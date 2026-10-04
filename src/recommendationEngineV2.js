"use strict";

const {
  EssentiaDiscogsEffNetProvider,
  JsonCommandEmbeddingProvider,
  SonicEmbeddingEngine,
  SpectralBaselineProvider
} = require("./sonicEmbeddingEngine");
const { SonicEmbeddingStore, identityKeyFor } = require("./sonicEmbeddingStore");
const { generateSonicNeighborCandidates, generateSonicNeighborCandidatesAsync } = require("./sonicNeighborCandidates");
const { SECOND_STAGE_VERSION, mergeSecondStageConfig } = require("./sonicNeighborSecondStage");
const {
  buildSonicNeighborSelectionModel
} = require("./sonicNeighborSelection");
const { readFeedbackEmbeddings } = require("./tasteClusterEvaluation");
const {
  mergeFeedbackEmbeddings,
  readSonicNeighborFeedbackEmbeddings,
  readSonicNeighborFeedbackReviews,
  readSonicReviewSessionReviews
} = require("./sonicNeighborFeedback");
const { matchBeatportVersionToTidal } = require("./beatportVersionMatch");
const { explicitTidalTrackId, tidalTrackIdFromUrl } = require("./tidalIdentity");
const { scoreTidalIdentity } = require("./exactTrackVerification");

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactIdentityCandidate(track = {}) {
  return {
    id: cleanText(track.id || track.beatportTrackId || track.tidalTrackId),
    artist: cleanText(track.artist),
    title: cleanText(track.title || track.name),
    album: cleanText(track.album || track.releaseTitle),
    mixVersion: cleanText(track.mixVersion || track.mixName || track.version),
    recordingYear: Number.isFinite(Number(track.recordingYear)) ? Number(track.recordingYear) : null,
    catalogReleaseYear: Number.isFinite(Number(track.catalogReleaseYear || track.releaseYear || track.year))
      ? Number(track.catalogReleaseYear || track.releaseYear || track.year) : null,
    reissueYear: Number.isFinite(Number(track.reissueYear)) ? Number(track.reissueYear) : null,
    durationMs: Number.isFinite(Number(track.durationMs)) ? Number(track.durationMs) : null,
    isrc: cleanText(track.isrc),
    url: cleanText(track.beatportUrl || track.tidalUrl || track.url)
  };
}

function beatportIdentityFailureType(match = {}) {
  const text = [...(match.reasons || []), ...(match.warnings || [])].map(cleanText).join(" ").toLowerCase();
  if (/ambiguous|multiple|more than one/.test(text)) return "AMBIGUOUS";
  if (/artist credits|isrc|track id|unsafe|proxy|different artist|artist.*match/.test(text)) return "UNSAFE_PROXY";
  if (/version|mix|remix|edit|dub|live|title|base title|descriptor/.test(text)) return "VERSION_MISMATCH";
  return "UNSAFE_PROXY";
}

function beatportIdentityDiagnostics({ tidalTrack = {}, beatportTrack = null, match = null, requestedBeatportTrackId = "", beatportSearchDiagnostics = null } = {}) {
  const candidate = beatportTrack ? compactIdentityCandidate(beatportTrack) : null;
  const searchedRejectionReasons = [...new Set((beatportSearchDiagnostics?.evaluated || [])
    .flatMap((entry) => Array.isArray(entry?.rejectionReasons) ? entry.rejectionReasons : [])
    .map(cleanText)
    .filter(Boolean))];
  const searchProducedOnlyRejectedCandidates = Boolean(
    !beatportTrack
      && Number(beatportSearchDiagnostics?.candidateCount || 0) > 0
      && beatportSearchDiagnostics?.selectedSafe === false
  );
  const effectiveMatch = match || (searchProducedOnlyRejectedCandidates
    ? { reasons: searchedRejectionReasons }
    : null);
  return {
    failureType: effectiveMatch ? beatportIdentityFailureType(effectiveMatch) : "NOT_FOUND",
    candidateIdentities: candidate ? [candidate] : [],
    beatportCandidateFound: Boolean(beatportTrack),
    beatportCandidateRejected: Boolean((beatportTrack && match && !match.matched) || searchProducedOnlyRejectedCandidates),
    requestedBeatportTrackId: cleanText(requestedBeatportTrackId),
    identityRules: match?.reasons || (searchedRejectionReasons.length ? searchedRejectionReasons : beatportTrack ? ["beatport-version-match-rejected"] : ["beatport-candidate-not-found"]),
    matcherDiagnostics: match?.diagnostics || null,
    beatportSearchDiagnostics: beatportSearchDiagnostics || null,
    legacyIdentityDiagnostics: match?.diagnostics?.legacyIdentityDiagnostics || null,
    requestedIdentity: compactIdentityCandidate(tidalTrack)
  };
}

class RecommendationEngineV2 {
  constructor({
    enabled = false,
    dbFile,
    embeddingProvider = "spectral-baseline",
    embeddingProviderInstance = null,
    ffmpegPath = "",
    embeddingCommand = "",
    embeddingArgs = [],
    embeddingModel = "",
    embeddingModelVersion = "1",
    embeddingTimeoutMs = 900_000,
    discoveryMode = "shadow",
    discoveryModel = "discogs-effnet",
    discoveryModelVersion = "1",
    discoveryRerankWeight = 0.18,
    discoveryMinCoverage = 0.1,
    discoveryMinScored = 5,
    sonicNeighborSecondStageConfig = {},
    essentia = {},
    beatportClient = null,
    tidalClient = null,
    logger = console
  } = {}) {
    this.enabled = enabled === true;
    this.logger = logger;
    this.discoveryIntegration = {
      mode: String(discoveryMode || "shadow").trim().toLowerCase(),
      model: String(discoveryModel || "discogs-effnet").trim() || "discogs-effnet",
      modelVersion: String(discoveryModelVersion || "1").trim() || "1",
      weight: Number(discoveryRerankWeight),
      minCoverage: Number(discoveryMinCoverage),
      minScored: Number(discoveryMinScored)
    };
    this.sonicNeighborSecondStageConfig = mergeSecondStageConfig(sonicNeighborSecondStageConfig);
    this.store = new SonicEmbeddingStore({ enabled: this.enabled, dbFile, logger });
    const providerName = String(embeddingProvider || "spectral-baseline").trim().toLowerCase();
    this.provider = embeddingProviderInstance || (providerName === "discogs-effnet" || providerName === "essentia"
      ? new EssentiaDiscogsEffNetProvider({
          ...essentia,
          modelVersion: essentia.modelVersion || embeddingModelVersion,
          timeoutMs: essentia.timeoutMs || embeddingTimeoutMs
        })
      : providerName === "external-json" || providerName === "mert"
      ? new JsonCommandEmbeddingProvider({
          command: embeddingCommand,
          args: embeddingArgs,
          model: embeddingModel || providerName,
          modelVersion: embeddingModelVersion,
          timeoutMs: embeddingTimeoutMs
        })
      : new SpectralBaselineProvider({ ffmpegPath }));
    this.sonic = new SonicEmbeddingEngine({ store: this.store, provider: this.provider, logger });
    this.beatport = beatportClient;
    this.tidal = tidalClient;
    this.sonicNeighborSelectionCache = null;
  }

  status() {
    return {
      enabled: this.enabled,
      phase: "phase-1-sonic-proof-of-concept",
      productionDiscoveryEnabled: this.enabled && this.discoveryIntegration.mode === "rerank",
      discoveryIntegration: {
        ...this.discoveryIntegration,
        active: this.enabled && this.discoveryIntegration.mode !== "off",
        orderingChanged: this.enabled && this.discoveryIntegration.mode === "rerank"
      },
      sonicNeighborCandidates: {
        enabled: this.enabled,
        mode: "shadow",
        source: "stored-versioned-sonic-profiles",
        productionIntegrated: false,
        model: this.discoveryIntegration.model,
        modelVersion: this.discoveryIntegration.modelVersion
      },
      sonicNeighborSelection: {
        enabled: this.enabled,
        mode: "shadow",
        source: "explicit-feedback-stored-embeddings",
        productionIntegrated: false,
        globalCentroidUsed: false,
        fallback: "raw-cosine"
      },
      sonicNeighborSecondStage: {
        enabled: this.enabled,
        mode: "shadow",
        version: SECOND_STAGE_VERSION,
        firstStageSignal: "raw-cosine",
        productionIntegrated: false,
        rawSimilarityPreserved: true,
        rankedBy: "adjusted-score",
        genreAdjustments: { ...this.sonicNeighborSecondStageConfig.genreAdjustments },
        maxArrangementBonusWhenGenreRisk: this.sonicNeighborSecondStageConfig.maxArrangementBonusWhenGenreRisk,
        genreEvidenceBonusScale: { ...this.sonicNeighborSecondStageConfig.genreEvidenceBonusScale }
      },
      beatportVersionProxy: {
        enabled: Boolean(this.beatport),
        configured: Boolean(this.beatport?.isConfigured?.())
      },
      ...this.sonic.status()
    };
  }

  analyzeFile(filePath, track = {}, options = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    return this.sonic.analyzeFile(filePath, track, options);
  }

  storeExtraction(options = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    return this.sonic.storeExtraction(options);
  }

  findSonicNeighbors(track, count = 20, options = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    return this.sonic.findSonicNeighbors(track, count, options);
  }

  generateSonicNeighborCandidates(input = {}) {
    return generateSonicNeighborCandidates(this.sonicNeighborCandidateOptions(input));
  }

  async generateSonicNeighborCandidatesAsync(input = {}) {
    return generateSonicNeighborCandidatesAsync(this.sonicNeighborCandidateOptions(input));
  }

  sonicNeighborCandidateOptions(input = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    const resolvedInput = {
      ...input,
      model: cleanText(input.model || input.provider) || this.discoveryIntegration.model,
      modelVersion: cleanText(input.modelVersion) || this.discoveryIntegration.modelVersion,
      secondStageConfig: input.secondStageConfig || this.sonicNeighborSecondStageConfig
    };
    const selectionModel = this.getSonicNeighborSelectionModel({
      model: resolvedInput.model,
      modelVersion: resolvedInput.modelVersion
    });
    return {
      neighborEngine: this.sonic,
      input: resolvedInput,
      selectionModel,
      genreResolver: ({ track, ...context }) => this.resolveSonicGenreEvidence(track, context),
      logger: this.logger
    };
  }

  recordSonicNeighborFeedback(input = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    const reviews = Array.isArray(input.feedback)
      ? input.feedback
      : Array.isArray(input.reviews)
        ? input.reviews
        : [input];
    if (!reviews.length || reviews.length > 100) throw new Error("Between one and 100 sonic-neighbor reviews are required.");
    const recorded = reviews.map((review = {}) => this.store.saveSonicNeighborFeedback({
      anchor: review.anchor ?? review.anchorIdentityKey ?? review.anchorTrack,
      candidate: review.candidate ?? review.candidateIdentityKey ?? review.candidateTrack,
      rating: review.rating,
      note: review.note || review.genreNote || review.comment,
      anchorArea: review.anchorArea,
      candidateArea: review.candidateArea || review.genreCorrection,
      sourceEventId: review.sourceEventId || review.eventId,
      sourceLabel: review.sourceLabel,
      model: review.model || input.model || this.discoveryIntegration.model,
      modelVersion: review.modelVersion || input.modelVersion || this.discoveryIntegration.modelVersion,
      createdAt: review.createdAt || review.recordedAt,
      rawJson: review.rawJson || review
    }));
    this.sonicNeighborSelectionCache = null;
    return {
      ok: true,
      mode: "shadow",
      recorded: recorded.length,
      inserted: recorded.filter((row) => row.inserted).length,
      feedback: recorded,
      globalTasteProfileUpdated: false,
      productionApplied: false
    };
  }

  getSonicAnchorProfile(input = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    const anchor = input.anchor ?? input.track ?? input.identityKey ?? input.identity_key;
    if (!anchor) throw new Error("A stored sonic anchor identity is required.");
    return {
      ok: true,
      mode: "shadow",
      profile: this.store.getSonicAnchorProfile(anchor),
      globalTasteProfileUpdated: false,
      productionApplied: false
    };
  }

  saveSonicAnchorProfile(input = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    const anchor = input.anchor ?? input.track ?? input.identityKey ?? input.identity_key;
    if (!anchor) throw new Error("A stored sonic anchor identity is required.");
    const profile = this.store.saveSonicAnchorProfile({
      anchor,
      genre: input.genre || input.area || input.anchorArea,
      subgenre: input.subgenre || input.lane,
      energy: input.energy,
      mood: input.mood,
      tags: input.tags,
      note: input.note || input.listeningNote || input.comment,
      sourceLabel: input.sourceLabel || "rabbit-hole-sonic-review",
      model: input.model || this.discoveryIntegration.model,
      modelVersion: input.modelVersion || this.discoveryIntegration.modelVersion,
      createdAt: input.createdAt || input.recordedAt,
      rawJson: input.rawJson || input
    });
    this.sonicNeighborSelectionCache = null;
    return {
      ok: true,
      mode: "shadow",
      profile,
      globalTasteProfileUpdated: false,
      productionApplied: false
    };
  }

  getSonicNeighborSelectionModel({ model = "", modelVersion = "" } = {}) {
    if (!this.enabled || !this.store.db) return null;
    const resolvedModel = cleanText(model) || this.discoveryIntegration.model;
    const resolvedVersion = cleanText(modelVersion) || this.discoveryIntegration.modelVersion;
    let signature = `${resolvedModel}:${resolvedVersion}`;
    try {
      const feedbackSignature = this.store.db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id
        FROM taste_feedback
      `).get();
      const sonicFeedbackSignature = this.store.db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id
        FROM sonic_neighbor_feedback
        WHERE model = ? AND model_version = ?
      `).get(resolvedModel, resolvedVersion);
      const profileSignature = this.store.db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id
        FROM track_sonic_profile
        WHERE model = ? AND model_version = ?
      `).get(resolvedModel, resolvedVersion);
      const anchorProfileSignature = this.store.db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS max_updated_at
        FROM sonic_anchor_profile
        WHERE model = ? AND model_version = ?
      `).get(resolvedModel, resolvedVersion);
      let sessionReviewSignature = { count: 0, max_updated_at: "" };
      try {
        sessionReviewSignature = this.store.db.prepare(`
          SELECT COUNT(*) AS count, COALESCE(MAX(i.updated_at), '') AS max_updated_at
          FROM sonic_review_session_item i
          JOIN sonic_review_session s ON s.session_id = i.session_id
          WHERE s.model = ? AND s.model_version = ? AND i.decision IS NOT NULL AND i.decision <> ''
        `).get(resolvedModel, resolvedVersion) || sessionReviewSignature;
      } catch {
        // Sonic Review sessions are optional in installations that only use
        // the raw neighbor endpoint.
      }
      signature += `:${Number(feedbackSignature?.count || 0)}:${Number(feedbackSignature?.max_id || 0)}:${Number(sonicFeedbackSignature?.count || 0)}:${Number(sonicFeedbackSignature?.max_id || 0)}:${Number(profileSignature?.count || 0)}:${Number(profileSignature?.max_id || 0)}:${Number(anchorProfileSignature?.count || 0)}:${cleanText(anchorProfileSignature?.max_updated_at)}:${Number(sessionReviewSignature?.count || 0)}:${cleanText(sessionReviewSignature?.max_updated_at)}`;
    } catch {
      // A read-only shadow selector is optional; if the feedback tables are not
      // available, leave the raw sonic-neighbor path intact.
      return null;
    }
    if (this.sonicNeighborSelectionCache?.signature === signature) return this.sonicNeighborSelectionCache.model;
    const generalRows = readFeedbackEmbeddings(this.store.db, {
      model: resolvedModel,
      modelVersion: resolvedVersion
    });
    const sonicRows = readSonicNeighborFeedbackEmbeddings(this.store.db, {
      model: resolvedModel,
      modelVersion: resolvedVersion
    });
    const rows = mergeFeedbackEmbeddings(generalRows, sonicRows);
    const neighborFeedbackRows = [
      ...readSonicNeighborFeedbackReviews(this.store.db, {
        model: resolvedModel,
        modelVersion: resolvedVersion
      }),
      ...readSonicReviewSessionReviews(this.store.db, {
        model: resolvedModel,
        modelVersion: resolvedVersion
      })
    ];
    const modelState = buildSonicNeighborSelectionModel(rows, {
      model: resolvedModel,
      modelVersion: resolvedVersion,
      source: sonicRows.length
        ? "explicit-feedback-plus-isolated-sonic-neighbor-review"
        : "explicit-feedback-stored-embeddings",
      neighborFeedbackRows,
      areaResolver: (track) => {
        const identityKey = identityKeyFor(track);
        if (!identityKey) return "";
        const anchorProfile = this.store.db.prepare(`
          SELECT genre, subgenre
          FROM sonic_anchor_profile
          WHERE anchor_identity_key = ?
          LIMIT 1
        `).get(identityKey);
        if (cleanText(anchorProfile?.genre) || cleanText(anchorProfile?.subgenre)) {
          return cleanText(anchorProfile?.genre) || cleanText(anchorProfile?.subgenre);
        }
        const row = this.store.db.prepare(`
          SELECT be.genre, be.subgenre
          FROM track_identity ti
          LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
          WHERE ti.identity_key = ?
          LIMIT 1
        `).get(identityKey);
        return row?.genre || row?.subgenre || "";
      }
    });
    this.sonicNeighborSelectionCache = { signature, model: modelState };
    return modelState.enabled ? modelState : null;
  }

  resolveSonicGenreEvidence(track = {}, { neighborTracks = [], subject = "" } = {}) {
    const db = this.store?.db;
    if (!db) return { inferred: [], sources: [] };
    const identityKey = identityKeyFor(track);
    const artist = cleanText(track.artist || track.metadata?.artist);
    let label = cleanText(track.label || track.beatport?.label || track.metadata?.label || track.metadata?.beatport?.label
      || track.metadataEnrichment?.label || track.metadataEnrichment?.beatport?.label
      || track.metadata_enrichment?.label || track.metadata_enrichment?.beatport?.label);
    const entries = [];
    const seen = new Set();
    const add = (value, source, confidence = "uncertain") => {
      const cleanValue = cleanText(value);
      if (!cleanValue) return;
      const key = `${cleanValue.toLowerCase()}|${source}|${confidence}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ value: cleanValue, source, confidence });
    };
    const addPair = (row, source, confidence = "uncertain") => {
      add(row?.genre, source, confidence);
      add(row?.subgenre || row?.subGenre, source, confidence);
    };
    const parseJson = (value) => {
      if (!value) return {};
      if (typeof value === "object") return value;
      try { return JSON.parse(value); } catch { return {}; }
    };
    const safeGet = (sql, params = []) => {
      try { return db.prepare(sql).get(...params) || null; } catch { return null; }
    };
    const safeAll = (sql, params = []) => {
      try { return db.prepare(sql).all(...params) || []; } catch { return []; }
    };

    // TIDAL/provider payloads are evidence, but direct track fields remain the
    // explicit metadata path in the pure scorer. This keeps the inference
    // source visible without asking an external model to classify anything.
    addPair(track.tidal, "tidal-metadata", "compatible");
    addPair(track.tidalMetadata || track.tidal_metadata, "tidal-metadata", "compatible");
    addPair(track.metadata?.tidal, "tidal-metadata", "compatible");
    addPair(track.metadataEnrichment || track.metadata_enrichment, "tidal-metadata", "compatible");

    if (identityKey) {
      for (const row of safeAll(`
        SELECT pe.provider, pe.genre, pe.subgenre, pe.label, pe.confidence
        FROM track_identity ti
        JOIN provider_enrichment pe ON pe.track_identity_id = ti.id
        WHERE ti.identity_key = ?
        ORDER BY pe.fetched_at DESC
        LIMIT 12
      `, [identityKey])) {
        const source = cleanText(row.provider).toLowerCase() === "tidal" ? "tidal-enrichment" : "stored-provider-enrichment";
        const confidence = Number(row.confidence || 0) >= 70 ? "compatible" : "uncertain";
        addPair(row, source, confidence);
        label ||= cleanText(row.label);
      }
      const beatport = safeGet(`
        SELECT be.genre, be.subgenre, be.label, be.confidence
        FROM track_identity ti
        LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
        WHERE ti.identity_key = ?
        LIMIT 1
      `, [identityKey]);
      if (beatport) {
        const confidence = Number(beatport.confidence || 0) >= 70 ? "compatible" : "uncertain";
        addPair(beatport, "beatport-enrichment", confidence);
        label ||= cleanText(beatport.label);
      }
      const profile = safeGet(`
        SELECT genre, subgenre
        FROM sonic_anchor_profile
        WHERE anchor_identity_key = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `, [identityKey]);
      if (profile) addPair(profile, "sonic-review-profile", "compatible");

      for (const row of safeAll(`
        SELECT CASE WHEN candidate_identity_key = ? THEN candidate_area ELSE anchor_area END AS genre
        FROM sonic_neighbor_feedback
        WHERE candidate_identity_key = ? OR anchor_identity_key = ?
        ORDER BY id DESC
        LIMIT 24
      `, [identityKey, identityKey, identityKey])) addPair(row, "reviewed-relationship", "compatible");

      for (const row of safeAll(`
        SELECT s.anchor_identity_key, s.anchor_json, i.candidate_identity_key, i.review_json, i.candidate_json
        FROM sonic_review_session s
        JOIN sonic_review_session_item i ON i.session_id = s.session_id
        WHERE i.candidate_identity_key = ? OR s.anchor_identity_key = ?
        ORDER BY i.updated_at DESC
        LIMIT 24
      `, [identityKey, identityKey])) {
        const review = parseJson(row.review_json);
        const candidate = parseJson(row.candidate_json);
        const anchorContext = parseJson(row.anchor_json);
        const side = row.candidate_identity_key === identityKey ? candidate : anchorContext;
        const profile = review.profile || review.sonicProfile || {};
        add(profile.genreLane || profile.genre || side.genre || side.subgenre, "sonic-review-session", "compatible");
        if (row.candidate_identity_key === identityKey) {
          for (const value of Array.isArray(profile.subgenres) ? profile.subgenres : []) add(value, "sonic-review-session", "compatible");
        }
      }
    }

    const normalizedArtist = artist.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    if (normalizedArtist) {
      for (const row of safeAll(`
        SELECT be.genre, be.subgenre, be.confidence
        FROM track_identity ti
        JOIN beatport_enrichment be ON be.track_identity_id = ti.id
        WHERE ti.normalized_artist = ? OR LOWER(TRIM(ti.artist)) = LOWER(TRIM(?))
        ORDER BY be.fetched_at DESC
        LIMIT 48
      `, [normalizedArtist, artist])) {
        addPair(row, "artist-history", Number(row.confidence || 0) >= 70 ? "compatible" : "uncertain");
      }
    }
    if (label) {
      for (const row of safeAll(`
        SELECT genre, subgenre
        FROM beatport_enrichment
        WHERE LOWER(TRIM(label)) = LOWER(TRIM(?))
        ORDER BY fetched_at DESC
        LIMIT 48
      `, [label])) addPair(row, "label-history", "uncertain");
    }

    // Neighbor metadata may corroborate a lane, but is intentionally lower
    // confidence than an exact stored enrichment or reviewed profile.
    const neighbors = Array.isArray(neighborTracks) ? neighborTracks : [];
    for (const neighbor of neighbors.slice(0, 24)) {
      if (identityKey && identityKeyFor(neighbor) === identityKey) continue;
      addPair(neighbor, "neighbor-metadata", "uncertain");
      addPair(neighbor.metadata, "neighbor-metadata", "uncertain");
    }
    return {
      inferred: entries,
      sources: [...new Set(entries.map((entry) => entry.source))],
      subject,
      evidenceCount: entries.length
    };
  }

  findStoredSonicProfile(track, { model = "", modelVersion = "" } = {}) {
    if (!this.enabled) return null;
    return this.store.getEmbedding(track, {
      model: cleanText(model) || this.provider.name,
      modelVersion: cleanText(modelVersion) || this.provider.modelVersion
    });
  }

  async prepareSonicAnchor(reference, options = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    const model = cleanText(options.model || options.provider) || this.provider.name;
    const modelVersion = cleanText(options.modelVersion) || this.provider.modelVersion;
    const existing = this.findStoredSonicProfile(reference, { model, modelVersion });
    if (existing && (!options.requireValidEmbedding || require("./sonicCoverageIdentity").validCoverageEmbedding(existing))) {
      return {
        ok: true,
        ready: true,
        prepared: false,
        source: "stored-sonic-embedding",
        identityKey: existing.identityKey,
        model: existing.model,
        modelVersion: existing.modelVersion,
        profile: {
          identityKey: existing.identityKey,
          model: existing.model,
          modelVersion: existing.modelVersion,
          dimensions: existing.dimensions,
          sourceSha256: existing.sourceSha256,
          updatedAt: existing.updatedAt
        }
      };
    }

    const track = await this.resolveTidalTrackReference(reference);
    const metadata = track.metadataEnrichment || track.metadata_enrichment || {};
    const beatport = track.beatport || metadata.beatport || {};
    const identityTidalId = cleanText(track.identityKey).match(/^tidal:(\d+)$/i)?.[1] || "";
    const canonicalTrack = {
      ...track,
      artist: cleanText(metadata.artist) || track.artist,
      title: cleanText(metadata.title) || track.title,
      album: cleanText(track.album) || metadata.album,
      label: cleanText(track.label) || metadata.label || beatport.label,
      releaseDate: cleanText(track.releaseDate) || metadata.releaseDate || beatport.releaseDate,
      year: track.year || metadata.year || metadata.releaseYear,
      isrc: cleanText(track.isrc) || metadata.isrc,
      durationMs: track.durationMs || metadata.durationMs,
      tidalId: cleanText(track.tidalId || track.tidalTrackId || track.tidal_id) || identityTidalId,
      tidalUrl: cleanText(track.tidalUrl || track.tidal_url) || (identityTidalId ? `https://tidal.com/browse/track/${identityTidalId}` : "")
    };
    const requestedBeatportTrackId = cleanText(
      options.beatportTrackId ||
      canonicalTrack.beatportTrackId ||
      canonicalTrack.beatportId ||
      canonicalTrack.beatport?.id ||
      beatport.id
    );
    try {
      const result = await this.analyzeBeatportPreviewForTidalTrack({
        ...canonicalTrack,
        beatportTrackId: requestedBeatportTrackId
      }, {
        ...options,
        model,
        modelVersion,
        beatportTrackId: requestedBeatportTrackId
      });
      const stored = this.findStoredSonicProfile(result.identityKey || track, {
        model: result.model || model,
        modelVersion: result.modelVersion || modelVersion
      });
      return {
        ok: true,
        ready: Boolean(stored),
        prepared: true,
        source: "beatport-preview",
        identityKey: stored?.identityKey || result.identityKey,
        model: stored?.model || result.model || model,
        modelVersion: stored?.modelVersion || result.modelVersion || modelVersion,
        track: result.tidal || canonicalTrack,
        profile: stored ? {
          identityKey: stored.identityKey,
          model: stored.model,
          modelVersion: stored.modelVersion,
          dimensions: stored.dimensions,
          sourceSha256: stored.sourceSha256,
          updatedAt: stored.updatedAt
        } : null
      };
    } catch (error) {
      if ([404, 422].includes(Number(error?.statusCode || 0))) error.needsLocalFile = true;
      error.identityDiagnostics ||= {
        failureType: Number(error?.statusCode || 0) === 404 ? "NOT_FOUND" : "API_ERROR",
        candidateIdentities: [],
        identityRules: ["sonic-anchor-preparation-failed"]
      };
      throw error;
    }
  }

  async resolveTidalTrackReference(reference) {
    const supplied = reference && typeof reference === "object" ? { ...reference } : {};
    const textReference = typeof reference === "string" ? reference.trim() : "";
    const tidalId = explicitTidalTrackId(supplied)
      || tidalTrackIdFromUrl(supplied.tidalUrl || supplied.tidal_url || supplied.tidal?.url || "")
      || tidalTrackIdFromUrl(textReference)
      || (/^\d+$/.test(textReference) ? textReference : "");
    if (supplied.artist && supplied.title && tidalId && this.tidal && typeof this.tidal.getTrack === "function") {
      let canonical;
      try {
        canonical = await this.tidal.getTrack(tidalId, `${supplied.artist} ${supplied.title}`);
      } catch (error) {
        error.identityDiagnostics = {
          failureType: "API_ERROR",
          candidateIdentities: [],
          identityRules: ["tidal-track-identity-validation-request-failed"],
          tidalId
        };
        throw error;
      }
      if (!canonical) {
        const error = new Error(`TIDAL track ${tidalId} could not be resolved.`);
        error.statusCode = 404;
        error.identityDiagnostics = {
          failureType: "NOT_FOUND",
          candidateIdentities: [],
          identityRules: ["tidal-track-id-not-found"],
          tidalId
        };
        throw error;
      }
      const evidence = scoreTidalIdentity(supplied, canonical);
      if (!evidence.matched) {
        const error = new Error(`TIDAL track ${tidalId} did not confirm the supplied artist/title/version.`);
        error.statusCode = 422;
        error.identityDiagnostics = {
          failureType: evidence.outcome,
          identityOutcome: evidence.outcome,
          candidateIdentities: [{
            id: canonical.id || tidalId,
            artist: canonical.artist || "",
            title: canonical.title || "",
            artistCredits: evidence.artistRelation.candidateCredits,
            identityOutcome: evidence.outcome,
            confidenceScore: evidence.confidenceScore,
            rejectionReason: evidence.rejectionReason,
            legacyIdentityDiagnostics: evidence.legacyIdentityDiagnostics
          }],
          requestedArtistCredits: evidence.artistRelation.requestedCredits,
          candidateArtistCredits: evidence.artistRelation.candidateCredits,
          artistOverlapType: evidence.artistRelation.type,
          normalizedBaseTitleMatch: evidence.normalizedBaseTitleMatch,
          requestedVersion: evidence.requestedVersion,
          candidateVersion: evidence.candidateVersion,
          isrcMatch: evidence.isrcMatch,
          tidalIdMatch: evidence.tidalIdMatch,
          beatportIdMatch: evidence.beatportIdMatch,
          durationDeltaMs: evidence.durationDeltaMs,
          albumAgreement: evidence.albumAgreement,
          labelAgreement: evidence.labelAgreement,
          releaseDateAgreement: evidence.releaseDateAgreement,
          candidateConfidenceScore: evidence.confidenceScore,
          rejectionReason: evidence.rejectionReason,
          legacyIdentityDiagnostics: evidence.legacyIdentityDiagnostics,
          identityRules: evidence.reasons,
          tidalId
        };
        throw error;
      }
      return {
        ...canonical,
        id: canonical.id || tidalId,
        tidalId: canonical.tidalId || tidalId,
        tidalUrl: canonical.tidalUrl || `https://tidal.com/browse/track/${tidalId}`,
        identityOutcome: evidence.outcome,
        identityConfidence: evidence.confidenceScore,
        identityDiagnostics: evidence
      };
    }
    if (supplied.artist && supplied.title && !tidalId && this.tidal && typeof this.tidal.findExactTrack === "function") {
      let canonical;
      try {
        canonical = await this.tidal.findExactTrack(supplied, { strict: true, limit: 10, includePageYear: false, maxQueries: 6 });
      } catch (error) {
        error.identityDiagnostics ||= {
          failureType: "API_ERROR",
          candidateIdentities: [],
          identityRules: ["tidal-catalogue-identity-validation-request-failed"]
        };
        throw error;
      }
      if (!canonical) {
        const error = new Error(`No safe TIDAL catalogue identity was found for ${supplied.artist} - ${supplied.title}.`);
        error.statusCode = 404;
        error.identityDiagnostics = {
          ...(this.tidal.lastExactIdentityDiagnostics || {}),
          failureType: "NOT_FOUND",
          identityOutcome: "NOT_FOUND",
          candidateIdentities: this.tidal.lastExactIdentityDiagnostics?.candidateIdentities || [],
          identityRules: this.tidal.lastExactIdentityDiagnostics?.failureType === "AMBIGUOUS"
            ? ["multiple-exact-tidal-candidates"]
            : ["no-safe-tidal-catalogue-candidate"]
        };
        if (this.tidal.lastExactIdentityDiagnostics?.failureType === "AMBIGUOUS") {
          error.statusCode = 422;
          error.identityDiagnostics.failureType = "AMBIGUOUS";
          error.identityDiagnostics.identityOutcome = "AMBIGUOUS";
          error.message = `TIDAL returned multiple plausible recordings for ${supplied.artist} - ${supplied.title}.`;
        }
        throw error;
      }
      const evidence = scoreTidalIdentity(supplied, canonical);
      if (!evidence.matched) {
        const error = new Error(`TIDAL found a candidate but could not safely confirm ${supplied.artist} - ${supplied.title}.`);
        error.statusCode = 422;
        error.identityDiagnostics = {
          failureType: evidence.outcome,
          identityOutcome: evidence.outcome,
          candidateIdentities: [{
            id: canonical.id || "",
            artist: canonical.artist || "",
            title: canonical.title || "",
            artistCredits: evidence.artistRelation.candidateCredits,
            identityOutcome: evidence.outcome,
            confidenceScore: evidence.confidenceScore,
            rejectionReason: evidence.rejectionReason,
            legacyIdentityDiagnostics: evidence.legacyIdentityDiagnostics
          }],
          requestedArtistCredits: evidence.artistRelation.requestedCredits,
          candidateArtistCredits: evidence.artistRelation.candidateCredits,
          artistOverlapType: evidence.artistRelation.type,
          normalizedBaseTitleMatch: evidence.normalizedBaseTitleMatch,
          requestedVersion: evidence.requestedVersion,
          candidateVersion: evidence.candidateVersion,
          isrcMatch: evidence.isrcMatch,
          tidalIdMatch: evidence.tidalIdMatch,
          beatportIdMatch: evidence.beatportIdMatch,
          durationDeltaMs: evidence.durationDeltaMs,
          albumAgreement: evidence.albumAgreement,
          labelAgreement: evidence.labelAgreement,
          releaseDateAgreement: evidence.releaseDateAgreement,
          candidateConfidenceScore: evidence.confidenceScore,
          rejectionReason: evidence.rejectionReason,
          legacyIdentityDiagnostics: evidence.legacyIdentityDiagnostics,
          identityRules: evidence.reasons
        };
        throw error;
      }
      return { ...canonical, identityOutcome: evidence.outcome, identityConfidence: evidence.confidenceScore, identityDiagnostics: evidence };
    }
    if (supplied.artist && supplied.title) {
      return {
        ...supplied,
        id: supplied.id || tidalId,
        tidalId: supplied.tidalId || tidalId,
        tidalUrl: supplied.tidalUrl || (tidalId ? `https://tidal.com/browse/track/${tidalId}` : "")
      };
    }
    if (!tidalId) throw new Error("A TIDAL track URL, numeric id, or normalized TIDAL track is required.");
    if (!this.tidal || typeof this.tidal.getTrack !== "function") {
      throw new Error("The TIDAL verifier is not connected to Recommendation Engine v2.");
    }
    let track;
    try {
      track = await this.tidal.getTrack(tidalId);
    } catch (error) {
      error.identityDiagnostics = {
        failureType: "API_ERROR",
        candidateIdentities: [],
        identityRules: ["tidal-track-request-failed"],
        tidalId
      };
      throw error;
    }
    if (!track) {
      const error = new Error(`TIDAL track ${tidalId} could not be resolved.`);
      error.statusCode = 404;
      error.identityDiagnostics = {
        failureType: "NOT_FOUND",
        candidateIdentities: [],
        identityRules: ["tidal-track-id-not-found"],
        tidalId
      };
      throw error;
    }
    return track;
  }

  async analyzeBeatportPreviewForTidalTrack(reference, options = {}) {
    if (!this.enabled) throw new Error("Recommendation Engine v2 is disabled. Set RABBIT_HOLE_RECOMMENDATION_V2_ENABLED=true for the proof of concept.");
    if (!this.beatport || typeof this.beatport.findTrack !== "function" || typeof this.beatport.fetchPreviewBuffer !== "function") {
      throw new Error("Beatport is not connected to Recommendation Engine v2.");
    }
    const tidalTrack = await this.resolveTidalTrackReference(reference);
    const metadata = tidalTrack.metadataEnrichment || tidalTrack.metadata_enrichment || {};
    const metadataBeatport = metadata.beatport || {};
    const requestedBeatportTrackId = cleanText(
      options.beatportTrackId ||
      tidalTrack.beatportTrackId ||
      tidalTrack.beatportId ||
      tidalTrack.beatport?.id ||
      metadataBeatport.id
    );
    const beatportTrack = await this.beatport.findTrack(tidalTrack, { beatportTrackId: requestedBeatportTrackId });
    if (!beatportTrack) {
      const error = new Error("Beatport returned no candidate for the TIDAL track.");
      error.statusCode = 404;
      error.identityDiagnostics = beatportIdentityDiagnostics({
        tidalTrack,
        requestedBeatportTrackId,
        beatportSearchDiagnostics: this.beatport.lastIdentityDiagnostics
      });
      throw error;
    }
    const match = matchBeatportVersionToTidal(tidalTrack, beatportTrack, {
      allowVersionProxy: options.allowVersionProxy !== false,
      requestedBeatportTrackId
    });
    if (!match.matched) {
      const error = new Error(`Beatport candidate was rejected: ${match.reasons.join("; ")}`);
      error.statusCode = 422;
      error.match = match;
      error.tidalTrack = tidalTrack;
      error.beatportTrack = beatportTrack;
      error.identityDiagnostics = beatportIdentityDiagnostics({
        tidalTrack,
        beatportTrack,
        match,
        requestedBeatportTrackId,
        beatportSearchDiagnostics: this.beatport.lastIdentityDiagnostics
      });
      throw error;
    }

    const streamed = await this.beatport.fetchPreviewBuffer(beatportTrack, options);
    let audioBuffer = streamed.buffer;
    try {
      const tidalId = explicitTidalTrackId(tidalTrack);
      // Learned extraction blocks in FFmpeg/Essentia child processes. Every
      // preview caller, including live observation, must keep it off Roon's thread.
      const backgroundExtraction = options.backgroundExtraction === true || this.provider instanceof EssentiaDiscogsEffNetProvider;
      const analyzeBuffer = typeof options.analysisHandler === "function" ? options.analysisHandler : backgroundExtraction
        ? this.sonic.analyzeBufferAsync.bind(this.sonic) : this.sonic.analyzeBuffer.bind(this.sonic);
      const result = await analyzeBuffer(audioBuffer, {
        ...tidalTrack,
        identityKey: tidalId ? `tidal:${tidalId}` : tidalTrack.identityKey
      }, {
        sourceType: match.relation === "exact" ? "beatport-preview" : "beatport-preview-version-proxy",
        metadata: {
          sourceProvider: "beatport",
          sourceTrackId: beatportTrack.id,
          sourceVersion: beatportTrack.mixName || beatportTrack.title,
          canonicalProvider: "tidal",
          canonicalTrackId: tidalId,
          identityRelation: match.relation,
          identityConfidence: match.confidence,
          identityMatchScore: match.score,
          identityDiagnostics: match.diagnostics,
          identityReasons: match.reasons,
          identityWarnings: match.warnings,
          previewUrl: streamed.previewUrl,
          previewBytes: streamed.bytes,
          previewContentType: streamed.contentType,
          previewDurationMs: streamed.previewDurationMs,
          partialPreview: true,
          analysisNote: match.relation === "exact"
            ? "Sonic profile is derived from a partial Beatport preview of the verified recording."
            : "Sonic profile is derived from a Beatport preview of a related version; it is not recording identity."
        }
      });
      return {
        ...result,
        relation: match.relation,
        match,
        tidal: tidalTrack,
        beatport: {
          ...beatportTrack,
          previewUrl: streamed.previewUrl,
          previewBytes: streamed.bytes,
          previewContentType: streamed.contentType,
          previewDurationMs: streamed.previewDurationMs
        }
      };
    } finally {
      if (audioBuffer) audioBuffer.fill(0);
      audioBuffer = null;
    }
  }
}

module.exports = {
  RecommendationEngineV2
};
