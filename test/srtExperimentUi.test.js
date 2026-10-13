"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/srt-experiment.js"), "utf8");
const html = fs.readFileSync(require.resolve("../public/srt-experiment.html"), "utf8");
const css = fs.readFileSync(require.resolve("../public/srt-experiment.css"), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const RECOVERY_KEY = "soundSpectrum.srtExperimentController.v1";
const videoProfile = (target = 600) => ({ requestedBitrateMbps: target, configuredBitrateMbps: target === 600 ? 599.999488 : 60,
  encoderMode: target === 600 ? "independent-srt" : "shared-publisher", width: 3840, height: 2160, fps: 60 });
function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function fixture(options = {}) {
  const elements = new Map(), requests = [], timers = new Map(), pageEvents = new Map(); let at = options.time ?? 1000000, timerId = 0, randomCall = 0;
  const storage = Object.hasOwn(options, "storage") ? options.storage : memoryStorage();
  const addPageEvent = (name, callback) => { if (!pageEvents.has(name)) pageEvents.set(name, []); pageEvents.get(name).push(callback); };
  const document = { addEventListener: addPageEvent, getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", hidden: false, disabled: false, attributes: new Map(), listeners: new Map(),
      addEventListener(event, callback) { this.listeners.set(event, callback); }, setAttribute(key, value) { this.attributes.set(key, value); },
      removeAttribute(key) { this.attributes.delete(key); }, focus() { this.focused = true; }, select() { this.selected = true; } });
    return elements.get(id);
  } };
  const state = options.serverState || {
    current: { state: "running", transport: "obs-webrtc", generation: 7, srtExperiment: { enabled: true, available: true, videoTargetsMbps: [60, 600] },
      videoStats: { width: 3840, height: 2160, targetFps: 60, configuredBitrateMbps: 60 }, visualDelay: { currentMs: 1635 } },
    own: { state: "idle" }, fail: null, failStatus: 503, failMessage: "secret-srt-url-do-not-show", startOverride: null, stopOverride: null, custom: null
  };
  const response = value => ({ ok: true, status: 200, json: async () => value });
  const request = async (url, config) => {
    requests.push({ url, config });
    if (state.custom) { const custom = state.custom(url, config); if (custom) return custom; }
    if (state.fail && state.fail(url, config)) return { ok: false, status: state.failStatus, json: async () => ({ error: state.failMessage }) };
    if (url === "/api/soundspectrum/status") return response(state.current);
    if (config.method === "GET") return response({ ...state.own, connectionUrl: undefined });
    const body = JSON.parse(config.body);
    if (body.action === "stop") { state.own = state.stopOverride || { state: "idle" }; return response(state.own); }
    state.own = state.startOverride ? { videoProfile: videoProfile(body.videoBitrateMbps), ...state.startOverride } : { state: "ready", generation: body.generation, expiresAt: at + 600000, maxDurationMs: 600000,
      requestedLatencyMs: 250, connectionUrl: "srt://192.168.50.119:8890?mode=caller&latency=250&streamid=read:visualizer&passphrase=private-key",
      videoProfile: videoProfile(body.videoBitrateMbps), metrics: { readers: body.videoBitrateMbps === 600 ? null : 0, observedAt: body.videoBitrateMbps === 600 ? null : at, stats: [] } };
    return response(state.own);
  };
  const context = { window: null, URL, URLSearchParams, Uint8Array, AbortController, addEventListener: addPageEvent }; context.window = context;
  vm.runInNewContext(source, context);
  const controller = context.createSrtExperimentController({ document, fetch: request, now: () => at, storage,
    crypto: options.noCrypto ? {} : { getRandomValues(bytes) { bytes.fill((options.randomByte ?? 15) + randomCall++); return bytes; } },
    navigator: options.navigator || {}, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms, at: at + ms }); return timerId; }, clearTimeout: id => timers.delete(id) });
  const element = id => elements.get(id);
  const fire = ms => { const timer = [...timers.entries()].find(([, value]) => value.ms === ms); assert.ok(timer, "timer " + ms + " exists"); timers.delete(timer[0]); timer[1].fn(); };
  return { controller, requests, timers, state, element, context, document, response, fire, storage, now: () => at, advance(ms) { at += ms; },
    event(name) { for (const callback of pageEvents.get(name) || []) callback(); },
    posts: () => requests.filter(value => value.config.method === "POST") };
}

test("opening and refreshing the control page is passive and only reads fixed status routes", async () => {
  const f = fixture(); assert.equal(f.requests.length, 0); await f.controller.refresh();
  assert.equal(f.requests.length, 2); assert.equal(f.posts().length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.requests[0].url, "/api/soundspectrum/status");
  assert.match(f.requests[1].url, /^\/api\/soundspectrum\/srt\?viewerId=srt-[a-f0-9]{32}$/);
  assert.ok(f.requests.every(value => value.config.cache === "no-store" && value.config.credentials === "same-origin"));
  assert.equal(f.element("srtStart").disabled, false); assert.equal(f.element("srtStop").disabled, true);
  assert.match(f.element("srtProfile").textContent, /3840 × 2160.*60 fps.*60 Mbps target/);
  assert.equal(f.element("srtVisualDelay").textContent, "1635 ms · unchanged");
});

test("Start joins the fresh exact running generation and holds only its private experiment identifier", async () => {
  const f = fixture(); await f.controller.refresh(); f.state.current.generation = 8; await f.controller.start();
  assert.equal(f.posts().length, 1); const post = f.posts()[0];
  assert.equal(post.url, "/api/soundspectrum/srt"); assert.deepEqual(JSON.parse(post.config.body), { action: "start", viewerId: "srt-" + "10".repeat(16), generation: 8, videoBitrateMbps: 600 });
  assert.equal(f.controller.state().generation, 8); assert.equal(f.controller.state().active, true);
  assert.equal(f.element("srtConnection").hidden, false); assert.match(f.element("srtConnectionUrl").value, /^srt:\/\/192\.168\.50\.119/);
  assert.equal(f.element("srtNativeLink").attributes.get("href"), f.element("srtConnectionUrl").value);
  assert.equal(f.element("srtStart").disabled, true); assert.equal(f.element("srtStop").disabled, false);
  assert.equal(f.element("srtConnected").textContent, "Unknown · native delivery not measured"); assert.match(f.element("srtStatus").textContent, /Native delivery counters are not measured/);
  assert.ok([...f.timers.values()].some(timer => timer.ms === 3000)); assert.ok([...f.timers.values()].some(timer => timer.ms === 600000));
});

test("idle, JPEG, starting, unavailable and invalid-generation publishers never receive Start", async () => {
  for (const change of [{ state: "idle" }, { state: "starting" }, { transport: "jpeg" }, { generation: -1 }, { generation: "7" }, { srtExperiment: { available: false } }, { srtExperiment: {} }]) {
    const f = fixture(); Object.assign(f.state.current, change); await f.controller.refresh(); await f.controller.start();
    assert.equal(f.posts().length, 0); assert.equal(f.element("srtStart").disabled, true);
  }
});

test("cryptographic token support is required without an insecure fallback", async () => {
  const f = fixture({ noCrypto: true }); await f.controller.refresh(); await f.controller.start();
  assert.equal(f.posts().length, 0); assert.equal(f.element("srtStart").disabled, true);
  assert.doesNotMatch(source, /Math\.random/);
});

test("Stop revokes only this experiment and clears the private native URL before its request settles", async () => {
  const f = fixture(); await f.controller.start(); let resolve;
  f.state.custom = (url, config) => url === "/api/soundspectrum/srt" && JSON.parse(config.body).action === "stop" ? new Promise(yes => { resolve = yes; }) : null;
  const pending = f.controller.stop(); await flush();
  assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtConnection").hidden, true); assert.equal(f.element("srtNativeLink").attributes.has("href"), false);
  resolve(f.response({ state: "idle" })); await pending;
  assert.deepEqual(JSON.parse(f.posts().at(-1).config.body), { action: "stop", viewerId: "srt-" + "10".repeat(16), generation: 7 });
  assert.equal(f.controller.state().active, false); assert.equal(f.timers.size, 0);
  assert.ok(f.posts().every(value => value.url === "/api/soundspectrum/srt"));
});

test("unknown Start outcomes remain stoppable and cannot renew through another Start", async () => {
  const f = fixture(); f.state.fail = (url, config) => config.method === "POST" && url === "/api/soundspectrum/srt";
  await f.controller.start(); assert.equal(f.controller.state().active, true); assert.equal(f.element("srtStop").disabled, false);
  await f.controller.start(); assert.equal(f.posts().length, 1); assert.equal(f.element("srtConnectionUrl").value, "");
  assert.doesNotMatch(f.element("srtStatus").textContent, /secret-srt/);
  f.state.fail = null; await f.controller.refresh(); assert.equal(f.controller.state().active, false);
});

test("Stop failure keeps bounded ownership for explicit retry without exposing private error text", async () => {
  const f = fixture(); await f.controller.start(); f.state.fail = (_, config) => config.method === "POST";
  await f.controller.stop(); assert.equal(f.controller.state().active, true); assert.equal(f.element("srtStop").disabled, false);
  assert.equal(f.element("srtConnectionUrl").value, ""); assert.match(f.element("srtStatus").textContent, /Tap Stop again/);
  f.state.fail = null; await f.controller.stop(); assert.equal(f.controller.state().active, false);
});

test("the real stopped receipt is terminal, while cleanup errors clear private data and require fresh main status", async () => {
  const f = fixture(); await f.controller.start(); f.state.stopOverride = { state: "stopped" }; await f.controller.stop();
  assert.equal(f.controller.state().active, false); assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.timers.size, 0);
  const failed = fixture(); await failed.controller.start(); failed.state.fail = (_, config) => config.method === "POST";
  await failed.controller.stop(); failed.state.fail = null; failed.state.own = { state: "error" }; await failed.controller.refresh();
  assert.equal(failed.controller.state().active, false); assert.equal(failed.element("srtStart").disabled, true);
  assert.match(failed.element("srtStatus").textContent, /experiment failed.*active experiment was not confirmed/); assert.equal(failed.element("srtConnectionUrl").value, "");
});

test("a 502 Stop failure reports possible shared cleanup without a false success or raw server errors", async () => {
  const f = fixture(); f.element("srtVideoBitrate").value = "60"; await f.controller.start(); f.state.failStatus = 502; f.state.fail = (_, config) => config.method === "POST";
  await f.controller.stop(); assert.match(f.element("srtStatus").textContent, /cleanup failed.*Shared visuals may have stopped.*Refresh status/);
  assert.doesNotMatch(f.element("srtStatus").textContent, /secret-srt|experiment stopped/);
  assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtNativeLink").attributes.has("href"), false);
});

test("a ready listener claims a native connection only with fresh positive reader counts", async () => {
  const f = fixture(); f.element("srtVideoBitrate").value = "60"; await f.controller.start(); f.state.own.metrics = { readers: 1, observedAt: f.now(), stats: [] };
  f.fire(3000); await flush(); assert.match(f.element("srtStatus").textContent, /native receiver is connected/);
  f.advance(6000); f.fire(3000); await flush(); assert.match(f.element("srtStatus").textContent, /not yet verified/);
  f.state.own = { ...f.state.own, state: "starting" }; f.fire(3000); await flush();
  assert.match(f.element("srtStatus").textContent, /setup is still in progress/); assert.equal(f.element("srtConnectionUrl").value, "");
});

test("fixed local expiry clears sensitive controls independently of a stalled status request", async () => {
  const f = fixture(); await f.controller.start(); f.state.custom = (_, config) => config.method === "GET" ? new Promise(() => {}) : null;
  f.fire(3000); await flush(); f.advance(600000); f.fire(600000); await flush();
  assert.equal(f.controller.state().active, false); assert.equal(f.element("srtConnectionUrl").value, "");
  assert.equal(f.element("srtNativeLink").attributes.has("href"), false); assert.equal(f.element("srtConnection").hidden, true);
  assert.equal(f.posts().length, 1); assert.equal(f.controller.state().phase, "expired");
});

test("polls never renew a lease or create media, and backend expiry clears the private connection", async () => {
  const f = fixture(); await f.controller.start(); f.fire(3000); await flush();
  assert.equal(f.posts().length, 1); assert.equal(f.requests.at(-1).config.method, "GET");
  f.state.own = { state: "expired" }; f.fire(3000); await flush();
  assert.equal(f.controller.state().active, false); assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.timers.size, 0);
  assert.doesNotMatch(source, /RTCPeerConnection|MediaStream|new WebSocket|getUserMedia|captureStream|sendBeacon|sessionStorage|console\./);
  assert.doesNotMatch(source, /addEventListener\(["'](?:pagehide|visibilitychange)/);
  assert.doesNotMatch(html, /<(?:video|audio|canvas|iframe)\b/i);
});

test("changed generation and stale status failures clear old private URLs", async () => {
  const f = fixture(); await f.controller.start(); f.state.own = { state: "ready", generation: 8, expiresAt: f.now() + 600000 };
  f.fire(3000); await flush(); assert.equal(f.controller.state().active, false); assert.equal(f.element("srtConnectionUrl").value, "");
  const failed = fixture(); await failed.controller.start(); failed.state.fail = (_, config) => config.method === "GET";
  failed.fire(3000); await flush(); assert.equal(failed.element("srtConnectionUrl").value, ""); assert.equal(failed.element("srtStop").disabled, false);
  assert.equal(failed.element("srtNativeLink").attributes.has("href"), false); assert.match(failed.element("srtStatus").textContent, /could not be checked/);
});

test("private connections reject external, active-content and malformed destinations", async () => {
  for (const url of ["https://192.168.50.119:8890/", "javascript:alert(1)", "srt://203.0.113.2:8890", "srt://example.com:8890", "srt://user:pass@192.168.50.119:8890", "srt://192.168.50.119", "srt://192.168.50.119:99999", "srt://192.168.50.119:8890#secret", "srt://192.168.50.999:8890"]) {
    const f = fixture(); f.state.startOverride = { state: "ready", generation: 7, expiresAt: f.now() + 600000, connectionUrl: url };
    await f.controller.start(); assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtNativeLink").attributes.has("href"), false);
    assert.equal(f.element("srtStop").disabled, false);
  }
});

test("server expiry cannot extend the original ten-minute bound", async () => {
  const f = fixture(); f.state.startOverride = { state: "ready", generation: 7, expiresAt: f.now() + 3600000, connectionUrl: "srt://10.1.2.3:8890?mode=caller" };
  await f.controller.start(); assert.equal(f.controller.state().expiresAt, f.now() + 600000);
  f.advance(3000); f.state.own.expiresAt += 600000; f.fire(3000); await flush();
  assert.equal(f.controller.state().expiresAt, f.now() + 597000);
});

test("fresh server reader and counter measurements preserve real zero without implying physical latency", async () => {
  const f = fixture(); f.element("srtVideoBitrate").value = "60"; await f.controller.start(); f.state.own = { ...f.state.own, state: "active", metrics: { readers: 1, observedAt: f.now(), stats: [{ msSendTsbPdDelay: 250, mbpsSendRate: 59.3, packetsRetrans: 0, packetsSendDrop: 0 }] } };
  f.fire(3000); await flush();
  assert.equal(f.element("srtConnected").textContent, "1 receiver connected"); assert.equal(f.element("srtNegotiatedDelay").textContent, "250 ms");
  assert.equal(f.element("srtSendRate").textContent, "59.3 Mbps"); assert.equal(f.element("srtRetransmits").textContent, "0"); assert.equal(f.element("srtDropped").textContent, "0");
  f.advance(6000); f.fire(3000); await flush(); assert.match(f.element("srtConnected").textContent, /stale/); assert.equal(f.element("srtSendRate").textContent, "Unknown");
  assert.match(html, /does not measure the tablet’s decoded frames or physical display timing/);
});

test("unknown and nonnumeric counters remain unknown, with numeric receiver aggregation bounded", async () => {
  const f = fixture(); f.element("srtVideoBitrate").value = "60"; await f.controller.start(); f.state.own.metrics = { readers: null, observedAt: f.now(), stats: [{ msSendTsbPdDelay: null, mbpsSendRate: "60", packetsRetrans: null, packetsSendDrop: -1 }] };
  f.fire(3000); await flush(); assert.equal(f.element("srtSendRate").textContent, "Unknown"); assert.equal(f.element("srtRetransmits").textContent, "Unknown");
  assert.match(f.element("srtNegotiatedDelay").textContent, /Unknown/);
  f.state.own.metrics = { readers: 2, observedAt: f.now(), stats: [{ msSendTsbPdDelay: 250, mbpsSendRate: 20 }, { msSendTsbPdDelay: 500, mbpsSendRate: 25 }] };
  f.fire(3000); await flush(); assert.equal(f.element("srtConnected").textContent, "2 receivers connected"); assert.equal(f.element("srtNegotiatedDelay").textContent, "250 ms / 500 ms"); assert.equal(f.element("srtSendRate").textContent, "45.0 Mbps");
});

test("copy uses secure clipboard only for the active private URL and fallback selects the readonly field", async () => {
  const copied = [], f = fixture({ navigator: { clipboard: { writeText: async value => copied.push(value) } } });
  await f.controller.copy(); assert.equal(copied.length, 0); await f.controller.start(); await f.controller.copy();
  assert.equal(copied[0], f.element("srtConnectionUrl").value); await f.controller.stop(); await f.controller.copy(); assert.equal(copied.length, 1);
  const fallback = fixture(); await fallback.controller.start(); await fallback.controller.copy();
  assert.equal(fallback.element("srtConnectionUrl").focused, true); assert.equal(fallback.element("srtConnectionUrl").selected, true);
  assert.match(fallback.element("srtCopyStatus").textContent, /selected/);
});

test("late clipboard completion cannot restore secret status after Stop", async () => {
  let resolve; const f = fixture({ navigator: { clipboard: { writeText: () => new Promise(yes => { resolve = yes; }) } } });
  await f.controller.start(); const pending = f.controller.copy(); await f.controller.stop(); resolve(); await pending;
  assert.equal(f.element("srtCopyStatus").textContent, ""); assert.equal(f.element("srtConnectionUrl").value, "");
});

test("page controls are labeled, touch-sized, local-only and usable at phone widths", () => {
  assert.match(html, /<html lang="en"/); assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.match(html, /<label for="srtConnectionUrl"/); assert.match(html, /id="srtConnectionUrl"[^>]*readonly[^>]*aria-describedby="srtConnectionHelp"/);
  assert.match(html, /id="srtStatus" role="status" aria-live="polite"/); assert.match(html, /href="#experiment"/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//); assert.match(css, /min-height: 44px/); assert.match(css, /font-size: 16px/);
  assert.match(css, /:focus-visible/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(html, /Record Larix’s existing playback-buffer setting/); assert.match(html, /expires after 10 minutes even if this page closes/);
});

test("explicit Start saves only a bounded controller capability, never the native connection or passwords", async () => {
  const f = fixture(); await f.controller.refresh(); assert.equal(f.storage.getItem(RECOVERY_KEY), null);
  await f.controller.start(); const raw = f.storage.getItem(RECOVERY_KEY), saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ["expiresAt", "generation", "startedAt", "version", "viewerId"]);
  assert.equal(saved.version, 1); assert.equal(saved.generation, 7); assert.equal(saved.expiresAt, f.controller.state().expiresAt);
  assert.equal(saved.expiresAt - saved.startedAt, 600000); assert.match(saved.viewerId, /^srt-[a-f0-9]{32}$/);
  assert.doesNotMatch(raw, /srt:\/\/|passphrase|streamid|private-key|connectionUrl|password/);
});

test("a new page after closing the tab passively recovers its original Stop control and deadline without native URL recovery", async () => {
  const first = fixture(); await first.controller.start(); const raw = first.storage.getItem(RECOVERY_KEY), saved = JSON.parse(raw);
  const reopened = fixture({ storage: first.storage, serverState: first.state, time: first.now() + 60000, randomByte: 31 });
  assert.equal(reopened.posts().length, 0); assert.equal(reopened.element("srtStop").disabled, true);
  await reopened.controller.refresh(); assert.equal(reopened.posts().length, 0);
  assert.equal(reopened.controller.state().generation, saved.generation); assert.equal(reopened.controller.state().expiresAt, saved.expiresAt);
  assert.equal(reopened.element("srtStart").disabled, true); assert.equal(reopened.element("srtStop").disabled, false);
  assert.equal(reopened.element("srtConnectionUrl").value, ""); assert.equal(reopened.element("srtNativeLink").attributes.has("href"), false);
  assert.match(reopened.element("srtStatus").textContent, /Recovered.*Stop control/); assert.equal(first.storage.getItem(RECOVERY_KEY), raw);
  await reopened.controller.stop(); assert.equal(JSON.parse(reopened.posts()[0].config.body).viewerId, saved.viewerId);
  assert.equal(first.storage.getItem(RECOVERY_KEY), null); assert.equal(reopened.controller.state().active, false);
  await reopened.controller.start(); assert.equal(reopened.posts().length, 2); assert.equal(reopened.controller.state().active, true);
});

test("canonical idle on recovery clears only the stale own record without any automatic POST", async () => {
  const first = fixture(); await first.controller.start(); first.state.own = { state: "idle" };
  const recovered = fixture({ storage: first.storage, serverState: first.state, randomByte: 31 }); await recovered.controller.refresh();
  assert.equal(recovered.posts().length, 0); assert.equal(first.storage.getItem(RECOVERY_KEY), null);
  assert.equal(recovered.controller.state().active, false); assert.equal(recovered.element("srtStop").disabled, true);
});

test("expired, future, malformed and extended recovery records are rejected and collected", async () => {
  const baseline = { version: 1, viewerId: "srt-" + "0f".repeat(16), generation: 7, startedAt: 1000000, expiresAt: 1600000 };
  for (const record of [{ ...baseline, expiresAt: 1000000 }, { ...baseline, expiresAt: 1600001 }, { ...baseline, startedAt: 1000001 },
    { ...baseline, generation: "7" }, { ...baseline, viewerId: "unsafe" }, { ...baseline, connectionUrl: "srt://private" },
    { ...baseline, startedAt: -1 }, { ...baseline, version: 2 }, "{broken", "x".repeat(513)]) {
    const storage = memoryStorage(); storage.setItem(RECOVERY_KEY, typeof record === "string" ? record : JSON.stringify(record));
    const f = fixture({ storage, randomByte: 31 }); await f.controller.refresh();
    assert.equal(storage.getItem(RECOVERY_KEY), null); assert.equal(f.controller.state().active, false); assert.equal(f.posts().length, 0);
  }
});

test("disabled recovery storage keeps explicit controls working and warns that this tab must stay open", async () => {
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  for (const storage of [null, blocked, { ...memoryStorage(), setItem() { throw Error("quota"); } }]) {
    const f = fixture({ storage }); await f.controller.start(); assert.equal(f.controller.state().active, true);
    assert.match(f.element("srtExpiry").textContent, /Recovery controls could not be saved.*keep this tab open/);
    assert.equal(f.element("srtStop").disabled, false); await f.controller.stop(); assert.equal(f.controller.state().active, false);
  }
});

test("a second pre-opened tab never overwrites a valid unexpired controller and offers passive recovery", async () => {
  const storage = memoryStorage(), first = fixture({ storage }), second = fixture({ storage, serverState: first.state, randomByte: 31 });
  await first.controller.start(); const raw = storage.getItem(RECOVERY_KEY); await second.controller.start();
  assert.equal(second.posts().length, 0); assert.equal(storage.getItem(RECOVERY_KEY), raw);
  assert.match(second.element("srtStatus").textContent, /Another tab.*Refresh status/); assert.equal(second.element("srtStop").disabled, true);
  await second.controller.refresh(); assert.equal(second.posts().length, 0); assert.equal(second.element("srtStop").disabled, false);
  assert.equal(second.controller.state().expiresAt, first.controller.state().expiresAt);
});

test("confirmed Stop and local expiry never delete a different valid recovery record", async () => {
  const f = fixture(); await f.controller.start();
  const other = JSON.stringify({ version: 1, viewerId: "srt-" + "1f".repeat(16), generation: 8, startedAt: f.now(), expiresAt: f.now() + 600000 });
  f.storage.setItem(RECOVERY_KEY, other); await f.controller.stop(); assert.equal(f.storage.getItem(RECOVERY_KEY), other);
  const expiring = fixture(); await expiring.controller.start();
  const newer = JSON.stringify({ version: 1, viewerId: "srt-" + "1f".repeat(16), generation: 8, startedAt: expiring.now() + 1000, expiresAt: expiring.now() + 601000 });
  expiring.storage.setItem(RECOVERY_KEY, newer); expiring.advance(600000); expiring.fire(600000);
  assert.equal(expiring.storage.getItem(RECOVERY_KEY), newer);
});

test("an exact known active-experiment 409 shows the real conflict without a fake Stop or stored rejected claim", async () => {
  const f = fixture(); f.state.failStatus = 409; f.state.failMessage = "Stop the current SRT experiment before starting another."; f.state.fail = (_, config) => config.method === "POST";
  await f.controller.start(); assert.equal(f.controller.state().active, false); assert.equal(f.element("srtStop").disabled, true);
  assert.equal(f.storage.getItem(RECOVERY_KEY), null); assert.match(f.element("srtStatus").textContent, /Another SRT experiment is still active/);
  assert.doesNotMatch(f.element("srtStatus").textContent, /visualizer changed/); await f.controller.start(); assert.equal(f.posts().length, 1);
  await f.controller.refresh(); assert.equal(f.posts().length, 1);
});

test("an unknown Start outcome survives tab closure for bounded passive status and explicit Stop", async () => {
  const first = fixture(); first.state.fail = (_, config) => config.method === "POST"; await first.controller.start();
  const saved = JSON.parse(first.storage.getItem(RECOVERY_KEY)); first.state.fail = null;
  first.state.own = { state: "ready", generation: 7, expiresAt: saved.expiresAt + 5000, metrics: { readers: 0, observedAt: first.now(), stats: [] } };
  const recovered = fixture({ storage: first.storage, serverState: first.state, time: first.now() + 1000 }); await recovered.controller.refresh();
  assert.equal(recovered.posts().length, 0); assert.equal(recovered.controller.state().expiresAt, saved.expiresAt);
  assert.equal(recovered.element("srtStop").disabled, false); await recovered.controller.stop(); assert.equal(recovered.posts().length, 1);
});

test("a successful receipt repairs an interleaved rejected-tab claim only after passive confirmation that it owns no experiment", async () => {
  const f = fixture(); let finish;
  const conflicting = { version: 1, viewerId: "srt-" + "1f".repeat(16), generation: 7, startedAt: f.now(), expiresAt: f.now() + 600000 };
  f.state.custom = (url, config) => config.method === "POST" ? new Promise(resolve => { finish = resolve; }) :
    url.includes(conflicting.viewerId) ? Promise.resolve(f.response({ state: "idle" })) : null;
  const starting = f.controller.start(); while (!finish) await flush(); f.storage.setItem(RECOVERY_KEY, JSON.stringify(conflicting));
  finish(f.response({ state: "ready", generation: 7, expiresAt: f.now() + 600000, videoProfile: videoProfile(), connectionUrl: "srt://192.168.50.119:8890?mode=caller" })); await starting;
  const saved = JSON.parse(f.storage.getItem(RECOVERY_KEY)); assert.notEqual(saved.viewerId, conflicting.viewerId);
  assert.equal(f.posts().length, 1); assert.ok(f.requests.some(request => request.config.method === "GET" && request.url.includes(conflicting.viewerId)));
  const recovered = fixture({ storage: f.storage, serverState: f.state }); assert.equal(recovered.controller.state().generation, 7);
});

test("a confirmed receipt preserves another valid owned record and warns when recovery cannot be saved", async () => {
  const f = fixture(); let finish;
  const conflicting = { version: 1, viewerId: "srt-" + "1f".repeat(16), generation: 7, startedAt: f.now(), expiresAt: f.now() + 600000 };
  f.state.custom = (url, config) => config.method === "POST" ? new Promise(resolve => { finish = resolve; }) :
    url.includes(conflicting.viewerId) ? Promise.resolve(f.response({ state: "ready", generation: 7, expiresAt: conflicting.expiresAt })) : null;
  const starting = f.controller.start(); while (!finish) await flush(); const raw = JSON.stringify(conflicting); f.storage.setItem(RECOVERY_KEY, raw);
  finish(f.response({ state: "ready", generation: 7, expiresAt: f.now() + 600000, videoProfile: videoProfile(), connectionUrl: "srt://192.168.50.119:8890?mode=caller" })); await starting;
  assert.equal(f.storage.getItem(RECOVERY_KEY), raw); assert.match(f.element("srtExpiry").textContent, /could not be saved/);
});

test("a shortened server deadline is saved and cannot grow after reopening the page", async () => {
  const f = fixture(); await f.controller.start(); const original = f.controller.state().expiresAt;
  f.state.own.expiresAt = original - 5000; f.fire(3000); await flush();
  assert.equal(f.controller.state().expiresAt, original - 5000); assert.equal(JSON.parse(f.storage.getItem(RECOVERY_KEY)).expiresAt, original - 5000);
  f.state.own.expiresAt = original;
  const recovered = fixture({ storage: f.storage, serverState: f.state }); await recovered.controller.refresh();
  assert.equal(recovered.controller.state().expiresAt, original - 5000); assert.equal(recovered.posts().length, 0);
});

test("a late conflicting-record probe cannot save an accepted receipt after local expiry", async () => {
  const f = fixture(); let finishStart, finishProbe;
  const conflicting = { version: 1, viewerId: "srt-" + "1f".repeat(16), generation: 7, startedAt: f.now(), expiresAt: f.now() + 600000 };
  f.state.custom = (url, config) => config.method === "POST" ? new Promise(resolve => { finishStart = resolve; }) :
    url.includes(conflicting.viewerId) ? new Promise(resolve => { finishProbe = resolve; }) : null;
  const starting = f.controller.start(); while (!finishStart) await flush(); f.storage.setItem(RECOVERY_KEY, JSON.stringify(conflicting));
  finishStart(f.response({ state: "ready", generation: 7, expiresAt: f.now() + 600000, videoProfile: videoProfile(), connectionUrl: "srt://192.168.50.119:8890?mode=caller" }));
  while (!finishProbe) await flush(); f.advance(600000); f.fire(600000);
  finishProbe(f.response({ state: "idle" })); await starting;
  assert.equal(f.storage.getItem(RECOVERY_KEY), null); assert.equal(f.controller.state().active, false);
  assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.posts().length, 1);
});

test("a stale recovered tab cannot Stop a fresh explicit trial on the same publisher generation", async () => {
  const first = fixture(); let owner = null;
  first.state.custom = (url, config) => {
    if (!url.startsWith("/api/soundspectrum/srt")) return null;
    if (config.method === "GET") {
      const viewer = new URLSearchParams(url.split("?")[1]).get("viewerId");
      return Promise.resolve(first.response(owner?.viewerId === viewer ? { state: "ready", generation: 7, expiresAt: owner.expiresAt } : { state: "stopped" }));
    }
    const body = JSON.parse(config.body);
    if (body.action === "start") {
      owner = { viewerId: body.viewerId, generation: body.generation, expiresAt: first.now() + 600000 };
      return Promise.resolve(first.response({ state: "ready", ...owner, videoProfile: videoProfile(body.videoBitrateMbps), connectionUrl: "srt://192.168.50.119:8890?mode=caller" }));
    }
    if (body.viewerId !== owner?.viewerId || body.generation !== owner?.generation) return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: "This controller does not own the SRT experiment." }) });
    owner = null; return Promise.resolve(first.response({ state: "stopped" }));
  };
  await first.controller.start(); const originalViewer = owner.viewerId;
  const stale = fixture({ storage: first.storage, serverState: first.state, randomByte: 31 }); await stale.controller.refresh();
  assert.equal(stale.element("srtStop").disabled, false);
  await first.controller.stop(); await first.controller.start(); const newViewer = owner.viewerId, saved = first.storage.getItem(RECOVERY_KEY);
  assert.notEqual(newViewer, originalViewer); assert.equal(owner.generation, 7);
  await stale.controller.stop();
  assert.equal(JSON.parse(stale.posts()[0].config.body).viewerId, originalViewer); assert.equal(owner.viewerId, newViewer);
  assert.equal(first.storage.getItem(RECOVERY_KEY), saved); assert.match(stale.element("srtStatus").textContent, /could not be confirmed/);
  await stale.controller.refresh(); assert.equal(stale.element("srtStop").disabled, true); assert.equal(stale.controller.state().active, false);
  assert.equal(owner.viewerId, newViewer); assert.equal(first.storage.getItem(RECOVERY_KEY), saved);
});

test("600 Mbps is the passive default, and unavailable targets never fall back or POST", async () => {
  for (const targets of [undefined, [60], ["600"], []]) {
    const f = fixture(); f.state.current.srtExperiment.videoTargetsMbps = targets;
    await f.controller.refresh(); assert.equal(f.element("srtVideoBitrate").value, "600");
    assert.equal(f.element("srtStart").disabled, true); assert.match(f.element("srtVideoTargetHelp").textContent, /600 Mbps SRT is not available.*No fallback/);
    await f.controller.start(); assert.equal(f.posts().length, 0); assert.equal(f.storage.getItem(RECOVERY_KEY), null);
    assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtStop").disabled, true);
    assert.match(f.element("srtProfile").textContent, /60 Mbps target/);
  }
  const explicit = fixture(); explicit.state.current.srtExperiment.videoTargetsMbps = [60]; await explicit.controller.refresh();
  explicit.element("srtVideoBitrate").value = "60"; explicit.element("srtVideoBitrate").listeners.get("change")();
  assert.equal(explicit.posts().length, 0); assert.equal(explicit.element("srtStart").disabled, false);
  assert.match(explicit.element("srtVideoTargetHelp").textContent, /baseline comparison/);
});

test("the 600 Mbps receipt confirms an independent encoder while keeping WebRTC configuration separate", async () => {
  const f = fixture(), original = JSON.stringify(f.state.current); await f.controller.start();
  assert.equal(JSON.parse(f.posts()[0].config.body).videoBitrateMbps, 600);
  assert.equal(f.element("srtRequestedRate").textContent, "600 Mbps · server confirmed");
  assert.equal(f.element("srtConfiguredRate").textContent, "≈ 600.0 Mbps · configured, not measured");
  assert.equal(f.element("srtVideoProfile").textContent, "3840 × 2160 · 60 fps target");
  assert.equal(f.element("srtEncoderMode").textContent, "Independent SRT encoder");
  assert.equal(f.element("srtSendRate").textContent, "Unknown"); assert.match(f.element("srtEncodedRate").textContent, /Unknown/);
  assert.match(f.element("srtObservedCodec").textContent, /Unknown/); assert.equal(f.element("srtVideoBitrate").disabled, true);
  assert.match(f.element("srtProfile").textContent, /60 Mbps target/); assert.equal(JSON.stringify(f.state.current), original);
});

test("60 Mbps is only sent after an explicit choice and reuses the shared publisher without changing its settings", async () => {
  const f = fixture(), original = JSON.stringify(f.state.current); await f.controller.refresh();
  f.element("srtVideoBitrate").value = "60"; f.element("srtVideoBitrate").listeners.get("change")();
  assert.equal(f.posts().length, 0); await f.controller.start();
  assert.equal(JSON.parse(f.posts()[0].config.body).videoBitrateMbps, 60);
  assert.equal(f.element("srtConfiguredRate").textContent, "60.0 Mbps · configured, not measured");
  assert.equal(f.element("srtEncoderMode").textContent, "Shared WebRTC publisher"); assert.equal(JSON.stringify(f.state.current), original);
  await f.controller.stop(); assert.equal(f.element("srtVideoBitrate").disabled, false); assert.equal(f.element("srtVideoBitrate").value, "60");
  assert.ok(f.posts().every(request => request.url === "/api/soundspectrum/srt"));
  assert.deepEqual(JSON.parse(f.posts()[1].config.body), { action: "stop", viewerId: "srt-" + "10".repeat(16), generation: 7 });
});

test("a target that becomes unavailable at Start is rejected before lease creation without a silent 60 Mbps substitution", async () => {
  const f = fixture(); await f.controller.refresh(); assert.equal(f.element("srtStart").disabled, false);
  f.state.current.srtExperiment.videoTargetsMbps = [60]; await f.controller.start();
  assert.equal(f.posts().length, 0); assert.equal(f.controller.state().active, false); assert.equal(f.storage.getItem(RECOVERY_KEY), null);
  assert.match(f.element("srtStatus").textContent, /selected SRT target is unavailable.*no fallback/i);
  assert.equal(f.element("srtVideoBitrate").value, "600"); assert.equal(f.element("srtConfiguredRate").textContent, "Not confirmed");
});

test("missing, mismatched and malformed encoder receipts keep only bounded Stop, never a falsely confirmed native connection", async () => {
  for (const profile of [undefined, videoProfile(60), { ...videoProfile(), encoderMode: "shared-publisher" },
    { ...videoProfile(), configuredBitrateMbps: 60 }, { ...videoProfile(), configuredBitrateMbps: "600" },
    { ...videoProfile(), width: "3840" }, { ...videoProfile(), fps: 0 }]) {
    const f = fixture(); f.state.startOverride = { state: "ready", generation: 7, expiresAt: f.now() + 600000,
      connectionUrl: "srt://192.168.50.119:8890?mode=caller", videoProfile: profile };
    await f.controller.start(); assert.equal(f.posts().length, 1); assert.equal(f.controller.state().active, true);
    assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtNativeLink").attributes.has("href"), false);
    assert.equal(f.element("srtStop").disabled, false); assert.equal(f.element("srtConfiguredRate").textContent, "Not confirmed");
    assert.deepEqual(Object.keys(JSON.parse(f.storage.getItem(RECOVERY_KEY))).sort(), ["expiresAt", "generation", "startedAt", "version", "viewerId"]);
  }
});

test("encoded video and observed H.264 format require their own fresh measurements, distinct from SRT send rate", async () => {
  const f = fixture(); await f.controller.start();
  f.state.own.videoProfile = { ...videoProfile(), videoBitrateMbps: 568.4, videoBitrateObservedAt: f.now(), videoBitrateWindowMs: 2000,
    observedCodec: { profile: "high", level: "6.1", observedAt: f.now(), measurement: "gstreamer-h264parse-caps" } };
  f.state.own.metrics = { readers: 1, observedAt: f.now(), stats: [{ mbpsSendRate: 615.2 }] };
  f.fire(3000); await flush();
  assert.equal(f.element("srtEncodedRate").textContent, "568.4 Mbps · 2.0 second window · 0.0 seconds old");
  assert.match(f.element("srtObservedCodec").textContent, /H\.264 high.*level 6\.1.*observed/);
  assert.equal(f.element("srtSendRate").textContent, "Unknown"); assert.match(f.element("srtConfiguredRate").textContent, /configured, not measured/);
  assert.equal(f.element("srtConnected").textContent, "Unknown · native delivery not measured"); assert.equal(f.element("srtNegotiatedDelay").textContent, "Unknown · not measured");
  f.advance(6000); f.fire(3000); await flush();
  assert.match(f.element("srtEncodedRate").textContent, /Unknown.*fresh/); assert.match(f.element("srtObservedCodec").textContent, /Unknown.*fresh/);
  assert.equal(f.element("srtSendRate").textContent, "Unknown"); assert.match(html, /Tablet decoded frames.*Unknown.*native player not measured/s);
});

test("future, nonnumeric and missing measurement timestamps remain unknown without leaking arbitrary codec data", async () => {
  const f = fixture(); await f.controller.start();
  for (const measurement of [
    { videoBitrateMbps: 600 }, { videoBitrateMbps: 600, videoBitrateObservedAt: f.now() + 1, videoBitrateWindowMs: 2000 },
    { videoBitrateMbps: "600", videoBitrateObservedAt: f.now(), videoBitrateWindowMs: 2000 },
    { videoBitrateMbps: 600, videoBitrateObservedAt: f.now(), videoBitrateWindowMs: 0 },
    { observedCodec: { profile: "private-key", level: "6.1", observedAt: f.now(), measurement: "gstreamer-h264parse-caps" } },
    { observedCodec: { profile: "high", level: "6.1", observedAt: f.now() + 1, measurement: "gstreamer-h264parse-caps" } },
    { observedCodec: { profile: "high", level: "6.1", observedAt: f.now(), measurement: "configured" } }
  ]) {
    f.state.own.videoProfile = { ...videoProfile(), ...measurement }; f.fire(3000); await flush();
    assert.match(f.element("srtEncodedRate").textContent, /Unknown/); assert.match(f.element("srtObservedCodec").textContent, /Unknown/);
    assert.doesNotMatch(f.element("srtObservedCodec").textContent, /private-key/);
  }
});

test("closed-page recovery reads its own 60 Mbps profile without storing bitrate or starting another encoder", async () => {
  const first = fixture(); first.element("srtVideoBitrate").value = "60"; await first.controller.start(); const raw = first.storage.getItem(RECOVERY_KEY);
  const restored = fixture({ storage: first.storage, serverState: first.state, randomByte: 31 }); await restored.controller.refresh();
  assert.equal(restored.posts().length, 0); assert.equal(restored.element("srtVideoBitrate").value, "60");
  assert.equal(restored.element("srtEncoderMode").textContent, "Shared WebRTC publisher"); assert.equal(restored.element("srtStop").disabled, false);
  assert.equal(restored.element("srtConnectionUrl").value, ""); assert.equal(first.storage.getItem(RECOVERY_KEY), raw);
  assert.doesNotMatch(raw, /bitrate|videoProfile|connectionUrl|passphrase/i);
  assert.equal(restored.controller.state().expiresAt, first.controller.state().expiresAt);
});

test("an unconfirmed or unexpectedly changed own video profile clears native connection while preserving bounded Stop", async () => {
  for (const profile of [undefined, videoProfile(60)]) {
    const f = fixture(); await f.controller.start(); assert.ok(f.element("srtConnectionUrl").value);
    f.state.own.videoProfile = profile; f.fire(3000); await flush();
    assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtStop").disabled, false);
    assert.equal(f.controller.state().active, true); assert.match(f.element("srtStatus").textContent, /video profile could not be confirmed/);
    assert.equal(f.element("srtConfiguredRate").textContent, "Not confirmed"); assert.equal(f.posts().length, 1);
  }
});

test("the bitrate selector is labeled and distinguishes a stress test from the shared baseline", () => {
  assert.match(html, /<label for="srtVideoBitrate">SRT video target/);
  assert.match(html, /id="srtVideoBitrate" aria-describedby="srtVideoTargetHelp"/);
  assert.match(html, /value="600" selected>600 Mbps.*independent SRT/);
  assert.match(html, /value="60">60 Mbps.*shared baseline/);
  assert.match(html, /600 Mbps is a separate encoder stress test/);
  assert.match(html, /Current WebRTC profile/); assert.match(css, /#srtVideoBitrate[^}]+min-height: 44px/s);
  assert.match(css, /#srtVideoBitrate \{[^}]+font-size: 16px/); assert.match(html, /WebRTC profile and audible playback stay unchanged/);
});

test("an owned independent-600 error retains only bounded Stop and clears connection and live observations", async () => {
  const f = fixture(); await f.controller.start(); const expiry = f.controller.state().expiresAt, record = f.storage.getItem(RECOVERY_KEY);
  f.state.own = { ...f.state.own, state: "error", expiresAt: expiry + 5000,
    videoProfile: { ...videoProfile(), videoBitrateMbps: 580, videoBitrateObservedAt: f.now(), videoBitrateWindowMs: 2000,
      observedCodec: { profile: "high", level: "6.1", observedAt: f.now(), measurement: "gstreamer-h264parse-caps" } },
    metrics: { readers: 1, observedAt: f.now(), stats: [{ mbpsSendRate: 620, packetsRetrans: 15, packetsSendDrop: 4 }] } };
  f.fire(3000); await flush();
  assert.equal(f.controller.state().active, true); assert.equal(f.controller.state().phase, "error"); assert.equal(f.controller.state().expiresAt, expiry);
  assert.equal(f.element("srtStop").disabled, false); assert.equal(f.element("srtStart").disabled, true); assert.equal(f.element("srtConnectionUrl").value, "");
  assert.equal(f.element("srtNativeLink").attributes.has("href"), false); assert.equal(f.storage.getItem(RECOVERY_KEY), record);
  assert.match(f.element("srtStatus").textContent, /SRT experiment failed.*Cleanup is still pending.*Stop to retry.*WebRTC viewers can continue/);
  assert.match(f.element("srtExpiry").textContent, /Stop retry remains available.*original 10-minute limit is unchanged/);
  assert.doesNotMatch(f.element("srtExpiry").textContent, /experiment running/);
  assert.equal(f.element("srtConnected").textContent, "Unknown · cleanup pending"); assert.equal(f.element("srtSendRate").textContent, "Unknown");
  assert.equal(f.element("srtRetransmits").textContent, "Unknown"); assert.equal(f.element("srtDropped").textContent, "Unknown");
  assert.match(f.element("srtEncodedRate").textContent, /Unknown/); assert.match(f.element("srtObservedCodec").textContent, /Unknown/);
  assert.match(f.element("srtProfile").textContent, /60 Mbps target/); assert.equal(f.posts().length, 1);
  await f.controller.stop(); assert.equal(f.controller.state().active, false); assert.equal(f.storage.getItem(RECOVERY_KEY), null); assert.equal(f.posts().length, 2);
});

test("an independent Stop cleanup 502 remains retryable without claiming the shared WebRTC publisher stopped", async () => {
  const f = fixture(); await f.controller.start(); const expiry = f.controller.state().expiresAt;
  f.state.failStatus = 502; f.state.fail = (_, config) => config.method === "POST";
  await f.controller.stop(); assert.equal(f.controller.state().active, true); assert.equal(f.controller.state().expiresAt, expiry);
  assert.equal(f.element("srtStop").disabled, false); assert.match(f.element("srtStatus").textContent, /Independent SRT cleanup could not be confirmed.*Stop to retry.*WebRTC viewers can continue/);
  assert.doesNotMatch(f.element("srtStatus").textContent, /Shared visuals may have stopped|secret-srt/);
  assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtConnected").textContent, "Unknown · cleanup pending");
  f.state.fail = null; await f.controller.stop(); assert.equal(f.controller.state().active, false); assert.equal(f.posts().length, 3);
});

test("reopening an owned independent cleanup error passively restores Stop without a private URL or deadline extension", async () => {
  const first = fixture(); await first.controller.start(); const saved = JSON.parse(first.storage.getItem(RECOVERY_KEY));
  first.state.own = { ...first.state.own, state: "error", expiresAt: saved.expiresAt + 5000 };
  const recovered = fixture({ storage: first.storage, serverState: first.state, time: first.now() + 1000, randomByte: 31 });
  assert.equal(recovered.element("srtStop").disabled, true); await recovered.controller.refresh();
  assert.equal(recovered.posts().length, 0); assert.equal(recovered.controller.state().expiresAt, saved.expiresAt); assert.equal(recovered.element("srtStop").disabled, false);
  assert.equal(recovered.element("srtConnectionUrl").value, ""); assert.match(recovered.element("srtStatus").textContent, /Cleanup is still pending/);
  assert.match(recovered.element("srtProfile").textContent, /60 Mbps target/);
  await recovered.controller.stop(); assert.equal(JSON.parse(recovered.posts()[0].config.body).viewerId, saved.viewerId);
  assert.equal(first.storage.getItem(RECOVERY_KEY), null); assert.equal(recovered.controller.state().active, false);
});

test("plain or invalid owned error receipts clear controls without falsely claiming cleanup is pending", async () => {
  for (const change of [{}, { generation: 8, expiresAt: 1600000, videoProfile: videoProfile() },
    { generation: 7, expiresAt: 999999, videoProfile: videoProfile() },
    { generation: 7, expiresAt: 1600000, videoProfile: videoProfile(60) },
    { generation: 7, expiresAt: 1600000, videoProfile: { ...videoProfile(), configuredBitrateMbps: 60 } }]) {
    const f = fixture(); await f.controller.start(); f.state.own = { state: "error", ...change };
    f.fire(3000); await flush();
    assert.equal(f.controller.state().active, false); assert.equal(f.element("srtStop").disabled, true); assert.equal(f.element("srtStart").disabled, true);
    assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.storage.getItem(RECOVERY_KEY), null);
    assert.match(f.element("srtStatus").textContent, /SRT experiment failed.*active experiment was not confirmed.*refresh the main player/);
    assert.doesNotMatch(f.element("srtStatus").textContent, /Cleanup is still pending|cleanup failed/); assert.equal(f.posts().length, 1);
  }
});

test("independent cleanup pending cannot outlive or renew its original local deadline", async () => {
  const f = fixture(); await f.controller.start(); f.state.own = { ...f.state.own, state: "error" }; f.fire(3000); await flush();
  assert.equal(f.element("srtStop").disabled, false); f.advance(600000); f.fire(600000);
  assert.equal(f.controller.state().active, false); assert.equal(f.element("srtStop").disabled, true); assert.equal(f.storage.getItem(RECOVERY_KEY), null);
  assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.posts().length, 1);
});

test("measurement explanations distinguish direct access-unit counts from shared-publisher delivery counters", async () => {
  const direct = fixture(); await direct.controller.start();
  direct.state.own.metrics = { readers: 1, observedAt: direct.now(), stats: [{ mbpsSendRate: 600, msSendTsbPdDelay: 250, packetsRetrans: 0, packetsSendDrop: 0 }] };
  direct.fire(3000); await flush();
  assert.match(direct.element("srtMeasurementNote").textContent, /H\.264 access-unit bytes before MPEG-TS and SRT/);
  assert.match(direct.element("srtMeasurementNote").textContent, /250 ms value is a request only/);
  assert.doesNotMatch(direct.element("srtMeasurementNote").textContent, /RTP framing|MediaMTX/);
  for (const id of ["srtSendRate", "srtRetransmits", "srtDropped"]) assert.equal(direct.element(id).textContent, "Unknown");
  assert.equal(direct.element("srtConnected").textContent, "Unknown · native delivery not measured");
  assert.doesNotMatch(direct.element("srtStatus").textContent, /receiver is connected/);
  const shared = fixture(); shared.element("srtVideoBitrate").value = "60"; await shared.controller.start();
  shared.state.own.metrics = { readers: 1, observedAt: shared.now(), stats: [{ mbpsSendRate: 62.1, msSendTsbPdDelay: 250, packetsRetrans: 0, packetsSendDrop: 0 }] };
  shared.fire(3000); await flush();
  assert.match(shared.element("srtMeasurementNote").textContent, /including RTP framing.*MediaMTX counters/);
  assert.equal(shared.element("srtConnected").textContent, "1 receiver connected"); assert.equal(shared.element("srtSendRate").textContent, "62.1 Mbps");
  assert.equal(shared.element("srtNegotiatedDelay").textContent, "250 ms"); assert.equal(shared.element("srtRetransmits").textContent, "0");
  assert.match(html, /id="srtMeasurementNote"/);
});

test("fixed sender failure codes explain their own failure without claiming a Larix decoder crash", async () => {
  for (const [failureCode, explanation] of [["child-exit", /sender process exited/], ["child-error", /sender process could not run/],
    ["native-identity-lost", /lost the visualizer’s PC window/], ["listener-lost", /SRT listener ended/],
    ["encoded-output-stale", /stopped producing fresh encoded video/], ["send-buffer-full", /sender ran out of send buffer and disconnected the player.*Start a new connection after this trial has stopped/], ["monitor-error", /health check failed/], ["cleanup-failed", /sender cleanup failed/]]) {
    const f = fixture(); await f.controller.start();
    f.state.own = { state: "error", diagnostics: { failureCode, failureObservedAt: f.now(), exitCode: null, signal: null,
      error: "srt://private-secret-invalid", connectionUrl: "srt://private-secret-invalid" } };
    f.fire(3000); await flush();
    assert.match(f.element("srtStatus").textContent, explanation); assert.match(f.element("srtStatus").textContent, /active experiment was not confirmed.*Larix receiving and decoding are not measured/);
    assert.equal(f.element("srtConnected").textContent, "Unknown · sender failed"); assert.match(f.element("srtMetricsStatus").textContent, /Sender failure reported.*does not measure Larix/);
    assert.doesNotMatch(f.element("srtStatus").textContent, /Cleanup is still pending|Larix crashed|private-secret|srt:\/\//);
    assert.equal(f.element("srtStop").disabled, true); assert.equal(f.controller.state().active, false); assert.equal(f.posts().length, 1);
  }
});

test("sender diagnostics only display known codes, bounded exit numbers and allowlisted signals", async () => {
  for (const diagnostics of [{ failureCode: "child-exit", exitCode: 3221225477, signal: "SIGABRT" },
    { failureCode: "child-exit", exitCode: -1073741819, signal: "SIGSEGV" },
    { failureCode: "child-exit", exitCode: "private-secret", signal: "srt://private-secret" },
    { failureCode: "child-exit", exitCode: Infinity, signal: "private-secret" }, { failureCode: "child-exit", exitCode: -2147483649, signal: {} },
    { failureCode: "child-error", exitCode: 5, signal: "SIGABRT" }, { failureCode: "cleanup-failed", exitCode: 5, signal: "SIGABRT" },
    { failureCode: "send-buffer-full", exitCode: 5, signal: "SIGABRT", message: "srt://private-secret", passphrase: "private-secret" },
    { failureCode: "srt://private-secret", exitCode: 5, signal: "SIGABRT" }, { failureCode: "toString", exitCode: 5, signal: "SIGABRT" },
    { failureCode: "send-buffer-full private-secret", exitCode: 5, signal: "SIGABRT" }]) {
    const f = fixture(); await f.controller.start(); f.state.own = { state: "error", diagnostics, error: "private-secret" };
    f.fire(3000); await flush(); const status = f.element("srtStatus").textContent;
    assert.doesNotMatch(status, /private-secret|srt:\/\/|Infinity|\[object|Exit code -2147483649/);
    if (diagnostics.exitCode === 3221225477) assert.match(status, /Exit code 3221225477.*Signal SIGABRT/);
    else if (diagnostics.exitCode === -1073741819) assert.match(status, /Exit code -1073741819.*Signal SIGSEGV/);
    else assert.doesNotMatch(status, /Exit code|Signal/);
    if (["srt://private-secret", "toString", "send-buffer-full private-secret"].includes(diagnostics.failureCode)) assert.match(status, /sender cause could not be confirmed/);
  }
});

test("owned sender diagnostics preserve exact bounded cleanup Stop, while terminal errors never keep pending cleanup", async () => {
  const f = fixture(); await f.controller.start(); const expiry = f.controller.state().expiresAt;
  f.state.own = { ...f.state.own, state: "error", diagnostics: { failureCode: "listener-lost", failureObservedAt: f.now() } };
  f.fire(3000); await flush(); assert.match(f.element("srtStatus").textContent, /SRT listener ended.*Cleanup is still pending/);
  assert.equal(f.element("srtStop").disabled, false); assert.equal(f.controller.state().expiresAt, expiry);
  f.state.own = { state: "error", diagnostics: { failureCode: "listener-lost", failureObservedAt: f.now() } };
  f.fire(3000); await flush(); assert.match(f.element("srtStatus").textContent, /SRT listener ended.*active experiment was not confirmed/);
  assert.doesNotMatch(f.element("srtStatus").textContent, /Cleanup is still pending/);
  assert.equal(f.element("srtStop").disabled, true); assert.equal(f.storage.getItem(RECOVERY_KEY), null); assert.equal(f.posts().length, 1);
});

test("native-app switching and page closure remain passive after five seconds without losing the original lease", async () => {
  const f = fixture(); await f.controller.start(); const expiry = f.controller.state().expiresAt, saved = f.storage.getItem(RECOVERY_KEY);
  f.document.hidden = true; f.event("visibilitychange"); f.event("pagehide"); f.event("unload");
  f.advance(5000); f.fire(3000); await flush();
  assert.equal(f.controller.state().active, true); assert.equal(f.controller.state().expiresAt, expiry);
  assert.equal(f.posts().length, 1); assert.equal(f.requests.at(-1).config.method, "GET");
  assert.equal(f.storage.getItem(RECOVERY_KEY), saved); assert.equal(f.element("srtConnection").hidden, false);
});

test("send-buffer failure clears credentials and keeps only the original bounded Stop until cleanup completes", async () => {
  const f = fixture(); await f.controller.start();
  const expiry = f.controller.state().expiresAt, record = f.storage.getItem(RECOVERY_KEY);
  f.state.own = { ...f.state.own, state: "error", diagnostics: { failureCode: "send-buffer-full", failureObservedAt: f.now(), message: "srt://private-secret", passphrase: "private-secret" } };
  f.fire(3000); await flush();
  assert.match(f.element("srtStatus").textContent, /sender ran out of send buffer and disconnected the player.*Cleanup is still pending; tap Stop to retry/);
  assert.doesNotMatch(f.element("srtStatus").textContent, /private-secret|decoder failed|Larix crashed|srt:\/\//);
  assert.equal(f.controller.state().expiresAt, expiry); assert.equal(f.storage.getItem(RECOVERY_KEY), record);
  assert.equal(f.element("srtStop").disabled, false); assert.equal(f.element("srtStart").disabled, true);
  assert.equal(f.element("srtConnectionUrl").value, ""); assert.equal(f.element("srtNativeLink").attributes.has("href"), false);
  assert.match(f.element("srtEncodedRate").textContent, /Unknown/); assert.equal(f.posts().length, 1);
  f.state.own = { state: "error", diagnostics: { failureCode: "send-buffer-full", failureObservedAt: f.now() } };
  f.fire(3000); await flush();
  assert.match(f.element("srtStatus").textContent, /sender ran out of send buffer.*active experiment was not confirmed/);
  assert.doesNotMatch(f.element("srtStatus").textContent, /Cleanup is still pending/);
  assert.equal(f.element("srtStop").disabled, true); assert.equal(f.controller.state().active, false);
  assert.equal(f.storage.getItem(RECOVERY_KEY), null); assert.equal(f.posts().length, 1);
});

test("handoff instructions name the exact controls and require an explicit baseline choice without changing the default", async () => {
  const f = fixture(); await f.controller.refresh();
  assert.equal(f.element("srtVideoBitrate").value, "600"); assert.equal(f.posts().length, 0);
  assert.match(f.element("srtVideoTargetHelp").textContent, /stress test may exceed the tablet’s decoder limits.*compatibility is unverified.*explicitly select 60 Mbps.*No automatic fallback/);
  assert.match(html, /Start SRT experiment<\/strong> here once.*private connection and copy it/);
  assert.match(html, /Stop visuals<\/strong> only.*Keep the music playing.*PC window open/);
  assert.match(html, /page only controls the experiment; it plays no video/);
  assert.match(html, /High \/ Level 6\.1.*compatibility has not been verified.*explicitly choose 60 Mbps/);
  assert.match(html, /srt-experiment\.js\?v=20261010-srt-flow-1/);
  assert.match(html, /srt-experiment\.css\?v=20261010-srt-600-1/);
});
