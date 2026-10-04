"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");

function tempDbFile() {
  return path.join(os.tmpdir(), `rabbit-hole-recommendation-v2-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function cleanDb(file) {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
}

test("Recommendation Engine v2 stays opt-in and does not expose production discovery", () => {
  const engine = new RecommendationEngineV2({ enabled: false, dbFile: tempDbFile(), logger: null });
  assert.equal(engine.status().enabled, false);
  assert.equal(engine.status().productionDiscoveryEnabled, false);
  assert.equal(engine.status().sonicNeighborCandidates.productionIntegrated, false);
  assert.throws(() => engine.findSonicNeighbors("tidal:123"), /disabled/);
  engine.store.close();
});

test("Recommendation Engine v2 returns explainable sonic neighbors from stored vectors", () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  const model = { model: "test-model", modelVersion: "1" };
  engine.store.upsertEmbedding({ ...model, track: { artist: "Seed Artist", title: "Seed Track" }, vector: [1, 0] });
  engine.store.upsertEmbedding({ ...model, track: { artist: "Close Artist", title: "Close Track" }, vector: [1, 0.01] });
  engine.store.upsertEmbedding({ ...model, track: { artist: "Far Artist", title: "Far Track" }, vector: [0, 1] });

  const result = engine.findSonicNeighbors({
    track: { artist: "Seed Artist", title: "Seed Track" },
    provider: model.model,
    modelVersion: model.modelVersion,
    count: 1,
    analyzeIfMissing: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.query.track.title, "Seed Track");
  assert.equal(result.neighbors[0].track.title, "Close Track");
  assert.ok(result.neighbors[0].similarity > 0.99);
  assert.equal(result.diagnostics.returned, 1);
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 neighbor candidates default to the versioned discovery model", () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    discoveryModel: "discogs-effnet",
    discoveryModelVersion: "1",
    embeddingProviderInstance: {
      name: "spectral-baseline",
      modelVersion: "1",
      status: () => ({ available: true, provider: "test", model: "spectral-baseline", modelVersion: "1" })
    }
  });
  engine.store.upsertEmbedding({
    identityKey: "tidal:neighbor-seed",
    track: { artist: "Seed Artist", title: "Seed Track", tidalId: "neighbor-seed" },
    vector: [1, 0],
    model: "discogs-effnet",
    modelVersion: "1"
  });
  engine.store.upsertEmbedding({
    identityKey: "tidal:neighbor-result",
    track: { artist: "Neighbor Artist", title: "Neighbor Track", tidalId: "neighbor-result" },
    vector: [0.99, 0.1],
    model: "discogs-effnet",
    modelVersion: "1"
  });

  const result = engine.generateSonicNeighborCandidates({ anchor: "tidal:neighbor-seed", count: 1 });
  assert.equal(result.diagnostics.model, "discogs-effnet");
  assert.equal(result.diagnostics.modelVersion, "1");
  assert.equal(result.candidates[0].identityKey, "tidal:neighbor-result");
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 resolves genre evidence from stored enrichment and review profiles", () => {
  const dbFile = tempDbFile();
  const memory = new (require("../src/musicMemoryStore").MusicMemoryStore)({ enabled: true, dbFile, logger: null });
  memory.upsertTrackIdentity({ tidalId: "123456789", artist: "Stored Artist", title: "Stored Track" });
  memory.saveBeatportEnrichment({ tidalId: "123456789", artist: "Stored Artist", title: "Stored Track" }, {
    id: "bp-genre-anchor", genre: "House", subGenre: "Progressive House", label: "Stored Label"
  }, { confidence: 96 });
  const engine = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  const evidence = engine.resolveSonicGenreEvidence({
    identityKey: "tidal:123456789", tidalId: "123456789", artist: "Stored Artist", title: "Stored Track"
  });
  assert.ok(evidence.inferred.some((item) => item.value === "House" && item.source === "beatport-enrichment"));
  assert.ok(evidence.sources.includes("artist-history") || evidence.sources.includes("beatport-enrichment"));
  assert.equal(evidence.inferred.some((item) => item.source === "playlist-membership"), false);
  engine.store.close();
  memory.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 exposes strict anchor identity failure diagnostics", async () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    tidalClient: { getTrack: async () => null }
  });
  await assert.rejects(
    () => engine.prepareSonicAnchor("https://tidal.com/browse/track/404404"),
    (error) => error.statusCode === 404 && error.identityDiagnostics?.failureType === "NOT_FOUND"
      && error.identityDiagnostics.identityRules.includes("tidal-track-id-not-found")
  );
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 accepts harmless TIDAL credit additions during anchor validation", async () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    tidalClient: {
      getTrack: async () => ({
        id: "123456789",
        artist: "Simon Doty, Roland Clark",
        title: "Universal Language",
        durationMs: 360000,
        tidalUrl: "https://tidal.com/browse/track/universal-language"
      })
    }
  });
  const resolved = await engine.resolveTidalTrackReference({
    tidalId: "123456789",
    artist: "Simon Doty",
    title: "Universal Language"
  });
  assert.equal(resolved.id, "123456789");
  assert.equal(resolved.identityOutcome, "VERIFIED_EQUIVALENT_RECORDING");
  assert.equal(resolved.identityDiagnostics.artistRelation.type, "requested-artists-subset");
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 can safely resolve a TIDAL anchor from artist/title without weakening identity", async () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    tidalClient: {
      findExactTrack: async () => ({
        id: "be-someone",
        artist: "Joachim Pastor, EKE",
        title: "Be Someone",
        durationMs: 300000
      })
    }
  });
  const resolved = await engine.resolveTidalTrackReference({ artist: "Joachim Pastor", title: "Be Someone" });
  assert.equal(resolved.id, "be-someone");
  assert.equal(resolved.identityOutcome, "VERIFIED_EQUIVALENT_RECORDING");

  const unsafeDbFile = tempDbFile();
  const unsafe = new RecommendationEngineV2({
    enabled: true,
    dbFile: unsafeDbFile,
    logger: null,
    tidalClient: { findExactTrack: async () => ({ id: "wrong", artist: "Other Artist", title: "Be Someone" }) }
  });
  await assert.rejects(
    () => unsafe.resolveTidalTrackReference({ artist: "Joachim Pastor", title: "Be Someone" }),
    error => error.statusCode === 422 && error.identityDiagnostics?.failureType === "ARTIST_CONFLICT"
      && error.identityDiagnostics?.artistOverlapType === "conflicting-artist-identity"
  );
  engine.store.close();
  cleanDb(dbFile);
  unsafe.store.close();
  cleanDb(unsafeDbFile);
});

test("Recommendation Engine v2 reports rejected Beatport proxy identity without loosening the matcher", async () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    tidalClient: { getTrack: async () => ({ id: "987654321", tidalId: "987654321", artist: "Anchor Artist", title: "Anchor Track", durationMs: 360000 }) },
    beatportClient: {
      isConfigured: () => true,
      findTrack: async () => ({ id: "bp-wrong", artist: "Other Artist", title: "Anchor Track (Remix)", mixName: "Remix" }),
      fetchPreviewBuffer: async () => { throw new Error("must not fetch a rejected preview"); }
    }
  });
  await assert.rejects(
    () => engine.analyzeBeatportPreviewForTidalTrack("https://tidal.com/browse/track/987654321"),
    (error) => error.statusCode === 422
      && error.identityDiagnostics?.beatportCandidateFound === true
      && error.identityDiagnostics?.beatportCandidateRejected === true
      && error.identityDiagnostics?.candidateIdentities?.[0]?.id === "bp-wrong"
      && ["VERSION_MISMATCH", "UNSAFE_PROXY", "AMBIGUOUS"].includes(error.identityDiagnostics.failureType)
  );
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 finds an existing profile using the active provider and model version", () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    embeddingProviderInstance: {
      name: "discogs-effnet",
      modelVersion: "1",
      status: () => ({ available: true, provider: "discogs-effnet", model: "discogs-effnet", modelVersion: "1" })
    }
  });
  engine.store.upsertEmbedding({
    identityKey: "tidal:296877987",
    track: { artist: "Luci / Point.Blank / Point Blank", title: "Wonky", tidalId: "296877987" },
    vector: [1, 0],
    model: "discogs-effnet",
    modelVersion: "1"
  });

  const profile = engine.findStoredSonicProfile({ tidalUrl: "https://tidal.com/browse/track/296877987" });
  assert.equal(profile.identityKey, "tidal:296877987");
  assert.equal(profile.model, "discogs-effnet");
  assert.equal(profile.modelVersion, "1");
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 prepares a missing TIDAL anchor from a nested Beatport hint and reuses it", async () => {
  const dbFile = tempDbFile();
  let findCalls = 0;
  let requestedOptions = null;
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    embeddingProviderInstance: {
      name: "discogs-effnet",
      modelVersion: "1",
      status: () => ({ available: true, provider: "test", model: "discogs-effnet", modelVersion: "1" }),
      extractBuffer: () => ({ vector: [1, 0], model: "discogs-effnet", modelVersion: "1", sampleRate: 16000, audioDurationMs: 1000, metadata: {} })
    },
    beatportClient: {
      isConfigured: () => true,
      findTrack: async (_track, options) => {
        findCalls += 1;
        requestedOptions = options;
        return { id: "bp-1", artist: "Anchor Artist", title: "Anchor Track", mixName: "Original Mix", label: "Anchor Label", releaseDate: "2026-09-13" };
      },
      fetchPreviewBuffer: async () => ({ buffer: Buffer.from("anchor-preview"), previewUrl: "https://example.test/anchor-preview.mp3", bytes: 14, contentType: "audio/mpeg", previewDurationMs: 1000 })
    }
  });
  const reference = {
    tidalId: "123456789",
    tidalUrl: "https://tidal.com/browse/track/123456789",
    artist: "Anchor Track",
    title: "Anchor Artist",
    metadataEnrichment: {
      confidence: 99,
      artist: "Anchor Artist",
      title: "Anchor Track",
      label: "Anchor Label",
      releaseDate: "2026-09-13",
      beatport: { id: "bp-1" }
    }
  };

  const first = await engine.prepareSonicAnchor(reference, { model: "discogs-effnet", modelVersion: "1" });
  assert.equal(first.ready, true);
  assert.equal(first.prepared, true);
  assert.equal(first.source, "beatport-preview");
  assert.equal(requestedOptions.beatportTrackId, "bp-1");

  const second = await engine.prepareSonicAnchor(reference, { model: "discogs-effnet", modelVersion: "1" });
  assert.equal(second.ready, true);
  assert.equal(second.prepared, false);
  assert.equal(second.source, "stored-sonic-embedding");
  assert.equal(findCalls, 1);
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 exposes versioned batch storage through its public wrapper", () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  const stored = engine.storeExtraction({
    identityKey: "beatport:batch-test",
    track: { artist: "Batch Artist", title: "Batch Track", beatportTrackId: "batch-test" },
    extraction: {
      vector: [3, 4],
      model: "discogs-effnet",
      modelVersion: "1",
      sampleRate: 16000,
      audioDurationMs: 120000,
      metadata: { batchExecution: "warm-worker", output: "PartitionedCall:1" }
    },
    sourcePath: "C:\\temp\\batch-test.flac",
    sourceSha256: "batch-sha"
  });
  assert.equal(stored.ok, true);
  assert.equal(stored.model, "discogs-effnet");
  assert.equal(stored.dimensions, 2);
  assert.equal(engine.store.getEmbedding("beatport:batch-test").track.metadata.batchExecution, "warm-worker");
  engine.store.close();
  cleanDb(dbFile);
});

test("the ANUQRAM anchor prepares and reuses an exact partial-preview profile under its TIDAL identity", async () => {
  const { tidal, beatport } = require("./fixtures/anuqram-remix.json");
  const dbFile = tempDbFile();
  const audio = Buffer.from("test-remix-preview");
  let downloads = 0;
  const engine = new RecommendationEngineV2({
    enabled: true, dbFile, logger: null,
    tidalClient: { getTrack: async () => ({ ...tidal }) },
    embeddingProviderInstance: {
      name: "test-audio", modelVersion: "1",
      status: () => ({ available: true, model: "test-audio", modelVersion: "1" }),
      extractBuffer: () => ({ vector: [1, 2, 3], model: "test-audio", modelVersion: "1", audioDurationMs: 120000, metadata: {} })
    },
    beatportClient: {
      findTrack: async (track, options) => {
        assert.equal(track.durationMs, 472000);
        assert.equal(options.beatportTrackId, beatport.id);
        return { ...beatport };
      },
      fetchPreviewBuffer: async () => {
        downloads += 1;
        return { buffer: audio, bytes: audio.length, previewUrl: "https://example.test/remix.mp3", previewDurationMs: 120000 };
      }
    }
  });
  try {
    const reference = { ...tidal, tidalId: tidal.id, durationMs: 424000 };
    const result = await engine.prepareSonicAnchor(reference, { beatportTrackId: beatport.id, allowVersionProxy: false });
    assert.equal(result.ready, true);
    assert.equal(result.prepared, true);
    assert.equal(result.identityKey, "tidal:502471838");
    const profile = engine.findStoredSonicProfile(reference);
    assert.equal(profile.track.title, tidal.title);
    assert.equal(profile.track.metadata.identityRelation, "exact");
    assert.equal(profile.track.metadata.sourceType, "beatport-preview");
    assert.equal(profile.track.metadata.partialPreview, true);
    assert.equal(profile.track.metadata.identityDiagnostics.exactRemixIdentity, true);
    assert.equal(profile.track.metadata.sourceTrackId, beatport.id);
    assert.equal(profile.track.metadata.canonicalTrackId, tidal.id);
    assert.ok(audio.every(byte => byte === 0), "preview bytes are cleared after analysis");
    assert.equal((await engine.prepareSonicAnchor(reference)).prepared, false);
    assert.equal(downloads, 1);
  } finally {
    engine.store.close();
    cleanDb(dbFile);
  }
});

test("Recommendation Engine v2 stores a Beatport version proxy under the canonical TIDAL identity", async () => {
  const dbFile = tempDbFile();
  const audio = Buffer.from("transient beatport preview");
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    embeddingProviderInstance: {
      name: "test-audio",
      modelVersion: "1",
      status: () => ({ available: true, provider: "test", model: "test-audio", modelVersion: "1" }),
      extractBuffer: () => ({
        vector: [1, 2, 3],
        model: "test-audio",
        modelVersion: "1",
        sampleRate: 16000,
        audioDurationMs: 1000,
        metadata: {}
      })
    },
    tidalClient: {
      getTrack: async () => ({
        id: "555732256",
        tidalId: "555732256",
        tidalUrl: "https://tidal.com/browse/track/555732256",
        artist: "D-Nox, M.O.S.",
        title: "Dream On",
        label: "Sprout",
        releaseDate: "2026-09-11",
        durationMs: 232000,
        isrc: "US83Z2657966"
      })
    },
    beatportClient: {
      isConfigured: () => true,
      findTrack: async () => ({
        id: "30374303",
        artist: "D-Nox, M.O.S.",
        title: "Dream On",
        mixName: "Extended Mix",
        label: "Sprout",
        releaseDate: "2026-09-11",
        durationMs: 410322,
        isrc: "US83Z2657964",
        previewUrl: "https://geo-samples.beatport.com/preview.mp3"
      }),
      fetchPreviewBuffer: async () => ({
        track: { id: "30374303", title: "Dream On", mixName: "Extended Mix" },
        buffer: audio,
        bytes: audio.length,
        contentType: "audio/mpeg",
        previewUrl: "https://geo-samples.beatport.com/preview.mp3",
        previewDurationMs: 120000
      })
    }
  });

  const result = await engine.analyzeBeatportPreviewForTidalTrack("https://tidal.com/track/555732256/u");
  assert.equal(result.ok, true);
  assert.equal(result.identityKey, "tidal:555732256");
  assert.equal(result.relation, "version-proxy");
  const stored = engine.store.getEmbedding("tidal:555732256", { model: "test-audio", modelVersion: "1" });
  assert.equal(stored.track.title, "Dream On");
  assert.equal(stored.track.metadata.identityRelation, "version-proxy");
  assert.equal(stored.track.metadata.partialPreview, true);
  assert.equal(stored.track.metadata.sourceTrackId, "30374303");
  engine.store.close();
  cleanDb(dbFile);
});

test("Recommendation Engine v2 parses a supplied TIDAL URL before storing profile identity metadata", async () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile,
    logger: null,
    embeddingProviderInstance: {
      name: "test-audio",
      modelVersion: "1",
      status: () => ({ available: true, provider: "test", model: "test-audio", modelVersion: "1" }),
      extractBuffer: () => ({ vector: [1, 0], model: "test-audio", modelVersion: "1", sampleRate: 16000, audioDurationMs: 1000, metadata: {} })
    },
    beatportClient: {
      isConfigured: () => true,
      findTrack: async () => ({ id: "bp-url", artist: "URL Artist", title: "URL Track", mixName: "Original Mix", label: "URL Label", releaseDate: "2026-09-13" }),
      fetchPreviewBuffer: async () => ({ buffer: Buffer.from("url-preview"), previewUrl: "https://example.test/url-preview.mp3", bytes: 11, contentType: "audio/mpeg", previewDurationMs: 1000 })
    }
  });

  await engine.analyzeBeatportPreviewForTidalTrack({
    artist: "URL Artist",
    title: "URL Track",
    tidalUrl: "https://tidal.com/browse/track/777888999",
    label: "URL Label",
    releaseDate: "2026-09-13"
  });
  const row = engine.store.db.prepare("SELECT tidal_id FROM track_sonic_profile WHERE identity_key = ?").get("tidal:777888999");
  assert.equal(row.tidal_id, "777888999");
  engine.store.close();
  cleanDb(dbFile);
});
