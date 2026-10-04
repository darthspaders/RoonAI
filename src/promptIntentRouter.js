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

function uniqueValues(values = [], limit = 50) {
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

function containsTerm(text = "", term = "") {
  const source = ` ${normalize(text)} `;
  const needle = normalize(term);
  if (!needle) return false;
  return source.includes(` ${needle} `);
}

function detectDefinitions(text = "", definitions = [], limit = 8) {
  const hits = [];
  for (const definition of definitions) {
    const alias = definition.aliases.find((item) => containsTerm(text, item));
    if (!alias) continue;
    hits.push({
      canonical: definition.canonical,
      label: definition.label || definition.canonical,
      alias,
      vibes: definition.vibes || [],
      queries: definition.queries || [],
      matchTerms: uniqueValues([definition.canonical, ...(definition.matchTerms || []), ...(definition.aliases || [])], 24)
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

const THEME_DEFINITIONS = [
  {
    canonical: "love",
    label: "love",
    aliases: ["love", "romance", "romantic", "relationship", "heart", "affection"],
    matchTerms: ["love", "romance", "heart", "lover", "beloved"],
    vibes: ["emotional", "vocal-driven"],
    queries: ["love", "romantic", "emotional vocal"]
  },
  {
    canonical: "being apart",
    label: "being apart",
    aliases: [
      "being apart",
      "apart",
      "distance",
      "long distance",
      "separation",
      "separated",
      "far away",
      "away from",
      "missing you",
      "miss you",
      "longing",
      "yearning"
    ],
    matchTerms: ["apart", "distance", "separation", "separated", "away", "missing", "miss you", "longing", "yearning", "without you", "far away"],
    vibes: ["melancholic", "emotional", "deep"],
    queries: ["being apart", "long distance love", "missing you", "far away", "longing", "separation"]
  },
  {
    canonical: "heartbreak",
    label: "heartbreak",
    aliases: ["heartbreak", "heartbroken", "breakup", "break up", "lost love", "sad love", "hurting"],
    matchTerms: ["heartbreak", "heartbroken", "breakup", "lost love", "hurting", "alone"],
    vibes: ["melancholic", "emotional", "dark"],
    queries: ["heartbreak", "lost love", "sad love", "melancholic vocal"]
  },
  {
    canonical: "loneliness",
    label: "loneliness",
    aliases: ["lonely", "loneliness", "alone", "isolation", "isolated", "solitude"],
    matchTerms: ["lonely", "loneliness", "alone", "isolation", "solitude"],
    vibes: ["melancholic", "atmospheric", "deep"],
    queries: ["lonely", "alone", "solitude", "melancholic electronic"]
  },
  {
    canonical: "hope",
    label: "hope",
    aliases: ["hope", "hopeful", "healing", "recovery", "moving on", "new beginning"],
    matchTerms: ["hope", "hopeful", "healing", "recover", "moving on", "new beginning"],
    vibes: ["uplifting", "emotional"],
    queries: ["hopeful", "healing", "new beginning", "uplifting emotional"]
  }
];

const ACTIVITY_DEFINITIONS = [
  {
    canonical: "driving",
    label: "driving",
    aliases: ["driving", "drive", "road trip", "night drive", "car", "highway"],
    matchTerms: ["drive", "driving", "road", "highway", "motion"],
    vibes: ["driving", "rolling"],
    queries: ["driving music", "night drive", "road trip", "rolling"]
  },
  {
    canonical: "focus",
    label: "focus",
    aliases: ["focus", "working", "work", "coding", "study", "studying", "concentration"],
    matchTerms: ["focus", "concentration", "work", "study"],
    vibes: ["minimal", "instrumental", "deep"],
    queries: ["focus music", "instrumental electronic", "minimal deep"]
  },
  {
    canonical: "sleep",
    label: "sleep",
    aliases: ["sleep", "fall asleep", "bedtime", "late night relaxing"],
    matchTerms: ["sleep", "dream", "night", "rest"],
    vibes: ["atmospheric", "deep", "minimal"],
    queries: ["sleep", "dream", "ambient night", "deep ambient"]
  },
  {
    canonical: "party",
    label: "party",
    aliases: ["party", "dancefloor", "club night", "floor", "peak time", "festival"],
    matchTerms: ["party", "dancefloor", "club", "peak", "festival"],
    vibes: ["peak-time", "dancefloor track"],
    queries: ["dancefloor", "club track", "peak time"]
  },
  {
    canonical: "warm up",
    label: "warm up",
    aliases: ["warm up", "opening set", "early night", "starter", "good start"],
    matchTerms: ["warm up", "opening", "early", "start"],
    vibes: ["deep", "slow build"],
    queries: ["warm up", "opening set", "slow build"]
  }
];

function scoringModeKey(options = {}) {
  const key = normalize(options.scoringMode || options.scoring_mode || options.mode || "taste-guided");
  if (["pure", "pure search", "search only", "unbiased"].includes(key)) return "pure";
  if (["explore", "explore mode", "outside taste", "outside known taste"].includes(key)) return "explore";
  if (["similar", "similar mode", "similarity", "liked"].includes(key)) return "similar";
  return "taste-guided";
}

function hasExplicitGenre(options = {}) {
  const text = normalize(`${options.genres || ""} ${options.request || ""}`);
  if (cleanText(options.genres)) return true;
  return /\b(?:edm|electronic dance music|electronic music|dance music|house|techno|trance|psytrance|psy trance|ambient|downtempo|chillout|breaks|breakbeat|dubstep|bass|drum and bass|dnb|electro|disco|synthwave|electronica|idm|jungle|garage|country|folk|rock|pop|indie|alternative|soul|r and b|rnb|jazz|classical|metal|hip hop|rap|singer songwriter)\b/.test(text);
}

function hasEraIntent(options = {}) {
  return /\b(?:19\d{2}|20\d{2}|this year|last year|this week|last week|today|yesterday|90s|80s|70s|2000s|2010s|2020s|nineties|eighties|seventies)\b/.test(normalize(`${options.request || ""} ${options.years || ""}`));
}

function hasSimilarityIntent(text = "") {
  // “radio-like” and similar descriptive compounds are not a request for
  // track similarity. Strip that adjective before checking the standalone
  // similarity language so standby's taste-profile prompt stays cluster-led.
  const normalized = normalize(text).replace(/\bradio like\b/g, " ");
  return /\b(?:like|similar to|sounds like|around|based on|in the vein of|for fans of|more from|more tracks by|discover from artist)\b/.test(normalized);
}

function hasOutsideTasteLanguage(text = "") {
  return /\b(?:outside|beyond|branch out|branching out|fresh artists?|new artists?|different artists?|not my usual|outside my usual|outside known taste|surprise me|adventurous|explore)\b/.test(normalize(text));
}

function hasOmnivoreOpenDiscoveryLanguage(text = "") {
  const normalized = normalize(text);
  return /\b(?:any|all|whatever|no matter|regardless of|regardless)\b.{0,24}\bgenres?\b/.test(normalized) ||
    /\bgenres?\b.{0,24}\b(?:do not matter|doesn t matter|does not matter|irrelevant|open|wide open)\b/.test(normalized) ||
    /\b(?:surprise me|anything good|good music|great music|best music|best tracks|hidden gems|wide net|open discovery|omnivore)\b/.test(normalized);
}

function hasBroadElectronicLanguage(text = "") {
  const normalized = normalize(text);
  return /\b(?:any|all|open|broad|various|different|multiple)\b.{0,32}\b(?:edm|electronic dance music|electronic music|dance music)\b/.test(normalized) ||
    /\b(?:edm|electronic dance music|electronic music|dance music)\b.{0,20}\b(?:lane|lanes|genre|genres|style|styles)\b/.test(normalized);
}

function hasExplicitThemeRequest(text = "") {
  return /\b(?:about|theme|story|stories|lyric|lyrics|song about|songs about|track about|tracks about)\b/.test(normalize(text));
}

function hasStrictTasteLanguage(text = "") {
  return /\b(?:only my taste|strict taste|stay in my taste|known taste only|similar mode|more of what i like|close to my taste)\b/.test(normalize(text));
}

function hasTasteProfileLanguage(text = "") {
  return /\b(?:use|match|based on|from)\b.{0,24}\b(?:my|current|known)\b.{0,24}\b(?:taste|profile|preferences?)\b/.test(normalize(text)) ||
    /\b(?:my|current|known)\b.{0,24}\b(?:taste|profile|preferences?)\b/.test(normalize(text));
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const key = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "allow", "allowed"].includes(key);
}

function buildThemeQueries(themeHits = [], activityHits = [], options = {}) {
  const rawGenres = cleanText(options.genres);
  const rawYears = cleanText(options.years);
  const genreParts = rawGenres ? [rawGenres] : ["electronic", "vocal electronic", "indie electronic", "chill electronic"];
  const themeQueries = uniqueValues([
    ...themeHits.flatMap((hit) => hit.queries),
    ...activityHits.flatMap((hit) => hit.queries)
  ], 18);

  const queries = [];
  for (const query of themeQueries) {
    queries.push(query);
    for (const genre of genreParts.slice(0, rawGenres ? 2 : 3)) {
      queries.push(`${query} ${genre}`);
      if (rawYears) queries.push(`${query} ${genre} ${rawYears}`);
    }
    if (rawYears) queries.push(`${query} ${rawYears}`);
  }

  if (themeHits.some((hit) => normalize(hit.canonical) === "love") && themeHits.some((hit) => normalize(hit.canonical) === "being apart")) {
    queries.unshift(
      "love apart",
      "long distance love",
      "missing you",
      "far away love",
      "love separation",
      "longing love"
    );
  }

  return uniqueValues(queries, 36);
}

function routeLabel(route = "") {
  const key = normalize(route);
  if (key === "theme") return "Theme First";
  if (key === "activity") return "Activity First";
  if (key === "similarity") return "Similar Artist/Track";
  if (key === "artist") return "Artist First";
  if (key === "genre") return "Genre First";
  if (key === "era") return "Era First";
  if (key === "mood") return "Mood First";
  return "Open Discovery";
}

function routePromptIntent(options = {}) {
  const request = cleanText(options.request);
  const text = cleanText(`${options.request || ""} ${options.reference || ""}`);
  const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
  const genreContext = cleanText(`${text} ${options.genres || ""}`);
  const explicitBroadElectronicOption = /^(?:edm|electronic|electronic music|electronic dance music|dance music)$/i.test(cleanText(options.genres));
  const suppressPlanConcepts = (hasOmnivoreOpenDiscoveryLanguage(text) || hasBroadElectronicLanguage(genreContext) || explicitBroadElectronicOption) && !hasExplicitThemeRequest(text);
  const planThemeTerms = suppressPlanConcepts ? [] : uniqueValues(Array.isArray(plan.themeTerms) ? plan.themeTerms : [], 8);
  const planActivityTerms = suppressPlanConcepts ? [] : uniqueValues(Array.isArray(plan.activityTerms) ? plan.activityTerms : [], 6);
  const themeHits = [
    ...detectDefinitions(text, THEME_DEFINITIONS, 6),
    ...planThemeTerms.map((term) => ({
      canonical: term,
      label: term,
      alias: term,
      vibes: [],
      queries: [term],
      matchTerms: [term]
    }))
  ];
  const activityHits = [
    ...detectDefinitions(text, ACTIVITY_DEFINITIONS, 4),
    ...planActivityTerms.map((term) => ({
      canonical: term,
      label: term,
      alias: term,
      vibes: [],
      queries: [term],
      matchTerms: [term]
    }))
  ];
  const scoringMode = scoringModeKey(options);
  const explicitGenre = hasExplicitGenre(options);
  const explicitMood = cleanText(options.mood);
  const similarityIntent = hasSimilarityIntent(text);
  const outsideLanguage = hasOutsideTasteLanguage(text);
  const strictTaste = hasStrictTasteLanguage(text);
  const tasteProfileRequest = hasTasteProfileLanguage(text);
  // “Use my taste” is a request to make the learned profile the primary
  // discovery compass. It is still a soft preference—not a genre whitelist—
  // and explicit branch-out language continues to open the lane.
  const tasteProfileLed = tasteProfileRequest && !outsideLanguage && !explicitGenre && !similarityIntent;
  const planAllowsOutsideTaste = normalizeBoolean(plan.allowOutsideTaste) && !tasteProfileLed;
  const planRoute = normalize(plan.intentRoute);
  const planRouteAllowed = !suppressPlanConcepts && ["theme", "activity", "genre", "era", "mood", "artist", "similarity", "open"].includes(planRoute);
  const route = themeHits.length
    ? "theme"
    : (activityHits.length
      ? "activity"
      : (similarityIntent
        ? "similarity"
        : (planRouteAllowed
          ? planRoute
          : (explicitGenre
          ? "genre"
          : (hasEraIntent(options)
            ? "era"
            : (explicitMood ? "mood" : (request ? "open" : "open")))))));

  const explicitTastePreference = normalize(options.tasteInfluence || options.taste_influence);
  const allowOutsideTaste = scoringMode === "pure" ||
    scoringMode === "explore" ||
    planAllowsOutsideTaste ||
    outsideLanguage ||
    (explicitGenre && !strictTaste) ||
    ((route === "theme" || route === "activity" || route === "open") && !strictTaste && scoringMode !== "similar" && !tasteProfileLed);
  const planTasteInfluence = ["strongly", "lightly", "not at all"].includes(normalize(plan.tasteInfluence))
    ? normalize(plan.tasteInfluence)
    : "";
  const requestedTasteInfluence = ["strongly", "lightly", "not at all"].includes(explicitTastePreference)
    ? explicitTastePreference
    : planTasteInfluence;
  const tasteInfluence = scoringMode === "pure"
    ? "not at all"
    : (scoringMode === "similar" || strictTaste || tasteProfileLed
      ? "strongly"
      : (requestedTasteInfluence === "not at all" && explicitGenre
        ? "lightly"
        : (requestedTasteInfluence || "lightly")));
  const inferredVibes = uniqueValues([
    ...themeHits.flatMap((hit) => hit.vibes),
    ...activityHits.flatMap((hit) => hit.vibes)
  ], 10);
  const themeTerms = uniqueValues(themeHits.map((hit) => hit.label), 8);
  const activityTerms = uniqueValues(activityHits.map((hit) => hit.label), 6);
  const matchTerms = uniqueValues([
    ...themeHits.flatMap((hit) => hit.matchTerms),
    ...activityHits.flatMap((hit) => hit.matchTerms)
  ], 40);
  const queryExpansions = buildThemeQueries(themeHits, activityHits, options);
  const primarySearchTerm = cleanText(queryExpansions[0]) ||
    cleanText(themeTerms.join(" ")) ||
    cleanText(activityTerms.join(" ")) ||
    "";

  return {
    route,
    routeLabel: routeLabel(route),
    strictness: route === "theme"
      ? "theme-first"
      : (route === "activity"
        ? "activity-first"
        : (route === "similarity"
          ? "similarity-first"
          : (route === "genre" ? "genre-first" : (route === "era" ? "era-first" : "open-discovery")))),
    hasIntent: Boolean(themeHits.length || activityHits.length || outsideLanguage || explicitGenre || explicitMood || similarityIntent || request),
    themeTerms,
    activityTerms,
    inferredVibes,
    matchTerms,
    queryExpansions,
    primarySearchTerm,
    allowOutsideTaste,
    tasteInfluence,
    tastePolicy: scoringMode === "pure"
      ? "Taste weighting is disabled only for Pure Search."
      : (explicitGenre
        ? "Current requested genre is the hard search lane; saved taste is a soft ranking/style preference and never a genre whitelist."
      : (tasteProfileLed
        ? "The current taste profile is the primary cluster guide; unfamiliar music can still enter when it earns strong evidence."
        : "Saved taste is a soft preference; prompt evidence can lead outside the known profile.")),
    outsideTasteMode: outsideLanguage
      ? "explicit"
      : (explicitGenre ? "genre-lane" : (tasteProfileLed ? "taste-profile" : (allowOutsideTaste ? "open-discovery" : "none"))),
    // A dedicated genres field is an explicit lane constraint even when the
    // natural-language request also contains an activity or theme. This is a
    // search boundary, not a claim that the user's taste profile is limited
    // to that genre or that unfamiliar genres should be rejected.
    genreConstraint: explicitGenre ? (cleanText(options.genres) ? "hard" : (route === "theme" || route === "activity" ? "soft" : "hard")) : "none",
    themeSource: themeHits.length ? "explicit" : "not specified",
    activitySource: activityHits.length ? "explicit" : "not specified",
    verificationMethods: route === "theme"
      ? ["title/theme evidence", "artist/album context", "TIDAL metadata", "Last.fm tags when available"]
      : (route === "activity"
        ? ["activity/vibe terms", "artist/album context", "TIDAL metadata"]
        : ["genre/label/artist metadata", "TIDAL/Roon verification"]),
    notes: allowOutsideTaste
      ? "Prompt can approve outside known taste when the catalogue evidence matches."
      : "Learned taste remains the primary preference for this request, without becoming a hard whitelist."
  };
}

module.exports = {
  routePromptIntent,
  routeLabel,
  cleanText,
  normalize,
  hasTasteProfileLanguage
};
