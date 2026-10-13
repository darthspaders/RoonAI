"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequestedVersionEvidenceLookup, buildRequestedVersionEvidenceRequest } = require("../src/requestedVersionEvidence");
const { scoreTidalIdentity } = require("../src/exactTrackVerification");

// Sanitized recording facts retained from the October 9 read-only catalog audit.
const request = { artist: "Makebo", title: "From Zero (Original Mix)" };
const detail = { source: "beatport", id: "30626729", artist: "Makebo", artists: [{ name: "Makebo" }],
  title: "From Zero", mixName: "Original Mix", isrc: "GBLV62602095", durationMs: 411270,
  album: "From Zero", label: "Random Shadow", releaseDate: "2026-10-08", year: "2026-10-08",
  beatportUrl: "https://www.beatport.com/track/from-zero/30626729" };
const tidal = { id: "565212426", artist: "Makebo", title: "From Zero", isrc: "GBLV62602095",
  durationMs: 411000, album: "From Zero", label: "Random Shadow", releaseDate: "2026-10-08" };
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ rows = [detail], fresh = detail, clock = () => 1791564000000, search, get } = {}) {
  const calls = [];
  const beatport = {
    isConfigured: () => true,
    searchTracks: async options => { calls.push({ kind: "search", ...options }); return search ? search(options) : { tracks: copy(rows) }; },
    getTrackById: async id => { calls.push({ kind: "detail", id }); return get ? get(id) : copy(fresh); }
  };
  return { lookup: createRequestedVersionEvidenceLookup({ beatport, clock }), calls, beatport };
}

test("fresh independent Makebo evidence satisfies the existing Original equivalence rule without rewriting TIDAL", async () => {
  const { lookup, calls } = fixture();
  const evidence = await lookup(Object.freeze(copy(request)));
  assert.equal(evidence.provider, "beatport");
  assert.equal(evidence.checkedAt, new Date(1791564000000).toISOString());
  assert.deepEqual(calls, [{ kind: "search", query: "Makebo From Zero", page: 1, perPage: 20 }, { kind: "detail", id: "30626729" }]);
  assert.equal(scoreTidalIdentity(request, tidal).matched, false, "candidate facts alone remain insufficient");
  const enriched = buildRequestedVersionEvidenceRequest(request, evidence);
  assert.equal(enriched.title, request.title);
  assert.equal(enriched.artist, request.artist);
  assert.equal(enriched.isrc, detail.isrc);
  assert.equal(enriched.durationMs, detail.durationMs);
  assert.equal(enriched.id, undefined);
  assert.equal(enriched.tidalTrackId, undefined);
  assert.equal(scoreTidalIdentity(enriched, tidal).outcome, "VERIFIED_EQUIVALENT_RECORDING");
  assert.equal(tidal.title, "From Zero");
  assert.equal(tidal.version, undefined);
  assert.deepEqual(request, { artist: "Makebo", title: "From Zero (Original Mix)" });
});

test("Extended evidence identifies the independent long recording and does not certify a conflicting short TIDAL recording", async () => {
  const long = { ...detail, id: "30572076", artist: "NAKSHATRA", artists: [{ name: "NAKSHATRA" }],
    title: "Sunset at Lake Pichola", mixName: "Extended Mix", isrc: "GBLV62601776", durationMs: 355680,
    album: "Sunset at Lake Pichola", label: "Polyptych Limited White", beatportUrl: "https://www.beatport.com/track/30572076" };
  const supplied = { artist: "NAKSHATRA", title: "Sunset at Lake Pichola (Extended Mix)" };
  const { lookup } = fixture({ rows: [long], fresh: long });
  const enriched = buildRequestedVersionEvidenceRequest(supplied, await lookup(supplied));
  assert.equal(enriched.isrc, "GBLV62601776");
  assert.equal(enriched.durationMs, 355680);
  assert.equal(scoreTidalIdentity(enriched, { artist: "NAKSHATRA", title: long.title, id: "565212415",
    isrc: "GBLV62601779", durationMs: 235000 }).matched, false);
});

test("only generic explicit Original and Extended requests can trigger a provider lookup", async () => {
  const { lookup, calls } = fixture();
  for (const title of ["From Zero", "From Zero (Radio Edit)", "From Zero (Club Mix)", "From Zero (Named Original Mix)",
    "From Zero (Artist Remix)", "From Zero (Extended Edit)"])
    assert.equal(await lookup({ artist: "Makebo", title }), null, title);
  assert.equal(await lookup({ ...request, mixVersion: "Extended Mix" }), null);
  assert.deepEqual(calls, []);
});

test("full credits allow reorder and punctuation but reject subsets, aliases and contradictory artist arrays", async () => {
  const two = { ...detail, artist: "Second Artist, Makebo", artists: [{ name: "Second Artist" }, { name: "Makebo" }] };
  const { lookup, calls } = fixture({ rows: [two], fresh: two });
  assert.ok(await lookup({ ...request, artist: "Makebo & Second Artist" }));
  assert.equal(await lookup(request), null, "co-artist omission is not recording proof");
  assert.equal(await lookup({ ...request, artist: "Other Name", artistAliases: ["Second Artist, Makebo"] }), null);
  const before = calls.length;
  assert.equal(await lookup({ ...request, artists: [{ name: "Somebody Else" }] }), null);
  assert.equal(calls.length, before);
  const dotted = { ...detail, artist: "Make.bo", artists: [{ name: "Make.bo" }] };
  assert.ok(await fixture({ rows: [dotted], fresh: dotted }).lookup(request));
});

test("different plausible recordings fail closed before detail lookup", async () => {
  for (const other of [{ ...detail, id: "30626730", isrc: "GBLV62602096" },
    { ...detail, id: "30626730", durationMs: detail.durationMs + 5001 },
    { ...detail, id: "30626730", isrc: "" }, { ...detail, id: "30626730", durationMs: null }]) {
    const { lookup, calls } = fixture({ rows: [detail, other] });
    assert.equal(await lookup(request), null);
    assert.equal(calls.filter(call => call.kind === "detail").length, 0);
  }
});

test("same ISRC and compatible durations collapse equivalent locators deterministically", async () => {
  const duplicate = { ...detail, id: "30626730", durationMs: detail.durationMs - 270 };
  const { lookup, calls } = fixture({ rows: [duplicate, detail, copy(detail)] });
  assert.ok(await lookup(request));
  assert.deepEqual(calls.filter(call => call.kind === "detail"), [{ kind: "detail", id: detail.id }]);
});

test("fresh details must independently reconfirm the locator's identity, version and recording facts", async () => {
  for (const change of [{ id: "999" }, { artist: "Other", artists: [{ name: "Other" }] }, { title: "Other Song" },
    { mixName: "Extended Mix" }, { title: "From Zero (Artist Remix)" }, { isrc: "GBLV62602096" },
    { isrc: "" }, { durationMs: null }, { durationMs: detail.durationMs + 5001 },
    { beatportUrl: "https://example.test/track/30626729" }, { source: "tidal" }, { releaseDate: "2026-02-30" }]) {
    const { lookup } = fixture({ fresh: { ...detail, ...change } });
    assert.equal(await lookup(request), null, JSON.stringify(change));
  }
});

test("supplied ISRC, duration, Beatport IDs and release facts cannot be overwritten", async () => {
  for (const change of [{ isrc: "GBLV62602096" }, { isrc: "bad" }, { durationMs: 206000 }, { durationMs: 0 },
    { duration: "PT3M26S" }, { beatportTrackId: "999" }, { beatport: { id: "999" } },
    { album: "Other Release" }, { label: "Other Label" }, { releaseDate: "2025-01-01" }]) {
    const { lookup } = fixture();
    assert.equal(await lookup({ ...request, ...change }), null, JSON.stringify(change));
  }
});

test("builder preserves supplied identifiers, facts, field shapes and version text; provenance remains separate", async () => {
  const supplied = { ...request, id: "565212426", tidalTrackId: "565212426", tidalUrl: "https://tidal.com/browse/track/565212426",
    isrc: "gb-lv6-26-02095", duration: "PT6M51S", album: { title: "From Zero" }, label: "Random Shadow",
    releaseDate: "2026-10-08", mixVersion: "Original Mix", custom: { untouched: true } };
  const { lookup } = fixture();
  const evidence = await lookup(supplied);
  assert.ok(evidence);
  const before = copy(supplied), enriched = buildRequestedVersionEvidenceRequest(supplied, evidence);
  for (const [key, value] of Object.entries(supplied)) assert.deepEqual(enriched[key], value, key);
  assert.equal(enriched.durationMs, undefined, "a supplied duration representation stays authoritative");
  assert.equal(enriched.beatportTrackId, undefined);
  assert.equal(enriched.requestedVersionEvidence.track.id, detail.id);
  enriched.custom.untouched = false;
  enriched.requestedVersionEvidence.track.artist = "mutated";
  assert.deepEqual(supplied, before);
  assert.equal(evidence.track.artist, "Makebo");
});

test("builder rejects forged/conflicting evidence rather than trusting lookup provenance fields", async () => {
  const evidence = await fixture().lookup(request);
  for (const changed of [{ ...evidence, provider: "tidal" }, { ...evidence, checkedAt: "invalid" },
    { ...evidence, sourceUrl: "https://www.beatport.com/track/999" },
    { ...evidence, track: { ...evidence.track, mixName: "Radio Edit" } },
    { ...evidence, track: { ...evidence.track, artists: [{ name: "Different" }] } }])
    assert.equal(buildRequestedVersionEvidenceRequest(request, changed), null);
  assert.equal(buildRequestedVersionEvidenceRequest({ ...request, isrc: "GBLV62602096" }, evidence), null);
});

test("all supplied ISRC and release aliases are checked and preserved without preferred-field shadowing", async () => {
  const evidence = await fixture().lookup(request);
  for (const change of [{ ISRC: "GBLV62602096" }, { isrc: detail.isrc, ISRC: "GBLV62602096" },
    { releaseTitle: "Other Release" }, { release: { title: "Other Release" } },
    { release_date: "2025-01-01" }, { releaseDate: detail.releaseDate, release_date: "2025-01-01" }, { year: 2025 }]) {
    const supplied = { ...request, ...change };
    assert.equal(await fixture().lookup(supplied), null, JSON.stringify(change));
    assert.equal(buildRequestedVersionEvidenceRequest(supplied, evidence), null, JSON.stringify(change));
  }
  for (const change of [{ ISRC: "gb-lv6-26-02095" }, { releaseTitle: "From Zero" },
    { release: { title: "From Zero" } }, { release_date: "2026-10-08" }]) {
    const supplied = { ...request, ...change }, enriched = buildRequestedVersionEvidenceRequest(supplied, evidence);
    assert.ok(enriched);
    for (const [key, value] of Object.entries(change)) assert.deepEqual(enriched[key], value);
    if (change.ISRC) assert.equal(enriched.isrc, undefined);
    if (change.releaseTitle || change.release) assert.equal(enriched.album, undefined);
    if (change.release_date) assert.equal(enriched.releaseDate, undefined);
  }
});

test("a provider response exceeding the declared page cap fails closed", async () => {
  const { lookup, calls } = fixture({ rows: Array.from({ length: 21 }, () => copy(detail)) });
  assert.equal(await lookup(request), null);
  assert.equal(calls.length, 1);
});

test("logical provider calls are bounded and no detail lookup follows an empty or failed search", async () => {
  for (const search of [async () => ({ tracks: [] }), async () => { throw new Error("private provider failure"); }]) {
    const { lookup, calls } = fixture({ search });
    assert.equal(await lookup(request), null);
    assert.equal(calls.length, 1);
  }
  const { lookup, calls } = fixture({ get: async () => { throw new Error("private detail failure"); } });
  assert.equal(await lookup(request), null);
  assert.equal(calls.length, 2);
});

test("positive and negative caches expire at their declared bounds and return detached values", async () => {
  let now = 1791564000000;
  const { lookup, calls } = fixture({ clock: () => now });
  const first = await lookup(request);
  first.track.artist = "mutated";
  assert.equal((await lookup(request)).track.artist, "Makebo");
  assert.equal(calls.length, 2);
  now += 600000;
  assert.ok(await lookup(request));
  assert.equal(calls.length, 4);
  const negative = fixture({ rows: [], clock: () => now });
  assert.equal(await negative.lookup(request), null);
  now += 59999;
  assert.equal(await negative.lookup(request), null);
  assert.equal(negative.calls.length, 1);
  now += 1;
  assert.equal(await negative.lookup(request), null);
  assert.equal(negative.calls.length, 2);
});

test("cache keys include all supplied facts and equivalent key ordering shares a flight", async () => {
  const { lookup, calls } = fixture();
  await Promise.all([lookup(request), lookup({ title: request.title, artist: request.artist })]);
  assert.equal(calls.length, 2);
  for (const change of [{ isrc: detail.isrc }, { durationMs: detail.durationMs }, { album: detail.album },
    { label: detail.label }, { releaseDate: detail.releaseDate }, { id: "565212426" }, { custom: { distinct: true } }])
    assert.ok(await lookup({ ...request, ...change }));
  assert.equal(calls.length, 16);
});

test("cache holds at most 256 request entries", async () => {
  const { lookup, calls } = fixture({ rows: [] });
  for (let entry = 0; entry < 257; entry += 1) assert.equal(await lookup({ ...request, entry }), null);
  assert.equal(calls.length, 257);
  await lookup({ ...request, entry: 256 });
  assert.equal(calls.length, 257);
  await lookup({ ...request, entry: 0 });
  assert.equal(calls.length, 258, "oldest request was evicted");
});

test("already aborted requests make no provider call", async () => {
  const { lookup, calls } = fixture();
  const controller = new AbortController(); controller.abort();
  assert.equal(await lookup(request, { signal: controller.signal }), null);
  assert.deepEqual(calls, []);
});

test("abort during search returns promptly and a late search result cannot launch detail or poison the cache", async () => {
  const pending = deferred(), entered = deferred();
  let delayed = true;
  const { lookup, calls } = fixture({ search: async () => { if (delayed) { entered.resolve(); return pending.promise; } return { tracks: [copy(detail)] }; } });
  const controller = new AbortController(), result = lookup(request, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.equal(await result, null);
  pending.resolve({ tracks: [copy(detail)] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  delayed = false;
  assert.ok(await lookup(request));
  assert.equal(calls.length, 3);
});

test("one caller abort cannot cancel another caller's shared provider lookup", async () => {
  const pending = deferred(), entered = deferred();
  const { lookup, calls } = fixture({ search: async () => { entered.resolve(); return pending.promise; } });
  const controller = new AbortController();
  const canceled = lookup(request, { signal: controller.signal }), live = lookup(request);
  await entered.promise; controller.abort();
  assert.equal(await canceled, null);
  pending.resolve({ tracks: [copy(detail)] });
  assert.ok(await live);
  assert.equal(calls.length, 2);
  assert.ok(await lookup(request));
  assert.equal(calls.length, 2);
});

test("abort during detail discards the late result and leaves no cached evidence", async () => {
  const pending = deferred(), entered = deferred();
  let delayed = true;
  const { lookup, calls } = fixture({ get: async () => { if (delayed) { entered.resolve(); return pending.promise; } return copy(detail); } });
  const controller = new AbortController(), result = lookup(request, { signal: controller.signal });
  await entered.promise; controller.abort();
  assert.equal(await result, null);
  pending.resolve(copy(detail)); await new Promise(resolve => setImmediate(resolve));
  delayed = false;
  assert.ok(await lookup(request));
  assert.equal(calls.length, 4);
});
