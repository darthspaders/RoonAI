"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCurrentTrackMetadataEnrichment } = require("../src/currentTrackMetadataEnrichment");

function createService(overrides = {}) {
  return createCurrentTrackMetadataEnrichment({
    cleanRadioText: overrides.cleanRadioText || ((value = "") => String(value || "").replace(/\s+/g, " ").trim()),
    config: overrides.config || { metadataEnrichment: { enabled: true } },
    metadataEnrichment: overrides.metadataEnrichment || {
      displayableCachedEntry: () => null,
      shouldBridgeCachedArtwork: () => false,
      bridgeCachedArtwork: async () => null,
      shouldLookup: () => false,
      enrich: async () => null,
      minConfidence: 0.6
    },
    scheduleBroadcast: overrides.scheduleBroadcast || (() => {}),
    summarizeZoneTrack: overrides.summarizeZoneTrack || ((zone = {}) => zone.summaryTrack || null)
  });
}

test("metadataLookupTrackFromZone preserves existing Roon metadata evidence", () => {
  const service = createService({
    summarizeZoneTrack: () => ({ artist: " Artist ", title: " Track " })
  });

  const lookup = service.metadataLookupTrackFromZone({
    now_playing: {
      length: 321,
      metadata: {
        release_date: "2024-04-05",
        record_label: " Anjunadeep ",
        genres: [{ name: " Progressive House " }]
      },
      three_line: { line3: " Album " }
    }
  });

  assert.deepEqual(lookup, {
    artist: "Artist",
    title: "Track",
    album: "Album",
    durationMs: 321000,
    releaseYear: 2024,
    releaseDate: "2024-04-05",
    label: "Anjunadeep",
    genre: "Progressive House",
    isRadio: false
  });
});

test("attachMetadataEnrichment adds displayable cached entry to now playing", () => {
  const service = createService({
    summarizeZoneTrack: () => ({ artist: "Artist", title: "Track" }),
    metadataEnrichment: {
      displayableCachedEntry: () => ({ status: "found", label: "Label" }),
      shouldBridgeCachedArtwork: () => false,
      bridgeCachedArtwork: async () => null,
      shouldLookup: () => false,
      enrich: async () => null,
      minConfidence: 0.6
    }
  });

  const state = service.attachMetadataEnrichment({
    zones: [{ zone_id: "z1", now_playing: {} }]
  });

  assert.deepEqual(state.zones[0].now_playing.metadata_enrichment, { status: "found", label: "Label" });
});

test("scheduleMetadataEnrichment looks up incomplete tracks and broadcasts confident hits", async () => {
  let enrichedLookup = null;
  let broadcasts = 0;
  const service = createService({
    summarizeZoneTrack: () => ({ artist: "Artist", title: "Track" }),
    metadataEnrichment: {
      displayableCachedEntry: () => null,
      shouldBridgeCachedArtwork: () => false,
      bridgeCachedArtwork: async () => null,
      shouldLookup: () => true,
      enrich: async (lookup) => {
        enrichedLookup = lookup;
        return { status: "found", confidence: 0.9 };
      },
      minConfidence: 0.6
    },
    scheduleBroadcast: () => {
      broadcasts += 1;
    }
  });

  service.scheduleMetadataEnrichment({
    zones: [{ now_playing: {} }]
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(enrichedLookup.artist, "Artist");
  assert.equal(enrichedLookup.title, "Track");
  assert.equal(broadcasts, 1);
});

test("scheduleMetadataEnrichment looks up complete TIDAL metadata when Beatport genre is missing", async () => {
  let enrichedLookup = null;
  const service = createService({
    summarizeZoneTrack: () => ({ artist: "D-SHIFT, Drunken Kong", title: "City Lights (HAFT Remix)" }),
    metadataEnrichment: {
      displayableCachedEntry: () => null,
      shouldBridgeCachedArtwork: () => false,
      bridgeCachedArtwork: async () => null,
      shouldLookup: () => true,
      enrich: async (lookup) => {
        enrichedLookup = lookup;
        return { status: "found", confidence: 0.9 };
      },
      minConfidence: 0.6
    },
    scheduleBroadcast: () => {}
  });

  service.scheduleMetadataEnrichment({
    zones: [{
      now_playing: {
        length: 469,
        metadata: {
          release_date: "2026-01-01",
          record_label: "Mango Alley",
          genres: [{ name: "Electronic" }]
        }
      }
    }]
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(enrichedLookup.artist, "D-SHIFT, Drunken Kong");
  assert.equal(enrichedLookup.genre, "Electronic");
});

test("metadata enrichment preserves local MusicBrainz genre evidence", async () => {
  const { MetadataEnrichmentService } = require("../src/metadataEnrichmentService");
  const service = new MetadataEnrichmentService({
    tidal: { isConfigured: () => false },
    metadataResolver: {
      searchRecordings: async () => [{
        id: "mb-recording",
        title: "U",
        length: 420000,
        "artist-credit": [{ artist: { name: "Avoure" } }],
        genres: [{ name: "progressive house" }],
        releases: [{
          id: "mb-release",
        title: "Night Versions",
        date: "2026-01-01",
        genres: [{ name: "melodic house" }],
        tags: [{ name: "progressive breaks" }],
        "release-group": { id: "rg" }
      }]
    }]
    },
    cacheFile: "",
    minConfidence: 80,
    artBridge: { enabled: false }
  });

  const result = await service.enrich({ artist: "Avoure", title: "U" });
  assert.equal(result.source, "musicbrainz");
  assert.match(result.genre, /progressive house/);
  assert.match(result.genre, /melodic house/);
  assert.deepEqual(result.musicBrainzTags, ["progressive house", "melodic house", "progressive breaks"]);
});

test("metadata enrichment disabled leaves state unchanged and skips scheduling", async () => {
  let lookups = 0;
  const service = createService({
    config: { metadataEnrichment: { enabled: false } },
    metadataEnrichment: {
      displayableCachedEntry: () => {
        lookups += 1;
        return { status: "found" };
      },
      shouldBridgeCachedArtwork: () => false,
      bridgeCachedArtwork: async () => null,
      shouldLookup: () => true,
      enrich: async () => {
        lookups += 1;
        return { status: "found", confidence: 1 };
      },
      minConfidence: 0.6
    }
  });
  const original = { zones: [{ now_playing: {} }] };

  assert.equal(service.attachMetadataEnrichment(original), original);
  service.scheduleMetadataEnrichment(original);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 0);
});
