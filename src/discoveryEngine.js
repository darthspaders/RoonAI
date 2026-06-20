"use strict";

const {
  detectEraTerms: detectOntologyEraTerms,
  detectGenreTerms: detectOntologyGenreTerms,
  detectTrackCharacteristics: detectOntologyTrackCharacteristics,
  detectVibeTerms: detectOntologyVibeTerms,
  pruneGenreTerms: pruneOntologyGenreTerms
} = require("./musicOntology");
const {
  queryTemplate,
  rejectionBucketForReason,
  summarizeRecords
} = require("./queryYieldTracker");
const { parseYearRange, yearFits, releaseDateFits } = require("./yearRange");

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

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tidalTrackIdFromUrl(value) {
  const match = cleanText(value).match(/\/track\/(\d+)/i);
  return match ? match[1] : "";
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  const titleArtist = `${normalize(track.artist)}|${normalize(track.title)}`;
  return [tidalUrl, titleArtist].filter((key) => key && key !== "|");
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

function matchingSceneArtist(value) {
  const artistText = normalize(value);
  return PROGRESSIVE_ARTISTS.find((artist) => {
    const normalizedArtist = normalize(artist);
    return artistText === normalizedArtist || artistText.includes(normalizedArtist);
  }) || "";
}

function queryTargetArtist(query) {
  const normalizedQuery = normalize(query);
  return PROGRESSIVE_ARTISTS.find((artist) => normalizedQuery.startsWith(normalize(artist))) || "";
}

function wantsLongTracks(options = {}) {
  const text = normalize(`${options.request} ${options.mood} ${options.genres}`);
  return /\b(?:long|extended|8 minute|8 min|eight minute|journey|deep mix|club mix)\b/.test(text);
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

function promptMatchFor(track = {}, options = {}, breakdown = {}, profile = buildDiscoveryProfile(options)) {
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const queryText = normalize(track.query);
  const combinedText = normalize(`${metadataText} ${queryText}`);
  const targetGenres = profile.targetGenres || [];
  const vibeTerms = profile.vibeTerms || [];
  const genreInference = breakdown.genreInference || {};
  const reasons = [];

  const genreScore = targetGenres.length
    ? (hasAnyTerm(metadataText, targetGenres)
      ? 38
      : (Number(genreInference.confidence || 0) >= 45
        ? Math.round(clamp(genreInference.confidence, 0, 100) * 0.38)
        : (hasAnyTerm(queryText, targetGenres) ? 24 : Math.round((Number(breakdown.genreMatch || 0) / SCORE_MAX.genreMatch) * 30))))
    : 24;
  const vibeScore = vibeTerms.length
    ? (hasAnyTerm(combinedText, vibeTerms) ? 18 : Math.round((Number(breakdown.genreMatch || 0) / SCORE_MAX.genreMatch) * 10))
    : 12;
  const entityScore = Math.round(((Number(breakdown.artistMatch || 0) / SCORE_MAX.artistMatch) * 18) +
    ((Number(breakdown.labelMatch || 0) / SCORE_MAX.labelMatch) * 12));
  const releaseScore = Math.round((Number(breakdown.freshness || 0) / SCORE_MAX.freshness) * 12);
  const lengthScore = Math.round((Number(breakdown.lengthPreference || 0) / SCORE_MAX.lengthPreference) * 8);
  const percent = clamp(Math.round(genreScore + vibeScore + entityScore + releaseScore + lengthScore), 0, 100);

  if (targetGenres.length) reasons.push(`User requested ${targetGenres[0]}.`);
  if (genreInference.summary && Number(genreInference.confidence || 0) >= 35) {
    reasons.push(`Genre inferred from ${genreInference.summary}.`);
  }
  if (vibeTerms.length && hasAnyTerm(combinedText, vibeTerms)) reasons.push(`Matched the ${vibeTerms[0]} vibe signal.`);
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
  if (adjustment > 0) reasons.push("Boosted by previous Love/Good/candidate signals.");
  if (adjustment < 0) reasons.push("Reduced by previous Skip/Never Again signals.");
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

const TRANCE_FORWARD_ARTISTS = [
  "Solarstone",
  "Scott Bond",
  "Basil O'Glue",
  "Jerome Isma-Ae",
  "Paul Thomas",
  "Forerunners"
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

const GENRE_ARTIST_ANCHORS = [
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
  ["breaks", ["Hybrid", "The Crystal Method", "Stanton Warriors", "Plump DJs", "Meat Katie", "Elite Force"]]
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

function pruneBroadGenreTerms(terms = []) {
  return pruneOntologyGenreTerms(terms);
}

function adjacentLaneTerms(profile = {}, options = {}) {
  const terms = [];
  const targetTerms = profile.targetGenres || detectTargetGenres(options);
  const targetText = targetTerms.join(" ");
  for (const [genre, adjacent] of ADJACENT_LANE_TERMS) {
    if (containsNormalized(targetText, genre) || targetTerms.some((term) => containsNormalized(term, genre) || containsNormalized(genre, term))) {
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
  if (/^(?:the\s+)?(?:\d{4}s?|\d0s|19\d0s|20\d0s|2000s|00s|nineties|eighties|seventies|era|decade)$/i.test(text)) return "";
  if (/^(?:this|that|current|playing|now|music|tracks?|songs?|genre|vibe|style|era)$/i.test(text)) return "";
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
      const label = normalizeEntityCandidate(match[1]);
      if (label) found.push(label);
    }
  }
  return uniqueTerms(found, 8);
}

function detectTargetGenres(options = {}) {
  const explicit = `${options.genres || ""} ${positiveIntentText(options.request || "")}`;
  const detected = detectOntologyGenreTerms(explicit, { includeAliases: true, limit: 24 });
  return uniqueTerms(pruneBroadGenreTerms(detected.terms), 12);
}

function detectSeedVibes(options = {}, seedArtists = []) {
  const promptVibes = detectOntologyVibeTerms(`${options.request || ""} ${options.reference || ""}`, { limit: 16 }).terms;
  const moodVibes = detectOntologyVibeTerms(options.mood || "", { limit: 16 }).terms;
  const explicit = uniqueTerms([...promptVibes, ...moodVibes], 16);
  const inferred = [];

  for (const artist of seedArtists) {
    const match = SEED_ARTIST_VIBES.find(([knownArtist]) => normalize(knownArtist) === normalize(artist));
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
  if (profile.isGenreDiscoveryTarget) return "lightly";
  return "strongly";
}

function intentDebugFor(profile = {}, options = {}) {
  const yearRange = parseYearRange(options);
  const eraTerms = detectEraTerms(options);
  const requestedGenre = profile.targetGenres.length
    ? profile.targetGenres.slice(0, 8).join(", ")
    : (cleanText(options.genres) || (profile.seedArtists.length ? "open-ended" : (profile.primaryTarget || "open-ended")));
  return {
    requestedGenre,
    requestedVibe: profile.vibeTerms.length ? profile.vibeTerms.slice(0, 8).join(", ") : (cleanText(options.mood) || "not specified"),
    requestedVibeSource: profile.vibeSource || "not specified",
    requestedEraDateRange: yearRange?.label || eraTerms.join(", ") || "not specified",
    requestedLength: requestedLengthText(options) || "not specified",
    requestedCharacteristics: (profile.trackCharacteristics || []).slice(0, 8),
    requestedArtists: (profile.requestedArtists || profile.seedArtists || []).slice(0, 8),
    requestedLabels: profile.requestedLabels.slice(0, 8),
    scoringMode: profile.scoringMode,
    scoringModeLabel: scoringModeLabel(profile.scoringMode),
    learnedTaste: tasteApplicationFor(profile),
    progressiveBias: profile.isProgressiveTarget ? "relevant to prompt" : "off unless explicitly requested"
  };
}

function genreDiscoverySeeds(profile = {}) {
  if (!profile.targetGenres?.length || profile.isProgressiveTarget) return [];
  const seedValues = [];
  const targetText = profile.targetGenres.join(" ");
  for (const [genre, seeds] of GENRE_DISCOVERY_SEEDS) {
    if (containsNormalized(targetText, genre) || profile.targetGenres.some((term) => containsNormalized(term, genre) || containsNormalized(genre, term))) {
      seedValues.push(...seeds);
    }
  }
  return uniqueValues(seedValues);
}

function genreArtistAnchors(profile = {}) {
  if (!profile.targetGenres?.length || profile.isProgressiveTarget) return [];
  const seedValues = [];
  const targetText = profile.targetGenres.join(" ");
  for (const [genre, seeds] of GENRE_ARTIST_ANCHORS) {
    if (containsNormalized(targetText, genre) || profile.targetGenres.some((term) => containsNormalized(term, genre) || containsNormalized(genre, term))) {
      seedValues.push(...seeds);
    }
  }
  return uniqueValues(seedValues);
}

function buildDiscoveryProfile(options = {}) {
  const scoringMode = normalizeScoringMode(options);
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planArtists = uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ].filter((artist) => !isGenericSeedArtist(artist)), 24);
  const planLabels = uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 24);
  const requestedArtists = uniqueTerms([
    ...extractPromptArtists(options),
    ...extractSeedArtists(options)
  ], 12);
  const pureRequestedArtistSearch = scoringMode === "pure" && requestedArtists.length;
  const seedArtists = uniqueTerms([
    ...requestedArtists,
    ...(pureRequestedArtistSearch ? [] : planArtists.slice(0, 8))
  ], 12);
  const requestedLabels = uniqueTerms([
    ...extractPromptLabels(options),
    ...planLabels
  ], 12);
  const targetGenres = detectTargetGenres(options);
  const vibeResult = detectSeedVibes(options, seedArtists);
  const vibeTerms = vibeResult.terms;
  const trackCharacteristics = detectTrackCharacteristics(options);
  const releaseRange = parseYearRange(options);
  const explicitTarget = cleanText(options.genres || options.request || "");
  const positiveTargetText = normalize(`${options.genres || ""} ${positiveIntentText(options.request || "")}`);
  const isProgressiveTarget = /\bprogressive house\b|\bmelodic progressive\b|\bdeep progressive\b|\borganic progressive\b/.test(positiveTargetText) ||
    targetGenres.some((term) => /\bprogressive house\b|\bmelodic progressive\b|\bdeep progressive\b|\borganic progressive\b/.test(normalize(term)));
  const isGenreOnlyTarget = Boolean(targetGenres.length && !isProgressiveTarget && !seedArtists.length);
  const isGenreDiscoveryTarget = Boolean(targetGenres.length && !isProgressiveTarget);
  const primaryTarget = targetGenres[0] || cleanText(options.genres) || cleanText(options.request).replace(/\b(?:make|create|find|give me|recommend|playlist|tracks?|songs?|like|similar|based on|seeded)\b/gi, " ").trim();
  const hasExplicitDiscoveryIntent = Boolean(
    requestedArtists.length ||
    requestedLabels.length ||
    targetGenres.length ||
    vibeResult.explicit.length ||
    trackCharacteristics.length ||
    releaseFilterRequiresVerification(options, releaseRange)
  );

  const profile = {
    scoringMode,
    seedArtists,
    requestedArtists,
    requestedLabels,
    targetGenres,
    vibeTerms,
    explicitVibeTerms: vibeResult.explicit,
    inferredVibeTerms: vibeResult.inferred,
    vibeSource: vibeResult.source,
    trackCharacteristics,
    primaryTarget,
    explicitTarget,
    hasExplicitDiscoveryIntent,
    isProgressiveTarget,
    isGenreOnlyTarget,
    isGenreDiscoveryTarget,
    hasSeedVibe: Boolean(seedArtists.length || vibeTerms.length)
  };
  profile.intent = intentDebugFor(profile, options);
  profile.tasteApplication = profile.intent.learnedTaste;
  return profile;
}

function labelText(track = {}) {
  return cleanText(track.label || track.tidal?.label || "");
}

function matchingSceneLabel(value) {
  const label = normalize(value);
  if (!label) return "";
  return PROGRESSIVE_LABELS.find((knownLabel) => {
    return containsEntityTerm(value, knownLabel) || containsEntityTerm(knownLabel, value);
  }) || "";
}

function isTranceForwardArtist(value) {
  const artistKeys = splitArtists(value).map(normalize);
  return TRANCE_FORWARD_ARTISTS.some((artist) => artistKeys.includes(normalize(artist)));
}

function wantsProgressiveHouseOnly(options = {}) {
  const wanted = normalize(`${positiveIntentText(options.request)} ${options.genres}`);
  return wanted.includes("progressive house") && !/\bprogressive trance\b|\btrance\b/.test(wanted);
}

function primaryArtistKey(track = {}) {
  return normalize(splitArtists(track.artist)[0] || track.artist);
}

function artistKeysForCandidate(track = {}) {
  const artists = splitArtists(track.artist);
  const keys = artists.map(normalize).filter(Boolean);
  if (!keys.length) {
    const fallback = normalize(track.artist);
    if (fallback) keys.push(fallback);
  }
  return [...new Set(keys)];
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

function isGenericSeedArtist(value = "") {
  const text = normalize(value);
  if (!text) return true;
  if (/^(?:various artists?|unknown artist|unknown|n a|na|va|v a|soundtrack)$/i.test(cleanText(value))) return true;
  if (/^(?:house music|techno music|trance music|psytrance|ambient music|electronic dance music|edm|deep house|progressive house|melodic house|organic house|tech house|dance music)$/i.test(cleanText(value))) return true;
  const parts = splitArtists(value);
  if (parts.length >= 3 && /\b(?:house|techno|trance|psytrance|ambient|edm|music)\b/.test(text)) return true;
  return false;
}

function buildSearchQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planQueries = uniqueTerms(Array.isArray(plan.searchQueries) ? plan.searchQueries : [], 24);
  const pureRequestedArtistSearch = profile.scoringMode === "pure" && (profile.requestedArtists || []).length;
  const planArtists = pureRequestedArtistSearch ? [] : uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ].filter((artist) => !isGenericSeedArtist(artist)), 24);
  const planLabels = uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 24);
  const planTargetTerms = uniqueTerms(Array.isArray(plan.targetGenres) ? plan.targetGenres : [], 16);
  const planVibeTerms = uniqueTerms(Array.isArray(plan.vibeTerms) ? plan.vibeTerms : [], 16);
  const request = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const isYearCatalogSearch = Boolean(yearRange && profile.targetGenres.length);
  const useAnchoredGenreSearch = Boolean(profile.isGenreDiscoveryTarget && !profile.isProgressiveTarget && !pureRequestedArtistSearch);
  const artists = uniqueTerms([
    ...planArtists,
    ...buildArtistSeeds(options, isYearCatalogSearch ? 34 : 18, tasteProfile, profile)
  ], isYearCatalogSearch ? 42 : 28);
  const genreSeeds = genreDiscoverySeeds(profile);
  const targetTerms = pureRequestedArtistSearch && !profile.targetGenres.length
    ? [""]
    : (planTargetTerms.length
    ? uniqueTerms([...planTargetTerms, ...(profile.isProgressiveTarget ? PROGRESSIVE_CATALOG_TARGETS : [])], 18)
    : (profile.targetGenres.length
      ? (profile.isProgressiveTarget ? uniqueTerms([...profile.targetGenres, ...PROGRESSIVE_CATALOG_TARGETS], 18) : profile.targetGenres)
      : [profile.primaryTarget].filter(Boolean)));
  const vibeTerms = uniqueTerms([...planVibeTerms, ...profile.vibeTerms], 24);
  const artistQueries = [];
  const sceneQueries = [];
  const labelQueries = [];
  const tranceQueries = [];
  const catalogYearQueries = [];
  const sceneAnchorQueries = useAnchoredGenreSearch
    ? buildSceneAnchorRecentQueries(options, tasteProfile, profile)
    : [];

  for (const artist of artists.slice(0, profile.isProgressiveTarget ? (isYearCatalogSearch ? 28 : 14) : 10)) {
    for (const target of targetTerms.slice(0, 4)) {
      for (const year of yearTerms.slice(-2)) artistQueries.push(cleanText(`${artist} ${target} ${year}`));
    }
    for (const vibe of vibeTerms.slice(0, 3)) {
      for (const target of targetTerms.slice(0, 2)) artistQueries.push(cleanText(`${artist} ${target} ${vibe}`));
    }
  }

  if (isYearCatalogSearch) {
    const useBroadGenreYearQueries = !useAnchoredGenreSearch || !genreSeeds.length;
    for (const year of yearTerms.slice(-3)) {
      for (const target of targetTerms.slice(0, profile.isProgressiveTarget ? 10 : 5)) {
        if (useBroadGenreYearQueries) {
          catalogYearQueries.push(cleanText(`${target} ${year}`));
          catalogYearQueries.push(cleanText(`${target} new releases ${year}`));
        }
      }
      if (profile.isGenreDiscoveryTarget) {
        for (const seed of genreSeeds.slice(0, 24)) {
          for (const target of targetTerms.slice(0, 2)) {
            catalogYearQueries.push(cleanText(`${seed} ${target} ${year}`));
          }
          catalogYearQueries.push(cleanText(`${seed} ${year}`));
        }
      }
      if (profile.isProgressiveTarget) {
        for (const label of PROGRESSIVE_LABELS.slice(0, 28)) {
          catalogYearQueries.push(cleanText(`${label} ${year}`));
          catalogYearQueries.push(cleanText(`${label} progressive house ${year}`));
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
    sceneQueries.push(cleanText(`${target} underground`));
    sceneQueries.push(cleanText(`${target} club tracks`));
    for (const vibe of vibeTerms.slice(0, 6)) {
      sceneQueries.push(cleanText(`${vibe} ${target}`));
      sceneQueries.push(cleanText(`${target} ${vibe}`));
    }
  }

  if (profile.isGenreDiscoveryTarget) {
    for (const seed of genreSeeds.slice(0, isYearCatalogSearch ? 24 : 14)) {
      for (const target of targetTerms.slice(0, 3)) {
        for (const year of yearTerms.slice(-2)) labelQueries.push(cleanText(`${seed} ${target} ${year}`));
      }
      for (const vibe of vibeTerms.slice(0, 3)) labelQueries.push(cleanText(`${seed} ${vibe}`));
    }
  }

  for (const label of planLabels.slice(0, isYearCatalogSearch ? 18 : 12)) {
    for (const target of targetTerms.slice(0, 3)) {
      for (const year of yearTerms.slice(-2)) labelQueries.push(cleanText(`${label} ${target} ${year}`));
    }
    for (const vibe of vibeTerms.slice(0, 3)) labelQueries.push(cleanText(`${label} ${vibe}`));
    labelQueries.push(cleanText(label));
  }

  if (profile.isProgressiveTarget) {
    for (const label of PROGRESSIVE_LABELS.slice(0, isYearCatalogSearch ? 28 : 14)) {
      for (const target of targetTerms.slice(0, 3)) {
        for (const year of yearTerms.slice(-2)) labelQueries.push(cleanText(`${label} ${target} ${year}`));
      }
      for (const vibe of vibeTerms.slice(0, 3)) labelQueries.push(cleanText(`${label} ${vibe} progressive`));
    }
  }

  const queryLimit = isYearCatalogSearch ? 88 : 42;
  const planQueryLimit = isYearCatalogSearch ? 18 : 12;
  const anchoredQueryLimit = isYearCatalogSearch ? 46 : 18;
  const progressiveLabelYearQueries = profile.isProgressiveTarget && isYearCatalogSearch
    ? uniqueTerms([
      ...catalogYearQueries.filter((query) => PROGRESSIVE_LABELS.some((label) => normalize(query).includes(normalize(label)))),
      ...labelQueries
    ], 44)
    : [];
  if (pureRequestedArtistSearch) {
    const requestedKeys = (profile.requestedArtists || []).map(normalize).filter(Boolean);
    const requestedPlanQueries = planQueries.filter((query) => {
      const normalizedQuery = normalize(query);
      return requestedKeys.some((artist) => normalizedQuery.includes(artist));
    });
    return Array.from(new Set([
      ...artistQueries,
      ...requestedPlanQueries
    ].map(cleanText).filter(Boolean))).slice(0, queryLimit);
  }
  if (options.autoBroadenLane === "yield-retry" && planQueries.length) {
    return Array.from(new Set([
      ...planQueries,
      ...progressiveLabelYearQueries,
      ...catalogYearQueries,
      ...sceneQueries
    ].map(cleanText).filter(Boolean))).slice(0, queryLimit);
  }
  return Array.from(new Set([
    ...progressiveLabelYearQueries,
    ...sceneAnchorQueries.slice(0, anchoredQueryLimit),
    ...labelQueries.slice(0, useAnchoredGenreSearch ? (isYearCatalogSearch ? 36 : 18) : 0),
    ...artistQueries.slice(0, useAnchoredGenreSearch ? (isYearCatalogSearch ? 30 : 14) : 0),
    ...planQueries.slice(0, useAnchoredGenreSearch ? Math.ceil(planQueryLimit / 2) : planQueryLimit),
    ...catalogYearQueries.slice(0, profile.isProgressiveTarget ? 36 : (profile.isGenreDiscoveryTarget ? 36 : 16)),
    ...artistQueries.slice(0, profile.isProgressiveTarget ? (isYearCatalogSearch ? 24 : 12) : 10),
    ...sceneQueries.slice(0, isYearCatalogSearch ? 22 : 14),
    ...labelQueries.slice(0, profile.isProgressiveTarget ? (isYearCatalogSearch ? 28 : 12) : (profile.isGenreDiscoveryTarget ? (isYearCatalogSearch ? 32 : 16) : 0)),
    ...tranceQueries.slice(0, 5),
    ...artistQueries.slice(24, isYearCatalogSearch ? 42 : 18)
  ].map(cleanText).filter(Boolean))).slice(0, queryLimit);
}

function buildAdjacentSearchQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  if (!profile.isGenreDiscoveryTarget || profile.isProgressiveTarget) return [];

  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const adjacentTerms = adjacentLaneTerms(profile, options);
  if (!adjacentTerms.length) return [];

  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planLabels = uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 16);
  const seeds = uniqueTerms([
    ...genreDiscoverySeeds(profile),
    ...planLabels,
    ...buildArtistSeeds(options, 16, tasteProfile, profile)
  ], 36);
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

  return uniqueTerms(queries, yearRange ? 72 : 40);
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
  const targets = (profile.targetGenres?.length ? profile.targetGenres : [profile.primaryTarget]).filter(Boolean).slice(0, 6);
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
  const targets = (profile.targetGenres?.length ? profile.targetGenres : [profile.primaryTarget])
    .filter(Boolean)
    .slice(0, 6);
  if (!targets.length) return [];

  const years = yearTermsForBroadenPass(options);
  const labels = uniqueTerms([
    ...(profile.requestedLabels || []),
    ...(profile.isProgressiveTarget ? PROGRESSIVE_LABELS.slice(0, 24) : genreDiscoverySeeds(profile).slice(0, 24))
  ], 32);
  const anchors = uniqueTerms([
    ...(profile.seedArtists || []),
    ...(profile.isProgressiveTarget ? PROGRESSIVE_FRESH_ANCHORS : []),
    ...(profile.isProgressiveTarget ? PROGRESSIVE_ARTISTS.slice(0, 24) : genreArtistAnchors(profile).slice(0, 24))
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

  if (yieldQueries.length) {
    passes.push({
      lane: "yield-retry",
      label: "Yield-aware retry",
      reason: `Query yield was weak (${yieldHealth.summary}); retrying with label/artist anchored same-intent queries.`,
      targetPool,
      queryYieldHealth: yieldHealth,
      options: {
        ...options,
        autoBroaden: true,
        autoBroadenLane: "yield-retry",
        autoBroadenLabel: "Yield-aware retry",
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
        effectiveCount: baseCount,
        llmSearchPlan: mergePlanForBroaden(options, {
          searchQueries: coreQueries,
          targetGenres,
          vibeTerms
        })
      }
    });
  }

  const adjacentQueries = broadenAdjacentQueries(options, profile);
  if (profile.isGenreDiscoveryTarget && adjacentQueries.length) {
    passes.push({
      lane: "adjacent",
      label: "Broadened adjacent-lane search",
      reason: `Initial candidate pool ${currentPool}/${targetPool}; checking adjacent terms without changing requested genre.`,
      targetPool,
      options: {
        ...options,
        autoBroaden: true,
        autoBroadenLane: "adjacent",
        autoBroadenLabel: "Broadened adjacent-lane search",
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
        reason: `Initial candidate pool ${currentPool}/${targetPool}; relaxing vibe terms while keeping requested genre.`,
        targetPool,
        options: {
          ...options,
          autoBroaden: true,
          autoBroadenLane: "relaxed-vibe",
          autoBroadenLabel: "Broadened genre-first search",
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

  return passes.slice(0, 3);
}

function buildSceneAnchorRecentQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  if (!profile.isGenreDiscoveryTarget) return [];

  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planArtists = uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ], 18);
  const planLabels = uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 18);
  const anchors = uniqueTerms([
    ...genreArtistAnchors(profile),
    ...genreDiscoverySeeds(profile),
    ...planLabels,
    ...planArtists,
    ...buildArtistSeeds(options, 22, tasteProfile, profile)
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

  return uniqueTerms(queries, yearRange ? 140 : 56);
}

function buildArtistSeeds(options = {}, limit = 12, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
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
  const planArtists = pureRequestedArtistSearch ? [] : uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ], limit);
  const seedArtists = profile.seedArtists || extractSeedArtists(options);
  const seedKeys = new Set(seedArtists.map(normalize));
  const useLearnedArtists = profile.scoringMode === "similar" ||
    (profile.scoringMode === "taste-guided" && !profile.hasExplicitDiscoveryIntent);
  const learnedLimit = profile.scoringMode === "similar" ? 12 : 3;
  const learnedArtists = useLearnedArtists && typeof tasteProfile?.getTopArtists === "function"
    ? tasteProfile.getTopArtists(learnedLimit)
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
  const priorityKeys = new Set([...seedArtists, ...freshYearAnchors].map(normalize));
  const rotatedSceneArtists = shuffled(uniqueValues(sceneArtists).filter((artist) => !seedKeys.has(normalize(artist)) && !priorityKeys.has(normalize(artist))));
  return uniqueValues([...planArtists, ...seedArtists, ...learnedArtists, ...freshYearAnchors, ...rotatedSceneArtists]).slice(0, limit);
}

function requestText(options = {}) {
  return `${options.request || ""} ${options.reference || ""} ${options.genres || ""} ${options.mood || ""}`;
}

function allowsPreviouslySuggested(options = {}) {
  const text = requestText(options);
  if (/\b(?:avoid|exclude|skip|without|no|not|do not|don't|stop)\b.{0,35}\b(?:previous|previously|repeat|repeats|repeated|same|old|seen|suggested|suggestions)\b/i.test(text)) {
    return false;
  }
  return /\b(?:allow repeats|include repeats|show repeats|reuse previous suggestions|include previous suggestions|include previously suggested|show previous suggestions|same tracks again|same songs again|rerun previous)\b/i.test(text);
}

function allowsPreviousDiscoveryFallback(options = {}) {
  return /\b(?:use previous discovery fallback|allow previous fallback|backfill from history|fill from history|reuse previous suggestions|include previous suggestions|include previously suggested)\b/i.test(requestText(options));
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

function genreTermMatchesTarget(term = "", targets = []) {
  const key = normalize(term);
  if (!key) return false;
  return targets.some((target) => {
    const targetKey = normalize(target);
    if (!targetKey) return false;
    if (key === targetKey) return true;
    if (isBroadGenreTerm(key)) return targetKey === key;
    if (key.includes(targetKey) && !isBroadGenreTerm(targetKey)) return true;
    return false;
  });
}

function ontologyGenreTermsForText(text = "", limit = 16) {
  const detected = detectOntologyGenreTerms(text, { includeAliases: true, limit });
  return uniqueTerms(detected.terms || [], limit);
}

function genreLabelSeeds(profile = {}) {
  const artistKeys = new Set(genreArtistAnchors(profile).map(normalize));
  return genreDiscoverySeeds(profile).filter((seed) => !artistKeys.has(normalize(seed)));
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
    const entry = profile.artists?.[normalize(artist)];
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

  const metadataAdjacent = metadataTerms.filter((term) => genreTermMatchesTarget(term, adjacentTerms));
  for (const term of metadataAdjacent.slice(0, 2)) {
    add("metadata", `${term} adjacent metadata`, isBroadGenreTerm(term) ? 8 : 18, { genre: term });
  }

  if (profile.isProgressiveTarget) {
    const sceneLabel = matchingSceneLabel(label);
    const sceneArtist = matchingSceneArtist(track.artist);
    if (sceneLabel) add("label", `${sceneLabel} label scene`, 38, { genre: "progressive house" });
    if (sceneArtist) add("artist", `${sceneArtist} artist scene`, sceneLabel || metadataTargets.length ? 22 : 14, {
      genre: "progressive house",
      corroborating: Boolean(sceneLabel || metadataTargets.length)
    });
    if (hasAnyTerm(metadataText, PROGRESSIVE_CATALOG_TARGETS)) {
      add("metadata", "progressive catalogue terms", 22, { genre: "progressive house" });
    }
  }

  if (requestedLabelMatch(track, profile)) {
    add("requested-label", `${requestedLabelMatch(track, profile)} requested label`, 32, { genre: targetGenres[0] || "" });
  }

  const labelSeed = genreLabelSeeds(profile).find((seed) => containsEntityTerm(label, seed)) || "";
  if (labelSeed) add("label", `${labelSeed} scene label`, 36, { genre: targetGenres[0] || "" });

  const artistAnchor = genreArtistAnchors(profile).find((seed) => splitArtists(track.artist).some((artist) => normalize(artist) === normalize(seed))) || "";
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

  if (hasAnyTerm(queryText, targetGenres)) {
    add("query", `${targetGenres.find((term) => containsNormalized(queryText, term)) || targetGenres[0]} search query`, 7, {
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
  const labelSeed = labelSeeds.find((seed) => containsEntityTerm(labelText(track), seed)) || "";
  const artistAnchor = artistAnchors.find((seed) => splitArtists(track.artist).some((artist) => normalize(artist) === normalize(seed))) || "";
  const metadataTarget = hasAnyTerm(metadataText, profile.targetGenres || []);
  const metadataAdjacent = hasAnyTerm(metadataText, adjacentTerms);
  const queryTarget = hasAnyTerm(query, profile.targetGenres || []);
  const queryLabel = hasAnyTerm(query, labelSeeds);

  return {
    labelSeed,
    artistAnchor,
    metadataTarget,
    metadataAdjacent,
    queryTarget,
    queryLabel,
    metadataSceneEvidence: Boolean(labelSeed || metadataTarget || metadataAdjacent || queryLabel),
    sceneEvidence: Boolean(labelSeed || metadataTarget || metadataAdjacent || queryTarget || queryLabel)
  };
}

function metadataCorroboratesRequestedGenre(track = {}, query = "", options = {}, profile = buildDiscoveryProfile(options)) {
  if (!profile.targetGenres?.length) return true;
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const genreInference = genreInferenceFor(track, query, options, profile);
  const progressiveMetadata = profile.isProgressiveTarget && Boolean(
    matchingSceneArtist(track.artist) ||
    matchingSceneLabel(labelText(track)) ||
    hasAnyTerm(metadataText, PROGRESSIVE_CATALOG_TARGETS)
  );
  const scene = sceneEvidenceFor(track, query, options, profile);
  return Boolean(
    progressiveMetadata ||
    requestedLabelMatch(track, profile) ||
    hasSeedArtistMatch(track, options, profile) ||
    genreInference.corroboratesRequested ||
    scene.labelSeed ||
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
  if (/^(?:deep house|house music|tech house|tech house music|techno house|deep vocallo|viral hits|dance hits|edm|electronic dance music|background music|benetti house bar|soundify background music|easy to dance music|electronic music|dance music|various artists?)$/.test(artist)) return true;
  return profile.targetGenres?.length &&
    hasAnyTerm(artist, profile.targetGenres) &&
    artist.split(/\s+/).length <= 5;
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
  const broadGenreTitle = /\b(?:deep tech house|deep tech|tech house|deep house|melodic house|organic house|progressive house|progressive trance|psytrance|psy trance|psychedelic trance|goa trance|melodic techno|progressive techno|deep techno|hypnotic techno|techno|trance|ambient|downtempo|breaks|breakbeat|drum and bass|dnb|dubstep|house)\b/i.test(titleAlbum);
  const hasTargetGenreInTitle = broadGenreTitle || (catalogGenreTerms.length
    ? hasAnyTerm(titleAlbum, catalogGenreTerms)
    : false);
  const embeddedMarketingYear = /\b(?:19\d{2}|20\d{2})\b/.test(titleAlbum);
  const dateCode = /\b(?:0?[1-9]|1[0-2])[-_/](?:19\d{2}|20\d{2})\b|\b(?:19\d{2}|20\d{2})[-_/](?:0?[1-9]|1[0-2])\b/i.test(titleAlbum);
  const catalogFillerNoun = /\b(?:fusion|fusions|grooves?|vibes?|sessions?|cuts?|tracks?|beats?|essentials?|selections?|collection|compilation|mixes|journeys?|sounds?|playlist|chart|hits?|anthems?)\b/i.test(titleAlbum);
  const romanOrVersionTail = /\b(?:v|vol(?:ume)?|pt|part)\s*(?:\d+|[ivxlcdm]{1,6})\b/i.test(titleAlbum) ||
    /\b(?:ii|iii|iv|v|vi|vii|viii|ix|x)\b\s*$/i.test(rawTitle);
  const shortCatalogCode = /\b[a-z]{1,4}\d+\b/i.test(`${rawArtist} ${rawTitle}`);
  const longKeywordTitle = rawTitle.length >= 64 || rawAlbum.length >= 76;
  const listOrVolume = /\b(?:vol(?:ume)?\.?\s*\d+|top\s*\d+|chart hits?|best\s+(?:of\s+)?|playlist|collection|compilation|dj mix|mix\s*\d+\s*hr|3hr|masters|anthems|essentials?|hits?|selection|selected works|various artists)\b/i.test(raw);
  const lifestyleKeywords = /\b(?:summer nights?|beach vibes?|beach|waves?|grooves?|cocktails?|workout|fitness|party|lounge|rooftop|sessions?|smooth|chill|background music|music for|motivation|focus|study|relaxing|spa|bar|restaurant)\b/i.test(raw);
  const marketingPhrase = /\b(?:this sound|night club energy|havana nights?|desert eyes?|midnight flow|endless city horizon|pulls you in|deep journey|club energy)\b/i.test(raw);
  const functionalMusicText = /\b(?:music\s+for|for\s+(?:programming|coding|focus|studying|study|sleep|meditation|relaxation|healing|energy balance|cafe|caf[eé]|workout|spa)|programming\s+and\s+coding|coding music|studying music|sleeping music|relaxing music|chakra healing|deep meditation|public domain|background music)\b/i.test(raw);
  const functionalMusicArtist = /\b(?:programming|coding|studying|sleeping|relaxing|relaxation|focus|meditation|healing|chill\s+house\s+music|music\s+caf[eé]|background music)\b/i.test(rawArtist);
  const genreStyleParenthetical = rawTitle.match(/\([^)]{8,140}\)/g)?.some((part) => {
    const normalizedPart = normalize(part);
    const hasGenre = /\b(?:edm|electronic dance music|deep house|tech house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|techno|progressive trance|psytrance|psy trance|trance|ambient|breaks|breakbeat|dubstep)\b/.test(normalizedPart);
    const hasDescriptor = /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b/.test(normalizedPart);
    return hasGenre && hasDescriptor && (part.includes("/") || /\bedm\b/.test(normalizedPart));
  }) || false;
  const artistLooksLikeMusicChannel = /\b(?:music|official|channel|sounds?|records?|recordings?)\b/i.test(rawArtist);
  const genreYearTag = /\|\s*[^|]*(?:house|techno|trance|ambient|breaks|breakbeat)[^|]*\|\s*(?:19\d{2}|20\d{2})\b/i.test(`${rawTitle} ${rawAlbum}`);
  const titleEqualsAlbum = normalize(rawTitle) && normalize(rawTitle) === normalize(rawAlbum);
  const titleOnlyYear = /^(?:19\d{2}|20\d{2})$/.test(rawTitle);
  const shortGenreYearTitle = hasTargetGenreInTitle && embeddedMarketingYear && normalize(rawTitle).split(/\s+/).length <= 5;
  const distributorLabel = /^\d+\s+records\s+dk$/i.test(rawLabel);
  const labelAsArtist = normalize(rawArtist) && normalize(rawArtist) === normalize(rawLabel) && /\brecords?\b/i.test(rawArtist);
  const obviousCoverOrKaraoke = /\b(?:karaoke|tribute to|cover version|covers?|as made famous by|originally performed by)\b/i.test(raw);
  const longGenericAlbum = hasTargetGenreInTitle && embeddedMarketingYear && normalize(rawAlbum).split(/\s+/).length >= 6;

  if (titleOnlyYear) return "Title is only a year, not a useful track match.";
  if (obviousCoverOrKaraoke) return "Cover/karaoke/tribute catalogue result.";
  if (genericGenreArtistName(rawArtist, profile)) return "Artist name looks like genre/SEO catalogue filler.";
  if (labelAsArtist) return "Artist name looks like a label/catalogue account, not a real artist.";
  if (distributorLabel && hasTargetGenreInTitle) return "Distributor-label genre upload looks like catalogue filler.";
  if (genreYearTag) return "Title looks like SEO genre/year tagging instead of a real track title.";
  if (shortGenreYearTitle) return "Title is just genre/year keywords, not a real track title.";
  if (functionalMusicText || functionalMusicArtist) return "Functional/background music result looks like SEO catalogue filler.";
  if (genreStyleParenthetical && (titleEqualsAlbum || artistLooksLikeMusicChannel || hasTargetGenreInTitle)) {
    return "Title uses genre/style descriptor keywords like SEO catalogue filler.";
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
  return "";
}

function belowMinimumSoftRejectReason(candidate = {}, profile = {}) {
  if (!candidate.belowMinimum || !profile.targetGenres?.length) return "";
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

function poolDiagnosticBucketFor(item = {}) {
  const reason = normalize(item.reason || "");
  if (!reason) return "Other discarded";
  if (/\b(?:previously suggested|held back|history|already suggested|repeat)\b/.test(reason)) return "Previously suggested";
  if (/\b(?:release|year|date|outside|range|canonical|reissue|remaster|older)\b/.test(reason)) return "Date/range mismatch";
  if (/\b(?:seo|catalogue|catalog|filler|functional|background|keyword|genre year|genre date|compilation|chart style|playlist)\b/.test(reason)) return "SEO/catalog sludge";
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
  previousCandidates = [],
  requestedCount = 0,
  generated = 0,
  candidatePoolTarget = 0,
  usefulCandidateTarget = 0,
  budgetExhausted = false,
  laneSelection = {},
  queryYield = {}
} = {}) {
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
  const querySludge = Number(queryYield.seoRejects || 0) + Number(queryYield.genreRejects || 0);
  const notes = [];
  if (budgetExhausted) notes.push("Runtime budget was exhausted before every crawl/search path could finish.");
  if (previousCandidates.length) notes.push(`${previousCandidates.length} previously suggested candidate${previousCandidates.length === 1 ? "" : "s"} held back for novelty.`);
  if (minimumRescueCandidates.length) notes.push(`${minimumRescueCandidates.length} below-floor candidate${minimumRescueCandidates.length === 1 ? "" : "s"} were eligible as branch-out fallback.`);
  if (queryYield.recordCount) notes.push(`${queryYield.attempted || 0} TIDAL search quer${queryYield.attempted === 1 ? "y" : "ies"} returned ${queryYield.returned || 0}; ${queryYield.accepted || 0} accepted by query-yield tracking.`);
  if (querySludge) notes.push(`${querySludge} query-yield reject${querySludge === 1 ? "" : "s"} looked like SEO sludge or genre drift.`);
  if (queryYield.prunedCount) notes.push(`${queryYield.prunedCount} historically low-yield quer${queryYield.prunedCount === 1 ? "y was" : "ies were"} skipped before spending crawl budget.`);
  if (Array.isArray(queryYield.laneBudgetStops) && queryYield.laneBudgetStops.length) notes.push("Core search stopped early enough to reserve crawl time for later lanes.");
  if (laneQuota?.enabled && laneQuota.rescueApplied) notes.push(`${laneQuota.rescueKept || 0} lower-confidence branch-out fallback${laneQuota.rescueKept === 1 ? "" : "s"} kept because the run undershot.`);

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
    rescueAvailable: minimumRescueCandidates.length,
    rescueKept: Number(laneQuota.rescueKept || tracks.filter((track) => track.belowMinimumRescue).length || 0),
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
  const artistMatch = Boolean(matchingSceneArtist(track.artist));
  const genreInference = profile.targetGenres.length ? genreInferenceFor(track, query, options, profile) : {};

  if (profile.isProgressiveTarget && wantsProgressiveHouseOnly(options)) {
    if (isTranceForwardArtist(track.artist)) return false;
    if (/\b(?:progressive trance|uplifting|psytrance|goa|vocal trance)\b/.test(text)) return false;
  }

  if (profile.isProgressiveTarget && artistMatch) return true;
  if (profile.isProgressiveTarget && wanted.includes("progressive")) {
    if (/\b(?:progressive|melodic|deep|organic|anjuna|anjunadeep|sudbeat|lost found|meanwhile|balance|bedrock|songspire|this never happened)\b/.test(text)) {
      return true;
    }
  }

  if (profile.targetGenres.length) {
    const scene = sceneEvidenceFor(track, query, options, profile);
    if (genreInference.queryOnly) return false;
    if (genreInference.corroboratesRequested && Number(genreInference.confidence || 0) >= 28) return true;
    if (requestedLabelMatch(track, profile)) return true;
    if (hasSeedArtistMatch(track, options, profile)) return true;
    if (scene.artistAnchor && scene.metadataSceneEvidence) return true;
    if (scene.artistAnchor && !scene.metadataSceneEvidence) return false;
    if (scene.labelSeed) return true;
    if (track.discoveryLane === "recent") return false;
    if (hasAnyTerm(metadataText, profile.targetGenres)) return true;
    if (hasAnyTerm(query, profile.targetGenres) && hasAnyTerm(metadataText, profile.vibeTerms)) return true;
    if (track.discoveryLane === "adjacent") {
      const adjacentTerms = adjacentLaneTerms(profile, options);
      if (hasAnyTerm(metadataText, adjacentTerms)) return true;
      if (hasAnyTerm(query, adjacentTerms) && hasAnyTerm(metadataText, profile.vibeTerms)) return true;
    }
    if (profile.isGenreDiscoveryTarget) return false;
  }

  return true;
}

function artistMatchesRequested(trackArtist = "", requestedArtists = []) {
  const actualArtists = splitArtists(trackArtist);
  if (!actualArtists.length || !requestedArtists.length) return false;
  return requestedArtists.some((requested) => actualArtists.some((actual) => (
    containsEntityTerm(actual, requested) || containsEntityTerm(requested, actual)
  )));
}

function requestedArtistMismatchReason(track = {}, profile = {}) {
  if (profile.scoringMode !== "pure" || !profile.requestedArtists?.length) return "";
  if (artistMatchesRequested(track.artist, profile.requestedArtists)) return "";
  return `Pure Search requested ${profile.requestedArtists.join(", ")}, but TIDAL returned ${track.artist || "unknown artist"}.`;
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
  const targetArtist = queryTargetArtist(track.query);
  if (targetArtist) {
    const target = normalize(targetArtist);
    const matchedTarget = normalize(track.artist).includes(target) || normalize(`${track.title} ${track.album}`).includes(target);
    if (!matchedTarget && !sceneCorroboratesArtistDrift(track, options, profile)) {
      return `Search was for ${targetArtist}, but TIDAL returned ${track.artist}.`;
    }
  }
  const requestedMismatch = requestedArtistMismatchReason(track, profile);
  if (requestedMismatch) return requestedMismatch;
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
  if (isShortEdit(track)) return "Short/radio edit.";
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

function hasSeedArtistMatch(track = {}, options = {}, profile = null) {
  const seedKeys = new Set((profile?.seedArtists || extractSeedArtists(options)).map(normalize));
  if (!seedKeys.size) return false;
  return splitArtists(track.artist).some((artist) => seedKeys.has(normalize(artist)));
}

function requestedLabelMatch(track = {}, profile = {}) {
  const label = labelText(track);
  if (!label || !profile.requestedLabels?.length) return "";
  return profile.requestedLabels.find((requested) => containsEntityTerm(label, requested) || containsEntityTerm(requested, label)) || "";
}

function lengthPreferenceIsRelevant(options = {}, profile = {}) {
  if (wantsLongTracks(options)) return true;
  if (profile.isProgressiveTarget) return true;
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
    const key = normalize(artist);
    if (key && topArtistsByKey[key]) return topArtistsByKey[key];
  }
  return null;
}

function profileSeedArtistMatch(track = {}, profile = {}) {
  const seedKeys = new Set((profile.seedArtists || []).map(normalize));
  if (!seedKeys.size) return false;
  return splitArtists(track.artist).some((artist) => seedKeys.has(normalize(artist)));
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

function scoreBreakdownFor(track = {}, options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options), scrobbleHistory = null) {
  const yearRange = parseYearRange(options);
  const wanted = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const queryText = normalize(track.query);
  const text = normalize(`${metadataText} ${queryText}`);
  const sceneArtist = profile.isProgressiveTarget ? matchingSceneArtist(track.artist) : "";
  const sceneLabel = profile.isProgressiveTarget ? matchingSceneLabel(labelText(track)) : "";
  const sceneEvidence = profile.targetGenres.length ? sceneEvidenceFor(track, track.query, options, profile) : {};
  const genreInference = profile.targetGenres.length
    ? genreInferenceFor(track, track.query, options, profile, tasteProfile)
    : { confidence: 0, inferredGenres: [], evidence: [], summary: "", weakOfficialGenre: false, queryOnly: false, corroboratesRequested: true };
  const minutes = durationMinutes(track);
  const currentYear = new Date().getFullYear();

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
  if (sceneLabel && wanted.includes(normalize(sceneLabel))) labelMatch += 2;
  if (profile.isGenreDiscoveryTarget && labelText(track)) {
    const seedLabel = genreLabelSeeds(profile).find((seed) => containsEntityTerm(labelText(track), seed));
    labelMatch = Math.max(labelMatch, seedLabel ? 16 : 6);
  }
  labelMatch = clamp(labelMatch, 0, SCORE_MAX.labelMatch);

  let artistMatch = 0;
  if (hasSeedArtistMatch(track, options, profile)) artistMatch = SCORE_MAX.artistMatch;
  else if (sceneArtist) artistMatch = 15;
  else if (wanted && splitArtists(track.artist).some((artist) => wanted.includes(normalize(artist)))) artistMatch = 11;
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

  let genreMatch = 0;
  if (profile.targetGenres.length) {
    const adjacentTerms = adjacentLaneTerms(profile, options);
    if (hasAnyTerm(metadataText, profile.targetGenres)) genreMatch += profile.isGenreDiscoveryTarget ? 20 : 11;
    else if (track.discoveryLane === "adjacent" && hasAnyTerm(metadataText, adjacentTerms)) genreMatch += profile.isGenreDiscoveryTarget ? 13 : 8;
    else if (hasAnyTerm(queryText, profile.targetGenres)) genreMatch += profile.isGenreDiscoveryTarget ? 6 : 4;
    else if (track.discoveryLane === "adjacent" && hasAnyTerm(queryText, adjacentTerms)) genreMatch += profile.isGenreDiscoveryTarget ? 5 : 3;
  }
  if (profile.vibeTerms.length) {
    if (hasAnyTerm(metadataText, profile.vibeTerms)) genreMatch += 8;
    else if (hasAnyTerm(queryText, profile.vibeTerms)) genreMatch += 5;
  }
  if (!profile.targetGenres.length && wanted.includes("progressive")) genreMatch += 5;
  if (sceneArtist) genreMatch += 6;
  if (sceneLabel) genreMatch += 4;
  if (profile.isProgressiveTarget && /\bprogressive\b/.test(text)) genreMatch += 5;
  if (profile.isProgressiveTarget && /\bmelodic\b/.test(text)) genreMatch += 3;
  if (profile.isProgressiveTarget && /\bdeep\b/.test(text)) genreMatch += 3;
  if (profile.isProgressiveTarget && /\borganic\b/.test(text)) genreMatch += 2;
  if (wanted.includes("hypnotic") && /\b(?:hypnotic|deep|dub|journey|extended)\b/.test(text)) genreMatch += 3;
  if (wanted.includes("driving") && /\b(?:driving|club|extended|peak|energy)\b/.test(text)) genreMatch += 3;
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

  if (isShortEdit(track)) {
    lengthPreference = Math.min(lengthPreference, 4);
    tasteAdjustment -= 6;
  }
  if (isReissueLike(track)) freshness = Math.min(freshness, 4);
  if (/\b(?:radio|festival|big room|edm|pop dance)\b/.test(text)) genreMatch = Math.max(0, genreMatch - 10);

  tasteAdjustment = clamp(tasteAdjustment, tasteMin, tasteMax);
  const calibrationAdjustment = clamp(calibration.value || 0, -10, 0);
  const categoryTotal = freshness + labelMatch + artistMatch + lengthPreference + genreMatch;
  const total = clamp(categoryTotal + tasteAdjustment + calibrationAdjustment, 1, 100);
  const baseBreakdown = {
    total,
    freshness,
    labelMatch,
    artistMatch,
    lengthPreference,
    genreMatch,
    genreInference,
    tasteAdjustment,
    tasteReasons: [...(taste.reasons || []), ...lastfmTaste.reasons],
    lastfmAdjustment: lastfmTaste.value,
    lastfmReasons: lastfmTaste.reasons,
    lastfmRecentRepeat: lastfmTaste.recentRepeat,
    calibrationAdjustment,
    calibrationReasons: calibration.reasons || [],
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
  const sceneArtist = profile.isProgressiveTarget ? matchingSceneArtist(track.artist) : "";
  const sceneLabel = profile.isProgressiveTarget ? matchingSceneLabel(labelText(track)) : "";
  const metadataText = `${track.artist} ${track.title} ${track.album} ${labelText(track)}`;
  const releaseValue = releaseValueForDisplay(track);
  if (releaseValue) parts.push(`${releaseValue} TIDAL release`);
  if (sceneLabel) parts.push(`${sceneLabel} label fit`);
  if (sceneArtist) parts.push(`${sceneArtist} sits in the requested progressive lane`);
  if (score.genreInference?.summary && Number(score.genreInference.confidence || 0) >= 35) {
    parts.push(`genre inferred from ${score.genreInference.summary}`);
  }
  if (!sceneArtist && hasAnyTerm(`${metadataText} ${track.query}`, profile.targetGenres)) parts.push(`${profile.targetGenres[0]} target fit`);
  if (track.discoveryLane === "adjacent") parts.push("adjacent-lane discovery");
  if (track.discoveryLane === "recent") parts.push("recent-year fallback");
  if (hasAnyTerm(`${metadataText} ${track.query}`, profile.vibeTerms)) parts.push(`${profile.vibeTerms[0]} seed-vibe fit`);
  if (minutes) parts.push(`${minutes.toFixed(1)} min`);
  const lastfmReasons = score.lastfmReasons || [];
  if (lastfmReasons.some((reason) => /long-term Last\.fm/i.test(reason))) parts.push("light Last.fm long-term artist signal");
  else if (score.tasteAdjustment > 0) parts.push("boosted by your thumbs-up history");
  if (lastfmReasons.some((reason) => /recent Last\.fm repeat|currently scrobbling/i.test(reason))) parts.push("downweighted recent Last.fm repeat");
  else if (score.tasteAdjustment < 0) parts.push("penalized by your thumbs-down history");
  if (score.calibrationAdjustment < 0) parts.push("downweighted by feedback calibration");
  const text = normalize(`${track.title} ${track.album} ${track.query}`);
  if (text.includes("melodic")) parts.push(profile.isProgressiveTarget ? "melodic/progressive signal" : "melodic signal");
  if (text.includes("deep")) parts.push(profile.isProgressiveTarget ? "deep progressive signal" : "deep signal");
  if (!parts.length) parts.push("catalogue match from TIDAL search");
  return parts.slice(0, 4).join("; ");
}

function hasArtistMatch(value, artist) {
  const wanted = normalize(artist);
  if (!wanted) return false;
  return splitArtists(value).some((candidate) => normalize(candidate) === wanted);
}

function discoverySourceForArtist(artist, options = {}, tasteProfile = null) {
  if (hasArtistMatch(options.nowPlaying?.artist, artist)) return "Recently played seed";
  if (extractSeedArtists(options).some((seed) => normalize(seed) === normalize(artist))) return "Artist expansion";
  const learned = typeof tasteProfile?.getTopArtists === "function" ? tasteProfile.getTopArtists(12) : [];
  if (learned.some((seed) => normalize(seed) === normalize(artist))) return "Liked artist expansion";
  return "Similar artist";
}

function discoverySourceForResult(track = {}, options = {}) {
  const query = normalize(track.query);
  if (splitArtists(options.nowPlaying?.artist).some((artist) => query.includes(normalize(artist)))) {
    return "Recently played seed";
  }
  if (extractSeedArtists(options).some((artist) => query.includes(normalize(artist)))) {
    return "Artist expansion";
  }
  if (matchingSceneArtist(track.artist)) return "Similar artist";
  return "TIDAL search";
}

function discoveryQuotaBucket(track = {}, profile = {}) {
  const lane = normalize(track.discoveryLane);
  const source = normalize(track.discoverySource);
  if (lane.includes("adjacent")) return "adjacent";
  if (lane.includes("recent") || source.includes("fallback")) return "recent";
  if (lane.includes("expanded") || lane.includes("relaxed") || track.autoBroadened) return "expanded";
  if (source.includes("liked artist") || source.includes("similar artist") || source.includes("artist expansion") || source.includes("recently played seed")) {
    return "taste";
  }
  if (labelText(track) && (source.includes("tidal search") || source.includes("local model") || source.includes("catalogue"))) {
    return "label";
  }
  return "core";
}

function discoveryLaneQuotaPlan(requestedCount = 8, profile = {}) {
  const count = Math.max(1, Math.min(40, Number(requestedCount || 8)));
  const explore = profile.scoringMode === "explore";
  const similar = profile.scoringMode === "similar";
  const pure = profile.scoringMode === "pure";
  const smallDiscoveryRequest = count >= 5 && count < 8 && !pure && !similar && Boolean(profile.targetGenres?.length || profile.vibeTerms?.length);
  const targets = {
    core: count >= 8 ? Math.max(2, Math.floor(count * (explore ? 0.35 : 0.45))) : Math.max(1, Math.ceil(count * 0.6)),
    adjacent: count >= 8 ? Math.max(1, Math.floor(count * (explore ? 0.22 : 0.16))) : ((explore && count >= 5) || smallDiscoveryRequest ? 1 : 0),
    label: count >= 8 ? 1 : (smallDiscoveryRequest ? 1 : 0),
    taste: !pure && count >= 8 ? Math.max(1, Math.floor(count * (similar ? 0.25 : 0.14))) : (smallDiscoveryRequest ? 1 : 0),
    expanded: count >= 12 ? 1 : 0,
    recent: 0
  };
  const max = {
    core: count,
    adjacent: Math.max(targets.adjacent, Math.ceil(count * (explore ? 0.4 : 0.3))),
    label: Math.max(targets.label, Math.ceil(count * 0.35)),
    taste: pure ? 0 : Math.max(targets.taste, Math.ceil(count * (similar ? 0.55 : (explore ? 0.25 : 0.4)))),
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
  if (total >= 2 && missRate >= 0.34) risk += 1;
  if (total >= 3 && missRate >= 0.5) risk += 1;
  if (badBoosts >= 2 || promptMismatches >= 2) risk += 1;
  return Math.max(0, Math.min(4, risk));
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
    reasons.push(`${kind} ${name} ${entry.modelMisses}/${entry.total}`);
  }

  return {
    value: Math.max(0, Math.min(8, value)),
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
  const riskCache = new WeakMap();
  function riskFor(candidate = {}) {
    if (!candidate || typeof candidate !== "object") return { value: 0, reasons: [] };
    if (!riskCache.has(candidate)) riskCache.set(candidate, candidateCalibrationRisk(candidate, calibration));
    return riskCache.get(candidate);
  }
  function quotaRank(candidate = {}) {
    return Number(candidate.score || 0) - (riskFor(candidate).value * 4);
  }
  const sorted = candidates.slice().sort((left, right) => (
    quotaRank(right) - quotaRank(left) ||
    Number(right.score || 0) - Number(left.score || 0) ||
    (right.durationMs || 0) - (left.durationMs || 0)
  ));
  const basePlan = discoveryLaneQuotaPlan(limit, profile);
  let plan = basePlan;
  const bucketOrder = ["core", "label", "adjacent", "taste", "expanded", "recent"];
  const selected = [];
  const selectedKeys = new Set();
  const artistCounts = new Map();
  const albumCounts = new Map();
  const bucketCounts = new Map();
  const availableCounts = new Map();
  const buckets = new Map(bucketOrder.map((bucket) => [bucket, []]));
  const maxPerPrimaryArtist = limit <= 12 ? 1 : 2;

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

  function addCandidate(candidate = {}, caps = {}) {
    if (selected.length >= limit || hasSelected(candidate)) return false;
    const bucket = discoveryQuotaBucket(candidate, profile);
    const bucketCap = caps.bucketMax ?? Number.MAX_SAFE_INTEGER;
    const bucketCount = bucketCounts.get(bucket) || 0;
    if (bucketCount >= bucketCap) return false;

    const artistKeys = artistKeysForCandidate(candidate);
    const albumKey = normalize(candidate.album);
    const artistCap = caps.artistCap ?? maxPerPrimaryArtist;
    const albumCap = caps.albumCap ?? 1;
    if (artistKeys.some((artistKey) => (artistCounts.get(artistKey) || 0) >= artistCap)) return false;
    if (albumKey && (albumCounts.get(albumKey) || 0) >= albumCap) return false;

    const keys = candidateIdentityKeys(candidate);
    for (const key of keys) selectedKeys.add(key);
    selected.push(withQuotaBucket(candidate, bucket, riskFor(candidate)));
    for (const artistKey of artistKeys) {
      artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1);
    }
    if (albumKey) albumCounts.set(albumKey, (albumCounts.get(albumKey) || 0) + 1);
    bucketCounts.set(bucket, bucketCount + 1);
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
    addCandidate(candidate, {
      bucketMax: Number.MAX_SAFE_INTEGER,
      artistCap: Number.MAX_SAFE_INTEGER,
      albumCap: Number.MAX_SAFE_INTEGER
    });
  }

  const alternates = sorted
    .filter((candidate) => !hasSelected(candidate))
    .map((candidate) => withQuotaBucket(candidate, discoveryQuotaBucket(candidate, profile), riskFor(candidate)));

  return {
    tracks: selected,
    alternates,
    quota: {
      enabled: true,
      requested: limit,
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
  const sceneLabel = profile.isProgressiveTarget ? matchingSceneLabel(label) : "";
  const sceneArtist = profile.isProgressiveTarget ? matchingSceneArtist(track.artist) : "";
  const minutes = durationMinutes(track);
  const text = normalize(`${track.artist} ${track.title} ${track.album} ${label} ${track.query}`);

  if (sceneLabel) bullets.push(`${sceneLabel} label match`);
  else if (label) bullets.push(`${label} label metadata`);

  if (breakdown.genreInference?.summary && Number(breakdown.genreInference.confidence || 0) >= 35) {
    bullets.push(`Genre inferred from ${breakdown.genreInference.summary}`);
  }

  if (sceneArtist) bullets.push("Similar progressive/melodic lane");
  else if (profile.targetGenres.length && hasAnyTerm(text, profile.targetGenres)) bullets.push(`${profile.targetGenres[0]} target genre signal`);
  if (profile.vibeTerms.length && hasAnyTerm(text, profile.vibeTerms)) bullets.push(`${profile.vibeTerms[0]} seed-vibe signal`);

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
  bullets.push(historyEntry ? "Previously suggested" : "Not previously suggested");

  const seen = new Set();
  return bullets.filter((bullet) => {
    const key = normalize(bullet);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
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

async function discoverTracks({ tidal, options = {}, history, tasteProfile = null, scrobbleHistory = null, queryYieldTracker = null } = {}) {
  if (!tidal?.isConfigured?.()) {
    throw new Error("TIDAL is not configured. Add TIDAL_CLIENT_ID/TIDAL_CLIENT_SECRET or TIDAL_ACCESS_TOKEN to .env.");
  }

  const startedAt = Date.now();
  const runtimeMs = Math.max(0, Number(options.discoveryRuntimeMs || options.maxRuntimeMs || 0));
  const deadlineAt = runtimeMs ? startedAt + runtimeMs : 0;
  let budgetExhausted = false;
  function hasBudget(reserveMs = 0) {
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
  const candidatePoolTarget = strictRoonMode
    ? (isYearCatalogSearch
      ? Math.min(160, Math.max(Math.ceil(requestedCount * 7), requestedCount + 54))
      : Math.min(650, Math.max(Math.ceil(requestedCount * 18), requestedCount + 260)))
    : (isYearCatalogSearch
      ? (smallExactYearSearch
        ? Math.min(180, Math.max(Math.ceil(requestedCount * 18), requestedCount + 95))
        : Math.min(140, Math.max(Math.ceil(requestedCount * 7), requestedCount + 48)))
      : Math.min(140, Math.max(Math.ceil(requestedCount * 4), requestedCount + 35)));
  const usefulCandidateTarget = isYearCatalogSearch
    ? (smallExactYearSearch
      ? Math.min(candidatePoolTarget, Math.max(Math.ceil(requestedCount * 8), requestedCount + 36))
      : Math.min(candidatePoolTarget, Math.max(Math.ceil(requestedCount * (strictRoonMode ? 4 : 3)), requestedCount + (strictRoonMode ? 28 : 18))))
    : candidatePoolTarget;
  const minScore = minimumScoreFor(options);
  const minScoreLabel = minimumScoreLabel(minScore);
  const queries = buildSearchQueries(options, tasteProfile, profile);
  const discarded = [];
  const scoreFiltered = [];
  const minimumRescueCandidates = [];
  const previousCandidates = [];
  const byKey = new Map();
  const seenCandidateKeys = new Set();
  const allowPreviousSuggestions = allowsPreviouslySuggested(options);
  const allowPreviousFallback = allowsPreviousDiscoveryFallback(options);
  const queryYieldRecords = new Map();
  const queryYieldAdjustments = [];
  const queryYieldPruned = [];
  const laneBudgetStops = [];

  function searchConcurrencyFor(lane = "core") {
    if (strictRoonMode) return 2;
    if (options.autoBroadenLane === "relaxed-vibe") return 1;
    if (isYearCatalogSearch) return smallExactYearSearch ? 2 : 2;
    return lane === "recent" ? 1 : 2;
  }

  function reserveForRemainingLanes(lane = "core") {
    if (!deadlineAt) return 0;
    if (options.autoBroaden) return 2_500;
    if (!profile.isGenreDiscoveryTarget) return 2_500;
    if (lane === "core") return yearRange ? 10_000 : 6_000;
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

  function rankTrackedQueries(list = [], lane = "core") {
    if (!queryYieldTracker || typeof queryYieldTracker.rankQueries !== "function") return list;
    try {
      const ranked = queryYieldTracker.rankQueries(list, {
        lane,
        scoringMode: profile.scoringMode,
        genres: profile.targetGenres,
        vibes: profile.vibeTerms,
        prune: true
      });
      for (const item of ranked.adjustments || []) {
        queryYieldAdjustments.push({ ...item, lane });
      }
      for (const item of ranked.pruned || []) {
        queryYieldPruned.push({ ...item, lane });
      }
      return ranked.queries || list;
    } catch {
      return list;
    }
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
  }

  function recordQueryRejected(query, lane, reason) {
    const record = queryYieldRecordFor(query, lane);
    if (!record) return;
    const bucket = rejectionBucketForReason(reason);
    record.rejected += 1;
    if (bucket === "seo") record.seoRejects += 1;
    if (bucket === "genre") record.genreRejects += 1;
  }

  function recordQueryError(query, lane) {
    const record = queryYieldRecordFor(query, lane);
    if (!record) return;
    record.attempts += 1;
    record.errorCount += 1;
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
    const keys = candidateIdentityKeys(result);
    const key = keys[0];
    if (!key || keys.some((candidateKey) => seenCandidateKeys.has(candidateKey))) return;
    const context = queryContextFor(result, queryContext);
    const historyEntry = typeof history?.entryFor === "function" ? history.entryFor(result) : null;
    const reason = rejectReason(result, scoringOptions, scoringProfile);
    if (reason) {
      if (context.tracked) recordQueryRejected(context.query, context.lane, reason);
      discarded.push({ ...result, reason });
      return;
    }

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
      scoreBreakdown,
      tidal: result,
      statusChecks: [...discoveryStatusFor(result, historyEntry, false, scrobbleHistory), ...artistDiversityChecks],
      verificationSource: "tidal"
    };
    candidate.feedback = typeof tasteProfile?.getFeedbackFor === "function" ? tasteProfile.getFeedbackFor(candidate) : "";
    for (const candidateKey of keys) seenCandidateKeys.add(candidateKey);

    if (minScore && candidate.score < minScore) {
      const belowMinimumReason = `Discovery score ${candidate.score} is below minimum ${minScoreLabel}.`;
      candidate.belowMinimum = true;
      candidate.minimumScore = minScore;
      candidate.minimumScoreLabel = minScoreLabel;
      candidate.reason = `${candidate.reason}; below ${minScoreLabel} floor`;
      candidate.statusChecks = [...candidate.statusChecks, belowMinimumReason];
      const softRejectReason = belowMinimumSoftRejectReason(candidate, scoringProfile);
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
        if (context.tracked) recordQueryRejected(context.query, context.lane, softRejectReason);
        discarded.push({ ...candidate, reason: softRejectReason });
        return;
      }
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
      if (context.tracked) recordQueryRejected(context.query, context.lane, "Previously suggested; held back for discovery variety.");
      discarded.push({ ...result, reason: "Previously suggested; held back for discovery variety." });
      return;
    }

    if (context.tracked) recordQueryAccepted(context.query, context.lane);
    byKey.set(key, candidate);
  }

  const modelCandidateLimit = strictRoonMode ? Math.max(40, requestedCount * 4) : Math.max(30, requestedCount * 3);
  const modelCandidates = Array.isArray(options.llmCandidates) ? options.llmCandidates.slice(0, modelCandidateLimit) : [];
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

  const artistSeedLimit = isYearCatalogSearch
    ? (strictRoonMode
      ? Math.min(42, Math.max(30, requestedCount + 24))
      : (smallExactYearSearch ? Math.min(24, Math.max(14, requestedCount + 10)) : Math.min(26, Math.max(18, requestedCount + 12))))
    : (strictRoonMode ? Math.max(12, Math.min(24, requestedCount + 8)) : Math.max(10, Math.min(18, requestedCount + 6)));
  const artistSeeds = buildArtistSeeds(options, artistSeedLimit, tasteProfile, profile);
  const hasGenreArtistAnchors = Boolean(profile.isGenreDiscoveryTarget && genreArtistAnchors(profile).length);
  const wantsDeepArtistCrawl = /\b(?:deep catalog|catalog crawl|discography|albums?|artist deep dive|accuracy|accurate|scrape)\b/i.test(`${options.request || ""} ${options.reference || ""}`);
  const useAlbumExpansion = !options.autoBroaden && (isYearCatalogSearch
    ? Boolean(strictRoonMode || profile.seedArtists.length || profile.requestedArtists.length || profile.isProgressiveTarget || hasGenreArtistAnchors || wantsDeepArtistCrawl)
    : (strictRoonMode || requestedCount <= 16 || wantsDeepArtistCrawl));
  const albumExpansionReserveMs = smallExactYearSearch && runtimeMs
    ? Math.max(8_000, Math.min(14_000, Math.floor(runtimeMs * 0.4)))
    : 2_500;

  if (useAlbumExpansion) {
    const artistExpansionLimit = isYearCatalogSearch
      ? (strictRoonMode
        ? Math.min(36, Math.max(26, requestedCount + 16))
        : (smallExactYearSearch
          ? (requestedCount <= 2 ? Math.min(34, Math.max(24, requestedCount + 20)) : Math.min(12, Math.max(8, requestedCount + 5)))
          : Math.min(20, Math.max(12, requestedCount + 6))))
      : (strictRoonMode ? (requestedCount >= 20 ? 14 : 10) : (requestedCount >= 20 ? 8 : 6));
    const artistsToExpand = artistSeeds.slice(0, artistExpansionLimit);
    await mapWithConcurrency(artistsToExpand, isYearCatalogSearch ? (strictRoonMode ? 3 : 2) : 2, async (artist) => {
      if (!hasBudget(albumExpansionReserveMs)) {
        noteBudgetExhausted();
        return;
      }
      if (byKey.size >= usefulCandidateTarget) return;
      let albums = [];
      try {
        albums = await tidal.getArtistAlbums(artist, {
          limit: isYearCatalogSearch
            ? (strictRoonMode ? 10 : 12)
            : (strictRoonMode ? (yearRange ? 12 : 6) : (yearRange ? 6 : 3))
        });
      } catch (error) {
        discarded.push({ query: artist, reason: error.message });
        return;
      }

      let artistAccepted = 0;
      const perArtistLimit = isYearCatalogSearch
        ? (strictRoonMode ? 3 : (smallExactYearSearch ? 1 : 2))
        : (strictRoonMode ? (requestedCount >= 20 ? 5 : 3) : (requestedCount >= 20 ? 3 : 2));
      for (const album of albums) {
        if (!hasBudget(albumExpansionReserveMs)) {
          noteBudgetExhausted();
          break;
        }
        if (artistAccepted >= perArtistLimit || byKey.size >= usefulCandidateTarget) break;
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
            limit: isYearCatalogSearch ? (strictRoonMode ? 5 : (smallExactYearSearch ? 4 : 3)) : (strictRoonMode ? 7 : (yearRange ? 4 : 3))
          });
        } catch (error) {
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
          if (artistAccepted >= perArtistLimit || byKey.size >= usefulCandidateTarget) break;
        }
      }
    });
  }

  const searchQueries = isYearCatalogSearch
    ? queries.slice(0, strictRoonMode ? 28 : (smallExactYearSearch ? 28 : Math.min(14, Math.max(8, requestedCount + 6))))
    : queries;
  const coreLane = options.autoBroadenLane || "core";
  const rankedSearchQueries = rankTrackedQueries(searchQueries, coreLane);
  if (byKey.size < usefulCandidateTarget) await mapWithConcurrency(rankedSearchQueries, searchConcurrencyFor(coreLane), async (query) => {
    if (!hasLaneBudget(coreLane)) {
      return;
    }
    if (byKey.size >= usefulCandidateTarget) return;
    let results = [];
    try {
      results = await tidal.searchTracks(query, {
        limit: strictRoonMode ? (isYearCatalogSearch ? 16 : 16) : (isYearCatalogSearch ? (smallExactYearSearch ? 12 : 8) : 6),
        detailLimit: yearRange?.dateSpecific
          ? (strictRoonMode ? 12 : 8)
          : (yearRange ? (isYearCatalogSearch ? (strictRoonMode ? 5 : (smallExactYearSearch ? 4 : 2)) : (strictRoonMode ? 5 : 3)) : (strictRoonMode ? 3 : 1))
      });
      recordQueryAttempt(query, coreLane, results.length);
    } catch (error) {
      recordQueryError(query, coreLane);
      discarded.push({ query, reason: error.message });
      return;
    }

    for (const result of results) {
      consider({
        ...result,
        discoverySource: cleanText(options.autoBroadenLabel) || discoverySourceForResult(result, options),
        discoveryLane: options.autoBroadenLane === "adjacent" ? "adjacent" : (result.discoveryLane || options.autoBroadenLane || "core")
      }, options, profile, { query, lane: coreLane, trackYield: true });
      if (byKey.size >= usefulCandidateTarget) break;
    }
  });

  const adjacentCandidateFloor = Math.min(
    usefulCandidateTarget,
    Math.max(requestedCount + (smallExactYearSearch ? 12 : 8), Math.ceil(usefulCandidateTarget * (smallExactYearSearch ? 0.7 : 0.55)))
  );
  if (profile.isGenreDiscoveryTarget && byKey.size < adjacentCandidateFloor) {
    const usedQueries = new Set(searchQueries.map(normalize));
    const adjacentQueries = buildAdjacentSearchQueries(options, tasteProfile, profile)
      .filter((query) => !usedQueries.has(normalize(query)))
      .slice(0, isYearCatalogSearch ? (strictRoonMode ? 28 : 22) : 16);
    const rankedAdjacentQueries = rankTrackedQueries(adjacentQueries, "adjacent");

    await mapWithConcurrency(rankedAdjacentQueries, searchConcurrencyFor("adjacent"), async (query) => {
      if (!hasLaneBudget("adjacent")) {
        return;
      }
      if (byKey.size >= usefulCandidateTarget) return;
      let results = [];
      try {
        results = await tidal.searchTracks(query, {
          limit: strictRoonMode ? (isYearCatalogSearch ? 16 : 14) : (isYearCatalogSearch ? (smallExactYearSearch ? 12 : 8) : 8),
          detailLimit: yearRange?.dateSpecific
            ? (strictRoonMode ? 12 : 8)
            : (yearRange ? (isYearCatalogSearch ? (strictRoonMode ? 5 : (smallExactYearSearch ? 4 : 2)) : 3) : 2)
        });
        recordQueryAttempt(query, "adjacent", results.length);
      } catch (error) {
        recordQueryError(query, "adjacent");
        discarded.push({ query, reason: error.message });
        return;
      }

      for (const result of results) {
        consider({
          ...result,
          discoverySource: "Adjacent lane search",
          discoveryLane: "adjacent"
        }, options, profile, { query, lane: "adjacent", trackYield: true });
        if (byKey.size >= usefulCandidateTarget) break;
      }
    });
  }

  const relaxedYearOptions = byKey.size < requestedCount ? nearYearFallbackOptions(options, yearRange) : null;
  if (relaxedYearOptions) {
    const relaxedProfile = buildDiscoveryProfile(relaxedYearOptions);
    const usedQueries = new Set(searchQueries.map(normalize));
    const relaxedQueries = buildSceneAnchorRecentQueries(relaxedYearOptions, tasteProfile, relaxedProfile)
      .filter((query) => !usedQueries.has(normalize(query)))
      .slice(0, strictRoonMode ? 72 : 56);
    const rankedRelaxedQueries = rankTrackedQueries(relaxedQueries, "recent");

    await mapWithConcurrency(rankedRelaxedQueries, searchConcurrencyFor("recent"), async (query) => {
      if (!hasLaneBudget("recent")) {
        return;
      }
      if (byKey.size >= usefulCandidateTarget) return;
      let results = [];
      try {
        results = await tidal.searchTracks(query, {
          limit: strictRoonMode ? 14 : 10,
          detailLimit: strictRoonMode ? 5 : 4
        });
        recordQueryAttempt(query, "recent", results.length);
      } catch (error) {
        recordQueryError(query, "recent");
        discarded.push({ query, reason: error.message });
        return;
      }

      for (const result of results) {
        consider({
          ...result,
          discoverySource: "Recent-year fallback search",
          discoveryLane: "recent"
        }, relaxedYearOptions, relaxedProfile, { query, lane: "recent", trackYield: true });
        if (byKey.size >= usefulCandidateTarget) break;
      }
    });
  }

  const candidates = Array.from(byKey.values())
    .sort((left, right) => right.score - left.score || (right.durationMs || 0) - (left.durationMs || 0));
  const quotaCalibration = typeof tasteProfile?.read === "function" ? tasteProfile.read().calibration : null;
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

  const fallbackAlternates = [];
  if (allowPreviousFallback && tracks.length < requestedCount && typeof history?.fallbackCandidates === "function") {
    const fallbackEntries = history.fallbackCandidates({ limit: Math.max(60, requestedCount * 4) });
    const selectedKeys = new Set(tracks.flatMap(candidateIdentityKeys));
    const fallbackAlternateTarget = Math.max(15, requestedCount);

    for (const entry of fallbackEntries) {
      if (tracks.length >= requestedCount && fallbackAlternates.length >= fallbackAlternateTarget) break;
      const entryKeys = candidateIdentityKeys(entry);
      if (!entryKeys.length || entryKeys.some((key) => selectedKeys.has(key))) continue;

      try {
        const tidalId = tidalTrackIdFromUrl(entry.tidalUrl);
        const result = tidalId && typeof tidal.getTrack === "function"
          ? await tidal.getTrack(tidalId, `${entry.artist} ${entry.title}`)
          : await tidal.verify?.({ artist: entry.artist, title: entry.title }, { strict: Boolean(yearRange) });
        if (!result) continue;

        const reason = rejectReason(result, options, profile);
        if (reason) {
          discarded.push({ ...result, reason });
          continue;
        }

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
          const softRejectReason = belowMinimumSoftRejectReason(candidate, profile);
          if (softRejectReason) {
            discarded.push({ ...candidate, reason: softRejectReason });
            continue;
          }
          scoreFiltered.push({
            ...candidate,
            reason: belowMinimumReason
          });
        }
        const keys = candidateIdentityKeys(candidate);
        if (keys.length && !keys.some((key) => selectedKeys.has(key))) {
          for (const key of keys) selectedKeys.add(key);
          if (tracks.length < requestedCount) tracks.push(candidate);
          else fallbackAlternates.push(candidate);
        }
      } catch (error) {
        discarded.push({ artist: entry.artist, title: entry.title, reason: error.message });
      }
    }
  }

  const selectedKeys = new Set(tracks.flatMap(candidateIdentityKeys));
  const alternates = laneSelection.alternates
    .filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key)))
    .concat(fallbackAlternates.filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key))))
    .slice(0, Math.max(160, requestedCount * 14));
  const finalDiscarded = discarded.filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key)));
  const belowMinimumKept = tracks.filter((candidate) => candidate.belowMinimum).length;
  const belowMinimumAlternates = alternates.filter((candidate) => candidate.belowMinimum).length;
  const aboveMinimumKept = minScore ? Math.max(0, tracks.length - belowMinimumKept) : tracks.length;
  const generated = tracks.length + alternates.length + finalDiscarded.length;
  const queryYield = queryYieldSummary();
  const poolDiagnostics = buildPoolDiagnostics({
    tracks,
    alternates,
    discarded: finalDiscarded,
    scoreFiltered,
    minimumRescueCandidates,
    previousCandidates,
    requestedCount,
    generated,
    candidatePoolTarget,
    usefulCandidateTarget,
    budgetExhausted,
    laneSelection,
    queryYield
  });

  return {
    requestedCount,
    tracks,
    alternates,
    discarded: finalDiscarded,
    verification: {
      enabled: true,
      tidal: true,
      requested: requestedCount,
      originalRequested: originalRequestedCount,
      countExpanded: requestedCount !== originalRequestedCount,
      generated,
      kept: tracks.length,
      discarded: finalDiscarded.length,
      runtimeMs: Date.now() - startedAt,
      budgetExhausted,
      minScore,
      minScoreLabel,
      scoreFiltered: scoreFiltered.length + minimumRescueCandidates.length,
      belowMinimumKept,
      belowMinimumAlternates,
      aboveMinimumKept,
      minScoreSoftFallback: Boolean(minScore && belowMinimumKept),
      belowMinimumRescueAvailable: minimumRescueCandidates.length,
      belowMinimumRescueKept: minimumRescueKept || tracks.filter((candidate) => candidate.belowMinimumRescue).length,
      strategy: "tidal-catalog-first",
      novelty: !allowPreviousSuggestions,
      previouslySuggestedAllowed: allowPreviousSuggestions,
      previousDiscoveryFallback: allowPreviousFallback,
      previouslySuggestedHeldBack: previousCandidates.length,
      nearYearFallback: Boolean(relaxedYearOptions),
      nearYearFallbackRange: relaxedYearOptions?.years || "",
      queries: queries.slice(0, 12),
      candidatePoolTarget,
      usefulCandidateTarget,
      laneQuotas: laneSelection.quota,
      adjacentLaneTerms: adjacentLaneTerms(profile, options).slice(0, 12),
      profile: {
        targetGenres: profile.targetGenres,
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
  effectiveDiscoveryCount,
  nearYearFallbackOptions,
  parseRequestedCount,
  parseYearRange,
  reasonFor,
  rejectReason,
  scoreBreakdownFor,
  whyBulletsFor,
  buildDiscoveryProfile,
  belowMinimumSoftRejectReason,
  releaseFilterRequiresVerification,
  autoBroadenSearchPasses,
  discoveryQuotaBucket,
  artistDiversityAdjustmentFor,
  selectDiscoveryLaneCandidates,
  normalizeScoringMode
};
