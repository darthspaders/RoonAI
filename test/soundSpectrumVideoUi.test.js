"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { packet } = require("../src/soundSpectrumVideo");
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture(options = {}) {
  const sockets = [], decoders = [], painted = [], ready = [], raf = new Map(), timers = new Map(); let id = 0, tick = 0, paintCost = 0, paintError = false;
  let presentation = options.presentation;
  const rect = name => options.rect?.[name] || { width: 800, height: 450 };
  const image = { hidden: true, removeAttribute() { this.src = ""; }, naturalWidth: 800, naturalHeight: 450, getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : rect("center"); } };
  function canvas(name) { return { width: 800, height: 450, hidden: true, dataset: {}, getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : rect(name); }, getContext: () => ({
    ...(options.contextAttributes === undefined ? {} : { getContextAttributes: () => options.contextAttributes }), imageSmoothingEnabled: true, imageSmoothingQuality: "low",
    drawImage: (...args) => { if (paintError) throw Error("paint failed"); painted.push({ name, source: args[0], args: args.slice(1) }); tick += paintCost; }, clearRect() {} }) }; }
  const center = canvas("center"), backdrop = canvas("backdrop");
  class Socket { static OPEN = 1; constructor(url) { this.url = String(url); this.readyState = 1; this.sent = []; sockets.push(this); } close() { this.closed = true; } send(value) { this.sent.push(JSON.parse(value)); } }
  const context = { window: {}, location: { href: "https://player.example/?lyrion-stage=visualizer" }, URL, URLSearchParams, Blob, ArrayBuffer, Uint8Array, DataView, performance: { now: () => tick }, WebSocket: Socket,
    matchMedia: query => ({ matches: options.touch === true && query === "(pointer: coarse) and (hover: none)" }),
    createImageBitmap: blob => new Promise((resolve, reject) => decoders.push({ resolve, reject, blob })),
    requestAnimationFrame: fn => { raf.set(++id, fn); return id; }, cancelAnimationFrame: id => raf.delete(id),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  context.window = context;
  context.devicePixelRatio = options.dpr === undefined ? 1 : options.dpr;
  context.getComputedStyle = element => ({ objectFit: element === backdrop ? "cover" : "contain", opacity: element === backdrop ? ".26" : ".8", filter: element === backdrop ? "blur(12px)" : "none", imageRendering: "auto" });
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/soundSpectrumVideo.js"), "utf8"), context);
  const media = context.createSoundSpectrumVideo({ image, canvas: center, backdrop, ...(options.presentation === undefined ? {} : { presentation: () => presentation }), onReady: value => ready.push(value) });
  function receive(sequence = 1, generation = 1, jpeg = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9])) { const bytes = packet(jpeg, sequence, generation, 100); return sockets.at(-1).onmessage({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  const bitmap = () => ({ width: 800, height: 450, close() { this.closed = true; } });
  async function present() { const callback = [...raf.values()][0]; assert.ok(callback); raf.clear(); callback(tick); await flush(); }
  return { media, sockets, decoders, painted, ready, raf, timers, image, center, backdrop, receive, bitmap, present, context,
    advance: ms => { tick += ms; }, paintCost: ms => { paintCost = ms; }, failPaint: () => { paintError = true; }, presentation: value => { presentation = value; } };
}

function diagnosticJpeg(width = 800, height = 450, sampling = [0x22, 0x11, 0x11], precision = 8, extraBytes = 0) {
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8 + sampling.length * 3, precision, height >> 8, height & 255, width >> 8, width & 255, sampling.length,
    ...sampling.flatMap((value, index) => [index + 1, value, 0]), ...Buffer.alloc(extraBytes), 0xff, 0xd9]);
  return frame;
}

async function frame(f, sequence, generation = 1, bitmap = f.bitmap()) {
  const pending = f.receive(sequence, generation); f.decoders.at(-1).resolve(bitmap); await pending; await f.present(); return bitmap;
}
test("video connects only on explicit start and acknowledges decode before one paint reuses its bitmap for both views", async () => {
  const f = fixture(); assert.equal(f.sockets.length, 0); f.media.start("viewer", "websocket-ack-jpeg");
  assert.match(f.sockets[0].url, /^wss:\/\/player.example\/api\/soundspectrum\/frames/);
  const pending = f.receive(), bitmap = f.bitmap(); assert.equal(f.decoders.length, 1); assert.equal(f.sockets[0].sent.length, 0);
  f.decoders[0].resolve(bitmap); await pending;
  assert.equal(f.sockets[0].sent[0].ack, 1); assert.equal(f.painted.length, 0); assert.equal(bitmap.closed, undefined); assert.deepEqual(f.ready, []);
  await f.present(); await pending;
  assert.equal(f.painted.length, 2); assert.equal(f.painted[0].source, f.painted[1].source);
  assert.equal(f.sockets[0].sent[0].ack, 1); assert.equal(bitmap.closed, true); assert.deepEqual(f.ready, [true]);
});
test("healthy hidden decoding clears the startup timeout while suspended painting stays bounded", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg");
  assert.equal(f.timers.size, 1);
  const first = f.receive(1), original = f.bitmap(); f.decoders[0].resolve(original); await first;
  assert.equal(f.timers.size, 0); assert.equal(f.raf.size, 1); assert.equal(f.media.ready(), false);
  f.advance(61000);
  const next = f.receive(2), latest = f.bitmap(); f.decoders[1].resolve(latest); await next;
  assert.equal(original.closed, true); assert.equal(f.raf.size, 1); assert.equal(f.sockets[0].closed, undefined);
  assert.equal(f.media.stats().transport, "websocket"); assert.equal(f.sockets[0].sent.at(-1).ack, 2);
  await f.present(); assert.equal(f.painted[0].source, latest); assert.equal(f.media.ready(), true);
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
  assert.equal(f.center.dataset.videoTransport, "idle");
});
test("a source change during decode rejects stale imagery but acknowledges it for the next fresh frame", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const pending = f.receive(1, 1), bitmap = f.bitmap();
  f.sockets[0].onmessage({ data: JSON.stringify({ state: "starting", generation: 2 }) });
  f.decoders[0].resolve(bitmap); await pending;
  assert.equal(f.painted.length, 0); assert.equal(f.sockets[0].sent[0].ack, 1); assert.equal(f.backdrop.hidden, true);
  assert.equal(bitmap.closed, true);
});
test("capture recovery fences an in-flight bitmap while retaining its socket, generation and one decoder", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg");
  const old = f.receive(1, 1), oldBitmap = f.bitmap(), socket = f.sockets[0];
  socket.onmessage({ data: JSON.stringify({ state: "starting", generation: 1 }) });
  await f.receive(2, 1);
  assert.equal(f.decoders.length, 1); assert.equal(socket.sent.at(-1).ack, 2);
  f.decoders[0].resolve(oldBitmap); await old;
  assert.equal(oldBitmap.closed, true); assert.equal(socket.sent.at(-1).ack, 1);
  assert.equal(f.painted.length, 0); assert.equal(f.raf.size, 0); assert.equal(f.media.ready(), false);
  assert.equal(f.center.hidden, true); assert.equal(f.backdrop.hidden, true);
  const fresh = f.receive(3, 1), newBitmap = f.bitmap();
  assert.equal(f.decoders.length, 2); f.decoders[1].resolve(newBitmap); await fresh; await f.present();
  assert.deepEqual(f.painted.map(value => value.source), [newBitmap, newBitmap]);
  assert.equal(newBitmap.closed, true); assert.equal(socket.sent.at(-1).ack, 3);
  assert.equal(f.sockets.length, 1); assert.equal(socket.closed, undefined); assert.equal(f.media.ready(), true);
});
test("capture recovery retires queued imagery without letting its old rAF consume the new bitmap", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const old = f.receive(1, 1), oldBitmap = f.bitmap();
  f.decoders[0].resolve(oldBitmap); await old; const stalePaint = [...f.raf.values()][0];
  f.sockets[0].onmessage({ data: JSON.stringify({ state: "starting", generation: 1 }) });
  assert.equal(oldBitmap.closed, true); assert.equal(f.raf.size, 0);
  const fresh = f.receive(2, 1), newBitmap = f.bitmap();
  f.decoders[1].resolve(newBitmap); await fresh; stalePaint(50);
  assert.equal(newBitmap.closed, undefined); assert.equal(f.raf.size, 1); assert.equal(f.painted.length, 0);
  await f.present(); assert.deepEqual(f.painted.map(value => value.source), [newBitmap, newBitmap]);
  assert.equal(newBitmap.closed, true); assert.equal(f.sockets.length, 1); assert.equal(f.media.ready(), true);
});
test("a retired decoder failure acknowledges its sequence without replacing the recovery socket", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const old = f.receive(1, 1), socket = f.sockets[0];
  socket.onmessage({ data: JSON.stringify({ state: "starting", generation: 1 }) });
  f.decoders[0].reject(Error("retired decode failed")); await old;
  assert.equal(socket.sent.at(-1).ack, 1); assert.equal(socket.closed, undefined); assert.equal(f.media.stats().transport, "websocket");
  const fresh = f.receive(2, 1), bitmap = f.bitmap(); f.decoders[1].resolve(bitmap); await fresh; await f.present();
  assert.equal(f.painted[0].source, bitmap); assert.equal(f.media.ready(), true); assert.equal(f.sockets.length, 1);
});
test("unsupported sockets use a single MJPEG image and reuse it for the backdrop", async () => {
  const f = fixture(); f.media.start("viewer", "mjpeg"); assert.equal(f.sockets.length, 0);
  assert.equal(f.image.src, "/api/soundspectrum/video?viewerId=viewer"); f.image.onload(); f.advance(50); await f.present();
  assert.equal(f.painted[0].source, f.image); assert.equal(f.backdrop.hidden, false);
  assert.equal(f.center.dataset.videoTransport, "mjpeg");
  f.media.stop(); assert.equal(f.image.src, ""); assert.equal(f.backdrop.hidden, true);
});
test("stalled rAF retains only the newest decoded bitmap and closes every superseded frame", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const bitmaps = [];
  for (let sequence = 1; sequence <= 25; sequence++) {
    const pending = f.receive(sequence), bitmap = f.bitmap(); bitmaps.push(bitmap);
    f.decoders.at(-1).resolve(bitmap); await pending;
    assert.equal(f.raf.size, 1); assert.equal(f.painted.length, 0);
    assert.equal(bitmaps.filter(value => !value.closed).length, 1);
    assert.equal(f.sockets[0].sent.at(-1).ack, sequence);
  }
  assert.equal(f.media.stats().replacedFrames, 24);
  await f.present();
  assert.deepEqual(f.painted.map(value => value.source), [bitmaps.at(-1), bitmaps.at(-1)]);
  assert.ok(bitmaps.every(value => value.closed)); assert.equal(f.media.stats().frames, 1);
});
test("unexpected frames during a pending decode cannot start overlapping decoders", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const first = f.receive(1);
  await f.receive(2); await f.receive(3);
  assert.equal(f.decoders.length, 1); assert.equal(f.media.stats().busyDroppedFrames, 2);
  const bitmap = f.bitmap(); f.decoders[0].resolve(bitmap); await first; await f.present();
  const next = f.receive(4); assert.equal(f.decoders.length, 2); f.decoders[1].resolve(f.bitmap()); await next; await f.present();
  assert.equal(f.media.stats().frames, 2);
});
test("a restart fences an old decoder and waits for it to finish before decoding the new stream", async () => {
  const f = fixture(); f.media.start("first", "websocket-ack-jpeg"); const old = f.receive(1), oldBitmap = f.bitmap(), oldSocket = f.sockets[0];
  f.media.start("second", "websocket-ack-jpeg"); await f.receive(1);
  assert.equal(f.decoders.length, 1); assert.equal(oldSocket.closed, true);
  f.decoders[0].resolve(oldBitmap); await old;
  assert.equal(oldBitmap.closed, true); assert.equal(f.painted.length, 0); assert.equal(oldSocket.sent.length, 0);
  const fresh = f.receive(2), newBitmap = f.bitmap(); f.decoders[1].resolve(newBitmap); await fresh; await f.present();
  assert.equal(f.painted[0].source, newBitmap); assert.equal(f.painted.length, 2);
});
test("an already queued old rAF callback cannot consume the restarted stream's pending frame", async () => {
  const f = fixture(); f.media.start("first", "websocket-ack-jpeg"); const old = f.receive(1), oldBitmap = f.bitmap();
  f.decoders[0].resolve(oldBitmap); await old; const stalePaint = [...f.raf.values()][0];
  f.media.start("second", "websocket-ack-jpeg"); const fresh = f.receive(1), newBitmap = f.bitmap();
  f.decoders[1].resolve(newBitmap); await fresh; stalePaint(50);
  assert.equal(oldBitmap.closed, true); assert.equal(newBitmap.closed, undefined); assert.equal(f.raf.size, 1); assert.equal(f.painted.length, 0);
  await f.present(); assert.equal(f.painted[0].source, newBitmap); assert.equal(newBitmap.closed, true);
});
test("a source switch closes a queued bitmap immediately and paints only the new generation", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const old = f.receive(1, 1), oldBitmap = f.bitmap();
  f.decoders[0].resolve(oldBitmap); await old;
  f.sockets[0].onmessage({ data: JSON.stringify({ state: "starting", generation: 2 }) });
  assert.equal(oldBitmap.closed, true); assert.equal(f.raf.size, 0);
  const fresh = f.receive(2, 2), newBitmap = f.bitmap(); f.decoders[1].resolve(newBitmap); await fresh; await f.present();
  assert.deepEqual(f.painted.map(value => value.source), [newBitmap, newBitmap]);
  await f.receive(3, 1); assert.equal(f.decoders.length, 2); assert.equal(f.sockets[0].sent.at(-1).ack, 3);
});
test("socket fallback during decode rejects its late bitmap and reports the actual MJPEG transport", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const pending = f.receive(1), bitmap = f.bitmap(), socket = f.sockets[0];
  socket.onerror(); assert.equal(f.center.dataset.videoTransport, "mjpeg"); assert.equal(f.media.stats().transport, "mjpeg");
  assert.equal(f.media.stats().fidelity.generation, null);
  f.decoders[0].resolve(bitmap); await pending;
  assert.equal(bitmap.closed, true); assert.equal(socket.sent.length, 0); assert.equal(f.painted.length, 0);
  f.image.onload(); f.advance(50); await f.present(); assert.equal(f.painted[0].source, f.image);
});
test("decode failure cancels the pending paint before using the one-image MJPEG fallback", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const first = f.receive(1), bitmap = f.bitmap();
  f.decoders[0].resolve(bitmap); await first;
  const next = f.receive(2); f.decoders[1].reject(Error("decode failed")); await next;
  assert.equal(bitmap.closed, true); assert.equal(f.raf.size, 0); assert.equal(f.center.dataset.videoTransport, "mjpeg");
  assert.equal(f.sockets.length, 1); assert.equal(f.media.stats().frames, 0);
  f.image.onload(); f.advance(50); await f.present(); assert.equal(f.painted[0].source, f.image);
});
test("rolling diagnostics distinguish decode, rAF wait, draw cost and paint gaps without retaining old samples", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); f.paintCost(2);
  for (let sequence = 1; sequence <= 3; sequence++) {
    f.advance(20); const pending = f.receive(sequence), bitmap = f.bitmap();
    f.advance(3); f.decoders.at(-1).resolve(bitmap); await pending; f.advance(10); await f.present();
  }
  const measured = f.media.stats();
  assert.equal(measured.receivedFrames, 3); assert.equal(measured.decodedFrames, 3); assert.equal(measured.frames, 3);
  assert.equal(measured.meanDecodeMs, 3); assert.equal(measured.meanRafWaitMs, 10); assert.equal(measured.meanPaintMs, 4);
  assert.equal(measured.maxPaintGapMs, 37); assert.equal(measured.lastPaintGapMs, 37);
  assert.equal(measured.receiveFps, 1000 / 37); assert.equal(measured.decodeFps, 1000 / 37); assert.equal(measured.displayedFps, 1000 / 37);
  assert.equal(f.center.dataset.videoTransport, "websocket"); assert.equal(f.center.dataset.videoPaintMs, "4.0");
  f.advance(6000); const expired = f.media.stats();
  assert.equal(expired.displayedFps, 0); assert.equal(expired.maxPaintGapMs, 0); assert.equal(expired.meanDecodeMs, 0); assert.equal(expired.frames, 3);
});
test("rAF timing measures the scheduled wait even when newer bitmaps replace the original frame", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const first = f.receive(1);
  f.decoders[0].resolve(f.bitmap()); await first; f.advance(1000);
  const next = f.receive(2); f.decoders[1].resolve(f.bitmap()); await next; f.advance(10); await f.present();
  assert.equal(f.media.stats().meanRafWaitMs, 1010); assert.equal(f.media.stats().replacedFrames, 1);
});
test("a paint exception closes its bitmap and cancels presentation before MJPEG fallback", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const pending = f.receive(), bitmap = f.bitmap();
  f.decoders[0].resolve(bitmap); await pending; f.failPaint();
  await f.present();
  assert.equal(bitmap.closed, true); assert.equal(f.center.dataset.videoTransport, "mjpeg"); assert.equal(f.raf.size, 0); assert.equal(f.backdrop.hidden, true);
});
test("an ACK send failure closes the queued bitmap and falls back without leaving an orphan rAF", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg"); const socket = f.sockets[0]; socket.send = () => { throw Error("send failed"); };
  const pending = f.receive(), bitmap = f.bitmap(); f.decoders[0].resolve(bitmap); await pending;
  assert.equal(bitmap.closed, true); assert.equal(f.raf.size, 0); assert.equal(socket.closed, true); assert.equal(f.center.dataset.videoTransport, "mjpeg");
});

test("touch windowed backgrounds use fewer pixels while both surfaces present every frame and all ACKs stay intact", async () => {
  for (const presentation of ["windowed", "player-fullscreen"]) {
    const f = fixture({ touch: true, presentation }); f.media.start("viewer", "websocket-ack-jpeg");
    const bitmaps = [];
    for (let sequence = 1; sequence <= 10; sequence++) {
      if (sequence > 1) f.advance(20);
      bitmaps.push(await frame(f, sequence));
    }
    const foreground = f.painted.filter(value => value.name === "center"), background = f.painted.filter(value => value.name === "backdrop");
    assert.equal(foreground.length, 10); assert.equal(background.length, 10);
    assert.deepEqual(foreground.map(value => value.source), bitmaps);
    assert.deepEqual(background.map(value => value.source), bitmaps);
    assert.ok(foreground.every(value => value.args.length === 2));
    assert.ok(background.every(value => value.args.join(",") === "0,0,320,180"));
    assert.equal(f.center.width, 800); assert.equal(f.center.height, 450);
    assert.equal(f.backdrop.width, 320); assert.equal(f.backdrop.height, 180);
    assert.equal(f.media.stats().frames, 10); assert.equal(f.media.stats().backgroundFrames, 10);
    assert.equal(f.media.stats().backdropProfile, "windowed-touch"); assert.equal(f.media.stats().backgroundFps, f.media.stats().displayedFps);
    assert.deepEqual(f.sockets[0].sent.map(value => value.ack), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(f.sockets.length, 1); assert.equal(f.decoders.length, 10); assert.equal(f.raf.size, 0); assert.equal(f.timers.size, 0);
    assert.ok(bitmaps.every(value => value.closed)); assert.equal(f.center.dataset.videoBackdropProfile, "windowed-touch");
  }
});

test("touch background presentation shares the foreground clock without a separate low-rate throttle", async () => {
  const f = fixture({ touch: true, presentation: "windowed" }); f.media.start("viewer", "websocket-ack-jpeg");
  await frame(f, 1); f.advance(20); await frame(f, 2);
  assert.equal(f.media.stats().backgroundFrames, 2); assert.equal(f.media.stats().frames, 2);
  f.advance(20); await frame(f, 3);
  assert.equal(f.media.stats().backgroundFrames, 3); assert.equal(f.media.stats().frames, 3); assert.equal(f.media.stats().backgroundFps, 50);
});

test("fine pointer, absent presentation and unrecognized presentation retain the existing full background cadence", async () => {
  for (const options of [{ touch: false, presentation: "windowed" }, { touch: true }, { touch: true, presentation: "unrecognized" }]) {
    const f = fixture(options); f.media.start("viewer", "websocket-ack-jpeg");
    for (let sequence = 1; sequence <= 3; sequence++) { f.advance(20); await frame(f, sequence); }
    assert.equal(f.media.stats().frames, 3); assert.equal(f.media.stats().backgroundFrames, 3);
    assert.equal(f.media.stats().backdropProfile, "full"); assert.equal(f.backdrop.width, 800); assert.equal(f.backdrop.height, 450);
    assert.ok(f.painted.every(value => value.args.length === 2));
  }
});

test("touch fullscreen and Return immediately refresh the same background and preserve the existing stream", async () => {
  const f = fixture({ touch: true, presentation: "windowed" }); f.media.start("viewer", "websocket-ack-jpeg");
  await frame(f, 1); const socket = f.sockets[0];
  f.advance(10); f.presentation("visualizer-fullscreen"); await frame(f, 2);
  assert.equal(f.backdrop.width, 800); assert.equal(f.backdrop.height, 450); assert.equal(f.media.stats().backdropProfile, "full");
  f.advance(10); await frame(f, 3);
  assert.equal(f.media.stats().backgroundFrames, 3);
  f.advance(10); f.presentation("windowed"); await frame(f, 4);
  assert.equal(f.backdrop.width, 320); assert.equal(f.backdrop.height, 180); assert.equal(f.media.stats().backdropProfile, "windowed-touch");
  assert.equal(f.media.stats().frames, 4); assert.equal(f.media.stats().backgroundFrames, 4);
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0], socket); assert.equal(socket.closed, undefined);
  assert.deepEqual(socket.sent.map(value => value.ack), [1, 2, 3, 4]);
});

test("touch decorative downscaling preserves tall, wide and already small source proportions", async () => {
  for (const [width, height, backgroundWidth, backgroundHeight] of [[600, 900, 120, 180], [1600, 400, 320, 80], [160, 90, 160, 90]]) {
    const f = fixture({ touch: true, presentation: "windowed" }); f.media.start("viewer", "websocket-ack-jpeg");
    const bitmap = f.bitmap(); bitmap.width = width; bitmap.height = height; await frame(f, 1, 1, bitmap);
    assert.equal(f.center.width, width); assert.equal(f.center.height, height);
    assert.equal(f.backdrop.width, backgroundWidth); assert.equal(f.backdrop.height, backgroundHeight);
    assert.deepEqual(f.painted.at(-1).args, [0, 0, backgroundWidth, backgroundHeight]); assert.equal(bitmap.closed, true);
  }
});

test("source changes and capture recovery retire touch pending frames and refresh the background without a cadence delay", async () => {
  for (const generation of [1, 2]) {
    const f = fixture({ touch: true, presentation: "windowed" }); f.media.start("viewer", "websocket-ack-jpeg");
    await frame(f, 1); f.advance(10);
    const queued = f.receive(2), retired = f.bitmap(); f.decoders.at(-1).resolve(retired); await queued;
    const stalePaint = [...f.raf.values()][0];
    f.sockets[0].onmessage({ data: JSON.stringify({ state: "starting", generation }) });
    assert.equal(retired.closed, true); assert.equal(f.raf.size, 0); assert.equal(f.backdrop.hidden, true);
    const fresh = f.receive(3, generation), latest = f.bitmap(); f.decoders.at(-1).resolve(latest); await fresh; stalePaint(10);
    assert.equal(latest.closed, undefined); assert.equal(f.raf.size, 1);
    await f.present();
    assert.equal(f.media.stats().frames, 2); assert.equal(f.media.stats().backgroundFrames, 2);
    assert.equal(f.backdrop.hidden, false); assert.equal(latest.closed, true); assert.equal(f.sockets.length, 1);
    assert.ok(!f.painted.some(value => value.source === retired));
  }
});

test("Stop and a new touch start reset background timing and measurements without keeping imagery", async () => {
  const f = fixture({ touch: true, presentation: "windowed" }); f.media.start("first", "websocket-ack-jpeg");
  await frame(f, 1); f.advance(10);
  const pending = f.receive(2), retired = f.bitmap(); f.decoders.at(-1).resolve(retired); await pending;
  f.media.stop(); assert.equal(retired.closed, true); assert.equal(f.raf.size, 0); assert.equal(f.backdrop.hidden, true);
  f.media.start("second", "websocket-ack-jpeg"); await frame(f, 1);
  assert.equal(f.media.stats().frames, 1); assert.equal(f.media.stats().backgroundFrames, 1);
  assert.equal(f.media.stats().backgroundFps, 0); assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].closed, true);
  assert.equal(f.backdrop.hidden, false); assert.equal(f.backdrop.width, 320); assert.equal(f.backdrop.height, 180);
});

test("MJPEG touch backgrounds share the same cadence and fullscreen policy without an extra image or decoder", async () => {
  const f = fixture({ touch: true, presentation: "windowed" }); f.media.start("viewer", "mjpeg"); f.image.onload();
  await f.present(); assert.equal(f.media.stats().backgroundFrames, 1); assert.equal(f.backdrop.width, 320);
  f.advance(29); await f.present(); assert.equal(f.media.stats().backgroundFrames, 1);
  f.advance(1); await f.present(); assert.equal(f.media.stats().backgroundFrames, 2);
  f.advance(1); f.presentation("visualizer-fullscreen"); await f.present();
  assert.equal(f.backdrop.width, 800); assert.equal(f.backdrop.height, 450); assert.equal(f.media.stats().backdropProfile, "full");
  f.advance(1); f.presentation("windowed"); await f.present();
  assert.equal(f.backdrop.width, 320); assert.equal(f.media.stats().backgroundFrames, 4);
  assert.equal(f.image.hidden, false); assert.equal(f.image.src, "/api/soundspectrum/video?viewerId=viewer");
  assert.equal(f.sockets.length, 0); assert.equal(f.decoders.length, 0); assert.ok(f.painted.every(value => value.source === f.image));
  const stalePaint = [...f.raf.values()][0], count = f.painted.length; f.media.stop(); stalePaint(500);
  assert.equal(f.painted.length, count); assert.equal(f.raf.size, 0); assert.equal(f.backdrop.hidden, true); assert.equal(f.image.src, "");
});

test("fidelity describes actual JPEG, backing surfaces, CSS contain footprint and DPR without resizing or another stream", async () => {
  const f = fixture({ touch: true, presentation: "windowed", dpr: 2,
    rect: { center: { width: 1600, height: 1000 }, backdrop: { width: 1440, height: 900 } }, contextAttributes: { colorSpace: "srgb", colorType: "unorm8" } });
  f.media.start("viewer", "websocket-ack-jpeg");
  const pending = f.receive(1, 1, diagnosticJpeg()), bitmap = f.bitmap(); f.decoders[0].resolve(bitmap); await pending; await f.present();
  const value = f.media.stats().fidelity;
  assert.deepEqual(JSON.parse(JSON.stringify(value.transmittedResolution)), { width: 800, height: 450 });
  assert.equal(value.jpegPrecisionBits, 8); assert.equal(value.jpegSubsampling, "4:2:0"); assert.equal(value.format, "JPEG");
  assert.deepEqual(JSON.parse(JSON.stringify(value.decodedResolution)), { width: 800, height: 450 });
  assert.deepEqual(JSON.parse(JSON.stringify(value.foregroundCanvasResolution)), { width: 800, height: 450 });
  assert.deepEqual(JSON.parse(JSON.stringify(value.backgroundCanvasResolution)), { width: 320, height: 180 });
  assert.deepEqual(JSON.parse(JSON.stringify(value.displayedCssResolution)), { width: 1600, height: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(value.displayedImageCssResolution)), { width: 1600, height: 900 });
  assert.deepEqual(JSON.parse(JSON.stringify(value.displayDevicePixels)), { width: 3200, height: 1800 });
  assert.deepEqual(JSON.parse(JSON.stringify(value.foregroundScale)), { cssX: 2, cssY: 2, deviceX: 4, deviceY: 4 });
  assert.equal(value.backgroundScale.cssX, 5); assert.equal(value.backgroundScale.deviceX, 10);
  assert.equal(value.canvasColorSpace, "srgb"); assert.equal(value.canvasColorType, "unorm8");
  assert.equal(value.foregroundPresentation.opacity, ".8"); assert.equal(value.foregroundPresentation.imageSmoothingEnabled, true);
  assert.equal(value.backgroundPresentation.filter, "blur(12px)"); assert.equal(value.nativeColorSpace, "Unknown");
  assert.equal(value.jpegPayloadMbps, null); assert.equal(value.wireMbps, null); assert.equal(value.averagingSeconds, 0);
  f.context.devicePixelRatio = 3;
  assert.equal(f.media.stats().fidelity.foregroundScale.deviceX, 6); assert.equal(f.center.width, 800); assert.equal(f.backdrop.width, 320);
  assert.equal(f.sockets.length, 1); assert.equal(f.decoders.length, 1); assert.equal(f.timers.size, 0); assert.equal(f.raf.size, 0);
  assert.deepEqual(f.sockets[0].sent.map(value => value.ack), [1]); assert.equal(bitmap.closed, true);
});

test("fidelity measures rolling actual received JPEG and RH packet bytes, expires them, and keeps per-frame headers bounded", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg");
  const jpeg = diagnosticJpeg(800, 450, [0x11, 0x11, 0x11], 8, 100);
  for (let sequence = 1; sequence <= 3; sequence++) {
    if (sequence > 1) f.advance(100);
    const pending = f.receive(sequence, 1, jpeg); f.decoders.at(-1).resolve(f.bitmap()); await pending; await f.present();
  }
  let value = f.media.stats().fidelity;
  assert.equal(value.jpegSubsampling, "4:4:4"); assert.equal(value.averagingSeconds, .2);
  assert.equal(value.jpegPayloadMbps, jpeg.byteLength * 2 * 8 / .2 / 1000000);
  assert.equal(value.wireMbps, (jpeg.byteLength + 20) * 2 * 8 / .2 / 1000000);
  assert.match(value.bitrateScope, /excludes WebSocket\/TCP\/TLS/);
  f.advance(5001); value = f.media.stats().fidelity;
  assert.equal(value.jpegPayloadMbps, null); assert.equal(value.wireMbps, null); assert.equal(value.averagingSeconds, 0);
  assert.equal(value.jpegPrecisionBits, 8); assert.equal(f.sockets.length, 1);
});

test("JPEG marker diagnostics tolerate supported sampling, truncated and absent headers without altering decoder and ACK behavior", async () => {
  const examples = [
    { jpeg: diagnosticJpeg(1920, 1080, [0x21, 0x11, 0x11]), sampling: "4:2:2", bits: 8 },
    { jpeg: diagnosticJpeg(400, 400, [0x11], 12), sampling: "grayscale", bits: 12 },
    { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xd9]), sampling: null, bits: null },
    { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]), sampling: null, bits: null },
    { jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(65533), diagnosticJpeg().subarray(2)]), sampling: null, bits: null }
  ];
  for (const example of examples) {
    const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg");
    const pending = f.receive(1, 1, example.jpeg); f.decoders[0].resolve(f.bitmap()); await pending; await f.present();
    const value = f.media.stats().fidelity;
    assert.equal(value.jpegSubsampling, example.sampling); assert.equal(value.jpegPrecisionBits, example.bits);
    assert.equal(f.media.stats().frames, 1); assert.deepEqual(f.sockets[0].sent.map(value => value.ack), [1]);
    assert.equal(f.decoders.length, 1); assert.equal(f.sockets.length, 1); assert.equal(f.media.ready(), true);
  }
});

test("capture recovery and late old decoders cannot leave stale dimensions or bitrate in fidelity", async () => {
  const f = fixture(); f.media.start("viewer", "websocket-ack-jpeg");
  const pending = f.receive(1, 1, diagnosticJpeg(1920, 1080)), oldBitmap = f.bitmap(); oldBitmap.width = 1920; oldBitmap.height = 1080;
  assert.equal(f.media.stats().fidelity.transmittedResolution.width, 1920);
  f.sockets[0].onmessage({ data: JSON.stringify({ state: "starting", generation: 2 }) });
  f.decoders[0].resolve(oldBitmap); await pending;
  let value = f.media.stats().fidelity;
  assert.equal(value.transmittedResolution, null); assert.equal(value.decodedResolution, null); assert.equal(value.foregroundCanvasResolution, null);
  assert.equal(value.jpegPayloadMbps, null); assert.equal(value.generation, 2); assert.equal(oldBitmap.closed, true);
  const fresh = f.receive(2, 2, diagnosticJpeg()); f.decoders[1].resolve(f.bitmap()); await fresh; await f.present();
  await f.receive(3, 1, diagnosticJpeg(3840, 2160));
  value = f.media.stats().fidelity;
  assert.equal(value.transmittedResolution.width, 800); assert.equal(value.decodedResolution.width, 800); assert.equal(value.averagingSeconds, 0);
  f.media.stop(); value = f.media.stats().fidelity;
  assert.equal(value.active, false); assert.equal(value.generation, null); assert.equal(value.format, null);
  assert.equal(value.transmittedResolution, null); assert.equal(value.decodedResolution, null); assert.equal(value.backgroundCanvasResolution, null);
  assert.equal(value.displayedCssResolution, null); assert.equal(value.jpegPayloadMbps, null); assert.equal(f.raf.size, 0);
});

test("MJPEG fidelity honestly separates observable intrinsic dimensions from unavailable JPEG bytes and canvas format", async () => {
  const f = fixture({ dpr: 2, rect: { center: { width: 1200, height: 900 } } }); f.media.start("viewer", "mjpeg");
  f.image.naturalWidth = 1600; f.image.naturalHeight = 900; f.image.onload(); await f.present();
  const value = f.media.stats().fidelity;
  assert.equal(value.format, "MJPEG"); assert.equal(value.generation, null); assert.equal(value.transmittedResolution, null); assert.equal(value.jpegPrecisionBits, null);
  assert.equal(value.decodedResolution.width, 1600); assert.equal(value.foregroundCanvasResolution, null);
  assert.equal(value.displayedImageCssResolution.width, 1200); assert.equal(value.displayedImageCssResolution.height, 675);
  assert.equal(value.canvasColorSpace, null); assert.equal(value.canvasColorType, null); assert.equal(value.jpegPayloadMbps, null); assert.equal(value.wireMbps, null);
  assert.match(value.bitrateScope, /does not expose/); assert.equal(f.sockets.length, 0); assert.equal(f.decoders.length, 0);
});

test("missing browser color and geometry APIs remain unknown and diagnostics add no layout reads to per-frame reporting", async () => {
  const f = fixture(); delete f.context.getComputedStyle; delete f.center.getBoundingClientRect; delete f.backdrop.getBoundingClientRect;
  f.context.devicePixelRatio = NaN; f.media.start("viewer", "websocket-ack-jpeg"); await frame(f, 1);
  let reads = 0; f.center.getBoundingClientRect = () => { reads++; return { width: 1000, height: 600 }; };
  f.advance(1100); await frame(f, 2);
  assert.equal(reads, 0);
  const value = f.media.stats().fidelity;
  assert.equal(reads, 1); assert.equal(value.canvasColorSpace, null); assert.equal(value.canvasColorType, null);
  assert.equal(value.devicePixelRatio, null); assert.equal(value.displayDevicePixels, null); assert.equal(value.foregroundScale.deviceX, null);
  assert.equal(value.foregroundPresentation.objectFit, null); assert.equal(value.transmittedResolution, null);
  assert.equal(value.decodedResolution.width, 800); assert.equal(f.sockets.length, 1);
});
