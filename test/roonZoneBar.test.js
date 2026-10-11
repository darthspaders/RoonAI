"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../public/roonZoneBar.js"), "utf8");

function harness(zones, selected) {
  const document = { activeElement: null };
  const element = tag => ({
    tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, hidden: false, className: "", textContent: "", parent: null,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; },
    focus() { document.activeElement = this; },
    before(node) { this.placedBefore = node; }
  });
  const events = [], observers = [];
  const select = {
    options: zones.map(([value, textContent]) => ({ value, textContent })), value: selected, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { events.push([event.type, this.value]); for (const fn of this.listeners[event.type] || []) fn(event); }
  };
  const topbar = element("section");
  Object.assign(document, {
    getElementById: id => id === "zoneSelect" ? select : null,
    querySelector: selector => selector === ".topbar" ? topbar : null,
    createElement: element
  });
  class MutationObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } }
  vm.runInNewContext(source, { document, MutationObserver, Event: class { constructor(type) { this.type = type; } }, JSON });
  const row = topbar.placedBefore;
  const group = row.children.find(child => child.className === "lyrionChoices");
  const pills = () => group.children.map(b => [b.textContent, b.getAttribute("aria-pressed")]);
  const roonUpdate = () => observers.forEach(o => o.fn([]));
  return { document, select, topbar, row, group, pills, events, observers, roonUpdate };
}

test("the Roon Zone row lists every Roon zone as a pill, marks the selected one, and sits above the navigation", () => {
  const h = harness([["z1", "HQPlayer"], ["z2", "WiiM Amp Pro"]], "z2");
  assert.equal(h.row.id, "roonZoneBar");
  assert.equal(h.row.className, "roonZoneBar");
  assert.equal(h.row.children[0].textContent, "Roon Zone");
  assert.equal(h.group.getAttribute("role"), "group");
  assert.equal(h.group.getAttribute("aria-label"), "Roon Zone");
  assert.deepEqual(h.pills(), [["HQPlayer", "false"], ["WiiM Amp Pro", "true"]]);
  assert.equal(h.row.hidden, false);
  assert.deepEqual(h.observers.map(o => [o.target === h.select, o.options.childList, o.options.subtree]), [[true, true, true]]);
});

test("picking a zone pill selects that zone in the app's zone select and tells the app it changed", () => {
  const h = harness([["z1", "HQPlayer"], ["z2", "WiiM Amp Pro"]], "z2");
  h.group.children[0].onclick();
  assert.equal(h.select.value, "z1");
  assert.deepEqual(h.events, [["change", "z1"]]);
  assert.deepEqual(h.pills(), [["HQPlayer", "true"], ["WiiM Amp Pro", "false"]]);
});

test("a Roon update that changes nothing keeps the same pills and keyboard focus; a new selection redraws them and keeps focus on that zone", () => {
  const h = harness([["z1", "HQPlayer"], ["z2", "WiiM Amp Pro"]], "z1");
  const before = h.group.children.slice();
  before[1].focus();
  h.roonUpdate();
  assert.equal(h.group.children[1], before[1]);
  assert.equal(h.document.activeElement, before[1]);
  h.select.value = "z2";
  h.roonUpdate();
  assert.notEqual(h.group.children[1], before[1]);
  assert.deepEqual(h.pills(), [["HQPlayer", "false"], ["WiiM Amp Pro", "true"]]);
  assert.equal(h.document.activeElement, h.group.children[1]);
});

test("the row is hidden while Roon reports no zones, and appears once it does", () => {
  const h = harness([], "");
  assert.equal(h.row.hidden, true);
  h.select.options.push({ value: "z1", textContent: "HQPlayer" });
  h.select.value = "z1";
  h.roonUpdate();
  assert.equal(h.row.hidden, false);
  assert.deepEqual(h.pills(), [["HQPlayer", "true"]]);
});

test("the Roon Zone row is hidden while Lyrion is the playback system and is a plain row like Playback System and HQPlayer, not a panel", () => {
  const css = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
  assert.match(css, /body\[data-playback-system="lyrion"\] #roonZoneBar,#roonZoneBar\[hidden\] \{display:none;\}/);
  assert.match(css, /\.roonZoneBar \{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:-4px 0 12px;\}/);
  assert.match(css, /\.roonZoneLabel \{color:var\(--muted\);font-size:16px;\}/);
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  assert.ok(html.indexOf('src="/roonZoneBar.js') > html.indexOf('src="/lyrion.js'), "loads after lyrion.js");
});
