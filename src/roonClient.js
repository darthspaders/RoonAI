"use strict";

const EventEmitter = require("events");
const RoonApi = require("node-roon-api");
const RoonApiBrowse = require("node-roon-api-browse");
const RoonApiStatus = require("node-roon-api-status");
const RoonApiTransport = require("node-roon-api-transport");
const { extractYearSearchTerms: extractSharedYearSearchTerms } = require("./yearRange");

const STATE_UPDATE_DEBOUNCE_MS = 1000;
const SEEK_UPDATE_EMIT_MS = 2000;

function callRoon(fn) {
  return new Promise((resolve, reject) => {
    fn((error, body) => {
      if (error) reject(new Error(String(error)));
      else resolve(body);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrorMessage(body) {
  return body?.action === "message" && body.is_error;
}

function actionTitle(item) {
  return String(item?.title || "").toLowerCase();
}

function actionRank(item, mode) {
  if (item?.hint !== "action" || !item.item_key) return 0;
  const title = actionTitle(item);

  if (mode === "queue") {
    if (/\badd\b.*\bqueue\b/.test(title)) return 100;
    if (/^(queue|add to queue|add to play queue)$/.test(title)) return 95;
    if (/\bqueue\b/.test(title) && !/^play queue$/.test(title)) return 85;
    if (/\badd\s+next\b|\badd\s+to\s+next\b|\badd\s+after\b/.test(title)) return 70;
    return 0;
  }

  if (mode === "next") {
    if (/\badd\s+next\b|\badd\s+to\s+next\b|\badd\s+after\b|\bplay\s+next\b/.test(title)) return 100;
    if (/\badd\b.*\bqueue\b/.test(title)) return 70;
    if (/^(queue|add to queue|add to play queue)$/.test(title)) return 60;
    if (/\bqueue\b/.test(title) && !/^play queue$/.test(title)) return 50;
    return 0;
  }

  if (/^(play|play now|play from here)$/.test(title)) return 100;
  if (/\bplay\b/.test(title) && !/\bplay\s+queue\b/.test(title)) return 80;
  if (/\badd\s+to\s+queue\b|\bqueue\b|\badd\s+next\b/.test(title)) return 20;
  return 0;
}

function preferredAction(items, mode = "play") {
  return (items || [])
    .map((item) => ({ item, rank: actionRank(item, mode) }))
    .filter((candidate) => candidate.rank > 0)
    .sort((left, right) => right.rank - left.rank)[0]?.item || null;
}

function itemText(item) {
  return `${item?.title || ""} ${item?.subtitle || ""}`.toLowerCase();
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanLookupText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function requestUsesNowPlayingAsSeed(options = {}) {
  const request = cleanLookupText(options.request);
  const text = normalizeLookupText(`${options.request || ""} ${options.reference || ""}`);
  if (!request && !cleanLookupText(options.genres)) return true;
  return /\b(?:now playing|current roon|current track|current song|what is playing|this track|this song|use current|like this|like what is playing|around what is playing)\b/.test(text);
}

function splitLookupArtists(value) {
  return String(value || "")
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map((part) => normalizeLookupText(part))
    .filter((part) => part && part.length > 1);
}

function splitLookupArtistAliases(value) {
  const artist = cleanLookupText(value);
  if (!artist) return [];

  return Array.from(new Set([
    artist,
    ...artist
      .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
      .map(cleanLookupText)
      .filter((part) => part && part.length > 1)
  ]));
}

function stripSafeTitleSuffixes(value) {
  return String(value || "")
    .replace(/\s*[\[(](?:feat\.?|featuring)\s+[^)\]]+[\])]/gi, "")
    .replace(/\s*[\[(](?:original mix|original version|original|extended mix|extended version)[\])]/gi, "")
    .trim();
}

function normalizeRemixDescriptors(value) {
  return stripSafeTitleSuffixes(value)
    .replace(/\s*[\[(]([^)\]]+?)\s+(?:extended\s+remix|dub\s+mix|remix|rework|rerub)[\])]/gi, " ($1 remix)")
    .trim();
}

function hasVersionDescriptor(value) {
  return /\b(?:remix|mix|rework|rerub|dub|edit|version)\b/i.test(String(value || ""));
}

function stripVersionDescriptors(value) {
  return stripSafeTitleSuffixes(value)
    .replace(/\s*[\[(][^)\]]*\b(?:remix|mix|rework|rerub|dub|edit|version)\b[^)\]]*[\])]/gi, "")
    .trim();
}

function stripGuestCredits(value) {
  return String(value || "")
    .replace(/\s*[\[(]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[\])]/gi, " ")
    .replace(/\s+-\s+(?:feat\.?|ft\.?|featuring|with)\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lookupTrack(track = {}) {
  const tidal = track.tidal || {};
  return {
    ...track,
    title: cleanLookupText(tidal.title || track.title),
    artist: cleanLookupText(tidal.artist || track.artist),
    album: cleanLookupText(tidal.album || track.album),
    durationMs: Number(tidal.durationMs || track.durationMs || 0),
    tidalUrl: cleanLookupText(tidal.tidalUrl || track.tidalUrl)
  };
}

function createRoonSearchQueries(track = {}) {
  const lookup = lookupTrack(track);
  const title = cleanLookupText(lookup.title);
  const safeTitle = cleanLookupText(stripSafeTitleSuffixes(title));
  const versionlessTitle = cleanLookupText(stripVersionDescriptors(title));
  const normalizedRemixTitle = cleanLookupText(normalizeRemixDescriptors(title));
  const guestlessTitle = cleanLookupText(stripGuestCredits(title));
  const guestlessVersionlessTitle = cleanLookupText(stripVersionDescriptors(guestlessTitle));
  const album = normalizeLookupText(lookup.album) === normalizeLookupText(title) ? "" : cleanLookupText(lookup.album);
  const artists = splitLookupArtistAliases(lookup.artist).slice(0, 4);
  const titles = Array.from(new Set([
    title,
    safeTitle,
    normalizedRemixTitle,
    versionlessTitle,
    guestlessTitle,
    guestlessVersionlessTitle
  ].map(cleanLookupText).filter(Boolean)));
  const searches = [];

  for (const candidateTitle of titles) {
    for (const artist of artists) {
      searches.push(`${artist} ${candidateTitle}`);
      searches.push(`${candidateTitle} ${artist}`);
    }
  }

  if (album) {
    for (const artist of artists.slice(0, 2)) {
      searches.push(`${artist} ${title} ${album}`);
      searches.push(`${title} ${artist} ${album}`);
    }
  }
  if (album) {
    for (const artist of artists.slice(0, 1)) {
      searches.push(`${artist} ${versionlessTitle || title} ${album}`);
    }
  }
  if (title) searches.push(title);
  if (versionlessTitle && versionlessTitle !== title) searches.push(versionlessTitle);

  return Array.from(new Set(searches.map(cleanLookupText).filter(Boolean))).slice(0, 14);
}

function splitDiscoveryTerms(value) {
  return String(value || "")
    .split(/[,;/|]+|\s+\+\s+/)
    .map(cleanLookupText)
    .filter((part) => part && part.length > 2)
    .slice(0, 8);
}

function pruneBroadDiscoveryTerms(terms = []) {
  const normalized = new Set(terms.map(normalizeLookupText));
  const remove = new Set();
  function removeTerms(values = []) {
    for (const value of values) remove.add(normalizeLookupText(value));
  }

  if (normalized.has("tech house")) removeTerms(["house", "deep house", "melodic house", "organic house"]);
  if (normalized.has("progressive house")) removeTerms(["house"]);
  if (normalized.has("melodic house")) removeTerms(["house"]);
  if (normalized.has("deep house")) removeTerms(["house"]);
  if (normalized.has("melodic techno")) removeTerms(["techno"]);
  if (normalized.has("dark ambient")) removeTerms(["ambient", "downtempo"]);

  return terms.filter((term) => !remove.has(normalizeLookupText(term)));
}

function extractReferenceTracks(value, limit = 80) {
  const tracks = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const text = cleanLookupText(line);
    if (!text) continue;
    const match = text.match(/^(.+?)\s+-\s+(.+)$/);
    if (match) {
      tracks.push({
        artist: cleanLookupText(match[1]),
        title: cleanLookupText(match[2])
      });
    } else if (text.length <= 90) {
      tracks.push({ artist: "", title: text });
    }
    if (tracks.length >= limit) break;
  }
  return tracks;
}

function extractYearSearchTerms(value) {
  return extractSharedYearSearchTerms(value);
}

function derivedGenreTerms(options = {}) {
  const text = normalizeLookupText(`${options.request || ""} ${options.genres || ""}`);
  const terms = splitDiscoveryTerms(options.genres);
  const knownGenres = [
    "progressive house",
    "progressive trance",
    "melodic house",
    "melodic techno",
    "tech house",
    "minimal tech house",
    "deep house",
    "organic house",
    "dark ambient",
    "downtempo",
    "cinematic electronic",
    "breakbeat",
    "breaks",
    "underground breaks",
    "new wave",
    "synth pop",
    "synthwave",
    "disco",
    "house",
    "trance",
    "techno",
    "ambient",
    "rock",
    "jazz",
    "80s"
  ];
  for (const genre of knownGenres) {
    if (text.includes(normalizeLookupText(genre))) terms.push(genre);
  }
  if (!terms.length && options.request) terms.push(cleanLookupText(options.request).slice(0, 80));
  return Array.from(new Set(pruneBroadDiscoveryTerms(terms).map(cleanLookupText).filter(Boolean))).slice(0, 8);
}

function createRoonDiscoveryQueries(options = {}) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planQueries = Array.isArray(plan.searchQueries) ? plan.searchQueries.map(cleanLookupText).filter(Boolean) : [];
  const planArtists = Array.from(new Set([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ].map(cleanLookupText).filter(Boolean))).slice(0, 24);
  const planLabels = Array.isArray(plan.candidateLabels) ? plan.candidateLabels.map(cleanLookupText).filter(Boolean).slice(0, 24) : [];
  const planGenres = Array.isArray(plan.targetGenres) ? plan.targetGenres.map(cleanLookupText).filter(Boolean).slice(0, 12) : [];
  const planVibes = Array.isArray(plan.vibeTerms) ? plan.vibeTerms.map(cleanLookupText).filter(Boolean).slice(0, 12) : [];
  const request = cleanLookupText(options.request);
  const genres = Array.from(new Set([...planGenres, ...derivedGenreTerms(options)].map(cleanLookupText).filter(Boolean))).slice(0, 12);
  const moods = Array.from(new Set([...planVibes, ...splitDiscoveryTerms(options.mood)].map(cleanLookupText).filter(Boolean))).slice(0, 16);
  const years = extractYearSearchTerms(options.years || request);
  const references = extractReferenceTracks(options.reference, 100);
  const seedArtists = Array.from(new Set([
    ...planArtists,
    ...(requestUsesNowPlayingAsSeed(options) ? [options.nowPlaying?.artist] : []),
    ...references.map((track) => track.artist)
  ].map(cleanLookupText).filter(Boolean))).slice(0, 18);
  const progressiveText = normalizeLookupText(`${request} ${genres.join(" ")}`);
  const wantsProgressive = /\bprogressive\b/.test(progressiveText);
  const retroText = normalizeLookupText(`${request} ${moods.join(" ")}`);
  const wantsRetro = /\b(?:80s|eighties|new wave|synth pop|synthwave|retro)\b/.test(retroText);
  const sceneArtists = wantsProgressive ? [
    "Hernan Cattaneo",
    "Nick Warren",
    "Guy J",
    "Khen",
    "Dmitry Molosh",
    "GMJ",
    "Matter",
    "Hobin Rude",
    "Kamilo Sanclemente",
    "Roger Martinez",
    "Simone Vitullo",
    "Simos Tagias",
    "Ezequiel Arias",
    "Marsh",
    "Lane 8",
    "Joris Voorn"
  ] : [];
  const sceneLabels = wantsProgressive ? [
    "Sudbeat",
    "Mango Alley",
    "Movement Recordings",
    "Proton Music",
    "Meanwhile",
    "The Soundgarden",
    "Bedrock",
    "Anjunadeep",
    "This Never Happened",
    "Selador"
  ] : [];
  const retroTerms = wantsRetro ? ["synthwave", "new wave", "synth pop", "80s", "retro", "nu disco"] : [];
  const queries = [];

  function add(value) {
    const query = cleanLookupText(value);
    if (query && query.length >= 3) queries.push(query);
  }

  for (const query of planQueries.slice(0, 18)) add(query);

  for (const artist of seedArtists.slice(0, 12)) {
    for (const genre of genres.slice(0, 3)) add(`${artist} ${genre}`);
    for (const mood of moods.slice(0, 2)) add(`${artist} ${mood}`);
    if (!genres.length) add(artist);
  }

  for (const artist of sceneArtists.slice(0, 12)) {
    for (const genre of genres.slice(0, 2)) add(`${artist} ${genre}`);
    for (const year of years.slice(0, 2)) add(`${artist} ${year}`);
  }

  for (const label of sceneLabels.slice(0, 10)) {
    for (const genre of genres.slice(0, 2)) add(`${label} ${genre}`);
    for (const year of years.slice(0, 2)) add(`${label} ${year}`);
  }

  for (const label of planLabels.slice(0, 12)) {
    for (const genre of genres.slice(0, 3)) add(`${label} ${genre}`);
    for (const mood of moods.slice(0, 2)) add(`${label} ${mood}`);
    for (const year of years.slice(0, 2)) add(`${label} ${year}`);
    add(label);
  }

  for (const track of references.slice(0, 12)) {
    for (const genre of genres.slice(0, 2)) add(`${track.artist || track.title} ${genre}`);
  }

  for (const genre of genres) {
    for (const mood of moods.slice(0, 4)) add(`${genre} ${mood}`);
    for (const retro of retroTerms.slice(0, 4)) add(`${genre} ${retro}`);
    for (const year of years.slice(0, 3)) add(`${genre} ${year}`);
    add(genre);
  }

  add(request);
  add(cleanLookupText(`${request} ${options.genres || ""} ${options.mood || ""}`));

  return Array.from(new Set(queries.map(cleanLookupText).filter(Boolean))).slice(0, 72);
}

function createModelCandidateQueries(options = {}) {
  const candidates = Array.isArray(options.llmCandidates) ? options.llmCandidates : [];
  const queries = [];

  function add(value) {
    const query = cleanLookupText(value);
    if (query && query.length >= 3) queries.push(query);
  }

  for (const candidate of candidates) {
    const artist = cleanLookupText(candidate.artist);
    const title = cleanLookupText(candidate.title);
    const year = cleanLookupText(candidate.year);
    if (artist && title) {
      add(`${artist} ${title}`);
      add(`${title} ${artist}`);
      if (year) add(`${artist} ${title} ${year}`);
    } else {
      add(artist || title);
    }
  }

  return Array.from(new Set(queries.map(cleanLookupText).filter(Boolean))).slice(0, 80);
}

function roonDiscoveryKey(track = {}) {
  return `${normalizeLookupText(track.artist)}|${normalizeLookupText(track.title)}`;
}

const DISCOVERY_ANCHOR_ARTISTS = [
  "Hernan Cattaneo",
  "Nick Warren",
  "Guy J",
  "Guy Mantzur",
  "Khen",
  "Dmitry Molosh",
  "GMJ",
  "Matter",
  "Hobin Rude",
  "Kamilo Sanclemente",
  "Roger Martinez",
  "Simos Tagias",
  "Ezequiel Arias",
  "Marsh",
  "Lane 8",
  "Joris Voorn",
  "YOTTO",
  "Tinlicker"
];

function queryAnchorArtistMismatch(track = {}, query = "") {
  const queryText = normalizeLookupText(query);
  if (!queryText) return false;
  const trackText = normalizeLookupText(`${track.artist || ""} ${track.title || ""} ${track.album || ""}`);
  return DISCOVERY_ANCHOR_ARTISTS.some((artist) => {
    const anchor = normalizeLookupText(artist);
    return queryText.includes(anchor) && !trackText.includes(anchor);
  });
}

function isRoonDiscoveryNoise(track = {}) {
  const raw = `${track.artist || ""} ${track.title || ""} ${track.album || ""}`;
  const text = normalizeLookupText(raw);
  const album = normalizeLookupText(track.album);
  if (!track.title || !track.artist) return true;
  if (track.title.length > 150 || track.artist.length > 120) return true;
  if (/\b(?:top\s*\d+|chart hits?|playlist|background music|soundify|workout|motivation|study music|sleep music|relax(?:ing)? music|party mix|dj mix\s*\d+\s*hr|vol\s*\d+|ultimate .* anthems?|best .* hits?)\b/.test(text)) return true;
  if (/^(?:progressive house|deep house|melodic house|organic house|techno house|progressive trance|edm|electronic dance music)\s*(?:20\d{2})?(?:\s*vol(?:ume)?\s*\d+)?$/.test(album)) return true;
  if (/\b(?:melodic house|deep house|progressive house|electronic dance music|techno house|soundify background music|easy to dance music)\b/.test(normalizeLookupText(track.artist))) return true;
  return false;
}

function searchTrackFromItem(item = {}, query = "") {
  const title = cleanLookupText(item.title);
  const subtitle = cleanLookupText(item.subtitle);
  if (!title || item.hint === "header" || item.hint === "action") return null;
  if (/^(tracks?|songs?|albums?|artists?|compositions?|playlists?|genres?)$/i.test(title)) return null;
  if (item.hint === "list" && /\b\d+\s+results?\b/i.test(subtitle)) return null;

  let artist = subtitle;
  let album = "";
  const parts = subtitle.split(/\s+-\s+/).map(cleanLookupText).filter(Boolean);
  if (parts.length >= 2) {
    artist = parts[0];
    album = parts.slice(1).join(" - ");
  }

  const track = {
    title,
    artist,
    album,
    imageKey: item.image_key || "",
    query,
    discoverySource: "Roon search",
    verificationSource: "roon",
    roon: {
      verified: true,
      match: itemSummary(item),
      sourceQuery: query,
      searchItemKey: item.item_key || ""
    }
  };

  if (queryAnchorArtistMismatch(track, query)) return null;
  return isRoonDiscoveryNoise(track) ? null : track;
}

function titleVariants(value) {
  const variants = new Set();
  const normalized = normalizeLookupText(value);
  const stripped = normalizeLookupText(stripSafeTitleSuffixes(value));
  const remixNormalized = normalizeLookupText(normalizeRemixDescriptors(value));
  if (normalized) variants.add(normalized);
  if (stripped) variants.add(stripped);
  if (remixNormalized) variants.add(remixNormalized);
  return variants;
}

function titleMatchesExactly(track, item) {
  const lookup = lookupTrack(track);
  const targetVariants = titleVariants(lookup.title);
  const actualVariants = titleVariants(item?.title);
  if ([...targetVariants].some((variant) => actualVariants.has(variant))) return true;

  const targetBase = normalizeLookupText(stripVersionDescriptors(lookup.title));
  const actualBase = normalizeLookupText(stripVersionDescriptors(item?.title));
  const targetHasVersion = hasVersionDescriptor(lookup.title);
  const actualHasVersion = hasVersionDescriptor(item?.title);

  if (!targetHasVersion && actualHasVersion) return false;
  return Boolean(
    targetBase &&
    targetBase === actualBase &&
    targetHasVersion &&
    !actualHasVersion
  );
}

function artistMatchInfo(track, item) {
  const lookup = lookupTrack(track);
  const artists = splitLookupArtists(lookup.artist);
  const subtitle = normalizeLookupText(item?.subtitle);
  if (!artists.length || !subtitle) return { matched: 0, total: artists.length, ratio: 0 };

  const matched = artists.filter((artist) => (
    subtitle === artist ||
    subtitle.includes(` ${artist} `) ||
    subtitle.startsWith(`${artist} `) ||
    subtitle.endsWith(` ${artist}`)
  )).length;

  return { matched, total: artists.length, ratio: matched / artists.length };
}

function artistMatches(track, item) {
  const info = artistMatchInfo(track, item);
  if (!info.total) return false;
  if (info.total === 1) return info.matched === 1;
  return info.matched >= 1 && info.ratio >= 0.3;
}

function albumMatches(track, item) {
  const lookup = lookupTrack(track);
  const album = normalizeLookupText(lookup.album);
  const title = normalizeLookupText(lookup.title);
  if (!album || album === title) return false;
  const subtitle = normalizeLookupText(item?.subtitle);
  return Boolean(subtitle && subtitle.includes(album));
}

function matchScore(track, item) {
  const lookup = lookupTrack(track);
  const title = normalizeLookupText(lookup.title);
  const itemTitle = normalizeLookupText(item?.title);
  const titleExact = titleMatchesExactly(track, item);
  const artistInfo = artistMatchInfo(track, item);

  let score = 0;
  if (titleExact) score += 12;
  else if (title && itemTitle.includes(title)) score += 2;

  if (artistInfo.matched) score += Math.round(8 * artistInfo.ratio);
  if (albumMatches(track, item)) score += 2;

  return score;
}

function isVerifiedMatch(track, item) {
  return titleMatchesExactly(track, item) && artistMatches(track, item);
}

function itemSummary(item) {
  return {
    title: item?.title,
    subtitle: item?.subtitle,
    imageKey: item?.image_key,
    hint: item?.hint,
    key: item?.item_key || "",
    hasKey: Boolean(item?.item_key)
  };
}

function queueItemSummary(item = {}) {
  const nowPlaying = item.now_playing || item.track || item;
  const title = nowPlaying.title || nowPlaying.one_line?.line1 || nowPlaying.two_line?.line1 || item.title || "";
  const subtitle = nowPlaying.subtitle || nowPlaying.artist || nowPlaying.two_line?.line2 || item.subtitle || "";
  const album = nowPlaying.album || nowPlaying.three_line?.line3 || item.album || "";
  return {
    id: item.queue_item_id || item.queue_id || item.item_id || item.item_key || "",
    title,
    subtitle,
    album,
    imageKey: nowPlaying.image_key || item.image_key || "",
    length: nowPlaying.length || item.length || null
  };
}

function queueSignature(items = []) {
  return JSON.stringify((items || []).map((item) => ({
    id: item.id || "",
    title: item.title || "",
    subtitle: item.subtitle || "",
    album: item.album || "",
    imageKey: item.imageKey || "",
    length: item.length || ""
  })));
}

function queueItemsFromMessage(msg = {}) {
  for (const key of ["items", "queue", "queue_items", "items_added", "items_changed"]) {
    if (Array.isArray(msg[key])) return msg[key];
  }
  return [];
}

function queueItemId(item = {}) {
  return String(item.id || item.queue_item_id || item.queue_id || item.item_id || item.item_key || "");
}

function changeItems(change = {}) {
  if (Array.isArray(change.items)) return change.items;
  if (Array.isArray(change.queue_items)) return change.queue_items;
  if (Array.isArray(change.items_added)) return change.items_added;
  if (change.item) return [change.item];
  if (change.queue_item) return [change.queue_item];
  if (change.now_playing || change.track || change.title || change.queue_item_id) return [change];
  return [];
}

function applyQueueChanges(previousItems = [], changes = []) {
  const items = previousItems.slice();
  for (const change of changes || []) {
    const action = String(change.operation || change.op || change.action || change.type || "").toLowerCase();
    const incoming = changeItems(change).map(queueItemSummary).filter((item) => item.title || item.subtitle);
    const index = Number.isFinite(Number(change.index ?? change.offset ?? change.position))
      ? Math.max(0, Math.min(items.length, Number(change.index ?? change.offset ?? change.position)))
      : -1;
    const removeCount = Math.max(1, Number(change.count || incoming.length || 1));
    const id = queueItemId(change.item || change.queue_item || change);

    if (/remove|delete/.test(action)) {
      const found = id ? items.findIndex((item) => queueItemId(item) === id) : -1;
      if (found >= 0) items.splice(found, removeCount);
      else if (index >= 0) items.splice(index, removeCount);
      continue;
    }

    if (/replace|update|change|modify/.test(action)) {
      const found = id ? items.findIndex((item) => queueItemId(item) === id) : -1;
      const target = found >= 0 ? found : index;
      if (target >= 0 && incoming.length) items.splice(target, Math.max(1, removeCount), ...incoming);
      continue;
    }

    if (/insert|add/.test(action) || incoming.length) {
      const target = index >= 0 ? index : items.length;
      if (incoming.length) items.splice(target, 0, ...incoming);
    }
  }
  return items;
}

function isBrowseItem(item) {
  return Boolean(item?.item_key && item.hint !== "header" && item.hint !== "action");
}

function playlistTrackFromItem(item = {}) {
  const title = String(item.title || "").trim();
  const subtitle = String(item.subtitle || "").trim();
  if (!title || item.hint === "header" || item.hint === "action") return null;

  let artist = subtitle;
  let album = "";
  const parts = subtitle.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    artist = parts[0];
    album = parts.slice(1).join(" - ");
  }

  return {
    title,
    artist,
    album,
    imageKey: item.image_key || "",
    roon: itemSummary(item)
  };
}

class RoonClient extends EventEmitter {
  constructor() {
    super();
    this.core = null;
    this.transport = null;
    this.browse = null;
    this.status = null;
    this.zones = new Map();
    this.playlistsSession = null;
    this.queues = new Map();
    this.queueSubscriptions = new Set();
    this.queueSignatures = new Map();
    this.zoneEmitTimer = null;
    this.lastSeekEmitAt = 0;
  }

  start() {
    this.roon = new RoonApi({
      extension_id: "com.local.roon-ai",
      display_name: "The Rabbit Hole",
      display_version: "0.1.0",
      publisher: "Local",
      email: "local@example.invalid",
      website: "http://localhost",
      core_paired: (core) => this.handlePaired(core),
      core_unpaired: (core) => this.handleUnpaired(core)
    });

    this.status = new RoonApiStatus(this.roon);
    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      provided_services: [this.status]
    });
    this.status.set_status("Waiting for Roon authorization", false);
    this.roon.start_discovery();
  }

  handlePaired(core) {
    this.core = core;
    this.transport = core.services.RoonApiTransport;
    this.browse = core.services.RoonApiBrowse;
    this.status.set_status(`Connected to ${core.display_name}`, false);

    this.transport.subscribe_zones((cmd, data) => {
      let contentChanged = false;
      let seekChanged = false;

      if (cmd === "Subscribed") {
        this.zones.clear();
        for (const zone of data.zones || []) {
          this.zones.set(zone.zone_id, zone);
          this.subscribeQueue(zone.zone_id);
        }
        contentChanged = true;
      }
      if (cmd === "Changed") {
        for (const zone of data.zones_added || []) {
          this.zones.set(zone.zone_id, zone);
          this.subscribeQueue(zone.zone_id);
          contentChanged = true;
        }
        for (const zone of data.zones_changed || []) {
          this.zones.set(zone.zone_id, {
            ...(this.zones.get(zone.zone_id) || {}),
            ...zone
          });
          this.subscribeQueue(zone.zone_id);
          contentChanged = true;
        }
        for (const seek of data.zones_seek_changed || []) {
          const zone = this.zones.get(seek.zone_id);
          if (!zone) continue;
          if (zone.now_playing && Object.prototype.hasOwnProperty.call(seek, "seek_position")) {
            zone.now_playing.seek_position = seek.seek_position;
          }
          if (Object.prototype.hasOwnProperty.call(seek, "queue_items_remaining")) {
            zone.queue_items_remaining = seek.queue_items_remaining;
          }
          if (Object.prototype.hasOwnProperty.call(seek, "queue_time_remaining")) {
            zone.queue_time_remaining = seek.queue_time_remaining;
          }
          seekChanged = true;
        }
        for (const zone of data.zones_removed || []) {
          this.zones.delete(zone.zone_id);
          this.queues.delete(zone.zone_id);
          this.queueSignatures.delete(zone.zone_id);
          contentChanged = true;
        }
      }
      this.scheduleZonesEmit({ contentChanged, seekChanged });
    });

    this.scheduleZonesEmit({ contentChanged: true });
  }

  handleUnpaired() {
    this.core = null;
    this.transport = null;
    this.browse = null;
    this.zones.clear();
    this.queues.clear();
    this.queueSubscriptions.clear();
    this.queueSignatures.clear();
    this.cancelZonesEmit();
    this.status?.set_status("Disconnected from Roon", true);
    this.emitZonesNow();
  }

  cancelZonesEmit() {
    if (this.zoneEmitTimer) clearTimeout(this.zoneEmitTimer);
    this.zoneEmitTimer = null;
  }

  scheduleZonesEmit({ contentChanged = false, seekChanged = false } = {}) {
    if (contentChanged) {
      this.cancelZonesEmit();
      this.zoneEmitTimer = setTimeout(() => this.emitZonesNow(), STATE_UPDATE_DEBOUNCE_MS);
      return;
    }

    if (!seekChanged) return;
    const now = Date.now();
    if (now - this.lastSeekEmitAt < SEEK_UPDATE_EMIT_MS) return;
    this.lastSeekEmitAt = now;
    if (!this.zoneEmitTimer) {
      this.zoneEmitTimer = setTimeout(() => this.emitZonesNow(), STATE_UPDATE_DEBOUNCE_MS);
    }
  }

  emitZonesNow() {
    this.cancelZonesEmit();
    this.emit("zones", this.getState());
  }

  hasActivePlayback() {
    for (const zone of this.zones.values()) {
      if (zone?.state !== "playing") continue;
      const text = [
        zone.display_name,
        ...(zone.outputs || []).map((output) => output.display_name)
      ].filter(Boolean).join(" ");
      if (/hqplayer/i.test(text)) return true;
    }
    return false;
  }

  getState() {
    return {
      connected: Boolean(this.core),
      core: this.core ? {
        id: this.core.core_id,
        name: this.core.display_name,
        version: this.core.display_version
      } : null,
      zones: [...this.zones.values()].map((zone) => ({
        ...zone,
        queue: this.queues.get(zone.zone_id) || null
      }))
    };
  }

  subscribeQueue(zoneId) {
    if (!this.transport || !zoneId || this.queueSubscriptions.has(zoneId)) return;
    this.queueSubscriptions.add(zoneId);

    try {
      this.transport.subscribe_queue(zoneId, 50, (cmd, msg = {}) => {
        if (cmd === "Unsubscribed") {
          this.queues.delete(zoneId);
          this.queueSubscriptions.delete(zoneId);
          this.queueSignatures.delete(zoneId);
          this.scheduleZonesEmit({ contentChanged: true });
          return;
        }

        const rawItems = queueItemsFromMessage(msg);
        const previous = this.queues.get(zoneId) || { items: [] };
        const changedItems = Array.isArray(msg.changes) && msg.changes.length
          ? applyQueueChanges(previous.items || [], msg.changes)
          : previous.items;
        const items = rawItems.length
          ? rawItems.map(queueItemSummary).filter((item) => item.title || item.subtitle)
          : changedItems;
        const signature = queueSignature(items);
        if (signature === this.queueSignatures.get(zoneId)) return;
        this.queueSignatures.set(zoneId, signature);
        this.queues.set(zoneId, {
          updatedAt: Date.now(),
          response: cmd,
          items,
          rawKeys: Object.keys(msg || {}),
          changeCount: Array.isArray(msg.changes) ? msg.changes.length : 0
        });
        this.scheduleZonesEmit({ contentChanged: true });
      });
    } catch (error) {
      this.queues.set(zoneId, {
        updatedAt: Date.now(),
        response: "Error",
        error: error.message,
        items: []
      });
    }
  }

  requireTransport() {
    if (!this.transport) throw new Error("Roon is not connected. Enable the extension in Roon Settings > Extensions.");
  }

  requireBrowse() {
    if (!this.browse) throw new Error("Roon browse service is not connected.");
  }

  getZone(zoneId) {
    this.requireTransport();
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`Unknown zone: ${zoneId}`);
    return zone;
  }

  controlTargetFor(zone) {
    const outputs = Array.isArray(zone?.outputs) ? zone.outputs : [];
    return outputs.length === 1 && outputs[0]?.output_id ? outputs[0] : zone;
  }

  zoneOrOutputId(zoneId) {
    const target = this.controlTargetFor(this.getZone(zoneId));
    return target.output_id || target.zone_id || zoneId;
  }

  async control(zoneId, control) {
    const allowed = new Set(["play", "pause", "playpause", "stop", "previous", "next"]);
    if (!allowed.has(control)) throw new Error(`Unsupported control: ${control}`);
    const zone = this.getZone(zoneId);
    return callRoon((cb) => this.transport.control(this.controlTargetFor(zone), control, cb));
  }

  async seek(zoneId, seconds) {
    const target = Math.max(0, Number(seconds || 0));
    return callRoon((cb) => this.transport.seek(this.getZone(zoneId), "absolute", target, cb));
  }

  async seekToStartWhenReady(zoneId, timeoutMs = 4000) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < timeoutMs) {
      const zone = this.zones.get(zoneId);
      if (zone?.now_playing && zone.is_seek_allowed) {
        try {
          await this.seek(zoneId, 0);
          return { reset: true };
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(250);
    }

    return {
      reset: false,
      error: lastError?.message || "Roon did not expose seeking before the reset timeout."
    };
  }

  async changeSettings(zoneId, settings) {
    return callRoon((cb) => this.transport.change_settings(this.getZone(zoneId), settings, cb));
  }

  async changeVolume(outputId, how, value) {
    this.requireTransport();
    for (const zone of this.zones.values()) {
      const output = (zone.outputs || []).find((candidate) => candidate.output_id === outputId);
      if (output) return callRoon((cb) => this.transport.change_volume(output, how, value, cb));
    }
    throw new Error(`Unknown output: ${outputId}`);
  }

  async getImage(imageKey, options = {}) {
    if (!this.core) throw new Error("Roon is not connected.");
    const key = String(imageKey || "").trim();
    if (!key) throw new Error("Missing Roon image key.");

    const host = this.core.moo?.transport?.host || "127.0.0.1";
    const ports = [
      this.core.moo?.transport?.port,
      this.core.registration?.http_port
    ].filter(Boolean);
    const uniquePorts = Array.from(new Set(ports));
    if (!uniquePorts.length) throw new Error("Roon did not expose an image HTTP port.");

    let lastError = null;
    for (const port of uniquePorts) {
      const url = new URL(`http://${host}:${port}/api/image/${encodeURIComponent(key)}`);
      for (const [name, value] of Object.entries(options)) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
      }

      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Roon image request failed: HTTP ${response.status}`);
        return {
          contentType: response.headers.get("content-type") || options.format || "image/jpeg",
          data: Buffer.from(await response.arrayBuffer())
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Roon image request failed.");
  }

  async listPlaylists() {
    this.requireBrowse();
    const session = `playlists-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.playlistsSession = session;

    await callRoon((cb) => this.browse.browse({
      hierarchy: "playlists",
      multi_session_key: session,
      pop_all: true
    }, cb));

    const loaded = await callRoon((cb) => this.browse.load({
      hierarchy: "playlists",
      multi_session_key: session,
      offset: 0,
      count: 200
    }, cb));

    return {
      title: loaded.list?.title || "Playlists",
      playlists: (loaded.items || [])
        .filter(isBrowseItem)
        .map((item) => ({
          id: item.item_key,
          title: item.title || "Untitled playlist",
          subtitle: item.subtitle || "",
          imageKey: item.image_key || "",
          hint: item.hint || ""
        }))
    };
  }

  async loadPlaylistTracks(itemKey, title = "") {
    this.requireBrowse();
    const key = String(itemKey || "").trim();
    if (!key) throw new Error("Missing playlist key.");

    const freshList = await this.listPlaylists();
    const indexMatch = key.match(/:(\d+)$/);
    const normalizedTitle = normalizeLookupText(title);
    const freshItem = freshList.playlists.find((playlist) => (
      normalizedTitle && normalizeLookupText(playlist.title) === normalizedTitle
    )) || freshList.playlists.find((playlist) => (
      indexMatch && playlist.id.endsWith(`:${indexMatch[1]}`)
    ));
    const currentKey = freshItem?.id || key;

    let selected;
    try {
      selected = await callRoon((cb) => this.browse.browse({
        hierarchy: "playlists",
        multi_session_key: this.playlistsSession,
        item_key: currentKey
      }, cb));
    } catch (error) {
      if (String(error.message || error) !== "InvalidItemKey") throw error;
      await this.listPlaylists();
      selected = await callRoon((cb) => this.browse.browse({
        hierarchy: "playlists",
        multi_session_key: this.playlistsSession,
        item_key: currentKey
      }, cb));
    }

    if (isErrorMessage(selected)) throw new Error(selected.message || "Roon could not open this playlist.");

    let loaded = await callRoon((cb) => this.browse.load({
      hierarchy: "playlists",
      multi_session_key: this.playlistsSession,
      offset: 0,
      count: 500
    }, cb));

    let items = loaded.items || [];
    const trackContainer = items.find((item) => (
      item.item_key &&
      item.hint !== "action" &&
      /(track|song)s?/i.test(`${item.title || ""} ${item.subtitle || ""}`)
    ));

    if (trackContainer && items.filter((item) => playlistTrackFromItem(item)).length < 3) {
      await callRoon((cb) => this.browse.browse({
        hierarchy: "playlists",
        multi_session_key: this.playlistsSession,
        item_key: trackContainer.item_key
      }, cb));

      loaded = await callRoon((cb) => this.browse.load({
        hierarchy: "playlists",
        multi_session_key: this.playlistsSession,
        offset: 0,
        count: 500
      }, cb));
      items = loaded.items || [];
    }

    const tracks = items
      .map(playlistTrackFromItem)
      .filter(Boolean)
      .filter((track) => !/(play|shuffle|edit|delete|add to)/i.test(track.title));

    return {
      title: loaded.list?.title || selected.list?.title || "Selected playlist",
      subtitle: loaded.list?.subtitle || "",
      count: tracks.length,
      tracks
    };
  }

  async searchQuery(track, zoneId, query) {
    if (!this.browse) throw new Error("Roon browse service is not connected.");
    const session = `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const zoneOrOutputId = this.zoneOrOutputId(zoneId);

    await callRoon((cb) => this.browse.browse({
      hierarchy: "search",
      multi_session_key: session,
      input: query,
      pop_all: true,
      zone_or_output_id: zoneOrOutputId
    }, cb));

    let loaded = await callRoon((cb) => this.browse.load({
      hierarchy: "search",
      multi_session_key: session,
      offset: 0,
      count: 50
    }, cb));

    const firstLevelItems = loaded.items || [];
    const trackCategory = firstLevelItems.find((item) => (
      item.item_key &&
      /(track|song|composition)s?/i.test(`${item.title || ""} ${item.subtitle || ""}`) &&
      item.hint !== "header"
    ));

    if (trackCategory) {
      await callRoon((cb) => this.browse.browse({
        hierarchy: "search",
        multi_session_key: session,
        item_key: trackCategory.item_key,
        zone_or_output_id: zoneOrOutputId
      }, cb));

      loaded = await callRoon((cb) => this.browse.load({
        hierarchy: "search",
        multi_session_key: session,
        offset: 0,
        count: 50
      }, cb));
    }

    const items = loaded.items || firstLevelItems;
    const ranked = items
      .map((item) => ({
        item,
        score: matchScore(track, item),
        verified: isVerifiedMatch(track, item),
        artistMatched: artistMatchInfo(track, item).matched > 0
      }))
      .sort((left, right) => (
        Number(right.verified) - Number(left.verified) ||
        Number(right.artistMatched) - Number(left.artistMatched) ||
        right.score - left.score
      ));
    const best = ranked[0]?.item || items[0] || null;
    const bestScore = ranked[0]?.score || 0;
    const verified = ranked[0]?.verified || false;

    return {
      query,
      match: best,
      matchScore: bestScore,
      verified,
      session,
      searchedCategory: trackCategory ? itemSummary(trackCategory) : null,
      candidates: items.slice(0, 10).map(itemSummary)
    };
  }

  async searchWithQueries(track, zoneId, queries) {
    const lookup = lookupTrack(track);
    const attempts = [];
    let bestResult = null;

    for (const query of queries) {
      const result = await this.searchQuery(lookup, zoneId, query);
      attempts.push({
        query,
        verified: result.verified,
        matchScore: result.matchScore,
        match: result.match ? itemSummary(result.match) : null,
        searchedCategory: result.searchedCategory
      });

      if (!bestResult || Number(result.verified) > Number(bestResult.verified) || result.matchScore > bestResult.matchScore) {
        bestResult = result;
      }

      if (result.verified) {
        return {
          ...result,
          queries,
          attempts
        };
      }
    }

    return {
      ...(bestResult || {
        query: queries[0] || `${lookup.artist} ${lookup.title}`,
        match: null,
        matchScore: 0,
        verified: false,
        session: "",
        searchedCategory: null,
        candidates: []
      }),
      queries,
      attempts
    };
  }

  async search(track, zoneId) {
    const lookup = lookupTrack(track);
    return this.searchWithQueries(lookup, zoneId, createRoonSearchQueries(lookup));
  }

  async searchTrackCandidates(query, zoneId, options = {}) {
    if (!this.browse) throw new Error("Roon browse service is not connected.");
    const session = `discover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const zoneOrOutputId = this.zoneOrOutputId(zoneId);
    const count = Math.max(20, Math.min(120, Number(options.limit || 80)));

    await callRoon((cb) => this.browse.browse({
      hierarchy: "search",
      multi_session_key: session,
      input: query,
      pop_all: true,
      zone_or_output_id: zoneOrOutputId
    }, cb));

    let loaded = await callRoon((cb) => this.browse.load({
      hierarchy: "search",
      multi_session_key: session,
      offset: 0,
      count
    }, cb));

    const firstLevelItems = loaded.items || [];
    const trackCategory = firstLevelItems.find((item) => (
      item.item_key &&
      /(track|song|composition)s?/i.test(`${item.title || ""} ${item.subtitle || ""}`) &&
      item.hint !== "header"
    ));

    if (trackCategory) {
      await callRoon((cb) => this.browse.browse({
        hierarchy: "search",
        multi_session_key: session,
        item_key: trackCategory.item_key,
        zone_or_output_id: zoneOrOutputId
      }, cb));

      loaded = await callRoon((cb) => this.browse.load({
        hierarchy: "search",
        multi_session_key: session,
        offset: 0,
        count
      }, cb));
    }

    const items = loaded.items || firstLevelItems;
    const tracks = items
      .map((item) => searchTrackFromItem(item, query))
      .filter(Boolean);

    return {
      query,
      session,
      searchedCategory: trackCategory ? itemSummary(trackCategory) : null,
      tracks,
      rawCount: items.length
    };
  }

  async discoverQueueableTracks(options = {}, zoneId, settings = {}) {
    if (!zoneId) throw new Error("Select a Roon output zone first.");
    const targetCount = Math.max(1, Math.min(80, Number(settings.targetCount || options.count || 12)));
    const candidateLimit = Math.min(
      500,
      Math.max(
        targetCount + 20,
        targetCount * 3,
        Number(settings.candidateLimit || 0)
      )
    );
    const modelQueries = createModelCandidateQueries(options)
      .slice(0, Math.max(0, Math.min(80, Number(settings.modelQueryLimit || 40))));
    const fallbackQueries = createRoonDiscoveryQueries(options);
    const queries = Array.from(new Set([...modelQueries, ...fallbackQueries].map(cleanLookupText).filter(Boolean)))
      .slice(0, Math.max(4, Math.min(120, Number(settings.maxQueries || 28))));
    const byKey = new Map();
    const discarded = [];
    const searchSummaries = [];

    for (const query of queries) {
      if (byKey.size >= candidateLimit) break;
      try {
        const result = await this.searchTrackCandidates(query, zoneId, {
          limit: settings.searchLimit || 90
        });
        searchSummaries.push({
          query,
          rawCount: result.rawCount,
          kept: result.tracks.length,
          searchedCategory: result.searchedCategory
        });
        for (const track of result.tracks) {
          const key = roonDiscoveryKey(track);
          if (!key || byKey.has(key)) continue;
          byKey.set(key, track);
          if (byKey.size >= candidateLimit) break;
        }
      } catch (error) {
        discarded.push({ query, reason: error.message, source: "Roon search" });
      }
    }

    const candidates = Array.from(byKey.values());
    const verifyQueueActions = /^(1|true|yes)$/i.test(String(settings.verifyQueueActions || ""));

    if (!verifyQueueActions) {
      const queueable = candidates.slice(0, targetCount).map((track) => ({
        ...track,
        roon: {
          ...(track.roon || {}),
          verified: true,
          queueAction: "Queue",
          queueActionPresumed: true,
          sourceQuery: track.query || ""
        },
        statusChecks: [
          "Roon search verified",
          "Roon-visible track",
          "TIDAL enrichment pending"
        ]
      }));

      return {
        requestedCount: targetCount,
        tracks: queueable,
        discarded,
        alternates: candidates.slice(targetCount),
        verification: {
          enabled: true,
          roonFirst: true,
          roonQueueable: true,
          roonQueueActionPresumed: true,
          roonStrict: true,
          requested: targetCount,
          searches: queries.length,
          searchSummaries: searchSummaries.slice(0, 18),
          candidates: candidates.length,
          roonChecked: 0,
          roonRejected: discarded.length,
          kept: queueable.length,
          discarded: discarded.length,
          strategy: "roon-search-first"
        }
      };
    }

    const queueable = [];
    const queueCheckLimit = Math.min(candidates.length, Number(settings.queueCheckLimit || 0) || Math.max(targetCount + 20, targetCount * 3));
    let checked = 0;

    for (const track of candidates) {
      if (queueable.length >= targetCount) break;
      if (checked >= queueCheckLimit) break;
      checked += 1;
      try {
        const search = await this.canQueueKnownRoonTrack(track, zoneId);
        if (search.success) {
          queueable.push({
            ...track,
            roon: {
              ...(track.roon || {}),
              verified: true,
              match: itemSummary(search.match),
              queueAction: search.action || "",
              sourceQuery: track.query || "",
              queueCheckQuery: search.query || ""
            },
            statusChecks: [
              "Roon verified",
              "Roon queue action ready",
              "TIDAL enrichment pending"
            ]
          });
        } else {
          discarded.push({
            ...track,
            reason: search.reason || "Roon search result did not expose a queue action.",
            roon: {
              ...(track.roon || {}),
              verified: false,
              match: search.match ? itemSummary(search.match) : null
            }
          });
        }
      } catch (error) {
        discarded.push({
          ...track,
          reason: error.message,
          roon: {
            ...(track.roon || {}),
            verified: false
          }
        });
      }
    }

    return {
      requestedCount: targetCount,
      tracks: queueable,
      discarded,
      alternates: candidates.slice(queueCheckLimit),
      verification: {
        enabled: true,
        roonFirst: true,
        roonQueueable: true,
        roonStrict: true,
        requested: targetCount,
        searches: queries.length,
        searchSummaries: searchSummaries.slice(0, 18),
        candidates: candidates.length,
        roonChecked: checked,
        roonRejected: discarded.length,
        kept: queueable.length,
        discarded: discarded.length,
        strategy: "roon-search-first"
      }
    };
  }

  async loadCurrentActions(session, mode = "play") {
    const actions = await callRoon((cb) => this.browse.load({
      hierarchy: "search",
      multi_session_key: session,
      offset: 0,
      count: 30
    }, cb));

    const items = actions.items || [];
    return {
      items,
      playable: preferredAction(items, mode)
    };
  }

  async findPlayableAction(session, zoneId, depth = 0, mode = "play", track = null) {
    const { items, playable } = await this.loadCurrentActions(session, mode);
    if (playable?.item_key) return { playable, items };
    if (depth >= 2) return { playable: null, items };
    const zoneOrOutputId = this.zoneOrOutputId(zoneId);

    const drillable = items.find((item) => (
      item.item_key &&
      item.hint !== "header" &&
      item.hint !== "action" &&
      !/(artist|album|credit|similar|radio|view all)/i.test(item.title || "") &&
      (!track || item.hint === "action_list" || isVerifiedMatch(track, item))
    ));

    if (!drillable) return { playable: null, items };

    const next = await callRoon((cb) => this.browse.browse({
      hierarchy: "search",
      multi_session_key: session,
      item_key: drillable.item_key,
      zone_or_output_id: zoneOrOutputId
    }, cb));

    if (isErrorMessage(next) || next.action === "message") return { playable: null, items };
    return this.findPlayableAction(session, zoneId, depth + 1, mode, track);
  }

  async resolveSearchAction(track, zoneId, mode = "play", options = {}) {
    const result = Array.isArray(options.queries) && options.queries.length
      ? await this.searchWithQueries(track, zoneId, options.queries)
      : await this.search(track, zoneId);
    if (!result.match?.item_key) {
      return { ...result, success: false, reason: "No Roon search match." };
    }
    if (!result.verified) {
      return {
        ...result,
        success: false,
        reason: `Roon did not find an exact artist/title match for ${track.artist} - ${track.title}. Best result was ${result.match.title || "unknown"}${result.match.subtitle ? ` - ${result.match.subtitle}` : ""}.`
      };
    }

    const zoneOrOutputId = this.zoneOrOutputId(zoneId);
    const selected = await callRoon((cb) => this.browse.browse({
      hierarchy: "search",
      multi_session_key: result.session,
      item_key: result.match.item_key,
      zone_or_output_id: zoneOrOutputId
    }, cb));

    if (isErrorMessage(selected)) throw new Error(selected.message || "Roon could not open this search result.");
    if (selected.action === "message") return { ...result, success: false, response: selected, reason: selected.message || "Roon opened a message instead of actions." };

    const { items, playable } = await this.findPlayableAction(result.session, zoneId, 0, mode, track);

    if (!playable?.item_key) {
      return {
        ...result,
        success: false,
        reason: mode === "queue" ? "Roon did not expose an add-to-queue action for this match." : "Roon did not expose a play action for this match.",
        response: selected,
        actions: items.map(itemSummary)
      };
    }

    return { ...result, success: true, action: playable.title, playable, mode, response: selected, actions: items.map(itemSummary) };
  }

  async performSearchAction(track, zoneId, mode = "play") {
    const result = await this.resolveSearchAction(track, zoneId, mode);
    if (!result.success || !result.playable?.item_key) return result;
    const zoneOrOutputId = this.zoneOrOutputId(zoneId);

    const played = await callRoon((cb) => this.browse.browse({
      hierarchy: "search",
      multi_session_key: result.session,
      item_key: result.playable.item_key,
      zone_or_output_id: zoneOrOutputId
    }, cb));

    if (isErrorMessage(played)) throw new Error(played.message || "Roon rejected the selected action.");

    const startReset = mode === "play" && /\bplay\b/i.test(result.playable.title || "")
      ? await this.seekToStartWhenReady(zoneId, 4500)
      : null;

    return { ...result, success: true, action: result.playable.title, mode, response: played, startReset };
  }

  async canQueueTrack(track, zoneId) {
    return this.resolveSearchAction(track, zoneId, "queue");
  }

  async canQueueKnownRoonTrack(track, zoneId) {
    const lookup = lookupTrack(track);
    const title = cleanLookupText(lookup.title);
    const artist = cleanLookupText(lookup.artist);
    const queries = Array.from(new Set([
      `${artist} ${title}`,
      `${title} ${artist}`
    ].map(cleanLookupText).filter(Boolean))).slice(0, 2);
    return this.resolveSearchAction(track, zoneId, "queue", { queries });
  }

  async playSearchMatch(track, zoneId) {
    const result = await this.performSearchAction(track, zoneId, "play");
    return {
      ...result,
      played: Boolean(result.success)
    };
  }

  async queueTracks(tracks, zoneId, options = {}) {
    const primary = Array.isArray(tracks) ? tracks.slice(0, 50) : [];
    const alternates = Array.isArray(options.alternates) ? options.alternates.slice(0, 50) : [];
    const targetCount = Math.min(50, Math.max(1, Number(options.targetCount || primary.length || 0)));
    const requestedTracks = options.mode === "next"
      ? primary.slice().reverse()
      : primary;
    const requested = [
      ...requestedTracks.map((track) => ({ track, isAlternate: false })),
      ...alternates.map((track) => ({ track, isAlternate: true }))
    ];
    if (!primary.length) throw new Error("No tracks were provided to queue.");

    const appendOnly = options.mode !== "replace";
    const queued = [];
    const failed = [];
    let sentAny = false;
    let started = false;
    let playbackStartRequested = false;
    let playbackStartError = "";
    let addNextUsed = false;
    let nextFallbackUsed = false;
    let shuffleDisabled = false;

    const zone = this.getZone(zoneId);
    if (zone.settings?.shuffle) {
      await this.changeSettings(zoneId, { shuffle: false });
      shuffleDisabled = true;
    }

    for (const [index, request] of requested.entries()) {
      if (queued.length >= targetCount) break;
      const { track, isAlternate } = request;
      const mode = options.mode === "next" ? "next" : (appendOnly ? "queue" : (sentAny ? "queue" : "play"));
      try {
        const result = await this.performSearchAction(track, zoneId, mode);
        if (result.success) {
          if (mode === "queue" && /add\s+next/i.test(result.action || "")) addNextUsed = true;
          if (mode === "next" && !/(add|play)\s+(to\s+)?next|add\s+after/i.test(result.action || "")) nextFallbackUsed = true;
          const actionWasPlayback = /\bplay\b/i.test(result.action || "");
          queued.push({
            index,
            track: {
              artist: track.artist,
              title: track.title,
              album: track.album || "",
              year: track.year || "",
              durationMs: track.durationMs || 0
            },
            action: result.action,
            mode,
            isAlternate,
            startReset: result.startReset || null,
            match: result.match ? itemSummary(result.match) : null
          });
          sentAny = true;
          started = started || actionWasPlayback;
        } else {
          failed.push({
            index,
            track,
            isAlternate,
            reason: result.reason || "No usable Roon action.",
            match: result.match ? itemSummary(result.match) : null,
            actions: result.actions || []
          });
        }
      } catch (error) {
        failed.push({ index, track, reason: error.message });
      }
    }

    if (!appendOnly && queued.length && !started) {
      try {
        await sleep(750);
        await this.control(zoneId, "play");
        playbackStartRequested = true;
        started = true;
      } catch (error) {
        playbackStartError = error.message;
      }
    }

    return {
      requested: targetCount,
      attemptedCount: queued.length + failed.length,
      primaryCount: primary.length,
      alternateCount: alternates.length,
      queuedCount: queued.length,
      failedCount: failed.length,
      appendOnly,
      topOfQueue: options.mode === "next",
      started,
      playbackStartRequested,
      playbackStartError,
      startReset: queued.find((item) => item.startReset)?.startReset || null,
      shuffleDisabled,
      warning: nextFallbackUsed
        ? "Roon did not expose Add Next for at least one track, so a normal queue action was used."
        : (addNextUsed ? "Roon exposed Add Next instead of Add To Queue for at least one track; order may depend on Roon's queue behavior." : ""),
      queued,
      failed
    };
  }
}

module.exports = {
  RoonClient
};
