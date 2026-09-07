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
  tasteProfile,
  tidal,
  trackMemory,
  previouslySuggestedTrack,
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
    return `${text} Standby pool: prioritize fresh adjacent artists, labels, remixers, and radio-like sources; avoid repeating top liked or previously recommended artists unless the prompt names them directly.`;
  }

  function standbySearchOptions(overrides = {}, behavior = {}) {
    const session = sessionStore.read();
    const sessionOptions = session.options || {};
    const optionBehavior = { useSession: behavior.useSession !== false };
    const now = new Date();
    const currentYear = now.getFullYear();
    const topArtists = tasteProfile.getTopArtists(10);
    const tastePrompt = topArtists.length
      ? `Taste anchors: ${topArtists.join(", ")}. Use them as gravity, not repeats.`
      : "Taste anchors are still forming. Favor high-confidence adjacent discoveries.";
    const request = standbyRequestText(standbyOptionValue(
      overrides,
      sessionOptions,
      "request",
      `Find tracks that fit my current Rabbit Hole taste profile. ${tastePrompt} Prioritize adjacent artists, labels, remixers, radio-like sources, long-form versions, and non-obvious discoveries.`,
      optionBehavior
    ));

    const options = {
      request,
      reference: standbyOptionValue(overrides, sessionOptions, "reference", "", optionBehavior),
      genres: standbyOptionValue(overrides, sessionOptions, "genres", "progressive house, melodic house, organic house, melodic techno", optionBehavior),
      years: standbyOptionValue(overrides, {}, "years", `${Math.max(2000, currentYear - 6)}-${currentYear}`, { useSession: false }),
      mood: standbyOptionValue(overrides, sessionOptions, "mood", "hypnotic, deep, melodic, cosmic, psychedelic, underground, long / extended", optionBehavior),
      language: standbyOptionValue(overrides, sessionOptions, "language", "", optionBehavior),
      minScore: standbyOptionValue(overrides, sessionOptions, "minScore", "", optionBehavior),
      scoringMode: standbyOptionValue(overrides, sessionOptions, "scoringMode", "explore", optionBehavior),
      zoneId: standbyOptionValue(overrides, sessionOptions, "zoneId", "", optionBehavior),
      releasePreset: standbyOptionValue(overrides, {}, "releasePreset", "", { useSession: false }),
      releaseExactDate: standbyOptionValue(overrides, {}, "releaseExactDate", "", { useSession: false }),
      releaseStartDate: standbyOptionValue(overrides, {}, "releaseStartDate", "", { useSession: false }),
      releaseEndDate: standbyOptionValue(overrides, {}, "releaseEndDate", "", { useSession: false }),
      count: String(STANDBY_TARGET_COUNT),
      standbyPool: "true",
      requireRoonQueueable: "",
      nowPlaying: overrides.nowPlaying || sessionOptions.nowPlaying || null
    };

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

  function standbyActivityEvents() {
    return [
      ...standbyEvents.entries,
      ...(listeningHistory.data.plays || []).map(t => ({ ...t, kind: "played", at: t.playedAt })),
      ...Object.values(tasteProfile.read().feedback || {}).map(t => ({ ...t, kind: "rated", at: t.updatedAt })),
      ...discoveryHistory.uniqueEntries().map(t => ({ ...t, kind: "suggested", at: t.lastShownAt }))
    ];
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
      const pool = new FreshPool({ history, current: snapshot.candidates, events: standbyActivityEvents(), target: STANDBY_TARGET_COUNT });
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
        const outcome = await searchFreshPool({
          pool,
          passes,
          search: async (pass, { remainingMs, requestedCount, acceptCandidate }) => {
            const runtime = Math.min(remainingMs, pass.id === "initial" ? STANDBY_REFRESH_TIMEOUT_MS : Math.max(18000, Number(pass.timeoutMs) || 24000));
            let accepting = true;
            const accepted = [];
            const passOptions = genreProfileStore.augmentOptions(withNormalizedYearFilter({
              ...searchBody,
              ...pass.options,
              count: String(requestedCount),
              effectiveCount: requestedCount,
              autoBroaden: true,
              standbyOnCandidate: t => { if (accepting) accepted.push(t); },
              standbyAcceptCandidate: t => accepting && acceptCandidate(t),
              discoveryRuntimeMs: Math.max(1, runtime - 1000),
              allowPreviousSuggestions: "true"
            }));
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
            return {
              tracks: [
                ...(discovered.tracks || []),
                ...(discovered.alternates || []),
                ...accepted
              ].filter(t => standbyPlanAnchorMatches(t, passOptions)),
              diagnostics: discovered.verification?.poolDiagnostics || null
            };
          },
          review: async tracks => {
            pool.blockEvents(standbyActivityEvents());
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
        pool.blockEvents(standbyActivityEvents());
        const commitTracks = outcome.tracks.filter(t => pool.eligible(t));
        voiceExecution.check();
        const added = standbyStore.replace(commitTracks, { reason, source: "Fresh standby discovery", recordHistory: true, history });
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
    const activity = new FreshPool({ events: standbyActivityEvents(), target: STANDBY_TARGET_COUNT });
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
