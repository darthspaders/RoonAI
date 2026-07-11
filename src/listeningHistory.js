"use strict";

const fs = require("fs");
const path = require("path");
const {
  detectGenreTerms,
  detectTrackCharacteristics,
  detectVibeTerms
} = require("./musicOntology");
const { normalizeRating, ratingDelta } = require("./tasteProfile");

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
  const hasRadioLookup = Boolean(now.radio_lookup);
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
    imageKey: hasRadioLookup ? "" : cleanText(now.image_key),
    artistImageKey: hasRadioLookup ? "" : firstImageKey(now.artist_image_keys),
    artistImageKeys: hasRadioLookup ? [] : (Array.isArray(now.artist_image_keys) ? now.artist_image_keys.map(cleanText).filter(Boolean) : []),
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

function titleCase(value = "") {
  return cleanText(value).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function signedScore(value) {
  const rounded = Number(Number(value || 0).toFixed(1));
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function signalKey(value = "") {
  return normalize(value);
}

function addSignal(map, name, amount = 0, note = "") {
  const label = titleCase(name);
  const key = signalKey(label);
  const value = Number(amount || 0);
  if (!key || !value) return;
  const current = map.get(key) || {
    name: label,
    score: 0,
    count: 0,
    up: 0,
    down: 0,
    notes: new Map()
  };
  current.score += value;
  current.count += 1;
  if (value > 0) current.up += 1;
  if (value < 0) current.down += 1;
  if (note) current.notes.set(note, (current.notes.get(note) || 0) + 1);
  map.set(key, current);
}

function rankedSignals(map = new Map(), direction = 1, limit = 6) {
  return [...map.values()]
    .filter((entry) => direction > 0 ? entry.score > 0 : entry.score < 0)
    .sort((left, right) => (
      direction * (right.score - left.score) ||
      right.count - left.count ||
      left.name.localeCompare(right.name)
    ))
    .slice(0, limit)
    .map((entry) => {
      const topNote = [...entry.notes.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || "";
      return {
        name: entry.name,
        score: signedScore(entry.score),
        rawScore: Number(entry.score.toFixed(2)),
        count: entry.count,
        note: topNote || `${entry.up} positive, ${entry.down} negative`
      };
    });
}

function signalBaseName(value = "") {
  return normalize(cleanText(value).replace(/\s+(?:source|label|lane)$/i, ""));
}

function trackMemoryEntries(trackMemory = null) {
  if (trackMemory?.entries instanceof Map) return [...trackMemory.entries.values()];
  if (Array.isArray(trackMemory?.entries)) return trackMemory.entries;
  return [];
}

function memoryLookup(trackMemory = null) {
  const lookup = new Map();
  for (const entry of trackMemoryEntries(trackMemory)) {
    const keys = [
      cleanText(entry.key).toLowerCase(),
      cleanText(entry.tidal?.tidalUrl || entry.tidalUrl).toLowerCase(),
      `${normalize(entry.artist)}|${normalize(entry.title)}`
    ].filter(Boolean);
    for (const key of keys) lookup.set(key, entry);
  }
  return lookup;
}

function feedbackMatchKeys(entry = {}) {
  return [
    cleanText(entry.tidalUrl || entry.tidal?.tidalUrl).toLowerCase(),
    `${normalize(entry.artist)}|${normalize(entry.title)}`,
    cleanText(entry.key).toLowerCase()
  ].filter(Boolean);
}

function enrichedFeedbackEntries(profile = {}, trackMemory = null) {
  const lookup = memoryLookup(trackMemory);
  return Object.entries(profile.feedback || {}).map(([key, entry]) => {
    const directKeys = [cleanText(key).toLowerCase(), ...feedbackMatchKeys(entry)];
    const memory = directKeys.map((candidateKey) => lookup.get(candidateKey)).find(Boolean) || {};
    const rating = normalizeRating(entry.rating);
    return {
      ...memory,
      ...entry,
      rating,
      tasteScore: Number.isFinite(Number(entry.tasteScore)) ? Number(entry.tasteScore) : ratingDelta(rating),
      scoreBreakdown: memory.scoreBreakdown || entry.scoreBreakdown || null,
      durationMs: memory.durationMs || entry.durationMs || null,
      reason: cleanText(memory.reason || entry.reason),
      why: Array.isArray(memory.why) ? memory.why : [],
      discoverySource: cleanText(entry.discoverySource || memory.discoverySource),
      discoveryLane: cleanText(entry.discoveryLane || memory.discoveryLane),
      label: cleanText(entry.label || memory.label || memory.tidal?.label),
      isRadio: Boolean(entry.isRadio || memory.isRadio),
      isLiveRadio: Boolean(entry.isLiveRadio || memory.isLiveRadio),
      memoryMatched: Boolean(memory.artist || memory.title || memory.scoreBreakdown)
    };
  });
}

function termsFromTrack(entry = {}) {
  const breakdown = entry.scoreBreakdown || {};
  const text = [
    entry.artist,
    entry.title,
    entry.album,
    entry.label,
    entry.reason,
    ...(entry.why || [])
  ].join(" ");
  const vibeTerms = [
    ...(breakdown.vibeInference?.matchedTerms || []),
    ...detectVibeTerms(text, { limit: 8 }).terms
  ];
  const genreTerms = [
    ...(breakdown.genreInference?.inferredGenres || []),
    ...detectGenreTerms(text, { includeAliases: false, limit: 8 }).terms
  ];
  const characteristicTerms = [
    ...detectTrackCharacteristics(text, { limit: 8 }).terms
  ];
  return {
    vibes: Array.from(new Set(vibeTerms.map(cleanText).filter(Boolean))).slice(0, 8),
    genres: Array.from(new Set(genreTerms.map(cleanText).filter(Boolean))).slice(0, 8),
    characteristics: Array.from(new Set(characteristicTerms.map(cleanText).filter(Boolean))).slice(0, 8)
  };
}

function durationShape(entry = {}) {
  const minutes = Number(entry.durationMs || 0) / 60000;
  if (!minutes) return "";
  if (minutes >= 8) return "long-form 8+ min";
  if (minutes >= 6) return "extended 6-8 min";
  if (minutes >= 4) return "club-length 4-6 min";
  return "short/edit under 4 min";
}

function buildTasteDna({ profile = {}, contributoryPlays = [], trackMemory = null } = {}) {
  const feedback = enrichedFeedbackEntries(profile, trackMemory);
  const calibration = profile.calibration || {};
  const traits = new Map();
  const genres = new Map();
  const formats = new Map();
  const sources = new Map();
  const avoid = new Map();
  const ratingCounts = {};
  let positiveCount = 0;
  let negativeCount = 0;
  let radioFeedbackCount = 0;
  let detailedMemoryCount = 0;
  let positiveDurationMs = 0;
  let positiveDurationCount = 0;
  let negativeDurationMs = 0;
  let negativeDurationCount = 0;

  for (const entry of feedback) {
    const delta = Number(entry.tasteScore || ratingDelta(entry.rating) || 0);
    if (!delta) continue;
    ratingCounts[entry.rating] = Number(ratingCounts[entry.rating] || 0) + 1;
    if (delta > 0) positiveCount += 1;
    if (delta < 0) negativeCount += 1;
    if (entry.isRadio || entry.isLiveRadio || /^live radio$/i.test(entry.discoverySource)) radioFeedbackCount += 1;
    if (entry.scoreBreakdown) detailedMemoryCount += 1;

    const note = `${entry.rating} on ${[entry.artist, entry.title].filter(Boolean).join(" - ") || "track"}`;
    const terms = termsFromTrack(entry);
    for (const term of terms.vibes) addSignal(traits, term, delta, note);
    for (const term of terms.genres) addSignal(genres, term, delta, note);
    for (const term of terms.characteristics) addSignal(formats, term, delta * 0.75, note);
    const shape = durationShape(entry);
    if (shape) addSignal(formats, shape, delta, note);

    if (entry.discoverySource) addSignal(sources, entry.discoverySource, delta, note);
    if (entry.discoveryLane) addSignal(sources, `${entry.discoveryLane} lane`, delta * 0.75, note);
    if (entry.label) addSignal(sources, `${entry.label} label`, delta * 0.75, note);

    if (delta < 0) {
      if (entry.discoverySource) addSignal(avoid, `${entry.discoverySource} source`, delta, note);
      if (entry.label) addSignal(avoid, `${entry.label} label`, delta, note);
      for (const term of [...terms.vibes, ...terms.genres].slice(0, 4)) addSignal(avoid, term, delta * 0.75, note);
    }

    const duration = Number(entry.durationMs || 0);
    if (duration && delta > 0) {
      positiveDurationMs += duration;
      positiveDurationCount += 1;
    } else if (duration && delta < 0) {
      negativeDurationMs += duration;
      negativeDurationCount += 1;
    }
  }

  for (const source of calibration.sources || []) {
    const sourceMisses = Number(source.modelMisses || 0) + Number(source.promptMismatches || 0);
    const sourceLongShots = Number(source.likedLongShots || 0);
    if (Number(source.likedLongShots || 0) > 0) {
      addSignal(sources, source.source || source.name, Number(source.likedLongShots) * 1.5, `${source.likedLongShots}/${source.total} liked long shots`);
    }
    if (sourceMisses > sourceLongShots) {
      addSignal(avoid, `${source.source || source.name} source`, -sourceMisses, `${source.modelMisses || 0}/${source.total || 0} model misses`);
    }
  }

  for (const label of calibration.labels || []) {
    const labelMisses = Number(label.modelMisses || 0) + Number(label.promptMismatches || 0);
    const labelLongShots = Number(label.likedLongShots || 0);
    if (Number(label.likedLongShots || 0) > 0) {
      addSignal(sources, `${label.label || label.name} label`, Number(label.likedLongShots) * 1.75, `${label.likedLongShots}/${label.total} liked long shots`);
    }
    if (labelMisses > labelLongShots) {
      addSignal(avoid, `${label.label || label.name} label`, -labelMisses, `${label.modelMisses || 0}/${label.total || 0} model misses`);
    }
  }

  const avgPositiveMinutes = positiveDurationCount ? Number((positiveDurationMs / positiveDurationCount / 60000).toFixed(1)) : 0;
  const avgNegativeMinutes = negativeDurationCount ? Number((negativeDurationMs / negativeDurationCount / 60000).toFixed(1)) : 0;
  const depthScore = Math.min(100, Math.round(
    Math.min(50, feedback.length) +
    Math.min(25, detailedMemoryCount * 2) +
    Math.min(15, radioFeedbackCount * 3) +
    Math.min(10, Number(calibration.likedLongShots || 0) * 2)
  ));
  const traitSignals = rankedSignals(traits, 1, 6);
  const genreSignals = rankedSignals(genres, 1, 6);
  const formatSignals = rankedSignals(formats, 1, 6);
  const sourceSignals = rankedSignals(sources, 1, 6);
  const positiveBases = new Set([
    ...traitSignals,
    ...genreSignals,
    ...formatSignals,
    ...sourceSignals
  ].map((entry) => signalBaseName(entry.name)).filter(Boolean));
  const avoidSignals = rankedSignals(avoid, -1, 10)
    .filter((entry) => !positiveBases.has(signalBaseName(entry.name)))
    .slice(0, 6);

  return {
    traits: traitSignals,
    genres: genreSignals,
    formats: formatSignals,
    sources: sourceSignals,
    avoid: avoidSignals,
    confidence: {
      depthScore,
      depthLabel: depthScore >= 75 ? "Deep" : (depthScore >= 45 ? "Growing" : "Early"),
      feedbackCount: feedback.length,
      positiveCount,
      negativeCount,
      detailedMemoryCount,
      radioFeedbackCount,
      likedLongShots: Number(calibration.likedLongShots || 0),
      observedPlays: contributoryPlays.length,
      avgPositiveMinutes,
      avgNegativeMinutes,
      ratingCounts
    }
  };
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

function tasteNarrative({ topArtists, topLabels, likedArtists, likedLabels, plays, discoveryCount, nowPlaying, tasteDna }) {
  const artistNames = likedArtists.length
    ? likedArtists.slice(0, 4).map((entry) => entry.name)
    : topArtists.slice(0, 4).map((entry) => entry.name);
  const labelNames = likedLabels.slice(0, 4).map((entry) => entry.name);
  const traitNames = (tasteDna?.traits || []).slice(0, 4).map((entry) => entry.name.toLowerCase());
  const genreNames = (tasteDna?.genres || []).slice(0, 3).map((entry) => entry.name.toLowerCase());
  const formatNames = (tasteDna?.formats || []).slice(0, 2).map((entry) => entry.name.toLowerCase());
  const sourceNames = (tasteDna?.sources || []).slice(0, 3).map((entry) => entry.name);
  const avoidNames = (tasteDna?.avoid || []).slice(0, 2).map((entry) => entry.name.toLowerCase());
  const confidence = tasteDna?.confidence || {};
  const signals = [];

  if (artistNames.length) signals.push(`artist gravity around ${artistNames.join(", ")}`);
  if (labelNames.length) signals.push(`label pull from ${labelNames.join(", ")}`);
  if (traitNames.length) signals.push(`traits like ${traitNames.join(", ")}`);
  if (formatNames.length) signals.push(`format bias toward ${formatNames.join(" and ")}`);
  if (sourceNames.length) signals.push(`discovery sources that have worked: ${sourceNames.join(", ")}`);
  if (discoveryCount) signals.push(`${discoveryCount} recent discovery candidates`);
  if (nowPlaying?.title) signals.push(`currently on ${nowPlaying.artist} - ${nowPlaying.title}`);

  if (!signals.length && !plays) {
    return "I do not have enough local history yet. Keep this app running while Roon plays, then use thumbs up/down on discoveries so the profile has real signal.";
  }

  const base = confidence.feedbackCount
    ? `Taste depth is ${String(confidence.depthLabel || "growing").toLowerCase()} from ${confidence.feedbackCount} ratings, ${confidence.detailedMemoryCount || 0} scored memories, and ${confidence.radioFeedbackCount || 0} radio feedback signals.`
    : "Taste depth is still based mostly on listening history, not enough explicit ratings.";
  const lane = genreNames.length
    ? ` The strongest lane evidence points to ${genreNames.join(", ")}.`
    : " The genre lane is still mostly inferred from artists and labels.";
  const caution = avoidNames.length
    ? ` Be careful with ${avoidNames.join(" and ")}.`
    : "";
  return signals.length ? `${base}${lane} Strongest signals: ${signals.join("; ")}.${caution}` : `${base}${lane}${caution}`;
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

  report({ roonState = {}, tasteProfile, discoveryHistory, trackMemory } = {}) {
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
    const tasteDna = buildTasteDna({ profile, contributoryPlays, trackMemory });

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
      tasteDna,
      recentPlays: recentPlays.map((play) => ({ ...play, imageUrl: play.imageUrl || imageUrl(play.imageKey) })),
      tasteNarrative: tasteNarrative({
        topArtists,
        topLabels: likedLabels,
        likedArtists,
        likedLabels,
        plays: contributoryPlays.length,
        discoveryCount,
        nowPlaying,
        tasteDna
      })
    };
  }
}

module.exports = {
  ListeningHistory,
  isNonContributoryPlay,
  trackFromZone
};
