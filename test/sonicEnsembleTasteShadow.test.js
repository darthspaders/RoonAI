"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { artistIdentityKey } = require("../src/artistIdentity");
const { freezeTasteView, rankEnsembleTasteShadow } = require("../src/sonicEnsembleTasteShadow");

const anchor = { identityKey: "tidal:100", artist: "Anchor Artist", title: "Anchor (Original Mix)", genre: "Progressive House" };
const options = { scoringMode: "similar", genres: "", request: "Find similar tracks" };
const track = (id, artist, title = "Track (Original Mix)") => ({ identityKey: `tidal:${id}`, tidalId: String(id), artist, title,
  mixVersion: "Original Mix", album: "Album", genre: "Progressive House", durationMs: 480000, year: 2025, label: "Label" });
const entry = (candidate, baseRankScore = 1, agreement = false, agreementBonus = 0) => ({ track: candidate, baseRankScore, agreement, agreementBonus });
const snapshot = (artists = {}) => ({ feedback: {}, candidates: {}, artists, labels: {}, calibration: { sources: [], lanes: [], labels: [] } });
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("an existing hard admission rejection cannot be restored by maximum agreement", () => {
  const rejected = entry(track(1, "Candidate Artist", "Track (Radio Edit)"), 1, true, 0.1);
  const admitted = entry(track(2, "Other Artist"), 0.1);
  const result = rankEnsembleTasteShadow({ anchor, unionCandidates: [rejected, admitted], tasteSnapshot: snapshot(), options });
  assert.deepEqual(result.shortlist.map(item => item.track.identityKey), ["tidal:2"]);
  assert.equal(result.excluded.length, 1);
  assert.match(result.excluded[0].reason, /radio edit/i);
  assert.equal(result.diagnostics.undershot, true);
});

test("strong global taste can outrank agreement and the rank feature never exceeds eight points", () => {
  const artists = {
    [artistIdentityKey("Liked Artist")]: { name: "Liked Artist", score: 6 },
    [artistIdentityKey("Disliked Artist")]: { name: "Disliked Artist", score: -6 }
  };
  const result = rankEnsembleTasteShadow({ anchor, count: 2, options, tasteSnapshot: snapshot(artists), unionCandidates: [
    entry(track(1, "Disliked Artist"), 1, true, 0.1), entry(track(2, "Liked Artist"), 0.5)
  ] });
  assert.deepEqual(result.shortlist.map(item => item.track.identityKey), ["tidal:2", "tidal:1"]);
  assert.equal(result.shortlist[0].tasteAdjustment, 8);
  assert.equal(result.shortlist[1].tasteAdjustment, -8);
  assert.equal(result.shortlist[1].retrievalPoints, 8);
  assert.ok(result.shortlist.every(item => item.retrievalPoints <= 8));
});

test("missing taste and metadata are explicit rather than a claim of full production replay", () => {
  const result = rankEnsembleTasteShadow({ anchor, unionCandidates: [entry({ identityKey: "tidal:1", artist: "Artist", title: "Title" })], options });
  assert.equal(result.diagnostics.tasteSnapshotAvailable, false);
  assert.equal(result.diagnostics.tasteSnapshotStatus, "missing-taste-snapshot");
  assert.equal(result.diagnostics.fullProductionFiltersAvailable, false);
  assert.equal(result.diagnostics.partialMetadataCount, 1);
  assert.ok(result.shortlist[0].missingMetadata.includes("release-year-or-date"));
  assert.ok(result.diagnostics.limitations.some(value => /taste scoring is unavailable/i.test(value)));
});

test("the anchor sampling lane does not become a hard request; an explicitly requested lane is honored", () => {
  const psyAnchor = { ...anchor, genre: "Psy-Trance" }, candidate = entry(track(1, "Other Artist"));
  const neutral = rankEnsembleTasteShadow({ anchor: psyAnchor, unionCandidates: [candidate], tasteSnapshot: snapshot() });
  assert.equal(neutral.shortlist.length, 1);
  assert.deepEqual(neutral.diagnostics.requestedGenres, []);
  const explicit = rankEnsembleTasteShadow({ anchor: psyAnchor, unionCandidates: [candidate], tasteSnapshot: snapshot(), options: { genres: "Psy-Trance" } });
  assert.equal(explicit.shortlist.length, 0);
  assert.equal(explicit.excluded.length, 1);
  assert.ok(explicit.diagnostics.requestedGenres.length > 0);
  assert.match(explicit.excluded[0].reason, /genre|psy|lane/i);
});

test("frozen inputs remain unchanged; output cannot queue, reveal source data or use current review labels", () => {
  const input = freeze({ anchor, options, tasteSnapshot: snapshot(), unionCandidates: [entry({ ...track(1, "Artist"),
    review: { decision: "KEEP", note: "Current listening label" }, rating: "love", analysisLocal: { file: "Z:\\private.flac", sha256: "a".repeat(64) },
    metadata: { sourceFile: "Z:\\private.flac" }, tidal: { artist: "Artist", title: "Track (Original Mix)", filePath: "Z:\\private.flac" }
  }, 1, true, 0.1)] });
  const before = JSON.stringify(input), result = rankEnsembleTasteShadow(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.shadowOnly, true); assert.equal(result.productionApplied, false);
  assert.equal(result.productionPromotionAllowed, false); assert.equal(result.queueable, false);
  assert.equal(result.shortlist[0].queueable, false); assert.equal(result.diagnostics.currentReviewLabelsUsed, false);
  assert.doesNotMatch(JSON.stringify(result), /private\.flac|a{64}|sourceFile|analysisLocal|Current listening label/);
  const changed = JSON.parse(before); changed.unionCandidates[0].track.review = { decision: "WRONG_LANE", note: "Different current label" };
  changed.unionCandidates[0].track.rating = "never";
  assert.deepEqual(rankEnsembleTasteShadow(changed), result);
});

test("the frozen taste view copies its supplied derived state and exposes no writable methods", () => {
  const source = snapshot({ [artistIdentityKey("Artist")]: { name: "Artist", score: 2 } });
  const view = freezeTasteView(source); source.artists[artistIdentityKey("Artist")].score = -6;
  assert.equal(view.adjustmentFor(track(1, "Artist")).value, 4);
  assert.ok(Object.isFrozen(view)); assert.ok(Object.isFrozen(view.read().artists));
  assert.equal(view.record, undefined); assert.equal(view.write, undefined); assert.equal(view.saveCandidate, undefined);
});

test("exact nomination aliases and subgenre are retained while arbitrary nomination fields are stripped", () => {
  const candidate = entry({ ...track(1, "Artist"), subgenre: "Organic House" });
  candidate.nominations = [{ analyzer: "mert-fullsong", specKey: "analysis-v1-example", identityKey: "isrc:EXACTALIAS", rank: 2, similarity: 0.8,
    sourceFile: "Z:\\private.flac", sourceSha256: "a".repeat(64), review: "KEEP" }];
  const result = rankEnsembleTasteShadow({ anchor, unionCandidates: [candidate], options, tasteSnapshot: snapshot() });
  assert.equal(result.shortlist[0].track.subgenre, "Organic House");
  assert.deepEqual(result.shortlist[0].nominations, [{ analyzer: "mert-fullsong", rank: 2, specKey: "analysis-v1-example", identityKey: "isrc:EXACTALIAS", similarity: 0.8 }]);
  assert.doesNotMatch(JSON.stringify(result), /private\.flac|sourceFile|sourceSha256|a{64}/);
});

test("count, distinct identity and feature bounds fail before ranking", () => {
  for (const count of [0, 51, 1.5, "3"]) assert.throws(() => rankEnsembleTasteShadow({ anchor, count }), /integer/i);
  for (const candidate of [entry(track(1, "Artist"), 1.1), entry(track(1, "Artist"), 1, true, 0.11), entry(track(1, "Artist"), 1, false, 0.1)])
    assert.throws(() => rankEnsembleTasteShadow({ anchor, unionCandidates: [candidate], options }), /bounded/i);
  const candidate = entry(track(1, "Artist"));
  assert.throws(() => rankEnsembleTasteShadow({ anchor, unionCandidates: [candidate, candidate], options }), /distinct exact/i);
});
