"use strict";

const { tidalTrackIdFromUrl } = require("./tidalIdentity");
const text = value => String(value ?? "").trim();

function tidalIds(reference) {
  if (typeof reference === "string") {
    return [reference.match(/^tidal:(\d+)$/i)?.[1] || tidalTrackIdFromUrl(reference)].filter(Boolean);
  }
  const track = reference?.track || reference || {};
  return [
    ...[track.tidalId, track.tidal_id, track.tidalTrackId, track.tidal?.id,
      track.tidal?.trackId, track.tidal?.track_id, track.tidal?.tidalId].map(text),
    ...[track.identityKey, track.identity_key].map(value => text(value).match(/^tidal:(\d+)$/i)?.[1]),
    ...[track.tidalUrl, track.tidal_url, track.tidal?.url, track.tidal?.tidalUrl].map(tidalTrackIdFromUrl)
  ].filter(Boolean);
}

// Vector validity and source identity are separate checks. In particular, some
// equivalent recordings have the historical "version-proxy" sourceType label;
// only the recorded relationship establishes recording-level provenance.
function storedSonicIdentityMatches(profile, reference = profile?.identityKey) {
  if (!profile) return false;
  const metadata = profile.track?.metadata || profile.metadata || {};
  const provenance = metadata.provenance || metadata;
  const verifiedLocal = provenance.sourceType === "verified-local-file" && Number(provenance.localFileId) > 0
    && /^[a-f0-9]{64}$/.test(profile.sourceSha256 || "");
  if (!verifiedLocal && !["exact", "equivalent-recording"].includes(text(metadata.identityRelation || provenance.identityRelation))) return false;
  const ids = [
    ...tidalIds(reference),
    ...tidalIds(profile.identityKey),
    ...tidalIds(profile.track),
    ...tidalIds(metadata),
    text(metadata.canonicalTrackId), text(provenance.canonicalTrackId)
  ].filter(Boolean);
  return new Set(ids).size <= 1;
}

module.exports = { storedSonicIdentityMatches };
