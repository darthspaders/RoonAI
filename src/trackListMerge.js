"use strict";

const { candidateIdentityKeys } = require("./discoveryEngine");

function mergeTrackLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const track of list || []) {
      const keys = candidateIdentityKeys(track);
      const key = keys[0] || `${track.artist || ""}|${track.title || ""}`.toLowerCase();
      if (!key || seen.has(key)) continue;
      for (const candidateKey of keys) seen.add(candidateKey);
      seen.add(key);
      merged.push(track);
    }
  }
  return merged;
}

module.exports = {
  mergeTrackLists
};
