"use strict";
const voiceExecution = require("./voiceExecution");
const { namedRemixEvidence, ORIGINAL_ARTIST_PENALTY } = require("./candidateReviewEvidence");
const {
  calibrationIssueCount,
  calibrationIssueDetail
} = require("./calibrationSignals");
const {
  explicitTidalTrackId,
  tidalTrackIdFromUrl
} = require("./tidalIdentity");

const {
  detectEraTerms: detectOntologyEraTerms,
  detectGenreTerms: detectOntologyGenreTerms,
  detectTrackCharacteristics: detectOntologyTrackCharacteristics,
  detectVibeTerms: detectOntologyVibeTerms,
  pruneGenreTerms: pruneOntologyGenreTerms
} = require("./musicOntology");
const {
  queryContextKey,
  queryTemplate,
  rejectionBucketForReason,
  summarizeRecords
} = require("./queryYieldTracker");
const { parseYearRange, yearFits, releaseDateFits } = require("./yearRange");
const {
  artistIdentityKey,
  artistIdentityKeysForTrack,
  artistNamesMatch,
  isCollisionSensitiveArtist
} = require("./artistIdentity");
const { routePromptIntent } = require("./promptIntentRouter");

const SCORE_MAX = {
  freshness: 19,
  labelMatch: 19,
  artistMatch: 19,
  lengthPreference: 19,
  genreMatch: 24
};

const SCORE_THRESHOLDS = {
  longshot: 0,
  experimental: 60,
  worth: 70,
  strong: 80,
  excellent: 90
};

const CALIBRATION_QUOTA_RISK = {
  moderateMissRate: 0.34,
  highMissRate: 0.5,
  repeatIssueThreshold: 2,
  maxBucketRisk: 4,
  maxCandidateRisk: 8,
  scorePenaltyPerRiskPoint: 4
};

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

function looksLikeGenreStyleDescriptor(value = "") {
  const raw = cleanText(value);
  const normalized = normalize(raw);
  if (!normalized) return false;
  const hasGenre = /\b(?:edm|electronic dance music|deep house|tech house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|techno|progressive trance|psytrance|psy trance|trance|ambient|breaks|breakbeat|dubstep|rock|metal|alternative|indie)\b/.test(normalized);
  const hasDescriptor = /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b/.test(normalized);
  const hasGenreSeparator = /[,\/&|]/.test(raw) || /\b(?:and|x)\b/.test(normalized);
  return hasGenre && hasDescriptor && (hasGenreSeparator || /\bedm\b/.test(normalized) || /\b(?:rock|metal)\b/.test(normalized));
}

function looksLikeStandaloneGenreStylePhrase(value = "") {
  const normalized = normalize(value);
  if (!normalized) return false;
  const hasGenre = /\b(?:edm|electronic dance music|deep house|tech house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|techno|progressive trance|psytrance|psy trance|trance|ambient|downtempo|breaks|breakbeat|dubstep|drum and bass|dnb|rock|metal|alternative|indie)\b/.test(normalized);
  if (!hasGenre) return false;
  return /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b/.test(normalized) ||
    /\b(?:journal|journals|journey|journeys|session|sessions|playlist|collection|compilation|selection|essentials|mixes?|vibes?|grooves?|sounds?)\b/.test(normalized);
}

function looksLikeSlashSeparatedGenreStyleDescriptor(value = "") {
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

function normalizeIdentityTitle(value = "") {
  const stripped = cleanText(value).replace(/\([^)]{8,160}\)|\[[^\]]{8,160}\]/g, (part) => (
    looksLikeGenreStyleDescriptor(part) ? " " : part
  ));
  return normalize(stripped);
}

function normalizeScoringMode(options = {}) {
  const key = normalize(options.scoringMode || options.scoring_mode || options.mode || "taste-guided");
  if (["pure", "pure search", "search only", "unbiased"].includes(key)) return "pure";
  if (["explore", "explore mode", "outside taste", "outside known taste"].includes(key)) return "explore";
  if (["similar", "similar mode", "similarity", "liked"].includes(key)) return "similar";
  return "taste-guided";
}

function scoringModeLabel(mode) {
  if (mode === "pure") return "Pure Search";
  if (mode === "explore") return "Explore Mode";
  if (mode === "similar") return "Similar Mode";
  return "Taste Guided";
}

function candidateIdentityKeys(track = {}) {
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl).toLowerCase();
  const explicitTidalId = explicitTidalTrackId(track);
  const tidalId = tidalTrackIdFromUrl(tidalUrl) || explicitTidalId;
  const artist = normalize(track.artist);
  const title = normalize(track.title);
  const identityTitle = normalizeIdentityTitle(track.title);
  return [
    tidalUrl,
    tidalId && `tidal:${tidalId}`,
    `${artist}|${title}`,
    identityTitle && identityTitle !== title ? `${artist}|${identityTitle}` : ""
  ].filter((key) => key && key !== "|");
}

function mergeCandidateLists(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const candidate of list || []) {
      const keys = candidateIdentityKeys(candidate);
      const key = keys[0] || `${normalize(candidate.artist)}|${normalize(candidate.title)}`;
      if (!key || seen.has(key)) continue;
      for (const candidateKey of keys) seen.add(candidateKey);
      seen.add(key);
      merged.push(candidate);
    }
  }
  return merged;
}

function parseRequestedCount(options = {}) {
  const effective = Number(options.effectiveCount || 0);
  if (effective > 0) return Math.min(40, Math.max(1, effective));

  const explicit = Number(options.count || 0);
  if (explicit > 0) return Math.min(40, Math.max(1, explicit));

  const request = cleanText(options.request);
  const match = request.match(/\b(\d{1,2})\s*(?:[a-z][\w-]*\s+){0,6}(?:track|song|cut|candidate|recommendation)s?\b/i);
  return match ? Math.min(40, Math.max(1, Number(match[1]))) : 8;
}

function hasHardCountLanguage(options = {}) {
  const request = cleanText(options.request);
  return /\b(?:exactly|only|just|no more than|not more than|max(?:imum)?|limit(?:ed)? to)\s+\d{1,2}\b/i.test(request) ||
    /\b\d{1,2}\s*(?:tracks?|songs?|cuts?|candidates?|recommendations?)\s*(?:only|exactly|max(?:imum)?)\b/i.test(request);
}

function shouldBuildWideDiscoveryPool(options = {}, profile = buildDiscoveryProfile(options)) {
  if (profile.scoringMode === "pure" && (profile.requestedArtists || []).length) return false;
  if (profile.scoringMode === "similar") return false;
  // A plain “use my taste” request should search through the active taste
  // cluster seeds first. It remains soft personalization, but must not enter
  // the wide fallback pool that turns an empty genre field into open-catalog
  // discovery. Explicit branch-out language still enables the wide pool.
  if (profile.promptIntent?.outsideTasteMode === "taste-profile") return false;
  if (hasExplicitArtistFocus(options, profile) && !requestRequiresFreshArtists(options)) return false;
  if (profile.promptIntent?.allowOutsideTaste && !hasHardCountLanguage(options)) return true;
  return Boolean(
    profile.hasExplicitDiscoveryIntent &&
    (profile.targetGenres?.length || profile.vibeTerms?.length || parseYearRange(options) || profile.promptIntent?.hasIntent) &&
    !hasHardCountLanguage(options)
  );
}

function defaultPerRunArtistCap(options = {}, profile = buildDiscoveryProfile(options), requestedCount = 8) {
  const limit = Math.max(1, Math.min(40, Number(requestedCount || 8)));
  if (profile.scoringMode === "pure" && (profile.requestedArtists || []).length) return Number.MAX_SAFE_INTEGER;
  if (profile.scoringMode === "similar") return limit <= 8 ? 2 : 3;
  if (hasExplicitArtistFocus(options, profile) && !requestRequiresFreshArtists(options)) return limit <= 8 ? 2 : 3;
  return 1;
}

function defaultPerRunLabelCap(options = {}, profile = buildDiscoveryProfile(options), requestedCount = 8) {
  const limit = Math.max(1, Math.min(40, Number(requestedCount || 8)));
  if (profile.scoringMode === "pure" || (profile.requestedLabels || []).length) return Number.MAX_SAFE_INTEGER;
  if (limit <= 3) return limit;
  if (limit <= 6) return 2;
  return Math.max(2, Math.ceil(limit * (profile.scoringMode === "explore" ? 0.25 : 0.3)));
}

function defaultPerRunSourceCap(options = {}, profile = buildDiscoveryProfile(options), requestedCount = 8) {
  const limit = Math.max(1, Math.min(40, Number(requestedCount || 8)));
  if (profile.scoringMode === "pure") return Number.MAX_SAFE_INTEGER;
  if (limit <= 3) return limit;
  if (profile.scoringMode === "similar") return Math.max(2, Math.ceil(limit * 0.45));
  if (limit <= 6) return 2;
  return Math.max(2, Math.ceil(limit * (profile.scoringMode === "explore" ? 0.25 : 0.3)));
}

function noveltyBudgetFor(options = {}, profile = buildDiscoveryProfile(options), requestedCount = 8) {
  const count = Math.max(1, Math.min(40, Number(requestedCount || 8)));
  const artistCap = defaultPerRunArtistCap(options, profile, count);
  const pure = profile.scoringMode === "pure";
  const similar = profile.scoringMode === "similar";
  const discoveryFirst = !pure && !similar && Boolean(
    profile.hasExplicitDiscoveryIntent ||
    profile.promptIntent?.hasIntent ||
    shouldBuildWideDiscoveryPool(options, profile)
  );

  return {
    artistCap,
    repeatFallbackAllowed: allowsArtistRepeatFallback(options, profile),
    tasteTarget: pure ? 0 : (similar
      ? Math.max(1, Math.floor(count * 0.3))
      : (discoveryFirst ? (count >= 12 ? 1 : 0) : (count >= 8 ? 1 : 0))),
    tasteMax: pure ? 0 : (similar
      ? Math.max(2, Math.ceil(count * 0.6))
      : (discoveryFirst ? Math.max(1, Math.ceil(count * 0.12)) : Math.max(1, Math.ceil(count * 0.22)))),
    discoveryFirst
  };
}

function allowsArtistRepeatFallback(options = {}, profile = buildDiscoveryProfile(options)) {
  if (defaultPerRunArtistCap(options, profile, parseRequestedCount(options)) > 1) return true;
  // Large explicit genre runs need enough depth to reach the requested count.
  // Keep the strict one-per-artist behavior for small runs, but allow the
  // selector to relax it only after the diverse candidates are exhausted.
  if (
    profile.isGenreDiscoveryTarget &&
    parseRequestedCount(options) >= 12 &&
    !requestRequiresStrictFreshArtists(options)
  ) return true;
  return /\b(?:allow|include|permit|ok(?:ay)? with)\b.{0,32}\b(?:repeat(?:ed)?|same)\s+artists?\b/i.test(requestText(options));
}

function hasExplicitCountRequest(options = {}) {
  if (Number(options.count || 0) > 0) return true;
  return /\b\d{1,2}\s*(?:[a-z][\w-]*\s+){0,6}(?:tracks?|songs?|cuts?|candidates?|recommendations?)\b/i.test(cleanText(options.request));
}

function effectiveDiscoveryCount(options = {}, profile = null) {
  const requested = parseRequestedCount({ ...options, effectiveCount: 0 });
  if (requested >= 8 || hasExplicitCountRequest(options) || hasHardCountLanguage(options)) return requested;

  const scoringMode = normalizeScoringMode(options);
  if (!["explore", "taste-guided"].includes(scoringMode)) return requested;

  const discoveryText = normalize(requestText(options));
  const discoveryIntent = /\b(?:find|discover|recommend|suggest|show|give me|search|explore|rabbit hole)\b/.test(discoveryText);
  const discoveryProfile = profile || buildDiscoveryProfile(options);
  const hasLane = Boolean(
    discoveryProfile.targetGenres?.length ||
    discoveryProfile.vibeTerms?.length ||
    discoveryProfile.primaryTarget ||
    cleanText(options.request)
  );

  return discoveryIntent && hasLane ? Math.min(12, Math.max(8, requested + 5)) : requested;
}

function candidatePoolSize(result = {}) {
  return (Array.isArray(result.tracks) ? result.tracks.length : 0) +
    (Array.isArray(result.alternates) ? result.alternates.length : 0);
}

function hasCanonicalYear(track = {}) {
  const evidence = track.releaseEvidence || {};
  return Boolean(track.year && (evidence.albumYear || evidence.trackYear || evidence.isrcYear || evidence.albumDate || evidence.trackDate));
}

function hasCanonicalReleaseDate(track = {}) {
  const evidence = track.releaseEvidence || {};
  return Boolean(track.releaseDate && (evidence.albumDate || evidence.trackDate || track.yearSource === "tidal-web"));
}

function hasCanonicalReleaseForRange(track = {}, range = null) {
  if (!range) return true;
  return range.dateSpecific ? hasCanonicalReleaseDate(track) : hasCanonicalYear(track);
}

function releaseValueForDisplay(track = {}) {
  return track.releaseDate || track.tidal?.releaseDate || track.year || track.tidal?.year || "";
}

function embeddedYears(value) {
  return Array.from(cleanText(value).matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => Number(match[1]));
}

function hasOutOfRangeEmbeddedYear(track, range) {
  if (!range) return false;
  return embeddedYears(`${track.title} ${track.album}`).some((year) => year < range.min || year > range.max);
}

function allowsNearYearFallback(options = {}, range = parseYearRange(options)) {
  if (!range || range.dateSpecific || range.min !== range.max) return false;
  const currentYear = new Date().getFullYear();
  if (range.max < currentYear - 1) return false;

  const text = normalize(requestText(options));
  if (requestHasExplicitReleaseFilter(options) && !/\b(?:near|nearby|around|roughly|approx(?:imately)?|broaden|broader|adjacent years?)\b/.test(text)) return false;
  if (/\b(?:today|yesterday|this week|last week|last 7|this month|last month|exact date|release date)\b/.test(text)) return false;
  if (/\b(?:exact|exactly|only|strict|strictly|must|hard)\b.{0,24}\b(?:19\d{2}|20\d{2})\b/.test(text)) return false;
  if (/\b(?:19\d{2}|20\d{2})\b.{0,16}\b(?:only|exactly|strictly)\b/.test(text)) return false;
  return true;
}

function nearYearFallbackOptions(options = {}, range = parseYearRange(options)) {
  if (!allowsNearYearFallback(options, range)) return null;
  const min = Math.max(1990, Number(range.min) - 2);
  return {
    ...options,
    years: `${min}-${range.max}`,
    nearYearFallback: true
  };
}

function requestHasExplicitReleaseFilter(options = {}) {
  if (cleanText(options.releasePreset || options.releaseExactDate || options.releaseStartDate || options.releaseEndDate || options.years)) return true;
  return /\b(?:today|yesterday|this week|last 7 days|last seven days|last 30 days|last thirty days|last 90 days|last ninety days|this year|19\d{2}|20\d{2})\b/.test(normalize(requestText(options)));
}

function releaseFilterRequiresVerification(options = {}, range = parseYearRange(options)) {
  return Boolean(range && requestHasExplicitReleaseFilter(options));
}

function isReissueLike(track = {}) {
  const text = normalize(`${track.title} ${track.album}`);
  return /\b(?:remaster(?:ed)?|re master(?:ed)?|reissue|re issued|anniversary|deluxe|expanded|restored|archive|classic|classics|retouch|alternative version|alt mix|best of|years of|mixed by|lost tapes|vault|anthology)\b/.test(text);
}

function isShortEdit(track = {}) {
  const text = normalize(`${track.title} ${track.album}`);
  return /\b(?:radio edit|short edit|single edit|edit)\b/.test(text);
}

function requestUsesNowPlayingAsSeed(options = {}) {
  const request = cleanText(options.request);
  const text = normalize(`${options.request || ""} ${options.reference || ""}`);
  if (!request && !cleanText(options.genres)) return true;
  return /\b(?:now playing|current roon|current track|current song|what is playing|this track|this song|use current|like this|like what is playing|around what is playing)\b/.test(text);
}

function isProgressiveSceneTarget(profile = {}) {
  return Boolean(profile.isProgressiveTarget || profile.isProgressiveTranceTarget);
}

function progressiveSceneTargetFor(profile = {}) {
  if (profile.isProgressiveTranceTarget) return "progressive trance";
  if (profile.isProgressiveTarget) return "progressive house";
  return "";
}

function matchingSceneArtist(value, profile = {}, options = {}) {
  const artists = profile.isProgressiveTranceTarget ? TRANCE_FORWARD_ARTISTS : PROGRESSIVE_ARTISTS;
  return artists.find((artist) => artistMatchesKnownName(value, artist, options)) || "";
}

function matchingSceneRemixer(track = {}, profile = {}) {
  if (!isProgressiveSceneTarget(profile)) return "";
  const title = cleanText(track.title || track);
  if (!title || !/\b(?:remix|rework|dub|edit|mix|version)\b/i.test(title)) return "";
  const artists = profile.isProgressiveTranceTarget ? TRANCE_FORWARD_ARTISTS : PROGRESSIVE_ARTISTS;
  const normalizedTitle = normalize(title);
  return artists.find((artist) => normalizedTitle.includes(normalize(artist))) || "";
}

function queryStartsWithKnownLabel(query = "", profile = {}) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return false;
  const labels = uniqueTerms([
    ...(profile.requestedLabels || []),
    ...progressiveSceneLabelsFor(profile)
  ], 80)
    .map((label) => normalize(label))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  return labels.some((label) => normalizedQuery === label || normalizedQuery.startsWith(`${label} `));
}

function queryTargetArtist(query, profile = {}) {
  const normalizedQuery = normalize(query);
  if (queryStartsWithKnownLabel(query, profile)) return "";
  const artists = profile.isProgressiveTranceTarget
    ? uniqueValues([...TRANCE_FORWARD_ARTISTS, ...PROGRESSIVE_ARTISTS])
    : PROGRESSIVE_ARTISTS;
  return artists.find((artist) => {
    const normalizedArtist = normalize(artist);
    if (normalizedQuery !== normalizedArtist && !normalizedQuery.startsWith(`${normalizedArtist} `)) return false;
    if (!isCollisionSensitiveArtist(artist)) return true;
    const rawPrefix = cleanText(query).split(/\s+/).slice(0, cleanText(artist).split(/\s+/).length).join(" ");
    return artistNamesMatch(rawPrefix, artist);
  }) || "";
}

function artistMatchesKnownName(value = "", knownName = "", options = {}) {
  const artists = splitArtists(value);
  // Keep group names such as Above & Beyond intact alongside collaboration
  // credits. A longer, unrelated artist name is never scene identity evidence.
  const credits = cleanText(value).split(/\s*(?:,|;|\/|\bfeat(?:uring)?\.?\s+|\bft\.?\s+)\s*/i);
  const candidates = [value, ...credits, ...artists];
  return candidates.some((artist) => artistNamesMatch(artist, knownName, options));
}

function wantsLongTracks(options = {}) {
  const text = normalize(`${options.request} ${options.mood} ${options.genres}`);
  return /\b(?:long|extended|8 minute|8 min|eight minute|journey|deep mix|club mix)\b/.test(text);
}

function hardDurationConstraintFor(options = {}) {
  const directMs = Number(options.minDurationMs ?? options.minimumDurationMs ?? options.min_duration_ms ?? 0);
  if (Number.isFinite(directMs) && directMs > 0) {
    return { minimumMs: directMs, source: "explicit milliseconds" };
  }

  const directSeconds = Number(options.minDurationSeconds ?? options.minimumDurationSeconds ?? options.min_duration_seconds ?? 0);
  if (Number.isFinite(directSeconds) && directSeconds > 0) {
    return { minimumMs: directSeconds * 1000, source: "explicit seconds" };
  }

  const directMinutes = Number(options.minDurationMinutes ?? options.minimumDurationMinutes ?? options.min_duration_minutes ?? 0);
  if (Number.isFinite(directMinutes) && directMinutes > 0) {
    return { minimumMs: directMinutes * 60000, source: "explicit minutes" };
  }

  const text = normalize(requestText(options));
  const patterns = [
    /\b(?:at least|minimum(?: of)?|no shorter than|longer than|over|more than)\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/,
    /\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\s*(?:minimum|or longer|or more|plus)\b/,
    /\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\s+(?:tracks?|songs?|cuts?)\b/,
    /\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b(?=.{0,48}\b(?:tracks?|songs?|cuts?|recommendations?)\b)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const minutes = Number(match?.[1] || 0);
    if (Number.isFinite(minutes) && minutes > 0) {
      return { minimumMs: minutes * 60000, source: "hard duration language" };
    }
  }

  return null;
}

function durationConstraintReason(track = {}, options = {}) {
  const constraint = hardDurationConstraintFor(options);
  if (!constraint) return "";
  const minimumMinutes = constraint.minimumMs / 60000;
  const minimumLabel = `${Number.isInteger(minimumMinutes) ? minimumMinutes : minimumMinutes.toFixed(1)} minutes`;
  const duration = Number(track.durationMs || 0);
  if (!(duration > 0)) return `No duration available to confirm the hard minimum of ${minimumLabel}.`;
  if (duration < constraint.minimumMs) {
    return `Duration ${(duration / 60000).toFixed(1)} minutes is below the hard minimum of ${minimumLabel}.`;
  }
  return "";
}

function requestPrefersExtendedMixes(options = {}) {
  const text = normalize(requestText(options));
  return Boolean(
    /\b(?:prefer|prioritize|prioritise|favor|favour|find|give|use)\b.{0,60}\b(?:extended|club|long)\s+(?:mixes?|versions?|cuts?)\b/.test(text) ||
    /\b(?:extended|club|long)\s+(?:mixes?|versions?|cuts?)\b.{0,40}\b(?:available|preferred|prefer|priority)\b/.test(text) ||
    /\b(?:extended mixes?|extended versions?|club mixes?|long mixes?|full length mixes?)\b/.test(text)
  );
}

function hasExtendedMixText(value = "") {
  return /\b(?:extended\s+(?:mix|version|remix|cut)|club\s+mix|full\s+length|long\s+(?:mix|version|cut)|12\s*(?:inch|")\s+(?:mix|version))\b/i.test(String(value || ""));
}

function durationMinutes(track = {}) {
  return Number(track.durationMs || 0) / 60000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function minimumScoreFor(options = {}) {
  const raw = cleanText(options.minScore || options.minimumScore || options.minMatch);
  const key = normalize(raw);
  if (!raw) return 0;
  if (Object.prototype.hasOwnProperty.call(SCORE_THRESHOLDS, key)) return SCORE_THRESHOLDS[key];
  return clamp(raw, 0, 100);
}

function scoreBandLabel(scoreValue) {
  const score = Number(scoreValue || 0);
  if (score >= 90) return "Excellent";
  if (score >= 80) return "Strong";
  if (score >= 70) return "Worth checking";
  if (score >= 60) return "Experimental";
  return "Long shot";
}

function titleCase(value) {
  return cleanText(value)
    .split(" ")
    .map((word) => word ? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}` : "")
    .join(" ");
}

function positiveIntentText(value = "") {
  return cleanText(value)
    .replace(/\b(?:do\s+not|don't|dont|avoid|exclude|without|skip|no)\b[^.?!;\n]*?\bunless\b/gi, " ")
    .replace(/\b(?:do\s+not|don't|dont|avoid|exclude|without|skip|no)\b[^.?!;,\n]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferredGenreFor(track = {}, options = {}, profile = buildDiscoveryProfile(options), breakdown = {}) {
  const inference = breakdown.genreInference || {};
  if (Array.isArray(inference.inferredGenres) && inference.inferredGenres.length) {
    return titleCase(inference.inferredGenres[0]);
  }

  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)} ${track.query}`);
  const requestedText = normalize(`${positiveIntentText(options.request)} ${options.genres} ${options.mood}`);
  const matchedTarget = (profile.targetGenres || []).find((term) => hasAnyTerm(metadataText, [term])) ||
    (profile.targetGenres || [])[0] ||
    cleanText(options.genres);
  const hasProgressiveSignal = /\bprogressive\b/.test(`${requestedText} ${metadataText}`) ||
    hasAnyTerm(metadataText, ["melodic progressive", "deep progressive", "progressive house", "progressive trance"]);

  if (/\btech house\b/.test(`${requestedText} ${metadataText}`) && hasProgressiveSignal) return "Progressive Tech House";
  if (matchedTarget) return titleCase(matchedTarget);
  if (hasProgressiveSignal) return "Progressive Electronic";
  return "Open Genre Discovery";
}

function promptIntentEvidenceFor(track = {}, query = "", profile = {}) {
  const promptIntent = profile.promptIntent || {};
  const terms = uniqueTerms(promptIntent.matchTerms || [], 32);
  if (!terms.length) {
    return {
      confidence: 0,
      matchedTerms: [],
      evidence: [],
      summary: "",
      queryOnly: false,
      corroboratesRequested: !promptIntent.hasIntent
    };
  }

  const title = normalize(track.title);
  const album = normalize(track.album);
  const label = normalize(labelText(track));
  const artist = normalize(track.artist);
  const metadataText = normalize(`${track.title} ${track.album} ${labelText(track)} ${track.artist}`);
  const queryText = normalize(query || track.query);
  const evidence = [];
  const matchedTerms = new Set();

  function add(source, term, weight, detail = {}) {
    const cleanTerm = cleanText(term);
    if (!cleanTerm || !weight) return;
    evidence.push({
      source,
      label: `${cleanTerm} ${source}`,
      term: cleanTerm,
      weight: Number(weight),
      queryOnly: Boolean(detail.queryOnly)
    });
    matchedTerms.add(cleanTerm);
  }

  for (const term of terms) {
    if (containsNormalized(title, term)) add("title", term, 28);
    else if (containsNormalized(album, term)) add("album", term, 18);
    else if (containsNormalized(label, term)) add("label", term, 10);
    else if (containsNormalized(artist, term)) add("artist", term, 8);
    else if (containsNormalized(metadataText, term)) add("metadata", term, 8);
    else if (containsNormalized(queryText, term)) add("search query", term, 4, { queryOnly: true });
  }

  const positive = evidence.filter((item) => item.weight > 0);
  const nonQueryPositive = positive.some((item) => !item.queryOnly);
  const coverage = terms.length ? matchedTerms.size / Math.min(terms.length, 8) : 0;
  const rawTotal = positive.reduce((sum, item) => sum + item.weight, 0);
  const confidence = clamp(Math.round(Math.max(rawTotal, coverage * 70 + Math.min(25, rawTotal * 0.3))), 0, 100);
  const summary = evidence
    .filter((item) => item.weight > 0 && !item.queryOnly)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 3)
    .map((item) => item.label)
    .join(", ");

  return {
    confidence,
    matchedTerms: [...matchedTerms],
    evidence: evidence.sort((left, right) => right.weight - left.weight).slice(0, 8),
    summary,
    queryOnly: positive.some((item) => item.queryOnly) && !nonQueryPositive,
    corroboratesRequested: Boolean(nonQueryPositive || confidence >= 55)
  };
}

function promptMatchFor(track = {}, options = {}, breakdown = {}, profile = buildDiscoveryProfile(options)) {
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const queryText = normalize(track.query);
  const combinedText = normalize(`${metadataText} ${queryText}`);
  const targetGenres = profile.targetGenres || [];
  const vibeTerms = profile.vibeTerms || [];
  const genreInference = breakdown.genreInference || {};
  const vibeInference = breakdown.vibeInference || {};
  const promptIntent = profile.promptIntent || {};
  const promptIntentEvidence = breakdown.promptIntentEvidence || promptIntentEvidenceFor(track, track.query, profile);
  const reasons = [];

  const genreScore = targetGenres.length
    ? (hasAnyTerm(metadataText, targetGenres)
      ? 38
      : (Number(genreInference.confidence || 0) >= 45
        ? Math.round(clamp(genreInference.confidence, 0, 100) * 0.38)
        : (hasAnyTerm(queryText, targetGenres) ? 24 : Math.round((Number(breakdown.genreMatch || 0) / SCORE_MAX.genreMatch) * 30))))
    : (promptIntent.matchTerms?.length ? 10 : 24);
  const intentScore = promptIntent.matchTerms?.length
    ? (promptIntentEvidence.corroboratesRequested
      ? Math.round(clamp(promptIntentEvidence.confidence || 0, 0, 100) * 0.32)
      : (promptIntentEvidence.queryOnly ? 6 : 0))
    : 0;
  const vibeScore = vibeTerms.length
    ? (vibeInference.corroboratesRequested
      ? Math.round(clamp(vibeInference.confidence || 0, 0, 100) * 0.18)
      : (vibeInference.queryOnly ? 4 : Math.round((Number(breakdown.genreMatch || 0) / SCORE_MAX.genreMatch) * 8)))
    : 12;
  const entityScore = Math.round(((Number(breakdown.artistMatch || 0) / SCORE_MAX.artistMatch) * 18) +
    ((Number(breakdown.labelMatch || 0) / SCORE_MAX.labelMatch) * 12));
  const releaseScore = Math.round((Number(breakdown.freshness || 0) / SCORE_MAX.freshness) * 12);
  const lengthScore = Math.round((Number(breakdown.lengthPreference || 0) / SCORE_MAX.lengthPreference) * 8);
  const percent = clamp(Math.round(intentScore + genreScore + vibeScore + entityScore + releaseScore + lengthScore), 0, 100);

  if (promptIntent.themeTerms?.length) reasons.push(`Theme-first search for ${promptIntent.themeTerms.slice(0, 3).join(", ")}.`);
  if (promptIntent.activityTerms?.length) reasons.push(`Activity/context search for ${promptIntent.activityTerms.slice(0, 3).join(", ")}.`);
  if (promptIntentEvidence.summary) reasons.push(`Prompt evidence from ${promptIntentEvidence.summary}.`);
  else if (promptIntentEvidence.queryOnly) reasons.push("Prompt terms only appeared in the search query.");
  if (targetGenres.length) reasons.push(`User requested ${targetGenres[0]}.`);
  if (genreInference.summary && Number(genreInference.confidence || 0) >= 35) {
    reasons.push(`Genre inferred from ${genreInference.summary}.`);
  }
  if (vibeTerms.length && vibeInference.summary) reasons.push(`Trait evidence from ${vibeInference.summary}.`);
  else if (vibeTerms.length && vibeInference.queryOnly) reasons.push("Requested trait words only appeared in the search query.");
  if (profile.requestedArtists?.length && hasSeedArtistMatch(track, options, profile)) reasons.push("Matched a requested or seeded artist.");
  if (profile.requestedLabels?.length && requestedLabelMatch(track, profile)) reasons.push("Matched a requested label.");
  if (releaseScore >= 10) reasons.push("Release date fits the requested window.");
  if (lengthScore >= 7) reasons.push("Length fits the listening preference.");
  if (!reasons.length) reasons.push("Selected from the closest catalogue/search overlap.");

  return {
    percent,
    label: percent >= 85 ? "High" : (percent >= 65 ? "Moderate" : (percent >= 45 ? "Loose" : "Weak")),
    reasons: reasons.slice(0, 4)
  };
}

function tasteMatchFor(track = {}, breakdown = {}, profile = {}) {
  const adjustment = Number(breakdown.tasteAdjustment || 0);
  const reasons = [];
  const base = profile.scoringMode === "pure" ? 50 : 58;
  const percent = clamp(Math.round(base + adjustment * 4 + (Number(breakdown.artistMatch || 0) / SCORE_MAX.artistMatch) * 14 + (Number(breakdown.labelMatch || 0) / SCORE_MAX.labelMatch) * 10), 0, 100);

  for (const reason of breakdown.tasteReasons || []) reasons.push(`Taste profile signal: ${reason}.`);
  if (adjustment > 0) reasons.push("Boosted by previous Love/Like/candidate signals.");
  if (adjustment < 0) reasons.push("Reduced by previous Dislike/Never Again signals.");
  if (!reasons.length && profile.scoringMode === "pure") reasons.push("Taste weighting is disabled for Pure Search mode.");
  if (!reasons.length) reasons.push("Taste profile has limited direct signal for this track.");

  return {
    percent,
    label: percent >= 85 ? "Strong taste fit" : (percent >= 65 ? "Taste-adjacent" : (percent >= 45 ? "Neutral taste fit" : "Outside usual taste")),
    reasons: reasons.slice(0, 4)
  };
}

function matchExplanationFor(track = {}, options = {}, breakdown = {}, profile = buildDiscoveryProfile(options)) {
  const prompt = promptMatchFor(track, options, breakdown, profile);
  const taste = tasteMatchFor(track, breakdown, profile);
  const genre = inferredGenreFor(track, options, profile, breakdown);
  const why = [];

  why.push(...prompt.reasons.slice(0, 2));
  if (taste.percent >= 75) {
    why.push("User taste profile strongly supports this pick.");
  } else if (taste.percent <= 45) {
    why.push("This is more prompt-led than taste-led.");
  }
  if (prompt.percent >= 55 && taste.percent >= 70) why.push("Result selected from the prompt/taste overlap region.");
  if (track.discoveryLane === "adjacent") why.push("Adjacent-lane result kept for discovery range.");
  if (track.discoveryLane === "branch") why.push("Branch-source result kept from a similar artist, label, radio, or remixer seed.");
  if (track.discoveryLane === "omnivore") why.push("Cross-genre taste-bridge result kept for open discovery.");

  const seen = new Set();
  return {
    prompt,
    taste,
    genre,
    why: why.filter((reason) => {
      const key = normalize(reason);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5)
  };
}

function minimumScoreLabel(scoreValue) {
  const score = Number(scoreValue || 0);
  return score > 0 ? `${scoreBandLabel(score)}+ (${score}+)` : "All verified";
}

const PROGRESSIVE_ARTISTS = [
  "Lane 8",
  "Marsh",
  "Ezequiel Arias",
  "Guy J",
  "Khen",
  "GMJ",
  "Matter",
  "Kamilo Sanclemente",
  "Forty Cats",
  "Gai Barone",
  "Dmitry Molosh",
  "Nicolas Rada",
  "Alex O'Rion",
  "Sebastian Sellares",
  "Hobin Rude",
  "Forerunners",
  "Antrim",
  "Mango",
  "Callecat",
  "Hernan Cattaneo",
  "Nick Warren",
  "Sasha",
  "John Digweed",
  "Quivver",
  "Cristoph",
  "Jeremy Olander",
  "Einmusik",
  "Sébastien Léger",
  "Roy Rosenfeld",
  "Gorje Hewek",
  "Volen Sentir",
  "Makebo",
  "RÜFÜS DU SOL",
  "Yotto",
  "Khen",
  "Stan Kolev",
  "Jerome Isma-Ae",
  "Paul Thomas",
  "Basil O'Glue",
  "Solarstone",
  "Cid Inc.",
  "D-Nox",
  "Darin Epsilon",
  "Dousk",
  "Framewerk",
  "Emi Galvan",
  "Mike Rish",
  "Subandrio",
  "Mauro Augugliaro",
  "Berni Turletti",
  "Simos Tagias",
  "Ruben Karapetyan",
  "Juan Deminicis",
  "Analog Jungs",
  "Nopi",
  "Dabeat",
  "Ziger",
  "Nicolas Viana",
  "Hicky & Kalo",
  "Budakid",
  "Tim Green",
  "Lost Desert",
  "Eelke Kleijn",
  "GMJ & Matter",
  "Kasablanca",
  "Rodriguez Jr.",
  "Dosem",
  "Simon Doty",
  "Braxton",
  "Qrion",
  "Durante",
  "Eli & Fur",
  "Tinlicker",
  "Ben Bohmer",
  "Luttrell",
  "16BL",
  "Spencer Brown",
  "Romain Garcia",
  "Nils Hoffmann",
  "Jody Wisternoff",
  "James Grant",
  "Joris Voorn",
  "Monkey Safari",
  "Sultan + Shepard",
  "Mass Digital",
  "M.O.S.",
  "Miraval",
  "Kostya Outta",
  "Jiminy Hop",
  "Fuenka",
  "Paul Deep",
  "Zankee Gulati",
  "Mike Griego",
  "Mayro",
  "Rodrigo Lapena",
  "Cocho",
  "Juan Ibanez",
  "Agustin Pietrocola",
  "Matias Chilano",
  "Dowden",
  "Navar",
  "Weird Sounding Dude",
  "Savvas",
  "Kenan Savrun",
  "Ric Niels",
  "Fede Archdale",
  "Lucas Rossi",
  "Golan Zocher",
  "Choopie",
  "Nick Muir",
  "Jamie Stevens"
];

const PROGRESSIVE_FRESH_ANCHORS = [
  "D-Nox Andre Moret",
  "D-Nox",
  "Andre Moret",
  "Ruben Karapetyan",
  "Hobin Rude",
  "Cid Inc.",
  "Guy J",
  "Khen",
  "GMJ Matter",
  "Kamilo Sanclemente",
  "Paul Thomas",
  "Ezequiel Arias",
  "Sebastian Sellares",
  "Nicolas Rada",
  "Forty Cats",
  "Dmitry Molosh"
];

// These names have appeared in learned Progressive House query history. They
// are kept as negative evidence for other hard genre requests without adding
// them to the user-facing progressive anchor pool.
const KNOWN_PROGRESSIVE_TASTE_CONTAMINATION = [
  "Beckers",
  "Maze 28",
  "Fluke"
];

const TRANCE_FORWARD_ARTISTS = [
  "Solarstone",
  "Scott Bond",
  "Basil O'Glue",
  "Jerome Isma-Ae",
  "Paul Thomas",
  "Forerunners",
  "Andrew Bayer",
  "ilan Bluestone",
  "Genix",
  "Grum",
  "John 00 Fleming",
  "Airwave",
  "Ruben Karapetyan",
  "Giuseppe Ottaviani",
  "Aly & Fila",
  "John O'Callaghan",
  "Craig Connelly",
  "The Thrillseekers",
  "Alex M.O.R.P.H.",
  "Factor B",
  "Art Of Trance",
  "Gai Barone"
];

const SCENE_TERMS = [
  "progressive house",
  "melodic progressive house",
  "deep progressive house",
  "organic progressive house",
  "progressive trance",
  "melodic house",
  "melodic techno"
];

// EDM is a parent discovery domain, not a single catalog genre. Keep this
// list intentionally broad so an "any EDM lane" request can explore across
// legitimate electronic scenes without opening the entire TIDAL catalog.
const ELECTRONIC_DOMAIN_TERMS = [
  "edm",
  "electronic",
  "electronic dance music",
  "electronic music",
  "dance music",
  "house",
  "deep house",
  "progressive house",
  "organic house",
  "tech house",
  "melodic house",
  "melodic techno",
  "techno",
  "trance",
  "progressive trance",
  "psytrance",
  "drum and bass",
  "dnb",
  "dubstep",
  "bass music",
  "experimental bass",
  "uk bass",
  "breaks",
  "breakbeat",
  "electro",
  "electronica",
  "indie dance",
  "future bass",
  "bass house",
  "garage",
  "synthwave"
];

// These are discovery anchors, not a taste whitelist. They give an open EDM
// request a real catalog starting point before any semantic mood/activity
// wording is considered.
const EDM_DISCOVERY_ARTISTS = [
  "Space 92",
  "HI-LO",
  "Eli Brown",
  "Layton Giordani",
  "Reinier Zonneveld",
  "UMEK",
  "Charlotte de Witte",
  "Amelie Lens",
  "ARTBAT",
  "Adam Beyer",
  "Anyma",
  "John Summit",
  "Chris Lake",
  "FISHER",
  "Habstrakt",
  "Malaa",
  "Skrillex",
  "Alix Perez",
  "Of The Trees",
  "Tape B",
  "Astrix",
  "Hybrid",
  "Bicep"
];

const EDM_DISCOVERY_LABELS = [
  "Drumcode",
  "KNTXT",
  "Terminal M",
  "Confession",
  "Filth on Acid",
  "Factory 93 Records",
  "Afterlife",
  "Defected",
  "Toolroom",
  "Solid Grooves",
  "Dirtybird",
  "Wakaan",
  "Deep Dark & Dangerous",
  "DUPLOC",
  "1985 Music",
  "Deep Medi Musik",
  "Hospital Records",
  "Critical Music",
  "Shogun Audio",
  "Iboga Records"
];

const SEMANTIC_QUERY_TERMS = new Set([
  "driving",
  "drive",
  "rolling",
  "underground",
  "deep cut",
  "deep cuts",
  "dark",
  "hypnotic",
  "euphoric",
  "filthy",
  "melodic",
  "minimal",
  "minimal vocals",
  "vocal",
  "vocals",
  "instrumental",
  "peak time",
  "peak-time",
  "club",
  "club tracks",
  "night drive",
  "road trip",
  "music",
  "tracks",
  "songs",
  "new releases",
  "new release"
]);

const PROGRESSIVE_CATALOG_TARGETS = [
  "progressive house",
  "melodic progressive house",
  "deep progressive house",
  "organic house",
  "melodic house",
  "melodic techno",
  "deep melodic house"
];

const PROGRESSIVE_LABELS = [
  "Anjunadeep",
  "This Never Happened",
  "Lost & Found",
  "Sudbeat",
  "Bedrock",
  "Balance Music",
  "The Soundgarden",
  "Meanwhile",
  "Mango Alley",
  "Replug",
  "Proton Music",
  "Plattenbank",
  "Manual Music",
  "Songspire Records",
  "Colorize",
  "UV",
  "onedotsixtwo",
  "Renaissance Records",
  "Selador",
  "Beat Boutique",
  "Movement Recordings",
  "Hoomidaas",
  "All Day I Dream",
  "Armada Electronic Elements",
  "Einmusika Recordings",
  "Last Night On Earth",
  "Where The Heart Is",
  "The Soundgarden",
  "Univack",
  "Droid9",
  "Future Avenue",
  "Deepwibe Underground",
  "AH Digital",
  "BC2",
  "Sound Avenue",
  "3rd Avenue",
  "ICONYC",
  "Stellar Fountain",
  "Warung Recordings",
  "TRYBESof"
];

// These are bounded scene anchors for an explicit Progressive Trance lane.
// They are admission evidence only when the returned candidate has the
// matching artist/label identity; they do not bypass catalogue or identity
// safety checks and are not free-form mood/activity evidence.
const PROGRESSIVE_TRANCE_LABELS = [
  "Anjunabeats",
  "Enhanced Progressive",
  "Coldharbour",
  "Coldharbour Recordings",
  "Pure Trance",
  "Black Hole",
  "Black Hole Recordings",
  "FSOE",
  "Future Sound of Egypt",
  "JOOF Recordings",
  "Subculture",
  "Armada Captivating",
  "Vandit",
  "Perfecto",
  "WAO138?!"
];

function progressiveSceneLabelsFor(profile = {}) {
  return profile.isProgressiveTranceTarget ? PROGRESSIVE_TRANCE_LABELS : PROGRESSIVE_LABELS;
}

const OMNIVORE_DISCOVERY_LANES = [
  {
    id: "leftfield-electronic",
    targets: ["leftfield electronic", "electronica", "IDM"],
    anchors: ["Ninja Tune", "Warp", "Ghostly International", "Brainfeeder", "!K7", "Planet Mu", "Four Tet", "Jon Hopkins", "Bonobo", "Bicep"]
  },
  {
    id: "downtempo",
    targets: ["downtempo", "organic downtempo", "chillout"],
    anchors: ["Music From Memory", "International Feel", "Ultimae", "Night Time Stories", "Kiasmos", "Tycho", "Maribou State", "Emancipator"]
  },
  {
    id: "ambient",
    targets: ["ambient", "deep ambient", "cinematic ambient"],
    anchors: ["Erased Tapes", "Kranky", "12k", "ECM", "Biosphere", "Loscil", "Nils Frahm", "A Winged Victory for the Sullen"]
  },
  {
    id: "indie-dance",
    targets: ["dark disco", "cosmic disco", "leftfield disco"],
    anchors: ["Permanent Vacation", "Running Back", "Kompakt", "Correspondant", "DFA", "Red Axes", "Pional", "Mano Le Tough"]
  },
  {
    id: "nu-disco",
    targets: ["nu disco", "balearic", "cosmic disco"],
    anchors: ["Glitterbox", "Salsoul", "West End Records", "Toy Tonics", "Razor-N-Tape", "Folamour", "Todd Terje", "Dimitri From Paris"]
  },
  {
    id: "breaks",
    targets: ["progressive breaks", "breakbeat", "electro breaks"],
    anchors: ["Marine Parade", "Distinctive Records", "Botchit & Scarper", "Hybrid", "BT", "Bicep", "Overmono", "Plump DJs"]
  },
  {
    id: "psychedelic-electronic",
    targets: ["psybient", "psybreaks", "progressive psytrance"],
    anchors: ["Iboga Records", "JOOF Recordings", "Ultimae", "Shpongle", "Carbon Based Lifeforms", "Ott", "Younger Brother", "Desert Dwellers"]
  },
  {
    id: "jazz-fusion",
    targets: ["jazz fusion", "nu jazz", "spiritual jazz"],
    anchors: ["Blue Note", "Impulse!", "Brownswood", "International Anthem", "ECM", "Yussef Dayes", "Nubya Garcia", "Makaya McCraven"]
  },
  {
    id: "modern-soul",
    targets: ["neo soul", "alt R&B", "modern soul"],
    anchors: ["Daptone", "Stones Throw", "Brainfeeder", "SAULT", "Michael Kiwanuka", "Kelela", "The Internet", "Anderson .Paak"]
  },
  {
    id: "dream-pop",
    defaultEnabled: false,
    enableWhen: /\b(?:dream pop|indie|indie electronic|synth pop|4ad|domino|m83|beach house|chromatics|the xx|roosevelt|vocal|song|songs|band|bands)\b/i,
    targets: ["dream pop", "indie electronic", "synth pop"],
    anchors: ["4AD", "Domino", "Ghostly International", "M83", "Beach House", "Chromatics", "The xx", "Roosevelt"]
  },
  {
    id: "cinematic-rock",
    defaultEnabled: false,
    enableWhen: /\b(?:post rock|cinematic rock|krautrock|rock|mogwai|explosions in the sky|tortoise|neu|can|godspeed)\b/i,
    targets: ["post rock", "cinematic rock", "krautrock"],
    anchors: ["Constellation", "Temporary Residence", "Mogwai", "Explosions in the Sky", "Tortoise", "Neu!", "Can", "Godspeed You! Black Emperor"]
  },
  {
    id: "deep-bass",
    targets: ["deep dubstep", "UK bass", "wave"],
    anchors: ["Hyperdub", "Tempa", "Deep Medi Musik", "Ilian Tape", "Burial", "Skee Mask", "Floating Points", "Mount Kimbie"]
  }
];

const OMNIVORE_DEFAULT_TRAITS = [
  "melodic",
  "hypnotic",
  "deep",
  "atmospheric",
  "driving",
  "emotional",
  "cinematic",
  "groove"
];

function omnivoreLaneEnabled(lane = {}, options = {}) {
  if (lane.defaultEnabled !== false) return true;
  const text = requestText(options);
  if (lane.enableWhen?.test?.(text)) return true;
  return [...(lane.targets || []), ...(lane.anchors || [])].some((term) => containsEntityTerm(text, term));
}

function activeOmnivoreDiscoveryLanes(options = {}) {
  return OMNIVORE_DISCOVERY_LANES.filter((lane) => omnivoreLaneEnabled(lane, options));
}

const SEED_ARTIST_VIBES = [
  ["Depeche Mode", ["80s", "dark synth", "new wave", "analog synth"]],
  ["New Order", ["80s", "new wave", "dance rock", "synth pop"]],
  ["Pet Shop Boys", ["80s", "synth pop", "hi nrg", "elegant pop"]],
  ["Tears for Fears", ["80s", "sophisticated pop", "melancholy", "big drums"]],
  ["Duran Duran", ["80s", "new romantic", "synth pop", "glossy"]],
  ["Eurythmics", ["80s", "synth pop", "blue eyed soul", "analog synth"]],
  ["The Cure", ["80s", "post punk", "gothic", "melancholy"]],
  ["INXS", ["80s", "dance rock", "funky", "sleek"]],
  ["Talk Talk", ["80s", "art pop", "sophisticated", "atmospheric"]],
  ["Simple Minds", ["80s", "new wave", "anthemic", "wide"]],
  ["A-ha", ["80s", "synth pop", "melodic", "bright"]],
  ["Prince", ["80s", "funk", "synth funk", "slinky"]],
  ["Madonna", ["80s", "dance pop", "club", "bright"]],
  ["Michael Jackson", ["80s", "pop", "funk", "polished"]],
  ["The Human League", ["80s", "synth pop", "new wave", "minimal synth"]],
  ["Gary Numan", ["80s", "cold wave", "synth", "robotic"]]
];

const GENRE_DISCOVERY_SEEDS = [
  ["edm", [
    ...EDM_DISCOVERY_LABELS,
    ...EDM_DISCOVERY_ARTISTS
  ]],
  ["acid house", [
    "Acid Test",
    "Super Rhythm Trax",
    "I Love Acid",
    "Dame-Music",
    "Balkan Vinyl",
    "Clone Jack For Daze",
    "TRAX",
    "Trax Records",
    "Phuture",
    "DJ Pierre",
    "Adonis",
    "Tyree Cooper",
    "Hardfloor",
    "Josh Wink",
    "A Guy Called Gerald",
    "Paranoid London",
    "Tin Man",
    "Posthuman",
    "Luke Vibert",
    "Ceephax Acid Crew"
  ]],
  ["tech house", [
    "Toolroom",
    "Hot Creations",
    "Solid Grooves",
    "Black Book Records",
    "Repopulate Mars",
    "Sola",
    "Saved Records",
    "Elrow Music",
    "Defected",
    "Dirtybird",
    "Cecille",
    "Moon Harbour",
    "Desolat",
    "8Bit",
    "Knee Deep In Sound",
    "Deeperfect",
    "Moan",
    "Moxy Muzik",
    "Kaluki Musik",
    "No Art",
    "PIV",
    "Hottrax",
    "Eastenderz",
    "FUSE London",
    "MicroHertz",
    "LOCUS",
    "Solid Grooves Raw",
    "Chris Lake",
    "FISHER",
    "Patrick Topping",
    "Green Velvet",
    "Jamie Jones",
    "Michael Bibi",
    "Dennis Cruz",
    "Sidney Charles",
    "Chris Stussy",
    "Archie Hamilton",
    "East End Dubs",
    "Traumer",
    "Toman",
    "Prunk",
    "Enzo Siragusa"
  ]],
  ["psytrance", [
    "Iboga Records",
    "Iono Music",
    "Nano Records",
    "Spin Twist Records",
    "Blue Tunes Records",
    "Digital Om",
    "TechSafari Records",
    "Sacred Technology",
    "JOOF Recordings",
    "TesseracTstudio",
    "Shamanic Tales",
    "HOMmega",
    "HOMmega Productions",
    "Stereo Society",
    "Dacru Records",
    "Sourcecode Transmissions",
    "Astrix",
    "Ace Ventura",
    "Liquid Soul",
    "Captain Hook",
    "Perfect Stranger",
    "Freedom Fighters",
    "Outsiders",
    "Symbolic",
    "Protonica",
    "Ritmo",
    "E-Clip",
    "Flegma",
    "Zyce",
    "Sideform",
    "Atacama",
    "Egorythmia",
    "Sonic Species"
  ]],
  ["melodic techno", [
    "Afterlife",
    "Innervisions",
    "Kompakt",
    "Diynamic",
    "Stil vor Talent",
    "Bedrock",
    "Siamese",
    "Adriatique",
    "Tale Of Us",
    "Mind Against",
    "Agents Of Time",
    "Stephan Bodzin"
  ]],
  ["house", [
    "Defected",
    "Glitterbox",
    "Toolroom",
    "Nervous Records",
    "Strictly Rhythm",
    "Kerri Chandler",
    "Louie Vega",
    "Folamour",
    "Purple Disco Machine",
    "The Shapeshifters"
  ]],
  ["deep house", [
    "Anjunadeep",
    "Deepalma",
    "All Day I Dream",
    "Pampa Records",
    "Get Physical Music",
    "Kompakt",
    "Maya Jane Coles",
    "Jimpster",
    "Atjazz",
    "Miguel Migs"
  ]],
  ["techno", [
    "Drumcode",
    "Afterlife",
    "Terminal M",
    "Tronic",
    "Kompakt",
    "Maceo Plex",
    "Adam Beyer",
    "Charlotte de Witte",
    "Enrico Sangiuliano",
    "ANNA"
  ]],
  ["trance", [
    "Anjunabeats",
    "Armada",
    "Black Hole Recordings",
    "Enhanced Progressive",
    "Solarstone",
    "Above & Beyond",
    "Gabriel & Dresden",
    "Markus Schulz",
    "Factor B",
    "John O'Callaghan"
  ]],
  ["breaks", [
    "Marine Parade",
    "Botchit & Scarper",
    "Distinctive Records",
    "Lot49",
    "Finger Lickin'",
    "Plump DJs",
    "Hybrid",
    "The Crystal Method",
    "Stanton Warriors",
    "Meat Katie",
    "Freestylers",
    "Elite Force"
  ]],
  ["dubstep", [
    "Deep Dark & Dangerous",
    "DUPLOC",
    "1985 Music",
    "Chestplate",
    "SubCarbon Records",
    "Disciple",
    "Never Say Die Records",
    "Artikal Music",
    "Deep Medi Musik",
    "Wakaan",
    "Ternion Sound",
    "Truth",
    "The Widdler",
    "Distinct Motive",
    "Alix Perez",
    "Shades",
    "EPROM",
    "Ivy Lab",
    "Hamdi",
    "Tape B",
    "Of The Trees",
    "PEEKABOO",
    "Ganja White Night",
    "LSDREAM",
    "Mersiv",
    "Levity",
    "Subtronics",
    "Zeds Dead",
    "REZZ",
    "Stylust",
    "Liquid Stranger",
    "CloZee",
    "EAZYBAKED",
    "A Hundred Drums"
  ]],
  ["experimental bass", [
    "Wakaan",
    "Ternion Sound",
    "The Widdler",
    "Alix Perez",
    "Shades",
    "EPROM",
    "Ivy Lab",
    "Tape B",
    "Of The Trees",
    "PEEKABOO",
    "Ganja White Night",
    "LSDREAM",
    "Mersiv",
    "Levity",
    "Liquid Stranger",
    "CloZee",
    "EAZYBAKED",
    "Deep Dark & Dangerous",
    "DUPLOC",
    "1985 Music",
    "SubCarbon Records"
  ]],
  ["bass music", [
    "Deep Dark & Dangerous",
    "DUPLOC",
    "1985 Music",
    "Chestplate",
    "SubCarbon Records",
    "Disciple",
    "Artikal Music",
    "Tape B",
    "Of The Trees",
    "PEEKABOO",
    "Ganja White Night",
    "LSDREAM",
    "Mersiv",
    "Levity",
    "Subtronics",
    "Zeds Dead",
    "REZZ",
    "Stylust",
    "Liquid Stranger",
    "CloZee"
  ]],
  ["synthwave", [
    "The Midnight",
    "FM-84",
    "Gunship",
    "Timecop1983",
    "Carpenter Brut",
    "Perturbator",
    "NewRetroWave",
    "Lazerhawk"
  ]],
  ["dark ambient", [
    "Cryo Chamber",
    "Lustmord",
    "Atrium Carceri",
    "Raison d'etre",
    "Haxan Cloak",
    "Kammarheit",
    "Robert Rich",
    "Steve Roach",
    "Sabled Sun",
    "Phelios"
  ]],
  ["ambient", [
    "Kranky",
    "Ghostly International",
    "Erased Tapes",
    "12k",
    "Ultimae",
    "Steve Roach",
    "Biosphere",
    "Loscil",
    "Carbon Based Lifeforms",
    "A Winged Victory for the Sullen"
  ]],
  ["new wave", [
    "New Order",
    "Depeche Mode",
    "The Cure",
    "Tears for Fears",
    "Simple Minds",
    "The Human League",
    "Gary Numan",
    "Pet Shop Boys"
  ]],
  ["disco", [
    "Glitterbox",
    "Salsoul",
    "West End Records",
    "Dimitri From Paris",
    "Purple Disco Machine",
    "Horse Meat Disco",
    "Joey Negro",
    "Folamour"
  ]],
  ["funk", [
    "Parliament",
    "Funkadelic",
    "Prince",
    "Zapp",
    "Cameo",
    "D-Train",
    "The Gap Band",
    "Lettuce"
  ]],
  ["soul", [
    "Daptone",
    "Stax",
    "Motown",
    "Hi Records",
    "Al Green",
    "Marvin Gaye",
    "Aretha Franklin",
    "Curtis Mayfield"
  ]],
  ["r&b", [
    "SZA",
    "H.E.R.",
    "The Internet",
    "Kelela",
    "Frank Ocean",
    "Daniel Caesar",
    "Anderson .Paak",
    "Victoria Monet"
  ]],
  ["jazz", [
    "Blue Note",
    "Impulse!",
    "ECM",
    "Verve",
    "Kamasi Washington",
    "Yussef Dayes",
    "Makaya McCraven",
    "Nubya Garcia"
  ]],
  ["rock", [
    "Sub Pop",
    "4AD",
    "Matador",
    "Domino",
    "The War on Drugs",
    "Tame Impala",
    "Queens of the Stone Age",
    "Radiohead"
  ]],
  ["metal", [
    "Nuclear Blast",
    "Metal Blade",
    "Roadrunner",
    "Relapse",
    "Opeth",
    "Mastodon",
    "Gojira",
    "Tool"
  ]],
  ["ambient", [
    "Music From Memory",
    "Erased Tapes",
    "Kranky",
    "Warp",
    "Brian Eno",
    "Jon Hopkins",
    "Loscil",
    "Biosphere"
  ]],
  ["hip hop", [
    "Griselda",
    "Top Dawg Entertainment",
    "Rhymesayers",
    "Stones Throw",
    "J Dilla",
    "Madlib",
    "Kendrick Lamar",
    "Nas"
  ]],
  ["country", [
    "Sturgill Simpson",
    "Tyler Childers",
    "Jason Isbell",
    "Margo Price",
    "Chris Stapleton",
    "Kacey Musgraves",
    "Sierra Ferrell"
  ]],
  ["pop", [
    "Charli XCX",
    "Robyn",
    "Carly Rae Jepsen",
    "Dua Lipa",
    "Christine and the Queens",
    "Rina Sawayama",
    "Jessie Ware"
  ]]
];

const ADJACENT_LANE_TERMS = [
  ["acid house", ["acid techno", "chicago house", "303", "tb-303", "raw house", "jack track", "warehouse house"]],
  ["tech house", ["minimal house", "deep tech", "minimal tech", "club house", "underground house", "rolling house", "bassline house"]],
  ["psytrance", ["progressive psytrance", "goa trance", "full-on psytrance", "psychedelic trance", "deep psytrance"]],
  ["melodic techno", ["indie dance", "melodic house", "progressive house", "deep techno", "dark disco"]],
  ["melodic house", ["deep house", "organic house", "progressive house", "indie dance"]],
  ["deep house", ["organic house", "deep melodic house", "minimal house", "underground house"]],
  ["house", ["deep house", "garage house", "nu disco", "club house", "vocal house"]],
  ["techno", ["deep techno", "hypnotic techno", "dub techno", "melodic techno"]],
  ["trance", ["progressive trance", "classic trance", "melodic trance", "breaks"]],
  ["breaks", ["breakbeat", "progressive breaks", "nu skool breaks", "electro breaks"]],
  ["dark ambient", ["drone", "isolationist ambient", "dark cinematic", "ritual ambient"]],
  ["ambient", ["downtempo", "chillout", "cinematic electronic", "leftfield electronic"]],
  ["electronic", ["leftfield electronic", "cinematic electronic", "downtempo", "electronica"]]
];

const PARENT_GENRE_TERMS = [
  "house",
  "techno",
  "trance",
  "ambient",
  "breaks",
  "breakbeat",
  "drum and bass",
  "dnb",
  "bass",
  "garage",
  "disco",
  "electro",
  "psytrance",
  "rock",
  "alternative",
  "indie",
  "pop",
  "metal",
  "soul",
  "jazz",
  "classical",
  "country",
  "folk"
];

const CHILD_GENRE_KEYWORD_ALIASES = {
  acid: ["acid", "303", "tb 303", "tb303", "squelch", "squelchy"],
  psy: ["psy", "psychedelic"],
  psychedelic: ["psychedelic", "psy"],
  garage: ["garage"],
  speed: ["speed"],
  raw: ["raw"],
  jack: ["jack", "jackin", "jacking"],
  chicago: ["chicago"],
  dub: ["dub"],
  tribal: ["tribal"],
  minimal: ["minimal"],
  deep: ["deep"],
  melodic: ["melodic"],
  organic: ["organic"],
  progressive: ["progressive"],
  hypnotic: ["hypnotic"],
  atmospheric: ["atmospheric"],
  dark: ["dark"]
};

const GENRE_ARTIST_ANCHORS = [
  ["edm", EDM_DISCOVERY_ARTISTS],
  ["acid house", ["Phuture", "DJ Pierre", "Adonis", "Tyree Cooper", "Hardfloor", "Josh Wink", "A Guy Called Gerald", "Paranoid London", "Tin Man", "Posthuman", "Luke Vibert", "Ceephax Acid Crew"]],
  ["tech house", [
    "Chris Stussy",
    "East End Dubs",
    "Archie Hamilton",
    "Sidney Charles",
    "Dennis Cruz",
    "Traumer",
    "Toman",
    "Prunk",
    "Enzo Siragusa",
    "PAWSA",
    "ANOTR",
    "Max Dean",
    "Rossi.",
    "Dimmish",
    "wAFF",
    "Jamie Jones",
    "Green Velvet",
    "Patrick Topping",
    "Chris Lake"
  ]],
  ["psytrance", [
    "Astrix",
    "Ace Ventura",
    "Liquid Soul",
    "Captain Hook",
    "Perfect Stranger",
    "Freedom Fighters",
    "Outsiders",
    "Symbolic",
    "Protonica",
    "Ritmo",
    "E-Clip",
    "Flegma",
    "Zyce",
    "Sideform",
    "Atacama",
    "Egorythmia",
    "Sonic Species"
  ]],
  ["melodic techno", ["Adriatique", "Mind Against", "Agents Of Time", "Stephan Bodzin", "Tale Of Us", "Maceo Plex"]],
  ["deep house", ["Jimpster", "Atjazz", "Miguel Migs", "Maya Jane Coles", "Kerri Chandler"]],
  ["breaks", ["Hybrid", "The Crystal Method", "Stanton Warriors", "Plump DJs", "Meat Katie", "Elite Force"]],
  ["dubstep", [
    "Tape B",
    "Of The Trees",
    "PEEKABOO",
    "Ganja White Night",
    "LSDREAM",
    "Mersiv",
    "Levity",
    "Subtronics",
    "Zeds Dead",
    "REZZ",
    "Stylust",
    "Alix Perez",
    "Shades",
    "EPROM",
    "Ivy Lab",
    "Hamdi",
    "Distinct Motive",
    "Truth",
    "The Widdler",
    "Ternion Sound",
    "Liquid Stranger",
    "CloZee",
    "EAZYBAKED",
    "A Hundred Drums"
  ]]
];

function splitArtists(value) {
  return cleanText(value)
    .replace(/[‐‑‒–—−]/g, "-")
    .split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i)
    .map(cleanText)
    .filter((part) => part && part.length <= 40);
}

function containsNormalized(text, term) {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  if (!normalizedText || !normalizedTerm) return false;
  return normalizedText === normalizedTerm || normalizedText.includes(normalizedTerm);
}

function normalizeGenreKey(value = "") {
  return normalize(value)
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsGenreTerm(text = "", term = "") {
  const source = ` ${normalizeGenreKey(text)} `;
  const needle = normalizeGenreKey(term);
  return Boolean(needle && source.includes(` ${needle} `));
}

function seedGenreMatchesTarget(targetTerms = [], genre = "") {
  const genreKey = normalizeGenreKey(genre);
  if (!genreKey) return false;
  return targetTerms.some((term) => {
    const targetKey = normalizeGenreKey(term);
    if (!targetKey) return false;
    if (targetKey === genreKey) return true;
    if (isBroadGenreTerm(genreKey) || isBroadGenreTerm(targetKey)) return false;
    return targetKey.includes(genreKey) || genreKey.includes(targetKey);
  });
}

function parentGenreTermsFor(value = "") {
  const text = normalize(value);
  if (!text) return [];
  return PARENT_GENRE_TERMS.filter((term) => containsNormalized(text, term));
}

function explicitGenrePhrase(options = {}) {
  const raw = cleanText(options.genres || "");
  if (!raw) return "";
  const first = cleanText(raw.split(/[,;|]/)[0]);
  const normalized = normalizeGenreKey(first);
  if (!normalized || normalized.split(/\s+/).length > 5) return "";
  const detected = detectOntologyGenreTerms(first, { includeAliases: true, limit: 12 });
  const exact = (detected.matches || []).some((match) => (
    normalizeGenreKey(match.canonical) === normalized ||
    (match.aliases || []).some((alias) => normalizeGenreKey(alias) === normalized)
  ));
  if (exact) return normalized;
  const detectedTerms = new Set((detected.terms || []).map(normalize).filter(Boolean));
  return parentGenreTermsFor(normalized).length && detectedTerms.size <= 1 ? normalized : "";
}

function childGenreKeywordsFor(value = "") {
  const parents = new Set(parentGenreTermsFor(value).flatMap((term) => normalize(term).split(/\s+/)));
  const ignored = new Set(["music", "track", "tracks", "song", "songs", "genre", "style", "scene", "sound", "sounds"]);
  const keywords = [];
  for (const token of normalize(value).split(/\s+/).filter(Boolean)) {
    if (parents.has(token) || ignored.has(token)) continue;
    keywords.push(...(CHILD_GENRE_KEYWORD_ALIASES[token] || [token]));
  }
  return uniqueTerms(keywords, 12);
}

function learnedGenreProfileFor(options = {}, key = "") {
  const profiles = options.learnedGenreProfiles || options.genreProfiles || {};
  const normalizedKey = normalize(key);
  if (!normalizedKey || !profiles || typeof profiles !== "object") return null;
  return profiles[normalizedKey] || profiles[key] || null;
}

function dynamicGenreProfileFor(options = {}, targetGenres = []) {
  const explicit = explicitGenrePhrase(options);
  // A multi-term lane such as "dubstep experimental bass bass music" is a
  // discovery target, not a new strict child-genre profile. Only create a
  // learned/dynamic profile for an exact genre phrase or a single detected
  // target; otherwise one child term can incorrectly reject the rest of the
  // requested lane.
  const primary = explicit || ((targetGenres || []).length === 1
    ? (targetGenres || []).find((term) => parentGenreTermsFor(term).length && !isBroadGenreTerm(term))
    : "") || "";
  const key = normalize(primary);
  const learned = learnedGenreProfileFor(options, key);
  const name = cleanText(learned?.name || primary);
  if (!name) return null;
  const parents = uniqueTerms([
    ...parentGenreTermsFor(name),
    ...(Array.isArray(learned?.parentGenres) ? learned.parentGenres : [])
  ], 8);
  const keywords = uniqueTerms([
    ...childGenreKeywordsFor(name),
    ...(Array.isArray(learned?.keywords) ? learned.keywords : [])
  ], 16);
  const strict = Boolean(parents.length && keywords.length && normalize(name) !== normalize(parents[0]));
  return {
    key: normalize(name),
    name,
    dynamic: Boolean(explicit && !targetGenres.some((term) => normalize(term) === key)),
    strict,
    parentGenres: parents,
    keywords,
    labels: uniqueTerms(Array.isArray(learned?.labels) ? learned.labels : [], 24),
    artists: uniqueTerms(Array.isArray(learned?.artists) ? learned.artists : [], 24),
    excludeLabels: uniqueTerms(Array.isArray(learned?.excludeLabels) ? learned.excludeLabels : [], 24),
    excludeArtists: uniqueTerms(Array.isArray(learned?.excludeArtists) ? learned.excludeArtists : [], 24),
    positiveCount: Number(learned?.positiveCount || 0),
    negativeCount: Number(learned?.negativeCount || 0)
  };
}

function containsEntityTerm(text, term) {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  if (!normalizedText || !normalizedTerm) return false;
  if (normalizedTerm.length <= 4) {
    return normalizedText === normalizedTerm || normalizedText.split(/\s+/).includes(normalizedTerm);
  }
  return normalizedText === normalizedTerm || normalizedText.includes(normalizedTerm);
}

function uniqueTerms(values, limit = 20) {
  return uniqueValues(values.map(cleanText).filter(Boolean)).slice(0, limit);
}

function uniqueGenreTerms(values, limit = 20) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const clean = cleanText(value);
    const key = normalizeGenreKey(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= limit) break;
  }
  return result;
}

function pruneBroadGenreTerms(terms = []) {
  return pruneOntologyGenreTerms(terms);
}

const STYLE_ENTITY_WORDS = new Set([
  "acid",
  "afro",
  "ambient",
  "atmosphere",
  "atmospheric",
  "balearic",
  "bass",
  "beat",
  "beats",
  "breakbeat",
  "breakbeats",
  "breaks",
  "chillout",
  "cinematic",
  "classic",
  "club",
  "cosmic",
  "dance",
  "dark",
  "deep",
  "disco",
  "downtempo",
  "driving",
  "dub",
  "dubstep",
  "electro",
  "electronic",
  "electronica",
  "emotional",
  "euphoric",
  "experimental",
  "extended",
  "funky",
  "garage",
  "groove",
  "groovy",
  "house",
  "hypnotic",
  "instrumental",
  "journey",
  "late",
  "long",
  "melodic",
  "minimal",
  "mix",
  "mood",
  "music",
  "organic",
  "original",
  "peak",
  "progressive",
  "psy",
  "psychedelic",
  "psytrance",
  "rhythm",
  "rhythms",
  "rolling",
  "song",
  "songs",
  "space",
  "spacey",
  "style",
  "sunrise",
  "sunset",
  "tech",
  "techno",
  "texture",
  "textures",
  "theme",
  "themes",
  "track",
  "tracks",
  "trance",
  "tribal",
  "underground",
  "uplifting",
  "vibe",
  "vibes",
  "vocal",
  "vocals"
]);

function looksLikeStyleEntityCandidate(value = "") {
  const text = cleanText(value);
  const normalizedText = normalize(text);
  const tokens = normalizedText.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;

  const genreDetected = detectOntologyGenreTerms(text, { includeAliases: true, limit: 30 });
  const vibeDetected = detectOntologyVibeTerms(text, { limit: 20 });
  const characteristicDetected = detectOntologyTrackCharacteristics(text, { limit: 12 });
  const styleTerms = uniqueValues([
    ...(genreDetected.terms || []),
    ...(vibeDetected.terms || []),
    ...(characteristicDetected.terms || []),
    ...(genreDetected.matches || []).flatMap((match) => [match.canonical, match.family, match.alias]),
    ...(vibeDetected.matches || []).flatMap((match) => [match.canonical, match.family, match.alias]),
    ...(characteristicDetected.matches || []).flatMap((match) => [match.canonical, match.family, match.alias])
  ]);
  const normalizedTerms = styleTerms.map(normalize).filter(Boolean);
  if (!normalizedTerms.length) return false;

  const styleTokens = new Set(STYLE_ENTITY_WORDS);
  for (const term of normalizedTerms) {
    for (const token of term.split(/\s+/).filter(Boolean)) styleTokens.add(token);
  }

  if (tokens.every((token) => styleTokens.has(token))) return true;
  if (normalizedTerms.some((term) => {
    const termTokens = term.split(/\s+/).filter(Boolean);
    return normalizedText === term && (termTokens.length > 1 || STYLE_ENTITY_WORDS.has(term));
  })) {
    return true;
  }

  const styleTokenCount = tokens.filter((token) => styleTokens.has(token)).length;
  return tokens.length >= 3 &&
    styleTokenCount / tokens.length >= 0.75 &&
    normalizedTerms.some((term) => normalizedText.includes(term));
}

function adjacentLaneTerms(profile = {}, options = {}) {
  const terms = [];
  const targetTerms = profile.targetGenres || detectTargetGenres(options);
  for (const [genre, adjacent] of ADJACENT_LANE_TERMS) {
    if (seedGenreMatchesTarget(targetTerms, genre)) {
      terms.push(...adjacent);
    }
  }

  const vibeText = normalize(`${options.request || ""} ${options.mood || ""} ${(profile.vibeTerms || []).join(" ")}`);
  if (/\bhypnotic\b/.test(vibeText)) terms.push("dub", "rolling", "minimal", "deep");
  if (/\bdriving\b/.test(vibeText)) terms.push("club", "peak time", "rolling");
  if (/\bdark\b/.test(vibeText)) terms.push("dark", "noir", "afterhours");
  if (/\bunderground\b/.test(vibeText)) terms.push("underground", "deep cut");

  const targetKeys = new Set(targetTerms.map(normalize));
  return uniqueTerms(terms, 16).filter((term) => !targetKeys.has(normalize(term)));
}

function normalizeEntityCandidate(value) {
  const text = cleanText(value)
    .replace(/^(?:the\s+)?(?:artist|band|producer|label|record label)\s+/i, "")
    .replace(/\s+[-–—]\s+.+$/, "")
    .replace(/\s+\b(?:tracks?|songs?|music|catalogue|catalog|discography|releases?)\b$/i, "")
    .trim();
  if (!text || text.length < 2 || text.length > 80) return "";
  if (/\b(?:what is playing|currently playing|current track|now playing)\b/i.test(text)) return "";
  // "from any EDM lane" and similar request scaffolding is domain intent,
  // not an artist name. Let the domain gate handle it downstream.
  if (/^(?:any|all|open|broad|various|different|multiple|no matter|regardless(?: of)?)\s+(?:edm|electronic(?: dance)?(?: music)?|dance music|genres?|lanes?|styles?|music)(?:\s+(?:lane|lanes|genre|genres|style|styles|music))?$/i.test(text)) return "";
  if (/^(?:the\s+)?(?:\d{4}s?|\d0s|19\d0s|20\d0s|2000s|00s|nineties|eighties|seventies|era|decade)$/i.test(text)) return "";
  if (/^(?:this|that|current|playing|now|music|tracks?|songs?|genre|vibe|style|era)$/i.test(text)) return "";
  if (looksLikeStyleEntityCandidate(text)) return "";
  return text;
}

function normalizeLabelCandidate(value) {
  const text = cleanText(value)
    .replace(/^(?:the\s+)?(?:label|record label)\s+/i, "")
    .trim();
  if (!text || text.length < 2 || text.length > 80) return "";
  if (/^(?:music|records?|recordings?|sound|sounds|audio|label)$/i.test(text)) return "";
  if (/^(?:the\s+)?(?:\d{4}s?|\d0s|19\d0s|20\d0s|2000s|00s|nineties|eighties|seventies|era|decade)$/i.test(text)) return "";
  if (looksLikeStyleEntityCandidate(text)) return "";
  return text;
}

function extractPromptArtists(options = {}) {
  const request = cleanText(options.request).replace(/\blby\b/gi, "by");
  const found = [];
  for (const match of request.matchAll(/\b(?:like|similar to|sounds? like|around|based on|in the vein of|for fans of)\s+(.+?)\s+[-–—]\s+(.+?)(?=,|;|$)/gi)) {
    const artist = normalizeEntityCandidate(match[1]);
    if (artist) found.push(artist);
  }
  const patterns = [
    /\b(?:like|similar to|sounds? like|around|based on|in the vein of|for fans of)\s+([^,;]+?)(?=\s+\b(?:but|with|from|released|that|who|where|and|or)\b|[,;]|$)/gi,
    /\b(?:by|from)\s+([^,.;]+?)(?=\s+\b(?:but|with|released|that|who|where|and|or)\b|[,.;]|$)/gi
  ];
  for (const pattern of patterns) {
    for (const match of request.matchAll(pattern)) {
      const artist = normalizeEntityCandidate(match[1]);
      if (artist && !/\b(?:label|records|recordings)\b/i.test(artist)) found.push(artist);
    }
  }
  return uniqueTerms(found, 8);
}

function extractPromptLabels(options = {}) {
  const request = cleanText(options.request);
  const found = [];
  const patterns = [
    /\b(?:label|record label)\s+([^,.;]+?)(?=\s+\b(?:but|with|from|released|that|and|or)\b|[,.;]|$)/gi,
    /\b(?:on|from)\s+([^,.;]+?\b(?:records|recordings|music|audio|sound|sounds|label))(?=\s+\b(?:but|with|released|that|and|or)\b|[,.;]|$)/gi
  ];
  for (const pattern of patterns) {
    for (const match of request.matchAll(pattern)) {
      // Labels may legitimately end in generic words such as "Music" or
      // "Records" (for example, "1985 Music"). Artist/style normalization
      // intentionally strips those suffixes, so labels need their own path.
      const label = normalizeLabelCandidate(match[1]);
      if (label) found.push(label);
    }
  }
  return uniqueTerms(found, 8);
}

function detectTargetGenres(options = {}) {
  const explicit = `${options.genres || ""} ${positiveIntentText(options.request || "")}`;
  const detected = detectOntologyGenreTerms(explicit, { includeAliases: true, limit: 24 });
  const explicitPhrase = explicitGenrePhrase(options);
  const parents = explicitPhrase ? parentGenreTermsFor(explicitPhrase).map(normalize) : [];
  const terms = [
    explicitPhrase,
    ...detected.terms
  ].filter(Boolean).filter((term) => (
    !explicitPhrase ||
    normalizeGenreKey(term) === normalizeGenreKey(explicitPhrase) ||
    !parents.includes(normalizeGenreKey(term))
  ));
  const canonicalTerms = pruneBroadGenreTerms(terms);
  const seen = new Set();
  return canonicalTerms.filter((term) => {
    const key = normalizeGenreKey(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function requestAsksForOmnivoreDiscovery(options = {}, targetGenres = []) {
  const text = normalize(requestText(options));
  if (!text) return false;
  const explicitGenre = cleanText(options.genres) || (targetGenres || []).length ||
    /\b(?:electronic|dance|house|techno|trance|psytrance|ambient|downtempo|breaks|breakbeat|bass|disco|electro|jazz|soul|r\s?b|hip hop|rap|rock|metal|country|folk|pop|indie)\b/.test(text);
  const anyGenreLanguage = /\b(?:any|all|whatever|no matter|regardless of|regardless)\b.{0,24}\bgenres?\b/.test(text) ||
    /\bgenres?\b.{0,24}\b(?:do not matter|doesn t matter|does not matter|irrelevant|open|wide open)\b/.test(text);
  if (anyGenreLanguage) return true;
  if (explicitGenre) return false;
  return /\b(?:surprise me|anything good|good music|great music|best music|best tracks|hidden gems|wide net|open discovery|omnivore|adventurous|branch out|branching out|outside my usual|outside known taste)\b/.test(text);
}

function isBroadElectronicDiscovery(options = {}, targetGenres = []) {
  const rawGenre = normalize(options.genres || "");
  const text = normalize(requestText(options));
  const broadGenre = /^(?:edm|electronic|electronic music|electronic dance music|dance music)$/.test(rawGenre) ||
    (targetGenres || []).some((term) => /^(?:edm|electronic|electronic music|electronic dance music|dance music)$/.test(normalize(term)));
  const broadPhrase = /\b(?:any|all|open|broad|various|different|multiple)\b.{0,32}\b(?:edm|electronic dance music|electronic music|dance music)\b/.test(text) ||
    /\b(?:edm|electronic dance music|electronic music|dance music)\b.{0,20}\b(?:lane|lanes|genre|genres|style|styles)\b/.test(text);
  return broadGenre || broadPhrase;
}

function semanticOnlyQueryFor(query = "", profile = {}) {
  if (!profile.targetGenres?.length && !profile.isBroadElectronicDiscovery) return false;
  const promptRoute = cleanText(profile.promptIntent?.route || "").toLowerCase();
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return false;

  // Explicit themes can still be useful catalog anchors (for example,
  // "love progressive house"). Activity and sonic-descriptor language is not
  // a reliable TIDAL catalog anchor and belongs in ranking instead.
  if (promptRoute === "theme" && (profile.promptIntent?.themeTerms || []).some((term) => containsEntityTerm(query, term))) {
    return false;
  }

  const entityTerms = uniqueTerms([
    ...(profile.requestedArtists || []),
    ...(profile.seedArtists || []),
    ...(profile.requestedLabels || []),
    ...(profile.genreProfile?.artists || []),
    ...(profile.genreProfile?.labels || []),
    ...genreArtistAnchors(profile),
    ...genreLabelSeeds(profile),
    ...ELECTRONIC_DOMAIN_TERMS,
    ...(profile.targetGenres || []),
    ...(profile.genreProfile?.parentGenres || [])
  ], 360)
    .sort((left, right) => normalize(right).length - normalize(left).length);
  let remainder = ` ${normalizedQuery} `;
  for (const term of entityTerms) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm) continue;
    remainder = remainder.replace(new RegExp(`\\b${normalizedTerm.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "g"), " ");
  }
  const tokens = remainder
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !/^\d{4}$/.test(token) && !["new", "release", "releases", "track", "tracks", "song", "songs"].includes(token));
  if (!tokens.length) return false;
  const semanticTokens = new Set([...SEMANTIC_QUERY_TERMS].flatMap((term) => normalize(term).split(/\s+/)));
  semanticTokens.add("night");
  semanticTokens.add("late");
  return tokens.every((token) => semanticTokens.has(token));
}

function queryGenerationInfo(query = "", profile = {}, options = {}) {
  const text = cleanText(query);
  const knownArtists = uniqueTerms([
    ...(profile.requestedArtists || []),
    ...(profile.seedArtists || []),
    ...(profile.learnedTasteArtists || []),
    ...(Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : []),
    ...(profile.genreProfile?.artists || []),
    ...genreArtistAnchors(profile),
    ...EDM_DISCOVERY_ARTISTS
  ], 360);
  const artist = knownArtists.find((value) => artistNamesMatch(text, value, { contains: true })) || "";
  const knownLabels = uniqueTerms([
    ...(profile.requestedLabels || []),
    ...(profile.learnedTasteLabels || []),
    ...(Array.isArray(options.learnedTasteLabels) ? options.learnedTasteLabels : []),
    ...(profile.genreProfile?.labels || []),
    ...genreLabelSeeds(profile),
    ...EDM_DISCOVERY_LABELS
  ], 360);
  const label = knownLabels.find((value) => entityEvidenceMatches(text, value)) || "";
  const learnedArtist = (profile.learnedTasteArtists || []).find((value) => artistNamesMatch(text, value, { contains: true })) || "";
  const learnedLabel = (profile.learnedTasteLabels || []).find((value) => entityEvidenceMatches(text, value)) || "";
  const semanticOnly = semanticOnlyQueryFor(text, profile);
  const target = (profile.targetGenres || []).find((term) => containsEntityTerm(text, term) || containsGenreTerm(text, term)) ||
    (profile.isBroadElectronicDiscovery ? ELECTRONIC_DOMAIN_TERMS.find((term) => containsEntityTerm(text, term)) || "" : "");
  if (artist) {
    return {
      source: (profile.requestedArtists || []).some((value) => artistNamesMatch(value, artist))
        ? "current-intent artist seed"
        : (learnedArtist ? "learned taste artist seed" : "trusted artist/scene anchor"),
      seedType: "artist",
      seed: artist,
      priorityTier: 10,
      semanticOnly: false,
      target
    };
  }
  if (label) {
    return {
      source: (profile.requestedLabels || []).some((value) => entityEvidenceMatches(value, label))
        ? "requested label seed"
        : (learnedLabel ? "learned taste label seed" : "trusted label/scene anchor"),
      seedType: "label",
      seed: label,
      priorityTier: 20,
      semanticOnly: false,
      target
    };
  }
  if (semanticOnly) {
    return {
      source: "semantic/activity expansion",
      seedType: "semantic",
      seed: "",
      priorityTier: 90,
      semanticOnly: true,
      target
    };
  }
  if (target) {
    return {
      source: "genre/domain lane",
      seedType: "genre",
      seed: target,
      priorityTier: 50,
      semanticOnly: false,
      target
    };
  }
  return {
    source: "catalog exploration",
    seedType: "exploratory",
    seed: "",
    priorityTier: 80,
    semanticOnly: false,
    target: ""
  };
}

function detectSeedVibes(options = {}, seedArtists = []) {
  const promptVibes = detectOntologyVibeTerms(`${options.request || ""} ${options.reference || ""}`, { limit: 16 }).terms;
  const moodVibes = detectOntologyVibeTerms(options.mood || "", { limit: 16 }).terms;
  const explicit = uniqueTerms([...promptVibes, ...moodVibes], 16);
  const inferred = [];

  for (const artist of seedArtists) {
    const match = SEED_ARTIST_VIBES.find(([knownArtist]) => artistNamesMatch(knownArtist, artist));
    if (match) inferred.push(...match[1]);
  }

  return {
    terms: uniqueTerms([...explicit, ...inferred], 16),
    explicit,
    inferred: uniqueTerms(inferred, 12),
    source: explicit.length ? "explicit" : (inferred.length ? "inferred" : "not specified")
  };
}

function detectEraTerms(options = {}) {
  return detectOntologyEraTerms(`${options.request || ""} ${options.years || ""}`, { limit: 8 });
}

function detectTrackCharacteristics(options = {}) {
  const detected = detectOntologyTrackCharacteristics(`${options.request || ""} ${options.mood || ""}`, { limit: 12 });
  return uniqueTerms(detected.terms, 12);
}

function requestedLengthText(options = {}) {
  const text = normalize(`${options.request || ""} ${options.mood || ""}`);
  const characteristics = detectTrackCharacteristics(options);
  const minuteMatch = cleanText(`${options.request || ""} ${options.mood || ""}`).match(/\b(?:over|under|at least|around|about)?\s*(\d{1,2})\s*(?:minutes?|mins?|min)\b/i);
  if (minuteMatch) return `${minuteMatch[0].trim()}`;
  if (characteristics.some((term) => ["extended mix", "long form", "slow build"].includes(normalize(term)))) return "long / extended";
  if (wantsLongTracks(options)) return "long / extended";
  if (characteristics.some((term) => ["radio edit"].includes(normalize(term)))) return "short / compact";
  if (/\b(?:short|brief|compact|radio edit|single edit)\b/.test(text)) return "short / compact";
  return "";
}

function tasteApplicationFor(profile = {}) {
  if (profile.scoringMode === "pure") return "not at all";
  if (profile.scoringMode === "explore") return "lightly";
  if (profile.scoringMode === "similar") return "strongly";
  if (profile.promptIntent?.tasteInfluence) return profile.promptIntent.tasteInfluence;
  if (profile.isGenreDiscoveryTarget) return "lightly";
  return "strongly";
}

function intentDebugFor(profile = {}, options = {}) {
  const yearRange = parseYearRange(options);
  const eraTerms = detectEraTerms(options);
  const promptIntent = profile.promptIntent || {};
  const requestedGenre = profile.targetGenres.length
    ? profile.targetGenres.slice(0, 8).join(", ")
    : (cleanText(options.genres) ||
      (["theme", "activity"].includes(promptIntent.route) ? "open-ended" : (profile.seedArtists.length ? "open-ended" : (profile.primaryTarget || "open-ended"))));
  return {
    searchRoute: promptIntent.routeLabel || "Open Discovery",
    promptStrictness: promptIntent.strictness || "open-discovery",
    theme: promptIntent.themeTerms || [],
    themeSource: promptIntent.themeSource || "not specified",
    activityContext: promptIntent.activityTerms || [],
    activitySource: promptIntent.activitySource || "not specified",
    outsideTaste: promptIntent.allowOutsideTaste ? "allowed when prompt evidence matches" : "limited",
    outsideTasteMode: promptIntent.outsideTasteMode || "none",
    tasteInfluence: promptIntent.tasteInfluence || tasteApplicationFor(profile),
    tastePolicy: promptIntent.tastePolicy || "saved taste is a soft preference, not a genre whitelist",
    genreConstraint: promptIntent.genreConstraint || (profile.targetGenres.length ? "hard" : "none"),
    verificationMethods: promptIntent.verificationMethods || [],
    requestedGenre,
    requestedVibe: profile.vibeTerms.length ? profile.vibeTerms.slice(0, 8).join(", ") : (cleanText(options.mood) || "not specified"),
    requestedVibeSource: profile.vibeSource || "not specified",
    requestedEraDateRange: yearRange?.label || eraTerms.join(", ") || "not specified",
    requestedLength: requestedLengthText(options) || "not specified",
    requestedCharacteristics: (profile.trackCharacteristics || []).slice(0, 8),
    requestedArtists: (profile.requestedArtists || profile.seedArtists || []).slice(0, 8),
    requestedLabels: profile.requestedLabels.slice(0, 8),
    querySeedPolicy: profile.querySeedPolicy || "not specified",
    standbyTasteReservoir: profile.standbyTasteReservoir ? "enabled" : "off",
    filteredPlanArtists: (profile.filteredPlanArtists || []).slice(0, 12),
    filteredPlanLabels: (profile.filteredPlanLabels || []).slice(0, 12),
    omnivoreDiscovery: profile.isOmnivoreDiscovery ? "enabled" : "off",
    electronicDomain: profile.isBroadElectronicDiscovery ? "EDM parent domain" : "off",
    genreProfile: profile.genreProfile?.strict ? {
      name: profile.genreProfile.name,
      parentGenres: profile.genreProfile.parentGenres,
      keywords: profile.genreProfile.keywords,
      learnedArtists: profile.genreProfile.artists.slice(0, 6),
      learnedLabels: profile.genreProfile.labels.slice(0, 6)
    } : null,
    scoringMode: profile.scoringMode,
    scoringModeLabel: scoringModeLabel(profile.scoringMode),
    learnedTaste: tasteApplicationFor(profile),
    progressiveBias: isProgressiveSceneTarget(profile) ? "relevant to prompt" : "off unless explicitly requested"
  };
}

function genreDiscoverySeeds(profile = {}) {
  if (!profile.targetGenres?.length || profile.isProgressiveTarget) return [];
  if (profile.isProgressiveTranceTarget) {
    return uniqueValues([
      ...progressiveSceneLabelsFor(profile),
      ...TRANCE_FORWARD_ARTISTS
    ]);
  }
  const seedValues = [...(profile.genreProfile?.labels || []), ...(profile.genreProfile?.artists || [])];
  for (const [genre, seeds] of GENRE_DISCOVERY_SEEDS) {
    if (seedGenreMatchesTarget(profile.targetGenres, genre)) {
      seedValues.push(...seeds);
    }
  }
  return uniqueValues(seedValues);
}

function genreArtistAnchors(profile = {}) {
  if (!profile.targetGenres?.length || profile.isProgressiveTarget) return [];
  if (profile.isProgressiveTranceTarget) return TRANCE_FORWARD_ARTISTS.slice();
  const seedValues = [...(profile.genreProfile?.artists || [])];
  for (const [genre, seeds] of GENRE_ARTIST_ANCHORS) {
    if (seedGenreMatchesTarget(profile.targetGenres, genre)) {
      seedValues.push(...seeds);
    }
  }
  return uniqueValues(seedValues);
}

const GENERIC_ENTITY_WORDS = new Set([
  "music",
  "records",
  "recordings",
  "record",
  "sound",
  "sounds",
  "audio",
  "label",
  "official",
  "group",
  "ltd",
  "llc",
  "inc"
]);

function entityEvidenceMatches(left = "", right = "") {
  const leftKey = normalize(left);
  const rightKey = normalize(right);
  if (!leftKey || !rightKey) return false;
  const leftTokens = leftKey.split(/\s+/).filter(Boolean);
  const rightTokens = rightKey.split(/\s+/).filter(Boolean);
  const leftMeaningful = leftTokens.filter((token) => !GENERIC_ENTITY_WORDS.has(token));
  const rightMeaningful = rightTokens.filter((token) => !GENERIC_ENTITY_WORDS.has(token));

  // Generic suffixes such as "Music" and "Records" are not an entity on
  // their own. In particular, "Music" must not satisfy "1985 Music".
  if (!leftMeaningful.length || !rightMeaningful.length) return false;
  if (leftKey === rightKey) return true;

  const shorter = leftTokens.length <= rightTokens.length ? leftMeaningful : rightMeaningful;
  const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
  return shorter.every((token) => longer.includes(token));
}

function hardGenreConstraintFor(profile = {}) {
  return Boolean(
    profile.targetGenres?.length &&
    profile.promptIntent?.genreConstraint === "hard" &&
    !profile.isOmnivoreDiscovery
  );
}

function genreSeedUniverseFor(profile = {}) {
  return uniqueValues([
    ...genreDiscoverySeeds(profile),
    ...genreArtistAnchors(profile),
    ...(isProgressiveSceneTarget(profile)
      ? [
        ...(profile.isProgressiveTranceTarget ? TRANCE_FORWARD_ARTISTS : PROGRESSIVE_ARTISTS),
        ...progressiveSceneLabelsFor(profile)
      ]
      : []),
    ...(profile.genreProfile?.artists || []),
    ...(profile.genreProfile?.labels || [])
  ], 220);
}

function incompatibleGenreSeedUniverseFor(profile = {}) {
  // Progressive, techno, house, trance, and bass artists are all valid
  // evidence inside an open EDM domain. They are incompatible only when the
  // request names a narrower non-progressive lane.
  if (isProgressiveSceneTarget(profile) || profile.isBroadElectronicDiscovery) return [];
  return uniqueValues([
    ...PROGRESSIVE_ARTISTS,
    ...KNOWN_PROGRESSIVE_TASTE_CONTAMINATION,
    ...GENRE_ARTIST_ANCHORS
      // EDM is a parent domain and its anchors span house, techno, trance,
      // and bass. Do not treat those anchors as incompatible with a child
      // lane merely because the parent label is not an exact match.
      .filter(([genre]) => genre !== "edm" && !(profile.targetGenres || []).some((target) => seedGenreMatchesTarget([target], genre)))
      .flatMap(([, seeds]) => seeds)
  ], 220);
}

function isGenreCompatibleSeed(value = "", profile = {}, allowed = []) {
  if (!hardGenreConstraintFor(profile)) return true;
  const candidate = cleanText(value);
  if (!candidate) return false;
  const explicitlyAllowed = [...(profile.requestedArtists || []), ...allowed]
    .some((seed) => artistNamesMatch(candidate, seed, { contains: true }) || entityEvidenceMatches(candidate, seed));
  if (explicitlyAllowed) return true;
  if (incompatibleGenreSeedUniverseFor(profile).some((seed) => (
    artistNamesMatch(candidate, seed, { contains: true }) || entityEvidenceMatches(candidate, seed)
  ))) return false;
  if (genreSeedUniverseFor(profile).some((seed) => (
    artistNamesMatch(candidate, seed, { contains: true }) || entityEvidenceMatches(candidate, seed)
  ))) return true;
  // Unknown plan artists remain eligible for later metadata scoring. The
  // hard boundary is against known incompatible seeds, not a requirement
  // that every artist already exist in the local anchor ontology.
  return true;
}

function filterGenreCompatibleSeeds(values = [], profile = {}, allowed = []) {
  return uniqueValues(values).filter((value) => isGenreCompatibleSeed(value, profile, allowed));
}

function isGenreCompatibleLabel(value = "", profile = {}, allowed = []) {
  if (!hardGenreConstraintFor(profile)) return true;
  const candidate = cleanText(value);
  if (!candidate) return false;
  const meaningful = normalize(candidate).split(/\s+/).filter((token) => token && !GENERIC_ENTITY_WORDS.has(token));
  if (!meaningful.length) return false;
  if (uniqueValues([
    ...(profile.requestedLabels || []),
    ...allowed,
    ...genreDiscoverySeeds(profile),
    ...(profile.genreProfile?.labels || [])
  ]).some((seed) => entityEvidenceMatches(candidate, seed))) return true;
  if (!isProgressiveSceneTarget(profile) && progressiveSceneLabelsFor(profile).some((label) => entityEvidenceMatches(candidate, label))) return false;
  // Preserve unknown label candidates for metadata scoring; unlike a generic
  // "Music" token, an unseen multi-word label can still be a valid lane seed.
  return true;
}

function filterGenreCompatibleLabels(values = [], profile = {}, allowed = []) {
  return uniqueValues(values).filter((value) => isGenreCompatibleLabel(value, profile, allowed));
}

function queryMentionsIncompatibleSeed(query = "", profile = {}, incompatibleSeeds = []) {
  if (!hardGenreConstraintFor(profile)) return false;
  return incompatibleSeeds.some((seed) => (
    artistNamesMatch(query, seed, { contains: true }) || entityEvidenceMatches(query, seed)
  ));
}

function queryIsGenreCompatible(query = "", profile = {}, incompatibleSeeds = []) {
  if (!hardGenreConstraintFor(profile)) return true;
  if (queryMentionsIncompatibleSeed(query, profile, incompatibleSeeds)) return false;
  if (semanticOnlyQueryFor(query, profile)) return false;
  const terms = [
    ...(profile.targetGenres || []),
    ...(profile.genreProfile?.parentGenres || []),
    ...(profile.genreProfile?.keywords || []),
    ...(profile.requestedLabels || []),
    ...(profile.isBroadElectronicDiscovery ? ELECTRONIC_DOMAIN_TERMS : []),
    ...genreSeedUniverseFor(profile),
    ...(profile.requestedArtists || [])
  ];
  return terms.some((term) => (
    containsNormalized(query, term) ||
    ((profile.targetGenres || []).some((target) => normalizeGenreKey(target) === normalizeGenreKey(term)) && containsGenreTerm(query, term)) ||
    entityEvidenceMatches(query, term) ||
    artistNamesMatch(query, term, { contains: true })
  ));
}

function incompatiblePlanArtistsFor(options = {}, profile = {}) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  return uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : []),
    ...(Array.isArray(plan.relatedArtists) ? plan.relatedArtists : []),
    ...(Array.isArray(plan.similarArtists) ? plan.similarArtists : [])
  ].filter((artist) => !isGenericSeedArtist(artist)), 32)
    .filter((artist) => !isGenreCompatibleSeed(artist, profile, profile.requestedArtists || []));
}

function filterHardGenreQueries(queries = [], options = {}, profile = {}, limit = Number.MAX_SAFE_INTEGER) {
  const incompatible = incompatiblePlanArtistsFor(options, profile);
  return uniqueValues(queries.map(cleanText).filter(Boolean))
    .filter((query) => !semanticOnlyQueryFor(query, profile))
    .filter((query) => queryIsGenreCompatible(query, profile, incompatible))
    .slice(0, limit);
}

function buildDiscoveryProfile(options = {}) {
  const scoringMode = normalizeScoringMode(options);
  const promptIntent = routePromptIntent({ ...options, scoringMode });
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planArtists = uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ].filter((artist) => !isGenericSeedArtist(artist)), 24);
  const planLabels = uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 24);
  const requestedArtists = uniqueTerms([
    ...extractPromptArtists(options),
    ...extractSeedArtists(options)
  ].filter((artist) => !isGenericSeedArtist(artist)), 12);
  const pureRequestedArtistSearch = scoringMode === "pure" && requestedArtists.length;
  const targetGenres = detectTargetGenres(options);
  const broadElectronicDiscovery = isBroadElectronicDiscovery(options, targetGenres);
  const isOmnivoreDiscovery = requestAsksForOmnivoreDiscovery(options, targetGenres);
  const standbyTasteReservoir = (
    /^(?:1|true|yes)$/i.test(String(options.standbyTasteReservoir || "")) ||
    (/^(?:1|true|yes)$/i.test(String(options.standbyPool || "")) &&
      !cleanText(options.genres) &&
      !cleanText(options.mood) &&
      /\b(?:taste\s+profile|use\s+my\s+taste|based\s+on\s+my\s+taste|current\s+taste)\b/i.test(String(options.request || "")))
  ) && !cleanText(options.genres) && !cleanText(options.mood);
  const tasteProfileLed = promptIntent.outsideTasteMode === "taste-profile" || standbyTasteReservoir;
  const positiveTargetText = normalize(`${options.genres || ""} ${positiveIntentText(options.request || "")}`);
  const isProgressiveTranceTarget = /\bprogressive trance\b/.test(positiveTargetText) ||
    targetGenres.some((term) => /\bprogressive trance\b/.test(normalize(term)));
  const isProgressiveTarget = /\bprogressive house\b|\bmelodic progressive\b|\bdeep progressive\b|\borganic progressive\b/.test(positiveTargetText) ||
    targetGenres.some((term) => /\bprogressive house\b|\bmelodic progressive\b|\bdeep progressive\b|\borganic progressive\b/.test(normalize(term)));
  const preliminaryProfile = {
    targetGenres,
    isBroadElectronicDiscovery: broadElectronicDiscovery,
    isOmnivoreDiscovery,
    isProgressiveTranceTarget,
    isProgressiveTarget,
    genreProfile: dynamicGenreProfileFor(options, targetGenres),
    requestedArtists,
    promptIntent
  };
  const hardGenreConstraint = hardGenreConstraintFor({
    ...preliminaryProfile,
    promptIntent
  });
  const compatiblePlanArtists = hardGenreConstraint
    ? filterGenreCompatibleSeeds(planArtists, preliminaryProfile, requestedArtists)
    : planArtists;
  const explicitRequestedLabels = uniqueTerms(extractPromptLabels(options), 12);
  const compatiblePlanLabels = hardGenreConstraint
    ? filterGenreCompatibleLabels(planLabels, preliminaryProfile, explicitRequestedLabels)
    : planLabels;
  const compatiblePlanCandidateArtists = hardGenreConstraint
    ? filterGenreCompatibleSeeds(
      Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [],
      preliminaryProfile,
      requestedArtists
    )
    : planArtists;
  // Model candidateArtists are current-lane suggestions and may help sparse
  // catalogue metadata. Model seedArtists, remembered artists, and learned
  // taste are not current-lane evidence; they must not silently become a
  // genre whitelist or spend the hard-lane crawl budget.
  const seedArtists = uniqueTerms([
    ...requestedArtists,
    ...(pureRequestedArtistSearch || isOmnivoreDiscovery
      ? []
      : (hardGenreConstraint ? compatiblePlanCandidateArtists : compatiblePlanArtists).slice(0, 8))
  ], 12);
  const requestedLabels = uniqueTerms([
    ...explicitRequestedLabels,
    // A taste-profile request may use learned labels as candidate anchors,
    // but those labels are not explicit user constraints. Promoting them to
    // requested-label evidence lets a generic catalogue artist (for example
    // a "Lost & Found" meditation upload) masquerade as a strong match.
    ...(isOmnivoreDiscovery || hardGenreConstraint || tasteProfileLed ? [] : compatiblePlanLabels)
  ], 12);
  const genreProfile = preliminaryProfile.genreProfile;
  // Standby's neutral taste reservoir contains retrieval policy words such as
  // "low-exposure", "deep", and "non-obvious". They are not a user request
  // for one sonic lane. Do not let ontology synonyms turn that policy copy
  // into hidden positive vibes or literal catalog queries.
  const vibeResult = standbyTasteReservoir
    ? { terms: [], explicit: [], inferred: [], source: "not specified" }
    : detectSeedVibes(options, seedArtists);
  const inferredPromptVibes = cleanText(options.mood) || vibeResult.explicit.length
    ? []
    : (promptIntent.inferredVibes || []);
  const vibeTerms = uniqueTerms(standbyTasteReservoir ? [] : [...vibeResult.terms, ...inferredPromptVibes], 16);
  const trackCharacteristics = standbyTasteReservoir ? [] : detectTrackCharacteristics(options);
  const releaseRange = parseYearRange(options);
  const explicitTarget = cleanText(options.genres || options.request || "");
  // Progressive Trance shares the specialized progressive planner family, but
  // remains a distinct hard genre. Keep that planning distinction separate
  // from the progressive-house scoring/admission flag.
  const isProgressivePlanningTarget = Boolean(isProgressiveTarget || isProgressiveTranceTarget);
  const isGenreOnlyTarget = Boolean(targetGenres.length && !isProgressiveTarget && !seedArtists.length);
  const isGenreDiscoveryTarget = Boolean(targetGenres.length && !isProgressiveTarget);
  const primaryTarget = targetGenres[0] ||
    cleanText(options.genres) ||
    (promptIntent.primarySearchTerm && ["theme", "activity", "open"].includes(promptIntent.route) ? promptIntent.primarySearchTerm : "") ||
    (isOmnivoreDiscovery || tasteProfileLed ? "" : cleanText(options.request).replace(/\b(?:make|create|find|give me|recommend|playlist|tracks?|songs?|like|similar|based on|seeded)\b/gi, " ").trim());
  const hasExplicitDiscoveryIntent = Boolean(
    requestedArtists.length ||
    requestedLabels.length ||
    targetGenres.length ||
    vibeResult.explicit.length ||
    promptIntent.hasIntent ||
    trackCharacteristics.length ||
    releaseFilterRequiresVerification(options, releaseRange)
  );

  const profile = {
    scoringMode,
    seedArtists,
    requestedArtists,
    requestedLabels,
    targetGenres,
    genreProfile,
    vibeTerms,
    explicitVibeTerms: vibeResult.explicit,
    inferredVibeTerms: uniqueTerms([...vibeResult.inferred, ...inferredPromptVibes], 12),
    vibeSource: vibeResult.explicit.length
      ? "explicit"
      : (inferredPromptVibes.length
        ? `inferred from ${promptIntent.route}`
        : vibeResult.source),
    trackCharacteristics,
    promptIntent,
    primaryTarget,
    explicitTarget,
    hasExplicitDiscoveryIntent,
    isOmnivoreDiscovery,
    tasteProfileLed,
    standbyTasteReservoir,
    isBroadElectronicDiscovery: broadElectronicDiscovery,
    isProgressiveTranceTarget,
    isProgressiveTarget,
    isProgressivePlanningTarget,
    isGenreOnlyTarget,
    isGenreDiscoveryTarget,
    hasSeedVibe: Boolean(seedArtists.length || vibeTerms.length),
    querySeedPolicy: hardGenreConstraint
      ? "current request is the hard search lane; model/taste seeds are soft suggestions and must earn current-lane metadata"
      : "prompt and taste seeds allowed by scoring mode",
    tastePolicy: promptIntent.tastePolicy || "saved taste is a soft preference, not a genre whitelist",
    filteredPlanArtists: planArtists.filter((artist) => {
      const queryEligible = hardGenreConstraint ? compatiblePlanCandidateArtists : compatiblePlanArtists;
      return !queryEligible.some((allowed) => normalize(allowed) === normalize(artist));
    }),
    filteredPlanLabels: planLabels.filter((label) => !compatiblePlanLabels.some((allowed) => normalize(allowed) === normalize(label)))
  };
  profile.intent = intentDebugFor(profile, options);
  profile.tasteApplication = profile.intent.learnedTaste;
  return profile;
}

function labelText(track = {}) {
  return cleanText(track.label || track.tidal?.label || "");
}

function matchingSceneLabel(value, profile = {}) {
  const label = normalize(value);
  if (!label) return "";
  const labels = progressiveSceneLabelsFor(profile);
  return labels.find((knownLabel) => {
    return entityEvidenceMatches(value, knownLabel);
  }) || "";
}

function isTranceForwardArtist(value) {
  return TRANCE_FORWARD_ARTISTS.some((artist) => artistMatchesKnownName(value, artist));
}

function wantsProgressiveHouseOnly(options = {}) {
  const wanted = normalize(`${positiveIntentText(options.request)} ${options.genres}`);
  return wanted.includes("progressive house") && !/\bprogressive trance\b|\btrance\b/.test(wanted);
}

function primaryArtistKey(track = {}) {
  return artistIdentityKey(splitArtists(track.artist)[0] || track.artist);
}

function artistKeysForCandidate(track = {}) {
  return artistIdentityKeysForTrack(track, splitArtists);
}

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function shuffled(values) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function extractSeedArtists(options = {}) {
  const seeds = [];
  const seedValues = [
    options.artist,
    options.seedArtist
  ];
  if (requestUsesNowPlayingAsSeed(options)) seedValues.unshift(options.nowPlaying?.artist);

  for (const value of seedValues) {
    seeds.push(...splitArtists(value));
  }

  const reference = cleanText(options.reference);
  for (const line of reference.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\s+-\s+.+$/);
    if (match) seeds.push(...splitArtists(match[1]));
  }

  return Array.from(new Set(seeds))
    .filter((artist) => !isGenericSeedArtist(artist))
    .slice(0, 8);
}

function optionValues(options = {}, keys = []) {
  const values = [];
  for (const key of keys) {
    const value = options[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  }
  return values.map(cleanText).filter(Boolean);
}

function extractRemixerSeedsFromText(value = "") {
  const text = cleanText(value);
  if (!text) return [];
  const seeds = [];
  const patterns = [
    /[\[(]([^\])]{2,80}?)\s+(?:extended\s+|club\s+|dub\s+|vocal\s+)?(?:remix|rework|rerub|dub)(?:\s+mix)?[\])]/gi,
    /\b(?:remix|rework|rerub|dub)\s+by\s+([a-z0-9][\w .'-]{2,80})\b/gi,
    /\b([a-z0-9][\w .'-]{2,80}?)\s+(?:extended\s+|club\s+|dub\s+|vocal\s+)?(?:remix|rework|rerub|dub)(?:\s+mix)?\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeEntityCandidate(match[1]);
      if (!candidate) continue;
      const key = normalize(candidate);
      if (/^(?:original|extended|radio|club|dub|vocal|instrumental|edit|remix|rework|rerub|mix|version)$/i.test(candidate)) continue;
      if (/\b(?:original mix|extended mix|radio edit|club mix|dub mix|vocal mix|instrumental mix)\b/.test(key)) continue;
      seeds.push(...splitArtists(candidate));
    }
  }

  return uniqueTerms(seeds, 12);
}

function branchArtistSeeds(options = {}, profile = buildDiscoveryProfile(options), limit = 24) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const optionSeeds = optionValues(options, [
    "similarArtistSeeds",
    "branchArtistSeeds",
    "relatedArtistSeeds",
    "radioArtistSeeds",
    "artistRadioSeeds",
    "remixerSeeds",
    "remixArtistSeeds"
  ]);
  const planSeeds = [
    ...(Array.isArray(plan.relatedArtists) ? plan.relatedArtists : []),
    ...(Array.isArray(plan.similarArtists) ? plan.similarArtists : []),
    ...(Array.isArray(plan.radioArtists) ? plan.radioArtists : []),
    ...(Array.isArray(plan.remixers) ? plan.remixers : [])
  ];
  const remixerSeeds = extractRemixerSeedsFromText([
    options.request,
    options.reference,
    options.nowPlaying?.title,
    options.nowPlaying?.album
  ].map(cleanText).join(" "));
  const requestedKeys = new Set([...(profile.requestedArtists || []), ...(profile.seedArtists || [])].map(artistIdentityKey));
  return filterGenreCompatibleSeeds(
    uniqueTerms([...optionSeeds, ...planSeeds, ...remixerSeeds].flatMap(splitArtists), limit),
    profile,
    profile.requestedArtists || []
  ).filter((artist) => !isGenericSeedArtist(artist) && !requestedKeys.has(artistIdentityKey(artist)));
}

function branchLabelSeeds(options = {}, profile = buildDiscoveryProfile(options), limit = 24) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  return filterGenreCompatibleLabels(uniqueTerms([
    ...(profile.requestedLabels || []),
    ...(profile.tasteProfileLed ? [] : (Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [])),
    ...(profile.tasteProfileLed ? [] : (Array.isArray(plan.relatedLabels) ? plan.relatedLabels : [])),
    ...optionValues(options, ["branchLabels", "relatedLabels", "radioLabels", "remixerLabels", "labelSeeds"])
  ], limit), profile, profile.requestedLabels || []);
}

function artistMatchesSeedList(artist = "", seeds = []) {
  return seeds.some((seed) => artistMatchesKnownName(artist, seed));
}

function tasteAnchorEvidenceFor(track = {}, options = {}, profile = {}) {
  if (!profile.tasteProfileLed) {
    return {
      learnedArtist: "",
      learnedLabel: "",
      relatedArtist: "",
      relatedLabel: ""
    };
  }

  const learnedArtists = uniqueTerms([
    ...(Array.isArray(profile.learnedTasteArtists) ? profile.learnedTasteArtists : []),
    ...(Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : [])
  ], 32).filter((artist) => !isGenericSeedArtist(artist));
  const learnedLabels = uniqueTerms([
    ...(Array.isArray(profile.learnedTasteLabels) ? profile.learnedTasteLabels : []),
    ...(Array.isArray(options.learnedTasteLabels) ? options.learnedTasteLabels : [])
    ], 36);
  const relatedArtists = optionValues(options, [
    "similarArtistSeeds",
    "branchArtistSeeds",
    "relatedArtistSeeds",
    "radioArtistSeeds",
    "artistRadioSeeds"
  ]).filter((artist) => !isGenericSeedArtist(artist));
  const relatedLabels = optionValues(options, [
    "similarLabelSeeds",
    "branchLabels",
    "relatedLabels",
    "radioLabels",
    "labelSeeds"
  ]);
  const relatedArtistEvidence = Array.isArray(options.similarArtistEvidence)
    ? options.similarArtistEvidence
    : [];

  return {
    learnedArtist: learnedArtists.find((artist) => artistMatchesKnownName(track.artist, artist)) || "",
    learnedLabel: learnedLabels.find((label) => entityEvidenceMatches(labelText(track), label)) || "",
    relatedArtist: relatedArtists.find((artist) => artistMatchesKnownName(track.artist, artist)) || "",
    relatedLabel: relatedLabels.find((label) => entityEvidenceMatches(labelText(track), label)) || "",
    relatedArtistSimilarity: (() => {
      const match = relatedArtistEvidence.find((item) => artistNamesMatch(track.artist, item?.name, { contains: true }));
      const score = Number(match?.matchScore || 0);
      return score > 0 ? Math.max(0, Math.min(1, score)) : 0.5;
    })()
  };
}

function textMentionsSeed(text = "", seeds = []) {
  const normalized = normalize(text);
  return Boolean(normalized) && seeds.some((seed) => {
    if (isCollisionSensitiveArtist(seed)) return false;
    const key = normalize(seed);
    return key && normalized.includes(key);
  });
}

function isGenericSeedArtist(value = "") {
  const text = normalize(value);
  if (!text) return true;
  if (/^(?:various artists?|unknown artist|unknown|n a|na|va|v a|soundtrack|source|sources|artist|artists)$/.test(text)) return true;
  if (/^(?:house music|techno music|trance music|psytrance|ambient music|electronic dance music|edm|deep house|progressive house|melodic house|organic house|tech house|dance music)$/i.test(cleanText(value))) return true;
  const parts = splitArtists(value);
  if (parts.length >= 3 && /\b(?:house|techno|trance|psytrance|ambient|edm|music)\b/.test(text)) return true;
  return false;
}

function tasteSeedExclusionNames(options = {}) {
  const expansion = options.similarArtistExpansion && typeof options.similarArtistExpansion === "object"
    ? options.similarArtistExpansion
    : {};
  return uniqueTerms([
    ...(Array.isArray(options.tasteSeedExclusions) ? options.tasteSeedExclusions : []),
    ...(Array.isArray(expansion.skippedSeeds) ? expansion.skippedSeeds.map((item) => item?.artist) : [])
  ], 48).filter((artist) => !isGenericSeedArtist(artist));
}

function promptIntentSearchQueries(options = {}, profile = buildDiscoveryProfile(options), limit = 42) {
  const promptIntent = profile.promptIntent || {};
  const expansions = Array.isArray(promptIntent.queryExpansions) ? promptIntent.queryExpansions : [];
  if (!expansions.length) return [];

  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index)).slice(-3)
    : [];
  const genres = profile.targetGenres?.length ? profile.targetGenres.slice(0, 4) : [];
  const vibes = profile.vibeTerms?.length ? profile.vibeTerms.slice(0, 4) : [];
  const queries = [];

  for (const expansion of expansions.slice(0, 18)) {
    queries.push(cleanText(expansion));
    for (const genre of genres) queries.push(cleanText(`${expansion} ${genre}`));
    for (const vibe of vibes.slice(0, genres.length ? 2 : 4)) queries.push(cleanText(`${expansion} ${vibe}`));
    for (const year of yearTerms) {
      queries.push(cleanText(`${expansion} ${year}`));
      for (const genre of genres.slice(0, 2)) queries.push(cleanText(`${expansion} ${genre} ${year}`));
    }
  }

  return uniqueTerms(queries, limit);
}

function topTasteLabels(tasteProfile = null, limit = 8) {
  if (!tasteProfile || typeof tasteProfile.read !== "function") return [];
  const labels = tasteProfile.read()?.labels || {};
  return Object.values(labels)
    .filter((entry) => Number(entry.score || 0) > 0 && cleanText(entry.name))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || Number(right.up || 0) - Number(left.up || 0))
    .slice(0, limit)
    .map((entry) => cleanText(entry.name));
}

function omnivoreBridgeTraits(options = {}, profile = buildDiscoveryProfile(options)) {
  return uniqueTerms([
    ...(profile.vibeTerms || []),
    ...(profile.trackCharacteristics || []),
    ...OMNIVORE_DEFAULT_TRAITS
  ], 10);
}

function interleaveQueryBuckets(buckets = [], limit = 80) {
  const result = [];
  const normalized = buckets.map((bucket) => uniqueTerms(bucket, 80));
  const maxLength = Math.max(0, ...normalized.map((bucket) => bucket.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const bucket of normalized) {
      if (bucket[index]) result.push(bucket[index]);
      if (result.length >= limit) return uniqueTerms(result, limit);
    }
  }
  return uniqueTerms(result, limit);
}

function buildOmnivoreDiscoveryQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), limit = 96) {
  if (!profile.isOmnivoreDiscovery || profile.scoringMode === "pure" || profile.scoringMode === "similar") return [];

  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index)).slice(-3)
    : [""];
  const traits = omnivoreBridgeTraits(options, profile);
  const tasteLabels = topTasteLabels(tasteProfile, 8);
  const buckets = [];

  for (const lane of activeOmnivoreDiscoveryLanes(options)) {
    const queries = [];
    const anchors = lane.anchors.slice(0, 5);
    const targets = lane.targets.slice(0, 3);
    for (const year of yearTerms) {
      for (const anchor of anchors) {
        for (const target of targets.slice(0, 2)) {
          queries.push(cleanText(`${anchor} ${target} ${year}`));
        }
        for (const trait of traits.slice(0, 2)) {
          queries.push(cleanText(`${anchor} ${trait} ${year}`));
        }
        queries.push(cleanText(`${anchor} ${year}`));
      }
      for (const target of targets.slice(0, 2)) {
        for (const trait of traits.slice(0, 3)) {
          queries.push(cleanText(`${target} ${trait} ${year}`));
        }
        queries.push(cleanText(`${target} underground ${year}`));
        queries.push(cleanText(`${target} ${year}`));
      }
    }
    buckets.push(queries);
  }

  if (tasteLabels.length) {
    const tasteQueries = [];
    for (const year of yearTerms) {
      for (const label of tasteLabels) {
        tasteQueries.push(cleanText(`${label} ${year}`));
        for (const trait of traits.slice(0, 3)) {
          tasteQueries.push(cleanText(`${label} ${trait} ${year}`));
        }
      }
    }
    buckets.unshift(tasteQueries);
  }

  return interleaveQueryBuckets(buckets, limit);
}

function omnivoreTargetTerms(options = {}, limit = 12) {
  return uniqueTerms(activeOmnivoreDiscoveryLanes(options).flatMap((lane) => lane.targets.slice(0, 2)), limit);
}

function omnivoreLaneEvidenceTerms(lane = {}) {
  const extras = {
    "leftfield-electronic": ["electronic", "electronica", "experimental electronic"],
    downtempo: ["downtempo", "chillout", "balearic"],
    ambient: ["ambient", "modern classical", "minimal"],
    "indie-dance": ["indie dance", "dance", "disco"],
    "nu-disco": ["disco", "funk", "boogie"],
    breaks: ["breaks", "breakbeat", "electro"],
    "psychedelic-electronic": ["psychedelic", "psytrance", "ambient"],
    "jazz-fusion": ["jazz", "fusion", "nu jazz"],
    "modern-soul": ["soul", "r&b", "r and b", "funk"],
    "dream-pop": ["dream pop", "indie", "synth pop"],
    "cinematic-rock": ["rock", "post rock", "krautrock"],
    "deep-bass": ["bass", "dubstep", "garage", "dub"]
  };
  return uniqueTerms([...(lane.targets || []), ...(extras[lane.id] || [])], 16);
}

function omnivoreBridgeEvidenceFor(track = {}, query = "", options = {}, profile = buildDiscoveryProfile(options)) {
  if (!profile.isOmnivoreDiscovery) return { points: 0, corroborates: false, queryOnly: false, queryMatched: false, lane: "", anchor: "", target: "" };

  const metadataText = `${track.artist || ""} ${track.title || ""} ${track.album || ""} ${labelText(track)} ${Array.isArray(track.genre) ? track.genre.join(" ") : (track.genre || "")}`;
  const queryText = cleanText(query || track.query || "");
  const lanes = activeOmnivoreDiscoveryLanes(options);
  let best = { points: 0, corroborates: false, queryOnly: false, queryMatched: false, lane: "", anchor: "", target: "" };

  for (const lane of lanes) {
    const anchors = lane.anchors || [];
    const targets = omnivoreLaneEvidenceTerms(lane);
    const metadataAnchor = anchors.find((anchor) => containsEntityTerm(metadataText, anchor)) || "";
    const metadataTarget = targets.find((target) => hasAnyTerm(metadataText, [target])) || "";
    const queryAnchor = anchors.find((anchor) => containsEntityTerm(queryText, anchor)) || "";
    const queryTarget = targets.find((target) => hasAnyTerm(queryText, [target])) || "";
    const queryMatched = Boolean(queryAnchor || queryTarget);
    const corroborates = Boolean(metadataAnchor || metadataTarget);
    const minutes = durationMinutes(track);
    let points = 0;

    if (metadataAnchor) points += 15;
    if (metadataTarget) points += 10;
    if (queryAnchor && corroborates) points += 5;
    else if (queryAnchor) points += 3;
    if (queryTarget && corroborates) points += 4;
    else if (queryTarget) points += 2;
    if (minutes >= 5 && minutes <= 12) points += 4;
    else if (minutes >= 3.5 && minutes < 5) points += 2;

    points = clamp(points, 0, 28);
    if (points > best.points) {
      best = {
        points,
        corroborates,
        queryOnly: queryMatched && !corroborates,
        queryMatched,
        lane: lane.id,
        anchor: metadataAnchor || queryAnchor || "",
        target: metadataTarget || queryTarget || ""
      };
    }
  }

  return best;
}

function omnivoreDriftReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  if (!profile.isOmnivoreDiscovery) return "";
  if (requestedLabelMatch(track, profile) || hasSeedArtistMatch(track, options, profile)) return "";
  const evidence = omnivoreBridgeEvidenceFor(track, track.query, options, profile);
  if (evidence.corroborates) return "";
  if (evidence.queryMatched) {
    return "Open any-genre discovery matched only the search query; TIDAL metadata does not corroborate the taste-bridge lane.";
  }
  return "Open any-genre discovery candidate lacks cross-genre taste-bridge evidence.";
}

function electronicDomainDriftReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  if (!profile.isBroadElectronicDiscovery) return "";

  const metadataText = normalize([
    track.artist,
    track.title,
    track.album,
    labelText(track),
    track.genre,
    track.genres,
    track.subgenre,
    track.subgenres,
    track.tidal?.genre,
    track.tidal?.genres,
    track.tidal?.artistGenre,
    track.tidal?.artistGenres,
    track.beatport?.genre,
    track.beatport?.subgenre
  ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(" "));
  const officialGenreText = normalize([
    ...trackGenreValues(track),
    track.subgenre,
    track.subgenres,
    track.beatport?.genre,
    track.beatport?.subgenre
  ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(" "));
  const nonElectronic = /\b(?:rock|progressive rock|psychedelic rock|country|folk|blues|jazz|classical|metal|hip hop|rap|r and b|soul|soundtrack|film score|original score|spoken word|audiobook|podcast|comedy)\b/.test(officialGenreText || metadataText);
  const electronicEvidence = ELECTRONIC_DOMAIN_TERMS.some((term) => containsEntityTerm(officialGenreText, term)) ||
    /\b(?:electronic|edm|dance music|house|techno|trance|dubstep|bass|drum and bass|dnb|breakbeat|electronica)\b/.test(officialGenreText) ||
    [...(profile.seedArtists || []), ...(profile.requestedArtists || []), ...PROGRESSIVE_ARTISTS, ...TRANCE_FORWARD_ARTISTS, ...genreArtistAnchors(profile)]
      .some((artist) => artistMatchesKnownName(track.artist, artist)) ||
    [...EDM_DISCOVERY_LABELS, ...progressiveSceneLabelsFor(profile)]
      .some((label) => entityEvidenceMatches(labelText(track), label));

  if (nonElectronic && !electronicEvidence) {
    return "Outside the EDM parent domain; catalog metadata identifies a non-electronic lane.";
  }
  return "";
}

function buildSearchQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), history = null, freshArtistAvoidance = null) {
  const tasteProfileLed = Boolean(
    profile.tasteProfileLed ||
    profile.promptIntent?.outsideTasteMode === "taste-profile" ||
    (/^(?:1|true|yes)$/i.test(String(options.standbyPool || "")) &&
      !cleanText(options.genres) &&
      !cleanText(options.mood) &&
      /\b(?:taste\s+profile|use\s+my\s+taste|based\s+on\s+my\s+taste|current\s+taste)\b/i.test(String(options.request || "")))
  );
  if (tasteProfileLed) {
    const excludedTasteSeeds = new Set(tasteSeedExclusionNames(options).map(artistIdentityKey));
    profile.learnedTasteArtists = uniqueTerms([
      ...(Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : []),
      ...(typeof tasteProfile?.getTopArtists === "function" ? tasteProfile.getTopArtists(36) : [])
    ].filter((artist) => !isGenericSeedArtist(artist) && !excludedTasteSeeds.has(artistIdentityKey(artist))), 36);
    profile.learnedTasteLabels = uniqueTerms([
      ...(Array.isArray(options.learnedTasteLabels) ? options.learnedTasteLabels : []),
      ...(tasteProfile ? topTasteLabels(tasteProfile, 18) : [])
    ], 18);
  }
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const hardGenreConstraint = hardGenreConstraintFor(profile);
  const broadElectronic = Boolean(profile.isBroadElectronicDiscovery);
  const rawPlanArtists = uniqueTerms([
    ...(hardGenreConstraint ? [] : (Array.isArray(plan.seedArtists) ? plan.seedArtists : [])),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ].filter((artist) => !isGenericSeedArtist(artist)), 24);
  const incompatiblePlanArtists = incompatiblePlanArtistsFor(options, profile);
  const planQueries = filterFreshArtistQueries(
    uniqueTerms(Array.isArray(plan.searchQueries) ? plan.searchQueries : [], 24)
      .filter((query) => queryIsGenreCompatible(query, profile, incompatiblePlanArtists)),
    options,
    history,
    tasteProfile,
    profile,
    freshArtistAvoidance
  );
  const pureRequestedArtistSearch = profile.scoringMode === "pure" && (profile.requestedArtists || []).length;
  const planArtists = pureRequestedArtistSearch ? [] : filterGenreCompatibleSeeds(
    rawPlanArtists,
    profile,
    profile.requestedArtists || []
  ).slice(0, 24);
  const branchArtists = pureRequestedArtistSearch ? [] : branchArtistSeeds(options, profile, 24);
  const planLabels = tasteProfileLed
    ? []
    : filterGenreCompatibleLabels(
      uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 24),
      profile,
      profile.requestedLabels || []
    );
  const planTargetTerms = uniqueTerms(Array.isArray(plan.targetGenres) ? plan.targetGenres : [], 16);
  const planVibeTerms = uniqueTerms(Array.isArray(plan.vibeTerms) ? plan.vibeTerms : [], 16);
  const request = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? (tasteProfileLed && !cleanText(options.genres)
      ? [""]
      : Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index)))
    : [""];
  const isYearCatalogSearch = Boolean(yearRange && profile.targetGenres.length);
  const useAnchoredGenreSearch = Boolean(profile.isGenreDiscoveryTarget && !profile.isProgressivePlanningTarget && !pureRequestedArtistSearch);
  const outsideTastePrompt = Boolean(profile.promptIntent?.allowOutsideTaste && profile.scoringMode === "taste-guided");
  const tasteArtistSeedLimit = tasteProfileLed
    ? 32
    : outsideTastePrompt
    ? 4
    : (isYearCatalogSearch ? 34 : 18);
  const learnedFirstArtistSeeds = buildArtistSeeds(options, tasteArtistSeedLimit, tasteProfile, profile, history, freshArtistAvoidance);
  const artists = filterFreshArtistSeeds(uniqueTerms(
    tasteProfileLed
      ? [...learnedFirstArtistSeeds, ...branchArtists, ...planArtists]
      : [
        ...(profile.isOmnivoreDiscovery ? [] : planArtists),
        ...branchArtists,
        ...learnedFirstArtistSeeds
      ],
    isYearCatalogSearch ? 42 : 28
  ), options, history, tasteProfile, profile, freshArtistAvoidance);
  const artistQuerySeeds = tasteProfileLed
    ? uniqueTerms([
      ...learnedFirstArtistSeeds.slice(0, 8),
      ...branchArtists,
      ...planArtists,
      ...learnedFirstArtistSeeds.slice(8)
    ], 28)
    : artists;
  const promptQueries = promptIntentSearchQueries(options, profile, isYearCatalogSearch ? 48 : 36);
  const omnivoreQueries = buildOmnivoreDiscoveryQueries(options, tasteProfile, profile, isYearCatalogSearch ? 120 : 84);
  const genreSeeds = genreDiscoverySeeds(profile);
  let targetTerms = [];
  if (tasteProfileLed && !profile.targetGenres.length) {
    targetTerms = [""];
  } else if (pureRequestedArtistSearch && !profile.targetGenres.length) {
    targetTerms = [""];
  } else if (profile.isOmnivoreDiscovery) {
    targetTerms = omnivoreTargetTerms(options, 18);
  } else if (broadElectronic) {
    targetTerms = uniqueTerms(ELECTRONIC_DOMAIN_TERMS, 20);
  } else if (planTargetTerms.length) {
    targetTerms = uniqueTerms([
      ...planTargetTerms,
      ...(profile.isProgressiveTarget ? PROGRESSIVE_CATALOG_TARGETS : [])
    ], 18);
  } else if (profile.targetGenres.length) {
    targetTerms = profile.isProgressiveTarget
      ? uniqueTerms([...profile.targetGenres, ...PROGRESSIVE_CATALOG_TARGETS], 18)
      : profile.targetGenres;
  } else {
    targetTerms = [profile.primaryTarget].filter(Boolean);
  }
  const vibeTerms = uniqueTerms([...planVibeTerms, ...profile.vibeTerms], 24);
  const artistQueries = [];
  const sceneQueries = [];
  const labelQueries = [];
  const tranceQueries = [];
  const catalogYearQueries = [];
  const extendedQueries = [];
  const electronicAnchorQueries = [];
  const tasteCatalogQueries = [];
  const sceneAnchorQueries = useAnchoredGenreSearch
    ? buildSceneAnchorRecentQueries(options, tasteProfile, profile, history, freshArtistAvoidance)
    : [];

  if (broadElectronic) {
    const electronicArtists = uniqueTerms([
      ...artists,
      ...EDM_DISCOVERY_ARTISTS
    ], 48);
    const electronicLabels = uniqueTerms([
      ...planLabels,
      ...EDM_DISCOVERY_LABELS
    ], 28);
    for (const artist of electronicArtists.slice(0, 32)) {
      electronicAnchorQueries.push(cleanText(artist));
      for (const year of yearTerms.slice(-2)) {
        if (year) electronicAnchorQueries.push(cleanText(`${artist} ${year}`));
      }
    }
    for (const label of electronicLabels.slice(0, 20)) {
      electronicAnchorQueries.push(cleanText(label));
      for (const year of yearTerms.slice(-2)) {
        if (year) electronicAnchorQueries.push(cleanText(`${label} ${year}`));
      }
    }
  }

  for (const artist of artistQuerySeeds.slice(0, profile.isProgressivePlanningTarget ? (isYearCatalogSearch ? 28 : 14) : (tasteProfileLed ? 22 : 10))) {
    for (const target of targetTerms.slice(0, 4)) {
      for (const year of yearTerms.slice(-2)) artistQueries.push(cleanText(`${artist} ${target} ${year}`));
    }
  }

  if (isYearCatalogSearch) {
    const useBroadGenreYearQueries = !useAnchoredGenreSearch || !genreSeeds.length;
    for (const year of yearTerms.slice(-3)) {
      for (const target of targetTerms.slice(0, profile.isProgressivePlanningTarget ? 10 : 5)) {
        if (useBroadGenreYearQueries) {
          catalogYearQueries.push(cleanText(`${target} ${year}`));
          catalogYearQueries.push(cleanText(`${target} new releases ${year}`));
        }
      }
      if (profile.isGenreDiscoveryTarget && !profile.isProgressivePlanningTarget) {
        for (const seed of genreSeeds.slice(0, 24)) {
          for (const target of targetTerms.slice(0, 2)) {
            catalogYearQueries.push(cleanText(`${seed} ${target} ${year}`));
          }
          catalogYearQueries.push(cleanText(`${seed} ${year}`));
        }
      }
      if (isProgressiveSceneTarget(profile)) {
        for (const label of progressiveSceneLabelsFor(profile).slice(0, 28)) {
          catalogYearQueries.push(cleanText(`${label} ${year}`));
          catalogYearQueries.push(cleanText(`${label} ${progressiveSceneTargetFor(profile)} ${year}`));
        }
        for (const artist of artists.slice(0, 24)) {
          catalogYearQueries.push(cleanText(`${artist} ${year}`));
        }
      }
    }
  }

  if (!pureRequestedArtistSearch && request.includes("trance")) {
    for (const artist of ["Solarstone", "Basil O'Glue", "Paul Thomas", "Jerome Isma-Ae", "Forerunners"]) {
      for (const year of yearTerms.slice(-3)) tranceQueries.push(cleanText(`${artist} ${year}`));
    }
  }

  for (const target of targetTerms.length ? targetTerms : SCENE_TERMS) {
    sceneQueries.push(cleanText(target));
    for (const year of yearTerms.slice(-2)) sceneQueries.push(cleanText(`${target} ${year}`));
    sceneQueries.push(cleanText(`${target} new releases`));
    if (!profile.targetGenres.length && !broadElectronic) {
      sceneQueries.push(cleanText(`${target} underground`));
      sceneQueries.push(cleanText(`${target} club tracks`));
    }
  }

  if (profile.isGenreDiscoveryTarget && !profile.isProgressivePlanningTarget) {
    for (const seed of genreSeeds.slice(0, isYearCatalogSearch ? 24 : 14)) {
      for (const target of targetTerms.slice(0, 3)) {
        for (const year of yearTerms.slice(-2)) labelQueries.push(cleanText(`${seed} ${target} ${year}`));
      }
    }
  }

  for (const label of uniqueTerms([...branchLabelSeeds(options, profile, 18), ...(profile.isOmnivoreDiscovery ? [] : planLabels)], isYearCatalogSearch ? 24 : 16)) {
      for (const target of targetTerms.slice(0, 3)) {
        for (const year of yearTerms.slice(-2)) labelQueries.push(cleanText(`${label} ${target} ${year}`));
      }
    labelQueries.push(cleanText(label));
  }

  if (isProgressiveSceneTarget(profile)) {
    for (const label of progressiveSceneLabelsFor(profile).slice(0, isYearCatalogSearch ? 28 : 14)) {
      for (const target of targetTerms.slice(0, 3)) {
        for (const year of yearTerms.slice(-2)) labelQueries.push(cleanText(`${label} ${target} ${year}`));
      }
    }
  }

  // A taste-profile request is intentionally seed-led. The learned profile
  // supplies artist/label anchors; mood and activity words stay ranking
  // signals instead of becoming literal TIDAL catalog queries.
  const tasteLabels = tasteProfileLed ? (profile.learnedTasteLabels || []) : [];
  if (tasteLabels.length) {
    for (const label of tasteLabels.slice(0, 18)) {
      labelQueries.push(cleanText(label));
      for (const year of yearTerms.slice(-2)) {
        if (year) labelQueries.push(cleanText(`${label} ${year}`));
      }
    }
  }

  if (tasteProfileLed) {
    // A bare artist query repeatedly returns the same popular TIDAL rows.
    // Add a small, anchored year slice so the reservoir can reach deeper and
    // newer catalog material without turning vibe words into literal search
    // text. These remain artist/label queries, not free-form mood searches.
    const currentYear = new Date().getFullYear();
    const catalogYears = [currentYear, currentYear - 1, currentYear - 2];
    for (const artist of artistQuerySeeds.slice(0, 18)) {
      for (const year of catalogYears.slice(0, 2)) tasteCatalogQueries.push(cleanText(`${artist} ${year}`));
    }
    for (const label of tasteLabels.slice(0, 12)) {
      for (const year of catalogYears.slice(0, 2)) tasteCatalogQueries.push(cleanText(`${label} ${year}`));
    }
  }

  if (requestPrefersExtendedMixes(options)) {
    for (const year of yearTerms.slice(-2)) {
      for (const artist of artists.slice(0, isYearCatalogSearch ? 24 : 12)) {
        extendedQueries.push(cleanText(`${artist} extended mix ${year}`));
        extendedQueries.push(cleanText(`${artist} club mix ${year}`));
        for (const target of targetTerms.slice(0, 2)) {
          extendedQueries.push(cleanText(`${artist} ${target} extended mix ${year}`));
        }
      }
      for (const target of targetTerms.slice(0, profile.isProgressivePlanningTarget ? 8 : 4)) {
        extendedQueries.push(cleanText(`${target} extended mix ${year}`));
        extendedQueries.push(cleanText(`${target} club mix ${year}`));
      }
      for (const label of uniqueTerms([...branchLabelSeeds(options, profile, 14), ...(profile.isOmnivoreDiscovery ? [] : planLabels)], 18)) {
        extendedQueries.push(cleanText(`${label} extended mix ${year}`));
        for (const target of targetTerms.slice(0, 2)) {
          extendedQueries.push(cleanText(`${label} ${target} extended mix ${year}`));
        }
      }
    }
  }

  const wideDiscoveryPool = shouldBuildWideDiscoveryPool(options, profile);
  const queryLimit = isYearCatalogSearch
    ? (wideDiscoveryPool ? 140 : 88)
    : (wideDiscoveryPool ? 90 : 42);
  const planQueryLimit = isYearCatalogSearch ? 18 : 12;
  const anchoredQueryLimit = isYearCatalogSearch ? 46 : 18;
  const progressiveLabelYearQueries = isProgressiveSceneTarget(profile) && isYearCatalogSearch
    ? uniqueTerms([
      ...catalogYearQueries.filter((query) => progressiveSceneLabelsFor(profile).some((label) => normalize(query).includes(normalize(label)))),
      ...labelQueries
    ], 44)
    : [];
  const tasteQueryAnchors = tasteProfileLed
    ? uniqueTerms([
      ...artists,
      ...tasteLabels,
      ...(Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : []),
      ...(Array.isArray(options.learnedTasteLabels) ? options.learnedTasteLabels : []),
      ...(Array.isArray(options.similarArtistSeeds) ? options.similarArtistSeeds : [])
    ], 96)
    : [];
  const isTasteAnchorQuery = (query) => !tasteProfileLed || tasteQueryAnchors.some((anchor) => (
    artistNamesMatch(query, anchor, { contains: true }) || entityEvidenceMatches(query, anchor)
  ));
  const finalizeQueries = (values = [], limit = queryLimit) => Array.from(new Set(values
    .map(cleanText)
    .filter(Boolean)
    .filter((query) => !semanticOnlyQueryFor(query, profile))
    .filter(isTasteAnchorQuery)
    .filter((query) => queryIsGenreCompatible(query, profile, incompatiblePlanArtists))
  )).slice(0, limit);
  if (/^(1|true|yes)$/i.test(String(options.planOnlySearch || options.planQueriesOnly || "")) && planQueries.length) {
    const planOnlyLimit = Math.max(1, Math.min(queryLimit, Number(options.planQueryLimit || planQueries.length || queryLimit)));
    return finalizeQueries(planQueries, planOnlyLimit);
  }
  if (pureRequestedArtistSearch) {
    const requestedArtists = (profile.requestedArtists || []).map(cleanText).filter(Boolean);
    const requestedPlanQueries = planQueries.filter((query) => {
      const normalizedQuery = normalize(query);
      return requestedArtists.some((artist) => (
        isCollisionSensitiveArtist(artist)
          ? artistMatchesKnownName(query, artist, { contains: true })
          : normalizedQuery.includes(normalize(artist))
      ));
    });
    return finalizeQueries([
      ...extendedQueries,
      ...artistQueries,
      ...requestedPlanQueries
    ]);
  }
  if (tasteProfileLed) {
    const tasteAnchors = uniqueTerms([...artists, ...tasteLabels], 48);
    const anchoredPlanQueries = planQueries.filter((query) => tasteAnchors.some((anchor) => (
      artistNamesMatch(query, anchor, { contains: true }) || entityEvidenceMatches(query, anchor)
    )));
    return finalizeQueries([
      ...artistQueries.slice(0, 18),
      ...tasteCatalogQueries,
      ...labelQueries.slice(0, 18),
      ...anchoredPlanQueries.slice(0, 12)
    ]);
  }
  if (profile.isProgressiveTranceTarget) {
    // Progressive Trance is a specialized hard-duration planning lane. Put
    // trusted direct artists first, reserve the exact genre lane next, and
    // keep trusted scene labels in the same bounded first-page reservoir.
    // The requested genre remains unchanged; this only controls query order.
    const directArtistQueries = uniqueValues([
      ...tranceQueries,
      ...(!pureRequestedArtistSearch ? filterFreshArtistSeeds(
        TRANCE_FORWARD_ARTISTS, options, history, tasteProfile, profile, freshArtistAvoidance
      ).flatMap(artist => yearTerms.slice(-3).map(year => cleanText(`${artist} ${year}`))) : []),
      ...artistQueries
    ].filter((query) => queryGenerationInfo(query, profile, options).seedType === "artist"));
    const exactRequestedGenre = cleanText(profile.targetGenres?.[0] || "");
    const exactGenreQueries = uniqueValues([
      exactRequestedGenre,
      ...sceneQueries.filter((query) => normalize(query) === normalize(exactRequestedGenre))
    ]);
    return finalizeQueries([
      ...directArtistQueries.slice(0, 8),
      ...exactGenreQueries.slice(0, 2),
      ...labelQueries.slice(0, 4),
      ...directArtistQueries.slice(8, 32),
      ...exactGenreQueries.slice(2, 12),
      ...labelQueries.slice(4, 24),
      ...planQueries.slice(0, planQueryLimit)
    ], Math.max(queryLimit, 48));
  }
  if (options.autoBroadenLane === "yield-retry" && planQueries.length) {
    return finalizeQueries([
      ...extendedQueries,
      ...planQueries,
      ...progressiveLabelYearQueries,
      ...catalogYearQueries,
      ...sceneQueries
    ]);
  }
  return finalizeQueries([
    ...electronicAnchorQueries,
    ...extendedQueries,
    ...omnivoreQueries.slice(0, profile.isOmnivoreDiscovery ? 72 : 48),
    ...promptQueries.slice(0, profile.isOmnivoreDiscovery ? 6 : 24),
    ...progressiveLabelYearQueries,
    ...sceneAnchorQueries.slice(0, anchoredQueryLimit),
    ...labelQueries.slice(0, useAnchoredGenreSearch ? (isYearCatalogSearch ? 36 : 18) : 0),
    ...artistQueries.slice(0, useAnchoredGenreSearch ? (isYearCatalogSearch ? 30 : 14) : 0),
    ...planQueries.slice(0, profile.isOmnivoreDiscovery ? 3 : (useAnchoredGenreSearch ? Math.ceil(planQueryLimit / 2) : planQueryLimit)),
    ...catalogYearQueries.slice(0, profile.isProgressivePlanningTarget ? 36 : (profile.isGenreDiscoveryTarget ? 36 : 16)),
    ...artistQueries.slice(0, profile.isProgressivePlanningTarget ? (isYearCatalogSearch ? 24 : 12) : 10),
    ...sceneQueries.slice(0, isYearCatalogSearch ? 22 : 14),
    ...labelQueries.slice(0, profile.isProgressivePlanningTarget ? (isYearCatalogSearch ? 28 : 12) : (profile.isGenreDiscoveryTarget ? (isYearCatalogSearch ? 32 : 16) : 0)),
    ...tranceQueries.slice(0, 5),
    ...artistQueries.slice(24, isYearCatalogSearch ? 42 : 18),
    ...omnivoreQueries.slice(profile.isOmnivoreDiscovery ? 72 : 48),
    ...promptQueries.slice(profile.isOmnivoreDiscovery ? 6 : 24)
  ]);
}

function buildAdjacentSearchQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), history = null, freshArtistAvoidance = null) {
  if (!profile.isGenreDiscoveryTarget || profile.isProgressivePlanningTarget) return [];

  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const adjacentTerms = adjacentLaneTerms(profile, options);
  if (!adjacentTerms.length) return [];

  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planLabels = filterGenreCompatibleLabels(
    uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 16),
    profile,
    profile.requestedLabels || []
  );
  const seeds = filterFreshArtistSeeds(uniqueTerms([
    ...branchArtistSeeds(options, profile, 18),
    ...genreDiscoverySeeds(profile),
    ...branchLabelSeeds(options, profile, 16),
    ...planLabels,
    ...buildArtistSeeds(options, 16, tasteProfile, profile, history, freshArtistAvoidance)
  ], 44), options, history, tasteProfile, profile, freshArtistAvoidance);
  const vibeTerms = uniqueTerms([...(profile.vibeTerms || [])], 10);
  const queries = [];

  for (const year of yearTerms.slice(-3)) {
    for (const adjacent of adjacentTerms.slice(0, 8)) {
      queries.push(cleanText(`${adjacent} ${year}`));
      for (const vibe of vibeTerms.slice(0, 3)) {
        queries.push(cleanText(`${vibe} ${adjacent} ${year}`));
      }
      for (const seed of seeds.slice(0, 18)) {
        queries.push(cleanText(`${seed} ${adjacent} ${year}`));
      }
    }
  }

  return filterHardGenreQueries(queries, options, profile, yearRange ? 72 : 40);
}

function buildBranchSearchQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), history = null, freshArtistAvoidance = null) {
  if (profile.scoringMode === "pure") return [];

  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const targetTerms = uniqueTerms([
    ...(profile.isOmnivoreDiscovery ? omnivoreTargetTerms(options, 10) : (profile.targetGenres || [])),
    ...(profile.primaryTarget ? [profile.primaryTarget] : [])
  ], 8);
  const vibeTerms = uniqueTerms([...(profile.vibeTerms || [])], 6);
  const tasteGuidedBranchSeeds = profile.scoringMode === "taste-guided" && shouldBuildWideDiscoveryPool(options, profile)
    ? buildArtistSeeds(options, profile.promptIntent?.allowOutsideTaste ? 4 : 14, tasteProfile, profile, history, freshArtistAvoidance)
    : [];
  const artistSeeds = filterFreshArtistSeeds(uniqueTerms([
    ...branchArtistSeeds(options, profile, 28),
    ...(profile.isOmnivoreDiscovery ? activeOmnivoreDiscoveryLanes(options).flatMap((lane) => lane.anchors.slice(0, 2)) : []),
    ...tasteGuidedBranchSeeds,
    ...((profile.scoringMode === "similar" || profile.scoringMode === "explore") ? buildArtistSeeds(options, 10, tasteProfile, profile, history, freshArtistAvoidance) : [])
  ], 32), options, history, tasteProfile, profile, freshArtistAvoidance);
  const labelSeeds = filterGenreCompatibleLabels(uniqueTerms([
    ...(isProgressiveSceneTarget(profile) ? progressiveSceneLabelsFor(profile).slice(0, 14) : []),
    ...branchLabelSeeds(options, profile, 24),
    ...(profile.isOmnivoreDiscovery ? activeOmnivoreDiscoveryLanes(options).flatMap((lane) => lane.anchors.slice(0, 2)) : []),
    ...(isProgressiveSceneTarget(profile) ? progressiveSceneLabelsFor(profile).slice(14, 28) : [])
  ], 32), profile, profile.requestedLabels || []);

  if (!artistSeeds.length && !labelSeeds.length) return [];

  const queries = [];
  const recentYears = yearTerms.slice(-3);
  for (const year of recentYears) {
    for (const artist of artistSeeds.slice(0, yearRange ? 18 : 12)) {
      queries.push(cleanText(`${artist} ${year}`));
      for (const target of targetTerms.slice(0, 3)) {
        queries.push(cleanText(`${artist} ${target} ${year}`));
      }
      for (const vibe of vibeTerms.slice(0, 2)) {
        queries.push(cleanText(`${artist} ${vibe} ${year}`));
      }
    }
    for (const label of labelSeeds.slice(0, yearRange ? 18 : 10)) {
      queries.push(cleanText(`${label} ${year}`));
      for (const target of targetTerms.slice(0, 3)) {
        queries.push(cleanText(`${label} ${target} ${year}`));
      }
      for (const vibe of vibeTerms.slice(0, 2)) {
        queries.push(cleanText(`${label} ${vibe} ${year}`));
      }
    }
  }

  return filterHardGenreQueries(queries, options, profile, yearRange ? 80 : 44);
}

function recoveryYearTerms(options = {}) {
  const yearRange = parseYearRange(options);
  if (!yearRange) return [];
  const years = Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index));
  return uniqueTerms([yearRange.label, ...years.slice(-3)], 4);
}

function recoveryQueryText(...parts) {
  return cleanText(parts.filter(Boolean).join(" "));
}

function recoveryCandidatePairs(options = {}) {
  const pairs = [];
  for (const candidate of Array.isArray(options.llmCandidates) ? options.llmCandidates : []) {
    const artist = cleanText(candidate?.artist);
    const title = cleanText(candidate?.title);
    if (artist && title) pairs.push({ artist, title });
  }
  const nowPlaying = options.nowPlaying || options.currentTrack || {};
  if (nowPlaying && typeof nowPlaying === "object") {
    const artist = cleanText(nowPlaying.artist);
    const title = cleanText(nowPlaying.title);
    if (artist && title) pairs.push({ artist, title });
  }
  return pairs.filter((pair, index, list) => {
    const key = `${normalize(pair.artist)}|${normalize(pair.title)}`;
    return key !== "|" && list.findIndex((item) => `${normalize(item.artist)}|${normalize(item.title)}` === key) === index;
  }).slice(0, 12);
}

function buildAdaptiveRecoveryQueryFamilies(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), artistSeeds = [], usedQueries = new Set(), history = null, freshArtistAvoidance = null) {
  const used = usedQueries instanceof Set ? usedQueries : new Set();
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const rawPlanArtists = uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : []),
    ...(Array.isArray(plan.relatedArtists) ? plan.relatedArtists : []),
    ...(Array.isArray(plan.similarArtists) ? plan.similarArtists : [])
  ].filter((artist) => !isGenericSeedArtist(artist)), 32);
  const incompatiblePlanArtists = rawPlanArtists.filter((artist) => !isGenreCompatibleSeed(artist, profile, profile.requestedArtists || []));
  const yearTerms = recoveryYearTerms(options);
  const primaryYear = yearTerms[0] || "";
  const targetTerms = uniqueTerms([
    ...(profile.isOmnivoreDiscovery ? omnivoreTargetTerms(options, 10) : (profile.targetGenres || [])),
    profile.primaryTarget || "",
    ...(Array.isArray(options.llmSearchPlan?.targetGenres) ? options.llmSearchPlan.targetGenres : [])
  ], 8);
  const vibeTerms = uniqueTerms([
    ...(profile.vibeTerms || []),
    ...(Array.isArray(options.llmSearchPlan?.vibeTerms) ? options.llmSearchPlan.vibeTerms : [])
  ], 8);
  const labelSeeds = filterGenreCompatibleLabels(uniqueTerms([
    ...(profile.requestedLabels || []),
    ...(Array.isArray(options.llmSearchPlan?.candidateLabels) ? options.llmSearchPlan.candidateLabels : []),
    ...branchLabelSeeds(options, profile, 18),
    ...genreLabelSeeds(profile).slice(0, 14)
  ], 24), profile, profile.requestedLabels || []);
  const requestedArtistSeeds = uniqueTerms([
    ...(profile.requestedArtists || []),
    ...(profile.seedArtists || [])
  ], 18);
  const branchSeeds = profile.scoringMode === "pure"
    ? requestedArtistSeeds
    : filterFreshArtistSeeds(uniqueTerms([
      ...requestedArtistSeeds,
      ...filterGenreCompatibleSeeds(Array.isArray(options.llmSearchPlan?.candidateArtists) ? options.llmSearchPlan.candidateArtists : [], profile, profile.requestedArtists || []),
      ...filterGenreCompatibleSeeds(artistSeeds, profile, profile.requestedArtists || []),
      ...branchArtistSeeds(options, profile, 18)
    ].filter((artist) => !isGenericSeedArtist(artist)), 28), options, history, tasteProfile, profile, freshArtistAvoidance);
  const genreText = targetTerms.slice(0, 2).join(" ") || cleanText(options.genres) || "electronic music";
  const vibeText = vibeTerms.slice(0, 2).join(" ");
  const requestTheme = cleanText(options.request)
    .replace(/\b(?:find|search|give me|show me|tracks?|songs?|music|please)\b/gi, " ")
    .replace(/[.,!?]+/g, " ")
    .trim()
    .slice(0, 80);

  function family(id, label, lane, queries, genreExemptQueries = []) {
    const exempt = new Set(genreExemptQueries.map((query) => normalize(query)).filter(Boolean));
    const filteredQueries = filterFreshArtistQueries(
      uniqueValues(queries.map(cleanText).filter(Boolean))
        .filter((query) => exempt.has(normalize(query)) || queryIsGenreCompatible(query, profile, incompatiblePlanArtists))
        .slice(0, 24),
      options,
      history,
      tasteProfile,
      profile,
      freshArtistAvoidance
    );
    return {
      id,
      label,
      lane,
      queries: filteredQueries
        .filter((query) => query && !used.has(normalize(query)))
    };
  }

  // A plain taste-profile refresh is not a semantic text-search request.
  // Recovery must stay on the learned artist/label reservoir instead of
  // turning the standby explanation into giant literal catalog queries such
  // as “sources that fit my current Rabbit Hole taste profile...”.
  if (profile.tasteProfileLed || profile.promptIntent?.outsideTasteMode === "taste-profile") {
    const learnedArtists = uniqueTerms([
      ...(Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : []),
      ...(Array.isArray(profile.learnedTasteArtists) ? profile.learnedTasteArtists : []),
      ...artistSeeds
    ].filter((artist) => !isGenericSeedArtist(artist)), 28);
    const learnedLabels = uniqueTerms([
      ...(Array.isArray(options.learnedTasteLabels) ? options.learnedTasteLabels : []),
      ...(Array.isArray(profile.learnedTasteLabels) ? profile.learnedTasteLabels : []),
      ...(tasteProfile ? topTasteLabels(tasteProfile, 18) : [])
    ], 18);
    return [
      family("taste-artist", "Learned taste artist recovery", "taste", learnedArtists),
      family("taste-label", "Learned taste label recovery", "label", learnedLabels)
    ].filter((item) => item.queries.length);
  }

  const exactTitleQueries = [];
  for (const pair of recoveryCandidatePairs(options)) {
    exactTitleQueries.push(recoveryQueryText(pair.artist, pair.title));
    exactTitleQueries.push(recoveryQueryText(pair.title, pair.artist));
    if (primaryYear) exactTitleQueries.push(recoveryQueryText(pair.artist, pair.title, primaryYear));
  }

  const exactArtistQueries = [];
  for (const artist of requestedArtistSeeds.slice(0, 10)) {
    exactArtistQueries.push(recoveryQueryText(artist, primaryYear));
    exactArtistQueries.push(recoveryQueryText(artist, genreText, primaryYear));
    if (vibeText) exactArtistQueries.push(recoveryQueryText(artist, vibeText, genreText));
  }

  const genreYearQueries = [];
  for (const year of yearTerms.length ? yearTerms : [""]) {
    genreYearQueries.push(recoveryQueryText(genreText, year, "new releases"));
    genreYearQueries.push(recoveryQueryText(genreText, year, "underground"));
    genreYearQueries.push(recoveryQueryText(genreText, year, "extended mix"));
    if (vibeText) genreYearQueries.push(recoveryQueryText(genreText, vibeText, year));
  }

  const labelYearQueries = [];
  if (profile.scoringMode !== "pure") {
    for (const label of labelSeeds.slice(0, 14)) {
      labelYearQueries.push(recoveryQueryText(label, genreText, primaryYear));
      labelYearQueries.push(recoveryQueryText(label, primaryYear, "extended mix"));
      if (vibeText) labelYearQueries.push(recoveryQueryText(label, vibeText, genreText));
    }
  }

  const branchQueries = [];
  if (profile.scoringMode !== "pure") {
    for (const artist of branchSeeds.slice(0, 14)) {
      branchQueries.push(recoveryQueryText(artist, genreText, primaryYear));
      branchQueries.push(recoveryQueryText(artist, primaryYear, "new release"));
      if (vibeText) branchQueries.push(recoveryQueryText(artist, vibeText, genreText));
    }
  }

  const adjacentQueries = profile.scoringMode === "pure"
    ? []
    : buildAdjacentSearchQueries(options, tasteProfile, profile, history, freshArtistAvoidance).slice(0, 32);

  const omnivoreQueries = [];
  if (profile.isOmnivoreDiscovery && profile.scoringMode !== "pure") {
    for (const lane of activeOmnivoreDiscoveryLanes(options).slice(0, 8)) {
      const targets = (lane.targets || []).slice(0, 2);
      const anchors = (lane.anchors || []).slice(0, 3);
      for (const target of targets) {
        omnivoreQueries.push(recoveryQueryText(target, "underground", primaryYear));
        for (const anchor of anchors.slice(0, 2)) {
          omnivoreQueries.push(recoveryQueryText(anchor, target));
          if (primaryYear) omnivoreQueries.push(recoveryQueryText(anchor, target, primaryYear));
        }
      }
    }
  }

  const themeQueries = [];
  if (requestTheme && !targetTerms.length) {
    themeQueries.push(recoveryQueryText(requestTheme, "electronic music", primaryYear));
    themeQueries.push(recoveryQueryText(requestTheme, "dance music"));
    themeQueries.push(recoveryQueryText(requestTheme, "ambient electronic"));
  }

  return [
    family("exact-title", "Exact title retry", "core", exactTitleQueries, exactTitleQueries),
    family("exact-artist", "Exact artist catalog retry", "core", exactArtistQueries),
    family("genre-year", "Genre/year discovery retry", "core", genreYearQueries),
    family("label-year", "Label/year recovery", "label", labelYearQueries),
    family("branch-artist", "Branch artist recovery", "branch", branchQueries),
    family("adjacent-lane", "Adjacent lane recovery", "adjacent", adjacentQueries),
    family("omnivore-branches", "Cross-genre branch recovery", "omnivore", omnivoreQueries),
    family("theme", "Theme recovery", "adjacent", themeQueries)
  ].filter((item) => item.queries.length);
}

function laneQuotaShortfalls(targets = {}, available = {}, buckets = ["omnivore", "label", "adjacent", "branch"]) {
  return buckets.map((bucket) => {
    const target = Number(targets?.[bucket] || 0);
    const count = Number(available?.[bucket] || 0);
    return {
      bucket,
      target,
      available: count,
      shortfall: Math.max(0, target - count)
    };
  }).filter((item) => item.target > 0 && item.shortfall > 0);
}

function shouldRunAdaptiveQueryRecovery({
  keptCount = 0,
  requestedCount = 0,
  usefulCandidateTarget = 0,
  queryYield = {},
  budgetAvailable = true,
  laneShortfalls = []
} = {}) {
  if (!budgetAvailable) return { run: false, reason: "runtime budget unavailable" };
  const usefulFloor = Math.min(
    Number(usefulCandidateTarget || 0) || Math.max(Number(requestedCount || 0) * 3, Number(requestedCount || 0) + 12),
    Math.max(Number(requestedCount || 0) + 2, Math.ceil((Number(usefulCandidateTarget || 0) || Number(requestedCount || 0)) * 0.35))
  );
  if (keptCount < requestedCount) return { run: true, reason: "below requested count" };
  if (keptCount < usefulFloor) return { run: true, reason: "thin candidate pool" };
  const actionableShortfalls = (Array.isArray(laneShortfalls) ? laneShortfalls : [])
    .filter((item) => item && Number(item.target || 0) > 0 && Number(item.shortfall || 0) > 0);
  if (actionableShortfalls.length) {
    const lanes = actionableShortfalls.map((item) => cleanText(item.bucket)).filter(Boolean);
    const summary = actionableShortfalls
      .slice(0, 3)
      .map((item) => `${item.bucket} ${item.available || 0}/${item.target || 0}`)
      .join(", ");
    return {
      run: true,
      reason: `lane starvation: ${summary}`,
      lanes,
      laneShortfalls: actionableShortfalls
    };
  }
  const attempted = Number(queryYield.attempted || 0);
  const returned = Number(queryYield.returned || 0);
  const accepted = Number(queryYield.accepted || 0);
  const sludge = Number(queryYield.seoRejects || 0) + Number(queryYield.genreRejects || 0);
  if (attempted >= 4 && accepted <= 1 && returned >= 20) return { run: true, reason: "weak query yield" };
  if (sludge >= Math.max(8, accepted * 4)) return { run: true, reason: "high sludge rejection" };
  return { run: false, reason: "" };
}

function yearTermsForBroadenPass(options = {}) {
  const yearRange = parseYearRange(options);
  if (!yearRange) return [""];
  return Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index)).slice(-3);
}

function mergePlanForBroaden(options = {}, additions = {}) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  return {
    ...plan,
    searchQueries: uniqueTerms([
      ...(additions.searchQueries || []),
      ...(Array.isArray(plan.searchQueries) ? plan.searchQueries : [])
    ], additions.queryLimit || 48),
    targetGenres: uniqueTerms([
      ...(additions.targetGenres || []),
      ...(Array.isArray(plan.targetGenres) ? plan.targetGenres : [])
    ], 20),
    vibeTerms: uniqueTerms([
      ...(additions.vibeTerms || []),
      ...(Array.isArray(plan.vibeTerms) ? plan.vibeTerms : [])
    ], 20),
    candidateArtists: uniqueTerms([
      ...(additions.candidateArtists || []),
      ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
    ], 28),
    candidateLabels: uniqueTerms([
      ...(additions.candidateLabels || []),
      ...(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [])
    ], 28)
  };
}

function broadenCoreQueries(options = {}, profile = buildDiscoveryProfile(options)) {
  const targets = (profile.isOmnivoreDiscovery
    ? omnivoreTargetTerms(options, 8)
    : (profile.targetGenres?.length ? profile.targetGenres : [profile.primaryTarget])).filter(Boolean).slice(0, 8);
  const vibes = (profile.vibeTerms || []).slice(0, 5);
  const years = yearTermsForBroadenPass(options);
  const queries = [];

  for (const target of targets) {
    queries.push(cleanText(target));
    queries.push(cleanText(`${target} new releases`));
    queries.push(cleanText(`${target} underground`));
    queries.push(cleanText(`${target} club tracks`));
    for (const year of years) {
      queries.push(cleanText(`${target} ${year}`));
      queries.push(cleanText(`${target} new releases ${year}`));
      for (const vibe of vibes) {
        queries.push(cleanText(`${vibe} ${target} ${year}`));
        queries.push(cleanText(`${target} ${vibe} ${year}`));
      }
    }
  }

  return uniqueTerms(queries, 48);
}

function broadenBranchOutQueries(options = {}, profile = buildDiscoveryProfile(options)) {
  if (profile.scoringMode === "pure" || profile.scoringMode === "similar") return [];
  if (hasExplicitArtistFocus(options, profile) && !requestRequiresFreshArtists(options)) return [];

  const targets = profile.isOmnivoreDiscovery
    ? omnivoreTargetTerms(options, 10)
    : uniqueTerms([
      ...(profile.targetGenres || []),
      ...(profile.primaryTarget ? [profile.primaryTarget] : [])
    ], 8);
  const vibes = (profile.vibeTerms || []).slice(0, 4);
  const years = yearTermsForBroadenPass(options);
  const artists = uniqueTerms([
    ...branchArtistSeeds(options, profile, 28),
    ...(profile.isOmnivoreDiscovery ? activeOmnivoreDiscoveryLanes(options).flatMap((lane) => lane.anchors.slice(0, 2)) : []),
    ...(profile.isProgressiveTarget ? PROGRESSIVE_FRESH_ANCHORS.slice(0, 20) : []),
    ...(profile.isProgressiveTarget ? PROGRESSIVE_ARTISTS.slice(0, 18) : []),
    ...genreArtistAnchors(profile).slice(0, 24)
  ], 44);
  const labels = filterGenreCompatibleLabels(uniqueTerms([
    ...branchLabelSeeds(options, profile, 28),
    ...(profile.isOmnivoreDiscovery ? activeOmnivoreDiscoveryLanes(options).flatMap((lane) => lane.anchors.slice(0, 3)) : []),
    ...(profile.isProgressiveTarget ? progressiveSceneLabelsFor(profile).slice(0, 24) : []),
    ...genreDiscoverySeeds(profile).slice(0, 24)
  ], 44), profile, profile.requestedLabels || []);
  const queries = [];

  for (const year of years) {
    for (const artist of artists.slice(0, 24)) {
      queries.push(cleanText(`${artist} ${year}`));
      for (const target of targets.slice(0, 3)) queries.push(cleanText(`${artist} ${target} ${year}`));
      for (const vibe of vibes.slice(0, 2)) queries.push(cleanText(`${artist} ${vibe} ${year}`));
    }
    for (const label of labels.slice(0, 24)) {
      queries.push(cleanText(`${label} ${year}`));
      for (const target of targets.slice(0, 3)) queries.push(cleanText(`${label} ${target} ${year}`));
      for (const vibe of vibes.slice(0, 2)) queries.push(cleanText(`${label} ${vibe} ${year}`));
    }
  }

  return uniqueTerms(queries, 96);
}

function broadenAdjacentQueries(options = {}, profile = buildDiscoveryProfile(options)) {
  const targets = (profile.targetGenres || []).slice(0, 3);
  const adjacent = adjacentLaneTerms(profile, options).slice(0, 10);
  const vibes = (profile.vibeTerms || []).slice(0, 4);
  const years = yearTermsForBroadenPass(options);
  const queries = [];

  for (const term of adjacent) {
    queries.push(cleanText(term));
    for (const year of years) {
      queries.push(cleanText(`${term} ${year}`));
      for (const target of targets) queries.push(cleanText(`${target} ${term} ${year}`));
      for (const vibe of vibes) queries.push(cleanText(`${vibe} ${term} ${year}`));
    }
  }

  return uniqueTerms(queries, 64);
}

function queryYieldHealthFor(result = {}, requestedCount = 8) {
  const requested = Math.min(40, Math.max(1, Number(requestedCount || 8)));
  const queryYield = result.verification?.queryYield || {};
  const attempted = Number(queryYield.attempted || 0);
  const returned = Number(queryYield.returned || 0);
  const accepted = Number(queryYield.accepted || 0);
  const rejected = Number(queryYield.rejected || 0);
  const seoRejects = Number(queryYield.seoRejects || 0);
  const genreRejects = Number(queryYield.genreRejects || 0);
  const errorCount = Number(queryYield.errorCount || 0);
  const sludge = seoRejects + genreRejects;
  const pool = candidatePoolSize(result);
  const discoveryError = cleanText(result.verification?.discoveryError || result.verification?.tidalError || "");
  const acceptedTarget = Math.max(2, Math.min(requested, Math.ceil(requested * 0.5)));
  const reasons = [];

  if (discoveryError && /\b(?:timed? out|took too long|failed to fetch|network|fetch failed)\b/i.test(discoveryError)) {
    reasons.push(discoveryError);
  }
  if (attempted >= 4 && accepted < acceptedTarget) {
    reasons.push(`${accepted}/${acceptedTarget} accepted`);
  }
  if (attempted >= 3 && sludge >= Math.max(6, attempted * 2)) {
    reasons.push(`${sludge} SEO/genre rejects`);
  }
  if (attempted >= 3 && errorCount >= Math.max(2, Math.ceil(attempted * 0.4))) {
    reasons.push(`${errorCount}/${attempted} query errors`);
  }
  if (attempted >= 5 && returned === 0) {
    reasons.push("no returned tracks");
  }
  if (attempted >= 5 && pool === 0) {
    reasons.push("empty candidate pool");
  }

  const unhealthy = reasons.length > 0;
  const retryNeeded = unhealthy && pool < Math.max(requested * 3, requested + 12);
  return {
    attempted,
    returned,
    accepted,
    rejected,
    seoRejects,
    genreRejects,
    errorCount,
    sludge,
    pool,
    requested,
    acceptedTarget,
    unhealthy,
    retryNeeded,
    reasons,
    summary: reasons.join(", ")
  };
}

function yieldRecoveryQueries(options = {}, profile = buildDiscoveryProfile(options)) {
  const targets = (profile.isOmnivoreDiscovery ? omnivoreTargetTerms(options, 8) : (profile.targetGenres?.length ? profile.targetGenres : [profile.primaryTarget]))
    .filter(Boolean)
    .slice(0, 8);
  if (!targets.length) return [];

  const years = yearTermsForBroadenPass(options);
  const useArtistAnchors = !requestRequiresFreshArtists(options);
  const labels = uniqueTerms([
    ...(profile.requestedLabels || []),
    ...(profile.isProgressiveTarget ? progressiveSceneLabelsFor(profile).slice(0, 24) : genreDiscoverySeeds(profile).slice(0, 24))
  ], 32);
  const anchors = uniqueTerms([
    ...(useArtistAnchors ? (profile.seedArtists || []) : []),
    ...(useArtistAnchors && profile.isProgressiveTarget ? PROGRESSIVE_FRESH_ANCHORS : []),
    ...(useArtistAnchors ? (profile.isProgressiveTarget ? PROGRESSIVE_ARTISTS.slice(0, 24) : genreArtistAnchors(profile).slice(0, 24)) : [])
  ], 42);
  const vibes = (profile.vibeTerms || []).slice(0, 4);
  const queries = [];

  for (const year of years) {
    for (const anchor of anchors.slice(0, 28)) {
      queries.push(cleanText(`${anchor} ${year}`));
      for (const target of targets.slice(0, 3)) {
        queries.push(cleanText(`${anchor} ${target} ${year}`));
      }
      for (const vibe of vibes.slice(0, 2)) {
        queries.push(cleanText(`${anchor} ${vibe} ${year}`));
      }
    }
    for (const label of labels.slice(0, 22)) {
      queries.push(cleanText(`${label} ${year}`));
      for (const target of targets.slice(0, 3)) {
        queries.push(cleanText(`${label} ${target} ${year}`));
      }
    }
    for (const target of targets.slice(0, 4)) {
      for (const vibe of vibes.slice(0, 3)) {
        queries.push(cleanText(`${target} ${vibe} ${year}`));
      }
    }
  }

  return uniqueTerms(queries, 90);
}

function autoBroadenSearchPasses(options = {}, profile = buildDiscoveryProfile(options), result = {}, requestedCount = parseRequestedCount(options)) {
  const requested = Math.min(40, Math.max(1, Number(requestedCount || parseRequestedCount(options))));
  const currentPool = candidatePoolSize(result);
  const strictRoonMode = /^(1|true|yes)$/i.test(String(options.requireRoonQueueable || ""));
  const strictFilteredRequest = Boolean(parseYearRange(options) || minimumScoreFor(options) || strictRoonMode);
  const yieldHealth = queryYieldHealthFor(result, requested);
  const targetPool = Math.min(
    strictFilteredRequest ? 220 : 110,
    Math.max(requested * (strictFilteredRequest ? 4 : 3), requested + (strictFilteredRequest ? 42 : 24))
  );

  if (currentPool >= targetPool && !yieldHealth.retryNeeded) return [];
  if (!cleanText(options.request) && !cleanText(options.genres) && !cleanText(options.mood) && !profile.primaryTarget) return [];

  const passes = [];
  const baseCount = Math.min(40, Math.max(requested, Math.ceil(requested * 1.2)));
  const targetGenres = profile.targetGenres || [];
  const vibeTerms = profile.vibeTerms || [];
  const yieldQueries = yieldHealth.retryNeeded ? yieldRecoveryQueries(options, profile) : [];
  const coreQueries = broadenCoreQueries(options, profile);
  const branchOutQueries = broadenBranchOutQueries(options, profile);

  if (yieldQueries.length) {
    passes.push({
      lane: "yield-retry",
      label: "Yield-aware retry",
      stage: "1. Same-intent yield recovery",
      reason: `Query yield was weak (${yieldHealth.summary}); retrying with label/artist anchored same-intent queries.`,
      targetPool,
      queryYieldHealth: yieldHealth,
      options: {
        ...options,
        autoBroaden: true,
        autoBroadenLane: "yield-retry",
        autoBroadenLabel: "Yield-aware retry",
        adaptiveRetryStage: "same-intent-yield-recovery",
        effectiveCount: baseCount,
        llmSearchPlan: mergePlanForBroaden(options, {
          searchQueries: yieldQueries,
          targetGenres,
          vibeTerms,
          candidateLabels: profile.requestedLabels || [],
          candidateArtists: profile.seedArtists || [],
          queryLimit: 72
        })
      }
    });
  }

  if (coreQueries.length) {
    passes.push({
      lane: "core-expanded",
      label: "Broadened same-lane search",
      stage: yieldQueries.length ? "2. Same-lane expansion" : "1. Same-lane expansion",
      reason: yieldHealth.retryNeeded
        ? `Query yield was weak (${yieldHealth.summary}); expanding within requested intent.`
        : `Initial candidate pool ${currentPool}/${targetPool}; expanding within requested intent.`,
      targetPool,
      queryYieldHealth: yieldHealth.retryNeeded ? yieldHealth : null,
      options: {
        ...options,
        autoBroaden: true,
        autoBroadenLane: "core-expanded",
        autoBroadenLabel: "Broadened same-lane search",
        adaptiveRetryStage: "same-lane-expansion",
        effectiveCount: baseCount,
        llmSearchPlan: mergePlanForBroaden(options, {
          searchQueries: coreQueries,
          targetGenres,
          vibeTerms
        })
      }
    });
  }

  if (branchOutQueries.length) {
    passes.push({
      lane: "branch-out",
      label: "Branch-out search",
      stage: `${passes.length + 1}. Scene branch-out`,
      reason: `Initial candidate pool ${currentPool}/${targetPool}; checking adjacent artists and labels while keeping the requested intent.`,
      targetPool,
      options: {
        ...options,
        autoBroaden: true,
        autoBroadenLane: "branch-out",
        autoBroadenLabel: "Branch-out search",
        adaptiveRetryStage: "scene-branch-out",
        effectiveCount: baseCount,
        llmSearchPlan: mergePlanForBroaden(options, {
          searchQueries: branchOutQueries,
          targetGenres,
          vibeTerms,
          candidateArtists: branchArtistSeeds(options, profile, 18),
          candidateLabels: branchLabelSeeds(options, profile, 18),
          queryLimit: 84
        })
      }
    });
  }

  const adjacentQueries = broadenAdjacentQueries(options, profile);
  if (profile.isGenreDiscoveryTarget && adjacentQueries.length) {
    passes.push({
      lane: "adjacent",
      label: "Broadened adjacent-lane search",
      stage: `${passes.length + 1}. Adjacent-lane check`,
      reason: `Initial candidate pool ${currentPool}/${targetPool}; checking adjacent terms without changing requested genre.`,
      targetPool,
      options: {
        ...options,
        autoBroaden: true,
        autoBroadenLane: "adjacent",
        autoBroadenLabel: "Broadened adjacent-lane search",
        adaptiveRetryStage: "adjacent-lane-check",
        effectiveCount: baseCount,
        llmSearchPlan: mergePlanForBroaden(options, {
          searchQueries: adjacentQueries,
          targetGenres,
          vibeTerms
        })
      }
    });
  }

  if (vibeTerms.length && targetGenres.length) {
    const relaxedQueries = uniqueTerms(
      targetGenres.slice(0, 6).flatMap((target) => yearTermsForBroadenPass(options).flatMap((year) => [
        cleanText(`${target} ${year}`),
        cleanText(`${target} releases ${year}`)
      ])),
      32
    );
    if (relaxedQueries.length) {
      passes.push({
        lane: "relaxed-vibe",
        label: "Broadened genre-first search",
        stage: `${passes.length + 1}. Relax vibe only`,
        reason: `Initial candidate pool ${currentPool}/${targetPool}; relaxing vibe terms while keeping requested genre.`,
        targetPool,
        options: {
          ...options,
          autoBroaden: true,
          autoBroadenLane: "relaxed-vibe",
          autoBroadenLabel: "Broadened genre-first search",
          adaptiveRetryStage: "relax-vibe-only",
          effectiveCount: baseCount,
          mood: "",
          llmSearchPlan: mergePlanForBroaden(options, {
            searchQueries: relaxedQueries,
            targetGenres,
            vibeTerms: []
          })
        }
      });
    }
  }

  return passes.slice(0, 4);
}

function shouldContinueAutoBroadenAfterError(error = null, context = {}) {
  const message = typeof error === "string" ? error : String(error?.message || "");
  const timedOut = /\b(?:timed out|took too long)\b/i.test(message);
  if (!timedOut) return true;
  if (context.initialTimedOut) return false;
  if (Number(context.remainingPasses || 0) <= 0) return false;
  return Number(context.currentPool || 0) < Number(context.requestedCount || 0);
}

function buildSceneAnchorRecentQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), history = null, freshArtistAvoidance = null) {
  if (!profile.isGenreDiscoveryTarget) return [];

  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const hardGenreConstraint = hardGenreConstraintFor(profile);
  const planArtists = filterFreshArtistSeeds(filterGenreCompatibleSeeds(uniqueTerms([
    ...(hardGenreConstraint ? [] : (Array.isArray(plan.seedArtists) ? plan.seedArtists : [])),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ], 18), profile, profile.requestedArtists || []), options, history, tasteProfile, profile, freshArtistAvoidance);
  const planLabels = filterGenreCompatibleLabels(
    uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 18),
    profile,
    profile.requestedLabels || []
  );
  const anchors = uniqueTerms([
    ...filterFreshArtistSeeds(genreArtistAnchors(profile), options, history, tasteProfile, profile, freshArtistAvoidance),
    ...genreDiscoverySeeds(profile),
    ...filterFreshArtistSeeds(branchArtistSeeds(options, profile, 20), options, history, tasteProfile, profile, freshArtistAvoidance),
    ...branchLabelSeeds(options, profile, 16),
    ...planLabels,
    ...planArtists,
    ...buildArtistSeeds(options, 22, tasteProfile, profile, history, freshArtistAvoidance)
  ], 56);
  const targetTerms = uniqueTerms([
    ...(profile.targetGenres || []),
    ...adjacentLaneTerms(profile, options).slice(0, 5)
  ], 12);
  const vibeTerms = uniqueTerms([...(profile.vibeTerms || [])], 8);
  const queries = [];

  const recentYears = yearTerms.slice(-3).reverse();
  const anchorSet = anchors.slice(0, 46);
  const targetSet = targetTerms.slice(0, 4);
  const vibeSet = vibeTerms.slice(0, 2);

  for (const anchor of anchorSet) {
    for (const year of recentYears) {
      queries.push(cleanText(`${anchor} ${year}`));
    }
  }
  for (const target of targetSet) {
    for (const anchor of anchorSet) {
      for (const year of recentYears) {
        queries.push(cleanText(`${anchor} ${target} ${year}`));
      }
    }
  }
  for (const vibe of vibeSet) {
    for (const anchor of anchorSet) {
      for (const year of recentYears) {
        queries.push(cleanText(`${anchor} ${vibe} ${year}`));
      }
    }
  }

  return filterHardGenreQueries(queries, options, profile, yearRange ? 140 : 56);
}

function buildArtistSeeds(options = {}, limit = 12, tasteProfile = null, profile = buildDiscoveryProfile(options), history = null, freshArtistAvoidance = null) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const hardGenreConstraint = hardGenreConstraintFor(profile);
  const pureRequestedArtistSearch = profile.scoringMode === "pure" && (profile.requestedArtists || []).length;
  const yearRange = parseYearRange(options);
  const discoveryBranching = Boolean(
    profile.scoringMode === "taste-guided" &&
    profile.hasExplicitDiscoveryIntent &&
    profile.isProgressiveTarget &&
    yearRange &&
    parseRequestedCount(options) > 2 &&
    !(profile.requestedArtists || []).length &&
    !(profile.seedArtists || extractSeedArtists(options)).length
  );
  const planArtists = pureRequestedArtistSearch ? [] : filterGenreCompatibleSeeds(uniqueTerms([
    ...(hardGenreConstraint ? [] : (Array.isArray(plan.seedArtists) ? plan.seedArtists : [])),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ], limit), profile, profile.requestedArtists || []);
  const seedArtists = profile.seedArtists || extractSeedArtists(options);
  const branchArtists = pureRequestedArtistSearch ? [] : branchArtistSeeds(options, profile, Math.max(4, Math.ceil(limit * 0.45)));
  const seedKeys = new Set(seedArtists.map(artistIdentityKey));
  const useLearnedArtists = profile.tasteProfileLed || profile.scoringMode === "similar" ||
    (profile.scoringMode === "taste-guided" && (
      !profile.hasExplicitDiscoveryIntent ||
      // Broad EDM is an explicit domain request, but it is intentionally
      // open across electronic lanes. Use a small number of learned artists
      // as personalized seed evidence without turning the profile into a
      // whitelist or allowing it to outrank trusted scene anchors.
      profile.isBroadElectronicDiscovery
    ));
  const learnedLimit = profile.tasteProfileLed
    ? 36
    : (profile.scoringMode === "similar"
      ? 12
      : (profile.isBroadElectronicDiscovery ? 6 : 3));
  const excludedTasteSeeds = new Set(tasteSeedExclusionNames(options).map(artistIdentityKey));
  const learnedArtists = useLearnedArtists
    ? uniqueTerms([
      ...(Array.isArray(profile.learnedTasteArtists) ? profile.learnedTasteArtists : []),
      ...(Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : []),
      ...(typeof tasteProfile?.getTopArtists === "function" ? tasteProfile.getTopArtists(learnedLimit) : [])
    ].filter((artist) => !excludedTasteSeeds.has(artistIdentityKey(artist))), learnedLimit)
    : [];
  const baseFreshYearAnchors = profile.isProgressiveTarget && yearRange
    ? PROGRESSIVE_FRESH_ANCHORS
    : [];
  const freshYearAnchors = discoveryBranching
    ? shuffled(baseFreshYearAnchors).slice(0, Math.max(3, Math.ceil(limit * 0.35)))
    : baseFreshYearAnchors;
  const sceneArtists = pureRequestedArtistSearch
    ? []
    : (profile.isProgressiveTarget && wantsProgressiveHouseOnly(options)
    ? PROGRESSIVE_ARTISTS.filter((artist) => !isTranceForwardArtist(artist))
    : (profile.isProgressiveTarget ? PROGRESSIVE_ARTISTS : genreArtistAnchors(profile)));
  const priorityKeys = new Set([...seedArtists, ...freshYearAnchors].map(artistIdentityKey));
  const rotatedSceneArtists = shuffled(uniqueValues(sceneArtists).filter((artist) => !seedKeys.has(artistIdentityKey(artist)) && !priorityKeys.has(artistIdentityKey(artist))));
  const orderedArtists = profile.tasteProfileLed
    ? [...learnedArtists, ...seedArtists, ...branchArtists, ...planArtists, ...freshYearAnchors, ...rotatedSceneArtists]
    : [...planArtists, ...seedArtists, ...branchArtists, ...learnedArtists, ...freshYearAnchors, ...rotatedSceneArtists];
  return filterFreshArtistSeeds(
    uniqueValues(orderedArtists),
    options,
    history,
    tasteProfile,
    profile,
    freshArtistAvoidance
  ).slice(0, limit);
}

function requestText(options = {}) {
  return `${options.request || ""} ${options.reference || ""} ${options.genres || ""} ${options.mood || ""}`;
}

function explicitlyForbidsPreviouslySuggested(options = {}) {
  return /\b(?:avoid|exclude|skip|without|no|not|do not|don't|stop)\b.{0,35}\b(?:previous|previously|repeat|repeats|repeated|same|old|seen|suggested|suggestions)\b/i.test(requestText(options));
}

function allowsPreviouslySuggested(options = {}) {
  if (explicitlyForbidsPreviouslySuggested(options)) return false;
  return /\b(?:allow repeats|include repeats|show repeats|reuse previous suggestions|include previous suggestions|include previously suggested|show previous suggestions|same tracks again|same songs again|rerun previous)\b/i.test(requestText(options));
}

function allowsPreviousDiscoveryFallback(options = {}) {
  return /\b(?:use previous discovery fallback|allow previous fallback|backfill from history|fill from history|reuse previous suggestions|include previous suggestions|include previously suggested)\b/i.test(requestText(options));
}

function requestRequiresFreshArtists(options = {}) {
  if (allowsPreviouslySuggested(options)) return false;
  const text = requestText(options);
  return Boolean(
    /\b(?:artists?|acts?|producers?)\b.{0,48}\b(?:not|never|haven'?t|have\s+not|has\s+not|not\s+yet|new|fresh|unseen|unrecommended)\b.{0,48}\b(?:recommended|suggested|shown|surfaced|seen|used)\b/i.test(text) ||
    /\b(?:not|never|haven'?t|have\s+not|has\s+not|not\s+yet)\b.{0,48}\b(?:recommended|suggested|shown|surfaced|seen|used)\b.{0,48}\b(?:artists?|acts?|producers?)\b/i.test(text) ||
    /\b(?:new|fresh|unseen|unrecommended)\s+(?:artists?|acts?|producers?)\b/i.test(text)
  );
}

function requestRequiresStrictFreshArtists(options = {}) {
  if (!requestRequiresFreshArtists(options)) return false;
  const text = requestText(options);
  return Boolean(
    /\b(?:strict|strictly|only|must|hard|zero|absolutely|exactly)\b.{0,48}\b(?:new|fresh|unseen|unrecommended|not\s+recommended|not\s+suggested|artists?|acts?|producers?)\b/i.test(text) ||
    /\b(?:new|fresh|unseen|unrecommended|not\s+recommended|not\s+suggested|artists?|acts?|producers?)\b.{0,48}\b(?:strict|strictly|only|must|hard|zero|absolutely|exactly)\b/i.test(text)
  );
}

function likedArtistsForFreshAvoidance(tasteProfile = null) {
  if (!tasteProfile) return [];
  if (typeof tasteProfile.read === "function") {
    const artists = tasteProfile.read()?.artists || {};
    return Object.values(artists)
      .filter((entry) => Number(entry.score || 0) > 0 && cleanText(entry.name))
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || Number(right.up || 0) - Number(left.up || 0))
      .map((entry) => cleanText(entry.name));
  }
  if (typeof tasteProfile.getTopArtists === "function") return tasteProfile.getTopArtists(120);
  return [];
}

function buildFreshArtistAvoidance(options = {}, history = null, tasteProfile = null) {
  const enabled = requestRequiresFreshArtists(options);
  const likedArtists = enabled
    ? uniqueTerms(likedArtistsForFreshAvoidance(tasteProfile), 160)
      .map((artist) => ({ artist, key: artistIdentityKey(artist) }))
      .filter((entry) => entry.key)
    : [];
  const exposedArtists = enabled && history && typeof history.artistStats === "function"
    ? Array.from(history.artistStats().values())
      .map((entry) => ({
        artist: cleanText(entry.artist),
        key: artistIdentityKey(entry.artist),
        trackCount: Number(entry.trackCount || 0),
        shownCount: Number(entry.shownCount || 0)
      }))
      .filter((entry) => entry.key && (entry.trackCount || entry.shownCount))
    : [];
  return {
    enabled,
    history,
    likedArtists,
    exposedArtists
  };
}

function freshAvoidanceContext(options = {}, history = null, tasteProfile = null, context = null) {
  return context && typeof context === "object"
    ? context
    : buildFreshArtistAvoidance(options, history, tasteProfile);
}

function textMatchesFreshArtist(value = "", artist = "") {
  if (!cleanText(value) || !cleanText(artist)) return false;
  if (artistMatchesKnownName(value, artist, { contains: true })) return true;
  return splitArtists(value).some((part) => artistNamesMatch(part, artist, { contains: true }));
}

function likedFreshArtistMatch(value = "", context = {}) {
  if (!context?.enabled || !context.likedArtists?.length) return null;
  return context.likedArtists.find((entry) => textMatchesFreshArtist(value, entry.artist)) || null;
}

function exposedFreshArtistMatch(value = "", context = {}) {
  if (!context?.enabled || !context.exposedArtists?.length) return null;
  return context.exposedArtists.find((entry) => textMatchesFreshArtist(value, entry.artist)) || null;
}

function freshArtistSeedAvoidanceReason(artist = "", options = {}, history = null, tasteProfile = null, profile = {}, context = null) {
  const avoidance = freshAvoidanceContext(options, history, tasteProfile, context);
  if (!avoidance.enabled || !cleanText(artist)) return "";
  if ((profile.requestedArtists || []).length && artistMatchesRequested(artist, profile.requestedArtists)) return "";

  const likedMatch = likedFreshArtistMatch(artist, avoidance);
  if (likedMatch) return `${likedMatch.artist} is already in your liked artist profile; fresh-artist search skipped it as a seed.`;

  const exposedMatch = exposedFreshArtistMatch(artist, avoidance);
  if (exposedMatch) {
    const count = exposedMatch.trackCount || exposedMatch.shownCount;
    return `${exposedMatch.artist} was already recommended${count ? ` (${count} prior track${count === 1 ? "" : "s"})` : ""}; fresh-artist search skipped it as a seed.`;
  }

  const sourceHistory = history || avoidance.history;
  if (sourceHistory && typeof sourceHistory.artistExposureFor === "function") {
    const exposure = sourceHistory.artistExposureFor({ artist });
    const trackCount = Number(exposure?.trackCount || 0);
    const shownCount = Number(exposure?.shownCount || 0);
    if (trackCount || shownCount) {
      const name = cleanText(exposure.artist || artist);
      const count = trackCount || shownCount;
      return `${name} was already recommended${count ? ` (${count} prior track${count === 1 ? "" : "s"})` : ""}; fresh-artist search skipped it as a seed.`;
    }
  }
  return "";
}

function filterFreshArtistSeeds(seeds = [], options = {}, history = null, tasteProfile = null, profile = {}, context = null) {
  // Taste-profile mode still needs familiar artists as retrieval anchors.
  // “Avoid repeats” applies to returned tracks/artists, not to the artist
  // pages we must crawl to discover adjacent music.
  if (profile.tasteProfileLed || profile.promptIntent?.outsideTasteMode === "taste-profile") return seeds;
  const avoidance = freshAvoidanceContext(options, history, tasteProfile, context);
  if (!avoidance.enabled) return seeds;
  return seeds.filter((artist) => !freshArtistSeedAvoidanceReason(artist, options, history, tasteProfile, profile, avoidance));
}

function filterFreshArtistQueries(queries = [], options = {}, history = null, tasteProfile = null, profile = {}, context = null) {
  // In taste-profile mode the learned artist is a retrieval anchor, not a
  // recommendation repeat. Keep the query so its adjacent catalog can be
  // crawled; freshness is enforced on the returned track candidates.
  if (profile.tasteProfileLed || profile.promptIntent?.outsideTasteMode === "taste-profile") return queries;
  const avoidance = freshAvoidanceContext(options, history, tasteProfile, context);
  if (!avoidance.enabled) return queries;
  return queries.filter((query) => {
    if ((profile.requestedArtists || []).length && artistMatchesRequested(query, profile.requestedArtists)) return true;
    return !likedFreshArtistMatch(query, avoidance) && !exposedFreshArtistMatch(query, avoidance);
  });
}

function previouslyRecommendedArtistReason(track = {}, history = null, profile = {}, options = {}, tasteProfile = null, context = null) {
  if (!requestRequiresFreshArtists(options)) return "";
  if ((profile.requestedArtists || []).length && artistMatchesRequested(track.artist, profile.requestedArtists)) return "";

  const avoidance = freshAvoidanceContext(options, history, tasteProfile, context);
  const likedMatch = likedFreshArtistMatch(track.artist, avoidance);
  if (likedMatch) {
    return `${likedMatch.artist} is already in your liked artist profile; request asked for artists not recommended before.`;
  }

  if (!history || typeof history.artistExposureFor !== "function") return "";
  const exposure = history.artistExposureFor(track);
  if (!exposure) return "";

  const trackCount = Number(exposure.trackCount || 0);
  const shownCount = Number(exposure.shownCount || 0);
  const strict = requestRequiresStrictFreshArtists(options);
  if (!strict && trackCount < 3 && shownCount < 5) return "";

  const count = trackCount || shownCount;
  const artist = cleanText(exposure.artist || splitArtists(track.artist)[0] || "Artist");
  return `${artist} was already recommended${count ? ` (${count} prior track${count === 1 ? "" : "s"})` : ""}; request asked for artists not recommended before.`;
}

function artistDiversityAdjustmentFor(track = {}, history = null, profile = {}, options = {}) {
  if (!history || typeof history.artistExposureFor !== "function") return { value: 0, reasons: [] };
  if (profile.scoringMode === "similar") return { value: 0, reasons: [] };
  if ((profile.requestedArtists || []).length && artistMatchesRequested(track.artist, profile.requestedArtists)) {
    return { value: 0, reasons: [] };
  }

  const exposure = history.artistExposureFor(track);
  if (!exposure) return { value: 0, reasons: [] };

  const trackCount = Number(exposure.trackCount || 0);
  const shownCount = Number(exposure.shownCount || 0);
  if (trackCount < 2 && shownCount < 3) return { value: 0, reasons: [] };

  const explore = profile.scoringMode === "explore";
  const pure = profile.scoringMode === "pure";
  const seedMatch = hasSeedArtistMatch(track, options, profile);
  let penalty = 0;

  if (trackCount >= 8 || shownCount >= 12) penalty = explore ? -11 : -8;
  else if (trackCount >= 5 || shownCount >= 8) penalty = explore ? -8 : -6;
  else if (trackCount >= 3 || shownCount >= 5) penalty = explore ? -5 : -4;
  else penalty = explore ? -3 : -2;

  if (exposure.recent) penalty -= explore ? 2 : 1;
  if (pure) penalty = Math.max(penalty, -4);
  if (seedMatch && !explore) penalty = Math.max(penalty, -4);

  const reasons = [
    `${exposure.artist || splitArtists(track.artist)[0] || "artist"} surfaced ${trackCount} prior track${trackCount === 1 ? "" : "s"}`
  ];
  if (shownCount > trackCount) reasons.push(`${shownCount} total prior appearances`);
  if (exposure.recent) reasons.push("seen recently");

  return {
    value: clamp(penalty, explore ? -12 : -8, 0),
    reasons
  };
}

function exposureDecayMultiplier(exposure = {}, now = Date.now(), maxAgeMs = 1000 * 60 * 60 * 24 * 30) {
  if (!exposure) return 0;
  const lastShownAt = Number(exposure.lastShownAt || 0);
  if (!lastShownAt) return exposure.recent ? 0.5 : 0;
  const ageMs = Math.max(0, now - lastShownAt);
  if (ageMs >= maxAgeMs) return 0;
  return Math.max(0, Math.min(1, 1 - (ageMs / maxAgeMs)));
}

function exposurePressure(exposure = {}, thresholds = {}) {
  if (!exposure) return 0;
  const trackCount = Number(exposure.trackCount || 0);
  const shownCount = Number(exposure.shownCount || 0);
  const heavyTracks = Number(thresholds.heavyTracks || 8);
  const mediumTracks = Number(thresholds.mediumTracks || 5);
  const lightTracks = Number(thresholds.lightTracks || 3);
  const heavyShows = Number(thresholds.heavyShows || 12);
  const mediumShows = Number(thresholds.mediumShows || 8);
  const lightShows = Number(thresholds.lightShows || 5);

  if (trackCount >= heavyTracks || shownCount >= heavyShows) return 4;
  if (trackCount >= mediumTracks || shownCount >= mediumShows) return 3;
  if (trackCount >= lightTracks || shownCount >= lightShows) return 2;
  if (trackCount >= 2 || shownCount >= 3) return 1;
  return 0;
}

function sourceNoveltyPenaltyAllowed(track = {}) {
  const text = normalize(`${track.discoverySource || ""} ${track.discoveryLane || ""}`);
  if (!text) return false;
  if (/^(?:tidal search|core|catalogue|catalog)$/.test(text)) return false;
  if (/\b(?:tidal search|catalogue result)\b/.test(text) && !/\b(?:branch|adjacent|omnivore|radio|liked|artist expansion|adaptive|standby|fallback|rescue)\b/.test(text)) {
    return false;
  }
  return /\b(?:liked artist|artist expansion|branch|adjacent|omnivore|taste bridge|radio|remixer|adaptive|standby|recent|fallback|rescue|expanded)\b/.test(text);
}

function labelDiversityKeyForCandidate(candidate = {}, profile = {}) {
  if (requestedLabelMatch(candidate, profile)) return "";
  return normalize(labelText(candidate));
}

function sourceDiversityKeyForCandidate(candidate = {}) {
  const text = normalize(`${candidate.discoverySource || ""} ${candidate.discoveryLane || ""}`);
  if (text.includes("omnivore") || text.includes("taste bridge")) return "";
  if (!sourceNoveltyPenaltyAllowed(candidate)) return "";
  return normalize([candidate.discoverySource, candidate.discoveryLane].filter(Boolean).join(" | "));
}

function sourceDiversityLabelForCandidate(candidate = {}) {
  return cleanText([candidate.discoverySource, candidate.discoveryLane].filter(Boolean).join(" / "));
}

function noveltyPenaltyForExposure(exposure = {}, options = {}) {
  const pressure = exposurePressure(exposure, options.thresholds || {});
  if (!pressure) return 0;
  const decay = exposureDecayMultiplier(exposure, options.now, options.maxAgeMs);
  if (!decay) return 0;
  const recentBoost = exposure.recent ? Number(options.recentBoost || 1) : 0;
  return Math.max(0, Math.round((pressure + recentBoost) * decay * Number(options.weight || 1)));
}

function recentSuggestionNoveltyPenaltyFor(track = {}, history = null, profile = {}, options = {}, now = Date.now()) {
  if (!history) return { value: 0, reasons: [], components: {} };
  if (profile.scoringMode === "pure") return { value: 0, reasons: [], components: {} };
  const repeatFriendly = allowsArtistRepeatFallback(options, profile) || allowsPreviouslySuggested(options);
  const scale = repeatFriendly ? 0.45 : 1;
  const components = {};
  const reasons = [];

  function addComponent(kind, exposure, rawPenalty, label) {
    const value = Math.round(Number(rawPenalty || 0) * scale);
    if (!value) return;
    components[kind] = value;
    const name = cleanText(label || exposure?.artist || exposure?.label || exposure?.source || kind);
    const count = Number(exposure?.trackCount || 0);
    const appearances = Number(exposure?.shownCount || 0);
    reasons.push(`${name} ${kind} surfaced ${count || appearances} prior ${count === 1 ? "track" : "tracks"}${exposure?.recent ? " recently" : ""}`);
  }

  if (typeof history.artistExposureFor === "function" &&
      profile.scoringMode !== "similar" &&
      !((profile.requestedArtists || []).length && artistMatchesRequested(track.artist, profile.requestedArtists))) {
    const exposure = history.artistExposureFor(track, now);
    addComponent("artist", exposure, noveltyPenaltyForExposure(exposure, {
      now,
      maxAgeMs: 1000 * 60 * 60 * 24 * 30,
      weight: profile.scoringMode === "explore" ? 1 : 0.75,
      recentBoost: 1
    }), exposure?.artist);
  }

  if (typeof history.labelExposureFor === "function" && !requestedLabelMatch(track, profile)) {
    const exposure = history.labelExposureFor(track, now);
    addComponent("label", exposure, noveltyPenaltyForExposure(exposure, {
      now,
      maxAgeMs: 1000 * 60 * 60 * 24 * 45,
      weight: profile.scoringMode === "explore" ? 1.15 : 0.9,
      recentBoost: 1,
      thresholds: {
        lightTracks: 2,
        mediumTracks: 4,
        heavyTracks: 7,
        lightShows: 3,
        mediumShows: 6,
        heavyShows: 10
      }
    }), exposure?.label);
  }

  if (typeof history.sourceExposureFor === "function" && sourceNoveltyPenaltyAllowed(track)) {
    const exposure = history.sourceExposureFor(track, now);
    addComponent("source", exposure, noveltyPenaltyForExposure(exposure, {
      now,
      maxAgeMs: 1000 * 60 * 60 * 24 * 21,
      weight: profile.scoringMode === "explore" ? 1 : 0.8,
      recentBoost: 1,
      thresholds: {
        lightTracks: 3,
        mediumTracks: 6,
        heavyTracks: 10,
        lightShows: 4,
        mediumShows: 8,
        heavyShows: 14
      }
    }), exposure?.source);
  }

  return {
    value: Math.max(0, Math.min(repeatFriendly ? 5 : 12, Object.values(components).reduce((sum, value) => sum + Number(value || 0), 0))),
    reasons: reasons.slice(0, 4),
    components
  };
}

function hasAnyTerm(text, terms = []) {
  return terms.some((term) => containsNormalized(text, term));
}

function isBroadGenreTerm(term = "") {
  return /^(?:electronic|electronica|dance|edm|club|house|techno|trance|bass|pop|rock|metal|jazz|soul|funk|country|alternative|other|unknown)$/i.test(normalize(term));
}

function trackGenreValues(track = {}) {
  function flatten(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (typeof value === "object") {
      return [
        value.name,
        value.title,
        value.value,
        value.text,
        value.genre,
        value.id
      ].flatMap(flatten);
    }
    return [cleanText(value)];
  }

  return uniqueTerms([
    ...flatten(track.genre),
    ...flatten(track.genres),
    ...flatten(track.tidal?.genre),
    ...flatten(track.tidal?.genres),
    ...flatten(track.tidal?.artistGenre),
    ...flatten(track.tidal?.artistGenres)
  ], 12);
}

function genreTokenSet(value = "") {
  return new Set(normalize(value).split(/\s+/).filter((token) => token && token !== "and"));
}

function genreValuesMatchTarget(values = [], targets = []) {
  const cleanValues = uniqueTerms(values || [], 24);
  if (!cleanValues.length) return false;
  if (cleanValues.some((value) => genreTermMatchesTarget(value, targets))) return true;

  const valueTokens = new Set(cleanValues.flatMap((value) => [...genreTokenSet(value)]));
  return targets.some((target) => {
    const targetTokens = [...genreTokenSet(target)];
    if (targetTokens.length < 3) return false;
    const hasBroadParent = targetTokens.some((token) => isBroadGenreTerm(token));
    const hasSpecificDescriptor = targetTokens.some((token) => !isBroadGenreTerm(token));
    return hasBroadParent && hasSpecificDescriptor && targetTokens.every((token) => valueTokens.has(token));
  });
}

function genreTermMatchesTarget(term = "", targets = []) {
  const key = normalizeGenreKey(term);
  if (!key) return false;
  return targets.some((target) => {
    const targetKey = normalizeGenreKey(target);
    if (!targetKey) return false;
    if (key === targetKey) return true;
    if (isBroadGenreTerm(key)) return targetKey === key;
    if (key.includes(targetKey) && !isBroadGenreTerm(targetKey)) return true;
    return false;
  });
}

function ontologyGenreTermsForText(text = "", limit = 16) {
  const detected = detectOntologyGenreTerms(text, { includeAliases: true, limit });
  return uniqueGenreTerms(detected.terms || [], limit);
}

function ontologyVibeTermsForText(text = "", limit = 16) {
  const detected = detectOntologyVibeTerms(text, { limit });
  return uniqueTerms(detected.terms || [], limit);
}

function isStrictChildGenreTarget(profile = {}) {
  return Boolean(profile.genreProfile?.strict);
}

function specificChildGenreEvidenceFor(track = {}, profile = buildDiscoveryProfile({})) {
  if (!isStrictChildGenreTarget(profile)) return { corroborates: true };
  const genreProfile = profile.genreProfile || {};
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)} ${trackGenreValues(track).join(" ")}`);
  const labelSeeds = uniqueTerms([...(genreProfile.labels || []), ...genreLabelSeeds(profile)], 48);
  const artistAnchors = uniqueTerms([...(genreProfile.artists || []), ...genreArtistAnchors(profile)], 48);
  const excludedLabel = (genreProfile.excludeLabels || []).find((seed) => entityEvidenceMatches(labelText(track), seed)) || "";
  const excludedArtist = (genreProfile.excludeArtists || []).find((seed) => artistMatchesKnownName(track.artist, seed)) || "";
  const remix = namedRemixEvidence(track);
  const originalArtistMismatchSoft = Boolean(excludedArtist && remix.named && !remix.versionConflict);
  const labelSeed = labelSeeds.find((seed) => entityEvidenceMatches(labelText(track), seed)) || "";
  const artistAnchor = artistAnchors.find((seed) => artistMatchesKnownName(track.artist, seed)) || "";
  const seedArtist = (profile.seedArtists || []).find((seed) => artistMatchesKnownName(track.artist, seed)) || "";
  const sceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(labelText(track), profile) : "";
  const sceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.artist, profile) : "";
  const sceneRemixer = isProgressiveSceneTarget(profile) ? matchingSceneRemixer(track, profile) : "";
  const querySceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(track.query, profile) : "";
  const querySceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.query, profile, { contains: true }) : "";
  const sceneCatalog = profile.isProgressiveTarget && hasAnyTerm(metadataText, PROGRESSIVE_CATALOG_TARGETS);
  const exactGenre = hasAnyTerm(metadataText, [genreProfile.name, ...(profile.targetGenres || [])]) ||
    genreValuesMatchTarget(trackGenreValues(track), [genreProfile.name, ...(profile.targetGenres || [])]);
  const childKeyword = (genreProfile.keywords || []).find((keyword) => containsNormalized(metadataText, keyword)) || "";
  const parentContext = hasAnyTerm(metadataText, genreProfile.parentGenres || []);
  const corroborates = Boolean(
    !excludedLabel &&
    (!excludedArtist || originalArtistMismatchSoft) &&
    (
      exactGenre ||
      labelSeed ||
      artistAnchor ||
      seedArtist ||
      sceneLabel ||
      sceneArtist ||
      sceneRemixer ||
      sceneCatalog ||
      (childKeyword && (parentContext || labelSeed || artistAnchor)) ||
      ((querySceneLabel || querySceneArtist) && parentContext)
    )
  );
  return {
    corroborates,
    exactGenre,
    childKeyword,
    parentContext,
    labelSeed,
    artistAnchor,
    seedArtist,
    sceneLabel,
    sceneArtist,
    sceneRemixer,
    querySceneLabel,
    querySceneArtist,
    sceneCatalog,
    excludedLabel,
    excludedArtist,
    originalArtistMismatchSoft
  };
}

function vibeTermMatchesTarget(term = "", targets = []) {
  const key = normalize(term);
  if (!key) return false;
  return targets.some((target) => {
    const targetKey = normalize(target);
    return targetKey && (key === targetKey || key.includes(targetKey) || targetKey.includes(key));
  });
}

function relatedVibeTermsFor(targets = []) {
  const related = [];
  const map = {
    hypnotic: ["Rolling", "Minimal", "Deep", "Journey", "Psychedelic"],
    psychedelic: ["Hypnotic", "Spacey", "Cosmic", "Experimental"],
    cosmic: ["Spacey", "Atmospheric", "Psychedelic", "Cinematic"],
    spacey: ["Cosmic", "Atmospheric", "Cinematic"],
    atmospheric: ["Spacey", "Cosmic", "Deep"],
    driving: ["Rolling", "Peak-Time", "Bass-Driven"],
    underground: ["Deep", "Minimal", "Late-Night"],
    deep: ["Hypnotic", "Underground", "Atmospheric"],
    tribal: ["Organic", "Hypnotic", "Rolling"]
  };

  for (const target of targets) {
    related.push(...(map[normalize(target)] || []));
  }
  const targetKeys = new Set(targets.map(normalize));
  return uniqueTerms(related.filter((term) => !targetKeys.has(normalize(term))), 12);
}

function topVibeEvidence(evidence = [], limit = 3) {
  return evidence
    .filter((item) => item.weight > 0 && !item.queryOnly)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit);
}

function vibeInferenceFor(track = {}, query = "", profile = {}) {
  const targets = profile.vibeTerms || [];
  if (!targets.length) {
    return { confidence: 0, evidence: [], summary: "", queryOnly: false, corroboratesRequested: true, matchedTerms: [] };
  }

  const relatedTargets = relatedVibeTermsFor(targets);
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const queryText = normalize(query || track.query);
  const officialText = trackGenreValues(track).join(" ");
  const metadataTerms = ontologyVibeTermsForText(metadataText, 18);
  const officialTerms = ontologyVibeTermsForText(officialText, 12);
  const queryTerms = ontologyVibeTermsForText(queryText, 18);
  const evidence = [];
  const matchedTerms = new Set();
  const nonQueryMatchedTerms = new Set();

  function add(source, term, weight, detail = {}) {
    const cleanTerm = cleanText(term);
    if (!cleanTerm || !weight) return;
    const direct = vibeTermMatchesTarget(cleanTerm, targets);
    if (direct) matchedTerms.add(cleanTerm);
    if (direct && !detail.queryOnly) nonQueryMatchedTerms.add(cleanTerm);
    evidence.push({
      source,
      label: detail.label || `${cleanTerm} ${source}`,
      term: cleanTerm,
      weight: Number(weight),
      direct,
      related: Boolean(detail.related),
      queryOnly: Boolean(detail.queryOnly),
      corroborating: detail.corroborating !== false
    });
  }

  for (const term of metadataTerms) {
    if (vibeTermMatchesTarget(term, targets)) add("metadata", term, 20);
    else if (vibeTermMatchesTarget(term, relatedTargets)) add("related metadata", term, 8, { related: true });
  }
  for (const term of officialTerms) {
    if (vibeTermMatchesTarget(term, targets)) add("official tag", term, 12);
    else if (vibeTermMatchesTarget(term, relatedTargets)) add("related official tag", term, 5, { related: true });
  }
  for (const term of queryTerms) {
    if (vibeTermMatchesTarget(term, targets)) add("search query", term, 4, { queryOnly: true, corroborating: false });
    else if (vibeTermMatchesTarget(term, relatedTargets)) add("related search query", term, 2, { related: true, queryOnly: true, corroborating: false });
  }

  const positive = evidence.filter((item) => item.weight > 0);
  const nonQueryPositive = positive.some((item) => !item.queryOnly);
  const nonQueryDirect = positive.some((item) => item.direct && !item.queryOnly);
  const directCoverage = targets.length ? nonQueryMatchedTerms.size / targets.length : 0;
  const rawTotal = positive.reduce((sum, item) => sum + item.weight, 0);
  const confidence = clamp(Math.round(Math.max(rawTotal, directCoverage * 65 + Math.min(35, rawTotal * 0.35))), 0, 100);
  const summary = topVibeEvidence(evidence)
    .map((item) => item.label)
    .join(", ");

  return {
    confidence,
    evidence: evidence
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 8),
    summary,
    queryOnly: positive.some((item) => item.queryOnly) && !nonQueryPositive,
    corroboratesRequested: Boolean(nonQueryDirect || (nonQueryPositive && confidence >= 35)),
    matchedTerms: [...matchedTerms]
  };
}

function genreLabelSeeds(profile = {}) {
  const artistKeys = new Set(genreArtistAnchors(profile).map(artistIdentityKey));
  return uniqueValues([
    ...genreDiscoverySeeds(profile),
    ...(isProgressiveSceneTarget(profile) ? progressiveSceneLabelsFor(profile) : [])
  ]).filter((seed) => !artistKeys.has(artistIdentityKey(seed)));
}

function tasteGenreEvidenceFor(track = {}, tasteProfile = null) {
  if (typeof tasteProfile?.read !== "function") return [];
  let profile;
  try {
    profile = tasteProfile.read();
  } catch {
    return [];
  }

  const evidence = [];
  const label = labelText(track);
  const labelEntry = label && profile.labels?.[normalize(label)];
  if (labelEntry?.score) {
    const score = Number(labelEntry.score || 0);
    evidence.push({
      source: "darth-rating",
      label: `${labelEntry.name || label} label rating`,
      weight: clamp(score * 1.5, -5, 5),
      corroborating: false
    });
  }

  for (const artist of splitArtists(track.artist)) {
    const entry = profile.artists?.[artistIdentityKey(artist)] ||
      (!isCollisionSensitiveArtist(artist) ? profile.artists?.[normalize(artist)] : null);
    if (!entry?.score) continue;
    const score = Number(entry.score || 0);
    evidence.push({
      source: "darth-rating",
      label: `${entry.name || artist} artist rating`,
      weight: clamp(score, -4, 4),
      corroborating: false
    });
  }

  return evidence;
}

function topGenreEvidence(evidence = [], limit = 3) {
  return evidence
    .filter((item) => item.weight > 0 && !item.queryOnly && item.source !== "darth-rating")
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit);
}

function genreInferenceFor(track = {}, query = "", options = {}, profile = buildDiscoveryProfile(options), tasteProfile = null) {
  const targetGenres = profile.targetGenres || [];
  const adjacentTerms = adjacentLaneTerms(profile, options);
  const label = labelText(track);
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${label}`);
  const queryText = normalize(query || track.query);
  const sourceText = normalize(`${track.discoverySource || ""} ${track.discoveryLane || ""}`);
  const officialGenreValues = trackGenreValues(track);
  const officialGenreText = officialGenreValues.join(" ");
  const officialTerms = ontologyGenreTermsForText(officialGenreText, 12);
  const metadataTerms = ontologyGenreTermsForText(metadataText, 16);
  const inferredGenres = [];
  const evidence = [];

  function add(source, labelTextValue, weight, detail = {}) {
    const cleanLabel = cleanText(labelTextValue);
    if (!cleanLabel || !weight) return;
    evidence.push({
      source,
      label: cleanLabel,
      weight: Number(weight),
      genre: cleanText(detail.genre || ""),
      corroborating: detail.corroborating !== false,
      queryOnly: Boolean(detail.queryOnly),
      weak: Boolean(detail.weak)
    });
    if (detail.genre) inferredGenres.push(detail.genre);
  }

  const metadataTargets = metadataTerms.filter((term) => genreTermMatchesTarget(term, targetGenres));
  for (const term of metadataTargets.slice(0, 3)) {
    add("metadata", `${term} metadata`, isBroadGenreTerm(term) ? 18 : 34, { genre: term });
  }

  if (isStrictChildGenreTarget(profile)) {
    const childEvidence = specificChildGenreEvidenceFor(track, profile);
    if (childEvidence.originalArtistMismatchSoft) {
      add("original-artist-profile", `${childEvidence.excludedArtist} original-artist profile mismatch (named remix)`, -ORIGINAL_ARTIST_PENALTY, { corroborating: false, weak: true });
    }
    if (childEvidence.exactGenre) {
      add("metadata", `${profile.genreProfile.name} metadata`, 34, { genre: profile.genreProfile.name });
    } else if (childEvidence.childKeyword && childEvidence.parentContext) {
      add("metadata", `${childEvidence.childKeyword} ${profile.genreProfile.parentGenres[0] || "genre"} metadata`, 28, { genre: profile.genreProfile.name });
    } else if (childEvidence.sceneLabel) {
      add("label", `${childEvidence.sceneLabel} label scene`, 34, { genre: profile.genreProfile.name });
    } else if (childEvidence.sceneArtist) {
      add("artist", `${childEvidence.sceneArtist} artist scene`, 18, { genre: profile.genreProfile.name });
    } else if (childEvidence.sceneRemixer) {
      add("remixer", `${childEvidence.sceneRemixer} remixer scene`, 18, { genre: profile.genreProfile.name });
    } else if (childEvidence.querySceneLabel || childEvidence.querySceneArtist) {
      add("query-scene", `${childEvidence.querySceneLabel || childEvidence.querySceneArtist} trusted scene query with parent metadata`, 8, {
        genre: profile.genreProfile.name,
        queryOnly: true,
        corroborating: false
      });
    } else if (childEvidence.seedArtist) {
      add("artist", `${childEvidence.seedArtist} branch seed`, 12, { genre: profile.genreProfile.name, weak: true });
    }
  }

  const metadataAdjacent = metadataTerms.filter((term) => genreTermMatchesTarget(term, adjacentTerms));
  for (const term of metadataAdjacent.slice(0, 2)) {
    add("metadata", `${term} adjacent metadata`, isBroadGenreTerm(term) ? 8 : 18, { genre: term });
  }

  if (isProgressiveSceneTarget(profile)) {
    const sceneLabel = matchingSceneLabel(label, profile);
    const sceneArtist = matchingSceneArtist(track.artist, profile);
    const sceneRemixer = matchingSceneRemixer(track, profile);
    const sceneGenre = progressiveSceneTargetFor(profile);
    const labelAlreadyCorroborated = sceneLabel && evidence.some((item) => (
      item.source === "label" && normalize(item.label).includes(normalize(sceneLabel))
    ));
    if (sceneLabel && !labelAlreadyCorroborated) add("label", `${sceneLabel} label scene`, 38, { genre: sceneGenre });
    if (sceneArtist && !evidence.some((item) => (
      item.source === "artist" && normalize(item.label).includes(normalize(sceneArtist))
    ))) add("artist", `${sceneArtist} artist scene`, sceneLabel || metadataTargets.length ? 22 : 18, {
      genre: sceneGenre,
      corroborating: Boolean(sceneLabel || metadataTargets.length)
    });
    if (sceneRemixer && !evidence.some((item) => (
      item.source === "remixer" && normalize(item.label).includes(normalize(sceneRemixer))
    ))) add("remixer", `${sceneRemixer} remixer scene`, sceneLabel || metadataTargets.length ? 22 : 18, {
      genre: sceneGenre,
      corroborating: Boolean(sceneLabel || metadataTargets.length)
    });
    if (profile.isProgressiveTarget && hasAnyTerm(metadataText, PROGRESSIVE_CATALOG_TARGETS)) {
      add("metadata", "progressive catalogue terms", 22, { genre: sceneGenre });
    }
  }

  if (requestedLabelMatch(track, profile)) {
    add("requested-label", `${requestedLabelMatch(track, profile)} requested label`, 32, { genre: targetGenres[0] || "" });
  }

  const labelSeed = genreLabelSeeds(profile).find((seed) => entityEvidenceMatches(label, seed)) || "";
  if (labelSeed && !evidence.some((item) => normalize(item.label).includes(normalize(labelSeed)))) {
    add("label", `${labelSeed} scene label`, 36, { genre: targetGenres[0] || "" });
  }

  const artistAnchor = genreArtistAnchors(profile).find((seed) => artistMatchesKnownName(track.artist, seed)) || "";
  if (artistAnchor) {
    const hasSceneSupport = Boolean(labelSeed || metadataTargets.length || metadataAdjacent.length || requestedLabelMatch(track, profile));
    add("artist", `${artistAnchor} genre anchor`, hasSceneSupport ? 28 : 12, {
      genre: targetGenres[0] || "",
      corroborating: hasSceneSupport
    });
  }

  if (hasSeedArtistMatch(track, options, profile)) {
    add("seed-artist", "requested artist seed", profile.scoringMode === "pure" ? 14 : 10, {
      genre: targetGenres[0] || "",
      corroborating: false
    });
  }

  const canonicalOfficialTarget = targetGenres.find((target) => genreValuesMatchTarget(officialGenreValues, [target])) || "";
  if (canonicalOfficialTarget && !officialTerms.some((term) => genreTermMatchesTarget(term, targetGenres))) {
    add("official-genre", `${canonicalOfficialTarget} canonical official genre`, 18, {
      genre: canonicalOfficialTarget
    });
  }

  for (const term of officialTerms.slice(0, 3)) {
    if (genreTermMatchesTarget(term, targetGenres)) {
      add("official-genre", `${term} official genre`, isBroadGenreTerm(term) ? 4 : 12, {
        genre: term,
        weak: isBroadGenreTerm(term)
      });
    } else if (genreTermMatchesTarget(term, adjacentTerms)) {
      add("official-genre", `${term} adjacent official genre`, isBroadGenreTerm(term) ? 2 : 7, {
        genre: term,
        weak: true
      });
    } else if (isBroadGenreTerm(term)) {
      add("official-genre", `${term} official genre`, 2, { genre: term, weak: true, corroborating: false });
    }
  }

  if (targetGenres.some((term) => containsGenreTerm(queryText, term))) {
    add("query", `${targetGenres.find((term) => containsGenreTerm(queryText, term)) || targetGenres[0]} search query`, 7, {
      genre: targetGenres[0] || "",
      queryOnly: true,
      corroborating: false
    });
  }
  if (isProgressiveSceneTarget(profile)) {
    const querySceneLabel = matchingSceneLabel(queryText, profile);
    const querySceneArtist = matchingSceneArtist(queryText, profile, { contains: true });
    if (querySceneLabel) add("query-scene", `${querySceneLabel} trusted scene query`, 6, {
      genre: targetGenres[0] || "",
      queryOnly: true,
      corroborating: false
    });
    else if (querySceneArtist) add("query-scene", `${querySceneArtist} trusted scene query`, 6, {
      genre: targetGenres[0] || "",
      queryOnly: true,
      corroborating: false
    });
  }
  if (track.discoveryLane === "adjacent" && hasAnyTerm(queryText, adjacentTerms)) {
    add("query", "adjacent search query", 5, { queryOnly: true, corroborating: false });
  }
  if (sourceText && hasAnyTerm(sourceText, targetGenres)) {
    add("source", "source lane mentions requested genre", 8, { genre: targetGenres[0] || "", corroborating: false });
  }

  for (const tasteEvidence of tasteGenreEvidenceFor(track, tasteProfile)) {
    add(tasteEvidence.source, tasteEvidence.label, tasteEvidence.weight, {
      corroborating: false
    });
  }

  const positive = evidence.filter((item) => item.weight > 0);
  const negative = evidence.filter((item) => item.weight < 0);
  const total = positive.reduce((sum, item) => sum + item.weight, 0) + negative.reduce((sum, item) => sum + item.weight, 0);
  const confidence = clamp(Math.round(total), 0, 100);
  const corroboratingEvidence = evidence.filter((item) => item.corroborating && item.weight >= 10 && !item.queryOnly);
  const strongNonQueryEvidence = evidence.filter((item) => item.source !== "query" && item.source !== "official-genre" && item.weight >= 18);
  const queryEvidence = evidence.some((item) => item.queryOnly && item.weight > 0);
  const nonQueryPositive = positive.some((item) => (
    !item.queryOnly &&
    !["official-genre", "darth-rating", "source"].includes(item.source)
  ));
  const weakOfficialGenre = officialGenreValues.some(isBroadGenreTerm) || officialTerms.some(isBroadGenreTerm);
  const summaryItems = topGenreEvidence(evidence).map((item) => item.label);

  return {
    confidence,
    inferredGenres: uniqueTerms(inferredGenres.filter((term) => !isBroadGenreTerm(term)), 5),
    evidence: evidence
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 8),
    summary: summaryItems.join(", "),
    weakOfficialGenre,
    queryOnly: queryEvidence && !nonQueryPositive,
    corroboratesRequested: Boolean(
      !targetGenres.length ||
      corroboratingEvidence.length ||
      strongNonQueryEvidence.length ||
      (confidence >= 35 && nonQueryPositive && !weakOfficialGenre)
    )
  };
}

function sceneEvidenceFor(track = {}, query = "", options = {}, profile = buildDiscoveryProfile(options)) {
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const labelSeeds = genreLabelSeeds(profile);
  const artistAnchors = genreArtistAnchors(profile);
  const adjacentTerms = adjacentLaneTerms(profile, options);
  const labelSeed = labelSeeds.find((seed) => entityEvidenceMatches(labelText(track), seed)) || "";
  const artistAnchor = artistAnchors.find((seed) => artistMatchesKnownName(track.artist, seed)) || "";
  const metadataTarget = hasAnyTerm(metadataText, profile.targetGenres || []);
  const metadataAdjacent = hasAnyTerm(metadataText, adjacentTerms);
  const queryTarget = (profile.targetGenres || []).some((term) => containsGenreTerm(query, term));
  const sceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(labelText(track), profile) : "";
  const sceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.artist, profile) : "";
  const sceneRemixer = isProgressiveSceneTarget(profile) ? matchingSceneRemixer(track, profile) : "";
  const queryLabel = hasAnyTerm(query, labelSeeds);

  return {
    labelSeed,
    artistAnchor,
    sceneLabel,
    sceneArtist,
    metadataTarget,
    metadataAdjacent,
    queryTarget,
    queryLabel,
    metadataSceneEvidence: Boolean(labelSeed || sceneLabel || sceneArtist || sceneRemixer || metadataTarget || metadataAdjacent || queryLabel),
    sceneEvidence: Boolean(labelSeed || artistAnchor || sceneLabel || sceneArtist || sceneRemixer || metadataTarget || metadataAdjacent || queryTarget || queryLabel),
    sceneRemixer
  };
}

function metadataCorroboratesRequestedGenre(track = {}, query = "", options = {}, profile = buildDiscoveryProfile(options)) {
  if (!profile.targetGenres?.length) return true;
  if (isStrictChildGenreTarget(profile) && !specificChildGenreEvidenceFor(track, profile).corroborates) return false;
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const genreInference = genreInferenceFor(track, query, options, profile);
  const canonicalOfficialGenre = genreValuesMatchTarget(trackGenreValues(track), profile.targetGenres);
  const progressiveMetadata = isProgressiveSceneTarget(profile) && Boolean(
    matchingSceneArtist(track.artist, profile) ||
    matchingSceneRemixer(track, profile) ||
    matchingSceneLabel(labelText(track), profile) ||
    hasAnyTerm(metadataText, PROGRESSIVE_CATALOG_TARGETS)
  );
  const scene = sceneEvidenceFor(track, query, options, profile);
  return Boolean(
    canonicalOfficialGenre ||
    progressiveMetadata ||
    requestedLabelMatch(track, profile) ||
    hasSeedArtistMatch(track, options, profile) ||
    genreInference.corroboratesRequested ||
    scene.labelSeed ||
    (profile.isProgressiveTranceTarget && scene.artistAnchor) ||
    (scene.artistAnchor && scene.metadataSceneEvidence) ||
    scene.metadataTarget ||
    scene.metadataAdjacent
  );
}

function weakCompilationText(track = {}) {
  const title = cleanText(track.title);
  const album = cleanText(track.album);
  const artist = cleanText(track.artist);
  const label = cleanText(labelText(track));
  const combined = `${title} ${album} ${artist} ${label}`;
  return /\b(?:various artists?|playlist|collection|compilation|chart|hits?|essentials?|selections?|session|sessions|vol(?:ume)?\.?\s*\d+|pt\.?\s*\d+|part\s*\d+|top\s*\d+|best\s+of|dj mix|continuous mix|mixed by|summer|beach|workout|fitness|background music|lounge|restaurant|bar|smooth grooves?)\b/i.test(combined);
}

function sourceQualityReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  if (!profile.targetGenres?.length) return "";

  const query = cleanText(track.query);
  if (isStrictChildGenreTarget(profile) && !specificChildGenreEvidenceFor(track, profile).corroborates) {
    return `${profile.genreProfile.name} requested, but TIDAL metadata does not corroborate that specific child genre; weak requested-genre evidence.`;
  }
  const scene = sceneEvidenceFor(track, query, options, profile);
  const genreInference = genreInferenceFor(track, query, options, profile);
  const metadataOk = metadataCorroboratesRequestedGenre(track, query, options, profile);
  const targetOnlyInQuery = scene.queryTarget && !metadataOk;
  const adjacentOnlyInQuery = track.discoveryLane === "adjacent" &&
    hasAnyTerm(query, adjacentLaneTerms(profile, options)) &&
    !metadataOk;

  if (adjacentOnlyInQuery) {
    return "Adjacent-lane genre appears only in the search query; TIDAL metadata does not corroborate the requested scene.";
  }
  if (targetOnlyInQuery || genreInference.queryOnly) {
    return "Requested genre appears only in the search query; TIDAL metadata does not corroborate the requested genre/scene.";
  }
  if (weakCompilationText(track) && !metadataOk) {
    return "Compilation/playlist-style result lacks artist, label, or metadata corroboration for the requested genre.";
  }
  return "";
}

function genericGenreArtistName(value, profile = {}) {
  const artist = normalize(value);
  if (!artist) return false;
  const artistWords = artist.split(/\s+/).filter(Boolean);
  const genreArtistWords = artist.match(/\b(?:edm|electronic|dance|melodic|progressive|deep|organic|hypnotic|dark|afro|electro|uk|garage|house|techno|tekkno|trance|ambient|downtempo|breaks|breakbeat|dubstep)\b/g) || [];
  const genreArtistSegments = cleanText(value)
    .split(/[,/&|]+/)
    .map(cleanText)
    .filter(Boolean);
  if (
    genreArtistSegments.length >= 2 &&
    genreArtistSegments.every((segment) => looksLikeStandaloneGenreStylePhrase(segment) || /\b(?:house|techno|tekkno|trance|ambient|downtempo|breaks|breakbeat|dubstep|edm)\b/i.test(segment))
  ) {
    return true;
  }
  if (genreArtistWords.length >= 3 && genreArtistWords.length >= artistWords.length - 1) return true;
  if (/^(?:deep house|house music|tech house|tech house music|techno house|deep vocallo|viral hits|dance hits|edm|electronic dance music|background music|benetti house bar|soundify background music|easy to dance music|electronic music|dance music|various artists?)$/.test(artist)) return true;
  if (
    /\b(?:house|techno|tekkno|trance|edm|dance|electronic|lounge|nightlife)\b/.test(artist) &&
    /\b(?:music|lounge|nation|zone|masters|hits|playlist|background|cafe|club)\b/.test(artist) &&
    artist.split(/\s+/).length >= 4
  ) {
    return true;
  }
  return profile.targetGenres?.length &&
    hasAnyTerm(artist, profile.targetGenres) &&
    artist.split(/\s+/).length <= 5;
}

function looksLikeGenericGenreKeywordUploadTitle(title = "", album = "") {
  const rawTitle = cleanText(title);
  const normalizedTitle = normalize(rawTitle);
  if (!normalizedTitle) return false;
  const rawAlbum = cleanText(album);
  const titleEqualsAlbum = normalizedTitle && normalizedTitle === normalize(rawAlbum);
  const hasGenre = /\b(?:deep house|tech house|afro house|electro house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|deep techno|hypnotic techno|techno|progressive trance|psytrance|psy trance|trance|ambient|downtempo|breaks|breakbeat|uk garage|garage|dubstep|edm|rock|metal|alternative rock|indie rock|psychedelic rock|progressive rock|art rock|space rock)\b/.test(normalizedTitle);
  if (!hasGenre) return false;

  const genreWords = normalizedTitle.match(/\b(?:edm|electronic|dance|melodic|progressive|psychedelic|deep|organic|hypnotic|dark|afro|electro|uk|garage|house|techno|trance|ambient|downtempo|breaks|breakbeat|dubstep|rock|metal|alternative|indie|art|space)\b/g) || [];
  const versionWords = /\b(?:mix|version|edit|remix|loop|club|dub|rework)\b/.test(normalizedTitle);
  const parentheticalGenre = /\([^)]*\b(?:house|techno|trance|garage|ambient|downtempo|breaks|breakbeat|dubstep|edm|rock|metal)\b[^)]*\)/i.test(rawTitle);
  const coreGenres = normalizedTitle.match(/\b(?:house|techno|trance|garage|ambient|downtempo|breaks|breakbeat|dubstep|edm|rock|metal)\b/g) || [];
  const titleWords = normalizedTitle.split(/\s+/).filter(Boolean);
  const genreDominated = genreWords.length >= 2 && genreWords.length >= titleWords.length - 2;
  const multiGenreSoup = new Set(coreGenres).size >= 2 && genreWords.length >= 3;
  const durationOrBackgroundHook = /\b(?:background|\d+\s*(?:hr|hour|hours)|one\s+hour|two\s+hour|three\s+hour)\b/.test(normalizedTitle);

  return Boolean(
    durationOrBackgroundHook ||
    (titleEqualsAlbum && genreDominated) ||
    (parentheticalGenre && (versionWords || titleEqualsAlbum || genreWords.length >= 2)) ||
    (versionWords && genreDominated) ||
    multiGenreSoup
  );
}

function seoSpamReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  const rawTitle = cleanText(track.title);
  const rawAlbum = cleanText(track.album);
  const rawArtist = cleanText(track.artist);
  const rawLabel = cleanText(labelText(track));
  const raw = [rawTitle, rawAlbum, rawArtist, rawLabel].filter(Boolean).join(" ");
  const titleAlbum = [rawTitle, rawAlbum].filter(Boolean).join(" ");
  const normalizedTitleAlbum = normalize(titleAlbum);
  const catalogGenreTerms = uniqueTerms([
    ...(profile.targetGenres || []),
    ...adjacentLaneTerms(profile, options)
  ], 32);
  const broadGenreTitle = /\b(?:deep tech house|deep tech|tech house|deep house|melodic house|organic house|progressive house|progressive trance|psytrance|psy trance|psychedelic trance|goa trance|melodic techno|progressive techno|deep techno|hypnotic techno|techno|trance|ambient|downtempo|breaks|breakbeat|drum and bass|dnb|dubstep|house|rock|metal|alternative rock|indie rock|psychedelic rock|progressive rock|art rock|space rock)\b/i.test(titleAlbum);
  const hasTargetGenreInTitle = broadGenreTitle || (catalogGenreTerms.length
    ? hasAnyTerm(titleAlbum, catalogGenreTerms)
    : false);
  const embeddedMarketingYear = /\b(?:19\d{2}|20\d{2})\b/.test(titleAlbum);
  const dateCode = /\b(?:0?[1-9]|1[0-2])[-_/](?:19\d{2}|20\d{2})\b|\b(?:19\d{2}|20\d{2})[-_/](?:0?[1-9]|1[0-2])\b/i.test(titleAlbum);
  const catalogFillerNoun = /\b(?:fusion|fusions|grooves?|vibes?|sessions?|cuts?|tracks?|beats?|essentials?|selections?|collection|compilation|mixes|journals?|journeys?|sounds?|playlist|chart|hits?|anthems?)\b/i.test(titleAlbum);
  const romanOrVersionTail = /\b(?:v|vol(?:ume)?|pt|part)\s*(?:\d+|[ivxlcdm]{1,6})\b/i.test(titleAlbum) ||
    /\b(?:ii|iii|iv|v|vi|vii|viii|ix|x)\b\s*$/i.test(rawTitle);
  const shortCatalogCode = /\b[a-z]{1,4}\d+\b/i.test(`${rawArtist} ${rawTitle}`);
  const longKeywordTitle = rawTitle.length >= 64 || rawAlbum.length >= 76;
  const listOrVolume = /\b(?:vol(?:ume)?\.?\s*\d+|top\s*\d+|chart hits?|best\s+(?:of\s+)?|playlist|collection|compilation|dj mix|mix\s*\d+\s*hr|3hr|masters|anthems|essentials?|hits?|selection|selected works|various artists)\b/i.test(raw);
  const lifestyleKeywords = /\b(?:summer nights?|beach vibes?|beach|waves?|grooves?|cocktails?|workout|fitness|party|lounge|rooftop|sessions?|smooth|chill|background music|music for|motivation|focus|study|relaxing|spa|bar|restaurant)\b/i.test(raw);
  const marketingPhrase = /\b(?:this sound|night club energy|havana nights?|desert eyes?|midnight flow|endless city horizon|pulls you in|deep journey|club energy)\b/i.test(raw);
  const functionalMusicText = /\b(?:music\s+for|for\s+(?:programming|coding|focus|studying|study|sleep|meditation|relaxation|healing|energy balance|cafe|caf[eé]|workout|spa)|programming\s+and\s+coding|coding music|studying music|sleeping music|relaxing music|chakra healing|deep meditation|public domain|background music)\b/i.test(raw);
  const functionalMusicArtist = /\b(?:programming|coding|studying|sleeping|relaxing|relaxation|focus|meditation|healing|chill\s+house\s+music|music\s+caf[eé]|background music)\b/i.test(rawArtist);
  const genreStyleParenthetical = rawTitle.match(/\([^)]{8,140}\)/g)?.some(looksLikeGenreStyleDescriptor) || false;
  const slashGenreStyleDescriptor = looksLikeSlashSeparatedGenreStyleDescriptor(rawTitle) ||
    looksLikeSlashSeparatedGenreStyleDescriptor(rawAlbum);
  const dashGenreStyleTail = rawTitle.split(/\s+[–—-]\s+/).length >= 2 &&
    rawTitle.split(/\s+[–—-]\s+/).slice(1).some(looksLikeStandaloneGenreStylePhrase);
  const artistLooksLikeMusicChannel = /\b(?:music|official|channel|sounds?|records?|recordings?)\b/i.test(rawArtist);
  const genreYearTag = /\|\s*[^|]*(?:house|techno|trance|ambient|breaks|breakbeat|rock|metal)[^|]*\|\s*(?:19\d{2}|20\d{2})\b/i.test(`${rawTitle} ${rawAlbum}`);
  const titleEqualsAlbum = normalize(rawTitle) && normalize(rawTitle) === normalize(rawAlbum);
  const genreCataloguePhrase = hasTargetGenreInTitle && catalogFillerNoun &&
    (titleEqualsAlbum || artistLooksLikeMusicChannel || normalize(rawTitle).split(/\s+/).length >= 5 || normalize(rawAlbum).split(/\s+/).length >= 4);
  const genreKeywordRemixTail = hasTargetGenreInTitle &&
    /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b.{0,48}\b(?:house|techno|trance|ambient|downtempo|breaks|breakbeat|dubstep|drum\s+and\s+bass|dnb)\b.{0,32}\bremix\b/i.test(rawTitle);
  const titleOnlyYear = /^(?:19\d{2}|20\d{2})$/.test(rawTitle);
  const shortGenreYearTitle = hasTargetGenreInTitle && embeddedMarketingYear && normalize(rawTitle).split(/\s+/).length <= 5;
  const distributorLabel = /^\d+\s+records\s+dk$/i.test(rawLabel);
  const labelAsArtist = normalize(rawArtist) && normalize(rawArtist) === normalize(rawLabel) && /\brecords?\b/i.test(rawArtist);
  const obviousCoverOrKaraoke = /\b(?:karaoke|tribute to|cover version|covers?|as made famous by|originally performed by)\b/i.test(raw);
  const longGenericAlbum = hasTargetGenreInTitle && embeddedMarketingYear && normalize(rawAlbum).split(/\s+/).length >= 6;
  const audiobookChapter = /\bchapter\s+\d+\b/i.test(rawTitle) &&
    /\b(?:unabridged|audiobook|audio\s*book|book|novel|story|escapist|romance|tale)\b/i.test(`${rawAlbum} ${rawLabel}`);
  const distributorKeywordUpload = distributorLabel && (
    longKeywordTitle ||
    /\b(?:official audio|dj mix|female vocal|new\s+(?:bollywood|hindi|saraiki)|electronic dance|romantic dj|qaseeda|new year)\b/i.test(raw)
  );
  const seasonalCatalogueFiller = embeddedMarketingYear &&
    /\b(?:happy new year songs?|new year|new beginnings?)\b/i.test(`${rawTitle} ${rawAlbum}`) &&
    (distributorLabel || normalize(rawArtist) === normalize(rawLabel) || /\b(?:lofi|songs?|catalogue|catalog)\b/i.test(raw));
  const obviousCompilationMarker = /\b(?:various artists?|compilation|playlist|chart hits?|top\s*\d+|best\s+(?:of\s+)?|continuous mix|mixed by|dj mix)\b/i.test(`${rawTitle} ${rawAlbum}`) ||
    (normalize(rawArtist) && normalize(rawArtist) === normalize(rawLabel) && /\b(?:vol(?:ume)?\.?\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)|pt\.?\s*\d+|part\s*\d+)\b/i.test(`${rawTitle} ${rawAlbum}`));
  const broadcastSeriesCompilation = /\b(?:future sound of egypt|a state of trance|state of trance|group therapy|global dj broadcast|essential mix)\b/i.test(titleAlbum) &&
    (/\b(?:disc|cd|episode|ep\.?|radio|show|series)\b/i.test(titleAlbum) || /\b\d{2,4}\b/.test(titleAlbum));
  const numberedLongDjSet = durationMinutes(track) >= 30 &&
    /\bmix\s*(?:\d+|one|two|three|four)\b/i.test(rawTitle);
  const mixedCompilationExcerpt = /[([]\s*(?:mixed|mix cut)\s*[)\]]/i.test(rawTitle) ||
    /^(?:mixed|mix cut)$/i.test(cleanText(track.version));

  if (audiobookChapter) return "Audiobook chapter result, not a music track.";
  if (titleOnlyYear) return "Title is only a year, not a useful track match.";
  if (obviousCoverOrKaraoke) return "Cover/karaoke/tribute catalogue result.";
  if (obviousCompilationMarker || broadcastSeriesCompilation || numberedLongDjSet || mixedCompilationExcerpt) return "Compilation/chart-style catalogue filler.";
  if (functionalMusicText || functionalMusicArtist) return "Functional/background music result looks like SEO catalogue filler.";
  if (genericGenreArtistName(rawArtist, profile)) return "Artist name looks like genre/SEO catalogue filler.";
  if (labelAsArtist) return "Artist name looks like a label/catalogue account, not a real artist.";
  if (distributorKeywordUpload) return "Distributor-label keyword upload looks like catalogue filler.";
  if (seasonalCatalogueFiller) return "Seasonal/greeting catalogue result looks like filler.";
  if (distributorLabel && hasTargetGenreInTitle) return "Distributor-label genre upload looks like catalogue filler.";
  if (genreYearTag) return "Title looks like SEO genre/year tagging instead of a real track title.";
  if (shortGenreYearTitle) return "Title is just genre/year keywords, not a real track title.";
  if (genreStyleParenthetical && (titleEqualsAlbum || artistLooksLikeMusicChannel || hasTargetGenreInTitle)) {
    return "Title uses genre/style descriptor keywords like SEO catalogue filler.";
  }
  if (dashGenreStyleTail && hasTargetGenreInTitle) {
    return "Title uses a dash-separated genre/style descriptor tail like SEO catalogue filler.";
  }
  if (slashGenreStyleDescriptor && (titleEqualsAlbum || artistLooksLikeMusicChannel || hasTargetGenreInTitle || longKeywordTitle)) {
    return "Title uses slash-separated genre/style descriptor keywords like SEO catalogue filler.";
  }
  if (hasTargetGenreInTitle && /\b(?:rework|genre remix|style remix)\b/i.test(rawTitle)) return "Title uses genre/remix keywords like catalogue filler.";
  if (hasTargetGenreInTitle && embeddedMarketingYear && (dateCode || catalogFillerNoun || romanOrVersionTail) && (shortCatalogCode || normalize(rawTitle).split(/\s+/).length >= 6 || normalize(rawAlbum).split(/\s+/).length >= 6)) {
    return "Title/album looks like SEO genre/date catalogue filler.";
  }
  if (hasTargetGenreInTitle && embeddedMarketingYear && (longKeywordTitle || listOrVolume || lifestyleKeywords || marketingPhrase || /\b(?:arabic|latin|best|mix|music|journey)\b/i.test(raw))) {
    return "Title/album looks like SEO genre/year catalogue filler.";
  }
  if (hasTargetGenreInTitle && listOrVolume) return "Compilation/chart-style catalogue filler.";
  if (longGenericAlbum && (listOrVolume || lifestyleKeywords)) return "Album looks like generic genre/year catalogue filler.";
  if (titleEqualsAlbum && embeddedMarketingYear && hasTargetGenreInTitle && normalizedTitleAlbum.split(/\s+/).length >= 7) {
    return "Title repeats genre/year keywords like a catalogue filler upload.";
  }
  if (genreCataloguePhrase) return "Title/album uses genre catalogue wording like SEO catalogue filler.";
  if (genreKeywordRemixTail) return "Title uses genre/remix keywords like catalogue filler.";
  if (looksLikeGenericGenreKeywordUploadTitle(rawTitle, rawAlbum)) {
    return "Title is dominated by genre/style/version keywords like a catalogue upload.";
  }
  return "";
}

function belowMinimumSoftRejectReason(candidate = {}, profile = {}, options = {}) {
  if (!candidate.belowMinimum || !profile.targetGenres?.length) return "";
  const hardDurationReason = durationConstraintReason(candidate.tidal || candidate, options);
  if (hardDurationReason) return hardDurationReason;
  const breakdown = candidate.scoreBreakdown || {};
  const score = Number(candidate.score || breakdown.total || 0);
  const minimumScore = Number(candidate.minimumScore || 0);
  const promptPercent = Number(breakdown.promptMatch?.percent || candidate.promptMatch?.percent || 0);
  const genreMatch = Number(breakdown.genreMatch || 0);
  const labelMatch = Number(breakdown.labelMatch || 0);
  const freshness = Number(breakdown.freshness || 0);
  const statusText = Array.isArray(candidate.statusChecks) ? candidate.statusChecks.join(" ") : "";
  const trustedRoonAnchor = Boolean(
    candidate.roonRescueSceneAnchor ||
    candidate.roon?.artistCreditConfirmed ||
    /\b(?:Roon scene anchor|Exact artist credit confirmed|Roon artist page crawl|Roon similar artist crawl)\b/i.test(statusText)
  );
  const trustedFreshLabelNearMiss = Boolean(
    minimumScore &&
    score >= minimumScore - 5 &&
    labelMatch >= 15 &&
    freshness >= 15 &&
    genreMatch >= 4
  );

  if (score < 45) return "Below minimum and not close enough to keep as a soft fallback.";
  if (trustedRoonAnchor && score >= 65) return "";
  if (trustedFreshLabelNearMiss) return "";
  if (promptPercent && promptPercent < 45) return "Below minimum with weak prompt match; not kept as a soft fallback.";
  if (genreMatch < 8) return "Below minimum with weak requested-genre evidence; not kept as a soft fallback.";
  return "";
}

function belowMinimumRescueNote(candidate = {}, softRejectReason = "", options = {}, profile = {}, historyEntry = null, allowPreviousSuggestions = false) {
  if (!candidate.belowMinimum || !softRejectReason || !profile.targetGenres?.length) return "";
  if (historyEntry && !allowPreviousSuggestions) return "";

  const score = Number(candidate.score || candidate.scoreBreakdown?.total || 0);
  const breakdown = candidate.scoreBreakdown || {};
  const promptPercent = Number(breakdown.promptMatch?.percent || candidate.promptMatch?.percent || 0);
  const freshness = Number(breakdown.freshness || 0);
  const labelMatch = Number(breakdown.labelMatch || 0);
  const artistMatch = Number(breakdown.artistMatch || 0);
  const lengthPreference = Number(breakdown.lengthPreference || 0);
  const genreMatch = Number(breakdown.genreMatch || 0);
  const reason = cleanText(softRejectReason);
  const yearRange = parseYearRange(options);
  const track = candidate.tidal || candidate;

  if (score < 50) return "";
  if (/not close enough/i.test(reason) && score < 55) return "";
  if (/weak prompt match/i.test(reason) && score < 52) return "";
  if (promptPercent && promptPercent < 35 && score < 52) return "";
  if (yearRange && !yearFits(track.year || candidate.year, yearRange, track.releaseDate || candidate.releaseDate)) return "";

  const hasBallparkEvidence = Boolean(
    freshness >= 15 ||
    labelMatch >= 7 ||
    artistMatch >= 11 ||
    lengthPreference >= 15 ||
    genreMatch >= 6 ||
    requestedLabelMatch(track, profile) ||
    hasSeedArtistMatch(track, options, profile)
  );
  if (!hasBallparkEvidence) return "";

  return `Below-minimum branch-out fallback: ${reason}`;
}

function hasExplicitArtistFocus(options = {}, profile = {}) {
  if (profile.isOmnivoreDiscovery && !(profile.requestedArtists || []).length && !extractSeedArtists(options).length) return false;
  return Boolean(
    (profile.requestedArtists || []).length ||
    (profile.seedArtists || []).length ||
    extractSeedArtists(options).length
  );
}

function exploreAvoidsRepeatedArtists(options = {}, profile = {}) {
  const mode = profile.scoringMode || normalizeScoringMode(options);
  if (mode !== "explore" && !requestRequiresFreshArtists(options)) return false;
  return !hasExplicitArtistFocus(options, profile);
}

function repeatedArtistDiversityPenaltyApplies(candidate = {}, options = {}, profile = {}) {
  if (!exploreAvoidsRepeatedArtists(options, profile)) return false;
  if (hasSeedArtistMatch(candidate, options, profile)) return false;

  const breakdown = candidate.scoreBreakdown || {};
  const adjustment = Number(
    breakdown.artistDiversityAdjustment ??
    candidate.artistDiversityAdjustment ??
    0
  );
  const reasons = cleanText([
    ...(breakdown.artistDiversityReasons || []),
    ...(candidate.artistDiversityReasons || [])
  ].join(" "));

  return adjustment <= -10 || /\b(?:surfaced\s+\d+\s+prior tracks?|already recommended|repeat(?:ed)? artist|prior tracks?)\b/i.test(reasons);
}

function belowMinimumCountFillNote(candidate = {}, softRejectReason = "", options = {}, profile = {}, historyEntry = null, allowPreviousSuggestions = false) {
  if (!candidate.belowMinimum || !softRejectReason || !profile.targetGenres?.length) return "";
  if (historyEntry && !allowPreviousSuggestions) return "";

  const score = Number(candidate.score || candidate.scoreBreakdown?.total || 0);
  const breakdown = candidate.scoreBreakdown || {};
  const promptPercent = Number(breakdown.promptMatch?.percent || candidate.promptMatch?.percent || 0);
  const freshness = Number(breakdown.freshness || 0);
  const labelMatch = Number(breakdown.labelMatch || 0);
  const artistMatch = Number(breakdown.artistMatch || 0);
  const lengthPreference = Number(breakdown.lengthPreference || 0);
  const genreMatch = Number(breakdown.genreMatch || 0);
  const reason = cleanText(softRejectReason);
  const yearRange = parseYearRange(options);
  const track = candidate.tidal || candidate;

  if (score < 45) return "";
  if (promptPercent && promptPercent < 30 && score < 52) return "";
  if (yearRange && !yearFits(track.year || candidate.year, yearRange, track.releaseDate || candidate.releaseDate)) return "";

  const hasBallparkEvidence = Boolean(
    freshness >= 15 ||
    labelMatch >= 7 ||
    artistMatch >= 8 ||
    lengthPreference >= 14 ||
    genreMatch >= 5 ||
    requestedLabelMatch(track, profile) ||
    hasSeedArtistMatch(track, options, profile)
  );
  if (!hasBallparkEvidence) return "";

  return `Below-minimum count-fill fallback: ${reason}`;
}

function poolDiagnosticBucketFor(item = {}) {
  const reason = normalize(item.reason || "");
  if (!reason) return "Other discarded";
  if (/\b(?:previously suggested|held back|history|already suggested|already recommended|not recommended before|repeat)\b/.test(reason)) return "Previously suggested";
  if (/\b(?:release|year|date|outside|range|canonical|reissue|remaster|older)\b/.test(reason)) return "Date/range mismatch";
  if (/\b(?:duration|minutes?|shorter than|too short|hard minimum)\b/.test(reason)) return "Duration constraint";
  if (/\b(?:seo|catalogue|catalog|filler|functional|background|keyword|genre year|genre date|compilation|chart style|playlist|audiobook|audio book|chapter)\b/.test(reason)) return "SEO/catalog sludge";
  if (/\b(?:below minimum|minimum|weak prompt|not close enough|weak requested genre)\b/.test(reason)) return "Below minimum / weak match";
  if (/\b(?:outside the requested|genre vibe|requested genre|scene|wrong genre|corroborat|metadata does not confirm|query only)\b/.test(reason)) return "Weak genre/scene evidence";
  if (/\b(?:search was for|pure search requested|requested .* returned|artist mismatch|same title wrong artist)\b/.test(reason)) return "Artist/search drift";
  if (/\b(?:roon|queueable|queue action|exact queueable|best result)\b/.test(reason)) return "Roon not queueable";
  if (/\b(?:tidal|verified|verification|fetch|timeout|timed out|circuit|token)\b/.test(reason)) return "TIDAL/API issue";
  if (/\b(?:short|radio edit|single edit)\b/.test(reason)) return "Short/edit";
  if (/\b(?:local model|model candidate|model)\b/.test(reason)) return "Model rejected";
  return "Other discarded";
}

function incrementDiagnosticCount(map, label, amount = 1) {
  const key = cleanText(label) || "Other discarded";
  map.set(key, (map.get(key) || 0) + Number(amount || 1));
}

function sortedDiagnosticCounts(map = new Map(), limit = 8) {
  return [...map.entries()]
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0) || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function diagnosticExampleFor(item = {}) {
  return {
    label: cleanText([item.artist, item.title].filter(Boolean).join(" - ")) || cleanText(item.query) || "Unknown candidate",
    reason: cleanText(item.reason || "No reason provided")
  };
}

function buildPoolDiagnostics({
  tracks = [],
  alternates = [],
  discarded = [],
  scoreFiltered = [],
  minimumRescueCandidates = [],
  countFillCandidates = [],
  belowMinimumCountFillKept = 0,
  previousCandidates = [],
  previousFallbackKept = 0,
  artistNoveltyCandidates = [],
  artistNoveltyFallbackKept = 0,
  requestedCount = 0,
  generated = 0,
  candidatePoolTarget = 0,
  usefulCandidateTarget = 0,
  budgetExhausted = false,
  laneSelection = {},
  queryYield = {},
  queryRecovery = {},
  querySelectionDiagnostics = [],
  catalogPaginationDiagnostics = [],
  candidateCollectionDiagnostics = {},
  searchStopDiagnostics = [],
  queryExecutionDiagnostics = [],
  deepCatalog = {}
} = {}) {
  function artistCountMapFor(list = []) {
    const counts = new Map();
    for (const track of list || []) {
      const keys = artistKeysForCandidate(track);
      if (!keys.length) continue;
      const primary = keys[0];
      counts.set(primary, (counts.get(primary) || 0) + 1);
    }
    return counts;
  }
  function repeatedArtistsFrom(map = new Map()) {
    return [...map.entries()]
      .filter(([, count]) => Number(count || 0) > 1)
      .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))
      .slice(0, 8)
      .map(([artist, count]) => ({ artist, count }));
  }
  const bucketCounts = new Map();
  const examplesByBucket = new Map();
  for (const item of discarded) {
    const bucket = poolDiagnosticBucketFor(item);
    incrementDiagnosticCount(bucketCounts, bucket);
    if (!examplesByBucket.has(bucket)) examplesByBucket.set(bucket, []);
    const examples = examplesByBucket.get(bucket);
    if (examples.length < 3) examples.push(diagnosticExampleFor(item));
  }

  const buckets = sortedDiagnosticCounts(bucketCounts, 8).map((bucket) => ({
    ...bucket,
    examples: examplesByBucket.get(bucket.label) || []
  }));
  const laneQuota = laneSelection?.quota || {};
  const selectedArtistCounts = artistCountMapFor(tracks);
  const retainedArtistCounts = artistCountMapFor([...tracks, ...alternates]);
  const selectedRepeatedArtists = repeatedArtistsFrom(selectedArtistCounts);
  const retainedRepeatedArtists = repeatedArtistsFrom(retainedArtistCounts);
  const noveltyTaxedCandidates = [...tracks, ...alternates]
    .filter((track) => Number(track.recentSuggestionPenalty || 0) > 0)
    .sort((left, right) => Number(right.recentSuggestionPenalty || 0) - Number(left.recentSuggestionPenalty || 0));
  const querySludge = Number(queryYield.seoRejects || 0) + Number(queryYield.genreRejects || 0);
  function topObjectCounts(object = {}, labelMap = {}) {
    return Object.entries(object || {})
      .map(([key, count]) => ({
        label: cleanText(labelMap[key] || key),
        count: Number(count || 0)
      }))
      .filter((item) => item.label && item.count > 0)
      .sort((left, right) => Number(right.count || 0) - Number(left.count || 0) || left.label.localeCompare(right.label))
      .slice(0, 8);
  }
  function capHeldDiagnosticsFor(value = {}) {
    const normalizeHeld = (item = {}) => ({
      kind: cleanText(item.kind),
      key: cleanText(item.key),
      identity: cleanText(item.identity),
      label: cleanText(item.label),
      candidate: cleanText(item.candidate),
      score: Number(item.score || 0),
      bucket: cleanText(item.bucket),
      source: cleanText(item.source),
      cap: Number(item.cap || 0),
      count: Number(item.count || 0),
      reason: cleanText(item.reason)
    });
    const label = Array.isArray(value.label) ? value.label.map(normalizeHeld).filter((item) => item.candidate) : [];
    const source = Array.isArray(value.source) ? value.source.map(normalizeHeld).filter((item) => item.candidate) : [];
    const uniqueIdentities = new Set([...label, ...source].map((item) => item.identity || item.candidate));
    return {
      total: Number(value.total || uniqueIdentities.size || 0),
      label: label.slice(0, 8),
      source: source.slice(0, 8)
    };
  }
  const capHeldDiagnostics = capHeldDiagnosticsFor(laneQuota.capHeld || {});
  const notes = [];
  if (budgetExhausted) notes.push("Runtime budget was exhausted before every crawl/search path could finish.");
  if (previousCandidates.length) notes.push(`${previousCandidates.length} previously suggested candidate${previousCandidates.length === 1 ? "" : "s"} held back for novelty.`);
  if (previousFallbackKept) notes.push(`${previousFallbackKept} previously suggested candidate${previousFallbackKept === 1 ? "" : "s"} promoted only as a fallback after the fresh pool undershot.`);
  if (artistNoveltyCandidates.length) notes.push(`${artistNoveltyCandidates.length} repeated-artist candidate${artistNoveltyCandidates.length === 1 ? "" : "s"} held back for artist novelty.`);
  if (artistNoveltyFallbackKept) notes.push(`${artistNoveltyFallbackKept} least-repeated artist fallback${artistNoveltyFallbackKept === 1 ? "" : "s"} kept because the fresh-artist search undershot.`);
  if (minimumRescueCandidates.length) notes.push(`${minimumRescueCandidates.length} below-floor candidate${minimumRescueCandidates.length === 1 ? "" : "s"} were eligible as branch-out fallback.`);
  if (countFillCandidates.length) notes.push(`${countFillCandidates.length} below-floor near-miss candidate${countFillCandidates.length === 1 ? "" : "s"} were eligible to fill the requested count.`);
  if (belowMinimumCountFillKept) notes.push(`${belowMinimumCountFillKept} below-floor near-miss fallback${belowMinimumCountFillKept === 1 ? "" : "s"} kept to avoid returning too few tracks.`);
  if (queryYield.recordCount) notes.push(`${queryYield.attempted || 0} TIDAL search quer${queryYield.attempted === 1 ? "y" : "ies"} returned ${queryYield.returned || 0}; ${queryYield.accepted || 0} accepted by query-yield tracking.`);
  if (querySludge) notes.push(`${querySludge} query-yield reject${querySludge === 1 ? "" : "s"} looked like SEO sludge or genre drift.`);
  if (queryYield.prunedCount) notes.push(`${queryYield.prunedCount} historically low-yield quer${queryYield.prunedCount === 1 ? "y was" : "ies were"} skipped before spending crawl budget.`);
  if (Array.isArray(queryYield.laneBudgetStops) && queryYield.laneBudgetStops.length) notes.push("Core search stopped early enough to reserve crawl time for later lanes.");
  if (queryRecovery?.triggered) notes.push(`Adaptive query recovery tried ${queryRecovery.attempted || 0} alternate quer${queryRecovery.attempted === 1 ? "y" : "ies"} and accepted ${queryRecovery.accepted || 0} candidate${queryRecovery.accepted === 1 ? "" : "s"}.`);
  if (laneQuota?.enabled && laneQuota.rescueApplied) notes.push(`${laneQuota.rescueKept || 0} lower-confidence branch-out fallback${laneQuota.rescueKept === 1 ? "" : "s"} kept because the run undershot.`);
  if (laneQuota?.enabled && Number(laneQuota.artistCap || 0) === 1) notes.push("Novelty budget capped displayed results at one track per artist.");
  if (laneQuota?.enabled && laneQuota.repeatFallbackAllowed) notes.push("Repeated artists are allowed because this request is artist-near or explicitly permits repeats.");
  if (laneQuota?.enabled && laneQuota.labelSourceRelaxed) notes.push(`${laneQuota.labelSourceRelaxed} candidate${laneQuota.labelSourceRelaxed === 1 ? "" : "s"} kept after label/source caps relaxed because the selected pool was short.`);
  if (capHeldDiagnostics.total) notes.push(`${capHeldDiagnostics.total} high-ranking candidate${capHeldDiagnostics.total === 1 ? " was" : "s were"} held back by label/source caps.`);
  if (!selectedRepeatedArtists.length && tracks.length > 1) notes.push("Artist diversity cap held the displayed set to one track per artist.");
  if (retainedRepeatedArtists.length) notes.push(`${retainedRepeatedArtists.length} retained artist${retainedRepeatedArtists.length === 1 ? " has" : "s have"} alternates beyond the displayed cap.`);
  if (noveltyTaxedCandidates.length) notes.push(`${noveltyTaxedCandidates.length} retained candidate${noveltyTaxedCandidates.length === 1 ? "" : "s"} received a recent-suggestion novelty tax for overused artists, labels, or sources.`);

  return {
    requested: Number(requestedCount || 0),
    generated: Number(generated || 0),
    kept: tracks.length,
    alternates: alternates.length,
    discarded: discarded.length,
    retainedPool: tracks.length + alternates.length,
    candidatePoolTarget: Number(candidatePoolTarget || 0),
    usefulCandidateTarget: Number(usefulCandidateTarget || 0),
    budgetExhausted: Boolean(budgetExhausted),
    scoreFiltered: scoreFiltered.length,
    previousHeldBack: previousCandidates.length,
    previousFallbackKept: Number(previousFallbackKept || 0),
    artistNoveltyHeldBack: artistNoveltyCandidates.length,
    artistNoveltyFallbackKept: Number(artistNoveltyFallbackKept || 0),
    rescueAvailable: minimumRescueCandidates.length,
    rescueKept: Number(laneQuota.rescueKept || tracks.filter((track) => track.belowMinimumRescue).length || 0),
    countFillAvailable: countFillCandidates.length,
    countFillKept: Number(belowMinimumCountFillKept || 0),
    artistSpread: {
      selectedArtists: selectedArtistCounts.size,
      retainedArtists: retainedArtistCounts.size,
      artistCap: laneQuota.artistCap || null,
      repeatFallbackAllowed: Boolean(laneQuota.repeatFallbackAllowed),
      selectedRepeatedArtists,
      retainedRepeatedArtists
    },
    diversityCaps: {
      artistCap: laneQuota.artistCap || null,
      labelCap: laneQuota.labelCap || null,
      sourceCap: laneQuota.sourceCap || null,
      labelSourceRelaxed: Number(laneQuota.labelSourceRelaxed || 0),
      topLabels: topObjectCounts(laneQuota.labels || {}),
      topSources: topObjectCounts(laneQuota.sources || {}, laneQuota.sourceLabels || {}),
      capHeld: capHeldDiagnostics
    },
    recentNovelty: {
      taxed: noveltyTaxedCandidates.length,
      maxPenalty: Math.max(0, ...noveltyTaxedCandidates.map((track) => Number(track.recentSuggestionPenalty || 0))),
      examples: noveltyTaxedCandidates.slice(0, 6).map((track) => ({
        label: cleanText([track.artist, track.title].filter(Boolean).join(" - ")) || "Unknown candidate",
        penalty: Number(track.recentSuggestionPenalty || 0),
        reasons: Array.isArray(track.recentSuggestionPenaltyReasons)
          ? track.recentSuggestionPenaltyReasons.slice(0, 3)
          : []
      }))
    },
    queryYield: {
      attempted: Number(queryYield.attempted || 0),
      returned: Number(queryYield.returned || 0),
      accepted: Number(queryYield.accepted || 0),
      rejected: Number(queryYield.rejected || 0),
      sludge: querySludge,
      errors: Number(queryYield.errorCount || 0),
      pruned: Number(queryYield.prunedCount || 0),
      laneBudgetStops: Array.isArray(queryYield.laneBudgetStops) ? queryYield.laneBudgetStops.length : 0
    },
    querySelectionDiagnostics: Array.isArray(querySelectionDiagnostics)
      ? querySelectionDiagnostics.slice(0, 160)
      : [],
    queryExecution: Array.isArray(queryExecutionDiagnostics)
      ? queryExecutionDiagnostics.slice(0, 160)
      : [],
    catalogPagination: Array.isArray(catalogPaginationDiagnostics)
      ? catalogPaginationDiagnostics.slice(0, 160)
      : [],
    candidateAccumulation: {
      rawCandidates: Number(candidateCollectionDiagnostics.rawCount || 0),
      uniqueCandidatesBeforeSelection: Number(candidateCollectionDiagnostics.acceptedCount || 0),
      validDurationCandidatesBeforeSelection: Number(candidateCollectionDiagnostics.validDurationCount || 0),
      freshCandidatesBeforeNovelty: Number(candidateCollectionDiagnostics.freshBeforeNoveltyCount || 0),
      freshCandidatesAfterNovelty: Number(candidateCollectionDiagnostics.freshAfterNoveltyCount || 0),
      duplicateCandidates: Number(candidateCollectionDiagnostics.duplicateCount || 0),
      invalidIdentityCandidates: Number(candidateCollectionDiagnostics.invalidIdentityCount || 0),
      duplicateExamples: Array.isArray(candidateCollectionDiagnostics.duplicateExamples)
        ? candidateCollectionDiagnostics.duplicateExamples.slice(0, 8)
        : [],
      durationCandidates: Array.isArray(candidateCollectionDiagnostics.durationCandidates)
        ? candidateCollectionDiagnostics.durationCandidates.slice(0, 160)
        : []
    },
    finalSelection: {
      candidatesBeforeSelection: Number(candidateCollectionDiagnostics.acceptedCount || 0),
      selected: tracks.length,
      alternates: alternates.length,
      lostToSelection: Math.max(0, Number(candidateCollectionDiagnostics.acceptedCount || 0) - tracks.length - alternates.length),
      diversityCapHeld: Number(capHeldDiagnostics.total || 0),
      selectionDiagnostics: laneQuota?.selectionDiagnostics || null
    },
    acceptedQueryFamilies: [...(candidateCollectionDiagnostics.acceptedByFamily instanceof Map
      ? candidateCollectionDiagnostics.acceptedByFamily.values()
      : [])].slice(0, 80),
    searchStops: Array.isArray(searchStopDiagnostics)
      ? searchStopDiagnostics.slice(0, 240)
      : [],
    deepCatalog: {
      enabled: Boolean(deepCatalog?.enabled),
      triggered: Boolean(deepCatalog?.triggered),
      pageCount: Number(deepCatalog?.pageCount || 1),
      attempted: Number(deepCatalog?.attempted || 0),
      returned: Number(deepCatalog?.returned || 0),
      accepted: Number(deepCatalog?.accepted || 0),
      duplicateCount: Number(deepCatalog?.duplicateCount || 0),
      stoppedReason: cleanText(deepCatalog?.stoppedReason || ""),
      anchors: Array.isArray(deepCatalog?.anchors) ? deepCatalog.anchors.slice(0, 8) : []
    },
    queryRecovery: {
      enabled: Boolean(queryRecovery?.enabled),
      triggered: Boolean(queryRecovery?.triggered),
      reason: cleanText(queryRecovery?.reason || ""),
      keptBefore: Number(queryRecovery?.keptBefore || 0),
      keptAfter: Number(queryRecovery?.keptAfter || 0),
      attempted: Number(queryRecovery?.attempted || 0),
      returned: Number(queryRecovery?.returned || 0),
      accepted: Number(queryRecovery?.accepted || 0),
      errors: Number(queryRecovery?.errors || 0),
      targetLanes: Array.isArray(queryRecovery?.targetLanes)
        ? queryRecovery.targetLanes.map(cleanText).filter(Boolean).slice(0, 8)
        : [],
      laneShortfalls: Array.isArray(queryRecovery?.laneShortfalls)
        ? queryRecovery.laneShortfalls.slice(0, 8).map((item) => ({
          bucket: cleanText(item.bucket),
          target: Number(item.target || 0),
          available: Number(item.available || 0),
          shortfall: Number(item.shortfall || 0)
        }))
        : [],
      families: Array.isArray(queryRecovery?.families)
        ? queryRecovery.families.slice(0, 8).map((family) => ({
          id: cleanText(family.id),
          label: cleanText(family.label),
          lane: cleanText(family.lane),
          queries: Number(family.queries || 0),
          attempted: Number(family.attempted || 0),
          returned: Number(family.returned || 0),
          accepted: Number(family.accepted || 0),
          rejected: Number(family.rejected || 0),
          seoRejects: Number(family.seoRejects || 0),
          genreRejects: Number(family.genreRejects || 0),
          errors: Number(family.errors || 0)
        }))
        : []
    },
    lanes: {
      selected: laneQuota.selected || {},
      available: laneQuota.available || {},
      targets: laneQuota.targets || {}
    },
    buckets,
    notes
  };
}

function isLikelySceneCandidate(track = {}, query = "", options = {}, profile = buildDiscoveryProfile(options)) {
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const text = normalize(`${metadataText} ${query}`);
  const wanted = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const artistMatch = Boolean(matchingSceneArtist(track.artist, profile));
  const labelMatch = Boolean(matchingSceneLabel(labelText(track), profile));
  const remixerMatch = Boolean(matchingSceneRemixer(track, profile));
  const genreInference = profile.targetGenres.length ? genreInferenceFor(track, query, options, profile) : {};

  if (profile.isProgressiveTarget && wantsProgressiveHouseOnly(options)) {
    const remix = namedRemixEvidence(track);
    if (isTranceForwardArtist(track.artist) && !(remix.named && !remix.versionConflict)) return false;
    if (/\b(?:progressive trance|uplifting|psytrance|goa|vocal trance)\b/.test(text)) return false;
  }

  if (profile.isProgressiveTarget && artistMatch) return true;
  if (profile.isProgressiveTranceTarget && (artistMatch || labelMatch || remixerMatch)) return true;
  if (profile.isProgressiveTarget && wanted.includes("progressive")) {
    if (/\b(?:progressive|melodic|deep|organic|anjuna|anjunadeep|sudbeat|lost found|meanwhile|balance|bedrock|songspire|this never happened)\b/.test(text)) {
      return true;
    }
  }

  if (profile.targetGenres.length) {
    if (isStrictChildGenreTarget(profile) && !specificChildGenreEvidenceFor(track, profile).corroborates) return false;
    const scene = sceneEvidenceFor(track, query, options, profile);
    if (genreInference.queryOnly) return false;
    if (genreInference.corroboratesRequested && Number(genreInference.confidence || 0) >= 28) return true;
    if (requestedLabelMatch(track, profile)) return true;
    if (hasSeedArtistMatch(track, options, profile)) return true;
    if (scene.sceneArtist || scene.sceneLabel || scene.sceneRemixer) return true;
    if (profile.isProgressiveTranceTarget && scene.artistAnchor) return true;
    if (scene.artistAnchor && scene.metadataSceneEvidence) return true;
    if (scene.artistAnchor && !scene.metadataSceneEvidence) return false;
    if (scene.labelSeed) return true;
    if (track.discoveryLane === "recent") return false;
    if (genreValuesMatchTarget(trackGenreValues(track), profile.targetGenres)) return true;
    if (hasAnyTerm(metadataText, profile.targetGenres)) return true;
    if (track.discoveryLane === "adjacent") {
      const adjacentTerms = adjacentLaneTerms(profile, options);
      if (hasAnyTerm(metadataText, adjacentTerms)) return true;
    }
    if (profile.isGenreDiscoveryTarget) return false;
  }

  return true;
}

function artistMatchesRequested(trackArtist = "", requestedArtists = []) {
  return requestedArtists.some((requested) => artistMatchesKnownName(trackArtist, requested));
}

function requestedArtistMismatchReason(track = {}, profile = {}) {
  if (profile.scoringMode !== "pure" || !profile.requestedArtists?.length) return "";
  if (artistMatchesRequested(track.artist, profile.requestedArtists)) return "";
  return `Pure Search requested ${profile.requestedArtists.join(", ")}, but TIDAL returned ${track.artist || "unknown artist"}.`;
}

function identityCorrectnessReasonFor(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  const targetArtist = queryTargetArtist(track.query, profile);
  if (targetArtist) {
    const target = normalize(targetArtist);
    const matchedTarget = artistMatchesKnownName(track.artist, targetArtist) ||
      normalize(`${track.title} ${track.album}`).includes(target);
    if (!matchedTarget && !sceneCorroboratesArtistDrift(track, options, profile)) {
      return `Search was for ${targetArtist}, but TIDAL returned ${track.artist}.`;
    }
  }
  return requestedArtistMismatchReason(track, profile);
}

// A bare descriptor search ("introspective") returns tracks titled or
// credited with that word. Those match the keyword, not the sound, so on a
// search that names no artist or label, a title that is the term or an artist
// that is or starts with it is rejected. Terms the listener typed and theme
// searches, where a title naming the theme is the point, are left alone.
function searchTermEchoReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  const term = normalize(track.query);
  if (!term) return "";
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  if (normalize(plan.intentRoute) === "theme") return "";
  if (queryTargetArtist(track.query, profile) || queryStartsWithKnownLabel(track.query, profile)) return "";
  if (` ${normalize(requestText(options))} `.includes(` ${term} `)) return "";
  const title = normalize(cleanText(track.title).replace(/\s*[([].*$/, ""));
  const artist = normalize(track.artist);
  if (title === term || artist === term || artist.startsWith(`${term} `)) {
    return `Title or artist only echoes the search term "${term}", not the requested sound.`;
  }
  return "";
}

function sceneCorroboratesArtistDrift(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  if (profile.scoringMode === "pure" || !profile.targetGenres?.length) return false;
  const query = cleanText(track.query);
  const scene = sceneEvidenceFor(track, query, options, profile);
  const inference = genreInferenceFor(track, query, options, profile);
  return Boolean(
    requestedLabelMatch(track, profile) ||
    matchingSceneLabel(labelText(track)) ||
    scene.labelSeed ||
    scene.metadataTarget ||
    scene.metadataAdjacent ||
    scene.queryLabel ||
    (inference.corroboratesRequested && Number(inference.confidence || 0) >= 28)
  );
}

function rejectReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  const yearRange = parseYearRange(options);
  const pureRequestedArtistMatch = Boolean(
    profile.scoringMode === "pure" &&
    profile.requestedArtists?.length &&
    artistMatchesRequested(track.artist, profile.requestedArtists)
  );
  const identityReason = identityCorrectnessReasonFor(track, options, profile);
  if (identityReason) return identityReason;
  const echoReason = searchTermEchoReason(track, options, profile);
  if (echoReason) return echoReason;
  if (yearRange?.dateSpecific && !track.releaseDate) return `No TIDAL release date for ${yearRange.label}.`;
  if (yearRange?.dateSpecific && !hasCanonicalReleaseForRange(track, yearRange)) return `No canonical TIDAL album/track release date for ${yearRange.label}.`;
  if (yearRange?.dateSpecific && !yearFits(track.year, yearRange, track.releaseDate)) return `TIDAL release date ${track.releaseDate || track.year || "unknown"} is outside ${yearRange.label}.`;
  if (yearRange && !yearRange.dateSpecific && !track.year) return `No TIDAL release year for ${yearRange.label}.`;
  if (yearRange && !yearRange.dateSpecific && !hasCanonicalReleaseForRange(track, yearRange)) return `No canonical TIDAL album/track/ISRC release year for ${yearRange.label}.`;
  if (yearRange && !yearRange.dateSpecific && !yearFits(track.year, yearRange, track.releaseDate)) return `TIDAL release year ${track.year} is outside ${yearRange.label}.`;
  if (yearRange && isReissueLike(track)) return `Looks like a reissue/remaster instead of a fresh ${yearRange.label} release.`;
  if (yearRange && hasOutOfRangeEmbeddedYear(track, yearRange)) return `Title or album references an older year outside ${yearRange.label}.`;
  const seoReason = seoSpamReason(track, options, profile);
  if (seoReason) return seoReason;
  const electronicDomainReason = electronicDomainDriftReason(track, options, profile);
  if (electronicDomainReason) return electronicDomainReason;
  const omnivoreReason = omnivoreDriftReason(track, options, profile);
  if (omnivoreReason) return omnivoreReason;
  if (isShortEdit(track)) return "Short/radio edit.";
  const hardDurationReason = durationConstraintReason(track, options);
  if (hardDurationReason) return hardDurationReason;
  if (profile.targetGenres.length && !pureRequestedArtistMatch) {
    const scene = sceneEvidenceFor(track, track.query, options, profile);
    if (scene.artistAnchor && !scene.metadataSceneEvidence) {
      return `Artist name matches ${scene.artistAnchor}, but TIDAL metadata does not confirm the requested genre/scene.`;
    }
  }
  const sourceQuality = pureRequestedArtistMatch ? "" : sourceQualityReason(track, options, profile);
  if (sourceQuality) return sourceQuality;
  if (!pureRequestedArtistMatch && !isLikelySceneCandidate(track, track.query, options, profile)) return "Outside the requested genre/vibe lane.";
  return "";
}

function admissionRejectionStageFor(reason = "", diagnostics = {}) {
  if (!diagnostics.identityCorrectness?.passed) return "identity-correctness";
  if (!diagnostics.catalogueQuality?.passed) return "catalogue-quality";
  if (!diagnostics.durationConstraints?.passed) return "duration-constraints";
  if (!diagnostics.genreLaneCompatibility?.passed) return "genre-lane-compatibility";
  const text = normalize(reason);
  if (/below minimum|minimum .* floor|score .* below|score threshold|score floor/.test(text)) return "score-threshold";
  if (/previously suggested|already suggested|held back|history|already recommended|repeat/.test(text)) return "novelty-policy";
  if (/artist novelty|fresh artist/.test(text)) return "artist-novelty-policy";
  if (/requested genre|genre\/scene|outside .*genre|specific child genre|weak requested-genre|genre lane/.test(text)) return "genre-lane-compatibility";
  if (/radio edit|short edit|version|remaster/.test(text)) return "version-safety";
  if (/tidal|roon|queue|provider|verification/.test(text)) return "provider-safety";
  return reason ? "post-search-admission" : "";
}

function admissionDiagnosticsFor(track = {}, options = {}, profile = buildDiscoveryProfile(options), decision = {}) {
  const identityReason = identityCorrectnessReasonFor(track, options, profile);
  const catalogueReason = seoSpamReason(track, options, profile);
  const durationReason = durationConstraintReason(track, options);
  const durationConstraint = hardDurationConstraintFor(options);
  const pureRequestedArtistMatch = Boolean(
    profile.scoringMode === "pure" &&
    profile.requestedArtists?.length &&
    artistMatchesRequested(track.artist, profile.requestedArtists)
  );
  const genreInference = profile.targetGenres?.length
    ? genreInferenceFor(track, track.query, options, profile)
    : { confidence: 0, evidence: [], summary: "", queryOnly: false, corroboratesRequested: true };
  const vibeInference = profile.vibeTerms?.length
    ? vibeInferenceFor(track, track.query, profile)
    : { confidence: 0, evidence: [], summary: "", queryOnly: false, corroboratesRequested: true, matchedTerms: [] };
  const scene = profile.targetGenres?.length
    ? sceneEvidenceFor(track, track.query, options, profile)
    : {};
  const childGenreEvidence = profile.targetGenres?.length && isStrictChildGenreTarget(profile)
    ? specificChildGenreEvidenceFor(track, profile)
    : {};
  const parentGenreTerms = profile.genreProfile?.parentGenres || [];
  const metadataForGenreEvidence = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)} ${trackGenreValues(track).join(" ")}`);
  const parentMetadataMatches = parentGenreTerms.filter((term) => hasAnyTerm(metadataForGenreEvidence, [term]));
  const parentOfficialMatches = parentGenreTerms.filter((term) => trackGenreValues(track).some((value) => containsNormalized(value, term)));
  const querySceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(track.query, profile) : "";
  const querySceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.query, profile, { contains: true }) : "";
  const explicitNonTranceGenre = /\b(?:rock|metal|country|folk|classical|jazz|hip hop|rap|r and b|soul|soundtrack|film score|spoken word|audiobook|podcast)\b/i.test(trackGenreValues(track).join(" "));
  const matchedSeedArtist = (profile.seedArtists || []).find((artist) => (
    artistMatchesKnownName(track.artist, artist)
  )) || "";
  const sceneAnchorReason = profile.targetGenres?.length && !pureRequestedArtistMatch && scene.artistAnchor && !scene.metadataSceneEvidence
    ? `Artist name matches ${scene.artistAnchor}, but TIDAL metadata does not confirm the requested genre/scene.`
    : "";
  const genreReason = profile.targetGenres?.length && !pureRequestedArtistMatch
    ? (sceneAnchorReason || sourceQualityReason(track, options, profile) ||
      (!isLikelySceneCandidate(track, track.query, options, profile) ? "Outside the requested genre lane." : ""))
    : "";
  const exactGenreConflictDetected = Boolean(
    genreReason &&
    explicitNonTranceGenre &&
    !childGenreEvidence.corroborates &&
    !parentMetadataMatches.length &&
    !parentOfficialMatches.length
  );
  const scoreBeforeRejection = Number(decision.scoreBeforeRejection);
  const rejectionStage = cleanText(decision.rejectionStage || "") || admissionRejectionStageFor(decision.hardFailReason || "", {
    catalogueQuality: { passed: !catalogueReason },
    identityCorrectness: { passed: !identityReason },
    durationConstraints: { passed: !durationReason },
    genreLaneCompatibility: { passed: !genreReason }
  });
  const hardFailReason = cleanText(decision.hardFailReason || "");
  const hasScoreBeforeRejection = Number.isFinite(scoreBeforeRejection) && scoreBeforeRejection > 0;

  return {
    candidate: {
      artist: cleanText(track.artist),
      title: cleanText(track.title)
    },
    normalizedRequestedGenre: (profile.targetGenres || []).map(normalizeGenreKey).filter(Boolean),
    candidateGenreEvidence: {
      official: trackGenreValues(track),
      inferred: genreInference.evidence || [],
      confidence: Number(genreInference.confidence || 0),
      canonicalOfficialMatch: genreValuesMatchTarget(trackGenreValues(track), profile.targetGenres || []),
      child: {
        exact: Boolean(childGenreEvidence.exactGenre),
        keyword: cleanText(childGenreEvidence.childKeyword || ""),
        corroborates: childGenreEvidence.corroborates !== false,
        sceneRemixer: cleanText(childGenreEvidence.sceneRemixer || "")
      },
      parent: {
        requested: parentGenreTerms,
        metadataMatches: parentMetadataMatches,
        officialMatches: parentOfficialMatches
      }
    },
    childGenreEvidence: {
      exact: Boolean(childGenreEvidence.exactGenre),
      keyword: cleanText(childGenreEvidence.childKeyword || ""),
      corroborates: childGenreEvidence.corroborates !== false,
      sceneLabel: cleanText(childGenreEvidence.sceneLabel || ""),
      sceneArtist: cleanText(childGenreEvidence.sceneArtist || ""),
      sceneRemixer: cleanText(childGenreEvidence.sceneRemixer || ""),
      querySceneLabel: cleanText(childGenreEvidence.querySceneLabel || ""),
      querySceneArtist: cleanText(childGenreEvidence.querySceneArtist || "")
    },
    parentGenreEvidence: {
      requested: parentGenreTerms,
      metadataMatches: parentMetadataMatches,
      officialMatches: parentOfficialMatches
    },
    artistSceneEvidence: {
      trustedSceneArtist: cleanText(scene.sceneArtist || ""),
      trustedRemixer: cleanText(scene.sceneRemixer || childGenreEvidence.sceneRemixer || ""),
      storedGenreProfileArtist: cleanText(scene.artistAnchor || ""),
      seedArtist: cleanText(matchedSeedArtist),
      metadataCorroboration: Boolean(scene.metadataSceneEvidence)
    },
    labelSceneEvidence: {
      trustedSceneLabel: cleanText(scene.sceneLabel || ""),
      storedGenreProfileLabel: cleanText(scene.labelSeed || ""),
      requestedLabel: cleanText(requestedLabelMatch(track, profile)),
      metadataCorroboration: Boolean(scene.metadataSceneEvidence)
    },
    querySceneEvidence: {
      query: cleanText(track.query || ""),
      targetGenreMatch: Boolean(scene.queryTarget),
      trustedSceneLabel: cleanText(querySceneLabel),
      trustedSceneArtist: cleanText(querySceneArtist),
      trustedSceneMatch: Boolean(querySceneLabel || querySceneArtist || scene.queryLabel),
      queryLabelMatch: Boolean(scene.queryLabel)
    },
    exactGenreConflictDetected,
    catalogueQuality: {
      hard: true,
      passed: !catalogueReason,
      reason: catalogueReason,
      evidence: catalogueReason ? [catalogueReason] : []
    },
    identityCorrectness: {
      hard: true,
      passed: !identityReason,
      reason: identityReason,
      evidence: identityReason ? [identityReason] : []
    },
    genreLaneCompatibility: {
      hard: true,
      passed: !genreReason,
      reason: genreReason,
      confidence: Number(genreInference.confidence || 0),
      evidence: genreInference.evidence || [],
      canonicalOfficialMatch: genreValuesMatchTarget(trackGenreValues(track), profile.targetGenres || [])
    },
    vibeMoodCompatibility: {
      // Vibe is intentionally diagnostic/ranking evidence only. It never
      // overrides the catalogue-quality, identity, genre, or duration gates.
      hard: false,
      passed: !profile.vibeTerms?.length || Boolean(vibeInference.corroboratesRequested),
      reason: profile.vibeTerms?.length && !vibeInference.corroboratesRequested
        ? "Vibe evidence is incomplete; retained as a soft ranking signal."
        : "",
      confidence: Number(vibeInference.confidence || 0),
      evidence: vibeInference.evidence || [],
      matchedTerms: vibeInference.matchedTerms || [],
      enforcement: "ranking-only"
    },
    durationConstraints: {
      hard: Boolean(durationConstraint),
      passed: !durationReason,
      reason: durationReason,
      constraint: durationConstraint
    },
    durationResult: {
      status: durationReason ? "failed" : "passed",
      reason: durationReason,
      constraint: durationConstraint,
      durationMs: Number(track.durationMs || track.tidal?.durationMs || 0) || null
    },
    scoreBeforeRejection: hasScoreBeforeRejection ? scoreBeforeRejection : null,
    rejectionStage,
    hardFailReason,
    hardFail: Boolean(decision.hardFail ?? [
      "catalogue-quality",
      "identity-correctness",
      "duration-constraints",
      "genre-lane-compatibility",
      "version-safety",
      "provider-safety"
    ].includes(rejectionStage))
  };
}

function hasSeedArtistMatch(track = {}, options = {}, profile = null) {
  const seedKeys = new Set((profile?.seedArtists || extractSeedArtists(options)).map(artistIdentityKey));
  if (!seedKeys.size) return false;
  return artistKeysForCandidate(track).some((artist) => seedKeys.has(artist));
}

function requestedLabelMatch(track = {}, profile = {}) {
  const label = labelText(track);
  if (!label || !profile.requestedLabels?.length) return "";
  return profile.requestedLabels.find((requested) => entityEvidenceMatches(label, requested)) || "";
}

function lengthPreferenceIsRelevant(options = {}, profile = {}) {
  if (wantsLongTracks(options)) return true;
  if (profile.isProgressiveTarget) return true;
  // A neutral standby taste reservoir is still primarily electronic/catalog
  // discovery in this app. Its operational wording is intentionally removed
  // from vibe parsing, so preserve the normal dance-track length signal here
  // without turning "long" or "underground" into a searchable vibe.
  if (profile.tasteProfileLed && /\bstandby\s+pool\b/i.test(String(options.request || ""))) return true;
  const text = normalize([
    options.request,
    options.genres,
    options.mood,
    profile.targetGenres?.join(" "),
    profile.vibeTerms?.join(" ")
  ].filter(Boolean).join(" "));
  return /\b(?:house|techno|trance|breaks|breakbeat|ambient|downtempo|electronic|cinematic|driving|hypnotic|journey|club|dj|mix)\b/.test(text);
}

function recentScrobbleMatchFor(track = {}, scrobbleHistory = null) {
  if (!scrobbleHistory?.checked || scrobbleHistory.error || scrobbleHistory.usernameValid === false) return null;
  const tracksByKey = scrobbleHistory.tracksByKey || {};
  return candidateIdentityKeys(track)
    .map((key) => tracksByKey[key])
    .find(Boolean) || null;
}

function topLastFmArtistMatchFor(track = {}, scrobbleHistory = null) {
  if (!scrobbleHistory?.checked || scrobbleHistory.error || scrobbleHistory.usernameValid === false) return null;
  const topArtistsByKey = scrobbleHistory.topArtistsByKey || {};
  for (const artist of splitArtists(track.artist)) {
    const key = artistIdentityKey(artist);
    if (key && topArtistsByKey[key]) return topArtistsByKey[key];
    const looseKey = normalize(artist);
    if (!isCollisionSensitiveArtist(artist) && looseKey && topArtistsByKey[looseKey]) return topArtistsByKey[looseKey];
  }
  return null;
}

function profileSeedArtistMatch(track = {}, profile = {}) {
  const seedKeys = new Set((profile.seedArtists || []).map(artistIdentityKey));
  if (!seedKeys.size) return false;
  return artistKeysForCandidate(track).some((artist) => seedKeys.has(artist));
}

function lastFmAdjustmentFor(track = {}, scrobbleHistory = null, profile = {}) {
  const reasons = [];
  if (
    !scrobbleHistory?.checked ||
    scrobbleHistory.error ||
    scrobbleHistory.enabled === false ||
    !scrobbleHistory.configured ||
    scrobbleHistory.usernameValid === false ||
    profile.scoringMode === "pure"
  ) {
    return { value: 0, reasons, recentRepeat: false };
  }

  let value = 0;
  const recent = recentScrobbleMatchFor(track, scrobbleHistory);
  if (recent) {
    const plays = Math.max(1, Number(recent.plays || 1));
    const penalty = recent.nowPlaying ? -10 : -Math.min(10, 5 + plays);
    value += penalty;
    reasons.push(recent.nowPlaying
      ? `currently scrobbling on Last.fm ${penalty}`
      : `recent Last.fm repeat ${penalty}`);
  }

  const topArtist = topLastFmArtistMatchFor(track, scrobbleHistory);
  if (topArtist && !recent) {
    const rank = Math.max(1, Number(topArtist.rank || 99));
    let boost = rank <= 10 ? 3 : (rank <= 25 ? 2 : 1);

    if (profile.scoringMode === "similar") {
      boost = Math.min(4, boost + 1);
    } else if (profile.scoringMode === "explore") {
      boost = profileSeedArtistMatch(track, profile) ? 0 : -2;
    } else if (profile.scoringMode === "taste-guided" && profile.hasExplicitDiscoveryIntent) {
      boost = Math.min(boost, 1);
    } else if (profile.isGenreDiscoveryTarget && !profile.isProgressiveTarget) {
      boost = Math.min(boost, 1);
    }

    if (boost) {
      value += boost;
      reasons.push(boost > 0
        ? `long-term Last.fm artist ${topArtist.artist || track.artist} rank ${rank} +${boost}`
        : `known Last.fm artist held back for Explore Mode ${boost}`);
    }
  }

  return { value, reasons, recentRepeat: Boolean(recent) };
}

function exploratoryLaneSignal(track = {}) {
  const text = normalize(`${track.discoverySource || ""} ${track.discoveryLane || ""}`);
  return /\b(?:adjacent|branch|similar|radio|remix|remixer|label|crawl|explor|discovery|seed vibe)\b/.test(text);
}

function verifiedCatalogueSignal(track = {}) {
  const statusText = Array.isArray(track.statusChecks) ? track.statusChecks.join(" ") : "";
  const verificationText = normalize(`${track.verificationSource || ""} ${statusText}`);
  return Boolean(
    track.tidal?.tidalUrl ||
    track.tidalUrl ||
    track.tidal?.id ||
    track.roon?.verified ||
    /\b(?:tidal|roon)\b/.test(verificationText)
  );
}

function serendipityBaseAdjustmentFor(track = {}, options = {}, profile = {}, components = {}) {
  const reasons = [];
  if (profile.scoringMode === "pure" || profile.scoringMode === "similar") return { value: 0, reasons };
  if (!verifiedCatalogueSignal(track) || isShortEdit(track)) return { value: 0, reasons };
  if (Number(components.tasteAdjustment || 0) < 0 || Number(components.calibrationAdjustment || 0) < 0) {
    return { value: 0, reasons };
  }

  const minutes = durationMinutes(track);
  const strongLength = Boolean((minutes >= 5 && minutes <= 10.5) || Number(components.lengthPreference || 0) >= 8);
  const genreConfidence = Number(components.genreInference?.confidence || 0);
  const scene = sceneEvidenceFor(track, track.query, options, profile);
  const sceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(labelText(track), profile) : "";
  const sceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.artist, profile) : "";
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)} ${track.query}`);
  const metadataTarget = hasAnyTerm(metadataText, profile.targetGenres || []) || Boolean(components.vibeInference?.corroboratesRequested);
  const requestedLabel = requestedLabelMatch(track, profile);
  const sceneSignal = Boolean(
    sceneLabel ||
    sceneArtist ||
    scene.labelSeed ||
    scene.metadataTarget ||
    scene.metadataAdjacent ||
    requestedLabel
  );
  const exploratory = exploratoryLaneSignal(track);
  const credibleSignal = Boolean(
    sceneSignal ||
    metadataTarget ||
    genreConfidence >= 35 ||
    (exploratory && (profile.targetGenres || []).length)
  );
  const sparseMetadata = Boolean(
    Number(components.freshness || 0) <= 6 ||
    Number(components.labelMatch || 0) <= 7 ||
    Number(components.genreMatch || 0) < 14 ||
    !labelText(track)
  );

  if (!strongLength || !credibleSignal || !sparseMetadata) return { value: 0, reasons };

  let value = 2;
  reasons.push("verified long-format long shot");

  if (sceneSignal) {
    value += 3;
    reasons.push(sceneLabel || sceneArtist || requestedLabel || "scene signal");
  }
  if (exploratory) {
    value += 2;
    reasons.push("exploratory branch source");
  }
  if (genreConfidence >= 35 || metadataTarget) {
    value += 1;
    reasons.push("genre context despite sparse metadata");
  }
  if (Number(components.artistMatch || 0) <= 5 && Number(components.labelMatch || 0) <= 7) {
    value += 1;
    reasons.push("fresh artist/label discovery");
  }

  return {
    value: clamp(value, 0, profile.scoringMode === "explore" ? 10 : 8),
    reasons: reasons.slice(0, 4)
  };
}

function scoreBreakdownFor(track = {}, options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), scrobbleHistory = null) {
  const yearRange = parseYearRange(options);
  const wanted = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const queryText = normalize(track.query);
  const text = normalize(`${metadataText} ${queryText}`);
  const sceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.artist, profile) : "";
  const sceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(labelText(track), profile) : "";
  const sceneEvidence = profile.targetGenres.length ? sceneEvidenceFor(track, track.query, options, profile) : {};
  const genreInference = profile.targetGenres.length
    ? genreInferenceFor(track, track.query, options, profile, tasteProfile)
    : { confidence: 0, inferredGenres: [], evidence: [], summary: "", weakOfficialGenre: false, queryOnly: false, corroboratesRequested: true };
  const vibeInference = profile.vibeTerms.length
    ? vibeInferenceFor(track, track.query, profile)
    : { confidence: 0, evidence: [], summary: "", queryOnly: false, corroboratesRequested: true, matchedTerms: [] };
  const promptIntentEvidence = promptIntentEvidenceFor(track, track.query, profile);
  const tasteAnchor = tasteAnchorEvidenceFor(track, options, profile);
  const minutes = durationMinutes(track);
  const currentYear = new Date().getFullYear();
  const prefersExtendedMixes = requestPrefersExtendedMixes(options);
  const hasExtendedMix = hasExtendedMixText(`${track.title || ""} ${track.album || ""}`);

  let freshness = 0;
  if (yearRange) {
    freshness = yearRange.dateSpecific
      ? (track.releaseDate && releaseDateFits(track.releaseDate, yearRange) && hasCanonicalReleaseForRange(track, yearRange) ? SCORE_MAX.freshness : 0)
      : (track.year && yearFits(track.year, yearRange, track.releaseDate) && hasCanonicalReleaseForRange(track, yearRange) ? SCORE_MAX.freshness : 0);
  } else if (track.year) {
    const age = currentYear - Number(track.year);
    if (age <= 0) freshness = SCORE_MAX.freshness;
    else if (age === 1) freshness = 18;
    else if (age === 2) freshness = 16;
    else if (age <= 4) freshness = 13;
    else if (age <= 8) freshness = 9;
    else freshness = 6;
  } else {
    freshness = 4;
  }

  let labelMatch = 0;
  const requestedLabel = requestedLabelMatch(track, profile);
  if (requestedLabel) labelMatch = SCORE_MAX.labelMatch;
  else if (sceneLabel) labelMatch = 17;
  else if (labelText(track)) labelMatch = profile.targetGenres.length || profile.requestedLabels.length ? 7 : 3;
  // In a plain taste-profile request, an artist or label selected as a
  // retrieval anchor is real evidence of personal relevance. Keep it softer
  // than an explicitly requested artist/label, but do not score the result as
  // if it came from an unrelated catalogue query.
  if (tasteAnchor.learnedLabel) labelMatch = Math.max(labelMatch, 14);
  else if (tasteAnchor.relatedLabel) labelMatch = Math.max(labelMatch, 10);
  if (sceneLabel && wanted.includes(normalize(sceneLabel))) labelMatch += 2;
  if (profile.isGenreDiscoveryTarget && labelText(track)) {
    const seedLabel = genreLabelSeeds(profile).find((seed) => entityEvidenceMatches(labelText(track), seed));
    labelMatch = Math.max(labelMatch, seedLabel ? 16 : 6);
  }
  labelMatch = clamp(labelMatch, 0, SCORE_MAX.labelMatch);

  let artistMatch = 0;
  if (hasSeedArtistMatch(track, options, profile)) artistMatch = SCORE_MAX.artistMatch;
  else if (sceneArtist) artistMatch = 15;
  else if (wanted && splitArtists(track.artist).some((artist) => !isCollisionSensitiveArtist(artist) && wanted.includes(normalize(artist)))) artistMatch = 11;
  if (tasteAnchor.learnedArtist) artistMatch = Math.max(artistMatch, 17);
  else if (tasteAnchor.relatedArtist) artistMatch = Math.max(artistMatch, 13);
  if (profile.isGenreDiscoveryTarget && track.artist) {
    const seedArtist = sceneEvidence.artistAnchor && sceneEvidence.metadataSceneEvidence ? sceneEvidence.artistAnchor : "";
    artistMatch = Math.max(artistMatch, seedArtist ? 15 : 5);
  }
  artistMatch = clamp(artistMatch, 0, SCORE_MAX.artistMatch);

  let lengthPreference = 0;
  if (wantsLongTracks(options)) {
    if (minutes >= 8) lengthPreference = SCORE_MAX.lengthPreference;
    else if (minutes >= 7) lengthPreference = 16;
    else if (minutes >= 6) lengthPreference = 11;
    else if (minutes >= 4) lengthPreference = 7;
    else lengthPreference = 3;
  } else if (minutes) {
    if (lengthPreferenceIsRelevant(options, profile)) {
      if (minutes >= 5 && minutes <= 12) lengthPreference = SCORE_MAX.lengthPreference;
      else if (minutes >= 4) lengthPreference = 15;
      else if (minutes >= 3) lengthPreference = 10;
      else lengthPreference = 5;
    } else if (minutes >= 2 && minutes <= 8) {
      lengthPreference = 8;
    } else {
      lengthPreference = 5;
    }
  } else {
    lengthPreference = lengthPreferenceIsRelevant(options, profile) ? 7 : 4;
  }

  let versionPreferenceAdjustment = 0;
  const versionPreferenceReasons = [];
  if (prefersExtendedMixes) {
    if (hasExtendedMix) {
      lengthPreference = Math.max(lengthPreference, SCORE_MAX.lengthPreference);
      versionPreferenceAdjustment += 8;
      versionPreferenceReasons.push("extended/club version requested and found");
    } else if (minutes >= 7) {
      lengthPreference = Math.max(lengthPreference, 16);
      versionPreferenceAdjustment += 2;
      versionPreferenceReasons.push("long version fits extended-mix preference");
    } else if (minutes) {
      if (minutes < 4) {
        lengthPreference = Math.min(lengthPreference, 2);
        versionPreferenceAdjustment -= 14;
        versionPreferenceReasons.push("short base cut despite extended-mix preference");
      } else if (minutes < 5) {
        lengthPreference = Math.min(lengthPreference, 5);
        versionPreferenceAdjustment -= 8;
        versionPreferenceReasons.push("base-length cut despite extended-mix preference");
      } else if (minutes < 6) {
        versionPreferenceAdjustment -= 3;
        versionPreferenceReasons.push("not clearly extended despite extended-mix preference");
      }
    } else {
      versionPreferenceAdjustment -= 2;
      versionPreferenceReasons.push("duration unknown for extended-mix preference");
    }
  }

  let genreMatch = 0;
  if (profile.targetGenres.length) {
    const adjacentTerms = adjacentLaneTerms(profile, options);
    if (hasAnyTerm(metadataText, profile.targetGenres)) genreMatch += profile.isGenreDiscoveryTarget ? 20 : 11;
    else if (track.discoveryLane === "adjacent" && hasAnyTerm(metadataText, adjacentTerms)) genreMatch += profile.isGenreDiscoveryTarget ? 13 : 8;
    else if (hasAnyTerm(queryText, profile.targetGenres)) genreMatch += profile.isGenreDiscoveryTarget ? 6 : 4;
    else if (track.discoveryLane === "adjacent" && hasAnyTerm(queryText, adjacentTerms)) genreMatch += profile.isGenreDiscoveryTarget ? 5 : 3;
  }
  if (profile.vibeTerms.length) {
    if (vibeInference.corroboratesRequested) {
      genreMatch += clamp(Math.round(Number(vibeInference.confidence || 0) / 10), 3, 10);
    } else if (vibeInference.queryOnly) {
      genreMatch += Math.min(2, Math.max(1, Math.round(Number(vibeInference.confidence || 0) / 20)));
    }
  }
  if (profile.promptIntent?.matchTerms?.length) {
    if (promptIntentEvidence.corroboratesRequested) {
      genreMatch += clamp(Math.round(Number(promptIntentEvidence.confidence || 0) / (profile.targetGenres.length ? 16 : 5)), 3, profile.targetGenres.length ? 8 : 18);
    } else if (promptIntentEvidence.queryOnly) {
      genreMatch += 2;
    }
  }
  if (profile.isOmnivoreDiscovery) {
    const omnivoreBridge = omnivoreBridgeEvidenceFor(track, track.query, options, profile);
    genreMatch += omnivoreBridge.corroborates
      ? omnivoreBridge.points
      : Math.min(2, omnivoreBridge.points);
  }
  if (!profile.targetGenres.length && wanted.includes("progressive")) genreMatch += 5;
  if (sceneArtist) genreMatch += 6;
  if (sceneLabel) genreMatch += 4;
  if (profile.isProgressiveTarget && /\bprogressive\b/.test(text)) genreMatch += 5;
  if (profile.isProgressiveTarget && /\bmelodic\b/.test(text)) genreMatch += 3;
  if (profile.isProgressiveTarget && /\bdeep\b/.test(text)) genreMatch += 3;
  if (profile.isProgressiveTarget && /\borganic\b/.test(text)) genreMatch += 2;
  if (wanted.includes("hypnotic") && /\b(?:hypnotic|deep|dub|journey|extended)\b/.test(metadataText)) genreMatch += 2;
  if (wanted.includes("driving") && /\b(?:driving|club|extended|peak|energy)\b/.test(metadataText)) genreMatch += 2;
  if (profile.isGenreDiscoveryTarget && hasAnyTerm(text, profile.targetGenres)) genreMatch += 5;
  if (profile.targetGenres.length) {
    const inferredPoints = Math.round((Number(genreInference.confidence || 0) / 100) * SCORE_MAX.genreMatch);
    genreMatch = Math.max(genreMatch, inferredPoints);
  }
  genreMatch = clamp(genreMatch, 0, SCORE_MAX.genreMatch);

  const taste = typeof tasteProfile?.adjustmentFor === "function"
    ? tasteProfile.adjustmentFor(track)
    : { value: 0, reasons: [] };
  const lastfmTaste = lastFmAdjustmentFor(track, scrobbleHistory, profile);
  const calibrationTrack = {
    ...track,
    discoverySource: track.discoverySource || discoverySourceForResult(track, options),
    discoveryLane: track.discoveryLane || "core"
  };
  const calibration = typeof tasteProfile?.calibrationAdjustmentFor === "function"
    ? tasteProfile.calibrationAdjustmentFor(calibrationTrack)
    : { value: 0, reasons: [] };
  let tasteMin = profile.isGenreDiscoveryTarget ? -4 : -12;
  let tasteMax = profile.isGenreDiscoveryTarget ? 6 : 12;
  if (profile.scoringMode === "taste-guided" && profile.hasExplicitDiscoveryIntent) tasteMax = Math.min(tasteMax, 4);
  // An explicit genre is a new search lane, not an instruction to discard
  // taste. Keep the familiar-artist/label boost bounded for that lane, but
  // reserve the smaller outside-taste cap for explicit branch-out/open
  // requests where the user is actively asking to leave the known cluster.
  if (profile.scoringMode === "taste-guided" &&
    profile.promptIntent?.allowOutsideTaste &&
    profile.promptIntent?.outsideTasteMode !== "genre-lane") {
    tasteMin = Math.max(tasteMin, -4);
    tasteMax = Math.min(tasteMax, 2);
  }
  let tasteAdjustment = clamp(taste.value || 0, tasteMin, tasteMax);
  if (profile.scoringMode === "pure") {
    tasteMin = 0;
    tasteMax = 0;
    tasteAdjustment = 0;
  } else if (profile.scoringMode === "explore") {
    tasteMin = -8;
    tasteMax = 0;
    const value = Number(taste.value || 0);
    tasteAdjustment = value > 0
      ? clamp(-Math.ceil(value * 0.75), tasteMin, tasteMax)
      : clamp(value, -6, 0);
  } else if (profile.scoringMode === "similar") {
    tasteMin = -12;
    tasteMax = 12;
    tasteAdjustment = clamp(taste.value || 0, tasteMin, tasteMax);
  }

  if (lastfmTaste.value < 0) tasteMin = Math.min(tasteMin, -10);
  tasteAdjustment += lastfmTaste.value;
  const relatedTasteReasons = [];
  if (profile.tasteProfileLed && tasteAnchor.relatedArtist) {
    const relatedBoost = clamp(Math.round(2 + Number(tasteAnchor.relatedArtistSimilarity || 0.5) * 4), 2, 6);
    tasteAdjustment += relatedBoost;
    relatedTasteReasons.push(`${tasteAnchor.relatedArtist} related-artist evidence +${relatedBoost}`);
  }

  if (isShortEdit(track)) {
    lengthPreference = Math.min(lengthPreference, 4);
    tasteAdjustment -= 6;
  }
  if (isReissueLike(track)) freshness = Math.min(freshness, 4);
  if (/\b(?:radio|festival|big room|edm|pop dance)\b/.test(text)) genreMatch = Math.max(0, genreMatch - 10);

  tasteAdjustment = clamp(tasteAdjustment, tasteMin, tasteMax);
  const calibrationAdjustment = clamp(calibration.value || 0, -10, 0);
  const baseSerendipity = serendipityBaseAdjustmentFor(track, options, profile, {
    freshness,
    labelMatch,
    artistMatch,
    lengthPreference,
    genreMatch,
    genreInference,
    vibeInference,
    promptIntentEvidence,
    tasteAnchor,
    tasteAdjustment,
    calibrationAdjustment
  });
  const learnedSerendipity = typeof tasteProfile?.serendipityAdjustmentFor === "function"
    ? tasteProfile.serendipityAdjustmentFor(calibrationTrack)
    : { value: 0, reasons: [] };
  const serendipityAdjustment = clamp(
    Number(baseSerendipity.value || 0) + Number(learnedSerendipity.value || 0),
    0,
    profile.scoringMode === "explore" ? 10 : 8
  );
  const categoryTotal = freshness + labelMatch + artistMatch + lengthPreference + genreMatch;
  versionPreferenceAdjustment = clamp(versionPreferenceAdjustment, -16, 8);
  const total = clamp(categoryTotal + tasteAdjustment + calibrationAdjustment + serendipityAdjustment + versionPreferenceAdjustment, 1, 100);
  const baseBreakdown = {
    total,
    freshness,
    labelMatch,
    artistMatch,
    lengthPreference,
    genreMatch,
    genreInference,
    vibeInference,
    promptIntentEvidence,
    tasteAnchorEvidence: tasteAnchor,
    tasteAdjustment,
    tasteReasons: [...(taste.reasons || []), ...lastfmTaste.reasons, ...relatedTasteReasons],
    lastfmAdjustment: lastfmTaste.value,
    lastfmReasons: lastfmTaste.reasons,
    lastfmRecentRepeat: lastfmTaste.recentRepeat,
    calibrationAdjustment,
    calibrationReasons: calibration.reasons || [],
    versionPreferenceAdjustment,
    versionPreferenceReasons,
    serendipityAdjustment,
    serendipityReasons: [
      ...(baseSerendipity.reasons || []),
      ...(learnedSerendipity.reasons || [])
    ],
    max: SCORE_MAX
  };
  const matchExplanation = matchExplanationFor(track, options, baseBreakdown, profile);

  return {
    ...baseBreakdown,
    promptMatch: matchExplanation.prompt,
    tasteMatch: matchExplanation.taste,
    matchGenre: matchExplanation.genre,
    matchWhy: matchExplanation.why
  };
}

function scoreTrack(track = {}, options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), scrobbleHistory = null) {
  return scoreBreakdownFor(track, options, tasteProfile, profile, scrobbleHistory).total;
}

function reasonFor(track = {}, options = {}, breakdown = null, profile = buildDiscoveryProfile(options)) {
  const score = breakdown || scoreBreakdownFor(track, options, null, profile);
  const parts = [];
  const minutes = durationMinutes(track);
  const sceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.artist, profile) : "";
  const sceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(labelText(track), profile) : "";
  const metadataText = `${track.artist} ${track.title} ${track.album} ${labelText(track)}`;
  const releaseValue = releaseValueForDisplay(track);
  if (releaseValue) parts.push(`${releaseValue} TIDAL release`);
  if (sceneLabel) parts.push(`${sceneLabel} label fit`);
  if (sceneArtist) parts.push(`${sceneArtist} sits in the requested progressive lane`);
  if (score.genreInference?.summary && Number(score.genreInference.confidence || 0) >= 35) {
    parts.push(`genre inferred from ${score.genreInference.summary}`);
  }
  if (score.promptIntentEvidence?.summary && Number(score.promptIntentEvidence.confidence || 0) >= 35) {
    parts.push(`prompt evidence from ${score.promptIntentEvidence.summary}`);
  }
  if (score.vibeInference?.summary && Number(score.vibeInference.confidence || 0) >= 25) {
    parts.push(`trait evidence from ${score.vibeInference.summary}`);
  } else if (score.vibeInference?.queryOnly) {
    parts.push("trait words only found in search query");
  }
  if (score.tasteAnchorEvidence?.learnedArtist) parts.push(`learned taste artist anchor: ${score.tasteAnchorEvidence.learnedArtist}`);
  else if (score.tasteAnchorEvidence?.learnedLabel) parts.push(`learned taste label anchor: ${score.tasteAnchorEvidence.learnedLabel}`);
  else if (score.tasteAnchorEvidence?.relatedArtist) parts.push(`related-artist taste branch: ${score.tasteAnchorEvidence.relatedArtist}`);
  if (!sceneArtist && hasAnyTerm(`${metadataText} ${track.query}`, profile.targetGenres)) parts.push(`${profile.targetGenres[0]} target fit`);
  if (track.discoveryLane === "adjacent") parts.push("adjacent-lane discovery");
  if (track.discoveryLane === "omnivore") parts.push("cross-genre taste-bridge discovery");
  if (track.discoveryLane === "recent") parts.push("recent-year fallback");
  if (hasAnyTerm(`${metadataText} ${track.query}`, profile.vibeTerms)) parts.push(`${profile.vibeTerms[0]} seed-vibe fit`);
  if (requestPrefersExtendedMixes(options) && score.versionPreferenceAdjustment > 0) parts.push("extended/long version preference");
  else if (requestPrefersExtendedMixes(options) && score.versionPreferenceAdjustment < 0) parts.push("base cut downweighted against extended preference");
  if (minutes) parts.push(`${minutes.toFixed(1)} min`);
  const lastfmReasons = score.lastfmReasons || [];
  if (lastfmReasons.some((reason) => /long-term Last\.fm/i.test(reason))) parts.push("light Last.fm long-term artist signal");
  else if (score.tasteAdjustment > 0) parts.push("boosted by your thumbs-up history");
  if (lastfmReasons.some((reason) => /recent Last\.fm repeat|currently scrobbling/i.test(reason))) parts.push("downweighted recent Last.fm repeat");
  else if (score.tasteAdjustment < 0) parts.push("penalized by your thumbs-down history");
  if (score.calibrationAdjustment < 0) parts.push("downweighted by feedback calibration");
  if (score.serendipityAdjustment > 0) parts.push("lifted by long-shot serendipity signals");
  const text = normalize(`${track.title} ${track.album} ${track.query}`);
  if (text.includes("melodic")) parts.push(profile.isProgressiveTarget ? "melodic/progressive signal" : "melodic signal");
  if (text.includes("deep")) parts.push(profile.isProgressiveTarget ? "deep progressive signal" : "deep signal");
  if (!parts.length) parts.push("catalogue match from TIDAL search");
  return parts.slice(0, 4).join("; ");
}

function hasArtistMatch(value, artist) {
  return artistMatchesKnownName(value, artist);
}

function discoverySourceForArtist(artist, options = {}, tasteProfile = null) {
  if (hasArtistMatch(options.nowPlaying?.artist, artist)) return "Recently played seed";
  if (extractSeedArtists(options).some((seed) => artistNamesMatch(seed, artist))) return "Artist expansion";
  if (artistMatchesSeedList(artist, optionValues(options, ["radioArtistSeeds", "artistRadioSeeds"]))) return "Radio branch artist";
  if (artistMatchesSeedList(artist, optionValues(options, ["remixerSeeds", "remixArtistSeeds"]))) return "Remixer branch artist";
  if (artistMatchesSeedList(artist, extractRemixerSeedsFromText(`${options.request || ""} ${options.reference || ""} ${options.nowPlaying?.title || ""}`))) return "Remixer branch artist";
  if (artistMatchesSeedList(artist, optionValues(options, ["similarArtistSeeds", "branchArtistSeeds", "relatedArtistSeeds"]))) return "Similar artist branch";
  const learned = typeof tasteProfile?.getTopArtists === "function" ? tasteProfile.getTopArtists(12) : [];
  if (learned.some((seed) => artistNamesMatch(seed, artist))) return "Liked artist expansion";
  return "Similar artist";
}

function discoverySourceForResult(track = {}, options = {}) {
  const query = normalize(track.query);
  if (splitArtists(options.nowPlaying?.artist).some((artist) => !isCollisionSensitiveArtist(artist) && query.includes(normalize(artist)))) {
    return "Recently played seed";
  }
  if (extractSeedArtists(options).some((artist) => !isCollisionSensitiveArtist(artist) && query.includes(normalize(artist)))) {
    return "Artist expansion";
  }
  const radioSeeds = optionValues(options, ["radioArtistSeeds", "artistRadioSeeds"]);
  if (artistMatchesSeedList(track.artist, radioSeeds) || textMentionsSeed(query, radioSeeds)) {
    return "Radio branch artist";
  }
  const remixerSeeds = [
    ...optionValues(options, ["remixerSeeds", "remixArtistSeeds"]),
    ...extractRemixerSeedsFromText(`${options.request || ""} ${options.reference || ""} ${options.nowPlaying?.title || ""}`)
  ];
  if (artistMatchesSeedList(track.artist, remixerSeeds) || textMentionsSeed(query, remixerSeeds)) {
    return "Remixer branch artist";
  }
  const similarSeeds = optionValues(options, ["similarArtistSeeds", "branchArtistSeeds", "relatedArtistSeeds"]);
  if (artistMatchesSeedList(track.artist, similarSeeds) || textMentionsSeed(query, similarSeeds)) {
    return "Similar artist branch";
  }
  if (matchingSceneArtist(track.artist)) return "Similar artist";
  return "TIDAL search";
}

function discoveryQuotaBucket(track = {}, profile = {}) {
  const lane = normalize(track.discoveryLane);
  const source = normalize(track.discoverySource);
  if (lane.includes("omnivore") || source.includes("omnivore") || source.includes("taste bridge")) return "omnivore";
  if (lane.includes("adjacent")) return "adjacent";
  if (lane.includes("recent") || source.includes("fallback")) return "recent";
  if (lane.includes("expanded") || lane.includes("relaxed") || track.autoBroadened) return "expanded";
  if (lane.includes("branch") || source.includes("similar artist") || source.includes("radio branch") || source.includes("remixer branch") || source.includes("branch source")) {
    return profile.scoringMode === "similar" ? "taste" : "branch";
  }
  if (source.includes("liked artist") || source.includes("artist expansion") || source.includes("recently played seed")) {
    return "taste";
  }
  if (labelText(track) && (source.includes("tidal search") || source.includes("local model") || source.includes("catalogue"))) {
    return "label";
  }
  return "core";
}

function omnivoreLaneKeyForCandidate(candidate = {}) {
  return cleanText(
    candidate.discoveryOmnivoreLane ||
    candidate.omnivoreLane ||
    candidate.tidal?.discoveryOmnivoreLane ||
    candidate.tidal?.omnivoreLane ||
    ""
  );
}

function discoveryLaneQuotaPlan(requestedCount = 8, profile = {}) {
  const count = Math.max(1, Math.min(40, Number(requestedCount || 8)));
  const explore = profile.scoringMode === "explore";
  const similar = profile.scoringMode === "similar";
  const pure = profile.scoringMode === "pure";
  const discoveryFirst = !pure && !similar && Boolean(profile.hasExplicitDiscoveryIntent || profile.promptIntent?.hasIntent);
  const smallDiscoveryRequest = count >= 5 && count < 8 && !pure && !similar && Boolean(profile.targetGenres?.length || profile.vibeTerms?.length);
  const tasteTarget = pure ? 0 : (similar
    ? Math.max(1, Math.floor(count * 0.3))
    : (discoveryFirst ? (count >= 12 ? 1 : 0) : (smallDiscoveryRequest ? 1 : (count >= 8 ? 1 : 0))));
  const tasteMax = pure ? 0 : (similar
    ? Math.max(2, Math.ceil(count * 0.6))
    : (discoveryFirst ? Math.max(1, Math.ceil(count * 0.12)) : Math.max(1, Math.ceil(count * (explore ? 0.2 : 0.22)))));
  const targets = {
    core: count >= 8 ? Math.max(2, Math.floor(count * (explore ? 0.35 : 0.45))) : Math.max(1, Math.ceil(count * 0.6)),
    omnivore: profile.isOmnivoreDiscovery ? (count >= 8 ? Math.max(2, Math.ceil(count * 0.28)) : Math.max(1, Math.ceil(count * 0.35))) : 0,
    adjacent: count >= 8 ? Math.max(1, Math.floor(count * (explore ? 0.22 : 0.16))) : ((explore && count >= 5) || smallDiscoveryRequest ? 1 : 0),
    label: count >= 8 ? 1 : (smallDiscoveryRequest ? 1 : 0),
    branch: !pure && !similar && count >= 8 ? Math.max(1, Math.floor(count * (explore ? 0.18 : 0.14))) : (smallDiscoveryRequest ? 1 : 0),
    taste: tasteTarget,
    expanded: count >= 12 ? 1 : 0,
    recent: 0
  };
  const max = {
    core: profile.isOmnivoreDiscovery ? Math.max(targets.core, Math.ceil(count * 0.45)) : count,
    omnivore: profile.isOmnivoreDiscovery ? Math.max(targets.omnivore, Math.ceil(count * 0.55)) : 0,
    adjacent: Math.max(targets.adjacent, Math.ceil(count * (explore ? 0.4 : 0.3))),
    label: Math.max(targets.label, Math.ceil(count * 0.35)),
    branch: pure ? 0 : Math.max(targets.branch, Math.ceil(count * (explore ? 0.32 : 0.28))),
    taste: Math.max(targets.taste, tasteMax),
    expanded: Math.max(targets.expanded, Math.ceil(count * 0.25)),
    recent: Math.max(1, Math.ceil(count * 0.15))
  };
  return { targets, max };
}

function calibrationBucketRisk(entry = {}) {
  if (!entry) return 0;
  const total = Number(entry.total || 0);
  const misses = Number(entry.modelMisses || 0);
  const badBoosts = Number(entry.badBoosts || 0);
  const promptMismatches = Number(entry.promptMismatches || 0);
  if (!total || !misses) return 0;

  const missRate = misses / total;
  let risk = misses >= 1 ? 1 : 0;
  if (total >= 2 && missRate >= CALIBRATION_QUOTA_RISK.moderateMissRate) risk += 1;
  if (total >= 3 && missRate >= CALIBRATION_QUOTA_RISK.highMissRate) risk += 1;
  if (badBoosts >= CALIBRATION_QUOTA_RISK.repeatIssueThreshold || promptMismatches >= CALIBRATION_QUOTA_RISK.repeatIssueThreshold) risk += 1;
  return Math.max(0, Math.min(CALIBRATION_QUOTA_RISK.maxBucketRisk, risk));
}

function findCalibrationEntry(items = [], key = "", property = "name") {
  const wanted = normalize(key);
  if (!wanted) return null;
  return (items || []).find((item) => normalize(item[property] || item.name) === wanted) || null;
}

function candidateCalibrationRisk(candidate = {}, calibration = null) {
  if (!calibration) return { value: 0, reasons: [] };
  const checks = [
    ["source", findCalibrationEntry(calibration.sources, candidate.discoverySource || "TIDAL search", "source"), 1],
    ["lane", findCalibrationEntry(calibration.lanes, candidate.discoveryLane || "core", "lane"), 0.75],
    ["label", findCalibrationEntry(calibration.labels, labelText(candidate), "label"), 1.25]
  ];
  let value = 0;
  const reasons = [];

  for (const [kind, entry, weight] of checks) {
    const risk = calibrationBucketRisk(entry);
    if (!risk) continue;
    const weighted = Math.max(1, Math.round(risk * weight));
    value += weighted;
    const name = entry.source || entry.lane || entry.label || entry.name || kind;
    const issues = calibrationIssueCount(entry);
    const detail = calibrationIssueDetail(entry);
    reasons.push(`${kind} ${name} ${issues}/${entry.total} issues${detail ? ` (${detail})` : ""}`);
  }

  return {
    value: Math.max(0, Math.min(CALIBRATION_QUOTA_RISK.maxCandidateRisk, value)),
    reasons: reasons.slice(0, 4)
  };
}

function calibrationAwareQuotaPlan(basePlan = {}, buckets = new Map(), profile = {}, calibration = null) {
  const targets = { ...(basePlan.targets || {}) };
  const max = { ...(basePlan.max || {}) };
  const risk = {};
  const adjustments = [];

  if (!calibration) return { targets, max, risk, adjustments };

  for (const [bucket, items] of buckets.entries()) {
    if (!items?.length) continue;
    const candidateRisks = items.map((candidate) => candidateCalibrationRisk(candidate, calibration).value);
    const maxRisk = Math.max(0, ...candidateRisks);
    const averageRisk = candidateRisks.reduce((sum, value) => sum + value, 0) / candidateRisks.length;
    const bucketRisk = Math.round(Math.max(maxRisk, averageRisk * 1.5));
    if (!bucketRisk) continue;

    risk[bucket] = {
      value: bucketRisk,
      average: Number(averageRisk.toFixed(2)),
      max: maxRisk
    };

    const originalTarget = Number(targets[bucket] || 0);
    const originalMax = Number(max[bucket] ?? 0);
    let nextTarget = originalTarget;
    let nextMax = originalMax;

    if (bucketRisk >= 5) {
      nextTarget = bucket === "core" ? Math.min(originalTarget, 1) : 0;
      nextMax = bucket === "core" ? Math.max(nextTarget, Math.ceil(originalMax * 0.5)) : nextTarget;
    } else if (bucketRisk >= 3) {
      nextTarget = Math.max(bucket === "core" ? 1 : 0, originalTarget - 1);
      nextMax = Math.max(nextTarget, originalMax - 1);
    } else if (bucketRisk >= 2 && originalTarget > 1) {
      nextTarget = originalTarget - 1;
    }

    targets[bucket] = nextTarget;
    max[bucket] = nextMax;
    if (nextTarget !== originalTarget || nextMax !== originalMax) {
      adjustments.push({
        bucket,
        risk: bucketRisk,
        target: originalTarget,
        adjustedTarget: nextTarget,
        max: originalMax,
        adjustedMax: nextMax
      });
    }
  }

  return { targets, max, risk, adjustments };
}

function countObjectFromMap(map = new Map()) {
  const result = {};
  for (const [key, value] of map.entries()) result[key] = value;
  return result;
}

function withQuotaBucket(track = {}, bucket = "core", risk = null) {
  return {
    ...track,
    discoveryQuotaBucket: bucket,
    ...(risk?.value ? {
      discoveryQuotaRisk: risk.value,
      discoveryQuotaRiskReasons: risk.reasons || []
    } : {})
  };
}

function selectDiscoveryLaneCandidates(candidates = [], requestedCount = 8, options = {}, profile = buildDiscoveryProfile(options), calibration = null) {
  const limit = Math.max(0, Math.min(40, Number(requestedCount || 0)));
  const avoidRepeatedArtists = exploreAvoidsRepeatedArtists(options, profile);
  const allowRepeatFallback = allowsArtistRepeatFallback(options, profile);
  const riskCache = new WeakMap();
  function riskFor(candidate = {}) {
    if (!candidate || typeof candidate !== "object") return { value: 0, reasons: [] };
    if (!riskCache.has(candidate)) riskCache.set(candidate, candidateCalibrationRisk(candidate, calibration));
    return riskCache.get(candidate);
  }
  function quotaRank(candidate = {}) {
    const repeatedArtistPenalty = repeatedArtistDiversityPenaltyApplies(candidate, options, profile) ? 20 : 0;
    const recentNoveltyPenalty = Number(candidate.recentSuggestionPenalty || 0);
    return Number(candidate.score || 0) - (riskFor(candidate).value * CALIBRATION_QUOTA_RISK.scorePenaltyPerRiskPoint) - repeatedArtistPenalty - recentNoveltyPenalty;
  }
  const sorted = candidates.slice().sort((left, right) => (
    quotaRank(right) - quotaRank(left) ||
    Number(right.score || 0) - Number(left.score || 0) ||
    (right.durationMs || 0) - (left.durationMs || 0)
  ));
  const basePlan = discoveryLaneQuotaPlan(limit, profile);
  let plan = basePlan;
  const bucketOrder = ["core", "omnivore", "label", "adjacent", "branch", "taste", "expanded", "recent"];
  const selected = [];
  const selectedKeys = new Set();
  const artistCounts = new Map();
  const albumCounts = new Map();
  const labelCounts = new Map();
  const sourceCounts = new Map();
  const sourceLabels = new Map();
  const capHeldByKey = new Map();
  const bucketCounts = new Map();
  const availableCounts = new Map();
  const buckets = new Map(bucketOrder.map((bucket) => [bucket, []]));
  const maxPerPrimaryArtist = defaultPerRunArtistCap(options, profile, limit);
  const maxPerLabel = defaultPerRunLabelCap(options, profile, limit);
  const maxPerSource = defaultPerRunSourceCap(options, profile, limit);
  let effectiveLabelCap = maxPerLabel;
  let effectiveSourceCap = maxPerSource;
  const maxPerOmnivoreLane = profile.isOmnivoreDiscovery
    ? Math.max(2, Math.ceil(limit * 0.25))
    : Number.MAX_SAFE_INTEGER;
  const omnivoreLaneCounts = new Map();

  for (const candidate of sorted) {
    const bucket = discoveryQuotaBucket(candidate, profile);
    availableCounts.set(bucket, (availableCounts.get(bucket) || 0) + 1);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(candidate);
  }
  plan = calibrationAwareQuotaPlan(basePlan, buckets, profile, calibration);

  function hasSelected(candidate = {}) {
    const keys = candidateIdentityKeys(candidate);
    return keys.length && keys.some((key) => selectedKeys.has(key));
  }

  function capHoldIdentityPartFor(candidate = {}) {
    const identityKeys = candidateIdentityKeys(candidate);
    return identityKeys[0]
      || [
        normalize(candidate.artist),
        normalizeIdentityTitle(candidate.title),
        normalize(candidate.album),
        normalize(candidate.discoverySource),
        normalize(candidate.discoveryLane),
        normalize(candidate.query)
      ].filter(Boolean).join("|");
  }

  function capHoldCandidateLabel(candidate = {}) {
    return cleanText([candidate.artist, candidate.title].filter(Boolean).join(" - "))
      || cleanText(candidate.query)
      || "Unknown candidate";
  }

  function recordCapHold(candidate = {}, kind = "", capKey = "", label = "", cap = 0, count = 0, replace = false) {
    const identity = capHoldIdentityPartFor(candidate);
    const numericCap = Number(cap || 0);
    if (!identity || !kind || !capKey || !Number.isFinite(numericCap)) return;
    const key = `${kind}:${capKey}:${identity}`;
    const score = Number(candidate.score || 0);
    const existing = capHeldByKey.get(key);
    if (!replace && existing && Number(existing.score || 0) >= score) return;
    const cleanLabel = cleanText(label || capKey);
    capHeldByKey.set(key, {
      kind,
      key: capKey,
      identity,
      label: cleanLabel,
      candidate: capHoldCandidateLabel(candidate),
      score,
      bucket: discoveryQuotaBucket(candidate, profile),
      source: sourceDiversityLabelForCandidate(candidate) || cleanText(candidate.discoverySource || candidate.discoveryLane || ""),
      cap: numericCap,
      count: Number(count || 0),
      reason: cleanText(`${cleanLabel} ${kind} cap ${Number(count || 0)}/${numericCap}`)
    });
  }

  function clearCapHold(candidate = {}) {
    const identity = capHoldIdentityPartFor(candidate);
    if (!identity) return;
    for (const key of [...capHeldByKey.keys()]) {
      if (key.endsWith(`:${identity}`)) capHeldByKey.delete(key);
    }
  }

  function capHeldDiagnostics() {
    const items = [...capHeldByKey.values()].sort((left, right) => (
      Number(right.score || 0) - Number(left.score || 0) ||
      String(left.candidate || "").localeCompare(String(right.candidate || ""))
    ));
    const uniqueIdentities = new Set(items.map((item) => item.identity || item.candidate));
    return {
      total: uniqueIdentities.size,
      label: items.filter((item) => item.kind === "label").slice(0, 8),
      source: items.filter((item) => item.kind === "source").slice(0, 8)
    };
  }

  function auditFinalCapHolds() {
    for (const candidate of sorted) {
      if (hasSelected(candidate)) continue;
      const labelKey = labelDiversityKeyForCandidate(candidate, profile);
      const sourceKey = sourceDiversityKeyForCandidate(candidate);
      const labelCount = labelCounts.get(labelKey) || 0;
      const sourceCount = sourceCounts.get(sourceKey) || 0;
      if (labelKey && Number.isFinite(effectiveLabelCap) && labelCount >= effectiveLabelCap) {
        recordCapHold(candidate, "label", labelKey, labelText(candidate) || labelKey, effectiveLabelCap, labelCount, true);
      }
      if (sourceKey && Number.isFinite(effectiveSourceCap) && sourceCount >= effectiveSourceCap) {
        recordCapHold(candidate, "source", sourceKey, sourceDiversityLabelForCandidate(candidate) || sourceKey, effectiveSourceCap, sourceCount, true);
      }
    }
  }

  function addCandidate(candidate = {}, caps = {}) {
    if (selected.length >= limit || hasSelected(candidate)) return false;
    const bucket = discoveryQuotaBucket(candidate, profile);
    const bucketCap = caps.bucketMax ?? Number.MAX_SAFE_INTEGER;
    const bucketCount = bucketCounts.get(bucket) || 0;
    if (bucketCount >= bucketCap) return false;

    const artistKeys = artistKeysForCandidate(candidate);
    const albumKey = normalize(candidate.album);
    const labelKey = labelDiversityKeyForCandidate(candidate, profile);
    const sourceKey = sourceDiversityKeyForCandidate(candidate);
    const artistCap = caps.artistCap ?? maxPerPrimaryArtist;
    const albumCap = caps.albumCap ?? 1;
    const labelCap = caps.labelCap ?? maxPerLabel;
    const sourceCap = caps.sourceCap ?? maxPerSource;
    const omnivoreLane = bucket === "omnivore" ? omnivoreLaneKeyForCandidate(candidate) : "";
    const omnivoreLaneCap = caps.omnivoreLaneCap ?? maxPerOmnivoreLane;
    if (artistKeys.some((artistKey) => (artistCounts.get(artistKey) || 0) >= artistCap)) return false;
    if (albumKey && (albumCounts.get(albumKey) || 0) >= albumCap) return false;
    const labelCount = labelCounts.get(labelKey) || 0;
    const sourceCount = sourceCounts.get(sourceKey) || 0;
    if (labelKey && Number.isFinite(labelCap) && labelCount >= labelCap) {
      recordCapHold(candidate, "label", labelKey, labelText(candidate) || labelKey, labelCap, labelCount);
      return false;
    }
    if (sourceKey && Number.isFinite(sourceCap) && sourceCount >= sourceCap) {
      recordCapHold(candidate, "source", sourceKey, sourceDiversityLabelForCandidate(candidate) || sourceKey, sourceCap, sourceCount);
      return false;
    }
    if (omnivoreLane && (omnivoreLaneCounts.get(omnivoreLane) || 0) >= omnivoreLaneCap) return false;

    const keys = candidateIdentityKeys(candidate);
    for (const key of keys) selectedKeys.add(key);
    selected.push(withQuotaBucket(candidate, bucket, riskFor(candidate)));
    clearCapHold(candidate);
    for (const artistKey of artistKeys) {
      artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1);
    }
    if (albumKey) albumCounts.set(albumKey, (albumCounts.get(albumKey) || 0) + 1);
    if (labelKey) labelCounts.set(labelKey, (labelCounts.get(labelKey) || 0) + 1);
    if (sourceKey) {
      sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) || 0) + 1);
      if (!sourceLabels.has(sourceKey)) sourceLabels.set(sourceKey, sourceDiversityLabelForCandidate(candidate) || sourceKey);
    }
    bucketCounts.set(bucket, bucketCount + 1);
    if (omnivoreLane) omnivoreLaneCounts.set(omnivoreLane, (omnivoreLaneCounts.get(omnivoreLane) || 0) + 1);
    return true;
  }

  for (const bucket of bucketOrder) {
    const target = Math.min(plan.targets[bucket] || 0, buckets.get(bucket)?.length || 0);
    if (!target) continue;
    for (const candidate of buckets.get(bucket) || []) {
      if ((bucketCounts.get(bucket) || 0) >= target) break;
      addCandidate(candidate, { bucketMax: target });
    }
  }

  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const bucket of bucketOrder) {
      const bucketMax = plan.max[bucket] ?? limit;
      if ((bucketCounts.get(bucket) || 0) >= bucketMax) continue;
      for (const candidate of buckets.get(bucket) || []) {
        if (addCandidate(candidate, { bucketMax })) {
          progressed = true;
          break;
        }
      }
      if (selected.length >= limit) break;
    }
  }

  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    const bucket = discoveryQuotaBucket(candidate, profile);
    addCandidate(candidate, { bucketMax: plan.max[bucket] ?? limit });
  }

  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    const bucket = discoveryQuotaBucket(candidate, profile);
    if (bucket === "taste" && profile.scoringMode !== "similar") continue;
    addCandidate(candidate, { bucketMax: Number.MAX_SAFE_INTEGER });
  }

  let labelSourceRelaxed = 0;
  if (selected.length < limit) {
    const beforeRelax = selected.length;
    const relaxedLabelCap = Math.max(maxPerLabel, Math.ceil(limit * 0.55));
    const relaxedSourceCap = Math.max(maxPerSource, Math.ceil(limit * 0.75));
    effectiveLabelCap = relaxedLabelCap;
    effectiveSourceCap = relaxedSourceCap;
    for (const candidate of sorted) {
      if (selected.length >= limit) break;
      const bucket = discoveryQuotaBucket(candidate, profile);
      if (bucket === "taste" && profile.scoringMode !== "similar") continue;
      addCandidate(candidate, {
        bucketMax: Number.MAX_SAFE_INTEGER,
        labelCap: relaxedLabelCap,
        sourceCap: relaxedSourceCap
      });
    }
    labelSourceRelaxed = Math.max(0, selected.length - beforeRelax);
  }

  if (allowRepeatFallback) {
    const repeatFallbackNeeded = selected.length < limit;
    for (const candidate of sorted) {
      if (selected.length >= limit) break;
      addCandidate(candidate, {
        bucketMax: Number.MAX_SAFE_INTEGER,
        artistCap: Number.MAX_SAFE_INTEGER,
        albumCap: Number.MAX_SAFE_INTEGER,
        labelCap: Number.MAX_SAFE_INTEGER,
        sourceCap: Number.MAX_SAFE_INTEGER
      });
    }
    if (repeatFallbackNeeded) {
      effectiveLabelCap = Number.MAX_SAFE_INTEGER;
      effectiveSourceCap = Number.MAX_SAFE_INTEGER;
    }
  }

  auditFinalCapHolds();

  const alternates = sorted
    .filter((candidate) => !hasSelected(candidate))
    .map((candidate) => withQuotaBucket(candidate, discoveryQuotaBucket(candidate, profile), riskFor(candidate)));

  return {
    tracks: selected,
    alternates,
    quota: {
      enabled: true,
      requested: limit,
      artistCap: maxPerPrimaryArtist,
      labelCap: maxPerLabel,
      sourceCap: maxPerSource,
      labelSourceRelaxed,
      repeatFallbackAllowed: allowRepeatFallback,
      omnivoreLaneCap: profile.isOmnivoreDiscovery ? maxPerOmnivoreLane : 0,
      omnivoreLanes: countObjectFromMap(omnivoreLaneCounts),
      labels: countObjectFromMap(labelCounts),
      sources: countObjectFromMap(sourceCounts),
      sourceLabels: Object.fromEntries([...sourceLabels.entries()]),
      capHeld: capHeldDiagnostics(),
      targets: plan.targets,
      max: plan.max,
      baseTargets: basePlan.targets,
      baseMax: basePlan.max,
      calibrationRisk: plan.risk,
      calibrationAdjustments: plan.adjustments,
      selected: countObjectFromMap(bucketCounts),
      available: countObjectFromMap(availableCounts)
    }
  };
}

function scrobbleStatusFor(track = {}, scrobbleHistory = null) {
  if (!scrobbleHistory) return "Scrobble history not checked";
  if (scrobbleHistory.error) return "Last.fm history unavailable";
  if (scrobbleHistory.enabled === false) return "Last.fm lookup disabled";
  if (!scrobbleHistory.apiKeyConfigured) return "Last.fm API key missing";
  if (!scrobbleHistory.usernameConfigured) return "Last.fm username missing";
  if (scrobbleHistory.usernameValid === false) return "Last.fm username invalid";
  if (!scrobbleHistory.checked) return "Scrobble history not checked";

  const match = recentScrobbleMatchFor(track, scrobbleHistory);
  if (!match) return "Not in recent Last.fm scrobbles";

  const plays = Number(match.plays || 0);
  if (match.nowPlaying) return plays > 1 ? `Currently scrobbling on Last.fm (${plays} recent plays)` : "Currently scrobbling on Last.fm";
  return plays > 1 ? `Previously scrobbled ${plays}x on Last.fm` : "Previously scrobbled on Last.fm";
}

function scrobbleVerificationSummary(scrobbleHistory = null) {
  if (!scrobbleHistory) return { checked: false, configured: false };
  return {
    enabled: scrobbleHistory.enabled !== false,
    configured: Boolean(scrobbleHistory.configured),
    apiKeyConfigured: Boolean(scrobbleHistory.apiKeyConfigured),
    usernameConfigured: Boolean(scrobbleHistory.usernameConfigured),
    usernameValid: scrobbleHistory.usernameValid !== false,
    checked: Boolean(scrobbleHistory.checked),
    returned: Number(scrobbleHistory.returned || 0),
    topArtistPeriod: cleanText(scrobbleHistory.topArtistPeriod || ""),
    topArtistsReturned: Number(scrobbleHistory.topArtistsReturned || 0),
    topArtistsError: cleanText(scrobbleHistory.topArtistsError || ""),
    error: cleanText(scrobbleHistory.error || scrobbleHistory.reason || "")
  };
}

function discoveryStatusFor(track = {}, historyEntry = null, recent = false, scrobbleHistory = null) {
  const statuses = [];
  statuses.push(track.tidalUrl || track.tidal?.tidalUrl ? "TIDAL verified" : "TIDAL verified by catalogue result");
  statuses.push(historyEntry
    ? `Previously suggested${historyEntry.shownCount ? ` ${historyEntry.shownCount}x` : ""}${recent ? " recently" : ""}`
    : "Not previously suggested");
  statuses.push("Roon library not checked");
  statuses.push("TIDAL playlist membership not connected");
  statuses.push(scrobbleStatusFor(track, scrobbleHistory));
  return statuses;
}

function whyBulletsFor(track = {}, options = {}, breakdown = {}, historyEntry = null, profile = buildDiscoveryProfile(options)) {
  const bullets = [];
  const label = labelText(track);
  const sceneLabel = isProgressiveSceneTarget(profile) ? matchingSceneLabel(label, profile) : "";
  const sceneArtist = isProgressiveSceneTarget(profile) ? matchingSceneArtist(track.artist, profile) : "";
  const minutes = durationMinutes(track);
  const text = normalize(`${track.artist} ${track.title} ${track.album} ${label} ${track.query}`);

  if (sceneLabel) bullets.push(`${sceneLabel} label match`);
  else if (label) bullets.push(`${label} label metadata`);

  if (breakdown.genreInference?.summary && Number(breakdown.genreInference.confidence || 0) >= 35) {
    bullets.push(`Genre inferred from ${breakdown.genreInference.summary}`);
  }
  if (breakdown.vibeInference?.summary && Number(breakdown.vibeInference.confidence || 0) >= 25) {
    bullets.push(`Trait evidence from ${breakdown.vibeInference.summary}`);
  } else if (breakdown.vibeInference?.queryOnly) {
    bullets.push("Trait words only appeared in the search query");
  }

  if (sceneArtist) bullets.push("Similar progressive/melodic lane");
  else if (profile.targetGenres.length && hasAnyTerm(text, profile.targetGenres)) bullets.push(`${profile.targetGenres[0]} target genre signal`);

  if (requestPrefersExtendedMixes(options) && Number(breakdown.versionPreferenceAdjustment || 0) > 0) bullets.push("Extended/long version preference matched");
  else if (requestPrefersExtendedMixes(options) && Number(breakdown.versionPreferenceAdjustment || 0) < 0) bullets.push("Downweighted because an extended mix was preferred");
  if (wantsLongTracks(options) && minutes >= 7) bullets.push("7+ minute track length preference");
  else if (minutes) bullets.push(`${minutes.toFixed(1)} minute playable length`);

  const releaseValue = releaseValueForDisplay(track);
  if (releaseValue) bullets.push(`${releaseValue} release`);
  const lastfmReasons = breakdown.lastfmReasons || [];
  if (lastfmReasons.some((reason) => /long-term Last\.fm/i.test(reason))) bullets.push("Lightly boosted by long-term Last.fm taste");
  else if (breakdown.tasteAdjustment > 0) bullets.push("Boosted by your likes");
  if (lastfmReasons.some((reason) => /recent Last\.fm repeat|currently scrobbling/i.test(reason))) bullets.push("Downweighted as a recent Last.fm repeat");
  else if (breakdown.tasteAdjustment < 0) bullets.push("Penalized by your dislikes");
  if (breakdown.calibrationAdjustment < 0) bullets.push("Downweighted by feedback calibration");
  if (breakdown.serendipityAdjustment > 0) bullets.push("Lifted by long-shot serendipity signals");
  bullets.push(historyEntry ? "Previously suggested" : "Not previously suggested");

  const seen = new Set();
  return bullets.filter((bullet) => {
    const key = normalize(bullet);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function pushEvidence(list = [], value = "") {
  const text = cleanText(value);
  if (!text) return;
  const key = normalize(text);
  if (!key || list.some((item) => normalize(item) === key)) return;
  list.push(text);
}

function evidenceLabelsForInference(inference = {}, { minWeight = 1, limit = 4 } = {}) {
  return (inference.evidence || [])
    .filter((item) => Number(item.weight || 0) >= minWeight && !item.queryOnly)
    .sort((left, right) => Number(right.weight || 0) - Number(left.weight || 0))
    .slice(0, limit)
    .map((item) => {
      const label = cleanText(item.label || item.term || item.genre || item.source);
      const source = cleanText(item.source);
      const weight = Number(item.weight || 0);
      const suffix = [
        source && !normalize(label).includes(normalize(source)) ? source : "",
        weight ? `weight ${weight}` : ""
      ].filter(Boolean).join(", ");
      return suffix ? `${label} (${suffix})` : label;
    })
    .filter(Boolean);
}

function buildDiscoveryEvidenceLedger(track = {}, {
  options = {},
  profile = buildDiscoveryProfile(options),
  decision = "candidate",
  decisionReason = ""
} = {}) {
  const sourceTrack = track.tidal || track;
  const breakdown = track.scoreBreakdown || {};
  const queryText = cleanText(track.query || sourceTrack.query || options.request || "");
  const label = labelText(track) || labelText(sourceTrack);
  const artist = cleanText(track.artist || sourceTrack.artist);
  const title = cleanText(track.title || sourceTrack.title);
  const releaseValue = releaseValueForDisplay(track) || releaseValueForDisplay(sourceTrack);
  const yearRange = parseYearRange(options);
  const durationMs = Number(track.durationMs || sourceTrack.durationMs || 0);
  const genreInference = breakdown.genreInference || (profile.targetGenres?.length
    ? genreInferenceFor(sourceTrack, queryText, options, profile)
    : {});
  const vibeInference = breakdown.vibeInference || (profile.vibeTerms?.length
    ? vibeInferenceFor(sourceTrack, queryText, profile)
    : {});
  const statusChecks = Array.isArray(track.statusChecks) ? track.statusChecks : [];
  const statusText = cleanText(statusChecks.join("; "));
  const promptPercent = Number(breakdown.promptMatch?.percent ?? track.promptMatch?.percent ?? 0);
  const tastePercent = Number(breakdown.tasteMatch?.percent ?? track.tasteMatch?.percent ?? 0);
  const score = Number(track.score || breakdown.total || 0);

  const proof = {
    artist: [],
    label: [],
    genre: [],
    vibe: [],
    year: [],
    novelty: [],
    quality: []
  };

  if (artist) pushEvidence(proof.artist, `candidate artist: ${artist}`);
  if (hasSeedArtistMatch(sourceTrack, options, profile)) pushEvidence(proof.artist, "matched an explicit seed artist");
  const scene = profile.targetGenres?.length ? sceneEvidenceFor(sourceTrack, queryText, options, profile) : {};
  if (scene.artistAnchor) pushEvidence(proof.artist, `${scene.artistAnchor} scene artist anchor`);
  if (breakdown.artistMatch !== undefined) {
    pushEvidence(proof.artist, `artist score ${breakdown.artistMatch}/${breakdown.max?.artistMatch || SCORE_MAX.artistMatch}`);
  }

  if (label) pushEvidence(proof.label, `${label} label metadata`);
  const requestedLabel = requestedLabelMatch(sourceTrack, profile);
  if (requestedLabel) pushEvidence(proof.label, `${requestedLabel} requested label match`);
  const sceneLabel = matchingSceneLabel(label, profile);
  if (sceneLabel) pushEvidence(proof.label, `${sceneLabel} scene label match`);
  if (breakdown.labelMatch !== undefined) {
    pushEvidence(proof.label, `label score ${breakdown.labelMatch}/${breakdown.max?.labelMatch || SCORE_MAX.labelMatch}`);
  }

  if (breakdown.matchGenre) pushEvidence(proof.genre, `ranked as ${breakdown.matchGenre}`);
  for (const item of evidenceLabelsForInference(genreInference, { minWeight: 1, limit: 5 })) {
    pushEvidence(proof.genre, item);
  }
  if (genreInference.summary) pushEvidence(proof.genre, `genre inference: ${genreInference.summary}`);
  const officialGenres = trackGenreValues(sourceTrack).filter((value) => !/^(?:hires|hi[-_\s]?res|lossless|hires_lossless)$/i.test(cleanText(value)));
  for (const value of officialGenres.slice(0, 3)) pushEvidence(proof.genre, `official genre hint: ${value}`);
  if (breakdown.genreMatch !== undefined) {
    pushEvidence(proof.genre, `genre score ${breakdown.genreMatch}/${breakdown.max?.genreMatch || SCORE_MAX.genreMatch}`);
  }

  for (const item of evidenceLabelsForInference(vibeInference, { minWeight: 1, limit: 4 })) {
    pushEvidence(proof.vibe, item);
  }
  if (vibeInference.summary) pushEvidence(proof.vibe, `trait inference: ${vibeInference.summary}`);
  if (profile.vibeTerms?.length && !proof.vibe.length) pushEvidence(proof.vibe, `requested trait: ${profile.vibeTerms.join(", ")}`);

  if (releaseValue) {
    const fits = !yearRange
      ? true
      : (yearRange.dateSpecific
        ? releaseDateFits(sourceTrack.releaseDate || track.releaseDate, yearRange)
        : yearFits(sourceTrack.year || track.year, yearRange, sourceTrack.releaseDate || track.releaseDate));
    pushEvidence(proof.year, `release ${releaseValue}${yearRange ? ` ${fits ? "fits" : "misses"} ${yearRange.label}` : ""}`);
  } else if (yearRange) {
    pushEvidence(proof.year, `missing release date/year for ${yearRange.label}`);
  }
  if (breakdown.freshness !== undefined) {
    pushEvidence(proof.year, `freshness score ${breakdown.freshness}/${breakdown.max?.freshness || SCORE_MAX.freshness}`);
  }

  if (/Not previously suggested/i.test(statusText)) pushEvidence(proof.novelty, "not previously suggested");
  if (/Previously suggested/i.test(statusText)) pushEvidence(proof.novelty, "previously suggested");
  if (track.artistNoveltyFallback || track.artistNoveltyRelaxed) pushEvidence(proof.novelty, track.artistNoveltyReason || "artist novelty fallback");
  if (track.discoveryQuotaBucket) pushEvidence(proof.novelty, `${track.discoveryQuotaBucket} discovery lane`);
  if (track.discoveryLane) pushEvidence(proof.novelty, `${track.discoveryLane} search lane`);

  if (sourceTrack.tidalUrl || track.tidalUrl) pushEvidence(proof.quality, "TIDAL catalog result");
  if (/Roon queue action ready/i.test(statusText) || track.roon?.queueActionReady) pushEvidence(proof.quality, "Roon queue action ready");
  if (durationMs) pushEvidence(proof.quality, `${(durationMs / 60000).toFixed(1)} minute playable length`);
  if (promptPercent) pushEvidence(proof.quality, `prompt match ${promptPercent}%`);
  if (tastePercent) pushEvidence(proof.quality, `taste match ${tastePercent}%`);

  const keptBecause = [];
  if (Array.isArray(track.why)) {
    for (const reason of track.why.slice(0, 6)) pushEvidence(keptBecause, reason);
  }
  if (!keptBecause.length && track.reason) {
    for (const reason of cleanText(track.reason).split(/\s*;\s*/).slice(0, 6)) pushEvidence(keptBecause, reason);
  }

  const risks = [];
  if (track.belowMinimum) pushEvidence(risks, `below ${track.minimumScoreLabel || "minimum"} floor`);
  if (score && score < 60) pushEvidence(risks, "long-shot score");
  if (promptPercent && promptPercent < 50) pushEvidence(risks, "weak prompt match");
  if (genreInference.queryOnly) pushEvidence(risks, "requested genre/trait only appears in the query");
  if (genreInference.weakOfficialGenre) pushEvidence(risks, "official genre tag is generic");
  if (profile.targetGenres?.length && Number(genreInference.confidence || 0) < 35) pushEvidence(risks, "weak genre corroboration");
  if (!label) pushEvidence(risks, "no trusted label metadata");
  if (yearRange && !releaseValue) pushEvidence(risks, `missing release value for ${yearRange.label}`);
  if (yearRange && releaseValue && !proof.year.some((item) => /\bfits\b/.test(item))) pushEvidence(risks, `release date outside ${yearRange.label}`);
  if (isShortEdit(sourceTrack)) pushEvidence(risks, "short/radio edit");
  if (track.discoveryQuotaRisk) pushEvidence(risks, "feedback calibration risk");

  const rejectedBecause = [];
  const rejectText = cleanText(decisionReason || track.reason);
  if (/^(?:discarded|rejected)$/i.test(cleanText(decision)) && rejectText) {
    for (const reason of rejectText.split(/\s*;\s*/).slice(0, 4)) pushEvidence(rejectedBecause, reason);
  }

  return {
    version: 1,
    decision: cleanText(decision) || "candidate",
    identity: {
      artist,
      title
    },
    query: {
      text: queryText,
      requested: cleanText(options.request || ""),
      mode: scoringModeLabel(profile.scoringMode)
    },
    source: {
      discoverySource: cleanText(track.discoverySource || discoverySourceForResult(sourceTrack, options)),
      discoveryLane: cleanText(track.discoveryLane || "core"),
      verificationSource: cleanText(track.verificationSource || (sourceTrack.tidalUrl || track.tidalUrl ? "tidal" : "catalog"))
    },
    scoring: {
      score,
      promptMatch: promptPercent,
      tasteMatch: tastePercent,
      genreConfidence: Number(genreInference.confidence || 0),
      vibeConfidence: Number(vibeInference.confidence || 0),
      tasteAdjustment: Number(breakdown.tasteAdjustment || 0),
      artistDiversityAdjustment: Number(breakdown.artistDiversityAdjustment || 0)
    },
    proof,
    keptBecause,
    risks,
    rejectedBecause
  };
}

function withDiscoveryEvidenceLedger(track = {}, context = {}) {
  if (!track || typeof track !== "object") return track;
  return {
    ...track,
    evidenceLedger: buildDiscoveryEvidenceLedger(track, context)
  };
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

async function discoverTracks({ tidal, options = {}, history, tasteProfile = null, scrobbleHistory = null, queryYieldTracker = null, directCandidates = null } = {}) {
  if (!tidal?.isConfigured?.()) {
    throw new Error("TIDAL is not configured. Add TIDAL_CLIENT_ID/TIDAL_CLIENT_SECRET or TIDAL_ACCESS_TOKEN to .env.");
  }

  const startedAt = Date.now();
  if (typeof tasteProfile?.createReadView === "function") tasteProfile = tasteProfile.createReadView();
  const runtimeMs = Math.max(0, Number(options.discoveryRuntimeMs || options.maxRuntimeMs || 0));
  const deadlineAt = runtimeMs ? startedAt + runtimeMs : 0;
  let budgetExhausted = false;
  function hasBudget(reserveMs = 0) {
    voiceExecution.check();
    if (!deadlineAt) return true;
    return Date.now() + reserveMs < deadlineAt;
  }
  function noteBudgetExhausted() {
    budgetExhausted = true;
  }

  const profile = buildDiscoveryProfile(options);
  const originalRequestedCount = Number(options.originalRequestedCount || 0) || parseRequestedCount({ ...options, effectiveCount: 0 });
  const requestedCount = effectiveDiscoveryCount(options, profile);
  const strictRoonMode = /^(1|true|yes)$/i.test(String(options.requireRoonQueueable || ""));
  const yearRange = parseYearRange(options);
  const isYearCatalogSearch = Boolean(yearRange && profile.targetGenres.length);
  const smallExactRequest = hasExplicitCountRequest(options) && originalRequestedCount <= 8;
  const smallExactYearSearch = smallExactRequest && isYearCatalogSearch;
  const wideDiscoveryPool = shouldBuildWideDiscoveryPool(options, profile);
  const baseCandidatePoolTarget = strictRoonMode
    ? (isYearCatalogSearch
      ? Math.min(160, Math.max(Math.ceil(requestedCount * 7), requestedCount + 54))
      : Math.min(650, Math.max(Math.ceil(requestedCount * 18), requestedCount + 260)))
    : (isYearCatalogSearch
      ? (smallExactYearSearch
        ? Math.min(180, Math.max(Math.ceil(requestedCount * 18), requestedCount + 95))
        : Math.min(140, Math.max(Math.ceil(requestedCount * 7), requestedCount + 48)))
      : Math.min(140, Math.max(Math.ceil(requestedCount * 4), requestedCount + 35)));
  const candidatePoolTarget = wideDiscoveryPool
    ? (strictRoonMode
      ? Math.min(900, Math.max(baseCandidatePoolTarget, Math.ceil(requestedCount * 28), requestedCount + 280))
      : (isYearCatalogSearch
        ? Math.min(520, Math.max(baseCandidatePoolTarget, Math.ceil(requestedCount * 42), requestedCount + 220))
        : Math.min(420, Math.max(baseCandidatePoolTarget, Math.ceil(requestedCount * 22), requestedCount + 150))))
    : baseCandidatePoolTarget;
  const usefulCandidateTarget = isYearCatalogSearch
    ? (wideDiscoveryPool
      ? Math.min(candidatePoolTarget, Math.max(Math.ceil(requestedCount * (strictRoonMode ? 14 : 11)), requestedCount + (strictRoonMode ? 95 : 65)))
      : (smallExactYearSearch
        ? Math.min(candidatePoolTarget, Math.max(Math.ceil(requestedCount * 8), requestedCount + 36))
        : Math.min(candidatePoolTarget, Math.max(Math.ceil(requestedCount * (strictRoonMode ? 4 : 3)), requestedCount + (strictRoonMode ? 28 : 18)))))
    : candidatePoolTarget;
  const minScore = minimumScoreFor(options);
  const minScoreLabel = minimumScoreLabel(minScore);
  const freshArtistAvoidance = buildFreshArtistAvoidance(options, history, tasteProfile);
  const queries = buildSearchQueries(options, tasteProfile, profile, history, freshArtistAvoidance);
  const omnivoreQueryKeys = new Set(buildOmnivoreDiscoveryQueries(options, tasteProfile, profile, 160).map(normalize));
  const discarded = [];
  const scoreFiltered = [];
  const minimumRescueCandidates = [];
  const countFillCandidates = [];
  const previousCandidates = [];
  const artistNoveltyCandidates = [];
  const byKey = new Map();
  const seenCandidateKeys = new Set();
  const candidateCollectionDiagnostics = {
      rawCount: 0,
      acceptedCount: 0,
      validDurationCount: 0,
      freshBeforeNoveltyCount: 0,
      freshAfterNoveltyCount: 0,
      duplicateCount: 0,
    invalidIdentityCount: 0,
    duplicateExamples: [],
    acceptedByFamily: new Map(),
    durationCandidates: []
  };
  const accumulatedCandidateKeys = new Set();

  function durationCandidateDiagnosticFor(candidate = {}, result = {}, context = null, admissionDiagnostics = null) {
    const key = candidateIdentityKeys(candidate)[0];
    const durationConstraint = hardDurationConstraintFor(options);
    const durationSubject = candidate.tidal || candidate || result;
    if (!key || !durationConstraint || durationConstraintReason(durationSubject, options)) return null;
    let diagnostic = candidateCollectionDiagnostics.durationCandidates.find(item => item.key === key);
    if (!diagnostic) {
      const genre = admissionDiagnostics?.genreLaneCompatibility || {};
      const catalogue = admissionDiagnostics?.catalogueQuality || {};
      const identity = admissionDiagnostics?.identityCorrectness || {};
      const duration = admissionDiagnostics?.durationConstraints || admissionDiagnostics?.durationResult || {};
      const raw = result || candidate.tidal || candidate;
      const child = admissionDiagnostics?.childGenreEvidence || {};
      const parent = admissionDiagnostics?.parentGenreEvidence || {};
      const artistScene = admissionDiagnostics?.artistSceneEvidence || {};
      const labelScene = admissionDiagnostics?.labelSceneEvidence || {};
      const queryScene = admissionDiagnostics?.querySceneEvidence || {};
      diagnostic = {
        key,
        artist: cleanText(candidate.artist || result.artist),
        title: cleanText(candidate.title || result.title),
        durationMs: Number(candidate.durationMs || result.durationMs || 0) || null,
        query: cleanText(result.query || context?.query || candidate.tidal?.query || ""),
        source: cleanText(candidate.discoverySource || result.discoverySource || "discovery"),
        lane: cleanText(candidate.discoveryLane || result.discoveryLane || context?.lane || "core"),
        rawTidalResult: {
          id: raw.id || raw.tidalId || raw.trackId || null,
          tidalUrl: cleanText(raw.tidalUrl || raw.tidal?.tidalUrl || ""),
          artist: cleanText(raw.artist),
          title: cleanText(raw.title),
          album: cleanText(raw.album),
          label: cleanText(raw.label || raw.tidal?.label || ""),
          genre: raw.genre || raw.genres || raw.tidal?.genre || raw.tidal?.genres || [],
          durationMs: Number(raw.durationMs || raw.tidal?.durationMs || 0) || null,
          query: cleanText(raw.query || context?.query || ""),
          discoverySource: cleanText(raw.discoverySource || candidate.discoverySource || ""),
          discoveryLane: cleanText(raw.discoveryLane || candidate.discoveryLane || context?.lane || "")
        },
        normalizedMetadata: {
          artist: normalize(candidate.artist || result.artist),
          title: normalize(candidate.title || result.title),
          album: normalize(candidate.album || result.album),
          label: normalize(candidate.label || result.label || raw.label || "")
        },
        // Reaching consider() means the provider/catalog mapper accepted the
        // result. Keep that distinct from the downstream catalogue-quality
        // safety gate, which is reported under qualityResult.catalogue.
        catalogAccepted: true,
        catalogQualityAccepted: catalogue.passed !== false,
        durationAccepted: duration.passed !== false && duration.status !== "failed",
        genreEvidence: {
          confidence: Number(genre.confidence || 0),
          evidence: Array.isArray(genre.evidence) ? genre.evidence.slice(0, 8) : [],
          canonicalOfficialMatch: Boolean(genre.canonicalOfficialMatch),
          child: child,
          parent: parent
        },
        childGenreEvidence: child,
        parentGenreEvidence: parent,
        artistSceneEvidence: artistScene,
        labelSceneEvidence: labelScene,
        querySceneEvidence: queryScene,
        exactGenreConflictDetected: Boolean(admissionDiagnostics?.exactGenreConflictDetected),
        qualityResult: {
          catalogue: {
            passed: catalogue.passed !== false,
            reason: cleanText(catalogue.reason || ""),
            evidence: Array.isArray(catalogue.evidence) ? catalogue.evidence.slice(0, 8) : []
          },
          identity: {
            passed: identity.passed !== false,
            reason: cleanText(identity.reason || ""),
            evidence: Array.isArray(identity.evidence) ? identity.evidence.slice(0, 8) : []
          },
          genre: {
            passed: genre.passed !== false,
            reason: cleanText(genre.reason || ""),
            confidence: Number(genre.confidence || 0)
          }
        },
        durationResult: {
          passed: duration.passed !== false && duration.status !== "failed",
          status: cleanText(duration.status || "passed"),
          reason: cleanText(duration.reason || ""),
          constraint: duration.constraint || null
        },
        noveltyResult: {
          status: "pending",
          previouslySuggested: false,
          reason: ""
        },
        candidateAccumulation: {
          status: "pending",
          stage: "candidate-accumulation",
          reason: ""
        },
        queryYieldAccepted: false,
        candidateAccumulationAccepted: false,
        scoreBeforeRejection: null,
        droppedStage: "",
        droppedReason: ""
      };
      candidateCollectionDiagnostics.durationCandidates.push(diagnostic);
    }
    return diagnostic;
  }

  function updateDurationCandidateDiagnostic(candidate = {}, patch = {}) {
    const key = candidateIdentityKeys(candidate)[0];
    if (!key || !hardDurationConstraintFor(options)) return;
    const diagnostic = candidateCollectionDiagnostics.durationCandidates.find(item => item.key === key);
    if (!diagnostic) return;
    Object.assign(diagnostic, patch);
  }

  function recordCandidateAccumulation(candidate = {}, context = null, result = null) {
    const keys = candidateIdentityKeys(candidate);
    const key = keys[0];
    if (!key || accumulatedCandidateKeys.has(key)) return false;
    accumulatedCandidateKeys.add(key);
    candidateCollectionDiagnostics.acceptedCount += 1;
    const source = result || candidate.tidal || candidate;
    const familyKey = [
      context?.lane || candidate.discoveryLane || "core",
      candidate.discoverySource || source.discoverySource || "discovery",
      cleanText(source.query || context?.query || "unattributed")
    ].join("|");
    const family = candidateCollectionDiagnostics.acceptedByFamily.get(familyKey) || {
      query: cleanText(source.query || context?.query || "unattributed"),
      lane: context?.lane || candidate.discoveryLane || "core",
      source: candidate.discoverySource || source.discoverySource || "discovery",
      accepted: 0
    };
    family.accepted += 1;
    candidateCollectionDiagnostics.acceptedByFamily.set(familyKey, family);
    return true;
  }

  function discardWithDiagnostics(candidate = {}, reason = "", scoringOptions = options, scoringProfile = profile, stage = "") {
    const source = candidate.tidal && typeof candidate.tidal === "object"
      ? {
        ...candidate.tidal,
        query: candidate.query || candidate.tidal.query,
        discoveryLane: candidate.discoveryLane || candidate.tidal.discoveryLane,
        discoverySource: candidate.discoverySource || candidate.tidal.discoverySource
      }
      : candidate;
    let score = Number(candidate.score);
    let scoreBreakdown = candidate.scoreBreakdown || null;
    if (!scoreBreakdown && !(score > 0)) {
      try {
        scoreBreakdown = scoreBreakdownFor(source, scoringOptions, tasteProfile, scoringProfile, scrobbleHistory);
        score = Number(scoreBreakdown?.total || 0);
      } catch {
        scoreBreakdown = null;
      }
    }
    const diagnosticsSeed = candidate.admissionDiagnostics || admissionDiagnosticsFor(source, scoringOptions, scoringProfile);
    const rejectionStage = cleanText(stage || admissionRejectionStageFor(reason, diagnosticsSeed));
    const hardStages = new Set([
      "catalogue-quality",
      "identity-correctness",
      "duration-constraints",
      "genre-lane-compatibility",
      "version-safety",
      "provider-safety"
    ]);
    const diagnostics = admissionDiagnosticsFor(source, scoringOptions, scoringProfile, {
      scoreBeforeRejection: Number.isFinite(score) && score > 0 ? score : null,
      rejectionStage,
      hardFail: hardStages.has(rejectionStage),
      hardFailReason: reason
    });
    return {
      ...candidate,
      reason,
      scoreBeforeRejection: Number.isFinite(score) && score > 0 ? score : null,
      admissionDiagnostics: diagnostics,
      rejectionStage
    };
  }

  const allowPreviousSuggestions = allowsPreviouslySuggested(options);
  const allowPreviousFallback = allowsPreviousDiscoveryFallback(options);
  const queryYieldRecords = new Map();
  const queryYieldAdjustments = [];
  const queryYieldPruned = [];
  const laneBudgetStops = [];
  const querySelectionDiagnostics = [];
  const catalogPaginationDiagnostics = [];
  const latestCatalogPageByQuery = new Map();
  const searchStopDiagnostics = [];
  const queryExecutionDiagnostics = [];
  const promisingCatalogAnchors = new Map();
  const deepCatalog = {
    enabled: Boolean(profile.isProgressivePlanningTarget && hardDurationConstraintFor(options)),
    triggered: false,
    triggerReason: "",
    pageCount: 2,
    attempted: 0,
    returned: 0,
    accepted: 0,
    duplicateCount: 0,
    stoppedReason: "",
    anchors: []
  };
  // Hard-duration genre requests need enough candidates to fill the requested
  // result set and absorb diversity caps, but they do not need the much wider
  // reservoir used by ordinary discovery. Keep the broader targets in the
  // diagnostics; use a bounded fill target for the expensive crawl lanes so
  // pagination/recovery can finish before the request budget expires.
  const discoveryFillTarget = deepCatalog.enabled
    ? Math.min(usefulCandidateTarget, Math.max(requestedCount + 4, requestedCount * 2))
    : usefulCandidateTarget;
  const quotaCalibration = typeof tasteProfile?.read === "function" ? tasteProfile.read().calibration : null;
  let selectionPoolSize = -1;
  let selectionPoolCount = 0;
  function selectableCandidateCount() {
    if (selectionPoolSize !== byKey.size) {
      selectionPoolSize = byKey.size;
      selectionPoolCount = selectDiscoveryLaneCandidates(
        [...byKey.values()], requestedCount, options, profile, quotaCalibration
      ).tracks.length;
    }
    return selectionPoolCount;
  }
  function reachedDiscoveryTarget(target = discoveryFillTarget) {
    // Raw candidates can all belong to the same artist/release. Keep crawling
    // within the existing budget until the real selector can fill the request.
    return byKey.size >= target && selectableCandidateCount() >= requestedCount;
  }
  const tidalErrors = [];
  const artistExpansionArtists = [];
  const queryTasteContext = profile.tasteProfileLed ? "taste-profile" : profile.genreProfile?.key;
  function queryTasteContextFor(query = "") {
    if (!profile.tasteProfileLed) return queryTasteContext;
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return queryTasteContext;
    for (const facet of Array.isArray(options.tasteFacets) ? options.tasteFacets : []) {
      const facetName = cleanText(facet?.name);
      if (!facetName) continue;
      const artists = Array.isArray(facet?.artistEvidence) && facet.artistEvidence.length
        ? facet.artistEvidence.map((item) => item?.name)
        : (Array.isArray(facet?.artists) ? facet.artists : []);
      const labels = Array.isArray(facet?.labelEvidence) && facet.labelEvidence.length
        ? facet.labelEvidence.map((item) => item?.name)
        : (Array.isArray(facet?.labels) ? facet.labels : []);
      if ([...artists, ...labels].filter(Boolean).some((anchor) => (
        artistNamesMatch(normalizedQuery, anchor, { contains: true }) || entityEvidenceMatches(normalizedQuery, anchor)
      ))) {
        return `${queryTasteContext}:${normalize(facetName)}`;
      }
    }
    return queryTasteContext;
  }
  const debugQuerySelection = Boolean(
    options.debugDiscovery ||
    options.debugQuerySelection ||
    process.env.RABBIT_HOLE_DEBUG_DISCOVERY === "1"
  );
  const refreshExcludedQueryKeys = new Set(
    (Array.isArray(options.discoveryExcludedQueries) ? options.discoveryExcludedQueries : [])
      .map(normalize)
      .filter(Boolean)
  );
  const neutralStandbyCatalog = /^(1|true|yes)$/i.test(String(options.standbyPool || "")) && profile.tasteProfileLed;

  function searchConcurrencyFor(lane = "core") {
    if (deepCatalog.enabled) return 1;
    if (strictRoonMode) return 2;
    if (options.autoBroadenLane === "relaxed-vibe") return 1;
    if (isYearCatalogSearch) return smallExactYearSearch ? 2 : 2;
    if (neutralStandbyCatalog) return 3;
    return lane === "recent" ? 1 : 2;
  }

  function reserveForRemainingLanes(lane = "core") {
    if (!deadlineAt) return 0;
    // Neutral standby has one more expensive lane after search: the deferred
    // artist-album crawl. Without a reserve, the initial search pass can use
    // the entire window and the deeper catalog path never gets a chance to
    // run. Keep enough time for that crawl while preserving the existing
    // lane ordering and all candidate-quality gates.
    if (neutralStandbyCatalog) {
      // The initial standby pass is the only pass that may need to leave
      // extra time for deferred album expansion. Refill passes have their
      // own short runtime window and must be allowed to search inside it.
      return options.autoBroadenLane ? 2_500 : 6_000;
    }
    if (options.autoBroaden) return 2_500;
    if (!profile.isGenreDiscoveryTarget) return 2_500;
    if (deepCatalog?.enabled && lane === "core") return 15_000;
    // Deep pagination itself requires an 8s check-in reserve. Keep the
    // trusted branch window above that threshold so branch queries cannot
    // consume the time that was explicitly reserved for page-2 recovery.
    if (deepCatalog?.enabled && lane === "branch") return 10_000;
    if (deepCatalog?.enabled && lane === "adjacent") return 4_000;
    if (lane === "core") return yearRange ? 10_000 : 6_000;
    if (lane === "branch") return yearRange ? 5_000 : 3_500;
    if (lane === "adjacent") return yearRange ? 5_000 : 3_500;
    return 2_500;
  }

  function hasLaneBudget(lane = "core") {
    const reserveMs = reserveForRemainingLanes(lane);
    if (hasBudget(reserveMs)) return true;
    noteBudgetExhausted();
    laneBudgetStops.push({
      lane,
      reserveMs,
      elapsedMs: Date.now() - startedAt
    });
    return false;
  }

  function queryYieldRecordFor(query, lane = "core") {
    const text = cleanText(query);
    if (!text) return null;
    const template = queryTemplate(text);
    const key = `${template}|${lane || "core"}|${text}`;
    if (!queryYieldRecords.has(key)) {
      queryYieldRecords.set(key, {
        query: text,
        template,
        lane: lane || "core",
        contextKey: queryContextKey({
          targetGenres: profile.targetGenres,
          parentGenres: profile.genreProfile?.parentGenres,
          activityTerms: profile.promptIntent?.activityTerms,
          vibes: profile.vibeTerms,
          tasteCluster: queryTasteContextFor(text)
        }),
        genres: profile.targetGenres,
        parentGenres: profile.genreProfile?.parentGenres || [],
        activityTerms: profile.promptIntent?.activityTerms || [],
        vibes: profile.vibeTerms,
        compatibleSeeds: genreSeedUniverseFor(profile),
        attempts: 0,
        returned: 0,
        accepted: 0,
        rejected: 0,
        seoRejects: 0,
        genreRejects: 0,
        errorCount: 0
      });
    }
    return queryYieldRecords.get(key);
  }

  function queryIntentContribution(query = "") {
    const text = normalize(query);
    const targetHits = (profile.targetGenres || []).filter((term) => containsNormalized(text, term)).length;
    const parentHits = (profile.genreProfile?.parentGenres || []).filter((term) => containsNormalized(text, term)).length;
    const vibeHits = (profile.vibeTerms || []).filter((term) => containsNormalized(text, term)).length;
    const activityHits = (profile.promptIntent?.activityTerms || []).filter((term) => containsNormalized(text, term)).length;
    const labelHits = (profile.requestedLabels || []).filter((term) => entityEvidenceMatches(text, term)).length;
    return clamp(targetHits * 35 + parentHits * 12 + labelHits * 24 + vibeHits * 6 + activityHits * 4, 0, 100);
  }

  function queryGenreCompatibility(query = "", incompatibleSeeds = []) {
    if (!profile.targetGenres?.length) return 0;
    if (queryMentionsIncompatibleSeed(query, profile, incompatibleSeeds)) return 0;
    const targetHits = (profile.targetGenres || []).filter((term) => containsNormalized(query, term)).length;
    const labelHits = (profile.requestedLabels || []).filter((term) => entityEvidenceMatches(query, term)).length;
    const seedHits = genreSeedUniverseFor(profile).filter((term) => (
      containsNormalized(query, term) || artistNamesMatch(query, term, { contains: true })
    )).length;
    const parentHits = (profile.genreProfile?.parentGenres || []).filter((term) => containsNormalized(query, term)).length;
    return clamp(targetHits * 70 + labelHits * 22 + seedHits * 18 + parentHits * 10, 0, 100);
  }

  function hardDurationQueryPriority(query = "") {
    const generation = queryGenerationInfo(query, profile, options);
    const normalizedQuery = normalize(query);
    const targetMatch = (profile.targetGenres || []).some((term) => containsNormalized(normalizedQuery, term));
    const trustedLabelMatch = uniqueTerms([
      ...(profile.requestedLabels || []),
      ...(profile.genreProfile?.labels || []),
      ...(isProgressiveSceneTarget(profile) ? progressiveSceneLabelsFor(profile) : []),
      ...genreLabelSeeds(profile)
    ], 260).some((label) => entityEvidenceMatches(normalizedQuery, label));
    const learnedArtistMatch = (profile.learnedTasteArtists || []).some((artist) => artistNamesMatch(normalizedQuery, artist, { contains: true }));
    const learnedLabelMatch = (profile.learnedTasteLabels || []).some((label) => entityEvidenceMatches(normalizedQuery, label));

    if (profile.isProgressiveTranceTarget) {
      // Historical query yield can rank within this lane, but it must not move
      // a direct trusted artist behind low-yield label searches. Keep the
      // exact genre and a trusted label branch in the reserved first window.
      if (generation.seedType === "artist") return 0;
      if (generation.seedType === "genre" && targetMatch) return 1;
      if (trustedLabelMatch) return 2;
    }

    // For a hard duration+genre request, current-lane and trusted scene/label
    // searches are the first budget tier. Learned taste anchors remain useful,
    // but cannot consume the crawl window before direct genre branches run.
    if (trustedLabelMatch && !learnedLabelMatch) return 0;
    if (targetMatch && !learnedArtistMatch) return 1;
    if (generation.source === "trusted artist/scene anchor") return 2;
    if (learnedArtistMatch || learnedLabelMatch) return 6;
    if (generation.seedType === "genre") return 3;
    if (generation.seedType === "artist" || generation.seedType === "label") return 4;
    return 7;
  }

  function orderHardDurationQueries(list = []) {
    if (!deepCatalog.enabled) return list;
    return list
      .map((query, index) => ({ query, index, priority: hardDurationQueryPriority(query) }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)
      .map((item) => item.query);
  }

  function recordQuerySelection(query, lane, source, rankedItem = null) {
    const generation = queryGenerationInfo(query, profile, options);
    const genreCompatibilityScore = queryGenreCompatibility(query, profile.filteredPlanArtists || []);
    const currentIntentContribution = queryIntentContribution(query);
    const tasteSeedArtists = uniqueTerms([
      ...(profile.seedArtists || []),
      ...(profile.learnedTasteArtists || []),
      ...(Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : [])
    ], 48);
    const tasteContribution = hardGenreConstraintFor(profile)
      ? 0
      : (tasteSeedArtists.some((artist) => artistNamesMatch(query, artist, { contains: true })) ? 8 : 0);
    const historicalYieldContribution = Number(rankedItem?.quality || 0);
    const whySelected = [];
    if (genreCompatibilityScore > 0) whySelected.push("genre-compatible query");
    if (currentIntentContribution > 0) whySelected.push("matches current intent");
    if (historicalYieldContribution > 0) whySelected.push("positive contextual query yield");
    if (generation.source) whySelected.push(generation.source);
    const diagnostic = {
      query: cleanText(query),
      // Preserve the long-standing source label in normal verification output.
      // The richer generation provenance is attached when query debugging is
      // enabled so existing consumers remain compatible while operators can
      // inspect the upstream selection policy on demand.
      source: debugQuerySelection ? (generation.source || cleanText(source) || "discovery") : (cleanText(source) || "discovery"),
      lane: cleanText(lane) || "core",
      genreCompatibilityScore,
      whySelected,
      historicalYieldContribution,
      tasteContribution,
      tasteRole: hardGenreConstraintFor(profile)
        ? "ranking-only; excluded from hard-lane query selection"
        : (profile.promptIntent?.tasteInfluence === "not at all" ? "disabled" : "query/style guidance allowed"),
      currentIntentContribution,
      budgetCost: 1,
      queryContextKey: queryContextKey({
        targetGenres: profile.targetGenres,
        parentGenres: profile.genreProfile?.parentGenres,
        activityTerms: profile.promptIntent?.activityTerms,
        vibes: profile.vibeTerms,
        tasteCluster: queryTasteContextFor(query)
      })
    };
    if (debugQuerySelection) {
      Object.assign(diagnostic, {
        selectionStage: cleanText(source) || "discovery",
        seedType: generation.seedType,
        seed: generation.seed,
        priorityTier: generation.priorityTier,
        semanticOnly: generation.semanticOnly,
        budgetPosition: querySelectionDiagnostics.length + 1
      });
    }
    querySelectionDiagnostics.push(diagnostic);
    if (debugQuerySelection) console.info("[discovery-query]", JSON.stringify(diagnostic));
  }

  function rankTrackedQueries(list = [], lane = "core", source = "discovery") {
    const eligibleList = list.filter((query) => !refreshExcludedQueryKeys.has(normalize(query)));
    if (!eligibleList.length) return [];
    const originalIndexes = new Map(eligibleList.map((query, index) => [normalize(query), index]));
    const groups = new Map();
    for (const query of eligibleList) {
      const contextKey = queryTasteContextFor(query);
      if (!groups.has(contextKey)) groups.set(contextKey, []);
      groups.get(contextKey).push(query);
    }
    const rankedGroups = [];
    for (const [tasteCluster, queries] of groups) {
      const context = {
        lane,
        scoringMode: profile.scoringMode,
        genres: profile.targetGenres,
        targetGenres: profile.targetGenres,
        parentGenres: profile.genreProfile?.parentGenres,
        activityTerms: profile.promptIntent?.activityTerms,
        vibes: profile.vibeTerms,
        compatibleSeeds: genreSeedUniverseFor(profile),
        tasteCluster,
        contextKey: queryContextKey({
          targetGenres: profile.targetGenres,
          parentGenres: profile.genreProfile?.parentGenres,
          activityTerms: profile.promptIntent?.activityTerms,
          vibes: profile.vibeTerms,
          tasteCluster
        }),
        prune: true
      };
      if (!queryYieldTracker || typeof queryYieldTracker.rankQueries !== "function") {
        rankedGroups.push(queries.map((query) => ({ query, score: 0 })));
        continue;
      }
      try {
        const ranked = queryYieldTracker.rankQueries(queries, context);
        const protectedPruned = deepCatalog.enabled
          ? (ranked.pruned || []).filter((item) => (
            queryGenreCompatibility(item.query, profile.filteredPlanArtists || []) >= 70 ||
            // A trusted scene/label anchor is a deliberate hard-lane branch,
            // even when historical yield says the bare label query was weak.
            // Keep it eligible for the reserved first-page window; the
            // catalogue and identity gates still decide every returned item.
            hardDurationQueryPriority(item.query) <= 2
          ))
          : [];
        const actualPruned = (ranked.pruned || []).filter((item) => !protectedPruned.includes(item));
        for (const item of ranked.adjustments || []) queryYieldAdjustments.push({ ...item, lane });
        for (const item of protectedPruned) {
          queryYieldAdjustments.push({
            ...item,
            lane,
            protection: "hard-duration genre anchor retained despite historical low yield"
          });
        }
        for (const item of actualPruned) {
          queryYieldPruned.push({ ...item, lane });
          recordSearchStop({
            query: item.query,
            lane,
            source,
            reason: "pruned-low-yield",
            attempted: false
          });
        }
        const protectedItems = protectedPruned.map((item) => ({
          ...item,
          score: Number(item.quality || 0),
          entryScope: item.entryScope || "historical-protected"
        }));
        const rankedItems = new Map([
          ...(ranked.ranked || []),
          ...protectedItems
        ].map((item) => [normalize(item.query), item]));
        const selectedItems = [...(ranked.queries || queries), ...protectedItems.map((item) => item.query)]
          .filter((query, index, list) => list.findIndex((item) => normalize(item) === normalize(query)) === index)
          .map((query) => rankedItems.get(normalize(query)) || { query, score: 0 })
          // Query-yield can optimize within a lane, but it must not promote a
          // historical semantic phrase over a current artist/label/domain
          // anchor. The generation tier is the upstream priority boundary.
          .sort((left, right) => {
            if (deepCatalog.enabled) {
              const leftHardDurationPriority = hardDurationQueryPriority(left.query);
              const rightHardDurationPriority = hardDurationQueryPriority(right.query);
              if (leftHardDurationPriority !== rightHardDurationPriority) {
                return leftHardDurationPriority - rightHardDurationPriority;
              }
            }
            const leftTier = queryGenerationInfo(left.query, profile, options).priorityTier;
            const rightTier = queryGenerationInfo(right.query, profile, options).priorityTier;
            return leftTier - rightTier || Number(right.score || 0) - Number(left.score || 0) ||
              (originalIndexes.get(normalize(left.query)) || 0) - (originalIndexes.get(normalize(right.query)) || 0);
          });
        rankedGroups.push(selectedItems);
      } catch {
        rankedGroups.push(queries.map((query) => ({ query, score: 0 })));
      }
    }
    // Keep the reservoir multi-faceted: one query from each learned region is
    // allowed to run before a single region can consume the lane budget.
    const selectedItems = [];
    for (let index = 0; ; index += 1) {
      let added = false;
      for (const group of rankedGroups) {
        if (group[index]) {
          selectedItems.push(group[index]);
          added = true;
        }
      }
      if (!added) break;
    }
    for (const item of selectedItems) recordQuerySelection(item.query, lane, source, item);
    return selectedItems.map((item) => item.query);
  }

  function recordTidalError(query, lane, error, endpoint = "searchTracks") {
    const rawMessage = cleanText(error?.message || error || "TIDAL request failed");
    const message = rawMessage
      .replace(/(?:access|refresh|catalog(?:ue)?)[-_ ]?token[^;,.]*/gi, "TIDAL token error")
      .slice(0, 240);
    const status = Number(error?.status || error?.statusCode || 0) || null;
    const authFallbackAttempted = /also tried the TIDAL profile OAuth token/i.test(rawMessage);
    const item = {
      query: cleanText(query),
      lane: cleanText(lane) || "core",
      endpoint,
      status,
      category: cleanText(error?.category || error?.code || (status === 401 ? "catalog-token-rejected" : "request-failed")),
      authFallbackAttempted,
      authFallbackResult: authFallbackAttempted ? "rejected" : "not-attempted",
      message
    };
    tidalErrors.push(item);
  }

  function recordQueryAttempt(query, lane, returned) {
    const record = queryYieldRecordFor(query, lane);
    if (!record) return;
    record.attempts += 1;
    record.returned += Number(returned || 0);
  }

  function recordQueryAccepted(query, lane) {
    const record = queryYieldRecordFor(query, lane);
    if (!record) return;
    record.accepted += 1;
    const page = latestCatalogPageFor(query, lane);
    if (page) {
      page.qualityAcceptedCount = Number(page.qualityAcceptedCount || 0) + 1;
      page.queryYieldAcceptedCount = Number(page.queryYieldAcceptedCount || 0) + 1;
      page.candidateAccumulationAcceptedCount = Number(page.candidateAccumulationAcceptedCount || 0) + 1;
    }
  }

  function recordQueryRejected(query, lane, reason) {
    const record = queryYieldRecordFor(query, lane);
    if (!record) return;
    const bucket = rejectionBucketForReason(reason);
    record.rejected += 1;
    if (bucket === "seo") record.seoRejects += 1;
    if (bucket === "genre") record.genreRejects += 1;
    const page = latestCatalogPageFor(query, lane);
    if (page) {
      page.qualityRejectedCount = Number(page.qualityRejectedCount || 0) + 1;
      page.queryYieldRejectedCount = Number(page.queryYieldRejectedCount || 0) + 1;
    }
  }

  function recordQueryError(query, lane, error = null) {
    const record = queryYieldRecordFor(query, lane);
    if (!record) return;
    record.attempts += 1;
    record.errorCount += 1;
    if (error) recordTidalError(query, lane, error);
  }

  function catalogPageDiagnosticFor(query, lane, info = {}) {
    const numberOrNull = value => {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const page = {
      source: cleanText(info.source || "tidal") || "tidal",
      anchor: cleanText(info.anchor || query),
      query: cleanText(info.query || query),
      requestedCursor: cleanText(info.requestedCursor || "") || null,
      requestedPage: numberOrNull(info.requestedPage),
      requestedOffset: numberOrNull(info.requestedOffset),
      nextCursor: cleanText(info.nextCursor || "") || null,
      nextPage: numberOrNull(info.nextPage),
      nextOffset: numberOrNull(info.nextOffset),
      returnedCount: Number(info.returnedCount || 0),
      duplicateCount: Number(info.duplicateCount || 0),
      acceptedCount: Number(info.acceptedCount || 0),
      catalogAcceptedCount: Number(info.acceptedCount || 0),
      qualityAcceptedCount: 0,
      queryYieldAcceptedCount: 0,
      candidateAccumulationAcceptedCount: 0,
      rejectedCount: Number(info.rejectedCount || 0),
      catalogRejectedCount: Number(info.rejectedCount || 0),
      qualityRejectedCount: 0,
      queryYieldRejectedCount: 0,
      budgetCost: Number(info.budgetCost || 0),
      progressResumed: Boolean(info.progressResumed),
      cacheHit: Boolean(info.cacheHit),
      cursorRecovery: Boolean(info.cursorRecovery),
      exhausted: Boolean(info.exhausted),
      error: cleanText(info.error || "")
    };
    const queryText = page.query || cleanText(query) || page.anchor;
    const queryKey = `${normalize(queryText)}|${cleanText(lane) || "core"}`;
    let diagnostic = [...querySelectionDiagnostics].reverse().find(item => (
      normalize(item.query) === normalize(queryText) && item.lane === (cleanText(lane) || "core")
    ));
    if (!diagnostic) {
      diagnostic = {
        query: queryText,
        source: cleanText(lane) || "catalog",
        lane: cleanText(lane) || "core",
        budgetCost: 0,
        queryContextKey: queryContextKey({
          targetGenres: profile.targetGenres,
          parentGenres: profile.genreProfile?.parentGenres,
          activityTerms: profile.promptIntent?.activityTerms,
          vibes: profile.vibeTerms,
          tasteCluster: queryTasteContextFor(queryText)
        })
      };
      querySelectionDiagnostics.push(diagnostic);
    }
    if (!Array.isArray(diagnostic.catalogPages)) diagnostic.catalogPages = [];
    diagnostic.catalogPages.push(page);
    diagnostic.catalogPagination = page;
    diagnostic.catalogSource = page.source;
    diagnostic.catalogAnchor = page.anchor;
    diagnostic.catalogRequestedCursor = page.requestedCursor;
    diagnostic.catalogRequestedPage = page.requestedPage;
    diagnostic.catalogNextCursor = page.nextCursor;
    diagnostic.catalogNextPage = page.nextPage;
    diagnostic.catalogReturnedCount = page.returnedCount;
    diagnostic.catalogDuplicateCount = page.duplicateCount;
    diagnostic.catalogAcceptedCount = page.acceptedCount;
    diagnostic.catalogRejectedCount = page.rejectedCount;
    diagnostic.catalogBudgetCost = page.budgetCost;
    diagnostic.catalogProgressResumed = page.progressResumed;
    diagnostic.budgetCost = Number(diagnostic.budgetCost || 0) + Number(page.budgetCost || 0);
    catalogPaginationDiagnostics.push(page);
    latestCatalogPageByQuery.set(queryKey, page);
    return page;
  }

  function catalogPageReporter(query, lane) {
    return info => catalogPageDiagnosticFor(query, lane, info);
  }

  function latestCatalogPageFor(query, lane) {
    return latestCatalogPageByQuery.get(`${normalize(query)}|${cleanText(lane) || "core"}`) || null;
  }

  function paginationAvailableFor(page = null) {
    return Boolean(page && !page.exhausted && (page.nextCursor || page.nextPage || page.nextOffset));
  }

  function recordSearchStop({
    query = "",
    lane = "core",
    source = "discovery",
    reason = "",
    returned = 0,
    accepted = 0,
    rejected = 0,
    duplicates = 0,
    attempted = false
  } = {}) {
    if (searchStopDiagnostics.length >= 240) return;
    const page = latestCatalogPageFor(query, lane);
    searchStopDiagnostics.push({
      query: cleanText(query),
      source: cleanText(source) || "discovery",
      lane: cleanText(lane) || "core",
      attempted: Boolean(attempted),
      returned: Number(returned || 0),
      accepted: Number(accepted || 0),
      rejected: Number(rejected || 0),
      duplicates: Number(duplicates || 0),
      stopReason: cleanText(reason) || "completed",
      paginationAvailable: paginationAvailableFor(page),
      nextCursor: page?.nextCursor || null,
      nextPage: page?.nextPage ?? null,
      nextOffset: page?.nextOffset ?? null,
      catalogExhausted: page ? Boolean(page.exhausted) : null,
      catalogSource: page?.source || null,
      catalogAnchor: page?.anchor || null
    });
  }

  function queryExecutionTypeFor(query = "", lane = "core", source = "") {
    if (cleanText(lane) === "branch" || /branch/i.test(cleanText(source))) return "branch";
    const generation = queryGenerationInfo(query, profile, options);
    if (generation.seedType === "artist") return "artist";
    if (generation.seedType === "genre") return "genre";
    if (generation.seedType === "label" || queryStartsWithKnownLabel(query, profile)) return "label";
    return "search";
  }

  function recordQueryExecution({
    query = "",
    lane = "core",
    source = "discovery",
    startedAt = Date.now(),
    returned = 0,
    accepted = 0,
    error = false,
    deepPagination = false
  } = {}) {
    if (queryExecutionDiagnostics.length >= 160) return;
    queryExecutionDiagnostics.push({
      query: cleanText(query),
      queryType: queryExecutionTypeFor(query, lane, source),
      lane: cleanText(lane) || "core",
      source: cleanText(source) || "discovery",
      runtimeMs: Math.max(0, Date.now() - Number(startedAt || Date.now())),
      returned: Number(returned || 0),
      currentRunAccepted: Number(accepted || 0),
      remainingBudgetMs: deadlineAt ? Math.max(0, deadlineAt - Date.now()) : null,
      deepPagination: Boolean(deepPagination),
      error: Boolean(error)
    });
  }

  function notePromisingCatalogAnchor({ query = "", lane = "core", source = "discovery", accepted = 0 } = {}) {
    const page = latestCatalogPageFor(query, lane);
    // Page-2 recovery is only useful when the current run admitted at least
    // one candidate. A paginated sludge/zero-yield source must not consume the
    // reserved deep-catalog budget.
    if (!paginationAvailableFor(page) || Number(accepted || 0) <= 0) return;
    const key = `${normalize(query)}|${cleanText(lane) || "core"}`;
    const existing = promisingCatalogAnchors.get(key);
    const item = {
      query: cleanText(query),
      lane: cleanText(lane) || "core",
      source: cleanText(source) || "discovery",
      accepted: Math.max(Number(existing?.accepted || 0), Number(accepted || 0)),
      genreCompatibilityScore: queryGenreCompatibility(query, profile.filteredPlanArtists || [])
    };
    promisingCatalogAnchors.set(key, item);
  }

  function queryYieldSnapshot() {
    return summarizeRecords(Array.from(queryYieldRecords.values()), queryYieldAdjustments);
  }

  function queryContextFor(result = {}, context = null) {
    return {
      query: cleanText(context?.query || result.query || ""),
      lane: cleanText(context?.lane || result.discoveryLane || options.autoBroadenLane || "core") || "core",
      tracked: context?.trackYield === true
    };
  }

  function queryYieldSummary() {
    const records = Array.from(queryYieldRecords.values());
    try {
      const summary = queryYieldTracker && typeof queryYieldTracker.recordRun === "function"
        ? queryYieldTracker.recordRun(records, queryYieldAdjustments)
        : summarizeRecords(records, queryYieldAdjustments);
      return {
        ...summary,
        enabled: Boolean(queryYieldTracker),
        recordCount: records.length,
        prunedCount: queryYieldPruned.length,
        pruned: queryYieldPruned.slice(0, 12),
        laneBudgetStops: laneBudgetStops.slice(0, 8)
      };
    } catch (error) {
      return {
        ...summarizeRecords(records, queryYieldAdjustments),
        enabled: Boolean(queryYieldTracker),
        recordCount: records.length,
        prunedCount: queryYieldPruned.length,
        pruned: queryYieldPruned.slice(0, 12),
        laneBudgetStops: laneBudgetStops.slice(0, 8),
        error: error.message
      };
    }
  }

  function consider(result, scoringOptions = options, scoringProfile = profile, queryContext = null) {
    candidateCollectionDiagnostics.rawCount += 1;
    if (typeof options.standbyAcceptCandidate === "function" && !options.standbyAcceptCandidate(result)) return;
    // TIDAL search results do not always carry the query that produced them.
    // Keep the search context attached for the admission/evidence pipeline so
    // a trusted genre or label branch can corroborate parent-genre metadata.
    // This is context propagation only; it does not turn query text into
    // standalone genre evidence or bypass any hard gate.
    const context = queryContextFor(result, queryContext);
    if ((!result.query || !cleanText(result.query)) && context.query) {
      result = { ...result, query: context.query };
    }
    if ((!result.discoveryLane || !cleanText(result.discoveryLane)) && context.lane) {
      result = { ...result, discoveryLane: context.lane };
    }
    const keys = candidateIdentityKeys(result);
    const key = keys[0];
    if (!key) {
      candidateCollectionDiagnostics.invalidIdentityCount += 1;
      return;
    }
    if (keys.some((candidateKey) => seenCandidateKeys.has(candidateKey))) {
      candidateCollectionDiagnostics.duplicateCount += 1;
      if (candidateCollectionDiagnostics.duplicateExamples.length < 8) {
        candidateCollectionDiagnostics.duplicateExamples.push({
          artist: cleanText(result.artist),
          title: cleanText(result.title),
          query: cleanText(result.query || queryContext?.query || ""),
          reason: "duplicate identity key"
        });
      }
      return;
    }
    const historyEntry = typeof history?.entryFor === "function" ? history.entryFor(result) : null;
    const hardDurationConstraint = hardDurationConstraintFor(scoringOptions);
    const durationAccepted = Boolean(hardDurationConstraint && !durationConstraintReason(result, scoringOptions));
    const preAdmissionDiagnostics = durationAccepted
      ? admissionDiagnosticsFor(result, scoringOptions, scoringProfile)
      : null;
    const durationCandidateDiagnostic = durationAccepted
      ? durationCandidateDiagnosticFor(result, result, context, preAdmissionDiagnostics)
      : null;
    const reason = rejectReason(result, scoringOptions, scoringProfile);
    if (reason) {
      if (durationCandidateDiagnostic) {
        const rejectedDiagnostics = admissionDiagnosticsFor(result, scoringOptions, scoringProfile, {
          hardFailReason: reason
        });
        const rejectionStage = admissionRejectionStageFor(reason, rejectedDiagnostics);
        updateDurationCandidateDiagnostic(result, {
          catalogAccepted: true,
          catalogQualityAccepted: rejectedDiagnostics.catalogueQuality?.passed !== false,
          durationAccepted: rejectedDiagnostics.durationConstraints?.passed !== false,
          qualityResult: {
            catalogue: rejectedDiagnostics.catalogueQuality,
            identity: rejectedDiagnostics.identityCorrectness,
            genre: rejectedDiagnostics.genreLaneCompatibility
          },
          genreEvidence: {
            confidence: Number(rejectedDiagnostics.genreLaneCompatibility?.confidence || 0),
            evidence: rejectedDiagnostics.genreLaneCompatibility?.evidence || [],
            canonicalOfficialMatch: Boolean(rejectedDiagnostics.genreLaneCompatibility?.canonicalOfficialMatch),
            child: rejectedDiagnostics.childGenreEvidence || {},
            parent: rejectedDiagnostics.parentGenreEvidence || {}
          },
          childGenreEvidence: rejectedDiagnostics.childGenreEvidence || {},
          parentGenreEvidence: rejectedDiagnostics.parentGenreEvidence || {},
          artistSceneEvidence: rejectedDiagnostics.artistSceneEvidence || {},
          labelSceneEvidence: rejectedDiagnostics.labelSceneEvidence || {},
          querySceneEvidence: rejectedDiagnostics.querySceneEvidence || {},
          exactGenreConflictDetected: Boolean(rejectedDiagnostics.exactGenreConflictDetected),
          queryYieldAccepted: false,
          candidateAccumulationAccepted: false,
          candidateAccumulation: { status: "dropped", stage: rejectionStage, reason },
          droppedStage: rejectionStage,
          droppedReason: reason
        });
      }
      if (context.tracked) recordQueryRejected(context.query, context.lane, reason);
      discarded.push(discardWithDiagnostics(result, reason, scoringOptions, scoringProfile));
      return;
    }

    // Query yield measures whether the search produced a candidate that
    // passed the hard admission gates. Score floors, novelty, and diversity
    // are later policy stages and must not make an otherwise useful query
    // appear to have produced zero yield.
    if (context.tracked) {
      recordQueryAccepted(context.query, context.lane);
      updateDurationCandidateDiagnostic(result, {
        queryYieldAccepted: true
      });
    }

    // Count candidates that passed catalogue, identity, genre, and hard
    // duration admission before novelty, score-floor, or diversity policy can
    // hold them back. This keeps pool-fill diagnostics honest when a valid
    // track is temporarily withheld for repeat protection.
    if (hardDurationConstraint && durationAccepted) {
      candidateCollectionDiagnostics.validDurationCount += 1;
      if (!historyEntry) candidateCollectionDiagnostics.freshBeforeNoveltyCount += 1;
    }

    const admissionDiagnostics = preAdmissionDiagnostics || admissionDiagnosticsFor(result, scoringOptions, scoringProfile);

    const baseScoreBreakdown = scoreBreakdownFor(result, scoringOptions, tasteProfile, scoringProfile, scrobbleHistory);
    const artistDiversity = artistDiversityAdjustmentFor(result, history, scoringProfile, scoringOptions);
    const scoreBreakdown = {
      ...baseScoreBreakdown,
      total: clamp(Number(baseScoreBreakdown.total || 0) + Number(artistDiversity.value || 0), 1, 100),
      artistDiversityAdjustment: artistDiversity.value || 0,
      artistDiversityReasons: artistDiversity.reasons || []
    };
    const artistDiversityChecks = artistDiversity.value
      ? [`Artist diversity ${artistDiversity.value}: ${artistDiversity.reasons.join("; ")}`]
      : [];
    const recentNovelty = recentSuggestionNoveltyPenaltyFor(result, history, scoringProfile, scoringOptions);
    const recentNoveltyChecks = recentNovelty.value
      ? [`Recent suggestion novelty tax -${recentNovelty.value}: ${recentNovelty.reasons.join("; ")}`]
      : [];
    const omnivoreBridge = scoringProfile.isOmnivoreDiscovery
      ? omnivoreBridgeEvidenceFor(result, result.query, scoringOptions, scoringProfile)
      : null;
    const candidate = {
      artist: result.artist,
      title: result.title,
      album: result.album,
      label: result.label || "",
      year: result.year || null,
      releaseDate: result.releaseDate || "",
      durationMs: result.durationMs || null,
      reason: reasonFor(result, scoringOptions, scoreBreakdown, scoringProfile),
      why: whyBulletsFor(result, scoringOptions, scoreBreakdown, historyEntry, scoringProfile),
      discoverySource: result.discoverySource || discoverySourceForResult(result, options),
      discoveryLane: result.discoveryLane || "core",
      score: scoreBreakdown.total,
      scoreBreakdown: {
        ...scoreBreakdown,
        recentSuggestionPenalty: recentNovelty.value ? -recentNovelty.value : 0,
        recentSuggestionPenaltyReasons: recentNovelty.reasons || [],
        recentSuggestionPenaltyComponents: recentNovelty.components || {}
      },
      recentSuggestionPenalty: recentNovelty.value,
      recentSuggestionPenaltyReasons: recentNovelty.reasons || [],
      recentSuggestionPenaltyComponents: recentNovelty.components || {},
      tidal: result,
      ...(omnivoreBridge?.lane ? {
        discoveryOmnivoreLane: omnivoreBridge.lane,
        discoveryOmnivoreAnchor: omnivoreBridge.anchor,
        discoveryOmnivoreTarget: omnivoreBridge.target
      } : {}),
      statusChecks: [...discoveryStatusFor(result, historyEntry, false, scrobbleHistory), ...artistDiversityChecks, ...recentNoveltyChecks],
      admissionDiagnostics,
      verificationSource: "tidal"
    };
    candidate.feedback = typeof tasteProfile?.getFeedbackFor === "function" ? tasteProfile.getFeedbackFor(candidate) : "";
    if (durationCandidateDiagnostic) {
      durationCandidateDiagnostic.scoreBeforeRejection = Number(candidate.score || 0) || null;
      durationCandidateDiagnostic.noveltyResult = historyEntry
        ? {
          status: "held-back",
          previouslySuggested: true,
          shownCount: Number(historyEntry.shownCount || 0),
          recent: Boolean(history?.isRecent?.(candidate)),
          reason: "Previously suggested; held back initially for discovery novelty."
        }
        : {
          status: "fresh",
          previouslySuggested: false,
          reason: "No matching discovery-history entry."
        };
    }
    for (const candidateKey of keys) seenCandidateKeys.add(candidateKey);

    if (minScore && candidate.score < minScore) {
      const belowMinimumReason = `Discovery score ${candidate.score} is below minimum ${minScoreLabel}.`;
      candidate.belowMinimum = true;
      candidate.minimumScore = minScore;
      candidate.minimumScoreLabel = minScoreLabel;
      candidate.reason = `${candidate.reason}; below ${minScoreLabel} floor`;
      candidate.statusChecks = [...candidate.statusChecks, belowMinimumReason];
      // Standby is a quality reservoir, not a count-fill request. The legacy
      // discovery path has deliberately permissive below-floor rescue logic,
      // but allowing that path here reintroduced 50–55 point candidates even
      // when the standby floor was configured at 60. Keep the soft-rescue
      // behavior for normal discovery while making standby fail closed.
      if (/^(1|true|yes)$/i.test(String(options.standbyPool || ""))) {
        updateDurationCandidateDiagnostic(candidate, {
          candidateAccumulationAccepted: false,
          candidateAccumulation: { status: "dropped", stage: "score-threshold", reason: belowMinimumReason },
          droppedStage: "score-threshold",
          droppedReason: belowMinimumReason
        });
        discarded.push(discardWithDiagnostics(candidate, belowMinimumReason, scoringOptions, scoringProfile, "score-threshold"));
        return;
      }
      const hardDurationReason = durationConstraintReason(candidate.tidal || candidate, scoringOptions);
      if (hardDurationReason) {
        updateDurationCandidateDiagnostic(candidate, {
          candidateAccumulationAccepted: false,
          candidateAccumulation: { status: "dropped", stage: "duration-constraints", reason: hardDurationReason },
          droppedStage: "duration-constraints",
          droppedReason: hardDurationReason
        });
        discarded.push(discardWithDiagnostics(candidate, hardDurationReason, scoringOptions, scoringProfile, "duration-constraints"));
        return;
      }
      const softRejectReason = belowMinimumSoftRejectReason(candidate, scoringProfile, scoringOptions);
      if (softRejectReason) {
        const rescueNote = belowMinimumRescueNote(
          candidate,
          softRejectReason,
          scoringOptions,
          scoringProfile,
          historyEntry,
          allowPreviousSuggestions
        );
        if (rescueNote) {
          const overexposedBelowFloorRescue = Boolean(
            Number(artistDiversity.value || 0) <= -10 &&
            !hasSeedArtistMatch(candidate, scoringOptions, scoringProfile)
          );
          if (overexposedBelowFloorRescue) {
            const overexposedReason = `Below-minimum repeat artist held back: ${artistDiversity.reasons.join("; ")}`;
            updateDurationCandidateDiagnostic(candidate, {
              candidateAccumulationAccepted: false,
              candidateAccumulation: { status: "dropped", stage: "score-threshold", reason: overexposedReason },
              droppedStage: "score-threshold",
              droppedReason: overexposedReason
            });
            discarded.push(discardWithDiagnostics(candidate, overexposedReason, scoringOptions, scoringProfile, "score-threshold"));
            return;
          }
          minimumRescueCandidates.push({
            ...candidate,
            belowMinimumRescue: true,
            belowMinimumReason: softRejectReason,
            reason: `${candidate.reason}; ${rescueNote}`,
            why: [
              ...(candidate.why || []),
              "Kept as a lower-confidence branch-out fallback because the run undershot the requested count."
            ],
            statusChecks: Array.from(new Set([
              ...(candidate.statusChecks || []),
              softRejectReason,
              "Below-minimum branch-out fallback"
            ]))
          });
        }
        const countFillNote = belowMinimumCountFillNote(
          candidate,
          softRejectReason,
          scoringOptions,
          scoringProfile,
          historyEntry,
          allowPreviousSuggestions
        );
        if (countFillNote && !rescueNote) {
          countFillCandidates.push({
            ...candidate,
            belowMinimumCountFill: true,
            belowMinimumReason: softRejectReason,
            reason: `${candidate.reason}; ${countFillNote}`,
            why: [
              ...(candidate.why || []),
              "Kept available as a lower-confidence near-miss because the run may undershoot the requested count."
            ],
            statusChecks: Array.from(new Set([
              ...(candidate.statusChecks || []),
              softRejectReason,
              "Below-minimum count-fill fallback"
            ]))
          });
        }
        updateDurationCandidateDiagnostic(candidate, {
          candidateAccumulationAccepted: false,
          candidateAccumulation: { status: "dropped", stage: "score-threshold", reason: softRejectReason },
          droppedStage: "score-threshold",
          droppedReason: softRejectReason
        });
        discarded.push(discardWithDiagnostics(candidate, softRejectReason, scoringOptions, scoringProfile, "score-threshold"));
        return;
      }
      updateDurationCandidateDiagnostic(candidate, {
        candidateAccumulationAccepted: false,
        candidateAccumulation: { status: "held-for-score-fill", stage: "score-threshold", reason: belowMinimumReason }
      });
      scoreFiltered.push({
        ...candidate,
        reason: belowMinimumReason
      });
    }

    if (!allowPreviousSuggestions && historyEntry) {
      const previousCandidate = {
        ...candidate,
        reason: `${candidate.reason}; previously suggested`,
        why: whyBulletsFor(result, scoringOptions, scoreBreakdown, historyEntry, scoringProfile),
        statusChecks: discoveryStatusFor(result, historyEntry, history?.isRecent?.(candidate), scrobbleHistory)
      };
      previousCandidates.push(previousCandidate);
      discarded.push(discardWithDiagnostics(
        previousCandidate,
        "Previously suggested; held back for discovery variety.",
        scoringOptions,
        scoringProfile,
        "novelty-policy"
      ));
      updateDurationCandidateDiagnostic(previousCandidate, {
        candidateAccumulationAccepted: false,
        candidateAccumulation: {
          status: "held-back",
          stage: "novelty-policy",
          reason: "Previously suggested; held back initially for discovery novelty."
        },
        droppedStage: "novelty-policy",
        droppedReason: "Previously suggested; held back initially for discovery novelty."
      });
      return;
    }

    const artistNoveltyReason = previouslyRecommendedArtistReason(result, history, scoringProfile, scoringOptions, tasteProfile, freshArtistAvoidance);
    if (artistNoveltyReason) {
      const noveltyCandidate = {
        ...candidate,
        artistNoveltyFallback: true,
        artistNoveltyReason,
        reason: `${candidate.reason}; ${artistNoveltyReason}`,
        statusChecks: Array.from(new Set([
          ...(candidate.statusChecks || []),
          artistNoveltyReason,
          "Held unless fresh-artist search undershoots"
        ]))
      };
      artistNoveltyCandidates.push(noveltyCandidate);
      discarded.push(discardWithDiagnostics(noveltyCandidate, artistNoveltyReason, scoringOptions, scoringProfile, "artist-novelty-policy"));
      updateDurationCandidateDiagnostic(noveltyCandidate, {
        candidateAccumulationAccepted: false,
        candidateAccumulation: { status: "held-back", stage: "artist-novelty-policy", reason: artistNoveltyReason },
        droppedStage: "artist-novelty-policy",
        droppedReason: artistNoveltyReason
      });
      return;
    }

    const accumulated = recordCandidateAccumulation(candidate, context, result);
    if (accumulated && !historyEntry) candidateCollectionDiagnostics.freshAfterNoveltyCount += 1;
    byKey.set(key, candidate);
    updateDurationCandidateDiagnostic(candidate, {
      candidateAccumulationAccepted: true,
      candidateAccumulation: { status: "accepted", stage: "candidate-accumulation", reason: "Entered selectable candidate pool." },
      droppedStage: "",
      droppedReason: ""
    });
    if (typeof options.standbyOnCandidate === "function") options.standbyOnCandidate(candidate);
  }

  function candidateCountForQuotaBucket(bucket) {
    return Array.from(byKey.values()).filter((candidate) => {
      return discoveryQuotaBucket(candidate, profile) === bucket;
    }).length;
  }

  const adaptiveRecovery = {
    enabled: !/^(0|false|no)$/i.test(String(options.adaptiveQueryRecovery ?? "true")),
    triggered: false,
    reason: "",
    keptBefore: 0,
    keptAfter: 0,
    attempted: 0,
    returned: 0,
    accepted: 0,
    errors: 0,
    targetLanes: [],
    laneShortfalls: [],
    families: []
  };
  let relaxedYearOptions = null;
  let modelCandidates = [];

  if (Array.isArray(directCandidates)) {
    for (const result of directCandidates) {
      if (!result || typeof result !== "object") continue;
      const query = cleanText(result.query || profile.targetGenres.join(" ") || "direct admission");
      consider({
        ...result,
        query,
        discoverySource: result.discoverySource || "direct admission harness",
        discoveryLane: result.discoveryLane || "direct-admission"
      }, options, profile, { query, lane: "direct-admission", trackYield: false });
    }
  } else {
  const modelCandidateLimit = strictRoonMode ? Math.max(40, requestedCount * 4) : Math.max(30, requestedCount * 3);
  modelCandidates = Array.isArray(options.llmCandidates) ? options.llmCandidates.slice(0, modelCandidateLimit) : [];
  if (modelCandidates.length) {
    await mapWithConcurrency(modelCandidates, 2, async (candidate) => {
      if (byKey.size >= candidatePoolTarget) return;
      try {
        const verified = await tidal.verify(candidate, { strict: Boolean(yearRange) });
        if (!verified) {
          discarded.push({ ...candidate, reason: "Local model candidate was not verified in TIDAL." });
          return;
        }
        consider({
          ...verified,
          query: cleanText(`${candidate.artist || ""} ${candidate.title || ""} ${candidate.reason || ""} ${profile.targetGenres.join(" ")} ${profile.vibeTerms.join(" ")}`),
          discoverySource: "Local model seed-vibe candidate"
        }, options, profile, { query: cleanText(`${candidate.artist || ""} ${candidate.title || ""}`), lane: "model" });
      } catch (error) {
        discarded.push({ ...candidate, reason: error.message });
      }
    });
  }

  const artistSeedLimit = wideDiscoveryPool
    ? (isYearCatalogSearch
      ? (strictRoonMode ? 56 : 44)
      : (strictRoonMode ? 36 : 28))
    : (isYearCatalogSearch
    ? (strictRoonMode
      ? Math.min(42, Math.max(30, requestedCount + 24))
      : (smallExactYearSearch ? Math.min(24, Math.max(14, requestedCount + 10)) : Math.min(26, Math.max(18, requestedCount + 12))))
    : (strictRoonMode ? Math.max(12, Math.min(24, requestedCount + 8)) : Math.max(10, Math.min(18, requestedCount + 6))));
  const artistSeeds = buildArtistSeeds(options, artistSeedLimit, tasteProfile, profile, history, freshArtistAvoidance);
  const hasGenreArtistAnchors = Boolean(profile.isGenreDiscoveryTarget && genreArtistAnchors(profile).length);
  const wantsDeepArtistCrawl = /\b(?:deep catalog|catalog crawl|discography|albums?|artist deep dive|accuracy|accurate|scrape)\b/i.test(`${options.request || ""} ${options.reference || ""}`);
  const standbyPool = /^(1|true|yes)$/i.test(String(options.standbyPool || ""));
  const useAlbumExpansion = typeof tidal.getArtistAlbums === "function" && (!options.autoBroaden || standbyPool) && (isYearCatalogSearch
    ? Boolean(strictRoonMode || profile.seedArtists.length || profile.requestedArtists.length || profile.isProgressiveTarget || hasGenreArtistAnchors || wantsDeepArtistCrawl)
    : (standbyPool && profile.tasteProfileLed || strictRoonMode || requestedCount <= 16 || wantsDeepArtistCrawl));
  const albumExpansionReserveMs = smallExactYearSearch && runtimeMs
    ? Math.max(8_000, Math.min(14_000, Math.floor(runtimeMs * 0.4)))
    : 2_500;
  async function expandArtistCatalog() {
    if (!useAlbumExpansion || reachedDiscoveryTarget()) return;
    const artistExpansionLimit = deepCatalog.enabled
      ? Math.min(3, Math.max(2, Math.ceil(requestedCount / 5)))
      : isYearCatalogSearch
      ? (wideDiscoveryPool
        ? (strictRoonMode ? 44 : 30)
        : (strictRoonMode
        ? Math.min(36, Math.max(26, requestedCount + 16))
        : (smallExactYearSearch
          ? (requestedCount <= 2 ? Math.min(34, Math.max(24, requestedCount + 20)) : Math.min(12, Math.max(8, requestedCount + 5)))
          : Math.min(20, Math.max(12, requestedCount + 6)))))
      : (wideDiscoveryPool
        ? (strictRoonMode ? 24 : 16)
        : (standbyPool && profile.tasteProfileLed
          ? Math.min(14, Math.max(10, Math.ceil(requestedCount / 3)))
          : (strictRoonMode ? (requestedCount >= 20 ? 14 : 10) : (requestedCount >= 20 ? 8 : 6))));
    const expansionExcludedArtistKeys = new Set(
      (Array.isArray(options.discoveryExcludedExpansionArtists) ? options.discoveryExcludedExpansionArtists : [])
        .map(artistIdentityKey)
        .filter(Boolean)
    );
    const artistsToExpand = standbyPool && profile.tasteProfileLed
      ? uniqueValues([
        ...artistSeeds.slice(0, Math.max(4, Math.ceil(artistExpansionLimit * 0.5))),
        ...branchArtistSeeds(options, profile, Math.max(8, artistExpansionLimit * 2)),
        ...artistSeeds
      ]).filter((artist) => !expansionExcludedArtistKeys.has(artistIdentityKey(artist))).slice(0, artistExpansionLimit)
      : artistSeeds.filter((artist) => !expansionExcludedArtistKeys.has(artistIdentityKey(artist))).slice(0, artistExpansionLimit);
    artistExpansionArtists.push(...artistsToExpand);
    const deepExpansion = deepCatalog.enabled && selectableCandidateCount() < requestedCount;
    await mapWithConcurrency(artistsToExpand, isYearCatalogSearch ? (strictRoonMode ? 3 : 2) : 2, async (artist) => {
      if (!hasBudget(albumExpansionReserveMs)) {
        noteBudgetExhausted();
        return;
      }
      if (reachedDiscoveryTarget()) return;
      let albums = [];
      try {
        albums = await tidal.getArtistAlbums(artist, {
          limit: isYearCatalogSearch
            ? (strictRoonMode ? 10 : 12)
            : (strictRoonMode
              ? (yearRange ? 12 : 6)
              : (neutralStandbyCatalog ? 12 : (yearRange ? 6 : 3))),
          rotateCatalog: standbyPool || deepExpansion,
          pageCount: deepExpansion ? 2 : 1,
          catalogAnchor: artist,
          onPagination: catalogPageReporter(artist, "artist-expansion")
        });
      } catch (error) {
        recordTidalError(artist, "artist-expansion", error, "getArtistAlbums");
        discarded.push({ query: artist, reason: error.message });
        return;
      }

      let artistAccepted = 0;
      const perArtistLimit = isYearCatalogSearch
        ? (wideDiscoveryPool && !allowsArtistRepeatFallback(options, profile)
          ? 1
          : (strictRoonMode ? 3 : (smallExactYearSearch ? 1 : 2)))
        : (strictRoonMode ? (requestedCount >= 20 ? 5 : 3) : (requestedCount >= 20 ? 3 : 2));
      for (const album of albums) {
        if (!hasBudget(albumExpansionReserveMs)) {
          noteBudgetExhausted();
          break;
        }
        if (artistAccepted >= perArtistLimit || reachedDiscoveryTarget()) break;
        if (yearRange && (!album.year || !yearFits(album.year, yearRange, album.releaseDate))) {
          discarded.push({
            query: `${artist} ${album.title}`,
            reason: album.year
              ? `Album release ${album.releaseDate || album.year} is outside ${yearRange.label}.`
              : `No album release year for ${yearRange.label}.`
          });
          continue;
        }
        let tracks = [];
        try {
          tracks = await tidal.getAlbumTracks(album, {
            fullPage: true,
            limit: isYearCatalogSearch
              ? (strictRoonMode ? 5 : (smallExactYearSearch ? 4 : 3))
              : (strictRoonMode ? 7 : (neutralStandbyCatalog ? 5 : (yearRange ? 4 : 3))),
            rotateCatalog: standbyPool || deepExpansion,
            pageCount: deepExpansion ? 2 : 1,
            catalogAnchor: album.id,
            onPagination: catalogPageReporter(`${artist} ${album.title}`, "artist-expansion")
          });
        } catch (error) {
          recordTidalError(`${artist} ${album.title}`, "artist-expansion", error, "getAlbumTracks");
          discarded.push({ query: `${artist} ${album.title}`, reason: error.message });
          continue;
        }
        for (const track of tracks) {
          const before = byKey.size;
          consider({
            ...track,
            query: `${artist} ${album.title}`,
            discoverySource: discoverySourceForArtist(artist, options, tasteProfile)
          }, options, profile, { query: `${artist} ${album.title}`, lane: "artist-expansion" });
          if (byKey.size > before) artistAccepted += 1;
          if (artistAccepted >= perArtistLimit || reachedDiscoveryTarget()) break;
        }
      }
    });
  }

  // Neutral standby is a reservoir operation, so give the cheaper and more
  // independent search lanes first chance to find fresh catalog. Deep album
  // expansion is valuable, but when it runs first it can consume the entire
  // refresh budget crawling the same few dominant taste artists and prevent
  // label/related-artist search from running at all. Normal discovery keeps
  // its established ordering; only the multi-facet standby reservoir defers
  // the crawl until after the primary search lanes.
  const deferStandbyAlbumExpansion = standbyPool && profile.tasteProfileLed;
  const deferAlbumExpansion = deferStandbyAlbumExpansion || (
    !isYearCatalogSearch && deepCatalog.enabled
  );
  if (useAlbumExpansion && !deferAlbumExpansion) await expandArtistCatalog();

  const searchQueryLimit = isYearCatalogSearch
    ? (wideDiscoveryPool
      ? (strictRoonMode ? 56 : 64)
      : (strictRoonMode ? 28 : (smallExactYearSearch ? 28 : Math.min(14, Math.max(8, requestedCount + 6)))))
    : (wideDiscoveryPool
      ? Math.min(90, Math.max(48, requestedCount * 5))
      : (neutralStandbyCatalog ? 30 : (deepCatalog.enabled ? Math.min(12, Math.max(10, requestedCount + 2)) : 0)));
  const searchQueries = isYearCatalogSearch
    ? queries.slice(0, searchQueryLimit)
    : (wideDiscoveryPool || neutralStandbyCatalog ? queries.slice(0, searchQueryLimit) : queries);
  const coreLane = options.autoBroadenLane || "core";
  const rankedSearchQueries = orderHardDurationQueries(
    rankTrackedQueries(searchQueries, coreLane, "explicit/core genre search")
  );
  const initialCoreQueryLimit = Math.min(6, Math.max(
    profile.isProgressiveTranceTarget ? 5 : 4,
    Math.ceil(requestedCount * 0.4)
  ));
  const initialCoreQueries = deepCatalog.enabled
    ? (profile.isProgressiveTranceTarget
      ? (() => {
        const exactRequestedGenre = normalize(profile.targetGenres?.[0] || "");
        return uniqueValues([
        ...rankedSearchQueries.filter((query) => queryGenerationInfo(query, profile, options).seedType === "artist").slice(0, 4),
        ...rankedSearchQueries.filter((query) => normalize(query) === exactRequestedGenre).slice(0, 1),
        ...rankedSearchQueries.filter((query) => queryGenerationInfo(query, profile, options).seedType === "artist").slice(4, 5),
        ...rankedSearchQueries
        ]).slice(0, initialCoreQueryLimit);
      })()
      : rankedSearchQueries.slice(0, initialCoreQueryLimit))
    : rankedSearchQueries;
  const initialCoreQueryKeys = new Set(initialCoreQueries.map(normalize));
  const deferredCoreQueries = deepCatalog.enabled
    ? rankedSearchQueries.filter(query => !initialCoreQueryKeys.has(normalize(query)))
    : [];

  async function runCoreSearchQueries(queriesToRun = [], { deferred = false } = {}) {
    if (reachedDiscoveryTarget() || !queriesToRun.length) return;
    await mapWithConcurrency(queriesToRun, searchConcurrencyFor(coreLane), async (query) => {
    const queryLane = omnivoreQueryKeys.has(normalize(query)) ? "omnivore" : coreLane;
    const beforeAccepted = candidateCollectionDiagnostics.acceptedCount;
    const beforeDuplicates = candidateCollectionDiagnostics.duplicateCount;
    const queryHasBudget = deferred ? hasBudget(2_500) : hasLaneBudget(queryLane);
    if (!queryHasBudget) {
      recordSearchStop({ query, lane: queryLane, source: deferred ? "deferred taste/core search" : "explicit/core genre search", reason: "budget", attempted: false });
      return;
    }
    if (reachedDiscoveryTarget()) {
      recordSearchStop({ query, lane: queryLane, source: "explicit/core genre search", reason: "target-satisfied", attempted: false });
      return;
    }
    let results = [];
    const queryStartedAt = Date.now();
    try {
      results = await tidal.searchTracks(query, {
        fullPage: true,
        standbyFresh: typeof options.standbyAcceptCandidate === "function",
        rotateCatalog: standbyPool || deepCatalog.enabled,
        catalogAnchor: query,
        onPagination: catalogPageReporter(query, queryLane),
        limit: neutralStandbyCatalog
          ? 16
          : (strictRoonMode ? (isYearCatalogSearch ? 16 : 16) : (isYearCatalogSearch ? (smallExactYearSearch ? 12 : 8) : 6)),
        detailLimit: yearRange?.dateSpecific
          ? (strictRoonMode ? 12 : 8)
            : (yearRange ? (isYearCatalogSearch ? (strictRoonMode ? 5 : (smallExactYearSearch ? 4 : 2)) : (strictRoonMode ? 5 : 3)) : (strictRoonMode ? 3 : 1))
      });
      recordQueryAttempt(query, queryLane, results.length);
    } catch (error) {
      recordQueryError(query, queryLane, error);
      discarded.push({ query, reason: error.message });
      recordQueryExecution({ query, lane: queryLane, source: "explicit/core genre search", startedAt: queryStartedAt, error: true });
      recordSearchStop({ query, lane: queryLane, source: "explicit/core genre search", reason: "error", attempted: true });
      return;
    }

    for (const result of results) {
      consider({
        ...result,
        discoverySource: queryLane === "omnivore"
          ? "Omnivore taste-bridge search"
          : (cleanText(options.autoBroadenLabel) || discoverySourceForResult(result, options)),
        discoveryLane: queryLane === "omnivore"
          ? "omnivore"
          : (options.autoBroadenLane === "adjacent" ? "adjacent" : (result.discoveryLane || options.autoBroadenLane || "core"))
      }, options, profile, { query, lane: queryLane, trackYield: true });
      if (reachedDiscoveryTarget()) break;
    }
    const accepted = candidateCollectionDiagnostics.acceptedCount - beforeAccepted;
    recordQueryExecution({ query, lane: queryLane, source: "explicit/core genre search", startedAt: queryStartedAt, returned: results.length, accepted });
    notePromisingCatalogAnchor({ query, lane: queryLane, source: "explicit/core genre search", accepted });
    const page = latestCatalogPageFor(query, queryLane);
    recordSearchStop({
      query,
      lane: queryLane,
      source: "explicit/core genre search",
      reason: reachedDiscoveryTarget()
        ? "target-satisfied"
        : (paginationAvailableFor(page)
          ? (accepted ? "underfilled-page-available" : "page-available")
          : (results.length ? "catalog-page-exhausted" : "empty-results")),
      returned: results.length,
      accepted,
      rejected: Math.max(0, results.length - accepted),
      duplicates: candidateCollectionDiagnostics.duplicateCount - beforeDuplicates,
      attempted: true
    });
    });
  }

  await runCoreSearchQueries(initialCoreQueries);

  const baseQuotaPlan = discoveryLaneQuotaPlan(requestedCount, profile);
  const branchQuotaTarget = Number(baseQuotaPlan.targets.branch || 0);
  const usedCoreQueries = new Set(searchQueries.map(normalize));
  const branchQueries = buildBranchSearchQueries(options, tasteProfile, profile, history, freshArtistAvoidance)
    .filter((query) => !usedCoreQueries.has(normalize(query)))
    .slice(0, isYearCatalogSearch
      ? (wideDiscoveryPool ? (strictRoonMode ? 56 : 48) : (strictRoonMode ? 28 : 22))
      : (wideDiscoveryPool ? 36 : 16));
  const needsBranchCandidate = () => branchQuotaTarget > 0 && candidateCountForQuotaBucket("branch") < branchQuotaTarget;
  if (branchQueries.length && (needsBranchCandidate() || !reachedDiscoveryTarget())) {
    const rankedBranchQueries = orderHardDurationQueries(
      rankTrackedQueries(branchQueries, "branch", "artist/label branch search")
    );
    if (profile.isProgressiveTranceTarget) {
      // The core lane owns direct artist priority. Reserve the branch lane's
      // first opportunity for a trusted scene label so labels remain present
      // without starving the direct-artist window.
      const trustedLabelBranch = rankedBranchQueries.find((query) => queryStartsWithKnownLabel(query, profile));
      // These artists were excluded from branch planning because the core
      // reservoir owns them. Run their direct queries before spending the
      // remaining budget on labels, genre-suffixed variants, or deeper pages
      // of artists that already fill the per-artist quota.
      const pendingSceneArtists = deferredCoreQueries.filter(query => matchingSceneArtist(query, profile));
      rankedBranchQueries.splice(0, rankedBranchQueries.length, ...uniqueValues([
        trustedLabelBranch, ...pendingSceneArtists, ...rankedBranchQueries
      ].filter(Boolean)));
    }
    await mapWithConcurrency(rankedBranchQueries, searchConcurrencyFor("branch"), async (query) => {
      const beforeAccepted = candidateCollectionDiagnostics.acceptedCount;
      const beforeDuplicates = candidateCollectionDiagnostics.duplicateCount;
      if (!hasLaneBudget("branch")) {
        recordSearchStop({ query, lane: "branch", source: "artist/label branch search", reason: "budget", attempted: false });
        return;
      }
      if (!needsBranchCandidate() && reachedDiscoveryTarget()) {
        recordSearchStop({ query, lane: "branch", source: "artist/label branch search", reason: "target-satisfied", attempted: false });
        return;
      }
      let results = [];
      const queryStartedAt = Date.now();
      try {
        results = await tidal.searchTracks(query, {
          fullPage: true,
          standbyFresh: typeof options.standbyAcceptCandidate === "function",
          rotateCatalog: standbyPool || deepCatalog.enabled,
          catalogAnchor: query,
          onPagination: catalogPageReporter(query, "branch"),
          limit: neutralStandbyCatalog
            ? 14
            : (strictRoonMode ? (isYearCatalogSearch ? 14 : 12) : (isYearCatalogSearch ? (smallExactYearSearch ? 10 : 8) : 6)),
          detailLimit: yearRange?.dateSpecific
            ? (strictRoonMode ? 10 : 7)
            : (yearRange ? (isYearCatalogSearch ? (strictRoonMode ? 4 : (smallExactYearSearch ? 3 : 2)) : 3) : 2)
        });
        recordQueryAttempt(query, "branch", results.length);
      } catch (error) {
        recordQueryError(query, "branch", error);
        discarded.push({ query, reason: error.message });
        recordQueryExecution({ query, lane: "branch", source: "artist/label branch search", startedAt: queryStartedAt, error: true });
        recordSearchStop({ query, lane: "branch", source: "artist/label branch search", reason: "error", attempted: true });
        return;
      }

      for (const result of results) {
        consider({
          ...result,
          discoverySource: "Branch source search",
          discoveryLane: "branch"
        }, options, profile, { query, lane: "branch", trackYield: true });
        if (!needsBranchCandidate() && reachedDiscoveryTarget()) break;
      }
      const accepted = candidateCollectionDiagnostics.acceptedCount - beforeAccepted;
      recordQueryExecution({ query, lane: "branch", source: "artist/label branch search", startedAt: queryStartedAt, returned: results.length, accepted });
      notePromisingCatalogAnchor({ query, lane: "branch", source: "artist/label branch search", accepted });
      recordSearchStop({
        query,
        lane: "branch",
        source: "artist/label branch search",
        reason: (!needsBranchCandidate() && reachedDiscoveryTarget())
          ? "target-satisfied"
          : (paginationAvailableFor(latestCatalogPageFor(query, "branch"))
            ? (accepted ? "underfilled-page-available" : "page-available")
            : (results.length ? "catalog-page-exhausted" : "empty-results")),
        returned: results.length,
        accepted,
        rejected: Math.max(0, results.length - accepted),
        duplicates: candidateCollectionDiagnostics.duplicateCount - beforeDuplicates,
        attempted: true
      });
    });
  }

  // Give trusted scene/label branches their guaranteed first-page window
  // before spending the remaining reserve on slower page-2 recovery.
  await runDeepCatalogPagination();

  // Only spend the remaining core budget after the deep page and trusted
  // branch lanes have had their guaranteed opportunity. These are mostly
  // taste-seeded or lower-confidence queries, so they are never allowed to
  // starve the stronger sources above.
  if (deferredCoreQueries.length && !reachedDiscoveryTarget()) {
    const executedQueries = new Set(queryExecutionDiagnostics.map(item => normalize(item.query)));
    await runCoreSearchQueries(deferredCoreQueries.filter(query => !executedQueries.has(normalize(query))), { deferred: true });
  }

  const adjacentCandidateFloor = Math.min(
    discoveryFillTarget,
    Math.max(requestedCount + (smallExactYearSearch ? 12 : 8), Math.ceil(discoveryFillTarget * (smallExactYearSearch ? 0.7 : 0.55)))
  );
  if (profile.isGenreDiscoveryTarget && !profile.isProgressivePlanningTarget && byKey.size < adjacentCandidateFloor) {
    const usedQueries = new Set([...searchQueries, ...branchQueries].map(normalize));
    const adjacentQueries = buildAdjacentSearchQueries(options, tasteProfile, profile, history, freshArtistAvoidance)
      .filter((query) => !usedQueries.has(normalize(query)))
      .slice(0, isYearCatalogSearch
        ? (wideDiscoveryPool ? (strictRoonMode ? 56 : 48) : (strictRoonMode ? 28 : 22))
        : (wideDiscoveryPool ? 36 : 16));
    const rankedAdjacentQueries = rankTrackedQueries(adjacentQueries, "adjacent", "adjacent bass/genre lane search");

    await mapWithConcurrency(rankedAdjacentQueries, searchConcurrencyFor("adjacent"), async (query) => {
      const beforeAccepted = candidateCollectionDiagnostics.acceptedCount;
      const beforeDuplicates = candidateCollectionDiagnostics.duplicateCount;
      if (!hasLaneBudget("adjacent")) {
        recordSearchStop({ query, lane: "adjacent", source: "adjacent bass/genre lane search", reason: "budget", attempted: false });
        return;
      }
      if (reachedDiscoveryTarget()) {
        recordSearchStop({ query, lane: "adjacent", source: "adjacent bass/genre lane search", reason: "target-satisfied", attempted: false });
        return;
      }
      let results = [];
      const queryStartedAt = Date.now();
      try {
        results = await tidal.searchTracks(query, {
          fullPage: true,
          standbyFresh: typeof options.standbyAcceptCandidate === "function",
          rotateCatalog: standbyPool || deepCatalog.enabled,
          catalogAnchor: query,
          onPagination: catalogPageReporter(query, "adjacent"),
          limit: neutralStandbyCatalog
            ? 16
            : (strictRoonMode ? (isYearCatalogSearch ? 16 : 14) : (isYearCatalogSearch ? (smallExactYearSearch ? 12 : 8) : 8)),
          detailLimit: yearRange?.dateSpecific
            ? (strictRoonMode ? 12 : 8)
            : (yearRange ? (isYearCatalogSearch ? (strictRoonMode ? 5 : (smallExactYearSearch ? 4 : 2)) : 3) : 2)
        });
        recordQueryAttempt(query, "adjacent", results.length);
      } catch (error) {
        recordQueryError(query, "adjacent", error);
        discarded.push({ query, reason: error.message });
        recordQueryExecution({ query, lane: "adjacent", source: "adjacent bass/genre lane search", startedAt: queryStartedAt, error: true });
        recordSearchStop({ query, lane: "adjacent", source: "adjacent bass/genre lane search", reason: "error", attempted: true });
        return;
      }

      for (const result of results) {
        consider({
          ...result,
          discoverySource: "Adjacent lane search",
          discoveryLane: "adjacent"
        }, options, profile, { query, lane: "adjacent", trackYield: true });
        if (reachedDiscoveryTarget()) break;
      }
      const accepted = candidateCollectionDiagnostics.acceptedCount - beforeAccepted;
      recordQueryExecution({ query, lane: "adjacent", source: "adjacent bass/genre lane search", startedAt: queryStartedAt, returned: results.length, accepted });
      notePromisingCatalogAnchor({ query, lane: "adjacent", source: "adjacent bass/genre lane search", accepted });
      recordSearchStop({
        query,
        lane: "adjacent",
        source: "adjacent bass/genre lane search",
        reason: reachedDiscoveryTarget()
          ? "target-satisfied"
          : (paginationAvailableFor(latestCatalogPageFor(query, "adjacent"))
            ? (accepted ? "underfilled-page-available" : "page-available")
            : (results.length ? "catalog-page-exhausted" : "empty-results")),
        returned: results.length,
        accepted,
        rejected: Math.max(0, results.length - accepted),
        duplicates: candidateCollectionDiagnostics.duplicateCount - beforeDuplicates,
        attempted: true
      });
    });
  }

  async function runDeepCatalogPagination() {
  if (deepCatalog.enabled && selectableCandidateCount() < requestedCount) {
    const deepTarget = Math.min(
      discoveryFillTarget,
      Math.max(requestedCount + 4, requestedCount * 2)
    );
    const anchors = [...promisingCatalogAnchors.values()]
      .sort((left, right) => (
        Number(right.accepted || 0) - Number(left.accepted || 0) ||
        Number(right.genreCompatibilityScore || 0) - Number(left.genreCompatibilityScore || 0) ||
        left.query.localeCompare(right.query)
      ))
      .slice(0, Math.min(4, Math.max(3, requestedCount)));
    deepCatalog.triggered = true;
    deepCatalog.anchors = anchors.map(anchor => ({ ...anchor }));
    if (!anchors.length) {
      deepCatalog.triggerReason = "candidate pool under target, but no paginated source produced a current-run accepted candidate";
      deepCatalog.stoppedReason = "no-promising-page-available";
    } else {
      deepCatalog.triggerReason = "candidate pool under target and a paginated source produced current-run accepted candidates";
      for (const anchor of anchors) {
        if (reachedDiscoveryTarget(deepTarget)) {
          deepCatalog.stoppedReason = "target-satisfied";
          break;
        }
        // Keep a real reserve for any remaining recovery work; deep pagination
        // runs only after the core and trusted branch first-page windows have
        // had their opportunity.
        if (!hasBudget(8_000)) {
          deepCatalog.stoppedReason = "budget";
          noteBudgetExhausted();
          break;
        }

        const beforeAccepted = candidateCollectionDiagnostics.acceptedCount;
        const beforeDuplicates = candidateCollectionDiagnostics.duplicateCount;
        let results = [];
        const queryStartedAt = Date.now();
        try {
          results = await tidal.searchTracks(anchor.query, {
            fullPage: true,
            standbyFresh: typeof options.standbyAcceptCandidate === "function",
            rotateCatalog: true,
            pageCount: deepCatalog.pageCount,
            catalogAnchor: anchor.query,
            onPagination: catalogPageReporter(anchor.query, anchor.lane),
            limit: strictRoonMode ? 12 : 8,
            // The initial search pages already carry the fields needed for
            // the hard-duration gate. Avoid serial detail lookups during the
            // recovery pass; detailed enrichment remains available to the
            // normal resolver paths.
            detailLimit: strictRoonMode ? 2 : 0
          });
          recordQueryAttempt(anchor.query, anchor.lane, results.length);
        } catch (error) {
          recordQueryError(anchor.query, anchor.lane, error);
          deepCatalog.stoppedReason = "error";
          recordQueryExecution({ query: anchor.query, lane: anchor.lane, source: "deep catalog pagination", startedAt: queryStartedAt, error: true, deepPagination: true });
          recordSearchStop({
            query: anchor.query,
            lane: anchor.lane,
            source: "deep catalog pagination",
            reason: "error",
            attempted: true
          });
          continue;
        }

        for (const result of results) {
          consider({
            ...result,
            discoverySource: "Deep catalog pagination",
            discoveryLane: anchor.lane
          }, options, profile, { query: anchor.query, lane: anchor.lane, trackYield: true });
          if (reachedDiscoveryTarget(deepTarget)) break;
        }

        const accepted = candidateCollectionDiagnostics.acceptedCount - beforeAccepted;
        const duplicates = candidateCollectionDiagnostics.duplicateCount - beforeDuplicates;
        recordQueryExecution({ query: anchor.query, lane: anchor.lane, source: "deep catalog pagination", startedAt: queryStartedAt, returned: results.length, accepted, deepPagination: true });
        deepCatalog.attempted += 1;
        deepCatalog.returned += results.length;
        deepCatalog.accepted += accepted;
        deepCatalog.duplicateCount += duplicates;
        const page = latestCatalogPageFor(anchor.query, anchor.lane);
        recordSearchStop({
          query: anchor.query,
          lane: anchor.lane,
          source: "deep catalog pagination",
          reason: reachedDiscoveryTarget(deepTarget)
            ? "target-satisfied"
            : (paginationAvailableFor(page)
              ? (accepted ? "underfilled-page-available" : "page-available")
              : (results.length ? "catalog-exhausted" : "empty-results")),
          returned: results.length,
          accepted,
          rejected: Math.max(0, results.length - accepted),
          duplicates,
          attempted: true
        });
      }
      if (!deepCatalog.stoppedReason) deepCatalog.stoppedReason = "candidates-exhausted";
    }
  } else if (deepCatalog.enabled) {
    deepCatalog.stoppedReason = "requested-count-already-met";
  }
  }

  if (deferAlbumExpansion && selectableCandidateCount() < requestedCount && hasBudget(6_000)) {
    await expandArtistCatalog();
  }

  relaxedYearOptions = selectableCandidateCount() < requestedCount ? nearYearFallbackOptions(options, yearRange) : null;
  if (relaxedYearOptions) {
    const relaxedProfile = buildDiscoveryProfile(relaxedYearOptions);
    const usedQueries = new Set(searchQueries.map(normalize));
    const relaxedFreshArtistAvoidance = buildFreshArtistAvoidance(relaxedYearOptions, history, tasteProfile);
    const relaxedQueries = buildSceneAnchorRecentQueries(relaxedYearOptions, tasteProfile, relaxedProfile, history, relaxedFreshArtistAvoidance)
      .filter((query) => !usedQueries.has(normalize(query)))
      .slice(0, strictRoonMode ? 72 : 56);
    const rankedRelaxedQueries = rankTrackedQueries(relaxedQueries, "recent", "recent-year fallback search");

    await mapWithConcurrency(rankedRelaxedQueries, searchConcurrencyFor("recent"), async (query) => {
      if (!hasLaneBudget("recent")) {
        return;
      }
      if (reachedDiscoveryTarget()) return;
      let results = [];
      const queryStartedAt = Date.now();
      try {
        results = await tidal.searchTracks(query, {
          fullPage: true,
          standbyFresh: typeof options.standbyAcceptCandidate === "function",
          rotateCatalog: standbyPool || deepCatalog.enabled,
          catalogAnchor: query,
          onPagination: catalogPageReporter(query, "recent"),
          limit: strictRoonMode ? 14 : 10,
          detailLimit: strictRoonMode ? 5 : 4
        });
        recordQueryAttempt(query, "recent", results.length);
      } catch (error) {
        recordQueryError(query, "recent", error);
        discarded.push({ query, reason: error.message });
        recordQueryExecution({ query, lane: "recent", source: "recent-year fallback search", startedAt: queryStartedAt, error: true });
        return;
      }

      const beforeAccepted = candidateCollectionDiagnostics.acceptedCount;
      for (const result of results) {
        consider({
          ...result,
          discoverySource: "Recent-year fallback search",
          discoveryLane: "recent"
        }, relaxedYearOptions, relaxedProfile, { query, lane: "recent", trackYield: true });
        if (reachedDiscoveryTarget()) break;
      }
      recordQueryExecution({
        query,
        lane: "recent",
        source: "recent-year fallback search",
        startedAt: queryStartedAt,
        returned: results.length,
        accepted: candidateCollectionDiagnostics.acceptedCount - beforeAccepted
      });
    });
  }

  if (adaptiveRecovery.enabled) {
    function currentLaneShortfalls() {
      return laneQuotaShortfalls(baseQuotaPlan.targets, {
        omnivore: candidateCountForQuotaBucket("omnivore"),
        label: candidateCountForQuotaBucket("label"),
        adjacent: candidateCountForQuotaBucket("adjacent"),
        branch: candidateCountForQuotaBucket("branch")
      });
    }

    const recoveryDecision = shouldRunAdaptiveQueryRecovery({
      keptCount: byKey.size,
      requestedCount,
      usefulCandidateTarget,
      queryYield: queryYieldSnapshot(),
      budgetAvailable: hasBudget(3_500),
      laneShortfalls: currentLaneShortfalls()
    });
    if (recoveryDecision.run) {
      const usedQueries = new Set(Array.from(queryYieldRecords.values()).map((record) => normalize(record.query)).filter(Boolean));
      const targetLaneSet = new Set((recoveryDecision.lanes || []).map(cleanText).filter(Boolean));
      const recoveringStarvedLanes = targetLaneSet.size > 0;
      const families = buildAdaptiveRecoveryQueryFamilies(options, tasteProfile, profile, artistSeeds, usedQueries, history, freshArtistAvoidance)
        .filter((family) => !recoveringStarvedLanes || targetLaneSet.has(cleanText(family.lane)));
      const maxRecoveryQueries = wideDiscoveryPool
        ? (strictRoonMode ? 42 : 36)
        : Math.max(12, Math.min(30, requestedCount * 4));
      let remainingQueries = maxRecoveryQueries;
      adaptiveRecovery.triggered = true;
      adaptiveRecovery.reason = recoveryDecision.reason;
      adaptiveRecovery.keptBefore = byKey.size;
      adaptiveRecovery.targetLanes = [...targetLaneSet];
      adaptiveRecovery.laneShortfalls = recoveryDecision.laneShortfalls || [];

      for (const family of families) {
        if (!remainingQueries || (!recoveringStarvedLanes && reachedDiscoveryTarget()) || !hasBudget(2_500)) break;
        if (recoveringStarvedLanes && !currentLaneShortfalls().some((item) => targetLaneSet.has(item.bucket))) break;
        const queryLane = cleanText(family.lane || "adaptive-recovery") || "adaptive-recovery";
        const familyQueries = rankTrackedQueries(family.queries, queryLane, `adaptive recovery: ${family.label}`).slice(0, remainingQueries);
        if (!familyQueries.length) continue;
        const familyStats = {
          id: family.id,
          label: family.label,
          lane: family.lane,
          queries: familyQueries.length,
          attempted: 0,
          returned: 0,
          accepted: 0,
          rejected: 0,
          seoRejects: 0,
          genreRejects: 0,
          errors: 0
        };
        adaptiveRecovery.families.push(familyStats);
        remainingQueries -= familyQueries.length;

        await mapWithConcurrency(familyQueries, 2, async (query) => {
          if (!hasLaneBudget(queryLane)) return;
           if (!recoveringStarvedLanes && reachedDiscoveryTarget()) return;
           let results = [];
           const queryStartedAt = Date.now();
           try {
            results = await tidal.searchTracks(query, {
              fullPage: true,
              standbyFresh: typeof options.standbyAcceptCandidate === "function",
              rotateCatalog: standbyPool || deepCatalog.enabled,
              catalogAnchor: query,
              onPagination: catalogPageReporter(query, queryLane),
              limit: neutralStandbyCatalog
                ? 16
                : (strictRoonMode ? (isYearCatalogSearch ? 14 : 12) : (isYearCatalogSearch ? 10 : 8)),
              detailLimit: yearRange?.dateSpecific
                ? (strictRoonMode ? 9 : 7)
                : (yearRange ? (strictRoonMode ? 4 : 3) : 2)
            });
            recordQueryAttempt(query, queryLane, results.length);
            familyStats.attempted += 1;
            familyStats.returned += results.length;
            adaptiveRecovery.attempted += 1;
            adaptiveRecovery.returned += results.length;
           } catch (error) {
             recordQueryError(query, queryLane, error);
            familyStats.attempted += 1;
            familyStats.errors += 1;
            adaptiveRecovery.attempted += 1;
             adaptiveRecovery.errors += 1;
             discarded.push({ query, reason: error.message });
             recordQueryExecution({ query, lane: queryLane, source: `adaptive recovery: ${family.label}`, startedAt: queryStartedAt, error: true });
             return;
          }

          let acceptedForQuery = 0;
          for (const result of results) {
            const before = byKey.size;
            const discardedBefore = discarded.length;
            consider({
              ...result,
              discoverySource: `Adaptive recovery: ${family.label}`,
              discoveryLane: family.lane || "core"
            }, options, profile, { query, lane: queryLane, trackYield: true });
            if (byKey.size > before) {
              acceptedForQuery += 1;
              familyStats.accepted += 1;
              adaptiveRecovery.accepted += 1;
            }
            for (const item of discarded.slice(discardedBefore)) {
              const bucket = rejectionBucketForReason(item.reason);
              if (bucket === "seo") familyStats.seoRejects += 1;
              if (bucket === "genre") familyStats.genreRejects += 1;
            }
            if (!recoveringStarvedLanes && reachedDiscoveryTarget()) break;
           }
           familyStats.rejected += Math.max(0, results.length - acceptedForQuery);
           recordQueryExecution({ query, lane: queryLane, source: `adaptive recovery: ${family.label}`, startedAt: queryStartedAt, returned: results.length, accepted: acceptedForQuery });
         });
      }
      adaptiveRecovery.keptAfter = byKey.size;
    }
  }

  }

  const candidates = Array.from(byKey.values())
    .sort((left, right) => right.score - left.score || (right.durationMs || 0) - (left.durationMs || 0));
  let laneSelection = selectDiscoveryLaneCandidates(candidates, requestedCount, options, profile, quotaCalibration);
  let tracks = laneSelection.tracks;
  let minimumRescueKept = 0;

  if (tracks.length < requestedCount && minimumRescueCandidates.length) {
    const selectedKeys = new Set(tracks.flatMap(candidateIdentityKeys));
    const rescuePool = minimumRescueCandidates
      .filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key)))
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));

    if (rescuePool.length) {
      const rescuedSelection = selectDiscoveryLaneCandidates(
        mergeCandidateLists(tracks, rescuePool),
        requestedCount,
        options,
        profile,
        quotaCalibration
      );
      tracks = rescuedSelection.tracks;
      minimumRescueKept = tracks.filter((candidate) => candidate.belowMinimumRescue).length;
      laneSelection = {
        tracks,
        alternates: mergeCandidateLists(rescuedSelection.alternates, laneSelection.alternates),
        quota: {
          ...(rescuedSelection.quota || {}),
          rescueApplied: minimumRescueKept > 0,
          rescueAvailable: rescuePool.length,
          rescueKept: minimumRescueKept
        }
      };
    }
  }

  // Novelty is a preference, not a hard availability gate. Once all fresh
  // candidates have gone through lane selection, promote already-seen tracks
  // that passed the same catalogue, identity, genre, duration, and rating
  // checks. Explicit no-repeat requests and strict fresh-artist requests stay
  // authoritative; the normal request path may use this only to backfill an
  // otherwise empty or short pool.
  let previousFallbackKept = 0;
  const automaticPreviousFallbackAllowed = Boolean(
    !allowPreviousSuggestions &&
    !explicitlyForbidsPreviouslySuggested(options) &&
    !requestRequiresFreshArtists(options) &&
    previousCandidates.length
  );
  if (tracks.length < requestedCount && automaticPreviousFallbackAllowed) {
    const selectedKeys = new Set(tracks.flatMap(candidateIdentityKeys));
    const selectedArtistCounts = new Map();
    const selectedAlbumCounts = new Map();
    const selectedLabelCounts = new Map();
    for (const track of tracks) {
      for (const artistKey of artistKeysForCandidate(track)) {
        selectedArtistCounts.set(artistKey, (selectedArtistCounts.get(artistKey) || 0) + 1);
      }
      const albumKey = normalize(track.album);
      if (albumKey) selectedAlbumCounts.set(albumKey, (selectedAlbumCounts.get(albumKey) || 0) + 1);
      const labelKey = labelDiversityKeyForCandidate(track, profile);
      if (labelKey) selectedLabelCounts.set(labelKey, (selectedLabelCounts.get(labelKey) || 0) + 1);
    }
    const sortedPreviousCandidates = previousCandidates.slice().sort((left, right) => (
      Number(right.score || 0) - Number(left.score || 0) ||
      Number(right.durationMs || 0) - Number(left.durationMs || 0)
    ));

    function addPreviousCandidateFallback(candidate = {}, caps = {}) {
      if (tracks.length >= requestedCount) return false;
      const keys = candidateIdentityKeys(candidate);
      if (!keys.length || keys.some((key) => selectedKeys.has(key))) return false;
      const artistKeys = artistKeysForCandidate(candidate);
      const albumKey = normalize(candidate.album);
      const labelKey = labelDiversityKeyForCandidate(candidate, profile);
      const artistCap = caps.artistCap ?? defaultPerRunArtistCap(options, profile, requestedCount);
      const albumCap = caps.albumCap ?? 1;
      const labelCap = caps.labelCap ?? defaultPerRunLabelCap(options, profile, requestedCount);
      if (artistKeys.some((key) => (selectedArtistCounts.get(key) || 0) >= artistCap)) return false;
      if (albumKey && (selectedAlbumCounts.get(albumKey) || 0) >= albumCap) return false;
      if (labelKey && Number.isFinite(labelCap) && (selectedLabelCounts.get(labelKey) || 0) >= labelCap) return false;

      const fallbackCandidate = {
        ...candidate,
        previousFallbackRelaxed: true,
        reason: `${candidate.reason}; kept after fresh candidates were exhausted`,
        statusChecks: Array.from(new Set([
          ...(candidate.statusChecks || []),
          "Previously suggested fallback after fresh pool undershoot"
        ])),
        why: [
          ...(candidate.why || []),
          "Backfilled from an otherwise valid previous suggestion because fresh candidates undershot."
        ].slice(0, 8)
      };
      tracks.push(fallbackCandidate);
      for (const key of keys) selectedKeys.add(key);
      for (const artistKey of artistKeys) {
        selectedArtistCounts.set(artistKey, (selectedArtistCounts.get(artistKey) || 0) + 1);
      }
      if (albumKey) selectedAlbumCounts.set(albumKey, (selectedAlbumCounts.get(albumKey) || 0) + 1);
      if (labelKey) selectedLabelCounts.set(labelKey, (selectedLabelCounts.get(labelKey) || 0) + 1);
      previousFallbackKept += 1;
      recordCandidateAccumulation(candidate, { query: candidate.tidal?.query, lane: candidate.discoveryLane }, candidate.tidal);
      updateDurationCandidateDiagnostic(candidate, {
        candidateAccumulation: {
          status: "selected-fallback",
          stage: "novelty-fallback",
          reason: "Promoted after fresh candidates undershot the requested count."
        },
        droppedStage: "",
        droppedReason: ""
      });
      return true;
    }

    const fallbackStages = [
      {
        artistCap: defaultPerRunArtistCap(options, profile, requestedCount),
        albumCap: 1,
        labelCap: defaultPerRunLabelCap(options, profile, requestedCount)
      },
      {
        artistCap: Math.max(2, Math.min(3, requestedCount)),
        albumCap: 2,
        labelCap: Math.max(2, Math.min(requestedCount, defaultPerRunLabelCap(options, profile, requestedCount)))
      },
      { artistCap: Number.MAX_SAFE_INTEGER, albumCap: Number.MAX_SAFE_INTEGER, labelCap: Number.MAX_SAFE_INTEGER }
    ];
    for (const caps of fallbackStages) {
      for (const candidate of sortedPreviousCandidates) {
        if (tracks.length >= requestedCount) break;
        addPreviousCandidateFallback(candidate, caps);
      }
      if (tracks.length >= requestedCount) break;
    }
    laneSelection = {
      ...laneSelection,
      tracks,
      quota: {
        ...(laneSelection.quota || {}),
        previousFallbackApplied: previousFallbackKept > 0,
        previousFallbackAvailable: previousCandidates.length,
        previousFallbackKept
      }
    };
  }

  const fallbackAlternates = [];
  if (allowPreviousFallback && tracks.length < requestedCount && typeof history?.fallbackCandidates === "function") {
    const fallbackEntries = history.fallbackCandidates({ limit: Math.max(60, requestedCount * 4) });
    const fallbackCandidates = [];
    const fallbackSeenKeys = new Set(tracks.flatMap(candidateIdentityKeys));
    const fallbackAlternateTarget = Math.max(15, requestedCount);

    for (const entry of fallbackEntries) {
      if (fallbackCandidates.length >= Math.max(60, requestedCount * 4)) break;
      const entryKeys = candidateIdentityKeys(entry);
      if (!entryKeys.length || entryKeys.some((key) => fallbackSeenKeys.has(key))) continue;

      try {
        const tidalId = tidalTrackIdFromUrl(entry.tidalUrl);
        const result = tidalId && typeof tidal.getTrack === "function"
          ? await tidal.getTrack(tidalId, `${entry.artist} ${entry.title}`)
          : await tidal.verify?.({ artist: entry.artist, title: entry.title }, { strict: Boolean(yearRange) });
        if (!result) continue;

        const reason = rejectReason(result, options, profile);
        if (reason) {
          discarded.push(discardWithDiagnostics(result, reason, options, profile));
          continue;
        }

        const admissionDiagnostics = admissionDiagnosticsFor(result, options, profile);

        const scoreBreakdown = scoreBreakdownFor(result, options, tasteProfile, profile, scrobbleHistory);
        const candidate = {
          artist: result.artist,
          title: result.title,
          album: result.album,
          label: result.label || "",
          year: result.year || null,
          releaseDate: result.releaseDate || "",
          durationMs: result.durationMs || null,
          reason: `${reasonFor(result, options, scoreBreakdown, profile)}; previously suggested`,
          why: whyBulletsFor(result, options, scoreBreakdown, entry, profile),
          discoverySource: "Previous discovery fallback",
          discoveryLane: result.discoveryLane || "core",
          score: scoreBreakdown.total,
          scoreBreakdown,
          tidal: result,
          statusChecks: discoveryStatusFor(result, entry, true, scrobbleHistory),
          admissionDiagnostics,
          verificationSource: "tidal"
        };
        candidate.feedback = typeof tasteProfile?.getFeedbackFor === "function" ? tasteProfile.getFeedbackFor(candidate) : "";
        if (minScore && candidate.score < minScore) {
          const belowMinimumReason = `Discovery score ${candidate.score} is below minimum ${minScoreLabel}.`;
          candidate.belowMinimum = true;
          candidate.minimumScore = minScore;
          candidate.minimumScoreLabel = minScoreLabel;
          candidate.reason = `${candidate.reason}; below ${minScoreLabel} floor`;
          candidate.statusChecks = [...candidate.statusChecks, belowMinimumReason];
          const hardDurationReason = durationConstraintReason(candidate.tidal || candidate, options);
          if (hardDurationReason) {
            discarded.push(discardWithDiagnostics(candidate, hardDurationReason, options, profile, "duration-constraints"));
            continue;
          }
          const softRejectReason = belowMinimumSoftRejectReason(candidate, profile, options);
          if (softRejectReason) {
            discarded.push(discardWithDiagnostics(candidate, softRejectReason, options, profile, "score-threshold"));
            continue;
          }
          scoreFiltered.push({
            ...candidate,
            reason: belowMinimumReason
          });
        }
        const keys = candidateIdentityKeys(candidate);
        if (keys.length && !keys.some((key) => fallbackSeenKeys.has(key))) {
          for (const key of keys) fallbackSeenKeys.add(key);
          fallbackCandidates.push(candidate);
        }
      } catch (error) {
        discarded.push({ artist: entry.artist, title: entry.title, reason: error.message });
      }
    }

    const fallbackArtistCounts = new Map();
    const fallbackAlbumCounts = new Map();
    const fallbackLabelCounts = new Map();
    for (const track of tracks) {
      for (const artistKey of artistKeysForCandidate(track)) {
        fallbackArtistCounts.set(artistKey, (fallbackArtistCounts.get(artistKey) || 0) + 1);
      }
      const albumKey = normalize(track.album);
      if (albumKey) fallbackAlbumCounts.set(albumKey, (fallbackAlbumCounts.get(albumKey) || 0) + 1);
      const labelKey = labelDiversityKeyForCandidate(track, profile);
      if (labelKey) fallbackLabelCounts.set(labelKey, (fallbackLabelCounts.get(labelKey) || 0) + 1);
    }

    function addPreviousFallback(candidate = {}, caps = {}) {
      if (tracks.length >= requestedCount) return false;
      const artistCap = caps.artistCap ?? defaultPerRunArtistCap(options, profile, requestedCount);
      const albumCap = caps.albumCap ?? 1;
      const labelCap = caps.labelCap ?? defaultPerRunLabelCap(options, profile, requestedCount);
      const artistKeys = artistKeysForCandidate(candidate);
      const albumKey = normalize(candidate.album);
      const labelKey = labelDiversityKeyForCandidate(candidate, profile);
      if (artistKeys.some((key) => (fallbackArtistCounts.get(key) || 0) >= artistCap)) return false;
      if (albumKey && (fallbackAlbumCounts.get(albumKey) || 0) >= albumCap) return false;
      if (labelKey && Number.isFinite(labelCap) && (fallbackLabelCounts.get(labelKey) || 0) >= labelCap) return false;

      tracks.push({
        ...candidate,
        previousFallbackRelaxed: true,
        reason: `${candidate.reason}; selected after diverse candidates were exhausted`,
        statusChecks: Array.from(new Set([...(candidate.statusChecks || []), "Previous fallback diversity policy applied"])),
        why: [...(candidate.why || []), "Backfilled from history after current-catalogue candidates undershot."].slice(0, 8)
      });
      previousFallbackKept += 1;
      recordCandidateAccumulation(candidate, { query: candidate.tidal?.query, lane: candidate.discoveryLane }, candidate.tidal);
      if (candidate.tidal?.query) recordQueryAccepted(candidate.tidal.query, candidate.discoveryLane || "core");
      for (const key of artistKeys) fallbackArtistCounts.set(key, (fallbackArtistCounts.get(key) || 0) + 1);
      if (albumKey) fallbackAlbumCounts.set(albumKey, (fallbackAlbumCounts.get(albumKey) || 0) + 1);
      if (labelKey) fallbackLabelCounts.set(labelKey, (fallbackLabelCounts.get(labelKey) || 0) + 1);
      return true;
    }

    const sortedFallbackCandidates = fallbackCandidates.slice().sort((left, right) => (
      Number(right.score || 0) - Number(left.score || 0) ||
      Number(right.durationMs || 0) - Number(left.durationMs || 0)
    ));
    const fallbackStages = [
      {
        artistCap: defaultPerRunArtistCap(options, profile, requestedCount),
        albumCap: 1,
        labelCap: defaultPerRunLabelCap(options, profile, requestedCount)
      },
      {
        artistCap: Math.max(2, Math.min(3, requestedCount)),
        albumCap: 2,
        labelCap: Math.max(2, Math.min(requestedCount, defaultPerRunLabelCap(options, profile, requestedCount)))
      },
      { artistCap: Number.MAX_SAFE_INTEGER, albumCap: Number.MAX_SAFE_INTEGER, labelCap: Number.MAX_SAFE_INTEGER }
    ];
    for (const stage of fallbackStages) {
      for (const candidate of sortedFallbackCandidates) {
        if (tracks.length >= requestedCount) break;
        addPreviousFallback(candidate, stage);
      }
      if (tracks.length >= requestedCount) break;
    }
    for (const candidate of sortedFallbackCandidates) {
      if (fallbackAlternates.length >= fallbackAlternateTarget) break;
      if (!candidateIdentityKeys(candidate).some((key) => tracks.flatMap(candidateIdentityKeys).includes(key))) {
        fallbackAlternates.push(candidate);
      }
    }
  }

  let belowMinimumCountFillKept = 0;
  const allowCountFillFallback = requestedCount >= 8 && profile.scoringMode !== "pure" &&
    !/^(1|true|yes)$/i.test(String(options.standbyPool || ""));
  if (allowCountFillFallback && tracks.length < requestedCount && (scoreFiltered.length || countFillCandidates.length)) {
    const selectedKeysForCountFill = new Set(tracks.flatMap(candidateIdentityKeys));
    const selectedArtistCounts = new Map();
    const selectedAlbumCounts = new Map();
    const previousKeysForCountFill = new Set(previousCandidates.flatMap(candidateIdentityKeys));

    for (const track of tracks) {
      for (const artistKey of artistKeysForCandidate(track)) {
        selectedArtistCounts.set(artistKey, (selectedArtistCounts.get(artistKey) || 0) + 1);
      }
      const albumKey = normalize(track.album);
      if (albumKey) selectedAlbumCounts.set(albumKey, (selectedAlbumCounts.get(albumKey) || 0) + 1);
    }

    function sortedCountFillPool(pool = []) {
      return mergeCandidateLists(pool)
        .sort((left, right) => (
          Number(repeatedArtistDiversityPenaltyApplies(left, options, profile)) - Number(repeatedArtistDiversityPenaltyApplies(right, options, profile)) ||
          Number(right.score || 0) - Number(left.score || 0) ||
          Number(right.durationMs || 0) - Number(left.durationMs || 0)
        ));
    }

    function addBelowMinimumCountFill(candidate = {}, caps = {}) {
      if (tracks.length >= requestedCount) return false;
      const keys = candidateIdentityKeys(candidate);
      if (!keys.length || keys.some((key) => selectedKeysForCountFill.has(key) || previousKeysForCountFill.has(key))) return false;

      const score = Number(candidate.score || 0);
      if (score < Number(caps.minScore || 0)) return false;
      const repeatedArtist = repeatedArtistDiversityPenaltyApplies(candidate, options, profile);
      if (caps.avoidRepeatedArtists && repeatedArtist) return false;

      const artistKeys = artistKeysForCandidate(candidate);
      const albumKey = normalize(candidate.album);
      const artistCap = caps.artistCap ?? 1;
      const albumCap = caps.albumCap ?? 1;
      if (artistKeys.some((artistKey) => (selectedArtistCounts.get(artistKey) || 0) >= artistCap)) return false;
      if (albumKey && (selectedAlbumCounts.get(albumKey) || 0) >= albumCap) return false;

      for (const key of keys) selectedKeysForCountFill.add(key);
      for (const artistKey of artistKeys) {
        selectedArtistCounts.set(artistKey, (selectedArtistCounts.get(artistKey) || 0) + 1);
      }
      if (albumKey) selectedAlbumCounts.set(albumKey, (selectedAlbumCounts.get(albumKey) || 0) + 1);

      belowMinimumCountFillKept += 1;
      tracks.push({
        ...candidate,
        belowMinimum: true,
        belowMinimumCountFill: true,
        reason: cleanText(candidate.reason).includes("count-fill")
          ? candidate.reason
          : `${candidate.reason}; kept as count-fill near-miss because the run undershot the requested count`,
        statusChecks: Array.from(new Set([
          ...(candidate.statusChecks || []),
          "Below-minimum count-fill fallback"
        ])),
        why: [
          ...(candidate.why || []),
          "Kept as a near-miss fallback because the strict score floor left the request short."
        ].filter(Boolean).slice(0, 8)
      });
      return true;
    }

    const nearFloor = minScore ? Math.max(45, minScore - 8) : 45;
    const wideFloor = minScore ? Math.max(45, minScore - 15) : 45;
    const countFillStages = [
      { pool: scoreFiltered, minScore: nearFloor, avoidRepeatedArtists: true, artistCap: 1, albumCap: 1 },
      { pool: countFillCandidates, minScore: wideFloor, avoidRepeatedArtists: true, artistCap: 1, albumCap: 1 },
      { pool: scoreFiltered, minScore: 45, avoidRepeatedArtists: true, artistCap: 1, albumCap: 1 },
      { pool: countFillCandidates, minScore: 45, avoidRepeatedArtists: true, artistCap: 1, albumCap: 1 },
      { pool: mergeCandidateLists(scoreFiltered, countFillCandidates), minScore: 50, avoidRepeatedArtists: false, artistCap: 1, albumCap: 1 }
    ];

    for (const stage of countFillStages) {
      if (tracks.length >= requestedCount) break;
      for (const candidate of sortedCountFillPool(stage.pool)) {
        if (tracks.length >= requestedCount) break;
        addBelowMinimumCountFill(candidate, stage);
      }
    }

    if (belowMinimumCountFillKept) {
      laneSelection = {
        ...laneSelection,
        tracks,
        quota: {
          ...(laneSelection.quota || {}),
          countFillApplied: true,
          countFillAvailable: mergeCandidateLists(scoreFiltered, countFillCandidates).length,
          countFillKept: belowMinimumCountFillKept
        }
      };
    }
  }

  function artistNoveltyPriorCount(candidate = {}) {
    const match = String(candidate.artistNoveltyReason || candidate.reason || "").match(/\((\d+)\s+prior track/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  let artistNoveltyFallbackKept = 0;
  if (!requestRequiresStrictFreshArtists(options) && tracks.length < requestedCount && artistNoveltyCandidates.length) {
    const selectedKeysForNovelty = new Set(tracks.flatMap(candidateIdentityKeys));
    const selectedArtistCounts = new Map();
    const selectedAlbumCounts = new Map();
    for (const track of tracks) {
      for (const artistKey of artistKeysForCandidate(track)) {
        selectedArtistCounts.set(artistKey, (selectedArtistCounts.get(artistKey) || 0) + 1);
      }
      const albumKey = normalize(track.album);
      if (albumKey) selectedAlbumCounts.set(albumKey, (selectedAlbumCounts.get(albumKey) || 0) + 1);
    }
    const noveltyPool = artistNoveltyCandidates
      .filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeysForNovelty.has(key)))
      .sort((left, right) => (
        artistNoveltyPriorCount(left) - artistNoveltyPriorCount(right) ||
        Number(right.score || 0) - Number(left.score || 0) ||
        Number(right.durationMs || 0) - Number(left.durationMs || 0)
      ));

    function addArtistNoveltyFallback(candidate = {}, caps = {}) {
      if (tracks.length >= requestedCount) return false;
      const keys = candidateIdentityKeys(candidate);
      if (!keys.length || keys.some((key) => selectedKeysForNovelty.has(key))) return false;
      const artistKeys = artistKeysForCandidate(candidate);
      const albumKey = normalize(candidate.album);
      const artistCap = caps.artistCap ?? 1;
      const albumCap = caps.albumCap ?? 1;
      if (artistKeys.some((artistKey) => (selectedArtistCounts.get(artistKey) || 0) >= artistCap)) return false;
      if (albumKey && (selectedAlbumCounts.get(albumKey) || 0) >= albumCap) return false;
      for (const key of keys) selectedKeysForNovelty.add(key);
      for (const artistKey of artistKeys) {
        selectedArtistCounts.set(artistKey, (selectedArtistCounts.get(artistKey) || 0) + 1);
      }
      if (albumKey) selectedAlbumCounts.set(albumKey, (selectedAlbumCounts.get(albumKey) || 0) + 1);
      artistNoveltyFallbackKept += 1;
      tracks.push({
        ...candidate,
        artistNoveltyRelaxed: true,
        reason: `${candidate.reason}; kept because fresh-artist filtering undershot the requested count`,
        statusChecks: Array.from(new Set([
          ...(candidate.statusChecks || []),
          "Artist novelty relaxed after undershoot"
        ])),
        why: [
          ...(candidate.why || []),
          "Kept as the least-repeated artist fallback because the fresh-artist search undershot."
        ].slice(0, 8)
      });
      return true;
    }

    const fallbackStages = allowsArtistRepeatFallback(options, profile)
      ? [
          { artistCap: 1, albumCap: 1 },
          { artistCap: 2, albumCap: 1 },
          { artistCap: 2, albumCap: 2 },
          { artistCap: Number.MAX_SAFE_INTEGER, albumCap: Number.MAX_SAFE_INTEGER }
        ]
      : [
          { artistCap: 1, albumCap: 1 }
        ];
    for (const caps of fallbackStages) {
      if (tracks.length >= requestedCount) break;
      for (const candidate of noveltyPool) {
        if (tracks.length >= requestedCount) break;
        addArtistNoveltyFallback(candidate, caps);
      }
    }
  }

  const selectedKeys = new Set(tracks.flatMap(candidateIdentityKeys));
  const alternates = laneSelection.alternates
    .filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key)))
    .concat(fallbackAlternates.filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key))))
    .slice(0, Math.max(160, requestedCount * 14));
  const remainingArtistNoveltyCandidates = artistNoveltyCandidates
    .filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key)));
  const finalDiscarded = discarded.filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key)));
  const alternateKeys = new Set(alternates.flatMap(candidateIdentityKeys));
  for (const diagnostic of candidateCollectionDiagnostics.durationCandidates) {
    if (selectedKeys.has(diagnostic.key)) {
      diagnostic.candidateAccumulation = {
        status: "selected",
        stage: diagnostic.candidateAccumulation?.stage === "novelty-fallback"
          ? "novelty-fallback"
          : "final-selection",
        reason: diagnostic.candidateAccumulation?.reason || "Selected for the requested result pool."
      };
      diagnostic.droppedStage = "";
      diagnostic.droppedReason = "";
    } else if (alternateKeys.has(diagnostic.key)) {
      diagnostic.candidateAccumulation = {
        status: "alternate",
        stage: "final-selection",
        reason: "Retained as an alternate after final selection."
      };
      diagnostic.droppedStage = "";
      diagnostic.droppedReason = "";
    } else if (["pending", "held-for-score-fill", "accepted"].includes(diagnostic.candidateAccumulation?.status)) {
      diagnostic.candidateAccumulation = {
        status: "dropped",
        stage: "final-selection",
        reason: "Valid candidate was not selected after lane, score, and diversity selection."
      };
      diagnostic.droppedStage = "final-selection";
      diagnostic.droppedReason = "Valid candidate was not selected after lane, score, and diversity selection.";
    }
  }
  const tracksWithEvidence = tracks.map((candidate) => withDiscoveryEvidenceLedger(candidate, {
    options,
    profile,
    decision: "kept"
  }));
  const alternatesWithEvidence = alternates.map((candidate) => withDiscoveryEvidenceLedger(candidate, {
    options,
    profile,
    decision: "alternate"
  }));
  const finalDiscardedWithEvidence = finalDiscarded.map((candidate) => withDiscoveryEvidenceLedger(candidate, {
    options,
    profile,
    decision: "discarded",
    decisionReason: candidate.reason
  }));
  const belowMinimumKept = tracksWithEvidence.filter((candidate) => candidate.belowMinimum).length;
  const belowMinimumAlternates = alternatesWithEvidence.filter((candidate) => candidate.belowMinimum).length;
  const aboveMinimumKept = minScore ? Math.max(0, tracksWithEvidence.length - belowMinimumKept) : tracksWithEvidence.length;
  const generated = tracksWithEvidence.length + alternatesWithEvidence.length + finalDiscardedWithEvidence.length;
  const queryYield = queryYieldSummary();
  const poolDiagnostics = buildPoolDiagnostics({
    tracks: tracksWithEvidence,
    alternates: alternatesWithEvidence,
    discarded: finalDiscardedWithEvidence,
    scoreFiltered,
    minimumRescueCandidates,
    countFillCandidates,
    belowMinimumCountFillKept,
    previousCandidates,
    previousFallbackKept,
    artistNoveltyCandidates: remainingArtistNoveltyCandidates,
    artistNoveltyFallbackKept,
    requestedCount,
    generated,
    candidatePoolTarget,
    usefulCandidateTarget,
    budgetExhausted,
    laneSelection,
    queryYield,
    queryRecovery: adaptiveRecovery,
    querySelectionDiagnostics,
    catalogPaginationDiagnostics,
    candidateCollectionDiagnostics,
    searchStopDiagnostics,
    queryExecutionDiagnostics,
    deepCatalog
  });

  return {
    requestedCount,
    tracks: tracksWithEvidence,
    alternates: alternatesWithEvidence,
    discarded: finalDiscardedWithEvidence,
    verification: {
      enabled: true,
      tidal: true,
      requested: requestedCount,
      originalRequested: originalRequestedCount,
      countExpanded: requestedCount !== originalRequestedCount,
      generated,
      kept: tracksWithEvidence.length,
      discarded: finalDiscardedWithEvidence.length,
      runtimeMs: Date.now() - startedAt,
      budgetExhausted,
      minScore,
      minScoreLabel,
      scoreFiltered: scoreFiltered.length + minimumRescueCandidates.length + countFillCandidates.length,
      belowMinimumKept,
      belowMinimumAlternates,
      aboveMinimumKept,
      minScoreSoftFallback: Boolean(minScore && belowMinimumKept),
      belowMinimumRescueAvailable: minimumRescueCandidates.length,
      belowMinimumRescueKept: minimumRescueKept || tracksWithEvidence.filter((candidate) => candidate.belowMinimumRescue).length,
      belowMinimumCountFillAvailable: countFillCandidates.length,
      belowMinimumCountFillKept,
      strategy: "tidal-catalog-first",
      plannerRoute: profile.isProgressiveTranceTarget
        ? "specialized-progressive-trance"
        : (profile.isProgressiveTarget ? "specialized-progressive" : "generic-genre"),
      admissionGates: {
        catalogueQuality: "hard",
        identityCorrectness: "hard",
        genreLaneCompatibility: "hard",
        vibeMoodCompatibility: "soft-ranking-only",
        durationConstraints: hardDurationConstraintFor(options) ? "hard-explicit-minimum" : "hard-when-explicit"
      },
      novelty: !allowPreviousSuggestions,
      previouslySuggestedAllowed: allowPreviousSuggestions,
      previousDiscoveryFallback: allowPreviousFallback,
      previouslySuggestedHeldBack: previousCandidates.length,
      previousFallbackKept,
      artistNoveltyHeldBack: remainingArtistNoveltyCandidates.length,
      artistNoveltyFallbackKept,
      nearYearFallback: Boolean(relaxedYearOptions),
      nearYearFallbackRange: relaxedYearOptions?.years || "",
      queries: queries.slice(0, 12),
      candidatePoolTarget,
      usefulCandidateTarget,
      wideDiscoveryPool,
      perRunArtistCap: defaultPerRunArtistCap(options, profile, requestedCount),
      laneQuotas: laneSelection.quota,
      adjacentLaneTerms: adjacentLaneTerms(profile, options).slice(0, 12),
      profile: {
        targetGenres: profile.targetGenres,
        isProgressiveTranceTarget: Boolean(profile.isProgressiveTranceTarget),
        isProgressiveTarget: Boolean(profile.isProgressiveTarget),
        isProgressivePlanningTarget: Boolean(profile.isProgressivePlanningTarget),
        isGenreDiscoveryTarget: Boolean(profile.isGenreDiscoveryTarget),
        vibeTerms: profile.vibeTerms,
        seedArtists: profile.seedArtists.slice(0, 12),
        requestedArtists: profile.requestedArtists.slice(0, 12),
        requestedLabels: profile.requestedLabels.slice(0, 12)
      },
      intent: profile.intent,
      scoringMode: profile.scoringMode,
      modelCandidates: modelCandidates.length,
      taste: typeof tasteProfile?.summary === "function" ? tasteProfile.summary() : null,
      lastfm: scrobbleVerificationSummary(scrobbleHistory),
      queryYield,
      querySelectionDiagnostics: querySelectionDiagnostics.slice(0, 160),
      catalogPagination: catalogPaginationDiagnostics.slice(0, 160),
      searchStops: searchStopDiagnostics.slice(0, 240),
      queryExecution: queryExecutionDiagnostics.slice(0, 160),
      first10ExecutedQueries: queryExecutionDiagnostics.slice(0, 10),
      deepCatalog,
      tidalErrors: tidalErrors.slice(0, 24),
      artistExpansionArtists: uniqueValues(artistExpansionArtists).slice(0, 48),
      queryRecovery: adaptiveRecovery,
      poolDiagnostics
    }
  };
}

module.exports = {
  discoverTracks,
  candidateIdentityKeys,
  discoveryStatusFor,
  scrobbleStatusFor,
  minimumScoreFor,
  minimumScoreLabel,
  hardDurationConstraintFor,
  durationConstraintReason,
  effectiveDiscoveryCount,
  nearYearFallbackOptions,
  parseRequestedCount,
  parseYearRange,
  reasonFor,
  rejectReason,
  admissionDiagnosticsFor,
  genreValuesMatchTarget,
  requestedLabelMatch,
  scoreBreakdownFor,
  whyBulletsFor,
  buildDiscoveryEvidenceLedger,
  buildDiscoveryProfile,
  buildSearchQueries,
  buildOmnivoreDiscoveryQueries,
  isBroadElectronicDiscovery,
  semanticOnlyQueryFor,
  queryGenerationInfo,
  electronicDomainDriftReason,
  belowMinimumSoftRejectReason,
  releaseFilterRequiresVerification,
  autoBroadenSearchPasses,
  buildAdaptiveRecoveryQueryFamilies,
  laneQuotaShortfalls,
  shouldRunAdaptiveQueryRecovery,
  discoveryQuotaBucket,
  artistDiversityAdjustmentFor,
  artistKeysForCandidate,
  matchingSceneArtist,
  requestRequiresFreshArtists,
  requestRequiresStrictFreshArtists,
  requestPrefersExtendedMixes,
  promptIntentEvidenceFor,
  previouslyRecommendedArtistReason,
  recentSuggestionNoveltyPenaltyFor,
  selectDiscoveryLaneCandidates,
  shouldContinueAutoBroadenAfterError,
  allowsArtistRepeatFallback,
  noveltyBudgetFor,
  defaultPerRunArtistCap,
  normalizeScoringMode
};
