"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function positiveNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function trackHistoryKey(track = {}) {
  const artist = normalize(track.artist);
  const title = normalize(track.title || track.name);
  return artist && title ? `${artist}|${title}` : "";
}

function normalizeUsername(value) {
  let text = cleanText(value).replace(/\s+#.*$/, "").trim().replace(/^@+/, "");
  const urlMatch = text.match(/last\.fm\/user\/([^/?#\s]+)/i);
  if (urlMatch) text = urlMatch[1];
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the original text if it is not URL encoded.
  }
  return text.trim();
}

function usernameLooksValid(value) {
  return /^[a-z0-9_-]{2,32}$/i.test(cleanText(value));
}

function lastFmImageUrl(images = []) {
  if (!Array.isArray(images)) return "";
  const candidates = [...images].reverse();
  const match = candidates.find((image) => cleanText(image?.["#text"]));
  return cleanText(match?.["#text"]);
}

class LastFmClient {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.apiKey = cleanText(options.apiKey);
    this.username = normalizeUsername(options.username);
    this.historyLimit = Math.max(10, Math.min(1000, Number(options.historyLimit || 200)));
    this.topArtistLimit = Math.max(0, Math.min(200, Number(options.topArtistLimit || 50)));
    this.topArtistPeriod = cleanText(options.topArtistPeriod || "12month") || "12month";
    this.cacheMs = Math.max(0, Number(options.cacheMs || 5 * 60 * 1000));
    this.timeoutMs = positiveNumber(options.timeoutMs, 3500, { min: 250, max: 30_000 });
    this.fetch = options.fetch || globalThis.fetch;
    this.cache = new Map();
  }

  status() {
    return {
      enabled: this.enabled,
      apiKeyConfigured: Boolean(this.apiKey),
      usernameConfigured: Boolean(this.username),
      usernameValid: usernameLooksValid(this.username),
      configured: this.isConfigured()
    };
  }

  isConfigured() {
    return Boolean(this.enabled && this.apiKey && this.username && usernameLooksValid(this.username) && this.fetch);
  }

  async fetchJson(params = {}, cacheKey = "") {
    const key = cacheKey || JSON.stringify(params);
    const cached = this.cache.get(key);
    if (cached && this.cacheMs && Date.now() - cached.updatedAt < this.cacheMs) return cached.value;

    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    for (const [name, value] of Object.entries({
      api_key: this.apiKey,
      format: "json",
      ...params
    })) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    }

    const response = await this.fetchWithTimeout(url, "Last.fm request");
    const body = await response.json();
    if (body?.error) throw new Error(`Last.fm ${body.error}: ${body.message || "request failed"}`);
    if (!response.ok) throw new Error(`Last.fm returned HTTP ${response.status}.`);

    this.cache.set(key, {
      updatedAt: Date.now(),
      value: body
    });
    return body;
  }

  async fetchWithTimeout(url, label = "Last.fm request") {
    if (typeof this.fetch !== "function") throw new Error("Fetch API unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(`${label} timed out after ${Math.round(this.timeoutMs / 1000)}s`);
        timeoutError.name = "TimeoutError";
        timeoutError.code = "ETIMEDOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  parseRecentTracks(body = {}) {
    const rawTracks = body?.recenttracks?.track;
    const tracks = Array.isArray(rawTracks) ? rawTracks : (rawTracks ? [rawTracks] : []);
    return tracks.map((track) => {
      const artist = cleanText(track.artist?.["#text"] || track.artist?.name || track.artist);
      const title = cleanText(track.name);
      const album = cleanText(track.album?.["#text"] || track.album);
      const uts = Number(track.date?.uts || 0);
      const nowPlaying = String(track["@attr"]?.nowplaying || "").toLowerCase() === "true";
      return {
        artist,
        title,
        album,
        playedAt: uts ? uts * 1000 : 0,
        nowPlaying,
        imageUrl: lastFmImageUrl(track.image)
      };
    }).filter((track) => track.artist && track.title);
  }

  parseTopArtists(body = {}, period = this.topArtistPeriod) {
    const rawArtists = body?.topartists?.artist;
    const artists = Array.isArray(rawArtists) ? rawArtists : (rawArtists ? [rawArtists] : []);
    return artists.map((artist, index) => {
      const rank = Number(artist?.["@attr"]?.rank || index + 1);
      return {
        artist: cleanText(artist.name || artist.artist || artist["#text"]),
        plays: Number(artist.playcount || artist.plays || 0),
        rank: rank > 0 ? rank : index + 1,
        period,
        imageUrl: lastFmImageUrl(artist.image),
        url: cleanText(artist.url)
      };
    }).filter((artist) => artist.artist);
  }

  async recentTracks(options = {}) {
    const limit = Math.max(1, Math.min(1000, Number(options.limit || this.historyLimit)));
    if (!this.isConfigured()) return [];
    const body = await this.fetchJson({
      method: "user.getrecenttracks",
      user: this.username,
      limit
    }, `recent:${this.username}:${limit}`);
    return this.parseRecentTracks(body);
  }

  async topArtists(options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit || this.topArtistLimit || 50)));
    const period = cleanText(options.period || this.topArtistPeriod || "12month");
    if (!this.isConfigured() || !limit) return [];
    const body = await this.fetchJson({
      method: "user.gettopartists",
      user: this.username,
      period,
      limit
    }, `topartists:${this.username}:${period}:${limit}`);
    return this.parseTopArtists(body, period);
  }

  async historySnapshot(options = {}) {
    const status = this.status();
    if (!this.enabled) return { ...status, checked: false, reason: "Last.fm lookup disabled" };
    if (!this.apiKey) return { ...status, checked: false, reason: "LASTFM_API_KEY is missing" };
    if (!this.username) return { ...status, checked: false, reason: "LASTFM_USERNAME is missing" };
    if (!usernameLooksValid(this.username)) return { ...status, checked: false, reason: "LASTFM_USERNAME does not look like a Last.fm username" };
    if (!this.fetch) return { ...status, checked: false, reason: "Fetch API unavailable" };

    const limit = Math.max(1, Math.min(1000, Number(options.limit || this.historyLimit)));
    const includeTopArtists = options.includeTopArtists !== false;
    const topArtistLimit = Math.max(0, Math.min(200, Number(options.topArtistLimit ?? this.topArtistLimit ?? 50)));
    const topArtistPeriod = cleanText(options.topArtistPeriod || this.topArtistPeriod || "12month");
    const tracks = await this.recentTracks({ limit });
    const tracksByKey = {};
    const artistsByKey = {};
    const recentArtistsByKey = artistsByKey;

    for (const track of tracks) {
      const key = trackHistoryKey(track);
      if (!key) continue;
      const existing = tracksByKey[key] || {
        artist: track.artist,
        title: track.title,
        plays: 0,
        lastPlayedAt: 0,
        nowPlaying: false,
        imageUrl: track.imageUrl || ""
      };
      existing.plays += 1;
      existing.nowPlaying = existing.nowPlaying || track.nowPlaying;
      existing.lastPlayedAt = Math.max(Number(existing.lastPlayedAt || 0), Number(track.playedAt || 0));
      existing.imageUrl = existing.imageUrl || track.imageUrl || "";
      tracksByKey[key] = existing;

      const artistKey = normalize(track.artist);
      if (artistKey) {
        artistsByKey[artistKey] = (artistsByKey[artistKey] || 0) + 1;
      }
    }

    let topArtists = [];
    let topArtistsError = "";
    if (includeTopArtists && topArtistLimit > 0) {
      try {
        topArtists = await this.topArtists({ limit: topArtistLimit, period: topArtistPeriod });
      } catch (error) {
        topArtistsError = error.message || "Last.fm top artists unavailable";
      }
    }

    const topArtistsByKey = {};
    for (const artist of topArtists) {
      const key = normalize(artist.artist);
      if (!key) continue;
      topArtistsByKey[key] = artist;
    }

    return {
      ...status,
      checked: true,
      limit,
      returned: tracks.length,
      tracksByKey,
      artistsByKey,
      recentArtistsByKey,
      topArtistLimit,
      topArtistPeriod,
      topArtistsReturned: topArtists.length,
      topArtists,
      topArtistsByKey,
      topArtistsError,
      checkedAt: Date.now()
    };
  }
}

module.exports = {
  LastFmClient,
  normalize,
  normalizeUsername,
  trackHistoryKey
};
