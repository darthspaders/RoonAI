"use strict";

// Only catalogue facts and the matching discovery request may enter a later
// review. Scores, feedback, inferred taste and free-form feedback reasons are
// deliberately absent, including from the fallback for older saved ratings.
function text(value, limit = 240) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function catalogTrack(track = {}) {
  const result = {};
  for (const name of ["artist", "title", "album", "label", "mix", "genre", "releaseDate", "year"]) {
    const value = text(track[name] ?? track.tidal?.[name]);
    if (value) result[name] = value;
  }
  const durationMs = Number(track.durationMs);
  if (Number.isFinite(durationMs) && durationMs > 0 && durationMs <= 86_400_000) result.durationMs = durationMs;
  const tidalId = text(track.tidal?.id || track.tidalId, 80);
  const tidalUrl = text(track.tidal?.tidalUrl || track.tidalUrl, 240);
  if (tidalId) result.tidalId = tidalId;
  if (tidalUrl) result.tidalUrl = tidalUrl;
  result.id = tidalId || tidalUrl || `${result.artist || ""}|${result.title || ""}`;
  return result;
}

function requestOptions(request = {}) {
  const options = {};
  for (const name of ["request", "genres", "years", "mood", "language"]) {
    if (name !== "request" && Array.isArray(request[name])) {
      const values = request[name].slice(0, 16).map(value => text(value, 100)).filter(Boolean);
      if (values.length) options[name] = values;
      continue;
    }
    const value = text(request[name], name === "request" ? 2000 : 300);
    if (value) options[name] = value;
  }
  return options;
}

function providerIdentity(track = {}) {
  const id = text(track.tidal?.id || track.tidalId, 80);
  const rawUrl = text(track.tidal?.tidalUrl || track.tidalUrl, 240);
  let urlId = "";
  try {
    const url = new URL(rawUrl);
    if (/(^|\.)tidal\.com$/i.test(url.hostname)) urlId = url.pathname.match(/\/track\/(\d+)(?:\/|$)/)?.[1] || "";
  } catch (_) {}
  if (id && urlId && id !== urlId) return "conflict";
  return id || urlId ? `tidal:${id || urlId}` : rawUrl ? `url:${rawUrl.toLowerCase()}` : "";
}

function sameCandidate(left = {}, right = {}) {
  if (text(left.artist).toLowerCase() !== text(right.artist).toLowerCase() ||
      text(left.title).toLowerCase() !== text(right.title).toLowerCase()) return false;
  const leftIdentity = providerIdentity(left);
  const rightIdentity = providerIdentity(right);
  return leftIdentity !== "conflict" && rightIdentity !== "conflict" && leftIdentity === rightIdentity;
}

function captureRetrospectiveInput(track = {}, request = {}, snapshotAt = new Date().toISOString()) {
  const options = requestOptions(request);
  const observedAt = Number.isFinite(Date.parse(snapshotAt)) ? text(snapshotAt, 80) : null;
  return {
    schemaVersion: 1,
    snapshotAt: observedAt,
    contextQuality: observedAt && Object.keys(options).length ? "original-request" : "metadata-only",
    track: catalogTrack(track),
    options: observedAt ? options : {}
  };
}

function inputForFeedback(entry = {}) {
  const saved = entry.reviewInput;
  // A saved request must belong to this exact stored candidate, never to the
  // current session or to a different later request.
  if (saved?.schemaVersion === 1 && sameCandidate(saved.track, entry)) {
    return captureRetrospectiveInput(saved.track, saved.options, saved.snapshotAt);
  }
  return captureRetrospectiveInput(entry, {}, entry.updatedAt || entry.calibration?.recordedAt || "");
}

module.exports = { captureRetrospectiveInput, inputForFeedback };
