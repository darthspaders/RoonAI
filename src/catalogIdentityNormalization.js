"use strict";

// Provider catalogues routinely disagree about harmless Unicode spelling,
// punctuation, and where featured credits are stored. Keep this normalization
// deliberately narrow: it creates comparison keys, never display values, and
// does not perform fuzzy artist matching.
const UNICODE_FOLD_MAP = new Map(Object.entries({
  "ø": "o", "Ø": "O", "ð": "d", "Ð": "D", "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L", "ħ": "h", "Ħ": "H", "ı": "i", "İ": "I",
  "þ": "th", "Þ": "Th", "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe",
  "ß": "ss", "ẞ": "SS"
}));

function foldUnicode(value) {
  return String(value ?? "")
    .replace(/[øØðÐđĐłŁħĦıİþÞæÆœŒßẞ]/g, (character) => UNICODE_FOLD_MAP.get(character) || character)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
}

function normalizeCatalogText(value) {
  return foldUnicode(value)
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitCreditNames(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.flatMap((entry) => String(entry ?? "")
    .split(/\s*(?:,|;|&|\/|\+|\||\band\b|\bfeat\.?|\bfeaturing\b|\bwith\b|\bvs\.?|\bversus\b)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean)))];
}

function artistCreditValues(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((entry) => {
    if (entry && typeof entry === "object") {
      return splitCreditNames(entry.name || entry.artist || entry.title || "");
    }
    return splitCreditNames(entry);
  });
}

function normalizeArtistCreditName(value) {
  return normalizeCatalogText(value);
}

function artistCreditKey(value) {
  return normalizeArtistCreditName(value).replace(/\s+/g, "");
}

function normalizeArtistCreditNames(value) {
  return [...new Set(artistCreditValues(value)
    .map(normalizeArtistCreditName)
    .filter(Boolean))];
}

function artistCreditSetKey(value) {
  return [...new Set(normalizeArtistCreditNames(value)
    .map(artistCreditKey)
    .filter(Boolean))].sort().join("|");
}

function artistCreditNormalizationRule(left, right) {
  const leftNames = normalizeArtistCreditNames(left);
  const rightNames = normalizeArtistCreditNames(right);
  const leftNormalized = [...new Set(leftNames)].sort().join("|");
  const rightNormalized = [...new Set(rightNames)].sort().join("|");
  if (leftNormalized === rightNormalized && leftNormalized) return "canonical-credit-set";

  const leftKeys = [...new Set(leftNames.map(artistCreditKey))].sort().join("|");
  const rightKeys = [...new Set(rightNames.map(artistCreditKey))].sort().join("|");
  if (leftKeys === rightKeys && leftKeys) {
    const leftSeparators = String(Array.isArray(left) ? left.map((entry) => entry?.name || entry?.artist || entry || "").join(" ") : left || "");
    const rightSeparators = String(Array.isArray(right) ? right.map((entry) => entry?.name || entry?.artist || entry || "").join(" ") : right || "");
    if (/[,;&+\/|]|\b(?:and|vs\.?|versus)\b/i.test(`${leftSeparators} ${rightSeparators}`)) return "credit-separator-normalization";
    return "punctuation-and-spacing-fold";
  }
  return "";
}

function featuredArtistNames(value) {
  const text = String(value ?? "");
  const bracketed = text.match(/[\[(]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\])]+)[\])]\s*$/i);
  if (bracketed) return splitCreditNames(bracketed[1]).map(normalizeCatalogText).filter(Boolean);

  // `with` is a normal title word surprisingly often (for example,
  // “Burned With Desire”). Treat it as a credit delimiter only when the
  // provider has structurally marked it as a suffix with a hyphen. Explicit
  // feat/ft/featuring suffixes remain valid without brackets.
  const explicit = text.match(/\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i)
    || text.match(/\s+-\s+with\s+(.+)$/i);
  return explicit ? splitCreditNames(explicit[1]).map(normalizeCatalogText).filter(Boolean) : [];
}

function stripFeaturedArtistText(value) {
  return String(value ?? "")
    .replace(/\s*(?:\((?:feat\.?|ft\.?|featuring|with)\s+[^()]*)\)\s*$/i, "")
    .replace(/\s*(?:\[(?:feat\.?|ft\.?|featuring|with)\s+[^\[\]]*)\]\s*$/i, "")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+[^()[\]]+$/i, "")
    .replace(/\s+-\s+with\s+[^()[\]]+$/i, "")
    .trim();
}

const VERSION_DESCRIPTOR_PATTERNS = [
  ["mixed", /\b(?:mixed|dj\s+mix|continuous\s+mix)\b/i],
  ["radio", /\b(?:radio\s+edit|radio\s+mix|radio)\b/i],
  ["remix", /\b(?:remix|rework|reimagined|bootleg|flip|vip)\b/i],
  ["dub", /\bdub(?:\s+(?:mix|version|edit))?\b/i],
  ["orchestra", /\borchestra\s+(?:version|mix|edit)\b/i],
  ["alternate", /\b(?:main|am|pm|ambient|acapella|a\s+cappella)\s+(?:mix|version|edit)\b/i],
  ["extended", /\b(?:extended|club)\s+(?:mix|version|edit)\b|\bextended\b/i],
  ["original", /\b(?:original\s+mix|original\s+version|original)\b/i],
  ["live", /\b(?:live|concert|in\s+concert)\b/i],
  ["acoustic", /\b(?:acoustic|unplugged)\b/i],
  ["remaster", /\b(?:remaster(?:ed)?|anniversary\s+edition)\b/i],
  ["edit", /\bedit\b/i]
];

const GENERIC_VERSION_WORDS = new Set([
  "mix", "remix", "edit", "version", "extended", "original", "radio", "club",
  "dub", "instrumental", "vip", "orchestra", "main", "am", "pm", "ambient",
  "acapella", "cappella", "remaster", "remastered", "anniversary", "edition",
  "live", "acoustic", "unplugged", "rework", "reimagined", "bootleg", "flip",
  "mixed", "dj", "continuous"
]);

function classifyVersionText(value) {
  const text = String(value ?? "").trim();
  const found = VERSION_DESCRIPTOR_PATTERNS.find(([, pattern]) => pattern.test(text));
  const rawNormalized = normalizeCatalogText(text);
  const bareKind = { main: "alternate", am: "alternate", pm: "alternate", club: "extended", extended: "extended", original: "original" }[rawNormalized];
  const kind = found?.[0] || bareKind || "none";
  const normalized = bareKind ? `${rawNormalized} mix` : rawNormalized;
  const semantic = normalized.split(/\s+/).filter(token => token && !GENERIC_VERSION_WORDS.has(token)).join(" ");
  return {
    kind,
    explicit: Boolean(text),
    label: text,
    normalized,
    semantic
  };
}

function versionDescriptorFromTitle(title) {
  const text = String(title ?? "").trim();
  const groups = [];
  for (const match of text.matchAll(/\(([^()]*)\)|\[([^\[\]]*)\]/g)) {
    const value = (match[1] || match[2] || "").trim();
    if (value && VERSION_DESCRIPTOR_PATTERNS.some(([, pattern]) => pattern.test(value))) groups.push(value);
  }
  const suffix = text.match(/(?:^|\s|[-–—])((?:extended|club|original|radio|main|orchestra|am|pm|ambient)\s+(?:mix|version|edit)|(?:radio\s+edit)|(?:dub|remix|rework|reimagined|bootleg|flip|vip|live|acoustic|unplugged|remaster(?:ed)?|edit))\s*$/i)?.[1] || "";
  if (suffix) groups.push(suffix.trim());
  const value = groups[groups.length - 1] || "";
  return value ? classifyVersionText(value) : classifyVersionText("");
}

function stripVersionDescriptorFromTitle(title) {
  let result = String(title ?? "").trim();
  result = result.replace(/\s*(?:\([^()]*\)|\[[^\[\]]*\])\s*$/g, (group) => {
    const value = group.replace(/^[\s(\[]+|[\s)\]]+$/g, "");
    return VERSION_DESCRIPTOR_PATTERNS.some(([, pattern]) => pattern.test(value)) ? "" : group;
  });
  result = result.replace(/\s+(?:(?:extended|club|original|radio|main|orchestra|am|pm|ambient)\s+(?:mix|version|edit)|radio\s+edit|dub|remix|rework|reimagined|bootleg|flip|vip|live|acoustic|unplugged|remaster(?:ed)?|edit)\s*$/i, "");
  return result.trim();
}

function durationMilliseconds(track = {}) {
  for (const key of ["durationMs", "duration_ms", "durationMilliseconds"]) {
    const value = Number(track?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const value = track?.duration;
  if (typeof value === "string") {
    const iso = value.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
    if (iso) return ((Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0)) * 1000;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds < 100000 ? seconds * 1000 : seconds;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? (number < 100000 ? number * 1000 : number) : null;
}

function normalizeAlbumFamily(value) {
  let result = normalizeCatalogText(value);
  // Only remove well-known release-marketing suffixes at the end. The core
  // album title remains part of the identity, so unrelated releases do not
  // collapse merely because they share an artist or track title.
  result = result.replace(/\s+(?:(?:19|20)\d{2}\s+)?(?:remaster(?:ed)?|deluxe\s+(?:edition|version)|anniversary\s+edition|expanded\s+(?:edition|version)|reissue|special\s+edition)\s*$/i, "");
  return result.trim();
}

function recordingFormForCatalog(track = {}, version = {}) {
  if (["radio", "edit"].includes(version.kind)) return "radio-edit";
  if (version.kind === "remix") return "remix";
  if (version.kind === "dub") return "dub";
  if (version.kind === "live") return "live";
  if (version.kind === "acoustic") return "acoustic";
  if (version.kind === "remaster") return "remaster";
  if (version.kind === "mixed") return "mixed-dj-set";
  const duration = durationMilliseconds(track);
  if (duration !== null && duration >= 8 * 60 * 1000) return "long-form-club";
  if (duration !== null && duration <= 5 * 60 * 1000) return "short-form";
  return ["extended", "original", "alternate"].includes(version.kind)
    ? "club-mix"
    : duration === null ? "unknown" : "mid-length";
}

function parseCanonicalCatalogIdentity(track = {}) {
  const title = String(track.title || track.name || "").trim();
  const explicitVersion = [track.mixVersion, track.mixName, track.version, track.remix]
    .map(value => String(value || "").trim()).find(Boolean) || "";
  const titleVersion = versionDescriptorFromTitle(title);
  const version = explicitVersion ? classifyVersionText(explicitVersion) : titleVersion;
  const titleWithoutVersion = stripVersionDescriptorFromTitle(title);
  const normalizedBaseTitle = normalizeCatalogText(stripFeaturedArtistText(titleWithoutVersion));
  const normalizedFeaturedArtists = featuredArtistNames(title);
  return {
    normalizedBaseTitle,
    normalizedVersion: version.normalized,
    versionKind: version.kind,
    featuredArtists: normalizedFeaturedArtists,
    normalizedFeaturedArtists,
    version,
    recordingForm: recordingFormForCatalog(track, version),
    normalizedAlbumFamily: normalizeAlbumFamily(track.album || track.releaseTitle || track.release?.title || ""),
    canonicalTitle: normalizeCatalogText([normalizedBaseTitle, version.normalized].filter(Boolean).join(" "))
  };
}

module.exports = {
  foldUnicode,
  normalizeCatalogText,
  splitCreditNames,
  artistCreditValues,
  normalizeArtistCreditName,
  artistCreditKey,
  normalizeArtistCreditNames,
  artistCreditSetKey,
  artistCreditNormalizationRule,
  featuredArtistNames,
  stripFeaturedArtistText,
  classifyVersionText,
  versionDescriptorFromTitle,
  stripVersionDescriptorFromTitle,
  durationMilliseconds,
  normalizeAlbumFamily,
  recordingFormForCatalog,
  parseCanonicalCatalogIdentity
};
