"use strict";
const { explicitTidalTrackId } = require("./tidalIdentity");
const { parseTrack } = require("./exactTrackVerification");

// Catalog STREAM availability plus an exact action exposed by the user's Roon
// account. This never invokes that action, writes a bridge playlist, or plays audio.
function createBandcampEligibility({ tidal, roon, zoneId }) {
  return async track => {
    const tidalId = explicitTidalTrackId(track);
    const proof = { tidalId, tidalAvailable: false, roonQueueable: false, countryCode: tidal.countryCode,
      checkedAt: new Date().toISOString(), method: "tidal-regional-stream-and-exact-roon-action" };
    if (!tidalId) return proof;
    try {
      const available = await tidal.streamingAvailability(tidalId);
      proof.tidalAvailable = available.available === true;
      if (!proof.tidalAvailable) return proof;
      const zone = zoneId(); if (!zone) return proof;
      const signal = AbortSignal.timeout(12000);
      const requested = parseTrack({ ...track, version: track.mixVersion || track.version });
      const result = await roon.canQueueTrack({ ...requested, id: tidalId, tidalTrackId: tidalId, exactVerification: true }, zone, {
        exactVerification: true, exactResolution: true, query: `${requested.artist} ${requested.title}`,
        preferExtendedMixes: false, mode: "queue", signal
      });
      proof.roonQueueable = result.success === true && result.identityEvidence?.accepted === true;
      // Do not keep a stale queue action as analysis provenance.
      if (result.queueToken) roon.exactQueueActions?.delete(result.queueToken);
      return proof;
    } catch { return proof; }
  };
}
module.exports = { createBandcampEligibility };
