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

module.exports = {
  port: Number(process.env.PORT || 3777),
  host: process.env.HOST || "0.0.0.0",
  llmProvider: (process.env.LLM_PROVIDER || "ollama").toLowerCase(),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
  openAiCompatibleBaseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || "http://127.0.0.1:1234/v1",
  openAiCompatibleApiKey: process.env.LLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "",
  openAiCompatibleModel: process.env.LLM_MODEL || process.env.OPENAI_COMPATIBLE_MODEL || "qwen3-32b",
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
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
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || ""
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
