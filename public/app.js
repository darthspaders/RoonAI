"use strict";

const TIDAL_PLAYLIST_CACHE_KEY = "rabbitHole.tidalPlaylists.v1";
const TIDAL_PLAYLIST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cleanCachedPlaylistText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCachedTidalPlaylist(playlist = {}) {
  const id = cleanCachedPlaylistText(playlist.id);
  const title = cleanCachedPlaylistText(playlist.title || playlist.name);
  if (!id || !title) return null;
  return {
    id,
    title,
    itemCount: Number(playlist.itemCount || playlist.numberOfItems || 0) || 0,
    url: cleanCachedPlaylistText(playlist.url || playlist.tidalUrl || ""),
    rawType: cleanCachedPlaylistText(playlist.rawType || playlist.type || "playlist"),
    description: cleanCachedPlaylistText(playlist.description || "")
  };
}

function readCachedTidalPlaylists() {
  try {
    const payload = JSON.parse(localStorage.getItem(TIDAL_PLAYLIST_CACHE_KEY) || "null");
    const cachedAt = Number(payload?.cachedAt || 0);
    const playlists = Array.isArray(payload?.playlists)
      ? payload.playlists.map(normalizeCachedTidalPlaylist).filter(Boolean)
      : [];
    if (!cachedAt || !playlists.length) return { playlists: [], cachedAt: 0, fresh: false };
    return {
      playlists,
      cachedAt,
      fresh: Date.now() - cachedAt < TIDAL_PLAYLIST_CACHE_TTL_MS
    };
  } catch {
    return { playlists: [], cachedAt: 0, fresh: false };
  }
}

const cachedTidalPlaylists = readCachedTidalPlaylists();

const state = {
  zones: [],
  selectedZoneId: localStorage.getItem("zoneId") || "",
  lastTracks: [],
  displayedTracks: [],
  lastResult: null,
  playlists: [],
  roonPlaylistsLoaded: false,
  roonPlaylistsLoading: false,
  roonPlaylistsError: "",
  roonPlaylistsWarning: "",
  playlistSeedTracks: [],
  playlistBrowserStatus: "",
  feedbackByKey: {},
  calibration: null,
  calibrationVersion: "",
  appUpdatedAt: "",
  sessionUpdatedAt: "",
  tasteUpdatedAt: "",
  feedbackVersion: "",
  memory: null,
  standby: null,
  standbyTracks: [],
  historyReport: null,
  historyNeedsRefresh: true,
  musicMemory: null,
  musicMemoryTracks: [],
  musicMemoryNeedsRefresh: true,
  musicMemoryLoading: false,
  musicMemoryOffset: 0,
  musicMemoryLimit: 50,
  musicMemoryQuery: "",
  musicMemoryBeatportFilter: "",
  musicMemoryFeedbackFilter: "",
  beatportChart: null,
  beatportChartTracks: [],
  beatportChartLoading: false,
  beatportChartNeedsRefresh: true,
  beatportChartId: localStorage.getItem("beatportChartId") || "901032",
  tidalMixes: null,
  tidalVisibleMixes: [],
  tidalMixesNeedsRefresh: true,
  radioStations: [],
  radioStationsLoaded: false,
  radioStationsLoading: false,
  radioStationsError: "",
  radioStationsSession: "",
  radioBrowseHierarchy: "",
  radioBrowseTitle: "",
  radioBrowseItemKey: "",
  tidalPlaylists: cachedTidalPlaylists.playlists,
  tidalPlaylistsLoaded: Boolean(cachedTidalPlaylists.playlists.length),
  tidalPlaylistsLoading: false,
  tidalPlaylistsError: "",
  tidalPlaylistsWarning: "",
  tidalPlaylistsFromCache: Boolean(cachedTidalPlaylists.playlists.length),
  tidalPlaylistsCacheAt: cachedTidalPlaylists.cachedAt || 0,
  selectedTidalPlaylistId: localStorage.getItem("tidalPlaylistId") || "",
  extraTidalPlaylistIds: [localStorage.getItem("tidalPlaylistId2") || "", localStorage.getItem("tidalPlaylistId3") || ""],
  nowTidalPlaylistArmed: [
    localStorage.getItem("tidalPlaylistArmed1") !== "false",
    localStorage.getItem("tidalPlaylistArmed2") === "true",
    localStorage.getItem("tidalPlaylistArmed3") === "true"
  ],
  nowTidalAddBusy: false,
  selectedTidalSeedPlaylistId: localStorage.getItem("tidalSeedPlaylistId") || "",
  tidalPlaylistSeedTracks: [],
  appStatus: null,
  connectionStatus: { connected: false, coreName: "" },
  nowTrack: null,
  nowTrackSource: "",
  nowQualityKey: "",
  nowQualityLoading: false,
  nowQualityInfo: null,
  nowQualityCache: {},
  nowMatchIndex: -1,
  rabbitHoleGraph: null,
  rabbitHoleKey: "",
  isSeeking: false,
  playerMaximized: localStorage.getItem("playerMaximized") === "1",
  llmStatus: null,
  modelStatus: null,
  pcMonitor: null,
  pcMonitorError: "",
  pcMonitorLoading: false,
  bridgeSyncAlertId: "",
  rejectedDebugOpen: false,
  resultArtistConfirmedOnly: false
};

const $ = (selector) => document.querySelector(selector);

const TIDAL_RADIO_RECENT_KEY = "rabbitHole.tidalRadioRecent.v1";
const TIDAL_RADIO_RECENT_TTL_MS = 24 * 60 * 60 * 1000;
const TIDAL_RADIO_RECENT_MAX = 160;
const RADIO_STATION_ORDER_KEY = "rabbitHole.radioStationOrder.v1";

function writeCachedTidalPlaylists(playlists = []) {
  const clean = (Array.isArray(playlists) ? playlists : [])
    .map(normalizeCachedTidalPlaylist)
    .filter(Boolean);
  if (!clean.length) {
    try {
      localStorage.removeItem(TIDAL_PLAYLIST_CACHE_KEY);
      state.tidalPlaylistsCacheAt = 0;
    } catch {
      // Best-effort UI cache only.
    }
    return;
  }
  const cachedAt = Date.now();
  try {
    localStorage.setItem(TIDAL_PLAYLIST_CACHE_KEY, JSON.stringify({
      cachedAt,
      playlists: clean
    }));
    state.tidalPlaylistsCacheAt = cachedAt;
  } catch {
    // Best-effort UI cache only.
  }
}

let lastRabbitStatusAt = 0;
let eventSourceOfflineTimer = null;
let rabbitRecoveryTimer = null;
let radioDrag = null;
let radioMoveIndex = -1;
let suppressNextRadioClick = false;
let screenWakeLock = null;
let screenWakeLockDesired = false;
let screenWakeLockPending = null;
let pcMonitorTimer = null;
const PC_MONITOR_POLL_MS = 5000;
const RABBIT_RECOVERY_REFRESH_MS = 1500;
let bridgeSyncRetry = null;
const screenWakeFallback = {
  video: null,
  stream: null,
  timer: null,
  canvas: null,
  flip: false
};

function setScoringMode(value = "") {
  const normalized = ["pure", "explore", "similar"].includes(String(value || "")) ? String(value || "") : "";
  const input = $("#scoringMode") || document.querySelector("[name='scoringMode']");
  if (input) input.value = normalized;

  document.querySelectorAll("[data-scoring-mode]").forEach((button) => {
    const active = String(button.dataset.scoringMode || "") === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function moveScoringModeSelection(currentButton, direction) {
  const buttons = Array.from(document.querySelectorAll("[data-scoring-mode]"));
  if (!buttons.length) return;
  const currentIndex = Math.max(0, buttons.indexOf(currentButton));
  const nextButton = buttons[(currentIndex + direction + buttons.length) % buttons.length];
  setScoringMode(nextButton.dataset.scoringMode || "");
  nextButton.focus();
}

const SCORE_MAX = {
  freshness: 19,
  labelMatch: 19,
  artistMatch: 19,
  lengthPreference: 19,
  genreMatch: 24
};

function zonePlaybackState(zone = {}) {
  return String(zone?.state || "").toLowerCase();
}

function zonePlaybackStopped(zone = {}) {
  return ["stopped", "disconnected"].includes(zonePlaybackState(zone));
}

function zonePlaybackPlaying(zone = {}) {
  return zonePlaybackState(zone) === "playing";
}

function currentZoneNowPlaying(zone = {}) {
  return zonePlaybackStopped(zone) ? null : zone?.now_playing;
}

function zoneHasCurrentNowPlaying(zone = {}) {
  return Boolean(!zonePlaybackStopped(zone) && currentZoneNowPlaying(zone));
}

function activeZone() {
  const selected = state.zones.find((zone) => zone.zone_id === state.selectedZoneId) || null;
  if (selected && zoneHasCurrentNowPlaying(selected)) return selected;
  const playing = state.zones.find((zone) => zonePlaybackPlaying(zone) && zoneHasCurrentNowPlaying(zone));
  return playing || selected || state.zones.find((zone) => !zonePlaybackStopped(zone)) || state.zones[0] || null;
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

function safeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function summarizeNowPlaying(zone) {
  const now = currentZoneNowPlaying(zone);
  if (!now) return null;
  const enriched = now.radio_enrichment;
  const radioLookup = now.radio_lookup;
  if (radioLookup?.title && radioLookup?.artist) {
    return {
      title: radioLookup.title,
      artist: radioLookup.artist,
      album: enriched?.album || radioLookup.album || ""
    };
  }
  if (enriched?.title && enriched?.artist) {
    return {
      title: enriched.title,
      artist: enriched.artist,
      album: enriched.album || now.three_line?.line3 || ""
    };
  }

  return {
    title: now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1 || "",
    artist: now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2 || "",
    album: now.three_line?.line3 || ""
  };
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripVersionText(value) {
  return String(value || "")
    .replace(/\s*[\[(][^)\]]*\b(?:remix|mix|rework|rerub|dub|edit|version)\b[^)\]]*[\])]/gi, "")
    .trim();
}

function splitMatchArtists(value) {
  return String(value || "")
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map(normalizeMatchText)
    .filter((part) => part && part.length > 1);
}

function titleMatchesNow(trackTitle, nowTitle) {
  const track = normalizeMatchText(trackTitle);
  const now = normalizeMatchText(nowTitle);
  const trackBase = normalizeMatchText(stripVersionText(trackTitle));
  const nowBase = normalizeMatchText(stripVersionText(nowTitle));
  if (!track || !now) return false;
  return track === now ||
    now.includes(track) ||
    track.includes(now) ||
    (trackBase && nowBase && (trackBase === nowBase || nowBase.includes(trackBase) || trackBase.includes(nowBase)));
}

function artistMatchesNow(trackArtist, nowArtist) {
  const trackArtists = splitMatchArtists(trackArtist);
  const nowArtists = splitMatchArtists(nowArtist);
  if (!trackArtists.length || !nowArtists.length) return false;
  return trackArtists.some((artist) => nowArtists.some((now) => now === artist || now.includes(artist) || artist.includes(now)));
}

function trackMatchesNow(track, now) {
  return Boolean(track && now?.title && titleMatchesNow(track.title, now.title) && artistMatchesNow(track.artist, now.artist));
}

function radioArtworkKeyFor(value = {}) {
  const artist = normalizeMatchText(value.artist || "");
  const title = normalizeMatchText(value.title || "");
  return artist && title ? `${artist}|${title}` : "";
}

function trustedRadioArtworkUrl(now = {}) {
  const lookup = now?.radio_lookup || null;
  const enrichment = now?.radio_enrichment || null;
  if (!lookup || !enrichment?.imageUrl) return "";

  const currentKey = radioArtworkKeyFor(lookup);
  const enrichmentKey = String(enrichment.radioTrackKey || enrichment.key || radioArtworkKeyFor(enrichment.lookup || enrichment)).trim();
  if (!currentKey || !enrichmentKey || currentKey !== enrichmentKey) return "";
  if (enrichment.radioArtworkResolved === false) return "";
  return enrichment.sourceImageUrl || enrichment.imageUrl;
}

function cleanRadioStationGenre(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const match = text.match(/^(.+?)\s*-\s*DI\.?FM(?:\s+Premium)?$/i)
    || text.match(/^(.+?)\s+DI\.?FM(?:\s+Premium)?$/i);
  if (!match) return "";
  const genre = match[1]
    .replace(/\b(?:premium|radio|station|channel|stream)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!genre || isAudioQualityGenreTag(genre)) return "";
  if (/^progressive$/i.test(genre)) return "Progressive House";
  return genre;
}

function radioStationGenre(rawNow = {}, zone = {}) {
  const candidates = [
    rawNow.two_line?.line1,
    rawNow.three_line?.line1,
    rawNow.one_line?.line1,
    rawNow.radio_lookup?.station,
    zone.display_name
  ];
  for (const candidate of candidates) {
    const genre = cleanRadioStationGenre(candidate);
    if (genre) return genre;
  }
  return "";
}

function withLocalFeedback(track = null) {
  if (!track) return null;
  const feedback = feedbackForTrack(track);
  return feedback && !track.feedback ? { ...track, feedback } : track;
}

function nowPlayingTrack(zone = activeZone()) {
  const now = summarizeNowPlaying(zone);
  if (!now?.title) return null;
  const rawNow = currentZoneNowPlaying(zone);
  const enriched = rawNow?.radio_enrichment;
  const metadataEnrichment = rawNow?.metadata_enrichment;
  const output = hqplayerOutputForZone(zone);
  const hqSource = hqplayerStatusFor(zone, output || {})?.source || null;
  const isRadio = Boolean(rawNow?.radio_lookup);
  const isLiveRadio = isRadio || isLiveRadioZone(zone);
  const roonDurationMs = rawNow?.length ? Number(rawNow.length) * 1000 : null;
  const roonImageUrl = rawNow?.image_key
    ? `/api/roon/image/${encodeURIComponent(rawNow.image_key)}?width=360&height=360`
    : "";
  const enrichedImageUrl = enriched?.sourceImageUrl || enriched?.imageUrl || "";
  const metadataImageUrl = metadataEnrichment?.sourceImageUrl || metadataEnrichment?.imageUrl || "";
  const imageUrl = isRadio
    ? (metadataImageUrl || trustedRadioArtworkUrl(rawNow) || roonImageUrl)
    : (roonImageUrl || enrichedImageUrl || metadataImageUrl || "");
  return withLocalFeedback({
    artist: now.artist || "Unknown artist",
    title: now.title,
    album: now.album || enriched?.album || metadataEnrichment?.album || "",
    durationMs: roonDurationMs || enriched?.durationMs || metadataEnrichment?.durationMs || null,
    label: enriched?.label || metadataEnrichment?.label || "",
    genre: enriched?.genre || metadataEnrichment?.genre || radioStationGenre(rawNow, zone),
    year: enriched?.year || metadataEnrichment?.releaseYear || metadataEnrichment?.year || null,
    releaseYear: enriched?.year || metadataEnrichment?.releaseYear || metadataEnrichment?.year || null,
    releaseDate: enriched?.releaseDate || metadataEnrichment?.releaseDate || "",
    metadataEnrichment: metadataEnrichment || null,
    tidal: enriched || null,
    tidalUrl: enriched?.tidalUrl || metadataEnrichment?.tidalUrl || "",
    isRadio,
    isLiveRadio,
    sourceType: isLiveRadio ? "radio" : "roon",
    playbackSource: hqSource ? {
      display: hqSource.display || "",
      codec: hqSource.codec || "",
      sampleRateKhz: hqSource.sampleRateKhz || null,
      bitDepth: hqSource.bitDepth || null,
      channels: hqSource.channels || null,
      bitrate: hqSource.bitrate || null,
      sourceName: hqSource.sourceName || ""
    } : null,
    imageUrl,
    discoverySource: "Now playing",
    statusChecks: ["Now playing in Roon"],
    roon: {
      verified: true,
      match: {
        title: now.title,
        subtitle: now.artist || ""
      }
    }
  });
}

function rabbitHoleContextTracks(zone = activeZone()) {
  const items = displayQueueItems(zone);
  return items.slice(0, 50).map((item) => {
    const subtitleParts = String(item.subtitle || "").split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    return {
      title: item.title || "",
      artist: subtitleParts[0] || item.subtitle || "",
      album: item.album || subtitleParts.slice(1).join(" - ") || "",
      durationMs: item.length ? Number(item.length) * 1000 : null,
      source: "Roon live queue"
    };
  }).filter((track) => track.title && track.artist);
}

function findNowPlayingMatch(zone = activeZone()) {
  const now = summarizeNowPlaying(zone);
  const fallback = nowPlayingTrack(zone);
  if (!now?.title) return { index: -1, track: null, source: "" };

  function withLiveNowPlayingMedia(track) {
    const localTrack = withLocalFeedback(track);
    if (!localTrack || !fallback) return localTrack;
    return {
      ...localTrack,
      album: fallback.album || localTrack.album || "",
      durationMs: fallback.durationMs || localTrack.durationMs || null,
      imageUrl: fallback.imageUrl || localTrack.imageUrl || "",
      tidal: localTrack.tidal || fallback.tidal || null,
      tidalUrl: localTrack.tidalUrl || fallback.tidalUrl || "",
      isRadio: fallback.isRadio || localTrack.isRadio || false,
      isLiveRadio: fallback.isLiveRadio || localTrack.isLiveRadio || false,
      sourceType: fallback.sourceType || localTrack.sourceType || "",
      playbackSource: fallback.playbackSource || localTrack.playbackSource || null
    };
  }

  const index = state.lastTracks.findIndex((track) => trackMatchesNow(track, now));
  if (index >= 0) return { index, track: withLiveNowPlayingMedia(state.lastTracks[index]), source: "current" };

  if (zone?.memoryTrack && trackMatchesNow(zone.memoryTrack, now)) {
    return { index: -1, track: withLiveNowPlayingMedia(zone.memoryTrack), source: "memory" };
  }

  return { index: -1, track: fallback, source: "now" };
}

function formatDuration(durationMs) {
  const seconds = Math.round(Number(durationMs || 0) / 1000);
  return formatSeconds(seconds);
}

function formatHours(seconds) {
  const hours = Number(seconds || 0) / 3600;
  if (!hours) return "0 h";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatQueueSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  if (!seconds) return "";
  if (seconds < 3600) return formatSeconds(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${remainder}`;
}

function formatHealthSeconds(value) {
  const seconds = Math.ceil(Number(value || 0) / 1000);
  if (!seconds) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatHealthTimeout(value) {
  const ms = Number(value || 0);
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms timeout`;
  return `${Math.round(ms / 100) / 10}s timeout`;
}

function providerHealthClass(level) {
  if (level === "bad") return "healthBad";
  if (level === "warn") return "healthWarn";
  if (level === "unknown") return "healthUnknown";
  return "healthOk";
}

function circuitHealth(provider = {}, options = {}) {
  const circuit = provider.circuit || provider.tidalCircuit || {};
  const configured = provider.configured !== undefined ? Boolean(provider.configured) : true;
  const enabled = provider.enabled !== false;
  const stateLabel = String(circuit.state || "unknown");
  const failures = Number(circuit.failureCount || 0);
  const threshold = Number(circuit.failureThreshold || 0);
  const retryAfterMs = Number(circuit.retryAfterMs || 0);
  const timeoutText = formatHealthTimeout(provider.timeoutMs || provider.tidalTimeoutMs);
  const lastError = String(circuit.lastError || "").trim();

  if (!enabled) {
    return { level: "unknown", status: "disabled", detail: timeoutText || "not active" };
  }
  if (!configured) {
    return { level: "warn", status: "not configured", detail: "missing credentials" };
  }
  if (stateLabel === "open") {
    return {
      level: "bad",
      status: `backing off for ${formatHealthSeconds(retryAfterMs)}`,
      detail: lastError || timeoutText || "repeated fetch failures"
    };
  }
  if (stateLabel === "half-open") {
    return {
      level: "warn",
      status: "retrying after backoff",
      detail: lastError || timeoutText || "checking recovery"
    };
  }
  if (failures > 0) {
    return {
      level: "warn",
      status: `${failures}${threshold ? `/${threshold}` : ""} recent failures`,
      detail: lastError || timeoutText || "watching TIDAL"
    };
  }
  return {
    level: "ok",
    status: options.readyText || "ready",
    detail: timeoutText || "healthy"
  };
}

function llmHealthSummary(app = {}) {
  const status = state.llmStatus || {};
  const llm = app.llm || {};
  const label = status.label || llm.label || "Local model";
  const model = status.model || llm.model || "";
  const detail = [label, model].filter(Boolean).join(" ");
  if (status.online && status.loaded !== false) return { level: "ok", status: "ready", detail };
  if (status.checking) return { level: "unknown", status: "checking", detail };
  if (status.reachable && status.loaded === false) {
    const loading = status.runtimeState === "loading" || /loading/i.test(status.message || "");
    return { level: "warn", status: loading ? "model loading" : "model not loaded", detail: status.message || detail };
  }
  if (state.llmStatus) return { level: "bad", status: "offline", detail: status.message || detail };
  return { level: "unknown", status: "not checked yet", detail };
}

function synapseHealthSummary(app = {}) {
  const status = state.modelStatus?.ai?.synapse || app.ai?.synapse || {};
  const stateLabel = String(status.state || "").toLowerCase();
  const selectedTier = status.selectedTier || app.ai?.selectedTier || "";
  const tier = status.tiers?.[selectedTier] || null;
  const model = tier?.model || status.model || "";
  const tierLabel = tier?.label || selectedTier;
  if (status.enabled === false) return { level: "unknown", status: "disabled", detail: "OPENAI_ENABLED=false" };
  if (!status.apiKeyConfigured && !status.configured) return { level: "warn", status: "not configured", detail: "OPENAI_API_KEY missing" };
  if (stateLabel === "checking") return { level: "unknown", status: "checking", detail: model || "checking OpenAI" };
  if (stateLabel === "authentication_error") return { level: "bad", status: "authentication error", detail: status.lastError || "check OPENAI_API_KEY" };
  if (stateLabel === "rate_limited") return { level: "warn", status: "rate limited", detail: status.lastError || model };
  if (stateLabel === "budget_limit_reached") return { level: "warn", status: "budget limit reached", detail: "using local fallback" };
  if (stateLabel === "disconnected") return { level: "bad", status: "disconnected", detail: status.lastError || "OpenAI unreachable" };
  if (stateLabel === "api_error") return { level: "bad", status: "API error", detail: status.lastError || model };
  if (status.connected || stateLabel === "connected") return { level: "ok", status: "connected", detail: model ? `Synapse ${tierLabel ? `${tierLabel} - ` : "- "}${model}` : "OpenAI reachable" };
  return { level: "unknown", status: "unknown", detail: model || "not checked yet" };
}

function synapseTierLabel(tier = "") {
  const key = String(tier || "").toLowerCase();
  return ({ luna: "Luna", terra: "Terra", sol: "Sol" })[key] || tier;
}

function synapseTierOption(value = "") {
  const key = String(value || "").toLowerCase();
  return ["luna", "terra", "sol"].includes(key) ? key : "";
}

function compactInteger(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat().format(Math.round(number));
}

function formatUsd(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "$0";
  return `$${number.toFixed(number < 0.01 ? 4 : 2)}`;
}

function renderSynapseUsageStatus(ai = {}) {
  const pill = $("#synapseUsageStatus");
  if (!pill) return;
  const usage = ai.synapse?.usage || {};
  const byTier = usage.byTier || {};
  const tierKeys = ["luna", "terra", "sol"];
  const summaries = tierKeys.map((tier) => {
    const item = byTier[tier]?.session || {};
    return `${synapseTierLabel(tier)[0]} ${compactInteger(item.calls || 0)}`;
  });
  const sessionCost = usage.session?.costUsd ?? 0;
  const todayCost = usage.todayCostUsd ?? usage.today?.costUsd ?? 0;
  pill.classList.remove("statusOffline", "statusWarn", "statusGood", "statusUnknown");
  pill.classList.add(ai.synapse?.enabled ? "statusGood" : "statusUnknown");
  pill.textContent = `Synapse usage: ${summaries.join(" / ")} - ${formatUsd(sessionCost)}`;
  pill.title = tierKeys.map((tier) => {
    const item = byTier[tier] || {};
    const session = item.session || {};
    const today = item.today || {};
    const month = item.month || {};
    return [
      `${synapseTierLabel(tier)} session: ${compactInteger(session.calls)} calls, in ${compactInteger(session.inputTokens)}, cached ${compactInteger(session.cachedInputTokens)}, out ${compactInteger(session.outputTokens)}, ${formatUsd(session.costUsd)}`,
      `${synapseTierLabel(tier)} today: ${compactInteger(today.calls)} calls, ${formatUsd(today.costUsd)}`,
      `${synapseTierLabel(tier)} month: ${compactInteger(month.calls)} calls, ${formatUsd(month.costUsd)}`
    ].join("\n");
  }).join("\n\n") + `\n\nTotal today: ${formatUsd(todayCost)}`;
}

function mcpHealthSummary(app = {}) {
  const mcp = app.mcp || {};
  if (mcp.connected === false) return { level: "bad", status: "offline", detail: "MCP endpoint unavailable" };
  if (mcp.connected) return { level: "ok", status: "connected", detail: `${mcp.endpoint || "/mcp"} - ${mcp.toolCount || 0} tools` };
  return { level: "unknown", status: "checking", detail: "/mcp" };
}

function lastFmHealthSummary(app = {}) {
  const lastfm = app.lastfm || {};
  if (lastfm.enabled === false) return { level: "unknown", status: "disabled", detail: "Last.fm lookup off" };
  if (!lastfm.apiKeyConfigured) return { level: "warn", status: "API key missing", detail: "taste history unavailable" };
  if (!lastfm.usernameConfigured) return { level: "warn", status: "username missing", detail: "scrobble history unavailable" };
  if (lastfm.usernameValid === false) return { level: "bad", status: "username invalid", detail: "check LASTFM_USERNAME" };
  if (lastfm.configured) return { level: "ok", status: "connected", detail: "taste history available" };
  return { level: "unknown", status: "not checked", detail: "waiting for status" };
}

function tidalProfileMixesHealthSummary(app = {}) {
  const mixes = app.tidalProfileMixes || {};
  if (mixes.enabled === false) return { level: "unknown", status: "disabled", detail: "profile mixes off" };
  if (!mixes.configured) return { level: "warn", status: "profile token missing", detail: "personal mixes unavailable" };
  const circuit = mixes.circuit || {};
  if (circuit.state === "open") return { level: "bad", status: "backing off", detail: circuit.lastError || "profile fetch failed" };
  if (circuit.state === "half-open") return { level: "warn", status: "retrying", detail: circuit.lastError || "checking recovery" };
  if (mixes.lastError) return { level: "warn", status: "last fetch empty", detail: mixes.lastError };
  return { level: "ok", status: "ready", detail: "personal mixes available" };
}

function healthCardHtml(item = {}) {
  const level = providerHealthClass(item.level);
  return `
    <article class="healthCard ${level}">
      <div>
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.status || "")}</strong>
      </div>
      <small>${escapeHtml(item.detail || "")}</small>
    </article>
  `;
}

function renderSystemHealth() {
  const container = $("#systemHealth");
  if (!container) return;
  const app = state.appStatus || {};
  const connection = state.connectionStatus || {};
  const roon = connection.connected
    ? { level: "ok", label: "Roon", status: "connected", detail: connection.coreName || "Core ready" }
    : { level: "bad", label: "Roon", status: "not connected", detail: "extension not linked" };
  const tidal = circuitHealth(app.tidal || {}, { readyText: "ready" });
  const radioTidal = circuitHealth(app.radioMetadata || {}, { readyText: "ready" });
  const llm = llmHealthSummary(app);
  const synapse = synapseHealthSummary(app);
  const mcp = mcpHealthSummary(app);
  const lastfm = lastFmHealthSummary(app);
  const tidalProfile = tidalProfileMixesHealthSummary(app);
  const updatedAt = app.updatedAt ? `Updated ${formatDateTime(Date.parse(app.updatedAt))}` : "";

  container.innerHTML = `
    <div class="systemHealthHead">
      <span>System Health</span>
      ${updatedAt ? `<small>${escapeHtml(updatedAt)}</small>` : ""}
    </div>
    <div class="healthGrid">
      ${healthCardHtml(roon)}
      ${healthCardHtml({ label: "TIDAL Search", ...tidal })}
      ${healthCardHtml({ label: "Radio Art TIDAL", ...radioTidal })}
      ${healthCardHtml({ label: "TIDAL Profile", ...tidalProfile })}
      ${healthCardHtml({ label: "Local Model", ...llm })}
      ${healthCardHtml({ label: "Rabbit Hole MCP", ...mcp })}
      ${healthCardHtml({ label: "Synapse", ...synapse })}
      ${healthCardHtml({ label: "Last.fm", ...lastfm })}
    </div>
  `;
}

function isLiveRadioZone(zone = {}) {
  if (zonePlaybackStopped(zone)) return false;
  const now = currentZoneNowPlaying(zone) || {};
  if (Number(now.length || 0) > 0) return false;
  if (zone?.is_seek_allowed) return false;
  const text = [
    zone?.display_name,
    now.two_line?.line1,
    now.two_line?.line2,
    now.three_line?.line1,
    now.three_line?.line2
  ].filter(Boolean).join(" ");
  return /\b(?:di\.?fm|fm|radio|station|stream|live|premium)\b/i.test(text);
}

function queueRemainingCount(zone = {}, fallback = 0) {
  if (zone?.queue_items_remaining !== undefined && zone?.queue_items_remaining !== null) {
    const value = Number(zone.queue_items_remaining);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return Math.max(0, fallback);
}

function formatQueueInfo(zone) {
  if (isLiveRadioZone(zone)) return "Live radio - no fixed end";
  const queueItems = displayQueueItems(zone).length;
  const count = queueRemainingCount(zone, queueItems);
  const remaining = Math.max(0, Number(zone?.queue_time_remaining || 0));
  const time = formatQueueSeconds(remaining);
  if (count > 0 && time) return `${count} queued - ${time} left`;
  if (count > 0) return `${count} queued`;
  if (time) return `${time} remaining`;
  return "";
}

function formatDateTime(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatVolume(volume) {
  if (!volume) return "No volume control";
  if (volume.value === undefined || volume.value === null) return volume.is_muted ? "Muted" : "Step volume";
  return `${volume.value}${volume.unit || ""}${volume.is_muted ? " muted" : ""}`;
}

function isHqPlayerOutput(zone, output) {
  return /hqplayer/i.test(`${zone?.display_name || ""} ${output?.display_name || ""}`);
}

function hqplayerStatusFor(zone, output) {
  return output?.hqplayer || zone?.hqplayer || {};
}

function hqplayerOutputForZone(zone = {}) {
  return (zone.outputs || []).find((output) => isHqPlayerOutput(zone, output)) || null;
}

function hqplayerInlineSignal(zone = {}) {
  const output = hqplayerOutputForZone(zone);
  if (!output && !/hqplayer/i.test(zone?.display_name || "")) return "";
  const status = hqplayerStatusFor(zone, output || {});
  const filter = status.filter || "";
  const rate = [status.format, status.rate].filter(Boolean).join(" ");
  return [filter, rate].filter(Boolean).join(" ") || status.signalPath || "";
}

function zoneDisplayLabel(zone = {}) {
  const name = zone.display_name || "Unknown zone";
  const signal = hqplayerInlineSignal(zone);
  return signal ? `${name} ${signal}` : name;
}

function hqplayerSignalHtml(zone, output) {
  const status = hqplayerStatusFor(zone, output);
  const filter = status.filter || "";
  const rate = [status.format, status.rate].filter(Boolean).join(" ");
  const signalPath = status.signalPath || "";

  return `
    <div class="outputMain hqOutputMain">
      <strong>HQPlayer current filter and rate</strong>
      <div class="hqSignalRows">
        <p><span>Filter</span><b>${escapeHtml(filter || signalPath || "Waiting for HQPlayer filter")}</b></p>
        <p><span>Rate</span><b>${escapeHtml(rate || "Waiting for live rate")}</b></p>
      </div>
      ${signalPath && signalPath !== filter ? `<p class="muted hqSignalPath">${escapeHtml(signalPath)}</p>` : ""}
    </div>
  `;
}

function queueItemMatchesNow(item = {}, now = {}) {
  if (!item?.title || !now?.title) return false;
  const itemArtist = String(item.subtitle || "").split(/\s+-\s+/)[0] || item.subtitle || "";
  return titleMatchesNow(item.title, now.title) && artistMatchesNow(itemArtist, now.artist);
}

function displayQueueItems(zone = {}) {
  const items = Array.isArray(zone?.queue?.items) ? zone.queue.items : [];
  const now = summarizeNowPlaying(zone);
  if (!now?.title) return items;
  return items.filter((item) => !queueItemMatchesNow(item, now));
}

function liveQueueHtml(zone = {}) {
  const queue = zone.queue || {};
  const rawItems = Array.isArray(queue.items) ? queue.items : [];
  const items = displayQueueItems(zone);
  const remaining = queueRemainingCount(zone, items.length);
  const time = formatQueueSeconds(zone.queue_time_remaining || 0);
  const countLabel = remaining || items.length;
  const suffix = [
    countLabel ? `${countLabel} remaining` : "",
    time ? `${time} left` : ""
  ].filter(Boolean).join(" - ");

  if (!items.length && !remaining) return "";

  return `
    <div class="liveQueueHead">
      <strong>Roon queue</strong>
      ${suffix ? `<span>${escapeHtml(suffix)}</span>` : ""}
    </div>
    ${items.length ? `
      <ol>
        ${items.slice(0, 8).map((item) => `
          <li>
            ${item.imageKey ? `<span class="queueArt" style="background-image:url('/api/roon/image/${encodeURIComponent(item.imageKey)}?width=80&height=80')"></span>` : "<span class=\"queueArt queueArtEmpty\"></span>"}
            <span class="queueText">
              <strong>${escapeHtml(item.title || "Unknown track")}</strong>
              <small>${escapeHtml([item.subtitle, item.album].filter(Boolean).join(" - "))}</small>
            </span>
          </li>
        `).join("")}
      </ol>
    ` : (rawItems.length ? "<p>Current track removed from Rabbit Hole queue view.</p>" : "<p>Roon is reporting queued time, but has not sent the queue item list yet.</p>")}
  `;
}

function outputHtml(zone, output) {
  if (isHqPlayerOutput(zone, output)) {
    return `<div class="output hqOutput">${hqplayerSignalHtml(zone, output)}</div>`;
  }

  return `
    <div class="output">
      <div class="outputMain">
        <strong>${escapeHtml(output.display_name)}</strong>
        <p class="muted">${escapeHtml(formatVolume(output.volume))}</p>
      </div>
      ${output.volume ? `<div class="volumeButtons"><button data-output="${escapeHtml(output.output_id)}" data-volume="-1">Vol -</button><button data-output="${escapeHtml(output.output_id)}" data-volume="1">Vol +</button></div>` : ""}
    </div>
  `;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${path}`);
    }
  }
  if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${path}`);
    }
  }
  if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function deleteJson(path, body) {
  const response = await fetch(path, {
    method: "DELETE",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${path}`);
    }
  }
  if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function plainList(tracks) {
  return (tracks || []).map((track) => `${track.artist} - ${track.title}`).join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bridgeSyncEntries(result = {}) {
  const candidates = [
    ...(Array.isArray(result.failedTracks) ? result.failedTracks : []),
    ...(Array.isArray(result.failed) ? result.failed : []),
    ...(Array.isArray(result.results) ? result.results : []),
    ...(Array.isArray(result.tracks) ? result.tracks : [])
  ];
  return candidates.filter((item) => {
    const bridge = item?.bridge || item?.roon?.bridge || {};
    return Boolean(bridge.requiresManualRefresh || bridge.sync?.requiresManualRefresh);
  });
}

function bridgeSyncTrackIds(entries = []) {
  return Array.from(new Set(entries
    .map((item) => String(item?.tidalTrackId || item?.track?.tidalTrackId || item?.track?.id || "").trim())
    .filter(Boolean)));
}

function bridgeSyncTracks(entries = []) {
  const seen = new Set();
  return entries.map((item) => {
    const track = item.track || item.requestedTrack || item;
    const tidalTrackId = String(item?.tidalTrackId || track?.tidalTrackId || track?.id || track?.tidal?.id || "").trim();
    const out = {
      artist: String(track?.artist || item?.artist || item?.requestedArtist || item?.matchedArtist || "").trim(),
      title: String(track?.title || item?.title || item?.requestedTitle || item?.matchedTitle || "").trim(),
      album: String(track?.album || item?.album || "").trim(),
      tidalTrackId
    };
    if (Number(track?.durationMs || item?.durationMs || 0) > 0) out.durationMs = Number(track?.durationMs || item?.durationMs);
    return out;
  }).filter((track) => {
    const key = track.tidalTrackId || `${track.artist}|${track.title}`;
    if (!track.artist || !track.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function showBridgeSyncPopup(result = {}) {
  const entries = bridgeSyncEntries(result);
  const popup = $("#bridgeSyncPopup");
  const title = $("#bridgeSyncTitle");
  const message = $("#bridgeSyncMessage");
  const confirm = $("#bridgeSyncConfirm");
  if (!popup || !title || !message || !entries.length) return false;
  const first = entries[0];
  const bridge = first.bridge || first.roon?.bridge || {};
  const sync = bridge.sync || {};
  const playlistTitle = sync.title || bridge.title || "Rabbit Hole Exact Verification Bridge";
  const trackLabel = [
    first.artist || first.track?.artist || first.requestedArtist || first.matchedArtist,
    first.title || first.track?.title || first.requestedTitle || first.matchedTitle
  ].filter(Boolean).join(" - ");
  const trackIds = bridgeSyncTrackIds(entries);
  const tracks = bridgeSyncTracks(entries);
  bridgeSyncRetry = {
    tracks,
    zoneId: activeZone()?.zone_id || "",
    allowBridge: true,
    matchPolicy: "strict",
    bridgeSyncDelaysMs: [0, 3000, 7000]
  };
  title.textContent = "Roon playlist refresh needed";
  message.textContent = `${trackLabel || "A verified track"} was added to ${playlistTitle}, but Roon did not expose it within 10 seconds. Refresh TIDAL playlists in Roon, then confirm here to retry and add it to the queue.`;
  if (confirm) {
    confirm.disabled = !tracks.length && !trackIds.length;
    confirm.textContent = (tracks.length || trackIds.length) > 1 ? `I refreshed Roon - queue ${tracks.length || trackIds.length}` : "I refreshed Roon - queue";
  }
  popup.hidden = false;
  return true;
}

function hideBridgeSyncPopup() {
  const popup = $("#bridgeSyncPopup");
  if (popup) popup.hidden = true;
}

function applyBridgeSyncAlert(alert = null) {
  if (!alert?.id || alert.id === state.bridgeSyncAlertId) return;
  state.bridgeSyncAlertId = alert.id;
  showBridgeSyncPopup(alert);
}

async function confirmBridgeSyncRefresh() {
  const confirm = $("#bridgeSyncConfirm");
  const message = $("#bridgeSyncMessage");
  if (!bridgeSyncRetry?.tracks?.length && !bridgeSyncRetry?.trackIds?.length) return hideBridgeSyncPopup();
  const originalText = confirm?.textContent || "";
  if (confirm) {
    confirm.disabled = true;
    confirm.textContent = "Retrying...";
  }
  if (message) message.textContent = "Checking the refreshed Roon playlist and adding the exact track to the queue...";
  try {
    const result = bridgeSyncRetry.tracks?.length
      ? await api("/api/roon/queue-tracks", {
        ...bridgeSyncRetry,
        targetCount: bridgeSyncRetry.tracks.length,
        mode: "append"
      })
      : await api("/api/tracks/verified/queue", bridgeSyncRetry);
    if (result.failedCount && showBridgeSyncPopup(result)) return;
    hideBridgeSyncPopup();
    $("#busy").textContent = result.queuedCount
      ? `Queued ${result.queuedCount} refreshed bridge track${result.queuedCount === 1 ? "" : "s"}`
      : "Roon playlist refreshed, but no bridge track was queued";
    setTimeout(() => {
      if (/^Queued|^Roon playlist refreshed/.test($("#busy").textContent || "")) $("#busy").textContent = "";
    }, 2600);
  } catch (error) {
    if (message) message.textContent = error.message;
    if (confirm) {
      confirm.disabled = false;
      confirm.textContent = originalText || "I refreshed Roon - queue";
    }
  }
}

function shuffledCopy(items = []) {
  const shuffled = Array.isArray(items) ? items.slice() : [];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function isFetchDrop(error = {}) {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(String(error.message || error));
}

function normalizeKeyText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function trackKeyFor(track = {}) {
  const tidalUrl = String(track.tidal?.tidalUrl || track.tidalUrl || track.metadataEnrichment?.tidalUrl || "").trim();
  if (tidalUrl) return tidalUrl.toLowerCase();
  return `${normalizeKeyText(track.artist)}|${normalizeKeyText(track.title)}`;
}

function trackFeedbackKeys(track = {}) {
  const keys = [];
  const addKey = (key) => {
    const cleanKey = String(key || "").trim().toLowerCase();
    if (cleanKey && cleanKey !== "|" && !keys.includes(cleanKey)) keys.push(cleanKey);
  };
  const addArtistTitle = (artist, title) => {
    addKey(`${normalizeKeyText(artist)}|${normalizeKeyText(title)}`);
  };

  addKey(track.tidal?.tidalUrl || track.tidalUrl || track.metadataEnrichment?.tidalUrl || track.url);
  addArtistTitle(track.artist, track.title);
  addArtistTitle(track.tidal?.artist, track.tidal?.title);
  addArtistTitle(track.metadataEnrichment?.artist, track.metadataEnrichment?.title);
  addArtistTitle(track.roon?.match?.subtitle, track.roon?.match?.title);

  return keys;
}

function feedbackForTrack(track = {}) {
  for (const key of trackFeedbackKeys(track)) {
    const rating = state.feedbackByKey[key];
    if (rating) return rating;
  }
  return "";
}

function tracksShareFeedbackIdentity(left = {}, right = {}) {
  const rightKeys = new Set(trackFeedbackKeys(right));
  return trackFeedbackKeys(left).some((key) => rightKeys.has(key));
}

function rememberFeedbackForTrack(track = {}, rating = "") {
  const normalized = normalizeFeedbackValue(rating);
  if (!normalized) return;
  for (const key of trackFeedbackKeys(track)) {
    state.feedbackByKey[key] = normalized;
  }
}

function nowQualityKeyFor(track = {}) {
  const key = trackKeyFor(track);
  if (!key || key === "|") return "";
  const album = normalizeKeyText(track.album || track.tidal?.album || "");
  const durationSeconds = track.durationMs ? Math.round(Number(track.durationMs || 0) / 1000) : "";
  const liveSource = track.isLiveRadio || track.isRadio || track.sourceType === "radio"
    ? normalizeKeyText([
      "radio",
      track.playbackSource?.display,
      track.playbackSource?.codec,
      track.playbackSource?.sampleRateKhz,
      track.playbackSource?.bitDepth,
      track.playbackSource?.channels,
      track.playbackSource?.bitrate
    ].filter(Boolean).join(" "))
    : "";
  return [key, album, durationSeconds, liveSource].filter(Boolean).join("|");
}

function formatTrackDuration(durationMs) {
  const totalSeconds = Math.round(Number(durationMs || 0) / 1000);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function releaseYearForTrack(track = {}) {
  const candidates = [
    track.releaseYear,
    track.year,
    track.metadata?.releaseYear,
    track.metadata?.year,
    track.metadataEnrichment?.releaseYear,
    track.metadataEnrichment?.year
  ];
  for (const value of candidates) {
    const match = String(value || "").match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return match[1];
  }
  return "";
}

function releaseDateForTrack(track = {}) {
  return String(
    track.metadataEnrichment?.beatport?.releaseDate ||
    track.releaseDate ||
    track.metadata?.releaseDate ||
    track.metadataEnrichment?.releaseDate ||
    ""
  ).trim();
}

function metadataLabelForTrack(track = {}) {
  return String(track.metadataEnrichment?.beatport?.label || track.label || track.metadata?.label || track.metadataEnrichment?.label || "").trim();
}

function isAudioQualityGenreTag(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/\s+/g, "");
  if (/^(?:lossless|hires|hireslossless|highres|highreslossless|master|mqa|atmos|dolbyatmos|sony360|aac|mp3|flac|alac|pcm|stereo|mono)$/.test(compact)) {
    return true;
  }
  if (/^\d+(?:\.\d+)?khz$/.test(compact) || /^\d+bit$/.test(compact)) {
    return true;
  }
  if (!/\b(?:lossless|hi\s*res|hires|high\s*res|mqa|dolby\s*atmos|flac|alac|pcm)\b/i.test(normalized)) {
    return false;
  }
  return !/\b(?:ambient|bass|breaks|chillout|disco|drum|dubstep|house|jungle|techno|trance)\b/i.test(normalized);
}

function metadataGenreForTrack(track = {}, excludedKeys = new Set()) {
  for (const value of [track.genre, track.metadata?.genre, track.metadataEnrichment?.genre]) {
    const genre = String(value || "").trim();
    const key = normalizeMatchText(genre);
    if (genre && key && !excludedKeys.has(key) && !isAudioQualityGenreTag(genre)) return genre;
  }
  return "";
}

function beatportGenreFieldsForTrack(track = {}) {
  const enrichment = track.metadataEnrichment || {};
  const beatport = enrichment.beatport || {};
  const genre = String(beatport.genre || (enrichment.source === "beatport" ? enrichment.beatportTags?.[0] : "") || "").trim();
  const subGenre = String(beatport.subGenre || (enrichment.source === "beatport" ? enrichment.beatportTags?.[1] : "") || "").trim();
  return {
    genre: genre && !isAudioQualityGenreTag(genre) ? genre : "",
    subGenre: subGenre && !isAudioQualityGenreTag(subGenre) ? subGenre : ""
  };
}

function metadataTagBadgesForTrack(track = {}, excludedKeys = new Set()) {
  const seen = new Set();
  const out = [];
  const add = (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const key = normalizeMatchText(text);
    if (!text || !key || seen.has(key) || excludedKeys.has(key) || isAudioQualityGenreTag(text)) return;
    seen.add(key);
    out.push(text);
  };
  const addMany = (value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => add(typeof item === "object" && item ? (item.name || item.title || item.value) : item));
      return;
    }
    String(value || "").split(/\s*,\s*/).forEach(add);
  };
  addMany(track.metadataEnrichment?.beatportTags);
  addMany(track.metadataEnrichment?.musicBrainzTags);
  addMany(track.metadataEnrichment?.genres);
  addMany(track.metadataEnrichment?.tags);
  addMany(track.genre);
  return out.slice(0, 5);
}

function nowSourceQualityHtml(info = null, track = null) {
  const primaryParts = [];
  const display = String(info?.display || track?.playbackSource?.display || "").trim();
  if (display) primaryParts.push(display);
  const duration = formatTrackDuration(track?.durationMs);
  if (duration) primaryParts.push(duration);

  const detailLines = [];
  const releaseYear = releaseYearForTrack(track || {});
  const releaseDate = releaseDateForTrack(track || {});
  const label = metadataLabelForTrack(track || {});
  const beatport = track?.metadataEnrichment?.beatport || {};
  const beatportGenre = beatportGenreFieldsForTrack(track || {});
  const explicitGenreKeys = new Set([
    normalizeMatchText(beatportGenre.genre),
    normalizeMatchText(beatportGenre.subGenre)
  ].filter(Boolean));
  const genre = beatportGenre.genre || metadataGenreForTrack(track || {}, explicitGenreKeys);
  if (releaseDate || releaseYear || label) {
    detailLines.push([
      releaseDate ? `Released: ${releaseDate}` : releaseYear ? `Released: ${releaseYear}` : "",
      label
    ].filter(Boolean).join(" • "));
  }
  if (genre) detailLines.push(`Genre: ${genre}`);
  if (beatportGenre.subGenre) detailLines.push(`Subgenre: ${beatportGenre.subGenre}`);
  const bpm = Number(beatport.bpm || track?.metadataEnrichment?.bpm || 0);
  const keyName = String(beatport.keyName || track?.metadataEnrichment?.keyName || "").trim();
  const camelot = String(beatport.camelot || track?.metadataEnrichment?.camelot || "").trim();
  const beatportDetails = [
    bpm > 0 ? `${Math.round(bpm)} BPM` : "",
    keyName,
    camelot && camelot !== keyName ? camelot : ""
  ].filter(Boolean).join(" • ");
  if (beatportDetails) detailLines.push(beatportDetails);
  const beatportIds = [
    beatport.id ? `Beatport #${beatport.id}` : "",
    beatport.releaseId ? `Release #${beatport.releaseId}` : ""
  ].filter(Boolean).join(" • ");
  if (beatportIds) detailLines.push(beatportIds);

  const tags = metadataTagBadgesForTrack(track || {}, explicitGenreKeys);
  const tagHtml = tags.length
    ? `<span class="sourceTagRow">${tags.map((tag) => `<span class="sourceTagBadge">${escapeHtml(tag)}</span>`).join("")}</span>`
    : "";
  const lines = [
    primaryParts.join(" • "),
    ...detailLines
  ].filter(Boolean);
  if (!lines.length && !tagHtml) return "";

  return lines.map((line, index) => (
    `<span class="${index === 0 ? "sourcePrimary" : "sourceDetail"}">${escapeHtml(line)}</span>`
  )).join("") + tagHtml;
}

function renderNowSourceQuality(info = null, track = state.nowTrack) {
  const source = $("#nowSourceFormat");
  if (!source) return;
  const html = nowSourceQualityHtml(info, track);
  source.innerHTML = html;
  source.hidden = !html;
}

function playbackQualityInfoFromTrack(track = null) {
  const source = track?.playbackSource || null;
  const display = String(source?.display || "").trim();
  if (!display) return null;
  return {
    display,
    source: source.sourceName || "Roon",
    codec: source.codec || "",
    sampleRateKhz: source.sampleRateKhz || null,
    bitDepth: source.bitDepth || null,
    channels: source.channels || null,
    bitrate: source.bitrate || null,
    resolvedBy: "live-playback-source"
  };
}

function updateNowSourceQuality(track = null) {
  const key = track ? nowQualityKeyFor(track) : "";
  if (!key) {
    state.nowQualityKey = "";
    state.nowQualityLoading = false;
    state.nowQualityInfo = null;
    renderNowSourceQuality(null, track);
    return;
  }

  const hasCachedQuality = Object.prototype.hasOwnProperty.call(state.nowQualityCache, key);
  const playbackFallback = playbackQualityInfoFromTrack(track);
  if (state.nowQualityKey !== key) {
    state.nowQualityKey = key;
    state.nowQualityLoading = false;
    state.nowQualityInfo = hasCachedQuality ? state.nowQualityCache[key] : playbackFallback;
  }

  if (hasCachedQuality) {
    renderNowSourceQuality(state.nowQualityCache[key], track);
    return;
  }

  renderNowSourceQuality(state.nowQualityInfo, track);
  if (state.nowQualityLoading) return;

  state.nowQualityLoading = true;
  api("/api/tidal/track-quality", { track })
    .then((result) => {
      if (state.nowQualityKey !== key) return;
      state.nowQualityInfo = result || null;
      state.nowQualityCache[key] = state.nowQualityInfo;
      renderNowSourceQuality(state.nowQualityInfo, track);
    })
    .catch(() => {
      if (state.nowQualityKey !== key) return;
      state.nowQualityInfo = playbackFallback;
      state.nowQualityCache[key] = playbackFallback;
      renderNowSourceQuality(playbackFallback, track);
    })
    .finally(() => {
      if (state.nowQualityKey === key) state.nowQualityLoading = false;
    });
}

function feedbackMapFromServer(feedback = {}) {
  const map = {};
  for (const [key, entry] of Object.entries(feedback || {})) {
    const rating = typeof entry === "string" ? entry : entry?.rating;
    if (!rating) continue;
    map[String(key).toLowerCase()] = rating;
    const aliasTrack = {
      artist: entry?.artist || "",
      title: entry?.title || "",
      tidalUrl: entry?.tidalUrl || ""
    };
    for (const aliasKey of trackFeedbackKeys(aliasTrack)) {
      map[aliasKey] = rating;
    }
  }
  return map;
}

function applyFeedbackToTrack(track = {}) {
  const feedback = feedbackForTrack(track);
  return feedback && !track.feedback ? { ...track, feedback } : track;
}

function applyFeedbackToTracks(tracks = []) {
  return (tracks || []).map(applyFeedbackToTrack);
}

function calibrationVersion(calibration = null) {
  if (!calibration) return "";
  return JSON.stringify({
    total: calibration.total || 0,
    reviewed: calibration.reviewed || 0,
    promptMismatches: calibration.promptMismatches || 0,
    modelMisses: calibration.modelMisses || 0,
    badBoosts: calibration.badBoosts || 0,
    missedLikes: calibration.missedLikes || 0,
    updatedAt: calibration.updatedAt || "",
    recent: (calibration.recent || []).map((item) => `${item.recordedAt || ""}:${item.rating || ""}:${item.modelAction || ""}:${item.artist || ""}:${item.title || ""}`)
  });
}

function applyCalibration(calibration = null) {
  const nextVersion = calibrationVersion(calibration);
  if (nextVersion === state.calibrationVersion) return false;
  state.calibration = calibration || null;
  state.calibrationVersion = nextVersion;
  if (state.lastResult) {
    state.lastResult.verification = {
      ...(state.lastResult.verification || {}),
      feedbackCalibration: state.calibration
    };
    showSourceReport(state.lastResult);
  }
  return true;
}

function sourceReportCalibration(verification = {}) {
  const embedded = verification.feedbackCalibration || null;
  const current = state.calibration || null;
  if (!current) return embedded || {};
  if (!embedded) return current;
  return calibrationVersion(current) === calibrationVersion(embedded) ? embedded : current;
}

function applyFeedbackResponse(result = {}) {
  const calibration = result.profile?.calibration || null;
  if (calibration) applyCalibration(calibration);
}

function renderMemoryStatus() {
  const element = $("#memoryStatus");
  if (!element) return;
  const memory = state.memory || {};
  const count = Number(memory.count || 0);
  const mb = Number(memory.mb || 0);
  const unlimited = memory.unlimited || memory.maxMb === null || memory.maxMb === undefined;
  const maxText = unlimited ? "unlimited" : `${Number(memory.maxMb).toFixed(0)} MB`;
  element.textContent = `Track memory: ${count} remembered track${count === 1 ? "" : "s"} - ${mb.toFixed(2)} MB / ${maxText}`;
}

function textList(value) {
  if (Array.isArray(value)) return value.join("; ");
  return String(value || "");
}

function csvForTracks(tracks) {
  const headers = [
    "artist",
    "title",
    "album",
    "label",
    "year",
    "releaseDate",
    "duration",
    "discoveryScore",
    "scoreBand",
    "freshness",
    "labelMatch",
    "artistMatch",
    "lengthPreference",
    "genreMatch",
    "tasteAdjustment",
    "feedback",
    "discoverySource",
    "whyMatched",
    "status",
    "tidalUrl",
    "why"
  ];
  const rows = (tracks || []).map((track) => [
    track.artist,
    track.title,
    track.album,
    track.label || track.tidal?.label || "",
    track.year || "",
    track.releaseDate || track.tidal?.releaseDate || "",
    formatDuration(track.durationMs),
    track.score || track.scoreBreakdown?.total || "",
    scoreBandFor(track.score || track.scoreBreakdown?.total).label,
    track.scoreBreakdown?.freshness || "",
    track.scoreBreakdown?.labelMatch || "",
    track.scoreBreakdown?.artistMatch || "",
    track.scoreBreakdown?.lengthPreference || "",
    track.scoreBreakdown?.genreMatch || "",
    track.scoreBreakdown?.tasteAdjustment || "",
    track.feedback || "",
    track.discoverySource || "",
    textList(track.why),
    textList(track.statusChecks),
    track.tidal?.tidalUrl || "",
    track.reason || ""
  ]);
  return [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`).join(",")).join("\r\n");
}

function downloadCsv(filename, tracks) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csvForTracks(tracks)], { type: "text/csv" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function scoreBandFor(scoreValue) {
  const score = Number(scoreValue || 0);
  if (score >= 90) return { label: "Excellent", className: "excellent" };
  if (score >= 80) return { label: "Strong", className: "strong" };
  if (score >= 70) return { label: "Worth checking", className: "worth" };
  if (score >= 60) return { label: "Experimental", className: "experimental" };
  return { label: "Long shot", className: "longshot" };
}

function minimumScoreLabel(scoreValue) {
  const score = Number(scoreValue || 0);
  return score > 0 ? `${scoreBandFor(score).label}+` : "verified";
}

function compactScoreBadgeHtml(track) {
  const score = track?.score || track?.scoreBreakdown?.total || "";
  if (!score) return "";
  const band = scoreBandFor(score);
  const suffix = track?.belowMinimum ? " - below minimum" : "";
  return `<span class="scoreBadge ${escapeHtml(band.className)}">Discovery ${escapeHtml(score)} - ${escapeHtml(band.label)}${escapeHtml(suffix)}</span>`;
}

function trackPayload(track = {}) {
  const { _resultIndex, ...payload } = track || {};
  return payload;
}

function jsonDataAttr(value) {
  return escapeHtml(JSON.stringify(value));
}

function tidalTrackUrl(track = {}) {
  return safeHttpUrl(track.tidal?.tidalUrl || track.tidalUrl);
}

function tidalTrackId(track = {}) {
  const explicit = String(track.tidal?.id || track.tidalId || track.id || track.trackId || "").trim();
  const url = tidalTrackUrl(track);
  const match = url.match(/\/(?:browse\/)?track\/(\d+)/i);
  if (match?.[1]) return match[1];
  return /^\d+$/.test(explicit) ? explicit : "";
}

function tidalAndroidHttpsIntentUrl(track = {}) {
  const id = tidalTrackId(track);
  const webUrl = tidalTrackUrl(track);
  if (!id || !webUrl) return "";
  return `intent://tidal.com/browse/track/${encodeURIComponent(id)}#Intent;scheme=https;package=com.aspiro.tidal;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
}

function tidalAndroidSchemeIntentUrl(track = {}) {
  const id = tidalTrackId(track);
  const webUrl = tidalTrackUrl(track);
  if (!id || !webUrl) return "";
  return `intent://track/${encodeURIComponent(id)}#Intent;scheme=tidal;package=com.aspiro.tidal;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
}

function tidalAndroidWakeIntentUrl(track = {}) {
  const webUrl = tidalTrackUrl(track);
  if (!webUrl) return "";
  return `intent://#Intent;scheme=tidal;package=com.aspiro.tidal;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
}

function tidalAppUrl(track = {}) {
  const id = tidalTrackId(track);
  return id ? `tidal://track/${encodeURIComponent(id)}` : "";
}

function openExternalUrl(url) {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) window.location.href = url;
}

function sendLocation(url) {
  if (!url) return;
  window.location.href = url;
}

function openAndroidTidalTrack(track = {}) {
  const webUrl = tidalTrackUrl(track);
  const firstIntent = tidalAndroidHttpsIntentUrl(track) || tidalAndroidSchemeIntentUrl(track) || webUrl;
  const retryIntent = tidalAndroidSchemeIntentUrl(track) || firstIntent;
  const wakeIntent = tidalAndroidWakeIntentUrl(track);
  let waitingForWake = false;
  let sentAfterWake = false;

  const removeVisibilityHandler = () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };

  function handleVisibilityChange() {
    if (!waitingForWake || sentAfterWake || document.visibilityState !== "visible") return;
    sentAfterWake = true;
    waitingForWake = false;
    setTimeout(() => sendLocation(retryIntent), 350);
    removeVisibilityHandler();
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  setTimeout(removeVisibilityHandler, 5000);

  sendLocation(firstIntent);
  setTimeout(() => {
    if (document.visibilityState === "hidden") return;
    waitingForWake = true;
    sendLocation(wakeIntent || retryIntent);
    setTimeout(() => {
      if (document.visibilityState !== "hidden" && !sentAfterWake) {
        sentAfterWake = true;
        sendLocation(retryIntent);
        removeVisibilityHandler();
      }
    }, 450);
  }, 900);
}

function parseTrackPayloadElement(element, key = "tidalOpen") {
  let payload = {};
  try {
    payload = JSON.parse(element?.dataset?.[key] || "{}");
  } catch {
    payload = {};
  }
  const fallbackUrl = safeHttpUrl(element?.getAttribute?.("href") || element?.dataset?.tidalUrl || "");
  if (fallbackUrl && !tidalTrackUrl(payload)) payload.tidalUrl = fallbackUrl;
  return payload;
}

function openTrackElementInTidal(element) {
  openTrackInTidal(parseTrackPayloadElement(element), element);
}

function openTrackInTidal(track = {}, button = null) {
  const webUrl = tidalTrackUrl(track);
  if (!webUrl) {
    alert("No TIDAL link is available for this track.");
    return;
  }

  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Opening...";
  }

  const userAgent = navigator.userAgent || "";
  const isAndroid = /Android/i.test(userAgent);
  const isIos = /iPhone|iPad|iPod/i.test(userAgent);
  const id = tidalTrackId(track);

  try {
    if (isAndroid) {
      openAndroidTidalTrack(track);
      return;
    }

    if (isIos && id) {
      window.location.href = tidalAppUrl(track);
      setTimeout(() => {
        window.location.href = webUrl;
      }, 900);
      return;
    }

    openExternalUrl(webUrl);
  } finally {
    if (button) {
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 1200);
    }
  }
}

function standbyPayloadTracks(limit = 25) {
  return (state.standbyTracks || []).slice(0, Math.max(1, Number(limit || 25))).map(trackPayload);
}

function standbyTimeLabel(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function standbyTrackMeta(track = {}) {
  return [
    track.artist || track.tidal?.artist || "",
    track.album || track.tidal?.album || "",
    track.releaseDate || track.tidal?.releaseDate || track.year || "",
    track.durationMs ? formatDuration(track.durationMs) : ""
  ].filter(Boolean).join(" - ");
}

function standbyTrackHtml(track = {}, index = 0) {
  const tidalUrl = safeHttpUrl(track.tidal?.tidalUrl || track.tidalUrl);
  const payload = trackPayload(track);
  const payloadAttr = jsonDataAttr(payload);
  const score = track.score || track.scoreBreakdown?.total || "";
  const badge = score ? compactScoreBadgeHtml(track) : "";
  return `
    <li class="standbyTrack">
      <span class="standbyIndex">${index + 1}</span>
      <span class="standbyMain">
        <strong>${tidalUrl ? `<a href="${escapeHtml(tidalUrl)}" data-tidal-open="${payloadAttr}" data-tidal-url="${escapeHtml(tidalUrl)}" rel="noreferrer">${escapeHtml(track.title || "Untitled")}</a>` : escapeHtml(track.title || "Untitled")}</strong>
        <small>${escapeHtml(standbyTrackMeta(track) || "Metadata unavailable")}</small>
      </span>
      <span class="standbyScore">${badge}</span>
    </li>
  `;
}

function renderStandbyPool(standby = state.standby) {
  const title = $("#standbyTitle");
  const status = $("#standbyStatus");
  const list = $("#standbyTracks");
  if (!title || !status || !list) return;

  state.standby = standby || null;
  state.standbyTracks = Array.isArray(standby?.tracks) ? applyFeedbackToTracks(standby.tracks) : [];
  const target = Number(standby?.targetCount || 25);
  const count = state.standbyTracks.length;
  title.textContent = `${count}/${target} standby tracks`;

  const statusParts = [];
  if (standby?.refreshing) statusParts.push("Refreshing");
  if (standby?.lastError) statusParts.push(`Last refresh failed: ${standby.lastError}`);
  if (standby?.lastRefreshAt) statusParts.push(`Updated ${standbyTimeLabel(standby.lastRefreshAt)}`);
  if (standby?.lastRun && !standby.lastError) {
    const kept = Number(standby.lastRun.kept || count);
    const generated = Number(standby.lastRun.generated || 0);
    if (generated) statusParts.push(`${kept}/${target} ready after ${generated} checked`);
  }
  const novelty = standby?.lastRun?.diagnostics?.novelty;
  if (novelty) {
    const carried = Array.isArray(novelty.carriedOver) ? novelty.carriedOver.length : Number(novelty.carriedOver || 0);
    statusParts.push(`${novelty.finalCount ?? novelty.total ?? count} / ${standby.targetCount || 25} fresh tracks found; new: ${novelty.newTracksIntroduced}; carried over: ${carried}`);
    if (novelty.shortfallReason) statusParts.push(novelty.shortfallReason);
    if (novelty.carryoverReason) statusParts.push(novelty.carryoverReason);
  }
  const synapseReview = standby?.lastRun?.diagnostics?.synapseReview;
  if (synapseReview) statusParts.push(synapseReview.participated
    ? `Synapse reviewed: ${synapseReview.model || "model unavailable"} (${synapseReview.latencyMs || synapseReview.durationMs || 0}ms)`
    : `Synapse ${synapseReview.attempted ? "attempted but failed" : "skipped"}${synapseReview.model ? ` (${synapseReview.model})` : ""} [${synapseReview.failureType || "legacy diagnostic"}]: ${synapseReview.skipReason || synapseReview.reason}; kept local/Qwen pool`);
  if (standby?.nextRefreshAt && !standby?.refreshing) statusParts.push(`Next ${standbyTimeLabel(standby.nextRefreshAt)}`);
  status.textContent = statusParts.join(" - ") || "Waiting for background search.";

  const hasTracks = count > 0;
  $("#standbyQueue").disabled = !hasTracks;
  $("#standbyQueueNext").disabled = !hasTracks;
  $("#standbySendTidal").disabled = !hasTracks;
  $("#standbyClear").disabled = !hasTracks && !standby?.lastError;

  list.innerHTML = hasTracks
    ? `<ol>${state.standbyTracks.map(standbyTrackHtml).join("")}</ol>`
    : "<p class=\"muted\">No standby tracks cached yet.</p>";
  cleanRenderedArtifacts(list);
}

function artistCreditConfirmed(track = {}) {
  const checks = Array.isArray(track.statusChecks) ? track.statusChecks.join(" ") : "";
  return Boolean(track.roon?.artistCreditConfirmed || /Exact artist credit confirmed/i.test(checks));
}

function roonVisibleTrack(track = {}) {
  const source = `${track.discoverySource || ""} ${track.verificationSource || ""}`;
  return Boolean(track.roon?.verified || /\bRoon\b/i.test(source));
}

function artistConfirmationBadgeHtml(track = {}) {
  if (!roonVisibleTrack(track)) return "";
  if (artistCreditConfirmed(track)) {
    const artist = track.roon?.artistCreditConfirmed || "";
    return `<span class="artistCreditBadge exact" title="Roon artist credit matched exactly">${artist ? `Exact artist: ${escapeHtml(artist)}` : "Exact artist"}</span>`;
  }
  return `<span class="artistCreditBadge broad" title="Roon found this through broader search, not exact artist crawl">Broader Roon match</span>`;
}

function displayedResultTracks(tracks = []) {
  const entries = (tracks || []).map((track, resultIndex) => ({ ...track, _resultIndex: resultIndex }));
  return state.resultArtistConfirmedOnly
    ? entries.filter(artistCreditConfirmed)
    : entries;
}

function updateResultTrackFeedback(updatedTrack = {}, rating = "") {
  const key = trackKeyFor(updatedTrack);
  if (!key) return;
  const apply = (track) => (
    trackKeyFor(track) === key || tracksShareFeedbackIdentity(track, updatedTrack)
      ? { ...track, feedback: rating }
      : track
  );
  if (state.lastResult?.tracks) state.lastResult.tracks = state.lastResult.tracks.map(apply);
  state.lastTracks = state.lastTracks.map(apply);
  state.displayedTracks = state.displayedTracks.map(apply);
}

function resultDiagnosticsFor(track = {}) {
  const breakdown = track.scoreBreakdown || {};
  const score = Number(track.score || breakdown.total || 0);
  const promptPercent = Number(breakdown.promptMatch?.percent ?? track.promptMatch?.percent ?? 0);
  const genreMatch = Number(breakdown.genreMatch ?? 0);
  const genreInference = breakdown.genreInference || {};
  const genreConfidence = Number(genreInference.confidence || 0);
  const kept = [];
  const risks = [];
  const checks = Array.isArray(track.statusChecks) ? track.statusChecks.join(" ") : "";
  const titleAlbum = `${track.title || ""} ${track.album || ""}`;
  const titleAlbumNormalized = normalizeMatchText(titleAlbum);
  const label = track.label || track.tidal?.label || "";
  const durationMs = Number(track.durationMs || track.tidal?.durationMs || 0);

  if (track.roon?.verified || /Roon queue action ready/i.test(checks)) kept.push("Roon queueable");
  if (track.tidal?.verified || track.tidal?.tidalUrl || track.tidalUrl) kept.push("TIDAL verified");
  if (track.releaseDate || track.year || track.tidal?.releaseDate || track.tidal?.year) kept.push("date matched");
  if (label) kept.push(`${label} label metadata`);
  if (/Not previously suggested/i.test(checks)) kept.push("not previously suggested");
  if (durationMs) kept.push(`${formatDuration(durationMs)} playable length`);
  if (genreConfidence >= 45 && genreInference.summary) kept.push(`genre inferred from ${genreInference.summary}`);
  if (breakdown.tasteAdjustment > 0) kept.push("taste signal boost");
  if (track.discoveryLane === "adjacent") kept.push("adjacent discovery lane");
  if (track.autoBroadened) kept.push("broadened search pass");
  if (artistCreditConfirmed(track)) kept.push("exact artist credit confirmed");
  if (!kept.length) kept.push(track.discoverySource || "closest catalogue match");

  if (track.belowMinimum) risks.push(`below ${track.minimumScoreLabel || "minimum"} floor`);
  if (score && score < 60) risks.push("long-shot score");
  if (promptPercent && promptPercent < 50) risks.push("weak prompt match");
  if (genreMatch && genreMatch < 12 && genreConfidence < 35) risks.push("weak inferred genre evidence");
  if (genreInference.weakOfficialGenre && genreConfidence < 45) risks.push("official genre tag is generic");
  if (!label) risks.push("no trusted label metadata");
  if (durationMs && durationMs < 240000) risks.push("short track length");
  if (track.discoveryQuotaRisk) risks.push("feedback calibration risk");
  if (/Roon verification timed out/i.test(checks)) risks.push("Roon action not verified");
  if (roonVisibleTrack(track) && !artistCreditConfirmed(track)) risks.push("broader Roon match");
  if (/\b(?:edm|house|techno|trance|progressive|melodic|deep|vibes?|fusions?|mix 20\d{2}|playlist|hits?)\b/.test(titleAlbumNormalized) &&
      (titleAlbum.includes("/") || /\b(?:vibes?|fusions?|playlist|hits?|mix 20\d{2})\b/.test(titleAlbumNormalized))) {
    risks.push("generic genre-title wording");
  }

  const show = Boolean(
    track.belowMinimum ||
    (score && score < 60) ||
    (promptPercent && promptPercent < 55) ||
    track.discoveryQuotaRisk ||
    risks.length >= 2
  );

  return {
    show,
    kept: Array.from(new Set(kept)).slice(0, 4),
    risks: Array.from(new Set(risks)).slice(0, 4)
  };
}

function resultDiagnosticsHtml(track = {}, index = 0) {
  const diagnostics = resultDiagnosticsFor(track);
  if (!diagnostics.show) return "";
  const rejected = normalizeFeedbackValue(track.feedback) === "reject_similar";
  return `
    <div class="resultDiagnostics">
      <div class="resultDiagnosticsHead">
        <span>Why is this here?</span>
        <button type="button" data-reject-similar="${index}" ${rejected ? "disabled" : ""}>${rejected ? "Rejected similar" : "Reject similar"}</button>
      </div>
      <p><strong>Kept because:</strong> ${escapeHtml(diagnostics.kept.join(", "))}</p>
      <p><strong>Risk:</strong> ${escapeHtml((diagnostics.risks.length ? diagnostics.risks : ["limited metadata support"]).join(", "))}</p>
    </div>
  `;
}

function evidenceLedgerValues(value, limit = 4) {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set();
  return values
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function evidenceLedgerRowHtml(label, value, limit = 4) {
  const values = evidenceLedgerValues(value, limit);
  if (!values.length) return "";
  return `
    <p>
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(values.join("; "))}</b>
    </p>
  `;
}

function evidenceLedgerHtml(track = {}) {
  const ledger = track.evidenceLedger || {};
  if (!ledger.version) return "";
  const proof = ledger.proof || {};
  const score = ledger.scoring?.score ? `Score ${ledger.scoring.score}` : "";
  const prompt = ledger.scoring?.promptMatch ? `Prompt ${ledger.scoring.promptMatch}%` : "";
  const taste = ledger.scoring?.tasteMatch ? `Taste ${ledger.scoring.tasteMatch}%` : "";
  const head = [score, prompt, taste].filter(Boolean).join(" - ");
  const rows = [
    evidenceLedgerRowHtml("Decision", [ledger.decision, ledger.source?.discoveryLane, ledger.source?.discoverySource], 3),
    evidenceLedgerRowHtml("Query", ledger.query?.text || ledger.query?.requested, 1),
    evidenceLedgerRowHtml("Genre proof", proof.genre, 4),
    evidenceLedgerRowHtml("Vibe proof", proof.vibe, 3),
    evidenceLedgerRowHtml("Label proof", proof.label, 3),
    evidenceLedgerRowHtml("Artist proof", proof.artist, 3),
    evidenceLedgerRowHtml("Date proof", proof.year, 3),
    evidenceLedgerRowHtml("Novelty", proof.novelty, 3),
    evidenceLedgerRowHtml("Quality", proof.quality, 3),
    evidenceLedgerRowHtml("Risk", ledger.risks, 4),
    evidenceLedgerRowHtml("Rejected", ledger.rejectedBecause, 3)
  ].filter(Boolean).join("");
  if (!rows) return "";
  return `
    <div class="evidenceLedger">
      <div class="evidenceLedgerHead">
        <span>Evidence Ledger</span>
        ${head ? `<strong>${escapeHtml(head)}</strong>` : ""}
      </div>
      <div class="evidenceLedgerGrid">
        ${rows}
      </div>
    </div>
  `;
}

function discardedEvidenceSummaryHtml(item = {}) {
  const ledger = item.evidenceLedger || {};
  if (!ledger.version) return "";
  const proof = ledger.proof || {};
  const pieces = [
    ...(ledger.rejectedBecause || []).slice(0, 1),
    ...(proof.genre || []).slice(0, 1),
    ...(proof.label || []).slice(0, 1),
    ...(proof.year || []).slice(0, 1),
    ...(ledger.risks || []).slice(0, 1)
  ];
  const summary = evidenceLedgerValues(pieces, 4);
  return summary.length ? `<em class="discardedEvidence">Evidence: ${escapeHtml(summary.join("; "))}</em>` : "";
}

function normalizeFeedbackValue(value) {
  const rating = String(value || "").toLowerCase();
  if (rating === "love") return "love";
  if (rating === "good" || rating === "up") return "good";
  if (rating === "ok" || rating === "okay") return "ok";
  if (rating === "wrong_genre" || rating === "wrong genre" || rating === "wrong" || rating === "not what i asked for" || rating === "not_asked") return "wrong_genre";
  if (rating === "reject_similar" || rating === "reject similar" || rating === "similar_bad" || rating === "similar") return "reject_similar";
  if (rating === "skip" || rating === "down") return "skip";
  if (rating === "never" || rating === "never_again" || rating === "never again") return "never";
  return "";
}

function feedbackBadgeLabel(value) {
  const rating = normalizeFeedbackValue(value);
  if (rating === "love") return "Loved now playing";
  if (rating === "good") return "Rated Good";
  if (rating === "ok") return "Rated OK";
  if (rating === "wrong_genre") return "Marked Wrong Genre";
  if (rating === "reject_similar") return "Rejected similar";
  if (rating === "skip") return "Skipped now playing";
  if (rating === "never") return "Never Again";
  return "";
}

function feedbackButtonsHtml(track, index, prefix = "") {
  const feedback = normalizeFeedbackValue(track?.feedback || "");
  const attr = prefix ? `data-${prefix}-feedback` : "data-feedback";
  const indexAttr = prefix ? `data-${prefix}-index` : "data-index";
  const options = [
    { value: "love", label: "&#10084;&#65039; Love", aria: "Love" },
    { value: "good", label: "&#128077; Good", aria: "Good" },
    { value: "ok", label: "&#128076; OK", aria: "OK" },
    { value: "wrong_genre", label: "Wrong Genre", aria: "Not what I asked for" },
    { value: "skip", label: "&#128078; Skip", aria: "Skip" },
    { value: "never", label: "&#128683; Never Again", aria: "Never Again" }
  ];
  return options.map((option) => `
    <button type="button" class="feedbackButton ${escapeHtml(option.value)} ${feedback === option.value ? "active" : ""}" ${attr}="${escapeHtml(option.value)}" ${indexAttr}="${index}" aria-label="${escapeHtml(option.aria)}" title="${escapeHtml(option.aria)}" aria-pressed="${feedback === option.value}">${option.label}</button>
  `).join("");
}

function displayArtists(value) {
  return String(value || "")
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part && part.length <= 70);
}

function remixersFromTitle(title) {
  const remixers = [];
  for (const match of String(title || "").matchAll(/[\[(]([^)\]]*(?:remix|rework|rerub|dub|edit|mix)[^)\]]*)[\])]/gi)) {
    const text = match[1]
      .replace(/\b(?:original|extended|club|radio|vocal|instrumental|dub|edit|mix|remix|rework|rerub|version)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text && !/^original$/i.test(text)) remixers.push(text);
  }
  return Array.from(new Set(remixers));
}

function rabbitHoleTextFor(track = {}) {
  const artists = displayArtists(track.artist || track.tidal?.artist);
  const label = track.label || track.tidal?.label || "";
  const primaryArtist = artists[0] || track.artist || "this artist";
  return `Find tracks like ${primaryArtist}${label ? ` connected to ${label}` : ""}, but go deeper and less obvious. Follow the prompt intent first, avoid repeats, and only return Roon-queueable matches.`;
}

function rabbitNodePayload(node = {}) {
  return escapeHtml(JSON.stringify({
    type: node.type,
    name: node.name,
    prompt: node.prompt,
    track: node.track || null
  }));
}

function rabbitNodeHtml(node = {}, extra = false) {
  const meta = [
    node.type,
    node.source || (node.sources || [])[0] || "",
    node.track?.releaseDate || node.track?.year || "",
    node.track?.durationMs ? formatDuration(node.track.durationMs) : ""
  ].filter(Boolean).join(" - ");
  return `
    <button type="button" class="rabbitNode rabbitNode-${escapeHtml(node.type || "entity")}${extra ? " rabbitNodeExtra" : ""}" data-rabbit-node='${rabbitNodePayload(node)}'>
      <strong>${escapeHtml(node.name || "Unknown")}</strong>
      ${meta ? `<span>${escapeHtml(meta)}</span>` : ""}
    </button>
  `;
}

function rabbitSectionLimit(section = {}) {
  if (section.id === "artist") return 4;
  if (section.id === "collaborators") return 8;
  if (section.id === "labels") return 8;
  if (section.id === "relatedArtists") return 8;
  return 6;
}

function rabbitSectionHtml(section = {}) {
  const items = section.items || [];
  const limit = rabbitSectionLimit(section);
  const visible = items.slice(0, limit);
  const extra = items.slice(limit);
  return `
    <section class="rabbitDepth rabbitDepth${escapeHtml(section.depth || 1)}">
      <div class="rabbitDepthHead">
        <div>
          <span>Depth ${escapeHtml(section.depth || 1)}</span>
          <strong>${escapeHtml(section.label || "Rabbit Hole")}</strong>
        </div>
        <em>${escapeHtml(items.length)} found</em>
      </div>
      <div class="rabbitNodes">
        ${items.length ? [
          ...visible.map((item) => rabbitNodeHtml(item)),
          ...extra.map((item) => rabbitNodeHtml(item, true)),
          extra.length ? `<button type="button" class="rabbitMore" data-rabbit-more="${extra.length}">Show ${extra.length} more</button>` : ""
        ].join("") : "<p class=\"muted\">No concrete entities found yet.</p>"}
      </div>
    </section>
  `;
}

function rabbitHoleGraphHtml(graph = {}) {
  const seed = graph.seed || {};
  const sections = graph.sections || {};
  const provider = graph.providerStatus || {};
  const ordered = [
    sections.artist,
    sections.collaborators,
    sections.labels,
    sections.relatedArtists,
    sections.hiddenGems,
    sections.deepCatalog
  ].filter(Boolean);

  return `
    <div class="rabbitHero">
      <div>
        <p class="eyebrow">Rabbit Hole Graph ${graph.cached ? "- cached" : ""}</p>
        <h3>${escapeHtml(seed.title || "Current track")}</h3>
        <p>${escapeHtml([seed.artist, seed.label, seed.year].filter(Boolean).join(" - "))}</p>
      </div>
      <div class="rabbitHeroActions">
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.artist || rabbitHoleTextFor(seed))}">Explore Artist</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.label || graph.prompts?.artist || "")}">Explore Label</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.similarArtists || graph.prompts?.artist || "")}">Similar Artists</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.hiddenGems || graph.prompts?.artist || "")}">Hidden Gems</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.graph || graph.prompts?.artist || "")}">Generate Prompt</button>
        <button type="button" data-rabbit-run="${escapeHtml(graph.prompts?.graph || graph.prompts?.artist || "")}">Run Discovery</button>
        <button type="button" data-rabbit-refresh="true">Refresh Graph</button>
      </div>
    </div>
    <div class="rabbitProviderStatus">
      ${Object.entries(provider).map(([key, value]) => `<span>${escapeHtml(key)}: ${escapeHtml(value)}</span>`).join("")}
    </div>
    <div class="rabbitDepths">
      ${ordered.map(rabbitSectionHtml).join("")}
    </div>
  `;
}

function setRabbitPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return;
  $("#request").value = text;
  const genres = document.querySelector("[name='genres']");
  const mood = document.querySelector("[name='mood']");
  const years = document.querySelector("[name='years']");
  const count = document.querySelector("[name='count']");
  if (genres && !genres.value.trim()) genres.value = "";
  if (mood && !mood.value.trim()) mood.value = "";
  if (years && !years.value.trim()) years.value = "";
  if (count && !count.value.trim()) count.value = "";
  document.querySelector(".composer")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function runRabbitPrompt(prompt) {
  setRabbitPrompt(prompt);
  $("#playlistForm").requestSubmit();
}

function jumpToTrackIdentity(track = {}) {
  const key = trackKeyFor(track);
  const currentIndex = state.lastTracks.findIndex((candidate) => trackKeyFor(candidate) === key);
  if (currentIndex >= 0) {
    scrollToDiscoveryTrack(currentIndex);
    return true;
  }
  if (track.tidalUrl || track.tidal?.tidalUrl) {
    window.open(track.tidalUrl || track.tidal.tidalUrl, "_blank", "noreferrer");
    return true;
  }
  return false;
}

async function loadRabbitHole(track, { force = false } = {}) {
  const panel = $("#rabbitHolePanel");
  const content = $("#rabbitHoleContent");
  if (!panel || !content || !track) return;
  const key = trackKeyFor(track);
  if (!force && state.rabbitHoleGraph && state.rabbitHoleKey === key) {
    content.innerHTML = rabbitHoleGraphHtml(state.rabbitHoleGraph);
    cleanRenderedArtifacts(content);
    return;
  }

  content.innerHTML = "<p class=\"muted\">Building Rabbit Hole graph...</p>";
  try {
    const graph = await api("/api/rabbit-hole", {
      track,
      force,
      contextTracks: rabbitHoleContextTracks()
    });
    state.rabbitHoleGraph = graph;
    state.rabbitHoleKey = key;
    content.innerHTML = rabbitHoleGraphHtml(graph);
    cleanRenderedArtifacts(content);
  } catch (error) {
    content.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function scrollToDiscoveryTrack(index) {
  const target = document.getElementById(`track-${index}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("trackFocus");
  setTimeout(() => target.classList.remove("trackFocus"), 1800);
}

function nowPlayingBadgeHtml(track = {}, source = "") {
  const scoreBadge = compactScoreBadgeHtml(track);
  if (scoreBadge) return scoreBadge;
  const feedbackLabel = feedbackBadgeLabel(track.feedback || feedbackForTrack(track));
  if (feedbackLabel) return `<span class="scoreBadge feedback">${escapeHtml(feedbackLabel)}</span>`;
  const label = source === "memory" ? "Remembered track" : "Unscored now playing";
  return `<span class="scoreBadge unscored">${escapeHtml(label)}</span>`;
}

function selectedTidalPlaylist() {
  return state.tidalPlaylists.find((playlist) => playlist.id === state.selectedTidalPlaylistId) || state.tidalPlaylists[0] || null;
}

function selectedTidalSeedPlaylist() {
  return state.tidalPlaylists.find((playlist) => playlist.id === state.selectedTidalSeedPlaylistId) || state.tidalPlaylists[0] || null;
}

function ensureSelectedTidalPlaylistIds() {
  if (!state.tidalPlaylists.length) return;
  if (!state.tidalPlaylists.some((playlist) => playlist.id === state.selectedTidalPlaylistId)) {
    state.selectedTidalPlaylistId = state.tidalPlaylists[0].id;
    localStorage.setItem("tidalPlaylistId", state.selectedTidalPlaylistId);
  }
  if (!state.tidalPlaylists.some((playlist) => playlist.id === state.selectedTidalSeedPlaylistId)) {
    state.selectedTidalSeedPlaylistId = state.tidalPlaylists[0].id;
    localStorage.setItem("tidalSeedPlaylistId", state.selectedTidalSeedPlaylistId);
  }
}

function tidalPlaylistOptionsKey() {
  return state.tidalPlaylists.map((playlist) => `${playlist.id}:${playlist.title}:${Number(playlist.itemCount || 0)}`).join("|");
}

function tidalPlaylistOptionsHtml() {
  return state.tidalPlaylists.map((playlist) => {
    const count = Number(playlist.itemCount || 0);
    const suffix = count ? ` (${count})` : "";
    return `<option value="${escapeHtml(playlist.id)}">${escapeHtml(playlist.title + suffix)}</option>`;
  }).join("");
}

function setSelectOptionsIfChanged(select, html, renderKey) {
  if (select.dataset.renderKey === renderKey) return;
  const currentValue = select.value;
  select.innerHTML = html;
  select.dataset.renderKey = renderKey;
  if (currentValue && Array.from(select.options).some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function selectedNowTidalPlaylists() {
  const primary = selectedTidalPlaylist();
  const full = playerFullscreenElement() === document.querySelector(".player");
  const ids = [
    state.nowTidalPlaylistArmed?.[0] !== false ? primary?.id : "",
    ...(full ? state.extraTidalPlaylistIds.map((id, index) => state.nowTidalPlaylistArmed?.[index + 1] ? id : "") : [])
  ].filter(Boolean);
  return [...new Set(ids)].map(id => state.tidalPlaylists.find(playlist => playlist.id === id)).filter(Boolean);
}

function renderNowTidalPlaylistControl(track = state.nowTrack) {
  renderPrimaryNowTidalPlaylistControl(track);
  const available = !state.tidalPlaylistsError && state.tidalPlaylists.length > 0;
  const primaryArm = $("#nowTidalPlaylistArm1");
  if (primaryArm) {
    primaryArm.checked = state.nowTidalPlaylistArmed?.[0] !== false;
    primaryArm.disabled = !available || state.nowTidalAddBusy;
  }
  for (const [index, id] of ["#nowTidalPlaylistSelect2", "#nowTidalPlaylistSelect3"].entries()) {
    const select = $(id);
    const arm = $(`#nowTidalPlaylistArm${index + 2}`);
    if (arm) {
      arm.checked = Boolean(state.nowTidalPlaylistArmed?.[index + 1]);
      arm.disabled = !available || state.nowTidalAddBusy || !state.extraTidalPlaylistIds[index];
    }
    if (!select) continue;
    const placeholder = '<option value="">None</option>';
    setSelectOptionsIfChanged(select, placeholder + (available ? tidalPlaylistOptionsHtml() : ""), `extra:${index}:${available ? tidalPlaylistOptionsKey() : "unavailable"}`);
    select.value = state.extraTidalPlaylistIds[index];
    if (select.selectedIndex < 0) select.value = "";
    select.disabled = !available || state.nowTidalAddBusy;
  }
  const button = $("#addNowToTidalPlaylist");
  if (button && !state.nowTidalAddBusy) {
    const count = selectedNowTidalPlaylists().length;
    button.textContent = count > 1 ? `Add to ${count} TIDAL playlists` : "Add to TIDAL";
  }
  if (state.nowTidalAddBusy) {
    if (button) button.disabled = true;
    for (const id of ["#nowTidalPlaylistSelect", "#nowTidalPlaylistArm1", "#createNowTidalPlaylist", "#nowTidalPlaylistName"]) {
      const element = $(id);
      if (element) element.disabled = true;
    }
  }
}

function renderPrimaryNowTidalPlaylistControl(track = state.nowTrack) {
  const select = $("#nowTidalPlaylistSelect");
  const button = $("#addNowToTidalPlaylist");
  const status = $("#nowTidalPlaylistStatus");
  const createButton = $("#createNowTidalPlaylist");
  const createInput = $("#nowTidalPlaylistName");
  if (!select || !button || !status) return;
  const createDisabled = state.tidalPlaylistsLoading;
  if (createButton) createButton.disabled = createDisabled;
  if (createInput) createInput.disabled = createDisabled;

  if (state.tidalPlaylistsLoading) {
    if (state.tidalPlaylistsLoaded && state.tidalPlaylists.length) {
      ensureSelectedTidalPlaylistIds();
      setSelectOptionsIfChanged(select, tidalPlaylistOptionsHtml(), `ready:${tidalPlaylistOptionsKey()}`);
      if (select.value !== state.selectedTidalPlaylistId) select.value = state.selectedTidalPlaylistId;
      select.disabled = false;
      button.disabled = !track || !state.selectedTidalPlaylistId;
      if (!status.textContent) {
        status.textContent = state.tidalPlaylistsFromCache ? "Using cached TIDAL playlists; refreshing..." : "";
      }
      return;
    }
    setSelectOptionsIfChanged(select, "<option value=\"\">Loading TIDAL playlists...</option>", "loading");
    select.disabled = true;
    button.disabled = true;
    status.textContent = "";
    return;
  }

  if (state.tidalPlaylistsError) {
    setSelectOptionsIfChanged(select, "<option value=\"\">TIDAL playlists unavailable</option>", `error:${state.tidalPlaylistsError}`);
    select.disabled = false;
    button.disabled = true;
    status.textContent = state.tidalPlaylistsError;
    return;
  }

  if (!state.tidalPlaylistsLoaded) {
    setSelectOptionsIfChanged(select, "<option value=\"\">Load TIDAL playlists...</option>", "not-loaded");
    select.disabled = true;
    button.disabled = true;
    status.textContent = "";
    return;
  }

  if (!state.tidalPlaylists.length) {
    setSelectOptionsIfChanged(select, "<option value=\"\">No TIDAL playlists found</option>", "empty");
    select.disabled = false;
    button.disabled = true;
    status.textContent = "Create a playlist below, or refresh after creating one in TIDAL.";
    return;
  }

  ensureSelectedTidalPlaylistIds();
  setSelectOptionsIfChanged(select, tidalPlaylistOptionsHtml(), `ready:${tidalPlaylistOptionsKey()}`);
  if (select.value !== state.selectedTidalPlaylistId) select.value = state.selectedTidalPlaylistId;
  select.disabled = false;
  button.disabled = !track || !selectedNowTidalPlaylists().length;
  if (state.tidalPlaylistsWarning && !status.textContent) status.textContent = state.tidalPlaylistsWarning;
  if (!state.tidalPlaylistsWarning && /^Using cached TIDAL playlists; refreshing/i.test(status.textContent || "")) {
    status.textContent = "";
  }
}

async function createNowTidalPlaylist(button = $("#createNowTidalPlaylist")) {
  const input = $("#nowTidalPlaylistName");
  const status = $("#nowTidalPlaylistStatus");
  const title = input?.value?.trim() || "";
  if (!title) return alert("Enter a TIDAL playlist name first.");

  const originalText = button?.textContent || "Create playlist";
  if (button) {
    button.disabled = true;
    button.textContent = "Creating...";
  }
  if (status) status.textContent = "Creating TIDAL playlist...";
  try {
    const result = await api("/api/tidal/playlist", {
      title,
      description: "Created from Rabbit Hole."
    });
    const playlist = result.playlist || {};
    state.tidalPlaylistsLoaded = true;
    state.tidalPlaylistsError = "";
    state.tidalPlaylists = [
      playlist,
      ...state.tidalPlaylists.filter((item) => item.id !== playlist.id)
    ].filter((item) => item?.id);
    state.tidalPlaylistsFromCache = false;
    state.tidalPlaylistsWarning = "";
    writeCachedTidalPlaylists(state.tidalPlaylists);
    state.selectedTidalPlaylistId = playlist.id || "";
    if (state.selectedTidalPlaylistId) localStorage.setItem("tidalPlaylistId", state.selectedTidalPlaylistId);
    if (input) input.value = "";
    renderNowTidalPlaylistControl();
    renderTidalPlaylistSeedControl();
    renderPlaylistBrowser();
    if (status) status.textContent = `Created ${playlist.title || title}.`;
  } catch (error) {
    if (status) status.textContent = error.message;
    alert(error.message);
  } finally {
    if (button) {
      button.textContent = originalText;
      button.disabled = false;
    }
  }
}

function renderTidalPlaylistSeedControl() {
  const select = $("#tidalPlaylistSeedSelect");
  const button = $("#useTidalPlaylistSeed");
  const status = $("#tidalPlaylistSeedStatus");
  if (!select || !button || !status) return;

  if (state.tidalPlaylistsLoading) {
    if (state.tidalPlaylistsLoaded && state.tidalPlaylists.length) {
      ensureSelectedTidalPlaylistIds();
      setSelectOptionsIfChanged(select, tidalPlaylistOptionsHtml(), `ready:${tidalPlaylistOptionsKey()}`);
      if (select.value !== state.selectedTidalSeedPlaylistId) select.value = state.selectedTidalSeedPlaylistId;
      select.disabled = false;
      button.disabled = !state.selectedTidalSeedPlaylistId;
      if (!status.textContent || /^(?:Loading|Refresh TIDAL|No TIDAL|TIDAL playlists unavailable)/i.test(status.textContent)) {
        status.textContent = state.tidalPlaylistsFromCache
          ? `${state.tidalPlaylists.length} cached TIDAL playlists; refreshing...`
          : `${state.tidalPlaylists.length} TIDAL playlists available`;
      }
      return;
    }
    setSelectOptionsIfChanged(select, "<option value=\"\">Loading TIDAL playlists...</option>", "loading");
    select.disabled = true;
    button.disabled = true;
    status.textContent = "Loading TIDAL playlists...";
    return;
  }

  if (state.tidalPlaylistsError) {
    setSelectOptionsIfChanged(select, "<option value=\"\">TIDAL playlists unavailable</option>", `error:${state.tidalPlaylistsError}`);
    select.disabled = false;
    button.disabled = true;
    status.textContent = state.tidalPlaylistsError;
    return;
  }

  if (!state.tidalPlaylistsLoaded) {
    setSelectOptionsIfChanged(select, "<option value=\"\">Load TIDAL playlists...</option>", "not-loaded");
    select.disabled = false;
    button.disabled = true;
    status.textContent = "Refresh TIDAL to load playlists.";
    return;
  }

  if (!state.tidalPlaylists.length) {
    setSelectOptionsIfChanged(select, "<option value=\"\">No TIDAL playlists found</option>", "empty");
    select.disabled = false;
    button.disabled = true;
    status.textContent = "No TIDAL playlists found";
    return;
  }

  ensureSelectedTidalPlaylistIds();
  setSelectOptionsIfChanged(select, tidalPlaylistOptionsHtml(), `ready:${tidalPlaylistOptionsKey()}`);
  if (select.value !== state.selectedTidalSeedPlaylistId) select.value = state.selectedTidalSeedPlaylistId;
  select.disabled = false;
  button.disabled = !state.selectedTidalSeedPlaylistId;
  if (!status.textContent || /^(?:Loading|Refresh TIDAL|No TIDAL|TIDAL playlists unavailable|\d+ cached TIDAL playlists)/i.test(status.textContent)) {
    status.textContent = state.tidalPlaylistsWarning || `${state.tidalPlaylists.length} TIDAL playlists available`;
  }
}

async function loadTidalPlaylists({ force = false } = {}) {
  if (state.tidalPlaylistsLoading) return;
  if (!force && state.tidalPlaylistsLoaded && !state.tidalPlaylistsFromCache) {
    renderNowTidalPlaylistControl();
    renderTidalPlaylistSeedControl();
    renderPlaylistBrowser();
    return;
  }
  state.tidalPlaylistsLoading = true;
  state.tidalPlaylistsError = "";
  state.tidalPlaylistsWarning = "";
  const previousPlaylists = state.tidalPlaylists.slice();
  renderNowTidalPlaylistControl();
  renderTidalPlaylistSeedControl();
  try {
    const result = await getJson(`/api/tidal/playlists${force ? "?refresh=1" : ""}`);
    const playlists = Array.isArray(result.playlists)
      ? result.playlists.map(normalizeCachedTidalPlaylist).filter(Boolean)
      : [];
    const resultError = result.connected === false ? (result.error || "Connect TIDAL profile access first.") : "";
    if (resultError && !playlists.length && previousPlaylists.length) {
      state.tidalPlaylists = previousPlaylists;
      state.tidalPlaylistsLoaded = true;
      state.tidalPlaylistsFromCache = true;
      state.tidalPlaylistsError = "";
      state.tidalPlaylistsWarning = `Using cached TIDAL playlists; refresh failed: ${resultError}`;
      return;
    }
    state.tidalPlaylists = playlists;
    state.tidalPlaylistsLoaded = true;
    state.tidalPlaylistsFromCache = false;
    state.tidalPlaylistsError = resultError;
    if (playlists.length) writeCachedTidalPlaylists(playlists);
  } catch (error) {
    if (state.tidalPlaylists.length) {
      state.tidalPlaylistsLoaded = true;
      state.tidalPlaylistsFromCache = true;
      state.tidalPlaylistsError = "";
      state.tidalPlaylistsWarning = `Using cached TIDAL playlists; refresh failed: ${error.message}`;
    } else {
      state.tidalPlaylists = [];
      state.tidalPlaylistsLoaded = false;
      state.tidalPlaylistsFromCache = false;
      state.tidalPlaylistsError = error.message;
    }
  } finally {
    state.tidalPlaylistsLoading = false;
    renderNowTidalPlaylistControl();
    renderTidalPlaylistSeedControl();
    renderPlaylistBrowser();
  }
}

async function addNowTrackToTidalPlaylist(button = $("#addNowToTidalPlaylist")) {
  if (state.nowTidalAddBusy) return;
  // Capture one track and all destinations before any asynchronous request or track change.
  const current = state.nowTrack || nowPlayingTrack(activeZone());
  const track = current ? JSON.parse(JSON.stringify(current)) : null;
  const playlists = selectedNowTidalPlaylists().map(playlist => ({ id: playlist.id, title: playlist.title }));
  const status = $("#nowTidalPlaylistStatus");
  if (!track) return alert("There is no current track to add.");
  if (!playlists.length) return alert("Choose a TIDAL playlist first.");
  state.nowTidalAddBusy = true;
  renderNowTidalPlaylistControl();
  const outcomes = [];
  const trackLabel = [track.artist, track.title].filter(Boolean).join(" - ") || "Current track";
  try {
    for (const [index, playlist] of playlists.entries()) {
      if (button) button.textContent = playlists.length > 1 ? `Adding ${index + 1} / ${playlists.length}…` : "Checking…";
      if (status) status.textContent = `Adding ${trackLabel} to ${playlist.title}…`;
      try {
        const request = { playlistId: playlist.id, playlistTitle: playlist.title, track };
        let result = await api("/api/tidal/playlist-track", request);
        if (result.duplicate && result.added === false) {
          if (!confirm(`${trackLabel} is already in ${playlist.title}.\n\nAdd it again anyway?`)) {
            outcomes.push(`Already in ${playlist.title}`);
            continue;
          }
          result = await api("/api/tidal/playlist-track", { ...request, allowDuplicate: true });
        } else if (result.duplicateCheckUnavailable && result.added === false) {
          const reason = result.duplicateCheckError || "TIDAL rate limit";
          if (!confirm(`Rabbit Hole could not check ${playlist.title} for duplicates.\n\nReason: ${reason}\n\nAdd it anyway?`)) {
            outcomes.push(`Skipped ${playlist.title}: duplicate check unavailable`);
            continue;
          }
          result = await api("/api/tidal/playlist-track", { ...request, allowDuplicate: true });
        }
        if (result.added === false) throw new Error(result.error || result.reason || "TIDAL did not add the track.");
        outcomes.push(`Added to ${playlist.title}`);
      } catch (error) {
        // One playlist failure must not prevent the other selected destinations.
        outcomes.push(`Failed: ${playlist.title} — ${error.message}`);
      }
    }
  } finally {
    state.nowTidalAddBusy = false;
    renderNowTidalPlaylistControl();
    if (status) status.textContent = `${trackLabel}: ${outcomes.join(" · ")}`;
  }
}

function updateNowDiscoveryTools(zone = activeZone()) {
  const tools = $("#nowDiscoveryTools");
  const feedback = $("#nowFeedback");
  const badge = $("#nowDiscoveryBadge");
  const openRabbitHole = $("#openRabbitHole");
  const rabbitHolePanel = $("#rabbitHolePanel");
  if (!tools || !feedback || !badge || !openRabbitHole || !rabbitHolePanel) return;

  const match = findNowPlayingMatch(zone);
  state.nowMatchIndex = match.index;
  state.nowTrack = match.track;
  state.nowTrackSource = match.source;

  if (!match.track) {
    tools.hidden = true;
    feedback.innerHTML = "";
    feedback.dataset.renderKey = "";
    badge.innerHTML = "";
    renderNowTidalPlaylistControl(null);
    openRabbitHole.disabled = true;
    rabbitHolePanel.hidden = true;
    return;
  }

  tools.hidden = false;
  const feedbackRenderKey = `${trackKeyFor(match.track)}|${normalizeFeedbackValue(match.track.feedback || "")}`;
  if (feedback.dataset.renderKey !== feedbackRenderKey) {
    feedback.innerHTML = feedbackButtonsHtml(match.track, 0, "now");
    feedback.dataset.renderKey = feedbackRenderKey;
  }
  badge.innerHTML = nowPlayingBadgeHtml(match.track, match.source);
  renderNowTidalPlaylistControl(match.track);
  if (!state.tidalPlaylistsLoaded && !state.tidalPlaylistsLoading && !state.tidalPlaylistsError) {
    loadTidalPlaylists().catch(() => {});
  }
  openRabbitHole.disabled = false;
  if (!rabbitHolePanel.hidden) {
    const nextKey = trackKeyFor(match.track);
    if (state.rabbitHoleKey !== nextKey) {
      loadRabbitHole(match.track).catch(() => {});
    }
  }
  cleanRenderedArtifacts(tools);
}

function setFeedbackButtonsActive(container, rating) {
  const normalized = normalizeFeedbackValue(rating);
  container.querySelectorAll(".feedbackButton").forEach((button) => {
    const buttonRating = normalizeFeedbackValue(button.dataset.nowFeedback || button.dataset.feedback);
    const active = buttonRating === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  container.dataset.renderKey = `${trackKeyFor(state.nowTrack)}|${normalized}`;
}

function scoreBreakdownHtml(track) {
  const breakdown = track.scoreBreakdown || {};
  const score = track.score || breakdown.total || "";
  if (!score && !Object.keys(breakdown).length) return "";
  const band = scoreBandFor(score);

  const rows = [
    ["Freshness", breakdown.freshness, breakdown.max?.freshness || SCORE_MAX.freshness],
    ["Label Match", breakdown.labelMatch, breakdown.max?.labelMatch || SCORE_MAX.labelMatch],
    ["Artist Match", breakdown.artistMatch, breakdown.max?.artistMatch || SCORE_MAX.artistMatch],
    ["Length Preference", breakdown.lengthPreference, breakdown.max?.lengthPreference || SCORE_MAX.lengthPreference],
    ["Genre Match", breakdown.genreMatch, breakdown.max?.genreMatch || SCORE_MAX.genreMatch]
  ].filter((row) => row[1] !== undefined && row[1] !== null && row[1] !== "");

  if (breakdown.genreInference?.confidence) {
    rows.push(["Genre Confidence", breakdown.genreInference.confidence, 100]);
  }
  if (breakdown.vibeInference?.confidence) {
    rows.push(["Trait Confidence", breakdown.vibeInference.confidence, 100]);
  }

  if (breakdown.tasteAdjustment) {
    rows.push(["Taste Adjustment", breakdown.tasteAdjustment, 12]);
  }
  if (breakdown.artistDiversityAdjustment) {
    rows.push(["Artist Diversity Adjustment", breakdown.artistDiversityAdjustment, 12]);
  }
  if (breakdown.calibrationAdjustment) {
    rows.push(["Calibration Adjustment", breakdown.calibrationAdjustment, 10]);
  }
  if (breakdown.serendipityAdjustment) {
    rows.push(["Serendipity Adjustment", breakdown.serendipityAdjustment, 8]);
  }

  return `
    <div class="scoreBox">
      <div class="scoreTotal">
        <span>Discovery Score: <strong>${escapeHtml(score)}</strong></span>
        <span class="scoreBadge ${escapeHtml(band.className)}">${escapeHtml(track.belowMinimum ? `${band.label} - below minimum` : band.label)}</span>
      </div>
      <div class="scoreGrid">
        ${rows.map(([label, value, max]) => `
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}${label.endsWith("Adjustment") ? "" : `/${escapeHtml(max)}`}</strong>
        `).join("")}
      </div>
    </div>
  `;
}

function matchSplitHtml(track) {
  const breakdown = track.scoreBreakdown || {};
  const prompt = breakdown.promptMatch || track.promptMatch || {};
  const taste = breakdown.tasteMatch || track.tasteMatch || {};
  const genre = breakdown.matchGenre || track.matchGenre || "";
  const why = Array.isArray(breakdown.matchWhy) && breakdown.matchWhy.length
    ? breakdown.matchWhy
    : (Array.isArray(track.matchWhy) ? track.matchWhy : []);
  const hasPrompt = prompt.percent !== undefined && prompt.percent !== null && prompt.percent !== "";
  const hasTaste = taste.percent !== undefined && taste.percent !== null && taste.percent !== "";
  if (!hasPrompt && !hasTaste && !genre && !why.length) return "";

  return `
    <div class="matchInsight">
      <div class="matchMeters">
        ${hasPrompt ? `
          <div class="matchMeter prompt">
            <span>Prompt Match</span>
            <strong>${escapeHtml(prompt.percent)}%</strong>
            ${prompt.label ? `<em>${escapeHtml(prompt.label)}</em>` : ""}
          </div>
        ` : ""}
        ${hasTaste ? `
          <div class="matchMeter taste">
            <span>Taste Match</span>
            <strong>${escapeHtml(taste.percent)}%</strong>
            ${taste.label ? `<em>${escapeHtml(taste.label)}</em>` : ""}
          </div>
        ` : ""}
      </div>
      ${genre ? `<p class="matchGenre"><span>Genre:</span> <strong>${escapeHtml(genre)}</strong></p>` : ""}
      ${why.length ? `
        <div class="matchWhy">
          <span>Why:</span>
          <ul>${why.slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      ` : ""}
    </div>
  `;
}

function whyMatchedHtml(track) {
  const bullets = Array.isArray(track.why) && track.why.length
    ? track.why
    : (track.reason ? String(track.reason).split(/\s*;\s*/).filter(Boolean) : []);
  if (!bullets.length) return "";
  return `
    <div class="reasonBlock">
      <p class="reasonTitle">Why this matched</p>
      <ul>
        ${bullets.slice(0, 6).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function statusChecksHtml(track) {
  const statuses = Array.isArray(track.statusChecks) && track.statusChecks.length
    ? track.statusChecks
    : ["TIDAL verified", "History status not checked"];
  return `
    <div class="statusBlock">
      ${statuses.map((status) => {
        const label = status === "Scrobble history not connected" ? "Scrobble history not checked" : status;
        return `<span class="statusChip">${escapeHtml(label)}</span>`;
      }).join("")}
    </div>
  `;
}

function queueReportHtml(result = {}) {
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const queued = Array.isArray(result.queued) ? result.queued : [];
  const title = `Queued ${result.queuedCount || queued.length}/${result.requested || queued.length + failed.length}`;
  const targetReached = Number(result.queuedCount || queued.length) >= Number(result.requested || 0);
  const backupCount = queued.filter((item) => item.isAlternate).length;
  const actionText = result.topOfQueue ? "added next after the current track" : "added to the existing Roon queue";
  const addedTracks = queued.slice(0, 18);
  return `
    <div>
      <strong>${escapeHtml(title)}</strong>
      ${queued.length ? `<p>${escapeHtml(`${queued.length} Rabbit Hole track${queued.length === 1 ? "" : "s"} ${actionText}. Existing queue items may still appear above them in Roon.`)}</p>` : ""}
      ${backupCount ? `<p>${escapeHtml(backupCount)} backup track${backupCount === 1 ? "" : "s"} used to fill the queue.</p>` : ""}
      ${result.warning ? `<p>${escapeHtml(result.warning)}</p>` : ""}
      ${addedTracks.length ? `
        <div class="queueReportAdded">
          <span>Added tracks</span>
          <ol>
            ${addedTracks.map((item) => {
              const track = item.track || {};
              const subtitle = [
                track.artist,
                track.album,
                track.year || ""
              ].filter(Boolean).join(" - ");
              const requested = track.requestedTitle && track.requestedTitle !== track.title
                ? `Requested as ${track.requestedTitle}`
                : "";
              return `
                <li>
                  <strong>${escapeHtml(track.title || "Unknown title")}</strong>
                  <span>${escapeHtml(subtitle || "Rabbit Hole result")}</span>
                  ${requested ? `<span>${escapeHtml(requested)}</span>` : ""}
                </li>
              `;
            }).join("")}
          </ol>
        </div>
      ` : ""}
      ${failed.length ? `
        <p>${escapeHtml(failed.length)} queue attempt${failed.length === 1 ? "" : "s"} failed${targetReached ? ", but the target count was reached." : ":"}</p>
        <ul>
          ${failed.slice(0, 12).map((item) => `
            <li>
              <strong>${escapeHtml(item.track?.artist || "Unknown artist")} - ${escapeHtml(item.track?.title || "Unknown title")}</strong>
              <span>${escapeHtml(item.reason || "No usable Roon action.")}</span>
            </li>
          `).join("")}
        </ul>
      ` : "<p>All displayed tracks were accepted by Roon.</p>"}
    </div>
  `;
}

function showQueueReport(result = null) {
  const report = $("#queueReport");
  if (!report) return;
  if (!result) {
    report.hidden = true;
    report.innerHTML = "";
    return;
  }
  report.hidden = false;
  report.innerHTML = queueReportHtml(result);
}

function tidalPlaylistReportHtml(result = {}) {
  const playlist = result.playlist || {};
  const url = safeHttpUrl(playlist.url);
  const skipped = Number(result.skippedCount || 0);
  const added = Number(result.addedCount || 0);
  const requested = Number(result.requested || 0);
  return `
    <div>
      <strong>Created TIDAL playlist${playlist.title ? `: ${escapeHtml(playlist.title)}` : ""}</strong>
      <p>Added ${escapeHtml(added)} of ${escapeHtml(requested)} track${requested === 1 ? "" : "s"} by TIDAL ID${skipped ? `; skipped ${escapeHtml(skipped)} without TIDAL IDs` : ""}.</p>
      ${url ? `<p><a class="buttonLink" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open TIDAL playlist</a></p>` : ""}
      <p>After TIDAL syncs, refresh Roon playlists if you want to queue the playlist from Roon.</p>
    </div>
  `;
}

function showTidalPlaylistReport(result = null) {
  const report = $("#queueReport");
  if (!report) return;
  if (!result) {
    showQueueReport(null);
    return;
  }
  report.hidden = false;
  report.innerHTML = tidalPlaylistReportHtml(result);
}

function discardedReasonSummary(discarded = []) {
  const counts = new Map();
  for (const item of discarded) {
    const reason = String(item.reason || "No reason provided").replace(/\s+/g, " ").trim();
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10);
}

function incrementCount(map, key, amount = 1) {
  const label = String(key || "").trim() || "Unknown";
  map.set(label, (map.get(label) || 0) + amount);
}

function sortedCounts(map, limit = 8) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function rejectionBucketFor(item = {}) {
  const reason = String(item.reason || "").toLowerCase();
  if (/\b(?:seo|catalogue filler|catalog filler|genre date|mix compilation|filler|sludge)\b/.test(reason)) return "SEO/catalog sludge";
  if (/\b(?:roon|queueable|queue action|exact queueable match|best result)\b/.test(reason)) return "Roon not queueable";
  if (/\b(?:outside the requested|genre\/vibe|requested genre|scene|wrong genre|does not confirm|search query|corroborat|metadata)\b/.test(reason)) return "Genre/scene mismatch";
  if (/\b(?:release|year|date|outside \d{4}|range)\b/.test(reason)) return "Date/range mismatch";
  if (/\b(?:previously suggested|held back|history|already suggested|already recommended|not recommended before)\b/.test(reason)) return "Previously suggested";
  if (/\b(?:below minimum|minimum)\b/.test(reason)) return "Below minimum";
  if (/\b(?:model rejected|model candidate|local model)\b/.test(reason)) return "Model rejected";
  if (/\b(?:short|radio edit)\b/.test(reason)) return "Short/edit";
  if (/\b(?:tidal|verified|verification)\b/.test(reason)) return "TIDAL verification";
  return "Other discarded";
}

function sourceReportFor(result = {}) {
  const verification = result.verification || {};
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const sources = new Map();
  const lanes = new Map();
  const rejectionBuckets = new Map();

  for (const track of tracks) {
    incrementCount(sources, track.discoverySource || "TIDAL search");
    incrementCount(lanes, track.discoveryLane || "core");
  }
  for (const item of discarded) {
    incrementCount(rejectionBuckets, rejectionBucketFor(item));
  }

  const autoBroaden = verification.autoBroaden || {};
  const laneQuotas = verification.laneQuotas || {};
  const lastfm = verification.lastfm || {};
  const calibration = sourceReportCalibration(verification);
  const queryYield = verification.queryYield || {};
  const exactArtistMatches = tracks.filter(artistCreditConfirmed).length;
  const broaderRoonMatches = tracks.filter((track) => roonVisibleTrack(track) && !artistCreditConfirmed(track)).length;
  const calibrationIssues = calibrationIssueCount(calibration);
  const metrics = [
    ["Generated", verification.generated || tracks.length + discarded.length || tracks.length],
    ["Kept", verification.kept ?? tracks.length],
    ["Discarded", verification.discarded ?? discarded.length],
    ["Roon checked", verification.roonChecked || 0],
    ["Roon rejected", verification.roonRejected || 0],
    ["Exact artist", exactArtistMatches],
    ["Broader Roon", broaderRoonMatches],
    ["Below floor kept", verification.belowMinimumKept || 0],
    ["Auto-broaden added", autoBroaden.added || 0],
    ["Yield retries", autoBroaden.yieldAware ? (autoBroaden.lanes || []).filter((lane) => lane.yieldAware).length || 1 : 0],
    ["Last.fm scrobbles", lastfm.checked ? (lastfm.returned || 0) : "not checked"],
    ["Last.fm top artists", lastfm.checked ? (lastfm.topArtistsReturned || 0) : "not checked"],
    ["Query accepted", queryYield.accepted || 0],
    ["Query sludge", Number(queryYield.seoRejects || 0) + Number(queryYield.genreRejects || 0)],
    ["Queries skipped", queryYield.prunedCount || 0],
    ["Calibration issues", calibrationIssues]
  ];

  return {
    metrics,
    sources: sortedCounts(sources, 8),
    lanes: sortedCounts(lanes, 8),
    rejectionBuckets: sortedCounts(rejectionBuckets, 8),
    autoBroaden,
    model: {
      queryCount: verification.modelPlanQueryCount || 0,
      skipped: verification.modelSkipped || "",
      error: verification.modelError || "",
      review: verification.modelCandidateReview || null
    },
    roon: {
      checked: verification.roonChecked || 0,
      rejected: verification.roonRejected || 0,
      limit: verification.roonCheckLimit || 0,
      queueable: Boolean(verification.roonQueueable),
      error: verification.roonVerificationError || ""
    },
    laneQuotas,
    lastfm,
    calibration,
    queryYield
  };
}

function fallbackPoolDiagnosticsFor(result = {}) {
  const verification = result.verification || {};
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const alternates = Array.isArray(result.alternates) ? result.alternates : [];
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const groups = discardedReasonSummary(discarded);
  return {
    requested: verification.requested || result.requestedCount || tracks.length,
    generated: verification.generated || tracks.length + alternates.length + discarded.length,
    kept: verification.kept ?? tracks.length,
    alternates: alternates.length,
    discarded: verification.discarded ?? discarded.length,
    retainedPool: tracks.length + alternates.length,
    candidatePoolTarget: verification.candidatePoolTarget || 0,
    usefulCandidateTarget: verification.usefulCandidateTarget || 0,
    budgetExhausted: Boolean(verification.budgetExhausted),
    scoreFiltered: verification.scoreFiltered || 0,
    previousHeldBack: verification.previouslySuggestedHeldBack || 0,
    rescueAvailable: verification.belowMinimumRescueAvailable || 0,
    rescueKept: verification.belowMinimumRescueKept || 0,
    diversityCaps: {
      artistCap: verification.laneQuotas?.artistCap || null,
      labelCap: verification.laneQuotas?.labelCap || null,
      sourceCap: verification.laneQuotas?.sourceCap || null,
      labelSourceRelaxed: verification.laneQuotas?.labelSourceRelaxed || 0,
      topLabels: [],
      topSources: [],
      capHeld: {
        total: 0,
        label: [],
        source: []
      }
    },
    recentNovelty: {
      taxed: tracks.filter((track) => Number(track.recentSuggestionPenalty || 0) > 0).length,
      maxPenalty: Math.max(0, ...tracks.map((track) => Number(track.recentSuggestionPenalty || 0))),
      examples: []
    },
    queryYield: {
      attempted: verification.queryYield?.attempted || 0,
      returned: verification.queryYield?.returned || 0,
      accepted: verification.queryYield?.accepted || 0,
      rejected: verification.queryYield?.rejected || 0,
      sludge: Number(verification.queryYield?.seoRejects || 0) + Number(verification.queryYield?.genreRejects || 0),
      errors: verification.queryYield?.errorCount || 0,
      pruned: verification.queryYield?.prunedCount || 0,
      laneBudgetStops: Array.isArray(verification.queryYield?.laneBudgetStops)
        ? verification.queryYield.laneBudgetStops.length
        : 0
    },
    lanes: {
      selected: verification.laneQuotas?.selected || {},
      available: verification.laneQuotas?.available || {},
      targets: verification.laneQuotas?.targets || {}
    },
    buckets: groups.map(([label, count]) => ({
      label,
      count,
      examples: discarded
        .filter((item) => rejectionBucketFor(item) === label)
        .slice(0, 3)
        .map((item) => ({
          label: [item.artist, item.title].filter(Boolean).join(" - ") || item.query || "Unknown candidate",
          reason: item.reason || "No reason provided"
        }))
    })),
    notes: [
      verification.budgetExhausted ? "Runtime budget was exhausted before every crawl/search path could finish." : "",
      verification.previouslySuggestedHeldBack ? `${verification.previouslySuggestedHeldBack} previously suggested candidate${verification.previouslySuggestedHeldBack === 1 ? "" : "s"} held back for novelty.` : "",
      verification.belowMinimumRescueAvailable ? `${verification.belowMinimumRescueAvailable} below-floor candidate${verification.belowMinimumRescueAvailable === 1 ? "" : "s"} eligible as branch-out fallback.` : ""
    ].filter(Boolean)
  };
}

function poolDiagnosticsFor(result = {}) {
  const diagnostics = result.verification?.poolDiagnostics;
  if (diagnostics && typeof diagnostics === "object") {
    return {
      ...fallbackPoolDiagnosticsFor(result),
      ...diagnostics,
      queryYield: {
        ...fallbackPoolDiagnosticsFor(result).queryYield,
        ...(diagnostics.queryYield || {})
      },
      queryRecovery: {
        enabled: false,
        triggered: false,
        reason: "",
        attempted: 0,
        returned: 0,
        accepted: 0,
        errors: 0,
        targetLanes: [],
        laneShortfalls: [],
        families: [],
        ...(diagnostics.queryRecovery || {})
      },
      lanes: {
        ...fallbackPoolDiagnosticsFor(result).lanes,
        ...(diagnostics.lanes || {})
      },
      buckets: Array.isArray(diagnostics.buckets) ? diagnostics.buckets : fallbackPoolDiagnosticsFor(result).buckets,
      notes: Array.isArray(diagnostics.notes) ? diagnostics.notes : fallbackPoolDiagnosticsFor(result).notes
    };
  }
  return fallbackPoolDiagnosticsFor(result);
}

function poolBucketRowsHtml(buckets = []) {
  if (!buckets.length) return `<p class="sourceReportEmpty">No discarded candidates</p>`;
  return buckets.slice(0, 6).map((bucket) => {
    const examples = Array.isArray(bucket.examples) ? bucket.examples : [];
    const firstExample = examples[0];
    return `
      <li>
        <div>
          <strong>${escapeHtml(bucket.label || "Other discarded")}</strong>
          <b>${escapeHtml(bucket.count || 0)}</b>
        </div>
        ${firstExample ? `<span>${escapeHtml(firstExample.label || "Example")} - ${escapeHtml(firstExample.reason || "")}</span>` : ""}
      </li>
    `;
  }).join("");
}

function poolLaneRowsHtml(lanes = {}) {
  const selected = lanes.selected || {};
  const available = lanes.available || {};
  const targets = lanes.targets || {};
  const names = Array.from(new Set([...Object.keys(targets), ...Object.keys(available), ...Object.keys(selected)]))
    .filter((name) => Number(targets[name] || available[name] || selected[name] || 0) > 0);
  if (!names.length) return `<p class="sourceReportEmpty">No lane quota data</p>`;
  return names.slice(0, 8).map((name) => `
    <p>
      <span>${escapeHtml(name)}</span>
      <b>${escapeHtml(`${selected[name] || 0}/${available[name] || 0} kept${targets[name] ? `, target ${targets[name]}` : ""}`)}</b>
    </p>
  `).join("");
}

function recoveryFamilyRowsHtml(families = []) {
  if (!families.length) return `<p class="sourceReportEmpty">No recovery families were attempted</p>`;
  return families.slice(0, 8).map((family) => {
    const sludge = Number(family.seoRejects || 0) + Number(family.genreRejects || 0);
    const detail = [
      `${family.accepted || 0}/${family.returned || 0} accepted`,
      `${family.attempted || 0} searches`,
      family.rejected ? `${family.rejected} rejected` : "",
      sludge ? `${sludge} sludge` : "",
      family.errors ? `${family.errors} errors` : ""
    ].filter(Boolean).join(", ");
    const queryCount = family.queries ? `${family.queries} planned` : "";
    return `
      <li>
        <strong>${escapeHtml(family.label || family.id || "Recovery family")}</strong>
        <span>${escapeHtml(detail || "No yield")}</span>
        ${queryCount ? `<em>${escapeHtml(queryCount)}</em>` : ""}
      </li>
    `;
  }).join("");
}

function recoveryDetailsHtml(recovery = {}) {
  if (!recovery.triggered) return "";
  const families = Array.isArray(recovery.families) ? recovery.families : [];
  const shortfalls = Array.isArray(recovery.laneShortfalls) ? recovery.laneShortfalls : [];
  const best = families
    .slice()
    .sort((left, right) => (
      Number(right.accepted || 0) - Number(left.accepted || 0) ||
      Number(right.returned || 0) - Number(left.returned || 0) ||
      String(left.label || left.id || "").localeCompare(String(right.label || right.id || ""))
    ))[0];
  const bestText = best
    ? `best: ${best.label || best.id || "recovery"} (${best.accepted || 0}/${best.returned || 0})`
    : "no family yield";
  return `
    <details class="queryYieldDebug recoveryDetails">
      <summary>
        Recovery Details
        <span>${escapeHtml(bestText)}</span>
      </summary>
      <div class="modelAuditGrid">
        <section>
          <h3>Families</h3>
          <ol>${recoveryFamilyRowsHtml(families)}</ol>
        </section>
        <section>
          <h3>Lane gaps</h3>
          ${shortfalls.length
            ? `<ol>${shortfalls.map((item) => `
              <li>
                <strong>${escapeHtml(item.bucket || "lane")}</strong>
                <span>${escapeHtml(`${item.available || 0}/${item.target || 0} available`)}</span>
                <em>${escapeHtml(`${item.shortfall || 0} short`)}</em>
              </li>
            `).join("")}</ol>`
            : `<p class="sourceReportEmpty">No lane gap data</p>`}
        </section>
      </div>
    </details>
  `;
}

function capHeldRowsHtml(items = [], emptyText = "No cap-held examples") {
  if (!items.length) return `<p class="sourceReportEmpty">${escapeHtml(emptyText)}</p>`;
  return items.slice(0, 6).map((item) => {
    const capLine = item.cap ? `${item.count || item.cap}/${item.cap}` : "";
    const detail = [
      item.reason || "",
      item.bucket ? `lane ${item.bucket}` : "",
      item.score ? `score ${item.score}` : "",
      capLine ? `cap ${capLine}` : ""
    ].filter(Boolean).join(" - ");
    return `
      <li>
        <strong>${escapeHtml(item.candidate || "Unknown candidate")}</strong>
        <span>${escapeHtml(detail || "Held by diversity cap")}</span>
        ${item.label ? `<em>${escapeHtml(item.label)}</em>` : ""}
      </li>
    `;
  }).join("");
}

function capHeldDetailsHtml(diversityCaps = {}) {
  const capHeld = diversityCaps.capHeld || {};
  const total = Number(capHeld.total || 0);
  if (!total) return "";
  const labelItems = Array.isArray(capHeld.label) ? capHeld.label : [];
  const sourceItems = Array.isArray(capHeld.source) ? capHeld.source : [];
  return `
    <details class="queryYieldDebug capHeldDetails">
      <summary>
        Cap-Held Examples
        <span>${escapeHtml(`${total} held`)}</span>
      </summary>
      <div class="modelAuditGrid">
        <section>
          <h3>Label cap</h3>
          <ol>${capHeldRowsHtml(labelItems, "No label-cap examples")}</ol>
        </section>
        <section>
          <h3>Source cap</h3>
          <ol>${capHeldRowsHtml(sourceItems, "No source-cap examples")}</ol>
        </section>
      </div>
    </details>
  `;
}

function poolDiagnosticsHtml(result = {}) {
  const diagnostics = poolDiagnosticsFor(result);
  const query = diagnostics.queryYield || {};
  const recovery = diagnostics.queryRecovery || {};
  const artistSpread = diagnostics.artistSpread || {};
  const diversityCaps = diagnostics.diversityCaps || {};
  const recentNovelty = diagnostics.recentNovelty || {};
  const summary = `${diagnostics.kept || 0}/${diagnostics.requested || 0} kept, ${diagnostics.discarded || 0} rejected`;
  const metrics = [
    ["Generated", diagnostics.generated || 0],
    ["Retained pool", diagnostics.retainedPool || 0],
    ["Alternates", diagnostics.alternates || 0],
    ["Target pool", diagnostics.usefulCandidateTarget || diagnostics.candidatePoolTarget || "n/a"],
    ["Artist cap", artistSpread.artistCap || "n/a"],
    ["Label cap", diversityCaps.labelCap || "n/a"],
    ["Source cap", diversityCaps.sourceCap || "n/a"],
    ["Cap held", diversityCaps.capHeld?.total || 0],
    ["Below-floor considered", diagnostics.scoreFiltered || 0],
    ["Previous held", diagnostics.previousHeldBack || 0],
    ["Rescue kept", diagnostics.rescueKept || 0],
    ["Novelty taxed", recentNovelty.taxed ? `${recentNovelty.taxed} / max ${recentNovelty.maxPenalty || 0}` : 0],
    ["Query sludge", query.sludge || 0],
    ["Queries skipped", query.pruned || 0],
    ["Recovery accepted", recovery.triggered ? `${recovery.accepted || 0}/${recovery.returned || 0}` : "not needed"]
  ];
  const queryLine = [
    query.attempted ? `${query.attempted} searches` : "",
    query.returned ? `${query.returned} returned` : "",
    query.accepted ? `${query.accepted} accepted` : "0 accepted by query-yield",
    query.pruned ? `${query.pruned} skipped` : "",
    query.errors ? `${query.errors} errors` : ""
  ].filter(Boolean).join(", ");
  const recoveryLine = recovery.triggered
    ? [
      recovery.reason ? `${recovery.reason}` : "triggered",
      `${recovery.attempted || 0} searches`,
      `${recovery.returned || 0} returned`,
      `${recovery.accepted || 0} accepted`,
      recovery.errors ? `${recovery.errors} errors` : ""
    ].filter(Boolean).join(", ")
    : "";
  return `
    <div class="poolDiagnosticsCard">
      <div class="intentDebugHead">
        <span>Pool Diagnostics</span>
        <strong>${escapeHtml(summary)}</strong>
      </div>
      <div class="sourceReportMetrics poolMetrics">
        ${metrics.map(([label, value]) => `
          <p>
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
          </p>
        `).join("")}
      </div>
      <div class="poolDiagnosticsGrid">
        <section>
          <h3>Top losses</h3>
          <ol>${poolBucketRowsHtml(diagnostics.buckets || [])}</ol>
        </section>
        <section>
          <h3>Lane availability</h3>
          <div class="sourceReportGrid">${poolLaneRowsHtml(diagnostics.lanes || {})}</div>
        </section>
      </div>
      ${recoveryDetailsHtml(recovery)}
      ${capHeldDetailsHtml(diversityCaps)}
      <div class="sourceReportNotes poolNotes">
        <p><span>Budget</span><b>${diagnostics.budgetExhausted ? "runtime exhausted" : "completed within budget"}</b></p>
        <p><span>Query yield</span><b>${escapeHtml(queryLine || "no search query data")}</b></p>
        ${diversityCaps.labelSourceRelaxed ? `<p><span>Cap relaxation</span><b>${escapeHtml(`${diversityCaps.labelSourceRelaxed} kept after label/source caps relaxed`)}</b></p>` : ""}
        ${recoveryLine ? `<p><span>Recovery</span><b>${escapeHtml(recoveryLine)}</b></p>` : ""}
        ${(diagnostics.notes || []).slice(0, 4).map((note) => `<p><span>Note</span><b>${escapeHtml(note)}</b></p>`).join("")}
      </div>
    </div>
  `;
}

function showPoolDiagnostics(result = null) {
  const panel = $("#poolDiagnostics");
  if (!panel) return;
  if (!result) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = poolDiagnosticsHtml(result);
}

function sourceReportGridHtml(items = [], emptyText = "none") {
  if (!items.length) return `<p class="sourceReportEmpty">${escapeHtml(emptyText)}</p>`;
  return items.map(([label, count]) => `
    <p>
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(count)}</b>
    </p>
  `).join("");
}

function modelAuditDeltaText(item = {}) {
  if (item.after === null || item.after === undefined) return `was ${item.before || 0}`;
  const delta = Number(item.delta || 0);
  const sign = delta > 0 ? "+" : "";
  return `${item.before || 0} -> ${item.after || 0} (${sign}${delta})`;
}

function modelAuditItemsHtml(items = [], emptyText = "none") {
  if (!items.length) return `<p class="sourceReportEmpty">${escapeHtml(emptyText)}</p>`;
  return items.map((item) => `
    <li>
      <strong>${escapeHtml(item.label || "Unknown track")}</strong>
      <span>${escapeHtml(modelAuditDeltaText(item))} · model ${escapeHtml(item.modelScore || 0)} · genre ${escapeHtml(item.genreConfidence || 0)}</span>
      <em>${escapeHtml(item.reason || "Model score adjustment")}</em>
    </li>
  `).join("");
}

function modelReviewAuditHtml(audit = null) {
  if (!audit) return "";
  const total = Number(audit.boostedCount || 0) +
    Number(audit.downrankedCount || 0) +
    Number(audit.rejectedCount || 0) +
    Number(audit.warningCount || 0) +
    Number(audit.unchangedCount || 0);
  if (!total) return "";
  return `
    <details class="modelAudit">
      <summary>
        Model Review Audit
        <span>${escapeHtml(`${audit.boostedCount || 0} boosted, ${audit.downrankedCount || 0} downranked, ${audit.rejectedCount || 0} rejected`)}</span>
      </summary>
      <div class="modelAuditGrid">
        <section>
          <h3>Boosted</h3>
          <ol>${modelAuditItemsHtml(audit.boosted || [], "No boosted candidates")}</ol>
        </section>
        <section>
          <h3>Downranked</h3>
          <ol>${modelAuditItemsHtml(audit.downranked || [], "No downranked candidates")}</ol>
        </section>
        <section>
          <h3>Rejected / warned</h3>
          <ol>${modelAuditItemsHtml([...(audit.rejected || []), ...(audit.warnings || [])], "No model rejects or warnings")}</ol>
        </section>
      </div>
    </details>
  `;
}

function calibrationIssueLabel(issue = "") {
  const normalized = String(issue || "").toLowerCase();
  if (normalized === "wrong_genre") return "Wrong genre";
  if (normalized === "bad_boost") return "Bad boost";
  if (normalized === "liked_downranked") return "Liked but downranked";
  if (normalized === "negative_model_approved") return "Negative on approved track";
  if (normalized === "model_miss") return "Model miss";
  return normalized ? normalized.replace(/_/g, " ") : "Feedback mismatch";
}

function calibrationIssueCount(entry = {}) {
  return Number(entry.modelMisses || 0) + Number(entry.promptMismatches || 0);
}

function calibrationRecentHtml(items = []) {
  if (!items.length) return `<p class="sourceReportEmpty">No feedback mismatches yet</p>`;
  return items.slice(0, 6).map((item) => `
    <li>
      <strong>${escapeHtml([item.title, item.artist].filter(Boolean).join(" - ") || "Unknown track")}</strong>
      <span>${escapeHtml(`${calibrationIssueLabel(item.issue)}; you marked ${item.rating || "feedback"}; model ${item.modelAction || "unreviewed"}`)}</span>
      <em>${escapeHtml(`${item.source || "Unknown source"}${item.modelScore ? `; model ${item.modelScore}` : ""}${item.genreConfidence ? `; genre ${item.genreConfidence}` : ""}`)}</em>
    </li>
  `).join("");
}

function calibrationSourcesHtml(sources = []) {
  if (!sources.length) return `<p class="sourceReportEmpty">No calibrated sources yet</p>`;
  return sources.slice(0, 6).map((source) => `
    <p>
      <span>${escapeHtml(source.source || source.label || source.lane || source.name || "Unknown source")}</span>
      <b>${escapeHtml(`${calibrationIssueCount(source)}/${source.total || 0} issues`)}</b>
    </p>
  `).join("");
}

function feedbackCalibrationHtml(calibration = null) {
  if (!calibration || !Number(calibration.total || 0)) return "";
  const issueCount = calibrationIssueCount(calibration);
  const summary = `${issueCount} calibration issues: ${calibration.modelMisses || 0} model misses, ${calibration.promptMismatches || 0} wrong genre`;
  const watchedBuckets = [
    ...(calibration.sources || []).map((item) => ({ ...item, name: item.source })),
    ...(calibration.labels || []).map((item) => ({ ...item, name: item.label })),
    ...(calibration.lanes || []).map((item) => ({ ...item, name: item.lane }))
  ].sort((left, right) => (
    calibrationIssueCount(right) -
    calibrationIssueCount(left) ||
    Number(right.total || 0) - Number(left.total || 0)
  ));
  return `
    <details class="feedbackCalibration" open>
      <summary>
        Feedback Calibration
        <span>${escapeHtml(summary)}</span>
      </summary>
      <div class="feedbackCalibrationGrid">
        <section>
          <h3>Calibration totals</h3>
          <div class="sourceReportGrid">
            ${sourceReportGridHtml([
              ["Feedback with context", calibration.total || 0],
              ["Model-reviewed", calibration.reviewed || 0],
              ["Calibration issues", issueCount],
              ["Model misses", calibration.modelMisses || 0],
              ["Wrong genre", calibration.promptMismatches || 0],
              ["Bad boosts", calibration.badBoosts || 0],
              ["Liked downranks", calibration.missedLikes || 0]
            ])}
          </div>
        </section>
        <section>
          <h3>Sources / labels to watch</h3>
          <div class="sourceReportGrid">${calibrationSourcesHtml(watchedBuckets)}</div>
        </section>
        <section>
          <h3>Recent mismatches</h3>
          <ol>${calibrationRecentHtml(calibration.recent || [])}</ol>
        </section>
      </div>
    </details>
  `;
}

function queryYieldRowsHtml(items = [], emptyText = "none") {
  if (!items.length) return `<p class="sourceReportEmpty">${escapeHtml(emptyText)}</p>`;
  return items.slice(0, 6).map((item) => {
    const label = item.query || item.template || "Unknown query";
    const detail = [
      item.accepted !== undefined ? `${item.accepted || 0} accepted` : "",
      item.returned !== undefined ? `${item.returned || 0} returned` : "",
      item.rejected !== undefined ? `${item.rejected || 0} rejected` : "",
      item.seoRejects ? `${item.seoRejects} SEO` : "",
      item.genreRejects ? `${item.genreRejects} genre` : "",
      item.errorCount ? `${item.errorCount} errors` : "",
      item.quality !== undefined ? `quality ${item.quality}` : ""
    ].filter(Boolean).join(", ");
    return `
      <li>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(detail || "No yield details")}</span>
      </li>
    `;
  }).join("");
}

function queryYieldHtml(queryYield = {}) {
  const hasDetails = Boolean(
    (queryYield.best || []).length ||
    (queryYield.worst || []).length ||
    (queryYield.adjustments || []).length ||
    (queryYield.pruned || []).length
  );
  if (!hasDetails) return "";
  return `
    <details class="queryYieldDebug">
      <summary>
        Query Yield
        <span>${escapeHtml(`${queryYield.accepted || 0} accepted, ${Number(queryYield.seoRejects || 0) + Number(queryYield.genreRejects || 0)} sludge`)}</span>
      </summary>
      <div class="modelAuditGrid">
        <section>
          <h3>Best this run</h3>
          <ol>${queryYieldRowsHtml(queryYield.best || [], "No accepted query patterns")}</ol>
        </section>
        <section>
          <h3>Worst this run</h3>
          <ol>${queryYieldRowsHtml(queryYield.worst || [], "No weak query patterns")}</ol>
        </section>
        <section>
          <h3>Memory adjustments</h3>
          <ol>${queryYieldRowsHtml(queryYield.adjustments || [], "No prior query memory used")}</ol>
        </section>
        <section>
          <h3>Skipped before crawl</h3>
          <ol>${queryYieldRowsHtml(queryYield.pruned || [], "No query families skipped")}</ol>
        </section>
      </div>
    </details>
  `;
}

function sourceReportHtml(result = {}) {
  const report = sourceReportFor(result);
  const autoLanes = Array.isArray(report.autoBroaden.lanes) ? report.autoBroaden.lanes : [];
  const plannedAutoLanes = Array.isArray(report.autoBroaden.planned) ? report.autoBroaden.planned : [];
  const autoSummary = report.autoBroaden.attempted
    ? `${report.autoBroaden.attempted} pass${report.autoBroaden.attempted === 1 ? "" : "es"}, ${report.autoBroaden.added || 0} added`
    : (plannedAutoLanes.length ? `${plannedAutoLanes.length} planned, not needed` : "not needed");
  const adaptivePlanSummary = plannedAutoLanes.length
    ? plannedAutoLanes.map((lane) => lane.label || lane.lane).filter(Boolean).slice(0, 4).join(" -> ")
    : "";
  const yieldRetrySummary = report.autoBroaden.yieldAware && report.autoBroaden.queryYieldHealth
    ? report.autoBroaden.queryYieldHealth.summary || "weak query yield"
    : "";
  const modelSummary = report.model.error
    ? `model error: ${report.model.error}`
    : (report.model.skipped || `${report.model.queryCount} planned queries`);
  const review = report.model.review;
  const reviewWarnings = Number(review?.audit?.warningCount || review?.warningCount || 0);
  const reviewKeptAfterReject = Number(review?.rejectedKept || 0);
  const reviewSummary = review?.enabled
    ? [
      `${review.scored || 0} reviewed`,
      `${review.rejected || 0} rejected`,
      reviewWarnings ? `${reviewWarnings} warning${reviewWarnings === 1 ? "" : "s"}` : "",
      reviewKeptAfterReject ? `${reviewKeptAfterReject} kept for count` : ""
    ].filter(Boolean).join(", ")
    : (review?.error || "not run");
  const roonSummary = report.roon.error
    ? report.roon.error
    : `${report.roon.checked}/${report.roon.limit || report.roon.checked || 0} checked, ${report.roon.rejected} rejected`;
  const quotaSummary = report.laneQuotas?.enabled
    ? Object.entries(report.laneQuotas.selected || {})
      .filter(([, count]) => Number(count || 0) > 0)
      .map(([bucket, count]) => `${bucket}: ${count}`)
      .join(", ") || "none selected"
    : "not run";
  const quotaAdjustmentSummary = report.laneQuotas?.calibrationAdjustments?.length
    ? report.laneQuotas.calibrationAdjustments
      .map((item) => `${item.bucket}: ${item.target}->${item.adjustedTarget}`)
      .join(", ")
    : "";
  const lastfmSummary = report.lastfm.checked
    ? `${report.lastfm.returned || 0} scrobbles, ${report.lastfm.topArtistsReturned || 0} top artists${report.lastfm.topArtistPeriod ? ` (${report.lastfm.topArtistPeriod})` : ""}${report.lastfm.topArtistsError ? `; top artists: ${report.lastfm.topArtistsError}` : ""}`
    : (report.lastfm.error || report.lastfm.reason || "not checked");
  const queryYieldSummary = report.queryYield.recordCount
    ? `${report.queryYield.attempted || 0} queries, ${report.queryYield.accepted || 0} accepted, ${Number(report.queryYield.seoRejects || 0) + Number(report.queryYield.genreRejects || 0)} sludge, ${report.queryYield.prunedCount || 0} skipped`
    : (report.queryYield.enabled ? "no search queries recorded" : "run-only until server tracker records data");

  return `
    <div class="sourceReportCard">
      <div class="intentDebugHead">
        <span>Candidate Source Report</span>
        <strong>${escapeHtml(autoSummary)}</strong>
      </div>
      <div class="sourceReportMetrics">
        ${report.metrics.map(([label, value]) => `
          <p>
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
          </p>
        `).join("")}
      </div>
      <div class="sourceReportColumns">
        <section>
          <h3>Kept sources</h3>
          <div class="sourceReportGrid">${sourceReportGridHtml(report.sources, "No kept tracks")}</div>
        </section>
        <section>
          <h3>Discovery lanes</h3>
          <div class="sourceReportGrid">${sourceReportGridHtml(report.lanes, "No lanes")}</div>
        </section>
        <section>
          <h3>Rejected buckets</h3>
          <div class="sourceReportGrid">${sourceReportGridHtml(report.rejectionBuckets, "No discarded candidates")}</div>
        </section>
      </div>
      <div class="sourceReportNotes">
        <p><span>Roon</span><b>${escapeHtml(roonSummary)}</b></p>
        <p><span>Model plan</span><b>${escapeHtml(modelSummary)}</b></p>
        <p><span>Model review</span><b>${escapeHtml(reviewSummary)}</b></p>
        <p><span>Lane quotas</span><b>${escapeHtml(quotaSummary)}</b></p>
        ${quotaAdjustmentSummary ? `<p><span>Quota dampening</span><b>${escapeHtml(quotaAdjustmentSummary)}</b></p>` : ""}
        <p><span>Last.fm</span><b>${escapeHtml(lastfmSummary)}</b></p>
        <p><span>Query yield</span><b>${escapeHtml(queryYieldSummary)}</b></p>
        ${adaptivePlanSummary ? `<p><span>Adaptive retry</span><b>${escapeHtml(adaptivePlanSummary)}</b></p>` : ""}
        ${yieldRetrySummary ? `<p><span>Yield retry</span><b>${escapeHtml(yieldRetrySummary)}</b></p>` : ""}
      </div>
      ${feedbackCalibrationHtml(report.calibration)}
      ${modelReviewAuditHtml(review?.audit)}
      ${queryYieldHtml(report.queryYield)}
      ${autoLanes.length ? `
        <details>
          <summary>Auto-broaden passes</summary>
          <ol>
            ${autoLanes.map((lane) => `
              <li>
                <strong>${escapeHtml(lane.label || lane.lane || "Broadened search")}</strong>
                <span>${escapeHtml(`${lane.stage ? `${lane.stage}: ` : ""}${lane.added || 0} added from ${lane.generated || 0} generated. ${lane.reason || ""}`)}</span>
              </li>
            `).join("")}
          </ol>
        </details>
      ` : ""}
    </div>
  `;
}

function showSourceReport(result = null) {
  const panel = $("#sourceReport");
  if (!panel) return;
  if (!result) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = sourceReportHtml(result);
}

function rejectedDebugHtml(result = {}) {
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  if (!discarded.length) return "";
  const groups = discardedReasonSummary(discarded);
  return `
    <div class="rejectedDebugCard">
      <div class="intentDebugHead">
        <span>Rejected / discarded</span>
        <strong>${escapeHtml(discarded.length)} candidates</strong>
      </div>
      <div class="rejectedGroups">
        ${groups.map(([reason, count]) => `
          <p>
            <b>${escapeHtml(count)}</b>
            <span>${escapeHtml(reason)}</span>
          </p>
        `).join("")}
      </div>
      <details>
        <summary>Show examples</summary>
        <ol>
          ${discarded.slice(0, 80).map((item) => `
            <li>
              <strong>${escapeHtml([item.artist, item.title].filter(Boolean).join(" - ") || item.query || "Unknown candidate")}</strong>
              <span>${escapeHtml(item.reason || "No reason provided")}</span>
              ${discardedEvidenceSummaryHtml(item)}
            </li>
          `).join("")}
        </ol>
      </details>
    </div>
  `;
}

function updateRejectedDebug() {
  const panel = $("#rejectedDebug");
  const button = $("#toggleRejected");
  if (!panel || !button) return;
  const discarded = Array.isArray(state.lastResult?.discarded) ? state.lastResult.discarded : [];
  button.disabled = !discarded.length;
  button.textContent = discarded.length ? `Rejected (${discarded.length})` : "Rejected";
  if (!discarded.length || !state.rejectedDebugOpen) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = rejectedDebugHtml(state.lastResult);
}

function intentListValue(value, fallback = "not specified") {
  if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
  const text = String(value || "").trim();
  return text || fallback;
}

function intentDebugHtml(intent = {}) {
  const rows = [
    ["Search route", intent.searchRoute || "Open Discovery"],
    ["Prompt strictness", intent.promptStrictness || "open-discovery"],
    ["Requested genre", intent.requestedGenre || "open-ended"],
    ["Genre constraint", intent.genreConstraint || "none"],
    ["Theme", intentListValue(intent.theme, "not specified")],
    ["Theme source", intent.themeSource || "not specified"],
    ["Activity / context", intentListValue(intent.activityContext, "not specified")],
    ["Activity source", intent.activitySource || "not specified"],
    ["Requested vibe", intent.requestedVibe || "not specified"],
    ["Vibe source", intent.requestedVibeSource || "not specified"],
    ["Era / date range", intent.requestedEraDateRange || "not specified"],
    ["Requested length", intent.requestedLength || "not specified"],
    ["Characteristics", intentListValue(intent.requestedCharacteristics, "not specified")],
    ["Artist seed", intentListValue(intent.requestedArtists, "none selected")],
    ["Labels", intentListValue(intent.requestedLabels, "none selected")],
    ["Scoring mode", intent.scoringModeLabel || "Taste Guided"],
    ["Taste influence", intent.tasteInfluence || intent.learnedTaste || "lightly"],
    ["Outside taste", intent.outsideTaste || "limited"],
    ["Learned taste", intent.learnedTaste || "lightly"],
    ["Verification", intentListValue(intent.verificationMethods, "TIDAL/Roon metadata")],
    ["Progressive bias", intent.progressiveBias || "off unless explicitly requested"]
  ];
  return `
    <div class="intentDebugCard">
      <div class="intentDebugHead">
        <span>Intent Parsed</span>
        <strong>${escapeHtml(intent.scoringModeLabel || "Taste Guided")}</strong>
      </div>
      <div class="intentDebugGrid">
        ${rows.map(([label, value]) => `
          <p>
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
          </p>
        `).join("")}
      </div>
    </div>
  `;
}

function showIntentDebug(intent = null) {
  const panel = $("#intentDebug");
  if (!panel) return;
  if (!intent) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = intentDebugHtml(intent);
}

function cleanRenderedArtifacts(root) {
  root.querySelectorAll(".trackMeta").forEach((element) => {
    element.textContent = element.textContent.replace(/\s*\u00e2\u20ac\u00a2\s*/g, " - ");
  });
}

function emptyResultHtml(reason, verification = {}) {
  const modelErrorText = String(verification.modelError || "");
  const contextLimitHit = /\b(?:context|token|tokens|maximum context|too many|too large|exceed|exceeded|length)\b/i.test(modelErrorText);
  const issues = [
    verification.discoveryError ? `TIDAL discovery: ${verification.discoveryError}` : "",
    verification.roonVerificationError ? `Roon queue verification: ${verification.roonVerificationError}` : "",
    verification.roonFirstError ? `Roon search: ${verification.roonFirstError}` : "",
    verification.modelError ? `Local model: ${verification.modelError}` : "",
    verification.tidalError ? `TIDAL verification: ${verification.tidalError}` : ""
  ].filter(Boolean);
  const tips = [
    contextLimitHit ? "The local model likely hit its context/token limit. Reduce seed playlist text, lower requested tracks, or start a fresh Generate run with less reference data." : "",
    verification.yearRange ? "Strict year ranges need reliable TIDAL release-year metadata." : "",
    verification.minScore ? "Try lowering Minimum match one step if you want more output." : "",
    "Try a broader seed artist, label, or year range if the run was too narrow."
  ].filter(Boolean);

  return `
    <div class="emptyState">
      <strong>No tracks returned for this run.</strong>
      <p>${escapeHtml(reason)}</p>
      ${issues.length ? `
        <div>
          <span>What happened</span>
          <ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>
        </div>
      ` : ""}
      ${contextLimitHit ? "<p><strong>Context limit hit:</strong> The Rabbit Hole starts each Generate request fresh, so trim the prompt/reference payload and run it again.</p>" : ""}
      <div>
        <span>Try next</span>
        <ul>${tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ul>
      </div>
    </div>
  `;
}

function trackCardHtml(track, index) {
  const label = track.label || track.tidal?.label || "";
  const tidalUrl = tidalTrackUrl(track);
  const resultIndex = Number.isFinite(Number(track._resultIndex)) ? Number(track._resultIndex) : index;
  const payload = trackPayload(track);
  const payloadAttr = jsonDataAttr(payload);
  const meta = [
    track.artist,
    track.releaseDate || track.tidal?.releaseDate || track.year || "",
    track.durationMs ? formatDuration(track.durationMs) : ""
  ].filter(Boolean).join(" - ");
  return `
    <div class="track" id="track-${resultIndex}" data-track-index="${resultIndex}">
      <div class="trackMain">
        <strong class="trackTitle">${index + 1}. ${escapeHtml(track.title)}</strong>
        <span class="trackMeta">${escapeHtml(meta)}</span>
        <div class="trackBadges">
          ${artistConfirmationBadgeHtml(track)}
          ${track.roon?.queueActionPresumed ? "<span class=\"artistCreditBadge queue\">Queue presumed</span>" : ""}
        </div>
        <p class="trackLabel">${label ? escapeHtml(label) : "Label unavailable"}</p>
        ${matchSplitHtml(track)}
        ${scoreBreakdownHtml(track)}
        ${whyMatchedHtml(track)}
        ${evidenceLedgerHtml(track)}
        <p class="sourceLine">Source: <strong>${escapeHtml(track.discoverySource || "TIDAL search")}</strong></p>
        ${statusChecksHtml(track)}
        ${track.tidal ? `<p class="muted">TIDAL: ${tidalUrl ? `<a href="${escapeHtml(tidalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(track.tidal.title || track.title)}</a>` : escapeHtml(track.tidal.title || track.title)}${track.tidal.artist ? ` - ${escapeHtml(track.tidal.artist)}` : ""}</p>` : ""}
        ${track.roon?.match ? `<p class="muted">Roon: ${escapeHtml(track.roon.match.title)}${track.roon.match.subtitle ? ` - ${escapeHtml(track.roon.match.subtitle)}` : ""}</p>` : ""}
        ${resultDiagnosticsHtml(track, index)}
        <div class="feedbackButtons" aria-label="Track feedback">${feedbackButtonsHtml(track, index)}</div>
      </div>
      <div class="trackActions">
        ${tidalUrl ? `<button type="button" data-tidal-open="${payloadAttr}" data-tidal-url="${escapeHtml(tidalUrl)}">TIDAL</button>` : ""}
        <button data-queue-next="${payloadAttr}">Add Next</button>
        <button data-track="${payloadAttr}">Play Roon</button>
      </div>
    </div>
  `;
}

function renderResults(result = {}) {
  state.lastResult = {
    ...result,
    tracks: applyFeedbackToTracks(result.tracks || [])
  };
  state.lastTracks = state.lastResult.tracks || [];
  state.displayedTracks = displayedResultTracks(state.lastTracks);
  const filterToggle = $("#artistConfirmedOnly");
  const exactConfirmedCount = state.lastTracks.filter(artistCreditConfirmed).length;
  if (filterToggle) {
    filterToggle.checked = state.resultArtistConfirmedOnly;
    filterToggle.disabled = !state.lastTracks.length;
    filterToggle.title = `Audit only: ${exactConfirmedCount}/${state.lastTracks.length} exact artist-confirmed results`;
  }
  $("#queueAll").disabled = !state.displayedTracks.length;
  $("#queueAllNext").disabled = !state.displayedTracks.length;
  $("#sendTidalQueue").disabled = !state.displayedTracks.length;
  $("#copyList").disabled = !state.displayedTracks.length;
  $("#exportCsv").disabled = !state.displayedTracks.length;
  updateRejectedDebug();

  const discarded = state.lastResult.verification?.discarded || 0;
  const generated = state.lastResult.verification?.generated || state.displayedTracks.length;
  const verifierLabel = state.lastResult.verification?.tidal ? "TIDAL" : "Roon";
  const queueableLabel = state.lastResult.verification?.roonQueueable ? "Roon-queueable" : "verified";
  const strictRoon = Boolean(state.lastResult.verification?.roonQueueable || state.lastResult.verification?.roonStrict);
  const minScore = Number(state.lastResult.verification?.minScore || 0);
  const minimumLabel = state.lastResult.verification?.minScoreLabel || minimumScoreLabel(minScore);
  const filteredByScore = Number(state.lastResult.verification?.scoreFiltered || 0);
  const belowMinimumKept = Number(state.lastResult.verification?.belowMinimumKept || 0);
  const aboveMinimumKept = minScore
    ? Number(state.lastResult.verification?.aboveMinimumKept ?? Math.max(0, state.displayedTracks.length - belowMinimumKept))
    : state.displayedTracks.length;
  const emptyReason = state.lastResult.verification?.discoveryError
    ? `Generation ran, but discovery did not finish cleanly. ${state.lastResult.verification.discoveryError}`
    : state.lastResult.verification?.roonVerificationError
      ? `Generation ran, but Roon queue verification timed out. ${state.lastResult.verification.roonVerificationError}`
      : state.lastResult.verification?.modelError && !generated
        ? `The local model did not return usable candidates. ${state.lastResult.verification.modelError}`
        : state.lastResult.verification?.tidalError
    ? `TIDAL verification failed: ${state.lastResult.verification.tidalError}. Roon fallback also did not verify these tracks.`
    : strictRoon
      ? "TIDAL found candidates, but none passed strict Roon verification for the selected output zone. Broaden the prompt or try a different Roon zone."
      : minScore
        ? `No queueable tracks were close enough to the request. Lower the Minimum match picker or broaden the seed/year range.`
        : `No tracks survived ${verifierLabel} catalogue filters. Try a broader year range or seed around a known artist/label.`;

  const titleCount = state.resultArtistConfirmedOnly
    ? `${state.displayedTracks.length} exact-artist shown from ${state.lastTracks.length}`
    : `${state.displayedTracks.length}`;
  const titlePrefix = minScore && belowMinimumKept
    ? `${titleCount} ${queueableLabel} tracks`
    : (minScore ? `${titleCount} ${minimumScoreLabel(minScore)} ${queueableLabel} tracks` : `${titleCount} ${queueableLabel} tracks`);
  const filterSuffix = minScore && belowMinimumKept
    ? `, ${aboveMinimumKept} ${minimumLabel}, ${belowMinimumKept} below minimum kept`
    : (filteredByScore ? `, ${filteredByScore} below minimum considered` : "");
  $("#resultTitle").textContent = discarded
    ? `${titlePrefix} (${discarded} discarded from ${generated}${filterSuffix})`
    : titlePrefix;
  showPoolDiagnostics(state.lastResult);
  $("#tracks").innerHTML = state.displayedTracks.length
    ? state.displayedTracks.map(trackCardHtml).join("")
    : (state.lastTracks.length && state.resultArtistConfirmedOnly
      ? emptyResultHtml("No exact artist-confirmed tracks are visible with the current filter. Turn off Exact artists to inspect broader Roon matches.", state.lastResult.verification || {})
      : emptyResultHtml(emptyReason, state.lastResult.verification || {}));
  showQueueReport(null);
  showIntentDebug(state.lastResult.verification?.intent || null);
  showSourceReport(state.lastResult);
  updateRejectedDebug();
  cleanRenderedArtifacts($("#tracks"));
  updateNowDiscoveryTools(activeZone());
}

function isLegacyUnverifiedResult(result = {}) {
  if (!result) return false;
  const verification = result.verification || {};
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  if (!tracks.length) return false;
  if (verification.roonQueueable || verification.roonStrict) return false;
  if (verification.discoveryError || verification.roonVerificationError || verification.strategy) return false;
  return true;
}

function applySession(session = {}) {
  if (!session.updatedAt) return;
  state.sessionUpdatedAt = session.updatedAt;
  const options = session.options || {};
  for (const field of ["request"]) {
    const element = document.querySelector(`[name="${field}"]`) || $(`#${field}`);
    const value = options[field];
    if (element && typeof value !== "object" && value !== undefined && value !== null) {
      element.value = value;
    }
  }

  for (const field of ["reference", "genres", "years", "mood", "language", "count", "scoringMode", "minScore", "releasePreset", "releaseExactDate", "releaseStartDate", "releaseEndDate"]) {
    const element = document.querySelector(`[name="${field}"]`) || $(`#${field}`);
    if (!element) continue;
    const value = options[field];
    element.value = typeof value === "object" || value === undefined || value === null ? "" : value;
  }
  setScoringMode(options.scoringMode || "");

  if (session.result && !isLegacyUnverifiedResult(session.result)) {
    renderResults(session.result);
  } else if (session.result) {
    state.lastResult = null;
    state.lastTracks = [];
    state.displayedTracks = [];
    $("#queueAll").disabled = true;
    $("#queueAllNext").disabled = true;
    $("#sendTidalQueue").disabled = true;
    $("#copyList").disabled = true;
    $("#exportCsv").disabled = true;
    $("#resultTitle").textContent = "Previous results need Roon verification";
    showPoolDiagnostics(null);
    $("#tracks").innerHTML = "<p class=\"muted\">Generate again to rebuild this list with strict TIDAL plus Roon verification. Old TIDAL-only session results are hidden so they do not look playable.</p>";
    showQueueReport(null);
    showIntentDebug(null);
    showSourceReport(null);
  }
}

async function refreshSession() {
  const session = await getJson("/api/session");
  applySession(session);
}

async function recoverGeneratedSession(startedAt = Date.now()) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(attempt < 2 ? 1200 : 1800);
    try {
      const session = await getJson("/api/session");
      const updatedAt = Date.parse(session.updatedAt || "");
      if (session.result && Number.isFinite(updatedAt) && updatedAt >= startedAt - 2000) {
        applySession(session);
        renderResults(session.result);
        return true;
      }
    } catch {
      // Keep polling briefly; the server may be restarting or finishing the request.
    }
  }
  return false;
}

function applyAppState(app = {}) {
  if (!app) return;
  state.appStatus = app;
  state.memory = app.memory || state.memory;
  if (app.standby) renderStandbyPool(app.standby);
  renderMemoryStatus();

  const llm = app.llm || {};
  const systemTag = $("#systemTag");
  if (systemTag) {
    const provider = String(llm.label || "LOCAL MODEL").toUpperCase();
    const model = llm.model ? ` - ${String(llm.model).toUpperCase()}` : "";
    systemTag.textContent = `${provider}${model} - TIDAL - ROON MATCHING: STRICT`;
  }
  if (!state.llmStatus && llm.label) {
    renderLlmStatus({ ...llm, checking: true });
  }
  if (app.ai) {
    state.modelStatus = { ...(state.modelStatus || {}), ai: app.ai };
    renderModelStatus(state.modelStatus);
  }
  applyBridgeSyncAlert(app.bridgeSyncAlert);

  applyCalibration(app.taste?.calibration || null);

  const feedbackMap = feedbackMapFromServer(app.feedback || {});
  const feedbackVersion = Object.entries(feedbackMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rating]) => `${key}:${rating}`)
    .join("|");
  if (feedbackVersion !== state.feedbackVersion) {
    state.feedbackByKey = feedbackMap;
    state.feedbackVersion = feedbackVersion;
    state.tasteUpdatedAt = app.taste?.updatedAt || "";
    if (state.lastResult) renderResults(state.lastResult);
    updateNowDiscoveryTools(activeZone());
    state.historyNeedsRefresh = true;
  }

  const session = app.session || {};
  if (session.updatedAt && session.updatedAt !== state.sessionUpdatedAt) {
    applySession(session);
  }
  renderSystemHealth();
}

function renderLlmStatus(status = {}) {
  const pill = $("#llmStatus");
  if (!pill) return;
  state.llmStatus = status;
  const label = String(status.label || "Local model");
  const model = status.model ? ` ${String(status.model).replace(/^qwen\//i, "")}` : "";
  const online = Boolean(status.online && status.loaded !== false);
  const checking = Boolean(status.checking && !status.reachable && status.loaded !== false);
  pill.classList.toggle("statusOffline", !online && !checking);
  pill.classList.toggle("statusUnknown", checking);
  pill.title = status.message || "";
  const unavailableText = status.message || `${label}: model not loaded`;
  pill.textContent = online
    ? `${label}${model}`
    : (status.reachable && status.loaded === false ? unavailableText : `${label}: offline`);
  renderSystemHealth();
}

function setStatusPill(pill, summary = {}, prefix = "") {
  if (!pill) return;
  const level = summary.level || "unknown";
  pill.classList.toggle("statusOffline", level === "bad");
  pill.classList.toggle("statusUnknown", level === "unknown" || level === "warn");
  pill.title = summary.detail || "";
  pill.textContent = `${prefix}${summary.status || "unknown"}`;
}

function renderModelStatus(status = {}) {
  state.modelStatus = status;
  const ai = status.ai || {};
  const mode = String(ai.mode || "auto").toLowerCase();
  const synapse = synapseHealthSummary({ ai });
  const mcp = mcpHealthSummary({ mcp: state.appStatus?.mcp || {} });
  const active = ai.lastDecision || {};
  const provider = String(active.provider || ai.activeProvider || "local").toUpperCase();
  const selectedTier = active.tier || ai.selectedTier || ai.synapse?.selectedTier || "";
  const selectedTierKey = synapseTierOption(selectedTier);
  const selectedTierStatus = ai.synapse?.tiers?.[selectedTierKey] || null;
  const escalationPath = Array.isArray(active.escalationPath) ? active.escalationPath.filter(Boolean) : [];
  const escalationLabel = escalationPath.length > 1
    ? escalationPath.map(synapseTierLabel).join(" -> ")
    : "";
  const synapseBrain = escalationLabel || synapseTierLabel(selectedTierKey);
  const providerLabel = provider === "SYNAPSE"
    ? `SYNAPSE${synapseBrain ? ` ${synapseBrain}` : ""}`
    : provider;
  const fallback = active.fallback ? " - fallback" : "";
  const model = active.model ? ` - ${String(active.model).replace(/^qwen\//i, "")}` : "";
  const cost = active.costUsd ? ` - $${Number(active.costUsd).toFixed(4)}` : "";
  const latency = active.latencyMs ? ` - ${Math.round(active.latencyMs)}ms` : "";

  const modeSelect = $("#aiModeSelect");
  const modeValue = mode === "synapse" && selectedTierKey ? selectedTierKey : mode;
  if (modeSelect && modeSelect.value !== modeValue) modeSelect.value = modeValue;
  const modelInput = $("#synapseModelInput");
  if (modelInput && document.activeElement !== modelInput) {
    modelInput.value = selectedTierStatus?.model || ai.synapse?.model || "";
  }

  setStatusPill($("#mcpStatus"), mcp, "MCP: ");
  setStatusPill($("#synapseStatus"), synapse, "Synapse: ");
  renderSynapseUsageStatus(ai);
  const activePill = $("#activeProviderStatus");
  if (activePill) {
    activePill.classList.toggle("statusOffline", Boolean(active.fallback && provider === "LOCAL"));
    activePill.classList.toggle("statusUnknown", mode === "auto" && provider === "LOCAL" && !active.fallback);
    activePill.textContent = `AI: ${mode.toUpperCase()} -> ${providerLabel}${fallback}${model}${cost}${latency}`;
    activePill.title = [active.reason || "", escalationLabel ? `Escalation: ${escalationLabel}` : ""].filter(Boolean).join("\n");
  }
  renderSystemHealth();
}

async function refreshModelStatus(options = {}) {
  const checking = {
    ...(state.modelStatus || {}),
    ai: {
      ...((state.modelStatus || {}).ai || {}),
      synapse: {
        ...(((state.modelStatus || {}).ai || {}).synapse || {}),
        state: "checking"
      }
    }
  };
  if (options.refresh) renderModelStatus(checking);
  try {
    const query = options.refresh ? "?refresh=1" : "";
    renderModelStatus(await getJson(`/api/model/status${query}`));
  } catch (error) {
    renderModelStatus({
      ...(state.modelStatus || {}),
      ai: {
        ...((state.modelStatus || {}).ai || {}),
        synapse: {
          ...(((state.modelStatus || {}).ai || {}).synapse || {}),
          connected: false,
          state: "disconnected",
          lastError: error.message
        }
      }
    });
  }
}

async function updateModelMode(options = {}) {
  const modeSelect = $("#aiModeSelect");
  const modelInput = $("#synapseModelInput");
  const selected = modeSelect?.value || "auto";
  const tier = synapseTierOption(selected);
  const mode = tier ? "synapse" : selected;
  const model = modelInput?.value || "";
  localStorage.setItem("rabbitHole.aiMode", selected);
  localStorage.setItem("rabbitHole.synapseModel", model);
  const status = await api("/api/model/mode", {
    mode,
    tier,
    model,
    refreshSynapse: Boolean(options.refreshSynapse)
  });
  renderModelStatus(status);
}

const BRIDGE_ARTWORK_RETRY_MS = 30 * 1000;

function isBridgeArtworkUrl(value = "") {
  const url = String(value || "").trim();
  return /^https?:\/\/art\.darthspader\.com\/art\/[a-f0-9]{40}\.jpg(?:$|[?#])/i.test(url) ||
    /^\/art\/[a-f0-9]{40}\.jpg(?:$|[?#])/i.test(url);
}

function artworkUrlForLoad(value = "", retryBucket = 0) {
  const url = String(value || "").trim();
  if (!url || !retryBucket || !isBridgeArtworkUrl(url)) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}rh_retry=${retryBucket}`;
}

function setCoverImage(cover, urls = []) {
  const candidates = urls.map((url) => String(url || "").trim()).filter(Boolean);
  const bridgeRetryBucket = candidates.some(isBridgeArtworkUrl)
    ? Math.floor(Date.now() / BRIDGE_ARTWORK_RETRY_MS)
    : 0;
  const signature = candidates.join("\n") + (bridgeRetryBucket ? `\nbridge-retry:${bridgeRetryBucket}` : "");

  if (!candidates.length) {
    cover.dataset.coverSignature = "";
    cover.dataset.coverLoaded = "0";
    cover.style.backgroundImage = "";
    cover.classList.remove("hasArt");
    return;
  }

  if (cover.dataset.coverSignature === signature && cover.dataset.coverLoaded === "1") return;
  cover.dataset.coverSignature = signature;
  cover.dataset.coverLoaded = "0";

  const tryCandidate = (index) => {
    if (cover.dataset.coverSignature !== signature) return;
    const url = candidates[index];
    if (!url) {
      cover.dataset.coverLoaded = "0";
      cover.style.backgroundImage = "";
      cover.classList.remove("hasArt");
      return;
    }
    const loadUrl = artworkUrlForLoad(url, bridgeRetryBucket);

    const image = new Image();
    image.onload = () => {
      if (cover.dataset.coverSignature !== signature) return;
      cover.dataset.coverLoaded = "1";
      cover.style.backgroundImage = `url("${loadUrl.replace(/"/g, "%22")}")`;
      cover.classList.add("hasArt");
    };
    image.onerror = () => tryCandidate(index + 1);
    image.src = loadUrl;
  };

  tryCandidate(0);
}

async function refreshLlmStatus() {
  const current = state.llmStatus || {};
  if (!current.online && !current.reachable) renderLlmStatus({ ...current, checking: true, label: current.label || "Local model" });
  try {
    renderLlmStatus(await getJson("/api/llm-status"));
  } catch (error) {
    renderLlmStatus({
      ...(state.llmStatus || {}),
      online: false,
      reachable: false,
      loaded: false,
      message: error.message,
      label: state.llmStatus?.label || "Local model"
    });
  }
}

function scheduleRabbitRecoveryRefresh(delayMs = RABBIT_RECOVERY_REFRESH_MS) {
  if (rabbitRecoveryTimer) clearTimeout(rabbitRecoveryTimer);
  rabbitRecoveryTimer = setTimeout(() => {
    rabbitRecoveryTimer = null;
    refresh().catch(() => {});
  }, Math.max(250, Number(delayMs || RABBIT_RECOVERY_REFRESH_MS)));
}

function markRabbitConnectionLost(error = {}) {
  state.connectionStatus = { connected: false, coreName: state.connectionStatus.coreName || "" };
  state.zones = state.zones.map((zone) => ({
    ...zone,
    state: "disconnected",
    now_playing: null
  }));
  state.nowTrack = null;
  state.nowTrackSource = "";
  state.nowMatchIndex = -1;
  const pill = $("#connection");
  if (pill) {
    pill.classList.add("statusOffline");
    pill.classList.remove("statusUnknown");
    pill.textContent = "Rabbit Hole offline - reconnecting";
    pill.title = error.message || "The browser cannot reach the Rabbit Hole server right now.";
  }
  const playState = $("#playState");
  if (playState) playState.textContent = "Connection lost";
  const title = $("#nowTitle");
  if (title) title.textContent = "Connection lost";
  const subtitle = $("#nowSubtitle");
  if (subtitle) subtitle.textContent = "Rabbit Hole offline";
  const cover = $("#cover");
  if (cover) setCoverImage(cover, []);
  const tools = $("#nowDiscoveryTools");
  if (tools) tools.hidden = true;
  renderNowSourceQuality(null, null);
  renderNowTidalPlaylistControl(null);
}

function renderState(payload) {
  lastRabbitStatusAt = Date.now();
  if (rabbitRecoveryTimer) {
    clearTimeout(rabbitRecoveryTimer);
    rabbitRecoveryTimer = null;
  }
  const connectionPill = $("#connection");
  if (connectionPill) {
    connectionPill.classList.toggle("statusOffline", !payload.connected);
    connectionPill.classList.remove("statusUnknown");
    connectionPill.title = "";
  }
  state.zones = payload.zones || [];
  if (!payload.connected || !state.zones.length) {
    scheduleRabbitRecoveryRefresh(payload.connected ? 1000 : 2500);
  }
  state.connectionStatus = {
    connected: Boolean(payload.connected),
    coreName: payload.core?.name || ""
  };
  if (!state.zones.some((zone) => zone.zone_id === state.selectedZoneId)) {
    const playingZone = state.zones.find((zone) => zonePlaybackPlaying(zone) && currentZoneNowPlaying(zone));
    state.selectedZoneId = playingZone?.zone_id || state.zones[0]?.zone_id || "";
  }
  const resolvedZoneId = activeZone()?.zone_id || "";
  if (resolvedZoneId && resolvedZoneId !== state.selectedZoneId) {
    state.selectedZoneId = resolvedZoneId;
  }

  connectionPill.textContent = payload.connected
    ? `Connected to ${payload.core.name}`
    : "Enable this extension in Roon Settings > Extensions";

  const phoneUrl = safeHttpUrl((payload.urls || []).find((url) => !url.includes("localhost")));
  $("#phoneAccess").innerHTML = phoneUrl
    ? `<span class="phoneLabel">Phone</span><a href="${escapeHtml(phoneUrl)}">${escapeHtml(phoneUrl)}</a>`
    : "";

  const select = $("#zoneSelect");
  select.innerHTML = state.zones.map((zone) => (
    `<option value="${escapeHtml(zone.zone_id)}">${escapeHtml(zoneDisplayLabel(zone))}</option>`
  )).join("");
  select.value = state.selectedZoneId;

  const zone = activeZone();
  const now = currentZoneNowPlaying(zone);
  const displayNow = summarizeNowPlaying(zone);
  $("#nowTitle").textContent = displayNow?.title || (zone ? "Nothing Playing" : "No active zone");
  $("#nowSubtitle").textContent = [displayNow?.artist, displayNow?.album].filter(Boolean).join(" - ") || zone?.state || "";

  const length = Math.max(0, Number(now?.length || 0));
  const position = Math.max(0, Math.min(length || Infinity, Number(now?.seek_position || 0)));
  const liveRadio = isLiveRadioZone(zone);
  const slider = $("#seekSlider");
  $("#playState").textContent = zone?.state || "stopped";
  $("#queueInfo").textContent = formatQueueInfo(zone);
  $("#seekPosition").textContent = formatSeconds(position) || "0:00";
  $("#seekLength").textContent = liveRadio ? "Live radio" : (formatSeconds(length) || "0:00");
  slider.max = String(liveRadio ? 1 : (length || 0));
  slider.disabled = liveRadio || !zone?.is_seek_allowed || !length;
  if (!state.isSeeking) slider.value = String(liveRadio ? 0 : (position || 0));

  const liveQueue = $("#liveQueue");
  const queueHtml = zone ? liveQueueHtml(zone) : "";
  if (queueHtml) {
    liveQueue.hidden = false;
    liveQueue.innerHTML = queueHtml;
  } else {
    liveQueue.hidden = true;
    liveQueue.innerHTML = "";
  }

  const cover = $("#cover");
  const metadataSourceCoverUrl = now?.metadata_enrichment?.sourceImageUrl || "";
  const metadataCoverUrl = now?.metadata_enrichment?.imageUrl || "";
  const radioSourceCoverUrl = now?.radio_enrichment?.sourceImageUrl || "";
  const roonCoverUrl = now?.image_key
    ? `/api/roon/image/${encodeURIComponent(now.image_key)}?width=360&height=360`
    : "";
  setCoverImage(cover, [
    metadataSourceCoverUrl,
    radioSourceCoverUrl,
    metadataCoverUrl,
    trustedRadioArtworkUrl(now),
    roonCoverUrl
  ]);

  const outputs = $("#outputs");
  if (outputs) {
    outputs.hidden = true;
    outputs.innerHTML = "";
  }
  updateNowDiscoveryTools(zone);
  updateNowSourceQuality(nowPlayingTrack(zone));
  updateJumpTopVisibility();
  renderSystemHealth();
}

async function refresh() {
  try {
    const payload = await getJson("/api/status");
    renderState(payload);
    applyAppState(payload.app);
  } catch (error) {
    markRabbitConnectionLost(error);
    throw error;
  }
}

function currentRequestPrefersExtendedMixes() {
  const text = [
    $("#request")?.value || "",
    document.querySelector("[name='genres']")?.value || "",
    document.querySelector("[name='mood']")?.value || "",
    state.lastResult?.options?.request || "",
    state.lastResult?.options?.genres || "",
    state.lastResult?.options?.mood || ""
  ].join(" ").toLowerCase();
  return /\b(?:prefer|prioritize|prioritise|favor|favour|find|give|use)\b.{0,80}\b(?:extended|club|long)\s+(?:mixes?|versions?|cuts?)\b/.test(text) ||
    /\b(?:extended|club|long)\s+(?:mixes?|versions?|cuts?)\b.{0,50}\b(?:available|preferred|prefer|priority)\b/.test(text) ||
    /\b(?:extended mixes?|extended versions?|club mixes?|long mixes?|full length mixes?)\b/.test(text);
}

async function queueTrackList(tracks, button, options = {}) {
  const zone = activeZone();
  if (!zone) return alert("Select a Roon zone first.");
  if (!tracks.length) return alert("There are no tracks to queue.");

  const originalText = options.buttonText || button.textContent;
  const mode = options.mode || "append";
  const nextMode = mode === "next";
  button.disabled = true;
  button.textContent = "Adding...";
  $("#busy").textContent = nextMode
    ? `Adding ${tracks.length} track${tracks.length === 1 ? "" : "s"} next in the Roon queue...`
    : `Adding ${tracks.length} tracks to the existing Roon queue...`;

  try {
    const result = await api("/api/roon/queue-tracks", {
      zoneId: zone.zone_id,
      tracks,
      alternates: options.alternates || [],
      targetCount: options.targetCount || tracks.length,
      mode,
      source: options.source || "",
      preferExtendedMixes: options.preferExtendedMixes ?? currentRequestPrefersExtendedMixes(),
      matchPolicy: options.matchPolicy || "strict",
      allowBridge: options.allowBridge !== false,
      bridgeSyncDelaysMs: options.bridgeSyncDelaysMs || [0, 3000, 7000]
    });
    console.info("Roon queue result", result);
    button.textContent = result.failedCount
      ? `Added ${result.queuedCount}/${result.requested}`
      : (nextMode ? "Added next" : "Added");
    const notes = [];
    if (result.shuffleDisabled) notes.push("Shuffle turned off");
    if (result.topOfQueue) notes.push("Added next after the current track");
    else if (result.appendOnly) notes.push("Added to existing queue");
    if (result.startReset?.reset) notes.push("Started at 0:00");
    if (result.startReset && !result.startReset.reset) notes.push(result.startReset.error || "Could not reset start position");
    if (result.warning) notes.push(result.warning);
    if (result.playbackStartRequested) notes.push("Playback started");
    if (result.playbackStartError) notes.push(`Queued, but playback did not start: ${result.playbackStartError}`);
    if (result.alternateCount) notes.push(`${result.alternateCount} backup track${result.alternateCount === 1 ? "" : "s"} available`);
    if (result.failedCount) notes.push(`${result.failedCount} queue attempt${result.failedCount === 1 ? "" : "s"} failed`);
    $("#busy").textContent = notes.join(" - ") || "Roon queue updated";
    showQueueReport(result);
    showBridgeSyncPopup(result);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
      $("#busy").textContent = "";
    }, 2200);
    return result;
  } catch (error) {
    button.textContent = "Failed";
    $("#busy").textContent = "";
    alert(error.message);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
    }, 1600);
    return null;
  }
}

async function sendTracksToTidalPlaylist(tracks, button, options = {}) {
  if (!tracks.length) return alert("There are no tracks to send to TIDAL.");
  const originalText = button.textContent;
  const title = options.title || "";
  button.disabled = true;
  button.textContent = "Sending...";
  $("#busy").textContent = `Creating TIDAL playlist from ${tracks.length} track${tracks.length === 1 ? "" : "s"}...`;

  try {
    const result = await api("/api/tidal/queue-playlist", {
      tracks,
      title,
      description: options.description || "Temporary Rabbit Hole queue. Created by Rabbit Hole so TIDAL/Roon can sync the exact TIDAL tracks."
    });
    button.textContent = "Sent to TIDAL";
    $("#busy").textContent = `TIDAL playlist ready: ${result.addedCount || 0} track${Number(result.addedCount || 0) === 1 ? "" : "s"}`;
    showTidalPlaylistReport(result);
    if (state.tidalMixes) state.tidalMixesNeedsRefresh = true;
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
      $("#busy").textContent = "";
    }, 2600);
  } catch (error) {
    button.textContent = "Failed";
    $("#busy").textContent = "";
    alert(error.message);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
    }, 1600);
  }
}

function tidalMixTrackLimit(mix = {}) {
  const itemCount = Number(mix.itemCount || 0);
  if (Number.isFinite(itemCount) && itemCount > 0) {
    return Math.max(1, Math.min(50, Math.floor(itemCount)));
  }
  return 20;
}

function queuedTrackFromItem(item = {}) {
  const subtitleParts = String(item.subtitle || "").split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  return {
    title: item.title || "",
    artist: subtitleParts[0] || item.subtitle || "",
    album: item.album || subtitleParts.slice(1).join(" - ") || "",
    durationMs: item.length ? Number(item.length) * 1000 : null
  };
}

function tidalRadioTrackKey(track = {}) {
  const tidalId = String(track.tidal?.id || track.tidalId || track.id || "").trim();
  if (tidalId) return `tidal:${tidalId.toLowerCase()}`;
  const title = normalizeMatchText(track.title || track.tidal?.title || "");
  const artist = normalizeMatchText(track.artist || track.tidal?.artist || "");
  return title && artist ? `${artist}::${title}` : "";
}

function tidalRadioMemoryKey(mix = {}) {
  return String(mix.pinnedKey || mix.id || mix.title || "artist-radio").trim();
}

function readTidalRadioRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TIDAL_RADIO_RECENT_KEY) || "{}");
    const now = Date.now();
    const next = {};
    for (const [key, tracks] of Object.entries(parsed || {})) {
      const fresh = Array.isArray(tracks)
        ? tracks.filter((track) => now - Number(track.addedAt || 0) < TIDAL_RADIO_RECENT_TTL_MS)
        : [];
      if (fresh.length) next[key] = fresh.slice(0, TIDAL_RADIO_RECENT_MAX);
    }
    if (JSON.stringify(parsed) !== JSON.stringify(next)) {
      localStorage.setItem(TIDAL_RADIO_RECENT_KEY, JSON.stringify(next));
    }
    return next;
  } catch {
    return {};
  }
}

function writeTidalRadioRecent(data = {}) {
  try {
    localStorage.setItem(TIDAL_RADIO_RECENT_KEY, JSON.stringify(data));
  } catch {
    // Browser storage can be unavailable in private modes; queueing should still work.
  }
}

function tidalRadioRecentTracksForMix(mix = {}) {
  const key = tidalRadioMemoryKey(mix);
  if (!key) return [];
  return readTidalRadioRecent()[key] || [];
}

function rememberTidalRadioTracks(mix = {}, tracks = []) {
  const key = tidalRadioMemoryKey(mix);
  if (!key || !Array.isArray(tracks) || !tracks.length) return;
  const now = Date.now();
  const recent = readTidalRadioRecent();
  const existing = recent[key] || [];
  const byKey = new Map(existing.map((track) => [tidalRadioTrackKey(track), track]).filter(([trackKey]) => trackKey));
  for (const track of tracks) {
    const memoryKey = tidalRadioTrackKey(track);
    if (!memoryKey) continue;
    byKey.set(memoryKey, {
      title: track.title || track.tidal?.title || "",
      artist: track.artist || track.tidal?.artist || "",
      album: track.album || track.tidal?.album || "",
      tidalId: track.tidal?.id || track.tidalId || track.id || "",
      tidalUrl: track.tidalUrl || track.tidal?.tidalUrl || "",
      addedAt: now
    });
  }
  recent[key] = Array.from(byKey.values())
    .sort((left, right) => Number(right.addedAt || 0) - Number(left.addedAt || 0))
    .slice(0, TIDAL_RADIO_RECENT_MAX);
  writeTidalRadioRecent(recent);
}

function freshArtistRadioArtistId(mix = {}) {
  if (!mix?.pinned) return "";
  if (mix.pinnedKind === "artist-radio" && mix.artistRadio?.artistId) return String(mix.artistRadio.artistId);
  const match = String(mix.pinnedKey || "").match(/^artist-radio:(.+)$/i);
  return match?.[1] || "";
}

function isPinnedArtistRadioMix(mix = {}) {
  if (!mix?.pinned) return false;
  const text = `${mix.category || ""} ${mix.subtitle || ""} ${mix.pinnedKind || ""}`;
  return /artist\s+radio/i.test(text);
}

function tidalArtistRadioExcludeTracks(zone = activeZone(), mix = {}) {
  return [
    nowPlayingTrack(zone),
    ...displayQueueItems(zone).map(queuedTrackFromItem),
    ...tidalRadioRecentTracksForMix(mix)
  ].filter((track) => track?.title && track?.artist);
}

async function queueTidalMix(mix, button, options = {}) {
  const zone = activeZone();
  if (!zone) return alert("Select a Roon zone first.");
  if (!mix?.id) return alert("This TIDAL mix is missing an id.");

  const limit = tidalMixTrackLimit(mix);
  const artistRadioId = freshArtistRadioArtistId(mix);
  const freshArtistRadio = Boolean(artistRadioId);
  const artistRadioLike = freshArtistRadio || isPinnedArtistRadioMix(mix);
  const excludeTracks = artistRadioLike ? tidalArtistRadioExcludeTracks(zone, mix) : [];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Loading...";
  $("#busy").textContent = artistRadioLike
    ? `Loading ${mix.title || "Artist Radio"} and skipping current queue repeats...`
    : `Loading ${limit} track${limit === 1 ? "" : "s"} from ${mix.title || "TIDAL mix"}...`;

  try {
    const result = await api("/api/tidal/mix-tracks", {
      mixId: mix.id,
      limit,
      freshArtistRadio,
      artistRadioArtistId: artistRadioId,
      excludeTracks
    });
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    if (!tracks.length) {
      const excluded = Number(result.excludedCount || 0);
      throw new Error(excluded
        ? `TIDAL returned ${excluded} Artist Radio track${excluded === 1 ? "" : "s"}, but they are already in the current queue. Try this radio again later.`
        : "TIDAL returned this mix, but no playable tracks were found.");
    }
    button.textContent = originalText;
    button.disabled = false;
    const skipped = Number(result.excludedCount || 0);
    $("#busy").textContent = `${options.mode === "replace" ? "Playing" : "Queueing"} ${tracks.length} track${tracks.length === 1 ? "" : "s"} from ${result.mix?.title || mix.title || "TIDAL mix"}${skipped ? `, skipped ${skipped} already in queue` : ""}...`;
    await queueTrackList(tracks, button, {
      targetCount: tracks.length,
      mode: options.mode || "append"
    });
    if (artistRadioLike) rememberTidalRadioTracks(mix, tracks);
  } catch (error) {
    button.textContent = "Failed";
    $("#busy").textContent = "";
    alert(error.message);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1800);
  }
}

async function playTrackInRoon(track, button) {
  const zone = activeZone();
  if (!zone) return alert("Select a Roon zone first.");

  button.disabled = true;
  button.textContent = "Searching...";
  try {
    const result = await api("/api/roon/play-search-match", {
      zoneId: zone.zone_id,
      track
    });
    button.textContent = result.played ? "Playing" : "No Exact Match";
    if (!result.played) {
      console.warn("Roon did not expose a safe play action for this match.", result);
      button.title = result.reason || "Roon did not find an exact artist/title match.";
    }
  } catch (error) {
    button.textContent = "Failed";
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

function playlistBrowserStatusText() {
  if (state.playlistBrowserStatus) return state.playlistBrowserStatus;
  const parts = [];

  if (state.roonPlaylistsLoading) {
    parts.push("Loading Roon local playlists");
  } else if (state.roonPlaylistsError) {
    parts.push(`Roon local unavailable: ${state.roonPlaylistsError}`);
  } else if (state.roonPlaylistsLoaded) {
    parts.push(`${state.playlists.length} Roon local playlist${state.playlists.length === 1 ? "" : "s"}`);
  } else {
    parts.push("Roon local playlists not loaded");
  }

  if (state.tidalPlaylistsLoading) {
    parts.push("loading TIDAL playlists");
  } else if (state.tidalPlaylistsError) {
    parts.push(`TIDAL unavailable: ${state.tidalPlaylistsError}`);
  } else if (state.tidalPlaylistsLoaded) {
    parts.push(`${state.tidalPlaylists.length} TIDAL playlist${state.tidalPlaylists.length === 1 ? "" : "s"}`);
  } else {
    parts.push("TIDAL playlists not loaded");
  }

  return parts.join(" - ");
}

function playlistBrowserCardHtml(playlist = {}, source = "roon", index = 0) {
  const isTidal = source === "tidal";
  const title = playlist.title || "Untitled playlist";
  const count = Number(playlist.itemCount || playlist.count || 0);
  const meta = [
    isTidal ? "TIDAL" : "Roon local",
    count ? `${count} track${count === 1 ? "" : "s"}` : "",
    playlist.subtitle || "",
    playlist.rawType && isTidal ? playlist.rawType : ""
  ].filter(Boolean).join(" - ");
  const imageUrl = !isTidal && playlist.imageKey
    ? `/api/roon/image/${encodeURIComponent(playlist.imageKey)}?width=160&height=160`
    : "";
  const externalUrl = isTidal ? safeHttpUrl(playlist.url) : "";
  const data = `data-playlist-source="${escapeHtml(source)}" data-playlist-index="${escapeHtml(index)}"`;
  return `
    <article class="playlistBrowserCard">
      <div class="playlistBrowserArt">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : `<span>${escapeHtml(String(index + 1).padStart(2, "0"))}</span>`}
      </div>
      <div class="playlistBrowserBody">
        <span class="playlistBrowserType">${escapeHtml(isTidal ? "TIDAL playlist" : "Roon local playlist")}</span>
        <h3>${escapeHtml(title)}</h3>
        ${meta ? `<p>${escapeHtml(meta)}</p>` : ""}
        ${playlist.description ? `<small>${escapeHtml(playlist.description)}</small>` : ""}
      </div>
      <div class="playlistBrowserActions">
        <button type="button" ${data} data-playlist-mode="replace">Play</button>
        <button type="button" ${data} data-playlist-mode="shuffle">Shuffle</button>
        <button type="button" ${data} data-playlist-mode="next">Add Next</button>
        <button type="button" ${data} data-playlist-mode="append">Queue</button>
        ${externalUrl ? `<a class="buttonLink" href="${escapeHtml(externalUrl)}" target="_blank" rel="noreferrer">Open TIDAL</a>` : ""}
        <button class="playlistBrowserDelete" type="button" ${data} data-playlist-delete="1">Delete</button>
      </div>
    </article>
  `;
}

function playlistBrowserEmptyHtml(message = "") {
  return `<div class="playlistBrowserEmpty">${escapeHtml(message || "No playlists loaded")}</div>`;
}

function playlistBrowserSectionHtml({ title = "", subtitle = "", source = "roon", playlists = [], loading = false, error = "", loaded = false } = {}) {
  let body = "";
  if (loading) body = playlistBrowserEmptyHtml(`Loading ${title}...`);
  else if (error) body = playlistBrowserEmptyHtml(error);
  else if (!loaded) body = playlistBrowserEmptyHtml(`Open this tab or refresh to load ${title}.`);
  else if (!playlists.length) body = playlistBrowserEmptyHtml(`No ${title} found.`);
  else body = `<div class="playlistBrowserCards">${playlists.map((playlist, index) => playlistBrowserCardHtml(playlist, source, index)).join("")}</div>`;

  return `
    <section class="playlistBrowserSection">
      <div class="playlistBrowserHeader">
        <h3>${escapeHtml(title)}</h3>
        ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ""}
      </div>
      ${body}
    </section>
  `;
}

function renderPlaylistBrowser() {
  const status = $("#playlistBrowserStatus");
  const grid = $("#playlistBrowserGrid");
  if (!status || !grid) return;
  status.textContent = playlistBrowserStatusText();
  grid.innerHTML = [
    playlistBrowserSectionHtml({
      title: "TIDAL playlists",
      subtitle: state.tidalPlaylistsWarning || (state.tidalPlaylistsLoaded ? `${state.tidalPlaylists.length} available` : ""),
      source: "tidal",
      playlists: state.tidalPlaylists,
      loading: state.tidalPlaylistsLoading,
      error: state.tidalPlaylistsError,
      loaded: state.tidalPlaylistsLoaded
    }),
    playlistBrowserSectionHtml({
      title: "Roon local playlists",
      subtitle: state.roonPlaylistsWarning || (state.roonPlaylistsLoaded ? `${state.playlists.length} available` : ""),
      source: "roon",
      playlists: state.playlists,
      loading: state.roonPlaylistsLoading,
      error: state.roonPlaylistsError,
      loaded: state.roonPlaylistsLoaded
    })
  ].join("");
}

function memoryMetadataParts(track = {}) {
  const beatport = track.beatport || {};
  const provider = track.provider || {};
  return [
    beatport.genre || provider.genre || "",
    beatport.subGenre || provider.subGenre || "",
    beatport.bpm ? `${Math.round(Number(beatport.bpm))} BPM` : "",
    beatport.keyName || provider.keyName || "",
    beatport.camelot || provider.camelot || "",
    beatport.label || provider.label || "",
    beatport.releaseDate || provider.releaseDate || "",
    track.durationMs ? formatDuration(track.durationMs) : ""
  ].filter(Boolean);
}

function musicMemoryBadgeHtml(label = "", className = "") {
  if (!label) return "";
  return `<span class="musicMemoryBadge ${escapeHtml(className)}">${escapeHtml(label)}</span>`;
}

function musicMemoryTrackHtml(track = {}) {
  const imageUrl = safeHttpUrl(track.imageUrl);
  const title = track.title || "Untitled";
  const artist = track.artist || "Unknown artist";
  const beatport = track.beatport || null;
  const provider = track.provider || null;
  const feedbackRatings = Array.isArray(track.feedbackRatings) ? track.feedbackRatings : [];
  const badges = [
    beatport ? musicMemoryBadgeHtml("Beatport", "isBeatport") : "",
    track.beatportMissing ? musicMemoryBadgeHtml(`Beatport ${track.latestBeatportStatus}`, "isMissing") : "",
    track.tidalId ? musicMemoryBadgeHtml("TIDAL", "isTidal") : "",
    track.feedbackCount ? musicMemoryBadgeHtml(`${track.feedbackCount} feedback`, "isFeedback") : "",
    track.playCount ? musicMemoryBadgeHtml(`${track.playCount} play${track.playCount === 1 ? "" : "s"}`, "isSeen") : "",
    track.observationCount ? musicMemoryBadgeHtml(`${track.observationCount} seen`, "isSeen") : ""
  ].filter(Boolean).join("");
  const meta = memoryMetadataParts(track);
  const identities = [
    track.tidalId ? `TIDAL ${track.tidalId}` : "",
    beatport?.id ? `Beatport ${beatport.id}` : "",
    beatport?.releaseId ? `Release ${beatport.releaseId}` : "",
    track.isrc ? `ISRC ${track.isrc}` : ""
  ].filter(Boolean);
  const updated = track.lastSeenAt ? `Last seen ${formatDateTime(Date.parse(track.lastSeenAt))}` : "";
  const providerLine = provider?.name && provider.name !== "beatport"
    ? `${provider.name}${provider.genre ? `: ${provider.genre}` : ""}${provider.subGenre ? ` / ${provider.subGenre}` : ""}`
    : "";
  return `
    <article class="musicMemoryCard">
      <div class="musicMemoryArt">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : ""}
      </div>
      <div class="musicMemoryBody">
        <div class="musicMemoryTitleRow">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(artist)}${track.album ? ` - ${escapeHtml(track.album)}` : ""}</p>
          </div>
          ${track.tidalUrl ? `<a class="buttonLink" href="${escapeHtml(track.tidalUrl)}" target="_blank" rel="noreferrer">TIDAL</a>` : ""}
        </div>
        ${badges ? `<div class="musicMemoryBadges">${badges}</div>` : ""}
        ${meta.length ? `<p class="musicMemoryMeta">${escapeHtml(meta.join(" - "))}</p>` : ""}
        ${identities.length ? `<p class="musicMemoryIds">${escapeHtml(identities.join(" - "))}</p>` : ""}
        ${feedbackRatings.length ? `<p class="musicMemoryFeedback">${escapeHtml(feedbackRatings.join(", "))}</p>` : ""}
        ${providerLine ? `<p class="musicMemoryProvider">${escapeHtml(providerLine)}</p>` : ""}
        ${updated ? `<small>${escapeHtml(updated)}${track.latestObservationSource ? ` - ${escapeHtml(track.latestObservationSource)}` : ""}</small>` : ""}
      </div>
    </article>
  `;
}

function renderMusicMemory() {
  const status = $("#musicMemoryStatus");
  const results = $("#musicMemoryResults");
  if (!status || !results) return;
  if (state.musicMemoryLoading && !state.musicMemoryTracks.length) {
    status.textContent = "Searching music memory...";
    results.innerHTML = "<div class=\"playlistBrowserEmpty\">Searching music memory...</div>";
    return;
  }
  const payload = state.musicMemory || {};
  if (payload.enabled === false) {
    status.textContent = "Rabbit Hole music memory is disabled.";
    results.innerHTML = "<div class=\"playlistBrowserEmpty\">Music memory is not available in this runtime.</div>";
    return;
  }
  const total = Number(payload.total || 0);
  const shown = state.musicMemoryTracks.length;
  const query = state.musicMemoryQuery ? ` for "${state.musicMemoryQuery}"` : "";
  status.textContent = total
    ? `${shown}/${total} tracks${query}`
    : `No tracks found${query}.`;
  const cards = state.musicMemoryTracks.map(musicMemoryTrackHtml).join("");
  const hasMore = shown < total;
  results.innerHTML = `
    ${cards || "<div class=\"playlistBrowserEmpty\">No matching tracks found.</div>"}
    ${hasMore ? `<button type="button" id="musicMemoryLoadMore" class="musicMemoryLoadMore"${state.musicMemoryLoading ? " disabled" : ""}>${state.musicMemoryLoading ? "Loading..." : "Load more"}</button>` : ""}
  `;
}

async function refreshMusicMemory({ append = false } = {}) {
  const query = $("#musicMemoryQuery")?.value.trim() || "";
  const beatport = $("#musicMemoryBeatportFilter")?.value || "";
  const feedback = $("#musicMemoryFeedbackFilter")?.value || "";
  const offset = append ? state.musicMemoryTracks.length : 0;
  state.musicMemoryLoading = true;
  if (!append) {
    state.musicMemoryTracks = [];
    state.musicMemoryOffset = 0;
  }
  state.musicMemoryQuery = query;
  state.musicMemoryBeatportFilter = beatport;
  state.musicMemoryFeedbackFilter = feedback;
  renderMusicMemory();
  try {
    const params = new URLSearchParams({
      q: query,
      beatport,
      feedback,
      limit: String(state.musicMemoryLimit),
      offset: String(offset)
    });
    const payload = await getJson(`/api/music-memory/search?${params.toString()}`);
    state.musicMemory = payload;
    state.musicMemoryTracks = append
      ? [...state.musicMemoryTracks, ...(payload.tracks || [])]
      : (payload.tracks || []);
    state.musicMemoryOffset = state.musicMemoryTracks.length;
    state.musicMemoryNeedsRefresh = false;
    return payload;
  } finally {
    state.musicMemoryLoading = false;
    renderMusicMemory();
  }
}

function beatportChartTrackPayload(track = {}) {
  return {
    artist: track.artist || "",
    title: track.titleWithMix || (track.mixName ? `${track.title} (${track.mixName})` : track.title) || "",
    album: track.album || "",
    label: track.label || "",
    genre: [track.genre, track.subGenre].filter(Boolean).join(", ") || track.genre || "",
    releaseDate: track.releaseDate || "",
    durationMs: track.durationMs || null,
    isrc: track.isrc || "",
    beatportTrackId: track.id || track.beatport?.id || "",
    beatport: track.beatport || {
      id: track.id || "",
      url: track.beatportUrl || track.url || "",
      genre: track.genre || "",
      subGenre: track.subGenre || "",
      label: track.label || "",
      releaseDate: track.releaseDate || "",
      releaseId: track.releaseId || "",
      bpm: track.bpm || null,
      keyName: track.keyName || "",
      camelot: track.camelot || "",
      isrc: track.isrc || ""
    },
    metadataEnrichment: track.metadataEnrichment || null,
    source: "beatport_chart",
    chartPosition: track.position || null
  };
}

function beatportChartMetaParts(chart = {}, pagination = {}) {
  return [
    chart.curator ? `Curator: ${chart.curator}` : "",
    chart.publishDate ? `Published ${formatDateTime(Date.parse(chart.publishDate))}` : "",
    Array.isArray(chart.genres) && chart.genres.length ? chart.genres.join(", ") : "",
    `${pagination.count || chart.trackCount || 0} tracks`
  ].filter(Boolean);
}

function beatportChartTrackHtml(track = {}) {
  const imageUrl = safeHttpUrl(track.imageUrl || track.metadataEnrichment?.imageUrl);
  const title = track.title || "Untitled";
  const mix = track.mixName ? ` (${track.mixName})` : "";
  const meta = [
    track.release || track.album || "",
    track.label || "",
    track.genre || "",
    track.subGenre || "",
    track.bpm ? `${Math.round(Number(track.bpm))} BPM` : "",
    track.keyName || "",
    track.camelot || "",
    track.releaseDate || "",
    track.durationMs ? formatDuration(track.durationMs) : ""
  ].filter(Boolean).join(" - ");
  return `
    <article class="beatportChartTrack">
      <span class="beatportChartPosition">${escapeHtml(track.position || "")}</span>
      <div class="beatportChartArt">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : ""}</div>
      <div class="beatportChartBody">
        <h3>${escapeHtml(title)}${escapeHtml(mix)}</h3>
        <p>${escapeHtml(track.artist || "Unknown artist")}</p>
        ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
        <small>${escapeHtml([track.id ? `Beatport ${track.id}` : "", track.isrc ? `ISRC ${track.isrc}` : ""].filter(Boolean).join(" - "))}</small>
      </div>
    </article>
  `;
}

function renderBeatportChart() {
  const status = $("#beatportChartStatus");
  const title = $("#beatportChartTitle");
  const meta = $("#beatportChartMeta");
  const tracks = $("#beatportChartTracks");
  const queue = $("#beatportChartQueue");
  const queueNext = $("#beatportChartQueueNext");
  if (!status || !title || !meta || !tracks) return;
  const payload = state.beatportChart || {};
  const chart = payload.chart || null;
  const list = state.beatportChartTracks || [];
  if (state.beatportChartLoading && !chart) {
    status.textContent = "Loading Beatport chart...";
    title.textContent = "Loading chart";
    meta.textContent = "";
    tracks.innerHTML = "<div class=\"playlistBrowserEmpty\">Loading Beatport chart...</div>";
  } else if (!chart) {
    status.textContent = "Load a Beatport chart, then queue through Rabbit Hole's TIDAL/Roon resolver.";
    title.textContent = "No chart loaded";
    meta.textContent = "";
    tracks.innerHTML = "<div class=\"playlistBrowserEmpty\">No chart loaded.</div>";
  } else {
    const pagination = payload.pagination || {};
    status.textContent = pagination.complete === false
      ? `${list.length}/${pagination.count || chart.trackCount || list.length} tracks loaded; more pages available.`
      : `${list.length}/${pagination.count || chart.trackCount || list.length} chart tracks loaded.`;
    title.textContent = chart.title || `Beatport chart ${chart.id || ""}`.trim();
    meta.textContent = beatportChartMetaParts(chart, pagination).join(" - ");
    tracks.innerHTML = list.length
      ? list.map(beatportChartTrackHtml).join("")
      : "<div class=\"playlistBrowserEmpty\">This chart did not return tracks.</div>";
  }
  const canQueue = Boolean(list.length && !state.beatportChartLoading);
  if (queue) queue.disabled = !canQueue;
  if (queueNext) queueNext.disabled = !canQueue;
}

async function refreshBeatportChart() {
  const input = $("#beatportChartId");
  const chartId = (input?.value || state.beatportChartId || "901032").trim().replace(/[^0-9]/g, "");
  if (input) input.value = chartId;
  if (!chartId) throw new Error("Enter a Beatport chart ID.");
  state.beatportChartLoading = true;
  state.beatportChartId = chartId;
  localStorage.setItem("beatportChartId", chartId);
  renderBeatportChart();
  try {
    const payload = await getJson(`/api/beatport/charts/${encodeURIComponent(chartId)}?per_page=100`);
    state.beatportChart = payload;
    state.beatportChartTracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    state.beatportChartNeedsRefresh = false;
    return payload;
  } finally {
    state.beatportChartLoading = false;
    renderBeatportChart();
  }
}

function setPlaylistBrowserStatus(message = "") {
  state.playlistBrowserStatus = message;
  const status = $("#playlistBrowserStatus");
  if (status) status.textContent = playlistBrowserStatusText();
}

async function refreshPlaylists({ force = false } = {}) {
  const seedStatus = $("#playlistStatus");
  if (seedStatus) seedStatus.textContent = "Loading playlists...";
  state.roonPlaylistsLoading = true;
  state.roonPlaylistsError = "";
  state.roonPlaylistsWarning = "";
  renderPlaylistBrowser();
  try {
    const result = await getJson(`/api/roon/playlists${force ? "?refresh=1" : ""}`);
    state.playlists = result.playlists || [];
    state.roonPlaylistsLoaded = true;
    state.roonPlaylistsError = "";
    const hiddenTidalCount = Number(result.hiddenTidalPlaylistCount || 0);
    const hiddenNote = hiddenTidalCount ? ` (${hiddenTidalCount} TIDAL-backed hidden)` : "";
    state.roonPlaylistsWarning = result.warning || (hiddenTidalCount ? `${hiddenTidalCount} TIDAL-backed playlist${hiddenTidalCount === 1 ? "" : "s"} hidden from local list` : "");
    const select = $("#playlistSelect");
    if (select) {
      select.innerHTML = state.playlists.length
        ? state.playlists.map((playlist) => `<option value="${escapeHtml(playlist.id)}">${escapeHtml(playlist.title)}${playlist.subtitle ? ` - ${escapeHtml(playlist.subtitle)}` : ""}</option>`).join("")
        : "<option value=\"\">No playlists found</option>";
    }
    if (seedStatus) seedStatus.textContent = state.playlists.length ? `${state.playlists.length} Roon local playlists available${hiddenNote}` : `No Roon local playlists found${hiddenNote}`;
    return result;
  } catch (error) {
    state.roonPlaylistsError = error.message;
    state.roonPlaylistsLoaded = false;
    if (seedStatus) seedStatus.textContent = error.message;
    return { playlists: [], error: error.message };
  } finally {
    state.roonPlaylistsLoading = false;
    renderPlaylistBrowser();
  }
}

async function refreshPlaylistBrowser({ force = false } = {}) {
  const button = $("#refreshPlaylistBrowser");
  const originalText = button?.textContent || "Refresh playlists";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  state.playlistBrowserStatus = "Loading playlists...";
  renderPlaylistBrowser();
  try {
    await Promise.all([
      (!state.roonPlaylistsLoaded || force) ? refreshPlaylists({ force }) : Promise.resolve(),
      (!state.tidalPlaylistsLoaded || state.tidalPlaylistsFromCache || force) ? loadTidalPlaylists({ force }) : Promise.resolve()
    ]);
  } finally {
    state.playlistBrowserStatus = "";
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    renderPlaylistBrowser();
  }
}

function browserPlaylistFor(source = "", index = 0) {
  const list = source === "tidal" ? state.tidalPlaylists : state.playlists;
  return Array.isArray(list) ? list[Number(index)] : null;
}

async function loadBrowserPlaylistTracks(source = "", playlist = {}, options = {}) {
  if (source === "tidal") {
    const result = await api("/api/tidal/playlist-tracks", {
      playlistId: playlist.id,
      title: playlist.title,
      limit: options.limit || 50
    });
    return {
      title: result.mix?.title || playlist.title || "TIDAL playlist",
      tracks: Array.isArray(result.tracks) ? result.tracks : []
    };
  }
  const result = await api("/api/roon/playlist-tracks", {
    itemKey: playlist.id,
    title: playlist.title
  });
  return {
    title: result.title || playlist.title || "Roon playlist",
    tracks: Array.isArray(result.tracks) ? result.tracks : []
  };
}

async function playBrowserPlaylist(source = "", index = 0, mode = "replace", button = null) {
  const playlist = browserPlaylistFor(source, index);
  if (!playlist?.id) return alert("Choose a playlist first.");
  const shuffle = mode === "shuffle";
  const queueMode = shuffle ? "replace" : mode;
  const originalText = button?.textContent || "Play";
  if (button) {
    button.disabled = true;
    button.textContent = "Loading...";
  }
  setPlaylistBrowserStatus(`Loading ${playlist.title || "playlist"}...`);

  try {
    const result = await loadBrowserPlaylistTracks(source, playlist, {
      limit: shuffle ? 500 : 50
    });
    const tracks = shuffle ? shuffledCopy(result.tracks || []) : (result.tracks || []);
    if (!tracks.length) throw new Error(`${result.title || playlist.title || "Playlist"} did not return playable tracks.`);
    const queuedTracks = tracks.slice(0, 50);
    const skipped = Math.max(0, tracks.length - queuedTracks.length);
    const verb = shuffle ? "Shuffle playing" : (queueMode === "replace" ? "Playing" : (queueMode === "next" ? "Adding next" : "Queueing"));
    setPlaylistBrowserStatus(`${verb} ${queuedTracks.length} track${queuedTracks.length === 1 ? "" : "s"} from ${result.title || playlist.title}${skipped ? `; ${skipped} more not queued` : ""}.`);
    if (button) button.textContent = shuffle ? "Shuffling..." : (queueMode === "replace" ? "Playing..." : "Queueing...");
    const queueResult = await queueTrackList(queuedTracks, button || $("#refreshPlaylistBrowser"), {
      targetCount: queuedTracks.length,
      mode: queueMode,
      preferExtendedMixes: false,
      buttonText: originalText
    });
    if (!queueResult) {
      setPlaylistBrowserStatus(`${result.title || playlist.title}: Roon queue update failed.`);
      return;
    }
    setPlaylistBrowserStatus(`${result.title || playlist.title}: ${queuedTracks.length} ${shuffle ? "shuffled " : ""}track${queuedTracks.length === 1 ? "" : "s"} sent to Roon${skipped ? `, ${skipped} left off because queue playback is capped at 50` : ""}.`);
  } catch (error) {
    setPlaylistBrowserStatus(error.message);
    if (button) button.textContent = "Failed";
    alert(error.message);
  } finally {
    renderPlaylistBrowser();
    if (button) {
      setTimeout(() => {
        button.disabled = false;
        button.textContent = originalText;
      }, 1600);
    }
  }
}

async function deleteBrowserPlaylist(source = "", index = 0, button = null) {
  const playlist = browserPlaylistFor(source, index);
  if (!playlist?.id) return alert("Choose a playlist first.");
  const provider = source === "tidal" ? "TIDAL" : "Roon local";
  const title = playlist.title || "Untitled playlist";
  if (!confirm(`Delete ${provider} playlist "${title}"? This cannot be undone from Rabbit Hole.`)) return;

  const originalText = button?.textContent || "Delete";
  if (button) {
    button.disabled = true;
    button.textContent = "Deleting...";
  }
  setPlaylistBrowserStatus(`Deleting ${title}...`);

  try {
    const result = source === "tidal"
      ? await deleteJson("/api/tidal/playlist", { playlistId: playlist.id, title })
      : await deleteJson("/api/roon/playlist", { itemKey: playlist.id, title });
    if (result.deleted === false) throw new Error(result.reason || `Could not delete ${title}.`);

    if (source === "tidal") {
      state.tidalPlaylists = state.tidalPlaylists.filter((item) => item.id !== playlist.id);
      state.tidalPlaylistsLoaded = true;
      state.tidalPlaylistsFromCache = false;
      state.tidalPlaylistsError = "";
      writeCachedTidalPlaylists(state.tidalPlaylists);
      if (state.selectedTidalPlaylistId === playlist.id) state.selectedTidalPlaylistId = state.tidalPlaylists[0]?.id || "";
      if (state.selectedTidalSeedPlaylistId === playlist.id) state.selectedTidalSeedPlaylistId = state.tidalPlaylists[0]?.id || "";
      if (state.selectedTidalPlaylistId) localStorage.setItem("tidalPlaylistId", state.selectedTidalPlaylistId);
      else localStorage.removeItem("tidalPlaylistId");
      renderNowTidalPlaylistControl();
      renderTidalPlaylistSeedControl();
    } else {
      await refreshPlaylists({ force: true });
    }

    setPlaylistBrowserStatus(result.removedFromCollection
      ? `Removed ${title} from your TIDAL collection.`
      : `Deleted ${title}.`);
  } catch (error) {
    setPlaylistBrowserStatus(error.message);
    if (button) button.textContent = "Failed";
    alert(error.message);
  } finally {
    renderPlaylistBrowser();
    if (button) {
      setTimeout(() => {
        button.disabled = false;
        button.textContent = originalText;
      }, 1600);
    }
  }
}

function seedLinesFromTracks(tracks = []) {
  return tracks
    .slice(0, 80)
    .map((track) => `${track.artist || "Unknown Artist"} - ${track.title || "Untitled"}`)
    .join("\n");
}

async function useTidalPlaylistSeed() {
  const playlist = selectedTidalSeedPlaylist();
  const status = $("#tidalPlaylistSeedStatus");
  if (!playlist?.id) return;

  status.textContent = "Loading TIDAL playlist tracks...";
  try {
    const result = await api("/api/tidal/playlist-tracks", {
      playlistId: playlist.id,
      title: playlist.title,
      limit: 80
    });
    state.tidalPlaylistSeedTracks = result.tracks || [];
    const title = result.mix?.title || playlist.title || "TIDAL playlist";
    $("#reference").value = seedLinesFromTracks(state.tidalPlaylistSeedTracks);
    if (!$("#request").value.trim()) {
      $("#request").value = `find similar discoveries to ${title}`;
    }
    status.textContent = `${title}: ${state.tidalPlaylistSeedTracks.length} TIDAL seed tracks loaded`;
  } catch (error) {
    status.textContent = error.message;
  }
}

function radioOrderStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RADIO_STATION_ORDER_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function radioOrderScope() {
  return state.radioBrowseItemKey || state.radioBrowseHierarchy || "root";
}

function radioStationOrderId(station = {}) {
  return String(station.id || station.itemKey || `${station.kind || "station"}:${station.title || ""}:${station.subtitle || ""}`).trim();
}

function saveRadioStationOrder(stations = state.radioStations) {
  const scope = radioOrderScope();
  const order = stations.map(radioStationOrderId).filter(Boolean);
  const store = radioOrderStore();
  if (order.length) store[scope] = order;
  else delete store[scope];
  localStorage.setItem(RADIO_STATION_ORDER_KEY, JSON.stringify(store));
}

function radioStationOrderForScope(scope = radioOrderScope()) {
  const order = radioOrderStore()[scope];
  return Array.isArray(order) ? order.filter(Boolean) : [];
}

function hasCustomRadioStationOrder() {
  return radioStationOrderForScope().length > 0;
}

function applyRadioStationOrder(stations = []) {
  const order = radioStationOrderForScope();
  if (!order.length) return stations;
  const rank = new Map(order.map((id, index) => [id, index]));
  return stations
    .map((station, index) => ({ station, index, id: radioStationOrderId(station) }))
    .sort((left, right) => {
      const leftRank = rank.has(left.id) ? rank.get(left.id) : Number.POSITIVE_INFINITY;
      const rightRank = rank.has(right.id) ? rank.get(right.id) : Number.POSITIVE_INFINITY;
      return leftRank - rightRank || left.index - right.index;
    })
    .map((entry) => entry.station);
}

function moveRadioStation(fromIndex, toIndex) {
  const from = Math.max(0, Math.min(state.radioStations.length - 1, Number(fromIndex)));
  const to = Math.max(0, Math.min(state.radioStations.length - 1, Number(toIndex)));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const next = [...state.radioStations];
  const [station] = next.splice(from, 1);
  next.splice(to, 0, station);
  state.radioStations = next;
  radioMoveIndex = -1;
  saveRadioStationOrder(next);
  renderRadioStations();
  const status = $("#radioStatus");
  if (status) status.textContent = `Saved radio station order for ${state.radioBrowseTitle || "Radio Stations"}.`;
  return true;
}

function clearRadioStationOrder() {
  const scope = radioOrderScope();
  const store = radioOrderStore();
  delete store[scope];
  localStorage.setItem(RADIO_STATION_ORDER_KEY, JSON.stringify(store));
}

function selectRadioStationForMove(index) {
  const nextIndex = Math.max(0, Math.min(state.radioStations.length - 1, Number(index)));
  if (!Number.isFinite(nextIndex) || !state.radioStations[nextIndex]) return;
  radioMoveIndex = radioMoveIndex === nextIndex ? -1 : nextIndex;
  renderRadioStations();
  const status = $("#radioStatus");
  if (!status) return;
  if (radioMoveIndex >= 0) {
    const station = state.radioStations[radioMoveIndex];
    status.textContent = `Move ${station.title || "station"}: tap another station to place it before that station, or hold and drag.`;
  } else {
    status.textContent = `${state.radioStations.length} station${state.radioStations.length === 1 ? "" : "s"} in ${state.radioBrowseTitle || "Radio Stations"}.`;
  }
}

function handleRadioStationMoveTarget(event) {
  if (radioMoveIndex < 0) return false;
  if (event.target.closest("button, a, input, select, textarea")) return false;
  const card = event.target.closest("#radioStations .radioStation[data-radio-index]");
  if (!card) return false;
  const targetIndex = Number(card.dataset.radioIndex);
  if (!Number.isFinite(targetIndex)) return false;
  event.preventDefault();
  if (targetIndex === radioMoveIndex) {
    radioMoveIndex = -1;
    renderRadioStations();
    return true;
  }
  const toIndex = radioMoveIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return moveRadioStation(radioMoveIndex, toIndex);
}

function radioStationCardHtml(station = {}, index = 0) {
  const title = station.title || "Untitled station";
  const subtitle = (station.subtitle || "").trim();
  const fallbackMeta = station.kind === "folder" ? "Folder" : "";
  const meta = subtitle || fallbackMeta;
  const moving = radioMoveIndex === index;
  const imageUrl = station.imageKey
    ? `/api/roon/image/${encodeURIComponent(station.imageKey)}?width=160&height=160`
    : "";
  const art = imageUrl
    ? `<span class="radioStationArt" style="background-image:url('${escapeHtml(imageUrl)}')"></span>`
    : `<span class="radioStationArt radioStationArtEmpty">${escapeHtml(String(index + 1).padStart(2, "0"))}</span>`;
  return `
    <article class="radioStation${moving ? " isMoveSelected" : ""}" data-radio-index="${index}">
      ${art}
      <div class="radioStationText">
        <h3 title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
        ${meta ? `<p>${escapeHtml(meta)}</p>` : ""}
      </div>
      <div class="radioStationActions">
        <button type="button" class="radioStationDragButton" data-radio-drag="${index}" aria-pressed="${moving ? "true" : "false"}" aria-label="Move ${escapeHtml(title)}">${moving ? "Moving" : "Move"}</button>
        ${station.kind === "folder" ? `<button type="button" data-radio-open="${index}">Open</button>` : ""}
        ${station.playable ? `<button type="button" data-radio-play="${index}">Play</button>` : ""}
      </div>
    </article>
  `;
}

function renderRadioStations() {
  const status = $("#radioStatus");
  const grid = $("#radioStations");
  if (!status || !grid) return;

  if (state.radioStationsLoading) {
    status.textContent = "Loading Roon radio stations...";
  } else if (state.radioStationsError) {
    status.textContent = state.radioStationsError;
  } else if (state.radioStationsLoaded) {
    const title = state.radioBrowseTitle || "Radio Stations";
    const playableCount = state.radioStations.filter((station) => station.playable).length;
    const itemLabel = playableCount === state.radioStations.length ? "station" : "item";
    status.textContent = state.radioStations.length
      ? `${state.radioStations.length} ${itemLabel}${state.radioStations.length === 1 ? "" : "s"} in ${title}.`
      : `${title}: Roon did not return any radio items.`;
  } else {
    status.textContent = "Radio stations have not been loaded yet.";
  }

  const rootButton = $("#radioRoot");
  if (rootButton) rootButton.hidden = !state.radioBrowseItemKey;
  const resetButton = $("#resetRadioOrder");
  if (resetButton) resetButton.hidden = !state.radioStationsLoaded || !hasCustomRadioStationOrder();
  if (radioMoveIndex >= state.radioStations.length) radioMoveIndex = -1;
  grid.innerHTML = state.radioStations.length
    ? state.radioStations.map(radioStationCardHtml).join("")
    : `<p class="muted">${escapeHtml(state.radioStationsLoading ? "Loading stations..." : "Open this tab or refresh to load Roon radio stations.")}</p>`;
}

async function refreshRadioStations({ force = false, itemKey = state.radioBrowseItemKey } = {}) {
  const zone = activeZone();
  if (!zone?.zone_id) throw new Error("Choose a Roon output zone first.");
  state.radioStationsLoading = true;
  state.radioStationsError = "";
  renderRadioStations();
  try {
    const query = new URLSearchParams({ zoneId: zone.zone_id });
    if (force) query.set("refresh", "1");
    if (itemKey) query.set("itemKey", itemKey);
    if (state.radioBrowseHierarchy) query.set("hierarchy", state.radioBrowseHierarchy);
    if (state.radioStationsSession) query.set("session", state.radioStationsSession);
    const result = await getJson(`/api/roon/radio?${query.toString()}`);
    state.radioStationsSession = result.session || "";
    state.radioBrowseHierarchy = result.hierarchy || state.radioBrowseHierarchy || "";
    state.radioBrowseTitle = result.title || "Radio Stations";
    state.radioBrowseItemKey = result.itemKey || itemKey || "";
    state.radioStations = applyRadioStationOrder(Array.isArray(result.items) ? result.items : (Array.isArray(result.stations) ? result.stations : []));
    state.radioStationsLoaded = true;
    state.radioStationsError = result.error || "";
    renderRadioStations();
    return result;
  } catch (error) {
    state.radioStationsError = error.message;
    renderRadioStations();
    throw error;
  } finally {
    state.radioStationsLoading = false;
    renderRadioStations();
  }
}

async function openRadioFolder(station = {}) {
  if (!station?.id) throw new Error("Missing radio folder id.");
  return refreshRadioStations({ itemKey: station.id });
}

async function playRadioStation(station = {}, button = null) {
  const zone = activeZone();
  if (!zone?.zone_id) throw new Error("Choose a Roon output zone first.");
  if (!station?.id) throw new Error("Missing radio station id.");
  const originalText = button?.textContent || "Play";
  if (button) {
    button.disabled = true;
    button.textContent = "Playing...";
  }
  try {
    const result = await api("/api/roon/radio/play", {
      zoneId: zone.zone_id,
      itemKey: station.id,
      hierarchy: state.radioBrowseHierarchy || "",
      session: state.radioStationsSession || "",
      title: station.title || "",
      subtitle: station.subtitle || ""
    });
    const status = $("#radioStatus");
    if (status) status.textContent = result.played || result.success
      ? `Playing ${station.title || "radio station"} on ${zone.display_name || "selected zone"}.`
      : (result.reason || "Roon did not start the radio station.");
    setTimeout(() => refresh().catch(() => {}), 900);
    return result;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function radioStationCardFromPoint(clientX, clientY) {
  const element = document.elementFromPoint(clientX, clientY);
  return element?.closest?.("#radioStations .radioStation[data-radio-index]") || null;
}

function clearRadioDragDropClasses() {
  document.querySelectorAll("#radioStations .radioStation").forEach((card) => {
    card.classList.remove("isDropBefore", "isDropAfter");
  });
}

function radioDragDestination(event) {
  if (!radioDrag?.active) return null;
  const targetCard = radioStationCardFromPoint(event.clientX, event.clientY);
  if (!targetCard) return null;
  const targetIndex = Number(targetCard.dataset.radioIndex);
  if (!Number.isFinite(targetIndex)) return null;
  const rect = targetCard.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  let toIndex = targetIndex + (after ? 1 : 0);
  if (radioDrag.sourceIndex < toIndex) toIndex -= 1;
  toIndex = Math.max(0, Math.min(state.radioStations.length - 1, toIndex));
  return { targetCard, targetIndex, toIndex, after };
}

function updateRadioDragGhost(event) {
  if (!radioDrag?.ghost) return;
  radioDrag.ghost.style.transform = `translate(${Math.round(event.clientX - radioDrag.offsetX)}px, ${Math.round(event.clientY - radioDrag.offsetY)}px)`;
}

function beginRadioDrag(event) {
  if (!radioDrag || radioDrag.active) return;
  const { card } = radioDrag;
  if (!card?.isConnected) {
    radioDrag = null;
    return;
  }
  const rect = card.getBoundingClientRect();
  radioDrag.active = true;
  radioDrag.offsetX = event.clientX - rect.left;
  radioDrag.offsetY = event.clientY - rect.top;
  radioDrag.ghost = card.cloneNode(true);
  radioDrag.ghost.classList.add("radioStationDragGhost");
  radioDrag.ghost.style.width = `${rect.width}px`;
  radioDrag.ghost.style.height = `${rect.height}px`;
  document.body.appendChild(radioDrag.ghost);
  card.classList.add("isDragging");
  document.body.classList.add("radioDragActive");
  updateRadioDragGhost(event);
}

function cancelPendingRadioDrag() {
  if (!radioDrag) return;
  if (radioDrag.timer) clearTimeout(radioDrag.timer);
  radioDrag = null;
}

function cleanupRadioDrag() {
  if (!radioDrag) return;
  if (radioDrag.timer) clearTimeout(radioDrag.timer);
  try {
    radioDrag.card?.releasePointerCapture?.(radioDrag.pointerId);
  } catch {
    // Pointer capture may already be released on some mobile browsers.
  }
  radioDrag.card?.classList.remove("isDragging");
  radioDrag.ghost?.remove();
  clearRadioDragDropClasses();
  document.body.classList.remove("radioDragActive");
  radioDrag = null;
}

function startRadioStationDrag(event) {
  const card = event.target.closest("#radioStations .radioStation[data-radio-index]");
  if (!card || event.button > 0) return;
  const handle = event.target.closest("[data-radio-drag]");
  const action = event.target.closest("button, a, input, select, textarea");
  if (action && !handle) return;
  if (event.pointerType === "mouse" && !handle) return;

  const sourceIndex = Number(card.dataset.radioIndex);
  if (!Number.isFinite(sourceIndex) || !state.radioStations[sourceIndex]) return;
  if (handle) event.preventDefault();
  radioDrag = {
    active: false,
    card,
    sourceIndex,
    startX: event.clientX,
    startY: event.clientY,
    pointerId: event.pointerId,
    timer: null,
    ghost: null,
    targetIndex: sourceIndex,
    dragOnMove: Boolean(handle),
    moved: false,
    offsetX: 0,
    offsetY: 0
  };
  try {
    card.setPointerCapture?.(event.pointerId);
  } catch {
    // Best-effort only. Window listeners still handle the drag path.
  }

  const delay = handle ? 0 : 420;
  if (delay) {
    radioDrag.timer = setTimeout(() => beginRadioDrag(event), delay);
  } else {
    beginRadioDrag(event);
  }
}

function handleRadioStationDragMove(event) {
  if (!radioDrag || event.pointerId !== radioDrag.pointerId) return;
  const moved = Math.hypot(event.clientX - radioDrag.startX, event.clientY - radioDrag.startY);
  if (moved > 10) radioDrag.moved = true;
  if (!radioDrag.active) {
    if (moved > 10) {
      if (radioDrag.dragOnMove) beginRadioDrag(event);
      else cancelPendingRadioDrag();
    }
    return;
  }

  event.preventDefault();
  updateRadioDragGhost(event);
  const destination = radioDragDestination(event);
  clearRadioDragDropClasses();
  if (destination) {
    radioDrag.targetIndex = destination.toIndex;
    destination.targetCard.classList.add(destination.after ? "isDropAfter" : "isDropBefore");
  }
  if (event.clientY < 70) window.scrollBy(0, -12);
  if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 12);
}

function handleRadioStationDragEnd(event) {
  if (!radioDrag || event.pointerId !== radioDrag.pointerId) return;
  const wasActive = radioDrag.active;
  const sourceIndex = radioDrag.sourceIndex;
  const moved = radioDrag.moved;
  const destination = wasActive ? radioDragDestination(event) : null;
  cleanupRadioDrag();
  if (wasActive && moved) {
    suppressNextRadioClick = true;
    setTimeout(() => {
      suppressNextRadioClick = false;
    }, 0);
  }
  if (!wasActive || !destination) return;
  moveRadioStation(sourceIndex, destination.toIndex);
}

function tidalMixCardHtml(mix = {}, index = 0) {
  const imageUrl = safeHttpUrl(mix.imageUrl);
  const externalUrl = safeHttpUrl(mix.url);
  const prompt = `find discoveries inspired by my TIDAL ${mix.category || "mix"} ${mix.title || ""}`.trim();
  const itemLabel = Number(mix.itemCount || 0) ? `${Number(mix.itemCount)} tracks` : "";
  const pinnedKey = mix.pinnedKey || "";
  return `
    <article class="tidalMixCard">
      <div class="tidalMixArt">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : `<span>${escapeHtml(String(index + 1).padStart(2, "0"))}</span>`}
      </div>
      <div class="tidalMixBody">
        <div class="tidalMixTypeRow">
          <span class="tidalMixType">${escapeHtml(mix.category || "Mix")}</span>
          ${mix.pinned ? "<span class=\"tidalPinnedBadge\">Pinned</span>" : ""}
        </div>
        <h3>${escapeHtml(mix.title || "Untitled mix")}</h3>
        ${mix.subtitle ? `<p>${escapeHtml(mix.subtitle)}</p>` : ""}
        ${mix.rawType || itemLabel ? `<small>${escapeHtml([mix.rawType, itemLabel].filter(Boolean).join(" - "))}</small>` : ""}
      </div>
      <div class="tidalMixActions">
        <button type="button" data-tidal-mix-play="${index}">Play Roon</button>
        <button type="button" data-tidal-mix-next="${index}">Add Next</button>
        <button type="button" data-tidal-mix-queue="${index}">Queue</button>
        <button type="button" data-tidal-mix-prompt="${escapeHtml(prompt)}">Use as prompt</button>
        ${externalUrl ? `<a class="buttonLink" href="${escapeHtml(externalUrl)}" target="_blank" rel="noreferrer">Open TIDAL</a>` : ""}
        ${mix.pinned && pinnedKey ? `<button type="button" data-tidal-pinned-remove="${escapeHtml(pinnedKey)}">Remove pin</button>` : ""}
      </div>
    </article>
  `;
}

function renderTidalMixes(result = state.tidalMixes) {
  const status = $("#tidalMixStatus");
  const grid = $("#tidalMixesGrid");
  const pinnedStatus = $("#tidalPinnedStatus");
  if (!status || !grid) return;
  const mixes = Array.isArray(result?.mixes) ? result.mixes : [];
  const pinnedMixes = Array.isArray(result?.pinnedMixes) ? result.pinnedMixes : [];
  const pinnedErrors = Array.isArray(result?.pinnedErrors) ? result.pinnedErrors : [];
  const pinnedItems = Array.isArray(result?.pinnedItems) ? result.pinnedItems : [];
  state.tidalVisibleMixes = [...pinnedMixes, ...mixes];

  if (!result) {
    status.textContent = "TIDAL profile mixes have not been loaded yet.";
    if (pinnedStatus) pinnedStatus.textContent = "";
    grid.innerHTML = "";
    return;
  }

  const fetchedAt = result.fetchedAt ? ` Updated ${formatDateTime(Date.parse(result.fetchedAt))}.` : "";
  if (result.error && !mixes.length && !pinnedMixes.length) {
    status.textContent = `${result.error}${fetchedAt}`;
    if (pinnedStatus) pinnedStatus.textContent = pinnedItems.length ? `${pinnedItems.length} pinned item${pinnedItems.length === 1 ? "" : "s"} could not be refreshed.` : "";
    grid.innerHTML = `
      <div class="panel tidalMixEmpty">
        <strong>No TIDAL profile mixes loaded.</strong>
        <p>Use Connect TIDAL to authorize Rabbit Hole and save a refreshable profile token locally. Catalog search credentials cannot read personal mixes.</p>
      </div>
    `;
    return;
  }

  const fullShelfNote = result.fullShelfAvailable === false && result.missingLegacyScope
    ? (result.artistRadioFallbackAvailable
      ? ` Added ${Number(result.artistRadioFallbackCount || 0)} Artist Radio fallback${Number(result.artistRadioFallbackCount || 0) === 1 ? "" : "s"}.`
      : " Full Mixes & Radio needs a TIDAL legacy scope; showing only official TIDAL profile mixes.")
    : (result.fullShelfAvailable ? " Full Mixes & Radio shelf loaded." : "");
  const total = mixes.length + pinnedMixes.length;
  const pinnedNote = pinnedMixes.length
    ? ` ${pinnedMixes.length} pinned TIDAL item${pinnedMixes.length === 1 ? "" : "s"}.`
    : "";
  status.textContent = total
    ? `${total} mix/radio item${total === 1 ? "" : "s"} found.${pinnedNote}${fullShelfNote}${fetchedAt}`
    : `${result.warning || "TIDAL responded, but no personal mixes were found."}${fetchedAt}`;
  if (pinnedStatus) {
    pinnedStatus.textContent = pinnedErrors.length
      ? `${pinnedErrors.length} pinned item${pinnedErrors.length === 1 ? "" : "s"} could not be refreshed.`
      : (pinnedItems.length ? `${pinnedItems.length} pinned item${pinnedItems.length === 1 ? "" : "s"} saved locally.` : "");
  }

  const pinnedErrorHtml = pinnedErrors.length ? `
    <div class="panel tidalMixEmpty">
      <strong>Pinned import warning</strong>
      <p>${escapeHtml(pinnedErrors.map((entry) => entry.error).filter(Boolean).join(" - "))}</p>
    </div>
  ` : "";
  const pinnedHtml = pinnedMixes.length ? `
    <section class="tidalMixSection">
      <div class="tidalSectionTitle">
        <h3>Pinned TIDAL</h3>
        <span>${pinnedMixes.length} imported</span>
      </div>
      ${pinnedMixes.map((mix, index) => tidalMixCardHtml(mix, index)).join("")}
    </section>
  ` : "";
  const officialHtml = mixes.length ? `
    <section class="tidalMixSection">
      <div class="tidalSectionTitle">
        <h3>Official Profile Mixes</h3>
        <span>${mixes.length} available</span>
      </div>
      ${mixes.map((mix, index) => tidalMixCardHtml(mix, index + pinnedMixes.length)).join("")}
    </section>
  ` : "";
  grid.innerHTML = total || pinnedErrorHtml
    ? [pinnedErrorHtml, pinnedHtml, officialHtml].filter(Boolean).join("")
    : `
      <div class="panel tidalMixEmpty">
        <strong>No mix or radio cards found in the TIDAL response.</strong>
        <p>The endpoint is reachable, but Rabbit Hole did not see My Mix, Daily Discovery, New Arrivals, Track Radio, or Artist Radio items.</p>
      </div>
    `;
}

async function importPinnedTidalMix(input, button) {
  const status = $("#tidalPinnedStatus");
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Importing...";
  }
  if (status) status.textContent = "Importing TIDAL item...";
  try {
    state.tidalMixes = await api("/api/tidal/pinned-mixes", { url: input });
    state.tidalMixesNeedsRefresh = false;
    renderTidalMixes(state.tidalMixes);
    if (status) status.textContent = "Pinned TIDAL item saved.";
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "Import";
    }
  }
}

async function removePinnedTidalMix(key, button) {
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Removing...";
  }
  try {
    state.tidalMixes = await deleteJson("/api/tidal/pinned-mixes", { key });
    renderTidalMixes(state.tidalMixes);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "Remove pin";
    }
  }
}

async function refreshTidalMixes({ force = false } = {}) {
  const button = $("#refreshTidalMixes");
  const status = $("#tidalMixStatus");
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  if (status) status.textContent = "Loading TIDAL profile mixes...";
  try {
    state.tidalMixes = await getJson(`/api/tidal/mixes${force ? "?refresh=1" : ""}`);
    state.tidalMixesNeedsRefresh = false;
    renderTidalMixes(state.tidalMixes);
  } catch (error) {
    state.tidalMixes = { mixes: [], error: error.message };
    renderTidalMixes(state.tidalMixes);
  } finally {
    if (button) {
      button.textContent = originalText || "Refresh mixes";
      button.disabled = false;
    }
  }
}

function metricCardHtml(label, value, note = "") {
  return `
    <div class="metricCard">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
    </div>
  `;
}

function reportRowHtml(item = {}, index = 0, mode = "artist") {
  const title = mode === "track" ? item.title || item.name : item.name || item.title;
  const subtitle = mode === "track"
    ? [item.artist, `${item.plays || 0} play${item.plays === 1 ? "" : "s"}`, formatHours(item.totalSeconds)].filter(Boolean).join(" - ")
    : [`${item.plays || 0} play${item.plays === 1 ? "" : "s"}`, formatHours(item.totalSeconds)].filter(Boolean).join(" - ");
  const imageUrl = safeHttpUrl(item.imageUrl);
  const art = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : `<span class="rowIndex">${index + 1}</span>`;

  return `
    <div class="reportRow">
      ${art}
      <div>
        <strong>${index + 1}. ${escapeHtml(title || "Unknown")}</strong>
        <span>${escapeHtml(subtitle)}</span>
      </div>
    </div>
  `;
}

function recentPlayHtml(play = {}) {
  const imageUrl = safeHttpUrl(play.imageUrl);
  const art = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : "<span class=\"rowIndex\">></span>";
  return `
    <div class="reportRow">
      ${art}
      <div>
        <strong>${escapeHtml(play.title || "Unknown track")}</strong>
        <span>${escapeHtml([play.artist, formatDateTime(play.playedAt), play.zoneName].filter(Boolean).join(" - "))}</span>
      </div>
    </div>
  `;
}

function signalGroupHtml(title, entries = [], emptyText = "No signal yet") {
  return `
    <div class="signalGroup">
      <strong>${escapeHtml(title)}</strong>
      ${entries.length ? entries.map((entry) => `
        <div class="signalItem">
          <span>${escapeHtml(entry.name)} <em>${Number(entry.rawScore ?? entry.score) > 0 && !String(entry.score).startsWith("+") ? "+" : ""}${escapeHtml(entry.score)}</em></span>
          ${entry.note ? `<small>${escapeHtml(entry.note)}</small>` : ""}
        </div>
      `).join("") : `<p class="muted">${escapeHtml(emptyText)}</p>`}
    </div>
  `;
}

function renderHistoryReport(report = {}) {
  state.historyReport = report;
  state.historyNeedsRefresh = false;
  const metrics = report.metrics || {};
  const ignoredRadio = Number(metrics.ignoredRadioPlays || 0);
  $("#tasteNarrative").textContent = report.tasteNarrative || "No taste report yet.";
  $("#historyMetrics").innerHTML = [
    metricCardHtml("Observed plays", metrics.observedPlays || 0, ignoredRadio ? `${ignoredRadio} radio placeholders ignored` : "Recorded while this app is running"),
    metricCardHtml("Listening time", formatHours(metrics.knownDurationSeconds), "Known track durations"),
    metricCardHtml("Active days", metrics.activeDays || 0),
    metricCardHtml("Feedback", metrics.feedbackCount || 0, "Love, Good, OK, Wrong Genre, Skip, Never Again signals"),
    metricCardHtml("Discovery pool", metrics.discoveryCount || 0, "Previously suggested tracks")
  ].join("");

  $("#topArtists").innerHTML = report.topArtists?.length
    ? report.topArtists.map((artist, index) => reportRowHtml(artist, index, "artist")).join("")
    : "<p class=\"muted\">No artist history yet. Start playback in Roon and leave this page open.</p>";

  $("#topTracks").innerHTML = report.topTracks?.length
    ? report.topTracks.map((track, index) => reportRowHtml(track, index, "track")).join("")
    : "<p class=\"muted\">No track history yet.</p>";

  const dna = report.tasteDna || {};
  const confidence = dna.confidence || {};
  $("#tasteSignals").innerHTML = [
    signalGroupHtml("Taste DNA", [
      { name: "Depth", score: `${confidence.depthScore || 0}/100`, rawScore: confidence.depthScore || 0, note: confidence.depthLabel || "Early" },
      { name: "Scored memories", score: confidence.detailedMemoryCount || 0, rawScore: confidence.detailedMemoryCount || 0, note: `${confidence.feedbackCount || 0} total ratings` },
      { name: "Radio feedback", score: confidence.radioFeedbackCount || 0, rawScore: confidence.radioFeedbackCount || 0, note: "Live/radio tracks counted into taste" }
    ], "No explicit taste depth yet"),
    signalGroupHtml("Favored traits", dna.traits || [], "No trait-level signal yet"),
    signalGroupHtml("Genre lane", dna.genres || [], "No genre-level signal yet"),
    signalGroupHtml("Listening shape", dna.formats || [], "No duration/version signal yet"),
    signalGroupHtml("Discovery sources", dna.sources || [], "No source pattern yet"),
    signalGroupHtml("Avoid / calibrate", dna.avoid || [], "No avoid signal yet"),
    signalGroupHtml("Liked artists", report.likedArtists || []),
    signalGroupHtml("Liked labels", report.likedLabels || []),
    signalGroupHtml("Rejected artists", report.rejectedArtists || [], "No rejected artist signal yet"),
    signalGroupHtml("Rejected labels", report.rejectedLabels || [], "No rejected label signal yet")
  ].join("");

  $("#recentPlays").innerHTML = report.recentPlays?.length
    ? report.recentPlays.slice(0, 12).map(recentPlayHtml).join("")
    : "<p class=\"muted\">Recent plays will fill in as Roon changes tracks.</p>";
}

async function refreshHistoryReport() {
  $("#tasteNarrative").textContent = "Refreshing listening report...";
  renderHistoryReport(await getJson("/api/history-report"));
}

function updateJumpTopVisibility() {
  const button = $("#jumpTop");
  const player = document.querySelector(".player");
  const playerViewActive = $("#playerView")?.classList.contains("isActive");
  if (!button || !player || !playerViewActive || state.playerMaximized) {
    if (button) button.hidden = true;
    return;
  }

  const rect = player.getBoundingClientRect();
  const visible = rect.bottom > 96 && rect.top < window.innerHeight - 96;
  button.hidden = visible;
}

function applyPlayerMaximized() {
  const player = document.querySelector(".player");
  const button = $("#togglePlayerMax");
  if (!player || !button) return;
  player.classList.toggle("isMaximized", state.playerMaximized);
  document.body.classList.toggle("playerMaximized", state.playerMaximized);
  button.textContent = state.playerMaximized ? "Minimize Player" : "Maximize Player";
  button.setAttribute("aria-pressed", String(state.playerMaximized));
  updateJumpTopVisibility();
}

function playerFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function drawScreenWakeFallbackFrame() {
  const canvas = screenWakeFallback.canvas;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  screenWakeFallback.flip = !screenWakeFallback.flip;
  context.fillStyle = screenWakeFallback.flip ? "#12031f" : "#160526";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = screenWakeFallback.flip ? "#c780ff" : "#65f4ff";
  context.fillRect(0, 0, 1, 1);
}

function stopScreenWakeFallback() {
  if (screenWakeFallback.timer) {
    clearInterval(screenWakeFallback.timer);
    screenWakeFallback.timer = null;
  }
  if (screenWakeFallback.video) {
    try {
      screenWakeFallback.video.pause();
    } catch {
      // Best effort cleanup; playback state is browser-owned.
    }
    screenWakeFallback.video.srcObject = null;
    screenWakeFallback.video.remove();
    screenWakeFallback.video = null;
  }
  if (screenWakeFallback.stream) {
    screenWakeFallback.stream.getTracks().forEach((track) => track.stop());
    screenWakeFallback.stream = null;
  }
  screenWakeFallback.canvas = null;
}

async function startScreenWakeFallback() {
  if (screenWakeFallback.video && !screenWakeFallback.video.paused) return true;
  if (!HTMLCanvasElement.prototype.captureStream) return false;

  stopScreenWakeFallback();
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  screenWakeFallback.canvas = canvas;
  drawScreenWakeFallbackFrame();

  const stream = canvas.captureStream(1);
  const video = document.createElement("video");
  video.className = "screenWakeVideo";
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.srcObject = stream;
  document.body.append(video);

  screenWakeFallback.stream = stream;
  screenWakeFallback.video = video;
  screenWakeFallback.timer = setInterval(drawScreenWakeFallbackFrame, 30_000);

  try {
    await video.play();
    return true;
  } catch {
    stopScreenWakeFallback();
    return false;
  }
}

async function acquireScreenWakeLock() {
  screenWakeLockDesired = true;
  if (document.visibilityState && document.visibilityState !== "visible") return false;
  if (screenWakeLock) return true;
  if (screenWakeLockPending) return screenWakeLockPending;

  screenWakeLockPending = (async () => {
    try {
      if (navigator.wakeLock?.request) {
        const lock = await navigator.wakeLock.request("screen");
        screenWakeLock = lock;
        stopScreenWakeFallback();
        lock.addEventListener("release", () => {
          if (screenWakeLock === lock) screenWakeLock = null;
          if (screenWakeLockDesired && document.visibilityState === "visible") {
            setTimeout(() => {
              acquireScreenWakeLock().catch(() => {});
            }, 500);
          }
        });
        return true;
      }
    } catch {
      screenWakeLock = null;
    }

    return startScreenWakeFallback();
  })();

  try {
    return await screenWakeLockPending;
  } finally {
    screenWakeLockPending = null;
  }
}

async function releaseScreenWakeLock() {
  screenWakeLockDesired = false;
  stopScreenWakeFallback();
  const lock = screenWakeLock;
  screenWakeLock = null;
  if (lock) {
    try {
      await lock.release();
    } catch {
      // Already released by the browser.
    }
  }
}

function syncScreenWakeLock() {
  const player = document.querySelector(".player");
  const full = player && playerFullscreenElement() === player;
  if (full) {
    acquireScreenWakeLock().catch(() => {});
  } else {
    releaseScreenWakeLock().catch(() => {});
  }
}

function pcMonitorTempText(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? `${Math.round(number)}C` : "--";
}

function setPcTempChipState(chip, value) {
  if (!chip) return;
  const number = Number(value);
  const available = value !== null && value !== undefined && Number.isFinite(number);
  chip.classList.toggle("isUnavailable", !available);
  chip.classList.toggle("isHot", available && number >= 80);
  chip.classList.toggle("isCritical", available && number >= 90);
}

function renderPcMonitorOverlay(snapshot = state.pcMonitor, error = state.pcMonitorError) {
  const overlay = $("#pcTempOverlay");
  const cpuText = $("#pcTempCpu");
  const gpuText = $("#pcTempGpu");
  const player = document.querySelector(".player");
  if (!overlay || !cpuText || !gpuText || !player) return;

  const full = playerFullscreenElement() === player;
  const statusStack = document.querySelector(".statusStack");
  const statusHome = document.querySelector(".topChrome");
  const statusDock = $("#fullscreenConnectionStatus");
  if (statusStack && statusHome && statusDock) {
    const destination = full ? statusDock : statusHome;
    if (statusStack.parentElement !== destination) destination.appendChild(statusStack);
  }
  overlay.hidden = !full;
  if (!full) return;

  const cpuTemp = snapshot?.cpu?.temperatureC;
  const gpuTemp = snapshot?.gpu?.temperatureC;
  cpuText.textContent = pcMonitorTempText(cpuTemp);
  gpuText.textContent = pcMonitorTempText(gpuTemp);
  setPcTempChipState(overlay.querySelector(".pcTempChipCpu"), cpuTemp);
  setPcTempChipState(overlay.querySelector(".pcTempChipGpu"), gpuTemp);
  overlay.classList.toggle("isOffline", Boolean(error) && !snapshot?.connected);
  overlay.title = error
    ? `PC monitor unavailable: ${error}`
    : `PC monitor: CPU ${pcMonitorTempText(cpuTemp)}, GPU ${pcMonitorTempText(gpuTemp)}`;
}

async function refreshPcMonitorOverlay() {
  const player = document.querySelector(".player");
  if (!player || playerFullscreenElement() !== player || state.pcMonitorLoading) return;
  state.pcMonitorLoading = true;
  try {
    const snapshot = await getJson("/api/pc-monitor");
    state.pcMonitor = snapshot;
    state.pcMonitorError = snapshot.error || "";
  } catch (error) {
    state.pcMonitorError = error.message || "PC monitor unavailable";
  } finally {
    state.pcMonitorLoading = false;
    renderPcMonitorOverlay();
  }
}

function syncPcMonitorOverlay(full) {
  if (full) {
    renderPcMonitorOverlay();
    refreshPcMonitorOverlay().catch(() => {});
    if (!pcMonitorTimer) {
      pcMonitorTimer = setInterval(() => {
        refreshPcMonitorOverlay().catch(() => {});
      }, PC_MONITOR_POLL_MS);
    }
    return;
  }

  if (pcMonitorTimer) {
    clearInterval(pcMonitorTimer);
    pcMonitorTimer = null;
  }
  renderPcMonitorOverlay(null, "");
}

function applyPlayerFullscreenState() {
  const player = document.querySelector(".player");
  const button = $("#togglePlayerFull");
  if (!player || !button) return;
  const full = playerFullscreenElement() === player;
  player.classList.toggle("isFullWindow", full);
  document.body.classList.toggle("playerFullWindow", full);
  button.textContent = full ? "Exit Full Window" : "Full Window";
  button.setAttribute("aria-pressed", String(full));
  renderNowTidalPlaylistControl();
  syncScreenWakeLock();
  syncPcMonitorOverlay(full);
}

function setPlayerMaximized(value) {
  state.playerMaximized = Boolean(value);
  localStorage.setItem("playerMaximized", state.playerMaximized ? "1" : "0");
  applyPlayerMaximized();
}

async function setPlayerFullWindow(value) {
  const player = document.querySelector(".player");
  if (!player) return;
  const full = playerFullscreenElement() === player;
  if (value && !full) {
    setPlayerMaximized(true);
    const request = player.requestFullscreen || player.webkitRequestFullscreen;
    if (!request) return alert("This browser does not allow full-window mode from a web page. Use Add to Home Screen or browser fullscreen if available.");
    try {
      await request.call(player, { navigationUI: "hide" });
    } catch {
      await request.call(player);
    }
    applyPlayerFullscreenState();
    return;
  }
  if (!value && full) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) await exit.call(document);
  }
  applyPlayerFullscreenState();
}

function setActiveView(view) {
  const target = ["history", "musicMemory", "beatportCharts", "radio", "playlists", "tidal"].includes(view) ? view : "player";
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === target);
  });
  $("#playerView").classList.toggle("isActive", target === "player");
  $("#historyView").classList.toggle("isActive", target === "history");
  $("#musicMemoryView")?.classList.toggle("isActive", target === "musicMemory");
  $("#beatportChartsView")?.classList.toggle("isActive", target === "beatportCharts");
  $("#radioView")?.classList.toggle("isActive", target === "radio");
  $("#playlistView")?.classList.toggle("isActive", target === "playlists");
  $("#tidalView")?.classList.toggle("isActive", target === "tidal");
  if (target === "history" && state.historyNeedsRefresh) {
    refreshHistoryReport().catch((error) => {
      $("#tasteNarrative").textContent = error.message;
    });
  }
  if (target === "radio" && !state.radioStationsLoaded && !state.radioStationsLoading) {
    refreshRadioStations().catch((error) => {
      $("#radioStatus").textContent = error.message;
    });
  }
  if (target === "musicMemory" && state.musicMemoryNeedsRefresh && !state.musicMemoryLoading) {
    refreshMusicMemory().catch((error) => {
      $("#musicMemoryStatus").textContent = error.message;
    });
  }
  if (target === "beatportCharts" && state.beatportChartNeedsRefresh && !state.beatportChartLoading) {
    refreshBeatportChart().catch((error) => {
      $("#beatportChartStatus").textContent = error.message;
    });
  }
  if (target === "playlists" && (!state.roonPlaylistsLoaded || !state.tidalPlaylistsLoaded) && !state.roonPlaylistsLoading && !state.tidalPlaylistsLoading) {
    refreshPlaylistBrowser().catch((error) => {
      $("#playlistBrowserStatus").textContent = error.message;
    });
  } else if (target === "playlists") {
    renderPlaylistBrowser();
  }
  if (target === "tidal" && state.tidalMixesNeedsRefresh) {
    refreshTidalMixes().catch((error) => {
      $("#tidalMixStatus").textContent = error.message;
    });
  }
  updateJumpTopVisibility();
}

$("#zoneSelect").addEventListener("change", (event) => {
  state.selectedZoneId = event.target.value;
  localStorage.setItem("zoneId", state.selectedZoneId);
  state.radioStationsLoaded = false;
  state.radioStationsSession = "";
  state.radioBrowseHierarchy = "";
  state.radioBrowseTitle = "";
  state.radioBrowseItemKey = "";
  renderState({ connected: true, core: { name: $("#connection").textContent.replace("Connected to ", "") }, zones: state.zones });
});

$("#openRabbitHole").addEventListener("click", () => {
  const panel = $("#rabbitHolePanel");
  const track = state.nowTrack;
  if (!panel || !track) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) loadRabbitHole(track).catch(() => {});
});

$("#rabbitHolePanel").addEventListener("click", (event) => {
  const more = event.target.closest("[data-rabbit-more]");
  if (more) {
    const section = more.closest(".rabbitDepth");
    const expanded = section?.classList.toggle("expanded");
    more.textContent = expanded ? "Show fewer" : `Show ${more.dataset.rabbitMore} more`;
    return;
  }

  const refresh = event.target.closest("[data-rabbit-refresh]");
  if (refresh && state.nowTrack) {
    loadRabbitHole(state.nowTrack, { force: true }).catch(() => {});
    return;
  }

  const run = event.target.closest("[data-rabbit-run]");
  if (run) {
    runRabbitPrompt(run.dataset.rabbitRun);
    return;
  }

  const prompt = event.target.closest("[data-rabbit-prompt]");
  if (prompt) {
    setRabbitPrompt(prompt.dataset.rabbitPrompt);
    return;
  }

  const nodeButton = event.target.closest("[data-rabbit-node]");
  if (!nodeButton) return;
  let node = {};
  try {
    node = JSON.parse(nodeButton.dataset.rabbitNode || "{}");
  } catch {
    node = {};
  }
  if (node.type === "track" && node.track && jumpToTrackIdentity(node.track)) return;
  setRabbitPrompt(node.prompt || rabbitHoleTextFor({ artist: node.name, title: "" }));
});

$("#bridgeSyncDismiss")?.addEventListener("click", hideBridgeSyncPopup);
$("#bridgeSyncConfirm")?.addEventListener("click", () => {
  confirmBridgeSyncRefresh().catch((error) => alert(error.message));
});

$("#nowTidalPlaylistSelect")?.addEventListener("focus", () => {
  loadTidalPlaylists({
    force: Boolean(state.tidalPlaylistsError || (state.tidalPlaylistsLoaded && !state.tidalPlaylists.length))
  }).catch(() => {});
});

$("#nowTidalPlaylistSelect")?.addEventListener("change", (event) => {
  state.selectedTidalPlaylistId = event.target.value || "";
  if (state.selectedTidalPlaylistId) localStorage.setItem("tidalPlaylistId", state.selectedTidalPlaylistId);
  renderNowTidalPlaylistControl();
});

for (const [index, id] of ["#nowTidalPlaylistArm1", "#nowTidalPlaylistArm2", "#nowTidalPlaylistArm3"].entries()) {
  $(id)?.addEventListener("change", event => {
    state.nowTidalPlaylistArmed[index] = Boolean(event.target.checked);
    localStorage.setItem(`tidalPlaylistArmed${index + 1}`, state.nowTidalPlaylistArmed[index] ? "true" : "false");
    renderNowTidalPlaylistControl();
  });
}

for (const [index, id] of ["#nowTidalPlaylistSelect2", "#nowTidalPlaylistSelect3"].entries()) {
  $(id)?.addEventListener("focus", () => loadTidalPlaylists({ force: Boolean(state.tidalPlaylistsError) }).catch(() => {}));
  $(id)?.addEventListener("change", event => {
    state.extraTidalPlaylistIds[index] = event.target.value || "";
    localStorage.setItem(`tidalPlaylistId${index + 2}`, state.extraTidalPlaylistIds[index]);
    renderNowTidalPlaylistControl();
  });
}

$("#addNowToTidalPlaylist")?.addEventListener("click", () => {
  addNowTrackToTidalPlaylist().catch((error) => alert(error.message));
});

$("#createNowTidalPlaylist")?.addEventListener("click", () => {
  createNowTidalPlaylist().catch((error) => alert(error.message));
});

$("#nowTidalPlaylistName")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  createNowTidalPlaylist().catch((error) => alert(error.message));
});

$("#jumpTop").addEventListener("click", () => {
  document.querySelector(".player")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#togglePlayerMax").addEventListener("click", () => {
  setPlayerMaximized(!state.playerMaximized);
});

$("#togglePlayerFull").addEventListener("click", () => {
  const player = document.querySelector(".player");
  setPlayerFullWindow(playerFullscreenElement() !== player).catch((error) => alert(error.message));
});

document.addEventListener("fullscreenchange", applyPlayerFullscreenState);
document.addEventListener("webkitfullscreenchange", applyPlayerFullscreenState);
document.addEventListener("fullscreenchange", () => scheduleRabbitRecoveryRefresh(250));
document.addEventListener("webkitfullscreenchange", () => scheduleRabbitRecoveryRefresh(250));
document.addEventListener("visibilitychange", () => {
  syncScreenWakeLock();
  if (!document.hidden) scheduleRabbitRecoveryRefresh(250);
});
window.addEventListener("pageshow", () => {
  syncScreenWakeLock();
  scheduleRabbitRecoveryRefresh(250);
});
window.addEventListener("focus", () => scheduleRabbitRecoveryRefresh(250));
window.addEventListener("pagehide", () => {
  releaseScreenWakeLock().catch(() => {});
});

$("#nowFeedback").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-now-feedback]");
  if (!button) return;
  const track = state.nowTrack;
  if (!track) return;
  if (button.dataset.saving === "true") return;

  const rating = normalizeFeedbackValue(button.dataset.nowFeedback);
  button.dataset.saving = "true";
  button.classList.add("isSaving");
  track.feedback = rating;
  setFeedbackButtonsActive($("#nowFeedback"), rating);
  try {
    const result = await api("/api/feedback", { track, rating });
    applyFeedbackResponse(result);
    rememberFeedbackForTrack(track, rating);
    if (state.nowMatchIndex >= 0 && state.lastResult?.tracks?.[state.nowMatchIndex]) {
      state.lastResult.tracks[state.nowMatchIndex].feedback = rating;
    }
    if (state.lastResult) renderResults(state.lastResult);
    else updateNowDiscoveryTools(activeZone());
  } catch (error) {
    alert(error.message);
  } finally {
    button.dataset.saving = "false";
    button.classList.remove("isSaving");
  }
});

window.addEventListener("scroll", updateJumpTopVisibility, { passive: true });
window.addEventListener("resize", updateJumpTopVisibility);

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setActiveView(button.dataset.view));
});

document.querySelectorAll("[data-scoring-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    setScoringMode(button.dataset.scoringMode || "");
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveScoringModeSelection(button, 1);
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveScoringModeSelection(button, -1);
    }
  });
});
setScoringMode($("#scoringMode")?.value || "");

$("#refreshHistory").addEventListener("click", () => {
  refreshHistoryReport().catch((error) => {
    $("#tasteNarrative").textContent = error.message;
  });
});

$("#musicMemorySearchForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  refreshMusicMemory().catch((error) => {
    $("#musicMemoryStatus").textContent = error.message;
  });
});

$("#musicMemoryBeatportFilter")?.addEventListener("change", () => {
  refreshMusicMemory().catch((error) => {
    $("#musicMemoryStatus").textContent = error.message;
  });
});

$("#musicMemoryFeedbackFilter")?.addEventListener("change", () => {
  refreshMusicMemory().catch((error) => {
    $("#musicMemoryStatus").textContent = error.message;
  });
});

$("#musicMemoryResults")?.addEventListener("click", (event) => {
  const more = event.target.closest("#musicMemoryLoadMore");
  if (!more) return;
  refreshMusicMemory({ append: true }).catch((error) => {
    $("#musicMemoryStatus").textContent = error.message;
  });
});

$("#beatportChartForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  refreshBeatportChart().catch((error) => {
    $("#beatportChartStatus").textContent = error.message;
  });
});

$("#beatportChartQueue")?.addEventListener("click", () => {
  const tracks = (state.beatportChartTracks || []).map(beatportChartTrackPayload);
  queueTrackList(tracks, $("#beatportChartQueue"), {
    source: "beatport_chart",
    buttonText: "Queue chart",
    mode: "append",
    targetCount: tracks.length,
    preferExtendedMixes: false,
    matchPolicy: "strict",
    allowBridge: true
  });
});

$("#beatportChartQueueNext")?.addEventListener("click", () => {
  const tracks = (state.beatportChartTracks || []).map(beatportChartTrackPayload);
  queueTrackList(tracks, $("#beatportChartQueueNext"), {
    source: "beatport_chart",
    buttonText: "Queue next",
    mode: "next",
    targetCount: tracks.length,
    preferExtendedMixes: false,
    matchPolicy: "strict",
    allowBridge: true
  });
});

$("#refreshRadioStations")?.addEventListener("click", () => {
  refreshRadioStations({ force: true }).catch((error) => {
    $("#radioStatus").textContent = error.message;
  });
});

$("#radioRoot")?.addEventListener("click", () => {
  state.radioBrowseItemKey = "";
  state.radioBrowseHierarchy = "";
  state.radioStationsSession = "";
  refreshRadioStations({ force: true, itemKey: "" }).catch((error) => {
    $("#radioStatus").textContent = error.message;
  });
});

$("#resetRadioOrder")?.addEventListener("click", () => {
  clearRadioStationOrder();
  refreshRadioStations({ force: true }).catch((error) => {
    $("#radioStatus").textContent = error.message;
  });
});

$("#radioStations")?.addEventListener("pointerdown", startRadioStationDrag);
window.addEventListener("pointermove", handleRadioStationDragMove, { passive: false });
window.addEventListener("pointerup", handleRadioStationDragEnd);
window.addEventListener("pointercancel", cleanupRadioDrag);

$("#radioStations")?.addEventListener("click", (event) => {
  if (suppressNextRadioClick) {
    event.preventDefault();
    suppressNextRadioClick = false;
    return;
  }

  const moveButton = event.target.closest("[data-radio-drag]");
  if (moveButton) {
    selectRadioStationForMove(Number(moveButton.dataset.radioDrag));
    return;
  }

  if (handleRadioStationMoveTarget(event)) return;

  const openButton = event.target.closest("[data-radio-open]");
  if (openButton) {
    const station = state.radioStations[Number(openButton.dataset.radioOpen)];
    if (!station) return;
    openRadioFolder(station).catch((error) => alert(error.message));
    return;
  }

  const button = event.target.closest("[data-radio-play]");
  if (!button) return;
  const station = state.radioStations[Number(button.dataset.radioPlay)];
  if (!station) return;
  playRadioStation(station, button).catch((error) => alert(error.message));
});

$("#refreshPlaylistBrowser")?.addEventListener("click", () => {
  refreshPlaylistBrowser({ force: true }).catch((error) => {
    const status = $("#playlistBrowserStatus");
    if (status) status.textContent = error.message;
  });
});

$("#playlistBrowserGrid")?.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-playlist-source][data-playlist-index][data-playlist-delete]");
  if (deleteButton) {
    deleteBrowserPlaylist(
      deleteButton.dataset.playlistSource,
      Number(deleteButton.dataset.playlistIndex || 0),
      deleteButton
    ).catch((error) => alert(error.message));
    return;
  }

  const button = event.target.closest("[data-playlist-source][data-playlist-index][data-playlist-mode]");
  if (!button) return;
  playBrowserPlaylist(
    button.dataset.playlistSource,
    Number(button.dataset.playlistIndex || 0),
    button.dataset.playlistMode || "replace",
    button
  ).catch((error) => alert(error.message));
});

$("#refreshTidalMixes")?.addEventListener("click", () => {
  refreshTidalMixes({ force: true }).catch((error) => {
    $("#tidalMixStatus").textContent = error.message;
  });
});

$("#tidalPinnedForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#tidalPinnedInput");
  const value = input?.value?.trim() || "";
  const button = event.submitter || event.currentTarget.querySelector("button[type='submit']");
  importPinnedTidalMix(value, button).then(() => {
    if (input) input.value = "";
  }).catch((error) => {
    $("#tidalPinnedStatus").textContent = error.message;
  });
});

$("#tidalMixesGrid")?.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-tidal-pinned-remove]");
  if (removeButton) {
    removePinnedTidalMix(removeButton.dataset.tidalPinnedRemove, removeButton).catch((error) => alert(error.message));
    return;
  }

  const actionButton = event.target.closest("[data-tidal-mix-play], [data-tidal-mix-next], [data-tidal-mix-queue]");
  if (actionButton) {
    const index = Number(actionButton.dataset.tidalMixPlay ?? actionButton.dataset.tidalMixNext ?? actionButton.dataset.tidalMixQueue);
    const mix = state.tidalVisibleMixes?.[index];
    if (!mix) return;
    const mode = actionButton.dataset.tidalMixPlay !== undefined
      ? "replace"
      : (actionButton.dataset.tidalMixNext !== undefined ? "next" : "append");
    queueTidalMix(mix, actionButton, { mode }).catch((error) => alert(error.message));
    return;
  }

  const button = event.target.closest("[data-tidal-mix-prompt]");
  if (!button) return;
  const request = $("#request");
  request.value = button.dataset.tidalMixPrompt || "";
  setScoringMode("");
  setActiveView("player");
  request.focus();
});

$("#tastePrompt").addEventListener("click", () => {
  const request = $("#request");
  const genres = document.querySelector("[name='genres']");
  const mood = document.querySelector("[name='mood']");
  const count = document.querySelector("[name='count']");
  request.value = "find tracks that match my current taste profile, but go deeper, less obvious, and avoid repeats";
  genres.value = "";
  mood.value = "";
  count.value = "";
  setScoringMode("");
  setActiveView("player");
  request.focus();
});

$("#seekSlider").addEventListener("pointerdown", () => {
  state.isSeeking = true;
});

$("#seekSlider").addEventListener("input", (event) => {
  state.isSeeking = true;
  $("#seekPosition").textContent = formatSeconds(event.target.value) || "0:00";
});

$("#seekSlider").addEventListener("change", async (event) => {
  const zone = activeZone();
  if (!zone) return;
  try {
    await api("/api/seek", { zoneId: zone.zone_id, seconds: Number(event.target.value) });
  } catch (error) {
    alert(error.message);
  } finally {
    state.isSeeking = false;
  }
});

$("#seekSlider").addEventListener("blur", () => {
  state.isSeeking = false;
});

document.addEventListener("click", async (event) => {
  const control = event.target.dataset.control;
  const volume = event.target.dataset.volume;
  const zone = activeZone();

  try {
    if (control && zone) await api("/api/control", { zoneId: zone.zone_id, control });
    if (volume) await api("/api/volume", { outputId: event.target.dataset.output, how: "relative_step", value: Number(volume) });
  } catch (error) {
    alert(error.message);
  }
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const zone = activeZone();
    const now = summarizeNowPlaying(zone);
    const request = $("#request");
    const genres = document.querySelector("[name='genres']");
    const mood = document.querySelector("[name='mood']");
    const count = document.querySelector("[name='count']");
    const releasePreset = $("#releasePreset");

    if (button.dataset.preset === "now" && now?.title) {
      request.value = `find tracks like ${now.artist} - ${now.title}, but deeper and less obvious`;
      mood.value = "";
      setScoringMode("");
    }

    if (button.dataset.preset === "artist") {
      const artist = now?.artist || "";
      request.value = artist
        ? `find tracks like ${artist}, but deeper and less obvious`
        : "find music from an artist or scene I can explore";
      mood.value = "";
      setScoringMode("");
    }

    if (button.dataset.preset === "long") {
      request.value = "find long, detailed electronic tracks released this week";
      genres.value = "";
      mood.value = "";
      count.value = "";
      if (releasePreset) releasePreset.value = "";
      setScoringMode("");
    }
  });
});

$("#releasePreset")?.addEventListener("change", (event) => {
  if (!event.target.value) return;
  for (const name of ["releaseExactDate", "releaseStartDate", "releaseEndDate"]) {
    const input = document.querySelector(`[name='${name}']`);
    if (input) input.value = "";
  }
});

for (const name of ["releaseExactDate", "releaseStartDate", "releaseEndDate"]) {
  document.querySelector(`[name='${name}']`)?.addEventListener("input", (event) => {
    if (!event.target.value) return;
    const quick = $("#releasePreset");
    if (quick) quick.value = "";
    if (name === "releaseExactDate") {
      for (const rangeName of ["releaseStartDate", "releaseEndDate"]) {
        const input = document.querySelector(`[name='${rangeName}']`);
        if (input) input.value = "";
      }
    } else {
      const exact = document.querySelector("[name='releaseExactDate']");
      if (exact) exact.value = "";
    }
  });
}

$("#refreshPlaylists").addEventListener("click", refreshPlaylists);

$("#refreshTidalSeedPlaylists")?.addEventListener("click", () => {
  loadTidalPlaylists({ force: true }).catch((error) => {
    const status = $("#tidalPlaylistSeedStatus");
    if (status) status.textContent = error.message;
  });
});

$("#tidalPlaylistSeedSelect")?.addEventListener("focus", () => {
  loadTidalPlaylists({
    force: Boolean(state.tidalPlaylistsError || (state.tidalPlaylistsLoaded && !state.tidalPlaylists.length))
  }).catch(() => {});
});

$("#tidalPlaylistSeedSelect")?.addEventListener("change", (event) => {
  state.selectedTidalSeedPlaylistId = event.target.value || "";
  if (state.selectedTidalSeedPlaylistId) localStorage.setItem("tidalSeedPlaylistId", state.selectedTidalSeedPlaylistId);
  const button = $("#useTidalPlaylistSeed");
  if (button) button.disabled = !state.selectedTidalSeedPlaylistId;
});

$("#useTidalPlaylistSeed")?.addEventListener("click", () => {
  useTidalPlaylistSeed().catch((error) => {
    const status = $("#tidalPlaylistSeedStatus");
    if (status) status.textContent = error.message;
  });
});

$("#usePlaylistSeed").addEventListener("click", async () => {
  const itemKey = $("#playlistSelect").value;
  if (!itemKey) return;
  const selectedPlaylist = state.playlists.find((playlist) => playlist.id === itemKey);

  $("#playlistStatus").textContent = "Loading playlist tracks...";
  try {
    const playlist = await api("/api/roon/playlist-tracks", { itemKey, title: selectedPlaylist?.title || "" });
    state.playlistSeedTracks = playlist.tracks || [];
    $("#reference").value = seedLinesFromTracks(state.playlistSeedTracks);
    if (!$("#request").value.trim()) {
      $("#request").value = `find similar discoveries to ${playlist.title}`;
    }
    $("#playlistStatus").textContent = `${playlist.title}: ${state.playlistSeedTracks.length} seed tracks loaded`;
  } catch (error) {
    $("#playlistStatus").textContent = error.message;
  }
});

$("#playlistForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = event.submitter || event.target.querySelector("button[type='submit']");
  const form = new FormData(event.target);
  const body = Object.fromEntries(form.entries());
  for (const field of [
    "reference",
    "genres",
    "years",
    "mood",
    "language",
    "count",
    "scoringMode",
    "minScore",
    "releasePreset",
    "releaseExactDate",
    "releaseStartDate",
    "releaseEndDate"
  ]) {
    if (body[field] !== undefined && !String(body[field] || "").trim()) delete body[field];
  }
  const zone = activeZone();
  body.zoneId = zone?.zone_id || "";
  body.nowPlaying = summarizeNowPlaying(zone);
  body.requireRoonQueueable = "";
  const generateStartedAt = Date.now();
  if (submitButton) submitButton.disabled = true;
  $("#busy").textContent = "Searching TIDAL + discovery sources...";
  $("#resultTitle").textContent = "Building rabbit hole...";
  $("#tracks").innerHTML = "";
  state.resultArtistConfirmedOnly = false;
  const artistConfirmedToggle = $("#artistConfirmedOnly");
  if (artistConfirmedToggle) artistConfirmedToggle.checked = false;
  state.lastTracks = [];
  state.displayedTracks = [];
  state.lastResult = null;
  state.rejectedDebugOpen = false;
  $("#queueAll").disabled = true;
  $("#queueAllNext").disabled = true;
  $("#sendTidalQueue").disabled = true;
  $("#copyList").disabled = true;
  $("#exportCsv").disabled = true;
  updateRejectedDebug();
  showIntentDebug(null);
  showPoolDiagnostics(null);
  showSourceReport(null);
  $("#rejectedDebug").hidden = true;
  $("#rejectedDebug").innerHTML = "";
  $("#tracks").innerHTML = `
    <div class="emptyState isWorking">
      <strong>Building a TIDAL-first discovery pool.</strong>
      <p>Rabbit Hole is scoring fresh candidates first; Send to TIDAL can bridge the final list into playback.</p>
    </div>
  `;

  try {
    const result = await api("/api/ai/playlist", body);
    renderResults(result);
  } catch (error) {
    if (isFetchDrop(error)) {
      $("#resultTitle").textContent = "Connection dropped";
      $("#tracks").innerHTML = `
        <div class="emptyState isWorking">
          <strong>Checking whether the search finished...</strong>
          <p>The phone lost the request to Rabbit Hole. If the server completed the run, this will recover the saved result automatically.</p>
        </div>
      `;
      if (await recoverGeneratedSession(generateStartedAt)) return;
    }
    $("#resultTitle").textContent = "Generation failed";
    $("#tracks").innerHTML = emptyResultHtml(error.message, {});
    showPoolDiagnostics(null);
    showSourceReport(null);
    state.rejectedDebugOpen = false;
    updateRejectedDebug();
  } finally {
    $("#busy").textContent = "";
    if (submitButton) submitButton.disabled = false;
  }
});

$("#standbyRefresh")?.addEventListener("click", async () => {
  const button = $("#standbyRefresh");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Refreshing...";
  $("#busy").textContent = "Refreshing standby discovery pool...";
  try {
    const result = await api("/api/standby/refresh", {
      reason: "manual",
      options: currentPlaylistFormBody()
    });
    renderStandbyPool(result);
    $("#busy").textContent = `${result.count || 0}/${result.targetCount || 25} standby tracks ready`;
  } catch (error) {
    alert(error.message);
    $("#busy").textContent = "";
  } finally {
    button.textContent = originalText;
    button.disabled = false;
  }
});

$("#standbyClear")?.addEventListener("click", async () => {
  const button = $("#standbyClear");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Clearing...";
  try {
    const result = await api("/api/standby/clear", {});
    renderStandbyPool(result);
  } catch (error) {
    alert(error.message);
  } finally {
    button.textContent = originalText;
    button.disabled = false;
  }
});

$("#standbyQueue")?.addEventListener("click", () => {
  const tracks = standbyPayloadTracks(state.standby?.targetCount || 25);
  queueTrackList(tracks, $("#standbyQueue"), {
    targetCount: tracks.length
  });
});

$("#standbyQueueNext")?.addEventListener("click", () => {
  const tracks = standbyPayloadTracks(state.standby?.targetCount || 25);
  queueTrackList(tracks, $("#standbyQueueNext"), {
    targetCount: tracks.length,
    mode: "next"
  });
});

$("#standbySendTidal")?.addEventListener("click", () => {
  const tracks = standbyPayloadTracks(state.standby?.targetCount || 25);
  sendTracksToTidalPlaylist(tracks, $("#standbySendTidal"), {
    title: `Rabbit Hole Standby - ${new Date().toLocaleString()}`,
    description: `Rabbit Hole standby pool with ${tracks.length} cached track${tracks.length === 1 ? "" : "s"}.`
  });
});

$("#standbyTracks")?.addEventListener("click", (event) => {
  const tidalLink = event.target.closest("[data-tidal-open]");
  if (!tidalLink) return;
  event.preventDefault();
  openTrackElementInTidal(tidalLink);
});

$("#copyList").addEventListener("click", async () => {
  await navigator.clipboard.writeText(plainList(state.displayedTracks.map(trackPayload)));
  $("#copyList").textContent = "Copied";
  setTimeout(() => {
    $("#copyList").textContent = "Copy list";
  }, 1200);
});

$("#exportCsv").addEventListener("click", () => {
  downloadCsv("roon-local-ai-discovery.csv", state.displayedTracks.map(trackPayload));
});

$("#toggleRejected").addEventListener("click", () => {
  state.rejectedDebugOpen = !state.rejectedDebugOpen;
  updateRejectedDebug();
});

$("#artistConfirmedOnly").addEventListener("change", (event) => {
  state.resultArtistConfirmedOnly = Boolean(event.target.checked);
  if (state.lastResult) renderResults(state.lastResult);
});

$("#queueAll").addEventListener("click", () => {
  const tracks = state.displayedTracks.map(trackPayload);
  queueTrackList(tracks, $("#queueAll"), {
    alternates: state.lastResult?.alternates || [],
    targetCount: tracks.length
  });
});

$("#queueAllNext").addEventListener("click", () => {
  const tracks = state.displayedTracks.map(trackPayload);
  queueTrackList(tracks, $("#queueAllNext"), {
    alternates: state.lastResult?.alternates || [],
    targetCount: tracks.length,
    mode: "next"
  });
});

$("#sendTidalQueue").addEventListener("click", () => {
  const tracks = state.displayedTracks.map(trackPayload);
  sendTracksToTidalPlaylist(tracks, $("#sendTidalQueue"), {
    title: `Rabbit Hole Queue - ${new Date().toLocaleString()}`,
    description: `Rabbit Hole generated queue with ${tracks.length} displayed track${tracks.length === 1 ? "" : "s"}.`
  });
});

$("#tracks").addEventListener("click", async (event) => {
  const tidalButton = event.target.closest("[data-tidal-open]");
  if (tidalButton) {
    openTrackElementInTidal(tidalButton);
    return;
  }

  const rejectSimilarButton = event.target.closest("[data-reject-similar]");
  if (rejectSimilarButton) {
    const index = Number(rejectSimilarButton.dataset.rejectSimilar);
    const track = state.displayedTracks[index];
    if (!track) return;
    const payload = trackPayload(track);

    const diagnostics = resultDiagnosticsFor(track);
    const reason = [
      diagnostics.risks.length ? `Risk: ${diagnostics.risks.join(", ")}` : "",
      diagnostics.kept.length ? `Kept because: ${diagnostics.kept.join(", ")}` : ""
    ].filter(Boolean).join(" | ");
    const originalText = rejectSimilarButton.textContent;
    rejectSimilarButton.disabled = true;
    rejectSimilarButton.textContent = "Saving...";
    try {
      const result = await api("/api/feedback", {
        track: payload,
        rating: "reject_similar",
        reason: reason || "Rejected similar weak discovery result."
      });
      applyFeedbackResponse(result);
      rememberFeedbackForTrack(payload, "reject_similar");
      updateResultTrackFeedback(payload, "reject_similar");
      renderResults(state.lastResult || { tracks: state.lastTracks });
    } catch (error) {
      rejectSimilarButton.textContent = originalText;
      rejectSimilarButton.disabled = false;
      alert(error.message);
    }
    return;
  }

  const feedbackButton = event.target.closest("[data-feedback]");
  if (feedbackButton) {
    const index = Number(feedbackButton.dataset.index);
    const track = state.displayedTracks[index];
    if (!track) return;
    const payload = trackPayload(track);

    const rating = normalizeFeedbackValue(feedbackButton.dataset.feedback);
    const originalText = feedbackButton.textContent;
    feedbackButton.disabled = true;
    feedbackButton.textContent = "Saving...";
    try {
      const result = await api("/api/feedback", { track: payload, rating });
      applyFeedbackResponse(result);
      rememberFeedbackForTrack(payload, rating);
      updateResultTrackFeedback(payload, rating);
      renderResults(state.lastResult || { tracks: state.lastTracks });
    } catch (error) {
      feedbackButton.textContent = originalText;
      alert(error.message);
    } finally {
      feedbackButton.disabled = false;
    }
    return;
  }

  if (event.target.dataset.queueNext) {
    await queueTrackList([parseTrackPayloadElement(event.target, "queueNext")], event.target, {
      targetCount: 1,
      mode: "next"
    });
    return;
  }

  if (!event.target.dataset.track) return;
  await playTrackInRoon(parseTrackPayloadElement(event.target, "track"), event.target);
});

function cleanAgentText(value) {
  return String(value || "").trim();
}

function agentBoolean(value) {
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function compactAgentTrack(track = {}) {
  return {
    artist: track.artist || "",
    title: track.title || "",
    album: track.album || "",
    label: track.label || track.tidal?.label || "",
    year: track.year || track.tidal?.year || null,
    releaseDate: track.releaseDate || track.tidal?.releaseDate || "",
    score: track.score || track.scoreBreakdown?.total || null,
    feedback: normalizeFeedbackValue(track.feedback || ""),
    discoverySource: track.discoverySource || "",
    discoveryLane: track.discoveryLane || "",
    tidalUrl: track.tidal?.tidalUrl || track.tidalUrl || "",
    roonVerified: Boolean(track.roon?.verified),
    reason: track.reason || ""
  };
}

function compactAgentResult(result = {}) {
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const verification = result.verification || {};
  return {
    requested: verification.requested || result.requestedCount || tracks.length,
    kept: tracks.length,
    discarded: discarded.length,
    strategy: verification.strategy || "",
    scoringMode: verification.scoringMode || "",
    intent: verification.intent || null,
    poolDiagnostics: verification.poolDiagnostics || null,
    queryYield: verification.queryYield || null,
    tracks: tracks.slice(0, 40).map(compactAgentTrack),
    rejectedExamples: discarded.slice(0, 12).map((track) => ({
      artist: track.artist || "",
      title: track.title || "",
      album: track.album || "",
      label: track.label || track.tidal?.label || "",
      year: track.year || track.tidal?.year || null,
      reason: track.reason || ""
    }))
  };
}

function compactAgentStatus(payload = null) {
  const app = payload?.app || state.appStatus || {};
  const zone = activeZone();
  const now = nowPlayingTrack(zone) || state.nowTrack || null;
  return {
    connected: Boolean(payload?.connected ?? state.connectionStatus.connected),
    coreName: payload?.core?.name || state.connectionStatus.coreName || "",
    selectedZone: zone ? {
      zoneId: zone.zone_id,
      name: zone.display_name,
      state: zone.state || "",
      queueItemsRemaining: zone.queue_items_remaining || 0,
      queueTimeRemaining: zone.queue_time_remaining || 0
    } : null,
    nowPlaying: now ? compactAgentTrack(now) : null,
    sourceQuality: state.nowQualityInfo || null,
    displayedTrackCount: state.displayedTracks.length,
    lastResult: state.lastResult ? compactAgentResult(state.lastResult) : null,
    standby: app.standby ? {
      count: app.standby.count || 0,
      targetCount: app.standby.targetCount || 25,
      ready: Boolean(app.standby.ready),
      refreshing: Boolean(app.standby.refreshing),
      lastRefreshAt: app.standby.lastRefreshAt || "",
      nextRefreshAt: app.standby.nextRefreshAt || "",
      lastError: app.standby.lastError || "",
      tracks: (app.standby.tracks || []).slice(0, 25).map(compactAgentTrack)
    } : null,
    tidalPlaylists: state.tidalPlaylists.map((playlist) => ({
      id: playlist.id || "",
      title: playlist.title || "",
      itemCount: playlist.itemCount || 0
    })),
    genreProfiles: app.genreProfiles || null,
    llm: app.llm || null,
    tidal: app.tidal || null,
    tidalProfileMixes: app.tidalProfileMixes || null
  };
}

function currentPlaylistFormBody(overrides = {}) {
  const form = $("#playlistForm");
  const body = form ? Object.fromEntries(new FormData(form).entries()) : {};
  for (const field of [
    "reference",
    "genres",
    "years",
    "mood",
    "language",
    "count",
    "scoringMode",
    "minScore",
    "releasePreset",
    "releaseExactDate",
    "releaseStartDate",
    "releaseEndDate"
  ]) {
    if (body[field] !== undefined && !cleanAgentText(body[field])) delete body[field];
  }

  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (key === "strictChildGenre") continue;
    if (key === "requireRoonQueueable" || key === "preferExtendedMixes") continue;
    body[key] = value;
  }

  const zone = activeZone();
  body.zoneId = cleanAgentText(overrides.zoneId) || zone?.zone_id || "";
  body.nowPlaying = summarizeNowPlaying(zone);
  body.requireRoonQueueable = agentBoolean(overrides.requireRoonQueueable) ? "true" : "";
  if (agentBoolean(overrides.preferExtendedMixes) && !/extended|club|long/i.test(String(body.request || ""))) {
    body.request = `${body.request || "Find music"}; prefer extended mixes when available`;
  }
  return body;
}

async function agentSearchRabbitHole(input = {}) {
  const body = currentPlaylistFormBody(input);
  const result = await api("/api/ai/playlist", body);
  if (result.mode === "exact_track_verification") return result;
  renderResults(result);
  return compactAgentResult(result);
}

async function agentVerifyTracks(input = {}) {
  const zone = activeZone();
  return api("/api/tracks/verify", {
    ...input,
    zoneId: cleanAgentText(input.zoneId || input.zone_id) || zone?.zone_id || ""
  });
}

async function agentQueueDisplayedTracks(input = {}) {
  const status = await api("/api/status");
  if (status.app?.latestResultSource === "exact_verification") {
    const result = await api("/api/tracks/verified/queue", input);
    showBridgeSyncPopup(result);
    return result;
  }
  const zone = activeZone();
  if (!zone) throw new Error("Select a Roon zone first.");
  const count = Math.max(1, Math.min(40, Number(input.count || state.displayedTracks.length || 0)));
  const tracks = state.displayedTracks.slice(0, count).map(trackPayload);
  if (!tracks.length) throw new Error("There are no displayed Rabbit Hole tracks to queue.");
  const result = await api("/api/roon/queue-tracks", {
    zoneId: cleanAgentText(input.zoneId) || zone.zone_id,
    tracks,
    alternates: state.lastResult?.alternates || [],
    targetCount: count,
    mode: input.mode === "next" ? "next" : "append",
    preferExtendedMixes: input.preferExtendedMixes ?? currentRequestPrefersExtendedMixes(),
    matchPolicy: input.matchPolicy || "strict",
    allowBridge: input.allowBridge !== false,
    bridgeSyncDelaysMs: input.bridgeSyncDelaysMs || [0, 3000, 7000]
  });
  showQueueReport(result);
  showBridgeSyncPopup(result);
  return {
    requested: result.requested || count,
    queuedCount: result.queuedCount || 0,
    failedCount: result.failedCount || 0,
    topOfQueue: Boolean(result.topOfQueue),
    appendOnly: Boolean(result.appendOnly),
    queued: (result.queued || []).slice(0, 40).map((item) => compactAgentTrack(item.track || item)),
    failed: (result.failed || []).slice(0, 12).map((item) => ({
      track: compactAgentTrack(item.track || item),
      reason: item.reason || ""
    }))
  };
}

async function agentQueueVerifiedTracks(input = {}) {
  const result = await api("/api/tracks/verified/queue", input);
  showBridgeSyncPopup(result);
  return result;
}

async function agentSendDisplayedTracksToTidal(input = {}) {
  const status = await api("/api/status");
  if (status.app?.latestResultSource === "exact_verification") return api("/api/tracks/verified/playlist", input);
  const count = Math.max(1, Math.min(40, Number(input.count || state.displayedTracks.length || 0)));
  const tracks = state.displayedTracks.slice(0, count).map(trackPayload);
  if (!tracks.length) throw new Error("There are no displayed Rabbit Hole tracks to send to TIDAL.");
  const result = await api("/api/tidal/queue-playlist", {
    tracks,
    title: cleanAgentText(input.title) || `Rabbit Hole Queue - ${new Date().toLocaleString()}`,
    description: cleanAgentText(input.description) || "Temporary Rabbit Hole queue created by a WebMCP tool."
  });
  showTidalPlaylistReport(result);
  state.tidalMixesNeedsRefresh = true;
  return {
    title: result.playlist?.title || result.title || "",
    addedCount: result.addedCount || 0,
    skippedCount: result.skippedCount || 0,
    playlist: result.playlist || null,
    added: (result.added || []).slice(0, 40).map(compactAgentTrack)
  };
}

async function agentGetStandbyPool() {
  const result = await getJson("/api/standby");
  renderStandbyPool(result);
  return {
    count: result.count || 0,
    targetCount: result.targetCount || 25,
    ready: Boolean(result.ready),
    refreshing: Boolean(result.refreshing),
    lastRefreshAt: result.lastRefreshAt || "",
    nextRefreshAt: result.nextRefreshAt || "",
    lastError: result.lastError || "",
    tracks: (result.tracks || []).slice(0, 25).map(compactAgentTrack)
  };
}

async function agentRefreshStandbyPool(input = {}) {
  const result = await api("/api/standby/refresh", {
    reason: cleanAgentText(input.reason) || "webmcp",
    options: currentPlaylistFormBody(input.options || input)
  });
  renderStandbyPool(result);
  return {
    count: result.count || 0,
    targetCount: result.targetCount || 25,
    ready: Boolean(result.ready),
    refreshing: Boolean(result.refreshing),
    lastError: result.lastError || "",
    tracks: (result.tracks || []).slice(0, 25).map(compactAgentTrack)
  };
}

async function agentQueueStandbyTracks(input = {}) {
  const zone = activeZone();
  if (!zone) throw new Error("Select a Roon zone first.");
  if (!state.standbyTracks.length) await agentGetStandbyPool();
  const count = Math.max(1, Math.min(25, Number(input.count || state.standbyTracks.length || 0)));
  const tracks = standbyPayloadTracks(count);
  if (!tracks.length) throw new Error("There are no standby tracks to queue.");
  const result = await api("/api/roon/queue-tracks", {
    zoneId: cleanAgentText(input.zoneId) || zone.zone_id,
    tracks,
    targetCount: count,
    mode: input.mode === "next" ? "next" : "append",
    preferExtendedMixes: input.preferExtendedMixes ?? currentRequestPrefersExtendedMixes(),
    matchPolicy: input.matchPolicy || "strict",
    allowBridge: input.allowBridge !== false,
    bridgeSyncDelaysMs: input.bridgeSyncDelaysMs || [0, 3000, 7000]
  });
  showQueueReport(result);
  showBridgeSyncPopup(result);
  return {
    requested: result.requested || count,
    queuedCount: result.queuedCount || 0,
    failedCount: result.failedCount || 0,
    topOfQueue: Boolean(result.topOfQueue),
    queued: (result.queued || []).slice(0, 25).map((item) => compactAgentTrack(item.track || item)),
    failed: (result.failed || []).slice(0, 12).map((item) => ({
      track: compactAgentTrack(item.track || item),
      reason: item.reason || ""
    }))
  };
}

async function agentSendStandbyTracksToTidal(input = {}) {
  if (!state.standbyTracks.length) await agentGetStandbyPool();
  const count = Math.max(1, Math.min(25, Number(input.count || state.standbyTracks.length || 0)));
  const tracks = standbyPayloadTracks(count);
  if (!tracks.length) throw new Error("There are no standby tracks to send to TIDAL.");
  const result = await api("/api/tidal/queue-playlist", {
    tracks,
    title: cleanAgentText(input.title) || `Rabbit Hole Standby - ${new Date().toLocaleString()}`,
    description: cleanAgentText(input.description) || "Rabbit Hole standby pool created by a WebMCP tool."
  });
  showTidalPlaylistReport(result);
  state.tidalMixesNeedsRefresh = true;
  return {
    title: result.playlist?.title || result.title || "",
    addedCount: result.addedCount || 0,
    skippedCount: result.skippedCount || 0,
    playlist: result.playlist || null,
    added: (result.added || []).slice(0, 25).map(compactAgentTrack)
  };
}

async function agentCreateTidalPlaylist(input = {}) {
  const title = cleanAgentText(input.title || input.name);
  if (!title) throw new Error("A playlist title is required.");
  const result = await api("/api/tidal/playlist", {
    title,
    description: cleanAgentText(input.description) || "Created from Rabbit Hole WebMCP."
  });
  const playlist = result.playlist || {};
  if (playlist.id) {
    state.tidalPlaylistsLoaded = true;
    state.tidalPlaylistsError = "";
    state.tidalPlaylists = [
      playlist,
      ...state.tidalPlaylists.filter((item) => item.id !== playlist.id)
    ];
    state.tidalPlaylistsFromCache = false;
    state.tidalPlaylistsWarning = "";
    writeCachedTidalPlaylists(state.tidalPlaylists);
    state.selectedTidalPlaylistId = playlist.id;
    localStorage.setItem("tidalPlaylistId", playlist.id);
    renderNowTidalPlaylistControl();
    renderTidalPlaylistSeedControl();
  }
  return {
    connected: result.connected !== false,
    playlist
  };
}

async function agentAddNowPlayingToTidal(input = {}) {
  const track = state.nowTrack || nowPlayingTrack(activeZone());
  if (!track) throw new Error("There is no current track to add.");
  if (!state.tidalPlaylistsLoaded || input.refreshPlaylists) await loadTidalPlaylists({ force: agentBoolean(input.refreshPlaylists) });
  const playlistTitle = cleanAgentText(input.playlistTitle || input.title);
  const playlistId = cleanAgentText(input.playlistId || input.playlist_id);
  const playlist = state.tidalPlaylists.find((item) => (
    (playlistId && item.id === playlistId) ||
    (playlistTitle && normalizeMatchText(item.title) === normalizeMatchText(playlistTitle))
  )) || selectedTidalPlaylist();
  if (!playlist?.id) throw new Error("Choose or create a TIDAL playlist first.");

  const result = await api("/api/tidal/playlist-track", {
    playlistId: playlist.id,
    playlistTitle: playlist.title,
    track,
    allowDuplicate: agentBoolean(input.allowDuplicate || input.allow_duplicate)
  });
  return {
    playlist: {
      id: playlist.id,
      title: playlist.title || ""
    },
    track: compactAgentTrack(result.track || track),
    resolvedBy: result.resolvedBy || "",
    added: result.added !== false,
    duplicate: Boolean(result.duplicate),
    result
  };
}

async function agentRateNowPlaying(input = {}) {
  const rating = normalizeFeedbackValue(input.rating || "");
  if (!rating) throw new Error("A rating is required.");
  const track = state.nowTrack || nowPlayingTrack(activeZone());
  if (!track) throw new Error("There is no current track to rate.");
  const result = await api("/api/feedback", {
    track: trackPayload(track),
    rating,
    reason: cleanAgentText(input.reason)
  });
  applyFeedbackResponse(result);
  rememberFeedbackForTrack(track, rating);
  updateResultTrackFeedback(track, rating);
  updateNowDiscoveryTools();
  return {
    rating,
    track: compactAgentTrack({ ...track, feedback: rating }),
    taste: result.profile || null,
    genreProfiles: result.genreProfiles || null
  };
}

async function agentExplainLastRejections(input = {}) {
  if (!state.lastResult) await refreshSession();
  const result = state.lastResult || {};
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const limit = Math.max(1, Math.min(50, Number(input.limit || 20)));
  return {
    discardedCount: discarded.length,
    poolDiagnostics: result.verification?.poolDiagnostics || null,
    queryYield: result.verification?.queryYield || null,
    examples: discarded.slice(0, limit).map((track) => ({
      artist: track.artist || "",
      title: track.title || "",
      album: track.album || "",
      label: track.label || "",
      year: track.year || null,
      query: track.query || "",
      reason: track.reason || ""
    }))
  };
}

async function agentInspectGenreProfile(input = {}) {
  const payload = await getJson("/api/status");
  const profileKey = normalizeMatchText(input.genre || input.name || "");
  const profiles = payload.app?.genreProfiles?.profiles || [];
  const matching = profileKey
    ? profiles.filter((profile) => normalizeMatchText(profile.name || profile.key || "").includes(profileKey))
    : profiles;
  return {
    genreProfiles: payload.app?.genreProfiles || null,
    matchingProfiles: matching,
    lastIntent: payload.app?.session?.result?.verification?.intent || payload.app?.session?.options || null
  };
}

window.RabbitHoleWebMcpBridge = {
  version: "1",
  getStatus: async () => compactAgentStatus(await getJson("/api/status")),
  searchRabbitHole: agentSearchRabbitHole,
  verifyTracks: agentVerifyTracks,
  resolveVerifiedTracksForRoon: (input = {}) => api("/api/tracks/verified/resolve-roon", { ...input, zoneId: input.zoneId || activeZone()?.zone_id || "" }),
  queueSuppliedTracks: (input = {}) => api("/api/tracks/supplied/queue", { ...input, zoneId: input.zoneId || activeZone()?.zone_id || "" }),
  queueVerifiedTracks: (input = {}) => agentQueueVerifiedTracks(input),
  sendVerifiedTracksToTidal: (input = {}) => api("/api/tracks/verified/playlist", input),
  queueDisplayedTracks: agentQueueDisplayedTracks,
  sendDisplayedTracksToTidal: agentSendDisplayedTracksToTidal,
  getStandbyPool: agentGetStandbyPool,
  refreshStandbyPool: agentRefreshStandbyPool,
  queueStandbyTracks: agentQueueStandbyTracks,
  sendStandbyTracksToTidal: agentSendStandbyTracksToTidal,
  createTidalPlaylist: agentCreateTidalPlaylist,
  addNowPlayingToTidal: agentAddNowPlayingToTidal,
  rateNowPlaying: agentRateNowPlaying,
  explainLastRejections: agentExplainLastRejections,
  inspectGenreProfile: agentInspectGenreProfile
};

const aiModeSelect = $("#aiModeSelect");
const synapseModelInput = $("#synapseModelInput");
const savedAiMode = localStorage.getItem("rabbitHole.aiMode");
const savedSynapseModel = localStorage.getItem("rabbitHole.synapseModel");
if (aiModeSelect && savedAiMode) aiModeSelect.value = savedAiMode;
if (synapseModelInput && savedSynapseModel) synapseModelInput.value = savedSynapseModel;
if (aiModeSelect) {
  aiModeSelect.addEventListener("change", () => {
    updateModelMode({ refreshSynapse: aiModeSelect.value !== "local" }).catch((error) => alert(error.message));
  });
}
if (synapseModelInput) {
  synapseModelInput.addEventListener("change", () => {
    updateModelMode({ refreshSynapse: true }).catch((error) => alert(error.message));
  });
}
const synapseCheck = $("#synapseCheck");
if (synapseCheck) {
  synapseCheck.addEventListener("click", () => {
    updateModelMode({ refreshSynapse: true }).catch((error) => alert(error.message));
  });
}

const events = new EventSource("/api/events");
events.onopen = () => {
  if (eventSourceOfflineTimer) {
    clearTimeout(eventSourceOfflineTimer);
    eventSourceOfflineTimer = null;
  }
  scheduleRabbitRecoveryRefresh(250);
};
events.onmessage = (event) => {
  if (eventSourceOfflineTimer) {
    clearTimeout(eventSourceOfflineTimer);
    eventSourceOfflineTimer = null;
  }
  const payload = JSON.parse(event.data);
  renderState(payload);
  applyAppState(payload.app);
  state.historyNeedsRefresh = true;
};
events.onerror = () => {
  if (eventSourceOfflineTimer) clearTimeout(eventSourceOfflineTimer);
  scheduleRabbitRecoveryRefresh(250);
  eventSourceOfflineTimer = setTimeout(() => {
    if (!lastRabbitStatusAt || Date.now() - lastRabbitStatusAt > 7000) {
      markRabbitConnectionLost(new Error("Live updates disconnected."));
    }
  }, 2500);
};
applyPlayerMaximized();
applyPlayerFullscreenState();
refresh().catch(() => {});
setInterval(() => {
  if (!lastRabbitStatusAt || Date.now() - lastRabbitStatusAt > 15_000) {
    refresh().catch(() => {});
  }
}, 5_000);
refreshLlmStatus().catch(() => {});
refreshModelStatus().catch(() => {});
setInterval(() => {
  refreshLlmStatus().catch(() => {});
  refreshModelStatus().catch(() => {});
}, 10_000);
refreshSession().catch(() => {});
refreshPlaylists().catch(() => {});
loadTidalPlaylists().catch(() => {});
refreshHistoryReport().catch(() => {});
