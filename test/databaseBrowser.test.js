"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { SonicEmbeddingStore, encodeVector } = require("../src/sonicEmbeddingStore");
const { readCatalog, browseCatalog, safeImage } = require("../src/databaseBrowserCatalog");
const { DatabaseBrowserService } = require("../src/databaseBrowserService");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-database-browser-"));
  const dbFile = path.join(directory, "catalog.sqlite");
  const memory = new MusicMemoryStore({ dbFile, logger: null });
  const sonic = new SonicEmbeddingStore({ dbFile, logger: null });
  const tracks = [
    { tidalId: "101", artist: "Ária", title: "Solar", album: "Night Moves", durationMs: 360000 },
    { tidalId: "102", artist: "Beta", title: "Moon", album: "Night Moves", durationMs: 480000 },
    { tidalId: "103", artist: "Ária", title: "Solar (Remix)", album: "Remixed", durationMs: 300000 },
    { tidalId: "104", artist: "Delta", title: "Elsewhere" },
    { tidalId: "105", artist: "Country Artist", title: "Home", album: "Night Moves" }
  ];
  for (const track of tracks) memory.rememberObservation(track, "discovery_history");
  for (const [index, track] of tracks.slice(0, 3).entries()) memory.saveBeatportEnrichment(track, {
    id: String(500 + index), genre: index === 2 ? "Techno" : "Progressive House", label: "Test Label",
    bpm: 120 + index * 4, album: track.album, releaseId: index === 2 ? "9002" : "9001", releaseDate: `${2020 + index}-06-01`,
    rawJson: { image: { uri: "https://geo-media.beatport.com/image_size/1500x250/banner.jpg" }, release: { image: { uri: `https://geo-media.beatport.com/image_size/1400x1400/cover-${index}.jpg` } } }
  });
  memory.saveProviderEnrichment(tracks[0], "tidal", { fetchedAt: "2024-01-01", genre: "HIRES_LOSSLESS, LOSSLESS", tags: ["warm", "LOSSLESS"], rawJson: { imageUrl: "https://example.com/old.jpg" } });
  memory.saveProviderEnrichment(tracks[0], "tidal", { fetchedAt: "2025-01-01", genre: "HIRES_LOSSLESS, LOSSLESS", tags: ["deep", "LOSSLESS"], rawJson: { imageUrl: "https://example.com/current.jpg" } });
  memory.saveProviderEnrichment(tracks[4], "discogs", { genre: "Folk, World, & Country", tags: ["Folk, World, & Country"] });
  memory.saveTasteFeedback(tracks[0], { rating: "love", createdAt: "2024-01-01" });
  memory.saveTasteFeedback(tracks[0], { rating: "like", createdAt: "2025-01-01" });
  memory.saveTasteFeedback(tracks[1], { rating: "up", createdAt: "2025-01-01" });
  memory.saveTasteFeedback(tracks[2], { rating: "wrong genre", createdAt: "2025-01-01" });
  sonic.upsertEmbedding({ track: tracks[0], model: "discogs-effnet", modelVersion: "1", vector: Array(1280).fill(.25) });
  sonic.upsertEmbedding({ track: tracks[1], model: "other-model", modelVersion: "1", vector: Array(1280).fill(.25) });
  sonic.upsertEmbedding({ track: tracks[2], model: "discogs-effnet", modelVersion: "1", vector: Array(1280).fill(.25) });
  sonic.db.prepare("UPDATE track_sonic_profile SET embedding_base64 = ? WHERE identity_key = ?").run(encodeVector(Array(1280).fill(0)), "tidal:103");
  sonic.saveSonicAnchorProfile({ anchor: tracks[0], tags: ["hypnotic", "rolling"], mood: "dark", note: "Existing listening note" });
  sonic.saveSonicNeighborFeedback({ anchor: tracks[0], candidate: tracks[3], rating: "keep" });
  memory.db.exec("CREATE TABLE sonic_review_session_item (candidate_identity_key TEXT, decision TEXT)");
  memory.db.prepare("INSERT INTO sonic_review_session_item VALUES (?, ?)").run("tidal:102", "KEEP");
  t.after(() => { sonic.close(); memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { dbFile, memory, sonic, tracks, snapshot: () => readCatalog(memory.db) };
}

test("catalog preserves exact identities and latest metadata, artwork, and rating", t => {
  const { snapshot } = fixture(t);
  const result = browseCatalog(snapshot(), { view: "tracks", q: "aria solar" });
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(track => track.tidalId).sort(), ["101", "103"]);
  const track = result.items.find(track => track.tidalId === "101");
  assert.equal(track.rating, "like");
  assert.equal(track.imageUrl, "https://example.com/current.jpg");
  assert.ok(track.tags.includes("deep"));
  assert.ok(!track.tags.includes("warm"));
  assert.ok(!track.tags.includes("LOSSLESS"));
  assert.equal(track.identityKey, "tidal:101");
  assert.equal(result.items.find(track => track.tidalId === "103").imageUrl, "https://geo-media.beatport.com/image_size/300x300/cover-2.jpg");
  assert.ok(!JSON.stringify(result).includes("embedding_base64"));
  assert.ok(!JSON.stringify(result).includes("searchText"));
});

test("combined facets use OR within a facet, AND between facets, and count alternatives", t => {
  const { snapshot } = fixture(t);
  const result = browseCatalog(snapshot(), { view: "tracks", rating: ["like", "good"], genre: "Progressive House", bpmMin: 121 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].tidalId, "102");
  assert.equal(result.facets.rating.find(item => item.value === "good").count, 1);
  assert.equal(browseCatalog(snapshot(), { view: "tracks", rating: "wrong_genre" }).items[0].tidalId, "103");
  assert.equal(browseCatalog(snapshot(), { view: "tracks", q: "' OR 1=1 --" }).total, 0);
});

test("compound genre names survive, and format flags are not music genres", t => {
  const { snapshot } = fixture(t);
  const result = browseCatalog(snapshot());
  assert.ok(result.items.some(item => item.name === "Folk, World, & Country"));
  assert.ok(!result.items.some(item => /LOSSLESS|^& Country$/.test(item.name)));
});

test("Sonic presence requires valid matching embeddings and remains distinct from reviews", t => {
  const { snapshot } = fixture(t);
  const stored = browseCatalog(snapshot(), { view: "tracks", sonic: "embedded" });
  assert.deepEqual(stored.items.map(track => track.tidalId), ["101"]);
  assert.equal(stored.items[0].sonicReviewed, false);
  const reviewed = browseCatalog(snapshot(), { view: "tracks", sonic: "reviewed" });
  assert.deepEqual(reviewed.items.map(track => track.tidalId).sort(), ["102", "104"]);
  assert.ok(reviewed.items.every(track => track.sonicEmbedded === false));
  assert.equal(browseCatalog(snapshot(), { view: "tracks", sonicTag: "hypnotic" }).total, 1);
  assert.equal(browseCatalog(snapshot(), { view: "tracks", sonic: "missing" }).total, 4);
});

test("album grouping uses explicit release identity without merging unrelated album names", t => {
  const { snapshot } = fixture(t);
  const data = snapshot();
  const result = browseCatalog(data, { view: "albums" });
  assert.equal(result.total, 3);
  assert.equal(result.missingAlbumCount, 1);
  const compilation = result.items.find(item => item.value === "beatport-album:9001");
  assert.equal(compilation.count, 2);
  assert.equal(compilation.artist, "Various artists");
  const drilldown = browseCatalog(data, { view: "tracks", album: compilation.value });
  assert.deepEqual(drilldown.items.map(track => track.tidalId).sort(), ["101", "102"]);
});

test("numeric ranges exclude unknown values and sort/pagination stays stable", t => {
  const { snapshot } = fixture(t);
  const data = snapshot();
  const filtered = browseCatalog(data, { view: "tracks", yearMin: 2020, yearMax: 2022, durationMin: 5, durationMax: 6 });
  assert.equal(filtered.total, 2);
  const first = browseCatalog(data, { view: "tracks", sort: "bpm", direction: "desc", limit: 2 });
  const second = browseCatalog(data, { view: "tracks", sort: "bpm", direction: "desc", limit: 2, offset: 2 });
  assert.deepEqual(first.items.map(track => track.tidalId), ["103", "102"]);
  assert.ok(!second.items.some(track => first.items.some(other => other.id === track.id)));
  const last = browseCatalog(data, { view: "tracks", limit: 2, offset: 99999 });
  assert.equal(last.offset, 4);
  assert.equal(last.items.length, 1);
});

test("unsafe or non-cover URLs cannot become album thumbnails", () => {
  assert.equal(safeImage("javascript:alert(1)"), "");
  assert.equal(safeImage("file:///C:/secret.jpg"), "");
  assert.equal(safeImage("https://user:password@example.com/art.jpg"), "");
  assert.equal(safeImage("https://geo-media.beatport.com/image_size/1500x250/banner.jpg"), "");
});

test("coverage follows stored exact resolutions and aliases without guessing by title", t => {
  const { memory, sonic, tracks, snapshot } = fixture(t);
  const alias = { artist: tracks[0].artist, title: tracks[0].title };
  memory.rememberObservation(alias, "now_playing");
  memory.db.exec("CREATE TABLE sonic_coverage_work (identity_key TEXT, resolved_identity_key TEXT, state TEXT)");
  const aliasIdentity = memory.db.prepare("SELECT identity_key FROM track_identity WHERE tidal_id = '' AND title = ?").get(alias.title);
  memory.db.prepare("INSERT INTO sonic_coverage_work VALUES (?, ?, ?)").run(aliasIdentity.identity_key, "tidal:101", "prepared");
  const result = browseCatalog(snapshot(), { view: "tracks", sonic: "embedded" });
  assert.equal(result.total, 2);
  assert.ok(result.items.every(track => track.sonicIdentityKey === "tidal:101"));
  memory.db.exec("UPDATE sonic_coverage_work SET state = 'failed'");
  assert.equal(browseCatalog(snapshot(), { view: "tracks", sonic: "embedded" }).total, 1);
  memory.linkTrackIdentity(alias, tracks[0], { source: "test-exact", confidence: 100 });
  assert.equal(browseCatalog(snapshot(), { view: "tracks", sonic: "embedded" }).total, 2);
  assert.equal(sonic.status().embeddingCount, 3);
});

test("unavailable Sonic data is not reported as missing embeddings", t => {
  const { memory } = fixture(t);
  const data = readCatalog(memory.db, null);
  assert.equal(data.sonicAvailable, false);
  assert.equal(browseCatalog(data, { view: "tracks", sonic: "missing" }).total, 0);
  assert.ok(browseCatalog(data, { view: "tracks" }).items.every(track => track.sonicEmbedded === null));
});

test("background browsing is read-only, keeps the parent responsive and supports details", async t => {
  const { dbFile, memory } = fixture(t);
  const before = memory.db.prepare("SELECT total_changes() AS count").get().count;
  const service = new DatabaseBrowserService({ dbFile });
  t.after(() => service.close());
  let yielded = false;
  let completed = false;
  const scheduled = new Promise(resolve => setImmediate(() => { yielded = true; resolve(); }));
  const first = service.browse(new URLSearchParams("view=tracks&rating=like&rating=good")).then(result => { completed = true; return result; });
  await scheduled;
  assert.equal(yielded, true);
  assert.equal(completed, false, "the parent can service other events while the reader is working");
  const result = await first;
  assert.equal(result.total, 2);
  const detail = await service.detail(result.items[0].id);
  assert.equal(detail.track.id, result.items[0].id);
  await assert.rejects(service.detail(999999), { statusCode: 404 });
  const simultaneous = await Promise.all([service.browse({ sonic: "missing" }), service.browse({ q: "solar" })]);
  assert.equal(simultaneous[0].matchingTracks, 4);
  assert.equal(memory.db.prepare("SELECT total_changes() AS count").get().count, before);
  assert.equal(memory.db.prepare("SELECT COUNT(*) AS n FROM taste_feedback").get().n, 4);
  await service.close();
});

test("disabled and missing databases report recoverable failures", async () => {
  const disabled = new DatabaseBrowserService({ enabled: false });
  await assert.rejects(disabled.browse(), { statusCode: 503 });
  const missing = new DatabaseBrowserService({ dbFile: path.join(os.tmpdir(), `missing-rabbit-${Date.now()}.sqlite`) });
  await assert.rejects(missing.browse(), { statusCode: 503 });
  await missing.close();
});

test("browse never creates Sonic decisions or modifies stored ratings", t => {
  const { memory, snapshot } = fixture(t);
  const before = memory.db.prepare("SELECT * FROM sonic_review_session_item").all();
  const ratings = memory.db.prepare("SELECT * FROM taste_feedback ORDER BY id").all();
  const data = snapshot();
  for (const view of ["tags", "albums", "tracks"]) browseCatalog(data, { view, sonic: "missing" });
  assert.deepEqual(memory.db.prepare("SELECT * FROM sonic_review_session_item").all(), before);
  assert.deepEqual(memory.db.prepare("SELECT * FROM taste_feedback ORDER BY id").all(), ratings);
});
