"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalize } = require("./exactTrackVerification");

class ExactRoonBridge {
  constructor({ profile, roon, file, syncDelaysMs, playlistLookupTimeoutMs, internalTidalSync }) {
    Object.assign(this, {
      profile,
      roon,
      file,
      pendingFile: path.join(path.dirname(file), "exact-bridge-pending.json"),
      internalTidalSync,
      syncDelaysMs: normalizeDelays(syncDelaysMs),
      playlistLookupTimeoutMs: boundMs(playlistLookupTimeoutMs, 15000, 1000, 60000)
    });
    this.tail = Promise.resolve();
  }
  resolve(row, input = {}) {
    const work = this.tail.catch(() => {}).then(() => this.resolveNow(row, input));
    this.tail = work.catch(() => {});
    return work;
  }
  async resolveNow(row, input) {
    const batch = await this.resolveBatchNow([row], input);
    const result = batch.results[0];
    if (result?.success) return result;
    const error = new Error(result?.reason || "Exact bridge track is not visible in Roon yet.");
    error.code = "EROON_BRIDGE_SYNC_PENDING";
    error.bridgeSync = result?.sync || null;
    throw error;
  }
  resolveBatch(rows = [], input = {}) {
    const work = this.tail.catch(() => {}).then(() => this.resolveBatchNow(rows, input));
    this.tail = work.catch(() => {});
    return work;
  }
  async resolveBatchNow(rows, input) {
    const title = "Rabbit Hole Exact Verification Bridge";
    if (!this.profile.isConfigured()) throw new Error("TIDAL profile writes are not configured; bridge unavailable.");
    let saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {};
    if (!saved.playlistId) {
      const collection = await this.profile.getUserPlaylists({ force: true });
      if (!collection.connected) throw new Error("Cannot list TIDAL playlists safely; refusing to create a possible duplicate bridge.");
      const matches = collection.playlists.filter(p => normalize(p.title) === normalize(title));
      if (matches.length > 1) throw new Error("Multiple designated bridge playlists exist; select one before retrying.");
        if (!matches.length && input.requireExisting) throw new Error("The permanent Rabbit Hole Exact Verification Bridge playlist is missing; no replacement was created.");
      const playlist = matches[0] || await this.profile.createPlaylist({ title, description: "Managed by Rabbit Hole. Exact verified TIDAL IDs only; reused for Roon resolution." });
      saved = { playlistId: playlist.id, title };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(saved, null, 2));
    }
    const validRows = (Array.isArray(rows) ? rows : []).filter(row => row?.track);
    const seen = new Set();
    for (const row of validRows) {
      const id = String(row.track.id || row.track.tidalTrackId || row.track.tidal?.id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const added = await this.profile.addTrackToPlaylist(saved.playlistId, row.track, {
        playlistTitle: title,
        checkDuplicate: true,
        forceDuplicateCheck: true,
        verifyAfterWrite: true,
        allowDuplicate: false
      });
      if (!added.added && !added.duplicate) throw new Error(added.warning || added.duplicateCheckError || "TIDAL did not confirm the bridge playlist write.");
    }
    const internalSync = await this.triggerInternalTidalSync({
      reason: "exact-bridge-playlist-write",
      trackCount: seen.size,
      playlistTitle: title
    });
    const delays = normalizeDelays(input.bridgeSyncDelaysMs || this.syncDelaysMs);
    const timeoutMs = boundMs(input.bridgeLookupTimeoutMs || this.playlistLookupTimeoutMs, this.playlistLookupTimeoutMs, 1000, 60000);
    const syncStartedAt = Date.now();
    const state = validRows.map((row) => ({
      row,
      last: null,
      result: null,
      sync: { playlistId: saved.playlistId, title, attempts: [], requiresManualRefresh: false, elapsedMs: 0, internalSync }
    }));
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delayMs = delays[attempt];
      if (delayMs) await require("node:timers/promises").setTimeout(delayMs);
      for (const item of state) {
        if (item.result?.success) continue;
        item.last = await this.roon.resolveExactPlaylistAction(item.row.track, input.zoneId || item.row.roon?.zoneId, title, { timeoutMs, mode: input.mode || "queue" });
        item.sync.attempts.push({
          attempt: attempt + 1,
          delayMs,
          success: Boolean(item.last.success),
          reason: item.last.reason || "",
          diagnostics: item.last.diagnostics || null,
          elapsedMs: Date.now() - syncStartedAt
        });
        item.sync.elapsedMs = Date.now() - syncStartedAt;
        if (item.last.success) item.result = { ...item.last, playlistId: saved.playlistId, title, syncAttempts: attempt + 1, sync: item.sync };
      }
      if (state.every(item => item.result?.success)) break;
    }
    this.updatePending(state, input, saved, title);
    return {
      playlistId: saved.playlistId,
      title,
      results: state.map((item) => {
        if (item.result?.success) return item.result;
        item.sync.requiresManualRefresh = true;
        item.sync.elapsedMs = Date.now() - syncStartedAt;
        return {
          success: false,
          playlistId: saved.playlistId,
          title,
          reason: `Exact TIDAL ID added to designated bridge ${saved.playlistId}, but Roon has not exposed its exact track/action after ${delays.length} bounded refreshed playlist checks. ${internalSync?.success ? "Rabbit Hole triggered Roon's internal TIDAL library sync automatically; retry shortly." : "Refresh TIDAL playlists in Roon, then retry queueing this track."} ${item.last?.reason || "not visible"}`,
          failureType: "bridge_resolution_failed",
          diagnostics: item.last?.diagnostics || null,
          sync: item.sync
        };
      })
    };
  }

  async triggerInternalTidalSync(context) {
    if (!this.internalTidalSync?.syncLibrary) return { attempted: false, success: false, skipped: true, reason: "No internal sync helper configured." };
    try {
      return await this.internalTidalSync.syncLibrary(context);
    } catch (error) {
      return { attempted: true, success: false, reason: error.message };
    }
  }

  listPending() {
    return readPending(this.pendingFile);
  }

  async retryPending(input = {}) {
    const pending = this.listPending().tracks;
    const wanted = new Set((Array.isArray(input.trackIds) ? input.trackIds : []).map(String).filter(Boolean));
    const limit = Math.max(1, Math.min(40, Number(input.count || 40)));
    const selected = pending
      .filter(item => !wanted.size || wanted.has(String(item.tidalTrackId || item.track?.tidalTrackId || item.track?.id || "")))
      .slice(0, limit);
    if (!selected.length) return { requested: 0, resolved: 0, queued: 0, failed: 0, results: [], pending: this.listPending().tracks };
    const batch = await this.resolveBatchNow(selected.map(item => ({ track: item.track, tidal: { verified: true }, roon: { zoneId: input.zoneId || item.zoneId } })), {
      ...input,
      requireExisting: true,
      mode: input.mode || "queue"
    });
    const results = [];
    let queued = 0;
    for (let index = 0; index < selected.length; index++) {
      const item = selected[index];
      const result = batch.results[index] || {};
      const entry = {
        index,
        tidalTrackId: item.tidalTrackId,
        artist: item.track?.artist || "",
        title: item.track?.title || "",
        success: Boolean(result.success),
        queued: false,
        queueToken: result.queueToken || "",
        reason: result.reason || "",
        failureType: result.failureType || "",
        diagnostics: result.diagnostics || null,
        sync: result.sync || null
      };
      if (result.success && result.queueToken && input.queue === true) {
        const zoneId = input.zoneId || item.zoneId;
        const queuedResult = await this.roon.queueVerifiedTrack(result.queueToken, zoneId, "append");
        entry.queued = Boolean(queuedResult.success);
        entry.queueResult = queuedResult;
        if (entry.queued) queued += 1;
      }
      results.push(entry);
    }
    return {
      requested: selected.length,
      resolved: results.filter(item => item.success).length,
      queued,
      failed: results.filter(item => !item.success || (input.queue === true && !item.queued)).length,
      results,
      pending: this.listPending().tracks
    };
  }

  updatePending(state, input, saved, title) {
    const current = this.listPending();
    const byId = new Map((current.tracks || []).map(item => [String(item.tidalTrackId || item.track?.tidalTrackId || item.track?.id || ""), item]));
    for (const item of state) {
      const track = item.row?.track || {};
      const id = String(track.tidalTrackId || track.id || track.tidal?.id || "");
      if (!id) continue;
      if (item.result?.success) {
        if (input.queue === false) {
          byId.set(id, {
            tidalTrackId: id,
            artist: track.artist || "",
            title: track.title || "",
            album: track.album || "",
            track: { ...track, tidalTrackId: id, id },
            zoneId: input.zoneId || item.row?.roon?.zoneId || "",
            mode: input.mode || "queue",
            playlistId: saved.playlistId,
            playlistTitle: title,
            createdAt: byId.get(id)?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastResolved: {
              match: item.result.match || null,
              queueToken: item.result.queueToken || "",
              sync: item.result.sync || item.sync || null
            }
          });
          continue;
        }
        byId.delete(id);
        continue;
      }
      item.sync.requiresManualRefresh = true;
      byId.set(id, {
        tidalTrackId: id,
        artist: track.artist || "",
        title: track.title || "",
        album: track.album || "",
        track: { ...track, tidalTrackId: id, id },
        zoneId: input.zoneId || item.row?.roon?.zoneId || "",
        mode: input.mode || "queue",
        playlistId: saved.playlistId,
        playlistTitle: title,
        createdAt: byId.get(id)?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastFailure: {
          reason: item.last?.reason || "Bridge item is not visible in Roon yet.",
          sync: item.sync
        }
      });
    }
    const tracks = Array.from(byId.values()).slice(-200);
    if (!tracks.length && !fs.existsSync(this.pendingFile)) return;
    writePending(this.pendingFile, { updatedAt: new Date().toISOString(), tracks });
  }
}

function readPending(file) {
  try {
    if (!fs.existsSync(file)) return { updatedAt: "", tracks: [] };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { updatedAt: parsed.updatedAt || "", tracks: Array.isArray(parsed.tracks) ? parsed.tracks : [] };
  } catch {
    return { updatedAt: "", tracks: [] };
  }
}

function writePending(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function boundMs(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeDelays(value) {
  const source = Array.isArray(value) ? value : [0, 3000, 7000];
  const delays = source
    .map((number) => Math.max(0, Math.min(120000, Number(number))))
    .filter((number) => Number.isFinite(number));
  return delays.length ? delays.slice(0, 8) : [0];
}

module.exports = { ExactRoonBridge };
