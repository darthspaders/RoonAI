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
function harness({ withMedia = false, provider = "lyrion", viewerPrefix = "viewer-" } = {}) {
  const prefix = provider === "roon" ? "roon" : "lyrion";
  const nodes = new Map(), observers = [], timers = new Map(), requests = [], releases = [], windowEvents = new Map(), mediaCalls = [];
  let timerId = 0, viewerNumber = 0, setMediaReady;
  class Node {
    constructor(tag = "div") {
      this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.events = new Map(); this.hidden = false; this.disabled = false; this.value = ""; this.textContent = ""; this.classes = new Set();
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
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === "id") { this.id = value; nodes.set(value, this); }
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; if (name === "src") this.src = ""; }
    set innerHTML(html) {
      this.children = [];
      for (const match of html.matchAll(/<([a-z]+)\b([^>]*)>/gi)) {
        const child = new Node(match[1]);
        for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(attribute[1], attribute[2]);
        child.hidden = /\bhidden\b/.test(match[2]); child.disabled = /\bdisabled\b/.test(match[2]); this.children.push(child);
      }
    }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return descendants;
      if (selector === "button") return descendants.filter(child => child.tag === "button");
      return [];
    }
    querySelector(selector) { if (selector.startsWith("#")) return nodes.get(selector.slice(1)); return this.children.find(child => child.className === selector.slice(1)); }
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
    before(child) { bar.children.unshift(child); }
    prepend(child) { this.children.unshift(child); }
    replaceChildren(...children) { this.children = children; }
    closest() { return tabPanel; }
    getClientRects() { return view.hidden || tabPanel.hidden || (provider === "roon" && !view.classList.contains("isActive")) ? [] : [{}]; }
  }
  const get = id => { if (!nodes.has(id)) { const node = new Node(); node.setAttribute("id", id); } return nodes.get(id); };
  const stage = get(prefix + "Now"), view = get(provider === "roon" ? "playerView" : "lyrionView"), tabPanel = get("lyrionTabPanel"), bar = new Node(), lane = new Node();
  stage.classes.add(provider === "roon" ? "player--regular" : "lyrionNow--fullscreen");
  bar.className = provider === "roon" ? "playerViewControls" : "lyrionStageBar";
  lane.className = provider === "roon" ? "artStack" : "lyrionArtworkLane";
  stage.children = [bar, lane]; bar.children = [get("lyrionFullscreen")];
  if (provider === "roon") {
    view.classList.add("isActive"); stage.dataset.playbackConnected = "true"; stage.dataset.playbackHqplayer = "true";
    get("zoneSelect").value = "exact-zone";
  }
  const document = new Node(); document.hidden = false; document.activeElement = null; document.getElementById = get; document.createElement = tag => new Node(tag);
  document.querySelector = selector => selector === "#playerView .player" && provider === "roon" ? stage : null;
  document.body = new Node(); document.body.dataset.playbackSystem = provider;
  const storage = new Map([[prefix + ".centerView", "visualizer"], [prefix + ".soundSpectrum", "whitecap"]]);
  const context = { document, navigator: { sendBeacon: (url, body) => { releases.push({ url, body }); return true; } },
    crypto: { randomUUID: () => viewerPrefix + ++viewerNumber }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    location: { search: "" }, URLSearchParams, AbortController, Blob,
    Option: function(label, value) { const option = new Node("option"); option.label = label; option.value = value; return option; },
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe(target) { observers.push({ target, callback: this.callback }); } },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: (url, options) => { const request = deferred(); requests.push({ ...request, url, options }); return request.promise; },
    addEventListener: (name, handler) => { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(handler); } };
  if (withMedia) context.createSoundSpectrumVideo = ({ onReady }) => {
    let ready = false;
    setMediaReady = value => { ready = value; onReady(value); };
    return { ready: () => ready,
      start(...args) { mediaCalls.push({ action: "start", args }); ready = true; onReady(true); },
      stop() { mediaCalls.push({ action: "stop" }); ready = false; onReady(false); } };
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/soundSpectrumStage.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/" + provider + "Visualizer.js"), "utf8"), context);
  return { get, prefix, stage, view, tabPanel, document, storage, requests, releases, timers, mediaCalls,
    mediaReady: value => setMediaReady?.(value),
    body: index => JSON.parse(requests[index].options.body),
    async answer(index, data, ok = true) { requests[index].resolve({ ok, json: async () => data }); await flush(); },
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

test("hiding, exiting fullscreen, changing center view, or pagehide releases the viewer without auto restart", async () => {
  for (const exit of [h => { h.document.hidden = true; h.document.dispatchEvent({ type: "visibilitychange" }); },
    h => { h.stage.classes.delete("lyrionNow--fullscreen"); h.mutate(h.stage); },
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
    h => { h.document.hidden = true; h.document.dispatchEvent(uiEvent("visibilitychange")); },
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
    h => { h.document.hidden = true; h.document.dispatchEvent(uiEvent("visibilitychange")); }]) {
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
