"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/sonicBlindReview.js"), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function batch({ coverage = true, completed = false } = {}) {
  const count = coverage ? 8 : 24;
  return { batchId: "fixture", ...(coverage ? { kind: "catalog-reference-coverage" } : {}),
    count, anchorCount: coverage ? 2 : 6, completed: completed ? count : 0, remaining: completed ? 0 : count,
    groups: Array.from({ length: coverage ? 2 : 6 }, (_, group) => ({ sessionId: `session-${group}`, ...(coverage ? {} : { lane: "Anchor style" }),
      anchor: { artist: "Anchor artist", title: `Anchor ${group}`, mixVersion: "Exact mix" },
      anchorAudio: { url: `/fixture/anchor-${group}`, start: 0, end: 30 },
      items: Array.from({ length: 4 }, (_, index) => ({ index, number: group * 4 + index + 1,
        status: completed ? "REVIEWED" : "PENDING", candidate: { artist: "Candidate artist", title: `Candidate ${group}-${index}` },
        audio: { url: `/fixture/candidate-${group}-${index}`, start: 0, end: 30 },
        review: completed ? { decision: "KEEP", listened: true, note: "Human note" } : null })) })) };
}

async function harness(payload) {
  const requests = [], events = new Map(), storage = new Map();
  const root = { innerHTML: "", addEventListener(type, handler) { events.set(type, handler); },
    querySelectorAll() { return []; }, querySelector(selector) {
      if (selector === "#blindNote") return { value: "" };
      if (selector === "#blindListened") return { checked: false };
      if (selector === "#blindCandidateHeading") return { focus() {} };
      return null;
    } };
  const context = { document: { getElementById: () => root }, location: { search: "?sonicBlindBatch=fixture" },
    URLSearchParams, AbortSignal, setActiveView() {}, addEventListener() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ batch: structuredClone(payload) }) }; } };
  context.window = context;
  vm.runInNewContext(source, context); await flush();
  return { root, requests, storage, changeAnchor(value) { events.get("change")({ target: { id: "blindAnchor", value: String(value) } }); } };
}

test("eight-pair coverage UI explains candidate fit and navigates two anchors without revealing attribution", async () => {
  const h = await harness(batch());
  assert.match(h.root.innerHTML, /<h2>Candidate coverage check<\/h2>/);
  assert.match(h.root.innerHTML, /fit its groove, energy and mood/);
  assert.match(h.root.innerHTML, /Candidate sources and selection details stay hidden/);
  assert.doesNotMatch(h.root.innerHTML, /Anchor lane:/);
  assert.match(h.root.innerHTML, /0 of 8 decisions saved/); assert.match(h.root.innerHTML, /Candidate 1 of 4/);
  assert.doesNotMatch(h.root.innerHTML, /model comparison|mert-|beatport|tidal\.com|autoplay/i);
  assert.equal((h.root.innerHTML.match(/<audio controls preload="none"/g) || []).length, 2);
  h.changeAnchor(4); assert.match(h.root.innerHTML, /Pair 5 of 8/); assert.match(h.root.innerHTML, /Anchor 1/);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.method, undefined, "rendering only reads the batch");
});

test("completed coverage UI names the saved coverage judgments and preserves human-listening confirmation", async () => {
  const h = await harness(batch({ completed: true }));
  assert.match(h.root.innerHTML, /8 of 8 decisions saved/);
  assert.match(h.root.innerHTML, /judgments are saved for the candidate coverage check/);
  assert.match(h.root.innerHTML, /I listened to both excerpts/);
  assert.match(h.root.innerHTML, /Global ratings and discovery ranking stay unchanged/);
  assert.doesNotMatch(h.root.innerHTML, /model comparison|model has been promoted/);
  assert.equal(h.requests.length, 1);
});

test("legacy model batches retain their existing copy, counts and completion meaning", async () => {
  const h = await harness(batch({ coverage: false, completed: true }));
  assert.match(h.root.innerHTML, /<h2>Blind listening<\/h2>/);
  assert.match(h.root.innerHTML, /24 of 24 decisions saved/);
  assert.match(h.root.innerHTML, /Model names and scores stay hidden/);
  assert.match(h.root.innerHTML, /Anchor lane: Anchor style/);
  assert.match(h.root.innerHTML, /saved for the model comparison; no model has been promoted/);
  assert.doesNotMatch(h.root.innerHTML, /Candidate coverage check/);
});

test("catalog scout review explains differing selections without invented anchor lanes or attribution", async () => {
  const payload = batch(); payload.kind = "catalog-scout-comparison";
  const h = await harness(payload);
  assert.match(h.root.innerHTML, /Only candidates that differ between the final shortlists are included/);
  assert.doesNotMatch(h.root.innerHTML, /Anchor lane:|mert-|current-production|ensemble|beatport|autoplay/i);
  assert.match(h.root.innerHTML, /Model names and scores stay hidden/);
  assert.match(h.root.innerHTML, /I listened to both excerpts/);
  assert.match(h.root.innerHTML, /0 of 8 decisions saved/);
  h.changeAnchor(4); assert.match(h.root.innerHTML, /Pair 5 of 8/);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.method, undefined);
});
