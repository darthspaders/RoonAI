'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { inverseFft, AnalysisDsp, OUTPUT_RATE } = require('./dsp.cjs');
const { closeChild } = require('./index.cjs');
const { toneFrame } = require('./fixtures.cjs');

function signal(bytes) {
  let peak = 0, squares = 0;
  for (let i = 0; i < bytes.length; i += 4) { const v = bytes.readInt16LE(i) / 32768; squares += v * v; peak = Math.max(peak, Math.abs(v)); }
  return { peak, rms: Math.sqrt(squares / (bytes.length / 4)) };
}

test('radix-2 inverse agrees with an independent direct transform', () => {
  const real = [0.2, 0.4, -0.1, 0.7, 0, -0.2, 0.3, -0.4], imaginary = [0, 0.2, 0.1, -0.3, 0, 0.3, -0.1, -0.2];
  const re = Float64Array.from(real), im = Float64Array.from(imaginary); inverseFft(re, im);
  for (let t = 0; t < 8; t++) { let expected = 0;
    for (let k = 0; k < 8; k++) expected += real[k] * Math.cos(2 * Math.PI * k * t / 8) - imaginary[k] * Math.sin(2 * Math.PI * k * t / 8);
    assert.ok(Math.abs(re[t] - expected / 8) < 1e-12);
  }
});

test('complex tone synthesis is non-silent, stereo and conservatively bounded', () => {
  const dsp = new AnalysisDsp(); let result;
  for (let i = 1; i <= 8; i++) result = dsp.process(toneFrame(), i);
  const measured = signal(result.pcm); assert.ok(measured.rms > 0.04 && measured.rms < 0.12); assert.ok(measured.peak < 0.91);
  for (let i = 0; i < result.pcm.length; i += 4) assert.equal(result.pcm.readInt16LE(i), result.pcm.readInt16LE(i + 2));
  // Independent correlation verifies the expected bin's frequency survives.
  let sine = 0, cosine = 0;
  for (let i = 0; i < result.pcm.length / 4; i++) { const x = result.pcm.readInt16LE(i * 4); sine += x * Math.sin(2 * Math.PI * 20 * i / 2048); cosine += x * Math.cos(2 * Math.PI * 20 * i / 2048); }
  assert.ok(Math.hypot(sine, cosine) / (result.pcm.length / 4) > 1000);
});

test('zero RMS and zero spectra remain silence without normalizing numeric residue', () => {
  const dsp = new AnalysisDsp(); dsp.process(toneFrame(), 1);
  const silence = dsp.process(toneFrame({ rmsDb: -Infinity }), 2).pcm;
  assert.equal(silence.some(Boolean), false);
  assert.equal(dsp.process(toneFrame({ amplitude: 0, rmsDb: -Infinity }), 3).pcm.some(Boolean), false);
});

test('zero source bits force exact silence for held spectra and fresh known bits restart synthesis', () => {
  const dsp = new AnalysisDsp(); dsp.process(toneFrame(), 1);
  for (let i = 2; i < 26; i++) {
    const result = dsp.process(toneFrame({ sourceBits: 0 }), i); // Deliberately held, nonzero coefficients/levels.
    assert.equal(result.pcm.some(Boolean), false); assert.ok(result.pcm.length > 0);
  }
  const bytes = toneFrame({ rate: 48000 }), fresh = dsp.process(bytes, 26);
  assert.equal(fresh.discontinuity, true); assert.deepEqual(fresh.pcm, new AnalysisDsp().process(bytes, 26).pcm);
  assert.ok(signal(fresh.pcm).rms > 0.01);
  const malformed = toneFrame({ sourceBits: 0 }); malformed.writeFloatLE(NaN, 48 + 20 * 4);
  assert.throws(() => dsp.process(malformed, 27), /Invalid HQPlayer transform/);
});

test('dropped local sequences and format changes reset overlap rather than joining unrelated frames', () => {
  const dsp = new AnalysisDsp(), bytes = toneFrame(); dsp.process(bytes, 1); dsp.process(bytes, 2);
  const reset = dsp.process(bytes, 10); assert.equal(reset.discontinuity, true);
  assert.deepEqual(reset.pcm, new AnalysisDsp().process(bytes, 10).pcm);
  const mono = dsp.process(toneFrame({ channels: 1, rate: 48000 }), 11); assert.equal(mono.discontinuity, true);
  for (let i = 0; i < mono.pcm.length; i += 4) assert.equal(mono.pcm.readInt16LE(i), mono.pcm.readInt16LE(i + 2));
});

test('resampling follows source-rate metadata over consecutive hops', () => {
  const dsp = new AnalysisDsp(); let frames = 0;
  for (let i = 0; i < 24; i++) frames += dsp.process(toneFrame({ rate: 48000 }), i).pcm.length / 4;
  assert.ok(Math.abs(frames - (24 * 1024 - 1) * OUTPUT_RATE / 48000) <= 1);
});

test('higher-rate ultrasonic coefficients cannot alias into the derived visual signal', () => {
  const dsp = new AnalysisDsp();
  for (let i = 0; i < 4; i++) assert.equal(dsp.process(toneFrame({ rate: 96000, bin: 700 }), i).pcm.some(Boolean), false);
  let audible;
  for (let i = 4; i < 12; i++) audible = dsp.process(toneFrame({ rate: 96000, bin: 20 }), i).pcm;
  assert.ok(signal(audible).rms > 0.01);
});

test('non-finite coefficients, unsupported imaginary endpoints and invalid levels fail closed', () => {
  for (const change of [b => b.writeFloatLE(NaN, 48 + 20 * 4), b => b.writeFloatLE(100, 48 + 20 * 4),
    b => b.writeFloatLE(0.1, 48 + 1025 * 4), b => b.writeFloatLE(NaN, 32 + 8)]) {
    const bytes = toneFrame(); change(bytes); assert.throws(() => new AnalysisDsp().process(bytes, 1), /Invalid|Unsupported/);
  }
});

test('isolated worker accepts bounded synthetic work and closes on its owner channel', async t => {
  const child = spawn(process.execPath, [path.join(__dirname, 'dsp-worker.cjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
  t.after(() => closeChild(child, true));
  const messages = [], waiters = [];
  child.on('message', message => { messages.push(message); for (const resolve of waiters.splice(0)) resolve(); });
  async function wait(type) { const deadline = Date.now() + 3000; while (!messages.some(m => m.type === type)) {
    if (Date.now() > deadline) throw Error('Worker test deadline.'); await Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise(resolve => setTimeout(resolve, 20))]); }
    return messages.find(m => m.type === type); }
  await wait('ready'); child.send({ type: 'frames', epoch: 1, frames: [{ bytes: toneFrame(), sequence: 1 }] });
  const result = await wait('pcm'); assert.equal(result.epoch, 1); assert.ok(Buffer.isBuffer(result.pcm)); assert.ok(signal(result.pcm).rms > 0.01);
  const invalid = toneFrame(); invalid.writeFloatLE(NaN, 48 + 20 * 4);
  child.send({ type: 'frames', epoch: 1, frames: [{ bytes: invalid, sequence: 99 }] });
  const failure = await wait('failure'); assert.equal(failure.sequence, 99); assert.equal(failure.epoch, 1);
  await closeChild(child, true); assert.equal(child.connected, false);
});
