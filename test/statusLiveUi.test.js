"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const helperSource = fs.readFileSync(require.resolve("../public/statusLive.js"), "utf8");
const appSource = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const live = (version = "v1", overrides = {}) => ({ connected: true, core: { name: "Exact Roon core" },
  zones: [{ zone_id: "exact-zone", state: "playing", now_playing: { title: "First track", artist: "Artist", album: "Album", length: 240, seek_position: 12 } }],
  app: { sessionVersion: version }, ...overrides });
const session = (version = "v1", title = "Saved discovery") => ({ sessionVersion: version,
  updatedAt: version, options: { request: "Saved request" }, result: { tracks: [{ tidalId: "exact-123", title }] } });

function harness() {
  const requests = [], statuses = [], sessions = [], errors = [], sessionErrors = [], forbidden = [];
  const context = { navigator: { mediaDevices: { getUserMedia() { forbidden.push("microphone"); throw Error("Unexpected microphone access"); } } },
    localStorage: { setItem() { forbidden.push("storage"); throw Error("Unexpected storage write"); } },
    fetch() { forbidden.push("fetch"); throw Error("Unexpected direct media/playback request"); } };
  context.window = context;
  vm.runInNewContext(helperSource, context);
  const getJson = url => { const pending = deferred(); requests.push({ url, ...pending }); return pending.promise; };
  const api = context.createRabbitStatusLive({ getJson, onStatus: value => statuses.push(value),
    onSession: value => sessions.push(value), onError: value => errors.push(value), onSessionError: value => sessionErrors.push(value) });
  return { api, context, getJson, requests, statuses, sessions, errors, sessionErrors, forbidden,
    refresh() { const pending = api.refresh(); pending.catch(() => {}); return pending; },
    receive(value) { const pending = api.receive(value); pending?.catch?.(() => {}); return pending; },
    async answer(index, value) { requests[index].resolve(value); await flush(); },
    async fail(index, error = Error("Unavailable")) { requests[index].reject(error); await flush(); return error; },
    urls() { return requests.map(request => request.url); }
  };
}

test("initial compact refresh is deduplicated and hydrates one exact saved session", async () => {
  const h = harness(); const first = h.refresh(), second = h.refresh(); await flush();
  assert.deepEqual(h.urls(), ["/api/status/live"]);
  const payload = live(); await h.answer(0, payload);
  assert.equal(h.statuses[0], payload);
  assert.deepEqual(h.urls(), ["/api/status/live", "/api/session"]);
  const saved = session(); await h.answer(1, saved); await Promise.all([first, second]);
  assert.equal(h.sessions.length, 1); assert.equal(h.sessions[0], saved);
  assert.deepEqual(h.forbidden, []);
});

test("unchanged session versions keep playback fresh without fetching or applying full state", async () => {
  const h = harness(); h.receive(live()); await flush(); await h.answer(0, session());
  for (let position = 20; position <= 40; position += 10) {
    h.refresh(); await flush();
    const payload = live("v1", { zones: [{ zone_id: "exact-zone", state: "paused", seek_position: position }] });
    await h.answer(h.requests.length - 1, payload);
    assert.equal(h.statuses.at(-1), payload);
  }
  assert.equal(h.requests.filter(request => request.url === "/api/session").length, 1);
  assert.equal(h.sessions.length, 1); assert.equal(h.statuses.at(-1).zones[0].seek_position, 40);
  assert.deepEqual(h.forbidden, []);
});

test("another live poll updates playback while the first full-session download remains pending", async () => {
  const h = harness(); h.refresh(); await flush(); await h.answer(0, live());
  assert.deepEqual(h.urls(), ["/api/status/live", "/api/session"]);
  h.refresh(); await flush();
  assert.deepEqual(h.urls(), ["/api/status/live", "/api/session", "/api/status/live"]);
  const current = live("v1", { connected: false, core: null, zones: [] }); await h.answer(2, current);
  assert.equal(h.statuses.at(-1), current); assert.equal(h.sessions.length, 0);
  await h.answer(1, session()); assert.equal(h.sessions.length, 1);
});

test("a changed saved-session version fetches and applies the new full state once", async () => {
  const h = harness(); h.receive(live()); await flush(); await h.answer(0, session());
  h.receive(live("v2")); h.receive(live("v2")); await flush();
  assert.deepEqual(h.urls(), ["/api/session", "/api/session"]);
  await h.answer(1, session("v2", "New exact result"));
  assert.equal(h.sessions.length, 2); assert.equal(h.sessions.at(-1).result.tracks[0].title, "New exact result");
  h.receive(live("v2")); await flush(); assert.equal(h.requests.length, 2);
});

test("a versioned empty saved session is applied explicitly rather than retaining a deleted result", async () => {
  const h = harness(); h.receive(live("v1")); await flush(); await h.answer(0, session("v1"));
  h.receive(live("cleared")); await flush();
  const cleared = { sessionVersion: "cleared", updatedAt: "cleared", options: {}, result: null };
  await h.answer(1, cleared);
  assert.equal(h.sessions.length, 2); assert.equal(h.sessions.at(-1), cleared);
  h.receive(live("cleared")); await flush(); assert.equal(h.requests.length, 2);
});

test("concurrent versions discard obsolete sessions and fetch only the latest desired version", async () => {
  const h = harness(); h.receive(live("v1")); await flush();
  h.receive(live("v2")); h.receive(live("v3")); await flush(); assert.equal(h.requests.length, 1);
  await h.answer(0, session("v1"));
  assert.equal(h.sessions.length, 0); assert.equal(h.requests.length, 2);
  await h.answer(1, session("v3", "Latest result"));
  assert.equal(h.sessions.length, 1); assert.equal(h.sessions[0].sessionVersion, "v3");
});

test("a mismatched session response waits for another live update instead of applying or looping", async () => {
  const h = harness(); h.receive(live("v1")); await flush(); await h.answer(0, session("v2"));
  assert.equal(h.sessions.length, 0); await flush(); assert.equal(h.requests.length, 1);
  h.receive(live("v2")); await flush(); assert.equal(h.requests.length, 2);
  await h.answer(1, session("v2")); assert.equal(h.sessions[0].sessionVersion, "v2");
});

test("failed session hydration preserves results and retries only when another live payload arrives", async () => {
  const h = harness(); h.receive(live("v1")); await flush(); await h.answer(0, session("v1"));
  h.receive(live("v2")); await flush(); const error = await h.fail(1);
  assert.equal(h.sessions.length, 1); assert.equal(h.sessions[0].sessionVersion, "v1");
  assert.equal(h.sessionErrors[0], error); assert.equal(h.errors.length, 0);
  await flush(); assert.equal(h.requests.length, 2);
  h.receive(live("v2")); await flush(); await h.answer(2, session("v2"));
  assert.equal(h.sessions.length, 2); assert.equal(h.sessions.at(-1).sessionVersion, "v2");
});

test("fresh SSE playback prevents an older in-flight HTTP response from replacing it", async () => {
  const h = harness(); h.refresh(); await flush();
  const newest = live("v2", { core: { name: "New core" }, zones: [{ zone_id: "new-zone", state: "playing" }] });
  h.receive(newest); await flush(); await h.answer(1, session("v2"));
  await h.answer(0, live("v1"));
  assert.deepEqual(h.statuses, [newest]); assert.equal(h.sessions.length, 1);
  assert.deepEqual(h.urls(), ["/api/status/live", "/api/session"]);
});

test("an obsolete HTTP failure does not mark newer SSE playback offline", async () => {
  const h = harness(); h.refresh(); await flush();
  const newest = live(undefined, { app: undefined }); h.receive(newest);
  await h.fail(0); assert.equal(h.errors.length, 0); assert.equal(h.statuses.at(-1), newest);
  h.refresh(); await flush(); assert.equal(h.requests.length, 2);
});

test("current live HTTP failure reports connection loss and allows a later reconnect", async () => {
  const h = harness(); h.refresh(); await flush(); const error = await h.fail(0);
  assert.equal(h.errors[0], error); assert.equal(h.statuses.length, 0);
  h.refresh(); await flush(); await h.answer(1, live("v1")); await h.answer(2, session("v1"));
  assert.equal(h.statuses.length, 1); assert.equal(h.sessions.length, 1);
});

test("reconnect with the same saved version refreshes live state without repeating session hydration", async () => {
  const h = harness(); h.receive(live()); await flush(); await h.answer(0, session());
  h.receive(live("v1", { connected: false, core: null, zones: [] })); await flush();
  h.refresh(); await flush(); const reconnected = live("v1", { core: { name: "Reconnected core" } });
  await h.answer(1, reconnected);
  assert.equal(h.statuses.at(-1), reconnected); assert.equal(h.sessions.length, 1);
  assert.deepEqual(h.urls(), ["/api/session", "/api/status/live"]);
});

test("legacy full payload applies through onStatus once and caches its provided version", async () => {
  const h = harness(), saved = session("v1");
  const full = live("v1", { app: { sessionVersion: "v1", session: saved, feedback: { exact: "love" } } });
  h.receive(full); await flush(); assert.equal(h.statuses[0], full);
  assert.equal(h.sessions.length, 0); assert.equal(h.requests.length, 0);
  h.receive(live("v1")); await flush(); assert.equal(h.requests.length, 0);
  h.receive(live("v2")); await flush(); await h.answer(0, session("v2"));
  assert.equal(h.sessions.length, 1); assert.equal(h.sessions[0].sessionVersion, "v2");
});

test("legacy full state supersedes a pending obsolete hydration without a duplicate session application", async () => {
  const h = harness(); h.receive(live("v1")); await flush();
  const full = live("v2", { app: { sessionVersion: "v2", session: session("v2") } });
  h.receive(full); await h.answer(0, session("v1"));
  assert.equal(h.statuses.at(-1), full); assert.equal(h.sessions.length, 0); assert.equal(h.requests.length, 1);
});

test("incomplete and unversioned updates cannot clear or re-fetch the retained saved session", async () => {
  const h = harness(); h.receive(live("v1")); await flush(); const saved = session(); await h.answer(0, saved);
  for (const app of [undefined, {}, { llm: { online: true } }]) { h.receive(live("v1", { app })); await flush(); }
  assert.equal(h.sessions.length, 1); assert.equal(h.sessions[0], saved); assert.equal(h.requests.length, 1);
  h.receive(live("v1")); await flush(); assert.equal(h.requests.length, 1);
});

function section(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, "production controller section is present");
  return source.slice(start, end);
}

function playerHarness() {
  const h = harness(), nodes = new Map(), applied = [], calibrations = [], audioActions = [], playbackEvents = [];
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", hidden: false, value: "", innerHTML: "", title: "",
      dataset: {}, dispatchEvent(event) { playbackEvents.push(event); },
      classList: { toggle() {}, remove() {} }, style: { setProperty() {} } });
    return nodes.get(selector);
  };
  const saved = session(), calibration = { exact: true }, feedback = { "exact-reference": "love" };
  const playerState = { zones: [], selectedZoneId: "exact-zone", feedbackByKey: feedback, feedbackVersion: "exact-reference:love",
    lastResult: saved.result, sessionUpdatedAt: saved.updatedAt, appStatus: { session: saved, feedback,
      taste: { calibration }, llm: { label: "Preserved model" } },
    lyrion: { playerId: "exact-lyrion", title: "Independent live channel", visualizer: "whitecap", generation: 15 } };
  Object.assign(h.context, { state: playerState, $: node, lastRabbitStatusAt: 0, rabbitRecoveryTimer: null,
    document: { querySelector: selector => selector === "#playerView .player" ? node(selector) : null },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    Date: { now: () => 123456 }, clearTimeout() {}, queueActionState: {},
    activeZone: () => playerState.zones.find(zone => zone.zone_id === playerState.selectedZoneId) || playerState.zones[0],
    zonePlaybackPlaying: zone => zone.state === "playing", currentZoneNowPlaying: zone => zone?.now_playing,
    summarizeNowPlaying: zone => zone?.now_playing, nowPlayingTrack: zone => zone?.now_playing,
    zoneDisplayLabel: zone => zone.zone_id, escapeHtml: value => String(value), isLiveRadioZone: () => false,
    formatQueueInfo: () => "", formatSeconds: value => String(value), liveQueueHtml: () => "",
    artworkMetadataMatchesRoon: () => false, trustedRadioArtworkUrl: () => "", setCoverImage() {},
    updateNowDiscoveryTools() {}, updateNowSourceQuality() {}, updateJumpTopVisibility() {}, renderSystemHealth() {},
    scheduleRabbitRecoveryRefresh() {}, renderStandbyPool() {}, renderMemoryStatus() {}, renderLlmStatus() {}, renderModelStatus() {},
    applyBridgeSyncAlert() {}, applyCalibration: value => calibrations.push(value), feedbackMapFromServer: value => value,
    applySession: value => { applied.push(value); playerState.lastResult = value.result; playerState.sessionUpdatedAt = value.updatedAt; },
    renderResults() {}, markRabbitConnectionLost: error => h.errors.push(error), getJson: h.getJson,
    api: url => { audioActions.push(url); throw Error("Unexpected playback or hardware control"); } });
  vm.runInNewContext(section(appSource, "function applyAppState(", "function renderLlmStatus(") +
    section(appSource, "function renderState(", "const liveStatus = window.createRabbitStatusLive(") +
    section(appSource, "const liveStatus = window.createRabbitStatusLive(", "function currentRequestPrefersExtendedMixes(") +
    "\nglobalThis.playerRefresh = refresh; globalThis.playerReceive = value => liveStatus.receive(value);", h.context);
  return { ...h, node, playerState, applied, calibrations, audioActions, playbackEvents, saved, calibration,
    async receivePlayer(value) { h.context.playerReceive(value); await flush(); } };
}

test("actual player binding keeps Roon controls current and retains discovery feedback and the independent Lyrion session", async () => {
  const h = playerHarness(), originalLyrion = h.playerState.lyrion, originalResult = h.playerState.lastResult;
  // Establish the version through a full legacy payload without a duplicate hydration.
  await h.receivePlayer(live("v1", { app: { ...h.playerState.appStatus, sessionVersion: "v1" } }));
  const current = live("v1"); current.zones[0].now_playing = { title: "New exact Roon track", artist: "New artist", length: 300, seek_position: 88 };
  current.zones[0].state = "paused"; current.zones[0].is_seek_allowed = true;
  await h.receivePlayer(current);
  assert.equal(h.node("#nowTitle").textContent, "New exact Roon track");
  assert.equal(h.node("#playState").textContent, "paused"); assert.equal(h.node("#seekSlider").value, "88");
  assert.equal(h.node("#connection").textContent, "Connected to Exact Roon core");
  assert.equal(h.playerState.lastResult, originalResult); assert.equal(h.playerState.feedbackByKey["exact-reference"], "love");
  assert.equal(h.calibrations.at(-1), h.calibration); assert.equal(h.playerState.lyrion, originalLyrion);
  assert.equal(h.requests.length, 0); assert.deepEqual(h.audioActions, []); assert.deepEqual(h.forbidden, []);
});

test("actual player binding ignores absent app metadata without resetting calibration or feedback", async () => {
  const h = playerHarness(), oldApp = h.playerState.appStatus, oldFeedback = h.playerState.feedbackByKey;
  await h.receivePlayer(live(undefined, { app: undefined }));
  assert.equal(h.playerState.appStatus, oldApp); assert.equal(h.playerState.feedbackByKey, oldFeedback);
  assert.equal(h.playerState.lastResult, h.saved.result); assert.equal(h.calibrations.length, 0);
  assert.equal(h.requests.length, 0); assert.deepEqual(h.audioActions, []);
});

test("actual player status announces the resolved Roon zone, connection and informational HQPlayer hint", async () => {
  const h = playerHarness(), originalLyrion = h.playerState.lyrion;
  const hqZone = { ...live().zones[0], display_name: "HQPlayer", outputs: [{ display_name: "HQPlayer" }] };
  await h.receivePlayer(live(undefined, { app: undefined, zones: [hqZone] }));
  assert.equal(h.node("#zoneSelect").value, "exact-zone");
  assert.deepEqual(h.node("#playerView .player").dataset, {
    playbackZoneId: "exact-zone", playbackConnected: "true", playbackHqplayer: "true"
  });
  assert.equal(h.playbackEvents.at(-1).type, "roon-playback");
  assert.equal(h.playbackEvents.at(-1).detail.zoneId, "exact-zone");
  assert.equal(h.playbackEvents.at(-1).detail.state, "playing");

  // A removed zone is resolved by renderState even though the select emits no change event.
  const replacement = { ...hqZone, zone_id: "replacement-zone", display_name: "HQPlayer Copy", outputs: [{ display_name: "HQPlayer Copy" }] };
  await h.receivePlayer(live(undefined, { app: undefined, zones: [replacement] }));
  assert.equal(h.node("#zoneSelect").value, "replacement-zone");
  assert.equal(h.playbackEvents.at(-1).detail.zoneId, "replacement-zone");
  assert.equal(h.playbackEvents.at(-1).detail.hqplayer, false);
  assert.equal(h.node("#playerView .player").dataset.playbackHqplayer, "false");
  await h.receivePlayer(live(undefined, { app: undefined, connected: false, zones: [replacement] }));
  assert.equal(h.playbackEvents.at(-1).detail.connected, false);
  assert.equal(h.node("#playerView .player").dataset.playbackConnected, "false");
  assert.equal(h.playerState.lyrion, originalLyrion); assert.deepEqual(h.audioActions, []); assert.equal(h.requests.length, 0);
});

test("main and remote browser updates use compact routes and helper loads before the main controller", () => {
  const remote = fs.readFileSync(require.resolve("../public/remote.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  assert.match(appSource, /new EventSource\("\/api\/events\?compact=1"\)/);
  assert.match(remote, /new EventSource\("\/api\/events\?compact=1"\)/);
  assert.match(remote, /getJson\("\/api\/status\/live"\)/);
  assert.match(section(appSource, "function refresh()", "function currentRequestPrefersExtendedMixes("), /liveStatus\.refresh\(\)/);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.findIndex(value => value.startsWith("/statusLive.js?")) >= 0);
  assert.ok(scripts.findIndex(value => value.startsWith("/statusLive.js?")) < scripts.findIndex(value => value.startsWith("/app.js?")));
  const startup = appSource.slice(appSource.lastIndexOf("applyPlayerMaximized();"));
  assert.doesNotMatch(startup, /refreshSession\(\)\.catch/);
});
