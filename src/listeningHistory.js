"use strict";

const fs = require("fs");
const path = require("path");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function imageUrl(imageKey) {
  return imageKey ? `/api/roon/image/${encodeURIComponent(imageKey)}?width=160&height=160` : "";
}

function firstImageKey(value) {
  if (Array.isArray(value)) return cleanText(value.find(Boolean));
  return cleanText(value);
}

function looksLikeRadioStationPlaceholder(value) {
  const text = normalize(value);
  if (!text) return false;
  return /\b(?:di fm|digitally imported|frisky radio|proton radio|afterhours fm|live radio|radio station|internet radio)\b/.test(text) ||
    /^(?:progressive|deep house|techno|trance|ambient|chillout|lounge)\s+di fm$/.test(text);
}

function looksLikeRadioProgramPlaceholder(value) {
  const text = cleanText(value);
  if (!text) return false;
  const monthAndYear = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/i;
  return monthAndYear.test(text) ||
    /\b(?:episode|showcase|takeover|podcast|radio\s+show|guest\s+mix|dj\s+set|live\s+set|live\s+mix|monthly\s+mix|weekly\s+mix|mixed\s+by)\b/i.test(text);
}

function isNonContributoryPlay(play = {}) {
  const artist = cleanText(play.artist);
  const title = cleanText(play.title);
  const album = cleanText(play.album);
  const combined = `${artist} ${title} ${album} ${play.zoneName || ""}`;
  const unknownArtist = /^(?:unknown|unknown artist|various artists?)$/i.test(artist);
  const stationTitle = looksLikeRadioStationPlaceholder(title);
  const stationArtist = looksLikeRadioStationPlaceholder(artist);
  const radioProgram = play.isRadioProgram ||
    play.catalogEnrichmentAllowed === false ||
    looksLikeRadioProgramPlaceholder(title) ||
    looksLikeRadioProgramPlaceholder(artist);

  if (!title || unknownArtist) return true;
  if (stationTitle || stationArtist) return true;
  if (looksLikeRadioStationPlaceholder(combined) && radioProgram) return true;
  return false;
}

function trackFromZone(zone = {}) {
  if (zone.state !== "playing") return null;

  const now = zone.now_playing || {};
  const lookup = now.radio_lookup || {};
  const enriched = now.radio_enrichment || {};
  const title = cleanText(enriched.title || lookup.title || now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1);
  const artist = cleanText(enriched.artist || lookup.artist || now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2);
  const album = cleanText(enriched.album || lookup.album || now.three_line?.line3 || "");
  if (!title) return null;

  const track = {
    key: `${normalize(artist)}|${normalize(title)}`,
    title,
    artist: artist || "Unknown Artist",
    album,
    lengthSeconds: Number(now.length || 0),
    imageUrl: cleanText(enriched.imageUrl),
    imageKey: cleanText(now.image_key),
    artistImageKey: firstImageKey(now.artist_image_keys),
    artistImageKeys: Array.isArray(now.artist_image_keys) ? now.artist_image_keys.map(cleanText).filter(Boolean) : [],
    zoneId: zone.zone_id || "",
    zoneName: zone.display_name || "",
    state: zone.state || "",
    seekPosition: Number(now.seek_position || 0),
    isRadioProgram: Boolean(lookup.isRadioProgram),
    catalogEnrichmentAllowed: lookup.catalogEnrichmentAllowed !== false
  };
  return isNonContributoryPlay(track) ? null : track;
}

function groupCounts(items, keyFn, extraFn = () => ({})) {
  const map = new Map();
  for (const item of items) {
    const name = cleanText(keyFn(item));
    const key = normalize(name);
    if (!key) continue;
    const current = map.get(key) || { name, plays: 0, totalSeconds: 0 };
    current.plays += 1;
    current.totalSeconds += Number(item.lengthSeconds || 0);
    Object.assign(current, extraFn(item, current));
    map.set(key, current);
  }
  return [...map.values()].sort((left, right) => (
    right.plays - left.plays ||
    right.totalSeconds - left.totalSeconds ||
    left.name.localeCompare(right.name)
  ));
}

function topWeighted(map = {}, direction = 1, limit = 8) {
  return Object.values(map)
    .filter((entry) => direction > 0 ? Number(entry.score || 0) > 0 : Number(entry.score || 0) < 0)
    .sort((left, right) => direction * (Number(right.score || 0) - Number(left.score || 0)) || Number(right.up || 0) - Number(left.up || 0))
    .slice(0, limit);
}

function dedupePlays(plays = []) {
  const kept = [];
  for (const rawPlay of plays.sort((left, right) => Number(right.playedAt || 0) - Number(left.playedAt || 0))) {
    if (rawPlay.state && rawPlay.state !== "playing") continue;
    const play = normalizeStoredPlay(rawPlay);
    const duplicate = kept.find((candidate) => (
      candidate.zoneId === play.zoneId &&
      candidate.key === play.key &&
      Math.abs(Number(candidate.playedAt || 0) - Number(play.playedAt || 0)) < 10 * 60 * 1000
    ));
    if (!duplicate) kept.push(play);
  }
  return kept;
}

function normalizeStoredPlay(play = {}) {
  const artist = cleanText(play.artist);
  let title = cleanText(play.title);
  const suffix = ` - ${artist}`;
  if (artist && title.toLowerCase().endsWith(suffix.toLowerCase())) {
    title = cleanText(title.slice(0, -suffix.length));
  }
  return {
    ...play,
    title,
    artist,
    artistImageKey: cleanText(play.artistImageKey || firstImageKey(play.artistImageKeys)),
    artistImageKeys: Array.isArray(play.artistImageKeys) ? play.artistImageKeys.map(cleanText).filter(Boolean) : [],
    key: `${normalize(artist)}|${normalize(title)}`,
    isRadioProgram: Boolean(play.isRadioProgram),
    catalogEnrichmentAllowed: play.catalogEnrichmentAllowed !== false
  };
}

function tasteNarrative({ topArtists, topLabels, likedArtists, likedLabels, plays, discoveryCount, nowPlaying }) {
  const artistNames = likedArtists.length
    ? likedArtists.slice(0, 4).map((entry) => entry.name)
    : topArtists.slice(0, 4).map((entry) => entry.name);
  const labelNames = likedLabels.slice(0, 4).map((entry) => entry.name);
  const signals = [];

  if (artistNames.length) signals.push(`artist gravity around ${artistNames.join(", ")}`);
  if (labelNames.length) signals.push(`label pull from ${labelNames.join(", ")}`);
  if (discoveryCount) signals.push(`${discoveryCount} recent discovery candidates`);
  if (nowPlaying?.title) signals.push(`currently on ${nowPlaying.artist} - ${nowPlaying.title}`);

  if (!signals.length && !plays) {
    return "I do not have enough local history yet. Keep this app running while Roon plays, then use thumbs up/down on discoveries so the profile has real signal.";
  }

  const base = "Your current taste is leaning toward detailed progressive and melodic electronic music: hypnotic, deep, club-capable, and more focused on texture than big-room obviousness.";
  return signals.length ? `${base} The strongest signals are ${signals.join("; ")}.` : base;
}

class ListeningHistory {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "listening-history.json");
    this.maxEntries = Number(options.maxEntries || 1500);
    this.lastByZone = new Map();
    this.data = { plays: [] };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = { plays: dedupePlays(Array.isArray(parsed.plays) ? parsed.plays : []) };
    } catch {
      this.data = { plays: [] };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data.plays = this.data.plays
      .sort((left, right) => Number(right.playedAt || 0) - Number(left.playedAt || 0))
      .slice(0, this.maxEntries);
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  recordState(state = {}) {
    let changed = false;
    for (const zone of state.zones || []) {
      const track = trackFromZone(zone);
      if (!track || !track.key || track.key === "|") continue;

      const priorKey = this.lastByZone.get(track.zoneId);
      if (priorKey === track.key) continue;

      this.lastByZone.set(track.zoneId, track.key);
      const now = Date.now();
      const repeatWindowMs = Math.max(3 * 60 * 1000, Math.min(15 * 60 * 1000, Number(track.lengthSeconds || 0) * 1000));
      const duplicate = this.data.plays.find((play) => (
        play.zoneId === track.zoneId &&
        play.key === track.key &&
        now - Number(play.playedAt || 0) < repeatWindowMs
      ));
      if (duplicate) continue;

      this.data.plays.unshift({
        ...track,
        playedAt: now
      });
      changed = true;
    }
    if (changed) this.save();
  }

  report({ roonState = {}, tasteProfile, discoveryHistory } = {}) {
    this.load();
    const plays = this.data.plays || [];
    const contributoryPlays = plays.filter((play) => !isNonContributoryPlay(play));
    const ignoredRadioPlays = plays.length - contributoryPlays.length;
    const recentPlays = contributoryPlays.slice(0, 40);
    const topArtists = groupCounts(contributoryPlays, (play) => play.artist, (play, current) => ({
      artistImageKey: current.artistImageKey || play.artistImageKey || "",
      imageKey: current.imageKey || play.imageKey || ""
    })).slice(0, 10);
    const topTracks = groupCounts(contributoryPlays, (play) => `${play.artist} - ${play.title}`, (play) => ({
      artist: play.artist,
      title: play.title,
      imageKey: play.imageKey
    })).slice(0, 10);

    const activeDays = new Set(contributoryPlays.map((play) => new Date(Number(play.playedAt || 0)).toISOString().slice(0, 10))).size;
    const totalSeconds = contributoryPlays.reduce((sum, play) => sum + Number(play.lengthSeconds || 0), 0);
    const profile = tasteProfile?.read ? tasteProfile.read() : { feedback: {}, artists: {}, labels: {} };
    const likedArtists = topWeighted(profile.artists, 1, 8);
    const rejectedArtists = topWeighted(profile.artists, -1, 5);
    const likedLabels = topWeighted(profile.labels, 1, 8);
    const rejectedLabels = topWeighted(profile.labels, -1, 5);
    const discoveryCount = discoveryHistory?.entries?.size || 0;
    const nowPlaying = (roonState.zones || []).map(trackFromZone).find(Boolean) || null;

    return {
      updatedAt: new Date().toISOString(),
      metrics: {
        observedPlays: contributoryPlays.length,
        ignoredRadioPlays,
        activeDays,
        uniqueArtists: topArtists.length,
        uniqueTracks: topTracks.length,
        knownDurationSeconds: totalSeconds,
        feedbackCount: Object.keys(profile.feedback || {}).length,
        discoveryCount
      },
      nowPlaying: nowPlaying ? { ...nowPlaying, imageUrl: nowPlaying.imageUrl || imageUrl(nowPlaying.imageKey) } : null,
      topArtists: topArtists.map((artist) => ({
        ...artist,
        imageUrl: imageUrl(artist.artistImageKey || artist.imageKey)
      })),
      topTracks: topTracks.map((track) => ({ ...track, imageUrl: track.imageUrl || imageUrl(track.imageKey) })),
      likedArtists,
      rejectedArtists,
      likedLabels,
      rejectedLabels,
      recentPlays: recentPlays.map((play) => ({ ...play, imageUrl: play.imageUrl || imageUrl(play.imageKey) })),
      tasteNarrative: tasteNarrative({
        topArtists,
        topLabels: likedLabels,
        likedArtists,
        likedLabels,
        plays: contributoryPlays.length,
        discoveryCount,
        nowPlaying
      })
    };
  }
}

module.exports = {
  ListeningHistory,
  isNonContributoryPlay,
  trackFromZone
};
