"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const config = require("./config");
const {
  candidateIdentityKeys,
  discoverTracks,
  discoveryStatusFor,
  minimumScoreFor,
  minimumScoreLabel,
  parseRequestedCount,
  reasonFor,
  rejectReason,
  scoreBreakdownFor,
  whyBulletsFor
} = require("./discoveryEngine");
const { DiscoveryHistory } = require("./discoveryHistory");
const { ListeningHistory } = require("./listeningHistory");
const { generatePlaylist } = require("./llmClient");
const { HQPlayerStatus } = require("./hqplayerStatus");
const { RoonClient } = require("./roonClient");
const { RabbitHoleGraph } = require("./rabbitHoleGraph");
const { RadioMetadataResolver, parseRadioTrack } = require("./radioMetadataResolver");
const { SavedPlaylist } = require("./savedPlaylist");
const { SessionStore } = require("./sessionStore");
const { TasteProfile, normalizeRating } = require("./tasteProfile");
const { TidalVerifier } = require("./tidalVerifier");
const { TrackMemory } = require("./trackMemory");
const yearRangeUtil = require("./yearRange");

const publicDir = path.join(__dirname, "..", "public");
const roon = new RoonClient();
const tidal = new TidalVerifier(config.tidal);
const discoveryHistory = new DiscoveryHistory();
const listeningHistory = new ListeningHistory();
const savedPlaylist = new SavedPlaylist();
const sessionStore = new SessionStore();
const tasteProfile = new TasteProfile();
const trackMemory = new TrackMemory();
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
  discogsEnabled: config.radioMetadata.discogsEnabled,
  discogsToken: config.radioMetadata.discogsToken,
  spotifyArtworkEnabled: config.radioMetadata.spotifyArtworkEnabled,
  spotifyMarket: config.radioMetadata.spotifyMarket,
  spotifyClientId: config.radioMetadata.spotifyClientId,
  spotifyClientSecret: config.radioMetadata.spotifyClientSecret,
  logger: console
});
const hqplayerStatus = new HQPlayerStatus(config.hqplayer);
const clients = new Set();
const radioEnrichmentCache = new Map();
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
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
    title: cleanRadioText(exactTidalResult?.title || metadata?.title || lookup.title),
    artist: cleanRadioText(exactTidalResult?.artist || metadata?.artist || lookup.artist),
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
        if (result) broadcast();
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
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const yearRange = yearRangeUtil.parseYearRange(options.years || options.request || "");
  const scoringOptions = yearRange ? { ...options, years: yearRange.label } : options;
  const requestedCount = parseRequestedCount(options);
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

  for (const track of enriched) {
    const scoringTrack = {
      ...track,
      ...(track.tidal || {}),
      query: track.query || track.roon?.sourceQuery || "",
      roon: track.roon
    };
    const historyEntry = discoveryHistory.entryFor(scoringTrack);
    const rejection = (yearRange || track.tidal?.tidalUrl) ? rejectReason(scoringTrack, scoringOptions) : "";

    if (rejection) {
      discarded.push({
        ...track,
        reason: rejection
      });
      continue;
    }

    const rawBreakdown = scoreBreakdownFor(scoringTrack, scoringOptions, tasteProfile);
    const scoreBreakdown = scoreWithRoonFloor(rawBreakdown, track);
    if (minScore && scoreBreakdown.total < minScore) {
      const filtered = {
        ...track,
        score: scoreBreakdown.total,
        scoreBreakdown,
        reason: `Discovery score ${scoreBreakdown.total} is below minimum ${minScoreLabel}.`
      };
      scoreFiltered.push(filtered);
      discarded.push(filtered);
      continue;
    }

    const candidate = {
      ...track,
      reason: reasonFor(scoringTrack, scoringOptions, scoreBreakdown),
      why: whyBulletsFor(scoringTrack, scoringOptions, scoreBreakdown, historyEntry),
      discoverySource: track.discoverySource || "Roon search",
      score: scoreBreakdown.total,
      scoreBreakdown,
      statusChecks: queueableStatusChecks({
        ...track,
        statusChecks: discoveryStatusFor(scoringTrack, historyEntry, discoveryHistory.isRecent(scoringTrack))
      }),
      verificationSource: track.verificationSource || "roon"
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
      kept: selected.length,
      discarded: discarded.length,
      minScore,
      minScoreLabel,
      yearRange: yearRange?.label || "",
      scoreFiltered: scoreFiltered.length,
      strategy: "roon-search-first",
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
      }
    }
  };
}

function appSnapshot() {
  const taste = tasteProfile.read();
  const saved = savedPlaylist.list();
  const session = sessionStore.read();
  return {
    updatedAt: new Date().toISOString(),
    session,
    saved,
    taste: tasteProfile.summary(taste),
    feedback: taste.feedback || {},
    memory: trackMemory.summary()
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
  const data = `data: ${JSON.stringify(eventPayload())}\n\n`;
  for (const client of clients) {
    try {
      client.write(data);
    } catch {
      clients.delete(client);
    }
  }
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: "Forbidden" });

  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(data);
  });
}

function parseYearRange(years) {
  const text = String(years || "").trim();
  if (!text) return null;

  const range = text.match(/\b(19\d{2}|20\d{2})\s*[-–]\s*(19\d{2}|20\d{2})\b/);
  if (range) {
    const min = Math.min(Number(range[1]), Number(range[2]));
    const max = Math.max(Number(range[1]), Number(range[2]));
    return { min, max, label: `${min}-${max}` };
  }

  const single = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (single) {
    const year = Number(single[1]);
    return { min: year, max: year, label: String(year) };
  }

  return null;
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
  const yearRange = yearRangeUtil.parseYearRange(options.years || options.request || "");

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

        if (yearRange && !tidalResult.year) {
          discarded.push({
            ...track,
            reason: `TIDAL verified the track but did not expose a release year for ${yearRange.label}.`,
            tidal: tidalResult
          });
          continue;
        }

        if (yearRange && !yearRangeUtil.yearFits(tidalResult.year, yearRange)) {
          discarded.push({
            ...track,
            reason: `TIDAL release year ${tidalResult.year} is outside ${yearRange.label}.`,
            tidal: tidalResult
          });
          continue;
        }

        verified.push({
          ...track,
          artist: tidalResult.artist || track.artist,
          title: tidalResult.title || track.title,
          year: tidalResult.year || null,
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

function withNormalizedYearFilter(options = {}) {
  const parsed = yearRangeUtil.parseYearRange(options.years || options.request || "");
  if (!parsed) return options;
  return {
    ...options,
    years: parsed.label
  };
}

function shouldSkipModelForCatalogSearch(options = {}) {
  const parsed = yearRangeUtil.parseYearRange(options.years || options.request || "");
  if (!parsed) return false;
  const text = normalizeMatchText(`${options.request || ""} ${options.genres || ""} ${options.mood || ""}`);
  return /\b(?:progressive|house|trance|melodic|deep|organic|techno|ambient|disco|synth|new wave|rock|jazz|metal|country|pop|funk|soul|r b|hip hop)\b/.test(text);
}

function strictSearchBudgets(options = {}, requestedCount = 8) {
  const yearRange = yearRangeUtil.parseYearRange(options.years || options.request || "");
  const minScore = minimumScoreFor(options);
  const strict = Boolean(yearRange || minScore);
  if (!strict) {
    return {
      roonFirstTimeoutMs: 10_000,
      modelTimeoutMs: 8_000,
      discoveryTimeoutMs: 12_000,
      roonQueueTimeoutMs: 10_000
    };
  }

  const catalogMode = shouldSkipModelForCatalogSearch(options);
  return {
    roonFirstTimeoutMs: Math.min(35_000, Math.max(16_000, requestedCount * 1_600)),
    modelTimeoutMs: catalogMode ? 0 : Math.min(18_000, Math.max(10_000, requestedCount * 1_000)),
    discoveryTimeoutMs: catalogMode
      ? Math.min(300_000, Math.max(220_000, requestedCount * 8_500))
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

  const yearRange = yearRangeUtil.parseYearRange(options.years || result.verification?.yearRange || "");
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
      const scoringTrack = {
        ...track,
        ...(track.tidal || {}),
        query: track.query || track.roon?.sourceQuery || "",
        roon: track.roon
      };
      const rejection = rejectReason(scoringTrack, scoringOptions);
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
      discarded: discarded.length
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
    const image = await roon.getImage(imageKey, {
      width,
      height,
      scale: url.searchParams.get("scale") || "fill",
      format: "image/jpeg"
    });

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

  if (req.method === "GET" && pathname === "/api/history-report") {
    const state = withHqplayerStatus(roon.getState());
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
    return sendJson(res, 200, { tracks: savedPlaylist.list() });
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

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  let body = await readJson(req);
  if (pathname === "/api/control") {
    const result = await roon.control(body.zoneId, body.control);
    broadcast();
    return sendJson(res, 200, { ok: true, result: result || null });
  }
  if (pathname === "/api/seek") {
    const result = await roon.seek(body.zoneId, body.seconds);
    broadcast();
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
    const requestedCount = parseRequestedCount(body);
    const yearRange = yearRangeUtil.parseYearRange(body.years || body.request || "");
    const strictFilteredRequest = Boolean(yearRange || minimumScoreFor(body));
    const catalogSearchMode = shouldSkipModelForCatalogSearch(body);
    const budgets = strictSearchBudgets(body, requestedCount);
    let roonFirst = { tracks: [], alternates: [], discarded: [], verification: {} };
    let roonFirstError = "";

    const runRoonFirstSearch = /^(1|true|yes)$/i.test(String(body.requireRoonQueueable || "")) && body.zoneId && !catalogSearchMode;
    if (!runRoonFirstSearch && catalogSearchMode) {
      roonFirstError = "Skipped broad Roon-first search for year-filtered catalogue mode.";
    }

    if (runRoonFirstSearch) {
      try {
        const rawRoonFirst = await withTimeout(roon.discoverQueueableTracks(body, body.zoneId, {
          targetCount: strictFilteredRequest
            ? Math.min(40, Math.max(Math.ceil(requestedCount * 1.45), requestedCount + 8))
            : Math.min(20, Math.max(Math.ceil(requestedCount * 1.15), requestedCount + 4)),
          candidateLimit: strictFilteredRequest
            ? Math.min(220, Math.max(requestedCount + 70, requestedCount * 12))
            : Math.min(70, Math.max(requestedCount + 22, requestedCount * 3)),
          searchLimit: strictFilteredRequest ? (requestedCount >= 25 ? 100 : 80) : (requestedCount >= 25 ? 55 : 30),
          maxQueries: strictFilteredRequest
            ? Math.min(36, Math.max(14, requestedCount * 2))
            : (requestedCount >= 25 ? 14 : (requestedCount >= 10 ? 8 : 4)),
          queueCheckLimit: strictFilteredRequest
            ? Math.min(120, Math.max(requestedCount + 42, requestedCount * 6))
            : Math.min(45, Math.max(requestedCount + 12, requestedCount * 2))
        }), budgets.roonFirstTimeoutMs, "Roon search-first discovery took too long.");
        roonFirst = await decorateRoonFirstResult(rawRoonFirst, body);
      } catch (error) {
        roonFirstError = error.message;
      }
    }

    const usefulRoonFirstCount = requestedCount <= 5
      ? requestedCount
      : Math.max(3, Math.ceil(requestedCount * 0.55));
    if (roonFirst.tracks.length >= requestedCount || roonFirst.tracks.length >= usefulRoonFirstCount) {
      roonFirst.verification = {
        ...(roonFirst.verification || {}),
        modelCandidateCount: 0,
        modelError: "",
        roonFirstError,
        partialRoonFirstReturn: roonFirst.tracks.length < requestedCount
      };
      discoveryHistory.record(roonFirst.tracks || []);
      trackMemory.record([...(roonFirst.tracks || []), ...(roonFirst.alternates || [])]);
      sessionStore.save(body, roonFirst);
      broadcast();
      return sendJson(res, 200, roonFirst);
    }

    let modelResult = null;
    let modelError = "";
    if (catalogSearchMode) {
      modelResult = { tracks: [] };
    } else {
      try {
        modelResult = await withTimeout(
          generatePlaylist(config, body),
          budgets.modelTimeoutMs,
          "The local model took too long to answer."
        );
      } catch (error) {
        modelError = error.message;
      }
    }

    let discovered = null;
    try {
      discovered = await withTimeout(
        discoverTracks({
          tidal,
          options: {
            ...body,
            llmCandidates: modelResult?.tracks || []
          },
          history: discoveryHistory,
          tasteProfile
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
          discoveryError: error.message
        }
      };
    }
    discovered.tracks = mergeTrackLists(roonFirst.tracks, discovered.tracks);
    discovered.alternates = mergeTrackLists(roonFirst.alternates, discovered.alternates);
    discovered.discarded = [...(roonFirst.discarded || []), ...(discovered.discarded || [])];
    discovered.verification = {
      ...(discovered.verification || {}),
      modelCandidateCount: modelResult?.tracks?.length || 0,
      modelError,
      modelSkipped: catalogSearchMode ? "Skipped local model for year-filtered catalogue search." : "",
      roonFirstKept: roonFirst.tracks.length,
      roonFirstError
    };
    let result = null;
    try {
      result = await withTimeout(
        filterForRoonQueueable(discovered, body.zoneId, body),
        budgets.roonQueueTimeoutMs,
        "Roon queue verification took too long."
      );
    } catch (error) {
      result = {
        ...discovered,
        tracks: roonFirst.tracks || [],
        verification: {
          ...(discovered.verification || {}),
          roonQueueable: true,
          roonStrict: true,
          roonVerificationError: error.message,
          kept: roonFirst.tracks.length,
          generated: (roonFirst.tracks || []).length + (discovered.discarded || []).length,
          discarded: (discovered.discarded || []).length
        }
      };
    }
    discoveryHistory.record(result.tracks || []);
    trackMemory.record([...(result.tracks || []), ...(result.alternates || [])]);
    sessionStore.save(body, result);
    broadcast();
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
    const result = tasteProfile.record(body.track || {}, rating);
    sessionStore.updateFeedback(body.track || {}, rating);
    trackMemory.updateFeedback(body.track || {}, rating);
    broadcast();
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
    broadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/add") {
    const result = savedPlaylist.add(body.track || {});
    if (result.added && typeof tasteProfile.recordCandidate === "function") {
      result.taste = tasteProfile.recordCandidate(result.track || body.track || {});
    }
    broadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/saved/remove") {
    const result = savedPlaylist.remove(body.key);
    broadcast();
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/memory/purge") {
    const result = trackMemory.purge();
    broadcast();
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
    sendJson(res, 500, { error: error.message });
  }
});

roon.on("zones", broadcast);
hqplayerStatus.start();
roon.start();

server.listen(config.port, config.host, () => {
  console.log(`The Rabbit Hole is running at http://localhost:${config.port}`);
  for (const url of getNetworkUrls().filter((candidate) => !candidate.includes("localhost"))) {
    console.log(`Phone/LAN URL: ${url}`);
  }
  console.log("Enable the extension in Roon Settings > Extensions if prompted.");
});
