"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { SoundSpectrum } = require("../src/soundSpectrum");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
const status = (overrides = {}) => ({ state: "idle", visualizer: "aeon", generation: 1, viewerActive: true,
  visualizers: [{ id: "aeon", name: "Aeon", available: true }, { id: "g-force", name: "G-Force", available: true }, { id: "whitecap", name: "WhiteCap", available: true }],
  inputs: [{ id: "USB microphone full description", name: "USB microphone" }], inputId: "USB microphone full description", captureAvailable: true, ...overrides });
const nativeGenerators = [
  { id: "generator:fluid", name: "Sound Generator (Fluid)", kind: "no-mic" },
  { id: "generator:high-energy", name: "Sound Generator (High Energy)", kind: "no-mic" },
  { id: "generator:chill", name: "Sound Generator (Chill)", kind: "no-mic" }
];
const noMicInputs = Object.fromEntries(["aeon", "g-force", "whitecap"].map(id => [id, nativeGenerators]));
const noMicStatus = (overrides = {}) => status({ inputs: [], noMicInputs, inputId: "generator:fluid", inputKind: "no-mic", ...overrides });
const musicInputs = [{ id: "feed:pre-hqplayer", label: "Music feed (experimental)", kind: "music-feed", available: true }];
const musicStatus = (overrides = {}) => noMicStatus({ musicInputs, ...overrides });
const feedStatus = (overrides = {}) => musicStatus({ state: "running", visualizer: "whitecap", inputId: "feed:pre-hqplayer", inputKind: "music-feed", audioFeed: { state: "waiting", playerId: "exact-player", reason: "Waiting for supported Lyrion audio." }, ...overrides });
function harness({ withMedia = false, withRtc = false, withHls = false, withWc = false, wcUnavailable = "", withDelay = false, withSettingsAnchor = false, withResponsive = false, centerView = "visualizer", savedTransport, savedRenderer, savedBuffer, sharedStorage, bufferSupported = true, bufferRejected = false, rtcStats, provider = "lyrion", viewerPrefix = "viewer-", mediaStats, hlsStats, now } = {}) {
  const prefix = provider === "roon" ? "roon" : "lyrion";
  const nodes = new Map(), observers = [], timers = new Map(), requests = [], releases = [], windowEvents = new Map(), mediaCalls = [], rtcCalls = [], bufferCalls = [], rtcStatsReads = [];
  let timerId = 0, viewerNumber = 0, setMediaReady, failMedia, mediaPresentation, notifyRtcStats, setRtcBufferState, setHlsReady, failHlsMedia;
  class Node {
    constructor(tag = "div") {
      this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.style = {}; this.events = new Map(); this.hidden = false; this.disabled = false; this.value = ""; this.textContent = ""; this.classes = new Set();
      this.classList = {
        contains: value => this.classes.has(value),
        add: (...values) => values.forEach(value => this.classes.add(value)),
        remove: (...values) => values.forEach(value => this.classes.delete(value)),
        toggle: (value, force) => {
          const present = force === undefined ? !this.classes.has(value) : Boolean(force);
          if (present) this.classes.add(value); else this.classes.delete(value);
          return present;
        }
      };
    }
    set id(value) { this._id = String(value); nodes.set(this._id, this); }
    get id() { return this._id; }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === "id") { this.id = value; nodes.set(value, this); }
      if (name === "class") { this.className = String(value); String(value).split(/\s+/).filter(Boolean).forEach(entry => this.classes.add(entry)); }
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; if (name === "src") this.src = ""; }
    set innerHTML(html) {
      this.children = [];
      const stack = [this], voidTags = new Set(["img", "input", "br", "hr", "meta", "link"]);
      for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>|([^<]+)/gi)) {
        if (match[4]) { stack.at(-1).textContent += match[4]; continue; }
        if (match[1]) { if (stack.at(-1).tag === match[2]) stack.pop(); continue; }
        const child = new Node(match[2]);
        for (const attribute of match[3].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attribute[1], attribute[2]);
        child.hidden = /\bhidden\b/.test(match[3]); child.disabled = /\bdisabled\b/.test(match[3]); stack.at(-1).append(child);
        if (!voidTags.has(child.tag) && !/\/\s*$/.test(match[3])) stack.push(child);
      }
    }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return descendants;
      if (selector === "button") return descendants.filter(child => child.tag === "button");
      return [];
    }
    querySelector(selector) { return this.querySelectorAll("*").find(child => selector.startsWith("#") ? child.id === selector.slice(1) : (child.className || "").split(/\s+/).includes(selector.slice(1))); }
    addEventListener(name, handler) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(handler); }
    dispatchEvent(event) {
      event.target ??= this; event.currentTarget = this;
      for (const handler of this.events.get(event.type) || []) {
        handler(event); if (event.immediatePropagationStopped) break;
      }
      if (!event.immediatePropagationStopped) this["on" + event.type]?.(event);
      return !event.defaultPrevented;
    }
    click() { if (!this.disabled) this.dispatchEvent(uiEvent("click")); }
    focus() { document.activeElement = this; this.dispatchEvent(uiEvent("focus")); }
    detach() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    append(child) { child.detach(); this.children.push(child); child.parentNode = this; }
    before(child) { const parent = this.parentNode || bar; child.detach(); const index = parent.children.indexOf(this); parent.children.splice(Math.max(index, 0), 0, child); child.parentNode = parent; }
    prepend(child) { child.detach(); this.children.unshift(child); child.parentNode = this; }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; children.forEach(child => this.append(child)); }
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    getBoundingClientRect() { return { left: 20, top: 20, right: 620, bottom: 620, width: 600, height: 600 }; }
    showModal() { this.showModalCalls = (this.showModalCalls || 0) + 1; this.open = true; }
    close() { this.closeCalls = (this.closeCalls || 0) + 1; this.open = false; this.dispatchEvent(uiEvent("close")); }
    closest() { return tabPanel; }
    getClientRects() { return view.hidden || tabPanel.hidden || (provider === "roon" && !view.classList.contains("isActive")) ? [] : [{}]; }
  }
  const get = id => { if (!nodes.has(id)) { const node = new Node(); node.setAttribute("id", id); } return nodes.get(id); };
  const stage = get(prefix + "Now"), view = get(provider === "roon" ? "playerView" : "lyrionView"), tabPanel = get("lyrionTabPanel"), bar = new Node(), lane = new Node();
  stage.classes.add(provider === "roon" ? "player--regular" : "lyrionNow--fullscreen");
  bar.className = provider === "roon" ? "playerViewControls" : "lyrionStageBar";
  lane.className = provider === "roon" ? "artStack" : "lyrionArtworkLane";
  stage.append(bar); stage.append(lane); bar.append(get("lyrionFullscreen"));
  const responsiveRail = withResponsive ? get(prefix + "NowInfo") : null;
  if (responsiveRail) { responsiveRail.className = "nowInfo"; stage.append(responsiveRail); }
  if (provider === "roon") {
    view.classList.add("isActive"); stage.dataset.playbackConnected = "true"; stage.dataset.playbackHqplayer = "true";
    get("zoneSelect").value = "exact-zone";
  }
  const document = new Node(); document.hidden = false; document.activeElement = null; document.getElementById = get; document.createElement = tag => new Node(tag);
  document.querySelector = selector => selector === "#playerView .player" && provider === "roon" ? stage : null;
  document.body = new Node(); document.body.dataset.playbackSystem = provider;
  const storage = sharedStorage || new Map();
  if (!storage.has(prefix + ".centerView")) storage.set(prefix + ".centerView", centerView);
  if (!storage.has(prefix + ".soundSpectrum")) storage.set(prefix + ".soundSpectrum", "whitecap");
  if (savedTransport) storage.set(prefix + ".soundSpectrumTransport", savedTransport);
  if (savedRenderer) storage.set(prefix + ".soundSpectrum", savedRenderer);
  if (savedBuffer !== undefined) storage.set("soundSpectrum.webrtcVideoBuffer", savedBuffer);
  const context = { document, navigator: { sendBeacon: (url, body) => { releases.push({ url, body }); return true; } },
    crypto: { randomUUID: () => viewerPrefix + ++viewerNumber }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    location: { search: "" }, URLSearchParams, AbortController, Blob,
    Option: function(label, value) { const option = new Node("option"); option.label = label; option.value = value; return option; },
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe(target) { observers.push({ target, callback: this.callback }); } },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: (url, options) => { const request = deferred(); requests.push({ ...request, url, options }); return request.promise; },
    addEventListener: (name, handler) => { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(handler); } };
  if (now) context.Date = class extends Date { static now() { return now(); } };
  const responsiveQueries = new Map();
  if (withResponsive) context.matchMedia = query => {
    if (!responsiveQueries.has(query)) responsiveQueries.set(query, { media: query, matches: false, listeners: [],
      addEventListener(type, handler) { if (type === "change") this.listeners.push(handler); } });
    return responsiveQueries.get(query);
  };
  if (withMedia) context.createSoundSpectrumVideo = ({ onReady, onError, presentation }) => {
    let ready = false;
    mediaPresentation = presentation;
    setMediaReady = value => { ready = value; onReady(value); };
    failMedia = () => { ready = false; onReady(false); onError?.(); };
    const api = { ready: () => ready,
      start(...args) { mediaCalls.push({ action: "start", args }); ready = true; onReady(true); },
      stop() { mediaCalls.push({ action: "stop" }); ready = false; onReady(false); } };
    if (mediaStats !== undefined) api.stats = () => typeof mediaStats === "function" ? mediaStats() : mediaStats;
    return api;
  };
  if (withRtc) {
    context.RTCPeerConnection = function () {};
    context.createSoundSpectrumWebRTC = ({ onReady, onError, presentation, onStats }) => {
      let ready = false, choice = null, state = "idle";
      const updateState = () => { state = !ready ? "idle" : !bufferSupported ? "unsupported" : bufferRejected ? "rejected" : "applied"; };
      notifyRtcStats = () => onStats?.(); setRtcBufferState = value => { state = value; };
      return { ready: () => ready,
        bufferState: () => ({ mode: choice === null ? "automatic" : "250ms", state, supported: ready ? bufferSupported : null, requestedMs: choice }),
        setBufferTarget(value) { bufferCalls.push(value); choice = value; updateState(); },
        stats(include) { rtcStatsReads.push(include); return { transport: "obs-webrtc", frames: 60, displayedFps: 60, rtc: rtcStats }; },
        start(...args) { rtcCalls.push({ action: "start", args }); ready = true; updateState(); mediaPresentation = presentation; onReady(true); },
        stop() { rtcCalls.push({ action: "stop" }); ready = false; updateState(); onReady(false); } };
    };
  }
  const hlsCalls = [];
  const wcCalls = [];
  if (withWc) {
    context.soundSpectrumWebCodecsSupport = () => wcUnavailable;
    context.createSoundSpectrumWebCodecs = ({ onReady }) => {
      let ready = false;
      return { ready: () => ready, stats: () => ({ transport: "webcodecs", frames: 10, displayedFps: 60, wcTargetFps: 120, wcPresentationHz: 60.1, wcStreamFps: 119.7, replacedFrames: 0, wcBufferBytes: 32000000, wcBufferSeconds: 4.2, wcRequestedMB: 32, wcTargetMs: 750, wcAheadSeconds: 0.9, wcLatenessMs: 0, wcRetries: 0, wcRecoveries: 0, wcBufferState: "playing" }),
        setFrameRate(n) { wcCalls.push({fps:n}); }, setPlaybackBuffer(n) { wcCalls.push({ bufferMs: n }); }, setBufferTarget(n) { wcCalls.push({ buffer: n }); }, setBitrateTarget(n) { wcCalls.push({ bitrate: n }); },
        start(...args) { wcCalls.push({ action: "start", args }); ready = true; onReady(true); },
        stop() { wcCalls.push({ action: "stop" }); ready = false; onReady(false); } };
    };
  }
  if (withHls) {
    context.Hls = { isSupported: () => true };
    context.createSoundSpectrumHLS = ({ onReady, onError }) => {
      let ready = false;
      setHlsReady = value => { ready = value; onReady(value); };
      failHlsMedia = (reason, diagnostics) => { ready = false; onReady(false); onError?.(reason, diagnostics); };
      return { ready: () => ready,
        setBufferTarget(value) { hlsCalls.push({ buffer: value }); },
        setBitrateTarget(value) { hlsCalls.push({ bitrate: value }); },
        stats(include) { return hlsStats === undefined ? { transport: "hls", frames: 100, lastPaintGapMs: 0, displayedFps: 60, hls: { bufferedSeconds: .4, framesDropped: 2 } } : typeof hlsStats === "function" ? hlsStats(include) : hlsStats; },
        start(...args) { hlsCalls.push({ action: "start", args }); ready = true; onReady(true); },
        stop() { hlsCalls.push({ action: "stop" }); ready = false; onReady(false); } };
    };
  }
  context.window = context;
  if (withDelay) vm.runInNewContext(fs.readFileSync(require.resolve("../public/soundSpectrumDelay.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/soundSpectrumStage.js"), "utf8"), context);
  let stageApi, settingsAnchor, stageFactoryCount = 0;
  const createStage = context.createSoundSpectrumStage;
  if (withSettingsAnchor) { settingsAnchor = get(prefix + "SettingsAnchor"); stage.prepend(settingsAnchor); }
  context.createSoundSpectrumStage = config => { stageFactoryCount++; stageApi = createStage({ ...config, ...(settingsAnchor ? { settingsAnchor } : {}) }); return stageApi; };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/" + provider + "Visualizer.js"), "utf8"), context);
  return { get, prefix, stage, view, tabPanel, document, context, storage, requests, releases, timers, mediaCalls, rtcCalls, hlsCalls, wcCalls, bufferCalls, rtcStatsReads, stageApi, settingsAnchor, responsiveRail,
    notifyRtcStats: () => notifyRtcStats?.(), setRtcBufferState: value => setRtcBufferState?.(value),
    stageFactoryCount: () => stageFactoryCount,
    phoneBreakpoint(matches) { const query = responsiveQueries.get("(max-width: 699px)"); assert.ok(query); query.matches = matches; for (const handler of query.listeners) handler({ matches, media: query.media }); },
    mediaReady: value => setMediaReady?.(value),
    mediaPresentation: () => mediaPresentation?.(),
    mediaError: () => failMedia?.(),
    hlsReady: value => setHlsReady?.(value), hlsError: (reason, diagnostics) => failHlsMedia?.(reason, diagnostics),
    body: index => JSON.parse(requests[index].options.body),
    async answer(index, data, ok = true, statusCode = ok ? 200 : 500) { requests[index].resolve({ ok, status: statusCode, json: async () => data }); await flush(); },
    async fire(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, "timer " + delay + " scheduled"); timers.delete(entry[0]); entry[1].fn(); await flush(); },
    mutate(target) { observers.filter(observer => observer.target === target).forEach(observer => observer.callback()); },
    event(name) { for (const handler of windowEvents.get(name) || []) handler(); },
    async ready(data = status()) { await this.fire(0); await this.answer(0, data); },
    async start(data = status({ state: "running" })) { get(prefix + "VisualToggle").click(); const index = requests.length - 1; await this.answer(index, data); return index; },
    async stoppedIds() { return Promise.all(releases.map(async release => JSON.parse(await release.body.text()).viewerId)); }
  };
}

function uiEvent(type, properties = {}) {
  return { type, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; this.propagationStopped = true; }, ...properties };
}

function pureUiState(h) {
  return { requestCount: h.requests.length, releaseCount: h.releases.length,
    stream: h.get("lyrionVisualVideo").src, selectedRenderer: h.get("lyrionNativeVisualizer").value,
    selectedInput: h.get("lyrionNativeInput").value, toggle: h.get("lyrionVisualToggle").textContent,
    storage: [...h.storage], mediaCalls: [...h.mediaCalls] };
}

test("WhiteCap theme selection applies only on Start, persists and cannot replace an active session from a change event", async () => {
  const themes = [{ id: "current", available: true }, { id: "nasa-layers", available: true }];
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, savedRenderer: "whitecap" });
    await h.ready(noMicStatus({ visualizer: "whitecap", whitecapThemes: themes }));
    const select = h.get(h.prefix + "WhitecapTheme"), field = h.get(h.prefix + "WhitecapThemeField");
    assert.equal(field.hidden, false); assert.equal(select.value, "current");
    const count = h.requests.length;
    select.value = "nasa-layers"; select.dispatchEvent(uiEvent("change")); await flush();
    assert.equal(h.requests.length, count); assert.equal(select.disabled, false);
    assert.equal([...h.storage].some(([key,value]) => key.endsWith(".whitecapTheme") && value === "nasa-layers"), true);
    const index = await h.start(noMicStatus({ state: "running", visualizer: "whitecap", whitecapTheme: "nasa-layers", whitecapThemes: themes }));
    assert.equal(h.body(index).whitecapTheme, "nasa-layers"); assert.equal(select.disabled, true);
    const started = h.requests.length;
    select.value = "current"; select.dispatchEvent(uiEvent("change")); await flush();
    assert.equal(select.value, "nasa-layers"); assert.equal(h.requests.length, started);
    h.get(h.prefix + "VisualToggle").click(); await flush();
    select.value = "current"; select.dispatchEvent(uiEvent("change"));
    const normal = await h.start(noMicStatus({ state: "running", visualizer: "whitecap", whitecapTheme: "current", whitecapThemes: themes }));
    assert.equal(h.body(normal).whitecapTheme || "current", "current");
  }
});

const delayStatus = (overrides = {}) => ({ currentMs: 0, savedMs: 0, revision: 0, instanceId: "delay-instance-one", available: true, maxMs: 5000, ...overrides });
const delayNode = (h, suffix) => h.get(h.prefix + "VisualDelay" + suffix);
const lastDelayRequest = h => h.requests.findLastIndex(request => request.url === "/api/soundspectrum/delay");
async function openDelay(h, data = delayStatus()) {
  h.get(h.prefix + "VisualSettings").click();
  const index = lastDelayRequest(h); assert.ok(index >= 0);
  await h.answer(index, data); return index;
}
async function editDelay(h, value, slider = false) {
  const control = delayNode(h, slider ? "Slider" : "Input"); control.value = String(value); control.dispatchEvent(uiEvent("input"));
  await h.fire(300); return lastDelayRequest(h);
}

test("global delay editor loads only on settings open and retains preview across all visualizer selections", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ withDelay: true, provider }); await h.ready(noMicStatus());
    assert.equal(lastDelayRequest(h), -1); await openDelay(h, delayStatus({ currentMs: 123, savedMs: 100, revision: 3 }));
    const editor = delayNode(h, "Input"), slider = delayNode(h, "Slider");
    assert.equal(editor.value, "123"); assert.equal(slider.value, "123");
    assert.equal(delayNode(h, "Current").textContent, "123 ms"); assert.equal(delayNode(h, "Saved").textContent, "100 ms");
    for (const value of ["aeon", "g-force", "whitecap"]) {
      const select = h.get(h.prefix + "NativeVisualizer"); select.value = value; select.dispatchEvent(uiEvent("change")); await flush();
      assert.equal(delayNode(h, "Input"), editor); assert.equal(editor.value, "123");
    }
    assert.equal(h.requests.filter(request => request.url === "/api/soundspectrum/delay").length, 1);
    assert.equal([...h.storage.keys()].some(key => /delay/i.test(key)), false);
    const request = await editDelay(h, 250, true);
    assert.equal(editor.value, "250"); assert.equal(slider.getAttribute("aria-valuetext"), "250 milliseconds");
    assert.equal(h.body(request).action, "preview"); assert.equal(h.body(request).delayMs, 250);
    assert.equal(h.body(request).expectedRevision, 3); assert.equal(h.body(request).expectedInstanceId, "delay-instance-one");
    await h.answer(request, delayStatus({ currentMs: 250, savedMs: 100, revision: 4 }));
    assert.equal(delayNode(h, "Current").textContent, "250 ms"); assert.equal(delayNode(h, "Saved").textContent, "100 ms");
  }
});

test("delay slider, numeric entry and fine buttons coalesce repeated edits and serialize previews", async () => {
  const h = harness({ withDelay: true }); await h.ready(noMicStatus()); await openDelay(h);
  delayNode(h, "Plus").click(); delayNode(h, "Plus").click(); delayNode(h, "Plus").click();
  assert.equal(delayNode(h, "Input").value, "30"); assert.equal(delayNode(h, "Slider").value, "30");
  assert.equal(h.requests.filter(request => request.url === "/api/soundspectrum/delay").length, 1);
  await h.fire(300); const first = lastDelayRequest(h); assert.equal(h.body(first).delayMs, 30);
  await editDelay(h, 100, true); await editDelay(h, 221);
  assert.equal(lastDelayRequest(h), first); assert.equal(delayNode(h, "Input").value, "221");
  await h.answer(first, delayStatus({ currentMs: 30, revision: 1 }));
  const final = lastDelayRequest(h); assert.notEqual(final, first); assert.equal(h.body(final).delayMs, 221); assert.equal(h.body(final).expectedRevision, 1);
  await h.answer(final, delayStatus({ currentMs: 221, revision: 2 }));
  delayNode(h, "Minus").click(); assert.equal(delayNode(h, "Input").value, "211");
  await h.fire(300); await h.answer(lastDelayRequest(h), delayStatus({ currentMs: 211, revision: 3 }));
  assert.equal(delayNode(h, "Saved").textContent, "0 ms");
});

test("Save serializes after preview, saves its tap-time value, and preserves a newer edit", async () => {
  const h = harness({ withDelay: true }); await h.ready(noMicStatus()); await openDelay(h);
  const first = await editDelay(h, 50);
  delayNode(h, "Input").value = "75"; delayNode(h, "Input").dispatchEvent(uiEvent("input")); delayNode(h, "Save").click();
  delayNode(h, "Input").value = "100"; delayNode(h, "Input").dispatchEvent(uiEvent("input")); await h.fire(300);
  assert.equal(lastDelayRequest(h), first);
  await h.answer(first, delayStatus({ currentMs: 50, revision: 1 }));
  const save = lastDelayRequest(h); assert.equal(h.body(save).action, "save"); assert.equal(h.body(save).delayMs, 75);
  assert.equal(delayNode(h, "Input").value, "100"); assert.equal(delayNode(h, "Save").disabled, true);
  await h.answer(save, delayStatus({ currentMs: 75, savedMs: 75, revision: 3 }));
  const later = lastDelayRequest(h); assert.equal(h.body(later).action, "preview"); assert.equal(h.body(later).delayMs, 100);
  await h.answer(later, delayStatus({ currentMs: 100, savedMs: 75, revision: 4 }));
  assert.equal(delayNode(h, "Current").textContent, "100 ms"); assert.equal(delayNode(h, "Saved").textContent, "75 ms");
});

test("a polling GET cannot regress a newer preview, and restart snapshots may reset revision", async () => {
  const h = harness({ withDelay: true }); await h.ready(noMicStatus()); await openDelay(h, delayStatus({ currentMs: 100, savedMs: 100, revision: 5 }));
  await h.fire(5000); const stale = lastDelayRequest(h);
  const preview = await editDelay(h, 200);
  await h.answer(preview, delayStatus({ currentMs: 200, savedMs: 100, revision: 6 }));
  await h.answer(stale, delayStatus({ currentMs: 100, savedMs: 100, revision: 5 }));
  assert.equal(delayNode(h, "Current").textContent, "200 ms"); assert.equal(delayNode(h, "Input").value, "200");
  await h.fire(5000); const oldProcess = lastDelayRequest(h);
  h.get(h.prefix + "VisualSettingsClose").click(); h.get(h.prefix + "VisualSettings").click(); const newProcess = lastDelayRequest(h);
  await h.answer(newProcess, delayStatus({ currentMs: 100, savedMs: 100, instanceId: "delay-instance-two" }));
  await h.answer(oldProcess, delayStatus({ currentMs: 200, savedMs: 100, revision: 6 }));
  assert.equal(delayNode(h, "Current").textContent, "100 ms"); assert.equal(delayNode(h, "Input").value, "100");
  const next = await editDelay(h, 110); assert.equal(h.body(next).expectedInstanceId, "delay-instance-two"); assert.equal(h.body(next).expectedRevision, 0);
});

test("conflicts preserve the reviewed draft through polling and require explicit retry", async () => {
  const h = harness({ withDelay: true }); await h.ready(noMicStatus()); await openDelay(h);
  const preview = await editDelay(h, 100); await h.answer(preview, delayStatus({ currentMs: 100, revision: 1 }));
  delayNode(h, "Save").click(); const conflict = lastDelayRequest(h);
  await h.answer(conflict, delayStatus({ currentMs: 200, savedMs: 200, revision: 3, error: "changed" }), false, 409);
  assert.equal(delayNode(h, "Current").textContent, "200 ms"); assert.equal(delayNode(h, "Input").value, "100");
  assert.match(delayNode(h, "Status").textContent, /another session/);
  await h.fire(5000); await h.answer(lastDelayRequest(h), delayStatus({ currentMs: 200, savedMs: 200, revision: 3 }));
  assert.equal(delayNode(h, "Input").value, "100");
  assert.equal(h.requests.filter(request => request.options?.method === "POST" && request.url === "/api/soundspectrum/delay").length, 2);
  delayNode(h, "Save").click(); const retry = lastDelayRequest(h); assert.equal(h.body(retry).delayMs, 100); assert.equal(h.body(retry).expectedRevision, 3);
  await h.answer(retry, delayStatus({ currentMs: 100, savedMs: 100, revision: 5 }));
});

test("delay failures report authoritative partial-save values or require refresh when unconfirmed", async () => {
  const h = harness({ withDelay: true }); await h.ready(noMicStatus()); await openDelay(h, delayStatus({ currentMs: 100, savedMs: 100 }));
  delayNode(h, "Input").value = "200"; delayNode(h, "Input").dispatchEvent(uiEvent("input")); delayNode(h, "Save").click();
  await h.answer(lastDelayRequest(h), delayStatus({ currentMs: 200, savedMs: 100, revision: 1, error: "disk" }), false);
  assert.equal(delayNode(h, "Current").textContent, "200 ms"); assert.equal(delayNode(h, "Saved").textContent, "100 ms");
  assert.equal(delayNode(h, "Input").value, "200"); assert.match(delayNode(h, "Status").textContent, /Could not save/);
  const preview = await editDelay(h, 300); h.requests[preview].reject(Error("offline")); await flush();
  assert.equal(delayNode(h, "Current").textContent, "200 ms"); assert.equal(delayNode(h, "Save").disabled, true); assert.equal(delayNode(h, "Refresh").hidden, false);
  assert.match(delayNode(h, "Status").textContent, /last confirmed/);
  delayNode(h, "Refresh").click(); await h.answer(lastDelayRequest(h), delayStatus({ currentMs: 300, savedMs: 100, revision: 2 }));
  assert.equal(delayNode(h, "Current").textContent, "300 ms"); assert.equal(delayNode(h, "Saved").textContent, "100 ms"); assert.equal(delayNode(h, "Save").disabled, false);
});

test("Reset previews zero without saving, invalid input never posts, and Enter saves a valid draft", async () => {
  const h = harness({ withDelay: true }); await h.ready(noMicStatus()); await openDelay(h, delayStatus({ currentMs: 5000, savedMs: 5000 }));
  assert.equal(delayNode(h, "Plus").disabled, true); delayNode(h, "Reset").click(); await h.fire(300);
  const reset = lastDelayRequest(h); assert.equal(h.body(reset).action, "preview"); assert.equal(h.body(reset).delayMs, 0);
  await h.answer(reset, delayStatus({ currentMs: 0, savedMs: 5000, revision: 1 }));
  assert.equal(delayNode(h, "Saved").textContent, "5000 ms"); assert.equal(delayNode(h, "Minus").disabled, true);
  for (const value of ["", "-1", "5001", "1.5", "nonsense"]) {
    const before = h.requests.length; await editDelay(h, value); assert.equal(h.requests.length, before);
    delayNode(h, "Save").click(); assert.equal(h.requests.length, before); assert.equal(delayNode(h, "Input").getAttribute("aria-invalid"), "true");
  }
  const numeric = delayNode(h, "Input"); numeric.value = "41"; numeric.dispatchEvent(uiEvent("input"));
  const enter = uiEvent("keydown", { key: "Enter" }); numeric.dispatchEvent(enter); assert.equal(enter.defaultPrevented, true);
  const saved = lastDelayRequest(h); assert.equal(h.body(saved).action, "save"); assert.equal(h.body(saved).delayMs, 41);
  await h.answer(saved, delayStatus({ currentMs: 41, savedMs: 41, revision: 3 }));
  assert.equal(delayNode(h, "Slider").value, "41");
});

test("failed initial GET, unavailable feed, and unreadable settings have explicit retry states", async () => {
  const h = harness({ withDelay: true }); await h.ready(noMicStatus());
  h.get(h.prefix + "VisualSettings").click(); h.requests[lastDelayRequest(h)].reject(Error("offline")); await flush();
  assert.equal(delayNode(h, "Input").disabled, true); assert.equal(delayNode(h, "Refresh").hidden, false);
  delayNode(h, "Refresh").click(); await h.answer(lastDelayRequest(h), delayStatus({ available: false }));
  assert.equal(delayNode(h, "Slider").disabled, true); assert.equal(delayNode(h, "Input").disabled, true); assert.equal(delayNode(h, "Save").disabled, true);
  assert.match(delayNode(h, "Status").textContent, /unavailable/);
  delayNode(h, "Refresh").click(); await h.answer(lastDelayRequest(h), delayStatus({ settingsError: "Saved visual delay could not be read. Reset and Save to replace it." }));
  assert.equal(delayNode(h, "Saved").textContent, "Unavailable"); assert.equal(delayNode(h, "Input").disabled, false);
  assert.match(delayNode(h, "Status").textContent, /could not be read/);
});

test("delay UI controls real API PCM timing, persists Save, and refreshes after controller reload", async t => {
  const path = require("node:path"), os = require("node:os");
  const { SoundSpectrumDelay } = require("../src/soundSpectrumDelay"), { PcmDelay } = require("../src/soundSpectrumPcmDelay");
  const { createSoundSpectrumApi } = require("../src/soundSpectrum");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "soundspectrum-ui-delay-"));
  t.after(() => {
    const target = path.resolve(temporary);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("soundspectrum-ui-delay-"));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const settingsPath = path.join(temporary, "visual-delay.json"), ring = new PcmDelay();
  let controller = new SoundSpectrumDelay({ settingsPath, apply: ms => ring.setDelayMs(ms) });
  const service = { visualDelay: controller, snapshot: () => ({}) };
  const api = createSoundSpectrumApi({ service, readJson: async request => request.body, sendJson: (response, status, body) => { response.status = status; response.body = body; } });
  const h = harness({ withDelay: true, provider: "roon" }); await h.ready(noMicStatus());
  async function dispatch(index = lastDelayRequest(h)) {
    const queued = h.requests[index], response = { setHeader() {} };
    await api.handle({ method: queued.options?.method || "GET", body: queued.options?.body ? JSON.parse(queued.options.body) : undefined,
      headers: { "content-type": "application/json" }, socket: {} }, response, new URL("http://localhost/api/soundspectrum/delay"));
    await h.answer(index, response.body, response.status === 200, response.status);
  }
  h.get("roonVisualSettings").click(); await dispatch();
  const pcm = Buffer.alloc(441 * 4, 7); assert.deepEqual(ring.process(pcm), pcm);
  await editDelay(h, 10, true); await dispatch();
  assert.equal(delayNode(h, "Current").textContent, "10 ms"); assert.equal(delayNode(h, "Saved").textContent, "0 ms");
  assert.equal(fs.existsSync(settingsPath), false);
  assert.deepEqual(ring.process(pcm), Buffer.alloc(pcm.length)); assert.deepEqual(ring.process(Buffer.alloc(pcm.length)), pcm);
  delayNode(h, "Save").click(); await dispatch(); assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).delayMs, 10);
  assert.equal(delayNode(h, "Saved").textContent, "10 ms");
  const originalInstance = controller.instanceId; controller = new SoundSpectrumDelay({ settingsPath }); service.visualDelay = controller;
  assert.notEqual(controller.instanceId, originalInstance);
  h.get("roonVisualSettingsClose").click(); h.get("roonVisualSettings").click(); await dispatch();
  assert.equal(delayNode(h, "Input").value, "10"); assert.equal(delayNode(h, "Saved").textContent, "10 ms");
  const refreshed = harness({ withDelay: true, provider: "roon" }); await refreshed.ready(noMicStatus());
  await openDelay(refreshed, controller.snapshot()); assert.equal(delayNode(refreshed, "Input").value, "10");
  assert.equal([...refreshed.storage.keys()].some(key => /delay/i.test(key)), false);
});

test("regular viewer heartbeats preserve option nodes, open menu state and focus for both providers", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ withMedia: true, provider });
    const running = () => noMicStatus({ state: "running", videoTransport: "websocket", visualizer: "whitecap",
      noMicInputs: Object.fromEntries(Object.entries(noMicInputs).map(([id, values]) => [id, values.map(value => ({ ...value }))])) });
    await h.ready(noMicStatus()); await h.start(running());
    const selects = [h.get(h.prefix + "NativeVisualizer"), h.get(h.prefix + "NativeInput")];
    const trees = selects.map(select => [...select.children]);
    const mutations = [];
    for (const select of selects) {
      let value = select.value;
      const replace = select.replaceChildren.bind(select);
      select.replaceChildren = (...children) => { mutations.push("replace"); select.menuOpen = false; replace(...children); };
      Object.defineProperty(select, "value", { get: () => value, set: next => { value = next; mutations.push("selection"); } });
      select.menuOpen = true;
    }
    selects[1].focus();
    for (let index = 0; index < 3; index++) { await h.fire(4000); await h.answer(h.requests.length - 1, running()); }
    assert.deepEqual(mutations, []);
    selects.forEach((select, index) => {
      assert.equal(select.menuOpen, true);
      select.children.forEach((child, childIndex) => assert.equal(child, trees[index][childIndex]));
    });
    assert.equal(h.document.activeElement, selects[1]); assert.equal(h.releases.length, 0);
    assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1);
  }
});

test("a shared selection change updates the value while reusing unchanged renderer and input option trees", async () => {
  const h = harness({ withMedia: true, provider: "roon" });
  await h.ready(noMicStatus()); await h.start(noMicStatus({ state: "running", visualizer: "whitecap", inputId: "generator:fluid", videoTransport: "websocket" }));
  const renderer = h.get("roonNativeVisualizer"), input = h.get("roonNativeInput");
  const oldRenderer = [...renderer.children], oldInput = [...input.children];
  await h.fire(4000); await h.answer(h.requests.length - 1, noMicStatus({ state: "running", visualizer: "g-force", inputId: "generator:high-energy", generation: 2, videoTransport: "websocket" }));
  assert.equal(renderer.value, "g-force"); assert.equal(input.value, "generator:high-energy");
  renderer.children.forEach((option, index) => assert.equal(option, oldRenderer[index]));
  input.children.forEach((option, index) => assert.equal(option, oldInput[index]));
  assert.equal(h.releases.length, 0); assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1);
});

test("changed availability, names, titles and ordering rebuild full option content immediately", async () => {
  const h = harness({ withMedia: true, provider: "roon" });
  const running = overrides => noMicStatus({ state: "running", visualizer: "whitecap", videoTransport: "websocket", ...overrides });
  await h.ready(noMicStatus()); await h.start(running());
  const input = h.get("roonNativeInput"), renderer = h.get("roonNativeVisualizer");
  async function heartbeat(overrides) { await h.fire(4000); await h.answer(h.requests.length - 1, running(overrides)); }
  const initialInput = input.children[0];
  const unavailable = nativeGenerators.map(value => ({ ...value, available: value.id !== "generator:fluid" }));
  await heartbeat({ noMicInputs: { ...noMicInputs, whitecap: unavailable } });
  assert.notEqual(input.children[0], initialInput); assert.equal(input.children[0].disabled, true);
  assert.equal(input.value, "generator:fluid", "selected unavailable inputs remain visible rather than switching sources");
  const renamed = nativeGenerators.map(value => ({ ...value, name: value.id === "generator:fluid" ? "Sound Generator (Low Motion)" : value.name }));
  const disabledOption = input.children[0];
  await heartbeat({ noMicInputs: { ...noMicInputs, whitecap: renamed } });
  assert.notEqual(input.children[0], disabledOption); assert.equal(input.children[0].disabled, false);
  assert.equal(input.children[0].label, "No mic · Low Motion"); assert.equal(input.children[0].title, "Sound Generator (Low Motion)");
  const reordered = [...input.children];
  await heartbeat({ noMicInputs: { ...noMicInputs, whitecap: [...renamed].reverse() } });
  assert.deepEqual(input.children.map(option => option.value), [...renamed].reverse().map(value => value.id));
  assert.notEqual(input.children[0], reordered[2]); assert.equal(input.value, "generator:fluid");
  const oldRenderer = renderer.children[0];
  const visualizers = status().visualizers.map(value => ({ ...value, nativeName: value.id === "aeon" ? "Aeon native build 2" : undefined }));
  await heartbeat({ visualizers });
  assert.notEqual(renderer.children[0], oldRenderer); assert.equal(renderer.children[0].title, "Aeon native build 2");
  const titledRenderer = renderer.children[0];
  await heartbeat({ visualizers: visualizers.map(value => ({ ...value, nativeName: undefined, available: value.id !== "whitecap" })) });
  assert.notEqual(renderer.children[0], titledRenderer); assert.equal(renderer.children[0].title, undefined);
  assert.equal(renderer.children.find(option => option.value === "whitecap").disabled, true); assert.equal(renderer.value, "aeon");
  assert.equal(h.releases.length, 0); assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1);
});

test("the no-input fallback is cached and replaced immediately when actual inputs return", async () => {
  const h = harness({ withMedia: true, provider: "roon" });
  const running = overrides => noMicStatus({ state: "running", visualizer: "whitecap", videoTransport: "websocket", ...overrides });
  await h.ready(noMicStatus()); await h.start(running());
  const input = h.get("roonNativeInput"), original = input.children[0];
  await h.fire(4000); await h.answer(h.requests.length - 1, running({ noMicInputs: {} }));
  const fallback = input.children[0];
  assert.notEqual(fallback, original); assert.equal(input.children.length, 1); assert.equal(fallback.label, "No audio inputs available");
  assert.equal(input.value, ""); assert.equal(input.disabled, true);
  await h.fire(4000); await h.answer(h.requests.length - 1, running({ noMicInputs: {} }));
  assert.equal(input.children[0], fallback);
  await h.fire(4000); await h.answer(h.requests.length - 1, running());
  assert.notEqual(input.children[0], fallback); assert.equal(input.children.length, 3);
  assert.equal(input.value, "generator:fluid"); assert.equal(input.disabled, false);
  assert.equal(h.releases.length, 0); assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1);
});

test("existing viewer heartbeats carry bounded optional presentation measurements for both providers", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ withMedia: true, provider, mediaStats: { transport: "websocket", receiveFps: 48,
      displayedFps: 36, meanDecodeMs: 1.3, meanRafWaitMs: 27, frames: 99999999999,
      backgroundFrames: 30, backgroundFps: 20, backdropProfile: "windowed-touch", maxPaintGapMs: 90000,
      busyDroppedFrames: Infinity, decodedFrames: -2, meanPaintMs: NaN, lastPaintGapMs: "20",
      viewerId: "private-viewer", url: "private-media", title: "private-track" } });
    h.context.matchMedia = query => { assert.equal(query, "(pointer: coarse)"); return { matches: true }; };
    await h.ready(noMicStatus()); await h.start(noMicStatus({ state: "running", videoTransport: "websocket" }));
    const initialPresentation = provider === "roon" ? "windowed" : "player-fullscreen";
    assert.equal(h.mediaPresentation(), initialPresentation);
    await h.fire(4000); const heartbeat = h.requests.length - 1;
    assert.deepEqual(h.body(heartbeat).videoStats, { transport: "websocket", presentation: initialPresentation,
      frames: 2147483647, backgroundFrames: 30, receiveFps: 48, displayedFps: 36, backgroundFps: 20,
      meanDecodeMs: 1.3, meanRafWaitMs: 27, maxPaintGapMs: 60000, backdropProfile: "windowed-touch", coarsePointer: true });
    await h.answer(heartbeat, noMicStatus({ state: "running", videoTransport: "websocket" }));
    h.get(h.prefix + "VisualExpand").click(); await flush();
    assert.equal(h.mediaPresentation(), "visualizer-fullscreen");
    await h.fire(4000); const expanded = h.requests.length - 1;
    assert.equal(h.body(expanded).videoStats.presentation, "visualizer-fullscreen");
    assert.equal(h.body(expanded).viewerId, h.body(heartbeat).viewerId);
    assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1); assert.equal(h.releases.length, 0);
    assert.equal(JSON.stringify(h.body(expanded)).includes("private-"), false);
  }
});

test("Roon player presentation measurements follow fullscreen classes and native fullscreen without reopening media", async () => {
  const h = harness({ withMedia: true, provider: "roon", mediaStats: { transport: "websocket", displayedFps: 48 } });
  await h.ready(noMicStatus()); await h.start(noMicStatus({ state: "running", videoTransport: "websocket" }));
  for (const [playerClass, native, expected] of [["player--maximized", false, "windowed"], ["player--fullscreen", false, "player-fullscreen"], ["player--regular", true, "player-fullscreen"], ["player--regular", false, "windowed"]]) {
    h.stage.classes.delete("player--regular"); h.stage.classes.delete("player--maximized"); h.stage.classes.delete("player--fullscreen");
    h.stage.classes.add(playerClass); h.document.fullscreenElement = native ? h.stage : null;
    assert.equal(h.mediaPresentation(), expected);
    await h.fire(4000); const index = h.requests.length - 1;
    assert.equal(h.body(index).videoStats.presentation, expected); assert.equal(h.body(index).videoStats.coarsePointer, undefined);
    await h.answer(index, noMicStatus({ state: "running", videoTransport: "websocket" }));
  }
  assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1); assert.equal(h.releases.length, 0);
});

test("missing or failing optional video diagnostics cannot prevent the existing heartbeat or renewals", async () => {
  for (const mediaStats of [undefined, null, [], { transport: "private-mode" }, () => { throw Error("optional stats unavailable"); }]) {
    const h = harness({ withMedia: true, provider: "roon", mediaStats });
    h.context.matchMedia = () => { throw Error("optional pointer information unavailable"); };
    await h.ready(noMicStatus()); await h.start(noMicStatus({ state: "running", videoTransport: "websocket" }));
    await h.fire(4000); const heartbeat = h.requests.length - 1;
    assert.equal(h.body(heartbeat).action, "heartbeat"); assert.equal(h.body(heartbeat).videoStats, undefined);
    await h.answer(heartbeat, noMicStatus({ state: "running", videoTransport: "websocket" }));
    assert.equal(h.releases.length, 0); assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1);
  }
  const h = harness({ withMedia: true, provider: "roon", mediaStats: { transport: "websocket", displayedFps: 48 } });
  h.context.matchMedia = () => { throw Error("optional pointer information unavailable"); };
  await h.ready(noMicStatus()); await h.start(noMicStatus({ state: "running", videoTransport: "websocket" }));
  await h.fire(4000);
  assert.deepEqual(h.body(h.requests.length - 1).videoStats, { transport: "websocket", presentation: "windowed", displayedFps: 48 });
});

test("saved center and renderer preferences never start PC capture", async () => {
  const h = harness();
  assert.equal(h.get("lyrionNativeVisualizer").value, "whitecap");
  assert.equal(h.get("lyrionVisualToggle").disabled, true);
  assert.equal(h.get("lyrionVisualStatus").textContent, "Loading audio inputs…");
  assert.equal(h.get("lyrionVisualHint").textContent, "Loading SoundSpectrum audio inputs…");
  await h.ready();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/soundspectrum/status");
  assert.equal(h.get("lyrionVisualVideo").src, "");
  assert.equal(h.get("lyrionVisualToggle").textContent, "Start visuals");
});

test("missing all audio inputs blocks start and refresh discovers newly connected input", async () => {
  const h = harness(); await h.ready(status({ inputs: [], captureAvailable: false }));
  assert.match(h.get("lyrionVisualReason").textContent, /No audio input is available/);
  assert.equal(h.get("lyrionVisualToggle").disabled, true);
  h.get("lyrionVisualToggle").click(); assert.equal(h.requests.length, 1);
  h.get("lyrionVisualRefresh").click();
  assert.equal(h.requests[1].url, "/api/soundspectrum/status?refresh=1");
  await h.answer(1, status());
  assert.equal(h.get("lyrionVisualToggle").disabled, false);
  assert.equal(h.get("lyrionNativeInput").value, "USB microphone full description");
});

test("explicit start waits for real native frames, renews lease, and stop releases capture", async () => {
  const h = harness(); await h.ready();
  const start = await h.start(status({ state: "starting" }));
  assert.equal(h.body(start).action, "start");
  assert.equal(h.body(start).inputId, "USB microphone full description");
  assert.equal(h.get("lyrionVisualEmpty").hidden, false);
  assert.match(h.get("lyrionVisualStatus").textContent, /Starting SoundSpectrum/);
  await h.fire(4000);
  const heartbeat = h.requests.length - 1; assert.equal(h.body(heartbeat).action, "heartbeat");
  await h.answer(heartbeat, status({ state: "running" }));
  assert.equal(h.get("lyrionVisualVideo").src, "/api/soundspectrum/video?viewerId=viewer-1");
  assert.equal(h.get("lyrionVisualEmpty").hidden, true);
  h.get("lyrionVisualToggle").click();
  assert.equal(h.get("lyrionVisualVideo").src, "");
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  assert.equal(h.requests.filter(request => /playback|lyrion\/visualizer|\/hqp|stream\.mp3/.test(request.url)).length, 0);
});

test("cancelled late starts cannot reopen the video or resurrect a viewer", async () => {
  const h = harness(); await h.ready(); h.get("lyrionVisualToggle").click();
  assert.equal(h.get("lyrionVisualToggle").textContent, "Cancel start");
  h.get("lyrionVisualToggle").click(); await h.answer(1, status({ state: "running" }));
  assert.equal(h.get("lyrionVisualVideo").src, "");
  assert.equal(h.get("lyrionVisualToggle").textContent, "Start visuals");
  assert.deepEqual(await h.stoppedIds(), ["viewer-1", "viewer-1"]);
});

test("exiting fullscreen, changing center view, or pagehide releases the viewer without auto restart", async () => {
  for (const exit of [h => { h.stage.classes.delete("lyrionNow--fullscreen"); h.mutate(h.stage); },
    h => { h.view.hidden = true; h.mutate(h.view); }, h => h.event("pagehide")]) {
    const h = harness(); await h.ready(); await h.start(); exit(h);
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    assert.equal(h.get("lyrionVisualVideo").src, "");
    h.document.hidden = false; h.view.hidden = false; h.stage.classes.add("lyrionNow--fullscreen"); h.event("pageshow");
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

test("shared renderer selection reflects other viewers without restarting their session", async () => {
  const h = harness(); await h.ready(); await h.start();
  const image = h.get("lyrionVisualVideo").src;
  await h.fire(4000); await h.answer(2, status({ state: "running", visualizer: "g-force", generation: 2 }));
  assert.equal(h.get("lyrionNativeVisualizer").value, "g-force");
  assert.equal(h.get("lyrionVisualVideo").src, image);
  assert.match(h.get("lyrionVisualStatus").textContent, /G-Force/);
  h.get("lyrionNativeVisualizer").value = "whitecap"; h.get("lyrionNativeVisualizer").onchange();
  assert.equal(h.body(3).visualizer, "whitecap");
  assert.equal(h.body(3).viewerId, "viewer-2");
});

test("pause releases capture and resume requires an explicit fresh start", async () => {
  const h = harness(); await h.ready(); await h.start();
  h.get("lyrionVisualFreeze").click();
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  assert.equal(h.get("lyrionVisualFreeze").textContent, "Resume visuals");
  assert.equal(h.get("lyrionVisualVideo").src, "");
  h.get("lyrionVisualFreeze").click();
  assert.equal(h.body(2).action, "start"); assert.equal(h.body(2).viewerId, "viewer-2");
});

test("broken image and expired heartbeat leases explain explicit reconnection", async () => {
  const h = harness(); await h.ready(); await h.start(); h.get("lyrionVisualVideo").onerror();
  assert.match(h.get("lyrionVisualReason").textContent, /stream disconnected/);
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  await h.fire(500); await h.answer(2, status()); await h.start();
  await h.fire(4000); await h.answer(4, status({ state: "running", viewerActive: false }));
  assert.match(h.get("lyrionVisualReason").textContent, /session ended/);
  assert.equal(h.get("lyrionVisualVideo").src, "");
});

test("native failure keeps the specific cause when its viewer lease ends", async () => {
  const h = harness(); await h.ready(); await h.start();
  await h.fire(4000);
  await h.answer(2, status({ state: "error", viewerActive: false, error: "The PC microphone disconnected. Connect it and try again." }));
  assert.equal(h.get("lyrionVisualReason").textContent, "The PC microphone disconnected. Connect it and try again.");
  assert.equal(h.get("lyrionVisualToggle").textContent, "Start visuals");
  assert.equal(h.get("lyrionVisualVideo").src, "");
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
});

test("all three native generators are selectable without any physical microphone", async () => {
  const h = harness(); await h.ready(noMicStatus());
  assert.equal(h.get("lyrionVisualToggle").disabled, false);
  assert.deepEqual(h.get("lyrionNativeInput").children.map(option => option.value), nativeGenerators.map(value => value.id));
  assert.deepEqual(h.get("lyrionNativeInput").children.map(option => option.label), ["No mic · Fluid", "No mic · High Energy", "No mic · Chill"]);
  assert.equal(h.get("lyrionNativeInput").title, "Sound Generator (Fluid)");
  assert.equal(h.get("lyrionNativeInput").children[1].title, "Sound Generator (High Energy)");
  assert.equal(h.get("lyrionNativeInput").value, "generator:fluid");
  assert.match(h.get("lyrionVisualHint").textContent, /uses no microphone and does not listen to your music/);
  assert.equal(h.requests.length, 1);
  await h.start(noMicStatus({ state: "running", visualizer: "whitecap" }));
  assert.equal(h.body(1).inputId, "generator:fluid");
  assert.match(h.get("lyrionVisualStatus").textContent, /WhiteCap · Sound generator · No microphone/);
});

test("renderer changes rebuild its own available generator inputs before starting", async () => {
  const h = harness();
  const productInputs = { ...noMicInputs, "g-force": [nativeGenerators[2]] };
  await h.ready(noMicStatus({ noMicInputs: productInputs }));
  h.get("lyrionNativeVisualizer").value = "g-force"; h.get("lyrionNativeVisualizer").onchange();
  assert.equal(h.get("lyrionNativeInput").value, "generator:chill");
  assert.equal(h.requests.length, 1);
  await h.start(noMicStatus({ state: "running", visualizer: "g-force", inputId: "generator:chill", noMicInputs: productInputs }));
  assert.equal(h.body(1).inputId, "generator:chill");
});

test("microphone and generator transitions restart explicitly with exact input identity", async () => {
  const h = harness(); const mixed = noMicStatus({ inputs: status().inputs });
  await h.ready(mixed); await h.start({ ...mixed, state: "running", visualizer: "whitecap" });
  h.get("lyrionNativeInput").value = "USB microphone full description"; h.get("lyrionNativeInput").onchange();
  assert.equal(h.body(2).inputId, "USB microphone full description");
  await h.answer(2, { ...mixed, state: "running", visualizer: "whitecap", inputId: "USB microphone full description", inputKind: "microphone" });
  assert.match(h.get("lyrionVisualStatus").textContent, /PC microphone active/);
  assert.match(h.get("lyrionVisualHint").textContent, /microphone on the Rabbit Hole PC/);
  h.get("lyrionNativeInput").value = "generator:high-energy"; h.get("lyrionNativeInput").onchange();
  assert.equal(h.body(3).inputId, "generator:high-energy");
  await h.answer(3, { ...mixed, state: "running", visualizer: "whitecap", inputId: "generator:high-energy" });
  assert.match(h.get("lyrionVisualStatus").textContent, /No microphone/);
  assert.deepEqual(await h.stoppedIds(), ["viewer-1", "viewer-2"]);
});

test("losing a physical microphone leaves an active generator stream untouched", async () => {
  const h = harness(); await h.ready(noMicStatus({ inputs: status().inputs }));
  await h.start(noMicStatus({ inputs: status().inputs, state: "running", visualizer: "whitecap" }));
  const stream = h.get("lyrionVisualVideo").src;
  await h.fire(4000); await h.answer(2, noMicStatus({ state: "running", visualizer: "whitecap" }));
  assert.equal(h.get("lyrionVisualVideo").src, stream);
  assert.equal(h.get("lyrionVisualToggle").textContent, "Stop visuals");
  assert.deepEqual(await h.stoppedIds(), []);
});

test("saved generator selections never auto start and shared input changes remain authoritative", async () => {
  const h = harness(); h.storage.set("lyrion.soundSpectrumInput.whitecap", "generator:chill");
  await h.ready(noMicStatus());
  assert.equal(h.get("lyrionNativeInput").value, "generator:chill");
  assert.equal(h.requests.length, 1);
  await h.start(noMicStatus({ state: "running", visualizer: "whitecap", inputId: "generator:chill" }));
  const stream = h.get("lyrionVisualVideo").src;
  await h.fire(4000); await h.answer(2, noMicStatus({ state: "running", visualizer: "aeon", inputId: "generator:high-energy", generation: 2 }));
  assert.equal(h.get("lyrionNativeVisualizer").value, "aeon");
  assert.equal(h.get("lyrionNativeInput").value, "generator:high-energy");
  assert.equal(h.get("lyrionVisualVideo").src, stream);
});

test("unavailable experimental feed stays visible with its reason and cannot start", async () => {
  const h = harness(), reason = "Enable the isolated music feed, then restart the Lyrion bridge.";
  await h.ready(musicStatus({ musicInputs: [{ ...musicInputs[0], available: false, reason }] }));
  const option = h.get("lyrionNativeInput").children.find(value => value.value === "feed:pre-hqplayer");
  assert.equal(option.label, "Music feed (experimental)"); assert.equal(option.disabled, true);
  assert.match(option.title, /restart the Lyrion bridge/);
  assert.equal(h.get("lyrionNativeInput").value, "generator:fluid");
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange();
  assert.equal(h.get("lyrionVisualToggle").disabled, true);
  assert.equal(h.get("lyrionVisualReason").textContent, reason);
  h.get("lyrionVisualToggle").click(); assert.equal(h.requests.length, 1);
  assert.equal(h.get("lyrionNativeInput").disabled, false);
});

test("music feed requires the actual selected Lyrion player and sends its exact identity", async () => {
  const h = harness(); await h.ready(musicStatus());
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange();
  assert.equal(h.get("lyrionVisualToggle").disabled, true);
  assert.match(h.get("lyrionVisualReason").textContent, /Choose a Lyrion player/);
  h.get("lyrionPlayer").value = "exact-player"; h.get("lyrionPlayer").dispatchEvent({ type: "change" });
  assert.equal(h.get("lyrionVisualToggle").disabled, false);
  assert.match(h.get("lyrionVisualHint").textContent, /copy of decoded PCM/);
  assert.match(h.get("lyrionVisualHint").textContent, /timing may differ/);
  await h.start(feedStatus({ state: "starting" }));
  assert.equal(h.body(1).playerId, "exact-player"); assert.equal(h.body(1).inputId, "feed:pre-hqplayer");
  assert.match(h.get("lyrionVisualReason").textContent, /experimental music feed/);
  assert.doesNotMatch(h.get("lyrionVisualReason").textContent, /microphone/);
});

test("music feed waiting, receiving and unsupported states preserve its selection and lease", async () => {
  const h = harness(); h.get("lyrionPlayer").value = "exact-player"; await h.ready(musicStatus());
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange();
  await h.start(feedStatus());
  assert.match(h.get("lyrionVisualStatus").textContent, /Music feed waiting/);
  assert.equal(h.get("lyrionVisualReason").textContent, "Waiting for supported Lyrion audio.");
  assert.equal(h.get("lyrionVisualEmpty").hidden, false);
  const video = h.get("lyrionVisualVideo").src;
  await h.fire(4000); await h.answer(2, feedStatus({ audioFeed: { state: "receiving", reason: "The separate PCM copy is feeding SoundSpectrum." } }));
  assert.match(h.get("lyrionVisualStatus").textContent, /Music feed active · Experimental/);
  assert.equal(h.get("lyrionVisualEmpty").hidden, true);
  await h.fire(4000); await h.answer(3, feedStatus({ audioFeed: { state: "unsupported", reason: "This Lyrion stream is not supported by the experimental feed." } }));
  assert.equal(h.get("lyrionVisualReason").textContent, "This Lyrion stream is not supported by the experimental feed.");
  assert.equal(h.get("lyrionNativeInput").value, "feed:pre-hqplayer");
  assert.equal(h.get("lyrionVisualEmpty").hidden, false);
  assert.equal(h.get("lyrionVisualVideo").src, video);
  assert.deepEqual(await h.stoppedIds(), []);
  assert.equal(h.requests.filter(value => value.options?.body && JSON.parse(value.options.body).action === "start").length, 1);
});

test("renderer and generator transitions use the music feed only with an explicit player", async () => {
  const h = harness(); h.get("lyrionPlayer").value = "exact-player"; await h.ready(musicStatus());
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange(); await h.start(feedStatus());
  h.get("lyrionNativeVisualizer").value = "g-force"; h.get("lyrionNativeVisualizer").onchange();
  assert.equal(h.body(2).visualizer, "g-force"); assert.equal(h.body(2).inputId, "feed:pre-hqplayer"); assert.equal(h.body(2).playerId, "exact-player");
  await h.answer(2, feedStatus({ visualizer: "g-force" }));
  h.get("lyrionNativeInput").value = "generator:chill"; h.get("lyrionNativeInput").onchange();
  assert.equal(h.body(3).inputId, "generator:chill"); assert.equal(Object.hasOwn(h.body(3), "playerId"), false);
  await h.answer(3, musicStatus({ state: "running", visualizer: "g-force", inputId: "generator:chill" }));
  assert.match(h.get("lyrionVisualStatus").textContent, /Sound generator/);
  assert.deepEqual(await h.stoppedIds(), ["viewer-1", "viewer-2"]);
});

test("saved music feed preference cannot replace the Fluid default or start a session", async () => {
  const h = harness(); h.get("lyrionPlayer").value = "exact-player";
  h.storage.set("lyrion.soundSpectrumInput.whitecap", "feed:pre-hqplayer"); await h.ready(musicStatus());
  assert.equal(h.get("lyrionNativeInput").value, "generator:fluid"); assert.equal(h.requests.length, 1);
  h.storage.delete("lyrion.soundSpectrumInput.whitecap");
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange();
  assert.equal(h.storage.has("lyrion.soundSpectrumInput.whitecap"), false); assert.equal(h.requests.length, 1);
  assert.equal(h.get("lyrionVisualVideo").src, "");
});

test("changing Lyrion player releases only the music-feed viewer and requires a fresh Start", async () => {
  const h = harness(); h.get("lyrionPlayer").value = "exact-player"; await h.ready(musicStatus());
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange(); await h.start(feedStatus());
  h.get("lyrionPlayer").value = "another-player"; h.get("lyrionPlayer").dispatchEvent({ type: "change" });
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  assert.equal(h.get("lyrionVisualVideo").src, ""); assert.equal(h.get("lyrionVisualToggle").textContent, "Start visuals");
  assert.equal(h.requests.length, 2);
  await h.start(feedStatus({ audioFeed: { state: "waiting", playerId: "another-player" } }));
  assert.equal(h.body(2).playerId, "another-player");
});

test("player refresh disappearance stops its feed while generator sessions ignore player changes", async () => {
  const h = harness(); h.get("lyrionPlayer").value = "exact-player"; await h.ready(musicStatus());
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange(); await h.start(feedStatus());
  h.get("lyrionPlayer").value = ""; h.stage.dispatchEvent({ type: "lyrion-track", detail: null });
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.get("lyrionVisualToggle").disabled, true);
  h.get("lyrionPlayer").value = "another-player"; h.stage.dispatchEvent({ type: "lyrion-playback" });
  assert.equal(h.requests.length, 2);
  h.get("lyrionNativeInput").value = "generator:fluid"; h.get("lyrionNativeInput").onchange();
  await h.start(musicStatus({ state: "running", visualizer: "whitecap" }));
  h.get("lyrionPlayer").value = ""; h.get("lyrionPlayer").dispatchEvent({ type: "change" });
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  assert.equal(h.get("lyrionVisualToggle").textContent, "Stop visuals");
});

test("music feed loss never falls back to a microphone or generated input", async () => {
  const h = harness(); h.get("lyrionPlayer").value = "exact-player"; await h.ready(musicStatus({ inputs: status().inputs }));
  h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange(); await h.start(feedStatus());
  await h.fire(4000); await h.answer(2, feedStatus({ musicInputs: [{ ...musicInputs[0], available: false, reason: "The isolated feed needs repair." }], audioFeed: { state: "error", reason: "The isolated feed needs repair." } }));
  assert.equal(h.get("lyrionNativeInput").value, "feed:pre-hqplayer");
  assert.match(h.get("lyrionVisualStatus").textContent, /Music feed unavailable/);
  assert.equal(h.get("lyrionVisualReason").textContent, "The isolated feed needs repair.");
  assert.equal(h.get("lyrionVisualToggle").textContent, "Stop visuals"); assert.equal(h.get("lyrionVisualToggle").disabled, false);
  assert.deepEqual(await h.stoppedIds(), []);
  h.get("lyrionVisualToggle").click(); assert.equal(h.get("lyrionVisualToggle").disabled, true);
});

test("music inventory rejects unknown identities and leaves an existing microphone default intact", async () => {
  const h = harness(); await h.ready(status({ musicInputs: [...musicInputs, { id: "feed:unknown", kind: "music-feed", label: "Unknown", available: true }, { id: "feed:pre-hqplayer", kind: "microphone", label: "Wrong kind", available: true }] }));
  assert.deepEqual(h.get("lyrionNativeInput").children.map(value => value.value), ["USB microphone full description", "feed:pre-hqplayer"]);
  assert.equal(h.get("lyrionNativeInput").value, "USB microphone full description");
});

test("the fullscreen control stays hidden and unavailable until visual frames are running", async () => {
  const h = harness(); await h.ready();
  const surface = h.get("lyrionVisualSurface"), overlay = h.get("lyrionVisualOverlay"), expand = h.get("lyrionVisualExpand");
  assert.equal(surface.getAttribute("role"), "group"); assert.equal(surface.tabIndex, -1);
  assert.equal(overlay.hidden, true); assert.equal(expand.disabled, true);
  surface.click(); expand.click();
  assert.equal(overlay.hidden, true); assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false);
  await h.start(status({ state: "starting" })); surface.click();
  assert.equal(overlay.hidden, true); assert.equal(expand.disabled, true);
  await h.fire(4000); await h.answer(2, status({ state: "running" }));
  assert.equal(surface.tabIndex, 0); assert.equal(expand.disabled, false);
  surface.click(); assert.equal(overlay.hidden, false); assert.equal(expand.tabIndex, 0);
  assert.equal(expand.getAttribute("aria-label"), "Expand visualizer"); assert.equal(expand.getAttribute("aria-expanded"), "false");
});

test("tap expand and return change only presentation while preserving the same viewer and media", async () => {
  for (const withMedia of [false, true]) {
    const h = harness({ withMedia }); await h.ready(); await h.start();
    const original = pureUiState(h), surface = h.get("lyrionVisualSurface"), expand = h.get("lyrionVisualExpand");
    h.stage.scrollTop = 140; h.stage.querySelector(".lyrionArtworkLane").scrollTop = 35;
    let exitCalls = 0; h.document.exitFullscreen = () => { exitCalls++; };
    surface.click(); const click = uiEvent("click"); expand.dispatchEvent(click); h.mutate(h.stage);
    assert.equal(click.propagationStopped, true); assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), true);
    assert.equal(expand.getAttribute("aria-label"), "Return to player"); assert.equal(expand.getAttribute("aria-expanded"), "true");
    assert.equal(h.get("lyrionVisualExpandLabel").textContent, "Return to player"); assert.equal(h.document.activeElement, surface);
    assert.deepEqual(pureUiState(h), original);
    h.stage.scrollTop = 0; h.stage.querySelector(".lyrionArtworkLane").scrollTop = 0;
    surface.click(); expand.click(); h.mutate(h.stage);
    assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false);
    assert.equal(expand.getAttribute("aria-label"), "Expand visualizer"); assert.equal(expand.getAttribute("aria-expanded"), "false");
    assert.equal(h.get("lyrionVisualExpandLabel").textContent, "Fullscreen"); assert.equal(h.document.activeElement, expand);
    assert.equal(h.stage.scrollTop, 140); assert.equal(h.stage.querySelector(".lyrionArtworkLane").scrollTop, 35);
    assert.equal(exitCalls, 0); assert.deepEqual(pureUiState(h), original);
  }
});

test("streaming controls auto hide after three seconds while keyboard focus keeps them reachable", async () => {
  const h = harness(); await h.ready(); await h.start();
  const surface = h.get("lyrionVisualSurface"), overlay = h.get("lyrionVisualOverlay"), expand = h.get("lyrionVisualExpand");
  surface.click(); assert.equal(surface.dataset.controlsVisible, "true");
  await h.fire(3000); assert.equal(surface.dataset.controlsVisible, "false"); assert.equal(overlay.hidden, true); assert.equal(expand.tabIndex, -1);
  surface.dispatchEvent(uiEvent("pointermove", { pointerType: "touch" })); assert.equal(overlay.hidden, true);
  surface.dispatchEvent(uiEvent("pointermove", { pointerType: "mouse" })); assert.equal(overlay.hidden, false);
  expand.focus(); await h.fire(3000); assert.equal(overlay.hidden, false); assert.equal(expand.tabIndex, 0);
  h.get("lyrionVisualToggle").focus(); expand.dispatchEvent(uiEvent("blur")); await h.fire(3000);
  assert.equal(overlay.hidden, true); assert.equal(h.releases.length, 0); assert.equal(h.requests.length, 2);
});

test("Enter and Space reveal and focus the expand button; immersive Tab and Escape preserve media", async () => {
  for (const key of ["Enter", " "]) {
    const h = harness({ withMedia: true }); await h.ready(); await h.start();
    const surface = h.get("lyrionVisualSurface"), expand = h.get("lyrionVisualExpand"), original = pureUiState(h);
    const reveal = uiEvent("keydown", { key }); surface.dispatchEvent(reveal);
    assert.equal(reveal.defaultPrevented, true); assert.equal(h.get("lyrionVisualOverlay").hidden, false); assert.equal(h.document.activeElement, expand);
    expand.click(); await h.fire(3000); assert.equal(h.get("lyrionVisualOverlay").hidden, true);
    const tab = uiEvent("keydown", { key: "Tab", shiftKey: true, target: surface }); h.stage.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true); assert.equal(tab.immediatePropagationStopped, true);
    assert.equal(h.document.activeElement, expand); assert.equal(h.get("lyrionVisualOverlay").hidden, false);
    let outerEscapeCalls = 0; h.stage.addEventListener("keydown", () => { outerEscapeCalls++; });
    const escape = uiEvent("keydown", { key: "Escape", target: expand }); h.stage.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true); assert.equal(escape.immediatePropagationStopped, true);
    assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false); assert.equal(h.document.activeElement, expand);
    assert.equal(outerEscapeCalls, 0);
    assert.deepEqual(pureUiState(h), original);
  }
});

test("Stop, Pause, view exits and page lifecycle clear pure mode and cannot restore it implicitly", async () => {
  const exits = [h => h.get("lyrionVisualToggle").click(), h => h.get("lyrionVisualFreeze").click(),
    h => { h.view.hidden = true; h.mutate(h.view); }, h => h.event("pagehide"),
    h => { h.stage.classes.delete("lyrionNow--fullscreen"); h.mutate(h.stage); },
    h => h.stage.querySelector(".lyrionStageBar").querySelector(".lyrionCenterViews").querySelectorAll("button").find(button => button.dataset.lyrionView === "artwork").click()];
  for (const exit of exits) {
    const h = harness(); await h.ready(); await h.start(); h.get("lyrionVisualSurface").click(); h.get("lyrionVisualExpand").click();
    assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), true); exit(h);
    assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false); assert.equal(h.get("lyrionVisualOverlay").hidden, true);
    assert.equal(h.get("lyrionVisualExpand").getAttribute("aria-expanded"), "false"); assert.equal(h.get("lyrionVisualVideo").src, "");
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    h.document.hidden = false; h.view.hidden = false; h.stage.classes.add("lyrionNow--fullscreen"); h.event("pageshow");
    assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false);
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

test("native or media failure clears expanded presentation without replacing its input", async () => {
  for (const failure of [h => h.get("lyrionVisualVideo").onerror(), async h => {
    await h.fire(4000); await h.answer(2, status({ state: "error", viewerActive: false, error: "The native visualizer stopped." }));
  }]) {
    const h = harness(); await h.ready(); await h.start(); h.get("lyrionVisualSurface").click(); h.get("lyrionVisualExpand").click();
    await failure(h);
    assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false); assert.equal(h.get("lyrionVisualOverlay").hidden, true);
    assert.equal(h.get("lyrionNativeInput").value, "USB microphone full description");
    assert.equal(h.get("lyrionVisualToggle").textContent, "Start visuals"); assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  }
});

test("rejected native fullscreen preserves the full-window visualizer fallback and existing lease", async () => {
  const h = harness(); await h.ready(); await h.start();
  let nativeRequests = 0; h.stage.requestFullscreen = () => { nativeRequests++; return Promise.reject(Error("Fullscreen unavailable")); };
  const original = pureUiState(h); h.get("lyrionVisualSurface").click(); h.get("lyrionVisualExpand").click(); await flush();
  assert.equal(nativeRequests, 1); assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), true);
  assert.deepEqual(pureUiState(h), original);
  h.get("lyrionVisualExpand").click(); assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false);
  assert.deepEqual(pureUiState(h), original);
});

test("late native fullscreen completion cannot resurrect pure mode after Stop, and existing fullscreen is reused", async () => {
  const h = harness(); await h.ready(); await h.start();
  const pending = deferred(); let nativeRequests = 0;
  h.stage.requestFullscreen = () => { nativeRequests++; return pending.promise; };
  h.get("lyrionVisualSurface").click(); h.get("lyrionVisualExpand").click(); h.get("lyrionVisualToggle").click();
  pending.resolve(); await flush();
  assert.equal(nativeRequests, 1); assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false);
  assert.equal(h.get("lyrionVisualVideo").src, ""); assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  const reused = harness(); await reused.ready(); await reused.start(); reused.document.fullscreenElement = reused.stage;
  reused.stage.requestFullscreen = () => { nativeRequests++; };
  reused.get("lyrionVisualSurface").click(); reused.get("lyrionVisualExpand").click();
  assert.equal(nativeRequests, 1); assert.equal(reused.stage.classList.contains("lyrionNow--visualFullscreen"), true);
});

test("lost browser media readiness exits pure mode and blocks expansion without changing its lease", async () => {
  const h = harness({ withMedia: true }); await h.ready(); await h.start();
  const original = pureUiState(h); h.get("lyrionVisualSurface").click(); h.get("lyrionVisualExpand").click();
  assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), true);
  h.mediaReady(false);
  assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false); assert.equal(h.get("lyrionVisualOverlay").hidden, true);
  assert.equal(h.get("lyrionVisualExpand").disabled, true); assert.equal(h.get("lyrionVisualSurface").tabIndex, -1);
  h.get("lyrionVisualSurface").click(); h.get("lyrionVisualExpand").click();
  assert.equal(h.stage.classList.contains("lyrionNow--visualFullscreen"), false); assert.deepEqual(pureUiState(h), original);
});

const hqplayerInput = { id: "feed:hqplayer-analysis", source: "roon-hqplayer", kind: "music-feed", label: "HQPlayer analysis (experimental)",
  available: true, zoneId: "exact-zone" };
const roonStatus = (overrides = {}) => noMicStatus({ musicInputs: [hqplayerInput, ...musicInputs], ...overrides });
const roonFeedStatus = (overrides = {}) => roonStatus({ state: "running", visualizer: "whitecap", inputId: hqplayerInput.id,
  inputKind: "music-feed", inputSource: "roon-hqplayer", zoneId: "exact-zone",
  audioFeed: { state: "receiving", source: "roon-hqplayer", zoneId: "exact-zone" }, ...overrides });
function selectRoonAnalysis(h) { h.get("roonNativeInput").value = hqplayerInput.id; h.get("roonNativeInput").onchange(); }

async function musicViewer(provider, withMedia = true) {
  const h = harness({ provider, withMedia });
  await h.ready(provider === "roon" ? roonStatus() : musicStatus());
  if (provider === "roon") selectRoonAnalysis(h);
  else {
    h.get("lyrionPlayer").value = "exact-player";
    h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange();
  }
  return h;
}

test("WebCodecs is a separate receiver with independent settings, shared leases and unchanged delay", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withMedia: true, withHls: true, withWc: true, withDelay: true, savedTransport: "webcodecs" });
    const snapshot = noMicStatus({ transports: [{ id: "jpeg", available: true }, { id: "hls", available: true }] });
    await h.ready(snapshot);
    assert.equal(h.get(h.prefix + "VisualTransport").value, "webcodecs");
    h.get(h.prefix + "WcBitrate").value = "450"; h.get(h.prefix + "WcBitrate").onchange();
    h.get(h.prefix + "WcBuffer").value = "250"; h.get(h.prefix + "WcBuffer").onchange();
    const i = await h.start({ ...snapshot, state: "running", transport: "hls", videoTransport: "hls", generation: 7, videoStats: { configuredBitrateMbps: 450 } });
    assert.equal(h.body(i).transport, "hls"); assert.equal(h.body(i).bitrateMbps, 450);
    assert.equal(h.get(h.prefix + "VisualTransport").value, "webcodecs");
    assert.equal(h.wcCalls.filter(c => c.action === "start").length, 1);
    assert.equal(h.hlsCalls.filter(c => c.action === "start").length, 0);
    assert.ok(h.wcCalls.some(c => c.buffer === 250));
    assert.ok(h.wcCalls.some(c => c.bufferMs === 750));
    assert.equal(h.get(h.prefix + "WcTime").disabled, true);
    assert.equal(h.storage.get("soundSpectrum.hlsBufferMB"), undefined);
    assert.equal(h.get(h.prefix + "WcBuffer").disabled, true);
    assert.equal(h.requests.some(r => r.url === "/api/soundspectrum/delay"), false);
    await h.fire(4000); assert.equal(h.body(h.requests.length - 1).videoStats.transport, "webcodecs");
    const rates = h.body(h.requests.length - 1).videoStats;
    assert.equal(rates.wcTargetFps, 120); assert.equal(rates.wcPresentationHz, 60.1); assert.equal(rates.wcStreamFps, 119.7);
    h.stageApi.stop(); assert.ok(h.wcCalls.some(c => c.action === "stop"));
  }
});

test("insecure WebCodecs selection explains HTTPS and cannot start the native source", async () => {
  const h = harness({ withWc: true, withHls: true, savedTransport: "webcodecs", wcUnavailable: "WebCodecs needs trusted local HTTPS." });
  await h.ready(noMicStatus({ transports: [{ id: "hls", available: true }] }));
  assert.equal(h.get("lyrionVisualToggle").disabled, true);
  assert.match(h.get("lyrionVisualTransport").title, /HTTPS/);
  assert.equal(h.wcCalls.some(c => c.action === "start"), false);
});

test("HLS starts at selected bitrate in both players, changes buffer live, and leaves delay untouched", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const measured = { transport: "hls", frames: 100, displayedFps: 59.9, callbackFps: 30, hls: { bufferedSeconds: .4, framesDropped: 217, dropPercent: 0, playbackIntervalSeconds: 1.1 } };
    const h = harness({ provider, withMedia: true, withRtc: true, withHls: true, withDelay: true, savedTransport: "hls", hlsStats: measured });
    const snapshot = noMicStatus({ transports: [{ id: "jpeg", name: "JPEG", available: true }, { id: "hls", name: "HLS", available: true }] });
    await h.ready(snapshot);
    assert.equal(h.get(h.prefix + "VisualTransport").value, "hls");
    assert.equal(h.get(h.prefix + "HlsBuffer").value, "32");
    assert.equal(h.get(h.prefix + "HlsFields").hidden, false);
    const bitrate = h.get(h.prefix + "HlsBitrate"); bitrate.value = "450"; bitrate.dispatchEvent(uiEvent("change"));
    const index = await h.start({ ...snapshot, state: "running", transport: "hls", videoTransport: "hls", generation: 3, videoStats: { configuredBitrateMbps: 450 } });
    assert.equal(h.body(index).bitrateMbps, 450); assert.equal(h.body(index).transport, "hls");
    assert.ok(h.hlsCalls.some(x => x.bitrate === 450)); assert.equal(h.hlsCalls.filter(x => x.action === "start").length, 1);
    assert.equal(bitrate.disabled, true);
    for (const mb of [16, 50, 75, 100, 250, 500, 750, 1000]) {
      h.get(h.prefix + "HlsBuffer").value = String(mb); h.get(h.prefix + "HlsBuffer").dispatchEvent(uiEvent("change"));
      assert.equal(h.hlsCalls.at(-1).buffer, mb);
    }
    assert.equal(h.hlsCalls.filter(x => x.action === "start").length, 1);
    assert.equal(h.requests.some(x => x.url === "/api/soundspectrum/delay"), false);
    assert.match(h.get(h.prefix + "HlsStatus").textContent, /0\.40 s buffered/);
    assert.match(h.get(h.prefix + "HlsStatus").textContent, /59\.9 video fps · 0\.0% video frames dropped over 1\.1 s · 217 dropped since Start/);
    measured.displayedFps = null; measured.hls.dropPercent = null;
    h.get(h.prefix + "HlsBuffer").dispatchEvent(uiEvent("change"));
    assert.match(h.get(h.prefix + "HlsStatus").textContent, /video fps measuring · 217 dropped since Start/);
    assert.doesNotMatch(h.get(h.prefix + "HlsStatus").textContent, /30\.0 video fps|0\.0%/);
    h.get(h.prefix + "VisualToggle").click(); assert.equal(bitrate.disabled, false);
  }
});

test("invalid HLS bitrate never starts and missing HLS support keeps a recoverable selection", async () => {
  const data = noMicStatus({ transports: [{ id: "jpeg", name: "JPEG", available: true }, { id: "hls", name: "HLS", available: true }] });
  const h = harness({ withHls: true, savedTransport: "hls" }); await h.ready(data);
  for (const value of ["49", "601", "50.5", ""]) {
    h.get("lyrionHlsBitrate").value = value; h.get("lyrionHlsBitrate").dispatchEvent(uiEvent("change"));
    const count = h.requests.length; h.get("lyrionVisualToggle").click(); await flush();
    assert.equal(h.requests.length, count); assert.equal(h.get("lyrionHlsBitrate").getAttribute("aria-invalid"), "true");
  }
  const unsupported = harness({ savedTransport: "hls" }); await unsupported.ready(data);
  assert.equal(unsupported.get("lyrionVisualTransport").value, "hls");
  assert.equal(unsupported.get("lyrionVisualToggle").disabled, true);
  assert.match(unsupported.get("lyrionVisualReason").textContent, /HLS playback is unavailable/);
});

test("joining HLS requires the same selected bitrate and generation", async () => {
  for (const target of [600, 300]) {
    const h = harness({ withHls: true, savedTransport: "hls" });
    const running = noMicStatus({ state: "running", transport: "hls", videoTransport: "hls", generation: 12,
      videoStats: { configuredBitrateMbps: target }, transports: [{ id: "hls", name: "HLS", available: true }] });
    await h.ready(running);
    h.get("lyrionVisualToggle").click(); await flush();
    assert.equal(h.body(h.requests.length - 1).action, target === 600 ? "join" : "start");
    assert.equal(h.body(h.requests.length - 1).bitrateMbps, 600);
  }
});

test("HLS buffer preference follows Roon and Lyrion without restarting either receiver", async () => {
  const storage = new Map(), data = noMicStatus({ transports: [{ id: "hls", name: "HLS", available: true }] });
  const roon = harness({ provider: "roon", withHls: true, savedTransport: "hls", sharedStorage: storage });
  const lyrion = harness({ withHls: true, savedTransport: "hls", sharedStorage: storage });
  await roon.ready(data); await lyrion.ready(data);
  roon.get("roonHlsBuffer").value = "1000"; roon.get("roonHlsBuffer").dispatchEvent(uiEvent("change"));
  lyrion.stageApi.sync();
  assert.equal(lyrion.get("lyrionHlsBuffer").value, "1000");
  assert.equal(lyrion.hlsCalls.at(-1).buffer, 1000);
  const reloaded = harness({ withHls: true, savedTransport: "hls", sharedStorage: storage });
  await reloaded.ready(data); assert.equal(reloaded.get("lyrionHlsBuffer").value, "1000");
  assert.equal(lyrion.hlsCalls.some(x => x.action === "start"), false);
  assert.equal(lyrion.get("lyrionHlsStatus").getAttribute("aria-live"), null);
});

const hlsStatus = (overrides = {}) => noMicStatus({ transport: "hls", videoTransport: "hls", generation: 3,
  transports: [{ id: "hls", name: "HLS", available: true }], videoStats: { configuredBitrateMbps: 600 }, ...overrides });

test("a delayed or aborted heartbeat retries fresh HLS after one second without releasing or restarting either player", async () => {
  for (const provider of ["roon", "lyrion"]) for (const name of ["TypeError", "AbortError"]) {
    let now = 1000;
    const stats = { transport: "hls", frames: 1, lastPaintGapMs: 3000 };
    const h = harness({ provider, withHls: true, savedTransport: "hls", now: () => now, hlsStats: include => { assert.equal(include, false); return stats; } });
    await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
    now = 5000; await h.fire(4000); const pending = h.requests.length - 1, signal = h.requests[pending].options.signal;
    now = 15000; stats.frames = 601; await h.fire(10000);
    assert.equal(signal.aborted, true);
    h.requests[pending].reject(Object.assign(Error("private request URL must not enter diagnostics"), { name })); await flush();
    assert.equal(h.get(h.prefix + "VisualToggle").textContent, "Stop visuals"); assert.equal(h.stage.dataset.visualActive, "true");
    assert.equal(h.stage.dataset.lastHeartbeatDurationMs, "10000"); assert.equal(h.stage.dataset.lastHlsFrameAgeMs, "3000");
    assert.equal(h.stage.dataset.lastHeartbeatError, name); assert.equal(h.stage.dataset.heartbeatRetryCount, "1");
    assert.equal(h.stage.dataset.heartbeatRetrying, "true"); assert.equal(h.stage.dataset.nextPollAt, "16000");
    assert.equal(h.releases.length, 0); assert.equal(h.hlsCalls.filter(x => x.action === "start").length, 1);
    assert.equal(Object.values(h.stage.dataset).some(value => String(value).includes("private request")), false);
    now = 16000; await h.fire(1000); const retry = h.requests.length - 1;
    assert.equal(h.body(retry).action, "heartbeat"); assert.equal(h.body(retry).viewerId, "viewer-1");
    assert.notEqual(h.requests[retry].options.signal, signal); assert.equal(h.requests[retry].options.signal.aborted, false);
    now = 16050; stats.frames++; stats.lastPaintGapMs = 20;
    await h.answer(retry, hlsStatus({ state: "running" }));
    assert.equal(h.stage.dataset.lastHeartbeatDurationMs, "50"); assert.equal(h.stage.dataset.lastHlsFrameAgeMs, "20");
    assert.equal(h.stage.dataset.heartbeatRetrying, "false"); assert.equal(h.stage.dataset.heartbeatRetryCount, "1");
    assert.equal(h.stage.dataset.lastHeartbeatError, ""); assert.equal(h.stage.dataset.nextPollAt, "20050");
    assert.equal(h.releases.length, 0); assert.equal(h.hlsCalls.filter(x => x.action === "start").length, 1);
    assert.equal(h.requests.filter((request, index) => request.options?.body && ["start", "join"].includes(h.body(index).action)).length, 1);
    await h.fire(4000); assert.equal(h.body(h.requests.length - 1).action, "heartbeat");
  }
});

test("HLS heartbeat retry requires usable recent frames, a ready receiver and foreground visibility", async () => {
  const healthy = { transport: "hls", frames: 100, lastPaintGapMs: 10 };
  const cases = [
    ...[undefined, null, NaN, Infinity, -1, 3001].map(lastPaintGapMs => ({ stats: { ...healthy, lastPaintGapMs } })),
    ...[0, NaN, Infinity, "100"].map(frames => ({ stats: { ...healthy, frames } })),
    { stats: { ...healthy, transport: "obs-webrtc" } }, { stats: () => { throw Error("unavailable"); } },
    { stats: healthy, notReady: true }, { stats: healthy, hidden: true }
  ];
  for (const scenario of cases) {
    const h = harness({ withHls: true, savedTransport: "hls", hlsStats: scenario.stats });
    await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
    await h.fire(4000); const pending = h.requests.length - 1;
    if (scenario.notReady) h.hlsReady(false);
    if (scenario.hidden) h.document.hidden = true;
    h.requests[pending].reject(new TypeError("network unavailable")); await flush();
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    assert.equal(h.stage.dataset.visualActive, "false"); assert.equal(h.stage.dataset.heartbeatRetrying, "false");
    assert.equal(h.stage.dataset.heartbeatRetryCount, "0");
    assert.equal([...h.timers.values()].some(timer => timer.delay === 1000), false);
  }
});

test("HTTP rejection and malformed responses retire even healthy HLS, including an interrupted rejection body", async () => {
  for (const statusCode of [403, 409, 500]) for (const interruptedBody of [false, true]) {
    const h = harness({ withHls: true, savedTransport: "hls" }); await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
    await h.fire(4000); const pending = h.requests.length - 1;
    if (interruptedBody) {
      h.requests[pending].resolve({ ok: false, status: statusCode, json: async () => { throw new TypeError("body interrupted"); } }); await flush();
    } else await h.answer(pending, { error: "Viewer rejected" }, false, statusCode);
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.stage.dataset.heartbeatRetryCount, "0");
    assert.equal(h.stage.dataset.lastHeartbeatError, "Error:" + statusCode);
    assert.equal(h.get("lyrionVisualToggle").textContent, "Start visuals");
  }
  for (const error of [new SyntaxError("malformed JSON"), new Error("unexpected response")]) {
    const h = harness({ withHls: true, savedTransport: "hls" }); await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
    await h.fire(4000); h.requests.at(-1).reject(error); await flush();
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.stage.dataset.heartbeatRetryCount, "0");
  }
});

test("Stop, source exit and fatal HLS media error fence delayed heartbeat failures and successes", async () => {
  for (const action of ["stop", "source", "media"]) for (const outcome of ["failure", "success"]) {
    const h = harness({ provider: "roon", withHls: true, savedTransport: "hls" }); await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
    await h.fire(4000); const pending = h.requests.length - 1;
    if (action === "stop") h.get("roonVisualToggle").click();
    else if (action === "source") { h.get("zoneSelect").value = "other-zone"; h.get("zoneSelect").dispatchEvent(uiEvent("change")); }
    else h.hlsError();
    assert.equal(h.requests[pending].options.signal.aborted, true);
    const diagnostics = { ...h.stage.dataset }, calls = h.hlsCalls.length;
    if (outcome === "failure") { h.requests[pending].reject(Object.assign(Error("delayed abort"), { name: "AbortError" })); await flush(); }
    else await h.answer(pending, hlsStatus({ state: "running", generation: 99 }));
    assert.deepEqual({ ...h.stage.dataset }, diagnostics); assert.equal(h.hlsCalls.length, calls);
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    assert.equal(h.stage.dataset.visualActive, "false"); assert.equal(h.stage.dataset.heartbeatRetrying, "false");
    assert.equal([...h.timers.values()].some(timer => timer.delay === 1000), false);
  }
});

test("a fresh HLS Start owns its controller and diagnostics when the previous heartbeat completes late", async () => {
  for (const outcome of ["failure", "success"]) {
    let now = 1000;
    const h = harness({ withHls: true, savedTransport: "hls", now: () => now }); await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
    await h.fire(4000); const obsolete = h.requests.length - 1;
    h.get("lyrionVisualToggle").click();
    now = 2000; await h.start(hlsStatus({ state: "running", generation: 4 }));
    await h.fire(4000); const current = h.requests.length - 1, currentSignal = h.requests[current].options.signal;
    const diagnostics = { ...h.stage.dataset }, calls = h.hlsCalls.length;
    if (outcome === "failure") { h.requests[obsolete].reject(new TypeError("old network failure")); await flush(); }
    else await h.answer(obsolete, hlsStatus({ state: "running", generation: 99 }));
    assert.deepEqual({ ...h.stage.dataset }, diagnostics); assert.equal(h.hlsCalls.length, calls); assert.equal(currentSignal.aborted, false);
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    now = 2100; await h.answer(current, hlsStatus({ state: "running", generation: 4 }));
    assert.equal(h.body(current).viewerId, "viewer-2"); assert.equal(h.stage.dataset.lastHeartbeatDurationMs, "100");
    assert.equal(h.stage.dataset.visualActive, "true"); assert.equal(h.stage.dataset.heartbeatRetryCount, "0");
    assert.equal(h.hlsCalls.filter(x => x.action === "start").at(-1).args[2], 4);
  }
});

test("Stop cancels a queued HLS heartbeat retry and a frozen retry cannot indefinitely preserve the viewer", async () => {
  for (const stop of [true, false]) {
    const stats = { transport: "hls", frames: 100, lastPaintGapMs: 10 };
    const h = harness({ withHls: true, savedTransport: "hls", hlsStats: stats }); await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
    await h.fire(4000); h.requests.at(-1).reject(new TypeError("first interruption")); await flush();
    assert.equal(h.stage.dataset.heartbeatRetrying, "true");
    if (stop) h.get("lyrionVisualToggle").click();
    else {
      await h.fire(1000); stats.lastPaintGapMs = 10001;
      h.requests.at(-1).reject(Object.assign(Error("timed out"), { name: "AbortError" })); await flush();
      assert.equal(h.stage.dataset.lastHlsFrameAgeMs, "10001");
    }
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.stage.dataset.heartbeatRetrying, "false");
    assert.equal([...h.timers.values()].some(timer => timer.delay === 1000), false);
    assert.equal(h.hlsCalls.filter(x => x.action === "start").length, 1);
  }
});

const obsTransports = [
  { id: "jpeg", name: "JPEG · current", available: true },
  { id: "obs-webrtc", name: "OBS / WebRTC · experimental", available: true }
];
const obsStatus = (overrides = {}) => noMicStatus({ visualizer: "g-force", transport: "obs-webrtc", videoTransport: "obs-webrtc", generation: 4, transports: obsTransports, ...overrides });

test("WebRTC buffer is a labeled native setting with a 250 ms experiment default and strict saved choices", async () => {
  for (const provider of ["roon", "lyrion"]) for (const savedBuffer of [undefined, "250", "automatic", "500", "", "250ms"]) {
    const h = harness({ provider, withRtc: true, savedTransport: "obs-webrtc", savedBuffer });
    const select = h.get(h.prefix + "VisualBuffer"), field = h.get(h.prefix + "VisualBufferField");
    assert.equal(select.tag, "select"); assert.equal(field.tag, "label"); assert.equal(field.getAttribute("for"), select.id);
    assert.equal(select.value, savedBuffer === "automatic" ? "automatic" : "250");
    assert.deepEqual(select.children.map(option => [option.getAttribute("value"), option.textContent]), [["automatic", "Automatic"], ["250", "250 ms"]]);
    assert.equal(select.getAttribute("aria-describedby"), h.prefix + "VisualBufferHelp " + h.prefix + "VisualBufferStatus");
    assert.equal(h.get(h.prefix + "VisualSettingsDialog").contains(select), true);
    assert.deepEqual(h.bufferCalls, [savedBuffer === "automatic" ? null : 250]);
    assert.equal(h.requests.length, 0); assert.equal(h.rtcCalls.length, 0);
    assert.match(h.get(h.prefix + "VisualBufferStatus").textContent, /selected · waiting for WebRTC/);
  }
});

test("changing a running WebRTC buffer saves and applies live without any session, peer, timer or focus change", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedRenderer: "g-force" });
    await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
    h.get(h.prefix + "VisualSettings").click(); const select = h.get(h.prefix + "VisualBuffer"); select.focus();
    const before = { requests: h.requests.length, releases: h.releases.length, peers: JSON.stringify(h.rtcCalls), jpeg: JSON.stringify(h.mediaCalls), timers: [...h.timers] };
    for (const value of ["automatic", "250"]) {
      select.value = value; select.dispatchEvent(uiEvent("change"));
      assert.equal(h.storage.get("soundSpectrum.webrtcVideoBuffer"), value);
      assert.equal(h.bufferCalls.at(-1), value === "automatic" ? null : 250);
      assert.match(h.get(h.prefix + "VisualBufferStatus").textContent, value === "automatic" ? /browser default restored/ : /target requested · browser setting verified; actual delay can differ/);
      assert.equal(h.document.activeElement, select); assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, true);
      assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, peers: JSON.stringify(h.rtcCalls), jpeg: JSON.stringify(h.mediaCalls), timers: [...h.timers] }, before);
    }
  }
});

test("buffer status distinguishes unsupported and rejected controls without claiming a requested delay was achieved", async () => {
  for (const option of [{ bufferSupported: false }, { bufferRejected: true }]) {
    const h = harness({ withRtc: true, savedTransport: "obs-webrtc", ...option });
    await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
    const text = h.get("lyrionVisualBufferStatus").textContent;
    assert.match(text, option.bufferSupported === false ? /does not support video buffer control/ : /could not apply 250 ms · its previous buffering may remain/);
    assert.doesNotMatch(text, /verified|restored|target requested/);
    assert.equal(h.get("lyrionVisualBuffer").disabled, false);
    h.get("lyrionVisualBuffer").value = "automatic"; h.get("lyrionVisualBuffer").dispatchEvent(uiEvent("change"));
    assert.match(h.get("lyrionVisualBufferStatus").textContent, option.bufferSupported === false ? /using its default/ : /could not apply Automatic · its previous buffering may remain/);
  }
  const missing = harness({ savedTransport: "obs-webrtc" });
  assert.match(missing.get("lyrionVisualBufferStatus").textContent, /does not support/);
});

test("JPEG hides and disables the buffer setting, including the grid label, without modifying the saved preference", async () => {
  const h = harness({ withRtc: true, savedTransport: "jpeg", savedBuffer: "automatic" }); await h.ready(obsStatus({ state: "idle" }));
  for (const suffix of ["VisualBufferField", "VisualBufferHelp", "VisualBufferStatus"]) assert.equal(h.get("lyrion" + suffix).hidden, true);
  assert.equal(h.get("lyrionVisualBufferField").style.display, "none"); assert.equal(h.get("lyrionVisualBuffer").disabled, true);
  assert.equal(h.get("lyrionVisualTransport").parentNode.style.gridColumn, "");
  assert.equal(h.storage.get("soundSpectrum.webrtcVideoBuffer"), "automatic");
  const transport = h.get("lyrionVisualTransport"); transport.value = "obs-webrtc"; transport.dispatchEvent(uiEvent("change"));
  assert.equal(h.get("lyrionVisualBufferField").hidden, false); assert.equal(h.get("lyrionVisualBufferField").style.display, "");
  assert.equal(transport.parentNode.style.gridColumn, "auto");
  assert.equal(h.get("lyrionVisualBuffer").value, "automatic"); assert.equal(h.rtcCalls.length, 0); assert.equal(h.requests.length, 1);
});

test("existing WebRTC stats completion updates interval delay, unknown values and freshness without a new poller", async () => {
  const rtcStats = { sampleAgeMs: null, bufferIntervalSeconds: null };
  const h = harness({ withRtc: true, savedTransport: "obs-webrtc", rtcStats });
  await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
  const statusNode = h.get("lyrionVisualBufferStatus"); assert.match(statusNode.textContent, /Interval measurements: waiting/);
  const before = { requests: h.requests.length, releases: h.releases.length, timers: [...h.timers], peers: JSON.stringify(h.rtcCalls) };
  Object.assign(rtcStats, { jitterBufferMs: 0, jitterBufferTargetMs: 250, jitterBufferMinimumMs: null, bufferIntervalSeconds: 4, sampleAgeMs: 125 });
  h.notifyRtcStats(); assert.match(statusNode.textContent, /Actual \/ target \/ minimum: 0\.0 ms \/ 250\.0 ms \/ unknown · last 4\.0 s · sample 0\.1 s old/);
  rtcStats.sampleAgeMs = 5001; h.notifyRtcStats(); assert.match(statusNode.textContent, /stale/);
  rtcStats.bufferIntervalSeconds = null; h.notifyRtcStats(); assert.match(statusNode.textContent, /waiting · sample 5\.0 s old · stale/);
  rtcStats.sampleAgeMs = null; h.notifyRtcStats(); assert.match(statusNode.textContent, /waiting/); assert.doesNotMatch(statusNode.textContent, /sample 0\.0/);
  assert.equal(h.rtcStatsReads.every(include => include === false), true);
  assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, timers: [...h.timers], peers: JSON.stringify(h.rtcCalls) }, before);
  await h.fire(4000); const heartbeat = h.body(h.requests.length - 1);
  assert.equal(heartbeat.action, "heartbeat"); assert.equal(heartbeat.videoStats.rtc, undefined);
  assert.equal(Object.keys(heartbeat.videoStats).some(key => /buffer/i.test(key)), false);
});

test("already constructed Roon and Lyrion stages refresh the shared buffer preference through existing renders", async () => {
  const sharedStorage = new Map();
  const roon = harness({ provider: "roon", withRtc: true, savedTransport: "obs-webrtc", sharedStorage });
  const lyrion = harness({ provider: "lyrion", withRtc: true, savedTransport: "obs-webrtc", sharedStorage });
  roon.get("roonVisualBuffer").value = "automatic"; roon.get("roonVisualBuffer").dispatchEvent(uiEvent("change"));
  lyrion.get("lyrionVisualSettings").click();
  assert.equal(lyrion.get("lyrionVisualBuffer").value, "automatic"); assert.deepEqual(lyrion.bufferCalls, [250, null]);
  lyrion.stageApi.sync(); assert.deepEqual(lyrion.bufferCalls, [250, null], "unchanged preference does not reapply the setter");
  sharedStorage.set("soundSpectrum.webrtcVideoBuffer", "250"); roon.stageApi.sync(); lyrion.stageApi.sync();
  assert.equal(roon.get("roonVisualBuffer").value, "250"); assert.equal(lyrion.get("lyrionVisualBuffer").value, "250");
  assert.equal(roon.requests.length + lyrion.requests.length, 0); assert.equal(roon.rtcCalls.length + lyrion.rtcCalls.length, 0);
  assert.equal(roon.releases.length + lyrion.releases.length, 0);
});

function popupTransportState(h) {
  return { requests: h.requests.length, releases: h.releases.length, mediaCalls: JSON.stringify(h.mediaCalls), rtcCalls: JSON.stringify(h.rtcCalls),
    renderer: h.get(h.prefix + "NativeVisualizer").value, input: h.get(h.prefix + "NativeInput").value,
    transport: h.get(h.prefix + "VisualTransport").value, storage: [...h.storage] };
}

test("visual settings use one labeled native dialog inside the fullscreen stage and move every exact control out of the center", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withSettingsAnchor: true }); await h.ready(noMicStatus());
    const dialog = h.get(h.prefix + "VisualSettingsDialog"), trigger = h.get(h.prefix + "VisualSettings"), surface = h.get(h.prefix + "VisualSurface");
    assert.equal(dialog.tag, "dialog"); assert.equal(dialog.parentNode, h.stage); assert.equal(trigger.parentNode, h.settingsAnchor);
    assert.equal(trigger.textContent, "Visuals & audio"); assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    assert.equal(trigger.getAttribute("aria-controls"), dialog.id); assert.equal(dialog.getAttribute("aria-labelledby"), h.prefix + "VisualSettingsHeading");
    assert.deepEqual(h.get(h.prefix + "VisualPanel").children, [surface]); assert.equal(dialog.contains(surface), false);
    for (const suffix of ["NativeVisualizer", "NativeInput", "VisualTransport", "VisualHint", "VisualToggle", "VisualRefresh", "VisualFreeze", "VisualStatus"]) {
      const control = h.get(h.prefix + suffix); assert.equal(dialog.contains(control), true, suffix);
      assert.equal(h.stage.querySelectorAll("*").filter(node => node.id === control.id).length, 1, suffix + " is never duplicated");
    }
    assert.equal(h.get(h.prefix + "VisualToggle").getAttribute("aria-describedby"), h.prefix + "VisualHint " + h.prefix + "VisualSettingsReason");
    assert.equal(h.get(h.prefix + "NativeInput").parentNode.getAttribute("for"), h.prefix + "NativeInput");
    assert.equal(dialog.hidden, true); assert.equal(trigger.getAttribute("aria-expanded"), "false");
  }
});

test("opening, Close, Escape, native cancel and backdrop dismissal only change modal focus and never request capture", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withSettingsAnchor: true }); await h.ready(noMicStatus());
    const dialog = h.get(h.prefix + "VisualSettingsDialog"), trigger = h.get(h.prefix + "VisualSettings"), close = h.get(h.prefix + "VisualSettingsClose");
    const before = popupTransportState(h); let outerEscapes = 0; h.stage.addEventListener("keydown", () => { outerEscapes++; });
    for (const dismiss of [() => close.click(), () => h.stage.dispatchEvent(uiEvent("keydown", { key: "Escape", target: close })),
      () => dialog.dispatchEvent(uiEvent("cancel")), () => dialog.dispatchEvent(uiEvent("click", { clientX: 0, clientY: 0 }))]) {
      trigger.focus(); trigger.click(); h.mutate(h.stage);
      assert.equal(dialog.open, true); assert.equal(dialog.hidden, false); assert.equal(h.document.activeElement, close);
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      dialog.dispatchEvent(uiEvent("click", { clientX: 30, clientY: 30 })); assert.equal(dialog.open, true, "dialog padding is not its backdrop");
      dismiss(); assert.equal(dialog.open, false); assert.equal(dialog.hidden, true); assert.equal(h.document.activeElement, trigger);
      assert.equal(trigger.getAttribute("aria-expanded"), "false"); assert.deepEqual(popupTransportState(h), before);
    }
    assert.equal(outerEscapes, 0); assert.equal(dialog.showModalCalls, 4);
  }
});

test("an open settings dialog survives heartbeat renders with the same OBS viewer, peer selection and focused input", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedRenderer: "g-force" });
    await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
    const dialog = h.get(h.prefix + "VisualSettingsDialog"), input = h.get(h.prefix + "NativeInput"), options = [...input.children];
    h.get(h.prefix + "VisualSettings").click(); input.focus();
    const peerCalls = JSON.stringify(h.rtcCalls), mediaCalls = JSON.stringify(h.mediaCalls), stored = [...h.storage];
    for (let index = 0; index < 3; index++) { await h.fire(4000); await h.answer(h.requests.length - 1, obsStatus({ state: "running" })); }
    assert.equal(dialog.open, true); assert.equal(h.document.activeElement, input); assert.deepEqual(input.children, options);
    assert.equal(h.get(h.prefix + "VisualStatus").textContent, "G-Force · Sound generator · No microphone");
    h.get(h.prefix + "VisualSettingsClose").click(); assert.equal(h.releases.length, 0);
    assert.equal(JSON.stringify(h.rtcCalls), peerCalls); assert.equal(JSON.stringify(h.mediaCalls), mediaCalls); assert.deepEqual([...h.storage], stored);
  }
});

test("Roon desktop-phone-desktop settings placement moves the same trigger while preserving its open dialog and OBS viewer", async () => {
  const h = harness({ provider: "roon", withResponsive: true, withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedRenderer: "g-force" });
  const trigger = h.get("roonVisualSettings"), dialog = h.get("roonVisualSettingsDialog"), renderer = h.get("roonNativeVisualizer");
  assert.equal(trigger.parentNode, h.stage); assert.equal(h.stageFactoryCount(), 1);
  await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
  trigger.click(); renderer.focus(); const before = popupTransportState(h);
  for (const phone of [true, false]) {
    h.phoneBreakpoint(phone); h.mutate(h.stage);
    assert.equal(h.get("roonVisualSettings"), trigger); assert.equal(trigger.parentNode, phone ? h.responsiveRail : h.stage);
    assert.equal(h.get("roonVisualSettingsDialog"), dialog); assert.equal(dialog.parentNode, h.stage); assert.equal(dialog.open, true);
    assert.equal(h.get("roonNativeVisualizer"), renderer); assert.equal(h.document.activeElement, renderer);
    assert.equal(h.stage.dataset.centerView, "visualizer"); assert.equal(h.stageFactoryCount(), 1);
    assert.equal(h.stage.querySelectorAll("*").filter(node => node.id === trigger.id).length, 1); assert.deepEqual(popupTransportState(h), before);
  }
  await h.fire(4000); const heartbeat = h.requests.length - 1;
  assert.equal(h.body(heartbeat).action, "heartbeat"); assert.equal(h.body(heartbeat).viewerId, "viewer-1");
  await h.answer(heartbeat, obsStatus({ state: "running" }));
  assert.equal(h.releases.length, 0); assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 1);
  assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 0); assert.equal(dialog.open, true); assert.equal(h.stageFactoryCount(), 1);
});

test("opening settings from Artwork preserves that view while making a valid explicit Start available", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider }); await h.ready(noMicStatus()); h.stageApi.setView("artwork");
    const before = popupTransportState(h); h.get(h.prefix + "VisualSettings").click(); h.mutate(h.stage);
    assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, true); assert.equal(h.stage.dataset.centerView, "artwork");
    assert.equal(h.get(h.prefix + "VisualSettingsNotice").hidden, false); assert.equal(h.get(h.prefix + "VisualRefresh").disabled, false);
    assert.equal(h.get(h.prefix + "VisualToggle").disabled, false); assert.deepEqual(popupTransportState(h), before);
    h.stageApi.setView("visualizer"); assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, false);
    assert.equal(h.get(h.prefix + "VisualSettingsNotice").hidden, true); assert.equal(h.get(h.prefix + "VisualRefresh").disabled, false);
    assert.deepEqual(popupTransportState(h), before);
  }
});

test("fresh Artwork settings load inputs passively and enable Start only after available input discovery", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, centerView: "artwork", withMedia: true, withRtc: true, savedTransport: "obs-webrtc" });
    h.get(h.prefix + "VisualSettings").click(); h.mutate(h.stage);
    const notice = h.get(h.prefix + "VisualSettingsNotice");
    assert.equal(notice.hidden, false); assert.equal(notice.textContent, "Start visuals switches the center view to Visualizer.");
    assert.equal(notice.parentNode.children[0], notice); assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, true);
    assert.equal(h.get(h.prefix + "VisualRefresh").disabled, false); assert.equal(h.get(h.prefix + "VisualToggle").disabled, true);
    assert.equal(h.get(h.prefix + "VisualStatus").textContent, "Loading audio inputs…", "unknown OBS availability must not say unavailable");
    assert.equal(h.requests.length, 0); assert.equal(h.releases.length, 0); assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 0);
    await h.fire(0); assert.equal(h.requests[0].url, "/api/soundspectrum/status"); assert.equal(h.requests[0].options.method, undefined);
    assert.equal(h.get(h.prefix + "VisualSettingsBody").getAttribute("aria-busy"), "true");
    await h.answer(0, obsStatus({ state: "idle" }));
    assert.equal(h.get(h.prefix + "NativeInput").value, "generator:fluid"); assert.equal(h.get(h.prefix + "NativeInput").disabled, false);
    assert.equal(h.get(h.prefix + "VisualStatus").textContent, "Visuals stopped");
    assert.equal(h.get(h.prefix + "VisualSettingsBody").getAttribute("aria-busy"), "false");
    assert.equal(h.stage.dataset.centerView, "artwork"); assert.equal(h.get(h.prefix + "VisualToggle").disabled, false);
    assert.equal(h.requests.length, 1); assert.equal(h.requests.every(request => request.options.method === undefined), true);
    assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 0); assert.equal(h.releases.length, 0);
    h.stageApi.setView("visualizer"); assert.equal(notice.hidden, true); await h.fire(0); await h.answer(1, obsStatus({ state: "idle" }));
    h.get(h.prefix + "VisualSettings").click(); assert.equal(h.get(h.prefix + "VisualRefresh").disabled, false);
    assert.equal(h.get(h.prefix + "VisualToggle").disabled, false); assert.equal(h.requests.length, 2);
    assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 0);
  }
});

async function artworkPopup(provider, overrides = {}) {
  const h = harness({ provider, centerView: "artwork", withMedia: true, withRtc: true, savedTransport: "obs-webrtc", ...overrides });
  h.get(h.prefix + "VisualSettings").click(); await h.fire(0);
  await h.answer(0, obsStatus({ state: "idle", visualizer: "whitecap" }));
  return h;
}

test("explicit Artwork popup Start promotes the same stage once in each supported player presentation", async () => {
  for (const [provider, presentation] of [["roon", "player--regular"], ["roon", "player--maximized"], ["roon", "player--fullscreen"], ["lyrion", "lyrionNow--fullscreen"]]) {
    const h = harness({ provider, centerView: "artwork", withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedBuffer: "automatic" });
    if (provider === "roon") { h.stage.classList.remove("player--regular"); h.stage.classList.add(presentation); h.mutate(h.stage); }
    h.get(h.prefix + "VisualSettings").click(); await h.fire(0); await h.answer(0, obsStatus({ state: "idle", visualizer: "whitecap" }));
    assert.equal(h.stage.dataset.centerView, "artwork"); assert.equal(h.requests.length, 1);
    h.get(h.prefix + "VisualToggle").click();
    assert.equal(h.stage.dataset.centerView, "visualizer"); assert.equal(h.storage.get(h.prefix + ".centerView"), "visualizer");
    assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, true); assert.equal(h.get(h.prefix + "VisualSettingsNotice").hidden, true);
    assert.equal(h.stageFactoryCount(), 1); assert.equal(h.requests.length, 2);
    assert.deepEqual(h.body(1), { action: "start", visualizer: "whitecap", inputId: "generator:fluid", viewerId: "viewer-1", transport: "obs-webrtc" });
    assert.equal(h.get(h.prefix + "VisualToggle").textContent, "Cancel start"); assert.equal(h.get(h.prefix + "VisualBuffer").value, "automatic");
    await h.answer(1, obsStatus({ state: "running", visualizer: "whitecap" }));
    assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 1); assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 0);
    h.get(h.prefix + "VisualToggle").click(); assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    assert.equal(h.requests.filter(request => request.options.method === "POST").length, 1);
  }
});

test("Artwork popup music Start preserves exact independent Roon zone and Lyrion player identities", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, centerView: "artwork", withRtc: true, savedTransport: "obs-webrtc" });
    h.get(h.prefix + "VisualSettings").click(); await h.fire(0);
    await h.answer(0, obsStatus({ ...(provider === "roon" ? roonStatus() : musicStatus()), state: "idle", visualizer: "whitecap" }));
    if (provider === "roon") selectRoonAnalysis(h);
    else { h.get("lyrionPlayer").value = "exact-player"; h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange(); }
    assert.equal(h.requests.length, 1); assert.equal(h.stage.dataset.centerView, "artwork");
    h.get(h.prefix + "VisualToggle").click();
    assert.deepEqual(h.body(1), { action: "start", visualizer: "whitecap", inputId: provider === "roon" ? "feed:hqplayer-analysis" : "feed:pre-hqplayer",
      viewerId: "viewer-1", transport: "obs-webrtc", ...(provider === "roon" ? { zoneId: "exact-zone" } : { playerId: "exact-player" }) });
    await h.answer(1, obsStatus(provider === "roon" ? roonFeedStatus() : feedStatus()));
    assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 1);
  }
});

test("a second Artwork Start tap cancels the pending first viewer instead of creating a second viewer", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = await artworkPopup(provider); h.get(h.prefix + "VisualToggle").click(); const pending = h.requests[1];
    h.get(h.prefix + "VisualToggle").click(); assert.equal(pending.options.signal.aborted, true);
    assert.equal(h.get(h.prefix + "VisualToggle").textContent, "Start visuals"); assert.equal(h.requests.length, 2);
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    await h.answer(1, obsStatus({ state: "running", visualizer: "whitecap" }));
    assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 0);
    assert.equal(h.requests.filter(request => request.options.method === "POST").length, 1);
    assert.equal(h.stage.dataset.centerView, "visualizer");
  }
});

test("Artwork Start validates unknown or unavailable inventory and exact music target before promoting the view", async () => {
  for (const provider of ["roon", "lyrion"]) {
    for (const invalid of ["unknown", "runtime", "input", "transport", "target"]) {
      const h = harness({ provider, centerView: "artwork", withRtc: true, savedTransport: "obs-webrtc" });
      h.get(h.prefix + "VisualSettings").click();
      if (invalid !== "unknown") {
        await h.fire(0);
        const inventory = invalid === "runtime" ? { visualizers: [] } : invalid === "input" ? { inputs: [], noMicInputs: {} } : invalid === "transport" ? { transports: obsTransports.map(value => ({ ...value, available: false })) } : provider === "roon" ? roonStatus() : musicStatus();
        await h.answer(0, obsStatus({ ...inventory, state: "idle", visualizer: "whitecap" }));
        if (invalid === "target") {
          if (provider === "roon") { selectRoonAnalysis(h); h.get("zoneSelect").value = "different-zone"; h.get("zoneSelect").dispatchEvent(uiEvent("change")); }
          else { h.get("lyrionPlayer").value = ""; h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange(); }
        }
      }
      const before = h.requests.length;
      assert.equal(h.get(h.prefix + "VisualToggle").disabled, true, invalid);
      h.get(h.prefix + "VisualToggle").onclick(); await flush();
      assert.equal(h.requests.length, before, invalid); assert.equal(h.stage.dataset.centerView, "artwork", invalid);
      assert.equal(h.storage.get(h.prefix + ".centerView"), "artwork", invalid);
    }
  }
});

test("closed, hidden or departed Artwork settings reject stale Start events before changing the center view", async () => {
  for (const provider of ["roon", "lyrion"]) for (const exit of [h => h.get(h.prefix + "VisualSettingsClose").click(), h => { h.document.hidden = true; },
    h => { h.view.hidden = true; }, h => { if (provider === "roon") h.document.body.dataset.playbackSystem = "lyrion"; else h.stage.classList.remove("lyrionNow--fullscreen"); }]) {
    const h = await artworkPopup(provider); exit(h); const before = h.requests.length;
    // Bypass the stale disabled attribute to exercise the actual Start guard.
    h.get(h.prefix + "VisualToggle").onclick(); await flush();
    assert.equal(h.requests.length, before); assert.equal(h.stage.dataset.centerView, "artwork");
    assert.equal(h.storage.get(h.prefix + ".centerView"), "artwork"); assert.equal(h.releases.length, 0);
  }
});

test("closing the popup after explicit Artwork Start preserves its one pending viewer and normal heartbeat", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = await artworkPopup(provider); h.get(h.prefix + "VisualToggle").click();
    h.get(h.prefix + "VisualSettingsClose").click(); assert.equal(h.requests[1].options.signal.aborted, false);
    await h.answer(1, obsStatus({ state: "running", visualizer: "whitecap" }));
    assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, false); assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 1);
    await h.fire(4000); assert.equal(h.body(2).action, "heartbeat"); assert.equal(h.body(2).viewerId, "viewer-1");
    await h.answer(2, obsStatus({ state: "running", visualizer: "whitecap" })); assert.equal(h.releases.length, 0);
  }
});

test("source, view or transport changes during popup Start cancel its promoted pending viewer without resurrection", async () => {
  for (const provider of ["roon", "lyrion"]) for (const cancel of [h => { h.view.hidden = true; h.mutate(h.view); }, h => h.stageApi.setView("artwork"),
    h => { h.get(h.prefix + "VisualTransport").value = "jpeg"; h.get(h.prefix + "VisualTransport").onchange(); }]) {
    const h = await artworkPopup(provider); h.get(h.prefix + "VisualToggle").click(); cancel(h);
    assert.equal(h.requests[1].options.signal.aborted, true); assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    await h.answer(1, obsStatus({ state: "running", visualizer: "whitecap" }));
    assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 0); assert.equal(h.requests.length, 2);
  }
});

test("failed popup Start keeps its promoted view and requires an explicit fresh viewer retry", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = await artworkPopup(provider); h.get(h.prefix + "VisualToggle").click();
    await h.answer(1, { error: "The selected bridge could not start." }, false);
    assert.equal(h.stage.dataset.centerView, "visualizer"); assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, true);
    assert.match(h.get(h.prefix + "VisualSettingsReason").textContent, /selected bridge could not start/);
    assert.equal(h.get(h.prefix + "VisualToggle").textContent, "Start visuals"); assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    await h.fire(8000); assert.equal(h.requests[2].url, "/api/soundspectrum/status"); await h.answer(2, obsStatus({ state: "idle", visualizer: "whitecap" }));
    assert.equal(h.requests.filter(request => request.options.method === "POST").length, 1); assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 0);
    h.get(h.prefix + "VisualToggle").click(); assert.equal(h.body(3).action, "start"); assert.equal(h.body(3).viewerId, "viewer-2");
    await h.answer(3, obsStatus({ state: "running", visualizer: "whitecap" })); assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 1);
  }
});

test("Artwork popup Refresh uses GET only and preserves the selected input, renderer, transport and buffer", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, centerView: "artwork", withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedBuffer: "automatic" });
    h.get(h.prefix + "VisualSettings").click(); await h.fire(0); await h.answer(0, obsStatus({ state: "idle" }));
    const input = h.get(h.prefix + "NativeInput"); input.value = "generator:chill"; input.onchange();
    const before = popupTransportState(h), buffer = h.get(h.prefix + "VisualBuffer").value;
    h.get(h.prefix + "VisualRefresh").click(); assert.equal(h.requests[1].url, "/api/soundspectrum/status?refresh=1");
    assert.equal(h.requests[1].options.method, undefined); await h.answer(1, obsStatus({ state: "idle" }));
    assert.deepEqual({ ...popupTransportState(h), mediaCalls: before.mediaCalls }, { ...before, requests: before.requests + 1 });
    assert.equal(h.mediaCalls.every(call => call.action === "stop"), true, "passive inventory never starts a receiver");
    assert.equal(h.get(h.prefix + "VisualBuffer").value, buffer); assert.equal(h.stage.dataset.centerView, "artwork");
    assert.equal(h.get(h.prefix + "VisualToggle").disabled, false); assert.equal(h.releases.length, 0);
  }
});

test("closing and reopening Artwork settings fences an aborted late inventory response", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, centerView: "artwork", withMedia: true, withRtc: true, savedTransport: "obs-webrtc" });
    h.get(h.prefix + "VisualSettings").click(); await h.fire(0); const oldSignal = h.requests[0].options.signal;
    h.get(h.prefix + "VisualSettingsClose").click(); assert.equal(oldSignal.aborted, true);
    assert.equal([...h.timers.values()].some(timer => [0, 4000, 8000].includes(timer.delay)), false);
    h.get(h.prefix + "VisualSettings").click(); await h.fire(0);
    await h.answer(0, status({ visualizers: [], inputs: [], captureAvailable: false }));
    assert.equal(h.get(h.prefix + "VisualStatus").textContent, "Loading audio inputs…");
    await h.answer(1, obsStatus({ state: "idle" })); assert.equal(h.get(h.prefix + "VisualStatus").textContent, "Visuals stopped");
    h.get(h.prefix + "VisualSettingsClose").click();
    assert.equal([...h.timers.values()].some(timer => [0, 4000, 8000].includes(timer.delay)), false);
    assert.equal(h.releases.length, 0); assert.equal(h.requests.every(request => request.options.method === undefined), true);
    assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 0);
  }
});

test("source or presentation exit cancels Artwork discovery and ignores its late completion", async () => {
  for (const provider of ["roon", "lyrion"]) for (const exit of [h => { h.view.hidden = true; h.mutate(h.view); }, h => {
    if (provider === "roon") h.document.body.dataset.playbackSystem = "lyrion";
    else h.stage.classList.remove("lyrionNow--fullscreen");
    h.mutate(h.stage);
  }]) {
    const h = harness({ provider, centerView: "artwork", withMedia: true });
    h.get(h.prefix + "VisualSettings").click(); await h.fire(0); exit(h);
    assert.equal(h.requests[0].options.signal.aborted, true); assert.equal(h.get(h.prefix + "VisualSettingsDialog").open, false);
    await h.answer(0, noMicStatus()); assert.equal(h.get(h.prefix + "NativeInput").value, "");
    assert.equal(h.requests.length, 1); assert.equal(h.releases.length, 0);
    assert.equal([...h.timers.values()].some(timer => [0, 4000, 8000].includes(timer.delay)), false);
  }
});

test("Artwork inventory timeout shows a recoverable Refresh error instead of endless loading or unknown transport failure", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, centerView: "artwork", withRtc: true, savedTransport: "obs-webrtc" });
    h.get(h.prefix + "VisualSettings").click(); await h.fire(0); await h.fire(10000);
    assert.equal(h.requests[0].options.signal.aborted, true);
    h.requests[0].reject(Object.assign(Error("aborted"), { name: "AbortError" })); await flush();
    assert.match(h.get(h.prefix + "NativeInput").children[0].label, /Could not load inputs/);
    assert.match(h.get(h.prefix + "VisualHint").textContent, /Refresh inputs/);
    const reason = h.get(h.prefix + "VisualSettingsReason"); assert.equal(reason.hidden, false); assert.match(reason.textContent, /discovery timed out.*Refresh inputs/);
    assert.notEqual(h.get(h.prefix + "VisualStatus").textContent, "Video transport unavailable");
    assert.equal(h.get(h.prefix + "VisualRefresh").disabled, false); assert.equal(h.get(h.prefix + "VisualSettingsBody").getAttribute("aria-busy"), "false");
    h.get(h.prefix + "VisualRefresh").click(); assert.equal(h.requests[1].url, "/api/soundspectrum/status?refresh=1");
    await h.answer(1, obsStatus({ state: "idle" })); assert.equal(h.get(h.prefix + "VisualStatus").textContent, "Visuals stopped");
    assert.equal(h.get(h.prefix + "VisualToggle").disabled, false); assert.equal(h.releases.length, 0);
    assert.equal(h.requests.every(request => request.options.method === undefined), true);
  }
});

test("Artwork settings report actual transport unavailability only after a checked inventory response", async () => {
  const h = harness({ provider: "roon", centerView: "artwork", withRtc: true, savedTransport: "obs-webrtc" });
  h.get("roonVisualSettings").click(); assert.equal(h.get("roonVisualStatus").textContent, "Loading audio inputs…");
  await h.fire(0); await h.answer(0, obsStatus({ state: "idle", transports: [{ id: "jpeg", available: true },
    { id: "obs-webrtc", available: false, reason: "Prepare the isolated OBS transport on the PC." }] }));
  assert.equal(h.get("roonVisualStatus").textContent, "Video transport unavailable");
  assert.equal(h.get("roonVisualSettingsReason").hidden, false); assert.match(h.get("roonVisualSettingsReason").textContent, /Prepare the isolated OBS/);
  assert.equal(h.get("roonVisualRefresh").disabled, false); assert.equal(h.get("roonVisualToggle").disabled, true);
});

test("the modal includes exact unavailable, waiting and paused reasons and hides them for healthy active visuals", async () => {
  const h = harness({ provider: "roon", withMedia: true });
  await h.ready(roonStatus({ musicInputs: [{ ...hqplayerInput, available: false, reason: "Enable the isolated HQPlayer analysis feed on the PC." }] }));
  h.get("roonNativeInput").value = hqplayerInput.id; h.get("roonNativeInput").onchange(); h.get("roonVisualSettings").click();
  const reason = h.get("roonVisualSettingsReason"), toggle = h.get("roonVisualToggle");
  assert.equal(reason.hidden, false); assert.equal(reason.textContent, "Enable the isolated HQPlayer analysis feed on the PC.");
  assert.equal(toggle.getAttribute("aria-describedby"), "roonVisualHint roonVisualSettingsReason");
  await h.fire(8000); await h.answer(h.requests.length - 1, roonStatus());
  await h.start(roonFeedStatus({ audioFeed: { state: "waiting", source: "roon-hqplayer", zoneId: "exact-zone", reason: "Waiting for the exact zone analysis." } }));
  assert.equal(reason.hidden, false); assert.equal(reason.textContent, "Waiting for the exact zone analysis.");
  await h.fire(4000); await h.answer(h.requests.length - 1, roonFeedStatus());
  assert.equal(reason.hidden, true); assert.equal(toggle.getAttribute("aria-describedby"), "roonVisualHint");
  h.get("roonVisualFreeze").click(); assert.equal(reason.hidden, false); assert.match(reason.textContent, /Resume visuals/);
  assert.equal(h.get("roonVisualSettingsDialog").open, true);
});

test("real provider, center view and page exits dismiss settings and release only the already-owned viewer", async () => {
  for (const provider of ["roon", "lyrion"]) {
    for (const exit of [h => h.stageApi.setView("artwork"), h => { h.view.hidden = true; if (provider === "roon") h.view.classList.remove("isActive"); h.mutate(h.view); }, h => h.event("pagehide")]) {
      const h = harness({ provider, withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedRenderer: "g-force" });
      await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
      const dialog = h.get(h.prefix + "VisualSettingsDialog"), trigger = h.get(h.prefix + "VisualSettings"), close = h.get(h.prefix + "VisualSettingsClose");
      trigger.click(); const requests = h.requests.length; exit(h);
      assert.equal(dialog.open, false); assert.equal(dialog.hidden, true); assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.equal(h.document.activeElement, close, "a source exit does not focus its hidden trigger"); assert.equal(h.requests.length, requests);
      assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 1);
    }
  }
});

test("visualizer-only fullscreen dismisses its popup and Return keeps the exact OBS receiver and viewer", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedRenderer: "g-force" });
    await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
    const dialog = h.get(h.prefix + "VisualSettingsDialog"), trigger = h.get(h.prefix + "VisualSettings"), expand = h.get(h.prefix + "VisualExpand");
    const before = popupTransportState(h); trigger.click(); expand.click(); h.mutate(h.stage);
    assert.equal(dialog.open, false); assert.equal(trigger.hidden, true); assert.equal(h.mediaPresentation(), "visualizer-fullscreen");
    expand.click(); h.mutate(h.stage); assert.equal(trigger.hidden, false); assert.equal(dialog.open, false);
    assert.deepEqual(popupTransportState(h), before);
  }
});

test("explicit Stop and transport changes keep settings available without reopening a peer or automatically starting JPEG", async () => {
  const h = harness({ provider: "roon", withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedRenderer: "g-force" });
  await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
  const dialog = h.get("roonVisualSettingsDialog"); h.get("roonVisualSettings").click();
  h.get("roonVisualToggle").click(); assert.equal(dialog.open, true); assert.equal(h.get("roonVisualToggle").textContent, "Start visuals");
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); const requests = h.requests.length;
  h.get("roonVisualTransport").value = "jpeg"; h.get("roonVisualTransport").onchange();
  assert.equal(dialog.open, true); assert.equal(h.requests.length, requests); assert.equal(h.rtcCalls.filter(call => call.action === "start").length, 1);
  assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 0); assert.equal(h.storage.get("roon.soundSpectrumTransport"), "jpeg");
});

test("an old queued dialog close event cannot hide a newly reopened modal", async () => {
  const h = harness(); await h.ready(noMicStatus());
  const dialog = h.get("lyrionVisualSettingsDialog"), trigger = h.get("lyrionVisualSettings");
  dialog.close = () => { dialog.open = false; }; trigger.click(); h.get("lyrionVisualSettingsClose").click(); trigger.click();
  dialog.dispatchEvent(uiEvent("close")); assert.equal(dialog.open, true); assert.equal(dialog.hidden, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "true"); assert.equal(h.releases.length, 0);
});

test("a rejected native modal opening remains closed without changing media or viewer demand", async () => {
  const h = harness(); await h.ready(noMicStatus()); const before = popupTransportState(h);
  const dialog = h.get("lyrionVisualSettingsDialog"); dialog.showModal = () => { throw Error("Unavailable modal"); };
  h.get("lyrionVisualSettings").click(); assert.equal(dialog.hidden, true); assert.equal(h.get("lyrionVisualSettings").getAttribute("aria-expanded"), "false");
  assert.equal(h.stage.classList.contains("soundSpectrumStage--settingsOpen"), false); assert.deepEqual(popupTransportState(h), before);
});

test("saved OBS transport never starts capture and unavailable OBS stays selected with an explicit reason", async () => {
  const h = harness({ withMedia: true, withRtc: true, provider: "roon", savedTransport: "obs-webrtc", savedRenderer: "g-force" });
  assert.equal(h.requests.length, 0); assert.equal(h.rtcCalls.length, 0);
  await h.ready(obsStatus({ state: "idle", transports: obsTransports.map(value => value.id === "obs-webrtc" ? { ...value, available: false, reason: "Start the isolated publisher on the PC." } : value) }));
  assert.equal(h.get("roonVisualTransport").value, "obs-webrtc"); assert.equal(h.get("roonVisualToggle").disabled, true);
  assert.match(h.get("roonVisualReason").textContent, /isolated publisher/);
  h.get("roonVisualToggle").click(); assert.equal(h.requests.length, 1); assert.equal(h.mediaCalls.filter(value => value.action === "start").length, 0); assert.equal(h.rtcCalls.length, 0);
});

test("explicit OBS Start selects the video receiver with exact generation and preserves peer selection across heartbeats and fullscreen", async () => {
  const h = harness({ withMedia: true, withRtc: true, provider: "roon", savedTransport: "obs-webrtc", savedRenderer: "g-force" });
  await h.ready(obsStatus({ state: "idle" })); const index = await h.start(obsStatus({ state: "running" }));
  assert.equal(h.body(index).transport, "obs-webrtc"); assert.equal(h.body(index).action, "start");
  assert.equal(h.rtcCalls.filter(value => value.action === "start").length, 1); assert.equal(h.rtcCalls[0].args[1], "obs-webrtc"); assert.equal(h.rtcCalls[0].args[2], 4);
  assert.equal(h.mediaCalls.filter(value => value.action === "start").length, 0);
  h.stage.classList.add("player--maximized"); h.mutate(h.stage);
  await h.fire(4000); const heartbeat = h.requests.length - 1; assert.equal(h.body(heartbeat).videoStats.transport, "obs-webrtc"); await h.answer(heartbeat, obsStatus({ state: "running" }));
  h.get("roonVisualExpand").click(); await flush(); h.get("roonVisualExpand").click(); await flush();
  assert.equal(h.rtcCalls.filter(value => value.action === "start").length, 1); assert.equal(h.releases.length, 0);
  await h.fire(4000); await h.answer(h.requests.length - 1, obsStatus({ state: "running", generation: 5 }));
  assert.equal(h.rtcCalls.filter(value => value.action === "start").length, 2); assert.equal(h.rtcCalls.at(-1).args[2], 5);
});

test("transport selection releases a running viewer and requires an explicit new Start without automatic JPEG fallback", async () => {
  const h = harness({ withMedia: true, withRtc: true, provider: "roon", savedTransport: "obs-webrtc", savedRenderer: "g-force" });
  await h.ready(obsStatus({ state: "idle" })); await h.start(obsStatus({ state: "running" }));
  const count = h.requests.length; h.get("roonVisualTransport").value = "jpeg"; h.get("roonVisualTransport").onchange(); await flush();
  assert.equal(h.requests.length, count); assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  assert.equal(h.storage.get("roon.soundSpectrumTransport"), "jpeg"); assert.equal(h.mediaCalls.filter(value => value.action === "start").length, 0);
  assert.equal(h.get("roonVisualToggle").textContent, "Start visuals");
});

test("missing browser support cannot silently select JPEG for any visualizer", async () => {
  for (const savedRenderer of ["aeon", "g-force", "whitecap"]) {
    const options = { withRtc: false, savedRenderer };
    const h = harness({ withMedia: true, provider: "roon", savedTransport: "obs-webrtc", ...options });
    await h.ready(obsStatus({ state: "idle" }));
    assert.equal(h.get("roonVisualTransport").value, "obs-webrtc"); assert.equal(h.get("roonVisualToggle").disabled, true);
    assert.equal(h.mediaCalls.filter(value => value.action === "start").length, 0); assert.equal(h.rtcCalls.length, 0);
  }
});

test("all three OBS visualizers are selectable in each provider and use only the WebRTC receiver", async () => {
  for (const provider of ["roon", "lyrion"]) for (const visualizer of ["aeon", "g-force", "whitecap"]) {
    const h = harness({ provider, withMedia: true, withRtc: true, savedTransport: "obs-webrtc", savedRenderer: visualizer });
    await h.ready(obsStatus({ state: "idle", visualizer }));
    assert.equal(h.get(h.prefix + "NativeVisualizer").value, visualizer);
    assert.equal(h.get(h.prefix + "VisualTransport").value, "obs-webrtc");
    assert.equal(h.get(h.prefix + "VisualToggle").disabled, false);
    assert.equal(h.rtcCalls.length, 0);
    const index = await h.start(obsStatus({ state: "running", visualizer }));
    assert.equal(h.body(index).visualizer, visualizer); assert.equal(h.body(index).transport, "obs-webrtc");
    assert.equal(h.rtcCalls.filter(value => value.action === "start").length, 1);
    assert.equal(h.mediaCalls.filter(value => value.action === "start").length, 0);
  }
});

test("prepared OBS is the unsaved default for every product while an explicit JPEG preference stays selected", async () => {
  for (const savedRenderer of ["aeon", "g-force", "whitecap"]) for (const savedTransport of [undefined, "jpeg"]) {
    const h = harness({ provider: "roon", withMedia: true, withRtc: true, savedRenderer, savedTransport });
    await h.ready(obsStatus({ state: "idle", visualizer: savedRenderer }));
    assert.equal(h.get("roonVisualTransport").value, savedTransport || "obs-webrtc");
    assert.equal(h.requests.length, 1); assert.equal(h.rtcCalls.length, 0);
  }
});

test("switching active OBS renderers preserves each provider's exact music input and retires the previous peer", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withMedia: true, withRtc: true, savedRenderer: "g-force", savedTransport: "obs-webrtc" });
    const inventory = provider === "roon" ? roonStatus() : musicStatus();
    const running = provider === "roon" ? roonFeedStatus : feedStatus;
    await h.ready(obsStatus({ ...inventory, visualizer: "g-force" }));
    if (provider === "roon") selectRoonAnalysis(h);
    else { h.get("lyrionPlayer").value = "exact-player"; h.get("lyrionNativeInput").value = "feed:pre-hqplayer"; h.get("lyrionNativeInput").onchange(); }
    const exactInput = h.get(h.prefix + "NativeInput").value;
    await h.start(obsStatus(running({ visualizer: "g-force", generation: 4 })));
    for (const [index, visualizer] of ["aeon", "whitecap", "g-force"].entries()) {
      const peers = h.rtcCalls.filter(call => call.action === "start").length;
      h.get(h.prefix + "NativeVisualizer").value = visualizer; h.get(h.prefix + "NativeVisualizer").onchange(); await flush();
      const pending = h.requests.length - 1, request = h.body(pending);
      assert.equal(request.action, "start"); assert.equal(request.visualizer, visualizer); assert.equal(request.transport, "obs-webrtc");
      assert.equal(request.inputId, exactInput); assert.equal(request[provider === "roon" ? "zoneId" : "playerId"], provider === "roon" ? "exact-zone" : "exact-player");
      await h.answer(pending, obsStatus(running({ visualizer, generation: 5 + index })));
      assert.equal(h.get(h.prefix + "VisualTransport").value, "obs-webrtc"); assert.equal(h.get(h.prefix + "NativeInput").value, exactInput);
      assert.equal(h.rtcCalls.filter(call => call.action === "start").length, peers + 1); assert.equal(h.rtcCalls.at(-1).args[2], 5 + index);
      assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 0);
    }
  }
});

test("another OBS viewer joins only an exact running transport and renderer generation", async () => {
  const h = harness({ withMedia: true, withRtc: true, provider: "roon", savedTransport: "obs-webrtc", savedRenderer: "g-force" });
  await h.ready(obsStatus({ state: "running", viewerActive: false })); const index = await h.start(obsStatus({ state: "running" }));
  assert.equal(h.body(index).action, "join"); assert.equal(h.body(index).generation, 4); assert.equal(h.body(index).transport, "obs-webrtc");
  assert.equal(h.rtcCalls.filter(value => value.action === "start").length, 1); assert.equal(h.mediaCalls.filter(value => value.action === "start").length, 0);
});
const musicRunning = provider => provider === "roon" ? roonFeedStatus() : feedStatus();
function setHidden(h, hidden) { h.document.hidden = hidden; h.document.dispatchEvent(uiEvent("visibilitychange")); }

test("native window occlusion keeps each viewer, exact music input and media while renewing hidden and visible leases", async () => {
  for (const provider of ["lyrion", "roon"]) {
    const h = await musicViewer(provider), running = musicRunning(provider), start = await h.start(running);
    const viewerId = h.body(start).viewerId, inputId = h.get(h.prefix + "NativeInput").value;
    const originalMedia = [...h.mediaCalls];
    setHidden(h, true);
    const hiddenHeartbeat = h.requests.length - 1;
    assert.deepEqual(h.body(hiddenHeartbeat), { action: "heartbeat", viewerId, visibility: "hidden" });
    assert.equal(h.get(h.prefix + "VisualToggle").textContent, "Stop visuals");
    assert.equal(h.get(h.prefix + "NativeInput").value, inputId);
    assert.deepEqual(h.mediaCalls, originalMedia); assert.deepEqual(await h.stoppedIds(), []);
    await h.answer(hiddenHeartbeat, running);
    await h.fire(4000);
    const recurring = h.requests.length - 1;
    assert.deepEqual(h.body(recurring), { action: "heartbeat", viewerId, visibility: "hidden" });
    await h.answer(recurring, running);
    setHidden(h, false);
    const visibleHeartbeat = h.requests.length - 1;
    assert.deepEqual(h.body(visibleHeartbeat), { action: "heartbeat", viewerId, visibility: "visible" });
    await h.answer(visibleHeartbeat, running);
    assert.equal(h.get(h.prefix + "NativeInput").value, inputId);
    assert.deepEqual(h.mediaCalls, originalMedia); assert.deepEqual(await h.stoppedIds(), []);
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

test("native window occlusion preserves expanded browser geometry and reveals its controls on return", async () => {
  for (const provider of ["lyrion", "roon"]) {
    const h = await musicViewer(provider), running = musicRunning(provider); await h.start(running);
    const fullscreenClass = provider === "roon" ? "roonVisualFullscreen" : "lyrionNow--visualFullscreen";
    h.get(h.prefix + "VisualSurface").click(); h.get(h.prefix + "VisualExpand").click();
    assert.equal(h.stage.classList.contains(fullscreenClass), true);
    const originalMedia = [...h.mediaCalls];
    setHidden(h, true); await h.answer(h.requests.length - 1, running);
    assert.equal(h.stage.classList.contains(fullscreenClass), true);
    assert.equal(h.get(h.prefix + "VisualExpand").getAttribute("aria-expanded"), "true");
    assert.equal(h.get(h.prefix + "VisualOverlay").hidden, true);
    setHidden(h, false); await h.answer(h.requests.length - 1, running);
    assert.equal(h.stage.classList.contains(fullscreenClass), true);
    assert.equal(h.get(h.prefix + "VisualOverlay").hidden, false);
    assert.deepEqual(h.mediaCalls, originalMedia); assert.deepEqual(await h.stoppedIds(), []);
  }
});

test("a visible Start that finishes under the native window retains its viewer and immediately renews a hidden lease", async () => {
  for (const provider of ["lyrion", "roon"]) {
    const h = await musicViewer(provider), running = musicRunning(provider);
    h.get(h.prefix + "VisualToggle").click();
    const start = h.requests.length - 1, viewerId = h.body(start).viewerId;
    setHidden(h, true);
    assert.equal(h.requests.length, start + 1, "pending Start stays the only request");
    await h.answer(start, running);
    const hiddenHeartbeat = h.requests.length - 1;
    assert.deepEqual(h.body(hiddenHeartbeat), { action: "heartbeat", viewerId, visibility: "hidden" });
    assert.equal(h.get(h.prefix + "VisualToggle").textContent, "Stop visuals");
    assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 0, "new media waits for a visible page");
    assert.deepEqual(await h.stoppedIds(), []);
    await h.answer(hiddenHeartbeat, running);
    setHidden(h, false);
    const visibleHeartbeat = h.requests.length - 1;
    assert.deepEqual(h.body(visibleHeartbeat), { action: "heartbeat", viewerId, visibility: "visible" });
    await h.answer(visibleHeartbeat, running);
    assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1);
    assert.deepEqual(await h.stoppedIds(), []);
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

test("occlusion during an in-flight heartbeat renews hidden demand immediately after that request completes", async () => {
  const h = await musicViewer("roon"), running = roonFeedStatus(); await h.start(running);
  const originalMedia = [...h.mediaCalls]; await h.fire(4000);
  const visibleHeartbeat = h.requests.length - 1;
  assert.equal(h.body(visibleHeartbeat).visibility, "visible");
  setHidden(h, true);
  assert.equal(h.requests.length, visibleHeartbeat + 1, "visibility does not create a concurrent heartbeat");
  await h.answer(visibleHeartbeat, running);
  const hiddenHeartbeat = h.requests.length - 1;
  assert.deepEqual(h.body(hiddenHeartbeat), { action: "heartbeat", viewerId: "viewer-1", visibility: "hidden" });
  await h.answer(hiddenHeartbeat, running);
  assert.deepEqual(h.mediaCalls, originalMedia); assert.deepEqual(await h.stoppedIds(), []);
});

test("a hidden page never starts a new visualizer or polls without an owned viewer", async () => {
  for (const provider of ["lyrion", "roon"]) {
    const h = await musicViewer(provider), originalRequests = h.requests.length;
    setHidden(h, true); h.event("pageshow"); h.event("online");
    assert.equal(h.get(h.prefix + "VisualToggle").disabled, true);
    h.get(h.prefix + "VisualToggle").click();
    assert.equal(h.requests.length, originalRequests);
    assert.equal(h.timers.size, 0); assert.deepEqual(await h.stoppedIds(), []);
    setHidden(h, false); await h.fire(0);
    assert.match(h.requests.at(-1).url, /\/status$/);
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 0);
  }
});

test("hidden media failure keeps native demand and reconnects the same viewer on return", async () => {
  for (const provider of ["lyrion", "roon"]) {
    const h = await musicViewer(provider), running = musicRunning(provider), start = await h.start(running);
    const viewerId = h.body(start).viewerId, inputId = h.get(h.prefix + "NativeInput").value;
    setHidden(h, true); await h.answer(h.requests.length - 1, running);
    h.mediaError();
    assert.equal(h.get(h.prefix + "VisualToggle").textContent, "Stop visuals");
    assert.deepEqual(await h.stoppedIds(), []);
    assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1);
    await h.fire(4000);
    const hiddenHeartbeat = h.requests.length - 1;
    assert.deepEqual(h.body(hiddenHeartbeat), { action: "heartbeat", viewerId, visibility: "hidden" });
    await h.answer(hiddenHeartbeat, running);
    assert.equal(h.mediaCalls.filter(call => call.action === "start").length, 1, "hidden status cannot reopen transport");
    setHidden(h, false);
    const visibleHeartbeat = h.requests.length - 1;
    await h.answer(visibleHeartbeat, running);
    const mediaStarts = h.mediaCalls.filter(call => call.action === "start");
    assert.equal(mediaStarts.length, 2); assert.equal(mediaStarts.at(-1).args[0], viewerId);
    assert.equal(h.get(h.prefix + "NativeInput").value, inputId); assert.deepEqual(await h.stoppedIds(), []);
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

test("real view and selection exits while hidden release with bounded reasons and cannot resurrect from a late heartbeat", async () => {
  const exits = [
    ["view-hidden", h => { h.view.hidden = true; h.mutate(h.view); }],
    ["source-change", h => { h.get("zoneSelect").value = "other-zone"; h.get("zoneSelect").dispatchEvent(uiEvent("change")); }],
    ["selection-change", h => { h.get("roonNativeInput").value = "generator:chill"; h.get("roonNativeInput").onchange(); }],
    ["pagehide", h => h.event("pagehide")]
  ];
  for (const [reason, exit] of exits) {
    const h = await musicViewer("roon"), running = roonFeedStatus(); await h.start(running);
    setHidden(h, true); const pending = h.requests.length - 1;
    exit(h);
    assert.equal(h.requests[pending].options.signal.aborted, true);
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    const body = JSON.parse(await h.releases[0].body.text());
    assert.deepEqual(body, { action: "stop", viewerId: "viewer-1", reason, visibility: "hidden" });
    await h.answer(pending, running);
    assert.equal(h.get("roonVisualToggle").textContent, "Start visuals");
    assert.equal(h.get("roonVisualVideo").src, "");
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

// Run the real player zone resolution and status event producer alongside the
// shared visualizer. Display-only collaborators do not affect target identity.
function bindRoonPlayer(h, selectedZoneId = "exact-zone") {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const section = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, "production player section is present");
    return source.slice(start, end);
  };
  const playerState = { zones: [], selectedZoneId, isSeeking: false };
  h.get("seekSlider").style = { setProperty() {} };
  Object.assign(h.context, {
    state: playerState, $: selector => h.get(selector.slice(1)), lastRabbitStatusAt: 0, rabbitRecoveryTimer: null,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    queueActionState: {}, summarizeNowPlaying: zone => h.context.currentZoneNowPlaying(zone),
    nowPlayingTrack: zone => h.context.currentZoneNowPlaying(zone), zoneDisplayLabel: zone => zone.zone_id,
    escapeHtml: value => String(value), isLiveRadioZone: () => false,
    formatQueueInfo: () => "", formatSeconds: value => String(value), liveQueueHtml: () => "",
    artworkMetadataMatchesRoon: () => false, trustedRadioArtworkUrl: () => "", setCoverImage() {},
    updateNowDiscoveryTools() {}, updateNowSourceQuality() {}, updateJumpTopVisibility() {}, renderSystemHealth() {},
    scheduleRabbitRecoveryRefresh() {}
  });
  vm.runInNewContext(section("function zonePlaybackState(", "function escapeHtml(") +
    section("function renderState(", "const liveStatus = window.createRabbitStatusLive(") +
    section('$("#zoneSelect").addEventListener("change",', 'function bindRabbitHolePanel() {'), h.context);
  return {
    state: playerState,
    render(zones, connected = true) { h.context.renderState({ connected, core: { name: "Fixture Roon core" }, zones }); }
  };
}

test("real Roon track-boundary updates preserve the selected zone and live visualizer", async () => {
  const h = harness({ provider: "roon", withMedia: true }), player = bindRoonPlayer(h);
  const selected = { zone_id: "exact-zone", display_name: "HQPlayer", state: "playing", outputs: [{ display_name: "HQPlayer" }],
    now_playing: { title: "First track", length: 240, seek_position: 239 } };
  const other = { zone_id: "other-zone", state: "playing", now_playing: { title: "Other output track" } };
  const events = []; h.stage.addEventListener("roon-playback", event => events.push(event.detail));
  player.render([selected, other]); await h.ready(roonStatus()); selectRoonAnalysis(h); await h.start(roonFeedStatus());
  const originalMedia = [...h.mediaCalls];
  for (const state of ["stopped", "paused", "playing"]) {
    player.render([{ ...selected, state, now_playing: undefined }, other]);
    assert.equal(player.state.selectedZoneId, "exact-zone"); assert.equal(h.get("zoneSelect").value, "exact-zone");
    assert.equal(events.at(-1).zoneId, "exact-zone"); assert.equal(events.at(-1).state, state);
    assert.equal(h.get("roonVisualToggle").textContent, "Stop visuals");
    assert.equal(h.releases.length, 0); assert.deepEqual(h.mediaCalls, originalMedia);
    await h.fire(4000);
    const index = h.requests.length - 1;
    assert.equal(h.body(index).action, "heartbeat"); assert.equal(h.body(index).viewerId, "viewer-1");
    await h.answer(index, roonFeedStatus({ audioFeed: { state: "waiting", source: "roon-hqplayer", zoneId: "exact-zone" } }));
  }
  player.render([{ ...selected, now_playing: { title: "Next track", length: 300, seek_position: 0 } }, other]);
  await h.fire(4000); await h.answer(h.requests.length - 1, roonFeedStatus());
  assert.equal(h.get("nowTitle").textContent, "Next track"); assert.equal(h.get("roonVisualToggle").textContent, "Stop visuals");
  assert.deepEqual(await h.stoppedIds(), []); assert.deepEqual(h.mediaCalls, originalMedia);
  assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  // An intentional selector change still releases the original viewer.
  h.get("zoneSelect").value = "other-zone"; h.get("zoneSelect").dispatchEvent(uiEvent("change"));
  assert.equal(player.state.selectedZoneId, "other-zone"); assert.equal(h.storage.get("zoneId"), "other-zone");
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.get("roonVisualToggle").textContent, "Start visuals");
});

test("real Roon zone resolution still selects a playing initial or truly unavailable output", () => {
  for (const selectedZoneId of ["", "removed-zone"]) {
    const h = harness({ provider: "roon" }), player = bindRoonPlayer(h, selectedZoneId);
    player.render([{ zone_id: "idle-zone", state: "stopped" },
      { zone_id: "playing-zone", state: "playing", now_playing: { title: "Current track" } }]);
    assert.equal(player.state.selectedZoneId, "playing-zone"); assert.equal(h.get("zoneSelect").value, "playing-zone");
    assert.equal(h.get("nowTitle").textContent, "Current track"); assert.equal(h.requests.length, 0); assert.equal(h.releases.length, 0);
  }
});

test("real Roon removal of the selected zone still releases a live visualizer", async () => {
  const h = harness({ provider: "roon" }), player = bindRoonPlayer(h);
  const selected = { zone_id: "exact-zone", state: "playing", now_playing: { title: "Current track" } };
  player.render([selected]); await h.ready(roonStatus()); selectRoonAnalysis(h); await h.start(roonFeedStatus());
  player.render([{ zone_id: "other-zone", state: "playing", now_playing: { title: "Other output track" } }]);
  assert.equal(player.state.selectedZoneId, "other-zone"); assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
  assert.equal(h.get("roonVisualVideo").src, ""); assert.equal(h.get("roonVisualToggle").textContent, "Start visuals");
});

test("Roon uses separate saved choices without starting capture and filters its own music source", async () => {
  const h = harness({ provider: "roon" });
  await h.ready(roonStatus({ musicInputs: [hqplayerInput, ...musicInputs, { ...hqplayerInput, source: "other-source", id: "feed:unknown" }] }));
  assert.deepEqual(h.get("roonNativeInput").children.map(option => option.value), [...nativeGenerators.map(value => value.id), hqplayerInput.id]);
  assert.equal(h.get("roonNativeInput").value, "generator:fluid");
  assert.equal(h.get("roonNativeVisualizer").value, "whitecap");
  assert.equal(h.get("roonVisualToggle").textContent, "Start visuals");
  assert.equal(h.requests.length, 1); assert.equal(h.releases.length, 0);
  assert.equal(h.stage.querySelector(".playerViewControls").querySelector(".lyrionCenterViews").querySelectorAll("button")[0].getAttribute("aria-controls"), "cover");
  assert.equal(h.storage.has("lyrion.centerView"), false);
});

test("all three Roon visualizers retain Fluid, High Energy and Chill without microphones", async () => {
  for (const visualizer of ["aeon", "g-force", "whitecap"]) {
    const h = harness({ provider: "roon" }); await h.ready(roonStatus());
    h.get("roonNativeVisualizer").value = visualizer; h.get("roonNativeVisualizer").onchange();
    h.get("roonNativeInput").value = "generator:chill"; h.get("roonNativeInput").onchange();
    assert.equal(h.requests.length, 1);
    const start = await h.start(roonStatus({ state: "running", visualizer, inputId: "generator:chill", inputKind: "no-mic" }));
    assert.equal(h.body(start).visualizer, visualizer); assert.equal(h.body(start).inputId, "generator:chill");
    assert.equal(Object.hasOwn(h.body(start), "zoneId"), false); assert.equal(Object.hasOwn(h.body(start), "playerId"), false);
    assert.match(h.get("roonVisualStatus").textContent, /Sound generator · No microphone/);
  }
});

test("HQPlayer analysis requires the pinned connected zone and sends only its exact zoneId", async () => {
  const h = harness({ provider: "roon" }); await h.ready(roonStatus());
  selectRoonAnalysis(h);
  h.get("zoneSelect").value = "other-zone"; h.get("zoneSelect").dispatchEvent(uiEvent("change"));
  assert.equal(h.get("roonVisualToggle").disabled, true); assert.match(h.get("roonVisualReason").textContent, /HQPlayer Roon zone/);
  h.get("zoneSelect").value = "exact-zone"; h.stage.dataset.playbackConnected = "false"; h.stage.dispatchEvent(uiEvent("roon-playback"));
  assert.equal(h.get("roonVisualToggle").disabled, true);
  h.stage.dataset.playbackConnected = "true"; h.stage.dataset.playbackHqplayer = "true"; h.stage.dispatchEvent(uiEvent("roon-playback"));
  assert.equal(h.get("roonVisualToggle").disabled, false);
  assert.match(h.get("roonVisualHint").textContent, /live spectrum/); assert.doesNotMatch(h.get("roonVisualHint").textContent, /copy of decoded PCM/);
  const start = await h.start(roonFeedStatus());
  assert.equal(h.body(start).zoneId, "exact-zone"); assert.equal(Object.hasOwn(h.body(start), "playerId"), false);
  assert.equal(h.body(start).inputId, hqplayerInput.id); assert.match(h.get("roonVisualStatus").textContent, /HQPlayer analysis active · Experimental/);
  assert.equal(h.requests.some(request => /playback|\/hqp|stream\.mp3|roon\/control/.test(request.url)), false);
});

test("unavailable HQPlayer analysis explains its cause without falling back or auto starting", async () => {
  const h = harness({ provider: "roon" }), reason = "HQPlayer's spectrum monitor is unavailable.";
  await h.ready(roonStatus({ musicInputs: [{ ...hqplayerInput, available: false, reason }] })); selectRoonAnalysis(h);
  assert.equal(h.get("roonVisualToggle").disabled, true); assert.equal(h.get("roonVisualReason").textContent, reason);
  h.get("roonVisualToggle").click(); assert.equal(h.requests.length, 1);
  assert.equal(h.get("roonNativeInput").value, hqplayerInput.id);
});

test("a renamed but pinned Roon zone remains eligible for HQPlayer analysis", async () => {
  const h = harness({ provider: "roon" }); await h.ready(roonStatus());
  h.stage.dataset.playbackHqplayer = "false"; h.stage.dispatchEvent(uiEvent("roon-playback"));
  selectRoonAnalysis(h);
  assert.equal(h.get("roonVisualToggle").disabled, false);
  const start = await h.start(roonFeedStatus());
  assert.equal(h.body(start).zoneId, "exact-zone"); assert.equal(h.body(start).inputId, hqplayerInput.id);
});

test("Roon regular, maximized and fullscreen transitions preserve a started viewer and media", async () => {
  const h = harness({ provider: "roon", withMedia: true }); await h.ready(roonStatus()); selectRoonAnalysis(h); await h.start(roonFeedStatus());
  const original = { requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] };
  for (const mode of ["player--maximized", "player--fullscreen", "player--regular"]) {
    h.stage.classes.delete("player--regular"); h.stage.classes.delete("player--maximized"); h.stage.classes.delete("player--fullscreen");
    h.stage.classes.add(mode); h.mutate(h.stage);
    assert.equal(h.get("roonVisualToggle").textContent, "Stop visuals");
    assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] }, original);
  }
});

test("changing Roon zones stops both analysis and generator viewers and requires a fresh Start", async () => {
  for (const analysis of [false, true]) {
    const h = harness({ provider: "roon" }); await h.ready(roonStatus()); if (analysis) selectRoonAnalysis(h);
    await h.start(analysis ? roonFeedStatus() : roonStatus({ state: "running", visualizer: "whitecap" }));
    h.get("zoneSelect").value = "other-zone"; h.get("zoneSelect").dispatchEvent(uiEvent("change"));
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.get("roonVisualVideo").src, "");
    h.get("zoneSelect").value = "exact-zone"; h.stage.dispatchEvent(uiEvent("roon-playback"));
    assert.equal(h.get("roonVisualToggle").textContent, "Start visuals"); assert.equal(h.requests.length, 2);
  }
});

test("an automatic Roon zone change or disconnect cancels a pending analysis start", async () => {
  for (const update of [h => { h.get("zoneSelect").value = "other-zone"; }, h => { h.stage.dataset.playbackConnected = "false"; }]) {
    const h = harness({ provider: "roon" }); await h.ready(roonStatus()); selectRoonAnalysis(h); h.get("roonVisualToggle").click();
    update(h); h.stage.dispatchEvent(uiEvent("roon-playback")); await h.answer(1, roonFeedStatus());
    assert.equal(h.get("roonVisualVideo").src, ""); assert.equal(h.get("roonVisualToggle").textContent, "Start visuals");
    assert.deepEqual(await h.stoppedIds(), ["viewer-1", "viewer-1"]);
  }
});

test("provider, view and page exits release only the Roon viewer and never resume automatically", async () => {
  for (const exit of [h => { h.document.body.dataset.playbackSystem = "lyrion"; h.mutate(h.document.body); },
    h => { h.view.classes.delete("isActive"); h.mutate(h.view); },
    h => h.event("pagehide")]) {
    const h = harness({ provider: "roon" }); await h.ready(roonStatus()); selectRoonAnalysis(h); await h.start(roonFeedStatus()); exit(h);
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.get("roonVisualVideo").src, "");
    h.document.body.dataset.playbackSystem = "roon"; h.view.classes.add("isActive"); h.document.hidden = false; h.event("pageshow");
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

test("a shared source or zone mismatch releases the Roon viewer without adopting another feed", async () => {
  for (const changed of [{ inputId: "feed:pre-hqplayer", inputSource: "lyrion" }, { inputSource: "other-source" },
    { zoneId: "other-zone" }, { inputSource: undefined, zoneId: undefined, audioFeed: { source: "roon-hqplayer", zoneId: "other-zone" } }]) {
    const h = harness({ provider: "roon" }); await h.ready(roonStatus()); selectRoonAnalysis(h); await h.start(roonFeedStatus());
    await h.fire(4000); await h.answer(2, roonFeedStatus(changed));
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]); assert.equal(h.get("roonVisualVideo").src, "");
    assert.equal(h.get("roonNativeInput").value, hqplayerInput.id); assert.match(h.get("roonVisualReason").textContent, /another playback source/);
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});

test("Roon tap and keyboard fullscreen controls preserve the same decoded media and viewer", async () => {
  const h = harness({ provider: "roon", withMedia: true }); await h.ready(roonStatus()); selectRoonAnalysis(h); await h.start(roonFeedStatus());
  const initial = { requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] };
  const surface = h.get("roonVisualSurface"), expand = h.get("roonVisualExpand");
  await h.fire(3000); assert.equal(h.get("roonVisualOverlay").hidden, true);
  surface.dispatchEvent(uiEvent("keydown", { key: "Enter" })); assert.equal(h.document.activeElement, expand);
  expand.click(); assert.equal(h.stage.classList.contains("roonVisualFullscreen"), true);
  const tab = uiEvent("keydown", { key: "Tab" }); h.stage.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true); assert.equal(h.document.activeElement, expand);
  const escape = uiEvent("keydown", { key: "Escape" }); h.stage.dispatchEvent(escape);
  assert.equal(escape.immediatePropagationStopped, true); assert.equal(h.stage.classList.contains("roonVisualFullscreen"), false);
  assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] }, initial);
  surface.click(); expand.click(); h.get("roonVisualToggle").click();
  assert.equal(h.stage.classList.contains("roonVisualFullscreen"), false); assert.equal(h.get("roonVisualOverlay").hidden, true);
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
});

test("Roon pure visuals return to their prior regular or maximized geometry and preserve existing fullscreen", async () => {
  for (const prior of ["player--regular", "player--maximized", "player--fullscreen"]) {
    const h = harness({ provider: "roon", withMedia: true }); await h.ready(roonStatus()); await h.start(roonStatus({ state: "running" }));
    h.stage.classes.delete("player--regular"); h.stage.classes.add(prior);
    let nativeRequests = 0, nativeExits = 0;
    if (prior === "player--fullscreen") h.document.fullscreenElement = h.stage;
    h.stage.requestFullscreen = async () => {
      nativeRequests++; h.document.fullscreenElement = h.stage; h.stage.classes.delete(prior); h.stage.classes.add("player--fullscreen");
      h.document.dispatchEvent(uiEvent("fullscreenchange"));
    };
    h.document.exitFullscreen = async () => {
      nativeExits++; h.document.fullscreenElement = null; h.stage.classes.delete("player--fullscreen"); h.stage.classes.add(prior);
      h.document.dispatchEvent(uiEvent("fullscreenchange"));
    };
    const original = { requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] };
    h.get("roonVisualSurface").click(); h.get("roonVisualExpand").click(); await flush();
    assert.equal(h.stage.classList.contains("roonVisualFullscreen"), true);
    h.get("roonVisualExpand").click(); await flush();
    assert.equal(h.stage.classList.contains("roonVisualFullscreen"), false); assert.equal(h.stage.classList.contains(prior), true);
    assert.equal(nativeRequests, prior === "player--fullscreen" ? 0 : 1); assert.equal(nativeExits, prior === "player--fullscreen" ? 0 : 1);
    assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] }, original);
  }
});

test("late Roon native fullscreen entry is undone after Return or Stop without resurrecting pure mode", async () => {
  for (const stop of [false, true]) {
    const h = harness({ provider: "roon", withMedia: true }); await h.ready(roonStatus()); await h.start(roonStatus({ state: "running" }));
    const pending = deferred(); let nativeExits = 0;
    h.stage.requestFullscreen = () => pending.promise;
    h.document.exitFullscreen = async () => { nativeExits++; h.document.fullscreenElement = null; h.document.dispatchEvent(uiEvent("fullscreenchange")); };
    h.get("roonVisualSurface").click(); h.get("roonVisualExpand").click();
    h.get(stop ? "roonVisualToggle" : "roonVisualExpand").click();
    h.document.fullscreenElement = h.stage; h.document.dispatchEvent(uiEvent("fullscreenchange")); pending.resolve(); await flush();
    assert.equal(nativeExits, 1); assert.equal(h.document.fullscreenElement, null); assert.equal(h.stage.classList.contains("roonVisualFullscreen"), false);
    assert.deepEqual(await h.stoppedIds(), stop ? ["viewer-1"] : []);
    assert.equal(h.get("roonVisualToggle").textContent, stop ? "Start visuals" : "Stop visuals");
  }
});

test("a browser native fullscreen exit also restores the Roon player without releasing its stream", async () => {
  const h = harness({ provider: "roon", withMedia: true }); await h.ready(roonStatus()); await h.start(roonStatus({ state: "running" }));
  h.stage.requestFullscreen = async () => { h.document.fullscreenElement = h.stage; h.document.dispatchEvent(uiEvent("fullscreenchange")); };
  h.get("roonVisualSurface").click(); h.get("roonVisualExpand").click(); await flush();
  const original = { requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] };
  h.document.fullscreenElement = null; h.document.dispatchEvent(uiEvent("fullscreenchange"));
  assert.equal(h.stage.classList.contains("roonVisualFullscreen"), false);
  assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] }, original);
});

test("Roon pure mode clears pre-existing full-window scroll and restores it on Return without another fullscreen request", async () => {
  for (const priorScroll of [0, 13.09]) {
    const h = harness({ provider: "roon", withMedia: true }); await h.ready(roonStatus()); await h.start(roonStatus({ state: "running" }));
    const lane = h.stage.querySelector(".artStack"), surface = h.get("roonVisualSurface");
    h.document.fullscreenElement = h.stage;
    let nativeRequests = 0; h.stage.requestFullscreen = () => { nativeRequests++; };
    const original = { requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] };
    surface.click(); h.stage.scrollTop = priorScroll; lane.scrollTop = 27;
    // Some fullscreen browsers scroll the focused surface after its layout changes.
    surface.focus = () => { h.document.activeElement = surface; h.stage.scrollTop = priorScroll + 13.09; lane.scrollTop = 39; };
    h.get("roonVisualExpand").click();
    assert.equal(h.stage.scrollTop, 0); assert.equal(lane.scrollTop, 0); assert.equal(nativeRequests, 0);
    h.get("roonVisualExpand").click();
    assert.equal(h.stage.scrollTop, priorScroll); assert.equal(lane.scrollTop, 27); assert.equal(h.document.fullscreenElement, h.stage);
    assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] }, original);
  }
});

test("recurring Roon heartbeats keep the real service lease alive across mode changes and in-flight status renders", async t => {
  const h = harness({ provider: "roon", withMedia: true, viewerPrefix: "viewer_recurring_12345678901234567890_" });
  await h.ready(roonStatus()); selectRoonAnalysis(h); const start = await h.start(roonFeedStatus());
  let now = 1000;
  const service = new SoundSpectrum({ native: { stop: async () => {} }, capture: {}, sweepMs: 0, clock: () => now,
    audioFeed: { snapshot: () => ({ state: "receiving", source: "roon-hqplayer", zoneId: "exact-zone" }), stop: async () => {} } });
  t.after(() => service.close());
  service.state = "running"; service.visualizer = "whitecap"; service.inputId = hqplayerInput.id;
  service.inputKind = "music-feed"; service.inputSource = "roon-hqplayer"; service.zoneId = "exact-zone";
  const inventory = roonStatus();
  service.inventory = { visualizers: inventory.visualizers, inputs: inventory.inputs, noMicInputs: inventory.noMicInputs,
    musicInputs: inventory.musicInputs, captureAvailable: true };
  const viewerId = h.body(start).viewerId;
  service.leases.set(viewerId, now + service.leaseMs);
  service.leases.set("viewer_other_12345678901234567890", now + 1_000_000);
  const originalMedia = [...h.mediaCalls];
  for (let cycle = 0; cycle < 16; cycle++) {
    now += 4000; service.frameAt = now; service.sweep();
    assert.equal(service.snapshot(viewerId).viewerActive, true, "lease remains valid before its next renewal");
    await h.fire(4000);
    const pending = h.requests.length - 1;
    assert.equal(h.body(pending).action, "heartbeat"); assert.equal(h.body(pending).viewerId, viewerId);
    // These are real recurring status/mode callbacks while the HTTP heartbeat is in flight.
    h.stage.classes.delete("player--regular"); h.stage.classes.delete("player--maximized"); h.stage.classes.delete("player--fullscreen");
    h.stage.classes.add(["player--regular", "player--maximized", "player--fullscreen"][cycle % 3]);
    h.mutate(h.stage); h.stage.dispatchEvent(uiEvent("roon-playback"));
    assert.equal(h.requests.length, pending + 1, "layout/status callbacks cannot issue another request");
    await h.answer(pending, await service.session(h.body(pending)));
    assert.equal(service.snapshot(viewerId).viewerActive, true); assert.equal(h.get("roonVisualToggle").textContent, "Stop visuals");
    assert.deepEqual(await h.stoppedIds(), []); assert.deepEqual(h.mediaCalls, originalMedia);
  }
  assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);

  // A browser that misses the actual 12s deadline must report that lease loss,
  // while the other viewer remains attached; it must never start implicitly.
  now += service.leaseMs + 1; service.frameAt = now; service.sweep(); await h.fire(4000);
  const expired = h.requests.length - 1;
  let rejection;
  try { await service.session(h.body(expired)); } catch (error) { rejection = error; }
  assert.equal(rejection.statusCode, 409);
  await h.answer(expired, { ...service.snapshot(viewerId), error: rejection.message }, false);
  assert.match(h.get("roonVisualReason").textContent, /Visuals stopped\. Select Start visuals to reconnect/);
  assert.equal(h.get("roonVisualToggle").textContent, "Start visuals"); assert.equal(service.snapshot().clients, 1);
  assert.deepEqual(await h.stoppedIds(), [viewerId]);
  assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
});

test("Refresh inputs rejects obsolete heartbeat completions without releasing or replacing the active Roon stream", async () => {
  for (const late of ["abort", "success"]) {
    const h = harness({ provider: "roon", withMedia: true }); await h.ready(roonStatus()); selectRoonAnalysis(h); await h.start(roonFeedStatus());
    const initialMedia = [...h.mediaCalls]; await h.fire(4000);
    const heartbeat = h.requests.length - 1;
    assert.equal(h.body(heartbeat).action, "heartbeat");
    h.get("roonVisualRefresh").click();
    const refresh = h.requests.length - 1;
    assert.match(h.requests[refresh].url, /\/status\?refresh=1&viewerId=viewer-1$/);
    assert.equal(h.requests[heartbeat].options.signal.aborted, true);
    if (late === "abort") {
      h.requests[heartbeat].reject(Object.assign(Error("Superseded heartbeat"), { name: "AbortError" })); await flush();
    } else await h.answer(heartbeat, roonFeedStatus({ viewerActive: false, visualizer: "aeon" }));
    assert.equal(h.get("roonVisualToggle").textContent, "Stop visuals");
    assert.deepEqual(await h.stoppedIds(), []); assert.deepEqual(h.mediaCalls, initialMedia);
    await h.answer(refresh, roonFeedStatus());
    await h.fire(4000);
    const next = h.requests.length - 1;
    assert.equal(h.body(next).action, "heartbeat"); assert.equal(h.body(next).viewerId, "viewer-1");
    await h.answer(next, roonFeedStatus());
    assert.equal(h.get("roonNativeVisualizer").value, "whitecap"); assert.equal(h.get("roonVisualToggle").textContent, "Stop visuals");
    assert.deepEqual(await h.stoppedIds(), []); assert.deepEqual(h.mediaCalls, initialMedia);
    assert.equal(h.requests.filter(request => request.options?.body && JSON.parse(request.options.body).action === "start").length, 1);
  }
});


test("HLS buffer rejection and fill timeout explain how to recover without changing delay", async () => {
  for (const [reason, message] of [["buffer-limit", /browser could not hold/], ["buffer-fill-timeout", /buffer did not fill in time/]]) {
    const h = harness({ withHls: true, savedTransport: "hls", withDelay: true });
    await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" })); h.hlsError(reason);
    assert.match(h.get("lyrionVisualReason").textContent, message);
    assert.equal(h.get("lyrionVisualToggle").textContent, "Start visuals");
    assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
    assert.equal(h.requests.some(x => x.url === "/api/soundspectrum/delay"), false);
  }
});


test("HLS stop reports the fill failure and last sample with a clear status heading", async () => {
  const h = harness({ withHls: true, savedTransport: "hls" });
  await h.ready(hlsStatus()); await h.start(hlsStatus({ state: "running" }));
  h.hlsError("buffer-fill-timeout", { transport: "hls", hlsRequestedMB: 250, hlsBufferSeconds: 1.4,
    hlsReserveSeconds: 250 * 8 / 600, hlsMaxBufferSeconds: 2, hlsPaused: true, hlsBufferState: "filling", hlsLastError: "quota", privateUrl: "SECRET" });
  const body = JSON.parse(await h.releases.at(-1).body.text());
  assert.equal(body.reason, "hls-buffer-timeout"); assert.equal(body.videoStats.hlsRequestedMB, 250);
  assert.equal(body.videoStats.hlsBufferSeconds, 1.4); assert.equal(body.videoStats.hlsPaused, true);
  assert.equal(body.videoStats.hlsLastError, "quota"); assert.doesNotMatch(JSON.stringify(body), /SECRET/);
  assert.equal(h.get("lyrionVisualStatus").textContent, "Playback buffer could not fill");
});

test("fullscreen with controls reuses the surface and stream, keeps settings and keyboard controls accessible, and restores its lane", async () => {
  for (const provider of ["roon", "lyrion"]) {
    const h = harness({ provider, withMedia: true }); await h.ready(); await h.start();
    const p = provider, button = h.get(p + "VisualControlsExpand"), surface = h.get(p + "VisualSurface"), panel = h.get(p + "VisualPanel");
    const initial = { requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] };
    button.click(); h.mutate(h.stage);
    assert.equal(h.stage.classList.contains("soundSpectrumStage--controlsFullscreen"), true);
    assert.equal(surface.parentNode, h.stage); assert.equal(h.mediaPresentation(), "player-fullscreen");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(h.get(p + "VisualSettings").hidden, false);
    const tab = uiEvent("keydown", { key: "Tab" }); h.stage.dispatchEvent(tab); assert.equal(tab.defaultPrevented, false);
    button.click(); h.mutate(h.stage);
    assert.equal(surface.parentNode, panel); assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(h.stage.classList.contains("soundSpectrumStage--controlsFullscreen"), false);
    assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] }, initial);
    button.click(); h.get(p + "VisualExpand").click();
    assert.equal(h.stage.classList.contains("soundSpectrumStage--controlsFullscreen"), false);
    assert.equal(h.mediaPresentation(), "visualizer-fullscreen"); assert.equal(surface.parentNode, panel);
    h.get(p + "VisualExpand").click();
    assert.deepEqual({ requests: h.requests.length, releases: h.releases.length, media: [...h.mediaCalls] }, initial);
  }
});

test("controls fullscreen cancellation and delayed native entry cannot leave the video behind controls after Stop", async () => {
  const h = harness({ provider: "roon", withMedia: true }); await h.ready(); await h.start();
  const pending = deferred(); let exits = 0;
  h.stage.requestFullscreen = () => pending.promise;
  h.document.exitFullscreen = async () => { exits++; h.document.fullscreenElement = null; h.document.dispatchEvent(uiEvent("fullscreenchange")); };
  h.get("roonVisualControlsExpand").click(); h.get("roonVisualToggle").click();
  h.document.fullscreenElement = h.stage; h.document.dispatchEvent(uiEvent("fullscreenchange")); pending.resolve(); await flush();
  assert.equal(exits, 1); assert.equal(h.stage.classList.contains("soundSpectrumStage--controlsFullscreen"), false);
  assert.equal(h.get("roonVisualSurface").parentNode, h.get("roonVisualPanel"));
  assert.deepEqual(await h.stoppedIds(), ["viewer-1"]);
});

test("exiting an already-fullscreen player clears controls mode even when the visualizer did not own native entry", async () => {
  const h = harness({ provider: "roon", withMedia: true }); await h.ready(); await h.start();
  h.document.fullscreenElement = h.stage;
  h.get("roonVisualControlsExpand").click();
  h.document.fullscreenElement = null; h.document.dispatchEvent(uiEvent("fullscreenchange"));
  assert.equal(h.stage.classList.contains("soundSpectrumStage--controlsFullscreen"), false);
  assert.equal(h.get("roonVisualSurface").parentNode, h.get("roonVisualPanel"));
  assert.equal(h.releases.length, 0);
});

test('both players explicitly request 120 fps and preserve the separate HLS 60 fps default',async()=>{
 for(const provider of ['roon','lyrion']) {
  const h=harness({provider,withWc:true,withHls:true,savedTransport:'webcodecs'});
  const snapshot=noMicStatus({transports:[{id:'hls',available:true}]});await h.ready(snapshot);
  assert.equal(h.get(h.prefix+'WcFps').value,'60');
  h.get(h.prefix+'WcFps').value='120';h.get(h.prefix+'WcFps').onchange();
  const i=await h.start({...snapshot,state:'running',transport:'hls',generation:3,videoStats:{targetFps:120,configuredBitrateMbps:60}});
  assert.equal(h.body(i).targetFps,120);assert.ok(h.wcCalls.some(c=>c.fps===120));
  assert.equal(h.get(h.prefix+'WcFps').disabled,true);assert.equal(h.storage.get('soundSpectrum.webcodecsFps'),'120');
  h.stageApi.stop();
 }
});
