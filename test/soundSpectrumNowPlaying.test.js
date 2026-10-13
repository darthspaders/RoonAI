"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { NowPlayingBridge, getOwnedTarget } = require("../integrations/soundspectrum-now-playing/index.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const target = (session = "main:1:123") => ({ session, nativePid: 123, source: "roon-hqplayer", zoneId: "exact-zone", playerId: "" });
const track = (key = "one", artToken = "cover-one") => ({ key: hash(key), title: "Track one", artist: "Artist", album: "Album", artToken });
const art = { data: Buffer.alloc(32, 1), extension: "jpg", width: 320, height: 320 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rh-now-playing-"));
  let selected = target(), now = 100000, incoming = { state: "playing", track: track() };
  let artCalls = 0, metadataCalls = 0;
  const provider = { readTrack: async () => { metadataCalls++; return incoming; },
    readArt: async () => { artCalls++; return art; }, ...options.provider };
  const warnings = [];
  const bridge = new NowPlayingBridge({ getTarget: () => selected, runtimeRoot: root,
    readiness: async () => ({ ready: true }), clock: () => now, monotonicClock: () => now,
    intervalMs: 0, warn: s => warnings.push(s), ...options, provider });
  await bridge.ready;
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { bridge, root, warnings, select: value => { selected = value; }, incoming: value => { incoming = value; },
    advance: ms => { now += ms; }, read: async () => JSON.parse(await fs.readFile(path.join(root, "now-playing.json"))),
    get artCalls() { return artCalls; }, get metadataCalls() { return metadataCalls; } };
}
async function settleArt(bridge) { if (bridge.artPending) await bridge.artPending; await bridge.writeSerial; }

test("metadata follows only a live owned G-Force music session without probing runtimes", () => {
  const service = { closed: false, state: "running", visualizer: "g-force", inputKind: "music-feed", inputSource: "roon-hqplayer",
    zoneId: "exact-zone", playerId: "", generation: 2, leases: new Map([["viewer", 2000]]), clock: () => 1000,
    native: { status: () => ({ state: "running", owned: true, visualizer: "g-force", pid: 123 }) },
    inspect: () => { throw Error("must not probe"); } };
  assert.equal(getOwnedTarget(service, "instance").zoneId, "exact-zone");
  for (const changes of [{ state: "starting" }, { closed: true }, { visualizer: "aeon" }, { inputKind: "no-mic" },
    { inputSource: "" }, { zoneId: "" }, { leases: new Map([["viewer", 999]]) },
    { native: { status: () => ({ state: "running", owned: false, visualizer: "g-force", pid: 123 }) } }]) {
    assert.equal(getOwnedTarget({ ...service, ...changes }, "instance"), null);
  }
  const lyrion = getOwnedTarget({ ...service, inputSource: "lyrion", zoneId: "", playerId: "aa:bb:cc:dd:ee:ff" }, "instance");
  assert.equal(lyrion.playerId, "aa:bb:cc:dd:ee:ff");
  const recovering = { ...service, state: "starting", captureRecovering: true, captureWindow: { pid: 123 } };
  assert.deepEqual(getOwnedTarget(recovering, "instance"), getOwnedTarget(service, "instance"));
  for (const changes of [{ captureRecovering: false }, { captureRecovering: 1 }, { captureWindow: null },
    { captureWindow: { pid: 456 } }, { captureWindow: { pid: "123" } }, { state: "error" }, { closed: true },
    { inputSource: "" }, { inputKind: "no-mic" }, { zoneId: "" }, { leases: new Map([["viewer", 999]]) },
    { native: { status: () => ({ state: "running", owned: false, visualizer: "g-force", pid: 123 }) } },
    { native: { status: () => ({ state: "starting", owned: true, visualizer: "g-force", pid: 123 }) } },
    { native: { status: () => ({ state: "running", owned: true, visualizer: "g-force", pid: 456 }) } }]) {
    assert.equal(getOwnedTarget({ ...recovering, ...changes }, "instance"), null);
  }
});

test("video-only recovery keeps the same metadata session, title and cached cover until Stop", async t => {
  let now = 100000;
  const service = { closed: false, state: "running", visualizer: "g-force", inputKind: "music-feed", inputSource: "roon-hqplayer",
    zoneId: "exact-zone", playerId: "", generation: 2, leases: new Map([["viewer", 200000]]), clock: () => now,
    native: { status: () => ({ state: "running", owned: true, visualizer: "g-force", pid: 123 }) },
    inspect: () => { throw Error("must not probe"); } };
  const f = await fixture(t, { getTarget: () => getOwnedTarget(service, "instance"), clock: () => now, monotonicClock: () => now });
  await f.bridge.tick(); await settleArt(f.bridge);
  const first = await f.read(), epoch = f.bridge.epoch, controller = f.bridge.controller;
  const cache = await fs.readFile(path.join(f.root, "artwork-cache.json"));
  const assets = await fs.readdir(f.root);
  const cover = await fs.readFile(path.join(f.root, first.track.artwork.file));
  assert.equal(f.artCalls, 1);

  service.state = "starting"; service.captureRecovering = true; service.captureWindow = { pid: 123 };
  f.bridge.invalidate(); await f.bridge.writeSerial;
  const during = await f.read();
  assert.equal(during.active, true); assert.equal(during.session, first.session); assert.equal(during.nativePid, first.nativePid);
  assert.deepEqual(during.track, first.track);
  now += 2000;
  await f.bridge.tick(); await settleArt(f.bridge);
  assert.equal(f.bridge.epoch, epoch); assert.equal(f.bridge.controller, controller); assert.equal(controller.signal.aborted, false);
  assert.equal(f.artCalls, 1);
  assert.deepEqual((await f.read()).track, first.track);

  service.state = "running"; service.captureRecovering = false;
  f.bridge.invalidate(); await f.bridge.tick(); await settleArt(f.bridge);
  const resumed = await f.read();
  assert.equal(resumed.active, true); assert.equal(resumed.session, first.session);
  assert.deepEqual(resumed.track, first.track); assert.equal(f.bridge.epoch, epoch); assert.equal(f.artCalls, 1);
  assert.deepEqual(await fs.readFile(path.join(f.root, "artwork-cache.json")), cache);
  assert.deepEqual(await fs.readFile(path.join(f.root, first.track.artwork.file)), cover);
  assert.deepEqual(await fs.readdir(f.root), assets);

  service.state = "idle"; service.captureRecovering = false; service.captureWindow = null; service.leases.clear();
  f.bridge.invalidate(); await f.bridge.tick(); await f.bridge.writeSerial;
  const stopped = await f.read();
  assert.equal(stopped.active, false); assert.equal(stopped.session, ""); assert.equal(stopped.nativePid, 0);
  assert.equal(stopped.track, null); assert.equal(controller.signal.aborted, true); assert.equal(f.artCalls, 1);
});

test("publishes bounded title fields and immutable artwork, retaining the same key across status updates", async t => {
  const f = await fixture(t);
  await f.bridge.tick(); await settleArt(f.bridge);
  const first = await f.read();
  assert.equal(first.nativePid, 123); assert.equal(first.active, true); assert.equal(first.track.key, track().key);
  assert.match(first.track.artwork.file, /^artwork-[a-f0-9]{64}\.jpg$/);
  f.incoming({ state: "paused", track: { ...track(), title: "New display title\n" + "x".repeat(2000), artist: "\0Artist" } });
  await f.bridge.tick();
  const second = await f.read();
  assert.equal(second.track.key, first.track.key); assert.equal(f.artCalls, 1);
  assert.equal(second.track.artwork.file, first.track.artwork.file);
  assert.ok(second.track.title.length <= 240); assert.equal(second.track.artist, "Artist");
  assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 8192);
  assert.equal("artToken" in second.track, false);
});

test("new song clears old artwork immediately and rejects the late previous cover", async t => {
  const oldArt = deferred(), newArt = deferred(); let calls = 0, oldSignal;
  const f = await fixture(t, { provider: { readArt: (_track, options) => {
    if (++calls === 1) { oldSignal = options.signal; return oldArt.promise; }
    return newArt.promise;
  } } });
  await f.bridge.tick();
  f.incoming({ state: "playing", track: track("two", "cover-two") });
  await f.bridge.tick();
  assert.equal(oldSignal.aborted, true);
  assert.equal((await f.read()).track.key, track("two").key); assert.equal((await f.read()).track.artwork, null);
  oldArt.resolve(art); await new Promise(resolve => setImmediate(resolve)); await f.bridge.writeSerial;
  assert.equal((await f.read()).track.artwork, null);
  newArt.resolve({ ...art, data: Buffer.alloc(32, 2) }); await settleArt(f.bridge);
  assert.equal((await f.read()).track.artwork.file, `artwork-${hash(Buffer.alloc(32, 2))}.jpg`);
});

test("stop cancels metadata/art and cannot resurrect stale overlays", async t => {
  const artwork = deferred(); let signal;
  const f = await fixture(t, { provider: { readArt: (_track, options) => { signal = options.signal; return artwork.promise; } } });
  await f.bridge.tick(); f.select(null); f.bridge.invalidate(); await f.bridge.writeSerial;
  assert.equal(signal.aborted, true); assert.equal((await f.read()).active, false);
  artwork.resolve(art); await new Promise(resolve => setImmediate(resolve)); await f.bridge.writeSerial;
  const state = await f.read(); assert.equal(state.track, null); assert.equal(state.session, "");
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.startsWith("artwork-")), []);
});

test("a new generation rejects old metadata and artwork and binds the new native PID", async t => {
  const oldMetadata = deferred(); let call = 0;
  const f = await fixture(t, { provider: { readTrack: () => (++call === 1 ? oldMetadata.promise : Promise.resolve({ state: "playing", track: track("two") })) } });
  const firstTick = f.bridge.tick(); while (call === 0) await new Promise(resolve => setImmediate(resolve));
  f.select({ ...target("main:2:456"), nativePid: 456 }); await f.bridge.tick(); await settleArt(f.bridge);
  oldMetadata.resolve({ state: "playing", track: track("old") }); await firstTick;
  const state = await f.read(); assert.equal(state.nativePid, 456); assert.equal(state.track.key, track("two").key);
});

test("short metadata gaps preserve cover but a bounded gap expires it", async t => {
  const f = await fixture(t); await f.bridge.tick(); await settleArt(f.bridge);
  const cover = (await f.read()).track.artwork;
  f.incoming({ state: "waiting", track: null }); await f.bridge.tick();
  f.advance(29999); await f.bridge.tick(); assert.deepEqual((await f.read()).track.artwork, cover);
  f.advance(1); await f.bridge.tick(); assert.equal((await f.read()).track, null);
});

test("disconnected exact source clears metadata immediately without stopping the visualizer", async t => {
  const f = await fixture(t); await f.bridge.tick(); await settleArt(f.bridge);
  f.incoming({ state: "unavailable", track: null }); await f.bridge.tick();
  assert.equal((await f.read()).track, null); assert.equal((await f.read()).active, true);
});

test("heartbeat remains fresh while one metadata read is busy, without duplicate polls", async t => {
  const metadata = deferred(); let calls = 0;
  const f = await fixture(t, { provider: { readTrack: () => { calls++; return metadata.promise; } } });
  const first = f.bridge.tick(); while (!calls) await new Promise(resolve => setImmediate(resolve));
  f.advance(2000); await f.bridge.tick();
  assert.equal((await f.read()).updatedAt, 102000); assert.equal(calls, 1);
  f.select(null); f.bridge.invalidate(); metadata.resolve({ state: "playing", track: track() }); await first;
  await f.bridge.writeSerial; assert.equal((await f.read()).active, false);
});

test("missing add-on leaves metadata publisher inert", async t => {
  const f = await fixture(t, { readiness: async () => ({ ready: false }) });
  await f.bridge.tick(); assert.equal(f.metadataCalls, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("image failures and unsafe output remain isolated from audio and retry after five seconds", async t => {
  let calls = 0;
  const f = await fixture(t, { provider: { readArt: async () => { calls++; if (calls === 1) throw Error("private URL"); return { ...art, extension: "svg" }; } } });
  await f.bridge.tick(); await new Promise(resolve => setImmediate(resolve));
  f.advance(4999); await f.bridge.tick(); assert.equal(calls, 1);
  f.advance(1); await f.bridge.tick(); await settleArt(f.bridge); assert.equal(calls, 2);
  assert.equal((await f.read()).track.artwork, null); assert.equal((await f.read()).active, true);
  assert.equal(f.warnings.some(value => value.includes("private URL")), false);
});

test("edited or linked private image collision is preserved and not loaded", async t => {
  const f = await fixture(t); const file = `artwork-${hash(art.data)}.jpg`;
  await fs.writeFile(path.join(f.root, file), Buffer.alloc(32, 3));
  await f.bridge.tick(); await settleArt(f.bridge);
  assert.equal((await f.read()).track.artwork, null);
  assert.deepEqual(await fs.readFile(path.join(f.root, file)), Buffer.alloc(32, 3));
});

test("close clears state even while downloads are pending, without awaiting network completion", async t => {
  const pending = deferred(); let signal;
  const f = await fixture(t, { provider: { readArt: (_track, options) => { signal = options.signal; return pending.promise; } } });
  await f.bridge.tick(); await f.bridge.close();
  assert.equal(signal.aborted, true); assert.equal((await f.read()).active, false);
  pending.resolve(art); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.read()).track, null);
});

test("metadata gap expiry uses monotonic time even if the system clock moves backward", async t => {
  let wall = 100000, elapsed = 0;
  const f = await fixture(t, { clock: () => wall, monotonicClock: () => elapsed });
  await f.bridge.tick(); await settleArt(f.bridge);
  f.incoming({ state: "waiting", track: null }); await f.bridge.tick();
  wall = 1000; elapsed = 29999; await f.bridge.tick(); assert.ok((await f.read()).track);
  elapsed = 30000; await f.bridge.tick(); assert.equal((await f.read()).track, null);
});

test("persisted cache prunes only verified older generated assets and preserves edits", async t => {
  const f = await fixture(t); const rows = [];
  for (let i = 0; i < 14; i++) {
    const data = Buffer.alloc(32, i + 1), filename = `artwork-${hash(data)}.jpg`;
    await fs.writeFile(path.join(f.root, filename), data); rows.push([filename, 1]);
  }
  await fs.writeFile(path.join(f.root, rows[0][0]), "user edit");
  await fs.writeFile(path.join(f.root, "artwork-cache.json"), JSON.stringify(rows));
  const next = new NowPlayingBridge({ getTarget: () => null, provider: { close() {} }, runtimeRoot: f.root,
    readiness: async () => ({ ready: true }), clock: () => 100000, intervalMs: 0, warn() {} });
  await next.ready; await next.pruneArtwork();
  assert.equal(await fs.readFile(path.join(f.root, rows[0][0]), "utf8"), "user edit");
  await assert.rejects(fs.stat(path.join(f.root, rows[1][0])), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "artwork-cache.json"))).length, 12);
  await next.close();
});
