"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MusicMemoryStore, trackIdentityKey } = require("../src/musicMemoryStore");

function tempDbFile(name = "music-memory") {
  return path.join(os.tmpdir(), `rabbit-hole-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

test("music memory keeps stable track identity separate from provider indexes", () => {
  assert.equal(trackIdentityKey({ tidalId: "544016594", artist: "D-SHIFT", title: "City Lights" }), "tidal:544016594");
  assert.equal(trackIdentityKey({ tidalId: "https://tidal.com/browse/track/544016594" }), "tidal:544016594");
  assert.equal(trackIdentityKey({ isrc: "gbewa2100645", artist: "Ezequiel Arias", title: "Solar" }), "isrc:GBEWA2100645");
  assert.equal(trackIdentityKey({ artist: "Ezequiel Arias", title: "Solar", mixName: "Extended Mix" }), "text:ezequiel arias|solar|extended mix");
});

test("music memory exposes prior validated TIDAL identities for narrow reuse", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  store.rememberObservation({
    tidalId: "2352515",
    artist: "James Holden",
    title: "A Break In The Clouds (Main Mix)",
    album: "Balance 005",
    durationMs: 420000
  }, "exact_verification");
  const matches = store.findValidatedTidalIdentities({ artist: "Holden", title: "A Break in the Clouds" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].tidalId, "2352515");
  assert.equal(matches[0].validatedIdentitySource, "music-memory-track-identity");
  store.close();
});

test("music memory records observations and Beatport enrichment", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null, clock: () => 1_788_810_000_000 });
  const track = {
    tidalId: "12345",
    roonIdentity: "roon-track-12345",
    isrc: "GBEWA2100645",
    artist: "Ezequiel Arias",
    title: "Solar",
    mixName: "Extended Mix"
  };

  store.rememberObservation(track, "now_playing");
  const saved = store.saveBeatportEnrichment(track, {
    id: "23107095",
    artist: "Ezequiel Arias",
    title: "Solar",
    mixName: "Extended Mix",
    genre: "Melodic House & Techno",
    subGenre: "Progressive House",
    bpm: 123,
    keyName: "Gb Major",
    camelot: "2B",
    label: "Anjunadeep",
    album: "25 Years Of Anjuna Mixed By James Grant",
    releaseDate: "2026-03-14",
    releaseId: "123456",
    artistIds: ["375072"],
    remixerIds: ["99"],
    durationMs: 520000,
    isrc: "GBEWA2100645",
    beatportUrl: "https://www.beatport.com/track/solar-extended-mix/23107095/",
    rawJson: { id: 23107095, genre: { name: "Melodic House & Techno" } }
  }, { confidence: 100 });

  const found = store.findBeatportEnrichment(track);
  const status = store.status();

  assert.equal(saved.id, "23107095");
  assert.equal(found.genre, "Melodic House & Techno");
  assert.equal(found.subGenre, "Progressive House");
  assert.equal(found.bpm, 123);
  assert.equal(found.releaseId, "123456");
  assert.equal(found.rawJson.id, 23107095);
  assert.equal(status.trackCount, 1);
  assert.equal(status.beatportCount, 1);
  assert.equal(status.observationCount, 1);
  store.close();
});

test("music memory keeps Beatport enrichment on a text-only source identity", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null, clock: () => 1_788_810_000_000 });
  const track = {
    artist: "Kamilo Sanclemente",
    title: "Alone"
  };

  store.rememberObservation(track, "now_playing");
  const saved = store.saveBeatportEnrichment(track, {
    id: "17151096",
    artist: "Kamilo Sanclemente",
    title: "Alone",
    mixName: "Extended Mix",
    isrc: "NLD682000483",
    genre: "Melodic House & Techno"
  }, { confidence: 100 });

  assert.equal(saved.id, "17151096");
  assert.equal(store.findBeatportEnrichment(track).id, "17151096");
  assert.equal(store.tracksMissingBeatportEnrichment(10).length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM track_identity").get().count, 1);
  store.close();
});

test("music memory exposes Beatport enrichment through a trusted canonical TIDAL alias", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const alias = {
    artist: "Eleonora / Morttagua / Ubbah",
    title: "Blue Enigma"
  };
  const canonical = {
    tidalId: "132973114",
    artist: "Eleonora, Morttagua",
    title: "Blue Enigma",
    isrc: "US83Z2006403",
    durationMs: 515000
  };

  store.rememberObservation(alias, "standby");
  store.linkTrackIdentity(alias, canonical, {
    relation: "CANONICAL_TIDAL",
    confidence: 99,
    source: "metadata_enrichment"
  });
  store.saveBeatportEnrichment(canonical, {
    id: "28956045",
    artist: "Eleonora, Morttagua",
    title: "Blue Enigma",
    mixName: "Original Mix",
    isrc: "US83Z2006403",
    genre: "Progressive House"
  }, { confidence: 100 });
  store.saveEnrichmentAttempt(alias, "beatport", {
    status: "missing",
    fetchedAt: "2026-09-16T00:00:00.000Z",
    nextRetryAt: "2026-09-23T00:00:00.000Z"
  });

  const candidate = store.findBeatportEnrichmentCandidate(alias);
  assert.equal(candidate.result.id, "28956045");
  assert.equal(candidate.identityReuse.reused, true);
  assert.equal(candidate.identityReuse.source, "canonical-tidal-alias");
  assert.equal(candidate.identityReuse.canonicalTidalId, "132973114");
  assert.equal(candidate.identityReuse.validationTrack.isrc, "US83Z2006403");
  assert.equal(store.findBeatportEnrichment(alias).id, "28956045");
  store.close();
});

test("music memory identity timestamps follow event timestamps", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null, clock: () => 1_788_810_000_000 });
  const track = {
    tidalId: "171847444",
    artist: "Ezequiel Arias",
    title: "Solar"
  };

  store.rememberObservation(track, "history", { observedAt: "2026-01-02T00:00:00.000Z" });
  store.saveTasteFeedback(track, { rating: "love", createdAt: "2026-01-01T00:00:00.000Z" });
  store.saveProviderEnrichment(track, "beatport", {
    genre: "Melodic House & Techno",
    fetchedAt: "2026-01-03T00:00:00.000Z"
  });

  const row = store.db.prepare("SELECT first_seen_at, last_seen_at FROM track_identity WHERE tidal_id = ?").get("171847444");
  assert.equal(row.first_seen_at, "2026-01-01T00:00:00.000Z");
  assert.equal(row.last_seen_at, "2026-01-03T00:00:00.000Z");
  store.close();
});

test("music memory links a live alias to the canonical TIDAL identity", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const alias = {
    artist: "Space Jesus / Dirt Monkey",
    title: "Sofa Surfin",
    roonIdentity: "roon-live-sofa-surfin"
  };
  const canonical = {
    artist: "Space Jesus, Dirt Monkey",
    title: "Sofa Surfin",
    tidalId: "80252026",
    tidalUrl: "https://tidal.com/browse/track/80252026"
  };

  store.saveSonicAnalysisRequest(alias, {
    status: "PENDING_METADATA",
    policy: "LIVE_BEATPORT_ONLY",
    requiredSource: "beatport_preview_or_local_file",
    reason: "waiting for metadata"
  });
  const link = store.linkTrackIdentity(alias, canonical, {
    relation: "CANONICAL_TIDAL",
    confidence: 99,
    source: "metadata_enrichment"
  });
  assert.equal(link.linked, true);
  assert.equal(link.canonicalIdentityKey, "tidal:80252026");

  const saved = store.saveSonicAnalysisRequest(alias, {
    status: "ANALYZED_BEATPORT_PREVIEW",
    beatportTrackId: "9873969",
    sourceAudioType: "beatport_preview",
    sourceMatchType: "exact",
    confidence: 99,
    fulfilledAt: "2026-09-13T09:00:00.000Z",
    reason: "preview analyzed"
  });
  assert.equal(saved.identity_key, "tidal:80252026");
  assert.equal(store.findSonicAnalysisRequest(alias).identity_key, "tidal:80252026");
  assert.equal(store.findSonicAnalysisRequest(canonical).status, "ANALYZED_BEATPORT_PREVIEW");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sonic_analysis_request").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM track_identity_alias").get().count, 1);
  store.close();
});

test("reconcileReversedRoonTrack links a uniquely identifiable reversed payload", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const canonical = {
    tidalId: "4833868",
    artist: "Charlie Daniels",
    title: "Long Haired Country Boy",
    album: "The Roots Remain",
    durationMs: 241000
  };
  store.saveSonicAnalysisRequest(canonical, { status: "NEEDS_LOCAL_FILE", reason: "no Beatport match" });

  const reversed = {
    artist: "Long Haired Country Boy",
    title: "The Charlie Daniels Band / Charlie Daniels",
    roonIdentity: "roon-reversed-country",
    durationMs: 241000
  };
  const result = store.reconcileReversedRoonTrack(reversed);
  assert.equal(result.relation, "REVERSED_ROON_METADATA");
  assert.equal(result.canonicalIdentityKey, "tidal:4833868");
  assert.equal(store.findSonicAnalysisRequest(reversed).identity_key, "tidal:4833868");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sonic_analysis_request").get().count, 1);
  store.close();
});

test("reversed identity reconciliation fails closed when multiple TIDAL candidates match", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  store.upsertTrackIdentity({ tidalId: "1", artist: "Artist One", title: "Shared Title" });
  store.upsertTrackIdentity({ tidalId: "2", artist: "Artist Two", title: "Shared Title" });
  const result = store.reconcileReversedRoonTrack({
    artist: "Shared Title",
    title: "Artist One / Artist Two",
    roonIdentity: "roon-ambiguous"
  });
  assert.equal(result, null);
  store.close();
});

test("startup migration reclassifies persisted deterministic sonic failures", () => {
  const dbFile = tempDbFile("sonic-failure-migration");
  const first = new MusicMemoryStore({ dbFile, logger: null });
  const failedTrack = { tidalId: "4833704", artist: "Charlie Daniels", title: "Land Of Opportunity" };
  first.saveSonicAnalysisRequest(failedTrack, {
    status: "ANALYSIS_FAILED",
    requiredSource: "beatport_preview_or_local_file",
    sourceMatchType: "HIGH_CONFIDENCE",
    beatportTrackId: "21376579",
    reason: "Beatport candidate was rejected: artist credits do not match exactly"
  });
  first.close();

  const second = new MusicMemoryStore({ dbFile, logger: null });
  const migrated = second.findSonicAnalysisRequest(failedTrack);
  assert.equal(migrated.status, "NEEDS_LOCAL_FILE");
  assert.equal(migrated.source_match_type, "BEATPORT_MATCH_REJECTED");
  assert.equal(migrated.required_source, "local_file");
  second.close();
});

test("music memory blocks Beatport retry until missing attempt retry time", () => {
  const now = Date.parse("2026-09-07T13:00:00.000Z");
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null, clock: () => now });
  const missingTrack = { tidalId: "555", artist: "Not Beatport", title: "Kitchen Sink Ballad" };
  const readyTrack = { tidalId: "556", artist: "Likely Beatport", title: "Warehouse Tool" };

  store.rememberObservation(missingTrack, "history");
  store.rememberObservation(readyTrack, "history");
  store.saveEnrichmentAttempt(missingTrack, "beatport", {
    status: "missing",
    fetchedAt: "2026-09-07T12:00:00.000Z",
    nextRetryAt: "2026-09-14T12:00:00.000Z"
  });

  assert.equal(store.beatportLookupBlocked(missingTrack), true);
  assert.equal(store.beatportLookupBlocked(readyTrack), false);
  assert.deepEqual(
    store.tracksMissingBeatportEnrichment(10).map((track) => track.tidalId),
    ["556"]
  );
  assert.equal(store.status().beatportMissingCount, 1);
  assert.equal(store.status().beatportRetryBlockedCount, 1);
  store.close();
});

test("music memory retries Beatport after missing attempt retry time expires", () => {
  const now = Date.parse("2026-09-15T13:00:00.000Z");
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null, clock: () => now });
  const track = { tidalId: "557", artist: "Not Beatport", title: "Kitchen Sink Ballad" };

  store.rememberObservation(track, "history");
  store.saveEnrichmentAttempt(track, "beatport", {
    status: "missing",
    fetchedAt: "2026-09-07T12:00:00.000Z",
    nextRetryAt: "2026-09-14T12:00:00.000Z"
  });

  assert.equal(store.beatportLookupBlocked(track), false);
  assert.deepEqual(
    store.tracksMissingBeatportEnrichment(10).map((item) => item.tidalId),
    ["557"]
  );
  assert.equal(store.status().beatportMissingCount, 1);
  assert.equal(store.status().beatportRetryBlockedCount, 0);
  store.close();
});

test("music memory status does not rescan all attempts for each latest-attempt check", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const database = store.db;
  const plans = [];
  store.db = {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        get(...parameters) {
          if (sql.includes("FROM enrichment_attempt newer")) {
            plans.push(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters));
          }
          return statement.get(...parameters);
        }
      };
    }
  };
  try {
    store.status();
    assert.equal(plans.length, 2, "check both missing and retry-blocked counts");
    for (const plan of plans) {
      assert.ok(plan.some(({ detail }) => /\bSEARCH newer\b/.test(detail)), JSON.stringify(plan));
      assert.ok(!plan.some(({ detail }) => /\bSCAN newer\b/.test(detail)), JSON.stringify(plan));
    }
  } finally {
    store.db = database;
    store.close();
  }
});

test("music memory search returns enrichment, feedback, observations, and artwork", () => {
  const now = Date.parse("2026-09-07T13:00:00.000Z");
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null, clock: () => now });
  const track = {
    tidalId: "544016594",
    artist: "D-SHIFT, Drunken Kong",
    title: "City Lights (HAFT Remix)",
    album: "City Lights",
    durationMs: 469000,
    isrc: "US83Z2647768"
  };

  store.rememberObservation(track, "now_playing", { observedAt: "2026-09-07T12:00:00.000Z" });
  store.saveTasteFeedback(track, { rating: "love", createdAt: "2026-09-07T12:01:00.000Z" });
  store.saveBeatportEnrichment(track, {
    id: "29781370",
    artist: "D-SHIFT, Drunken Kong",
    title: "City Lights",
    mixName: "HAFT Remix",
    genre: "Progressive House",
    subGenre: "Organic House",
    bpm: 123,
    keyName: "Eb Major",
    camelot: "5B",
    label: "Mango Alley",
    releaseDate: "2026-08-20",
    releaseId: "7216259",
    durationMs: 469268,
    isrc: "US83Z2647768",
    beatportUrl: "https://api.beatport.com/v4/catalog/tracks/29781370/",
    rawJson: {
      id: 29781370,
      image: { url: "https://geo-media.beatport.com/image.jpg" }
    }
  }, { confidence: 100 });

  const result = store.searchTracks({ q: "Mango", beatport: "has", feedback: "love" });

  assert.equal(result.total, 1);
  assert.equal(result.tracks[0].title, "City Lights (HAFT Remix)");
  assert.equal(result.tracks[0].beatport.genre, "Progressive House");
  assert.equal(result.tracks[0].beatport.subGenre, "Organic House");
  assert.equal(result.tracks[0].beatport.bpm, 123);
  assert.equal(result.tracks[0].beatport.releaseId, "7216259");
  assert.equal(result.tracks[0].feedbackCount, 1);
  assert.equal(result.tracks[0].playCount, 1);
  assert.deepEqual(result.tracks[0].feedbackRatings, ["love"]);
  assert.equal(result.tracks[0].latestObservationSource, "now_playing");
  assert.equal(result.tracks[0].imageUrl, "https://geo-media.beatport.com/image.jpg");
  store.close();
});

test("music memory feedback filters include legacy aliases for the new vocabulary", () => {
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const likeTrack = { tidalId: "910", artist: "Like Artist", title: "Like Track" };
  const dislikeTrack = { tidalId: "911", artist: "Dislike Artist", title: "Dislike Track" };
  const okayTrack = { tidalId: "912", artist: "Okay Artist", title: "Okay Track" };
  store.saveTasteFeedback(likeTrack, { rating: "good", sourceEventId: "legacy-good" });
  store.saveTasteFeedback(dislikeTrack, { rating: "skip", sourceEventId: "legacy-skip" });
  store.saveTasteFeedback(okayTrack, { rating: "ok", sourceEventId: "current-ok" });

  assert.deepEqual(store.searchTracks({ feedback: "like" }).tracks.map((track) => track.tidalId), ["910"]);
  assert.deepEqual(store.searchTracks({ feedback: "dislike" }).tracks.map((track) => track.tidalId), ["911"]);
  assert.deepEqual(store.searchTracks({ feedback: "ok" }).tracks.map((track) => track.tidalId), ["912"]);
  store.close();
});

test("music memory search filters Beatport retry-blocked misses", () => {
  const now = Date.parse("2026-09-07T13:00:00.000Z");
  const store = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null, clock: () => now });
  const missingTrack = { tidalId: "900", artist: "Miles Davis", title: "So What" };
  const readyTrack = { tidalId: "901", artist: "Ezequiel Arias", title: "Solar" };

  store.rememberObservation(missingTrack, "history");
  store.rememberObservation(readyTrack, "history");
  store.saveEnrichmentAttempt(missingTrack, "beatport", {
    status: "missing",
    fetchedAt: "2026-09-07T12:00:00.000Z",
    nextRetryAt: "2026-09-14T12:00:00.000Z"
  });

  assert.deepEqual(
    store.searchTracks({ beatport: "retry-blocked" }).tracks.map((track) => track.tidalId),
    ["900"]
  );
  assert.deepEqual(
    store.searchTracks({ beatport: "missing" }).tracks.map((track) => track.tidalId).sort(),
    ["900", "901"]
  );
  store.close();
});
