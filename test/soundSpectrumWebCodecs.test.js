"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const mp4 = require("../public/soundSpectrumMP4");
const { privateIPv4 } = require("../src/lanHttps");
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (name, ...contents) => { const body = Buffer.concat(contents); return Buffer.concat([u32(body.length + 8), Buffer.from(name), body]); };
function initFixture() {
  const sample = Buffer.alloc(78); sample.writeUInt16BE(3840, 24); sample.writeUInt16BE(2160, 26);
  const avcc = Buffer.from([1, 100, 0, 61, 255, 225, 0, 1, 103, 1, 0, 1, 104]);
  const tkhd = box("tkhd", u32(0), u32(0), u32(0), u32(1));
  const mdhd = box("mdhd", u32(0), u32(0), u32(0), u32(90000));
  const stsd = box("stsd", u32(0), u32(1), box("avc1", sample, box("avcC", avcc)));
  const trex = box("trex", u32(0), u32(1), u32(1), u32(1500), u32(4), u32(0));
  return box("moov", box("trak", tkhd, box("mdia", mdhd, box("minf", box("stbl", stsd)))), box("mvex", trex));
}
function fragment(offsetOverride) {
  const tfhd = box("tfhd", u32(0x20000), u32(1));
  const tfdt = box("tfdt", u32(0x1000000), u32(0), u32(90000));
  const run = offset => box("trun", u32(0x701), u32(2), u32(offset), u32(1500), u32(4), u32(0), u32(1500), u32(4), u32(0x10000));
  const preliminary = box("moof", box("traf", tfhd, tfdt, run(0)));
  return Buffer.concat([box("moof", box("traf", tfhd, tfdt, run(offsetOverride ?? preliminary.length + 8))), box("mdat", Buffer.from([1,2,3,4,5,6,7,8]))]);
}
test("fMP4 preserves AVC config, real key/delta flags, timebase and access-unit bytes", () => {
  const config = mp4.init(initFixture()); assert.equal(config.codec, "avc1.64003d");
  assert.equal(config.codedWidth, 3840); assert.equal(config.codedHeight, 2160);
  const rows = mp4.samples(fragment(), config);
  assert.equal(rows.length, 2); assert.equal(rows[0].key, true); assert.equal(rows[1].key, false);
  assert.equal(rows[0].timestamp, 1000000); assert.equal(rows[1].timestamp, 1016667);
  assert.deepEqual([...rows[1].data], [5,6,7,8]);
});
test("fMP4 rejects truncated boxes, payloads outside mdat, extra tracks and unsupported codec", () => {
  assert.throws(() => mp4.init(initFixture().subarray(0, 30)));
  assert.throws(() => mp4.samples(fragment(1), mp4.init(initFixture())));
  const corrupt = Buffer.from(initFixture()); const offset = corrupt.indexOf("avc1"); corrupt.write("hev1", offset);
  assert.throws(() => mp4.init(corrupt), /H.264/);
  const small = fragment(); small.writeUInt32BE(0xffffffff, 0); assert.throws(() => mp4.samples(small, mp4.init(initFixture())));
});
test("optional HTTPS listener accepts only private IPv4 or loopback bindings", () => {
  for (const ip of ["192.168.50.119", "10.0.0.1", "172.16.0.1", "172.31.255.1", "127.0.0.1"]) assert.equal(privateIPv4(ip), true);
  for (const ip of ["0.0.0.0", "8.8.8.8", "172.32.0.1", "192.168.1.256", "localhost", null]) assert.equal(privateIPv4(ip), false);
});

const workerSource = fs.readFileSync(require.resolve("../public/soundSpectrumWebCodecsWorker.js"), "utf8");
const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
function workerFixture({ supported = true, noOutput = false, offOrigin = false, retained = 0, failures = [], failKind = "playlist", sourceFps = 60, withAnimation = true } = {}) {
  let at = 0, id = 0, segment = 0, closeCount = 0; const timers = new Map(), messages = [], configurations = [], inputs = [], requests = [], instances = [];
  class Decoder {
    static async isConfigSupported(c) { configurations.push(c); return { supported }; }
    constructor(c) { this.c = c; this.decodeQueueSize = 0; this.pending = []; instances.push(this); }
    configure(c) { configurations.push(c); }
    decode(chunk) { inputs.push(chunk); if (noOutput) return; this.pending.push(chunk); if (this.pending.length <= retained) return; this.c.output({ timestamp: this.pending.shift().timestamp, close() { closeCount++; } }); }
    close() { this.closed = true; }
  }
  const viewer = "a".repeat(24), base = "https://localhost/api/soundspectrum/hls/1/";
  const animation = new Map();
  const context = { VideoDecoder: Decoder, EncodedVideoChunk: class { constructor(c) { Object.assign(this, c); } },
    importScripts() {}, SoundSpectrumMP4: { init: () => ({ codec: "avc1.64003d", codedWidth: 3840, codedHeight: 2160, description: new Uint8Array([1]) }),
      samples: () => { const n = segment++; return Array.from({ length: sourceFps / 5 }, (_, i) => ({ key: i === 0, timestamp: Math.round((n * sourceFps / 5 + i) * 1e6 / sourceFps), duration: Math.round(1e6 / sourceFps), data: new Uint8Array(50000) })); } },
    URL, TextDecoder, Uint8Array, Number, Math, AbortController, performance: { now: () => at },
    postMessage: data => messages.push(data),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms, repeat: false }); return id; }, clearTimeout: n => timers.delete(n),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms, repeat: true }); return id; }, clearInterval: n => timers.delete(n),
    fetch: async (url, options) => {
      requests.push(url);
      const kind = url.includes(".m3u8") ? "playlist" : url.includes("init.mp4") ? "init" : "segment";
      if (kind === failKind && failures.length) { const status = failures.shift(); if (status === "hang") return new Promise((resolve,reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); if (!status) throw new TypeError("connection reset"); return { ok: false, status, body: { cancel: async () => {} } }; }
      let bytes;
      if (url.includes(".m3u8")) bytes = new TextEncoder().encode("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI=\"" + base + "init.mp4?viewerId=" + viewer + "\"\n" +
        Array.from({ length: 20 + (sourceFps === 120 ? segment : 0) }, (_, i) => "#EXTINF:0.2,\n" + (offOrigin ? "https://other.example/" : base) + "part" + i + ".m4s?viewerId=" + viewer).join("\n"));
      else bytes = new Uint8Array(10);
      let read = false;
      return { ok: true, status: 200, headers: new Map(), body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }), cancel: async () => {} }) } };
    }
  };
  if (withAnimation) { context.requestAnimationFrame = fn => { animation.set(++id, fn); return id; }; context.cancelAnimationFrame = n => animation.delete(n); }
  vm.createContext(context); vm.runInContext(workerSource, context);
  return { messages, inputs, configurations, timers, requests, instances, closes: () => closeCount,
    async start(mb = 32, bufferMs = 750, targetFps = 60) { void context.onmessage({ data: { type: "start", mb, bufferMs, targetFps, bitrate: 60, canvas: { getContext: () => ({ drawImage() {} }) }, url: base + "index.m3u8?viewerId=" + viewer } }); await flush(); },
    async tick(ms = 17) { at += ms; const t = [...timers].find(([, t]) => t.ms === 4); if (t) { timers.delete(t[0]); t[1].fn(); } await flush(); },
    async event(data) { await context.onmessage({ data }); await flush(); },
    async delay(ms) { const t = [...timers].find(([, t]) => t.ms === ms && !t.repeat); assert.ok(t, "timer " + ms); timers.delete(t[0]); at += ms; t[1].fn(); await flush(); },
    async pump() { const t=[...timers].find(([,t])=>!t.repeat && [50,100].includes(t.ms)); if(t){timers.delete(t[0]);t[1].fn();await flush();} },
    paint() { const callbacks = [...animation.values()]; animation.clear(); for (const fn of callbacks) fn(at); },
    report() { vm.runInContext("report()", context); },
    animation, stats() { return vm.runInContext("snapshot()", context); }
  };
}
test("worker checks codec and starts at the time target without filling the memory limit", async () => {
  const f = workerFixture(); await f.start(); assert.equal(f.inputs.length, 0);
  assert.equal(f.configurations[0].hardwareAcceleration, "prefer-hardware"); assert.equal(f.configurations[0].codedWidth, 3840);
  assert.ok(f.stats().wcBufferSeconds >= 0.75); assert.ok(f.stats().wcBufferBytes < 32e6);
  await f.tick(); assert.equal(f.stats().wcBufferState, "playing"); assert.ok(f.inputs.length <= 24);
  for (let i = 0; i < 10; i++) await f.tick();
  assert.ok(f.messages.some(m => m.type === "ready")); assert.ok(f.closes() > 0);
  assert.ok(f.inputs.some(i => i.type === "delta")); await f.event({ type: "stop" });
  assert.equal(f.stats().wcBufferBytes, 0);
});
test("unsupported hardware fails explicitly without software fallback or any decode", async () => {
  const f = workerFixture({ supported: false }); await f.start();
  assert.equal(f.inputs.length, 0); assert.ok(f.messages.some(m => m.reason === "codec-unsupported"));
});
test("receiver rejects cross-origin media references and detects a stalled first decode", async () => {
  const invalid = workerFixture({ offOrigin: true }); await invalid.start(); assert.ok(invalid.messages.some(m => m.reason === "media-format"));
  const stalled = workerFixture({ noOutput: true }); await stalled.start(); await stalled.tick(); await stalled.tick(15100);
  assert.ok(stalled.messages.some(m => m.reason === "decoder-stalled"));
});
test("hidden-page pause does not drain the reserve or count a long pause as decoder failure", async () => {
  const f = workerFixture(); await f.start(); await f.tick(); await f.event({ type: "visibility", hidden: true });
  const before = f.inputs.length; await f.tick(20000); assert.equal(f.inputs.length, before);
  await f.event({ type: "visibility", hidden: false }); await f.tick();
  assert.equal(f.messages.some(m => m.reason === "decoder-stalled"), false); await f.event({ type: "stop" });
});
test("decoder retaining sixteen pictures receives enough bounded input to make progress", async () => {
  const f = workerFixture({ retained: 16 }); await f.start();
  for (let i = 0; i < 80; i++) await f.tick();
  assert.ok(f.messages.some(m => m.type === "ready"));
  assert.ok(f.stats().decodedFrames > 0);
  assert.ok(f.inputs.length - f.stats().frames - f.stats().replacedFrames <= 24);
  await f.event({ type: "stop" });
});
test("large memory ceiling does not add startup delay and a too-small ceiling fails clearly", async () => {
  const large = workerFixture(); await large.start(250, 500); await large.tick();
  assert.equal(large.stats().wcBufferState, "playing"); assert.ok(large.stats().wcBufferBytes < 5e6);
  await large.event({ type: "stop" });
  const small = workerFixture(); await small.start(1, 750);
  const error = small.messages.find(m => m.reason === "buffer-limit");
  assert.ok(error); assert.ok(error.stats.wcBufferBytes <= 1e6); assert.equal(error.stats.wcRetries, 0);
});
test("temporary delivery failure retries the same request and succeeds without discarding samples", async () => {
  const f = workerFixture({ failures: [503, 0] }); await f.start();
  assert.equal(f.stats().wcBufferState, "retrying"); await f.delay(250); await f.delay(750);
  assert.equal(f.requests[0], f.requests[1]); assert.equal(f.requests[1], f.requests[2]);
  assert.equal(f.stats().wcRetries, 2); await f.tick(); assert.equal(f.stats().wcBufferState, "playing");
  assert.equal(f.messages.some(m => m.type === "error"), false); await f.event({ type: "stop" });
});
test("retry exhaustion retains HTTP status and safe request kind; access rejection is not retried", async () => {
  const f = workerFixture({ failures: [502,502,502] }); await f.start(); await f.delay(250); await f.delay(750);
  const error = f.messages.find(m => m.reason === "network-error"); assert.ok(error);
  assert.equal(error.stats.wcHttpStatus, 502); assert.equal(error.stats.wcRequestKind, "playlist"); assert.equal(f.requests.length, 3);
  assert.equal(JSON.stringify(error).includes("viewerId"), false);
  const denied = workerFixture({ failures: [403] }); await denied.start();
  assert.equal(denied.requests.length, 1); assert.ok(denied.messages.some(m => m.reason === "session-ended"));
});
test("stopping during retry prevents another request or stale error", async () => {
  const f = workerFixture({ failures: [503] }); await f.start(); await f.event({ type: "stop" }); await f.delay(250);
  assert.equal(f.requests.length, 1); assert.equal(f.messages.some(m => m.type === "error"), false);
});
test("expired segment refreshes the playlist and resumes at a keyframe", async () => {
  const f = workerFixture({ failures: [404,404,404], failKind: "segment" });
  await f.start(); await f.delay(250); await f.delay(750); await f.delay(100);
  assert.equal(f.stats().wcRecoveries, 1); await f.tick(); assert.equal(f.inputs[0].type, "key");
  assert.ok(f.requests.filter(u => u.includes(".m3u8")).length >= 2);
  await f.event({ type: "stop" });
});
test("late playback resets decoder, discards stale callbacks and starts recovery on a keyframe", async () => {
  const f = workerFixture(); await f.start(250); await f.tick(); await f.tick(100);
  const old = f.instances[0], offset = f.inputs.length; assert.ok(f.stats().frames > 0);
  await f.tick(1000); assert.equal(f.stats().wcRecoveries, 1); assert.equal(old.closed, true);
  const decodedBefore = f.stats().decodedFrames; let closed = false;
  old.c.output({ timestamp: 0, close() { closed = true; } });
  assert.equal(closed, true); assert.equal(f.stats().decodedFrames, decodedBefore);
  await f.delay(100); await f.tick(); assert.equal(f.inputs[offset].type, "key");
  assert.equal(f.stats().wcLatenessMs, 0); await f.event({ type: "stop" });
});

test("request deadlines abort and retry, then retain timeout diagnostics", async () => {
  const f = workerFixture({ failures: ["hang","hang","hang"] }); await f.start();
  await f.delay(4000); await f.delay(250); await f.delay(4000); await f.delay(750); await f.delay(4000);
  assert.equal(f.requests.length, 3); assert.ok(f.messages.some(m => m.reason === "network-timeout"));
});
test("repeated long suspension recovery is bounded instead of looping indefinitely", async () => {
  const f = workerFixture(); await f.start(); await f.tick();
  for (let i = 0; i < 4; i++) {
    await f.event({ type: "visibility", hidden: true }); await f.tick(2100);
    await f.event({ type: "visibility", hidden: false });
    if (i < 3) { const ms = [...f.timers.values()].some(t => t.ms === 100) ? 100 : 50; await f.delay(ms); await f.tick(); }
  }
  assert.equal(f.stats().wcRecoveries, 3); assert.ok(f.messages.some(m => m.reason === "history-expired"));
});

for (const displayHz of [60,120]) test('120 fps stream reports actual ' + displayHz + ' Hz presentation opportunities separately', async () => {
  const f = workerFixture({ sourceFps: 120 }); await f.start(32,750,120);
  for (let i=0;i<displayHz*2;i++) { await f.pump(); await f.tick(1000/displayHz); f.paint(); }
  f.report(); const s=f.stats();
  assert.equal(s.wcTargetFps,120); assert.ok(Math.abs(s.wcStreamFps-120)<0.1);
  assert.ok(Math.abs(s.wcPresentationHz-displayHz)<1);
  assert.ok(s.displayedFps<=displayHz+1); assert.ok(s.displayedFps>displayHz*0.8, JSON.stringify(s));
  if(displayHz===60) assert.ok(s.replacedFrames>50, '60 Hz cannot present all 120 fps frames');
  await f.event({type:'stop'}); assert.equal(f.animation.size,0);
});
test('120 fps refuses an unavailable presentation scheduler without pretending to present 120 Hz', async()=>{
  const f=workerFixture({sourceFps:120,withAnimation:false}); await f.start(32,750,120);
  assert.ok(f.messages.some(m=>m.type==='error' && m.reason==='renderer-unavailable'));
  assert.equal(f.inputs.length,0);
});
