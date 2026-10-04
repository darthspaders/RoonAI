"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sourceFor(track = {}) {
  return cleanText(track.standbySource || track.discoverySource || track.source || "Unknown source");
}

function laneFor(track = {}) {
  return cleanText(track.standbyLane || track.discoveryLane || track.discoveryQuotaBucket || "unknown");
}

function increment(map, key, amount = 1) {
  const label = cleanText(key) || "unknown";
  map.set(label, (map.get(label) || 0) + Number(amount || 1));
}

function sortedCounts(map = new Map(), limit = 12) {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function summarizeStandbyFreshness({
  storedTracks = [],
  visibleTracks = [],
  targetCount = 25,
  isPreviouslySuggested = () => false,
  keyForTrack = (track) => cleanText(track.key)
} = {}) {
  const visibleKeys = new Set((visibleTracks || []).map(keyForTrack).filter(Boolean));
  const filteredBySource = new Map();
  const filteredByLane = new Map();
  const visibleBySource = new Map();
  const visibleByLane = new Map();
  let previouslySuggested = 0;
  let invalid = 0;

  for (const track of storedTracks || []) {
    const key = keyForTrack(track);
    if (!key) {
      invalid += 1;
      increment(filteredBySource, sourceFor(track));
      increment(filteredByLane, laneFor(track));
      continue;
    }
    if (visibleKeys.has(key)) {
      increment(visibleBySource, sourceFor(track));
      increment(visibleByLane, laneFor(track));
      continue;
    }
    if (isPreviouslySuggested(track)) previouslySuggested += 1;
    increment(filteredBySource, sourceFor(track));
    increment(filteredByLane, laneFor(track));
  }

  const stored = (storedTracks || []).length;
  const visible = (visibleTracks || []).length;
  const filtered = Math.max(0, stored - visible);
  return {
    targetCount: Math.max(1, Number(targetCount || 25)),
    stored,
    visible,
    filtered,
    previouslySuggested,
    invalid,
    shortfall: Math.max(0, Math.max(1, Number(targetCount || 25)) - visible),
    filteredBySource: sortedCounts(filteredBySource),
    filteredByLane: sortedCounts(filteredByLane),
    visibleBySource: sortedCounts(visibleBySource),
    visibleByLane: sortedCounts(visibleByLane)
  };
}

function mergeStandbyRefillPool({
  newTracks = [],
  existingTracks = [],
  targetCount = 25,
  keyForTrack = (track) => cleanText(track.key || `${track.artist || ""}|${track.title || ""}`)
} = {}) {
  const target = Math.max(1, Number(targetCount || 25));
  const nextTracks = Array.isArray(newTracks) ? newTracks : [];
  const currentTracks = Array.isArray(existingTracks) ? existingTracks : [];
  const primary = nextTracks.length >= currentTracks.length ? nextTracks : currentTracks;
  const secondary = nextTracks.length >= currentTracks.length ? currentTracks : nextTracks;
  const seen = new Set();
  const merged = [];

  function add(track) {
    const key = cleanText(keyForTrack(track));
    if (!key || seen.has(key) || merged.length >= target) return;
    seen.add(key);
    merged.push(track);
  }

  for (const track of primary) add(track);
  for (const track of secondary) add(track);

  return merged;
}

function withStandbyInstruction(baseRequest = "", instruction = "") {
  const request = cleanText(baseRequest);
  const suffix = cleanText(instruction);
  if (!request) return suffix;
  if (!suffix) return request;
  return `${request} ${suffix}`;
}

function withoutExplicitYearTerms(value = "") {
  return cleanText(value)
    .replace(/\b(?:19|20)\d{2}\s*(?:-|to|through|thru|until|and|\/)\s*(?:19|20)?\d{2}\b/gi, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:this year|new releases this year|recent year|current year)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function broadeningCount(targetCount = 25, freshCount = 0) {
  const target = Math.max(1, Number(targetCount || 25));
  const needed = Math.max(1, target - Math.max(0, Number(freshCount || 0)));
  return String(Math.min(60, Math.max(target, needed * 4)));
}

function cleanRefillCount(targetCount = 25, freshCount = 0) {
  const target = Math.max(1, Number(targetCount || 25));
  const needed = Math.max(1, target - Math.max(0, Number(freshCount || 0)));
  return String(Math.min(28, Math.max(target, target + needed * 3)));
}

function standbyFreshSourcePasses(baseOptions = {}, state = {}) {
  const targetCount = Math.max(1, Number(state.targetCount || baseOptions.count || 25));
  const freshCount = Math.max(0, Number(state.freshCount || 0));
  if (freshCount >= targetCount) return [];

  const count = broadeningCount(targetCount, freshCount);
  const refillCount = cleanRefillCount(targetCount, freshCount);
  const baseRequest = cleanText(baseOptions.request);
  const yearlessBaseRequest = withoutExplicitYearTerms(baseRequest);
  const baseMood = cleanText(baseOptions.mood);
  const yearlessBaseMood = withoutExplicitYearTerms(baseMood);
  const baseGenres = cleanText(baseOptions.genres);
  const tasteArtists = Array.isArray(baseOptions.learnedTasteArtists)
    ? baseOptions.learnedTasteArtists.map(cleanText).filter(Boolean).slice(0, 18)
    : [];
  const tasteLabels = Array.isArray(baseOptions.learnedTasteLabels)
    ? baseOptions.learnedTasteLabels.map(cleanText).filter(Boolean).slice(0, 18)
    : [];
  const tasteReservoir = !baseGenres && Boolean(tasteArtists.length || tasteLabels.length);
  const tasteAnchorQueries = [...tasteArtists, ...tasteLabels].filter(Boolean);
  const refillGenres = tasteReservoir
    ? ""
    : "progressive house, melodic house, organic house, melodic techno, progressive breaks, breakbeat, progressive trance, downtempo, leftfield electronic, indie dance, nu disco";
  const stockInstruction = "Avoid exact track repeats and obvious artist floods. Prefer a short clean pool over padding with weak catalogue matches.";
  // A taste-profile refresh is intentionally genre/mood-neutral. Keep these
  // words out of the parsed request so they cannot become hidden positive
  // query terms; explicit user genres and moods still flow through normally.
  const discoveryMood = (value) => tasteReservoir ? undefined : value;
  const common = {
    count,
    effectiveCount: Number(count),
    scoringMode: cleanText(baseOptions.scoringMode) || "explore",
    // Standby should return a smaller pool rather than padding with weak
    // catalog matches when the current taste reservoir is sparse.
    minScore: cleanText(baseOptions.minScore) || "50",
    standbyPool: "true",
    requireRoonQueueable: "",
    allowPreviousSuggestions: "",
    years: "",
    releasePreset: "",
    releaseExactDate: "",
    releaseStartDate: "",
    releaseEndDate: ""
  };

  const passes = [
    {
      id: "adjacent-artist-branches",
      label: "Fresh adjacent artist branches",
      reason: "Visible standby pool is below target after repeat suppression; search adjacent artists, remixers, and radio-like branches.",
      source: "Standby adjacent broadening",
      options: {
        ...common,
        request: tasteReservoir ? "" : withStandbyInstruction(yearlessBaseRequest, `Standby fresh broadening pass: prioritize adjacent artists, remixers, and external relationship branches. Exclude previously suggested tracks and avoid top-artist repeats. ${stockInstruction}`),
        mood: discoveryMood(withStandbyInstruction(yearlessBaseMood, "fresh adjacent, low-exposure"))
      }
    },
    {
      id: "label-branches",
      label: "Fresh label branches",
      reason: "Use labels as the bridge when artist novelty is exhausted.",
      source: "Standby label broadening",
      options: {
        ...common,
        request: tasteReservoir ? "" : withStandbyInstruction(yearlessBaseRequest, `Standby fresh broadening pass: search trusted and low-exposure label branches rather than familiar artists. Exclude previously suggested tracks. ${stockInstruction}`),
        mood: discoveryMood(withStandbyInstruction(yearlessBaseMood, "label discovery, deep cuts, catalogue-adjacent")),
        genres: baseGenres
      }
    },
    {
      id: "radio-bridge",
      label: "Fresh radio-style branches",
      reason: "Use TIDAL/radio-like branching language when catalogue search is too narrow.",
      source: "Standby radio broadening",
      options: {
        ...common,
        request: tasteReservoir ? "" : withStandbyInstruction(yearlessBaseRequest, `Standby fresh broadening pass: use catalog artist relationships and playlist-context branches. Exclude previously suggested tracks. ${stockInstruction}`),
        mood: discoveryMood(withStandbyInstruction(yearlessBaseMood, "adjacent, surprising, playable"))
      }
    },
    {
      id: "clean-refill-wide-sources",
      label: "Clean refill wide sources",
      reason: "Strict sludge and repeat filters left the visible standby pool short; widen to durable adjacent scenes and trusted labels without relaxing rejection filters.",
      source: "Standby clean refill",
      timeoutMs: 18_000,
      options: {
        ...common,
        count: refillCount,
        effectiveCount: Number(refillCount),
        // The plan-only taste refill already carries its anchors in the
        // structured llmSearchPlan below. Keep prose out of the request so a
        // parser cannot turn words like "adjacent" or "deep" into catalog
        // queries if a plan is unavailable or partially malformed.
        request: tasteReservoir
          ? ""
          : `Clean standby refill pass: widen beyond the current recent-year lane into durable label, artist-radio, and deep-cut sources. Prefer real artist-title releases with normal titles and real release metadata. Apply the standard catalogue-quality policy and exclude previously suggested tracks. ${stockInstruction}`,
        genres: refillGenres,
        years: "",
        releasePreset: "",
        releaseExactDate: "",
        releaseStartDate: "",
        releaseEndDate: "",
        skipSimilarArtistExpansion: "true",
        planOnlySearch: "true",
        planQueryLimit: tasteReservoir ? String(Math.min(24, Math.max(18, tasteAnchorQueries.length))) : "18",
        requirePlanQueryAnchor: "true",
        mood: discoveryMood(withStandbyInstruction(yearlessBaseMood, "durable, deep, hypnotic, melodic, atmospheric, groove-led, non-obvious")),
        llmSearchPlan: {
          searchQueries: [
            "Bedrock Records progressive house",
            "Lost & Found Records progressive house",
            "Sudbeat Music progressive house",
            "Sound Avenue progressive house",
            "The Soundgarden progressive house",
            "Mango Alley progressive house",
            "Meanwhile Recordings progressive house",
            "Balance Music progressive breaks",
            "Anjunadeep melodic house",
            "Plattenbank progressive house",
            "Replug Records progressive house",
            "UV Ibiza progressive house",
            "Univack progressive",
            "Proton Music progressive house",
            "Juicebox Music progressive",
            "Manual Music melodic house"
          ],
          candidateLabels: [
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
          ],
          targetGenres: [
            "progressive house",
            "melodic house",
            "melodic techno",
            "progressive breaks",
            "downtempo",
            "leftfield electronic"
          ],
          vibeTerms: [
            "deep",
            "hypnotic",
            "melodic",
            "atmospheric",
            "groove-led"
          ]
        }
      }
    }
  ];
  if (tasteReservoir) {
    const refill = passes.find((pass) => pass.id === "clean-refill-wide-sources");
    if (refill) {
      refill.options.llmSearchPlan = {
        searchQueries: tasteAnchorQueries,
        candidateArtists: tasteArtists,
        candidateLabels: tasteLabels,
        targetGenres: [],
        vibeTerms: []
      };
    }
  }
  return [
    ...passes.filter((pass) => pass.id === "clean-refill-wide-sources"),
    ...passes.filter((pass) => pass.id !== "clean-refill-wide-sources")
  ];
}

module.exports = {
  mergeStandbyRefillPool,
  standbyFreshSourcePasses,
  summarizeStandbyFreshness
};
