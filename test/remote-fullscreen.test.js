"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const publicDir = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "remote.html"), "utf8");
const script = fs.readFileSync(path.join(publicDir, "remote.js"), "utf8");

class EventTargetFixture {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

class ElementFixture extends EventTargetFixture {
  constructor(tagName, attributes = {}) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this.parentElement = null;
    this.hidden = Object.hasOwn(attributes, "hidden");
    this.disabled = Object.hasOwn(attributes, "disabled");
    this.dataset = new Proxy({}, {
      get: (_, name) => this.getAttribute(`data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
      set: (_, name, value) => {
        this.setAttribute(`data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
        return true;
      }
    });
    this.classList = {
      contains: (name) => (this.attributes.class || "").split(/\s+/).includes(name),
      toggle: (name, force) => {
        const names = new Set((this.attributes.class || "").split(/\s+/).filter(Boolean));
        const active = force ?? !names.has(name);
        if (active) names.add(name);
        else names.delete(name);
        this.attributes.class = [...names].join(" ");
        return active;
      }
    };
  }

  get textContent() {
    return this.children.map((child) => typeof child === "string" ? child : child.textContent).join("");
  }

  set textContent(value) {
    this.children = [String(value)];
  }

  get title() { return this.getAttribute("title") || ""; }
  set title(value) { this.setAttribute("title", value); }
  get src() { return this.getAttribute("src") || ""; }
  set src(value) { this.setAttribute("src", value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() {}

  contains(node) {
    return node === this || this.children.some((child) => typeof child !== "string" && child.contains(node));
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.attributes.id === selector.slice(1);
    if (selector.startsWith(".")) return selector.slice(1).split(".").every((name) => this.classList.contains(name));
    const attribute = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
    if (attribute) return attribute[2] === undefined
      ? this.getAttribute(attribute[1]) !== null
      : this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
  }

  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (typeof child === "string") continue;
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// Parse the actual Remote HTML so the fullscreen target's ancestry is tested too.
function createDocument() {
  const document = new EventTargetFixture();
  const container = new ElementFixture("fixture");
  const stack = [container];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const token of html.matchAll(/<!--[^]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi)) {
    const value = token[0];
    if (value.startsWith("<!")) continue;
    if (value.startsWith("</")) { stack.pop(); continue; }
    if (!value.startsWith("<")) { stack.at(-1).children.push(value); continue; }
    const [, tagName, attributeText] = value.match(/^<([a-z][\w-]*)([^]*?)\/?\s*>$/i);
    const attributes = {};
    for (const attribute of attributeText.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      attributes[attribute[1]] = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    }
    const element = new ElementFixture(tagName, attributes);
    element.parentElement = stack.at(-1);
    element.parentElement.children.push(element);
    if (!voidTags.has(tagName.toLowerCase()) && !value.endsWith("/>")) stack.push(element);
  }
  document.documentElement = container.querySelector("html");
  document.body = container.querySelector("body");
  document.querySelector = (selector) => container.querySelector(selector);
  document.querySelectorAll = (selector) => container.querySelectorAll(selector);
  document.fullscreenElement = null;
  document.hidden = false;
  document.visibilityState = "visible";
  return document;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise(setImmediate);
}

function fixture(t, options = {}) {
  const document = createDocument();
  const calls = { enter: [], exit: [], fetch: [], events: [], wake: [], sentinels: [] };
  const timeouts = new Map();
  const window = new EventTargetFixture();
  const navigator = {};
  window.location = { origin: options.secure === false ? "http://192.0.2.1:3777" : "https://remote.test" };
  window.isSecureContext = options.secure ?? true;
  let timerId = 0;
  const setTimer = (callback) => { timeouts.set(++timerId, callback); return timerId; };
  const f = {
    document,
    window,
    calls,
    button: document.querySelector("#remoteFullscreenToggle"),
    status: document.querySelector("#remoteFullscreenStatus"),
    wakeStatus: document.querySelector("#remoteWakeLockStatus"),
    feedback: document.querySelector("#remoteFeedbackStatus"),
    setFullscreen(element) {
      document.fullscreenElement = element;
      document.dispatchEvent({ type: "fullscreenchange" });
    },
    setVisible(visible) {
      document.hidden = !visible;
      document.visibilityState = visible ? "visible" : "hidden";
      document.dispatchEvent({ type: "visibilitychange" });
    },
    sentinel({ released = false, deferEvent = false, releaseFailure = false } = {}) {
      const sentinel = new EventTargetFixture();
      sentinel.released = released;
      sentinel.releaseCalls = 0;
      sentinel.release = () => {
        sentinel.releaseCalls++;
        if (releaseFailure) return Promise.reject(new Error("Fixture release failure"));
        sentinel.released = true;
        if (!deferEvent) sentinel.dispatchEvent({ type: "release" });
        return Promise.resolve();
      };
      sentinel.osRelease = () => {
        sentinel.released = true;
        sentinel.dispatchEvent({ type: "release" });
      };
      calls.sentinels.push(sentinel);
      return sentinel;
    },
    click() { f.button.dispatchEvent({ type: "click" }); },
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const callback of pending) callback();
    }
  };
  window.setTimeout = setTimer;
  if (options.hidden) {
    document.hidden = true;
    document.visibilityState = "hidden";
  }
  if (options.wake) navigator.wakeLock = {
    request(type) {
      calls.wake.push(type);
      return options.wakeRequest ? options.wakeRequest(f) : Promise.resolve(f.sentinel());
    }
  };
  if (!options.enabledAbsent) document.fullscreenEnabled = options.enabled ?? true;
  if (options.initialFullscreen) document.fullscreenElement = document.documentElement;
  if (!options.requestMissing) {
    document.documentElement.requestFullscreen = function () {
      calls.enter.push(this);
      return options.request
        ? options.request.call(this, f)
        : Promise.resolve().then(() => f.setFullscreen(this));
    };
  }
  if (!options.exitMissing) {
    document.exitFullscreen = function () {
      calls.exit.push(this);
      return options.exit
        ? options.exit.call(this, f)
        : Promise.resolve().then(() => f.setFullscreen(null));
    };
  }
  const payload = {
    connected: true,
    zones: [{
      zone_id: "fixture-zone",
      state: "paused",
      is_seek_allowed: true,
      now_playing: { two_line: { line1: "Fixture track", line2: "Fixture artist" }, length: 180, seek_position: 12 }
    }]
  };
  class EventSourceFixture {
    constructor(url) { this.url = url; calls.events.push(this); }
  }
  const context = vm.createContext({
    document,
    window,
    navigator,
    URL,
    EventSource: EventSourceFixture,
    fetch: async (url, request = {}) => {
      calls.fetch.push({ url, request });
      assert.equal(request.method || "GET", "GET", "fullscreen must never mutate the backend");
      assert.equal(url, "/api/status/live", "only the script's existing status refresh is allowed");
      return { ok: true, status: 200, json: async () => payload };
    },
    setTimeout: setTimer,
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: () => ++timerId,
    clearInterval() {}
  });
  vm.runInContext(script, context, { filename: "remote.js" });
  t.after(() => {
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].url, "/api/events?compact=1");
    assert.ok(calls.fetch.length > 0);
    assert.ok(calls.fetch.every((call) => (call.request.method || "GET") === "GET"));
    assert.ok(calls.fetch.every((call) => call.url === "/api/status/live"));
  });
  return f;
}

function assertButton(f, active, { busy = false, disabled = busy } = {}) {
  const label = active ? "Exit fullscreen" : "Enter fullscreen";
  assert.equal(f.button.textContent.trim(), label);
  assert.equal(f.button.getAttribute("aria-label"), label);
  assert.equal(f.button.title, label);
  assert.equal(f.button.getAttribute("aria-pressed"), String(active));
  assert.equal(f.button.getAttribute("aria-busy"), String(busy));
  assert.equal(f.button.disabled, disabled);
}

function assertFailure(f, action) {
  assert.match(f.status.textContent, new RegExp(`Could not ${action} fullscreen`));
  assert.equal(f.status.hidden, false);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.getAttribute("aria-busy"), "false");
}

test("Remote exposes a native fullscreen button and its own accessible status", async (t) => {
  const f = fixture(t);
  await flush();
  assert.equal(f.button.tagName, "BUTTON");
  assert.equal(f.button.getAttribute("type"), "button");
  assert.equal(f.button.getAttribute("aria-describedby"), "remoteFullscreenStatus remoteWakeLockStatus");
  assert.equal(f.status.getAttribute("role"), "status");
  assert.equal(f.status.getAttribute("aria-live"), "polite");
  assert.notEqual(f.status, f.feedback);
  assert.equal(f.status.hidden, true);
  assertButton(f, false);
});

test("repeated enter and exit toggles use the document root, including the rating sheet", async (t) => {
  const f = fixture(t);
  await flush();
  const root = f.document.documentElement;
  const sheet = f.document.querySelector("#remoteRatingSheet");
  assert.equal(root.contains(sheet), true);
  assert.equal(f.document.querySelector(".rabbitRemoteShell").contains(sheet), false);
  for (let index = 0; index < 3; index += 1) {
    f.click();
    assertButton(f, false, { busy: true });
    await flush();
    assert.equal(f.document.fullscreenElement, root);
    assertButton(f, true);
    f.click();
    assertButton(f, true, { busy: true });
    await flush();
    assert.equal(f.document.fullscreenElement, null);
    assertButton(f, false);
  }
  assert.equal(f.calls.enter.length, 3);
  assert.ok(f.calls.enter.every((target) => target === root));
  assert.equal(f.calls.exit.length, 3);
  assert.ok(f.calls.exit.every((target) => target === f.document));
});

test("external browser exit immediately restores the enter action", async (t) => {
  const f = fixture(t);
  f.click();
  await flush();
  assertButton(f, true);
  f.setFullscreen(null);
  assertButton(f, false);
  assert.equal(f.calls.exit.length, 0);
  f.click();
  await flush();
  assertButton(f, true);
  assert.equal(f.calls.enter.length, 2);
});

test("initial and externally entered fullscreen are read from document state", async (t) => {
  const f = fixture(t, { initialFullscreen: true });
  await flush();
  assertButton(f, true);
  f.click();
  await flush();
  assertButton(f, false);
  f.setFullscreen(f.document.body);
  assertButton(f, true);
  f.click();
  await flush();
  assertButton(f, false);
  assert.equal(f.calls.enter.length, 0);
  assert.equal(f.calls.exit.length, 2);
});

for (const [name, options] of [
  ["missing request API", { requestMissing: true }],
  ["missing exit API", { exitMissing: true }],
  ["browser permissions disabling fullscreen", { enabled: false }]
]) {
  test(`${name} disables entry with persistent visible guidance`, async (t) => {
    const f = fixture(t, options);
    await flush();
    assert.equal(f.button.disabled, true);
    assert.equal(f.button.getAttribute("aria-busy"), "false");
    assert.equal(f.button.getAttribute("aria-label"), "Enter fullscreen");
    assert.match(f.status.textContent, /Fullscreen is unavailable/i);
    assert.equal(f.status.hidden, false);
    assert.equal(f.button.title, f.status.textContent);
    f.click();
    await flush();
    f.runTimeouts();
    assert.equal(f.status.hidden, false);
    assert.match(f.status.textContent, /Fullscreen is unavailable/i);
    assert.equal(f.calls.enter.length + f.calls.exit.length, 0);
  });
}

test("available APIs work when fullscreenEnabled is not exposed", async (t) => {
  const f = fixture(t, { enabledAbsent: true });
  assertButton(f, false);
  f.click();
  await flush();
  assertButton(f, true);
});

test("an existing fullscreen session can exit even when new entry is disabled", async (t) => {
  const f = fixture(t, { initialFullscreen: true, enabled: false, requestMissing: true });
  assertButton(f, true);
  f.click();
  await flush();
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(f.button.disabled, true);
  assert.equal(f.button.getAttribute("aria-label"), "Enter fullscreen");
  assert.match(f.status.textContent, /Fullscreen is unavailable/i);
});

for (const failure of ["sync", "async"]) {
  test(`${failure} entry failure restores truthful state and permits retry`, async (t) => {
    let fail = true;
    const f = fixture(t, {
      request(current) {
        if (fail) {
          if (failure === "sync") throw new Error("Fixture rejection");
          return Promise.reject(new Error("Fixture rejection"));
        }
        return Promise.resolve().then(() => current.setFullscreen(this));
      }
    });
    f.click();
    await flush();
    assertButton(f, false);
    assertFailure(f, "enter");
    f.runTimeouts();
    assertFailure(f, "enter");
    fail = false;
    f.click();
    await flush();
    assertButton(f, true);
    assert.equal(f.status.textContent, "");
    assert.equal(f.status.hidden, true);
    assert.equal(f.calls.enter.length, 2);
  });

  test(`${failure} exit failure retains the exit action and permits retry`, async (t) => {
    let fail = true;
    const f = fixture(t, {
      initialFullscreen: true,
      exit(current) {
        if (fail) {
          if (failure === "sync") throw new Error("Fixture rejection");
          return Promise.reject(new Error("Fixture rejection"));
        }
        return Promise.resolve().then(() => current.setFullscreen(null));
      }
    });
    f.click();
    await flush();
    assertButton(f, true);
    assertFailure(f, "exit");
    fail = false;
    f.click();
    await flush();
    assertButton(f, false);
    assert.equal(f.status.hidden, true);
    assert.equal(f.calls.exit.length, 2);
  });
}

test("pending entry ignores duplicate clicks and changes the label only with browser state", async (t) => {
  const pending = deferred();
  const f = fixture(t, { request: () => pending.promise });
  f.click();
  assertButton(f, false, { busy: true });
  f.click(); // Force an event even though a native disabled button would reject it.
  assert.equal(f.calls.enter.length, 1);
  f.setFullscreen(f.document.documentElement);
  assertButton(f, true, { busy: true });
  f.click();
  assert.equal(f.calls.exit.length, 0);
  pending.resolve();
  await flush();
  assertButton(f, true);
});

test("external exit during a pending request wins over the request's eventual completion", async (t) => {
  const pending = deferred();
  const f = fixture(t, { request: () => pending.promise });
  f.click();
  f.setFullscreen(f.document.documentElement);
  assertButton(f, true, { busy: true });
  f.setFullscreen(null);
  assertButton(f, false, { busy: true });
  pending.resolve();
  await flush();
  assertButton(f, false);
  assert.equal(f.document.fullscreenElement, null);
});

test("pending exit ignores duplicate clicks and follows external state after rejection", async (t) => {
  const pending = deferred();
  const f = fixture(t, { initialFullscreen: true, exit: () => pending.promise });
  f.click();
  assertButton(f, true, { busy: true });
  f.click();
  assert.equal(f.calls.exit.length, 1);
  f.setFullscreen(null);
  assertButton(f, false, { busy: true });
  pending.reject(new Error("Fixture rejected after external exit"));
  await flush();
  assertButton(f, false);
  assertFailure(f, "exit");
});

test("entry rejection after an external entry preserves the actual fullscreen state", async (t) => {
  const pending = deferred();
  const f = fixture(t, { request: () => pending.promise });
  f.click();
  f.setFullscreen(f.document.documentElement);
  pending.reject(new Error("Fixture rejection"));
  await flush();
  assertButton(f, true);
  assertFailure(f, "enter");
});

test("fullscreenerror uses separate persistent feedback and a subsequent click can retry", async (t) => {
  const f = fixture(t);
  await flush();
  f.calls.events[0].onmessage({ data: "{" });
  assert.match(f.feedback.textContent, /unreadable update/i);
  f.document.dispatchEvent({ type: "fullscreenerror" });
  assertButton(f, false);
  assert.match(f.status.textContent, /Fullscreen could not be changed/i);
  assert.equal(f.status.hidden, false);
  f.runTimeouts();
  assert.equal(f.feedback.textContent, "");
  assert.match(f.status.textContent, /Fullscreen could not be changed/i);
  assert.equal(f.status.hidden, false);
  f.click();
  await flush();
  assertButton(f, true);
  assert.equal(f.status.hidden, true);
});

function assertWake(f, state, text) {
  assert.equal(f.wakeStatus.dataset.state, state);
  if (state === "active") {
    assert.equal(f.wakeStatus.hidden, true, "successful wake lock has no visible status row");
    assert.equal(f.wakeStatus.textContent, "");
    return;
  }
  assert.equal(f.wakeStatus.hidden, false);
  assert.match(f.wakeStatus.textContent, text);
}

test("wake-lock status is separate, muted, accessible and absent outside fullscreen", async (t) => {
  const f = fixture(t, { wake: true });
  await flush();
  assert.equal(f.wakeStatus.getAttribute("role"), "status");
  assert.equal(f.wakeStatus.getAttribute("aria-live"), "polite");
  assert.equal(f.wakeStatus.getAttribute("aria-atomic"), "true");
  assert.notEqual(f.wakeStatus, f.status);
  assert.notEqual(f.wakeStatus, f.feedback);
  assert.equal(f.wakeStatus.hidden, true);
  assert.equal(f.calls.wake.length, 0);
  const css = fs.readFileSync(path.join(publicDir, "remote.css"), "utf8");
  assert.match(css, /\.rabbitRemoteWakeLockStatus\s*\{[^}]*color:\s*var\(--remote-muted\)/);
});

test("visible fullscreen requests one screen lock and repeated enter/exit releases each owner", async (t) => {
  const f = fixture(t, { wake: true });
  for (let index = 0; index < 3; index++) {
    f.click(); f.click();
    await flush();
    assertButton(f, true);
    assertWake(f, "active");
    assert.equal(f.calls.wake.length, index + 1);
    assert.ok(f.calls.wake.every(type => type === "screen"));
    f.setFullscreen(f.document.documentElement);
    f.setVisible(true);
    f.window.dispatchEvent({ type: "pageshow" });
    await flush();
    assert.equal(f.calls.wake.length, index + 1, "duplicate events do not acquire extra locks");
    f.click(); f.click();
    await flush();
    assertButton(f, false);
    assert.equal(f.calls.sentinels[index].releaseCalls, 1);
    assert.equal(f.calls.sentinels[index].released, true);
    assert.equal(f.wakeStatus.hidden, true);
  }
  assert.equal(f.calls.enter.length, 3);
  assert.equal(f.calls.exit.length, 3);
});

test("initial and external fullscreen acquire, and browser exit releases without another button click", async (t) => {
  const f = fixture(t, { wake: true, initialFullscreen: true });
  await flush();
  assertWake(f, "active");
  f.setFullscreen(null);
  await flush();
  assert.equal(f.calls.sentinels[0].releaseCalls, 1);
  assert.equal(f.wakeStatus.hidden, true);
  assert.equal(f.calls.exit.length, 0);
  f.setFullscreen(f.document.body);
  await flush();
  assert.equal(f.calls.wake.length, 2);
  assertWake(f, "active");
});

test("hidden fullscreen waits until visible and a later hidden period releases and reacquires", async (t) => {
  const f = fixture(t, { wake: true, initialFullscreen: true, hidden: true });
  await flush();
  assert.equal(f.calls.wake.length, 0);
  assert.equal(f.wakeStatus.hidden, true);
  f.setVisible(true);
  await flush();
  assertWake(f, "active");
  f.setVisible(false);
  await flush();
  assert.equal(f.calls.sentinels[0].releaseCalls, 1);
  assert.equal(f.wakeStatus.hidden, true);
  f.setVisible(true);
  await flush();
  assert.equal(f.calls.wake.length, 2);
  assertWake(f, "active");
  f.setVisible(false); f.setFullscreen(null); f.setVisible(true);
  await flush();
  assert.equal(f.calls.wake.length, 2, "restoration without fullscreen cannot acquire");
});

test("browser or OS release reports sleep availability without a retry loop", async (t) => {
  const f = fixture(t, { wake: true });
  f.click(); await flush();
  f.calls.sentinels[0].osRelease();
  assertWake(f, "released", /Screen may sleep/);
  f.setFullscreen(f.document.documentElement); f.setVisible(true);
  f.window.dispatchEvent({ type: "pageshow" }); f.runTimeouts();
  await flush();
  assert.equal(f.calls.wake.length, 1);
  assert.equal(f.calls.sentinels[0].releaseCalls, 0);
  f.setVisible(false); f.setVisible(true); await flush();
  assert.equal(f.calls.wake.length, 2);
  assertWake(f, "active");
});

for (const failure of ["sync", "async"]) {
  test(`${failure} wake-lock denial preserves fullscreen and retries only in a new eligible period`, async (t) => {
    let deny = true;
    const f = fixture(t, { wake: true, wakeRequest(current) {
      if (!deny) return Promise.resolve(current.sentinel());
      if (failure === "sync") throw new Error("Fixture denial");
      return Promise.reject(new Error("Fixture denial"));
    } });
    f.click(); await flush();
    assertButton(f, true);
    assert.equal(f.status.hidden, true);
    assertWake(f, "declined", /Screen may sleep.*declined/);
    f.setFullscreen(f.document.documentElement); f.setVisible(true); f.runTimeouts();
    await flush();
    assert.equal(f.calls.wake.length, 1);
    deny = false;
    f.click(); await flush(); f.click(); await flush();
    assert.equal(f.calls.wake.length, 2);
    assertWake(f, "active");
  });
}

for (const [name, options, expected] of [
  ["insecure LAN HTTP with an exposed API", { wake: true, secure: false }, /needs a secure connection/],
  ["insecure LAN HTTP without an API", { secure: false }, /needs a secure connection/],
  ["secure context without the API", {}, /unavailable in this browser/]
]) {
  test(`${name} shows accurate guidance only in fullscreen and leaves fullscreen enabled`, async (t) => {
    const f = fixture(t, options);
    await flush();
    assert.equal(f.wakeStatus.hidden, true);
    f.click(); await flush();
    assertButton(f, true);
    assertWake(f, "unavailable", expected);
    assert.equal(f.calls.wake.length, 0);
    assert.equal(f.status.hidden, true);
    f.setFullscreen(null); await flush();
    assertButton(f, false);
    assert.equal(f.wakeStatus.hidden, true);
  });
}

for (const boundary of ["fullscreen exit", "hidden", "pagehide"]) {
  test(`a wake-lock grant arriving after ${boundary} is released instead of adopted`, async (t) => {
    const pending = deferred();
    const f = fixture(t, { wake: true, wakeRequest: () => pending.promise });
    f.click(); await flush();
    assertWake(f, "pending", /Requesting/);
    if (boundary === "fullscreen exit") f.setFullscreen(null);
    if (boundary === "hidden") f.setVisible(false);
    if (boundary === "pagehide") f.window.dispatchEvent({ type: "pagehide" });
    const late = f.sentinel(); pending.resolve(late); await flush();
    assert.equal(late.releaseCalls, 1);
    assert.equal(late.released, true);
    assert.equal(f.wakeStatus.hidden, true);
    assert.equal(f.calls.wake.length, 1);
  });
}

for (const boundary of ["fullscreen", "visibility"]) {
  test(`${boundary} restoration during a pending request disposes of the obsolete grant before fresh acquisition`, async (t) => {
    const pending = deferred();
    const f = fixture(t, { wake: true, wakeRequest: current => current.calls.wake.length === 1 ? pending.promise : Promise.resolve(current.sentinel()) });
    f.click(); await flush();
    if (boundary === "fullscreen") { f.setFullscreen(null); f.setFullscreen(f.document.documentElement); }
    else { f.setVisible(false); f.setVisible(true); }
    assert.equal(f.calls.wake.length, 1, "pending requests serialize across transitions");
    const stale = f.sentinel(); pending.resolve(stale); await flush();
    assert.equal(stale.releaseCalls, 1);
    assert.equal(f.calls.wake.length, 2);
    assertWake(f, "active");
    const current = f.calls.sentinels.at(-1);
    stale.osRelease(); await flush();
    assertWake(f, "active");
    assert.equal(current.releaseCalls, 0);
  });
}

test("obsolete request denial cannot overwrite a restored fullscreen lock", async (t) => {
  const pending = deferred();
  const f = fixture(t, { wake: true, wakeRequest: current => current.calls.wake.length === 1 ? pending.promise : Promise.resolve(current.sentinel()) });
  f.click(); await flush(); f.setFullscreen(null); f.setFullscreen(f.document.documentElement);
  pending.reject(new Error("Old request denied")); await flush();
  assert.equal(f.calls.wake.length, 2);
  assertWake(f, "active");
});

test("a delayed old release event cannot clear a newer sentinel or its status", async (t) => {
  const f = fixture(t, { wake: true, wakeRequest: current => Promise.resolve(current.sentinel({ deferEvent: true })) });
  f.click(); await flush();
  const old = f.calls.sentinels[0];
  f.setVisible(false); await flush(); f.setVisible(true); await flush();
  assert.equal(old.releaseCalls, 1);
  assert.equal(f.calls.wake.length, 2);
  old.dispatchEvent({ type: "release" });
  assertWake(f, "active");
  assert.equal(f.calls.sentinels[1].releaseCalls, 0);
});

test("an outstanding old release promise cannot block reentry or erase its new owner", async (t) => {
  const released = deferred();
  const f = fixture(t, { wake: true });
  f.click(); await flush();
  const old = f.calls.sentinels[0];
  old.release = () => {
    old.releaseCalls++;
    old.released = true;
    old.dispatchEvent({ type: "release" });
    return released.promise;
  };
  f.click(); await flush();
  assert.equal(old.releaseCalls, 1);
  assert.equal(f.wakeStatus.hidden, true);
  f.click(); await flush();
  assert.equal(f.calls.wake.length, 2);
  assertWake(f, "active");
  released.resolve(); old.dispatchEvent({ type: "release" }); await flush();
  assertWake(f, "active");
  assert.equal(f.calls.sentinels[1].releaseCalls, 0);
});

test("an already-released returned sentinel is reported accurately and never retried in place", async (t) => {
  const f = fixture(t, { wake: true, wakeRequest: current => Promise.resolve(current.sentinel({ released: true })) });
  f.click(); await flush();
  assertWake(f, "released", /Screen may sleep/);
  f.setVisible(true); f.setFullscreen(f.document.documentElement); await flush();
  assert.equal(f.calls.wake.length, 1);
  f.setFullscreen(null); await flush();
  assert.equal(f.calls.sentinels[0].releaseCalls, 0);
});

test("pagehide releases and fences events until pageshow restores a visible fullscreen page", async (t) => {
  const f = fixture(t, { wake: true });
  f.click(); await flush();
  f.window.dispatchEvent({ type: "pagehide", persisted: true }); await flush();
  assert.equal(f.calls.sentinels[0].releaseCalls, 1);
  assert.equal(f.wakeStatus.hidden, true);
  f.setVisible(false); f.setVisible(true); f.setFullscreen(f.document.documentElement); await flush();
  assert.equal(f.calls.wake.length, 1);
  f.window.dispatchEvent({ type: "pageshow", persisted: true }); await flush();
  assert.equal(f.calls.wake.length, 2);
  assertWake(f, "active");
  f.window.dispatchEvent({ type: "pagehide" }); f.setFullscreen(null);
  f.window.dispatchEvent({ type: "pageshow", persisted: true }); await flush();
  assert.equal(f.calls.wake.length, 2, "pageshow without fullscreen cannot acquire");
});

test("wake-lock feedback cannot erase fullscreen errors or playback feedback", async (t) => {
  const pending = deferred();
  const f = fixture(t, { wake: true, request: () => pending.promise });
  f.click(); f.setFullscreen(f.document.documentElement); await flush();
  pending.reject(new Error("Late fullscreen rejection")); await flush();
  assertFailure(f, "enter");
  assertWake(f, "active");
  f.calls.events[0].onmessage({ data: "{" });
  assert.match(f.feedback.textContent, /unreadable update/);
  f.calls.sentinels[0].osRelease();
  assertWake(f, "released", /Screen may sleep/);
  assertFailure(f, "enter");
  f.runTimeouts();
  assert.equal(f.feedback.textContent, "");
  assertFailure(f, "enter");
  assertWake(f, "released", /Screen may sleep/);
});

test("wake-lock release rejection is handled without retries or blocking fullscreen exit", async (t) => {
  const f = fixture(t, { wake: true, wakeRequest: current => Promise.resolve(current.sentinel({ releaseFailure: true })) });
  f.click(); await flush(); f.click(); await flush();
  assertButton(f, false);
  assert.equal(f.wakeStatus.hidden, true);
  assert.equal(f.calls.sentinels[0].releaseCalls, 1);
  f.setVisible(true); f.runTimeouts(); await flush();
  assert.equal(f.calls.wake.length, 1);
});
