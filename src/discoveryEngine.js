"use strict";

const { parseYearRange, yearFits } = require("./yearRange");

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

function candidateIdentityKeys(track = {}) {
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl).toLowerCase();
  const titleArtist = `${normalize(track.artist)}|${normalize(track.title)}`;
  return [tidalUrl, titleArtist].filter((key) => key && key !== "|");
}

function parseRequestedCount(options = {}) {
  const explicit = Number(options.count || 0);
  if (explicit > 0) return Math.min(40, Math.max(1, explicit));

  const request = cleanText(options.request);
  const match = request.match(/\b(\d{1,2})\s*(?:track|song|cut|candidate|recommendation)s?\b/i);
  return match ? Math.min(40, Math.max(1, Number(match[1]))) : 8;
}

function hasCanonicalYear(track = {}) {
  const evidence = track.releaseEvidence || {};
  return Boolean(track.year && (evidence.albumYear || evidence.trackYear || evidence.isrcYear));
}

function embeddedYears(value) {
  return Array.from(cleanText(value).matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => Number(match[1]));
}

function hasOutOfRangeEmbeddedYear(track, range) {
  if (!range) return false;
  return embeddedYears(`${track.title} ${track.album}`).some((year) => year < range.min || year > range.max);
}

function isReissueLike(track = {}) {
  const text = normalize(`${track.title} ${track.album}`);
  return /\b(?:remaster(?:ed)?|re master(?:ed)?|reissue|anniversary|deluxe|expanded|restored|archive|classic|retouch|alternative version|alt mix|best of|years of|mixed by)\b/.test(text);
}

function isShortEdit(track = {}) {
  const text = normalize(`${track.title} ${track.album}`);
  return /\b(?:radio edit|short edit|single edit|edit)\b/.test(text);
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
  ["progressive house", ["progressive house", "melodic progressive house", "deep progressive house", "organic progressive house", "progressive electronic"]],
  ["progressive trance", ["progressive trance", "deep progressive trance", "melodic progressive trance"]],
  ["progressive", ["progressive house", "melodic progressive", "deep progressive", "progressive trance"]],
  ["melodic house", ["melodic house", "deep melodic house", "organic melodic house"]],
  ["deep house", ["deep house", "deep melodic house", "organic house"]],
  ["house", ["house", "deep house", "melodic house", "organic house"]],
  ["techno", ["techno", "melodic techno", "deep techno"]],
  ["trance", ["trance", "progressive trance", "melodic trance"]],
  ["synthwave", ["synthwave", "retrowave", "outrun"]],
  ["new wave", ["new wave", "post punk", "synth pop"]],
  ["disco", ["disco", "nu disco", "italo disco"]],
  ["funk", ["funk", "boogie", "electro funk"]],
  ["soul", ["soul", "modern soul", "r&b"]],
  ["r&b", ["r&b", "soul", "contemporary r&b"]],
  ["jazz", ["jazz", "fusion", "spiritual jazz"]],
  ["rock", ["rock", "indie rock", "alternative rock"]],
  ["metal", ["metal", "progressive metal", "doom metal"]],
  ["ambient", ["ambient", "downtempo", "chillout"]],
  ["hip hop", ["hip hop", "rap", "beats"]],
  ["country", ["country", "americana", "alt country"]],
  ["pop", ["pop", "synth pop", "indie pop"]]
];

const VIBE_ALIASES = [
  ["80s", ["80s", "1980s", "eighties", "new wave", "synth pop", "synthpop", "italo disco", "hi nrg", "boogie", "post disco", "neon", "retro", "analog synth", "gated drums"]],
  ["70s", ["70s", "1970s", "seventies", "disco", "funk", "soul", "psychedelic", "warm tape"]],
  ["90s", ["90s", "1990s", "nineties", "rave", "breakbeat", "trip hop", "acid", "warehouse"]],
  ["dark", ["dark", "moody", "noir", "gothic", "shadowy"]],
  ["uplifting", ["uplifting", "euphoric", "bright", "anthemic"]],
  ["hypnotic", ["hypnotic", "driving", "rolling", "trippy", "journey"]],
  ["cinematic", ["cinematic", "atmospheric", "wide", "emotional"]],
  ["funky", ["funky", "groovy", "boogie", "syncopated"]],
  ["organic", ["organic", "earthy", "tribal", "acoustic", "percussive"]]
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

function splitArtists(value) {
  return cleanText(value)
    .split(/\s*(?:,|;|\/|&|\+|\band\b|-)\s*/i)
    .map(cleanText)
    .filter((part) => part && part.length <= 40);
}

function containsNormalized(text, term) {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  if (!normalizedText || !normalizedTerm) return false;
  return normalizedText === normalizedTerm || normalizedText.includes(normalizedTerm);
}

function uniqueTerms(values, limit = 20) {
  return uniqueValues(values.map(cleanText).filter(Boolean)).slice(0, limit);
}

function detectTargetGenres(options = {}) {
  const explicit = `${options.genres || ""} ${options.request || ""}`;
  const found = [];
  for (const [key, aliases] of TARGET_GENRE_ALIASES) {
    if (aliases.some((alias) => containsNormalized(explicit, alias)) || containsNormalized(explicit, key)) {
      found.push(key, ...aliases);
    }
  }
  return uniqueTerms(found, 12);
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

function buildDiscoveryProfile(options = {}) {
  const seedArtists = extractSeedArtists(options);
  const targetGenres = detectTargetGenres(options);
  const vibeTerms = detectSeedVibes(options, seedArtists);
  const explicitTarget = cleanText(options.genres || options.request || "");
  const isProgressiveTarget = targetGenres.some((term) => normalize(term).includes("progressive"));
  const primaryTarget = targetGenres[0] || cleanText(options.genres) || cleanText(options.request).replace(/\b(?:make|create|find|give me|recommend|playlist|tracks?|songs?|like|similar|based on|seeded)\b/gi, " ").trim();

  return {
    seedArtists,
    targetGenres,
    vibeTerms,
    primaryTarget,
    explicitTarget,
    isProgressiveTarget,
    hasSeedVibe: Boolean(seedArtists.length || vibeTerms.length)
  };
}

function labelText(track = {}) {
  return cleanText(track.label || track.tidal?.label || "");
}

function matchingSceneLabel(value) {
  const label = normalize(value);
  if (!label) return "";
  return PROGRESSIVE_LABELS.find((knownLabel) => {
    const known = normalize(knownLabel);
    return label === known || label.includes(known) || known.includes(label);
  }) || "";
}

function isTranceForwardArtist(value) {
  const artistKeys = splitArtists(value).map(normalize);
  return TRANCE_FORWARD_ARTISTS.some((artist) => artistKeys.includes(normalize(artist)));
}

function wantsProgressiveHouseOnly(options = {}) {
  const wanted = normalize(`${options.request} ${options.genres}`);
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
  for (const value of [
    options.nowPlaying?.artist,
    options.artist,
    options.seedArtist
  ]) {
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
  const request = normalize(`${options.request} ${options.genres} ${options.mood}`);
  const yearRange = parseYearRange(options.years);
  const yearTerms = yearRange
    ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, index) => String(yearRange.min + index))
    : [""];
  const isYearCatalogSearch = Boolean(yearRange && profile.targetGenres.length);
  const artists = buildArtistSeeds(options, isYearCatalogSearch ? 34 : 18, tasteProfile, profile);
  const targetTerms = profile.targetGenres.length
    ? (profile.isProgressiveTarget ? uniqueTerms([...profile.targetGenres, ...PROGRESSIVE_CATALOG_TARGETS], 18) : profile.targetGenres)
    : [profile.primaryTarget].filter(Boolean);
  const vibeTerms = profile.vibeTerms;
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
    for (const year of yearTerms.slice(-2)) sceneQueries.push(cleanText(`${target} ${year}`));
    for (const vibe of vibeTerms.slice(0, 6)) {
      sceneQueries.push(cleanText(`${vibe} ${target}`));
      sceneQueries.push(cleanText(`${target} ${vibe}`));
    }
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
    ...catalogYearQueries.slice(0, profile.isProgressiveTarget ? 36 : 16),
    ...artistQueries.slice(0, profile.isProgressiveTarget ? (isYearCatalogSearch ? 24 : 12) : 10),
    ...sceneQueries.slice(0, isYearCatalogSearch ? 22 : 14),
    ...labelQueries.slice(0, profile.isProgressiveTarget ? (isYearCatalogSearch ? 28 : 12) : 0),
    ...tranceQueries.slice(0, 5),
    ...artistQueries.slice(24, isYearCatalogSearch ? 42 : 18)
  ].map(cleanText).filter(Boolean))).slice(0, queryLimit);
}

function buildArtistSeeds(options = {}, limit = 12, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  const seedArtists = profile.seedArtists || extractSeedArtists(options);
  const seedKeys = new Set(seedArtists.map(normalize));
  const learnedArtists = profile.isProgressiveTarget && typeof tasteProfile?.getTopArtists === "function" ? tasteProfile.getTopArtists(8) : [];
  const sceneArtists = profile.isProgressiveTarget && wantsProgressiveHouseOnly(options)
    ? PROGRESSIVE_ARTISTS.filter((artist) => !isTranceForwardArtist(artist))
    : (profile.isProgressiveTarget ? PROGRESSIVE_ARTISTS : []);
  const rotatedSceneArtists = shuffled(uniqueValues(sceneArtists).filter((artist) => !seedKeys.has(normalize(artist))));
  return uniqueValues([...seedArtists, ...learnedArtists, ...rotatedSceneArtists]).slice(0, limit);
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
    if (hasAnyTerm(metadataText, profile.targetGenres)) return true;
    if (hasAnyTerm(query, profile.targetGenres) && (hasAnyTerm(metadataText, profile.vibeTerms) || hasSeedArtistMatch(track, options))) return true;
  }

  return true;
}

function rejectReason(track = {}, options = {}, profile = buildDiscoveryProfile(options)) {
  const yearRange = parseYearRange(options.years);
  const targetArtist = queryTargetArtist(track.query);
  if (targetArtist) {
    const target = normalize(targetArtist);
    const matchedTarget = normalize(track.artist).includes(target) || normalize(`${track.title} ${track.album}`).includes(target);
    if (!matchedTarget) return `Search was for ${targetArtist}, but TIDAL returned ${track.artist}.`;
  }
  if (yearRange && !track.year) return `No TIDAL release year for ${yearRange.label}.`;
  if (yearRange && !hasCanonicalYear(track)) return `No canonical TIDAL album/track/ISRC release year for ${yearRange.label}.`;
  if (yearRange && !yearFits(track.year, yearRange)) return `TIDAL release year ${track.year} is outside ${yearRange.label}.`;
  if (yearRange && isReissueLike(track)) return `Looks like a reissue/remaster instead of a fresh ${yearRange.label} release.`;
  if (yearRange && hasOutOfRangeEmbeddedYear(track, yearRange)) return `Title or album references an older year outside ${yearRange.label}.`;
  if (isShortEdit(track)) return "Short/radio edit.";
  if (!isLikelySceneCandidate(track, track.query, options, profile)) return "Outside the requested genre/vibe lane.";
  return "";
}

function hasSeedArtistMatch(track = {}, options = {}) {
  const seedKeys = new Set(extractSeedArtists(options).map(normalize));
  if (!seedKeys.size) return false;
  return splitArtists(track.artist).some((artist) => seedKeys.has(normalize(artist)));
}

function scoreBreakdownFor(track = {}, options = {}, tasteProfile = null, profile = buildDiscoveryProfile(options)) {
  const yearRange = parseYearRange(options.years);
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
    freshness = track.year && yearFits(track.year, yearRange) && hasCanonicalYear(track) ? SCORE_MAX.freshness : 0;
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
  if (sceneLabel) labelMatch = 17;
  else if (labelText(track)) labelMatch = 7;
  if (sceneLabel && wanted.includes(normalize(sceneLabel))) labelMatch += 2;
  labelMatch = clamp(labelMatch, 0, SCORE_MAX.labelMatch);

  let artistMatch = 0;
  if (hasSeedArtistMatch(track, options)) artistMatch = SCORE_MAX.artistMatch;
  else if (sceneArtist) artistMatch = 15;
  else if (wanted && splitArtists(track.artist).some((artist) => wanted.includes(normalize(artist)))) artistMatch = 11;
  artistMatch = clamp(artistMatch, 0, SCORE_MAX.artistMatch);

  let lengthPreference = 0;
  if (wantsLongTracks(options)) {
    if (minutes >= 8) lengthPreference = SCORE_MAX.lengthPreference;
    else if (minutes >= 7) lengthPreference = 16;
    else if (minutes >= 6) lengthPreference = 11;
    else if (minutes >= 4) lengthPreference = 7;
    else lengthPreference = 3;
  } else if (minutes) {
    if (minutes >= 5 && minutes <= 12) lengthPreference = SCORE_MAX.lengthPreference;
    else if (minutes >= 4) lengthPreference = 15;
    else if (minutes >= 3) lengthPreference = 10;
    else lengthPreference = 5;
  } else {
    lengthPreference = 7;
  }

  let genreMatch = 0;
  if (profile.targetGenres.length) {
    if (hasAnyTerm(metadataText, profile.targetGenres)) genreMatch += 11;
    else if (hasAnyTerm(queryText, profile.targetGenres)) genreMatch += 7;
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
  genreMatch = clamp(genreMatch, 0, SCORE_MAX.genreMatch);

  const taste = typeof tasteProfile?.adjustmentFor === "function"
    ? tasteProfile.adjustmentFor(track)
    : { value: 0, reasons: [] };
  let tasteAdjustment = clamp(taste.value || 0, -12, 12);

  if (isShortEdit(track)) {
    lengthPreference = Math.min(lengthPreference, 4);
    tasteAdjustment -= 6;
  }
  if (isReissueLike(track)) freshness = Math.min(freshness, 4);
  if (/\b(?:radio|festival|big room|edm|pop dance)\b/.test(text)) genreMatch = Math.max(0, genreMatch - 10);

  tasteAdjustment = clamp(tasteAdjustment, -12, 12);
  const categoryTotal = freshness + labelMatch + artistMatch + lengthPreference + genreMatch;
  const total = clamp(categoryTotal + tasteAdjustment, 1, 100);

  return {
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
  if (track.year) parts.push(`${track.year} TIDAL release`);
  if (sceneLabel) parts.push(`${sceneLabel} label fit`);
  if (sceneArtist) parts.push(`${sceneArtist} sits in the requested progressive lane`);
  if (!sceneArtist && hasAnyTerm(`${metadataText} ${track.query}`, profile.targetGenres)) parts.push(`${profile.targetGenres[0]} target fit`);
  if (hasAnyTerm(`${metadataText} ${track.query}`, profile.vibeTerms)) parts.push(`${profile.vibeTerms[0]} seed-vibe fit`);
  if (minutes) parts.push(`${minutes.toFixed(1)} min`);
  if (score.tasteAdjustment > 0) parts.push("boosted by your thumbs-up history");
  if (score.tasteAdjustment < 0) parts.push("penalized by your thumbs-down history");
  const text = normalize(`${track.title} ${track.album} ${track.query}`);
  if (text.includes("melodic")) parts.push("melodic/progressive signal");
  if (text.includes("deep")) parts.push("deep progressive signal");
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

  if (track.year) bullets.push(`${track.year} release`);
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

  const requestedCount = parseRequestedCount(options);
  const profile = buildDiscoveryProfile(options);
  const strictRoonMode = /^(1|true|yes)$/i.test(String(options.requireRoonQueueable || ""));
  const yearRange = parseYearRange(options.years);
  const isYearCatalogSearch = Boolean(yearRange && profile.targetGenres.length);
  const candidatePoolTarget = strictRoonMode
    ? (isYearCatalogSearch
      ? Math.min(90, Math.max(Math.ceil(requestedCount * 4), requestedCount + 28))
      : Math.min(650, Math.max(Math.ceil(requestedCount * 18), requestedCount + 260)))
    : (isYearCatalogSearch
      ? Math.min(90, Math.max(Math.ceil(requestedCount * 4), requestedCount + 24))
      : Math.min(140, Math.max(Math.ceil(requestedCount * 4), requestedCount + 35)));
  const usefulCandidateTarget = isYearCatalogSearch
    ? Math.min(candidatePoolTarget, Math.max(Math.ceil(requestedCount * (strictRoonMode ? 3 : 2)), requestedCount + (strictRoonMode ? 16 : 8)))
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

  function consider(result) {
    const keys = candidateIdentityKeys(result);
    const key = keys[0];
    if (!key || keys.some((candidateKey) => seenCandidateKeys.has(candidateKey))) return;
    const historyEntry = typeof history?.entryFor === "function" ? history.entryFor(result) : null;
    const reason = rejectReason(result, options, profile);
    if (reason) {
      discarded.push({ ...result, reason });
      return;
    }

    const scoreBreakdown = scoreBreakdownFor(result, options, tasteProfile, profile);
    const candidate = {
      artist: result.artist,
      title: result.title,
      album: result.album,
      label: result.label || "",
      year: result.year || null,
      durationMs: result.durationMs || null,
      reason: reasonFor(result, options, scoreBreakdown, profile),
      why: whyBulletsFor(result, options, scoreBreakdown, historyEntry, profile),
      discoverySource: result.discoverySource || discoverySourceForResult(result, options),
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
        why: whyBulletsFor(result, options, scoreBreakdown, historyEntry, profile),
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
        if (yearRange && (!album.year || !yearFits(album.year, yearRange))) {
          discarded.push({ query: `${artist} ${album.title}`, reason: album.year ? `Album year ${album.year} is outside ${yearRange.label}.` : `No album release year for ${yearRange.label}.` });
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
    ? queries.slice(0, strictRoonMode ? 18 : 12)
    : queries;
  if (byKey.size < usefulCandidateTarget) await mapWithConcurrency(searchQueries, 1, async (query) => {
    if (byKey.size >= usefulCandidateTarget) return;
    let results = [];
    try {
      results = await tidal.searchTracks(query, {
        limit: strictRoonMode ? (isYearCatalogSearch ? 12 : 16) : (isYearCatalogSearch ? 8 : 6),
        detailLimit: yearRange ? (isYearCatalogSearch ? 2 : (strictRoonMode ? 5 : 3)) : (strictRoonMode ? 3 : 1)
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
          durationMs: result.durationMs || null,
          reason: `${reasonFor(result, options, scoreBreakdown, profile)}; previously suggested`,
          why: whyBulletsFor(result, options, scoreBreakdown, entry, profile),
          discoverySource: "Previous discovery fallback",
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
      queries: queries.slice(0, 12),
      candidatePoolTarget,
      usefulCandidateTarget,
      profile: {
        targetGenres: profile.targetGenres,
        vibeTerms: profile.vibeTerms,
        seedArtists: profile.seedArtists.slice(0, 12)
      },
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
  parseRequestedCount,
  parseYearRange,
  reasonFor,
  rejectReason,
  scoreBreakdownFor,
  whyBulletsFor
};
