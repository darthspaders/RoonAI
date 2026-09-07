"use strict";

const { normalize, artists } = require("./exactTrackVerification");
const tails = new WeakMap();

function roonIdentityEvidence(track, item = {}) {
  const title = item.title || "";
  const credit = item.artist || String(item.subtitle || "").split(/\s+-\s+/)[0];
  const wanted = artists(track.artist).split("|").filter(Boolean);
  const credited = artists(credit).split("|");
  const titleExact = normalize(title) === normalize(track.title);
  const artistExact = wanted.length > 0 && wanted.every(name => credited.includes(name));
  const tidalId = String(item.tidalTrackId || item.tidal?.id || "");
  const isrc = String(item.isrc || "");
  const durationMs = Number(item.durationMs || (item.length ? item.length * 1000 : 0));
  const idConflict = tidalId && tidalId !== String(track.id || track.tidalTrackId);
  const isrcConflict = isrc && track.isrc && normalize(isrc) !== normalize(track.isrc);
  const durationConflict = durationMs && track.durationMs && Math.abs(durationMs - track.durationMs) > 2000;
  const albumExact = Boolean(item.album && track.album && normalize(item.album) === normalize(track.album));
  return { accepted: Boolean(titleExact && artistExact && !idConflict && !isrcConflict && !durationConflict), titleExact, artistExact,
    tidalIdCompared: Boolean(tidalId), isrcCompared: Boolean(isrc && track.isrc), durationCompared: Boolean(durationMs && track.durationMs), albumExact,
    additionalArtistCredits: artistExact && credited.length > wanted.length,
    failureType: !titleExact ? "version_mismatch" : !artistExact ? "artist_mismatch" : (idConflict || isrcConflict || durationConflict) ? "identity_mismatch" : "",
    score: (tidalId && !idConflict ? 100 : 0) + (isrc && !isrcConflict ? 80 : 0) + (albumExact ? 20 : 0) + (durationMs && !durationConflict ? 10 : 0) };
}

function queriesFor(track) {
  const base = String(track.title).replace(/\s*\([^)]*(?:mix|remix|edit|version)[^)]*\)\s*$/i, "");
  return [...new Set([`${track.artist} ${track.title}`, `${normalize(track.artist)} ${normalize(base)}`, normalize(track.title)])];
}

function deadline(promise, signal) {
  signal.throwIfAborted();
  let abort;
  return Promise.race([promise, new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error("Roon exact resolution timed out."), { code: "ETIMEDOUT" }));
    signal.addEventListener("abort", abort, { once: true });
  })]).finally(() => signal.removeEventListener("abort", abort));
}

async function resolveOne(row, input, roon, logger) {
  const track = row.track;
  const zoneId = input.zoneId || row.roon?.zoneId || "";
  if (!zoneId) {
    row.status = "ROON_NOT_FOUND";
    row.queueable = null;
    row.roon = { checked: false, queueable: null, failureType: "no_zone", reason: "Select a Roon zone before resolving this exact track.", retryCount: 0, zoneId };
    return;
  }
  const timeoutMs = Math.max(100, Math.min(30000, Number(input.roonTimeoutMs) || 12000));
  const retries = Math.max(0, Math.min(2, Number.isFinite(Number(input.retries)) ? Number(input.retries) : 2));
  const queries = queriesFor(track).slice(0, 1 + retries);
  const attempts = [];
  let check = null;
  for (const [retryCount, query] of queries.entries()) {
    const startedAt = new Date().toISOString(), started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    logger({ event: "roon_search_start", tidalTrackId: row.tidalTrackId, title: track.title, startedAt, retryCount, query });
    try {
      check = await deadline(roon.canQueueTrack({ ...track, exactVerification: true }, zoneId, {
        exactVerification: true, exactResolution: true, query, signal: controller.signal, preferExtendedMixes: false
      }), controller.signal);
    } catch (error) {
      check = { success: false, failureType: controller.signal.aborted || error.code === "ETIMEDOUT" ? "timeout" : "error", reason: error.message };
    } finally { clearTimeout(timer); }
    const attempt = { startedAt, durationMs: Date.now() - started, query, resultCount: check.resultCount ?? null,
      exactMatchFound: Boolean(check.identityEvidence?.accepted || check.success), retryCount, queueTokenCreated: Boolean(check.queueToken), failureType: check.failureType || (check.success ? "" : "not_found"), reason: check.reason || "" };
    attempts.push(attempt);
    logger({ event: "roon_search_end", tidalTrackId: row.tidalTrackId, ...attempt });
    if (check.success) break;
  }
  const success = Boolean(check?.success);
  // A timeout leaves an unresolved possibility; it must not turn into a definitive miss.
  const failureType = success ? "" : attempts.some(a => a.failureType === "timeout") ? "timeout"
    : attempts.some(a => a.exactMatchFound) ? "no_queue_action" : attempts.some(a => a.failureType === "version_mismatch") ? "version_mismatch" : check?.failureType || "not_found";
  row.status = success ? "ROON_QUEUEABLE" : failureType === "timeout" ? "ROON_TIMEOUT"
    : failureType === "version_mismatch" ? "ROON_VERSION_MISMATCH" : "ROON_NOT_FOUND";
  row.queueable = success ? true : failureType === "timeout" ? null : false;
  row.roon = { checked: true, roonResolved: success, queueable: row.queueable, queueToken: check?.queueToken || "", zoneId,
    match: check?.match || null, identityEvidence: check?.identityEvidence || null, failureType,
    resolutionMethod: check?.resolutionMethod || '', albumFallback: check?.albumFallback || null,
    reason: success ? "Exact Roon track and queue action resolved." : failureType === "timeout" ? "At least one bounded Roon lookup timed out; saved TIDAL identity remains retryable." : check?.reason || "No exact Roon match.",
    retryCount: attempts.length - 1, attempts, durationMs: attempts.reduce((sum, a) => sum + a.durationMs, 0) };
  row.bridge = { available: false, state: "TIDAL_VERIFIED_BRIDGE_UNAVAILABLE", reason: "No verified Roon-visible bridge action. Direct resolution was attempted first; no playlist was created." };
  logger({ event: "roon_resolution_final", tidalTrackId: row.tidalTrackId, finalState: row.status, queueTokenCreated: success, retryCount: row.roon.retryCount, durationMs: row.roon.durationMs });
}

async function resolveVerifiedTracksForRoon(result, input = {}, { roon, logger = () => {}, save = () => {}, bridge }) {
  if (!result?.tracks) throw Object.assign(new Error("No saved exact verification result."), { statusCode: 400 });
  const selectedIds = Array.isArray(input.trackIds) ? new Set(input.trackIds.map(String)) : null;
  const selectRows = () => result.tracks.filter(row => row.tidal?.verified && row.usable && !row.queuedAt && !row.queueAttemptedAt && (!selectedIds || selectedIds.has(String(row.tidalTrackId))) &&
    !(row.queueable && row.roon?.queueToken && (!input.zoneId || input.zoneId === row.roon.zoneId) && roon.hasVerifiedQueueAction?.(row.roon.queueToken)));
  const work = (tails.get(roon) || Promise.resolve()).catch(() => {}).then(async () => {
    const rows = selectRows();
    // Per-track deadlines start here, after waiting for previous resolution work.
    for (const row of rows) {
      row.status = "ROON_RESOLVING";
      save(result);
      await resolveOne(row, input, roon, logger);
      if (!row.queueable && input.allowBridge !== false && bridge) {
        try {
          const resolved = await bridge.resolve(row, input);
          row.bridge = { available: true, state: "TIDAL_VERIFIED_BRIDGE_AVAILABLE", playlistId: resolved.playlistId, title: resolved.title, sync: resolved.sync || null };
          row.status = "TIDAL_VERIFIED_BRIDGE_AVAILABLE";
          row.queueable = true;
          row.roon = { ...row.roon, directFailureType: row.roon.failureType, failureType: "", queueable: true, roonResolved: true, queueToken: resolved.queueToken, match: resolved.match, reason: "Exact verified bridge track and Roon queue action resolved." };
        } catch (error) {
          row.status = "TIDAL_VERIFIED_BRIDGE_UNAVAILABLE";
          row.bridge = {
            available: false,
            state: row.status,
            reason: error.message,
            sync: error.bridgeSync || null,
            requiresManualRefresh: Boolean(error.bridgeSync?.requiresManualRefresh)
          };
        }
        logger({ event: "roon_bridge_final", tidalTrackId: row.tidalTrackId, finalState: row.status, reason: row.bridge.reason || "", queueTokenCreated: Boolean(row.queueable) });
      }
      result.roonQueueableCount = result.tracks.filter(row => row.queueable === true).length; save(result);
    }
    result.roonQueueableCount = result.tracks.filter(row => row.queueable === true).length;
    result.roonResolution = { attemptedCount: rows.length, queueableCount: rows.filter(row => row.queueable).length,
      tracks: rows.map(row => ({ tidalTrackId: row.tidalTrackId, artist: row.matchedArtist, title: row.matchedTitle, status: row.status, bridge: row.bridge, ...row.roon })) };
    save(result);
    return result;
  });
  tails.set(roon, work.catch(() => {}));
  return work;
}

module.exports = { roonIdentityEvidence, queriesFor, resolveVerifiedTracksForRoon };
