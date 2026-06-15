"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const config = require("./config");
const {
  candidateIdentityKeys,
  buildDiscoveryProfile,
  autoBroadenSearchPasses,
  discoverTracks,
  discoveryStatusFor,
  effectiveDiscoveryCount,
  minimumScoreFor,
  minimumScoreLabel,
  nearYearFallbackOptions,
  normalizeScoringMode,
  parseRequestedCount,
  reasonFor,
  rejectReason,
  scoreBreakdownFor,
  whyBulletsFor
} = require("./discoveryEngine");
const { DiscoveryHistory } = require("./discoveryHistory");
const { ListeningHistory } = require("./listeningHistory");
const { generateSearchPlan, scoreCandidateBatch } = require("./llmClient");
const { LastFmClient } = require("./lastFmClient");
const {
  createModelReviewAudit,
  classifyModelReviewChange,
  modelReviewAuditItem,
  recordModelReviewAudit
} = require("./modelReviewAudit");
const { QueryYieldTracker } = require("./queryYieldTracker");
const { HQPlayerStatus } = require("./hqplayerStatus");
const { RoonClient } = require("./roonClient");
const { RabbitHoleGraph } = require("./rabbitHoleGraph");
const { RadioMetadataResolver, parseRadioTrack } = require("./radioMetadataResolver");
const { SavedPlaylist } = require("./savedPlaylist");
const { SessionStore, trackKey } = require("./sessionStore");
const { TasteProfile, normalizeRating } = require("./tasteProfile");
const { TidalVerifier } = require("./tidalVerifier");
const { TrackMemory } = require("./trackMemory");
const yearRangeUtil = require("./yearRange");

const publicDir = path.join(__dirname, "..", "public");
const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;
const roon = new RoonClient();
const tidal = new TidalVerifier(config.tidal);
const discoveryHistory = new DiscoveryHistory();
const listeningHistory = new ListeningHistory();
const savedPlaylist = new SavedPlaylist();
const sessionStore = new SessionStore();
const tasteProfile = new TasteProfile();
const trackMemory = new TrackMemory();
const lastfm = new LastFmClient(config.lastfm);
const queryYieldTracker = new QueryYieldTracker();
const rabbitHoleGraph = new RabbitHoleGraph();
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
  spotifyArtworkEnabled: config.radioMetadata.spotifyArtworkEnabled,
  spotifyMarket: config.radioMetadata.spotifyMarket,
  spotifyClientId: config.radioMetadata.spotifyClientId,
  spotifyClientSecret: config.radioMetadata.spotifyClientSecret,
  logger: console
});
const hqplayerStatus = new HQPlayerStatus({
  ...config.hqplayer,
  activePlaybackProvider: () => roon.hasActivePlayback(),
  onChange: () => scheduleBroadcast()
});
const clients = new Set();
const radioEnrichmentCache = new Map();
const STATE_UPDATE_DEBOUNCE_MS = 1000;
const OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai-compatible", "openai_compatible", "lmstudio", "llamacpp"]);
let broadcastTimer = null;
let lastBroadcastData = "";
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

function sendJson(res, status, body) {
  const payload = body === undefined ? { ok: true } : body;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeBaseUrl(baseUrl = "") {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function llmSnapshot() {
  const openAiCompatible = OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider);
  const model = openAiCompatible
    ? config.openAiCompatibleModel
    : (config.llmProvider === "openrouter" ? config.openRouterModel : config.ollamaModel);
  const label = openAiCompatible
    ? "LM STUDIO"
    : (config.llmProvider === "openrouter" ? "OPENROUTER" : "OLLAMA");
  const baseUrl = openAiCompatible
    ? config.openAiCompatibleBaseUrl
    : (config.llmProvider === "openrouter" ? "https://openrouter.ai/api/v1" : config.ollamaBaseUrl);
  return {
    provider: config.llmProvider,
    label,
    model,
    baseUrl
  };
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

async function llmHealth() {
  const snapshot = llmSnapshot();
  const headers = {};
  if (config.openAiCompatibleApiKey) headers.authorization = `Bearer ${config.openAiCompatibleApiKey}`;
  if (config.openRouterApiKey) headers.authorization = `Bearer ${config.openRouterApiKey}`;

  try {
    if (OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider)) {
      const baseUrl = normalizeBaseUrl(config.openAiCompatibleBaseUrl);
      const { response, body } = await fetchJsonWithTimeout(`${baseUrl}/models`, { headers }, 2500);
      const models = Array.isArray(body?.data) ? body.data.map((model) => model.id).filter(Boolean) : [];
      const loaded = !snapshot.model || models.includes(snapshot.model);
      return {
        ...snapshot,
        online: response.ok && loaded,
        reachable: response.ok,
        loaded,
        models,
        message: response.ok
          ? (loaded ? "Local model ready" : "LM Studio reachable, configured model not loaded")
          : `LM Studio returned HTTP ${response.status}`
      };
    }

    if (config.llmProvider === "openrouter") {
      return {
        ...snapshot,
        online: Boolean(config.openRouterApiKey),
        reachable: Boolean(config.openRouterApiKey),
        loaded: Boolean(config.openRouterApiKey),
        message: config.openRouterApiKey ? "OpenRouter key configured" : "OPENROUTER_API_KEY is missing"
      };
    }

    const baseUrl = normalizeBaseUrl(config.ollamaBaseUrl);
    const { response, body } = await fetchJsonWithTimeout(`${baseUrl}/api/tags`, {}, 2500);
    const models = Array.isArray(body?.models) ? body.models.map((model) => model.name).filter(Boolean) : [];
    const loaded = !snapshot.model || models.includes(snapshot.model);
    return {
      ...snapshot,
      online: response.ok && loaded,
      reachable: response.ok,
      loaded,
      models,
      message: response.ok
        ? (loaded ? "Ollama model ready" : "Ollama reachable, configured model not loaded")
        : `Ollama returned HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ...snapshot,
      online: false,
      reachable: false,
      loaded: false,
      models: [],
      message: error?.name === "AbortError" ? "Local model check timed out" : (error.message || "Local model is offline")
    };
  }
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

function summarizeZoneTrack(zone = {}) {
  const now = zone.now_playing;
  if (!now) return null;
  return {
    title: now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1 || "",
    artist: now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2 || "",
    album: now.three_line?.line3 || "",
    durationMs: now.length ? Number(now.length) * 1000 : null
  };
}

function cleanRadioText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRadioText(value) {
  return cleanRadioText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitRadioArtistTitle(value) {
  const text = cleanRadioText(value);
  const parts = text.split(/\s+[-\u2013\u2014]\s+/).map(cleanRadioText).filter(Boolean);
  if (parts.length < 2) return null;
  return {
    artist: parts[0],
    title: parts.slice(1).join(" - ")
  };
}

function looksLikeRadioProgramTitle(value) {
  const text = cleanRadioText(value);
  if (!text) return false;
  const monthAndYear = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/i;
  return monthAndYear.test(text) ||
    /\b(?:episode|showcase|takeover|podcast|radio\s+show|guest\s+mix|dj\s+set|live\s+set|monthly\s+mix|weekly\s+mix|mixed\s+by|with\s+[a-z0-9][\w .'-]{2,})\b/i.test(text);
}

function looksLikeStationText(value) {
  const text = cleanRadioText(value);
  if (!text) return false;
  return /\b(?:station|fm|di\.?fm|frisky|proton|afterhours|live\s+radio|radio\s+station|stream|premium)\b/i.test(text);
}

function looksLikeNonMusicStatus(value) {
  return /\b(?:muted detected|twitch stream|system output|no media|no track|silence)\b/i.test(cleanRadioText(value));
}

function radioTrackFromZone(zone = {}) {
  const now = zone.now_playing;
  if (!now) return null;

  const line1 = cleanRadioText(now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1);
  const line2 = cleanRadioText(now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2);
  const threeTitle = cleanRadioText(now.three_line?.line2);
  const threeArtist = cleanRadioText(now.three_line?.line3);
  const rawAlbum = cleanRadioText(now.three_line?.line3 || "");
  const oneLine = cleanRadioText(now.one_line?.line1);
  if (!line1 && !line2) return null;
  if (looksLikeNonMusicStatus(`${zone.display_name || ""} ${line1} ${line2} ${rawAlbum}`)) return null;

  const splitLine2 = splitRadioArtistTitle(line2);
  const splitLine1 = splitRadioArtistTitle(line1);
  const artistDuplicatesTitle = line2 && normalizeRadioText(line2) === normalizeRadioText(line1);
  const streamLike = !zone.is_seek_allowed || looksLikeStationText(`${zone.display_name || ""} ${line1} ${line2} ${rawAlbum}`);

  let artist = line2;
  let title = line1;
  const parsed = streamLike ? parseRadioTrack({
    title: line1,
    artist: line2,
    album: rawAlbum,
    originalTitle: line1,
    originalArtist: line2,
    originalAlbum: rawAlbum,
    activityDetails: oneLine || line1,
    activityState: line2
  }) : null;

  if (streamLike && parsed?.artist && parsed?.title) {
    artist = parsed.artist;
    title = parsed.title;
  } else if (streamLike && threeTitle && threeArtist && !looksLikeStationText(threeArtist)) {
    artist = threeArtist;
    title = threeTitle;
  } else if (streamLike && splitLine2) {
    artist = splitLine2.artist;
    title = splitLine2.title;
  } else if (splitLine1 && (!artist || artistDuplicatesTitle || streamLike || looksLikeStationText(artist))) {
    artist = splitLine1.artist;
    title = splitLine1.title;
  }

  artist = cleanRadioText(artist);
  title = cleanRadioText(title);
  if (!artist || !title) return null;
  if (looksLikeNonMusicStatus(`${artist} ${title}`)) return null;
  if (!streamLike && !artistDuplicatesTitle && !(splitLine1 && normalizeRadioText(line2).includes(normalizeRadioText(splitLine1.artist)))) return null;
  const isRadioProgram = streamLike && looksLikeRadioProgramTitle(title);

  return {
    artist,
    title,
    album: rawAlbum,
    durationMs: now.length ? Number(now.length) * 1000 : null,
    isRadioProgram,
    catalogEnrichmentAllowed: !isRadioProgram,
    source: "Roon radio metadata"
  };
}

function radioEnrichmentKey(track = {}) {
  if (!track) return "";
  const artist = normalizeRadioText(track.artist);
  const title = normalizeRadioText(track.title);
  return artist && title ? `${artist}|${title}` : "";
}

function attachRadioEnrichment(state = {}) {
  return {
    ...state,
    zones: (state.zones || []).map((zone) => {
      const lookup = radioTrackFromZone(zone);
      const key = radioEnrichmentKey(lookup);
      const cached = key ? radioEnrichmentCache.get(key) : null;
      if (!lookup && !cached?.result) return zone;
      if (lookup?.catalogEnrichmentAllowed === false) return {
        ...zone,
        now_playing: {
          ...(zone.now_playing || {}),
          radio_lookup: lookup
        }
      };

      return {
        ...zone,
        now_playing: {
          ...(zone.now_playing || {}),
          radio_lookup: lookup,
          ...(cached?.result ? { radio_enrichment: cached.result } : {})
        }
      };
    })
  };
}

function trimRadioEnrichmentCache(max = 200) {
  if (radioEnrichmentCache.size <= max) return;
  const entries = [...radioEnrichmentCache.entries()]
    .sort((left, right) => Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0));
  for (const [key] of entries.slice(0, radioEnrichmentCache.size - max)) {
    radioEnrichmentCache.delete(key);
  }
}

function radioMetadataToEnrichment(lookup = {}, metadata = {}, tidalResult = null) {
  if (lookup?.catalogEnrichmentAllowed === false) return null;
  if (!metadata && !tidalResult) return null;

  const exactTidalResult = tidalResult && tidalEnrichmentMatches(lookup, tidalResult) ? tidalResult : null;
  if (tidalResult && !exactTidalResult) {
    console.warn(`Ignoring loose radio TIDAL match for ${lookup.artist} - ${lookup.title}: ${tidalResult.artist} - ${tidalResult.title}`);
  }

  const imageUrl = cleanRadioText(metadata?.albumArtUrl || exactTidalResult?.imageUrl);
  const tidalUrl = cleanRadioText(metadata?.tidalUrl || exactTidalResult?.tidalUrl || exactTidalResult?.url);
  const album = cleanRadioText(metadata?.album || exactTidalResult?.album);
  const durationMs = Number(metadata?.durationMs || exactTidalResult?.durationMs || 0) || lookup.durationMs || null;

  if (!imageUrl && !tidalUrl && !album && !durationMs && !exactTidalResult) return null;

  return {
    ...(exactTidalResult || {}),
    title: cleanRadioText(metadata?.title || lookup.title || exactTidalResult?.title),
    artist: cleanRadioText(metadata?.artist || lookup.artist || exactTidalResult?.artist),
    album,
    durationMs,
    tidalUrl,
    url: tidalUrl,
    imageUrl,
    lookup,
    source: metadata?.source ? `radio-${metadata.source}` : (exactTidalResult ? "tidal-radio-enrichment" : "radio-metadata")
  };
}

async function resolveRadioEnrichment(lookup, key) {
  if (lookup?.catalogEnrichmentAllowed === false) return null;
  const metadataPromise = config.radioMetadata.enabled
    ? radioMetadataResolver.lookup(lookup, key).catch((error) => {
      console.warn("Radio metadata resolver failed", error.message);
      return null;
    })
    : Promise.resolve(null);
  const tidalPromise = tidal.isConfigured()
    ? tidal.verify(lookup, { strict: false }).catch((error) => {
      console.warn("Radio TIDAL enrichment failed", error.message);
      return null;
    })
    : Promise.resolve(null);

  const [metadata, tidalResult] = await Promise.all([metadataPromise, tidalPromise]);
  return radioMetadataToEnrichment(lookup, metadata, tidalResult);
}

function scheduleRadioEnrichment(state = {}) {
  if (!config.radioMetadata.enabled && !tidal.isConfigured()) return;

  for (const zone of state.zones || []) {
    const lookup = radioTrackFromZone(zone);
    const key = radioEnrichmentKey(lookup);
    if (!key) continue;
    if (lookup.catalogEnrichmentAllowed === false) {
      radioEnrichmentCache.delete(key);
      continue;
    }

    const cached = radioEnrichmentCache.get(key);
    if (cached?.pending) continue;
    if (cached?.result) continue;
    if (cached?.error && Date.now() - Number(cached.updatedAt || 0) < 15 * 60 * 1000) continue;

    radioEnrichmentCache.set(key, {
      pending: true,
      lookup,
      updatedAt: Date.now()
    });

    resolveRadioEnrichment(lookup, key)
      .then((result) => {
        radioEnrichmentCache.set(key, {
          lookup,
          result,
          updatedAt: Date.now()
        });
        trimRadioEnrichmentCache();
        if (result) scheduleBroadcast();
      })
      .catch((error) => {
        radioEnrichmentCache.set(key, {
          lookup,
          error: error.message,
          updatedAt: Date.now()
        });
        trimRadioEnrichmentCache();
      });
  }
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

function mergeTrackLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const track of list || []) {
      const keys = candidateIdentityKeys(track);
      const key = keys[0] || `${track.artist || ""}|${track.title || ""}`.toLowerCase();
      if (!key || seen.has(key)) continue;
      for (const candidateKey of keys) seen.add(candidateKey);
      seen.add(key);
      merged.push(track);
    }
  }
  return merged;
}

function discoveryPoolCount(result = {}) {
  return mergeTrackLists(result.tracks, result.alternates).length;
}

function mergeQueryYieldSummaries(base = {}, extra = {}) {
  if (!base?.recordCount && !extra?.recordCount) return base?.recordCount ? base : extra;
  const combineItems = (left = [], right = [], limit = 8) => [...left, ...right].slice(0, limit);
  return {
    enabled: Boolean(base.enabled || extra.enabled),
    attempted: Number(base.attempted || 0) + Number(extra.attempted || 0),
    returned: Number(base.returned || 0) + Number(extra.returned || 0),
    accepted: Number(base.accepted || 0) + Number(extra.accepted || 0),
    rejected: Number(base.rejected || 0) + Number(extra.rejected || 0),
    seoRejects: Number(base.seoRejects || 0) + Number(extra.seoRejects || 0),
    genreRejects: Number(base.genreRejects || 0) + Number(extra.genreRejects || 0),
    errorCount: Number(base.errorCount || 0) + Number(extra.errorCount || 0),
    recordCount: Number(base.recordCount || 0) + Number(extra.recordCount || 0),
    adjustments: combineItems(base.adjustments || [], extra.adjustments || []),
    best: combineItems(base.best || [], extra.best || []),
    worst: combineItems(base.worst || [], extra.worst || []),
    error: base.error || extra.error || ""
  };
}

function annotateAutoBroadenTracks(list = [], pass = {}) {
  return list.map((track) => ({
    ...track,
    autoBroadened: true,
    discoverySource: track.discoverySource || pass.label || "Auto-broadened search",
    discoveryLane: track.discoveryLane || pass.lane || "core-expanded",
    statusChecks: Array.from(new Set([
      ...(Array.isArray(track.statusChecks) ? track.statusChecks : []),
      pass.label || "Auto-broadened search"
    ].filter(Boolean)))
  }));
}

async function runAutoBroadenSearches(discovered = {}, baseOptions = {}, searchProfile = buildDiscoveryProfile(baseOptions), requestedCount = 8, scrobbleHistory = null, budgets = {}) {
  const passes = autoBroadenSearchPasses(baseOptions, searchProfile, discovered, requestedCount);
  const queryYieldHealth = passes.find((pass) => pass.queryYieldHealth)?.queryYieldHealth || null;
  const summary = {
    enabled: true,
    attempted: 0,
    added: 0,
    poolBefore: discoveryPoolCount(discovered),
    poolAfter: discoveryPoolCount(discovered),
    targetPool: passes[0]?.targetPool || 0,
    yieldAware: Boolean(queryYieldHealth?.retryNeeded),
    queryYieldHealth,
    lanes: [],
    errors: []
  };

  if (!passes.length) {
    return {
      ...discovered,
      verification: {
        ...(discovered.verification || {}),
        autoBroaden: summary
      }
    };
  }

  let current = discovered;
  const perPassTimeoutMs = Math.max(8_000, Math.min(30_000, Math.floor(Number(budgets.discoveryTimeoutMs || 30_000) / 2)));

  for (const pass of passes) {
    const beforePool = discoveryPoolCount(current);
    if (beforePool >= pass.targetPool && (current.tracks || []).length >= requestedCount) break;

    summary.attempted += 1;
    try {
      const broadened = await withTimeout(
        discoverTracks({
          tidal,
          options: pass.options,
          history: discoveryHistory,
          tasteProfile,
          scrobbleHistory,
          queryYieldTracker
        }),
        perPassTimeoutMs,
        `${pass.label} took too long.`
      );
      const broadenedTracks = annotateAutoBroadenTracks(broadened.tracks || [], pass);
      const broadenedAlternates = annotateAutoBroadenTracks(broadened.alternates || [], pass);
      current = {
        ...current,
        tracks: mergeTrackLists(current.tracks, broadenedTracks),
        alternates: mergeTrackLists(current.alternates, broadenedAlternates),
        discarded: [...(current.discarded || []), ...(broadened.discarded || [])],
        verification: {
          ...(current.verification || {}),
          queryYield: mergeQueryYieldSummaries(current.verification?.queryYield, broadened.verification?.queryYield),
          autoBroaden: summary
        }
      };

      const afterPool = discoveryPoolCount(current);
      const added = Math.max(0, afterPool - beforePool);
      summary.added += added;
      summary.poolAfter = afterPool;
      summary.lanes.push({
        lane: pass.lane,
        label: pass.label,
        reason: pass.reason,
        yieldAware: pass.lane === "yield-retry" || Boolean(pass.queryYieldHealth?.retryNeeded),
        generated: broadened.verification?.generated || 0,
        kept: broadened.tracks?.length || 0,
        alternates: broadened.alternates?.length || 0,
        added
      });
    } catch (error) {
      summary.errors.push({
        lane: pass.lane,
        label: pass.label,
        error: error.message
      });
    }
  }

  return {
    ...current,
    verification: {
      ...(current.verification || {}),
      autoBroaden: {
        ...summary,
        poolAfter: discoveryPoolCount(current)
      }
    }
  };
}

function clampScore(value, min = 1, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeMatchText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function llmScoreKey(track = {}) {
  const direct = track.tidal?.id || track.tidalId || track.id || track.trackId || track.tidal?.tidalUrl || track.tidalUrl;
  if (direct) return String(direct).trim();
  const keys = candidateIdentityKeys(track);
  return keys[0] || `${normalizeMatchText(track.artist)}|${normalizeMatchText(track.title)}`;
}

function scoreLabelForPercent(percent) {
  const score = Number(percent || 0);
  if (score >= 90) return "Excellent";
  if (score >= 80) return "Strong";
  if (score >= 70) return "Good";
  if (score >= 55) return "Loose";
  return "Weak";
}

function hardModelReject(score = {}) {
  if (!score.rejected) return false;
  const reason = normalizeMatchText(score.rejectionReason);
  if (!reason) return false;
  if (Number(score.finalScore || 0) >= 65 && Number(score.scores?.genreConfidence || 0) >= 55) return false;
  return /\b(?:playlist|compilation|seo|chart|karaoke|cover|tribute|live|remaster|reissue|anniversary|deluxe|archive|background|catalogue|filler|spam)\b/.test(reason);
}

function mergeWhy(existing = [], additions = []) {
  const seen = new Set();
  const merged = [];
  for (const item of [...additions, ...existing]) {
    const text = String(item || "").replace(/\s+/g, " ").trim();
    const key = normalizeMatchText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    merged.push(text);
    if (merged.length >= 8) break;
  }
  return merged;
}

function applyModelReview(track = {}, score = {}) {
  if (!score || !score.trackId) return track;
  const modelScores = score.scores || {};
  const existingBreakdown = track.scoreBreakdown || {};
  const promptPercent = clampScore(modelScores.promptMatch, 0, 100);
  const tastePercent = clampScore(modelScores.tasteMatch, 0, 100);
  const finalScore = clampScore(score.finalScore, 0, 100);
  const currentScore = Number(track.score || existingBreakdown.total || 0) || finalScore;
  const genreConfidence = clampScore(modelScores.genreConfidence, 0, 100);
  const scorePenalty = genreConfidence && genreConfidence < 50 ? 6 : 0;
  const blendedScore = clampScore((currentScore * 0.78) + (finalScore * 0.22) - scorePenalty);
  const modelWhy = mergeWhy(score.why || [], score.rejectionReason ? [`Model warning: ${score.rejectionReason}`] : []);
  const matchWhy = mergeWhy(existingBreakdown.matchWhy || track.matchWhy || [], modelWhy);
  const scoreBreakdown = {
    ...existingBreakdown,
    total: blendedScore,
    promptMatch: {
      ...(existingBreakdown.promptMatch || {}),
      percent: promptPercent,
      label: scoreLabelForPercent(promptPercent)
    },
    tasteMatch: {
      ...(existingBreakdown.tasteMatch || {}),
      percent: tastePercent,
      label: scoreLabelForPercent(tastePercent)
    },
    matchGenre: score.genre || existingBreakdown.matchGenre || track.matchGenre || "",
    matchWhy,
    llmReview: {
      finalScore,
      freshness: modelScores.freshness,
      artistLabelMatch: modelScores.artistLabelMatch,
      lengthPreference: modelScores.lengthPreference,
      genreConfidence,
      rejected: score.rejected,
      rejectionReason: score.rejectionReason
    }
  };
  return {
    ...track,
    score: blendedScore,
    scoreBreakdown,
    promptMatch: scoreBreakdown.promptMatch,
    tasteMatch: scoreBreakdown.tasteMatch,
    matchGenre: scoreBreakdown.matchGenre,
    matchWhy,
    why: mergeWhy(track.why || [], modelWhy),
    reason: track.reason ? `${track.reason}; model-reviewed` : "model-reviewed",
    llmReview: scoreBreakdown.llmReview
  };
}

async function applyModelCandidateReview(discovered = {}, options = {}) {
  const combined = mergeTrackLists(discovered.tracks, discovered.alternates).slice(0, 50);
  if (!combined.length) return {
    result: discovered,
    review: { enabled: false, scored: 0, rejected: 0, error: "No candidates to review." }
  };

  const review = await scoreCandidateBatch(config, {
    tracks: combined,
    options,
    tasteProfile: tasteProfile.read(),
    timeoutMs: 30_000
  });
  const scoreMap = new Map();
  for (const score of review.scores || []) {
    if (score.trackId) scoreMap.set(score.trackId, score);
  }

  let rejected = 0;
  const audit = createModelReviewAudit();
  const discarded = [...(discovered.discarded || [])];
  function applyList(list = []) {
    const next = [];
    for (const track of list) {
      const key = llmScoreKey(track);
      const score = scoreMap.get(key);
      if (!score) {
        next.push(track);
        continue;
      }
      const beforeScore = Number(track.score || track.scoreBreakdown?.total || 0) || Number(score.finalScore || 0) || 0;
      if (hardModelReject(score)) {
        rejected += 1;
        const item = modelReviewAuditItem(track, score, beforeScore, null, "rejected");
        recordModelReviewAudit(audit, item, "rejected");
        discarded.push({
          ...track,
          llmReview: score,
          reason: `Model rejected candidate: ${score.rejectionReason || "low-confidence catalogue result"}`
        });
        continue;
      }
      const reviewedTrack = applyModelReview(track, score);
      const afterScore = Number(reviewedTrack.score || reviewedTrack.scoreBreakdown?.total || 0) || beforeScore;
      const type = classifyModelReviewChange(score, beforeScore, afterScore, false);
      const item = modelReviewAuditItem(reviewedTrack, score, beforeScore, afterScore, type);
      recordModelReviewAudit(audit, item, type);
      next.push({
        ...reviewedTrack,
        modelReview: {
          action: type,
          before: item.before,
          after: item.after,
          delta: item.delta,
          modelScore: item.modelScore,
          genreConfidence: item.genreConfidence,
          reason: item.reason
        }
      });
    }
    return next;
  }

  return {
    result: {
      ...discovered,
      tracks: applyList(discovered.tracks),
      alternates: applyList(discovered.alternates),
      discarded
    },
    review: {
      enabled: true,
      scored: scoreMap.size,
      rejected,
      rawCount: review.rawCount || 0,
      audit,
      error: ""
    }
  };
}

function baseTitleForMatch(value) {
  return normalizeMatchText(String(value || "")
    .replace(/\s*[\[(][^\])]*(?:mix|remix|edit|version|rework|dub|rerub|original|extended)[^\])]*[\])]/gi, " ")
    .replace(/\s+/g, " "));
}

function splitArtistForMatch(value) {
  return String(value || "")
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map(normalizeMatchText)
    .filter((part) => part && part.length > 1);
}

function tidalEnrichmentMatches(track = {}, verified = {}) {
  const targetTitle = normalizeMatchText(track.title);
  const actualTitle = normalizeMatchText(verified.title);
  const targetBase = baseTitleForMatch(track.title);
  const actualBase = baseTitleForMatch(verified.title);
  const titleOk = Boolean(
    targetTitle &&
    actualTitle &&
    (targetTitle === actualTitle || (targetBase && targetBase === actualBase))
  );
  const targetArtists = splitArtistForMatch(track.artist);
  const actualArtists = splitArtistForMatch(verified.artist);
  const artistOk = Boolean(
    targetArtists.length &&
    actualArtists.length &&
    targetArtists.some((target) => actualArtists.some((actual) => target === actual || target.includes(actual) || actual.includes(target)))
  );
  return titleOk && artistOk;
}

function scoreWithRoonFloor(breakdown = {}, track = {}) {
  const floor = 70;
  if (Number(breakdown.total || 0) >= floor) return breakdown;

  const max = breakdown.max || {};
  const boosted = { ...breakdown };
  let remaining = floor - Number(boosted.total || 0);
  function addTo(field) {
    const current = Number(boosted[field] || 0);
    const cap = Number(max[field] || current);
    const add = Math.max(0, Math.min(remaining, cap - current));
    boosted[field] = current + add;
    remaining -= add;
  }

  addTo("genreMatch");
  addTo("artistMatch");
  addTo("labelMatch");
  boosted.total = Math.min(100, Number(boosted.freshness || 0) + Number(boosted.labelMatch || 0) + Number(boosted.artistMatch || 0) + Number(boosted.lengthPreference || 0) + Number(boosted.genreMatch || 0) + Number(boosted.tasteAdjustment || 0));
  if (boosted.total < floor) boosted.total = floor;
  return boosted;
}

async function enrichRoonTrackWithTidal(track) {
  if (!tidal.isConfigured()) return track;
  try {
    const verified = await Promise.race([
      tidal.verify(track, { strict: false }).catch(() => null),
      wait(1800).then(() => null)
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

function requestAllowsPreviousSuggestions(options = {}) {
  const text = `${options.request || ""} ${options.reference || ""} ${options.genres || ""} ${options.mood || ""}`;
  return /\b(?:allow repeats|include repeats|show repeats|reuse previous suggestions|include previous suggestions|include previously suggested|show previous suggestions|same tracks again|same songs again|rerun previous)\b/i.test(text);
}

function requestAllowsArtistCluster(options = {}) {
  const text = `${options.request || ""} ${options.reference || ""} ${options.genres || ""} ${options.mood || ""}`;
  return /\b(?:same artist|single artist|one artist|artist deep dive|deep dive on|discography|catalogue|catalog|all .* by|only .* by|more from)\b/i.test(text);
}

function artistDiversityKey(track = {}) {
  return splitArtistForMatch(track.artist || track.tidal?.artist || "")[0] || normalizeMatchText(track.artist || track.tidal?.artist || "");
}

function albumDiversityKey(track = {}) {
  return normalizeMatchText(track.album || track.tidal?.album || "");
}

function trackDiversityKey(track = {}) {
  const keys = candidateIdentityKeys(track);
  return keys[0] || `${artistDiversityKey(track)}|${normalizeMatchText(track.title || track.tidal?.title || "")}`;
}

function diversifyCandidates(candidates = [], requestedCount = 10, options = {}) {
  const allowCluster = requestAllowsArtistCluster(options);
  const selected = [];
  const selectedKeys = new Set();
  const artistCounts = new Map();
  const albumCounts = new Map();
  const stages = allowCluster
    ? [{ artist: Math.max(4, requestedCount), album: Math.max(3, Math.ceil(requestedCount / 2)) }]
    : [
      { artist: requestedCount <= 12 ? 1 : 2, album: 1 },
      { artist: requestedCount <= 12 ? 2 : 3, album: 2 },
      { artist: requestedCount <= 12 ? 3 : 4, album: 3 }
    ];

  function addCandidate(candidate, caps) {
    if (selected.length >= requestedCount) return false;
    const key = trackDiversityKey(candidate);
    if (!key || selectedKeys.has(key)) return false;
    const artistKey = artistDiversityKey(candidate);
    const albumKey = albumDiversityKey(candidate);
    const artistCount = artistCounts.get(artistKey) || 0;
    const albumCount = albumKey ? (albumCounts.get(albumKey) || 0) : 0;
    if (artistKey && artistCount >= caps.artist) return false;
    if (albumKey && albumCount >= caps.album) return false;
    selected.push(candidate);
    selectedKeys.add(key);
    if (artistKey) artistCounts.set(artistKey, artistCount + 1);
    if (albumKey) albumCounts.set(albumKey, albumCount + 1);
    return true;
  }

  for (const caps of stages) {
    for (const candidate of candidates) addCandidate(candidate, caps);
    if (selected.length >= requestedCount) break;
  }

  for (const candidate of candidates) {
    if (selected.length >= requestedCount) break;
    addCandidate(candidate, { artist: Number.MAX_SAFE_INTEGER, album: Number.MAX_SAFE_INTEGER });
  }

  return {
    tracks: selected,
    alternates: candidates.filter((candidate) => !selectedKeys.has(trackDiversityKey(candidate))),
    artistSpread: artistCounts.size,
    albumSpread: albumCounts.size,
    relaxed: selected.length < Math.min(requestedCount, candidates.length)
  };
}

async function decorateRoonFirstResult(roonResult, options = {}) {
  const yearRange = yearRangeUtil.parseYearRange(options);
  const scoringOptions = yearRange ? { ...options, years: yearRange.label } : options;
  const discoveryProfile = buildDiscoveryProfile(scoringOptions);
  const requestedCount = parseRequestedCount(options);
  const originalRequestedCount = Number(options.originalRequestedCount || 0) || requestedCount;
  const minScore = minimumScoreFor(scoringOptions);
  const strictFilteredRequest = Boolean(yearRange || minScore);
  const sourcePoolLimit = strictFilteredRequest
    ? (requestedCount <= 5 ? 14 : Math.min(120, Math.max(requestedCount + 30, requestedCount * 7)))
    : (requestedCount <= 5 ? 12 : Math.min(80, Math.max(requestedCount + 16, requestedCount * 4)));
  const scoringPoolLimit = strictFilteredRequest
    ? (requestedCount <= 5 ? 10 : Math.min(70, Math.max(requestedCount + 20, requestedCount * 5)))
    : (requestedCount <= 5 ? 8 : Math.min(50, Math.max(requestedCount + 10, requestedCount * 3)));
  const minScoreLabel = minimumScoreLabel(minScore);
  const discarded = [...(roonResult.discarded || [])];
  const allowPreviousSuggestions = requestAllowsPreviousSuggestions(scoringOptions);
  const sourcePool = mergeTrackLists(roonResult.tracks, roonResult.alternates)
    .slice(0, sourcePoolLimit);
  const freshPool = [];
  const previousPool = [];
  for (const track of sourcePool) {
    if (discoveryHistory.entryFor(track)) previousPool.push(track);
    else freshPool.push(track);
  }

  const poolForScoring = allowPreviousSuggestions
    ? [...freshPool, ...previousPool].slice(0, scoringPoolLimit)
    : [
      ...freshPool.slice(0, scoringPoolLimit),
      ...previousPool.slice(0, Math.max(12, requestedCount))
    ];
  const enriched = await mapWithConcurrency(poolForScoring, 4, enrichRoonTrackWithTidal);
  const freshDecorated = [];
  const previousDecorated = [];
  const scoreFiltered = [];
  let previouslySuggestedHeldBack = 0;
  const relaxedYearOptions = nearYearFallbackOptions(scoringOptions, yearRange);
  const relaxedYearProfile = relaxedYearOptions ? buildDiscoveryProfile(relaxedYearOptions) : null;
  let nearYearFallbackUsed = false;

  for (const track of enriched) {
    let candidateTrack = track;
    let scoringTrack = {
      ...track,
      ...(track.tidal || {}),
      query: track.query || track.roon?.sourceQuery || "",
      roon: track.roon
    };
    let scoringOptionsForTrack = scoringOptions;
    let profileForTrack = discoveryProfile;
    const historyEntry = discoveryHistory.entryFor(scoringTrack);
    let rejection = (yearRange || track.tidal?.tidalUrl) ? rejectReason(scoringTrack, scoringOptionsForTrack, profileForTrack) : "";

    if (rejection && relaxedYearOptions) {
      const relaxedTrack = {
        ...scoringTrack,
        discoveryLane: "recent",
        discoverySource: "Roon recent-year fallback"
      };
      const relaxedRejection = rejectReason(relaxedTrack, relaxedYearOptions, relaxedYearProfile);
      if (!relaxedRejection) {
        candidateTrack = {
          ...track,
          discoveryLane: "recent",
          discoverySource: "Roon recent-year fallback"
        };
        scoringTrack = relaxedTrack;
        scoringOptionsForTrack = relaxedYearOptions;
        profileForTrack = relaxedYearProfile;
        rejection = "";
        nearYearFallbackUsed = true;
      }
    }

    if (rejection) {
      discarded.push({
        ...candidateTrack,
        reason: rejection
      });
      continue;
    }

    const rawBreakdown = scoreBreakdownFor(scoringTrack, scoringOptionsForTrack, tasteProfile, profileForTrack);
    const scoreBreakdown = scoreWithRoonFloor(rawBreakdown, candidateTrack);
    if (minScore && scoreBreakdown.total < minScore) {
      const filtered = {
        ...candidateTrack,
        score: scoreBreakdown.total,
        scoreBreakdown,
        reason: `Discovery score ${scoreBreakdown.total} is below minimum ${minScoreLabel}.`
      };
      scoreFiltered.push(filtered);
      discarded.push(filtered);
      continue;
    }

    const candidate = {
      ...candidateTrack,
      reason: reasonFor(scoringTrack, scoringOptionsForTrack, scoreBreakdown, profileForTrack),
      why: whyBulletsFor(scoringTrack, scoringOptionsForTrack, scoreBreakdown, historyEntry, profileForTrack),
      discoverySource: candidateTrack.discoverySource || "Roon search",
      score: scoreBreakdown.total,
      scoreBreakdown,
      statusChecks: queueableStatusChecks({
        ...candidateTrack,
        statusChecks: discoveryStatusFor(scoringTrack, historyEntry, discoveryHistory.isRecent(scoringTrack))
      }),
      verificationSource: candidateTrack.verificationSource || "roon"
    };
    candidate.feedback = tasteProfile.getFeedbackFor(candidate);
    if (historyEntry && !allowPreviousSuggestions) {
      previousDecorated.push(candidate);
      previouslySuggestedHeldBack += 1;
      discarded.push({
        ...candidate,
        reason: "Previously suggested; held back for discovery variety."
      });
    } else {
      freshDecorated.push(candidate);
    }
  }

  const sortCandidates = (left, right) => (
    Number(right.score || 0) - Number(left.score || 0) ||
    Number(right.durationMs || 0) - Number(left.durationMs || 0)
  );
  freshDecorated.sort(sortCandidates);
  previousDecorated.sort(sortCandidates);
  const candidateOrder = allowPreviousSuggestions
    ? mergeTrackLists(freshDecorated, previousDecorated)
    : freshDecorated;
  const diversity = diversifyCandidates(candidateOrder, requestedCount, scoringOptions);
  const selected = diversity.tracks;
  const alternates = allowPreviousSuggestions
    ? diversity.alternates
    : mergeTrackLists(diversity.alternates, previousDecorated);

  return {
    requestedCount,
    tracks: selected,
    alternates,
    discarded,
    verification: {
      ...(roonResult.verification || {}),
      requested: requestedCount,
      originalRequested: originalRequestedCount,
      countExpanded: requestedCount !== originalRequestedCount,
      kept: selected.length,
      discarded: discarded.length,
      minScore,
      minScoreLabel,
      yearRange: yearRange?.label || "",
      scoreFiltered: scoreFiltered.length,
      strategy: "roon-search-first",
      nearYearFallback: nearYearFallbackUsed,
      nearYearFallbackRange: nearYearFallbackUsed ? relaxedYearOptions?.years || "" : "",
      tidalEnriched: [...freshDecorated, ...previousDecorated].filter((track) => track.tidal?.tidalUrl).length,
      novelty: !allowPreviousSuggestions,
      previouslySuggestedAllowed: allowPreviousSuggestions,
      previouslySuggestedHeldBack,
      freshRoonCandidates: freshPool.length,
      previousRoonCandidates: previousPool.length,
      diversity: {
        enabled: true,
        artistSpread: diversity.artistSpread,
        albumSpread: diversity.albumSpread,
        artistClusterAllowed: requestAllowsArtistCluster(scoringOptions)
      },
      intent: discoveryProfile.intent,
      scoringMode: discoveryProfile.scoringMode
    }
  };
}

function appSnapshot() {
  const taste = tasteProfile.read();
  const saved = savedPlaylist.snapshot();
  const session = sessionStore.read();
  return {
    updatedAt: new Date().toISOString(),
    session,
    saved,
    taste: tasteProfile.summary(taste),
    feedback: taste.feedback || {},
    memory: trackMemory.summary(),
    queryYield: queryYieldTracker.summary(),
    lastfm: lastfm.status(),
    tidal: tidal.status(),
    radioMetadata: radioMetadataResolver.status(),
    llm: llmSnapshot()
  };
}

function sessionTrackFor(track = {}) {
  const key = trackKey(track);
  if (!key) return null;
  const session = sessionStore.read();
  const pools = [
    ...(session.result?.tracks || []),
    ...(session.result?.alternates || []),
    ...(session.result?.discarded || [])
  ];
  return pools.find((candidate) => trackKey(candidate) === key) || null;
}

function feedbackTrackWithSessionContext(track = {}) {
  const sessionTrack = sessionTrackFor(track) || {};
  return {
    ...sessionTrack,
    ...track,
    scoreBreakdown: track.scoreBreakdown || sessionTrack.scoreBreakdown || null,
    llmReview: track.llmReview || sessionTrack.llmReview || null,
    modelReview: track.modelReview || sessionTrack.modelReview || null,
    discoverySource: track.discoverySource || sessionTrack.discoverySource || "",
    discoveryLane: track.discoveryLane || sessionTrack.discoveryLane || ""
  };
}

function feedbackCalibrationContext(track = {}) {
  const modelReview = track.modelReview || {};
  const llmReview = track.scoreBreakdown?.llmReview || track.llmReview || {};
  return {
    modelReview,
    modelAction: modelReview.action || "",
    beforeScore: modelReview.before,
    afterScore: modelReview.after,
    delta: modelReview.delta,
    modelScore: modelReview.modelScore ?? llmReview.finalScore,
    genreConfidence: modelReview.genreConfidence ?? llmReview.genreConfidence,
    promptMatch: track.promptMatch ?? track.scoreBreakdown?.promptMatch,
    tasteMatch: track.tasteMatch ?? track.scoreBreakdown?.tasteMatch,
    reason: modelReview.reason || llmReview.rejectionReason || "",
    discoverySource: track.discoverySource || "",
    discoveryLane: track.discoveryLane || ""
  };
}

function eventPayload() {
  const baseState = withTrackMemory(withHqplayerStatus(roon.getState()));
  scheduleRadioEnrichment(baseState);
  const state = attachRadioEnrichment(baseState);
  listeningHistory.recordState(state);
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
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(data);
  });
}

function yearFitsRange(year, range) {
  if (!range) return true;
  return Number(year) >= range.min && Number(year) <= range.max;
}

function isReissueLike(result = {}) {
  const text = `${result.title || ""} ${result.album || ""}`.toLowerCase();
  return /\b(?:remaster(?:ed)?|re-?master(?:ed)?|reissue|anniversary|deluxe|expanded|restored|archive|classics?|retouch|alternative\s+version|alt(?:ernative)?\s+mix)\b/.test(text);
}

function embeddedYears(value) {
  return Array.from(String(value || "").matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => Number(match[1]));
}

function hasOutOfRangeEmbeddedYear(result = {}, range) {
  if (!range) return false;
  const years = embeddedYears(`${result.title || ""} ${result.album || ""}`);
  return years.some((year) => year < range.min || year > range.max);
}

function genreLooksWrong(track = {}, options = {}) {
  const genre = String(options.genres || options.request || "").toLowerCase();
  if (!genre.includes("progressive house")) return false;

  const text = `${track.artist || ""} ${track.title || ""} ${track.album || ""}`.toLowerCase();
  return /\b(?:trance|uplifting|psytrance|goa|techno|ambient|chillout|downtempo|breakbeat|drum\s*and\s*bass|dubstep)\b/.test(text);
}

async function verifyPlaylistWithRoon(playlist, zoneId, options = {}) {
  if (!zoneId) return playlist;

  const verified = [];
  const discarded = [];
  const targetCount = Number(playlist.requestedCount || options.count || playlist.tracks.length);
  const useTidal = tidal.isConfigured();
  const tidalErrors = [];
  const yearRange = yearRangeUtil.parseYearRange(options);

  for (const track of playlist.tracks) {
    if (verified.length >= targetCount) break;

    try {
      let tidalResult = null;
      if (useTidal) {
        try {
          tidalResult = await tidal.verify(track, { strict: Boolean(yearRange) });
        } catch (error) {
          tidalErrors.push(error.message);
        }
      }

      if (tidalResult) {
        if (genreLooksWrong({ ...track, ...tidalResult }, options)) {
          discarded.push({
            ...track,
            reason: "TIDAL match appears outside progressive house.",
            tidal: tidalResult
          });
          continue;
        }

        if (yearRange && isReissueLike(tidalResult)) {
          discarded.push({
            ...track,
            reason: `TIDAL match looks like a remaster/reissue, not a current release in ${yearRange.label}.`,
            tidal: tidalResult
          });
          continue;
        }

        if (yearRange && hasOutOfRangeEmbeddedYear(tidalResult, yearRange)) {
          discarded.push({
            ...track,
            reason: `TIDAL title/album references an older year outside ${yearRange.label}.`,
            tidal: tidalResult
          });
          continue;
        }

        if (yearRange?.dateSpecific && !tidalResult.releaseDate) {
          discarded.push({
            ...track,
            reason: `TIDAL verified the track but did not expose a release date for ${yearRange.label}.`,
            tidal: tidalResult
          });
          continue;
        }

        if (yearRange && !yearRange.dateSpecific && !tidalResult.year) {
          discarded.push({
            ...track,
            reason: `TIDAL verified the track but did not expose a release year for ${yearRange.label}.`,
            tidal: tidalResult
          });
          continue;
        }

        if (yearRange && !yearRangeUtil.yearFits(tidalResult.year, yearRange, tidalResult.releaseDate)) {
          discarded.push({
            ...track,
            reason: `TIDAL release ${tidalResult.releaseDate || tidalResult.year || "unknown"} is outside ${yearRange.label}.`,
            tidal: tidalResult
          });
          continue;
        }

        verified.push({
          ...track,
          artist: tidalResult.artist || track.artist,
          title: tidalResult.title || track.title,
          year: tidalResult.year || null,
          releaseDate: tidalResult.releaseDate || "",
          tidal: tidalResult,
          verificationSource: "tidal"
        });
        continue;
      }

      if (useTidal && yearRange) {
        discarded.push({
          ...track,
          reason: `Not verified in TIDAL with a release year inside ${yearRange.label}.`,
          tidal: { verified: false }
        });
        continue;
      }

      const search = await roon.search(track, zoneId);
      if (search.verified) {
        verified.push({
          ...track,
          roon: {
            verified: true,
            match: {
              title: search.match?.title,
              subtitle: search.match?.subtitle
            }
          },
          verificationSource: "roon"
        });
      } else {
        discarded.push({
          ...track,
          reason: useTidal ? "Not verified in TIDAL or Roon search" : "Not verified in Roon search",
          roon: {
            verified: false,
            match: search.match ? {
              title: search.match.title,
              subtitle: search.match.subtitle
            } : null
          }
        });
      }
    } catch (error) {
      discarded.push({
        ...track,
        reason: error.message,
        roon: { verified: false }
      });
    }
  }

  return {
    ...playlist,
    tracks: verified.slice(0, targetCount),
    discarded,
    verification: {
      enabled: true,
      tidal: useTidal,
      tidalError: tidalErrors[0] || "",
      yearRange: yearRange?.label || "",
      requested: targetCount,
      generated: playlist.tracks.length,
      kept: Math.min(verified.length, targetCount),
      discarded: discarded.length
    }
  };
}

function queueableStatusChecks(track = {}) {
  const checks = Array.isArray(track.statusChecks) ? track.statusChecks : [];
  return [
    "Roon verified",
    track.roon?.queueActionPresumed ? "Queue action resolved when queued" : "Roon queue action ready",
    ...checks.filter((status) => !/^Roon\b/i.test(String(status || "")))
  ];
}

function roonVerificationTimeoutFallback(discovered = {}, requestedCount = 8, error = null) {
  const fallbackTracks = mergeTrackLists(discovered.tracks, discovered.alternates)
    .slice(0, Math.max(1, requestedCount))
    .map((track) => ({
      ...track,
      roon: {
        ...(track.roon || {}),
        verified: false
      },
      statusChecks: [
        "Roon verification timed out",
        "Queue action will be checked when queued",
        ...(Array.isArray(track.statusChecks) ? track.statusChecks.filter((status) => !/^Roon\b/i.test(String(status || ""))) : [])
      ]
    }));
  const discarded = discovered.discarded || [];
  return {
    ...discovered,
    tracks: fallbackTracks,
    alternates: mergeTrackLists(discovered.tracks, discovered.alternates)
      .filter((track) => !fallbackTracks.some((fallback) => candidateIdentityKeys(fallback).some((key) => candidateIdentityKeys(track).includes(key))))
      .slice(0, Math.max(80, requestedCount * 8)),
    discarded,
    verification: {
      ...(discovered.verification || {}),
      roonQueueable: false,
      roonStrict: true,
      roonVerificationError: error?.message || "Roon queue verification took too long.",
      roonVerificationFallback: true,
      kept: fallbackTracks.length,
      generated: fallbackTracks.length + discarded.length,
      discarded: discarded.length
    }
  };
}

function withNormalizedYearFilter(options = {}) {
  const parsed = yearRangeUtil.parseYearRange(options);
  if (!parsed) return options;
  return {
    ...options,
    years: parsed.label
  };
}

function shouldSkipModelForCatalogSearch(options = {}) {
  const parsed = yearRangeUtil.parseYearRange(options);
  if (!parsed) return false;
  const profile = buildDiscoveryProfile(options);
  if (profile.targetGenres?.length) return true;
  const text = normalizeMatchText(`${options.request || ""} ${options.genres || ""} ${options.mood || ""}`);
  return /\b(?:progressive|house|trance|melodic|deep|organic|techno|ambient|disco|synth|new wave|rock|jazz|metal|country|pop|funk|soul|r b|hip hop)\b/.test(text);
}

function strictSearchBudgets(options = {}, requestedCount = 8) {
  const yearRange = yearRangeUtil.parseYearRange(options);
  const minScore = minimumScoreFor(options);
  const strict = Boolean(yearRange || minScore);
  if (!strict) {
    return {
      roonFirstTimeoutMs: 10_000,
      modelTimeoutMs: 30_000,
      discoveryTimeoutMs: 12_000,
      roonQueueTimeoutMs: 10_000
    };
  }

  const catalogMode = shouldSkipModelForCatalogSearch(options);
  return {
    roonFirstTimeoutMs: Math.min(35_000, Math.max(16_000, requestedCount * 1_600)),
    modelTimeoutMs: Math.min(45_000, Math.max(catalogMode ? 30_000 : 25_000, requestedCount * 1_500)),
    discoveryTimeoutMs: catalogMode
      ? Math.min(90_000, Math.max(30_000, requestedCount * 3_500))
      : Math.min(120_000, Math.max(60_000, requestedCount * 5_000)),
    roonQueueTimeoutMs: Math.min(45_000, Math.max(18_000, requestedCount * 1_800))
  };
}

function roonMatchSummary(match = null) {
  if (!match) return null;
  return {
    title: match.title || "",
    subtitle: match.subtitle || "",
    imageKey: match.image_key || "",
    key: match.item_key || "",
    hint: match.hint || ""
  };
}

async function filterForRoonQueueable(result, zoneId, options = {}) {
  if (!zoneId) {
    throw new Error("Select a Roon output zone first. Strict mode requires every TIDAL result to be verified and queueable in Roon.");
  }

  if (!result?.tracks?.length && !result?.alternates?.length) {
    if (result) delete result.alternates;
    return result;
  }

  const yearRange = yearRangeUtil.parseYearRange({ ...options, years: options.years || result.verification?.yearRange || "" });
  const scoringOptions = yearRange ? { ...options, years: yearRange.label } : options;
  const targetCount = Number(result.requestedCount || result.verification?.requested || result.tracks.length);
  const minScore = minimumScoreFor(scoringOptions);
  const strictFilteredRequest = Boolean(yearRange || minScore);
  const pool = [];
  const seen = new Set();
  for (const track of [...(result.tracks || []), ...(result.alternates || [])]) {
    const key = String(track.tidal?.tidalUrl || `${track.artist || ""}|${track.title || ""}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pool.push(track);
  }

  const accepted = [];
  const rejected = [];
  const maxChecks = Math.min(
    pool.length,
    strictFilteredRequest
      ? Math.min(180, Math.max(targetCount + 70, targetCount * 8))
      : Math.min(90, Math.max(targetCount + 36, targetCount * 5))
  );
  let checked = 0;

  for (const track of pool) {
    if (accepted.length >= targetCount) break;
    if (checked >= maxChecks) break;

    if (yearRange) {
      const candidateRange = track.discoveryLane === "recent" && result.verification?.nearYearFallbackRange
        ? yearRangeUtil.parseYearRange({ ...options, years: result.verification.nearYearFallbackRange })
        : yearRange;
      const candidateScoringOptions = candidateRange
        ? { ...options, years: candidateRange.label }
        : scoringOptions;
      const scoringTrack = {
        ...track,
        ...(track.tidal || {}),
        query: track.query || track.roon?.sourceQuery || "",
        roon: track.roon
      };
      const rejection = rejectReason(scoringTrack, candidateScoringOptions);
      if (rejection) {
        rejected.push({
          ...track,
          reason: rejection
        });
        continue;
      }
    }

    if (track.roon?.verified && track.roon?.queueAction) {
      accepted.push({
        ...track,
        statusChecks: queueableStatusChecks(track)
      });
      continue;
    }

    checked += 1;
    try {
      const search = await roon.canQueueTrack(track, zoneId);
      if (search.success) {
        accepted.push({
          ...track,
          roon: {
            verified: true,
            match: roonMatchSummary(search.match),
            queueAction: search.action || ""
          },
          statusChecks: queueableStatusChecks(track)
        });
      } else {
        rejected.push({
          ...track,
          reason: search.reason || `Roon did not find an exact queueable match. Best result was ${search.match?.title || "none"}${search.match?.subtitle ? ` - ${search.match.subtitle}` : ""}.`,
          roon: {
            verified: false,
            match: roonMatchSummary(search.match)
          }
        });
      }
    } catch (error) {
      rejected.push({
        ...track,
        reason: error.message,
        roon: { verified: false }
      });
    }
  }

  const discarded = [...(result.discarded || []), ...rejected];
  const belowMinimumKept = accepted.filter((track) => track.belowMinimum).length;
  const aboveMinimumKept = minScore ? Math.max(0, accepted.length - belowMinimumKept) : accepted.length;
  delete result.alternates;
  return {
    ...result,
    tracks: accepted,
    discarded,
    verification: {
      ...(result.verification || {}),
      roonQueueable: true,
      roonStrict: true,
      yearRange: yearRange?.label || result.verification?.yearRange || "",
      roonChecked: checked,
      roonRejected: rejected.length,
      roonCheckLimit: maxChecks,
      generated: accepted.length + discarded.length,
      kept: accepted.length,
      discarded: discarded.length,
      belowMinimumKept,
      aboveMinimumKept,
      minScoreSoftFallback: Boolean(minScore && belowMinimumKept)
    }
  };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive"
    });
    clients.add(res);
    res.write(`data: ${JSON.stringify(eventPayload())}\n\n`);
    req.on("close", () => clients.delete(res));
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

  if (req.method === "GET" && pathname === "/api/history-report") {
    const baseState = withHqplayerStatus(roon.getState());
    scheduleRadioEnrichment(baseState);
    const state = attachRadioEnrichment(baseState);
    listeningHistory.recordState(state);
    return sendJson(res, 200, listeningHistory.report({
      roonState: state,
      tasteProfile,
      discoveryHistory
    }));
  }

  if (req.method === "GET" && pathname === "/api/roon/playlists") {
    return sendJson(res, 200, await roon.listPlaylists());
  }

  if (req.method === "GET" && pathname === "/api/saved") {
    return sendJson(res, 200, savedPlaylist.snapshot());
  }

  if (req.method === "GET" && pathname === "/api/session") {
    return sendJson(res, 200, sessionStore.read());
  }

  if (req.method === "GET" && pathname === "/api/taste") {
    return sendJson(res, 200, tasteProfile.summary());
  }

  if (req.method === "GET" && pathname === "/api/memory") {
    return sendJson(res, 200, trackMemory.summary());
  }

  if (req.method === "GET" && pathname === "/api/query-yield") {
    return sendJson(res, 200, queryYieldTracker.summary());
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

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  let body = await readJson(req);
  if (pathname === "/api/control") {
    const result = await roon.control(body.zoneId, body.control);
    scheduleBroadcast();
    return sendJson(res, 200, { ok: true, result: result || null });
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
    body = withNormalizedYearFilter(body);
    body.scoringMode = normalizeScoringMode(body);
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
    const budgets = strictSearchBudgets(effectiveBody, requestedCount);
    const roonFirst = { tracks: [], alternates: [], discarded: [], verification: {} };
    const lastFmHistoryPromise = lastFmHistoryForDiscovery();
    let roonFirstError = "";
    let modelResult = null;
    let modelError = "";
    let modelSkipped = "";

    if (catalogSearchMode) {
      modelSkipped = "Catalog-style search; using deterministic TIDAL/Roon discovery for planning, then model review on verified candidates.";
      modelResult = { plan: null };
    } else {
      try {
        modelResult = await withTimeout(
          generateSearchPlan(config, effectiveBody),
          budgets.modelTimeoutMs,
          "The local model took too long to answer."
        );
      } catch (error) {
        modelError = error.message;
        modelResult = { plan: null };
      }
    }

    const searchBody = {
      ...effectiveBody,
      llmSearchPlan: modelResult?.plan || null,
      llmCandidates: []
    };
    const searchProfile = buildDiscoveryProfile(searchBody);

    roonFirstError = body.zoneId
      ? "Roon-first discovery disabled. TIDAL generates candidates; Roon verifies queueability after scoring."
      : "No Roon output zone selected. Roon verification requires a zone.";

    const scrobbleHistory = await lastFmHistoryPromise;
    let discovered = null;
    try {
      discovered = await withTimeout(
        discoverTracks({
          tidal,
          options: searchBody,
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
      modelProvider: config.llmProvider,
      modelName: config.llmProvider === "openrouter"
        ? config.openRouterModel
        : (OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider)
          ? config.openAiCompatibleModel
          : config.ollamaModel),
      modelSkipped,
      roonFirstKept: roonFirst.tracks.length,
      roonFirstError,
      roonFirstSearches: roonFirst.verification?.searches || 0,
      roonFirstCandidates: roonFirst.verification?.candidates || 0,
      roonFirstSearchSummaries: roonFirst.verification?.searchSummaries || [],
      roonFirstDiscarded: roonFirst.discarded?.length || 0,
      roonFirstDefault: false,
      tidalDirectFallback: false,
      strategy: "tidal-catalog-first-roon-verified"
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
    let result = null;
    try {
      result = await withTimeout(
        filterForRoonQueueable(discovered, body.zoneId, searchBody),
        budgets.roonQueueTimeoutMs,
        "Roon queue verification took too long."
      );
    } catch (error) {
      result = roonVerificationTimeoutFallback(discovered, requestedCount, error);
    }
    discoveryHistory.record(result.tracks || []);
    trackMemory.record([...(result.tracks || []), ...(result.alternates || [])]);
    sessionStore.save(body, result);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/rabbit-hole") {
    const graph = await rabbitHoleGraph.build(body.track || {}, {
      config,
      tidal,
      discoveryHistory,
      trackMemory,
      savedPlaylist,
      tasteProfile,
      contextTracks: body.contextTracks || []
    }, {
      force: Boolean(body.force)
    });
    return sendJson(res, 200, graph);
  }
  if (pathname === "/api/feedback") {
    const rating = normalizeRating(body.rating);
    const feedbackTrack = feedbackTrackWithSessionContext(body.track || {});
    const result = tasteProfile.record(feedbackTrack, rating, feedbackCalibrationContext(feedbackTrack));
    sessionStore.updateFeedback(feedbackTrack, rating);
    trackMemory.updateFeedback(feedbackTrack, rating);
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/roon/playlist-tracks") {
    return sendJson(res, 200, await roon.loadPlaylistTracks(body.itemKey, body.title));
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
    const tracks = [...primary.map((track) => ({ track, isAlternate: false })), ...alternates.map((track) => ({ track, isAlternate: true }))];
    const queueable = [];
    const failed = [];

    for (const [index, request] of tracks.entries()) {
      if (queueable.length >= targetCount) break;
      const { track, isAlternate } = request;
      try {
        const result = await roon.canQueueTrack(track, body.zoneId);
        if (result.success) {
          queueable.push({
            index,
            track,
            isAlternate,
            action: result.action || "",
            match: roonMatchSummary(result.match)
          });
        } else {
          failed.push({
            index,
            track,
            isAlternate,
            reason: result.reason || "No usable queue action.",
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
  if (pathname === "/api/roon/queue-tracks") {
    const result = await roon.queueTracks(body.tracks || [], body.zoneId, {
      mode: body.mode || "append",
      alternates: body.alternates || [],
      targetCount: body.targetCount
    });
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/add") {
    const result = savedPlaylist.add(body.track || {}, body.listId || body.list_id || "");
    if (result.added && typeof tasteProfile.recordCandidate === "function") {
      result.taste = tasteProfile.recordCandidate(result.track || body.track || {});
    }
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/remove") {
    const result = savedPlaylist.remove(body.key, body.listId || body.list_id || "");
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/move") {
    const result = savedPlaylist.move(body.key, body.fromListId || body.from_list_id || "", body.toListId || body.to_list_id || "");
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/list/select") {
    const result = savedPlaylist.select(body.listId || body.list_id || "");
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/list/create") {
    const result = savedPlaylist.create(body.name || "");
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/list/rename") {
    const result = savedPlaylist.rename(body.listId || body.list_id || "", body.name || "");
    scheduleBroadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/list/delete") {
    const result = savedPlaylist.delete(body.listId || body.list_id || "");
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
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
});
