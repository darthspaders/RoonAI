"use strict";

const { identityKeyFor } = require("./sonicEmbeddingStore");
const { explicitTidalTrackId, tidalTrackIdFromUrl } = require("./tidalIdentity");
const MODEL = "discogs-effnet";
const MODEL_VERSION = "1";
const DIMENSIONS = 1280;
const text = value => String(value ?? "").trim();

function coverageTrack(input = {}) {
  const track = input.track || input;
  // Bare numeric IDs can be memory/Beatport IDs. Only explicit TIDAL fields
  // and TIDAL URLs identify the playback provider here.
  const tidalId = explicitTidalTrackId({ tidal: track.tidal, tidalId: track.tidalId || track.tidal_id, tidalTrackId: track.tidalTrackId }) || tidalTrackIdFromUrl(track.tidalUrl || track.tidal?.tidalUrl || "")
    || text(track.identityKey || track.identity_key).match(/^tidal:(\d+)$/i)?.[1] || "";
  const result = {
    artist: text(track.artist || track.tidal?.artist), title: text(track.title || track.tidal?.title),
    album: text(track.album || track.tidal?.album), mixVersion: text(track.mixVersion || track.mixName || track.version),
    tidalId, tidalUrl: tidalId ? `https://tidal.com/browse/track/${tidalId}` : "",
    isrc: text(track.isrc || track.tidal?.isrc), durationMs: Number(track.durationMs || track.tidal?.durationMs || track.lengthSeconds * 1000) || null,
    genre: text(track.genre || track.tidal?.genre), subgenre: text(track.subgenre || track.subGenre), label: text(track.label || track.tidal?.label),
    year: track.year || null, releaseDate: text(track.releaseDate),
    beatportTrackId: text(track.beatportTrackId || track.beatportId || track.beatport?.id)
  };
  result.identityKey = tidalId ? `tidal:${tidalId}` : identityKeyFor({ ...result, identityKey: track.identityKey || track.identity_key });
  if (!result.identityKey || !result.artist || !result.title || track.isRadioProgram || track.catalogEnrichmentAllowed === false) return null;
  if (/^(unknown|unknown artist|various artists?)$/i.test(result.artist)) return null;
  return result;
}

function validCoverageEmbedding(embedding) {
  if (embedding?.model !== MODEL || String(embedding.modelVersion) !== MODEL_VERSION || embedding.dimensions !== DIMENSIONS || embedding.vector?.length !== DIMENSIONS) return false;
  let norm = 0;
  for (const value of embedding.vector) {
    if (!Number.isFinite(value)) return false;
    norm += value * value;
  }
  return norm > 0 && Number.isFinite(norm);
}

module.exports = { MODEL, MODEL_VERSION, DIMENSIONS, coverageTrack, validCoverageEmbedding };
