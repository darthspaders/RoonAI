"use strict";

const fs = require("fs");
const path = require("path");

function loadDotEnv(file = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function envNumber(name, fallback = 0) {
  const number = Number(process.env[name]);
  return Number.isFinite(number) ? number : fallback;
}

function envNumberList(name, fallback = []) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const numbers = String(value)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((number) => Number.isFinite(number) && number >= 0);
  return numbers.length ? numbers : fallback;
}

module.exports = {
  port: Number(process.env.PORT || 3777),
  host: process.env.HOST || "0.0.0.0",
  llmProvider: (process.env.LLM_PROVIDER || "ollama").toLowerCase(),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
  openAiCompatibleBaseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || "http://127.0.0.1:1234/v1",
  openAiCompatibleApiKey: process.env.LLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "",
  openAiCompatibleModel: process.env.LLM_MODEL || process.env.OPENAI_COMPATIBLE_MODEL || "qwen3-32b",
  llmPlanningTimeoutMs: Number(process.env.LLM_PLANNING_TIMEOUT_MS || 0),
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
  ai: {
    mode: (process.env.AI_MODE || "auto").toLowerCase(),
    localTimeoutMs: envNumber("AI_LOCAL_TIMEOUT_MS", 45000),
    openai: {
      enabled: envFlag("OPENAI_ENABLED", Boolean(process.env.OPENAI_API_KEY)),
      apiKey: process.env.OPENAI_API_KEY || "",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      defaultTier: (process.env.OPENAI_DEFAULT_TIER || "luna").toLowerCase(),
      model: process.env.OPENAI_MODEL || process.env.OPENAI_LUNA_MODEL || "gpt-5.6-luna",
      maxOutputTokens: envNumber("OPENAI_MAX_OUTPUT_TOKENS", 1200),
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "",
      reasoningMode: process.env.OPENAI_REASONING_MODE || "",
      timeoutMs: envNumber("OPENAI_TIMEOUT_MS", 60000),
      healthTimeoutMs: envNumber("OPENAI_HEALTH_TIMEOUT_MS", 6000),
      retryCount: envNumber("OPENAI_RETRY_COUNT", 1),
      retryDelayMs: envNumber("OPENAI_RETRY_DELAY_MS", 750),
      maxToolRounds: envNumber("OPENAI_MAX_TOOL_ROUNDS", 6),
      maxEscalationAttempts: envNumber("OPENAI_MAX_ESCALATION_ATTEMPTS", 3),
      maxCostPerRequest: envNumber("OPENAI_MAX_COST_PER_REQUEST", 0),
      dailyBudget: envNumber("OPENAI_DAILY_BUDGET", 0),
      monthlyBudget: envNumber("OPENAI_MONTHLY_BUDGET", 0),
      inputCostPerMillion: envNumber("OPENAI_INPUT_COST_PER_1M", 0),
      cachedInputCostPerMillion: envNumber("OPENAI_CACHED_INPUT_COST_PER_1M", 0),
      outputCostPerMillion: envNumber("OPENAI_OUTPUT_COST_PER_1M", 0),
      tiers: {
        luna: {
          model: process.env.OPENAI_LUNA_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-luna",
          maxOutputTokens: envNumber("OPENAI_LUNA_MAX_OUTPUT_TOKENS", envNumber("OPENAI_MAX_OUTPUT_TOKENS", 1200)),
          reasoningEffort: process.env.OPENAI_LUNA_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || "",
          reasoningMode: process.env.OPENAI_LUNA_REASONING_MODE || process.env.OPENAI_REASONING_MODE || "",
          maxCostPerRequest: envNumber("OPENAI_LUNA_MAX_COST_PER_REQUEST", envNumber("OPENAI_MAX_COST_PER_REQUEST", 0)),
          dailyBudget: envNumber("OPENAI_LUNA_DAILY_BUDGET", 0),
          monthlyBudget: envNumber("OPENAI_LUNA_MONTHLY_BUDGET", 0),
          inputCostPerMillion: envNumber("OPENAI_LUNA_INPUT_COST_PER_1M", envNumber("OPENAI_INPUT_COST_PER_1M", 0)),
          cachedInputCostPerMillion: envNumber("OPENAI_LUNA_CACHED_INPUT_COST_PER_1M", envNumber("OPENAI_CACHED_INPUT_COST_PER_1M", 0)),
          outputCostPerMillion: envNumber("OPENAI_LUNA_OUTPUT_COST_PER_1M", envNumber("OPENAI_OUTPUT_COST_PER_1M", 0))
        },
        terra: {
          model: process.env.OPENAI_TERRA_MODEL || "gpt-5.6-terra",
          maxOutputTokens: envNumber("OPENAI_TERRA_MAX_OUTPUT_TOKENS", envNumber("OPENAI_MAX_OUTPUT_TOKENS", 1200)),
          reasoningEffort: process.env.OPENAI_TERRA_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || "",
          reasoningMode: process.env.OPENAI_TERRA_REASONING_MODE || process.env.OPENAI_REASONING_MODE || "",
          maxCostPerRequest: envNumber("OPENAI_TERRA_MAX_COST_PER_REQUEST", envNumber("OPENAI_MAX_COST_PER_REQUEST", 0)),
          dailyBudget: envNumber("OPENAI_TERRA_DAILY_BUDGET", 0),
          monthlyBudget: envNumber("OPENAI_TERRA_MONTHLY_BUDGET", 0),
          inputCostPerMillion: envNumber("OPENAI_TERRA_INPUT_COST_PER_1M", envNumber("OPENAI_INPUT_COST_PER_1M", 0)),
          cachedInputCostPerMillion: envNumber("OPENAI_TERRA_CACHED_INPUT_COST_PER_1M", envNumber("OPENAI_CACHED_INPUT_COST_PER_1M", 0)),
          outputCostPerMillion: envNumber("OPENAI_TERRA_OUTPUT_COST_PER_1M", envNumber("OPENAI_OUTPUT_COST_PER_1M", 0))
        },
        sol: {
          model: process.env.OPENAI_SOL_MODEL || "gpt-5.6-sol",
          maxOutputTokens: envNumber("OPENAI_SOL_MAX_OUTPUT_TOKENS", envNumber("OPENAI_MAX_OUTPUT_TOKENS", 1600)),
          reasoningEffort: process.env.OPENAI_SOL_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || "",
          reasoningMode: process.env.OPENAI_SOL_REASONING_MODE || process.env.OPENAI_REASONING_MODE || "",
          maxCostPerRequest: envNumber("OPENAI_SOL_MAX_COST_PER_REQUEST", envNumber("OPENAI_MAX_COST_PER_REQUEST", 0)),
          dailyBudget: envNumber("OPENAI_SOL_DAILY_BUDGET", 0),
          monthlyBudget: envNumber("OPENAI_SOL_MONTHLY_BUDGET", 0),
          inputCostPerMillion: envNumber("OPENAI_SOL_INPUT_COST_PER_1M", envNumber("OPENAI_INPUT_COST_PER_1M", 0)),
          cachedInputCostPerMillion: envNumber("OPENAI_SOL_CACHED_INPUT_COST_PER_1M", envNumber("OPENAI_CACHED_INPUT_COST_PER_1M", 0)),
          outputCostPerMillion: envNumber("OPENAI_SOL_OUTPUT_COST_PER_1M", envNumber("OPENAI_OUTPUT_COST_PER_1M", 0))
        }
      },
      usageFile: process.env.OPENAI_USAGE_FILE || path.join(__dirname, "..", "data", "openai-usage.json")
    }
  },
  streamingService: process.env.STREAMING_SERVICE || "qobuz",
  tidal: {
    enabled: !/^(0|false|no)$/i.test(process.env.TIDAL_VERIFY || "true"),
    countryCode: process.env.TIDAL_COUNTRY_CODE || "US",
    clientId: process.env.TIDAL_CLIENT_ID || "",
    clientSecret: process.env.TIDAL_CLIENT_SECRET || "",
    accessToken: process.env.TIDAL_ACCESS_TOKEN || "",
    timeoutMs: Number(process.env.TIDAL_FETCH_TIMEOUT_MS || 12000),
    failureThreshold: Number(process.env.TIDAL_CIRCUIT_FAILURES || 3),
    circuitCooldownMs: Number(process.env.TIDAL_CIRCUIT_COOLDOWN_MS || 45000)
  },
  tidalProfileMixes: {
    enabled: !/^(0|false|no)$/i.test(process.env.TIDAL_PROFILE_MIXES || "true"),
    countryCode: process.env.TIDAL_COUNTRY_CODE || "US",
    locale: process.env.TIDAL_LOCALE || "en_US",
    deviceType: process.env.TIDAL_DEVICE_TYPE || "BROWSER",
    userId: process.env.TIDAL_USER_ID || "",
    clientId: process.env.TIDAL_PROFILE_CLIENT_ID || process.env.TIDAL_CLIENT_ID || "",
    clientSecret: process.env.TIDAL_PROFILE_CLIENT_SECRET || process.env.TIDAL_CLIENT_SECRET || "",
    redirectUri: process.env.TIDAL_PROFILE_REDIRECT_URI || `http://127.0.0.1:${Number(process.env.PORT || 3777)}/api/tidal/oauth/callback`,
    scopes: process.env.TIDAL_PROFILE_SCOPES || "user.read playlists.read playlists.write recommendations.read collection.read collection.write search.read",
    allowLegacyScope: /^(1|true|yes)$/i.test(process.env.TIDAL_PROFILE_ALLOW_LEGACY_SCOPE || ""),
    accessToken: process.env.TIDAL_PROFILE_ACCESS_TOKEN || process.env.TIDAL_USER_ACCESS_TOKEN || "",
    refreshToken: process.env.TIDAL_PROFILE_REFRESH_TOKEN || process.env.TIDAL_USER_REFRESH_TOKEN || "",
    tokenFile: process.env.TIDAL_PROFILE_TOKEN_FILE || "",
    authorizationUrl: process.env.TIDAL_PROFILE_AUTHORIZATION_URL || "",
    tokenUrl: process.env.TIDAL_PROFILE_TOKEN_URL || "",
    endpoint: process.env.TIDAL_PROFILE_MIXES_ENDPOINT || "",
    artistRadioFallback: /^(1|true|yes)$/i.test(process.env.TIDAL_PROFILE_ARTIST_RADIO_FALLBACK || ""),
    pinnedFile: process.env.TIDAL_PINNED_MIXES_FILE || "",
    timeoutMs: Number(process.env.TIDAL_PROFILE_FETCH_TIMEOUT_MS || process.env.TIDAL_FETCH_TIMEOUT_MS || 12000),
    failureThreshold: Number(process.env.TIDAL_PROFILE_CIRCUIT_FAILURES || process.env.TIDAL_CIRCUIT_FAILURES || 3),
    circuitCooldownMs: Number(process.env.TIDAL_PROFILE_CIRCUIT_COOLDOWN_MS || process.env.TIDAL_CIRCUIT_COOLDOWN_MS || 45000),
    cacheMs: Number(process.env.TIDAL_PROFILE_CACHE_MS || 300000),
    playlistTrackCacheMs: Number(process.env.TIDAL_PLAYLIST_TRACK_CACHE_MS || 1800000),
    playlistTrackCacheFile: process.env.TIDAL_PLAYLIST_TRACK_CACHE_FILE || path.join(__dirname, "..", "data", "tidal-playlist-track-cache.json"),
    playlistTrackFetchMinIntervalMs: Number(process.env.TIDAL_PLAYLIST_TRACK_FETCH_INTERVAL_MS || 750)
  },
  exactRoonBridge: {
    syncDelaysMs: envNumberList("EXACT_ROON_BRIDGE_SYNC_DELAYS_MS", [0, 3000, 7000]),
    playlistLookupTimeoutMs: envNumber("EXACT_ROON_BRIDGE_LOOKUP_TIMEOUT_MS", 15000)
  },
  roonInternal: {
    enabled: envFlag("ROON_INTERNAL_API_ENABLED", false),
    tidalSyncEnabled: envFlag("ROON_INTERNAL_TIDAL_SYNC_ENABLED", false),
    packagePath: process.env.ROON_INTERNAL_API_PACKAGE_PATH || "",
    host: process.env.ROON_INTERNAL_HOST || "127.0.0.1",
    port: envNumber("ROON_INTERNAL_PORT", 9332),
    brokerId: process.env.ROON_INTERNAL_BROKER_ID || "",
    connectTimeoutMs: envNumber("ROON_INTERNAL_CONNECT_TIMEOUT_MS", 10000),
    settleMs: envNumber("ROON_INTERNAL_SETTLE_MS", 2000)
  },
  radioMetadata: {
    enabled: !/^(0|false|no)$/i.test(process.env.RADIO_METADATA_LOOKUP || "true"),
    cacheMax: Number(process.env.RADIO_METADATA_CACHE_MAX || 200),
    minLookupIntervalMs: Number(process.env.RADIO_METADATA_MIN_LOOKUP_INTERVAL_MS || 1500),
    tidalArtworkEnabled: !/^(0|false|no)$/i.test(process.env.TIDAL_ARTWORK_LOOKUP || "true"),
    tidalCountryCode: process.env.TIDAL_COUNTRY_CODE || "US",
    tidalAccessToken: process.env.TIDAL_ACCESS_TOKEN || "",
    tidalClientId: process.env.TIDAL_CLIENT_ID || "",
    tidalClientSecret: process.env.TIDAL_CLIENT_SECRET || "",
    tidalTimeoutMs: Number(process.env.TIDAL_FETCH_TIMEOUT_MS || 12000),
    tidalFailureThreshold: Number(process.env.TIDAL_CIRCUIT_FAILURES || 3),
    tidalCircuitCooldownMs: Number(process.env.TIDAL_CIRCUIT_COOLDOWN_MS || 45000),
    discogsEnabled: !/^(0|false|no)$/i.test(process.env.DISCOGS_LOOKUP || "true"),
    discogsToken: process.env.DISCOGS_TOKEN || "",
    spotifyArtworkEnabled: /^(1|true|yes)$/i.test(process.env.SPOTIFY_ARTWORK_LOOKUP || ""),
    spotifyMarket: process.env.SPOTIFY_MARKET || "US",
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || "",
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    roonPresenceNowStateUrl: process.env.ROONPRESENCE_NOW_STATE_URL || "http://127.0.0.1:8787/now-state",
    roonPresenceTimeoutMs: Number(process.env.ROONPRESENCE_NOW_STATE_TIMEOUT_MS || 1200)
  },
  artBridge: {
    enabled: !/^(0|false|no)$/i.test(process.env.ART_BRIDGE_ENABLED || "true"),
    cacheUrl: process.env.ART_BRIDGE_CACHE_URL || "http://127.0.0.1:8787/api/art/cache",
    timeoutMs: Number(process.env.ART_BRIDGE_TIMEOUT_MS || 1200)
  },
  metadataEnrichment: {
    enabled: !/^(0|false|no)$/i.test(process.env.METADATA_ENRICHMENT || "true"),
    cacheFile: process.env.METADATA_ENRICHMENT_CACHE_FILE || path.join(__dirname, "..", "data", "metadata-enrichment-cache.json"),
    minConfidence: Number(process.env.METADATA_ENRICHMENT_MIN_CONFIDENCE || 80),
    timeoutMs: Number(process.env.METADATA_ENRICHMENT_TIMEOUT_MS || 8000)
  },
  musicMemory: {
    enabled: envFlag("RABBIT_HOLE_MUSIC_MEMORY", true),
    dbFile: process.env.RABBIT_HOLE_MUSIC_MEMORY_DB || path.join(__dirname, "..", "data", "rabbit-hole-memory.sqlite")
  },
  musicBrainzLocal: {
    enabled: envFlag("MUSICBRAINZ_LOCAL_INDEX", false),
    indexDir: process.env.MUSICBRAINZ_INDEX_DIR || path.join(__dirname, "..", "data", "musicbrainz-index"),
    publicFallback: envFlag("MUSICBRAINZ_PUBLIC_FALLBACK", true),
    maxResults: envNumber("MUSICBRAINZ_LOCAL_MAX_RESULTS", 8)
  },
  beatport: {
    enabled: envFlag("BEATPORT_ENABLED", false),
    experimentalPublicClient: envFlag("BEATPORT_EXPERIMENTAL_PUBLIC_CLIENT", false),
    clientId: process.env.BEATPORT_CLIENT_ID || "",
    accessToken: process.env.BEATPORT_ACCESS_TOKEN || "",
    refreshToken: process.env.BEATPORT_REFRESH_TOKEN || "",
    tokenFile: process.env.BEATPORT_TOKEN_FILE || path.join(__dirname, "..", "data", "beatport-token.json"),
    baseUrl: process.env.BEATPORT_BASE_URL || "https://api.beatport.com/v4",
    timeoutMs: envNumber("BEATPORT_TIMEOUT_MS", 8000),
    maxResults: envNumber("BEATPORT_MAX_RESULTS", 8),
    requestsPerSecond: envNumber("BEATPORT_REQUESTS_PER_SECOND", 2),
    cacheTtlMs: envNumber("BEATPORT_CACHE_TTL_MS", 86400000),
    maxCacheEntries: envNumber("BEATPORT_MAX_CACHE_ENTRIES", 2000),
    maxRetries: envNumber("BEATPORT_MAX_RETRIES", 2),
    missingRetryMs: envNumber("BEATPORT_MISSING_RETRY_MS", 604800000)
  },
  beatportMemoryBackfill: {
    enabled: envFlag("BEATPORT_MEMORY_BACKFILL", true),
    batchSize: envNumber("BEATPORT_MEMORY_BACKFILL_BATCH_SIZE", 25),
    intervalMs: envNumber("BEATPORT_MEMORY_BACKFILL_INTERVAL_MS", 300000),
    delayMs: envNumber("BEATPORT_MEMORY_BACKFILL_DELAY_MS", 2000),
    jitter: envNumber("BEATPORT_MEMORY_BACKFILL_JITTER", 0.2),
    startDelayMs: envNumber("BEATPORT_MEMORY_BACKFILL_START_DELAY_MS", 30000)
  },
  pcMonitor: {
    enabled: !/^(0|false|no)$/i.test(process.env.PC_MONITOR_ENABLED || "true"),
    baseUrl: process.env.PC_MONITOR_BASE_URL || "http://127.0.0.1:3088",
    timeoutMs: Number(process.env.PC_MONITOR_TIMEOUT_MS || 1200)
  },
  hqplayer: {
    signalPathPrefix: process.env.HQPLAYER_SIGNAL_PATH_PREFIX || "poly-sinc-gauss-hires-mp, TPDF, PCM",
    signalPathStatic: process.env.HQPLAYER_SIGNAL_PATH_STATIC || "",
    rateCommand: process.env.HQPLAYER_RATE_COMMAND || "",
    ptyWorkerPath: process.env.HQPLAYER_PTY_WORKER || "",
    pollMs: Number(process.env.HQPLAYER_SIGNAL_PATH_POLL_MS || 60000)
  },
  rabbitHole: {
    musicBrainz: !/^(0|false|no)$/i.test(process.env.RABBIT_HOLE_MUSICBRAINZ || "true"),
    lastfmApiKey: process.env.LASTFM_API_KEY || "",
    discogsToken: process.env.DISCOGS_TOKEN || ""
  },
  lastfm: {
    enabled: !/^(0|false|no)$/i.test(process.env.LASTFM_LOOKUP || "true"),
    apiKey: process.env.LASTFM_API_KEY || "",
    username: process.env.LASTFM_USERNAME || "",
    historyLimit: Number(process.env.LASTFM_HISTORY_LIMIT || 200),
    topArtistLimit: Number(process.env.LASTFM_TOP_ARTIST_LIMIT || 50),
    topArtistPeriod: process.env.LASTFM_TOP_ARTIST_PERIOD || "12month",
    cacheMs: Number(process.env.LASTFM_CACHE_MS || 300000),
    timeoutMs: Number(process.env.LASTFM_TIMEOUT_MS || 3500)
  }
};
