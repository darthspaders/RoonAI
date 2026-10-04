"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const preferredLane = track => /progressive house|progressive trance|psy.?trance|techno|melodic house|organic house|deep house|trance/i.test(`${track.genre || ""} ${track.subgenre || ""}`);

function createSonicCoverageInventory({ db, dataDirectory = path.join(__dirname, "..", "data"), files = {}, queueTracks = () => [] } = {}) {
  const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  async function read(name) {
    try { return JSON.parse(await fs.readFile(files[name] || path.join(dataDirectory, name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  async function* rows(sql, params = []) {
    let after = 0;
    while (true) {
      const page = db.prepare(sql).all(...params, after, 100);
      if (!page.length) return;
      for (const row of page) { after = row.cursor; yield row; }
      await yieldTurn();
    }
  }
  return async function* inventory() {
    // Stored ratings are used only to prioritize fingerprint preparation.
    // No rating, review, cluster or semantic classification is written.
    const feedback = (await read("taste-profile.json")).feedback || {};
    for (const track of Object.values(feedback)) yield { track, priority: 1, source: "global-rating" };

    if (exists("sonic_review_session")) {
      for await (const row of rows("SELECT rowid AS cursor,anchor_identity_key AS identityKey,anchor_json AS payload FROM sonic_review_session WHERE rowid>? ORDER BY rowid LIMIT ?")) {
        const anchor = JSON.parse(row.payload);
        yield { track: { ...(anchor.track || anchor), identityKey: row.identityKey }, priority: 2, source: "sonic-anchor" };
      }
    }
    if (exists("sonic_review_session_item")) {
      for await (const row of rows("SELECT rowid AS cursor,candidate_identity_key AS identityKey,candidate_json AS payload FROM sonic_review_session_item WHERE rowid>? AND status <> 'PENDING' ORDER BY rowid LIMIT ?")) {
        const candidate = JSON.parse(row.payload);
        yield { track: { ...(candidate.track || candidate), identityKey: row.identityKey }, priority: 2, source: "sonic-reviewed" };
      }
    }
    if (exists("sonic_anchor_profile")) {
      for await (const row of rows("SELECT rowid AS cursor,anchor_identity_key AS identityKey,anchor_artist AS artist,anchor_title AS title,genre,subgenre FROM sonic_anchor_profile WHERE rowid>? ORDER BY rowid LIMIT ?")) {
        yield { track: row, priority: 2, source: "sonic-anchor-profile" };
      }
    }
    if (exists("sonic_neighbor_feedback")) {
      for await (const row of rows("SELECT id AS cursor,anchor_identity_key,anchor_artist,anchor_title,candidate_identity_key,candidate_artist,candidate_title FROM sonic_neighbor_feedback WHERE id>? ORDER BY id LIMIT ?")) {
        yield { track: { identityKey: row.anchor_identity_key, artist: row.anchor_artist, title: row.anchor_title }, priority: 2, source: "sonic-reviewed-anchor" };
        yield { track: { identityKey: row.candidate_identity_key, artist: row.candidate_artist, title: row.candidate_title }, priority: 2, source: "sonic-reviewed" };
      }
    }

    for (const track of (await read("discovery-history.json")).entries || []) yield { track, priority: 3, source: "discovery-history" };
    const standby = await read("standby-candidates.json");
    for (const track of standby.candidates || []) yield { track, priority: 3, source: "standby" };
    for (const refresh of standby.standbyHistory || []) {
      for (const track of refresh.tracks || []) yield { track: { ...track, tidalId: track.tidalId || track.trackId }, priority: 3, source: "standby-history" };
    }
    for (const track of await queueTracks()) yield { track, priority: 4, source: "roon-queue" };
    for (const track of (await read("listening-history.json")).plays || []) yield { track, priority: 4, source: "playback-history" };
    for (const track of (await read("track-memory.json")).entries || []) {
      yield { track, priority: track.feedback ? 1 : preferredLane(track) ? 5 : 6, source: track.feedback ? "global-rating" : "track-memory" };
    }

    if (!exists("track_identity")) return;
    const rated = exists("taste_feedback") ? new Set(db.prepare("SELECT DISTINCT track_identity_id FROM taste_feedback").all().map(row => row.track_identity_id)) : new Set();
    const observed = new Map();
    if (exists("track_observation")) {
      for await (const row of rows("SELECT id AS cursor,track_identity_id,source FROM track_observation WHERE id>? ORDER BY id LIMIT ?")) {
        const priority = /discovery|standby/i.test(row.source) ? 3 : /roon|queue|play|listen/i.test(row.source) ? 4 : 6;
        observed.set(row.track_identity_id, Math.min(observed.get(row.track_identity_id) || 6, priority));
      }
    }
    const hasBeatport = exists("beatport_enrichment");
    const sql = `SELECT ti.id AS cursor,ti.identity_key AS identityKey,ti.tidal_id AS tidalId,ti.artist,ti.title,
      ti.album,ti.mix_version AS mixVersion,ti.isrc,ti.duration_ms AS durationMs
      ${hasBeatport ? ",be.genre,be.subgenre,be.label,be.beatport_track_id AS beatportTrackId" : ""}
      FROM track_identity ti ${hasBeatport ? "LEFT JOIN beatport_enrichment be ON be.track_identity_id=ti.id" : ""}
      WHERE ti.id>? ORDER BY ti.id LIMIT ?`;
    for await (const track of rows(sql)) {
      const priority = rated.has(track.cursor) ? 1 : Math.min(observed.get(track.cursor) || 6, preferredLane(track) ? 5 : 6);
      yield { track, priority, source: priority === 1 ? "global-rating" : "known-catalog" };
    }
  };
}

module.exports = { createSonicCoverageInventory, preferredLane };
