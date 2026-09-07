"use strict";

const { tidalEnrichmentMatches } = require("./tidalMatchRules");

function createRoonTidalEnricher({
  tidal,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  async function enrichRoonTrackWithTidal(track, options = {}) {
    if (!tidal.isConfigured()) return track;
    const timeoutMs = Math.max(150, Math.min(2000, Number(options.timeoutMs || 750)));
    try {
      const verified = await Promise.race([
        tidal.verify(track, { strict: false }).catch(() => null),
        wait(timeoutMs).then(() => null)
      ]);
      if (!verified) return track;
      if (!tidalEnrichmentMatches(track, verified)) {
        return {
          ...track,
          tidalError: `TIDAL enrichment did not exactly match ${track.artist} - ${track.title}.`
        };
      }
      return {
        ...track,
        artist: verified.artist || track.artist,
        title: verified.title || track.title,
        album: verified.album || track.album || "",
        label: verified.label || track.label || "",
        year: verified.year || track.year || null,
        releaseDate: verified.releaseDate || track.releaseDate || "",
        durationMs: verified.durationMs || track.durationMs || null,
        tidal: verified,
        verificationSource: "roon+tidal"
      };
    } catch (error) {
      return {
        ...track,
        tidalError: error.message
      };
    }
  }

  async function enrichRoonTracksOpportunistically(tracks = [], options = {}) {
    const startedAt = Date.now();
    const circuitState = tidal.status?.()?.circuit?.state || "";
    if (!tidal.isConfigured()) {
      return {
        tracks,
        stats: {
          enabled: false,
          skipped: true,
          reason: "TIDAL is not configured.",
          attempted: 0,
          enriched: 0,
          elapsedMs: 0
        }
      };
    }
    if (["open", "half-open"].includes(circuitState)) {
      return {
        tracks,
        stats: {
          enabled: true,
          skipped: true,
          reason: `TIDAL circuit is ${circuitState}.`,
          attempted: 0,
          enriched: 0,
          elapsedMs: 0
        }
      };
    }

    const requestedCount = Math.max(1, Number(options.requestedCount || 8));
    const deep = Boolean(options.deep);
    const strict = Boolean(options.strict);
    const limit = Math.min(
      tracks.length,
      Number(options.limit || (strict
        ? Math.min(deep ? 30 : 22, Math.max(requestedCount * 2, requestedCount + 8))
        : Math.min(deep ? 24 : 16, Math.max(requestedCount + 4, 10))))
    );
    const budgetMs = Math.max(800, Math.min(5000, Number(options.budgetMs || (deep ? 3200 : 2200))));
    const perTrackTimeoutMs = Math.max(150, Math.min(1200, Number(options.perTrackTimeoutMs || 650)));
    const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 5)));
    const result = tracks.slice();
    let nextIndex = 0;
    let attempted = 0;
    let enriched = 0;
    let timedOut = false;

    async function worker() {
      while (nextIndex < limit) {
        const elapsed = Date.now() - startedAt;
        const remaining = budgetMs - elapsed;
        if (remaining <= 120) {
          timedOut = true;
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        attempted += 1;
        const candidate = await enrichRoonTrackWithTidal(tracks[index], {
          timeoutMs: Math.min(perTrackTimeoutMs, remaining)
        });
        result[index] = candidate;
        if (candidate?.tidal?.tidalUrl) enriched += 1;
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, limit) }, worker));
    const elapsedMs = Date.now() - startedAt;
    return {
      tracks: result,
      stats: {
        enabled: true,
        skipped: false,
        attempted,
        enriched,
        limit,
        candidateCount: tracks.length,
        budgetMs,
        perTrackTimeoutMs,
        concurrency,
        timedOut,
        elapsedMs
      }
    };
  }

  return {
    enrichRoonTrackWithTidal,
    enrichRoonTracksOpportunistically
  };
}

module.exports = {
  createRoonTidalEnricher
};
