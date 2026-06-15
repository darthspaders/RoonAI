"use strict";

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

function titleToKey(value) {
  return normalize(value);
}

function uniqueValues(values, limit = 50) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(cleanText).filter(Boolean)) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizedContains(text, term) {
  const source = ` ${normalize(text)} `;
  const needle = normalize(term);
  if (!needle) return false;
  return source.includes(` ${needle} `);
}

function entry(name, family, aliases = []) {
  const canonical = titleToKey(name);
  const familyKey = titleToKey(family || name);
  return {
    canonical,
    family: familyKey,
    aliases: uniqueValues([name, canonical, ...aliases], 20)
  };
}

const GENRE_ENTRIES = [
  ...[
    "House",
    "Deep House",
    "Progressive House",
    "Organic House",
    "Melodic House",
    "Tech House",
    "Minimal House",
    "Afro House",
    "Soulful House",
    "Vocal House",
    "Tribal House",
    "Funky House",
    "Jackin House",
    "Garage House",
    "Electro House",
    "Future House",
    "Bass House",
    "Big Room House",
    "Latin House",
    "Disco House",
    "Piano House",
    "French House",
    "Filter House",
    "Tropical House",
    "Microhouse",
    "Lo-Fi House",
    "Deep Tech House",
    "Progressive Tech House",
    "Organic Progressive House",
    "Atmospheric House",
    "Underground House",
    "Hypnotic House"
  ].map((name) => entry(name, "House", {
    "Lo-Fi House": ["lofi house", "lo fi house"],
    "Jackin House": ["jacking house"],
    "Organic Progressive House": ["organic progressive"]
  }[name] || [])),
  ...[
    "Trance",
    "Progressive Trance",
    "Uplifting Trance",
    "Vocal Trance",
    "Tech Trance",
    "Hard Trance",
    "Acid Trance",
    "Deep Trance",
    "Melodic Trance",
    "Driving Trance",
    "Emotional Trance",
    "Classic Trance",
    "Euphoric Trance",
    "Dream Trance",
    "Balearic Trance",
    "Progressive Vocal Trance"
  ].map((name) => entry(name, "Trance")),
  ...[
    "Psytrance",
    "Progressive Psytrance",
    "Deep Psy",
    "Goa Trance",
    "Full-On Psytrance",
    "Morning Psy",
    "Night Psy",
    "Dark Psy",
    "Forest Psy",
    "Hi-Tech Psy",
    "Zenonesque",
    "Psygressive",
    "Psybient",
    "Psybreaks",
    "Suomisaundi",
    "Twilight Psy",
    "Tribal Psy",
    "Progressive Goa"
  ].map((name) => entry(name, "Psytrance", {
    "Psytrance": ["psy trance", "psychedelic trance"],
    "Deep Psy": ["deep psytrance"],
    "Full-On Psytrance": ["full on psytrance", "full-on psy", "full on psy"],
    "Morning Psy": ["morning psytrance"],
    "Night Psy": ["night psytrance"],
    "Dark Psy": ["dark psytrance"],
    "Forest Psy": ["forest psytrance"],
    "Hi-Tech Psy": ["hi tech psy", "hitech psy", "hi-tech psytrance"],
    "Psygressive": ["psy progressive"],
    "Progressive Goa": ["progressive goa trance"]
  }[name] || [])),
  ...[
    "Techno",
    "Melodic Techno",
    "Progressive Techno",
    "Peak Time Techno",
    "Hypnotic Techno",
    "Minimal Techno",
    "Detroit Techno",
    "Dub Techno",
    "Deep Techno",
    "Driving Techno",
    "Industrial Techno",
    "Acid Techno",
    "Hard Techno",
    "Schranz",
    "Raw Techno",
    "Atmospheric Techno",
    "Organic Techno",
    "Tribal Techno",
    "Warehouse Techno",
    "Dark Techno",
    "Cinematic Techno",
    "Emotional Techno",
    "Progressive Melodic Techno",
    "Atmospheric Melodic Techno",
    "Indie Dance",
    "Melodic Electronica"
  ].map((name) => entry(name, ["Indie Dance", "Melodic Electronica"].includes(name) ? name : "Techno", {
    "Melodic Techno": ["afterlife techno", "deep melodic techno"],
    "Peak Time Techno": ["peak-time techno"],
    "Progressive Melodic Techno": ["melodic progressive techno"]
  }[name] || [])),
  ...[
    "Breakbeat",
    "Progressive Breaks",
    "Nu Skool Breaks",
    "Florida Breaks",
    "Electro Breaks",
    "Atmospheric Breaks",
    "Psybreaks",
    "Deep Breaks",
    "Organic Breaks"
  ].map((name) => entry(name, "Breakbeat", {
    "Breakbeat": ["breaks", "breakbeats", "broken beat"],
    "Nu Skool Breaks": ["new school breaks"]
  }[name] || [])),
  ...[
    "Drum & Bass",
    "Liquid DnB",
    "Atmospheric DnB",
    "Neurofunk",
    "Jungle",
    "Techstep",
    "Darkstep",
    "Jump Up",
    "Deep DnB",
    "Intelligent DnB",
    "Progressive DnB"
  ].map((name) => entry(name, "Drum & Bass", {
    "Drum & Bass": ["drum and bass", "dnb", "drum n bass", "drum bass"],
    "Liquid DnB": ["liquid drum and bass", "liquid drum & bass"],
    "Atmospheric DnB": ["atmospheric drum and bass", "atmospheric drum & bass"],
    "Deep DnB": ["deep drum and bass", "deep drum & bass"],
    "Intelligent DnB": ["intelligent drum and bass", "intelligent drum & bass"],
    "Progressive DnB": ["progressive drum and bass", "progressive drum & bass"]
  }[name] || [])),
  ...[
    "Dubstep",
    "Melodic Dubstep",
    "Deep Dubstep",
    "Brostep",
    "Future Bass",
    "Trap",
    "Hybrid Trap",
    "Wave",
    "Bass Music",
    "Experimental Bass",
    "UK Bass"
  ].map((name) => entry(name, name === "Trap" ? "Trap" : "Dubstep")),
  ...[
    "Electro",
    "Electroclash",
    "Breaks Electro",
    "Modern Electro",
    "Detroit Electro"
  ].map((name) => entry(name, "Electro")),
  ...[
    "Disco",
    "Nu Disco",
    "Cosmic Disco",
    "Space Disco",
    "Italo Disco",
    "Indie Disco",
    "Disco House"
  ].map((name) => entry(name, "Disco")),
  ...[
    "Chillout",
    "Downtempo",
    "Ambient",
    "Organic Downtempo",
    "Psybient",
    "Lounge",
    "Balearic",
    "Meditation",
    "Deep Ambient",
    "Cinematic Ambient",
    "Space Ambient"
  ].map((name) => entry(name, ["Ambient", "Deep Ambient", "Cinematic Ambient", "Space Ambient"].includes(name) ? "Ambient" : "Downtempo")),
  ...[
    "Synthwave",
    "Retrowave",
    "Outrun",
    "Darksynth",
    "Chillwave",
    "Vaporwave",
    "Dreamwave"
  ].map((name) => entry(name, "Synthwave")),
  ...[
    "Electronica",
    "IDM",
    "Glitch",
    "Experimental Electronic",
    "Leftfield",
    "Intelligent Electronica",
    "Ambient Techno",
    "Micro Rhythm",
    "Abstract Electronic"
  ].map((name) => entry(name, "Electronica", {
    "IDM": ["intelligent dance music"],
    "Leftfield": ["leftfield electronic", "left-field electronic"]
  }[name] || [])),
  ...[
    "Afro Tech",
    "Organic World",
    "Ethnic Electronica",
    "Tribal Electronic",
    "Desert House",
    "Middle Eastern Electronica"
  ].map((name) => entry(name, "Global Electronic"))
];

const VIBE_ENTRIES = [
  ["Hypnotic", ["trippy", "mesmerizing", "mesmeric"]],
  ["Driving", ["drive", "road trip", "cruising", "forward motion"]],
  ["Rolling", ["roll", "rolling groove"]],
  ["Groovy", ["groove", "grooves"]],
  ["Funky", ["funky groove"]],
  ["Psychedelic", ["psychedelic vibe", "trippy"]],
  ["Atmospheric", ["wide", "airy"]],
  ["Emotional", ["emotive"]],
  ["Euphoric", ["euphoria"]],
  ["Dark", ["moody", "noir", "shadowy"]],
  ["Melancholic", ["melancholy"]],
  ["Uplifting", ["bright", "anthemic"]],
  ["Deep", ["deep vibe"]],
  ["Underground", ["deep cut", "deep cuts", "less obvious", "non-obvious", "obscure"]],
  ["Organic", ["earthy"]],
  ["Cinematic", ["film score", "soundtrack"]],
  ["Tribal", ["percussive", "ritual"]],
  ["Spacey", ["spacy", "space music"]],
  ["Cosmic", ["cosmos"]],
  ["Minimal", ["stripped back", "minimalist"]],
  ["Aggressive", ["hard hitting", "intense"]],
  ["Peak-Time", ["peak time", "peaktime"]],
  ["Late-Night", ["late night", "afterhours", "after hours"]],
  ["Sunrise", ["morning light"]],
  ["Sunset", ["dusk"]],
  ["Journey", ["journey track", "journey-like"]],
  ["Bass-Driven", ["bass driven", "bass heavy"]],
  ["Vocal-Driven", ["vocal driven", "vocal-led", "vocal led"]],
  ["Instrumental", ["no vocals"]],
  ["Experimental", ["weird", "leftfield"]]
].map(([name, aliases]) => entry(name, name, aliases));

const ERA_ENTRIES = [
  ["70s", ["1970s", "seventies"]],
  ["80s", ["1980s", "eighties"]],
  ["90s", ["1990s", "nineties"]],
  ["2000s", ["00s", "noughties", "aughts", "y2k"]]
].map(([name, aliases]) => entry(name, name, aliases));

const CHARACTERISTIC_ENTRIES = [
  ["Extended Mix", ["extended", "extended version"]],
  ["Original Mix", ["original"]],
  ["Club Mix", ["club version"]],
  ["Dub Mix", ["dub version"]],
  ["Radio Edit", ["radio version", "short edit", "single edit"]],
  ["Long Form", ["long-form", "long track", "long tracks", "long build", "long builds"]],
  ["DJ Friendly", ["dj-friendly", "mixable"]],
  ["Story Driven", ["story-driven", "narrative"]],
  ["Slow Build", ["slow-building", "slow builder"]],
  ["Peak Time Weapon", ["peak-time weapon", "weapon"]],
  ["Warm Up Track", ["warm-up track", "warmup track", "warm up"]],
  ["Closing Track", ["closer", "closing set"]],
  ["Headphone Track", ["headphone listening"]],
  ["Dancefloor Track", ["dance floor track", "dancefloor"]],
  ["Festival Track", ["festival"]],
  ["Underground Track", ["underground track"]]
].map(([name, aliases]) => entry(name, name, aliases));

const CHILD_PARENT_REMOVALS = [
  ["psytrance", ["trance", "house", "progressive house", "progressive trance", "melodic trance", "progressive"]],
  ["goa trance", ["trance"]],
  ["progressive psytrance", ["trance", "progressive house", "progressive trance", "progressive"]],
  ["tech house", ["house", "deep house", "melodic house", "organic house"]],
  ["deep tech house", ["house", "deep house", "tech house"]],
  ["progressive tech house", ["house", "tech house", "progressive house", "progressive"]],
  ["progressive house", ["house", "progressive"]],
  ["organic progressive house", ["house", "organic house", "progressive house", "progressive"]],
  ["melodic house", ["house"]],
  ["deep house", ["house"]],
  ["melodic techno", ["techno", "deep techno"]],
  ["progressive melodic techno", ["techno", "melodic techno", "progressive techno", "progressive"]],
  ["dark ambient", ["ambient", "downtempo"]],
  ["cinematic ambient", ["ambient", "downtempo"]],
  ["space ambient", ["ambient", "downtempo"]],
  ["progressive breaks", ["breakbeat", "breaks", "progressive"]],
  ["psybreaks", ["breakbeat", "breaks", "psytrance"]],
  ["drum and bass", ["bass music"]],
  ["liquid dnb", ["drum and bass"]],
  ["atmospheric dnb", ["drum and bass"]],
  ["progressive dnb", ["drum and bass", "progressive"]]
];

function sortedAliases(entries) {
  const aliases = [];
  for (const item of entries) {
    for (const alias of item.aliases) {
      aliases.push({
        entry: item,
        alias,
        normalized: normalize(alias),
        length: normalize(alias).length
      });
    }
  }
  return aliases
    .filter((item) => item.normalized)
    .sort((left, right) => right.length - left.length || right.normalized.split(" ").length - left.normalized.split(" ").length);
}

function findMatches(text, entries) {
  const matches = [];
  const seen = new Set();
  for (const alias of sortedAliases(entries)) {
    if (!normalizedContains(text, alias.alias)) continue;
    const key = alias.entry.canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      canonical: alias.entry.canonical,
      family: alias.entry.family,
      alias: alias.alias,
      aliases: alias.entry.aliases
    });
  }
  return matches;
}

function pruneGenreTerms(terms = []) {
  const keys = new Set(terms.map(normalize));
  const remove = new Set();
  for (const [child, parents] of CHILD_PARENT_REMOVALS) {
    if (!keys.has(normalize(child))) continue;
    for (const parent of parents) remove.add(normalize(parent));
  }
  return terms.filter((term) => !remove.has(normalize(term)));
}

function detectGenreTerms(text, { includeAliases = true, limit = 18 } = {}) {
  const matches = findMatches(text, GENRE_ENTRIES);
  const values = [];
  for (const match of matches) {
    values.push(match.canonical);
    if (match.family && match.family !== match.canonical) values.push(match.family);
    if (includeAliases) values.push(...match.aliases.map(titleToKey));
  }
  return {
    terms: uniqueValues(pruneGenreTerms(values), limit),
    matches
  };
}

function scrubGenreAliases(text) {
  let scrubbed = ` ${normalize(text)} `;
  for (const alias of sortedAliases(GENRE_ENTRIES)) {
    const token = ` ${alias.normalized} `;
    while (scrubbed.includes(token)) {
      scrubbed = scrubbed.replace(token, " ");
    }
  }
  return scrubbed.replace(/\s+/g, " ").trim();
}

function detectVibeTerms(text, { limit = 18 } = {}) {
  const matches = findMatches(scrubGenreAliases(text), VIBE_ENTRIES);
  return {
    terms: uniqueValues(matches.map((match) => match.canonical), limit),
    matches
  };
}

function detectEraTerms(text, { limit = 8 } = {}) {
  const matches = findMatches(text, ERA_ENTRIES);
  const years = [];
  for (const match of cleanText(text).matchAll(/\b(?:19\d0s|20\d0s|\d0s|19\d{2}|20\d{2})\b/gi)) {
    years.push(match[0]);
  }
  return uniqueValues([
    ...matches.map((match) => match.canonical),
    ...years
  ], limit);
}

function detectTrackCharacteristics(text, { limit = 12 } = {}) {
  const matches = findMatches(text, CHARACTERISTIC_ENTRIES);
  return {
    terms: uniqueValues(matches.map((match) => match.canonical), limit),
    matches
  };
}

function genreAliasValues() {
  return uniqueValues(GENRE_ENTRIES.flatMap((item) => [item.canonical, ...item.aliases.map(titleToKey)]), 300);
}

module.exports = {
  CHARACTERISTIC_ENTRIES,
  ERA_ENTRIES,
  GENRE_ENTRIES,
  VIBE_ENTRIES,
  cleanText,
  detectEraTerms,
  detectGenreTerms,
  detectTrackCharacteristics,
  detectVibeTerms,
  genreAliasValues,
  normalize,
  pruneGenreTerms,
  scrubGenreAliases
};
