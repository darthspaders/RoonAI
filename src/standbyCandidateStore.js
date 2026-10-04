"use strict";
const {recordRefresh} = require("./standbyNovelty");
const {identityKeys} = require("./standbyTrackIdentity");
const {parseCanonicalCatalogIdentity} = require("./catalogIdentityNormalization");

const fs = require("fs");
const path = require("path");
const { artistIdentityKeysForTrack } = require("./artistIdentity");

const DEFAULT_TARGET_COUNT = 25;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_QUEUE_FAILURE_RETAIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ARTIST_CAP = 2;
const DEFAULT_ALBUM_CAP = 1;
const DEFAULT_MIN_SCORE = 50;
const CLEAN_REFILL_ANCHORS = [
  "Bedrock Records",
  "Lost & Found",
  "Sudbeat Music",
  "Sound Avenue",
  "The Soundgarden",
  "Mango Alley",
  "Meanwhile Recordings",
  "Balance Music",
  "Anjunadeep",
  "Plattenbank",
  "Replug Records",
  "UV",
  "Univack",
  "Proton Music",
  "Juicebox Music",
  "Manual Music"
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function splitStandbyArtists(value = "") {
  return cleanText(value)
    .split(/\s*(?:,|&|\+|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\band\b)\s*/i)
    .map(cleanText)
    .filter(Boolean);
}

function looksLikeStandaloneGenreStylePhrase(value = "") {
  const normalized = normalize(value);
  if (!normalized) return false;
  const hasGenre = /\b(?:edm|electronic dance music|deep house|tech house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|techno|progressive trance|psytrance|psy trance|trance|ambient|downtempo|breaks|breakbeat|dubstep|drum and bass|dnb)\b/.test(normalized);
  if (!hasGenre) return false;
  return /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b/.test(normalized) ||
    /\b(?:journal|journals|journey|journeys|session|sessions|playlist|collection|compilation|selection|essentials|mixes?|vibes?|grooves?|sounds?)\b/.test(normalized);
}

function looksLikeGenreStyleDescriptor(value = "") {
  const raw = cleanText(value);
  const normalized = normalize(raw);
  if (!normalized) return false;
  const hasGenre = /\b(?:edm|electronic dance music|deep house|tech house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|techno|progressive trance|psytrance|psy trance|trance|ambient|downtempo|breaks|breakbeat|dubstep|drum and bass|dnb)\b/.test(normalized);
  const hasDescriptor = /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b/.test(normalized);
  const hasGenreSeparator = /[\/&|]/.test(raw) || /\b(?:and|x)\b/.test(normalized);
  return hasGenre && hasDescriptor && (hasGenreSeparator || /\bedm\b/.test(normalized));
}

function looksLikeSlashSeparatedGenreStyleSludge(value = "") {
  const raw = cleanText(value);
  if (!/[\/|]/.test(raw)) return false;
  const chunks = raw.split(/\/{1,2}|\|/).map(cleanText).filter(Boolean);
  if (chunks.length < 2) return false;
  const genreStyleChunkCount = chunks.filter(looksLikeStandaloneGenreStylePhrase).length;
  const hasDoubleSlash = /\/\//.test(raw);
  const hasCatalogueNoun = /\b(?:journal|journals|journey|journeys|session|sessions|playlist|collection|compilation|selection|essentials|mixes?|vibes?|grooves?|sounds?)\b/i.test(raw);
  if (genreStyleChunkCount >= 2) return true;
  if (hasDoubleSlash && genreStyleChunkCount >= 1) return true;
  if (hasCatalogueNoun && genreStyleChunkCount >= 1) return true;
  return looksLikeGenreStyleDescriptor(raw) && normalize(raw).split(/\s+/).length >= 5;
}

function looksLikeGenreCatalogueSludge(title = "", album = "") {
  const titleText = cleanText(title);
  const albumText = cleanText(album);
  const text = `${titleText} ${albumText}`;
  const normalized = normalize(text);
  if (!normalized) return false;
  const hasGenre = /\b(?:edm|electronic dance music|deep house|tech house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|techno|progressive trance|psytrance|psy trance|trance|ambient|downtempo|breaks|breakbeat|dubstep|drum and bass|dnb)\b/.test(normalized);
  if (!hasGenre) return false;
  const hasCatalogueNoun = /\b(?:journal|journals|journey|journeys|session|sessions|playlist|collection|compilation|selection|essentials|mixes?|vibes?|grooves?|sounds?)\b/.test(normalized);
  const titleEqualsAlbum = normalize(titleText) && normalize(titleText) === normalize(albumText);
  const longGenericTitle = normalize(titleText).split(/\s+/).length >= 5 || normalize(albumText).split(/\s+/).length >= 4;
  return hasCatalogueNoun && looksLikeStandaloneGenreStylePhrase(text) && (titleEqualsAlbum || longGenericTitle);
}

function looksLikeGenreKeywordRemixSludge(title = "", album = "") {
  const text = `${cleanText(title)} ${cleanText(album)}`;
  const normalized = normalize(text);
  if (!normalized) return false;
  return /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b.{0,48}\b(?:house|techno|trance|ambient|downtempo|breaks|breakbeat|dubstep|drum and bass|dnb)\b.{0,32}\bremix\b/.test(normalized);
}

function looksLikeGenericGenreArtistName(value = "") {
  const raw = cleanText(value);
  const artist = normalize(raw);
  if (!artist) return false;
  const artistWords = artist.split(/\s+/).filter(Boolean);
  const genreArtistWords = artist.match(/\b(?:edm|electronic|dance|melodic|progressive|deep|organic|hypnotic|dark|afro|electro|uk|garage|house|techno|tekkno|trance|ambient|downtempo|breaks|breakbeat|dubstep)\b/g) || [];
  const genreArtistSegments = raw.split(/[,/&|]+/).map(cleanText).filter(Boolean);
  if (
    genreArtistSegments.length >= 2 &&
    genreArtistSegments.every((segment) => looksLikeStandaloneGenreStylePhrase(segment) || /\b(?:house|techno|tekkno|trance|ambient|downtempo|breaks|breakbeat|dubstep|edm)\b/i.test(segment))
  ) {
    return true;
  }
  return genreArtistWords.length >= 3 && genreArtistWords.length >= artistWords.length - 1;
}

function looksLikeGenericGenreKeywordUploadTitle(title = "", album = "") {
  const rawTitle = cleanText(title);
  const normalizedTitle = normalize(rawTitle);
  if (!normalizedTitle) return false;
  const rawAlbum = cleanText(album);
  const titleEqualsAlbum = normalizedTitle && normalizedTitle === normalize(rawAlbum);
  const hasGenre = /\b(?:deep house|tech house|afro house|electro house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|deep techno|hypnotic techno|techno|progressive trance|psytrance|psy trance|trance|ambient|downtempo|breaks|breakbeat|uk garage|garage|dubstep|edm)\b/.test(normalizedTitle);
  if (!hasGenre) return false;

  const genreWords = normalizedTitle.match(/\b(?:edm|electronic|dance|melodic|progressive|deep|organic|hypnotic|dark|afro|electro|uk|garage|house|techno|trance|ambient|downtempo|breaks|breakbeat|dubstep)\b/g) || [];
  const versionWords = /\b(?:mix|version|edit|remix|loop|club|dub|rework)\b/.test(normalizedTitle);
  const parentheticalGenre = /\([^)]*\b(?:house|techno|trance|garage|ambient|downtempo|breaks|breakbeat|dubstep|edm)\b[^)]*\)/i.test(rawTitle);
  const coreGenres = normalizedTitle.match(/\b(?:house|techno|trance|garage|ambient|downtempo|breaks|breakbeat|dubstep|edm)\b/g) || [];
  const titleWords = normalizedTitle.split(/\s+/).filter(Boolean);
  const genreDominated = genreWords.length >= 2 && genreWords.length >= titleWords.length - 2;
  const multiGenreSoup = new Set(coreGenres).size >= 2 && genreWords.length >= 3;
  const durationOrBackgroundHook = /\b(?:background|\d+\s*(?:hr|hour|hours)|one\s+hour|two\s+hour|three\s+hour)\b/.test(normalizedTitle);
  const loopToolingHook = /\b(?:buildup|build up|loop|loops|drop|stab|drum loop|bass loop|melody loop|construction kit)\b/.test(normalizedTitle);

  return Boolean(
    durationOrBackgroundHook ||
    (loopToolingHook && genreWords.length >= 2) ||
    (titleEqualsAlbum && genreDominated) ||
    (parentheticalGenre && (versionWords || titleEqualsAlbum || genreWords.length >= 2)) ||
    (versionWords && genreDominated) ||
    multiGenreSoup
  );
}

function metadataField(track = {}, key = "") {
  return cleanText(track[key] || track.tidal?.[key]);
}

function hasReleaseEvidence(track = {}) {
  return Boolean(
    metadataField(track, "album") ||
    metadataField(track, "label") ||
    cleanText(track.tidal?.id || track.tidalId || track.id || track.trackId) ||
    cleanText(track.tidal?.tidalUrl || track.tidalUrl) ||
    cleanText(track.releaseDate || track.year || track.tidal?.releaseDate || track.tidal?.year)
  );
}

function looksLikeWellnessOrFunctionalSludge(title = "", album = "", artist = "", label = "") {
  const text = normalize([title, album, artist, label].filter(Boolean).join(" "));
  if (!text) return false;
  const hasFunctionalArtist = /\b(?:yoga|namaste|healing|meditation|mindfulness|sleep|hypnosis|hypnotic therapy|reiki|chakra|spa|massage|relaxation|binaural|solfeggio|frequency|frequencies|zen|shakuhachi|wellness|therapy|calm|study|focus|workout|pilates|tantra|mantra)\b/.test(text);
  const hasFunctionalTitle = /\b(?:inner contentment|holy enlightenment|oriental bliss|feeling good|source of energy|sleep|deep sleep|relax|relaxing|meditation|mindfulness|healing|chakra|reiki|spa|massage|binaural|solfeggio|frequency|frequencies|zen|calm|study|focus)\b/.test(text);
  return hasFunctionalArtist && (hasFunctionalTitle || /\b(?:universe|masters|guide|music|sounds?|source)\b/.test(text));
}

function looksLikeAudioBookOrSpokenWordSludge(title = "", album = "", artist = "", label = "") {
  const text = normalize([title, album, artist, label].filter(Boolean).join(" "));
  if (!text) return false;
  return /\b(?:chapter|chapters|unabridged|audiobook|audio book|story|stories|novel|narrator|narrated|booktrack|boldwood books|harper audio|penguin audio|audible|bedtime story|guided meditation)\b/.test(text);
}

function looksLikeSoundLibraryOrStockSludge(title = "", album = "", artist = "", label = "") {
  const text = normalize([title, album, artist, label].filter(Boolean).join(" "));
  if (!text) return false;
  return /\b(?:sound effects?|sfx|foley|production music|library music|stock music|background music|background ambience|ambient background|royalty free|music bed|underscore|sound library|sleep music|study music|relaxation music|yoga music|meditation music|deep background|audiosparx|audiojungle|epidemic sound|pond5|artlist|premiumbeat|motion array|storyblocks|soundstripe|bmg production music)\b/.test(text);
}

function looksLikeGenericSourceTitleSludge(title = "", album = "", artist = "", track = {}) {
  if (hasReleaseEvidence(track)) return false;
  const normalizedTitle = normalize(title);
  const normalizedAlbum = normalize(album);
  const normalizedArtist = normalize(artist);
  if (!normalizedTitle) return false;
  const genericSourceTitle = /^(?:sources?|source control|deep source|into the source|source of (?:energy|feeling good|oriental bliss|inner peace|life|light|sound|healing)|deep background)$/.test(normalizedTitle);
  if (genericSourceTitle) return true;
  const sourceHeavyText = `${normalizedArtist} ${normalizedTitle} ${normalizedAlbum}`;
  return /\bsource\b/.test(sourceHeavyText) && /\b(?:deep|energy|feeling|healing|bliss|background|oriental|zen|inner|contentment)\b/.test(sourceHeavyText);
}

function looksLikeLowEvidenceRoonFallback(track = {}) {
  const source = normalize(track.standbyFreshPass || track.discoverySource || track.standbySource || track.source);
  if (!/\broon\b/.test(source)) return false;
  if (hasReleaseEvidence(track)) return false;
  const score = scoreFor(track);
  if (score > 70) return false;
  const query = normalize(track.query || track.tidal?.query);
  const text = normalize([
    track.artist,
    track.title,
    track.album,
    track.label,
    query
  ].filter(Boolean).join(" "));
  if (!text) return true;
  return Boolean(
    !query ||
    /\b(?:sources?|source|deep|background|energy|feeling|contentment|self|spiral|movie|sea|zen|yoga|healing|sleep|hypnosis)\b/.test(text)
  );
}

function cleanRefillAnchorMismatch(track = {}) {
  if (cleanText(track.standbyFreshPass) !== "clean-refill-wide-sources") return false;
  const query = normalize(track.query || track.tidal?.query);
  if (!query) return false;
  const queryAnchors = CLEAN_REFILL_ANCHORS.filter((anchor) => {
    const key = normalize(anchor);
    return key && query.includes(key);
  });
  if (!queryAnchors.length) return false;
  const metadata = normalize([
    track.artist,
    track.title,
    track.album,
    track.label,
    track.tidal?.artist,
    track.tidal?.title,
    track.tidal?.album,
    track.tidal?.label
  ].filter(Boolean).join(" "));
  return !queryAnchors.some((anchor) => metadata.includes(normalize(anchor)));
}

function standbySeoSludgeReason(track = {}) {
  const title = metadataField(track, "title");
  const album = metadataField(track, "album");
  const artist = metadataField(track, "artist");
  const label = metadataField(track, "label");
  if (looksLikeGenericGenreArtistName(artist)) {
    return "Artist name looks like genre SEO filler.";
  }
  if (looksLikeWellnessOrFunctionalSludge(title, album, artist, label)) {
    return "Wellness, meditation, sleep, or functional-audio metadata looks like standby filler.";
  }
  if (looksLikeAudioBookOrSpokenWordSludge(title, album, artist, label)) {
    return "Audiobook or spoken-word metadata is not a music discovery candidate.";
  }
  if (looksLikeSoundLibraryOrStockSludge(title, album, artist, label)) {
    return "Sound-library or background-audio metadata looks like standby filler.";
  }
  if (looksLikeGenericSourceTitleSludge(title, album, artist, track)) {
    return "Generic source/background title without release evidence looks like fallback filler.";
  }
  if (looksLikeLowEvidenceRoonFallback(track)) {
    return "Low-evidence Roon fallback candidate lacks release metadata.";
  }
  if (looksLikeSlashSeparatedGenreStyleSludge(title) || looksLikeSlashSeparatedGenreStyleSludge(album)) {
    return "Slash-separated genre/style descriptor looks like SEO catalogue filler.";
  }
  if (looksLikeGenreCatalogueSludge(title, album)) {
    return "Genre catalogue wording looks like SEO filler.";
  }
  if (looksLikeGenreKeywordRemixSludge(title, album)) {
    return "Genre/remix keyword tail looks like SEO filler.";
  }
  if (looksLikeGenericGenreKeywordUploadTitle(title, album)) {
    return "Genre/style/version keyword title looks like SEO filler.";
  }
  if (cleanRefillAnchorMismatch(track)) {
    return "Curated refill query anchor was not corroborated by returned metadata.";
  }
  return "";
}

function isStandbySeoSludge(track = {}) {
  return Boolean(standbySeoSludgeReason(track));
}

function standbyTrackKey(track = {}) {
  return (identityKeys(track)[0] || "").replace(/^name:/, "");
}

function scoreFor(track = {}) {
  const score = Number(track.score ?? track.scoreBreakdown?.total ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function meetsStandbyScoreFloor(track = {}) {
  return scoreFor(track) >= DEFAULT_MIN_SCORE;
}

function isTransientStandbyQueueFailure(track = {}) {
  const failure = track.standbyQueueFailure || {};
  const failureType = normalize(failure.failureType);
  const reason = normalize(failure.reason);
  // A disconnected Roon core is a transient delivery problem, not evidence
  // that the candidate itself is invalid. Keep it retryable/displayable so a
  // brief bridge outage cannot empty the standby pool. Version mismatches and
  // catalog misses remain quarantined until a later refresh finds a replacement.
  return failureType === "error" && /\broon\b.*\b(?:not connected|disconnected|connection|timeout|timed out)\b/.test(reason);
}

function retainedQueueFailure(track = {}, now = Date.now()) {
  if (isTransientStandbyQueueFailure(track)) return false;
  const failure = track.standbyQueueFailure || {};
  return Boolean(failure && Number(failure.retainUntil || 0) > now);
}

function standbyArtistKeys(track = {}) {
  return artistIdentityKeysForTrack({
    ...track,
    artist: metadataField(track, "artist") || track.artist
  }, splitStandbyArtists);
}

function standbyCopyTitle(title = "") {
  return cleanText(title)
    .replace(/\s*[([]\s*(?:mixed|(?:ulf|fsoe|abgt)\s*\d+|episode\s+\d+)\s*[)\]]/gi, " ")
    .replace(/\s+(?:mixed|episode\s+\d+)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function standbyCanonicalCopyKind(track = {}, identity = {}) {
  const title = metadataField(track, "title");
  const album = metadataField(track, "album");
  const titleText = cleanText(title);
  const albumText = cleanText(album);
  if (/\b(?:episode\s*\d+|(?:ulf|fsoe|abgt)\s*\d+)\b/i.test(`${titleText} ${albumText}`)) return "episode";
  if (identity.versionKind === "mixed" || /\b(?:dj\s+mix|continuous\s+mix|mixed\s+by|mixed)\b/i.test(titleText)) return "dj-mix";
  if (/\b(?:compilation|various\s+artists?|best\s+of|collection|anthology|essentials?|yearbook|sampler)\b/i.test(albumText)) return "compilation";
  return "";
}

function standbyCanonicalIdentity(track = {}) {
  const title = metadataField(track, "title");
  if (!title) return null;
  const initial = parseCanonicalCatalogIdentity({
    ...track,
    title
  });
  const copyKind = standbyCanonicalCopyKind(track, initial);
  const identity = copyKind
    ? parseCanonicalCatalogIdentity({ ...track, title: standbyCopyTitle(title) })
    : initial;
  const artistKeys = standbyArtistKeys(track);
  if (!artistKeys.length || !identity.normalizedBaseTitle) return null;
  const versionKind = identity.versionKind === "mixed" ? "none" : (identity.versionKind || "none");
  return {
    track,
    key: `${artistKeys.slice().sort().join("|")}|${identity.normalizedBaseTitle}`,
    artistKeys,
    baseTitle: identity.normalizedBaseTitle,
    versionKind,
    versionSemantic: identity.version.semantic || "",
    copyKind,
    identity
  };
}

function standbyVersionCompatible(left = {}, right = {}) {
  if (left.versionKind !== right.versionKind) {
    const principalPair = new Set([left.versionKind, right.versionKind]);
    if (!principalPair.has("none") || !principalPair.has("original")) return false;
  }
  const leftSemantic = normalize(left.versionSemantic);
  const rightSemantic = normalize(right.versionSemantic);
  return !leftSemantic && !rightSemantic || leftSemantic === rightSemantic;
}

function standbyCanonicalReleasePreference(tracks = []) {
  const source = Array.isArray(tracks) ? tracks : [];
  const entries = source
    .map(track => ({ track, entry: standbyCanonicalIdentity(track) }));
  const families = new Map();
  for (const { entry } of entries) {
    if (!entry) continue;
    if (!families.has(entry.key)) families.set(entry.key, []);
    families.get(entry.key).push(entry);
  }

  const rejected = [];
  const kept = [];
  for (const { track, entry } of entries) {
    if (!entry) {
      kept.push(track);
      continue;
    }
    if (!entry.copyKind) {
      kept.push(entry.track);
      continue;
    }
    const standalone = (families.get(entry.key) || [])
      .filter(candidate => !candidate.copyKind && candidate !== entry && standbyVersionCompatible(entry, candidate))
      .sort((left, right) => {
        const leftPrincipal = left.identity.normalizedAlbumFamily === left.baseTitle ? 1 : 0;
        const rightPrincipal = right.identity.normalizedAlbumFamily === right.baseTitle ? 1 : 0;
        return rightPrincipal - leftPrincipal;
      })[0];
    if (!standalone) {
      kept.push(entry.track);
      continue;
    }
    rejected.push({
      artist: metadataField(entry.track, "artist"),
      title: metadataField(entry.track, "title"),
      album: metadataField(entry.track, "album"),
      copyKind: entry.copyKind,
      reason: "standby-copy-replaced-by-compatible-standalone-release",
      canonicalArtist: metadataField(standalone.track, "artist"),
      canonicalTitle: metadataField(standalone.track, "title"),
      canonicalAlbum: metadataField(standalone.track, "album"),
      normalizedBaseTitle: entry.baseTitle,
      versionCompatible: true
    });
  }

  return { tracks: kept, rejected };
}

function standbyQueueVariantInfo(track = {}) {
  if (standbyCanonicalIdentity(track)?.copyKind) return null;
  const title = metadataField(track, "title");
  const versionTexts = [
    metadataField(track, "version"),
    track.mixVersion,
    track.mixName,
    track.tidal?.mixVersion,
    track.tidal?.mixName
  ].map(cleanText).filter(Boolean);
  if (!title) return null;

  const titleMarker = title.match(/\b(original|extended)\s+(?:mix|version)\b/i)?.[1]?.toLowerCase() || "";
  const versionMarkers = [...new Set(versionTexts
    .map((value) => value.match(/\b(original|extended)\s+(?:mix|version)\b/i)?.[1]?.toLowerCase() || "")
    .filter(Boolean))];
  if (versionMarkers.length > 1) return null;
  const versionMarker = versionMarkers[0] || "";
  if (titleMarker && versionMarker && titleMarker !== versionMarker) return null;

  const kind = versionMarker || titleMarker || "base";
  const baseTitle = title
    .replace(/\s*(?:\(|\[)?\s*(?:original|extended)\s+(?:mix|version)\s*(?:\)|\])?\s*$/i, "")
    .trim();
  const artistKeys = standbyArtistKeys(track);
  if (!baseTitle || !artistKeys.length) return null;

  return {
    key: `${artistKeys.slice().sort().join("|")}|${normalize(baseTitle)}`,
    kind,
    track
  };
}

function selectStandbyQueueTracks(tracks = [], targetCount = tracks.length) {
  const source = standbyCanonicalReleasePreference(tracks).tracks;
  const numericTarget = Number(targetCount);
  const target = Number.isFinite(numericTarget)
    ? Math.max(0, Math.trunc(numericTarget))
    : source.length;
  if (!source.length || !target) return [];

  const families = new Map();
  for (const track of source) {
    const info = standbyQueueVariantInfo(track);
    if (!info) continue;
    if (!families.has(info.key)) families.set(info.key, []);
    families.get(info.key).push(info);
  }

  const extendedReplacements = new Map();
  for (const [key, family] of families.entries()) {
    const extended = family.find((entry) => entry.kind === "extended");
    const hasPlainOrOriginal = family.some((entry) => entry.kind === "base" || entry.kind === "original");
    if (extended && hasPlainOrOriginal) extendedReplacements.set(key, extended);
  }

  const selected = [];
  const emittedFamilies = new Set();
  for (const track of source) {
    if (selected.length >= target) break;
    const info = standbyQueueVariantInfo(track);
    const replacement = info && extendedReplacements.get(info.key);
    if (replacement) {
      if (emittedFamilies.has(info.key)) continue;
      selected.push(replacement.track);
      emittedFamilies.add(info.key);
      continue;
    }
    selected.push(track);
  }

  return selected.slice(0, target);
}

function standbyAlbumKey(track = {}) {
  const album = metadataField(track, "album");
  if (!album) return "";
  return normalize([metadataField(track, "label"), album].filter(Boolean).join(" "));
}

function diverseStandbyCandidates(
  tracks = [],
  targetCount = DEFAULT_TARGET_COUNT,
  artistCap = DEFAULT_ARTIST_CAP,
  albumCap = DEFAULT_ALBUM_CAP
) {
  const target = Math.max(1, Number(targetCount || DEFAULT_TARGET_COUNT));
  const cap = Math.max(1, Number(artistCap || DEFAULT_ARTIST_CAP));
  const releaseCap = Math.max(1, Number(albumCap || DEFAULT_ALBUM_CAP));
  const selected = [];
  const artistCounts = new Map();
  const albumCounts = new Map();

  for (const track of tracks || []) {
    if (selected.length >= target) break;
    const artistKeys = standbyArtistKeys(track);
    if (artistKeys.length && artistKeys.some((key) => (artistCounts.get(key) || 0) >= cap)) continue;
    const albumKey = standbyAlbumKey(track);
    if (albumKey && (albumCounts.get(albumKey) || 0) >= releaseCap) continue;
    selected.push(track);
    for (const key of artistKeys) {
      artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
    }
    if (albumKey) albumCounts.set(albumKey, (albumCounts.get(albumKey) || 0) + 1);
  }

  return selected;
}

function adaptiveDiverseStandbyCandidates(tracks = [], targetCount = DEFAULT_TARGET_COUNT, { allowAlbumRepeatsOnShortfall = false } = {}) {
  const target = Math.max(1, Number(targetCount || DEFAULT_TARGET_COUNT));
  const first = diverseStandbyCandidates(tracks, target, 1);
  if (first.length >= target) return first;
  const second = diverseStandbyCandidates(tracks, target, 2, allowAlbumRepeatsOnShortfall ? 2 : 1);
  if (second.length >= target) return second;
  return diverseStandbyCandidates(tracks, target, 3, allowAlbumRepeatsOnShortfall ? 2 : 1);
}

function compactTrack(track = {}, previous = {}, context = {}, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const key = standbyTrackKey(track);
  const addedAt = Number(previous.standbyAddedAt || previous.addedAt || now);
  return {
    ...track,
    key,
    standbyAddedAt: addedAt,
    standbyUpdatedAt: now,
    standbyExpiresAt: now + ttlMs,
    standbyReason: cleanText(context.reason || previous.standbyReason || "background"),
    standbySource: cleanText(context.source || previous.standbySource || track.discoverySource || "Standby discovery"),
    standbyLane: cleanText(track.discoveryLane || previous.standbyLane || ""),
    _resultIndex: undefined
  };
}

function sortCandidates(left = {}, right = {}) {
  const leftRetained = retainedQueueFailure(left);
  const rightRetained = retainedQueueFailure(right);
  if (leftRetained !== rightRetained) return leftRetained ? -1 : 1;
  if (left.standbyFinalRank && right.standbyFinalRank && left.standbyFinalRank.runId === right.standbyFinalRank.runId) return left.standbyFinalRank.rank - right.standbyFinalRank.rank;
  if (left.standbySynapseRank && right.standbySynapseRank && left.standbySynapseRank.runId === right.standbySynapseRank.runId) return left.standbySynapseRank.rank - right.standbySynapseRank.rank;
  return scoreFor(right) - scoreFor(left) ||
    Number(right.standbyUpdatedAt || 0) - Number(left.standbyUpdatedAt || 0) ||
    cleanText(left.artist).localeCompare(cleanText(right.artist)) ||
    cleanText(left.title).localeCompare(cleanText(right.title));
}

class StandbyCandidateStore {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "standby-candidates.json");
    this.targetCount = Math.max(1, Number(options.targetCount || DEFAULT_TARGET_COUNT));
    this.ttlMs = Math.max(60_000, Number(options.ttlMs || DEFAULT_TTL_MS));
  }

  empty() {
    return {
      version: 1,
      standbyHistory: [],
      enabled: true,
      targetCount: this.targetCount,
      ttlMs: this.ttlMs,
      updatedAt: "",
      refreshing: false,
      refreshStartedAt: "",
      lastRefreshAt: "",
      nextRefreshAt: "",
      lastError: "",
      lastRun: null,
      standbySelectionPolicy: "",
      candidates: []
    };
  }

  read() {
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...this.empty(),
        ...snapshot,
        targetCount: this.targetCount,
        ttlMs: this.ttlMs,
        candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates : []
      };
    } catch {
      return this.empty();
    }
  }

  write(snapshot = this.empty()) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const next = {
      ...this.empty(),
      ...snapshot,
      targetCount: this.targetCount,
      ttlMs: this.ttlMs,
      candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates : [],
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(next, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
    return next;
  }

  activeCandidates(snapshot = this.read(), now = Date.now(), options = {}) {
    const includeQueueFailures = Boolean(options.includeQueueFailures);
    const allowAlbumRepeatsOnShortfall = options.allowAlbumRepeatsOnShortfall === true || snapshot.standbySelectionPolicy === "adaptive-album-v1";
    const tracks = (snapshot.candidates || [])
      .filter((track) => (
        standbyTrackKey(track) &&
        meetsStandbyScoreFloor(track) &&
        !isStandbySeoSludge(track) &&
        Number(track.standbyExpiresAt || 0) > now &&
        (includeQueueFailures || !retainedQueueFailure(track, now))
      ))
      .sort(sortCandidates);
    return adaptiveDiverseStandbyCandidates(tracks, this.targetCount, { allowAlbumRepeatsOnShortfall });
  }

  list(options = {}) {
    const limit = Math.max(1, Number(options.limit || this.targetCount));
    return this.activeCandidates().slice(0, limit);
  }

  readyCount() {
    return this.list({ limit: this.targetCount }).length;
  }

  refreshDue(intervalMs = 20 * 60 * 1000, now = Date.now()) {
    const snapshot = this.read();
    if (snapshot.refreshing) return false;
    if (this.readyCount() < this.targetCount) return true;
    return false;
  }

  add(tracks = [], context = {}) {
    const snapshot = this.read();
    const now = Date.now();
    const active = this.activeCandidates(snapshot, now);
    const byKey = new Map(active.map((track) => [standbyTrackKey(track), track]).filter(([key]) => key));

    for (const track of tracks || []) {
      const key = standbyTrackKey(track);
      if (!key || !meetsStandbyScoreFloor(track) || isStandbySeoSludge(track)) continue;
      byKey.set(key, compactTrack(track, byKey.get(key), context, now, this.ttlMs));
    }

    const canonical = standbyCanonicalReleasePreference([...byKey.values()].sort(sortCandidates));
    const candidates = adaptiveDiverseStandbyCandidates(canonical.tracks, this.targetCount);
    const next = this.write({
      ...snapshot,
      candidates,
      standbyHistory: context.recordHistory ? recordRefresh(context.history || snapshot.standbyHistory || [], candidates) : snapshot.standbyHistory
    });
    return {
      addedCount: candidates.length,
      targetCount: this.targetCount,
      tracks: candidates,
      canonicalReleaseRejected: canonical.rejected,
      summary: this.summary(next)
    };
  }

  replace(tracks = [], context = {}) {
    const snapshot = this.read();
    const now = Date.now();
    // Keep queue-failed candidates in the persisted quarantine during a
    // replacement, but never let them compete with fresh recommendations in
    // the normal active/display pool.
    const previousActive = this.activeCandidates(snapshot, now, { includeQueueFailures: true });
    const previousByKey = new Map(
      previousActive
        .map((track) => [standbyTrackKey(track), track])
        .filter(([key]) => key)
    );
    const quarantined = new Map();
    const retryable = new Map();
    for (const track of previousActive.filter((candidate) => retainedQueueFailure(candidate, now))) {
      const key = standbyTrackKey(track);
      if (key) quarantined.set(key, track);
    }
    for (const track of previousActive.filter((candidate) => isTransientStandbyQueueFailure(candidate))) {
      const key = standbyTrackKey(track);
      if (key) retryable.set(key, track);
    }

    const freshByKey = new Map();

    for (const track of tracks || []) {
      const key = standbyTrackKey(track);
      if (!key || !meetsStandbyScoreFloor(track) || isStandbySeoSludge(track)) continue;
      // A newly discovered candidate supersedes an older queue-failed copy of
      // the same identity. Do not carry the failure marker forward.
      quarantined.delete(key);
      retryable.delete(key);
      freshByKey.set(key, compactTrack(track, previousByKey.get(key), context, now, this.ttlMs));
    }

    // Quarantined failures are persisted separately from the fresh selection
    // so they cannot crowd out new tracks when the target is only partially
    // filled.
    const allowAlbumRepeatsOnShortfall = context.allowAlbumRepeatsOnShortfall === true;
    const canonical = standbyCanonicalReleasePreference([...freshByKey.values()].sort(sortCandidates));
    const freshCandidates = adaptiveDiverseStandbyCandidates(canonical.tracks, this.targetCount, { allowAlbumRepeatsOnShortfall });
    // A Roon connection failure says nothing about candidate quality. Carry
    // those tracks forward only to fill a genuine shortfall; once the fresh
    // pool reaches the target, the new pool fully replaces them.
    const visibleCandidates = freshCandidates.length >= this.targetCount
      ? freshCandidates
      : adaptiveDiverseStandbyCandidates([...freshCandidates, ...retryable.values()].sort(sortCandidates), this.targetCount, { allowAlbumRepeatsOnShortfall });
    const candidates = [...quarantined.values(), ...visibleCandidates];
    const historyCandidates = visibleCandidates.filter((candidate) => freshByKey.has(standbyTrackKey(candidate)) && !retainedQueueFailure(candidate, now));
    const next = this.write({
      ...snapshot,
      candidates,
      standbySelectionPolicy: allowAlbumRepeatsOnShortfall ? "adaptive-album-v1" : snapshot.standbySelectionPolicy,
      standbyHistory: context.recordHistory ? recordRefresh(context.history || snapshot.standbyHistory || [], historyCandidates) : snapshot.standbyHistory
    });
    return {
      addedCount: visibleCandidates.length,
      targetCount: this.targetCount,
      tracks: visibleCandidates,
      canonicalReleaseRejected: canonical.rejected,
      quarantinedTracks: [...quarantined.values()],
      summary: this.summary(next)
    };
  }

  retainQueueFailures(failed = [], context = {}) {
    const snapshot = this.read();
    const now = Date.now();
    const retainMs = Math.max(60_000, Number(context.retainMs || DEFAULT_QUEUE_FAILURE_RETAIN_MS));
    const failedByKey = new Map();
    for (const row of failed || []) {
      const track = row?.track || row?.requestedTrack || row;
      const keys = identityKeys(track);
      for (const key of keys) failedByKey.set(key, { row, track });
    }
    if (!failedByKey.size) return this.summary(snapshot);
    let changed = false;
    const candidates = (snapshot.candidates || []).map((candidate) => {
      const hit = identityKeys(candidate).map((key) => failedByKey.get(key)).find(Boolean);
      if (!hit) return candidate;
      changed = true;
      return {
        ...candidate,
        standbyExpiresAt: Math.max(Number(candidate.standbyExpiresAt || 0), now + retainMs),
        standbyQueueFailure: {
          at: new Date(now).toISOString(),
          retainUntil: now + retainMs,
          reason: cleanText(hit.row?.reason || "Queue attempt failed."),
          failureType: cleanText(hit.row?.failureType || ""),
          resolutionMethod: cleanText(hit.row?.resolutionMethod || ""),
          queueAttemptSource: cleanText(context.source || "")
        }
      };
    });
    return changed ? this.summary(this.write({ ...snapshot, candidates })) : this.summary(snapshot);
  }

  remove(keys = []) {
    const keySet = new Set((keys || []).map(cleanText).filter(Boolean));
    const snapshot = this.read();
    const candidates = this.activeCandidates(snapshot)
      .filter((track) => !keySet.has(track.key || standbyTrackKey(track)) && !keySet.has(standbyTrackKey(track)));
    return this.summary(this.write({ ...snapshot, candidates }));
  }

  clear() {
    const snapshot=this.read();
    const history=snapshot.standbyHistory?.length ? snapshot.standbyHistory : (snapshot.candidates.length ? recordRefresh([],snapshot.candidates,snapshot.lastRefreshAt||new Date().toISOString()) : []);
    return this.summary(this.write({
      ...snapshot,
      standbyHistory:history,
      candidates: [],
      lastError: "",
      lastRun: null
    }));
  }

  markRefreshStart(context = {}) {
    const startedAt = new Date().toISOString();
    return this.summary(this.write({
      ...this.read(),
      refreshing: true,
      refreshStartedAt: startedAt,
      lastError: "",
      lastRun: {
        reason: cleanText(context.reason || "background"),
        startedAt,
        diagnostics: {synapseReview: context.synapseReview || null}
      }
    }));
  }

  markRefreshEnd(result = {}) {
    const snapshot = this.read();
    const endedAt = new Date().toISOString();
    return this.summary(this.write({
      ...snapshot,
      refreshing: false,
      refreshStartedAt: "",
      lastRefreshAt: result.error ? snapshot.lastRefreshAt : endedAt,
      nextRefreshAt: result.nextRefreshAt || snapshot.nextRefreshAt || "",
      lastError: cleanText(result.error || ""),
      lastRun: {
        ...(snapshot.lastRun || {}),
        reason: cleanText(result.reason || snapshot.lastRun?.reason || "background"),
        endedAt,
        runtimeMs: Number(result.runtimeMs || 0),
        generated: Number(result.generated || 0),
        kept: Number(result.kept || 0),
        discarded: Number(result.discarded || 0),
        error: cleanText(result.error || ""),
        diagnostics: { ...(snapshot.lastRun?.diagnostics || {}), ...(result.diagnostics || result.standbyDiagnostics || {}), ...(!result.diagnostics?.synapseReview && result.error && snapshot.lastRun?.diagnostics?.synapseReview ? {synapseReview:{...snapshot.lastRun.diagnostics.synapseReview,skipReason:`Refresh stopped before Synapse review: ${result.error}`,reason:result.error}} : {}) }
      }
    }));
  }

  summary(snapshot = this.read()) {
    const tracks = this.activeCandidates(snapshot).slice(0, this.targetCount);
    return {
      enabled: snapshot.enabled !== false,
      targetCount: this.targetCount,
      ttlMs: this.ttlMs,
      count: tracks.length,
      ready: tracks.length >= this.targetCount,
      refreshing: Boolean(snapshot.refreshing),
      refreshStartedAt: snapshot.refreshStartedAt || "",
      updatedAt: snapshot.updatedAt || "",
      lastRefreshAt: snapshot.lastRefreshAt || "",
      nextRefreshAt: tracks.length >= this.targetCount ? "" : snapshot.nextRefreshAt || "",
      lastError: snapshot.lastError || "",
      lastRun: snapshot.lastRun || null,
      tracks
    };
  }
}

module.exports = {
  StandbyCandidateStore,
  isStandbySeoSludge,
  standbySeoSludgeReason,
  isTransientStandbyQueueFailure,
  standbyTrackKey,
  standbyArtistKeys,
  standbyCanonicalReleasePreference,
  selectStandbyQueueTracks,
  diverseStandbyCandidates
};
