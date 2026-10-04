"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { packet } = require("../src/soundSpectrumVideo");
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture() {
  const sockets = [], decoders = [], painted = [], ready = [], raf = new Map(), timers = new Map(); let id = 0, tick = 0;
  const image = { hidden: true, removeAttribute() { this.src = ""; }, naturalWidth: 800, naturalHeight: 450 };
  function canvas(name) { return { width: 800, height: 450, hidden: true, getContext: () => ({ drawImage: source => painted.push({ name, source }), clearRect() {} }) }; }
  const center = canvas("center"), backdrop = canvas("backdrop");
  class Socket { static OPEN = 1; constructor(url) { this.url = String(url); this.readyState = 1; this.sent = []; sockets.push(this); } close() { this.closed = true; } send(value) { this.sent.push(JSON.parse(value)); } }
  const context = { window: {}, location: { href: "https://player.example/?lyrion-stage=visualizer" }, URL, URLSearchParams, Blob, ArrayBuffer, Uint8Array, DataView, performance: { now: () => tick += 1 }, WebSocket: Socket,
    createImageBitmap: blob => new Promise((resolve, reject) => decoders.push({ resolve, reject, blob })),
    requestAnimationFrame: fn => { raf.set(++id, fn); return id; }, cancelAnimationFrame: id => raf.delete(id),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/soundSpectrumVideo.js"), "utf8"), context);
  const media = context.createSoundSpectrumVideo({ image, canvas: center, backdrop, onReady: value => ready.push(value) });
  function receive(sequence = 1, generation = 1) { const bytes = packet(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]), sequence, generation, 100); return sockets.at(-1).onmessage({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  const bitmap = () => ({ width: 800, height: 450, close() { this.closed = true; } });
  async function present() { const callback = [...raf.values()][0]; assert.ok(callback); raf.clear(); callback(50); await flush(); }
  return { media, sockets, decoders, painted, ready, raf, timers, image, center, backdrop, receive, bitmap, present, context };
}
test("video creates no connection until explicit start and acknowledges only after one decode paints both views", async () => {
  const f = fixture(); assert.equal(f.sockets.length, 0); f.media.start("viewer", "websocket-ack-jpeg");
  assert.match(f.sockets[0].url, /^wss:\/\/player.example\/api\/soundspectrum\/frames/);
  const pending = f.receive(), bitmap = f.bitmap(); assert.equal(f.decoders.length, 1); assert.equal(f.sockets[0].sent.length, 0);
  f.decoders[0].resolve(bitmap); await flush(); assert.equal(f.sockets[0].sent.length, 0);
  await f.present(); await pending;
  assert.equal(f.painted.length, 2); assert.equal(f.painted[0].source, f.painted[1].source);
  assert.equal(f.sockets[0].sent[0].ack, 1); assert.equal(bitmap.closed, true); assert.deepEqual(f.ready, [true]);
});
test("stopping during decode cannot paint or resurrect a background", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const pending = f.receive(), bitmap = f.bitmap(); f.media.stop();
  f.decoders[0].resolve(bitmap); await pending;
  assert.equal(bitmap.closed, true); assert.equal(f.painted.length, 0); assert.equal(f.backdrop.hidden, true); assert.equal(f.sockets[0].sent.length, 0);
});
test("stopping during pending presentation closes the bitmap and cancels its animation", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const pending = f.receive(), bitmap = f.bitmap();
  f.decoders[0].resolve(bitmap); await flush(); f.media.stop(); await pending;
  assert.equal(bitmap.closed, true); assert.equal(f.raf.size, 0); assert.equal(f.painted.length, 0);
});
test("a source change during decode rejects stale imagery but acknowledges it for the next fresh frame", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const pending = f.receive(1, 1), bitmap = f.bitmap();
  f.sockets[0].onmessage({ data: JSON.stringify({ state: "starting", generation: 2 }) });
  f.decoders[0].resolve(bitmap); await pending;
  assert.equal(f.painted.length, 0); assert.equal(f.sockets[0].sent[0].ack, 1); assert.equal(f.backdrop.hidden, true);
});
test("unsupported sockets use a single MJPEG image and reuse it for the backdrop", async () => {
  const f = fixture(); f.media.start("viewer", "mjpeg"); assert.equal(f.sockets.length, 0);
  assert.equal(f.image.src, "/api/soundspectrum/video?viewerId=viewer"); f.image.onload(); await f.present();
  assert.equal(f.painted[0].source, f.image); assert.equal(f.backdrop.hidden, false);
  f.media.stop(); assert.equal(f.image.src, ""); assert.equal(f.backdrop.hidden, true);
});
