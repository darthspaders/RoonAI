"use strict";

const http = require("http");
const voiceExecution = require("./voiceExecution");
const { createVoiceApi } = require("./voiceApi");
const {memory} = require("./synapseMemory");
const { bridgeSyncAlertFromResult } = require("./bridgeSyncAlert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const config = require("./config");
const { FreshPool, FreshnessEvents, searchFreshPool, identityKeys: standbyIdentityKeys } = require("./standbyFreshness");
const { recordRefresh } = require("./standbyNovelty");
const { reviewStandbyPool, generateStandbySearchPlan } = require("./standbySynapseReview");
const { ExternalTrackQueue } = require("./externalTrackQueue");
const { exactIntent, verifyExactTracks, queueExactTracks } = require("./exactTrackVerification");
const { resolveVerifiedTracksForRoon } = require("./roonExactResolution");
const { ExactRoonBridge } = require("./exactRoonBridge");
const { RoonInternalTidalSync } = require("./roonInternalTidalSync");
const { ExactVerificationStore } = require("./exactVerificationStore");
const exactVerificationStore = new ExactVerificationStore(path.join(__dirname, "..", "data", "last-exact-verification.json"));
let lastExactVerification = exactVerificationStore.read();
let latestResultSource = "discovery";
let latestBridgeSyncAlert = null;
async function runExactVerification(body) {
  const result = await verifyExactTracks(body, { tidal, roon, logger: entry => console.warn("[exact-verification]", JSON.stringify(entry)) });
  lastExactVerification = result;
  exactVerificationStore.save(result);
  latestResultSource = "exact_verification";
  scheduleBroadcast();
  return result;
}

function defaultRoonZoneId() {
  const zones = roon.getState().zones;
  const selected = sessionStore.read()?.options?.zoneId;
  return zones.find(zone => zone.zone_id === selected)?.zone_id ||
    zones.find(zone => zone.state === "playing")?.zone_id ||
    zones[0]?.zone_id;
}

const {
  candidateIdentityKeys,
  artistKeysForCandidate,
  buildDiscoveryProfile,
  belowMinimumSoftRejectReason,
  autoBroadenSearchPasses,
  allowsArtistRepeatFallback,
  defaultPerRunArtistCap,
  discoverTracks,
  discoveryStatusFor,
  effectiveDiscoveryCount,
  minimumScoreFor,
  minimumScoreLabel,
  nearYearFallbackOptions,
  normalizeScoringMode,
  parseRequestedCount,
  previouslyRecommendedArtistReason,
  releaseFilterRequiresVerification,
  requestPrefersExtendedMixes,
  reasonFor,
  rejectReason,
  scoreBreakdownFor,
  selectDiscoveryLaneCandidates,
  shouldContinueAutoBroadenAfterError,
  whyBulletsFor
} = require("./discoveryEngine");
const { DiscoveryHistory } = require("./discoveryHistory");
const { ListeningHistory } = require("./listeningHistory");
const { generateSearchPlan, scoreCandidateBatch } = require("./llmClient");
const { LastFmClient } = require("./lastFmClient");
const { MetadataEnrichmentService } = require("./metadataEnrichmentService");
const { MusicBrainzLocalIndex } = require("./musicBrainzLocalIndex");
const { BeatportClient } = require("./beatportClient");
const { MusicMemoryStore } = require("./musicMemoryStore");
const { runBeatportEnrichmentBackfill } = require("../scripts/beatport-enrichment-backfill");
const { createRabbitHoleMcpHttpHandler, createRabbitHoleMcpTools } = require("./mcpHttpServer");
const { createModelRouter } = require("./modelProviders");
const {
  appSnapshot: buildAppSnapshot,
  sessionSnapshot: buildSessionSnapshot
} = require("./statusSnapshot");
const {
  createModelReviewAudit,
  classifyModelReviewChange,
  modelReviewAuditItem,
  recordModelReviewAudit
} = require("./modelReviewAudit");
const { createModelCandidateReviewer } = require("./modelCandidateReview");
const { QueryYieldTracker } = require("./queryYieldTracker");
const { recordFeedbackAcrossStores } = require("./feedbackRecorder");
const {
  feedbackCalibrationContext: buildFeedbackCalibrationContext,
  feedbackTrackWithSessionContext: buildFeedbackTrackWithSessionContext,
  isRadioPlaybackTrack
} = require("./feedbackContext");
const { createTidalLookupResolver } = require("./tidalLookupResolver");
const { createAgentTrackVerifier } = require("./agentTrackVerifier");
const { createRoonTidalEnricher } = require("./roonTidalEnrichment");
const { createRoonFirstDecorator } = require("./roonFirstDecorator");
const {
  createRoonFirstRescueRunner,
  roonFirstResultIsEnough
} = require("./roonFirstRescueRunner");
const { createRoonQueueableFilter } = require("./roonQueueableFilter");
const { createStandbyRefreshService } = require("./standbyRefreshService");
const { createPcMonitorStatus } = require("./pcMonitorStatus");
const { createLlmHealthStatus } = require("./llmHealthStatus");
const { createCurrentTrackMetadataEnrichment } = require("./currentTrackMetadataEnrichment");
const { createRadioEnrichmentService } = require("./radioEnrichmentService");
const { createSimilarArtistExpansion } = require("./similarArtistExpansion");
const {
  diversifyCandidates,
  requestAllowsArtistCluster
} = require("./discoveryDiversity");
const { createDiscoveryRequestPolicy } = require("./discoveryRequestPolicy");
const { createDiscoveryResultVerification } = require("./discoveryResultVerification");
const { createDiscoveryOrchestration } = require("./discoveryOrchestration");
const {
  createDiscoveryNoveltyPolicy,
  requestAllowsPreviousSuggestions
} = require("./discoveryNoveltyPolicy");
const {
  normalizeMatchText,
  tidalEnrichmentMatches,
  tidalPlaylistFallbackMatches
} = require("./tidalMatchRules");
const { GenreProfileStore } = require("./genreProfileStore");
const { HQPlayerStatus } = require("./hqplayerStatus");
const { RoonClient } = require("./roonClient");
const { RabbitHoleGraph } = require("./rabbitHoleGraph");
const { RadioMetadataResolver } = require("./radioMetadataResolver");
const {
  cleanArtworkUrl,
  cleanHttpUrl,
  cleanRadioText,
  normalizeRadioText,
  parseRoonPresenceNowState,
  radioEnrichmentHasArtwork,
  radioEnrichmentKey,
  radioEnrichmentResultKey,
  radioTrackFromZone,
  summarizeZoneTrack
} = require("./radioPlaybackState");
const { SessionStore, trackKey } = require("./sessionStore");
const { StandbyCandidateStore, isStandbySeoSludge } = require("./standbyCandidateStore");
const {
  mergeStandbyRefillPool,
  standbyFreshSourcePasses,
  summarizeStandbyFreshness
} = require("./standbyDiscoveryPlanner");
const { TidalPinnedMixStore } = require("./tidalPinnedMixes");
const { TasteProfile, normalizeRating, ratingDelta } = require("./tasteProfile");
const { TidalProfileMixes } = require("./tidalProfileMixes");
const { TidalVerifier } = require("./tidalVerifier");
const { TrackMemory } = require("./trackMemory");
const { QueueAttemptStore } = require("./queueAttemptStore");
const { mergeTrackLists } = require("./trackListMerge");
const yearRangeUtil = require("./yearRange");

const publicDir = path.join(__dirname, "..", "public");
const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;
const TIDAL_QUALITY_LOOKUP_TIMEOUT_MS = Math.max(
  8_000,
  Math.min(30_000, Number(process.env.TIDAL_QUALITY_LOOKUP_TIMEOUT_MS || Math.max(15_000, Number(config.tidal.timeoutMs || 12_000) + 3_000)))
);
const TIDAL_PLAYLIST_VERIFY_TIMEOUT_MS = Math.max(8_000, Math.min(45_000, Number(process.env.TIDAL_PLAYLIST_VERIFY_TIMEOUT_MS || 18_000)));
const TIDAL_PLAYLIST_FALLBACK_TIMEOUT_MS = Math.max(6_000, Math.min(30_000, Number(process.env.TIDAL_PLAYLIST_FALLBACK_TIMEOUT_MS || 12_000)));
const STANDBY_TARGET_COUNT = Math.max(1, Math.min(100, Number(process.env.STANDBY_TARGET_COUNT || 25)));
const STANDBY_REFRESH_INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.STANDBY_REFRESH_INTERVAL_MS || 20 * 60_000));
const STANDBY_PARTIAL_REFRESH_INTERVAL_MS = Math.max(2 * 60_000, Number(process.env.STANDBY_PARTIAL_REFRESH_INTERVAL_MS || 5 * 60_000));
const STANDBY_ERROR_REFRESH_INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.STANDBY_ERROR_REFRESH_INTERVAL_MS || 10 * 60_000));
const STANDBY_REFRESH_TIMEOUT_MS = Math.max(12_000, Math.min(90_000, Number(process.env.STANDBY_REFRESH_TIMEOUT_MS || 35_000)));
const STANDBY_MODEL_TIMEOUT_MS = Math.max(8_000, Math.min(60_000, Number(process.env.STANDBY_MODEL_TIMEOUT_MS || 25_000)));
const roon = new RoonClient();
const directRoonQueue = new (require('./directRoonQueue').DirectRoonQueue)(roon,
  entry => console.info('[direct-roon-queue]', JSON.stringify(entry)),
  () => (lastExactVerification?.tracks || []).filter(row => row.tidal?.verified).map(row => ({ ...row.track, tidalTrackId: row.tidalTrackId })));
const discoveryHistory = new DiscoveryHistory();
const {
  freshUnseenTracks,
  previouslySuggestedTrack,
  suppressPreviouslySuggestedResultTracks
} = createDiscoveryNoveltyPolicy({
  discoveryHistory,
  candidateIdentityKeys
});
const listeningHistory = new ListeningHistory();
const sessionStore = new SessionStore();
const tasteProfile = new TasteProfile();
const trackMemory = new TrackMemory();
const queueAttemptStore = new QueueAttemptStore();
const standbyStore = new StandbyCandidateStore({ targetCount: STANDBY_TARGET_COUNT });
const standbyEvents = new FreshnessEvents();
let musicMemory = null;
function recordStandbyActivity(kind,tracks) {
  try {standbyEvents.record(kind,tracks);} catch(error) {console.error("[standby-activity] Persistence failed:",error.message);}
}
function rememberMusicObservations(tracks, source, optionsForTrack = null) {
  const list = Array.isArray(tracks) ? tracks : [tracks].filter(Boolean);
  for (const [index, track] of list.entries()) {
    const options = typeof optionsForTrack === "function" ? optionsForTrack(track, index) : (optionsForTrack || {});
    try { musicMemory?.rememberObservation?.(track, source, options); } catch (error) { console.debug("[music-memory] Observation failed:", error.message); }
  }
}
roon.on("trackQueued", track => {
  recordStandbyActivity("queued", [track]);
  rememberMusicObservations(track, "queued");
});
const lastfm = new LastFmClient(config.lastfm);
const tidalProfileMixes = new TidalProfileMixes(config.tidalProfileMixes);
tidalProfileMixes.onTracksAdded = tracks => {
  recordStandbyActivity("playlist", tracks);
  rememberMusicObservations(tracks, "tidal_playlist");
};
const roonInternalTidalSync = new RoonInternalTidalSync(config.roonInternal, console);
const exactRoonBridge = new ExactRoonBridge({
  profile: tidalProfileMixes,
  roon,
  file: path.join(__dirname, "..", "data", "exact-bridge.json"),
  internalTidalSync: roonInternalTidalSync,
  ...config.exactRoonBridge
});
const externalTrackQueue = new ExternalTrackQueue({ roon, verify: runExactVerification,
  save: result => { if (lastExactVerification === result) exactVerificationStore.save(result); },
  bridge: exactRoonBridge
});
{
  const directBridge = require("./directRoonBridge");
  const directBridgeDeps = { knownTracks: () => directRoonQueue.knownTracks(), tidal: { getTrack: (id) => tidal.getTrack(id) }, bridge: exactRoonBridge };
  roon.resolveDirectBridge = directBridge.createDirectBridge(directBridgeDeps);
  roon.resolveDirectBridgeBatch = directBridge.createDirectBridgeBatch(directBridgeDeps);
}
const tidalPinnedMixes = new TidalPinnedMixStore({ file: config.tidalProfileMixes.pinnedFile });
const tidal = new TidalVerifier({
  ...config.tidal,
  profileAccessTokenProvider: () => tidalProfileMixes.auth.getAccessToken()
});
const queryYieldTracker = new QueryYieldTracker();
const genreProfileStore = new GenreProfileStore();
const rabbitHoleGraph = new RabbitHoleGraph();
const { withSimilarArtistSeeds } = createSimilarArtistExpansion({
  buildDiscoveryProfile,
  config,
  lastfm,
  normalizeScoringMode,
  rabbitHoleGraph,
  tasteProfile,
  withTimeout
});
const artBridgeProvider = createArtBridgeProvider(config.artBridge);
const musicBrainzLocalIndex = new MusicBrainzLocalIndex({
  ...config.musicBrainzLocal,
  logger: console
});
const beatport = new BeatportClient({
  ...config.beatport,
  logger: console
});
musicMemory = new MusicMemoryStore({
  ...config.musicMemory,
  logger: console
});
const radioMetadataResolver = new RadioMetadataResolver({
  enabled: config.radioMetadata.enabled,
  cacheMax: config.radioMetadata.cacheMax,
  minLookupIntervalMs: config.radioMetadata.minLookupIntervalMs,
  tidalArtworkEnabled: config.radioMetadata.tidalArtworkEnabled,
  tidalCountryCode: config.radioMetadata.tidalCountryCode,
  tidalAccessToken: config.radioMetadata.tidalAccessToken,
  tidalClientId: config.radioMetadata.tidalClientId,
  tidalClientSecret: config.radioMetadata.tidalClientSecret,
  tidalTimeoutMs: config.radioMetadata.tidalTimeoutMs,
  tidalFailureThreshold: config.radioMetadata.tidalFailureThreshold,
  tidalCircuitCooldownMs: config.radioMetadata.tidalCircuitCooldownMs,
  discogsEnabled: config.radioMetadata.discogsEnabled,
  discogsToken: config.radioMetadata.discogsToken,
  musicBrainzIndex: musicBrainzLocalIndex,
  musicBrainzPublicFallback: config.musicBrainzLocal.publicFallback,
  spotifyArtworkEnabled: config.radioMetadata.spotifyArtworkEnabled,
  spotifyMarket: config.radioMetadata.spotifyMarket,
  spotifyClientId: config.radioMetadata.spotifyClientId,
  spotifyClientSecret: config.radioMetadata.spotifyClientSecret,
  albumArtProvider: artBridgeProvider,
  logger: console
});
const {
  attachRadioEnrichment,
  scheduleRadioEnrichment
} = createRadioEnrichmentService({
  cleanArtworkUrl,
  cleanHttpUrl,
  cleanRadioText,
  config,
  fetchJsonWithTimeout,
  parseRoonPresenceNowState,
  radioEnrichmentHasArtwork,
  radioEnrichmentKey,
  radioEnrichmentResultKey,
  radioMetadataResolver,
  radioTrackFromZone,
  scheduleBroadcast,
  tidal,
  tidalEnrichmentMatches
});
const metadataEnrichment = new MetadataEnrichmentService({
  tidal,
  beatport,
  musicMemory,
  metadataResolver: radioMetadataResolver,
  artBridge: config.artBridge,
  cacheFile: config.metadataEnrichment.cacheFile,
  minConfidence: config.metadataEnrichment.minConfidence,
  timeoutMs: config.metadataEnrichment.timeoutMs,
  beatportMissingRetryMs: config.beatport.missingRetryMs,
  logger: console
});
const {
  attachMetadataEnrichment,
  scheduleMetadataEnrichment
} = createCurrentTrackMetadataEnrichment({
  cleanRadioText,
  config,
  metadataEnrichment,
  scheduleBroadcast,
  summarizeZoneTrack
});
let beatportMemoryBackfillRunning = false;
function scheduleBeatportMemoryBackfill(delayMs = config.beatportMemoryBackfill.startDelayMs) {
  if (!config.beatportMemoryBackfill.enabled || !config.beatport.enabled || !beatport.isConfigured?.() || !musicMemory?.enabled) return;
  const waitMs = Math.max(30_000, Number(delayMs) || 0);
  const timer = setTimeout(async () => {
    if (beatportMemoryBackfillRunning) {
      scheduleBeatportMemoryBackfill(config.beatportMemoryBackfill.intervalMs);
      return;
    }
    beatportMemoryBackfillRunning = true;
    try {
      const result = await runBeatportEnrichmentBackfill({
        store: musicMemory,
        beatport,
        limit: config.beatportMemoryBackfill.batchSize,
        delayMs: config.beatportMemoryBackfill.delayMs,
        jitter: config.beatportMemoryBackfill.jitter,
        logger: console
      });
      if (result.enriched > 0) scheduleBroadcast();
    } catch (error) {
      console.warn("[beatport-memory-backfill] Failed:", error.message);
    } finally {
      beatportMemoryBackfillRunning = false;
      scheduleBeatportMemoryBackfill(config.beatportMemoryBackfill.intervalMs);
    }
  }, waitMs);
  timer.unref?.();
}
const hqplayerStatus = new HQPlayerStatus({
  ...config.hqplayer,
  activePlaybackProvider: () => roon.hasActivePlayback(),
  onChange: () => scheduleBroadcast()
});
const OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai-compatible", "openai_compatible", "lmstudio", "llamacpp"]);
const {
  booleanFlag,
  isStrictRoonQueueMode,
  shouldSkipModelForCatalogSearch,
  strictSearchBudgets,
  withNormalizedYearFilter
} = createDiscoveryRequestPolicy({
  buildDiscoveryProfile,
  config,
  minimumScoreFor,
  normalizeMatchText,
  openAiCompatibleProviders: OPENAI_COMPATIBLE_PROVIDERS,
  yearRangeUtil
});
const {
  queueableStatusChecks,
  roonMatchSummary,
  roonVerificationTimeoutFallback,
  shouldRunRoonFirstRescue,
  syncFinalResultVerification,
  tidalPlaylistBridgeResult
} = createDiscoveryResultVerification({
  candidateIdentityKeys,
  mergeTrackLists,
  normalizeMatchText
});
const {
  applyModelCandidateReview
} = createModelCandidateReviewer({
  candidateIdentityKeys,
  classifyModelReviewChange,
  config,
  createModelReviewAudit,
  mergeTrackLists,
  modelReviewAuditItem,
  normalizeMatchText,
  recordModelReviewAudit,
  scoreCandidateBatch,
  tasteProfile
});
const {
  rebalanceDiscoveryResult,
  runAutoBroadenSearches
} = createDiscoveryOrchestration({
  artistKeysForCandidate,
  autoBroadenSearchPasses,
  buildDiscoveryProfile,
  defaultPerRunArtistCap,
  discoverTracks,
  discoveryHistory,
  mergeTrackLists,
  queryYieldTracker,
  selectDiscoveryLaneCandidates,
  shouldContinueAutoBroadenAfterError,
  tasteProfile,
  tidal,
  withTimeout
});
const tidalLookupResolver = createTidalLookupResolver({
  tidal,
  metadataEnrichment,
  hqplayerStatus,
  isRadioPlaybackTrack,
  withTimeout,
  qualityLookupTimeoutMs: TIDAL_QUALITY_LOOKUP_TIMEOUT_MS,
  playlistVerifyTimeoutMs: TIDAL_PLAYLIST_VERIFY_TIMEOUT_MS,
  playlistFallbackTimeoutMs: TIDAL_PLAYLIST_FALLBACK_TIMEOUT_MS
});
const {
  findExactTidalCatalogueTrack,
  resolveCurrentTrackQuality,
  resolveTidalTrackForPlaylist
} = tidalLookupResolver;
const { verifyTracksForAgent } = createAgentTrackVerifier({
  tidal,
  roon,
  discoveryHistory,
  trackMemory,
  trackKey,
  findExactTidalCatalogueTrack,
  withTimeout,
  roonMatchSummary,
  booleanFlag,
  playlistVerifyTimeoutMs: TIDAL_PLAYLIST_VERIFY_TIMEOUT_MS
});
const { enrichRoonTracksOpportunistically } = createRoonTidalEnricher({
  tidal,
  wait
});
const roonFirstDecorator = createRoonFirstDecorator({
  buildDiscoveryProfile,
  releaseFilterRequiresVerification,
  parseRequestedCount,
  minimumScoreFor,
  minimumScoreLabel,
  mergeTrackLists,
  discoveryHistory,
  enrichRoonTracksOpportunistically,
  nearYearFallbackOptions,
  rejectReason,
  previouslyRecommendedArtistReason,
  scoreBreakdownFor,
  tasteProfile,
  belowMinimumSoftRejectReason,
  reasonFor,
  whyBulletsFor,
  discoveryStatusFor,
  queueableStatusChecks,
  diversifyCandidates,
  requestAllowsArtistCluster
});
const { runFreshRoonRescue } = createRoonFirstRescueRunner({
  roon,
  withTimeout,
  mergeTrackLists,
  parseRequestedCount,
  releaseFilterRequiresVerification,
  decorateRoonFirstResult: roonFirstDecorator.decorateRoonFirstResult,
  decorateRoonFirstTimeoutFallback: roonFirstDecorator.decorateRoonFirstTimeoutFallback
});
const {
  filterForRoonQueueable,
  verifyPlaylistWithRoon
} = createRoonQueueableFilter({
  allowsArtistRepeatFallback,
  artistKeysForCandidate,
  buildDiscoveryProfile,
  candidateIdentityKeys,
  defaultPerRunArtistCap,
  minimumScoreFor,
  normalizeMatchText,
  queueableStatusChecks,
  rejectReason,
  requestPrefersExtendedMixes,
  roon,
  roonMatchSummary,
  tidal,
  yearRangeUtil
});
const clients = new Set();
const STATE_UPDATE_DEBOUNCE_MS = 1000;
const EVENT_STREAM_HEARTBEAT_MS = Math.max(5000, Number(process.env.EVENT_STREAM_HEARTBEAT_MS || 15000));
let broadcastTimer = null;
let lastBroadcastData = "";
let modelRouter = null;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const {
  refreshStandbyPool,
  scheduleStandbyRefresh,
  standbyCleanText,
  standbyFreshSummary
} = createStandbyRefreshService({
  booleanFlag,
  candidateIdentityKeys,
  config,
  discoverTracks,
  discoveryHistory,
  FreshPool,
  generateSearchPlan,
  generateStandbySearchPlan,
  genreProfileStore,
  getModelRouter: () => modelRouter,
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
});
const { pcMonitorSnapshot } = createPcMonitorStatus({
  config,
  fetchJsonWithTimeout
});
const { llmHealth, llmSnapshot } = createLlmHealthStatus({
  config,
  fetchJsonWithTimeout,
  openAiCompatibleProviders: OPENAI_COMPATIBLE_PROVIDERS
});

const webMcpHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "tools=(self)"
};

const noStoreHeaders = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  "pragma": "no-cache",
  "expires": "0"
};

function responseHeaders(headers = {}) {
  return {
    ...webMcpHeaders,
    ...headers
  };
}

const lastSession = sessionStore.read();
trackMemory.record([
  ...(lastSession.result?.tracks || []),
  ...(lastSession.result?.alternates || [])
], Date.now(), { incrementSeen: false });

function getNetworkUrls() {
  const urls = [`http://localhost:${config.port}`];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${config.port}`);
      }
    }
  }
  return Array.from(new Set(urls));
}

function formatInternalHttpHost(host) {
  const value = String(host || "").trim();
  if (!value || value === "0.0.0.0" || value === "::") return "127.0.0.1";
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function cleanHeaderValue(value = "") {
  return String(Array.isArray(value) ? value[0] : value || "").split(",")[0].trim();
}

function requestOrigin(req) {
  const host = cleanHeaderValue(req.headers["x-forwarded-host"] || req.headers.host);
  if (!host || /[/?#]/.test(host)) return "";
  const forwardedProto = cleanHeaderValue(req.headers["x-forwarded-proto"]);
  const protocol = /^(https?|wss?)$/i.test(forwardedProto)
    ? forwardedProto.replace(/^ws/i, "http").toLowerCase()
    : (req.socket?.encrypted ? "https" : "http");
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return "";
  }
}

function tidalOAuthRedirectUriForRequest(req) {
  const origin = requestOrigin(req);
  return origin ? `${origin}/api/tidal/oauth/callback` : tidalProfileMixes.auth.redirectUri;
}

function sendJson(res, status, body) {
  const payload = body === undefined ? { ok: true } : body;
  res.writeHead(status, responseHeaders({
    ...noStoreHeaders,
    "content-type": "application/json; charset=utf-8"
  }));
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  res.writeHead(status, responseHeaders({
    ...noStoreHeaders,
    "content-type": "text/html; charset=utf-8"
  }));
  res.end(html);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function oauthPage({ title, message, details = "", error = false } = {}) {
  const safeTitle = escapeHtml(title || "TIDAL OAuth");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #05020b; color: #faf6ff; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(720px, calc(100vw - 32px)); padding: 28px; border: 1px solid rgba(217,179,255,.28); border-radius: 12px; background: rgba(13,6,25,.92); box-shadow: 0 24px 70px rgba(2,0,8,.72); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { margin: 0 0 16px; color: rgba(238,228,252,.84); line-height: 1.45; }
      code { display: block; padding: 12px; border-radius: 8px; background: rgba(0,0,0,.38); color: ${error ? "#ff9ab1" : "#8ff0ff"}; white-space: pre-wrap; overflow-wrap: anywhere; }
      a { display: inline-flex; align-items: center; min-height: 42px; padding: 0 14px; border-radius: 8px; border: 1px solid rgba(217,179,255,.32); color: #fff; text-decoration: none; background: rgba(53,27,94,.58); }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${escapeHtml(message || "")}</p>
      ${details ? `<code>${escapeHtml(details)}</code>` : ""}
      <p><a href="/">Return to Rabbit Hole</a></p>
    </main>
  </body>
</html>`;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function createArtBridgeProvider(bridgeConfig = {}) {
  if (/^(0|false|no)$/i.test(String(bridgeConfig.enabled))) return null;
  const cacheUrl = cleanHttpUrl(bridgeConfig.cacheUrl);
  if (!cacheUrl) return null;
  return {
    cachePublicUrl: async (sourceUrl, imageKey = "", track = {}) => cacheArtworkThroughBridge(sourceUrl, imageKey, track)
  };
}

async function cacheArtworkThroughBridge(sourceUrl, imageKey = "", track = {}) {
  const cleanSourceUrl = cleanArtworkUrl(sourceUrl);
  const cacheUrl = cleanHttpUrl(config.artBridge.cacheUrl);
  if (!config.artBridge.enabled || !cleanSourceUrl || !cacheUrl) return cleanSourceUrl;

  const artist = cleanRadioText(track.artist || track.inputArtist);
  const title = cleanRadioText(track.title || track.inputTitle);
  const key = cleanRadioText(imageKey) ||
    (artist || title ? `rabbit-hole:${normalizeRadioText(artist)}|${normalizeRadioText(title)}` : "");

  try {
    const { response, body } = await fetchJsonWithTimeout(cacheUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        sourceUrl: cleanSourceUrl,
        imageKey: key,
        artist,
        title
      })
    }, Math.max(300, Math.min(5000, Number(config.artBridge.timeoutMs || 1200))));

    const bridgedUrl = cleanArtworkUrl(body?.url);
    if (response.ok && bridgedUrl) return bridgedUrl;
  } catch (error) {
    console.warn(`Artwork bridge cache failed for ${new URL(cleanSourceUrl).hostname}: ${error.message}`);
  }

  return cleanSourceUrl;
}

function withHqplayerStatus(state) {
  const hqplayer = hqplayerStatus.getStatus();
  return {
    ...state,
    hqplayer,
    zones: (state.zones || []).map((zone) => ({
      ...zone,
      hqplayer: /hqplayer/i.test(zone.display_name || "") ? hqplayer : zone.hqplayer,
      outputs: (zone.outputs || []).map((output) => ({
        ...output,
        hqplayer: /hqplayer/i.test(`${zone.display_name || ""} ${output.display_name || ""}`) ? hqplayer : output.hqplayer
      }))
    }))
  };
}

function withTrackMemory(state) {
  return {
    ...state,
    zones: (state.zones || []).map((zone) => {
      const memoryTrack = trackMemory.find(summarizeZoneTrack(zone) || {});
      return memoryTrack ? { ...zone, memoryTrack } : zone;
    })
  };
}

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      const error = new Error("Request body too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON request body.");
    error.statusCode = 400;
    throw error;
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message || `Operation timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function lastFmHistoryForDiscovery() {
  const status = lastfm.status();
  if (!status.configured) {
    const reason = status.enabled === false
      ? "Last.fm lookup disabled"
      : (!status.apiKeyConfigured
        ? "LASTFM_API_KEY is missing"
        : (!status.usernameConfigured
          ? "LASTFM_USERNAME is missing"
          : "LASTFM_USERNAME does not look like a Last.fm username"));
    return { ...status, checked: false, reason };
  }
  try {
    return await withTimeout(
      lastfm.historySnapshot({
        limit: config.lastfm.historyLimit,
        topArtistLimit: config.lastfm.topArtistLimit,
        topArtistPeriod: config.lastfm.topArtistPeriod
      }),
      config.lastfm.timeoutMs,
      "Last.fm history check timed out."
    );
  } catch (error) {
    return {
      ...status,
      checked: false,
      error: error.message || "Last.fm history unavailable"
    };
  }
}

async function decorateRoonFirstResult(roonResult, options = {}) {
  return roonFirstDecorator.decorateRoonFirstResult(roonResult, options);
}

function decorateRoonFirstTimeoutFallback(roonResult = {}, options = {}, error = null) {
  return roonFirstDecorator.decorateRoonFirstTimeoutFallback(roonResult, options, error);
}

function appSnapshot() {
  return buildAppSnapshot({
    latestResultSource,
    latestBridgeSyncAlert,
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
    modelRouter
  });
}

function recordBridgeSyncAlert(result = {}) {
  const alert = bridgeSyncAlertFromResult(result, {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString()
  });
  if (!alert) return null;
  latestBridgeSyncAlert = alert;
  return latestBridgeSyncAlert;
}

function sessionSnapshot() {
  return buildSessionSnapshot({ sessionStore, syncFinalResultVerification, parseRequestedCount });
}

function feedbackTrackWithSessionContext(track = {}, rating = "") {
  return buildFeedbackTrackWithSessionContext(track, rating, { sessionStore, trackKey, ratingDelta });
}

function feedbackCalibrationContext(track = {}, request = {}) {
  return buildFeedbackCalibrationContext(track, request);
}

function eventPayload() {
  const baseState = withTrackMemory(withHqplayerStatus(roon.getState()));
  scheduleRadioEnrichment(baseState);
  const stateWithRadio = attachRadioEnrichment(baseState);
  scheduleMetadataEnrichment(stateWithRadio);
  const state = attachMetadataEnrichment(stateWithRadio);
  const addedPlays = listeningHistory.recordState(state);
  rememberMusicObservations(addedPlays, "now_playing", (track) => ({
    observedAt: track.playedAt,
    sourceEventId: `listening-history:play:${track.zoneId || "zone"}:${track.key}:${track.playedAt || Date.now()}`,
    context: track.zoneName,
    rawJson: track
  }));
  return {
    ...state,
    urls: getNetworkUrls(),
    app: appSnapshot()
  };
}

function broadcast() {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  const data = `data: ${JSON.stringify(eventPayload())}\n\n`;
  if (data === lastBroadcastData) return;
  lastBroadcastData = data;
  for (const client of clients) {
    try {
      client.write(data);
    } catch {
      clients.delete(client);
    }
  }
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast();
  }, STATE_UPDATE_DEBOUNCE_MS);
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  const relativePath = path.relative(publicDir, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, responseHeaders({
      ...noStoreHeaders,
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
    }));
    res.end(data);
  });
}

async function tidalMixesResponse({ force = false } = {}) {
  const result = await tidalProfileMixes.getMixes({ force });
  const pinnedItems = tidalPinnedMixes.list();
  const pinned = await tidalProfileMixes.getPinnedMixes(pinnedItems);
  return {
    ...result,
    pinnedItems,
    pinnedMixes: pinned.mixes,
    pinnedErrors: pinned.errors,
    pinnedCount: pinnedItems.length
  };
}

async function roonPlaylistsResponse({ includeTidal = false } = {}) {
  const roonResult = await roon.listPlaylists();
  const playlists = Array.isArray(roonResult.playlists) ? roonResult.playlists : [];
  if (includeTidal) {
    return {
      ...roonResult,
      playlists,
      count: playlists.length,
      totalRoonVisibleCount: playlists.length,
      hiddenTidalPlaylistCount: 0,
      playlistFilter: "all-roon-visible"
    };
  }

  try {
    const tidalResult = await tidalProfileMixes.getUserPlaylists();
    const tidalTitleKeys = new Set((tidalResult.playlists || [])
      .map((playlist) => normalizeMatchText(playlist.title))
      .filter(Boolean));
    if (!tidalResult.connected || !tidalTitleKeys.size) {
      return {
        ...roonResult,
        playlists,
        count: playlists.length,
        totalRoonVisibleCount: playlists.length,
        hiddenTidalPlaylistCount: 0,
        playlistFilter: "unfiltered",
        warning: tidalResult.error || tidalResult.warning || "TIDAL playlist comparison unavailable."
      };
    }

    const localPlaylists = playlists
      .filter((playlist) => !tidalTitleKeys.has(normalizeMatchText(playlist.title)))
      .map((playlist) => ({ ...playlist, source: "roon-local" }));
    return {
      ...roonResult,
      playlists: localPlaylists,
      count: localPlaylists.length,
      totalRoonVisibleCount: playlists.length,
      hiddenTidalPlaylistCount: playlists.length - localPlaylists.length,
      playlistFilter: "local-only-by-tidal-title"
    };
  } catch (error) {
    return {
      ...roonResult,
      playlists,
      count: playlists.length,
      totalRoonVisibleCount: playlists.length,
      hiddenTidalPlaylistCount: 0,
      playlistFilter: "unfiltered",
      warning: `TIDAL playlist comparison unavailable: ${error.message}`
    };
  }
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (pathname === "/api/events") {
    res.writeHead(200, responseHeaders({
      ...noStoreHeaders,
      "content-type": "text/event-stream",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    }));
    clients.add(res);
    res.write(`data: ${JSON.stringify(eventPayload())}\n\n`);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, EVENT_STREAM_HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/roon/image/")) {
    const imageKey = decodeURIComponent(pathname.slice("/api/roon/image/".length));
    const width = Math.max(64, Math.min(1200, Number(url.searchParams.get("width") || 320)));
    const height = Math.max(64, Math.min(1200, Number(url.searchParams.get("height") || width)));
    let image;
    try {
      image = await roon.getImage(imageKey, {
        width,
        height,
        scale: url.searchParams.get("scale") || "fill",
        format: "image/jpeg"
      });
    } catch (error) {
      const status = /HTTP 404\b/.test(error.message || "") ? 404 : 502;
      return sendJson(res, status, { error: error.message || "Roon image unavailable" });
    }

    res.writeHead(200, {
      "content-type": image.contentType,
      "cache-control": "private, max-age=86400"
    });
    res.end(image.data);
    return;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    return sendJson(res, 200, {
      ...eventPayload()
    });
  }

  if (req.method === "GET" && pathname === "/api/llm-status") {
    return sendJson(res, 200, await llmHealth());
  }

  if (req.method === "GET" && pathname === "/api/model/status") {
    if (url.searchParams.get("refresh") && modelRouter) {
      await modelRouter.refreshSynapseStatus({ timeoutMs: config.ai.openai.healthTimeoutMs });
    }
    return sendJson(res, 200, {
      local: await llmHealth(),
      ai: modelRouter ? modelRouter.status() : null
    });
  }

  if (req.method === "GET" && pathname === "/api/model/synapse/status") {
    return sendJson(res, 200, modelRouter
      ? await modelRouter.refreshSynapseStatus({ timeoutMs: config.ai.openai.healthTimeoutMs })
      : { connected: false, state: "not_configured", lastError: "Model router is not initialized." });
  }

  if (req.method === "GET" && pathname === "/api/pc-monitor") {
    return sendJson(res, 200, await pcMonitorSnapshot());
  }

  if (req.method === "GET" && pathname === "/api/tidal/oauth/start") {
    try {
      const redirectUri = tidalOAuthRedirectUriForRequest(req);
      const authorizeUrl = tidalProfileMixes.auth.createAuthorizationUrl({ redirectUri });
      res.writeHead(302, { location: authorizeUrl });
      res.end();
      return;
    } catch (error) {
      return sendHtml(res, 400, oauthPage({
        title: "TIDAL authorization not ready",
        message: "Rabbit Hole could not start the TIDAL login flow.",
        details: error.message,
        error: true
      }));
    }
  }

  if (req.method === "GET" && pathname === "/api/tidal/oauth/callback") {
    const callbackError = url.searchParams.get("error");
    const callbackDescription = url.searchParams.get("error_description");
    if (callbackError) {
      return sendHtml(res, 400, oauthPage({
        title: "TIDAL authorization failed",
        message: "TIDAL returned an error before Rabbit Hole could receive a profile token.",
        details: [callbackError, callbackDescription].filter(Boolean).join(": "),
        error: true
      }));
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return sendHtml(res, 200, oauthPage({
        title: "Connect TIDAL Profile",
        message: "Open the authorization start URL below. After you approve Rabbit Hole in TIDAL, this callback will save a refreshable profile token locally.",
        details: `${requestOrigin(req) || getNetworkUrls()[0]}/api/tidal/oauth/start`
      }));
    }

    try {
      const token = await tidalProfileMixes.auth.exchangeAuthorizationCode({
        code,
        state: url.searchParams.get("state")
      });
      if (tidalProfileMixes.cache) tidalProfileMixes.cache = null;
      return sendHtml(res, 200, oauthPage({
        title: "TIDAL profile connected",
        message: "Rabbit Hole saved a local profile token and refresh token. You can return to the TIDAL Mixes tab now.",
        details: [
          token.scope ? `Scopes: ${token.scope}` : "",
          token.expiresAtMs ? `Access token expires: ${new Date(Number(token.expiresAtMs)).toLocaleString()}` : "",
          token.refreshToken ? "Refresh token: saved locally" : "Refresh token: not returned by TIDAL"
        ].filter(Boolean).join("\n")
      }));
    } catch (error) {
      return sendHtml(res, 400, oauthPage({
        title: "TIDAL token exchange failed",
        message: "Rabbit Hole received the callback, but could not exchange it for a profile token.",
        details: error.message,
        error: true
      }));
    }
  }

  if (req.method === "GET" && pathname === "/api/tidal/oauth/status") {
    return sendJson(res, 200, tidalProfileMixes.auth.status());
  }

  if (req.method === "GET" && pathname === "/api/history-report") {
    const baseState = withHqplayerStatus(roon.getState());
    scheduleRadioEnrichment(baseState);
    const state = attachRadioEnrichment(baseState);
    const addedPlays = listeningHistory.recordState(state);
    rememberMusicObservations(addedPlays, "now_playing", (track) => ({
      observedAt: track.playedAt,
      sourceEventId: `listening-history:play:${track.zoneId || "zone"}:${track.key}:${track.playedAt || Date.now()}`,
      context: track.zoneName,
      rawJson: track
    }));
    return sendJson(res, 200, listeningHistory.report({
      roonState: state,
      tasteProfile,
      discoveryHistory,
      trackMemory
    }));
  }

  if (req.method === "GET" && pathname === "/api/roon/playlists") {
    return sendJson(res, 200, await roonPlaylistsResponse({
      includeTidal: /^(1|true|yes)$/i.test(String(url.searchParams.get("includeTidal") || url.searchParams.get("all") || ""))
    }));
  }

  if (req.method === "GET" && pathname === "/api/roon/radio") {
    return sendJson(res, 200, await roon.listRadioStations(url.searchParams.get("zoneId") || "", {
      refresh: /^(1|true|yes)$/i.test(String(url.searchParams.get("refresh") || "")),
      itemKey: url.searchParams.get("itemKey") || "",
      hierarchy: url.searchParams.get("hierarchy") || "",
      session: url.searchParams.get("session") || "",
      count: Number(url.searchParams.get("count") || 300)
    }));
  }

  if (req.method === "GET" && pathname === "/api/session") {
    return sendJson(res, 200, sessionSnapshot());
  }

  if (req.method === "GET" && pathname === "/api/taste") {
    return sendJson(res, 200, tasteProfile.summary());
  }

  if (req.method === "GET" && pathname === "/api/memory") {
    return sendJson(res, 200, trackMemory.summary());
  }

  if (req.method === "GET" && pathname === "/api/music-memory/search") {
    return sendJson(res, 200, musicMemory?.searchTracks?.({
      q: url.searchParams.get("q") || "",
      beatport: url.searchParams.get("beatport") || "",
      feedback: url.searchParams.get("feedback") || "",
      provider: url.searchParams.get("provider") || "",
      limit: url.searchParams.get("limit") || 50,
      offset: url.searchParams.get("offset") || 0
    }) || { enabled: false, tracks: [], total: 0 });
  }

  if (req.method === "GET" && pathname === "/api/query-yield") {
    return sendJson(res, 200, queryYieldTracker.summary());
  }

  if (req.method === "GET" && pathname === "/api/standby") {
    return sendJson(res, 200, standbyFreshSummary());
  }

  if (req.method === "GET" && pathname === "/api/lastfm/status") {
    const snapshot = await lastFmHistoryForDiscovery();
    return sendJson(res, 200, {
      ...lastfm.status(),
      checked: Boolean(snapshot.checked),
      returned: Number(snapshot.returned || 0),
      topArtistPeriod: snapshot.topArtistPeriod || "",
      topArtistsReturned: Number(snapshot.topArtistsReturned || 0),
      topArtistsError: snapshot.topArtistsError || "",
      error: snapshot.error || snapshot.reason || ""
    });
  }

  if (req.method === "GET" && pathname === "/api/tidal/mixes") {
    return sendJson(res, 200, await tidalMixesResponse({
      force: /^(1|true|yes)$/i.test(String(url.searchParams.get("refresh") || ""))
    }));
  }

  if (req.method === "GET" && pathname === "/api/tidal/playlists") {
    return sendJson(res, 200, await tidalProfileMixes.getUserPlaylists({
      force: /^(1|true|yes)$/i.test(String(url.searchParams.get("refresh") || ""))
    }));
  }

  if (req.method === "GET" && pathname === "/api/tidal/pinned-mixes") {
    return sendJson(res, 200, await tidalMixesResponse({ force: true }));
  }

  if (req.method === "DELETE" && pathname === "/api/tidal/pinned-mixes") {
    const body = await readJson(req);
    tidalPinnedMixes.remove(body.key || body.id || "");
    return sendJson(res, 200, await tidalMixesResponse({ force: true }));
  }

  if (req.method === "DELETE" && pathname === "/api/tidal/playlist") {
    const body = await readJson(req);
    return sendJson(res, 200, await tidalProfileMixes.deletePlaylist(body.playlistId || body.playlist_id || body.id || "", {
      title: body.title || body.name || ""
    }));
  }

  if (req.method === "DELETE" && pathname === "/api/roon/playlist") {
    const body = await readJson(req);
    const result = await roon.deletePlaylist(body.itemKey || body.item_key || body.id || "", body.title || body.name || "", {
      zoneId: body.zoneId || body.zone_id || ""
    });
    if (result.deleted) scheduleBroadcast();
    return sendJson(res, 200, result);
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  let body = await readJson(req);
  if (pathname === "/api/model/mode") {
    if (!modelRouter) return sendJson(res, 503, { error: "Model router is not initialized." });
    if (body.mode) modelRouter.setMode(body.mode);
    if (body.tier) modelRouter.setSynapseTier(body.tier);
    if (body.model) modelRouter.setOpenAiModel(body.model, body.tier || body.mode || "");
    if (body.refreshSynapse) await modelRouter.refreshSynapseStatus({ timeoutMs: config.ai.openai.healthTimeoutMs });
    scheduleBroadcast();
    return sendJson(res, 200, {
      local: await llmHealth(),
      ai: modelRouter.status()
    });
  }
  if (pathname === "/api/memory/synapse") return sendJson(res,200,{...memory.stats(),...memory.read()});
  if (pathname === "/api/memory/synapse/save") return sendJson(res,200,memory.upsert(body));
  if (pathname === "/api/memory/synapse/forget") return sendJson(res,200,memory.forget(body.id));
  if (pathname === "/api/memory/synapse/import") return sendJson(res,200,{imported:memory.import(body.content).length});
  if (pathname === "/api/memory/synapse/context") return sendJson(res,200,{entries:memory.retrieve(body.query||""),context:memory.context(body.query||"")});
  if (pathname === "/api/model/chat") {
    if (!modelRouter) return sendJson(res, 503, { error: "Model router is not initialized." });
    const message = String(body.message || body.prompt || "").trim();
    if (!message) return sendJson(res, 400, { error: "Message is required." });
    const result = await modelRouter.respond({
      message,
      mode: body.mode || "",
      tier: body.tier || "",
      model: body.model || ""
    });
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/tracks/verify" || pathname === "/api/tracks/verify-exact") {
    return sendJson(res, 200, await runExactVerification(body));
  }
  if (pathname === "/api/tracks/verified") {
    return sendJson(res, 200, lastExactVerification || { mode: "exact_track_verification", tracks: [], usable: [] });
  }
  if (pathname === "/api/tracks/verified/resolve-roon") {
    const result = await resolveVerifiedTracksForRoon(lastExactVerification, body, {
      roon, logger: entry => console.log("[exact-roon]", JSON.stringify(entry)),
      bridge: exactRoonBridge,
      save: result => { if (lastExactVerification === result) exactVerificationStore.save(result); }
    });
    recordBridgeSyncAlert(result);
    latestResultSource = "exact_verification";
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/roon/exact-bridge/pending") {
    return sendJson(res, 200, exactRoonBridge.listPending());
  }
  if (pathname === "/api/roon/exact-bridge/pending/retry") {
    if (!body.zoneId) {
      body.zoneId = defaultRoonZoneId();
    }
    const result = await exactRoonBridge.retryPending(body);
    recordBridgeSyncAlert(result);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/tracks/verified/queue" || pathname === "/api/tracks/verified/playlist") {
    const tracks = (lastExactVerification?.usable || []).slice(0, Math.max(1, Math.min(40, Number(body.count || 40))));
    if (!tracks.length) return sendJson(res, 400, { error: "No exact verified tracks. Run verify_tracks first." });
    if (pathname.endsWith("/queue")) {
      const result = await queueExactTracks(lastExactVerification, body, roon, {
        bridge: exactRoonBridge,
        save: result => { if (lastExactVerification === result) exactVerificationStore.save(result); }
      });
      recordBridgeSyncAlert(result);
      latestResultSource = "exact_verification";
      scheduleBroadcast();
      return sendJson(res, 200, result);
    }
    return sendJson(res, 200, await tidalProfileMixes.createQueuePlaylist(tracks, { title: body.title || "Rabbit Hole Verified Tracks", description: body.description || "Exact verified tracks" }));
  }
  if (pathname === "/api/standby/refresh") {
    latestResultSource = "standby";
    return sendJson(res, 200, await refreshStandbyPool({
      force: true,
      reason: standbyCleanText(body.reason || "manual") || "manual",
      options: body.options || body
    }));
  }
  if (pathname === "/api/standby/clear") {
    const summary = standbyStore.clear();
    scheduleBroadcast();
    return sendJson(res, 200, summary);
  }
  if (pathname === "/api/standby/remove") {
    const summary = standbyStore.remove(Array.isArray(body.keys) ? body.keys : [body.key]);
    scheduleBroadcast();
    return sendJson(res, 200, summary);
  }
  if (pathname === "/api/tidal/pinned-mixes") {
    tidalPinnedMixes.add(body.url || body.input || body.value || "");
    return sendJson(res, 200, await tidalMixesResponse({ force: true }));
  }
  if (pathname === "/api/control") {
    const result = await roon.control(body.zoneId, body.control);
    scheduleBroadcast();
    return sendJson(res, 200, { ok: true, result: result || null });
  }
  if (pathname === "/api/roon/radio/play") {
    const result = await roon.playRadioStation(body.itemKey || body.id || body.stationId, body.zoneId, {
      hierarchy: body.hierarchy || "",
      session: body.session || "",
      title: body.title || "",
      subtitle: body.subtitle || ""
    });
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/seek") {
    const result = await roon.seek(body.zoneId, body.seconds);
    scheduleBroadcast();
    return sendJson(res, 200, { ok: true, result: result || null });
  }
  if (pathname === "/api/settings") {
    return sendJson(res, 200, await roon.changeSettings(body.zoneId, body.settings || {}));
  }
  if (pathname === "/api/volume") {
    return sendJson(res, 200, await roon.changeVolume(body.outputId, body.how || "relative_step", Number(body.value || 0)));
  }
  if (pathname === "/api/ai/playlist") {
    const intent = exactIntent(body);
    if (intent) return sendJson(res, 200, await runExactVerification({ ...body, tracks: intent.tracks }));
    body = withNormalizedYearFilter(body);
    body.scoringMode = normalizeScoringMode(body);
    body = genreProfileStore.augmentOptions(body);
    const originalRequestedCount = parseRequestedCount(body);
    const requestedCount = effectiveDiscoveryCount(body, buildDiscoveryProfile(body));
    const effectiveBody = {
      ...body,
      effectiveCount: requestedCount,
      originalRequestedCount
    };
    const yearRange = yearRangeUtil.parseYearRange(effectiveBody);
    const strictFilteredRequest = Boolean(yearRange || minimumScoreFor(effectiveBody));
    const catalogSearchMode = shouldSkipModelForCatalogSearch(effectiveBody);
    const strictRoonRequested = isStrictRoonQueueMode(effectiveBody);
    const budgets = strictSearchBudgets(effectiveBody, requestedCount);
    let roonFirst = { tracks: [], alternates: [], discarded: [], verification: {} };
    const lastFmHistoryPromise = lastFmHistoryForDiscovery();
    let roonFirstError = "";
    let modelResult = null;
    let modelError = "";
    let modelSkipped = "";

    if (catalogSearchMode) {
      modelSkipped = strictRoonRequested
        ? "Catalog-style search; using deterministic TIDAL/Roon discovery for planning, then model review on verified candidates."
        : "Catalog-style search; using deterministic TIDAL discovery for planning, then model review on playback-bridge candidates.";
      modelResult = { plan: null };
    } else {
      try {
        modelResult = await withTimeout(
          modelRouter
            ? modelRouter.generateSearchPlan(
              effectiveBody,
              (planOptions, planTimeoutMs) => generateSearchPlan(config, planOptions, planTimeoutMs),
              budgets.modelTimeoutMs
            )
            : generateSearchPlan(config, effectiveBody, budgets.modelTimeoutMs),
          budgets.modelTimeoutMs,
          "The local model took too long to answer."
        );
      } catch (error) {
        modelError = error.message;
        modelResult = { plan: null };
      }
    }

    let searchBody = {
      ...effectiveBody,
      llmSearchPlan: modelResult?.plan || null,
      llmCandidates: []
    };
    searchBody = genreProfileStore.augmentOptions(searchBody);
    let searchProfile = buildDiscoveryProfile(searchBody);
    const strictRoonMode = strictRoonRequested || isStrictRoonQueueMode(searchBody);
    if (!strictRoonMode) {
      searchBody = {
        ...searchBody,
        requireRoonQueueable: ""
      };
    }

    if (normalizeScoringMode(searchBody) !== "pure") {
      searchBody = await withSimilarArtistSeeds(searchBody, requestedCount);
      searchProfile = buildDiscoveryProfile(searchBody);
    }

    const releaseVerificationRequired = releaseFilterRequiresVerification(searchBody, yearRangeUtil.parseYearRange(searchBody));
    const runRoonPreflight = body.zoneId && strictRoonMode && !releaseVerificationRequired;

    if (runRoonPreflight) {
      const roonPreflight = await runFreshRoonRescue(
        {
          requestedCount,
          tracks: [],
          alternates: [],
          discarded: [],
          verification: {
            requested: requestedCount,
            strategy: "roon-first-preflight"
          }
        },
        searchBody,
        requestedCount,
        {
          ...budgets,
          roonFirstTimeoutMs: Math.max(30_000, Number(budgets.roonFirstTimeoutMs || 0))
        },
        "Strict queueable search preflight."
      );
      const preflightTracks = Array.isArray(roonPreflight.tracks) ? roonPreflight.tracks.length : 0;
      const tidalCircuitState = tidal.status()?.circuit?.state || "";
      const tidalUnhealthy = ["open", "half-open"].includes(tidalCircuitState);
      const enough = roonFirstResultIsEnough(roonPreflight, requestedCount);
      roonPreflight.verification = {
        ...(roonPreflight.verification || {}),
        strategy: "roon-first-preflight",
        tidalSkipped: Boolean(enough || tidalUnhealthy),
        tidalSkippedReason: tidalUnhealthy
          ? `TIDAL circuit is ${tidalCircuitState}; using Roon-first result.`
          : (enough
            ? "Roon-first preflight found enough queueable tracks."
            : "Roon-first preflight was incomplete; continuing with wider TIDAL catalogue discovery and Roon verification."),
        intent: searchProfile.intent,
        scoringMode: searchProfile.scoringMode,
        similarArtistExpansion: searchBody.similarArtistExpansion || null
      };
      if (enough || tidalUnhealthy) {
        const guardedPreflight = syncFinalResultVerification(
          suppressPreviouslySuggestedResultTracks(roonPreflight, searchBody),
          requestedCount
        );
        voiceExecution.check();
        discoveryHistory.record(guardedPreflight.tracks || []);
        trackMemory.record([...(guardedPreflight.tracks || []), ...(guardedPreflight.alternates || [])]);
        sessionStore.save(body, guardedPreflight);
        latestResultSource = "discovery";
        scheduleBroadcast();
        return sendJson(res, 200, guardedPreflight);
      }
      roonFirst = roonPreflight;
      roonFirstError = `Roon-first preflight kept ${preflightTracks}; continuing to TIDAL catalogue expansion.`;
    } else if (body.zoneId && strictRoonMode && releaseVerificationRequired) {
      roonFirstError = "Roon-first preflight skipped because the release date/year filter requires TIDAL release verification first.";
    }

    if (!roonFirstError) {
      roonFirstError = strictRoonMode
        ? (body.zoneId
          ? "Roon-first discovery disabled. TIDAL generates candidates; Roon verifies queueability after scoring."
          : "No Roon output zone selected. Roon verification requires a zone.")
        : "Strict Roon verification skipped. TIDAL generates candidates; Send to TIDAL creates the playable bridge playlist.";
    }

    const scrobbleHistory = await lastFmHistoryPromise;
    let discovered = null;
    try {
      discovered = await withTimeout(
        discoverTracks({
          tidal,
          options: {
            ...searchBody,
            discoveryRuntimeMs: Math.max(8_000, Number(budgets.discoveryTimeoutMs || 30_000) - 4_000)
          },
          history: discoveryHistory,
          tasteProfile,
          scrobbleHistory,
          queryYieldTracker
        }),
        budgets.discoveryTimeoutMs,
        "TIDAL discovery took too long."
      );
    } catch (error) {
      discovered = {
        requestedCount,
        tracks: [],
        alternates: [],
        discarded: [],
        verification: {
          requested: requestedCount,
          generated: (roonFirst.tracks || []).length + (roonFirst.discarded || []).length,
          kept: 0,
          discarded: (roonFirst.discarded || []).length,
          discoveryError: error.message,
          intent: searchProfile.intent,
          scoringMode: searchProfile.scoringMode,
          lastfm: {
            enabled: scrobbleHistory?.enabled !== false,
            configured: Boolean(scrobbleHistory?.configured),
            apiKeyConfigured: Boolean(scrobbleHistory?.apiKeyConfigured),
            usernameConfigured: Boolean(scrobbleHistory?.usernameConfigured),
            checked: Boolean(scrobbleHistory?.checked),
            returned: Number(scrobbleHistory?.returned || 0),
            topArtistPeriod: scrobbleHistory?.topArtistPeriod || "",
            topArtistsReturned: Number(scrobbleHistory?.topArtistsReturned || 0),
            topArtistsError: scrobbleHistory?.topArtistsError || "",
            error: scrobbleHistory?.error || scrobbleHistory?.reason || ""
          },
          queryYield: {
            enabled: true,
            attempted: 0,
            returned: 0,
            accepted: 0,
            rejected: 0,
            seoRejects: 0,
            genreRejects: 0,
            errorCount: 1,
            recordCount: 0,
            adjustments: [],
            best: [],
            worst: [],
            error: error.message
          }
        }
      };
    }
    discovered.tracks = mergeTrackLists(roonFirst.tracks, discovered.tracks);
    discovered.alternates = mergeTrackLists(roonFirst.alternates, discovered.alternates);
    discovered.discarded = [...(roonFirst.discarded || []), ...(discovered.discarded || [])];
    discovered.verification = {
      ...(discovered.verification || {}),
      modelCandidateCount: 0,
      modelPlanQueryCount: modelResult?.plan?.searchQueries?.length || 0,
      modelPlan: modelResult?.plan || null,
      modelError,
      modelProvider: modelResult?.routing?.provider || config.llmProvider,
      modelName: modelResult?.routing?.model || (config.llmProvider === "openrouter"
        ? config.openRouterModel
        : (OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider)
          ? config.openAiCompatibleModel
          : config.ollamaModel)),
      modelRouting: modelResult?.routing || null,
      modelSkipped,
      roonFirstKept: roonFirst.tracks.length,
      roonFirstError,
      roonFirstSearches: roonFirst.verification?.searches || 0,
      roonFirstCandidates: roonFirst.verification?.candidates || 0,
      roonFirstSearchSummaries: roonFirst.verification?.searchSummaries || [],
      roonFirstDiscarded: roonFirst.discarded?.length || 0,
      roonFirstDefault: false,
      tidalDirectFallback: false,
      strategy: strictRoonMode ? "tidal-catalog-first-roon-verified" : "tidal-catalog-playlist-bridge"
    };
    discovered = await runAutoBroadenSearches(
      discovered,
      searchBody,
      searchProfile,
      requestedCount,
      scrobbleHistory,
      budgets
    );
    let modelCandidateReview = { enabled: false, scored: 0, rejected: 0, error: "" };
    try {
      const reviewed = await applyModelCandidateReview(discovered, searchBody);
      discovered = reviewed.result;
      modelCandidateReview = reviewed.review;
      if (modelError && !modelCandidateReview.error) {
        modelCandidateReview.planningError = modelError;
      }
    } catch (error) {
      modelCandidateReview = {
        enabled: false,
        scored: 0,
        rejected: 0,
        error: error.message,
        planningError: modelError || ""
      };
    }
    discovered.verification = {
      ...(discovered.verification || {}),
      modelCandidateReview
    };
    discovered = rebalanceDiscoveryResult(discovered, searchBody, searchProfile, requestedCount);
    discovered = syncFinalResultVerification(discovered, requestedCount);
    let result = null;
    if (strictRoonMode) {
      try {
        result = await withTimeout(
          filterForRoonQueueable(discovered, body.zoneId, searchBody),
          budgets.roonQueueTimeoutMs,
          "Roon queue verification took too long."
        );
      } catch (error) {
        result = roonVerificationTimeoutFallback(discovered, requestedCount, error);
      }
    } else {
      result = tidalPlaylistBridgeResult(discovered, requestedCount);
    }
    result = syncFinalResultVerification(result, requestedCount);
    if (strictRoonMode && shouldRunRoonFirstRescue(result)) {
      result = await runFreshRoonRescue(
        result,
        searchBody,
        requestedCount,
        budgets,
        result.verification?.discoveryError || result.verification?.roonVerificationError || "TIDAL-first path returned no queueable tracks."
      );
      result = syncFinalResultVerification(result, requestedCount);
    }
    result = syncFinalResultVerification(
      suppressPreviouslySuggestedResultTracks(result, searchBody),
      requestedCount
    );
    voiceExecution.check();
    discoveryHistory.record(result.tracks || []);
    trackMemory.record([...(result.tracks || []), ...(result.alternates || [])]);
    rememberMusicObservations(result.tracks || [], "discovery_result");
    sessionStore.save(body, result);
    latestResultSource = "discovery";
    recordBridgeSyncAlert(result);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/rabbit-hole") {
    const graph = await rabbitHoleGraph.build(body.track || {}, {
      config,
      tidal,
      discoveryHistory,
      trackMemory,
      tasteProfile,
      contextTracks: body.contextTracks || []
    }, {
      force: Boolean(body.force)
    });
    return sendJson(res, 200, graph);
  }
  if (pathname === "/api/feedback") {
    const rating = normalizeRating(body.rating);
    const feedbackTrack = feedbackTrackWithSessionContext(body.track || {}, rating);
    const result = recordFeedbackAcrossStores({
      rating,
      track: feedbackTrack,
      calibrationContext: feedbackCalibrationContext(feedbackTrack, body),
      tasteProfile,
      genreProfileStore,
      sessionStore,
      trackMemory
    });
    rememberMusicObservations(feedbackTrack, `feedback:${rating || "unknown"}`);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/roon/playlist-tracks") {
    return sendJson(res, 200, await roon.loadPlaylistTracks(body.itemKey, body.title));
  }
  if (pathname === "/api/tidal/mix-tracks") {
    const artistRadioId = body.artistRadioArtistId || body.artist_radio_artist_id || "";
    if (/^(1|true|yes)$/i.test(String(body.freshArtistRadio || body.fresh_artist_radio || "")) && artistRadioId) {
      return sendJson(res, 200, await tidalProfileMixes.getFreshArtistRadioTracks(artistRadioId, {
        limit: body.limit || 20,
        excludeTracks: Array.isArray(body.excludeTracks) ? body.excludeTracks : []
      }));
    }
    return sendJson(res, 200, await tidalProfileMixes.getMixTracks(body.mixId || body.id || "", {
      limit: body.limit || 50,
      excludeTracks: Array.isArray(body.excludeTracks) ? body.excludeTracks : []
    }));
  }
  if (pathname === "/api/tidal/playlist-tracks") {
    return sendJson(res, 200, await tidalProfileMixes.getMixTracks(body.playlistId || body.playlist_id || body.mixId || body.id || "", {
      limit: body.limit || 50,
      excludeTracks: Array.isArray(body.excludeTracks) ? body.excludeTracks : []
    }));
  }
  if (pathname === "/api/tidal/queue-playlist") {
    return sendJson(res, 200, await tidalProfileMixes.createQueuePlaylist(body.tracks || [], {
      title: body.title || "",
      description: body.description || ""
    }));
  }
  if (pathname === "/api/tidal/playlist") {
    const playlist = await tidalProfileMixes.createPlaylist({
      title: body.title || body.name || "",
      description: body.description || ""
    });
    return sendJson(res, 200, {
      connected: true,
      playlist
    });
  }
  if (pathname === "/api/tidal/track-quality") {
    return sendJson(res, 200, await resolveCurrentTrackQuality(body.track || {}));
  }
  if (pathname === "/api/tidal/playlist-track") {
    const resolved = await resolveTidalTrackForPlaylist(body.track || {});
    const result = await tidalProfileMixes.addTrackToPlaylist(body.playlistId || body.playlist_id || "", resolved.track, {
      playlistTitle: body.playlistTitle || body.playlist_title || "",
      allowDuplicate: booleanFlag(body.allowDuplicate || body.allow_duplicate),
      checkDuplicate: body.checkDuplicate === undefined && body.check_duplicate === undefined
        ? true
        : booleanFlag(body.checkDuplicate || body.check_duplicate)
    });
    return sendJson(res, 200, {
      ...result,
      resolvedBy: resolved.resolvedBy,
      track: {
        ...(result.track || {}),
        title: resolved.track.title || result.track?.title || "",
        artist: resolved.track.artist || result.track?.artist || "",
        tidalUrl: resolved.track.tidal?.tidalUrl || resolved.track.tidalUrl || ""
      }
    });
  }
  if (pathname === "/api/roon/search") {
    return sendJson(res, 200, await roon.search(body.track, body.zoneId));
  }
  if (pathname === "/api/roon/play-search-match") {
    return sendJson(res, 200, await roon.playSearchMatch(body.track, body.zoneId));
  }
  if (pathname === "/api/roon/queue-check") {
    const primary = Array.isArray(body.tracks) ? body.tracks.slice(0, 50) : [];
    const alternates = Array.isArray(body.alternates) ? body.alternates.slice(0, 50) : [];
    const targetCount = Math.min(50, Math.max(1, Number(body.targetCount || primary.length || 0)));
    const roonSearchOptions = {
      preferExtendedMixes: booleanFlag(body.preferExtendedMixes || body.prefer_extended_mixes)
    };
    const tracks = [...primary.map((track) => ({ track, isAlternate: false })), ...alternates.map((track) => ({ track, isAlternate: true }))];
    const queueable = [];
    const failed = [];

    for (const [index, request] of tracks.entries()) {
      if (queueable.length >= targetCount) break;
      const { track, isAlternate } = request;
      try {
        const result = await roon.canQueueTrack(track, body.zoneId, roonSearchOptions);
        if (result.success) {
          queueable.push({
            index,
            track,
            isAlternate,
            action: result.action || "",
            match: roonMatchSummary(result.match),
            resolutionMethod: result.resolutionMethod || '', albumFallback: result.albumFallback || null
          });
        } else {
          failed.push({
            index,
            track,
            isAlternate,
            reason: result.reason || "No usable queue action.",
            resolutionMethod: result.resolutionMethod || '', albumFallback: result.albumFallback || null,
            match: roonMatchSummary(result.match),
            actions: result.actions || []
          });
        }
      } catch (error) {
        failed.push({ index, track, reason: error.message });
      }
    }

    return sendJson(res, 200, {
      requested: targetCount,
      attemptedCount: queueable.length + failed.length,
      primaryCount: primary.length,
      alternateCount: alternates.length,
      queueableCount: queueable.length,
      failedCount: failed.length,
      queueable,
      failed
    });
  }
  if (pathname === "/api/tracks/supplied/queue") {
    const result = await externalTrackQueue.queue(body);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/roon/direct/queue" || pathname === "/api/roon/direct/search") {
    if (!body.zoneId) {
      body.zoneId = defaultRoonZoneId();
    }
    const result = pathname.endsWith('/search') ? await directRoonQueue.search(body) : await directRoonQueue.queue(body);
    recordBridgeSyncAlert(result);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/roon/queue-tracks") {
    const result = await roon.queueTracks(body.tracks || [], body.zoneId, {
      mode: body.mode || "append",
      alternates: body.alternates || [],
      targetCount: body.targetCount,
      preferExtendedMixes: booleanFlag(body.preferExtendedMixes || body.prefer_extended_mixes),
      matchPolicy: body.matchPolicy || (booleanFlag(body.allowBridge) ? "strict" : ""),
      allowBridge: booleanFlag(body.allowBridge),
      bridgeSyncDelaysMs: body.bridgeSyncDelaysMs,
      bridgeLookupTimeoutMs: body.bridgeLookupTimeoutMs
    });
    try {
      queueAttemptStore.record({ request: body, result, source: req.headers["x-rabbit-hole-caller"] || "" });
    } catch (error) {
      console.error("[queue-attempts] Persistence failed:", error.message);
    }
    if (Array.isArray(result.failed) && result.failed.length) {
      try {
        standbyStore.retainQueueFailures(result.failed, { source: body.source || req.headers["x-rabbit-hole-caller"] || "queue-tracks" });
      } catch (error) {
        console.error("[standby-queue-failures] Persistence failed:", error.message);
      }
    }
    recordBridgeSyncAlert(result);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/memory/purge") {
    const result = trackMemory.purge();
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

const rabbitHoleMcpBaseUrl = process.env.RABBIT_HOLE_MCP_BASE_URL || `http://${formatInternalHttpHost(config.host)}:${config.port}`;
const rabbitHoleMcpTools = createRabbitHoleMcpTools({
  baseUrl: rabbitHoleMcpBaseUrl,
  timeoutMs: process.env.RABBIT_HOLE_MCP_TIMEOUT_MS || 120_000
});

memory.refreshSources = () => {
  const profile=tasteProfile.read();
  const signals=Object.values(profile.artists||{}).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)).slice(0,20);
  const labels=Object.values(profile.labels||{}).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)).slice(0,10);
  if(signals.length||labels.length) memory.sync("rabbit_hole_taste", "Learned music taste (positive score = liked, negative = disliked): artists "+signals.map(e=>`${e.name}: ${e.score}`).join(", ")+". Labels: "+labels.map(e=>`${e.name}: ${e.score}`).join(", "),"user_preferences");
  const history=standbyStore.read().standbyHistory||[];
  if(history.length) memory.sync("rabbit_hole_standby", "Recent standby music exposure: "+history.slice(-3).flatMap(h=>h.tracks.slice(0,8).map(t=>`${t.artist} — ${t.title} (rank ${t.rank})`)).join("; ").slice(0,3500));
};
memory.refreshSources();
modelRouter = createModelRouter({
  memory,
  config,
  tools: rabbitHoleMcpTools,
  logger: console
});

const handleMcpHttp = createRabbitHoleMcpHttpHandler({
  baseUrl: rabbitHoleMcpBaseUrl,
  token: process.env.RABBIT_HOLE_MCP_TOKEN || "",
  serverVersion: require("../package.json").version,
  tools: rabbitHoleMcpTools
});

const handleVoice = createVoiceApi({ tools: rabbitHoleMcpTools, router: modelRouter,
  availability: () => ({ synapseAvailable: Boolean(config.ai.openai.enabled && config.ai.openai.apiKey), localAvailable: Boolean(config.openAiCompatibleBaseUrl || config.ollamaBaseUrl) }) });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/voice/")) {
      await handleVoice(req, res, url);
    } else if (["/mcp", "/mcp/", "/rabbitholemcp/mcp", "/rabbitholemcp/mcp/"].includes(url.pathname)) {
      await handleMcpHttp(req, res, url);
    } else if (url.pathname.startsWith("/api/")) {
      const voiceContext = voiceExecution.fromHeader(req.headers["x-rabbit-hole-voice-execution"]);
      await voiceExecution.run(voiceContext, async () => { voiceExecution.check(); await handleApi(req, res, url); });
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    const status = Number(error?.statusCode || error?.status || 500);
    sendJson(res, status >= 400 && status < 600 ? status : 500, { error: error.message || "Server error" });
  }
});

roon.on("zones", () => {
  hqplayerStatus.start();
  scheduleBroadcast();
});
roon.start();

server.listen(config.port, config.host, () => {
  console.log(`The Rabbit Hole is running at http://localhost:${config.port}`);
  for (const url of getNetworkUrls().filter((candidate) => !candidate.includes("localhost"))) {
    console.log(`Phone/LAN URL: ${url}`);
  }
  console.log("Enable the extension in Roon Settings > Extensions if prompted.");
  scheduleStandbyRefresh(45_000);
  scheduleBeatportMemoryBackfill();
});
