"use strict";

const { normalizeMatchText } = require("./tidalMatchRules");

function scoreWithRoonFloor(breakdown = {}) {
  const floor = 70;
  if (Number(breakdown.total || 0) >= floor) return breakdown;

  const max = breakdown.max || {};
  const boosted = { ...breakdown };
  let remaining = floor - Number(boosted.total || 0);
  function addTo(field) {
    const current = Number(boosted[field] || 0);
    const cap = Number(max[field] || current);
    const add = Math.max(0, Math.min(remaining, cap - current));
    boosted[field] = current + add;
    remaining -= add;
  }

  addTo("genreMatch");
  addTo("artistMatch");
  addTo("labelMatch");
  boosted.total = Math.min(100, Number(boosted.freshness || 0) + Number(boosted.labelMatch || 0) + Number(boosted.artistMatch || 0) + Number(boosted.lengthPreference || 0) + Number(boosted.genreMatch || 0) + Number(boosted.tasteAdjustment || 0));
  if (boosted.total < floor) boosted.total = floor;
  return boosted;
}

function roonRescueSceneAnchor(track = {}) {
  const query = String(track.query || "");
  const match = query.match(/^(.+?)\s+(?:progressive house|progressive trance|melodic progressive|deep progressive|organic progressive|trance|20\d{2}|hypnotic|driving|late night|tribal|funky|dark|deep)\b/i);
  const anchor = match ? match[1].trim() : "";
  const key = normalizeMatchText(anchor);
  if (!key || (key.length < 6 && !key.includes(" "))) return "";
  if (/^(?:various artists?|unknown artist|house music|techno music|trance music|progressive house|progressive trance|deep house|melodic house|organic house)$/i.test(anchor)) return "";
  const artistParts = String(track.artist || "")
    .split(/\s*(?:,|\/|&|\+|\band\b)\s*/i)
    .map((part) => normalizeMatchText(part))
    .filter(Boolean);
  const album = normalizeMatchText(track.album || "");
  const artistMatches = key.includes(" ")
    ? artistParts.some((part) => part === key || part.includes(key))
    : artistParts.some((part) => part === key);
  if (artistMatches) return anchor;
  return key.includes(" ") && album.includes(key) ? anchor : "";
}

module.exports = {
  roonRescueSceneAnchor,
  scoreWithRoonFloor
};
