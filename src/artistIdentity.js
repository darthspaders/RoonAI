"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeArtistName(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasDiacritics(value = "") {
  const text = cleanText(value);
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "") !== text.normalize("NFKD");
}

function letterNumberCount(value = "") {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .length;
}

function isDottedAcronym(value = "") {
  const text = cleanText(value).normalize("NFC");
  if (!/[.·]/.test(text)) return false;
  const count = letterNumberCount(text);
  return count >= 2 && count <= 5;
}

function strictArtistFingerprint(value = "") {
  const text = cleanText(value)
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();

  if (isDottedAcronym(text)) return text.replace(/[.·]+$/g, "");
  return text;
}

function isCollisionSensitiveArtist(value = "") {
  return Boolean(cleanText(value) && (hasDiacritics(value) || isDottedAcronym(value)));
}

function artistIdentityKey(value = "") {
  const strict = strictArtistFingerprint(value);
  if (!strict) return "";
  return isCollisionSensitiveArtist(value) ? `strict:${strict}` : normalizeArtistName(value);
}

function artistNameCollisionRisk(left = "", right = "") {
  const leftLoose = normalizeArtistName(left);
  const rightLoose = normalizeArtistName(right);
  if (!leftLoose || leftLoose !== rightLoose) return false;
  if (strictArtistFingerprint(left) === strictArtistFingerprint(right)) return false;
  return isCollisionSensitiveArtist(left) || isCollisionSensitiveArtist(right);
}

function startsWithArtistBoundary(haystack = "", needle = "") {
  if (!needle || !haystack.startsWith(needle)) return false;
  const next = haystack.slice(needle.length, needle.length + 1);
  return !next || /[\s.·,/&+\-]/.test(next);
}

function artistNamesMatch(left = "", right = "", { contains = false } = {}) {
  const leftKey = artistIdentityKey(left);
  const rightKey = artistIdentityKey(right);
  if (!leftKey || !rightKey) return false;
  if (artistNameCollisionRisk(left, right)) return false;
  if (isCollisionSensitiveArtist(left) || isCollisionSensitiveArtist(right)) {
    if (leftKey === rightKey) return true;
    if (!contains) return false;
    const leftStrict = strictArtistFingerprint(left);
    const rightStrict = strictArtistFingerprint(right);
    return startsWithArtistBoundary(leftStrict, rightStrict) || startsWithArtistBoundary(rightStrict, leftStrict);
  }

  const leftLoose = normalizeArtistName(left);
  const rightLoose = normalizeArtistName(right);
  if (leftLoose === rightLoose) return true;
  return Boolean(contains && (leftLoose.includes(rightLoose) || rightLoose.includes(leftLoose)));
}

function flatten(values = []) {
  const result = [];
  for (const value of values) {
    if (Array.isArray(value)) result.push(...flatten(value));
    else if (value !== undefined && value !== null) result.push(value);
  }
  return result;
}

function providerArtistIds(track = {}) {
  const artists = [
    track.artistId,
    track.artist_id,
    track.artistIds,
    track.artist_ids,
    track.artists?.map((artist) => artist?.id || artist?.artistId || artist?.artist_id),
    track.tidal?.artistId,
    track.tidal?.artist_id,
    track.tidal?.artistIds,
    track.tidal?.artist_ids,
    track.tidal?.artists?.map((artist) => artist?.id || artist?.artistId || artist?.artist_id),
    track.roon?.artistId,
    track.roon?.artist_id,
    track.roon?.artistIds,
    track.roon?.artist_ids,
    track.roon?.artists?.map((artist) => artist?.id || artist?.artistId || artist?.artist_id)
  ];

  return [...new Set(flatten(artists).map(cleanText).filter(Boolean))];
}

function artistIdentityKeysForTrack(track = {}, splitArtists = null) {
  const ids = providerArtistIds(track).map((id) => `provider:${id}`);
  if (ids.length) return ids;

  const artists = typeof splitArtists === "function" ? splitArtists(track.artist) : [track.artist];
  const keys = artists.map(artistIdentityKey).filter(Boolean);
  if (!keys.length) {
    const fallback = artistIdentityKey(track.artist);
    if (fallback) keys.push(fallback);
  }
  return [...new Set(keys)];
}

module.exports = {
  artistIdentityKey,
  artistIdentityKeysForTrack,
  artistNameCollisionRisk,
  artistNamesMatch,
  cleanText,
  isCollisionSensitiveArtist,
  normalizeArtistName,
  providerArtistIds,
  strictArtistFingerprint
};
