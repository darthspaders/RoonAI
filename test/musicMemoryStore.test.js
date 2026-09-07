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
