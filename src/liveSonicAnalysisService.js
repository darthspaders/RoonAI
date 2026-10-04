"use strict";

const { tidalTrackIdFromUrl } = require("./tidalIdentity");

const LIVE_SONIC_POLICY = "LIVE_BEATPORT_ONLY";
const DEFAULT_ANALYSIS_FAILURE_RETRY_MS = 15 * 60 * 1000;
const SONIC_STATUS = Object.freeze({
  PENDING_METADATA: "PENDING_METADATA",
  READY_BEATPORT_PREVIEW: "READY_BEATPORT_PREVIEW",
  ANALYZING_BEATPORT_PREVIEW: "ANALYZING_BEATPORT_PREVIEW",
  ANALYZED_BEATPORT_PREVIEW: "ANALYZED_BEATPORT_PREVIEW",
  NEEDS_LOCAL_FILE: "NEEDS_LOCAL_FILE",
  ANALYSIS_FAILED: "ANALYSIS_FAILED"
});

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function trackLabel(track = {}) {
  const artist = cleanText(track.artist);
  const title = cleanText(track.title);
  return artist && title ? `${artist} - ${title}` : artist || title || "unknown track";
}

function canonicalTidalId(track = {}) {
  const direct = cleanText(track.tidalId || track.tidal_id || track.tidalTrackId || track.tidal?.id);
  if (/^\d+$/.test(direct)) return direct;
  return tidalTrackIdFromUrl(track.tidalUrl || track.tidal_url || track.tidal?.url || "");
}

function beatportEvidence(entry = {}, minConfidence = 85) {
  const metadata = entry?.metadataEnrichment || entry?.metadata_enrichment || {};
  const beatport = entry?.beatport || metadata.beatport || {};
  const id = cleanText(beatport.id || entry.beatportId || entry.beatportTrackId || metadata.beatportTrackId);
  const confidence = Number(beatport.confidence || entry.confidence || metadata.confidence || 0) || 0;
  return {
    available: Boolean(id) && confidence >= Number(minConfidence || 85),
    id,
    confidence,
    url: cleanText(beatport.url || entry.beatportUrl),
    genre: cleanText(beatport.genre),
    subGenre: cleanText(beatport.subGenre),
    label: cleanText(beatport.label),
    releaseId: cleanText(beatport.releaseId),
    releaseDate: cleanText(beatport.releaseDate)
  };
}

function sonicSourceDecision(entry = null, { minConfidence = 85 } = {}) {
  const evidence = beatportEvidence(entry || {}, minConfidence);
  if (evidence.available) {
    return {
      status: SONIC_STATUS.READY_BEATPORT_PREVIEW,
      policy: LIVE_SONIC_POLICY,
      requiredSource: "beatport_preview_or_local_file",
      sourceAudioType: "beatport_preview",
      sourceMatchType: "HIGH_CONFIDENCE",
      beatportTrackId: evidence.id,
      confidence: evidence.confidence,
      reason: "high-confidence Beatport metadata match permits preview analysis",
      evidence
    };
  }
  return {
    status: SONIC_STATUS.NEEDS_LOCAL_FILE,
    policy: LIVE_SONIC_POLICY,
    requiredSource: "local_file",
    sourceAudioType: "",
    sourceMatchType: evidence.id ? "BELOW_CONFIDENCE" : "NO_BEATPORT_MATCH",
    beatportTrackId: evidence.id,
    confidence: evidence.confidence,
    reason: evidence.id
      ? "Beatport candidate did not meet the confidence threshold; retain the track and wait for a local file"
      : "No high-confidence Beatport match; retain the track and wait for a local file",
    evidence
  };
}

function isDeterministicBeatportRejection(error) {
  return Number(error?.statusCode || 0) === 422 || /Beatport candidate was rejected/i.test(String(error?.message || ""));
}

function isStoredDeterministicBeatportRejection(request = {}) {
  return /Beatport candidate was rejected|artist credits do not match exactly|base titles do not match|Beatport track ID does not match/i.test(
    `${request.reason || ""} ${request.raw_json || ""}`
  );
}

function isRetryableBeatportMiss(request = {}) {
  return cleanText(request.policy).toUpperCase() === LIVE_SONIC_POLICY
    && cleanText(request.source_match_type).toUpperCase() === "NO_BEATPORT_MATCH"
    && !isStoredDeterministicBeatportRejection(request);
}

class LiveSonicAnalysisService {
  constructor({
    enabled = false,
    autoAnalyze = false,
    musicMemory = null,
    metadataEnrichment = null,
    recommendationEngine = null,
    minConfidence = 85,
    maxConcurrentAnalyses = 1,
    analysisFailureRetryMs = DEFAULT_ANALYSIS_FAILURE_RETRY_MS,
    logger = console,
    clock = Date.now
  } = {}) {
    this.enabled = enabled === true;
    this.autoAnalyze = autoAnalyze === true;
    this.musicMemory = musicMemory;
    this.metadataEnrichment = metadataEnrichment;
    this.recommendationEngine = recommendationEngine;
    this.minConfidence = Number(minConfidence) || 85;
    this.maxConcurrentAnalyses = Math.max(1, Math.round(Number(maxConcurrentAnalyses) || 1));
    this.analysisFailureRetryMs = Math.max(0, Number(analysisFailureRetryMs) || DEFAULT_ANALYSIS_FAILURE_RETRY_MS);
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : Date.now;
    this.pending = new Map();
    this.activeAnalyses = 0;
  }

  status() {
    return {
      enabled: this.enabled,
      autoAnalyze: this.autoAnalyze,
      policy: LIVE_SONIC_POLICY,
      minConfidence: this.minConfidence,
      pending: this.pending.size,
      activeAnalyses: this.activeAnalyses,
      maxConcurrentAnalyses: this.maxConcurrentAnalyses,
      analysisFailureRetryMs: this.analysisFailureRetryMs,
      stateCounts: this.musicMemory?.sonicAnalysisRequirements
        ? Object.fromEntries(Object.values(SONIC_STATUS).map((status) => [status, this.musicMemory.sonicAnalysisRequirements({ status, limit: 100000 }).length]))
        : {}
    };
  }

  rememberState(track, decision = {}) {
    return this.musicMemory?.saveSonicAnalysisRequest?.(track, {
      ...decision,
      updatedAt: new Date(Number(this.clock())).toISOString(),
      rawJson: {
        track: {
          artist: cleanText(track.artist),
          title: cleanText(track.title),
          album: cleanText(track.album),
          tidalId: cleanText(track.tidalId),
          tidalUrl: cleanText(track.tidalUrl),
          roonIdentity: cleanText(track.roonIdentity)
        },
        decision
      }
    }) || null;
  }

  async observe(track = {}) {
    if (!this.enabled || !track?.artist || !track?.title || track.catalogEnrichmentAllowed === false) return { skipped: true };
    const key = cleanText(track.tidalId || track.roonIdentity || `${track.artist}|${track.title}`).toLowerCase();
    if (this.pending.has(key)) return this.pending.get(key);

    // Reconcile the occasional reversed Roon artist/title payload before
    // checking request state. This lets a replay find the canonical TIDAL
    // request/profile instead of opening a duplicate identity.
    this.musicMemory?.reconcileReversedRoonTrack?.(track);
    const existing = this.musicMemory?.findSonicAnalysisRequest?.(track);
    if (existing?.status === SONIC_STATUS.NEEDS_LOCAL_FILE) {
      if (!isRetryableBeatportMiss(existing)) {
        return { skipped: true, status: existing.status, request: existing };
      }
    }
    if (existing?.status === SONIC_STATUS.ANALYSIS_FAILED) {
      if (isStoredDeterministicBeatportRejection(existing)) {
        const request = this.rememberState(track, {
          status: SONIC_STATUS.NEEDS_LOCAL_FILE,
          policy: LIVE_SONIC_POLICY,
          requiredSource: "local_file",
          sourceMatchType: "BEATPORT_MATCH_REJECTED",
          beatportTrackId: existing.beatport_track_id,
          confidence: existing.confidence,
          reason: "Previous Beatport candidate rejection was deterministic; wait for a local file instead of retrying",
          rawJson: { previousFailure: existing.reason, previousRawJson: existing.raw_json }
        });
        return { skipped: true, status: SONIC_STATUS.NEEDS_LOCAL_FILE, classified: true, request };
      }
      const updatedAt = Date.parse(String(existing.updated_at || ""));
      const ageMs = Number.isFinite(updatedAt) ? Math.max(0, Number(this.clock()) - updatedAt) : 0;
      if (ageMs < this.analysisFailureRetryMs) {
        const retryAt = Number.isFinite(updatedAt)
          ? new Date(updatedAt + this.analysisFailureRetryMs).toISOString()
          : null;
        return { skipped: true, status: existing.status, cooldown: true, retryAt, request: existing };
      }
    }
    if (existing?.status && String(existing.status).startsWith("ANALYZED")) {
      const profileReference = existing?.tidal_id
        ? { ...track, tidalId: existing.tidal_id }
        : (existing?.identity_key || track);
      const existingProfile = this.recommendationEngine?.findStoredSonicProfile?.(profileReference);
      if (existingProfile || !this.autoAnalyze || !this.recommendationEngine?.enabled) {
        return { skipped: true, status: existing.status, request: existing, cached: Boolean(existingProfile) };
      }
    }

    this.rememberState(track, {
      status: SONIC_STATUS.PENDING_METADATA,
      policy: LIVE_SONIC_POLICY,
      requiredSource: "beatport_preview_or_local_file",
      reason: "live Roon track observed; waiting for metadata enrichment"
    });

    if (!this.metadataEnrichment?.enrich) {
      const decision = sonicSourceDecision(null, { minConfidence: this.minConfidence });
      const request = this.rememberState(track, decision);
      return { ...decision, request };
    }

    const promise = this.metadataEnrichment.enrich(track)
      .then((entry) => this.handleEnrichment(track, entry))
      .catch((error) => {
        const decision = {
          status: SONIC_STATUS.NEEDS_LOCAL_FILE,
          policy: LIVE_SONIC_POLICY,
          requiredSource: "local_file",
          sourceMatchType: "METADATA_LOOKUP_FAILED",
          reason: `Metadata lookup failed; local file required: ${error.message}`
        };
        const request = this.rememberState(track, decision);
        return { ...decision, request };
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async handleEnrichment(track = {}, entry = null) {
    const enrichedTrack = { ...track, ...(entry || {}) };
    const tidalId = canonicalTidalId(enrichedTrack);
    if (tidalId && Number(entry?.confidence || 0) >= this.minConfidence) {
      this.musicMemory?.linkTrackIdentity?.(
        track,
        {
          ...enrichedTrack,
          tidalId,
          tidalUrl: enrichedTrack.tidalUrl || `https://tidal.com/browse/track/${tidalId}`
        },
        {
          relation: "CANONICAL_TIDAL",
          confidence: Number(entry?.confidence || 0) || null,
          source: "metadata_enrichment",
          updatedAt: entry?.updatedAt || ""
        }
      );
    }
    const decision = sonicSourceDecision(entry, { minConfidence: this.minConfidence });
    if (!decision.evidence.available || !this.autoAnalyze || !this.recommendationEngine?.enabled) {
      const request = this.rememberState(track, decision);
      return { ...decision, request, analyzed: false };
    }

    const existingProfile = this.recommendationEngine.findStoredSonicProfile?.(enrichedTrack);
    if (existingProfile) {
      const cachedMetadata = existingProfile.track?.metadata || {};
      const request = this.rememberState(track, {
        ...decision,
        status: SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW,
        sourceMatchType: cleanText(cachedMetadata.identityRelation) || "CACHED_PROFILE",
        reason: "existing sonic profile found; Beatport preview download and analysis skipped",
        fulfilledAt: existingProfile.updatedAt || new Date(Number(this.clock())).toISOString(),
        rawJson: {
          cached: true,
          profile: {
            identityKey: existingProfile.identityKey,
            model: existingProfile.model,
            modelVersion: existingProfile.modelVersion,
            dimensions: existingProfile.dimensions,
            sourceSha256: existingProfile.sourceSha256,
            updatedAt: existingProfile.updatedAt
          }
        }
      });
      return {
        ...decision,
        status: SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW,
        analyzed: false,
        cached: true,
        previewDownloaded: false,
        profile: {
          identityKey: existingProfile.identityKey,
          model: existingProfile.model,
          modelVersion: existingProfile.modelVersion,
          dimensions: existingProfile.dimensions,
          sourceSha256: existingProfile.sourceSha256,
          updatedAt: existingProfile.updatedAt
        },
        request
      };
    }

    if (this.activeAnalyses >= this.maxConcurrentAnalyses) {
      const request = this.rememberState(track, {
        ...decision,
        status: SONIC_STATUS.READY_BEATPORT_PREVIEW,
        reason: "analysis deferred while another live Beatport preview is being analyzed",
        deferred: true
      });
      return { ...decision, status: SONIC_STATUS.READY_BEATPORT_PREVIEW, analyzed: false, deferred: true, request };
    }

    const analyzing = this.rememberState(track, {
      ...decision,
      status: SONIC_STATUS.ANALYZING_BEATPORT_PREVIEW,
      reason: "high-confidence Beatport preview queued for live sonic analysis"
    });
    this.activeAnalyses += 1;
    try {
      const analysisTidalId = canonicalTidalId(enrichedTrack);
      const result = await this.recommendationEngine.analyzeBeatportPreviewForTidalTrack({
        ...track,
        ...(entry || {}),
        // The metadata entry's numeric `id` may be a Beatport id. Never let
        // that be interpreted as a TIDAL id when the live track only has a
        // Roon identity.
        id: cleanText(track.tidalId) || analysisTidalId,
        tidalId: cleanText(track.tidalId) || analysisTidalId,
        tidalUrl: enrichedTrack.tidalUrl || enrichedTrack.tidal_url || "",
        beatportTrackId: decision.beatportTrackId,
        beatport: {
          ...(entry?.beatport || {}),
          id: decision.beatportTrackId
        }
      });
      const request = this.rememberState(track, {
        ...decision,
        status: SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW,
        sourceAudioType: "beatport_preview",
        sourceMatchType: result.match?.relation || "HIGH_CONFIDENCE",
        reason: "live Beatport preview analyzed and embedding persisted",
        fulfilledAt: new Date(Number(this.clock())).toISOString(),
        rawJson: result
      });
      return { ...decision, status: SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW, analyzed: true, result, request };
    } catch (error) {
      this.logger?.warn?.(`Live sonic analysis failed for ${trackLabel(track)}: ${error.message}`);
      const deterministicRejection = isDeterministicBeatportRejection(error);
      const failureDecision = {
        ...decision,
        status: deterministicRejection ? SONIC_STATUS.NEEDS_LOCAL_FILE : SONIC_STATUS.ANALYSIS_FAILED,
        requiredSource: deterministicRejection ? "local_file" : decision.requiredSource,
        sourceAudioType: deterministicRejection ? "" : decision.sourceAudioType,
        sourceMatchType: deterministicRejection ? "BEATPORT_MATCH_REJECTED" : "ANALYSIS_FAILED",
        reason: deterministicRejection
          ? `Beatport candidate rejected deterministically; local file required: ${error.message}`
          : error.message,
        rawJson: {
          error: {
            name: cleanText(error.name),
            message: cleanText(error.message),
            statusCode: Number(error.statusCode || 0) || null
          },
          matchDiagnostics: error.match?.diagnostics || null,
          matchReasons: error.match?.reasons || []
        }
      };
      const request = this.rememberState(track, {
        ...failureDecision
      });
      return { ...failureDecision, analyzed: false, request };
    } finally {
      this.activeAnalyses = Math.max(0, this.activeAnalyses - 1);
    }
  }
}

module.exports = {
  LIVE_SONIC_POLICY,
  DEFAULT_ANALYSIS_FAILURE_RETRY_MS,
  SONIC_STATUS,
  LiveSonicAnalysisService,
  beatportEvidence,
  sonicSourceDecision
};
