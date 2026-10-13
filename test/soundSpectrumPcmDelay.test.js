"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PcmDelay, validateDelayMs, MAX_DELAY_MS, SAMPLE_RATE, FRAME_BYTES } = require("../src/soundSpectrumPcmDelay");
const zeros = frames => Buffer.alloc(frames * FRAME_BYTES);
function markers(frames, first = 1) {
  const value = zeros(frames);
  for (let frame = 0; frame < frames; frame++) value.writeUInt32LE(first + frame, frame * FRAME_BYTES);
  return value;
}

test("bounded integer delay validation and default bypass preserve complete PCM frames", () => {
  assert.equal(MAX_DELAY_MS, 5000);
  for (const value of [-1, 5001, 0.5, "100", NaN, Infinity, null]) assert.throws(() => validateDelayMs(value), RangeError);
  const stage = new PcmDelay(), input = markers(50);
  assert.deepEqual(stage.process(input), input);
  assert.equal(stage.snapshot().capacityBytes, 0);
  assert.throws(() => stage.process(Buffer.alloc(3)), /complete stereo/);
  assert.throws(() => stage.skipFrames(-1), RangeError);
});

test("exact sample shift preserves markers across uneven chunks and drains the complete ending", () => {
  const stage = new PcmDelay({ delayMs: 10 }), input = markers(1777), outputs = [];
  let offset = 0;
  for (const frames of [17, 443, 11, 901, 405]) {
    outputs.push(stage.process(input.subarray(offset * 4, (offset + frames) * 4))); offset += frames;
  }
  const ending = stage.process(zeros(stage.delayFrames));
  assert.deepEqual(Buffer.concat([...outputs, ending]), Buffer.concat([zeros(441), input]));
  assert.ok(stage.process(zeros(900)).every(value => value === 0));
});

test("one millisecond rounding and five second ring stay bounded across many wraps", () => {
  const short = new PcmDelay({ delayMs: 1 });
  assert.equal(short.delayFrames, 44);
  assert.deepEqual(short.process(markers(100)), Buffer.concat([zeros(44), markers(56)]));
  const stage = new PcmDelay({ delayMs: MAX_DELAY_MS }), block = 4410;
  assert.equal(stage.snapshot().capacityBytes, 882000);
  const input = markers(SAMPLE_RATE * 12), outputs = [];
  for (let frame = 0; frame < input.length / 4; frame += block) outputs.push(stage.process(input.subarray(frame * 4, (frame + block) * 4)));
  assert.deepEqual(Buffer.concat(outputs), Buffer.concat([zeros(stage.delayFrames), input.subarray(0, input.length - stage.delayFrames * 4)]));
  assert.equal(stage.snapshot().capacityBytes, 882000);
});

test("increasing inserts only additional silence and decreasing drops the oldest queued samples", () => {
  const stage = new PcmDelay({ delayMs: 10 });
  assert.deepEqual(stage.process(markers(441)), zeros(441));
  stage.setDelayMs(20);
  assert.deepEqual(stage.process(markers(441, 442)), zeros(441));
  assert.deepEqual(stage.process(markers(441, 883)), markers(441));
  stage.setDelayMs(10);
  assert.deepEqual(stage.process(zeros(441)), markers(441, 883));
  stage.setDelayMs(0);
  assert.deepEqual(stage.process(markers(50, 9001)), markers(50, 9001));
  assert.equal(stage.snapshot().capacityBytes, 0);
});

test("reset keeps the chosen delay but erases all pending samples", () => {
  const stage = new PcmDelay({ delayMs: 15 });
  stage.process(markers(662)); stage.reset();
  assert.equal(stage.delayMs, 15); assert.equal(stage.snapshot().bufferedBytes, 0);
  assert.deepEqual(stage.process(markers(100, 8001)), zeros(100));
  stage.setDelayMs(20, { reset: true });
  assert.deepEqual(stage.process(zeros(2000)), zeros(2000));
});

test("skipped output advances the causal timeline with zeros instead of adding delay or replaying history", () => {
  const stage = new PcmDelay({ delayMs: 10 });
  stage.process(markers(441)); stage.skipFrames(100);
  assert.deepEqual(stage.process(markers(441, 1001)), Buffer.concat([markers(341, 101), zeros(100)]));
  stage.skipFrames(1000000000);
  assert.deepEqual(stage.process(zeros(900)), zeros(900));
  assert.equal(stage.snapshot().capacityBytes, 882000);
});

test("mixed chunking, changes and skipped time match an independent causal FIFO model", () => {
  const stage = new PcmDelay(); let pending = [], delayFrames = 0, seed = 173, nextMarker = 1;
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let step = 0; step < 120; step++) {
    if (step % 5 === 0) {
      const milliseconds = step === 0 ? MAX_DELAY_MS : random(MAX_DELAY_MS + 1);
      const frames = Math.round(milliseconds * SAMPLE_RATE / 1000);
      pending = frames >= delayFrames ? Array(frames - delayFrames).fill(0).concat(pending) : pending.slice(delayFrames - frames);
      delayFrames = frames; stage.setDelayMs(milliseconds);
    } else if (step % 7 === 0) {
      const skipped = random(250000);
      pending = skipped >= delayFrames ? Array(delayFrames).fill(0) : pending.slice(skipped).concat(Array(skipped).fill(0));
      stage.skipFrames(skipped);
    } else {
      const frames = random(1400), input = markers(frames, nextMarker);
      const values = Array.from({ length: frames }, (_, frame) => nextMarker + frame); nextMarker += frames;
      const combined = pending.concat(values), expected = combined.slice(0, frames); pending = combined.slice(frames);
      const output = stage.process(input);
      for (let frame = 0; frame < frames; frame++) assert.equal(output.readUInt32LE(frame * 4), expected[frame], `step ${step}, frame ${frame}`);
    }
    assert.equal(pending.length, delayFrames);
    assert.ok(stage.snapshot().capacityBytes <= 882000);
  }
});
