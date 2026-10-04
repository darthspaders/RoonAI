"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const {
  LiveSonicAnalysisService,
  SONIC_STATUS,
  sonicSourceDecision
} = require("../src/liveSonicAnalysisService");

function tempDbFile() {
  return path.join(os.tmpdir(), `rabbit-hole-live-sonic-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function track() {
  return { artist: "D-Nox", title: "Dream On", roonIdentity: "roon-item-1", durationMs: 463000 };
}

test("sonic source decision requires a high-confidence Beatport match", () => {
  assert.equal(sonicSourceDecision({ beatport: { id: "bp-1", confidence: 90 } }).status, SONIC_STATUS.READY_BEATPORT_PREVIEW);
  assert.equal(sonicSourceDecision({ beatport: { id: "bp-1", confidence: 70 } }).status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(sonicSourceDecision(null).status, SONIC_STATUS.NEEDS_LOCAL_FILE);
});

test("live track without Beatport metadata is retained and marked NEEDS_LOCAL_FILE", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const service = new LiveSonicAnalysisService({
    enabled: true,
    musicMemory: memory,
    metadataEnrichment: { enrich: async () => null },
    logger: null
  });

  const result = await service.observe(track());
  assert.equal(result.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  const saved = memory.findSonicAnalysisRequest(track());
  assert.equal(saved.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(saved.required_source, "local_file");
  assert.equal(memory.status().sonicNeedsLocalFileCount, 1);
  memory.close();
});

test("temporary NO_BEATPORT_MATCH is retried on a later observation and auto-analyzed", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  let enrichCalls = 0;
  let analyzeCalls = 0;
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async () => {
        enrichCalls += 1;
        if (enrichCalls === 1) return null;
        return {
          artist: "D-Nox",
          title: "Dream On",
          tidalUrl: "https://tidal.com/browse/track/555732256",
          confidence: 99,
          beatport: { id: "bp-1", confidence: 99 }
        };
      }
    },
    recommendationEngine: {
      enabled: true,
      analyzeBeatportPreviewForTidalTrack: async () => {
        analyzeCalls += 1;
        return { ok: true, match: { relation: "HIGH_CONFIDENCE" } };
      }
    },
    logger: null
  });

  const first = await service.observe(track());
  assert.equal(first.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(first.sourceMatchType, "NO_BEATPORT_MATCH");

  const second = await service.observe(track());
  assert.equal(second.status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  assert.equal(second.analyzed, true);
  assert.equal(enrichCalls, 2);
  assert.equal(analyzeCalls, 1);
  assert.equal(memory.findSonicAnalysisRequest(track()).status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  assert.equal(memory.status().sonicAnalyzedCount, 1);
  memory.close();
});

test("live metadata links a no-Beatport track to its canonical TIDAL identity", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  let analyzeCalls = 0;
  const observed = {
    artist: "Cocho",
    title: "Coast Fantasy",
    roonIdentity: "roon-live-coast-fantasy",
    durationMs: 272000
  };
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async () => ({
        artist: "Cocho",
        title: "Coast Fantasy",
        tidalUrl: "https://tidal.com/browse/track/271991887",
        confidence: 99,
        beatport: {}
      })
    },
    recommendationEngine: {
      enabled: true,
      analyzeBeatportPreviewForTidalTrack: async () => {
        analyzeCalls += 1;
      }
    },
    logger: null
  });

  const result = await service.observe(observed);
  assert.equal(result.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(analyzeCalls, 0);
  assert.equal(result.request.identity_key, "tidal:271991887");
  assert.equal(memory.findSonicAnalysisRequest(observed).identity_key, "tidal:271991887");
  assert.equal(memory.db.prepare("SELECT COUNT(*) AS count FROM sonic_analysis_request").get().count, 1);
  memory.close();
});

test("live Beatport metadata can automatically analyze and fulfill the sonic request", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const calls = [];
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async () => ({
        artist: "D-Nox",
        title: "Dream On",
        tidalUrl: "https://tidal.com/browse/track/555732256",
        confidence: 99,
        beatport: { id: "bp-1", confidence: 99, url: "https://www.beatport.com/track/dream-on/1" }
      })
    },
    recommendationEngine: {
      enabled: true,
      analyzeBeatportPreviewForTidalTrack: async (input) => {
        calls.push(input);
        return { ok: true, match: { relation: "version-proxy" } };
      }
    },
    logger: null
  });

  const result = await service.observe(track());
  assert.equal(result.status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  assert.equal(result.analyzed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].beatportTrackId, "bp-1");
  assert.equal(calls[0].tidalId, "555732256");
  assert.equal(memory.findSonicAnalysisRequest(track()).status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  assert.equal(memory.status().sonicAnalyzedCount, 1);
  memory.close();
});

test("existing sonic profile skips the Beatport preview download and inference", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  let analyzeCalls = 0;
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async () => ({
        artist: "Luci, Point.Blank",
        title: "Wonky",
        tidalUrl: "https://tidal.com/browse/track/296877987",
        confidence: 99,
        beatport: { id: "17771962", confidence: 99 }
      })
    },
    recommendationEngine: {
      enabled: true,
      findStoredSonicProfile: (observed) => {
        assert.equal(observed.tidalUrl, "https://tidal.com/browse/track/296877987");
        return {
          identityKey: "tidal:296877987",
          model: "discogs-effnet",
          modelVersion: "1",
          dimensions: 1280,
          sourceSha256: "existing-sha",
          updatedAt: "2026-09-13T08:31:34.419Z",
          track: { metadata: { identityRelation: "exact" } }
        };
      },
      analyzeBeatportPreviewForTidalTrack: async () => {
        analyzeCalls += 1;
        throw new Error("must not download or analyze an existing profile");
      }
    },
    logger: null
  });

  const result = await service.observe({ ...track(), artist: "Luci / Point.Blank / Point Blank", title: "Wonky" });
  assert.equal(result.status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  assert.equal(result.cached, true);
  assert.equal(result.analyzed, false);
  assert.equal(result.previewDownloaded, false);
  assert.equal(analyzeCalls, 0);
  assert.equal(memory.findSonicAnalysisRequest({ ...track(), artist: "Luci / Point.Blank / Point Blank", title: "Wonky" }).status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  memory.close();
});

test("already fulfilled or local-file-required live tracks are not reprocessed", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const observed = track();
  memory.saveSonicAnalysisRequest(observed, { status: SONIC_STATUS.NEEDS_LOCAL_FILE, reason: "test" });
  let enrichCalls = 0;
  const service = new LiveSonicAnalysisService({
    enabled: true,
    musicMemory: memory,
    metadataEnrichment: { enrich: async () => { enrichCalls += 1; return null; } },
    logger: null
  });
  const result = await service.observe(observed);
  assert.equal(result.skipped, true);
  assert.equal(result.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(enrichCalls, 0);
  memory.close();
});

test("deterministic Beatport rejection becomes terminal NEEDS_LOCAL_FILE and is not retried", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  let enrichCalls = 0;
  let analyzeCalls = 0;
  const observed = { ...track(), roonIdentity: "roon-deterministic-rejection" };
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async () => {
        enrichCalls += 1;
        return {
          artist: "D-Nox",
          title: "Dream On",
          confidence: 99,
          beatport: { id: "bp-1", confidence: 99 }
        };
      }
    },
    recommendationEngine: {
      enabled: true,
      analyzeBeatportPreviewForTidalTrack: async () => {
        analyzeCalls += 1;
        throw Object.assign(new Error("Beatport candidate was rejected: artist credits do not match exactly"), {
          statusCode: 422,
          match: { reasons: ["artist credits do not match exactly"], diagnostics: { artistMatch: false } }
        });
      }
    },
    logger: null
  });

  const first = await service.observe(observed);
  const second = await service.observe(observed);
  assert.equal(first.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(first.sourceMatchType, "BEATPORT_MATCH_REJECTED");
  assert.equal(second.skipped, true);
  assert.equal(second.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(enrichCalls, 1);
  assert.equal(analyzeCalls, 1);
  memory.close();
});

test("transient live analysis failure is suppressed during cooldown and retried after it expires", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  let now = Date.parse("2026-09-13T12:00:00.000Z");
  let analyzeCalls = 0;
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    analysisFailureRetryMs: 15 * 60 * 1000,
    clock: () => now,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async () => ({
        artist: "D-Nox",
        title: "Dream On",
        confidence: 99,
        beatport: { id: "bp-1", confidence: 99 }
      })
    },
    recommendationEngine: {
      enabled: true,
      analyzeBeatportPreviewForTidalTrack: async () => {
        analyzeCalls += 1;
        throw new Error("temporary preview gateway timeout");
      }
    },
    logger: null
  });
  const observed = { ...track(), roonIdentity: "roon-transient-failure" };

  const first = await service.observe(observed);
  const duringCooldown = await service.observe(observed);
  assert.equal(first.status, SONIC_STATUS.ANALYSIS_FAILED);
  assert.equal(duringCooldown.cooldown, true);
  assert.equal(analyzeCalls, 1);

  now += 15 * 60 * 1000 + 1;
  const afterCooldown = await service.observe(observed);
  assert.equal(afterCooldown.status, SONIC_STATUS.ANALYSIS_FAILED);
  assert.equal(analyzeCalls, 2);
  memory.close();
});

test("reversed Roon fields reuse the canonical local-file request", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  memory.saveSonicAnalysisRequest({
    tidalId: "4833868",
    artist: "Charlie Daniels",
    title: "Long Haired Country Boy"
  }, { status: SONIC_STATUS.NEEDS_LOCAL_FILE, reason: "no Beatport match" });
  let enrichCalls = 0;
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async () => {
        enrichCalls += 1;
        return null;
      }
    },
    logger: null
  });

  const reversed = {
    artist: "Long Haired Country Boy",
    title: "The Charlie Daniels Band / Charlie Daniels",
    roonIdentity: "roon-reversed-country"
  };
  const result = await service.observe(reversed);
  assert.equal(result.skipped, true);
  assert.equal(result.status, SONIC_STATUS.NEEDS_LOCAL_FILE);
  assert.equal(enrichCalls, 0);
  assert.equal(memory.findSonicAnalysisRequest(reversed).identity_key, "tidal:4833868");
  memory.close();
});

test("live Beatport analysis stays single-flight when tracks change quickly", async () => {
  const memory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const calls = [];
  let signalFirstStarted;
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve;
  });
  let releaseFirst;
  const firstRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    maxConcurrentAnalyses: 1,
    musicMemory: memory,
    metadataEnrichment: {
      enrich: async (observed) => ({
        artist: observed.artist,
        title: observed.title,
        confidence: 99,
        beatport: { id: `bp-${observed.artist}`, confidence: 99 }
      })
    },
    recommendationEngine: {
      enabled: true,
      analyzeBeatportPreviewForTidalTrack: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          signalFirstStarted();
          await firstRelease;
        }
        return { ok: true, match: { relation: "HIGH_CONFIDENCE" } };
      }
    },
    logger: null
  });

  const first = service.observe({ ...track(), artist: "First Artist", roonIdentity: "roon-first" });
  await firstStarted;
  const second = await service.observe({ ...track(), artist: "Second Artist", roonIdentity: "roon-second" });
  assert.equal(second.deferred, true);
  assert.equal(calls.length, 1);
  assert.equal(service.status().activeAnalyses, 1);
  releaseFirst();
  await first;
  assert.equal(service.status().activeAnalyses, 0);
  memory.close();
});
