"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MetadataEnrichmentService,
  confidenceForMatch,
  metadataCacheKey,
  stripSearchVersionTerms
} = require("../src/metadataEnrichmentService");

function tempCacheFile(name) {
  return path.join(os.tmpdir(), `rabbit-hole-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

test("metadata title normalization strips only generic version text", () => {
  assert.equal(stripSearchVersionTerms("Small Things (Extended)"), "Small Things");
  assert.equal(stripSearchVersionTerms("Small Things (Extended Mix) [2021 Remaster]"), "Small Things");
  assert.equal(stripSearchVersionTerms("Infinite Enclosure (Kyotto Remix)"), "Infinite Enclosure (Kyotto Remix)");
  assert.equal(stripSearchVersionTerms("A [VIP Radio Rip] Title"), "A Title");
});

test("metadata cache key is normalized by artist and safe search title", () => {
  assert.equal(
    metadataCacheKey({ artist: "Lab's Cloud", title: "Small Things (Extended)" }),
    "lab s cloud|small things"
  );
  assert.equal(
    metadataCacheKey({ artist: "Lab's Cloud", title: "Small Things" }),
    "lab s cloud|small things"
  );
});

test("metadata confidence scores exact, normalized, fuzzy, and weak matches", () => {
  assert.equal(confidenceForMatch(
    { artist: "Lab's Cloud", title: "Small Things", isrc: "USABC2100001" },
    { artist: "Lab's Cloud", title: "Wrong Title", isrc: "USABC2100001" }
  ).confidence, 100);
  assert.equal(confidenceForMatch(
    { artist: "Lab's Cloud", title: "Small Things" },
    { artist: "Lab's Cloud", title: "Small Things" }
  ).confidence, 99);
  assert.equal(confidenceForMatch(
    { artist: "Lab's Cloud", title: "Small Things (Extended)" },
    { artist: "Lab's Cloud", title: "Small Things" }
  ).confidence, 95);
  assert.equal(confidenceForMatch(
    { artist: "Lab's Cloud", title: "Small Thngs" },
    { artist: "Lab's Cloud", title: "Small Things" }
  ).confidence, 85);
  assert.equal(confidenceForMatch(
    { artist: "Lab's Cloud", title: "Small Things" },
    { artist: "Other Artist", title: "Small Things" }
  ).confidence, 0);
});

test("metadata enrichment uses TIDAL once and persists a successful lookup", async () => {
  const cacheFile = tempCacheFile("metadata-success");
  let calls = 0;
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => {
        calls += 1;
        return {
          id: "1",
          artist: "Lab's Cloud",
          title: "Small Things",
          album: "Build of Silence",
          label: "Silk Music",
          year: 2021,
          durationMs: 526000,
          imageUrl: "https://example.test/cover.jpg",
          tidalUrl: "https://tidal.com/browse/track/1"
        };
      }
    },
    metadataResolver: null,
    logger: null
  });

  const first = await service.enrich({ artist: "Lab's Cloud", title: "Small Things (Extended)" });
  const callsAfterFirstLookup = calls;
  const second = await service.enrich({ artist: "Lab's Cloud", title: "Small Things" });

  assert.equal(calls, callsAfterFirstLookup);
  assert.equal(first.id, "1");
  assert.equal(first.label, "Silk Music");
  assert.equal(second.durationMs, 526000);
  assert.ok(fs.existsSync(cacheFile));
});

test("metadata enrichment can use Beatport EDM metadata after a TIDAL miss", async () => {
  const cacheFile = tempCacheFile("metadata-beatport");
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => null
    },
    beatport: {
      isConfigured: () => true,
      findTrack: async () => ({
        id: "77",
        artist: "Ezequiel Arias",
        title: "Solar",
        album: "Solar",
        label: "Sudbeat Music",
        genre: "Melodic House & Techno",
        subGenre: "Progressive House",
        beatportTags: ["Melodic House & Techno", "Progressive House"],
        bpm: 122,
        keyName: "D Minor",
        camelot: "7A",
        durationMs: 414000,
        beatportUrl: "https://www.beatport.com/track/solar/77"
      })
    },
    metadataResolver: {
      searchRecordings: async () => {
        throw new Error("MusicBrainz should not run after Beatport match");
      }
    },
    logger: null
  });

  const entry = await service.enrich({ artist: "Ezequiel Arias", title: "Solar" });

  assert.equal(entry.source, "beatport");
  assert.equal(entry.genre, "Melodic House & Techno, Progressive House");
  assert.deepEqual(entry.beatportTags, ["Melodic House & Techno", "Progressive House"]);
  assert.equal(entry.label, "Sudbeat Music");
  assert.equal(entry.bpm, 122);
  assert.equal(entry.keyName, "D Minor");
  assert.equal(entry.camelot, "7A");
  assert.equal(entry.beatport.url, "https://www.beatport.com/track/solar/77");
});

test("metadata enrichment augments TIDAL hits with Beatport genre detail", async () => {
  const cacheFile = tempCacheFile("metadata-tidal-plus-beatport");
  let savedConfidence = 0;
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => ({
        id: "544016594",
        artist: "D-SHIFT, Drunken Kong",
        title: "City Lights (HAFT Remix)",
        album: "City Lights",
        label: "Mango Alley",
        releaseDate: "2026-01-01",
        durationMs: 469000,
        isrc: "US83Z2647768"
      })
    },
    beatport: {
      isConfigured: () => true,
      findTrack: async () => ({
        id: "23107095",
        artist: "D-SHIFT, Drunken Kong",
        title: "City Lights",
        mixName: "HAFT Remix",
        genre: "Melodic House & Techno",
        subGenre: "Progressive House",
        beatportTags: ["Melodic House & Techno", "Progressive House"],
        bpm: 123,
        keyName: "A Minor",
        camelot: "8A",
        label: "Mango Alley",
        releaseDate: "2026-08-20",
        releaseId: "7216259",
        artistIds: ["225530", "1456004"],
        remixerIds: ["645772"],
        durationMs: 469000,
        isrc: "US83Z2647768"
      })
    },
    musicMemory: {
      rememberObservation: () => {},
      findBeatportEnrichment: () => null,
      saveBeatportEnrichment: (input, result, options) => {
        assert.equal(input.title, "City Lights (HAFT Remix)");
        assert.equal(result.id, "23107095");
        savedConfidence = options.confidence;
      }
    },
    metadataResolver: null,
    logger: null
  });

  const entry = await service.enrich({
    tidalId: "544016594",
    artist: "D-SHIFT, Drunken Kong",
    title: "City Lights (HAFT Remix)",
    isrc: "US83Z2647768"
  });

  assert.equal(entry.source, "tidal+beatport");
  assert.equal(entry.genre, "Melodic House & Techno, Progressive House");
  assert.deepEqual(entry.beatportTags, ["Melodic House & Techno", "Progressive House"]);
  assert.equal(entry.label, "Mango Alley");
  assert.equal(entry.bpm, 123);
  assert.equal(entry.camelot, "8A");
  assert.equal(entry.beatport.genre, "Melodic House & Techno");
  assert.equal(entry.beatport.subGenre, "Progressive House");
  assert.equal(entry.beatport.releaseDate, "2026-08-20");
  assert.equal(entry.beatport.releaseId, "7216259");
  assert.deepEqual(entry.beatport.artistIds, ["225530", "1456004"]);
  assert.deepEqual(entry.beatport.remixerIds, ["645772"]);
  assert.equal(savedConfidence, 100);
});

test("metadata enrichment retries cached TIDAL hits that lack Beatport genre", async () => {
  const cacheFile = tempCacheFile("metadata-cached-tidal-needs-beatport");
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: { isConfigured: () => false },
    beatport: { isConfigured: () => true },
    metadataResolver: null,
    logger: null
  });
  service.cache.set("d shift drunken kong|city lights haft remix", {
    status: "found",
    key: "d shift drunken kong|city lights haft remix",
    source: "tidal",
    artist: "D-SHIFT, Drunken Kong",
    title: "City Lights (HAFT Remix)",
    label: "Mango Alley",
    genre: "",
    confidence: 99,
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(service.shouldLookup({
    artist: "D-SHIFT, Drunken Kong",
    title: "City Lights (HAFT Remix)"
  }), true);
});

test("metadata enrichment reuses Rabbit Hole memory before calling Beatport", async () => {
  const cacheFile = tempCacheFile("metadata-memory-beatport");
  let beatportCalls = 0;
  const track = { artist: "Ezequiel Arias", title: "Solar", isrc: "GBEWA2100645" };
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => null
    },
    beatport: {
      isConfigured: () => true,
      findTrack: async () => {
        beatportCalls += 1;
        throw new Error("Beatport API should not run when memory has enrichment");
      }
    },
    musicMemory: {
      rememberObservation: () => {},
      findBeatportEnrichment: () => ({
        id: "23107095",
        artist: "Ezequiel Arias",
        title: "Solar",
        mixName: "Extended Mix",
        genre: "Melodic House & Techno",
        subGenre: "Progressive House",
        beatportTags: ["Melodic House & Techno", "Progressive House"],
        bpm: 123,
        keyName: "Gb Major",
        camelot: "2B",
        durationMs: 520000,
        isrc: "GBEWA2100645"
      }),
      saveBeatportEnrichment: () => {
        throw new Error("Cached Beatport memory should not be rewritten");
      },
      status: () => ({ enabled: true, trackCount: 1, beatportCount: 1 })
    },
    metadataResolver: {
      searchRecordings: async () => {
        throw new Error("MusicBrainz should not run after memory Beatport match");
      }
    },
    logger: null
  });

  const entry = await service.enrich(track);

  assert.equal(beatportCalls, 0);
  assert.equal(entry.source, "beatport");
  assert.equal(entry.genre, "Melodic House & Techno, Progressive House");
});

test("metadata enrichment skips Beatport API while durable miss is retry-blocked", async () => {
  const cacheFile = tempCacheFile("metadata-beatport-miss-blocked");
  let beatportCalls = 0;
  let musicBrainzCalls = 0;
  const track = { artist: "Miles Davis", title: "So What" };
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => null
    },
    beatport: {
      isConfigured: () => true,
      findTrack: async () => {
        beatportCalls += 1;
        throw new Error("Beatport should not run while miss is blocked");
      }
    },
    musicMemory: {
      rememberObservation: () => {},
      findBeatportEnrichment: () => null,
      beatportLookupBlocked: () => true,
      saveEnrichmentAttempt: () => {
        throw new Error("Blocked Beatport lookup should not write a new attempt");
      }
    },
    metadataResolver: {
      searchRecordings: async () => {
        musicBrainzCalls += 1;
        return [];
      }
    },
    logger: null
  });

  const entry = await service.enrich(track);

  assert.equal(entry, null);
  assert.equal(beatportCalls, 0);
  assert.equal(musicBrainzCalls, 1);
});

test("metadata enrichment stores bridge-hosted artwork when bridge is available", async () => {
  const cacheFile = tempCacheFile("metadata-art-bridge");
  const bridgeCalls = [];
  const service = new MetadataEnrichmentService({
    cacheFile,
    artBridge: {
      cacheUrl: "http://127.0.0.1:8787/api/art/cache",
      timeoutMs: 500
    },
    fetchImpl: async (url, options = {}) => {
      bridgeCalls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ url: "https://art.example.com/art/shimmer.jpg" })
      };
    },
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => ({
        artist: "Ambyion, Abandoned & GalaxyTones",
        title: "Shimmer",
        imageUrl: "https://resources.tidal.com/images/shimmer.jpg",
        durationMs: 246000
      })
    },
    metadataResolver: null,
    logger: null
  });

  const entry = await service.enrich({ artist: "Ambyion, Abandoned & GalaxyTones", title: "Shimmer" });

  assert.equal(entry.imageUrl, "https://art.example.com/art/shimmer.jpg");
  assert.equal(bridgeCalls[0].url, "http://127.0.0.1:8787/api/art/cache");
  assert.equal(bridgeCalls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(bridgeCalls[0].options.body), {
    sourceUrl: "https://resources.tidal.com/images/shimmer.jpg",
    imageKey: "rabbit-hole:ambyion abandoned and galaxytones|shimmer",
    artist: "Ambyion, Abandoned & GalaxyTones",
    title: "Shimmer"
  });
});

test("metadata enrichment can migrate cached direct artwork through the bridge", async () => {
  const cacheFile = tempCacheFile("metadata-art-bridge-migrate");
  const service = new MetadataEnrichmentService({
    cacheFile,
    artBridge: {
      cacheUrl: "http://127.0.0.1:8787/api/art/cache",
      timeoutMs: 500
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ url: "https://art.example.com/art/cached.jpg" })
    }),
    tidal: { isConfigured: () => false },
    metadataResolver: null,
    logger: null
  });
  const track = { artist: "Ezequiel Arias", title: "Solar" };
  const entry = {
    status: "found",
    key: service.keyFor(track),
    inputArtist: track.artist,
    inputTitle: track.title,
    artist: track.artist,
    title: track.title,
    confidence: 99,
    imageUrl: "https://resources.tidal.com/images/solar.jpg",
    updatedAt: new Date().toISOString()
  };

  assert.equal(service.shouldBridgeCachedArtwork(entry), true);
  const updated = await service.bridgeCachedArtwork(track, entry);

  assert.equal(updated.imageUrl, "https://art.example.com/art/cached.jpg");
  assert.equal(service.cachedEntry(track).imageUrl, "https://art.example.com/art/cached.jpg");
});

test("metadata enrichment retries legacy bridge artwork without a source URL", async () => {
  const cacheFile = tempCacheFile("metadata-art-bridge-legacy-refresh");
  const track = { artist: "Agustin Pietrocola", title: "Damage" };
  const legacyUrl = `https://art.darthspader.com/art/${"a".repeat(40)}.jpg`;
  const sourceUrl = "https://resources.tidal.com/images/damage.jpg";
  let tidalCalls = 0;
  const service = new MetadataEnrichmentService({
    cacheFile,
    artBridge: {
      cacheUrl: "http://127.0.0.1:8787/api/art/cache",
      timeoutMs: 500
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ url: legacyUrl })
    }),
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => {
        tidalCalls += 1;
        return {
          artist: track.artist,
          title: track.title,
          imageUrl: sourceUrl,
          durationMs: 414000
        };
      }
    },
    metadataResolver: null,
    logger: null
  });

  service.cache.set(service.keyFor(track), {
    status: "found",
    key: service.keyFor(track),
    inputArtist: track.artist,
    inputTitle: track.title,
    artist: track.artist,
    title: track.title,
    confidence: 99,
    imageUrl: legacyUrl,
    updatedAt: new Date().toISOString()
  });

  assert.equal(service.shouldLookup(track), true);
  const entry = await service.enrich(track);

  assert.equal(tidalCalls, 1);
  assert.equal(entry.imageUrl, legacyUrl);
  assert.equal(entry.sourceImageUrl, sourceUrl);
  assert.equal(service.shouldLookup(track), false);
});

test("metadata enrichment does not display audio quality tags as genre", async () => {
  const cacheFile = tempCacheFile("metadata-quality-genre");
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => ({
        artist: "Ezequiel Arias",
        title: "Solar",
        genre: "HIRES_LOSSLESS",
        mediaTags: ["LOSSLESS"],
        durationMs: 310000
      })
    },
    metadataResolver: null,
    logger: null
  });

  const entry = await service.enrich({ artist: "Ezequiel Arias", title: "Solar" });
  assert.equal(entry.genre, "");
});

test("metadata enrichment records misses so weak matches are not searched repeatedly", async () => {
  const cacheFile = tempCacheFile("metadata-miss");
  let calls = 0;
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => {
        calls += 1;
        return {
          artist: "Wrong Artist",
          title: "Small Things",
          durationMs: 526000
        };
      }
    },
    metadataResolver: null,
    logger: null
  });

  const first = await service.enrich({ artist: "Lab's Cloud", title: "Small Things" });
  const second = await service.enrich({ artist: "Lab's Cloud", title: "Small Things" });

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls, 1);
  assert.equal(service.cachedEntry({ artist: "Lab's Cloud", title: "Small Things" }).status, "missing");
});

test("metadata enrichment retries stale misses without hammering lookup providers", async () => {
  const cacheFile = tempCacheFile("metadata-stale-miss");
  let now = 1_000_000;
  let calls = 0;
  const service = new MetadataEnrichmentService({
    cacheFile,
    missRetryMs: 30_000,
    clock: () => now,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            artist: "Wrong Artist",
            title: "Small Things"
          };
        }
        return {
          id: "2",
          artist: "Lab's Cloud",
          title: "Small Things",
          durationMs: 526000,
          tidalUrl: "https://tidal.com/browse/track/2"
        };
      }
    },
    metadataResolver: null,
    logger: null
  });

  assert.equal(await service.enrich({ artist: "Lab's Cloud", title: "Small Things" }), null);
  assert.equal(await service.enrich({ artist: "Lab's Cloud", title: "Small Things" }), null);
  assert.equal(calls, 1);

  now += 30_001;
  const retried = await service.enrich({ artist: "Lab's Cloud", title: "Small Things" });
  assert.equal(retried.id, "2");
  assert.equal(calls, 2);
});

test("metadata enrichment retries legacy found entries that never checked artwork", async () => {
  const cacheFile = tempCacheFile("metadata-artwork-retry");
  let calls = 0;
  const service = new MetadataEnrichmentService({
    cacheFile,
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => {
        calls += 1;
        return {
          id: "2",
          artist: "Ambyion, Abandoned, GalaxyTones",
          title: "Shimmer",
          durationMs: 246000,
          imageUrl: "https://resources.tidal.com/shimmer.jpg",
          tidalUrl: "https://tidal.com/browse/track/2"
        };
      }
    },
    metadataResolver: null,
    logger: null
  });

  const track = { artist: "Ambyion, Abandoned & GalaxyTones", title: "Shimmer" };
  service.cache.set(service.keyFor(track), {
    status: "found",
    key: service.keyFor(track),
    inputArtist: "Ambyion, Abandoned & GalaxyTones",
    inputTitle: "Shimmer",
    artist: "Ambyion, Abandoned, GalaxyTones",
    title: "Shimmer",
    confidence: 99,
    imageUrl: "",
    updatedAt: new Date().toISOString()
  });

  const entry = await service.enrich(track);
  assert.equal(calls, 1);
  assert.equal(entry.imageUrl, "https://resources.tidal.com/shimmer.jpg");
});
