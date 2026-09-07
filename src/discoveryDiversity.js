"use strict";

const { candidateIdentityKeys } = require("./discoveryEngine");
const {
  normalizeMatchText,
  splitArtistForMatch
} = require("./tidalMatchRules");

function requestAllowsArtistCluster(options = {}) {
  const text = `${options.request || ""} ${options.reference || ""} ${options.genres || ""} ${options.mood || ""}`;
  return /\b(?:same artist|single artist|one artist|artist deep dive|deep dive on|discography|catalogue|catalog|all .* by|only .* by|more from)\b/i.test(text);
}

function artistDiversityKey(track = {}) {
  return splitArtistForMatch(track.artist || track.tidal?.artist || "")[0] || normalizeMatchText(track.artist || track.tidal?.artist || "");
}

function albumDiversityKey(track = {}) {
  return normalizeMatchText(track.album || track.tidal?.album || "");
}

function trackDiversityKey(track = {}) {
  const keys = candidateIdentityKeys(track);
  return keys[0] || `${artistDiversityKey(track)}|${normalizeMatchText(track.title || track.tidal?.title || "")}`;
}

function diversifyCandidates(candidates = [], requestedCount = 10, options = {}) {
  const allowCluster = requestAllowsArtistCluster(options);
  const selected = [];
  const selectedKeys = new Set();
  const artistCounts = new Map();
  const albumCounts = new Map();
  const stages = allowCluster
    ? [{ artist: Math.max(4, requestedCount), album: Math.max(3, Math.ceil(requestedCount / 2)) }]
    : [
      { artist: requestedCount <= 12 ? 1 : 2, album: 1 },
      { artist: requestedCount <= 12 ? 2 : 3, album: 2 },
      { artist: requestedCount <= 12 ? 3 : 4, album: 3 }
    ];

  function addCandidate(candidate, caps) {
    if (selected.length >= requestedCount) return false;
    const key = trackDiversityKey(candidate);
    if (!key || selectedKeys.has(key)) return false;
    const artistKey = artistDiversityKey(candidate);
    const albumKey = albumDiversityKey(candidate);
    const artistCount = artistCounts.get(artistKey) || 0;
    const albumCount = albumKey ? (albumCounts.get(albumKey) || 0) : 0;
    if (artistKey && artistCount >= caps.artist) return false;
    if (albumKey && albumCount >= caps.album) return false;
    selected.push(candidate);
    selectedKeys.add(key);
    if (artistKey) artistCounts.set(artistKey, artistCount + 1);
    if (albumKey) albumCounts.set(albumKey, albumCount + 1);
    return true;
  }

  for (const caps of stages) {
    for (const candidate of candidates) addCandidate(candidate, caps);
    if (selected.length >= requestedCount) break;
  }

  for (const candidate of candidates) {
    if (selected.length >= requestedCount) break;
    addCandidate(candidate, { artist: Number.MAX_SAFE_INTEGER, album: Number.MAX_SAFE_INTEGER });
  }

  return {
    tracks: selected,
    alternates: candidates.filter((candidate) => !selectedKeys.has(trackDiversityKey(candidate))),
    artistSpread: artistCounts.size,
    albumSpread: albumCounts.size,
    relaxed: selected.length < Math.min(requestedCount, candidates.length)
  };
}

module.exports = {
  albumDiversityKey,
  artistDiversityKey,
  diversifyCandidates,
  requestAllowsArtistCluster,
  trackDiversityKey
};
