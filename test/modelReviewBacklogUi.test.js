"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/modelReviewBacklog.js"), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const status = overrides => ({ state: "pending", paused: false, running: false, modelReady: true,
  counts: { pending: 2, failed: 0, completed: 0, total: 2 }, pendingCount: 2,
  failedCount: 0, completedCount: 0, model: { provider: "ollama", model: "test-model" },
  recentResults: [], accuracyEligible: false, ...overrides });

function harness({ active = true, hidden = false, bootstrap = false, loading = false, awaitingApi = false } = {}) {
  const requests = [], timers = new Map(), observers = [], windowEvents = new Map();
  let now = 0, nextTimer = 0;
  class Element {
    constructor(tag, ownerDocument) {
      this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument;
      this.children = []; this.parentElement = null; this.events = new Map();
      this.style = {}; this.dataset = {}; this.attributes = new Map();
      this.hidden = false; this.disabled = false; this.isConnected = true;
      this._text = ""; this.className = "";
      this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(" "); }
    set innerHTML(_) { throw Error("Unexpected HTML injection"); }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this._text = ""; this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; } }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, handler) { const list = this.events.get(type) || new Set(); list.add(handler); this.events.set(type, list); }
    removeEventListener(type, handler) { this.events.get(type)?.delete(handler); }
    dispatch(type, target = this) { for (const handler of [...(this.events.get(type) || [])]) handler({ type, target }); }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === ".view" && node.classList.contains("view")) return node;
        if (selector === "[data-backlog-action]" && node.dataset.backlogAction) return node;
      }
      return null;
    }
    getClientRects() {
      for (let node = this; node; node = node.parentElement) if (node.hidden || (node.classList.contains("view") && !node.classList.contains("isActive"))) return [];
      return [{}];
    }
  }
  const document = { hidden, events: new Map(), createElement(tag) { return new Element(tag, document); },
    addEventListener(type, handler) { const list = this.events.get(type) || new Set(); list.add(handler); this.events.set(type, list); },
    removeEventListener(type, handler) { this.events.get(type)?.delete(handler); },
    dispatch(type) { for (const handler of [...(this.events.get(type) || [])]) handler(); } };
  const view = document.createElement("section"); view.className = `view${active ? " isActive" : ""}`;
  const root = document.createElement("section"); root.id = "modelReviewBacklog"; root.className = "panel historyPanel"; view.append(root);
  if (awaitingApi) { root.hidden = true; root.setAttribute("data-await-backlog-api", ""); }
  if (bootstrap) {
    document.readyState = loading ? "loading" : "complete";
    document.getElementById = id => id === root.id ? root : null;
  }
  const context = { document, AbortController, Date, WeakMap, navigator: { onLine: true },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; this.closed = false; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.closed = true; }
    },
    addEventListener(type, handler) { const list = windowEvents.get(type) || new Set(); list.add(handler); windowEvents.set(type, list); },
    removeEventListener(type, handler) { windowEvents.get(type)?.delete(handler); },
    fetch(url, options) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ url, options, resolve, reject });
      return promise;
    }
  };
  context.window = context;
  vm.runInNewContext(source, context);
  const bootedChildren = root.children.length;
  const api = bootstrap && loading ? null : context.ModelReviewBacklogUi.mount(root);
  const nodes = (tag, parent = root) => parent.children.flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...nodes(tag, child) ]);
  const button = action => nodes("BUTTON").find(node => node.dataset.backlogAction === action);
  const click = action => button(action).parentElement.dispatch("click", button(action));
  const mutate = () => { for (const observer of observers) if (!observer.closed) observer.callback(); };
  return { api, context, document, root, view, requests, timers, observers, nodes, button, click, bootedChildren,
    polls: () => [...timers.values()].filter(timer => timer.delay === 45000),
    async answer(index, body = status(), ok = true) { requests[index].resolve({ ok, status: ok ? 200 : 503, json: async () => body }); await flush(); },
    async fail(index, error = Error("Connection unavailable")) { requests[index].reject(error); await flush(); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
      await flush();
    },
    async visible(value) { view.className = `view${value ? " isActive" : ""}`; mutate(); await flush(); },
    async hidden(value) { document.hidden = value; document.dispatch("visibilitychange"); await flush(); },
    async page(type) { for (const handler of [...(windowEvents.get(type) || [])]) handler(); await flush(); }
  };
}

test("mount and repeated renders are read-only and idempotent with one GET, timer and listener set", async () => {
  const h = harness();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/model-review/backlog");
  assert.equal(h.requests[0].options.method, "GET");
  const button = h.button("review");
  assert.equal(h.context.ModelReviewBacklogUi.mount(h.root), h.api);
  assert.equal(h.context.ModelReviewBacklogUi.mount(h.root), h.api);
  assert.equal(h.root.children.length, 1);
  assert.equal(h.requests.length, 1);
  await h.answer(0);
  assert.equal(h.polls().length, 1);
  h.context.ModelReviewBacklogUi.mount(h.root);
  assert.equal(h.polls().length, 1);
  assert.equal(h.button("review"), button, "poll rendering retains focused native controls");
  assert.equal(h.document.events.get("visibilitychange").size, 1);
  assert.equal(h.observers.filter(item => !item.closed).length, 1);
  assert.equal(h.requests.filter(item => item.options.method === "POST").length, 0);
  for (const control of h.nodes("BUTTON")) { assert.equal(control.type, "button"); assert.equal(control.style.minHeight, "44px"); }
});

test("repeated Review clicks make one explicit POST and cannot overlap a status GET", async () => {
  const h = harness(); await h.answer(0);
  h.click("review"); h.click("review"); h.api.refresh(); await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, "/api/model-review/backlog/review");
  assert.equal(h.requests[1].options.method, "POST");
  assert.equal(h.requests[1].options.body, "{}");
  assert.equal(h.button("review").disabled, true);
  assert.equal(h.button("pause").disabled, true);
  await h.answer(1, status({ state: "running", running: true }));
  assert.match(h.root.textContent, /Reviewing backlog/);
  assert.equal(h.button("review").disabled, true);
  assert.equal(h.button("pause").disabled, false);
  assert.equal(h.polls().length, 1);
});

test("Pause is explicit, remains paused through status polls, and resumes only after Review", async () => {
  const h = harness(); await h.answer(0);
  h.click("pause"); h.click("pause"); await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, "/api/model-review/backlog/pause");
  await h.answer(1, status({ state: "paused", paused: true }));
  assert.match(h.root.textContent, /Paused\. Select Review backlog to resume/);
  assert.equal(h.button("review").disabled, false);
  assert.equal(h.button("pause").disabled, true);
  await h.advance(45000);
  assert.equal(h.requests[2].options.method, "GET");
  await h.answer(2, status({ state: "paused", paused: true }));
  assert.equal(h.requests.filter(item => item.options.method === "POST").length, 1);
  h.click("review"); await flush();
  assert.equal(h.requests[3].url, "/api/model-review/backlog/review");
});

test("polling is bounded and stops for hidden Taste or document, then reads once on return", async () => {
  const h = harness({ active: false });
  assert.equal(h.requests.length, 0);
  assert.equal(h.polls().length, 0);
  await h.visible(true); assert.equal(h.requests.length, 1); await h.answer(0);
  await h.visible(false); assert.equal(h.polls().length, 0);
  await h.advance(90000); assert.equal(h.requests.length, 1);
  await h.visible(true); assert.equal(h.requests.length, 2); await h.answer(1);
  await h.hidden(true); assert.equal(h.polls().length, 0);
  await h.advance(90000); assert.equal(h.requests.length, 2);
  await h.hidden(false); assert.equal(h.requests.length, 3); await h.answer(2);
  await h.advance(44999); assert.equal(h.requests.length, 3);
  await h.advance(1); assert.equal(h.requests.length, 4);
  assert.ok(h.requests.every(item => item.options.method === "GET"));
});

test("hidden reads abort and late responses cannot replace the newer visible snapshot", async () => {
  const h = harness(); await h.hidden(true);
  assert.equal(h.requests[0].options.signal.aborted, true);
  await h.hidden(false); assert.equal(h.requests.length, 2);
  await h.answer(1, status({ state: "paused", paused: true }));
  await h.answer(0, status({ state: "running", running: true }));
  assert.match(h.root.textContent, /Paused\. Select Review backlog/);
  assert.doesNotMatch(h.root.textContent, /Reviewing backlog/);
  assert.equal(h.polls().length, 1);
});

test("unavailable and offline status errors recover with a read-only refresh", async () => {
  const h = harness(); await h.answer(0, { error: "Model review service unavailable" }, false);
  assert.match(h.root.textContent, /Model review service unavailable/);
  assert.equal(h.button("refresh").disabled, false);
  h.click("refresh"); await h.answer(1, status({ state: "waiting_model", modelReady: false }));
  assert.match(h.root.textContent, /Waiting for your model to be ready/);
  assert.match(h.root.textContent, /will not be loaded automatically/);
  h.context.navigator.onLine = false;
  h.click("refresh"); await h.fail(2);
  assert.match(h.root.textContent, /Offline\. Reconnect and refresh status/);
  h.context.navigator.onLine = true;
  h.click("refresh"); await h.answer(3, status({ state: "foreground_busy" }));
  assert.match(h.root.textContent, /Waiting for the current model request/);
  assert.ok(h.requests.every(item => item.options.method === "GET"));
});

test("timeout and failed Pause preserve status and allow recovery without implicit retry", async () => {
  const h = harness(); await h.answer(0);
  h.click("pause"); await h.advance(10000);
  assert.equal(h.requests[1].options.signal.aborted, true);
  assert.match(h.root.textContent, /Request timed out\. Refresh status before trying again/);
  assert.equal(h.button("pause").disabled, false);
  assert.equal(h.requests.length, 2);
  h.click("refresh"); await h.answer(2, status({ state: "paused", paused: true }));
  await h.answer(1, status({ state: "running", running: true }));
  assert.match(h.root.textContent, /Paused\. Select Review backlog/);
  assert.equal(h.requests.filter(item => item.options.method === "POST").length, 1);
});

test("later reviews preserve original rating/action/scores and safely render model, time and context limits", async () => {
  const h = harness();
  await h.answer(0, status({ completedCount: 1, recentResults: [{ artist: "<img src=x onerror=alert(1)>", title: "Track & mix",
    rating: "like", originalModelAction: "KEEP", originalScore: 61, originalModelScore: 0,
    provider: "<script>provider</script>", model: "test-model", reviewedAt: "2026-10-07T20:00:00Z",
    contextQuality: "metadata-only", accuracyEligible: false,
    result: { scores: [{ rejected: true, finalScore: 88, rejectionReason: "<svg onload=alert(2)>" }] } }] }));
  assert.match(h.root.textContent, /Original rating: like · Original model action: KEEP · Original score: 61 · Original model score: 0/);
  assert.match(h.root.textContent, /Rejected afterward · Score: 88/);
  assert.match(h.root.textContent, /Reviewed afterward · Model: <script>provider<\/script> \/ test-model · Time:/);
  assert.match(h.root.textContent, /Metadata-only review: original request unavailable/);
  assert.match(h.root.textContent, /excluded from historical accuracy/);
  assert.match(h.root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(h.nodes("IMG").length + h.nodes("SCRIPT").length + h.nodes("SVG").length, 0);
  assert.equal(h.requests.length, 1);
});

test("empty, blocked and stopped states remain actionable and never update feedback or playback", async () => {
  const h = harness(); await h.answer(0, status({ state: "idle", pendingCount: 0, counts: { pending: 0, failed: 0, completed: 0 } }));
  assert.match(h.root.textContent, /No reviews waiting/);
  assert.match(h.root.textContent, /No later model reviews yet/);
  assert.equal(h.button("review").disabled, true);
  h.click("refresh"); await h.answer(1, status({ state: "blocked", paused: true, modelReady: false, lastError: "Review context could not be saved" }));
  assert.match(h.root.textContent, /Review backlog needs attention\. Review context could not be saved/);
  assert.equal(h.button("review").disabled, false);
  h.click("refresh"); await h.answer(2, status({ state: "stopped" }));
  assert.match(h.root.textContent, /Backlog review stopped/);
  h.click("refresh"); await h.answer(3, { state: "pending", paused: false, running: false, modelReady: true,
    counts: { pending: 3, waiting_model: 1, failed: 2, completed: 5, total: 11 }, recentResults: [] });
  assert.match(h.root.textContent, /4 pending · 5 reviewed afterward · 2 failed/);
  assert.equal(h.button("review").disabled, false);
  assert.ok(h.requests.every(item => /^\/api\/model-review\/backlog(?:\/(?:review|pause))?$/.test(item.url)));
  assert.ok(h.requests.every(item => item.options.method === "GET"));
});

test("pagehide stops reads and pageshow resumes one read; destroy/remount cleans timers and handlers", async () => {
  const h = harness(); await h.answer(0);
  await h.page("pagehide"); assert.equal(h.polls().length, 0);
  await h.advance(90000); assert.equal(h.requests.length, 1);
  await h.page("pageshow"); assert.equal(h.requests.length, 2); await h.answer(1);
  h.api.destroy(); h.api.destroy();
  assert.equal(h.polls().length, 0);
  assert.equal(h.root.children.length, 0);
  assert.equal(h.document.events.get("visibilitychange").size, 0);
  const next = h.context.ModelReviewBacklogUi.mount(h.root);
  assert.notEqual(next, h.api);
  assert.equal(h.root.children.length, 1);
  assert.equal(h.requests.length, 3);
  assert.equal(h.document.events.get("visibilitychange").size, 1);
  assert.equal(h.observers.filter(item => !item.closed).length, 1);
});

test("script bootstraps the permanent Taste panel immediately or on DOM readiness without an app hook or POST", async () => {
  const immediate = harness({ bootstrap: true });
  assert.equal(immediate.bootedChildren, 1);
  assert.equal(immediate.root.children.length, 1);
  assert.equal(immediate.requests.length, 1);
  await immediate.answer(0);
  await immediate.page("pagehide");
  await immediate.page("pageshow");
  assert.equal(immediate.root.children.length, 1);
  assert.equal(immediate.requests.length, 2);
  assert.ok(immediate.requests.every(item => item.options.method === "GET"));
  const deferred = harness({ bootstrap: true, loading: true });
  assert.equal(deferred.bootedChildren, 0);
  assert.equal(deferred.requests.length, 0);
  deferred.document.dispatch("DOMContentLoaded"); await flush();
  assert.equal(deferred.root.children.length, 1);
  assert.equal(deferred.requests.length, 1);
  deferred.document.dispatch("DOMContentLoaded"); await flush();
  assert.equal(deferred.root.children.length, 1);
  assert.equal(deferred.requests.length, 1);
  assert.ok(deferred.requests.every(item => item.options.method === "GET"));
});

test("awaiting API activation probes only visible Taste and reveals controls only after valid status", async () => {
  const h = harness({ awaitingApi: true, active: false, bootstrap: true });
  assert.equal(h.root.hidden, true);
  assert.equal(h.requests.length, 0);
  await h.visible(true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.method, "GET");
  await h.answer(0, { error: "Route unavailable" }, false);
  assert.equal(h.root.hidden, true);
  assert.equal(h.root.hasAttribute("data-await-backlog-api"), true);
  h.click("review"); h.click("pause"); await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.polls().length, 1);
  await h.advance(45000);
  assert.equal(h.requests.length, 2);
  await h.answer(1, status());
  assert.equal(h.root.hidden, false);
  assert.equal(h.root.hasAttribute("data-await-backlog-api"), false);
  assert.equal(h.button("review").disabled, false);
  assert.equal(h.requests.length, 2, "revealing the panel does not duplicate the successful probe");
  assert.ok(h.requests.every(item => item.options.method === "GET"));
});
