"use strict";

const config = require("../src/config");
const { BeatportClient } = require("../src/beatportClient");
const { MusicMemoryStore } = require("../src/musicMemoryStore");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function jitterMs(baseMs, jitterRatio = 0.2) {
  const spread = Math.max(0, baseMs * jitterRatio);
  return Math.round(baseMs + (Math.random() * spread * 2) - spread);
}

function parseArgs(argv) {
  const args = {
    limit: 50,
    dryRun: false,
    delayMs: 2000,
    jitter: 0.2
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--limit") args.limit = Number(argv[++index]) || args.limit;
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++index]) || args.delayMs;
    else if (arg === "--jitter") args.jitter = Number(argv[++index]) || args.jitter;
  }
  return args;
}

async function runBeatportEnrichmentBackfill({
  store = new MusicMemoryStore({ ...config.musicMemory, logger: console }),
  beatport = new BeatportClient({
    ...config.beatport,
    requestsPerSecond: Math.min(Number(config.beatport.requestsPerSecond || 2), 0.5),
    logger: console
  }),
  limit = 50,
  delayMs = 2000,
  jitter = 0.2,
  missingRetryMs = config.beatport.missingRetryMs,
  dryRun = false,
  logger = console
} = {}) {
  const tracks = store.tracksMissingBeatportEnrichment(limit);
  const result = {
    dryRun,
    scanned: tracks.length,
    enriched: 0,
    missing: 0,
    failed: 0,
    beatportDiagnostics: beatport.status?.().diagnostics || null
  };
  if (dryRun) {
    logger.log(JSON.stringify({ ...result, sample: tracks.slice(0, 10) }, null, 2));
    return result;
  }
  for (const [index, track] of tracks.entries()) {
    if (index > 0) await sleep(jitterMs(delayMs, jitter));
    try {
      const found = store.findBeatportEnrichment(track);
      if (found) continue;
      if (store.beatportLookupBlocked?.(track)) continue;
      const enrichment = await beatport.findTrack(track);
      if (enrichment) {
        store.saveBeatportEnrichment(track, enrichment, { confidence: enrichment.confidence || 0 });
        store.saveProviderEnrichment(track, "beatport", {
          ...enrichment,
          providerTrackId: enrichment.id,
          fetchedAt: new Date().toISOString()
        });
        store.saveEnrichmentAttempt(track, "beatport", {
          status: "found",
          confidence: enrichment.confidence || 0,
          fetchedAt: new Date().toISOString()
        });
        result.enriched += 1;
      } else {
        store.saveEnrichmentAttempt(track, "beatport", {
          status: "missing",
          nextRetryAt: new Date(Date.now() + Math.max(60_000, Number(missingRetryMs) || 604800000)).toISOString(),
          fetchedAt: new Date().toISOString()
        });
        result.missing += 1;
      }
    } catch (error) {
      store.saveEnrichmentAttempt(track, "beatport", {
        status: /429|rate/i.test(error.message || "") ? "rate_limited" : "failed",
        error: error.message,
        nextRetryAt: new Date(Date.now() + Math.max(60_000, Number(error.retryAfterMs || missingRetryMs) || 604800000)).toISOString(),
        fetchedAt: new Date().toISOString()
      });
      result.failed += 1;
    }
    if ((index + 1) % 10 === 0) logger.log(`Beatport enrichment backfill progress: ${index + 1}/${tracks.length}`);
  }
  result.beatportDiagnostics = beatport.status?.().diagnostics || null;
  logger.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  runBeatportEnrichmentBackfill(parseArgs(process.argv.slice(2)))
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  jitterMs,
  runBeatportEnrichmentBackfill
};
