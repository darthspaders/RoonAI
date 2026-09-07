"use strict";

const { tidalTrackIdFromUrl } = require("./tidalIdentity");

function displayText(value) {
  return String(value || '').replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '$1');
}

function normalize(value) {
  return displayText(value).normalize("NFKD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[’'`]/g, "").replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function artists(value) {
  return displayText(value).split(/\s*(?:,|&|\s\/\s|\band\b|\bfeat\.?|\bfeaturing\b)\s*/i)
    .map(normalize).filter(Boolean).sort().join("|");
}

function parseTrack(input) {
  if (typeof input === "string") {
    const text = input.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    const match = text.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    return match ? { artist: match[1].trim(), title: match[2].trim() } : { title: text };
  }
  const track = { ...(input || {}) };
  track.artist = track.artist || (Array.isArray(track.artists) ? track.artists.map(a => typeof a === "string" ? a : a.name).filter(Boolean).join(", ") : "");
  track.title = track.title || track.name || "";
  const version = track.version || track.remix;
  if (version && !normalize(track.title).includes(normalize(version))) track.title += ` (${version})`;
  return track;
}

function exactIntent(input = {}) {
  const text = [input.request, input.message, input.reference].filter(Boolean).join("\n");
  if (input.intent?.type !== "exact_track_verification" && input.mode !== "exact_track_verification" &&
      !/\b(?:verify|verification|validate|check|confirm|make sure)\b/i.test(text)) return null;
  const tracks = Array.isArray(input.tracks) ? parseTrackList(input.tracks) : parseTrackList(input.tracks || text);
  return tracks.length ? { type: "exact_track_verification", tracks } : null;
}

function parseTrackList(input) {
  if (Array.isArray(input)) return input.every(item => typeof item === "string") ? parseTrackList(input.join("\n")) : input.flatMap(item => typeof item === "string" ? parseTrackList(item) : [parseTrack(item)]);
  const result = [];
  for (let line of String(input || "").split(/\r?\n|;/)) {
    line = line.trim();
    if (!line) continue;
    // Strip only explicit instruction prefixes; never infer an artist from prose.
    line = line.replace(/^(?:please\s+)?(?:verify|check|confirm|validate)\b[^:\n]*:\s*/i, "")
      .replace(/^(?:please\s+)?(?:verify|check|confirm|validate)\s+(?:(?:these|the|following|exact|tracks?|availability|of)\s+)*/i, "");
    const prose = /[.!?]\s+(?=(?:please\s+)?(?:preserve|do not|don't|keep|make sure|only queue|then queue|verify|check|return|report)\b)/i.exec(line);
    if (prose) line = line.slice(0, prose.index);
    const track = parseTrack(line);
    const valid = track.artist && track.title && !/\b(?:verify|verification|check|confirm|preserve|following|please|must|should)\b|^(?:do not|don't|keep|return|report|then)\b/i.test(track.artist);
    if (!valid) { if (result.length) break; continue; }
    result.push(track);
    if (prose) break;
  }
  return result;
}

function baseTitle(title) {
  return normalize(String(title || "").replace(/\s*(?:\([^)]*(?:mix|remix|edit|version|dub|live)[^)]*\)|\s+-\s+.*(?:mix|remix|edit|version|dub|live).*)\s*$/i, ""));
}

function exactMatch(requested, matched) {
  return artists(requested.artist) === artists(matched.artist) &&
    normalize(requested.title) === normalize(matched.title);
}

function chooseExact(requested, candidates) {
  let matches = candidates.filter(t => exactMatch(requested, t));
  if (requested.album && matches.some(t => normalize(t.album) === normalize(requested.album))) {
    matches = matches.filter(t => normalize(t.album) === normalize(requested.album));
  }
  if (requested.releaseDate) matches = matches.filter(t => String(t.releaseDate).slice(0, 10) === String(requested.releaseDate).slice(0, 10));
  if (requested.year) matches = matches.filter(t => Number(t.year || String(t.releaseDate).slice(0, 4)) === Number(requested.year));
  matches = [...new Map(matches.map(t => [t.id || t.tidalUrl, t])).values()];
  if (matches.length > 1) return { status: "AMBIGUOUS", matches };
  if (matches.length === 1) return { status: "VERIFIED_TIDAL_ONLY", match: matches[0] };
  return { status: candidates.some(t => artists(t.artist) === artists(requested.artist) && baseTitle(t.title) === baseTitle(requested.title)) ? "VERSION_MISMATCH" : "NOT_FOUND" };
}

function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
}

async function abortable(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      onAbort = () => reject(new Error("Verification timed out."));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

async function verifyExactTracks(body, { tidal, roon, logger = () => {} }) {
  const raw = parseTrackList(body.tracks || body.candidates || body.request || "");
  if (!Array.isArray(raw) || !raw.length) throw Object.assign(new Error("Provide at least one track to verify."), { statusCode: 400 });
  const requested = raw.slice(0, bounded(body.max, 40, 1, 40)).map(parseTrack);
  const results = new Array(requested.length);
  const timeoutMs = bounded(body.perTrackTimeoutMs, 12000, 100, 30000);
  const concurrency = bounded(body.concurrency, 3, 1, 4);
  const checkRoon = body.checkRoon === true || body.checkRoon === "true" || body.requireRoonQueueable === true || body.requireRoonQueueable === "true";
  let next = 0;
  async function verify(index) {
    const request = requested[index];
    const row = { index, input: request, requestedArtist: request.artist || "", requestedTitle: request.title || "", status: "NOT_FOUND", verdict: "unverified", usable: false, versionExact: false, queueable: null, confidence: 0, error: "", tidal: { verified: false }, roon: { checked: false, queueable: null } };
    const id = String(request.tidalTrackId || request.id || tidalTrackIdFromUrl(request.tidalUrl || request.url) || "");
    if (!(request.artist && request.title) && !/^\d+$/.test(id)) {
      return { ...row, status: "INVALID", verdict: "invalid", reasons: ["Track needs artist/title or a TIDAL track URL/id."] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let selected;
    try {
      if (!tidal.isConfigured()) throw new Error("TIDAL catalogue verification is not configured.");
      const candidates = await abortable(tidal.searchExactCandidates(request, { id, signal: controller.signal, timeoutMs, logger }), controller.signal);
      selected = request.artist && request.title ? chooseExact(request, candidates) : candidates.length === 1 ? { status: "VERIFIED_TIDAL_ONLY", match: candidates[0] } : { status: "NOT_FOUND" };
      row.searchVariants = [id ? "tidal_id" : "exact_artist_title"];
      const fallbackTitle = baseTitle(request.title);
      if (!id && ["NOT_FOUND", "VERSION_MISMATCH"].includes(selected.status) && fallbackTitle && fallbackTitle !== normalize(request.title)) {
        row.searchVariants.push("artist_base_title");
        const fallback = await abortable(tidal.searchExactCandidates({ ...request, title: fallbackTitle }, {
          signal: controller.signal, timeoutMs,
          logger: entry => logger({ ...entry, track: { artist: request.artist, title: request.title }, searchVariant: "artist_base_title" })
        }), controller.signal);
        // Only the query changes. The original full artist/title/version remains authoritative.
        selected = chooseExact(request, [...candidates, ...fallback]);
      }
    } catch (error) {
      return { ...row, status: "API_ERROR", verdict: "tidal_error", error: controller.signal.aborted ? "TIDAL verification timed out." : error.message, reasons: [controller.signal.aborted ? "TIDAL verification timed out." : error.message] };
    } finally { clearTimeout(timer); }
    row.status = selected.status;
    row.verdict = selected.status.toLowerCase();
    if (!selected.match) return { ...row, matches: selected.matches || [] };
    const track = selected.match;
    Object.assign(row, { track, matchedArtist: track.artist, matchedTitle: track.title, album: track.album, durationMs: track.durationMs, releaseDate: track.releaseDate, tidalTrackId: track.id, tidalUrl: track.tidalUrl, confidence: 1, versionExact: true, usable: true, verdict: "verified", tidal: { verified: true, match: track } });
    const minDuration = Number(body.minDurationMs || Number(body.minDurationSeconds || 0) * 1000 || Number(body.minDurationMinutes || 0) * 60000);
    if (minDuration && !(track.durationMs >= minDuration)) return { ...row, usable: false, status: "DURATION_MISMATCH", verdict: "duration_too_short" };
    row.status = "TIDAL_VERIFIED_ROON_PENDING";
    row.roon = { checked: false, queueable: null, zoneId: body.zoneId || "", reason: "Exact TIDAL identity saved. Roon resolution has not been requested.", failureType: "not_checked" };
    return row;
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requested.length) }, async () => {
    while (next < requested.length) { const index = next++; results[index] = await verify(index); }
  }));
  const usable = results.filter(t => t.usable).map(t => ({ ...t.track, exactVerification: true }));
  const result = { mode: "exact_track_verification", latestResultSource: "exact_verification", requestedCount: raw.length, parsedCount: raw.length, checkedCount: results.length, truncated: raw.length > requested.length, verifiedCount: results.filter(t => t.tidal.verified).length, usableCount: usable.length, roonQueueableCount: 0, notFoundCount: results.filter(t => t.status === "NOT_FOUND").length, versionMismatchCount: results.filter(t => t.status === "VERSION_MISMATCH").length, apiErrorCount: results.filter(t => t.status === "API_ERROR").length, errorCount: results.filter(t => t.status === "API_ERROR").length, tracks: results, usable };
  if (checkRoon) await require("./roonExactResolution").resolveVerifiedTracksForRoon(result, body, { roon, logger });
  return result;
}

const exactQueueTails = new WeakMap();
function queueExactTracks(result, input = {}, roon, dependencies = {}) {
  if (!result?.tracks) return Promise.reject(Object.assign(new Error("No saved exact verification result."), { statusCode: 400 }));
  const work = (exactQueueTails.get(result) || Promise.resolve()).catch(() => {}).then(() => queueExactBatch(result, input, roon, dependencies));
  exactQueueTails.set(result, work.catch(() => {}));
  return work;
}
async function queueExactBatch(result, input, roon, { save = () => {}, logger = () => {}, bridge } = {}) {
  if (input.mode && input.mode !== "append") throw Object.assign(new Error("Exact verified queue currently supports append only."), { statusCode: 400 });
  let rows = result.tracks.filter(row => row.usable && row.tidal?.verified);
  if (Array.isArray(input.trackIds)) rows = rows.filter(row => input.trackIds.map(String).includes(String(row.tidalTrackId)));
  rows = rows.slice(0, bounded(input.count, 40, 1, 40));
  if (!rows.length) throw Object.assign(new Error("No saved usable TIDAL-verified tracks."), { statusCode: 400 });
  const alreadyQueuedCount = rows.filter(row => row.queuedAt).length;
  const uncertain = rows.filter(row => row.queueAttemptedAt && !row.queuedAt);
  const pending = rows.filter(row => !row.queuedAt && !row.queueAttemptedAt);
  const zoneId = input.zoneId || pending[0]?.roon?.zoneId;
  const resolve = require("./roonExactResolution").resolveVerifiedTracksForRoon;
  await resolve(result, { ...input, zoneId, trackIds: pending.map(row => String(row.tidalTrackId)), allowBridge: input.allowBridge !== false }, { roon, save, logger, bridge });
  const ready = pending.filter(row => row.queueable === true && row.roon?.queueToken);
  const failed = [...pending.filter(row => !ready.includes(row)), ...uncertain].map(row => ({
    index: row.index, tidalTrackId: row.tidalTrackId, artist: row.matchedArtist, title: row.matchedTitle,
    status: row.status, error: row.queueAttemptedAt ? "Previous queue action outcome is uncertain; inspect Roon before resending." : row.bridge?.reason || row.roon?.reason || row.status,
    bridge: row.bridge || null
  }));
  const queued = [];
  if (ready.length) {
    const tracks = ready.map(row => ({ ...row.track, exactVerification: true, verifiedQueueToken: row.roon.queueToken }));
    const response = await roon.queueTracks(tracks, zoneId, {
      mode: "append", targetCount: tracks.length, preferExtendedMixes: false,
      onQueueStart: (_track, index) => { ready[index].queueAttemptedAt = new Date().toISOString(); save(result); },
      onQueueResult: (index, ok) => {
        if (ok) { ready[index].queuedAt = new Date().toISOString(); ready[index].status = "ROON_QUEUED"; ready[index].queueable = false; }
        save(result);
      }
    });
    for (const item of response.queued || []) {
      const row = ready[item.index]; row.queuedAt ||= new Date().toISOString(); row.status = "ROON_QUEUED"; row.queueable = false;
      queued.push({ index: row.index, tidalTrackId: row.tidalTrackId, artist: row.matchedArtist, title: row.matchedTitle, action: item.action });
    }
    for (const item of response.failed || []) {
      const row = ready[item.index]; failed.push({ index: row.index, tidalTrackId: row.tidalTrackId, artist: row.matchedArtist, title: row.matchedTitle, error: item.reason });
    }
  }
  result.roonQueueableCount = result.tracks.filter(row => row.queueable === true).length;
  save(result);
  return { source: "exact_verification", requestedToQueue: rows.length, alreadyQueuedCount, queued: queued.length, failed: failed.length,
    queuedCount: queued.length, failedCount: failed.length, queuedTracks: queued, failedTracks: failed };
}

module.exports = { displayText, normalize, artists, parseTrack, parseTrackList, exactIntent, exactMatch, chooseExact, verifyExactTracks, queueExactTracks };
