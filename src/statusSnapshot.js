"use strict";

function sessionSnapshot({ sessionStore, syncFinalResultVerification, parseRequestedCount } = {}) {
  const session = sessionStore?.read?.() || { updatedAt: null, options: {}, result: null };
  if (!session.result) return session;
  return {
    ...session,
    result: syncFinalResultVerification(
      session.result,
      Number(session.result?.verification?.requested || 0) || parseRequestedCount(session.options || {})
    )
  };
}

function appSnapshot({
  latestResultSource = "discovery",
  latestBridgeSyncAlert = null,
  sessionStore,
  syncFinalResultVerification,
  parseRequestedCount,
  tasteProfile,
  genreProfileStore,
  trackMemory,
  standbyFreshSummary,
  queryYieldTracker,
  lastfm,
  tidal,
  tidalProfileMixes,
  radioMetadataResolver,
  metadataEnrichment,
  llmSnapshot,
  modelRouter,
  now = () => new Date()
} = {}) {
  const taste = tasteProfile.read();
  const session = sessionSnapshot({ sessionStore, syncFinalResultVerification, parseRequestedCount });
  const modelStatus = modelRouter ? modelRouter.status() : null;
  return {
    latestResultSource,
    bridgeSyncAlert: latestBridgeSyncAlert,
    updatedAt: now().toISOString(),
    session,
    taste: tasteProfile.summary(taste),
    feedback: taste.feedback || {},
    genreProfiles: genreProfileStore.summary(),
    memory: trackMemory.summary(),
    standby: standbyFreshSummary(),
    queryYield: queryYieldTracker.summary(),
    lastfm: lastfm.status(),
    tidal: tidal.status(),
    tidalProfileMixes: tidalProfileMixes.status(),
    radioMetadata: radioMetadataResolver.status(),
    metadataEnrichment: metadataEnrichment.status(),
    llm: llmSnapshot(),
    ai: modelStatus,
    mcp: {
      endpoint: "/mcp",
      connected: true,
      toolCount: modelStatus ? modelStatus.tools.count : 0
    }
  };
}

module.exports = {
  appSnapshot,
  sessionSnapshot
};
