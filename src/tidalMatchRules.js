"use strict";

function normalizeMatchText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function boundedEditDistance(left, right, maxDistance) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length];
}

function artistNameLooksClose(left, right) {
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return true;
  const maxLength = Math.max(left.length, right.length);
  const minLength = Math.min(left.length, right.length);
  if (minLength < 6) return false;
  const maxDistance = maxLength >= 10 ? 2 : 1;
  if (Math.abs(left.length - right.length) > maxDistance) return false;
  if (left.slice(0, 3) !== right.slice(0, 3)) return false;
  return boundedEditDistance(left, right, maxDistance) <= maxDistance;
}

function baseTitleForMatch(value) {
  return normalizeMatchText(String(value || "")
    .replace(/\s*[\[(][^\])]*(?:mix|remix|edit|version|rework|dub|rerub|original|extended)[^\])]*[\])]/gi, " ")
    .replace(/\s+/g, " "));
}

function splitArtistForMatch(value) {
  return String(value || "")
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map(normalizeMatchText)
    .filter((part) => part && part.length > 1);
}

const GENERIC_VERSION_WORDS = new Set([
  "mix",
  "remix",
  "remixes",
  "edit",
  "version",
  "extended",
  "original",
  "radio",
  "club",
  "dub",
  "instrumental",
  "vip"
]);

function versionDescriptorTokens(value = "") {
  const descriptors = [];
  for (const match of String(value || "").matchAll(/[\[(]([^\])]+)[\])]/g)) {
    descriptors.push(match[1]);
  }
  const text = normalizeMatchText(descriptors.join(" "));
  if (!text) return [];
  return Array.from(new Set(text
    .split(/\s+/)
    .filter((token) => token.length > 1 && !GENERIC_VERSION_WORDS.has(token))));
}

function playlistTitleMatches(track = {}, verified = {}) {
  const targetTitle = normalizeMatchText(track.title);
  const actualTitle = normalizeMatchText(verified.title);
  if (!targetTitle || !actualTitle) return false;
  if (targetTitle === actualTitle) return true;

  const targetBase = baseTitleForMatch(track.title);
  const actualBase = baseTitleForMatch(verified.title);
  if (!targetBase || targetBase !== actualBase) return false;

  const targetDescriptors = versionDescriptorTokens(track.title);
  if (!targetDescriptors.length) return false;
  return targetDescriptors.every((token) => actualTitle.includes(token));
}

function durationLooksClose(track = {}, verified = {}) {
  const target = Number(track.durationMs || 0);
  const actual = Number(verified.durationMs || 0);
  if (!target || !actual) return false;
  const difference = Math.abs(target - actual);
  return difference <= Math.max(15_000, Math.round(Math.min(target, actual) * 0.06));
}

function weakTidalArtistHint(value = "") {
  const text = normalizeMatchText(value);
  if (!text) return true;
  return /\b(?:unknown artist|various artists?|collection|compilation|playlist|soundtrack|album|volume|vol|top tracks?|selected|selection)\b/.test(text);
}

function albumHintMatches(track = {}, verified = {}) {
  const album = normalizeMatchText(track.album);
  const verifiedAlbum = normalizeMatchText(verified.album);
  if (!album || !verifiedAlbum) return false;
  return album === verifiedAlbum || album.includes(verifiedAlbum) || verifiedAlbum.includes(album);
}

function tidalEnrichmentMatches(track = {}, verified = {}) {
  const targetTitle = normalizeMatchText(track.title);
  const actualTitle = normalizeMatchText(verified.title);
  const targetBase = baseTitleForMatch(track.title);
  const actualBase = baseTitleForMatch(verified.title);
  const titleOk = Boolean(
    targetTitle &&
    actualTitle &&
    (targetTitle === actualTitle || (targetBase && targetBase === actualBase))
  );
  const targetArtists = splitArtistForMatch(track.artist);
  const actualArtists = splitArtistForMatch(verified.artist);
  const artistOk = Boolean(
    targetArtists.length &&
    actualArtists.length &&
    targetArtists.some((target) => actualArtists.some((actual) => artistNameLooksClose(target, actual)))
  );
  return titleOk && artistOk;
}

function tidalPlaylistFallbackMatches(track = {}, verified = {}) {
  if (!playlistTitleMatches(track, verified)) return false;
  if (tidalEnrichmentMatches(track, verified)) return true;
  return weakTidalArtistHint(track.artist) || albumHintMatches(track, verified) || durationLooksClose(track, verified);
}

module.exports = {
  albumHintMatches,
  artistNameLooksClose,
  baseTitleForMatch,
  boundedEditDistance,
  durationLooksClose,
  normalizeMatchText,
  playlistTitleMatches,
  splitArtistForMatch,
  tidalEnrichmentMatches,
  tidalPlaylistFallbackMatches,
  versionDescriptorTokens,
  weakTidalArtistHint
};
