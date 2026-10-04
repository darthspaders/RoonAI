"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readSnapshot, buildReport } = require("../scripts/audit-recording-duplicates");
const { releaseFamily, editionMarkers, titleQuality, releaseEvidence, summarizeCard, compareCards, buildSourceInventory, readReleaseEvidence, buildReleaseReport } = require("../scripts/audit-release-identities");

function card(key, overrides = {}) {
  return { key, titles: ["Album"], normalizedTitles: ["album"], families: ["album"], artistStrings: ["Artist"], normalizedTrackArtistCredits: ["artist"], compatibleReleaseKeys: [key], allSourceReleaseKeys: [key], safeIsrcRows: {}, compatibleSourceDates: ["2020-01-01"], compatibleSourceLabels: ["label"], artworkUrls: [], labels: ["Label"], years: [2020], genres: [], editionMarkers: [], trackConflictRows: [], sourceDisplayIssues: [], ...overrides };
}

test("the deadmau5 album title is intentional, while an unverified placeholder remains only a suspicion", () => {
  assert.equal(titleQuality("> album title goes here <", ["deadmau5, Chris James"]), "verified-intentional-title");
  assert.equal(titleQuality("> album title goes here <", ["Other Artist"]), "suspect-placeholder-needs-review");
  assert.equal(titleQuality("Unknown", ["Artist"]), "suspect-placeholder-needs-review");
  assert.equal(titleQuality("", []), "missing-or-punctuation-only");
});

test("release family retrieval retains edition distinctions and compilation volume numbers", () => {
  assert.equal(releaseFamily("Album (Deluxe)"), "album");
  assert.equal(releaseFamily("Album EP"), "album");
  assert.equal(releaseFamily("Album (Special Edition)"), "album");
  assert.deepEqual(editionMarkers("Album (Deluxe)"), ["deluxe"]);
  assert.deepEqual(editionMarkers("Album (Special Edition)"), ["special edition"]);
  assert.notEqual(releaseFamily("Compilation Vol. 1"), releaseFamily("Compilation Vol. 2"));
  assert.notEqual(releaseFamily("Album Remixes"), releaseFamily("Album"));
});

test("normalization of a title alone is never sufficient for duplicate-release classification", () => {
  const result = compareCards(card("beatport-album:1"), card("beatport-album:2"), new Map());
  assert.equal(result.classification, "unresolved-release-relationship");
  assert.equal(result.overlap.completeAlbumTracklistsCompared, false);
});

test("provider namespaces prevent numeric ID collisions", () => {
  const result = compareCards(card("beatport-album:1"), card("tidal-album:1"), new Map());
  assert.deepEqual(result.sharedReleaseKeys, []);
  assert.equal(result.classification, "unresolved-release-relationship");
});

test("a common release ID exposes fragmented visible cards with different track credits", () => {
  const left = card("album:album|artist", { compatibleReleaseKeys: ["beatport-album:1"] });
  const right = card("album:album|artist, guest", { compatibleReleaseKeys: ["beatport-album:1"], artistStrings: ["Artist, Guest"], normalizedTrackArtistCredits: ["artist|guest"] });
  const result = compareCards(left, right, new Map());
  assert.equal(result.classification, "same-provider-release-fragments");
  assert.ok(result.flags.includes("same-title-different-track-artist-strings"));
});

test("different providers require several checked recording matches, compatible metadata and no conflicts", () => {
  const left = card("beatport-album:1", { safeIsrcRows: { GBABC2000001: [1], GBABC2000002: [2] } });
  const right = card("discogs-album:2", { safeIsrcRows: { GBABC2000001: [3], GBABC2000002: [4] } });
  const pairs = new Map([["1:3", { category: "exact_duplicate" }], ["2:4", { category: "different_release" }]]);
  const result = compareCards(left, right, pairs);
  assert.equal(result.classification, "different-provider-ids-duplicate-candidate");
  assert.equal(result.overlap.containmentOfSmallerObservedSubset, 1);
  assert.equal(compareCards(left, { ...right, trackConflictRows: [3] }, pairs).classification, "unresolved-release-relationship");
});

test("partial tracklist overlap is reported without pretending the full album was compared", () => {
  const left = card("beatport-album:1", { safeIsrcRows: { GBABC2000001: [1], GBABC2000002: [2] } });
  const right = card("beatport-album:2", { safeIsrcRows: { GBABC2000001: [3] } });
  const pair = compareCards(left, right, new Map([["1:3", { category: "exact_duplicate" }]]));
  assert.equal(pair.classification, "unresolved-release-relationship");
  assert.equal(pair.overlap.containmentOfSmallerObservedSubset, 1);
  assert.equal(pair.overlap.jaccard, 0.5);
  assert.ok(pair.flags.includes("overlapping-different-known-track-subsets"));
});

test("shared ISRC with a track version conflict is excluded from album overlap", () => {
  const left = card("beatport-album:1", { safeIsrcRows: { GBABC2000001: [1] } });
  const right = card("beatport-album:2", { safeIsrcRows: { GBABC2000001: [2] } });
  assert.deepEqual(compareCards(left, right, new Map([["1:2", { category: "version_mismatch" }]])).overlap.verifiedSharedIsrcs, []);
});

test("deluxe/reissue distinctions and compilations stay separate from source-duplicate proposals", () => {
  assert.equal(compareCards(card("1"), card("2", { titles: ["Album (Deluxe)"], normalizedTitles: ["album deluxe"], editionMarkers: ["deluxe"] }), new Map()).classification, "edition-variant-keep-separate");
  const compilation = card("2", { titles: ["Compilation"], normalizedTitles: ["compilation"], families: ["compilation"], allSourceReleaseKeys: ["1"] });
  assert.equal(compareCards(card("1"), compilation, new Map()).classification, "different-release-or-cross-release-enrichment");
});

test("album artist is extracted only from explicit release credits, not track artist guesses", () => {
  const bp = releaseEvidence({ track_identity_id: 1, release_id: "10", release_title: "Album", raw_json: JSON.stringify({ artists: [{ name: "Artist, Guest" }], release: { id: 10, name: "Album" } }) }, "beatport", "beatport_enrichment");
  assert.equal(bp.primaryArtistCredits, "");
  const discogs = releaseEvidence({ track_identity_id: 2, release_id: "20", release_title: "Album", raw_json: JSON.stringify({ artists: [{ name: "Artist" }], formats: [{ name: "CD", descriptions: ["Album", "Reissue"] }], tracklist: [{ position: "1", title: "Track" }], master_id: 40 }) }, "discogs", "provider_enrichment");
  assert.equal(discogs.primaryArtistCredits, "Artist");
  assert.equal(discogs.releaseFamilyId, "discogs-master:40");
  assert.equal(discogs.cachedReleaseTracklistAvailable, true);
  assert.ok(discogs.formats.includes("Reissue"));
});

test("hidden source edition descriptors prevent apparently identical cards becoming duplicate candidates", () => {
  const left = card("beatport-album:1", { safeIsrcRows: { GBABC2000001: [1], GBABC2000002: [2] }, sourceFamilyEditionMarkers: [] });
  const right = card("beatport-album:2", { safeIsrcRows: { GBABC2000001: [3], GBABC2000002: [4] }, sourceFamilyEditionMarkers: ["special edition"] });
  const result = compareCards(left, right, new Map([["1:3", { category: "exact_duplicate" }], ["2:4", { category: "exact_duplicate" }]]));
  assert.equal(result.classification, "edition-variant-keep-separate");
  assert.ok(result.flags.includes("source-edition-claims-differ"));
});

test("source inventory retains provider IDs and distinct memberships without asserting release equivalence", () => {
  const first = releaseEvidence({ track_identity_id: 1, release_id: "10", release_title: "Album", beatport_track_id: "20", raw_json: "{}" }, "beatport", "beatport_enrichment");
  const second = releaseEvidence({ track_identity_id: 2, release_id: "10", release_title: "Album", beatport_track_id: "21", raw_json: "{}" }, "beatport", "beatport_enrichment");
  const third = releaseEvidence({ track_identity_id: 1, release_id: "10", release_title: "Album", raw_json: JSON.stringify({ artists: [{ name: "Different Artist" }], images: [{ uri: "https://example.com/front.jpg", uri150: "https://example.com/front-small.jpg" }], tracklist: [{ position: "1", title: "Track" }] }) }, "discogs", "provider_enrichment");
  const result = buildSourceInventory([first, second, third]);
  assert.equal(result.releases.length, 2);
  assert.deepEqual(result.releases[0].memberRows, [1, 2]);
  assert.equal(result.releases[0].membershipAssertions.length, 2);
  assert.equal(result.releases[1].cachedTracklists.length, 1);
  assert.equal(result.releases[1].membershipVerified, false);
  assert.deepEqual(result.releases[1].artworkVariants, ["https://example.com/front.jpg", "https://example.com/front-small.jpg"]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].candidateOnly, true);
  assert.deepEqual(result.groups[0].sourceReleaseKeys, ["beatport-album:10", "discogs-album:10"]);
});

test("display album, artwork release and date provenance remain separate", () => {
  const row = { id: 1, artist: "Sting", album: "...Nothing Like The Sun", year: 2025, releaseDate: "2025-03-14", label: "Other Label", genres: [], imageUrl: "https://example.com/tribute.jpg", artworkSource: "beatport" };
  const evidence = { provider: "beatport", slot: "beatport_enrichment", releaseKey: "beatport-album:1", title: "Tribute", normalizedTitle: "tribute", releaseDate: "2025-03-14", artworkUrl: row.imageUrl };
  const result = summarizeCard("album:nothing like the sun|sting", [row], new Map([[1, [evidence]]]), new Map());
  assert.equal(result.sourceDisplayIssues.length, 2);
  assert.deepEqual(result.compatibleReleaseKeys, []);
});

test("production grouping and both audits share one read-only snapshot, with no data or schema change", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-identity-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE track_identity (id INTEGER PRIMARY KEY, identity_key TEXT, artist TEXT, title TEXT, album TEXT, duration_ms INTEGER);
    INSERT INTO track_identity VALUES (1,'text:a|track|','Artist','Track','Album',400000);
    INSERT INTO track_identity VALUES (2,'text:a and b|other|','Artist & Guest','Other','Album',300000);`);
  db.close();
  const before = fs.readFileSync(file);
  const { extra, ...snapshot } = readSnapshot(file, { extraRead: readReleaseEvidence });
  const report = buildReleaseReport(buildReport(snapshot), extra);
  assert.equal(report.counts.browserAlbumCards, 2);
  assert.equal(report.counts.productionBrowserAlbumCards, 2);
  assert.equal(report.connectionChanges, 0);
  assert.equal(report.readOnly, true);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => readSnapshot(file, { extraRead: connection => connection.exec("DELETE FROM track_identity") }), /readonly|read-only/i);
  assert.deepEqual(fs.readFileSync(file), before);
});
