"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { captureTidalEvidence, captureProviderEvidence, combineSourceEvidence } = require("../src/providerSourceEvidence");
const { providerResultToEntry } = require("../src/metadataEnrichmentService");
const { TidalVerifier } = require("../src/tidalVerifier");
const { MusicMemoryStore } = require("../src/musicMemoryStore");

function document() {
  const track = { id: "123", type: "tracks", attributes: { title: "Song", version: "Radio Edit", duration: "PT3M", trackNumber: 4, volumeNumber: 2 }, relationships: { albums: { data: [{ type: "albums", id: "456" }] }, artists: { data: [{ type: "artists", id: "guest" }] } } };
  const album = { id: "456", type: "albums", attributes: { title: "Album Deluxe", albumType: "ALBUM", version: "Deluxe", releaseDate: "2024-01-02", originalReleaseDate: "2000-01-02", numberOfItems: 18, numberOfVolumes: 2, barcodeId: "0123456789012" }, relationships: { artists: { data: [{ type: "artists", id: "primary" }] } } };
  return { data: track, included: [album, { id: "primary", type: "artists", attributes: { name: "Band & Name" } }, { id: "guest", type: "artists", attributes: { name: "Featured Singer" } }, { id: "irrelevant", type: "tracks", attributes: { title: "Other search result" } }] };
}

test("TIDAL evidence preserves exact release ID, primary credits, edition, dates and positions separately", () => {
  const raw = document(), evidence = captureTidalEvidence(raw.data, raw.included[0], raw);
  assert.equal(evidence.providerTrackId, "123");
  assert.equal(evidence.release.id, "456");
  assert.equal(evidence.release.type, "ALBUM");
  assert.equal(evidence.release.credits[0].name, "Band & Name");
  assert.equal(evidence.trackCredits[0].name, "Featured Singer");
  assert.equal(evidence.release.originalReleaseDate, "2000-01-02");
  assert.equal(evidence.release.releaseDate, "2024-01-02");
  assert.equal(evidence.release.trackCount, 18);
  assert.equal(evidence.release.edition, "Deluxe");
  assert.deepEqual(evidence.membership, { state: "OBSERVED", disc: 2, position: 4, sequence: 4 });
  assert.ok(!evidence.raw.included.some(item => item.id === "irrelevant"));
});

test("missing album artist/version/position stays unknown and multiple releases stay ambiguous", () => {
  const raw = document();
  raw.data.relationships.albums.data.push({ type: "albums", id: "other-edition" });
  const evidence = captureTidalEvidence(raw.data, {}, raw);
  assert.deepEqual(evidence.release.credits, []);
  assert.equal(evidence.release.id, "");
  assert.equal(evidence.release.edition, "");
  assert.deepEqual(evidence.ambiguities, ["multiple-provider-release-references"]);
  assert.equal(captureTidalEvidence().membership.position, null);
});

test("recording IDs, release IDs and provider track namespaces are not interchangeable", () => {
  const tidal = captureProviderEvidence("tidal", { id: "12", releaseId: "34" })[0];
  const beatport = captureProviderEvidence("beatport", { id: "12", releaseId: "34" })[0];
  const mb = captureProviderEvidence("musicbrainz", { recordingId: "recording", releaseId: "release" })[0];
  const discogs = captureProviderEvidence("discogs", { id: "34", releaseId: "34" })[0];
  assert.notEqual(tidal.provider, beatport.provider);
  assert.equal(mb.recordingId, "recording");
  assert.equal(mb.providerTrackId, "");
  assert.equal(discogs.providerTrackId, "");
  assert.equal(discogs.objectKind, "release-appearance-claim");
  const combined = combineSourceEvidence({ sourceEvidence: [tidal] }, { sourceEvidence: [beatport, tidal] });
  assert.equal(combined.length, 2);
});

test("fresh exact TIDAL detail carries source evidence through metadata and SQLite without changing legacy grouping fields", async t => {
  const raw = document();
  const verifier = new TidalVerifier({ enabled: true, accessToken: "test", fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => raw }) });
  const result = await verifier.getTrack("123");
  assert.equal(result.id, "123");
  assert.equal(result.album, "Album Deluxe");
  assert.equal(result.sourceEvidence[0].release.id, "456");
  const track = { tidalId: "123", artist: result.artist, title: result.title, album: result.album };
  const entry = providerResultToEntry(track, result, "tidal", { confidence: 99, reason: "exact" });
  assert.equal(entry.id, "123");
  assert.equal(entry.releaseId, undefined);
  assert.equal(entry.sourceEvidence[0].originalVersion, "Radio Edit");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-evidence-"));
  const store = new MusicMemoryStore({ dbFile: path.join(directory, "db.sqlite"), logger: null });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  store.saveProviderEnrichment(track, "tidal", entry);
  const row = store.db.prepare("SELECT * FROM provider_enrichment").get();
  assert.equal(row.provider_track_id, "123");
  assert.equal(row.release_id, "");
  assert.equal(JSON.parse(row.raw_json).sourceEvidence[0].release.id, "456");
});
