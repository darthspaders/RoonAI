'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MeterParser, parseHeader, MAX_WIRE_BYTES } = require('./protocol.cjs');
const { toneFrame } = require('./fixtures.cjs');

test('meter geometry matches the receive-only Desktop probe and signed source bits', () => {
  const h = parseHeader(toneFrame());
  assert.equal(h.frameBytes, 16464); assert.equal(h.transformLength, 2048); assert.equal(h.hop, 1024);
  assert.equal(h.sourceRate, 44100); assert.equal(h.sourceBits, 24);
  assert.equal(parseHeader(toneFrame({ sourceBits: -64 })).sourceBits, -64);
  assert.equal(parseHeader(toneFrame({ sourceBits: 1 })).sourceBits, 1);
});

test('captured zero-bit intertrack metadata is recognized only with otherwise valid geometry', () => {
  const bytes = toneFrame({ sourceBits: 0 }), h = parseHeader(bytes);
  assert.equal(h.sourceInactive, true); assert.equal(h.hop, 1024); assert.equal(h.sourceRate, 44100);
  const parser = new MeterParser(); parser.push(Buffer.concat(Array.from({ length: 20 }, () => bytes)));
  assert.equal(parser.drain(20).every(frame => frame.header.sourceInactive && !frame.header.transition), true);
  bytes.writeFloatLE(0, 24); assert.throws(() => parseHeader(bytes), { code: 'HQP_UNUSABLE_METADATA' });
});

test('fragmented headers and channel data reconstruct exact frames without losing a burst', () => {
  const first = toneFrame(), second = toneFrame({ phase: 0.4 }), joined = Buffer.concat([first, second]);
  const parser = new MeterParser(), frames = [];
  for (let at = 0; at < joined.length; at += 79) { parser.push(joined.subarray(at, at + 79)); frames.push(...parser.drain()); }
  assert.equal(frames.length, 2); assert.deepEqual(frames[0].bytes, first); assert.deepEqual(frames[1].bytes, second);
  assert.equal(parser.bufferedBytes, 0);
});

test('draining is bounded per turn and retains only bounded receive storage', () => {
  const parser = new MeterParser(); parser.push(Buffer.concat(Array.from({ length: 10 }, () => toneFrame())));
  assert.equal(parser.drain(3).length, 3); assert.ok(parser.bufferedBytes > 0); assert.equal(parser.drain(8).length, 7);
  parser.push(Buffer.alloc(MAX_WIRE_BYTES)); assert.throws(() => parser.push(Buffer.from([0])), /bound/);
  parser.clear(); assert.equal(parser.bufferedBytes, 0);
});

test('unknown versions, channel counts and FFT layouts fail before body allocation', () => {
  for (const change of [b => b.writeUInt32LE(2, 0), b => b.writeUInt32LE(99, 4), b => b.writeUInt32LE(4098, 8)]) {
    const bytes = toneFrame(); change(bytes); assert.throws(() => parseHeader(bytes), /Unsupported/);
    const parser = new MeterParser(); parser.push(bytes.subarray(0, 32)); assert.throws(() => parser.drain(), /Unsupported/);
  }
});

test('strict synthesis rejects invalid metadata but recognizable complete layouts can be discarded', () => {
  for (const change of [b => b.writeFloatLE(NaN, 16), b => b.writeFloatLE(0, 20), b => b.writeFloatLE(0.0001, 20),
    b => b.writeFloatLE(0.25, 20), b => b.writeFloatLE(Infinity, 24), b => b.writeInt32LE(99, 12)]) {
    const bytes = toneFrame(); change(bytes); assert.throws(() => parseHeader(bytes), { code: 'HQP_UNUSABLE_METADATA' });
    const parser = new MeterParser(); parser.push(bytes); const [frame] = parser.drain(); assert.equal(frame.header.transition, true); assert.deepEqual(frame.bytes, bytes);
  }
});

test('fragmented hybrid rate metadata is discarded without losing alignment to the next valid 48k frame', () => {
  const transition = toneFrame(); transition.writeFloatLE(24000, 16); // New bandwidth with the old 44.1k hop.
  const next = toneFrame({ rate: 48000 }), joined = Buffer.concat([transition, next]), parser = new MeterParser(), frames = [];
  for (let i = 0; i < joined.length; i += 47) { parser.push(joined.subarray(i, i + 47)); frames.push(...parser.drain()); }
  assert.equal(frames.length, 2); assert.equal(frames[0].header.transition, true); assert.equal(frames[1].header.sourceRate, 48000);
  assert.deepEqual(frames[1].bytes, next); assert.equal(parser.bufferedBytes, 0);
});
