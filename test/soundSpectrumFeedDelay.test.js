"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { HqplayerFeed } = require("../integrations/soundspectrum-hqplayer-feed/index.cjs");
const { AudioFeed, packet } = require("../integrations/soundspectrum-audio-feed/index.cjs");
const { SAMPLE_RATE } = require("../src/soundSpectrumPcmDelay");
const PLAYER = "aa:bb:cc:dd:ee:ff";
const FLAC = Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(38)]);
const zeros = frames => Buffer.alloc(frames * 4);
function marker(frames, value = 12345) {
  const result = zeros(frames); for (let frame = 0; frame < frames; frame++) result.writeUInt32LE(value, frame * 4); return result;
}
class Stream extends EventEmitter {
  constructor() { super(); this.writes = []; this.writableLength = 0; this.writableNeedDrain = false; this.destroyed = false; }
  write(value, callback) { this.writes.push(Buffer.from(value)); callback?.(); return true; }
  end() {}
  pause() {}
  resume() {}
  destroy() { this.destroyed = true; }
}
class Child extends EventEmitter {
  constructor(worker = false) { super(); this.stdin = new Stream(); this.stdout = new Stream(); this.stderr = new Stream(); this.exitCode = null; this.signalCode = null; this.connected = worker; }
  send(message, callback) { callback?.(); if (message.type === "close") this.kill(); }
  kill() { if (this.exitCode !== null) return; this.exitCode = 0; this.connected = false; queueMicrotask(() => this.emit("close", 0)); }
}
async function fixture(t, kind, delayMs = 0, legacyDelayMs = 0) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rh-visual-delay-test-"));
  const settingsPath = path.join(directory, "settings.json"), children = [], sockets = [];
  await fs.writeFile(settingsPath, JSON.stringify({ version: 1, enabled: true, zoneId: "zone-one", outputId: "output-one", delayMs: legacyDelayMs, route: { fingerprint: "a".repeat(64) } }));
  let mono = 1000, wall = 1000, zoneState = "playing";
  const output = { probeOutput: async () => ({ available: true }), validateOutput: async () => ({ available: true }), buildOutputCommand: () => ({ command: "fake-visual-only-writer", args: [] }) };
  const common = { settingsPath, output, clock: () => wall, paceClock: () => mono, visualDelayMs: delayMs,
    spawnImpl: (_command, args) => {
      const worker = args.some(value => /dsp-worker/.test(value)), child = new Child(worker); children.push(child);
      if (worker) queueMicrotask(() => child.emit("message", { type: "ready" })); return child;
    } };
  const socketFactory = options => {
    const socket = new EventEmitter(); socket.options = options; socket.writes = 0;
    socket.setNoDelay = () => {}; socket.setTimeout = () => {};
    socket.destroy = () => { socket.destroyed = true; queueMicrotask(() => socket.emit("close")); };
    socket.bind = (_port, address, callback) => { assert.equal(address, "127.0.0.1"); callback(); };
    socket.address = () => ({ port: 34567 }); socket.close = () => { socket.destroyed = true; };
    sockets.push(socket); return socket;
  };
  const feed = kind === "hqplayer" ? new HqplayerFeed({ ...common, timers: false, socketFactory,
    requireZone: async (_id, _settings, options) => {
      if (zoneState !== "playing" && !options?.allowInactive) throw Error("initial start must be playing");
      return { state: zoneState };
    } }) : new AudioFeed({ ...common, socketFactory, demandPath: path.join(directory, "demand.json"),
    requirePlayer: async id => { assert.equal(id, PLAYER); }, bridgeStatus: async () => ({ version: 1, loaded: 1, configured: 1 }) });
  const start = async () => feed.start(kind === "hqplayer" ? { zoneId: "zone-one" } : { playerId: PLAYER });
  await start();
  if (kind === "lyrion") feed.receive(packet({ v: 1, token: feed.token, playerId: PLAYER, generation: "stream-one", sequence: 0, type: "begin", format: "flac" }, FLAC), { address: "127.0.0.1" });
  t.after(async () => {
    await feed.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { feed, children, sockets, start, writer: () => feed.writer,
    advance(ms) { mono += ms; wall += ms; }, wallShift(ms) { wall += ms; }, state(value) { zoneState = value; },
    offer(value) {
      if (kind === "lyrion") feed.offerPcm(value);
      else { feed.pcm.push(Buffer.from(value)); feed.pcmSize += value.length; feed.frameAt = wall; feed.pcmAt = wall; }
    },
    tick(ms = 20) { mono += ms; wall += ms; feed.tick(feed.epoch); return feed.writer.stdin.writes.at(-1); },
    async boundary() {
      if (kind === "hqplayer") { zoneState = "loading"; await feed.checkSafety(); }
      else feed.resetDecoder();
    },
    async resume() { if (kind === "hqplayer") { zoneState = "playing"; await feed.checkSafety(); } }
  };
}

for (const kind of ["hqplayer", "lyrion"]) {
  test(`${kind}: exact delayed writer onset and ending include silence and supersede legacy delay`, async t => {
    const q = await fixture(t, kind, 100, 1000), input = marker(882), outputs = [];
    q.offer(input); for (let tick = 0; tick < 7; tick++) outputs.push(q.tick());
    assert.deepEqual(Buffer.concat(outputs), Buffer.concat([zeros(4410), input, zeros(882)]));
    assert.equal(q.feed.snapshot().delayMs, 100);
    assert.equal(q.feed.snapshot().visualDelay.capacityBytes, 882000);
    assert.ok(q.sockets.every(socket => socket.writes === 0));
  });
  test(`${kind}: between-tick source boundary drains accepted tail without backdating new PCM`, async t => {
    const q = await fixture(t, kind, 20);
    q.offer(marker(882)); assert.deepEqual(q.tick(), zeros(882));
    const writer = q.writer(), count = q.children.length;
    q.advance(19); await q.boundary(); await q.resume();
    q.offer(marker(882, 22222));
    assert.deepEqual(q.tick(1), marker(882));
    assert.deepEqual(q.tick(), Buffer.concat([zeros(837), marker(45, 22222)]));
    assert.equal(q.writer(), writer); assert.equal(q.children.length, count);
    assert.ok(q.sockets.every(socket => socket.writes === 0));
  });
  test(`${kind}: live adjustment, reset, and Stop/new session cannot replay pending audio`, async t => {
    const q = await fixture(t, kind, 20); q.offer(marker(882)); q.tick();
    q.feed.setVisualDelayMs(40); assert.deepEqual(q.tick(), zeros(882)); assert.deepEqual(q.tick(), marker(882));
    q.offer(marker(882, 777)); q.tick();
    q.feed.setVisualDelayMs(0, { reset: true }); assert.equal(q.feed.snapshot().delayMs, 0);
    assert.deepEqual(q.tick(), zeros(882));
    q.feed.setVisualDelayMs(100); q.offer(marker(882, 888)); q.tick(); q.advance(9);
    await q.feed.stop(); assert.equal(q.feed.snapshot().visualDelay.bufferedBytes, 0);
    assert.equal(q.feed.snapshot().delayMs, 100); await q.start();
    assert.deepEqual(q.tick(120), zeros(4410));
    assert.deepEqual(q.tick(20), zeros(1764));
  });
  test(`${kind}: monotonic jitter and wall-clock changes preserve the sample delay`, async t => {
    const q = await fixture(t, kind, 33), input = marker(SAMPLE_RATE / 10), outputs = [];
    q.offer(input);
    for (const ms of [21, 19, 23, 17, 20]) outputs.push(q.tick(ms));
    q.wallShift(-3600000);
    outputs.push(q.tick(40));
    assert.deepEqual(Buffer.concat(outputs), Buffer.concat([zeros(1455), input, zeros(309)]));
  });
  test(`${kind}: overdue pacer and blocked writer expire pending output without accumulating delay`, async t => {
    const q = await fixture(t, kind, 100); q.offer(marker(4410)); q.tick(100);
    assert.deepEqual(q.tick(700), zeros(4410));
    q.offer(marker(882, 999)); q.tick(); q.writer().stdin.writableNeedDrain = true;
    q.tick(200); q.writer().stdin.writableNeedDrain = false;
    assert.deepEqual(q.tick(), zeros(882));
    assert.equal(q.feed.snapshot().delayMs, 100);
  });
}
