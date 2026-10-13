"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../public/remoteMatrixClock.js"), "utf8");
const preferences = fs.readFileSync(require.resolve("../public/remoteClockStyle.js"), "utf8");

// Exercise the browser scheduler with deterministic clocks; no player or network mocks.
function fixture({ saved = "seven", reduced = false, cost = .2, noCanvas = false } = {}) {
  let id = 0, now = 0, created = 0, composites = [], observer, mutation, resize;
  const timers = new Map(), rafs = new Map(), storage = new Map([["rabbitRemoteClockStyle", saved]]);
  function target(extra = {}) { return Object.assign({ listeners: {}, addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn); }, fire(n, event = {}) { this.listeners[n]?.forEach(fn => fn(event)); } }, extra); }
  function context() { return { setTransform() {}, clearRect() {}, save() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {}, restore() {},
    drawImage() {}, strokeText() {}, fillText() {}, measureText: t => ({ width: t.length * 13 }),
    set globalCompositeOperation(value) { composites.push(value); }
  }; }
  function element(y, width = 357, height = 44) { return target({ textContent: "", dataset: {}, style: {}, hidden: false, classList: { toggle() {}, remove() {} },
    getBoundingClientRect: () => ({ left: 0, top: y, width, height }), getAttribute: () => "23:59", getContext: () => noCanvas ? null : context() }); }
  const host = element(0), canvas = element(0), select = element(0), clock = element(0, 190, 76), date = element(84), weather = element(130);
  canvas.parentElement = host; canvas.hidden = true; date.textContent = "Sun 11 Oct"; weather.textContent = "62°F · Partly cloudy";
  const nodes = { remoteMatrixClock: canvas, remoteClockStyle: select, remoteClock: clock, remoteDate: date, remoteWeatherSummary: weather };
  const doc = target({ hidden: false, getElementById: id => nodes[id], createElement() { created++; return element(0); } });
  const win = target(), media = target({ matches: reduced });
  const scope = vm.createContext({ document: doc, window: win, devicePixelRatio: 3, matchMedia: () => media,
    performance: { now: () => { now += cost; return now; } },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    setTimeout(fn, ms) { const key = ++id; timers.set(key, {fn, ms}); return key; }, clearTimeout: key => timers.delete(key),
    requestAnimationFrame(fn) { const key = ++id; rafs.set(key, fn); return key; }, cancelAnimationFrame: key => rafs.delete(key),
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} },
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} },
    IntersectionObserver: class { constructor(fn) { observer = fn; } observe() {} }
  });
  vm.runInContext(preferences, scope); vm.runInContext(source, scope);
  function flushRaf() { const pending = [...rafs.values()]; rafs.clear(); pending.forEach(fn => fn(now)); }
  function frame() { for (const [key, value] of [...timers]) { timers.delete(key); now += value.ms; value.fn(); } flushRaf(); }
  return { doc, win, media, canvas, select, timers, rafs, composites, storage, flushRaf, frame,
    choose(value) { win.rabbitRemoteClockStyle.set(value); flushRaf(); },
    intersect(value) { observer([{ isIntersecting: value }]); },
    mutate() { mutation(); }, resize() { resize(); }, created: () => created,
    stats: () => JSON.parse(canvas.dataset.matrixStats) };
}
test("seven-segment stays the initial fallback and allocates no rain textures or animation work", () => {
  const f = fixture(); assert.equal(f.canvas.hidden, true); assert.equal(f.timers.size + f.rafs.size, 0); assert.equal(f.created(), 1);
});
test("Matrix dims only outside the text, caps canvas pixels/FPS, and reuses textures across frames", () => {
  const f = fixture(); f.choose("matrix");
  assert.equal(f.canvas.hidden, false); assert.equal(f.canvas.width, Math.ceil(190 * 1.25));
  assert.equal(f.composites.at(-1), "destination-out");
  assert.deepEqual(f.composites.slice(0, 2), ["source-out", "source-over"], "invert text to preserve bright code inside");
  assert.ok(!f.composites.includes("destination-over"), "no opaque backing plate");
  assert.ok([...f.timers.values()].every(t => t.ms >= 1000 / 30));
  const count = f.created(); for (let i = 0; i < 120; i++) f.frame();
  assert.equal(f.created(), count, "no per-frame DOM/canvas creation");
  assert.equal(f.stats().mode, "animated");
  f.choose("seven"); assert.equal(f.timers.size + f.rafs.size, 0); assert.equal(f.canvas.hidden, true);
});
test("hidden/offscreen/pagehide stop all frame work and return resumes", () => {
  const f = fixture({ saved: "matrix" }); f.flushRaf();
  f.doc.hidden = true; f.doc.fire("visibilitychange"); assert.equal(f.timers.size + f.rafs.size, 0);
  f.mutate(); assert.equal(f.rafs.size, 0);
  f.doc.hidden = false; f.doc.fire("visibilitychange"); f.flushRaf(); assert.equal(f.timers.size, 1);
  f.intersect(false); assert.equal(f.timers.size + f.rafs.size, 0); assert.equal(f.stats().mode, "paused");
  f.intersect(true); assert.equal(f.timers.size, 1);
  f.win.fire("pagehide"); assert.equal(f.timers.size + f.rafs.size, 0);
  f.win.fire("pageshow"); f.flushRaf(); assert.equal(f.timers.size, 1);
});
test("reduced motion keeps static code lettering and still refreshes changed time/weather", () => {
  const f = fixture({ saved: "matrix", reduced: true }); f.flushRaf();
  assert.equal(f.timers.size + f.rafs.size, 0); const before = f.composites.length;
  f.mutate(); f.mutate(); assert.equal(f.rafs.size, 1); f.flushRaf();
  assert.ok(f.composites.length > before); assert.equal(f.timers.size + f.rafs.size, 0);
  f.media.matches = false; f.media.fire("change"); assert.equal(f.timers.size, 1);
});
test("persistently slow painting stops decoration without touching another subsystem", () => {
  const f = fixture({ saved: "matrix", cost: 6 }); f.flushRaf();
  for (let i = 0; i < 12; i++) f.frame();
  assert.equal(f.stats().mode, "static"); assert.equal(f.timers.size + f.rafs.size, 0);
});
test("unavailable canvas keeps readable original clock without animation work", () => {
  const f = fixture({ noCanvas: true, saved: "matrix" }); assert.equal(f.canvas.hidden, true); assert.equal(f.timers.size + f.rafs.size, 0);
});

test("saved settings survive reload and a second tab's changes apply without a remote selector", () => {
  const f = fixture(); f.choose("matrix");
  assert.equal(f.storage.get("rabbitRemoteClockStyle"), "matrix");
  const reloaded = fixture({ saved: f.storage.get("rabbitRemoteClockStyle") }); reloaded.flushRaf();
  assert.equal(reloaded.canvas.hidden, false);
  f.storage.set("rabbitRemoteClockStyle", "seven"); f.win.fire("storage", { key: "rabbitRemoteClockStyle" });
  assert.equal(f.canvas.hidden, true); assert.equal(f.timers.size + f.rafs.size, 0);
  f.storage.set("rabbitRemoteClockStyle", "matrix"); f.doc.fire("visibilitychange"); f.flushRaf();
  assert.equal(f.canvas.hidden, false);
});
