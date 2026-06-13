"use strict";

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

function parseRequestedCount(options = {}) {
  const effective = Number(options.effectiveCount || 0);
  if (effective > 0) return Math.min(40, Math.max(1, effective));

  const explicit = Number(options.count || 0);
  if (explicit > 0) return Math.min(40, Math.max(1, explicit));

  const request = cleanText(options.request);
  const match = request.match(/\b(\d{1,2})\s*(?:track|song|cut|candidate|recommendation)s?\b/i);
  return match ? Math.min(40, Math.max(1, Number(match[1]))) : 8;
}

function hasHardCountLanguage(options = {}) {
  const request = cleanText(options.request);
  return /\b(?:exactly|only|just|no more than|not more than|max(?:imum)?|limit(?:ed)? to)\s+\d{1,2}\b/i.test(request) ||
    /\b\d{1,2}\s*(?:tracks?|songs?|cuts?|candidates?|recommendations?)\s*(?:only|exactly|max(?:imum)?)\b/i.test(request);
}

function effectiveDiscoveryCount(options = {}, profile = null) {
  const requested = parseRequestedCount({ ...options, effectiveCount: 0 });
  if (requested >= 8 || hasHardCountLanguage(options)) return requested;

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

function inferredGenreFor(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
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
  const reasons = [];

  const genreScore = targetGenres.length
    ? (hasAnyTerm(metadataText, targetGenres) ? 38 : (hasAnyTerm(queryText, targetGenres) ? 26 : Math.round((Number(breakdown.genreMatch || 0) / SCORE_MAX.genreMatch) * 30)))
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
  const genre = inferredGenreFor(track, options, profile);
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

const TARGET_GENRE_ALIASES = [
  ["psytrance", ["psytrance", "psy trance", "psychedelic trance", "progressive psytrance", "deep psytrance", "hypnotic psytrance", "goa trance"]],
  ["progressive house", ["progressive house", "melodic progressive house", "deep progressive house", "organic progressive house", "progressive electronic"]],
  ["progressive trance", ["progressive trance", "deep progressive trance", "melodic progressive trance"]],
  ["progressive", ["progressive house", "melodic progressive", "deep progressive", "progressive trance"]],
  ["melodic techno", ["melodic techno", "deep melodic techno", "afterlife techno"]],
  ["melodic house", ["melodic house", "deep melodic house", "organic melodic house"]],
  ["deep house", ["deep house", "deep melodic house", "organic house"]],
  ["tech house", ["tech house", "deep tech house", "minimal tech house", "club tech house"]],
  ["house", ["house", "deep house", "melodic house", "organic house"]],
  ["techno", ["techno", "melodic techno", "deep techno"]],
  ["trance", ["trance", "progressive trance", "melodic trance"]],
  ["breaks", ["breaks", "breakbeat", "nu skool breaks", "progressive breaks", "underground breaks", "broken beat"]],
  ["synthwave", ["synthwave", "retrowave", "outrun"]],
  ["new wave", ["new wave", "post punk", "synth pop"]],
  ["disco", ["disco", "nu disco", "italo disco"]],
  ["funk", ["funk", "boogie", "electro funk"]],
  ["soul", ["soul", "modern soul", "r&b"]],
  ["r&b", ["r&b", "soul", "contemporary r&b"]],
  ["jazz", ["jazz", "fusion", "spiritual jazz"]],
  ["rock", ["rock", "indie rock", "alternative rock"]],
  ["metal", ["metal", "progressive metal", "doom metal"]],
  ["dark ambient", ["dark ambient", "drone ambient", "isolationist ambient", "dark drone"]],
  ["ambient", ["ambient", "downtempo", "chillout"]],
  ["electronic", ["electronic", "electronica", "cinematic electronic", "leftfield electronic"]],
  ["hip hop", ["hip hop", "rap", "beats"]],
  ["country", ["country", "americana", "alt country"]],
  ["pop", ["pop", "synth pop", "indie pop"]]
];

const VIBE_ALIASES = [
  ["80s", ["80s", "1980s", "eighties", "new wave", "synth pop", "synthpop", "italo disco", "hi nrg", "boogie", "post disco", "neon", "retro", "analog synth", "gated drums"]],
  ["70s", ["70s", "1970s", "seventies", "disco", "funk", "soul", "psychedelic", "warm tape"]],
  ["90s", ["90s", "1990s", "nineties", "rave", "breakbeat", "trip hop", "acid", "warehouse"]],
  ["2000s", ["2000s", "00s", "noughties", "aughts", "y2k"]],
  ["dark", ["dark", "moody", "noir", "gothic", "shadowy"]],
  ["chill", ["chill", "mellow", "laid back", "relaxed", "late night"]],
  ["driving", ["driving", "road trip", "cruising", "forward motion", "rolling"]],
  ["uplifting", ["uplifting", "euphoric", "bright", "anthemic"]],
  ["hypnotic", ["hypnotic", "driving", "rolling", "trippy", "journey"]],
  ["cinematic", ["cinematic", "atmospheric", "wide", "emotional"]],
  ["funky", ["funky", "groovy", "boogie", "syncopated"]],
  ["organic", ["organic", "earthy", "tribal", "acoustic", "percussive"]],
  ["female vocals", ["female vocals", "female vocal", "vocal house", "vocal-led", "sung vocals"]],
  ["underground", ["underground", "deep cut", "deep cuts", "less obvious", "non-obvious", "obscure"]]
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
  const normalized = new Set(terms.map(normalize));
  const remove = new Set();
  function removeTerms(values = []) {
    for (const value of values) remove.add(normalize(value));
  }

  if (normalized.has("tech house")) removeTerms(["house", "deep house", "melodic house", "organic house"]);
  if (normalized.has("progressive house")) removeTerms(["house"]);
  if (normalized.has("melodic house")) removeTerms(["house"]);
  if (normalized.has("deep house")) removeTerms(["house"]);
  if (normalized.has("melodic techno")) removeTerms(["techno", "deep techno"]);
  if (normalized.has("dark ambient")) removeTerms(["ambient", "downtempo", "chillout"]);
  if (normalized.has("breaks")) removeTerms(["progressive breaks"]);

  return terms.filter((term) => !remove.has(normalize(term)));
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
  const request = cleanText(options.request);
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
  const found = [];
  for (const [key, aliases] of TARGET_GENRE_ALIASES) {
    if (aliases.some((alias) => containsNormalized(explicit, alias)) || containsNormalized(explicit, key)) {
      found.push(key, ...aliases);
    }
  }
  return uniqueTerms(pruneBroadGenreTerms(found), 12);
}

function detectSeedVibes(options = {}, seedArtists = []) {
  const text = `${options.request || ""} ${options.reference || ""} ${options.mood || ""}`;
  const vibes = [];
  for (const [key, aliases] of VIBE_ALIASES) {
    if (aliases.some((alias) => containsNormalized(text, alias)) || containsNormalized(text, key)) {
      vibes.push(key, ...aliases.slice(0, 5));
    }
  }

  for (const artist of seedArtists) {
    const match = SEED_ARTIST_VIBES.find(([knownArtist]) => normalize(knownArtist) === normalize(artist));
    if (match) vibes.push(...match[1]);
  }

  if (/\b(?:198[0-9]|80s|eighties)\b/i.test(text)) {
    vibes.push("80s", "new wave", "synth pop", "analog synth", "retro");
  }

  return uniqueTerms(vibes, 16);
}

function detectEraTerms(options = {}) {
  const text = `${options.request || ""} ${options.years || ""} ${options.mood || ""}`;
  const eras = [];
  for (const match of cleanText(text).matchAll(/\b(?:19\d0s|20\d0s|\d0s|19\d{2}|20\d{2})\b/gi)) {
    eras.push(match[0]);
  }
  if (/\b(?:nineties)\b/i.test(text)) eras.push("90s");
  if (/\b(?:eighties)\b/i.test(text)) eras.push("80s");
  if (/\b(?:seventies)\b/i.test(text)) eras.push("70s");
  if (/\b(?:2000s|00s|noughties|aughts|y2k)\b/i.test(text)) eras.push("2000s");
  return uniqueTerms(eras, 8);
}

function requestedLengthText(options = {}) {
  const text = normalize(`${options.request || ""} ${options.mood || ""}`);
  const minuteMatch = cleanText(`${options.request || ""} ${options.mood || ""}`).match(/\b(?:over|under|at least|around|about)?\s*(\d{1,2})\s*(?:minutes?|mins?|min)\b/i);
  if (minuteMatch) return `${minuteMatch[0].trim()}`;
  if (wantsLongTracks(options)) return "long / extended";
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
    requestedEraDateRange: yearRange?.label || eraTerms.join(", ") || "not specified",
    requestedLength: requestedLengthText(options) || "not specified",
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
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planArtists = uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ], 24);
  const planLabels = uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 24);
  const requestedArtists = uniqueTerms([
    ...extractPromptArtists(options),
    ...extractSeedArtists(options)
  ], 12);
  const seedArtists = uniqueTerms([
    ...requestedArtists,
    ...planArtists.slice(0, 8)
  ], 12);
  const requestedLabels = uniqueTerms([
    ...extractPromptLabels(options),
    ...planLabels
  ], 12);
  const targetGenres = detectTargetGenres(options);
  const vibeTerms = detectSeedVibes(options, seedArtists);
  const explicitTarget = cleanText(options.genres || options.request || "");
  const positiveTargetText = normalize(`${options.genres || ""} ${positiveIntentText(options.request || "")}`);
  const isProgressiveTarget = /\bprogressive house\b|\bmelodic progressive\b|\bdeep progressive\b|\borganic progressive\b/.test(positiveTargetText) ||
    targetGenres.some((term) => /\bprogressive house\b|\bmelodic progressive\b|\bdeep progressive\b|\borganic progressive\b/.test(normalize(term)));
  const isGenreOnlyTarget = Boolean(targetGenres.length && !isProgressiveTarget && !seedArtists.length);
  const isGenreDiscoveryTarget = Boolean(targetGenres.length && !isProgressiveTarget);
  const primaryTarget = targetGenres[0] || cleanText(options.genres) || cleanText(options.request).replace(/\b(?:make|create|find|give me|recommend|playlist|tracks?|songs?|like|similar|based on|seeded)\b/gi, " ").trim();
  const scoringMode = normalizeScoringMode(options);

  const profile = {
    scoringMode,
    seedArtists,
    requestedArtists,
    requestedLabels,
    targetGenres,
    vibeTerms,
    primaryTarget,
    explicitTarget,
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

  return Array.from(new Set(seeds)).slice(0, 8);
}

function buildSearchQueries(options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const planQueries = uniqueTerms(Array.isArray(plan.searchQueries) ? plan.searchQueries : [], 24);
  const planArtists = uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ], 24);
  const planLabels = uniqueTerms(Array.isArray(plan.candidateLabels) ? plan.candidateLabels : [], 24);
  const planTargetTerms = uniqueTerms(Array.isArray(plan.targetGenres) ? plan.targetGenres : [], 16);
  const planVibeTerms = uniqueTerms(Array.isArray(plan.vibeTerms) ? plan.vibeTerms : [], 16);
  const request = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const yearRange = parseYearRange(options);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const isYearCatalogSearch = Boolean(yearRange && profile.targetGenres.length);
  const artists = uniqueTerms([
    ...planArtists,
    ...buildArtistSeeds(options, isYearCatalogSearch ? 34 : 18, tasteProfile, profile)
  ], isYearCatalogSearch ? 42 : 28);
  const genreSeeds = genreDiscoverySeeds(profile);
  const targetTerms = planTargetTerms.length
    ? uniqueTerms([...planTargetTerms, ...(profile.isProgressiveTarget ? PROGRESSIVE_CATALOG_TARGETS : [])], 18)
    : (profile.targetGenres.length
      ? (profile.isProgressiveTarget ? uniqueTerms([...profile.targetGenres, ...PROGRESSIVE_CATALOG_TARGETS], 18) : profile.targetGenres)
      : [profile.primaryTarget].filter(Boolean));
  const vibeTerms = uniqueTerms([...planVibeTerms, ...profile.vibeTerms], 24);
  const artistQueries = [];
  const sceneQueries = [];
  const labelQueries = [];
  const tranceQueries = [];
  const catalogYearQueries = [];

  for (const artist of artists.slice(0, profile.isProgressiveTarget ? (isYearCatalogSearch ? 28 : 14) : 10)) {
    for (const target of targetTerms.slice(0, 4)) {
      for (const year of yearTerms.slice(-2)) artistQueries.push(cleanText(`${artist} ${target} ${year}`));
    }
    for (const vibe of vibeTerms.slice(0, 3)) {
      for (const target of targetTerms.slice(0, 2)) artistQueries.push(cleanText(`${artist} ${target} ${vibe}`));
    }
  }

  if (isYearCatalogSearch) {
    for (const year of yearTerms.slice(-3)) {
      for (const target of targetTerms.slice(0, profile.isProgressiveTarget ? 10 : 5)) {
        catalogYearQueries.push(cleanText(`${target} ${year}`));
        catalogYearQueries.push(cleanText(`${target} new releases ${year}`));
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

  if (request.includes("trance")) {
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
  return Array.from(new Set([
    ...planQueries.slice(0, isYearCatalogSearch ? 18 : 12),
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
  const planArtists = uniqueTerms([
    ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
    ...(Array.isArray(plan.candidateArtists) ? plan.candidateArtists : [])
  ], limit);
  const seedArtists = profile.seedArtists || extractSeedArtists(options);
  const seedKeys = new Set(seedArtists.map(normalize));
  const useLearnedArtists = profile.scoringMode === "similar" ||
    (profile.scoringMode === "taste-guided" && (!profile.targetGenres.length || profile.isProgressiveTarget));
  const learnedLimit = profile.scoringMode === "similar" ? 12 : 5;
  const learnedArtists = useLearnedArtists && typeof tasteProfile?.getTopArtists === "function"
    ? tasteProfile.getTopArtists(learnedLimit)
    : [];
  const sceneArtists = profile.isProgressiveTarget && wantsProgressiveHouseOnly(options)
    ? PROGRESSIVE_ARTISTS.filter((artist) => !isTranceForwardArtist(artist))
    : (profile.isProgressiveTarget ? PROGRESSIVE_ARTISTS : []);
  const rotatedSceneArtists = shuffled(uniqueValues(sceneArtists).filter((artist) => !seedKeys.has(normalize(artist))));
  return uniqueValues([...planArtists, ...seedArtists, ...learnedArtists, ...rotatedSceneArtists]).slice(0, limit);
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

function hasAnyTerm(text, terms = []) {
  return terms.some((term) => containsNormalized(text, term));
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
  const hasTargetGenreInTitle = catalogGenreTerms.length
    ? hasAnyTerm(titleAlbum, catalogGenreTerms)
    : /\b(?:tech house|deep house|melodic house|melodic techno|progressive house|progressive trance|trance|techno|ambient|breaks|breakbeat)\b/i.test(titleAlbum);
  const embeddedMarketingYear = /\b(?:19\d{2}|20\d{2})\b/.test(titleAlbum);
  const longKeywordTitle = rawTitle.length >= 64 || rawAlbum.length >= 76;
  const listOrVolume = /\b(?:vol(?:ume)?\.?\s*\d+|top\s*\d+|chart hits?|best\s+(?:of\s+)?|playlist|collection|compilation|dj mix|mix\s*\d+\s*hr|3hr|masters|anthems|essentials?|hits?|selection|selected works|various artists)\b/i.test(raw);
  const lifestyleKeywords = /\b(?:summer nights?|beach vibes?|beach|waves?|grooves?|cocktails?|workout|fitness|party|lounge|rooftop|sessions?|smooth|chill|background music|music for|motivation|focus|study|relaxing|spa|bar|restaurant)\b/i.test(raw);
  const marketingPhrase = /\b(?:this sound|night club energy|havana nights?|desert eyes?|midnight flow|endless city horizon|pulls you in|deep journey|club energy)\b/i.test(raw);
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
  if (hasTargetGenreInTitle && /\b(?:rework|genre remix|style remix)\b/i.test(rawTitle)) return "Title uses genre/remix keywords like catalogue filler.";
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

function isLikelySceneCandidate(track = {}, query = "", options = {}, profile = buildDiscoveryProfile(options)) {
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const text = normalize(`${metadataText} ${query}`);
  const wanted = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const artistMatch = Boolean(matchingSceneArtist(track.artist));

  if (profile.isProgressiveTarget && wantsProgressiveHouseOnly(options)) {
    if (isTranceForwardArtist(track.artist)) return false;
    if (/\b(?:progressive trance|uplifting|psytrance|goa|vocal trance)\b/.test(text)) return false;
  }

  if (profile.isProgressiveTarget && artistMatch) return true;
  if (profile.isProgressiveTarget && wanted.includes("progressive")) {
    return /\b(?:progressive|melodic|deep|organic|anjuna|anjunadeep|sudbeat|lost found|meanwhile|balance|bedrock|songspire|this never happened)\b/.test(text);
  }

  if (profile.targetGenres.length) {
    const seedMetadataMatch = uniqueValues([...genreDiscoverySeeds(profile), ...genreArtistAnchors(profile)]).some((seed) => (
      containsEntityTerm(labelText(track), seed) ||
      splitArtists(track.artist).some((artist) => normalize(artist) === normalize(seed))
    ));
    if (requestedLabelMatch(track, profile)) return true;
    if (seedMetadataMatch || hasSeedArtistMatch(track, options, profile)) return true;
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

function rejectReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  const yearRange = parseYearRange(options);
  const targetArtist = queryTargetArtist(track.query);
  if (targetArtist) {
    const target = normalize(targetArtist);
    const matchedTarget = normalize(track.artist).includes(target) || normalize(`${track.title} ${track.album}`).includes(target);
    if (!matchedTarget) return `Search was for ${targetArtist}, but TIDAL returned ${track.artist}.`;
  }
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
  if (!isLikelySceneCandidate(track, track.query, options, profile)) return "Outside the requested genre/vibe lane.";
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

function scoreBreakdownFor(track = {}, options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  const yearRange = parseYearRange(options);
  const wanted = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const metadataText = normalize(`${track.artist} ${track.title} ${track.album} ${labelText(track)}`);
  const queryText = normalize(track.query);
  const text = normalize(`${metadataText} ${queryText}`);
  const sceneArtist = profile.isProgressiveTarget ? matchingSceneArtist(track.artist) : "";
  const sceneLabel = profile.isProgressiveTarget ? matchingSceneLabel(labelText(track)) : "";
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
    const seedLabel = genreDiscoverySeeds(profile).find((seed) => containsEntityTerm(labelText(track), seed));
    labelMatch = Math.max(labelMatch, seedLabel ? 16 : 6);
  }
  labelMatch = clamp(labelMatch, 0, SCORE_MAX.labelMatch);

  let artistMatch = 0;
  if (hasSeedArtistMatch(track, options, profile)) artistMatch = SCORE_MAX.artistMatch;
  else if (sceneArtist) artistMatch = 15;
  else if (wanted && splitArtists(track.artist).some((artist) => wanted.includes(normalize(artist)))) artistMatch = 11;
  if (profile.isGenreDiscoveryTarget && track.artist) {
    const seedArtist = uniqueValues([...genreDiscoverySeeds(profile), ...genreArtistAnchors(profile)])
      .find((seed) => splitArtists(track.artist).some((artist) => normalize(artist) === normalize(seed)));
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
  genreMatch = clamp(genreMatch, 0, SCORE_MAX.genreMatch);

  const taste = typeof tasteProfile?.adjustmentFor === "function"
    ? tasteProfile.adjustmentFor(track)
    : { value: 0, reasons: [] };
  let tasteMin = profile.isGenreDiscoveryTarget ? -4 : -12;
  let tasteMax = profile.isGenreDiscoveryTarget ? 6 : 12;
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

  if (isShortEdit(track)) {
    lengthPreference = Math.min(lengthPreference, 4);
    tasteAdjustment -= 6;
  }
  if (isReissueLike(track)) freshness = Math.min(freshness, 4);
  if (/\b(?:radio|festival|big room|edm|pop dance)\b/.test(text)) genreMatch = Math.max(0, genreMatch - 10);

  tasteAdjustment = clamp(tasteAdjustment, tasteMin, tasteMax);
  const categoryTotal = freshness + labelMatch + artistMatch + lengthPreference + genreMatch;
  const total = clamp(categoryTotal + tasteAdjustment, 1, 100);
  const baseBreakdown = {
    total,
    freshness,
    labelMatch,
    artistMatch,
    lengthPreference,
    genreMatch,
    tasteAdjustment,
    tasteReasons: taste.reasons || [],
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

function scoreTrack(track = {}, options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  return scoreBreakdownFor(track, options, tasteProfile, profile).total;
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
  if (!sceneArtist && hasAnyTerm(`${metadataText} ${track.query}`, profile.targetGenres)) parts.push(`${profile.targetGenres[0]} target fit`);
  if (track.discoveryLane === "adjacent") parts.push("adjacent-lane discovery");
  if (track.discoveryLane === "recent") parts.push("recent-year fallback");
  if (hasAnyTerm(`${metadataText} ${track.query}`, profile.vibeTerms)) parts.push(`${profile.vibeTerms[0]} seed-vibe fit`);
  if (minutes) parts.push(`${minutes.toFixed(1)} min`);
  if (score.tasteAdjustment > 0) parts.push("boosted by your thumbs-up history");
  if (score.tasteAdjustment < 0) parts.push("penalized by your thumbs-down history");
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

function discoveryStatusFor(track = {}, historyEntry = null, recent = false) {
  const statuses = [];
  statuses.push(track.tidalUrl || track.tidal?.tidalUrl ? "TIDAL verified" : "TIDAL verified by catalogue result");
  statuses.push(historyEntry
    ? `Previously suggested${historyEntry.shownCount ? ` ${historyEntry.shownCount}x` : ""}${recent ? " recently" : ""}`
    : "Not previously suggested");
  statuses.push("Roon library not checked");
  statuses.push("TIDAL playlist membership not connected");
  statuses.push("Scrobble history not connected");
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

  if (sceneArtist) bullets.push("Similar progressive/melodic lane");
  else if (profile.targetGenres.length && hasAnyTerm(text, profile.targetGenres)) bullets.push(`${profile.targetGenres[0]} target genre signal`);
  if (profile.vibeTerms.length && hasAnyTerm(text, profile.vibeTerms)) bullets.push(`${profile.vibeTerms[0]} seed-vibe signal`);

  if (wantsLongTracks(options) && minutes >= 7) bullets.push("7+ minute track length preference");
  else if (minutes) bullets.push(`${minutes.toFixed(1)} minute playable length`);

  const releaseValue = releaseValueForDisplay(track);
  if (releaseValue) bullets.push(`${releaseValue} release`);
  if (breakdown.tasteAdjustment > 0) bullets.push("Boosted by your likes");
  if (breakdown.tasteAdjustment < 0) bullets.push("Penalized by your dislikes");
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

async function discoverTracks({ tidal, options = {}, history, tasteProfile = null } = {}) {
  if (!tidal?.isConfigured?.()) {
    throw new Error("TIDAL is not configured. Add TIDAL_CLIENT_ID/TIDAL_CLIENT_SECRET or TIDAL_ACCESS_TOKEN to .env.");
  }

  const profile = buildDiscoveryProfile(options);
  const originalRequestedCount = Number(options.originalRequestedCount || 0) || parseRequestedCount({ ...options, effectiveCount: 0 });
  const requestedCount = effectiveDiscoveryCount(options, profile);
  const strictRoonMode = /^(1|true|yes)$/i.test(String(options.requireRoonQueueable || ""));
  const yearRange = parseYearRange(options);
  const isYearCatalogSearch = Boolean(yearRange && profile.targetGenres.length);
  const candidatePoolTarget = strictRoonMode
    ? (isYearCatalogSearch
      ? Math.min(160, Math.max(Math.ceil(requestedCount * 7), requestedCount + 54))
      : Math.min(650, Math.max(Math.ceil(requestedCount * 18), requestedCount + 260)))
    : (isYearCatalogSearch
      ? Math.min(140, Math.max(Math.ceil(requestedCount * 7), requestedCount + 48))
      : Math.min(140, Math.max(Math.ceil(requestedCount * 4), requestedCount + 35)));
  const usefulCandidateTarget = isYearCatalogSearch
    ? Math.min(candidatePoolTarget, Math.max(Math.ceil(requestedCount * (strictRoonMode ? 4 : 3)), requestedCount + (strictRoonMode ? 28 : 18)))
    : candidatePoolTarget;
  const minScore = minimumScoreFor(options);
  const minScoreLabel = minimumScoreLabel(minScore);
  const queries = buildSearchQueries(options, tasteProfile, profile);
  const discarded = [];
  const scoreFiltered = [];
  const previousCandidates = [];
  const byKey = new Map();
  const seenCandidateKeys = new Set();
  const allowPreviousSuggestions = allowsPreviouslySuggested(options);
  const allowPreviousFallback = allowsPreviousDiscoveryFallback(options);

  function consider(result, scoringOptions = options, scoringProfile = profile) {
    const keys = candidateIdentityKeys(result);
    const key = keys[0];
    if (!key || keys.some((candidateKey) => seenCandidateKeys.has(candidateKey))) return;
    const historyEntry = typeof history?.entryFor === "function" ? history.entryFor(result) : null;
    const reason = rejectReason(result, scoringOptions, scoringProfile);
    if (reason) {
      discarded.push({ ...result, reason });
      return;
    }

    const scoreBreakdown = scoreBreakdownFor(result, scoringOptions, tasteProfile, scoringProfile);
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
      statusChecks: discoveryStatusFor(result, historyEntry, false),
      verificationSource: "tidal"
    };
    candidate.feedback = typeof tasteProfile?.getFeedbackFor === "function" ? tasteProfile.getFeedbackFor(candidate) : "";
    for (const candidateKey of keys) seenCandidateKeys.add(candidateKey);

    if (minScore && candidate.score < minScore) {
      const filtered = {
        ...result,
        score: candidate.score,
        scoreBreakdown,
        reason: `Discovery score ${candidate.score} is below minimum ${minScoreLabel}.`
      };
      scoreFiltered.push(filtered);
      discarded.push(filtered);
      return;
    }

    if (!allowPreviousSuggestions && historyEntry) {
      const previousCandidate = {
        ...candidate,
        reason: `${candidate.reason}; previously suggested`,
        why: whyBulletsFor(result, scoringOptions, scoreBreakdown, historyEntry, scoringProfile),
        statusChecks: discoveryStatusFor(result, historyEntry, history?.isRecent?.(candidate))
      };
      previousCandidates.push(previousCandidate);
      discarded.push({ ...result, reason: "Previously suggested; held back for discovery variety." });
      return;
    }

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
        });
      } catch (error) {
        discarded.push({ ...candidate, reason: error.message });
      }
    });
  }

  const artistSeedLimit = isYearCatalogSearch
    ? (strictRoonMode
      ? Math.min(42, Math.max(30, requestedCount + 24))
      : Math.min(26, Math.max(18, requestedCount + 12)))
    : (strictRoonMode ? Math.max(12, Math.min(24, requestedCount + 8)) : Math.max(10, Math.min(18, requestedCount + 6)));
  const artistSeeds = buildArtistSeeds(options, artistSeedLimit, tasteProfile, profile);
  const wantsDeepArtistCrawl = /\b(?:deep catalog|catalog crawl|discography|albums?|artist deep dive|accuracy|accurate|scrape)\b/i.test(`${options.request || ""} ${options.reference || ""}`);
  const useAlbumExpansion = isYearCatalogSearch
    ? Boolean(profile.isProgressiveTarget || profile.seedArtists.length || wantsDeepArtistCrawl)
    : (strictRoonMode || requestedCount <= 16 || wantsDeepArtistCrawl);

  if (useAlbumExpansion) {
    const artistExpansionLimit = isYearCatalogSearch
      ? (strictRoonMode ? Math.min(36, Math.max(26, requestedCount + 16)) : Math.min(20, Math.max(12, requestedCount + 6)))
      : (strictRoonMode ? (requestedCount >= 20 ? 14 : 10) : (requestedCount >= 20 ? 8 : 6));
    const artistsToExpand = artistSeeds.slice(0, artistExpansionLimit);
    await mapWithConcurrency(artistsToExpand, isYearCatalogSearch ? 3 : 2, async (artist) => {
      if (byKey.size >= usefulCandidateTarget) return;
      let albums = [];
      try {
        albums = await tidal.getArtistAlbums(artist, {
          limit: isYearCatalogSearch
            ? (strictRoonMode ? 8 : 5)
            : (strictRoonMode ? (yearRange ? 12 : 6) : (yearRange ? 6 : 3))
        });
      } catch (error) {
        discarded.push({ query: artist, reason: error.message });
        return;
      }

      let artistAccepted = 0;
      const perArtistLimit = isYearCatalogSearch
        ? (strictRoonMode ? 3 : 2)
        : (strictRoonMode ? (requestedCount >= 20 ? 5 : 3) : (requestedCount >= 20 ? 3 : 2));
      for (const album of albums) {
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
            limit: isYearCatalogSearch ? (strictRoonMode ? 5 : 3) : (strictRoonMode ? 7 : (yearRange ? 4 : 3))
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
          });
          if (byKey.size > before) artistAccepted += 1;
          if (artistAccepted >= perArtistLimit || byKey.size >= usefulCandidateTarget) break;
        }
      }
    });
  }

  const searchQueries = isYearCatalogSearch
    ? queries.slice(0, strictRoonMode ? 28 : 24)
    : queries;
  if (byKey.size < usefulCandidateTarget) await mapWithConcurrency(searchQueries, 1, async (query) => {
    if (byKey.size >= usefulCandidateTarget) return;
    let results = [];
    try {
      results = await tidal.searchTracks(query, {
        limit: strictRoonMode ? (isYearCatalogSearch ? 16 : 16) : (isYearCatalogSearch ? 12 : 6),
        detailLimit: yearRange?.dateSpecific
          ? (strictRoonMode ? 12 : 8)
          : (yearRange ? (isYearCatalogSearch ? (strictRoonMode ? 5 : 4) : (strictRoonMode ? 5 : 3)) : (strictRoonMode ? 3 : 1))
      });
    } catch (error) {
      discarded.push({ query, reason: error.message });
      return;
    }

    for (const result of results) {
      consider({ ...result, discoverySource: discoverySourceForResult(result, options) });
      if (byKey.size >= usefulCandidateTarget) break;
    }
  });

  const adjacentCandidateFloor = Math.min(
    usefulCandidateTarget,
    Math.max(requestedCount + 8, Math.ceil(usefulCandidateTarget * 0.55))
  );
  if (profile.isGenreDiscoveryTarget && byKey.size < adjacentCandidateFloor) {
    const usedQueries = new Set(searchQueries.map(normalize));
    const adjacentQueries = buildAdjacentSearchQueries(options, tasteProfile, profile)
      .filter((query) => !usedQueries.has(normalize(query)))
      .slice(0, isYearCatalogSearch ? (strictRoonMode ? 28 : 22) : 16);

    await mapWithConcurrency(adjacentQueries, 1, async (query) => {
      if (byKey.size >= usefulCandidateTarget) return;
      let results = [];
      try {
        results = await tidal.searchTracks(query, {
          limit: strictRoonMode ? (isYearCatalogSearch ? 16 : 14) : (isYearCatalogSearch ? 12 : 8),
          detailLimit: yearRange?.dateSpecific
            ? (strictRoonMode ? 12 : 8)
            : (yearRange ? (isYearCatalogSearch ? (strictRoonMode ? 5 : 4) : 3) : 2)
        });
      } catch (error) {
        discarded.push({ query, reason: error.message });
        return;
      }

      for (const result of results) {
        consider({
          ...result,
          discoverySource: "Adjacent lane search",
          discoveryLane: "adjacent"
        });
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

    await mapWithConcurrency(relaxedQueries, 1, async (query) => {
      if (byKey.size >= usefulCandidateTarget) return;
      let results = [];
      try {
        results = await tidal.searchTracks(query, {
          limit: strictRoonMode ? 14 : 10,
          detailLimit: strictRoonMode ? 5 : 4
        });
      } catch (error) {
        discarded.push({ query, reason: error.message });
        return;
      }

      for (const result of results) {
        consider({
          ...result,
          discoverySource: "Recent-year fallback search",
          discoveryLane: "recent"
        }, relaxedYearOptions, relaxedProfile);
        if (byKey.size >= usefulCandidateTarget) break;
      }
    });
  }

  const candidates = Array.from(byKey.values())
    .sort((left, right) => right.score - left.score || (right.durationMs || 0) - (left.durationMs || 0));
  const artistCounts = new Map();
  const albumCounts = new Map();
  const tracks = [];
  const maxPerPrimaryArtist = requestedCount <= 12 ? 1 : 2;

  for (const candidate of candidates) {
    const artistKey = primaryArtistKey(candidate);
    const albumKey = normalize(candidate.album);
    const count = artistCounts.get(artistKey) || 0;
    const albumCount = albumCounts.get(albumKey) || 0;
    if (count >= maxPerPrimaryArtist || (albumKey && albumCount >= 1)) continue;
    tracks.push(candidate);
    artistCounts.set(artistKey, count + 1);
    if (albumKey) albumCounts.set(albumKey, albumCount + 1);
    if (tracks.length >= requestedCount) break;
  }

  for (const candidate of candidates) {
    if (tracks.length >= requestedCount) break;
    if (tracks.includes(candidate)) continue;
    tracks.push(candidate);
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

        const scoreBreakdown = scoreBreakdownFor(result, options, tasteProfile, profile);
        if (minScore && scoreBreakdown.total < minScore) {
          const filtered = {
            ...result,
            score: scoreBreakdown.total,
            scoreBreakdown,
            reason: `Discovery score ${scoreBreakdown.total} is below minimum ${minScoreLabel}.`
          };
          scoreFiltered.push(filtered);
          discarded.push(filtered);
          continue;
        }

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
          statusChecks: discoveryStatusFor(result, entry, true),
          verificationSource: "tidal"
        };
        candidate.feedback = typeof tasteProfile?.getFeedbackFor === "function" ? tasteProfile.getFeedbackFor(candidate) : "";
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
  const alternates = candidates
    .filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key)))
    .concat(fallbackAlternates.filter((candidate) => !candidateIdentityKeys(candidate).some((key) => selectedKeys.has(key))))
    .slice(0, Math.max(160, requestedCount * 14));

  return {
    requestedCount,
    tracks,
    alternates,
    discarded,
    verification: {
      enabled: true,
      tidal: true,
      requested: requestedCount,
      originalRequested: originalRequestedCount,
      countExpanded: requestedCount !== originalRequestedCount,
      generated: tracks.length + discarded.length,
      kept: tracks.length,
      discarded: discarded.length,
      minScore,
      minScoreLabel,
      scoreFiltered: scoreFiltered.length,
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
      taste: typeof tasteProfile?.summary === "function" ? tasteProfile.summary() : null
    }
  };
}

module.exports = {
  discoverTracks,
  candidateIdentityKeys,
  discoveryStatusFor,
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
  normalizeScoringMode
};
