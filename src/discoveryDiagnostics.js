"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const text = value => String(value ?? "").trim();
const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const bounded = (value, fallback, max = 40) => Math.max(1, Math.min(max, Math.trunc(Number(value) || fallback)));

function scalarFields(value = {}) {
  return Object.fromEntries(Object.entries(value || {})
    .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 500) : item]));
}

function smallDiagnostic(value, depth = 2) {
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return depth > 0 ? value.slice(0, 5).map(item => smallDiagnostic(item, depth - 1)) : [];
  if (!value || typeof value !== "object") return value;
  if (depth <= 0) return scalarFields(value);
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, smallDiagnostic(item, depth - 1)]));
}

// Keep raw provider/candidate traces in the app's session, outside model context.
// This projection only changes transport: counts, scores and queue inputs are untouched.
function compactDiscoveryVerification(verification = {}) {
  const pool = verification.poolDiagnostics;
  const queries = verification.querySelectionDiagnostics || [];
  const summary = {
    ...scalarFields(verification),
    diagnosticsDetail: "summary",
    diagnosticsLimits: { queryExamples: 8, nestedExamples: 5, fullTrace: "local-last-session" },
    querySelectionCount: queries.length,
    querySelectionDiagnostics: queries.slice(0, 8).map(query => ({
      ...scalarFields(Object.fromEntries(["query", "source", "lane", "genreCompatibilityScore", "historicalYieldContribution", "currentIntentContribution", "budgetCost", "catalogReturnedCount", "catalogAcceptedCount"]
        .map(key => [key, query[key]]))),
      whySelected: smallDiagnostic(query.whySelected || [])
    })),
    tidalErrors: smallDiagnostic(verification.tidalErrors || [])
  };
  for (const key of ["intent", "admissionGates", "recommendationV2", "modelCandidateReview", "modelRouting", "queryYield", "deepCatalog", "queryRecovery"]) {
    if (verification[key] !== undefined) summary[key] = smallDiagnostic(verification[key]);
  }
  if (pool) {
    summary.poolDiagnostics = { ...scalarFields(pool) };
    for (const key of ["artistSpread", "diversityCaps", "recentNovelty", "queryYield", "finalSelection", "deepCatalog", "queryRecovery", "lanes", "buckets", "notes"]) {
      if (pool[key] !== undefined) summary.poolDiagnostics[key] = smallDiagnostic(pool[key]);
    }
    if (pool.candidateAccumulation) {
      summary.poolDiagnostics.candidateAccumulation = {
        ...scalarFields(pool.candidateAccumulation),
        durationCandidatesCount: pool.candidateAccumulation.durationCandidates?.length || 0
      };
    }
  }
  return summary;
}

function compactSonicTrack(track = {}) {
  const evidence = track.recommendationV2 || track.scoreBreakdown?.recommendationV2;
  if (!evidence) return null;
  return {
    available: Boolean(evidence.available),
    applied: Boolean(evidence.applied),
    reason: text(evidence.reason),
    identityKey: text(evidence.identityKey),
    scoreBefore: number(evidence.originalScore),
    sonicDelta: number(evidence.sonicAdjustment),
    scoreAfter: number(evidence.finalScore),
    wouldBeScoreAfter: number(evidence.wouldBeFinalScore),
    rankBefore: number(evidence.rankBefore),
    rankAfter: number(evidence.rankAfter),
    wouldBeRankAfter: number(evidence.wouldBeRankAfter),
    cluster: text(evidence.clusterName || evidence.clusterKey)
  };
}

function compactSonicRun(result = {}) {
  const evidence = result.verification?.recommendationV2;
  const counts = {};
  for (const track of [...(result.tracks || []), ...(result.alternates || [])]) {
    const sonic = compactSonicTrack(track);
    if (sonic && !sonic.available) counts[sonic.reason || "unknown"] = (counts[sonic.reason || "unknown"] || 0) + 1;
  }
  const mode = text(evidence?.productionMode || evidence?.mode) || "unknown";
  return {
    sonicInvoked: evidence?.invoked ?? Boolean(evidence && evidence.reason !== "not-configured"),
    mode,
    sonicBlendApplied: mode === "blend" && evidence?.applied === true,
    applied: Boolean(evidence?.applied),
    reason: text(evidence?.reason) || "sonic-stage-not-reached",
    model: text(evidence?.model),
    modelVersion: text(evidence?.modelVersion),
    maxAdjustmentPoints: number(evidence?.maxAdjustmentPoints),
    candidateCount: number(evidence?.candidateCount),
    scoredCount: number(evidence?.scoredCount),
    coverage: number(evidence?.coverage),
    missingEmbeddingCount: number(evidence?.missingEmbeddingCount),
    lazyFillQueuedCount: number(evidence?.lazyFillQueuedCount),
    lazyFillAlreadyInFlightCount: number(evidence?.lazyFillAlreadyInFlightCount),
    lazyFillFailedCount: number(evidence?.lazyFillFailedCount),
    lazyFillError: text(evidence?.lazyFillError),
    sonicScoredCount: number(evidence?.scoredCount),
    sonicCoverage: number(evidence?.coverage),
    coverageThresholdMet: evidence?.coverageThresholdMet ?? (number(evidence?.scoredCount) !== null && number(evidence?.minScored) !== null
      && evidence.scoredCount >= evidence.minScored && evidence.coverage >= evidence.minCoverage),
    backfillQueueDepth: number(evidence?.backfillQueueDepth),
    minScored: number(evidence?.minScored),
    minCoverage: number(evidence?.minCoverage),
    adjustedCount: number(evidence?.adjustedCount),
    orderingChanged: Boolean(evidence?.orderingChanged),
    rankScope: "candidate-pool-score-before-diversity-and-playback-checks",
    returnedUnscoredReasons: counts
  };
}

function reportTrack(track, index) {
  return {
    position: index + 1,
    tidalId: text(track.tidal?.id || track.tidalId || track.tidalTrackId),
    artist: text(track.artist).slice(0, 200),
    title: text(track.title).slice(0, 240),
    score: number(track.score ?? track.scoreBreakdown?.total),
    sonic: compactSonicTrack(track)
  };
}

function buildDiscoveryDiagnostics(options = {}, result = {}, { runId, completedAt } = {}) {
  return {
    ok: true,
    runId,
    completedAt,
    request: text(options.request).slice(0, 1000),
    requested: number(result.verification?.requested || result.requestedCount || options.count),
    returned: (result.tracks || []).length,
    alternateCount: (result.alternates || []).length,
    sonic: compactSonicRun(result),
    tracks: (result.tracks || []).slice(0, 40).map(reportTrack),
    alternates: (result.alternates || []).slice(0, 40).map(reportTrack)
  };
}

class DiscoveryDiagnosticsStore {
  constructor({ file = path.join(__dirname, "..", "data", "discovery-diagnostics.json"), sessionStore = null, maxRuns = 20, logger = console } = {}) {
    this.file = file;
    this.sessionStore = sessionStore;
    this.maxRuns = bounded(maxRuns, 20, 50);
    this.logger = logger;
  }

  readReports() {
    let reports = [];
    try {
      reports = JSON.parse(fs.readFileSync(this.file, "utf8")).runs;
      if (!Array.isArray(reports)) throw new Error("Invalid discovery diagnostics archive");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // The existing last-session file makes the pre-upgrade run recoverable too.
    // Reading diagnostics never reruns discovery or changes history/feedback.
    const session = this.sessionStore?.read();
    if (session?.result && session.updatedAt) {
      const runId = session.result.discoveryRunId || `legacy-${crypto.createHash("sha256")
        .update(JSON.stringify([session.options?.request, session.result.verification, session.result.tracks?.map(t => [t.tidal?.id || t.tidalId, t.artist, t.title])]))
        .digest("hex").slice(0, 20)}`;
      if (!reports.some(report => report.runId === runId)) {
        reports.push({
          ...buildDiscoveryDiagnostics(session.options, session.result, {
            runId, completedAt: session.result.discoveryCompletedAt || null
          }),
          sessionUpdatedAt: session.updatedAt
        });
      }
    }
    return reports.sort((a, b) => String(b.completedAt || b.sessionUpdatedAt).localeCompare(String(a.completedAt || a.sessionUpdatedAt))).slice(0, this.maxRuns);
  }

  record(options, result) {
    const report = buildDiscoveryDiagnostics(options, result, {
      runId: crypto.randomUUID(), completedAt: new Date().toISOString()
    });
    let persisted = false;
    try {
      const runs = [report, ...this.readReports()].slice(0, this.maxRuns);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ runs }));
      fs.renameSync(temporary, this.file);
      persisted = true;
    } catch (error) {
      // Optional diagnostics must not turn completed discovery into an error.
      // The normal last-session save still retains the annotated result.
      this.logger?.warn?.("Discovery diagnostics archive unavailable", { error: error.message });
    }
    return {
      ...result,
      discoveryRunId: report.runId,
      discoveryCompletedAt: report.completedAt,
      discoveryDiagnosticsPersisted: persisted,
      sonicDiagnostics: report.sonic,
      mcpVerification: compactDiscoveryVerification(result.verification),
      tracks: (result.tracks || []).map(track => ({ ...track, sonic: compactSonicTrack(track) })),
      alternates: (result.alternates || []).map(track => ({ ...track, sonic: compactSonicTrack(track) }))
    };
  }

  get({ runId = "", limit = 10, includeAlternates = false } = {}) {
    const reports = this.readReports();
    const report = runId ? reports.find(item => item.runId === text(runId)) : reports[0];
    if (!report) {
      const error = new Error(runId ? "Discovery diagnostics run was not found or has expired." : "No completed discovery run is available.");
      error.statusCode = 404;
      throw error;
    }
    const count = bounded(limit, 10);
    return {
      ...report,
      tracks: report.tracks.slice(0, count),
      alternates: includeAlternates ? report.alternates.slice(0, count) : [],
      recentRuns: reports.slice(0, 5).map(item => ({ runId: item.runId, completedAt: item.completedAt, returned: item.returned }))
    };
  }
}

module.exports = { compactDiscoveryVerification, compactSonicTrack, compactSonicRun, buildDiscoveryDiagnostics, DiscoveryDiagnosticsStore };
