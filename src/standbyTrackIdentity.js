"use strict";
const normalize = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Keep version words; punctuation, collaborator order and separate version fields are not identities.
function identityKeys(track = {}) {
  const tidalId = [track.tidal?.id, track.tidal?.trackId, track.tidalTrackId, track.tidalId, track.id, track.trackId,
    String(track.tidalUrl || track.tidal?.tidalUrl || track.key || "").match(/(?:track\/|tidal:)(\d+)/)?.[1]]
    .find(value => /^\d+$/.test(String(value || "")));
  const artist = String(track.artist || track.tidal?.artist || "").split(/\s*(?:,|;|&|\+|\band\b)\s*/i).map(normalize).filter(Boolean).sort().join(" & ");
  let title = normalize(track.title || track.tidal?.title);
  const version = normalize(track.version || track.remix || track.tidal?.version || track.tidal?.remix);
  if (version && !(` ${title} `).includes(` ${version} `)) title = `${title} ${version}`.trim();
  return [...new Set([tidalId ? `tidal:${tidalId}` : "", artist && title ? `name:${artist}|${title}` : ""].filter(Boolean))];
}

module.exports={identityKeys};
