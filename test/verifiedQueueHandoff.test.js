"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { RoonClient } = require("../src/roonClient");
const { queueExactTracks } = require("../src/exactTrackVerification");
const pairs = [["Amonita", "Inner World (Extended Mix)"], ["Luciano Ficarra", "Gone (Extended Mix)"], ["Christian Patti", "Parallel Memories"], ["Christian Patti", "See You Again"], ["Redspace & SHERRNX", "Against All Odds (Juan Buitrago Remix)"], ["Das Pharaoh", "Whispers in the Wind (Extended Mix)"]];
test("six pending identities use the real shared bulk resolver/dispatcher: five queued, wrong version retained for retry", async () => {
  const result = { tracks: pairs.map(([artist, title], index) => ({ index, tidal: { verified: true }, tidalTrackId: String(index), usable: true, status: "TIDAL_VERIFIED_ROON_PENDING", matchedArtist: artist, matchedTitle: title, track: { artist, title, id: String(index) }, roon: {} })) };
  const roon = Object.create(RoonClient.prototype); const sessions = new Map(); const dispatched = []; const saved = []; let current, bulkCalls = 0;
  roon.zoneOrOutputId = z => z; roon.getZone = () => ({});
  roon.canQueueTrack = function(track, zone, options) { current = track; return RoonClient.prototype.canQueueTrack.call(this, track, zone, options); };
  roon.queueTracks = function(...args) { bulkCalls++; return RoonClient.prototype.queueTracks.apply(this, args); };
  roon.browse = {
    browse(args, cb) {
      if (args.input) sessions.set(args.multi_session_key, { track: current, selected: false });
      if (args.item_key === "track") sessions.get(args.multi_session_key).selected = true;
      if (args.item_key === "queue") dispatched.push(sessions.get(args.multi_session_key).track.id);
      cb(null, {});
    },
    load(args, cb) {
      const session = sessions.get(args.multi_session_key), track = session.track;
      cb(null, { items: session.selected ? [{ title: "Queue", hint: "action", item_key: "queue" }] : [{ title: track.id === "5" ? "Whispers in the Wind" : track.title, subtitle: track.artist, item_key: "track", hint: "action_list" }] });
    }
  };
  const queued = await queueExactTracks(result, { zoneId: "HQPlayer", retries: 1 }, roon, { save: r => saved.push(r.tracks.map(t => t.status)) });
  assert.equal(bulkCalls, 1); assert.equal(queued.queuedCount, 5); assert.equal(queued.failedCount, 1);
  assert.deepEqual(dispatched, ["0", "1", "2", "3", "4"]);
  assert.equal(result.tracks[5].status, "ROON_VERSION_MISMATCH"); assert.equal(result.tracks[5].tidal.verified, true);
  assert.ok(saved.some(states => states.includes("ROON_RESOLVING")));
  const repeat = await queueExactTracks(result, { zoneId: "HQPlayer", retries: 0 }, roon);
  assert.equal(repeat.alreadyQueuedCount, 5); assert.equal(dispatched.length, 5);
});
