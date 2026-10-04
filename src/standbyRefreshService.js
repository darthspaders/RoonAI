"use strict";

function createStandbyRefreshService({
  booleanFlag,
  candidateIdentityKeys,
  config,
  discoverTracks,
  discoveryHistory,
  FreshPool,
  generateSearchPlan,
  generateStandbySearchPlan,
  genreProfileStore,
  getModelRouter,
  lastFmHistoryForDiscovery,
  listeningHistory,
  normalizeMatchText,
  queryYieldTracker,
  recordRefresh,
  reviewStandbyPool,
  scheduleBroadcast,
  searchFreshPool,
  sessionStore,
  STANDBY_ERROR_REFRESH_INTERVAL_MS,
  STANDBY_MODEL_TIMEOUT_MS,
  STANDBY_PARTIAL_REFRESH_INTERVAL_MS,
  STANDBY_REFRESH_INTERVAL_MS,
  STANDBY_REFRESH_TIMEOUT_MS,
  STANDBY_TARGET_COUNT,
  standbyEvents,
  standbyFreshSourcePasses,
  standbyIdentityKeys,
  standbyStore,
  summarizeStandbyFreshness,
  tasteFacetSeedProvider,
  tasteProfile,
  tidal,
  trackMemory,
  previouslySuggestedTrack,
  withSimilarArtistSeeds,
  voiceExecution,
  withNormalizedYearFilter,
  withTimeout
}) {
  let standbyRefreshTimer = null;
  let standbyRefreshInFlight = null;

  function standbyCleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function standbyOptionValue(overrides = {}, sessionOptions = {}, key, fallback = "", behavior = {}) {
    const override = standbyCleanText(overrides[key]);
    if (override) return override;
    if (behavior.useSession === false) return fallback;
    const sessionValue = standbyCleanText(sessionOptions[key]);
    return sessionValue || fallback;
  }

  function hasExplicitStandbySearchOptions(options = {}) {
    const searchKeys = [
      "request",
      "reference",
      "genres",
      "years",
      "mood",
      "language",
      "minScore",
      "scoringMode",
      "releasePreset",
      "releaseExactDate",
      "releaseStartDate",
      "releaseEndDate",
      "llmSearchPlan",
      "similarArtistSeeds",
      "targetGenres",
      "candidateLabels",
      "candidateArtists"
    ];
    return searchKeys.some((key) => {
      const value = options[key];
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") return Object.keys(value).length > 0;
      return standbyCleanText(value);
    });
  }

  function standbyRequestText(request = "") {
    const text = standbyCleanText(request);
    if (!text) return "";
    if (/\bstandby pool\b/i.test(text)) return text;
    // Keep operational policy out of the natural-language intent surface.
    // Terms such as "radio-like" and "underground" can be interpreted as
    // positive vibe/search terms and turn a taste-profile refill into literal
    // catalog queries. Retrieval policy is carried by structured options and
    // diagnostics instead.
    return `${text} Standby pool: prioritize fresh adjacent artists, labels, remixers, and low-exposure catalog sources; avoid repeating top liked or previously recommended artists unless the prompt names them directly.`;
  }

  function standbySearchOptions(overrides = {}, behavior = {}) {
    const session = sessionStore.read();
    const sessionOptions = session.options || {};
    const optionBehavior = { useSession: behavior.useSession !== false };
    const topArtists = tasteProfile.getTopArtists(24);
    let facetSeeds = { facets: [], artists: [], labels: [] };
    try {
      if (typeof tasteFacetSeedProvider === "function") facetSeeds = tasteFacetSeedProvider() || facetSeeds;
    } catch {
      facetSeeds = { facets: [], artists: [], labels: [] };
    }
    let topLabels = [];
    try {
      const labels = tasteProfile.read()?.labels || {};
      topLabels = Object.values(labels)
        .filter((entry) => Number(entry.score || 0) > 0 && standbyCleanText(entry.name))
        .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
        .slice(0, 18)
        .map((entry) => standbyCleanText(entry.name));
    } catch {
      topLabels = [];
    }
    // Interleave metadata-facet anchors with the global feedback leaders.
    // The global list remains strong evidence, but each discovered taste
    // region gets a retrieval opportunity instead of being starved by one
    // larger Progressive House signal.
    const learnedTasteArtists = [];
    const facetArtists = Array.isArray(facetSeeds.artists) ? facetSeeds.artists : [];
    for (let index = 0; index < Math.max(topArtists.length, facetArtists.length); index += 1) {
      if (facetArtists[index]) learnedTasteArtists.push(facetArtists[index]);
      if (topArtists[index]) learnedTasteArtists.push(topArtists[index]);
    }
    const learnedTasteArtistList = Array.from(new Set(learnedTasteArtists)).slice(0, 42);
    const learnedTasteLabels = Array.from(new Set([
      ...topLabels,
      ...(facetSeeds.labels || [])
    ])).slice(0, 30);
    const request = standbyRequestText(standbyOptionValue(
      overrides,
      sessionOptions,
      "request",
      "Find tracks that fit my current Rabbit Hole taste profile. This is a soft multi-facet taste guide, not a one-genre whitelist. Prioritize unfamiliar artists, labels, remixers, long-form versions, and non-obvious discoveries.",
      optionBehavior
    ));

    const options = {
      request,
      reference: standbyOptionValue(overrides, sessionOptions, "reference", "", optionBehavior),
      // Standby is a multi-facet reservoir. An empty genre field here means
      // “use the learned taste anchors and their scene relationships”, not
      // “search the entire catalog without an EDM/electronic boundary”.
      genres: standbyOptionValue(overrides, sessionOptions, "genres", "", optionBehavior),
      years: standbyOptionValue(overrides, {}, "years", "", { useSession: false }),
      // An unprompted mood list would turn one learned region into a hidden
      // global bias. Let the taste facets and their audio/metadata evidence
      // provide the default shape; an explicit mood still wins here.
      mood: standbyOptionValue(overrides, sessionOptions, "mood", "", optionBehavior),
      language: standbyOptionValue(overrides, sessionOptions, "language", "", optionBehavior),
      // Standby is a quality reservoir. Keep the legacy discovery path
      // available, but do not admit weak catalog matches merely to reach 25.
      // Taste-profile mode has no explicit genre/vibe points to add to the
      // normal discovery score. Keep the established standby hard floor of
      // 50 and rely on the separate sludge, release-evidence, and freshness
      // gates for quality; a 60 floor would reject legitimate open-profile
      // matches before they can reach review.
      minScore: standbyOptionValue(overrides, sessionOptions, "minScore", "50", optionBehavior),
      scoringMode: standbyOptionValue(overrides, sessionOptions, "scoringMode", "taste-guided", optionBehavior),
      zoneId: standbyOptionValue(overrides, sessionOptions, "zoneId", "", optionBehavior),
      releasePreset: standbyOptionValue(overrides, {}, "releasePreset", "", { useSession: false }),
      releaseExactDate: standbyOptionValue(overrides, {}, "releaseExactDate", "", { useSession: false }),
      releaseStartDate: standbyOptionValue(overrides, {}, "releaseStartDate", "", { useSession: false }),
      releaseEndDate: standbyOptionValue(overrides, {}, "releaseEndDate", "", { useSession: false }),
      count: String(STANDBY_TARGET_COUNT),
      standbyPool: "true",
      requireRoonQueueable: "",
      learnedTasteArtists: learnedTasteArtistList,
      learnedTasteLabels,
      tasteFacets: facetSeeds.facets || [],
      nowPlaying: overrides.nowPlaying || sessionOptions.nowPlaying || null
    };

    // A background standby refill is a reservoir operation, not a literal
    // natural-language search. Mark the neutral taste-profile variant so the
    // discovery profile can keep operational copy such as "low-exposure" or
    // "non-obvious" from becoming hidden vibe/query terms. An explicit genre
    // or mood still opts out of this suppression.
    const tasteProfileRequest = /\b(?:taste\s+profile|use\s+my\s+taste|based\s+on\s+my\s+taste|current\s+taste)\b/i.test(request);
    if (tasteProfileRequest && !standbyCleanText(options.genres) && !standbyCleanText(options.mood)) {
      options.standbyTasteReservoir = "true";
    }

    for (const [key, value] of Object.entries(overrides || {})) {
      if (value === undefined || value === null) continue;
      if (["zoneId", "count", "requireRoonQueueable", "strictRoonQueueable", "roonStrict"].includes(key)) continue;
      if (typeof value === "string" && !value.trim()) continue;
      if (options[key] === undefined) options[key] = value;
    }
    for (const [key, value] of Object.entries(options)) {
      if (typeof value === "string" && !value.trim()) delete options[key];
    }
    return options;
  }

  function standbyNextRefreshIso(delayMs = STANDBY_REFRESH_INTERVAL_MS) {
    return new Date(Date.now() + Math.max(0, Number(delayMs || 0))).toISOString();
  }

  function standbyPlanAnchorMatches(track = {}, passOptions = {}) {
    if (!booleanFlag(passOptions.requirePlanQueryAnchor)) return true;
    const plan = passOptions.llmSearchPlan && typeof passOptions.llmSearchPlan === "object" ? passOptions.llmSearchPlan : {};
    const query = normalizeMatchText(track.query || track.tidal?.query || "");
    if (!query) return true;
    const anchors = [
      ...(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : []),
      ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
    ].map(standbyCleanText).filter(Boolean);
    const queryAnchors = anchors.filter((anchor) => {
      const key = normalizeMatchText(anchor);
      return key && query.includes(key);
    });
    if (!queryAnchors.length) return true;
    const metadata = normalizeMatchText([
      track.artist,
      track.title,
      track.album,
      track.label,
      track.tidal?.artist,
      track.tidal?.title,
      track.tidal?.album,
      track.tidal?.label
    ].filter(Boolean).join(" "));
    return queryAnchors.some((anchor) => {
      const key = normalizeMatchText(anchor);
      return key && metadata.includes(key);
    });
  }

  function activityTimestamp(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function isRetryableRoonFailure(track = {}) {
    const failure = track.standbyQueueFailure || {};
    return String(failure.failureType || "").trim().toLowerCase() === "error" &&
      /\broon\b.*\b(?:not connected|disconnected|connection|timeout|timed out)\b/i.test(String(failure.reason || ""));
  }

  function standbyActivityEvents({ discoveryBefore = 0 } = {}) {
    const cutoff = Number(discoveryBefore) || 0;
    const retryableQueueKeys = new Set(
      (standbyStore.read?.().candidates || [])
        .filter(isRetryableRoonFailure)
        .flatMap(candidateIdentityKeys)
    );
    const activityEntries = (standbyEvents.entries || []).filter((event) => {
      // A failed queue attempt should not become a permanent freshness signal.
      // If the candidate is marked with a transient Roon connection failure,
      // allow it to remain available for retry after the bridge reconnects.
      // Successful playlist additions remain real user activity and continue
      // to suppress the candidate.
      return !(event.kind === "queued" && candidateIdentityKeys(event).some(key => retryableQueueKeys.has(key)));
    });
    const discoveryEvents = discoveryHistory.uniqueEntries()
      .filter(track => !cutoff || !activityTimestamp(track.lastShownAt) || activityTimestamp(track.lastShownAt) < cutoff)
      .map(t => ({ ...t, kind: "discovery", at: t.lastShownAt }));
    return [
      ...activityEntries,
      ...(listeningHistory.data.plays || []).map(t => ({ ...t, kind: "played", at: t.playedAt })),
      ...Object.values(tasteProfile.read().feedback || {}).map(t => ({ ...t, kind: "rated", at: t.updatedAt })),
      ...discoveryEvents
    ];
  }

  function standbyDisplayActivityEvents(tracks = []) {
    const addedAtByKey = new Map();
    for (const track of tracks || []) {
      const addedAt = activityTimestamp(track.standbyAddedAt || track.standbyUpdatedAt);
      if (!addedAt) continue;
      for (const key of candidateIdentityKeys(track)) {
        const previous = addedAtByKey.get(key) || 0;
        addedAtByKey.set(key, Math.max(previous, addedAt));
      }
    }

    return standbyActivityEvents().filter(event => {
      if (event.kind !== "suggested" && event.kind !== "discovery") return true;
      const eventAt = activityTimestamp(event.at || event.lastShownAt);
      if (!eventAt) return true;
      // A normal discovery result can be recorded while a standby refresh is
      // committing. Do not let that same-run record hide the standby track;
      // records that predate the standby entry still suppress old repeats.
      return !candidateIdentityKeys(event).some(key => {
        const addedAt = addedAtByKey.get(key) || 0;
        return addedAt > 0 && eventAt >= addedAt;
      });
    });
  }

  async function refreshStandbyPool({ force = false, reason = "background", options = {} } = {}) {
    voiceExecution.check();
    if (standbyRefreshInFlight) {
      await standbyRefreshInFlight;
      if (!force) return standbyFreshSummary();
      return refreshStandbyPool({ force, reason, options });
    }
    const current = standbyFreshSummary();
    if (!force && current.count >= STANDBY_TARGET_COUNT) return current;
    standbyRefreshInFlight = (async () => {
      const startedAt = Date.now();
      const modelRouter = getModelRouter();
      const snapshot = standbyStore.read();
      const history = snapshot.standbyHistory?.length ? snapshot.standbyHistory :
        (snapshot.candidates.length ? recordRefresh([], snapshot.candidates, snapshot.lastRefreshAt || new Date().toISOString()) : []);
      const mode = String(options.aiMode || modelRouter?.mode || "auto").toLowerCase();
      // discoverTracks records its returned candidates in the shared history.
      // Freeze the suggestion-history boundary for this refresh so the final
      // safety recheck cannot reject the refresh's own candidates.
      const discoveryHistoryCutoff = startedAt;
      // Query history is durable, but query reuse within one refresh is not
      // productive: once an anchor has returned its available catalogue, the
      // next pass should move to the next artist/label/branch family.
      const refreshQueryKeys = new Set();
      const refreshExpansionArtistKeys = new Set();
      const pool = new FreshPool({ history, current: snapshot.candidates, events: standbyActivityEvents({ discoveryBefore: discoveryHistoryCutoff }), target: STANDBY_TARGET_COUNT });
      standbyStore.markRefreshStart({
        reason,
        synapseReview: {
          attempted: false,
          participated: false,
          model: modelRouter?.openAiProvider?.tierConfig?.(modelRouter?.selectedTier)?.model || "",
          routingMode: mode.toUpperCase(),
          failureType: "stage_not_reached",
          skipReason: "Refresh has not reached the Synapse review stage."
        }
      });
      scheduleBroadcast();
      try {
        if (tidal.status()?.circuit?.state === "open") throw Error("TIDAL search circuit is open; fresh discovery is unavailable.");
        let searchBody = genreProfileStore.augmentOptions(withNormalizedYearFilter(standbySearchOptions(options, { useSession: hasExplicitStandbySearchOptions(options) })));
        if (typeof withSimilarArtistSeeds === "function" && searchBody.scoringMode !== "pure") {
          try {
            // Grow a small Last.fm/Rabbit Hole graph branch before catalog
            // search. This is candidate generation only; later scoring and
            // freshness gates still decide what can enter the pool.
            searchBody = await withSimilarArtistSeeds(searchBody, STANDBY_TARGET_COUNT);
          } catch (error) {
            searchBody.similarArtistExpansion = {
              enabled: false,
              reason: error.message || "Similar-artist expansion failed."
            };
          }
        }
        searchBody.count = String(pool.rawTarget);
        searchBody.effectiveCount = pool.rawTarget;
        searchBody.originalRequestedCount = STANDBY_TARGET_COUNT;
        let modelResult = { plan: null };
        let modelError = "";
        try {
          modelResult = await withTimeout(
            generateStandbySearchPlan({
              mode,
              router: modelRouter,
              options: searchBody,
              localGenerate: (o, t) => generateSearchPlan(config, o, t),
              timeoutMs: STANDBY_MODEL_TIMEOUT_MS
            }),
            STANDBY_MODEL_TIMEOUT_MS,
            "Standby local planning timed out."
          );
        } catch (error) {
          modelError = error.message;
        }
        const scrobbleHistory = await lastFmHistoryForDiscovery();
        const scrobbles = Object.values(scrobbleHistory.tracksByKey || {})
          .filter(t => t.lastPlayedAt)
          .map(t => ({ ...t, kind: "played", at: t.lastPlayedAt }));
        pool.blockEvents(scrobbles);
        const passes = [
          { id: "initial", options: { llmSearchPlan: modelResult.plan, llmCandidates: [] } },
          ...standbyFreshSourcePasses(searchBody, { freshCount: 0, targetCount: STANDBY_TARGET_COUNT })
        ];
        const neutralTasteReservoir = booleanFlag(searchBody.standbyTasteReservoir);
        const outcome = await searchFreshPool({
          pool,
          passes,
          search: async (pass, { remainingMs, requestedCount, acceptCandidate }) => {
            // A neutral standby reservoir has several independent discovery
            // lanes. Do not let the initial artist/album pass consume the
            // whole window; leave time for clean refill, adjacent, label, and
            // radio/relationship sources to contribute fresh catalog.
            const passBudget = pass.id === "initial"
              ? (neutralTasteReservoir ? 40_000 : STANDBY_REFRESH_TIMEOUT_MS)
              : (neutralTasteReservoir ? Math.max(18_000, Number(pass.timeoutMs) || 20_000) : Math.max(18_000, Number(pass.timeoutMs) || 24_000));
            const runtime = Math.min(remainingMs, passBudget);
            let accepting = true;
            const accepted = [];
        let passOptions = genreProfileStore.augmentOptions(withNormalizedYearFilter({
          ...searchBody,
          ...pass.options,
          // A refill pass must not spend its budget re-running the exact
          // queries already attempted earlier in this refresh. This is a
          // per-refresh exclusion only; query history remains durable and
          // contextual across future runs.
              discoveryExcludedQueries: [...refreshQueryKeys],
              discoveryExcludedExpansionArtists: [...refreshExpansionArtistKeys],
              count: String(requestedCount),
              effectiveCount: requestedCount,
              autoBroaden: true,
              standbyOnCandidate: t => { if (accepting) accepted.push(t); },
              standbyAcceptCandidate: t => accepting && acceptCandidate(t),
              discoveryRuntimeMs: Math.max(1, runtime - 1000),
              allowPreviousSuggestions: "true"
            }));
            if (booleanFlag(passOptions.skipSimilarArtistExpansion)) {
              // The clean refill is deliberately an independent anchor lane.
              // Do not let related artists discovered by the initial pass
              // leak back into it and consume the same catalog/search budget.
              passOptions = {
                ...passOptions,
                similarArtistSeeds: [],
                similarArtistExpansion: {
                  enabled: false,
                  reason: "This standby pass uses only its explicit artist/label anchors."
                }
              };
            }
            let discovered;
            try {
            discovered = await withTimeout(
                discoverTracks({ tidal, options: passOptions, history: discoveryHistory, tasteProfile, scrobbleHistory, queryYieldTracker }),
                runtime,
                "Standby search pass timed out."
              );
            } catch (error) {
              discovered = { tracks: accepted, verification: { poolDiagnostics: { partialResult: true, error: error.message } } };
            } finally {
              accepting = false;
            }
            for (const item of discovered.verification?.querySelectionDiagnostics || []) {
              const query = standbyCleanText(item?.query);
              if (query) refreshQueryKeys.add(normalizeMatchText(query));
            }
            for (const artist of discovered.verification?.artistExpansionArtists || []) {
              const key = normalizeMatchText(artist);
              if (key) refreshExpansionArtistKeys.add(key);
            }
            return {
              tracks: [
                ...(discovered.tracks || []),
                ...(discovered.alternates || []),
                ...accepted
              ].filter(t => standbyPlanAnchorMatches(t, passOptions)),
              diagnostics: {
                ...(discovered.verification?.poolDiagnostics || {}),
                similarArtistExpansion: passOptions.similarArtistExpansion || null,
                querySelectionDiagnostics: discovered.verification?.querySelectionDiagnostics || [],
                artistExpansionArtists: discovered.verification?.artistExpansionArtists || [],
                passRuntimeBudgetMs: runtime,
                refreshExcludedQueryCount: refreshQueryKeys.size,
                refreshExcludedExpansionArtistCount: refreshExpansionArtistKeys.size
              }
            };
          },
          review: async tracks => {
            pool.blockEvents(standbyActivityEvents({ discoveryBefore: discoveryHistoryCutoff }));
            const clean = tracks.filter(t => pool.eligible(t));
            const result = await reviewStandbyPool(clean, {
              router: modelRouter,
              mode,
              profile: tasteProfile.read(),
              timeoutMs: STANDBY_MODEL_TIMEOUT_MS
            });
            result.review.candidateIdentities = clean.map(standbyIdentityKeys);
            return result;
          }
        });
        pool.blockEvents(standbyActivityEvents({ discoveryBefore: discoveryHistoryCutoff }));
        const commitTracks = outcome.tracks.filter(t => pool.eligible(t));
        voiceExecution.check();
        const added = standbyStore.replace(commitTracks, {
          reason,
          source: "Fresh standby discovery",
          recordHistory: true,
          history,
          // Diversity is attempted first. If the reviewed fresh pool still
          // undershoots, permit a second track from a strong album so the
          // reservoir does not collapse solely because of an album cap.
          allowAlbumRepeatsOnShortfall: true
        });
        Object.assign(outcome.novelty, { finalCount: added.tracks.length, newTracksIntroduced: added.tracks.length, carriedOver: 0 });
        if (added.tracks.length) trackMemory.record(added.tracks, Date.now(), { incrementSeen: false });
        const summary = standbyStore.markRefreshEnd({
          reason,
          runtimeMs: Date.now() - startedAt,
          generated: outcome.novelty.rawCandidatesGenerated,
          kept: added.tracks.length,
          diagnostics: {
            novelty: outcome.novelty,
            synapseReview: outcome.review,
            standbyBroadening: { passes: outcome.searches },
            canonicalReleasePreference: {
              applied: Boolean(added.canonicalReleaseRejected?.length),
              rejectedCount: added.canonicalReleaseRejected?.length || 0,
              rejected: added.canonicalReleaseRejected || []
            },
            localModel: modelResult?.routing?.model || "",
            modelError
          },
          nextRefreshAt: added.tracks.length < STANDBY_TARGET_COUNT ? standbyNextRefreshIso(STANDBY_PARTIAL_REFRESH_INTERVAL_MS) : ""
        });
        scheduleBroadcast();
        return standbyFreshSummary(summary);
      } catch (error) {
        const summary = standbyStore.markRefreshEnd({
          reason,
          runtimeMs: Date.now() - startedAt,
          error: error.message,
          kept: current.count,
          diagnostics: {
            novelty: {
              ...pool.diagnostics,
              carriedOver: current.count,
              carryoverReason: "Refresh failed before commit; previous display retained: " + error.message,
              finalCount: current.count,
              newTracksIntroduced: 0
            }
          },
          nextRefreshAt: standbyNextRefreshIso(STANDBY_ERROR_REFRESH_INTERVAL_MS)
        });
        scheduleBroadcast();
        return standbyFreshSummary(summary);
      }
    })();
    try {
      return await standbyRefreshInFlight;
    } finally {
      standbyRefreshInFlight = null;
    }
  }

  function scheduleStandbyRefresh(delayMs = STANDBY_REFRESH_INTERVAL_MS) {
    if (standbyRefreshTimer) clearTimeout(standbyRefreshTimer);
    standbyRefreshTimer = setTimeout(async () => {
      standbyRefreshTimer = null;
      let nextDelayMs = STANDBY_REFRESH_INTERVAL_MS;
      try {
        const summary = await refreshStandbyPool({ reason: "background" });
        nextDelayMs = summary?.lastError
          ? STANDBY_ERROR_REFRESH_INTERVAL_MS
          : (Number(summary?.count || 0) < STANDBY_TARGET_COUNT
            ? STANDBY_PARTIAL_REFRESH_INTERVAL_MS
            : STANDBY_REFRESH_INTERVAL_MS);
      } finally {
        scheduleStandbyRefresh(nextDelayMs);
      }
    }, Math.max(1_000, Number(delayMs || STANDBY_REFRESH_INTERVAL_MS)));
  }

  function standbyFreshSummary(snapshot = standbyStore.summary()) {
    const originalTracks = Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
    const activity = new FreshPool({ events: standbyDisplayActivityEvents(originalTracks), target: STANDBY_TARGET_COUNT });
    const tracks = originalTracks.filter(t => activity.eligible(t));
    const freshness = summarizeStandbyFreshness({
      storedTracks: originalTracks,
      visibleTracks: tracks,
      targetCount: STANDBY_TARGET_COUNT,
      isPreviouslySuggested: previouslySuggestedTrack,
      keyForTrack: (track) => (candidateIdentityKeys(track)[0] || track.key || "")
    });
    return {
      ...snapshot,
      tracks,
      count: tracks.length,
      ready: tracks.length >= STANDBY_TARGET_COUNT,
      filteredPreviouslySuggested: Math.max(0, originalTracks.length - tracks.length),
      freshness,
      nextRefreshAt: tracks.length >= STANDBY_TARGET_COUNT ? "" : snapshot.nextRefreshAt || ""
    };
  }

  return {
    hasExplicitStandbySearchOptions,
    refreshStandbyPool,
    scheduleStandbyRefresh,
    standbyActivityEvents,
    standbyCleanText,
    standbyFreshSummary,
    standbyPlanAnchorMatches,
    standbyRequestText,
    standbySearchOptions
  };
}

module.exports = {
  createStandbyRefreshService
};
