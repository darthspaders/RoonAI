"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const { normalizeBeatportTrack } = require("../src/beatportClient"), source = require("../src/sonicCatalogVerifiedSource");
const collector = require("../src/sonicCatalogVerifiedContinuationCollector"), runtime = require("../scripts/sonic-catalog-scout-verified-continuation");
const clone = structuredClone, hash = value => createHash("sha256").update(value).digest("hex");
function fixture() {
  const originals = new Map(), audio = new Map(), pages = [], calls = { metadata: 0, search: [], detail: [], preview: [], save: [] };
  for (const genreId of ["91", "92"]) for (const page of [2, 3, 4]) {
    const genreName = genreId === "91" ? "Bass House" : "Techno (Raw / Deep / Hypnotic)", start = genreId === "91" ? 1000 : 2000;
    const rows = Array.from({ length: 100 }, (_, i) => {
      const id = String(start + (page - 2) * 100 + i), raw = { id, name: "Source " + id, mix_name: "Original Mix", artists: [{ id: String(100000 + Number(id)), name: "Artist " + id }],
        genre: { id: genreId, name: genreName }, release: { id: String(500000 + Number(id)), name: "Album " + id, label: { name: "Label " + id }, publish_date: "2020-01-01" },
        isrc: "GBKQU20" + id.padStart(5, "0"), length_ms: 360000, bpm: 128, sample_url: "https://private-fixture.invalid/preview?secret=" + id };
      originals.set(id, raw); const n = normalizeBeatportTrack(raw), row = { id: n.id, artist: n.artist, title: n.title, genreId, genre: n.genre, artistIds: n.artistIds,
        releaseId: n.releaseId, album: n.album, releaseDate: n.releaseDate.slice(0, 10) };
      for (const key of ["mixName", "isrc", "label", "subGenre", "bpm", "durationMs"]) if (n[key] !== undefined && n[key] !== null && n[key] !== "") row[key] = n[key];
      row.catalogRecordKey = hash(JSON.stringify(row)); return row;
    }); pages.push({ pageKey: genreId + ":catalogue:" + page, genreId, genreName, feed: "catalogue", page, perPage: 100, maxPages: 1, status: "ready", rows, rejected: {}, conflictingTrackIds: [] });
  }
  const canonical = id => { const raw = originals.get(id); return { identityKey: "tidal:" + (1000000 + Number(id)), id: String(1000000 + Number(id)), tidalId: String(1000000 + Number(id)),
    artist: raw.artists[0].name, title: raw.name, ...(id === "1000" ? {} : { mixVersion: raw.mix_name }), album: raw.release.name, label: raw.release.label.name,
    isrc: raw.isrc, durationMs: raw.length_ms, releaseDate: "2020-01-01", year: 2020 }; };
  const entries = pages[0].rows.slice(0, 5).map(row => { const track = canonical(row.id), bytes = Buffer.from("audio-" + row.id), frozen = source.freezeSonicSourceSnapshot({ track,
    sourceTrack: row, sourceType: "beatport-preview", allowVersionProxy: false, audioBytes: bytes, durationSeconds: 120 });
    const sourceFile = "private/" + frozen.sourceSha256 + ".audio"; audio.set(sourceFile, bytes);
    return { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) }, source: frozen, sourceFile,
      metadata: { query: "Beatport genre 91 catalogue page 2", discoverySource: "verified Beatport genre catalogue resolved to canonical TIDAL", discoveryLane: "core", beatportGenre: "Bass House", label: row.label, bpm: row.bpm } }; });
  const catalogProvenance = entries.map((entry, i) => ({ identityKey: entry.track.identityKey, beatportTrackId: pages[0].rows[i].id, sourceSnapshotKey: entry.source.snapshotKey,
    genreId: "91", genreName: "Bass House", artistIds: pages[0].rows[i].artistIds, pageKey: "91:catalogue:2" }));
  const breadth = entries.map((entry, i) => ({ identityKey: entry.track.identityKey, beatportTrackId: pages[0].rows[i].id, sourceSnapshotKey: entry.source.snapshotKey,
    genreId: "91", beatportReleaseId: pages[0].rows[i].releaseId, beatportAlbum: pages[0].rows[i].album, canonicalAlbumFamily: "album " + pages[0].rows[i].id, artistIds: pages[0].rows[i].artistIds }));
  const attempts = pages[0].rows.slice(0, 21).map((row, i) => ({ beatportTrackId: row.id, genreId: "91", pageKey: "91:catalogue:2", requestId: "bass-house-" + (i === 0 ? 1 : 2), role: i < 2 ? "anchor" : "candidate",
    status: i < 5 ? entries[i].source.version === 2 ? "frozen-verified" : "frozen-exact" : "unavailable", stage: i < 5 ? "complete" : "identity", tidalQueries: [], canonicalLookups: [],
    ...(i < 5 ? { identityKey: entries[i].track.identityKey } : { reason: "no-exact-canonical-recording" }) }));
  Object.assign(attempts.at(-1), { stage: "persistence", reason: "private-checkpoint-replace-interrupted" });
  const seed = { version: 1, kind: "catalog-scout-verified-original-descriptive-fit", requestSha256: "a".repeat(64), cutoffDate: "2026-10-08", pages, attempts, entries, catalogProvenance, breadth,
    genres: [{ genreId: "91", genreName: "Bass House", anchorIdentityKeys: entries.slice(0, 2).map(entry => entry.track.identityKey), candidateIdentityKeys: entries.slice(2).map(entry => entry.track.identityKey) },
      { genreId: "92", genreName: "Techno (Raw / Deep / Hypnotic)", anchorIdentityKeys: [], candidateIdentityKeys: [] }], closed: true, complete: false };
  const seedBytes = Buffer.from(JSON.stringify(seed)), request = { version: 1, recipe: { ...collector.CONTINUATION_COLLECTOR_RECIPE }, requests: clone(collector.CONTINUATION_COLLECTOR_REQUESTS),
    excludedBeatportTrackIds: [...attempts.map(row => row.beatportTrackId), ...Array.from({ length: 481 }, (_, i) => String(10000 + i))], excluded: entries.map(entry => entry.track), excludedSourceSha256: entries.map(entry => entry.source.sourceSha256),
    heldOut: Array.from({ length: 6 }, (_, i) => ({ identityKey: "tidal:" + (i + 1), artist: "Heldout " + i, title: "Heldout " + i })), continuationSeed: { file: "private/seed.json", sha256: hash(seedBytes) } };
  let last = null;
  const deps = { request, seedBytes, requestSha256: hash(JSON.stringify(request)), now: () => "2026-10-08T01:00:00.000Z",
    beatport: { pagedTracks: async () => { calls.metadata++; throw Error("Metadata cannot be fetched again"); }, fetchPreviewBuffer: async row => { calls.preview.push(row.id); return Buffer.from("audio-" + row.id); } },
    tidal: { searchTracks: async query => { const id = query.match(/source (\d+)/i)?.[1]; calls.search.push(id); return id ? [canonical(id)] : []; },
      getTrack: async id => { calls.detail.push(id); return canonical(String(Number(id) - 1000000)); } },
    saveAudio: async (bytes, info) => { calls.save.push(info.beatportTrackId); const file = "private/" + hash(bytes) + ".audio"; audio.set(file, bytes); return file; },
    probeDuration: async () => 120, persistProgress: async progress => { last = clone(progress); } };
  return { seed, seedBytes, request, deps, calls, canonical, originals, audio, getLast: () => last };
}
test("carries five unchanged sources and twenty-one receipts, freezes old pages and only collects eleven new sources", async () => {
  const f = fixture(), before = clone(f.seed), result = await collector.collectSonicCatalogVerifiedContinuationPool(f.deps);
  assert.equal(result.complete, true); assert.equal(result.pool.entries.length, 16); assert.equal(result.progress.attempts.length, 32); assert.equal(f.calls.metadata, 0);
  assert.equal(f.calls.preview.length, 11); assert.equal(f.calls.save.length, 11); assert.ok(f.calls.search.every(id => !f.seed.attempts.some(old => old.beatportTrackId === id)));
  assert.deepEqual(result.progress.entries.slice(0, 5), f.seed.entries); assert.deepEqual(result.progress.attempts.slice(0, 21), f.seed.attempts); assert.deepEqual(result.progress.pages, f.seed.pages); assert.deepEqual(f.seed, before);
  assert.equal(result.progress.entries[0].source.version, 2); assert.equal(result.progress.genres[0].candidateIdentityKeys.length, 6); assert.equal(result.progress.genres[1].candidateIdentityKeys.length, 6);
  assert.ok(collector.validateVerifiedCollectionBreadth(result.progress).complete); assert.ok(collector.validateContinuationExclusions(result.pool, f.request, f.seed));
});
test("hashed seed, prior receipts and five carryover exceptions cannot be altered or omitted", async () => {
  const f = fixture(); await assert.rejects(collector.collectSonicCatalogVerifiedContinuationPool({ ...f.deps, seedBytes: Buffer.from(JSON.stringify({ ...f.seed, closed: false })) }), /seed bytes changed/);
  const request = clone(f.request); request.excludedBeatportTrackIds = request.excludedBeatportTrackIds.filter(id => id !== "1000");
  await assert.rejects(collector.collectSonicCatalogVerifiedContinuationPool({ ...f.deps, request }), /prior attempts/); assert.equal(f.calls.search.length, 0);
  const result = await collector.collectSonicCatalogVerifiedContinuationPool(f.deps), altered = clone(result.progress); altered.attempts[20].reason = "fabricated";
  await assert.rejects(collector.collectSonicCatalogVerifiedContinuationPool({ ...f.deps, progress: altered }), /Prior attempts changed/);
});
test("the review view removes exactly five carryover exceptions while all five source proofs remain enforced", async () => {
  const f = fixture(), view = collector.continuationReviewRequest(f.request, f.seed);
  assert.equal(f.request.excludedBeatportTrackIds.length, 502); assert.equal(view.excludedBeatportTrackIds.length, 497); assert.equal(view.carryoverExceptions.length, 5);
  assert.equal(view.excluded.length, 0); assert.equal(view.excludedSourceSha256.length, 0); assert.deepEqual(view.heldOut, f.request.heldOut);
  const result = await collector.collectSonicCatalogVerifiedContinuationPool(f.deps), pool = clone(result.pool); pool.entries[0].source.spans[0][0]++;
  assert.throws(() => collector.validateContinuationExclusions(pool, f.request, f.seed), /Carryover source changed/);
});
test("attempt caps include all twenty-one seed attempts and exclude every fresh prior ID", async () => {
  const f = fixture(); f.deps.tidal.searchTracks = async query => { f.calls.search.push(query.match(/source (\d+)/i)?.[1]); return []; };
  const result = await collector.collectSonicCatalogVerifiedContinuationPool(f.deps); assert.equal(result.complete, false); assert.equal(result.pool, null);
  assert.equal(result.progress.attempts.length, 160); assert.equal(result.progress.attempts.filter(row => row.genreId === "91").length, 80);
  assert.equal(result.progress.attempts.filter(row => row.genreId === "92").length, 80); assert.equal(result.progress.attempts.length - 21, 139); assert.equal(f.calls.metadata, 0);
  assert.ok(!result.progress.attempts.slice(21).some(row => f.request.excludedBeatportTrackIds.includes(row.beatportTrackId)));
});
test("fresh canonical changes preserve seed entries and exact gates block new duplicate recordings before audio", async () => {
  const f = fixture(), get = f.deps.tidal.getTrack; f.deps.tidal.getTrack = async id => { const track = await get(id); if (id === "1001021") track.isrc = "CONFLICT"; return track; };
  const result = await collector.collectSonicCatalogVerifiedContinuationPool(f.deps); assert.equal(result.complete, true); assert.ok(!f.calls.preview.includes("1021")); assert.deepEqual(result.progress.entries.slice(0, 5), f.seed.entries);
});
test("closed continuation replay makes no source calls and frozen metadata tampering is rejected", async () => {
  const f = fixture(), result = await collector.collectSonicCatalogVerifiedContinuationPool(f.deps), calls = clone(f.calls);
  assert.deepEqual(await collector.collectSonicCatalogVerifiedContinuationPool({ ...f.deps, progress: result.progress }), result); assert.deepEqual(f.calls, calls);
  const altered = clone(result.progress); altered.pages[0].rows[90].isrc = "changed";
  await assert.rejects(collector.collectSonicCatalogVerifiedContinuationPool({ ...f.deps, progress: altered })); assert.deepEqual(f.calls, calls);
});
test("preview locator detail must preserve all frozen descriptors and only follows fresh canonical admission", async () => {
  const f = fixture(), row = f.seed.pages[0].rows[21], raw = f.originals.get(row.id), providerCalls = [], ledger = { newLocatorDetails: [], newPreviewCalls: 0 };
  const progress = { attempts: [{ beatportTrackId: row.id, stage: "preview", canonicalLookups: [{ status: "verified", admission: { accepted: true } }] }] };
  const facade = runtime.continuationBeatportFacade({ getTrackById: async id => { providerCalls.push("detail:" + id); return normalizeBeatportTrack(raw); },
    fetchPreviewBuffer: async track => { providerCalls.push("preview:" + track.id); assert.match(track.previewUrl, /^https:/); return Buffer.from("fixture"); } },
    { request: f.request, seed: f.seed, ledger, persist() {}, getProgress: () => progress });
  await facade.fetchPreviewBuffer(row, {}); assert.deepEqual(providerCalls, ["detail:1021", "preview:1021"]);
  assert.doesNotMatch(JSON.stringify(ledger), /https?:|secret|previewUrl/);
  const conflicting = clone(raw); conflicting.isrc = "WRONG"; assert.throws(() => collector.validateLocatorDetail(row, normalizeBeatportTrack(conflicting), f.seed.cutoffDate), /diverged/);
  await assert.rejects(facade.fetchPreviewBuffer(f.seed.pages[0].rows[0], {}), /Prior attempted IDs/);
  progress.attempts[0].canonicalLookups = []; await assert.rejects(facade.fetchPreviewBuffer(row, {}), /canonical admission/);
});
test("combined transport ledgers retain prior physical counts without mutating original histories", () => {
  const prior = { priorTransportCalls: 0, refreshAttempts: 0, transport: Array.from({ length: 11 }, () => ({ status: 200 })),
    tidalTransport: [{ kind: "search", status: 200 }], tidalRawTransport: [{ kind: "authentication", status: 200 }, { kind: "search", status: 200 }], previewCalls: 5 }, before = clone(prior);
  const ledger = runtime.seedTransportLedger(prior, { refreshAttempts: 1, transport: [{ status: 200 }] });
  assert.equal(ledger.priorTransportCalls, 12); assert.equal(ledger.previewCalls, 5); assert.equal(ledger.priorTidalApiCalls, 1); assert.equal(ledger.priorTidalAuthenticationCalls, 1);
  ledger.tidalRawTransport.push({ kind: "detail", status: 200 }); assert.deepEqual(prior, before); assert.equal(ledger.newMetadataCalls, 0);
});
test("private checkpoint errors record only safe codes and retained-checkpoint facts", () => {
  const error = Object.assign(new Error("raw token https://private.invalid"), { code: "PRIVATE_JSON_REPLACE_FAILED", filesystemCode: "EPERM", renameAttempts: 5, checkpointRetained: true });
  assert.deepEqual(runtime.safeOperationalError(error), { kind: "private-persistence", code: "PRIVATE_JSON_REPLACE_FAILED", filesystemCode: "EPERM", renameAttempts: 5, checkpointRetained: true });
  assert.doesNotMatch(JSON.stringify(runtime.safeOperationalError(error)), /raw token|https?:|private.invalid/);
});
