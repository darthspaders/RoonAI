"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ExternalTrackQueue } = require("../src/externalTrackQueue");
const { queueExactTracks } = require("../src/exactTrackVerification");
const { resolveVerifiedTracksForRoon } = require("../src/roonExactResolution");
const { RoonClient } = require("../src/roonClient");
const { ExactRoonBridge } = require("../src/exactRoonBridge");

function track(index) { return { id: String(index), artist: "Requested Artist", title: `Requested Song ${index} (Named Remix)` }; }
function verified(tracks) {
  return { tracks: tracks.map((value, index) => ({ index, input: value, track: { ...value }, tidal: { verified: true }, tidalTrackId: value.id,
    matchedArtist: value.artist, matchedTitle: value.title, usable: true, versionExact: true, confidence: 1,
    identityOutcome: "VERIFIED_EXACT", identityDiagnostics: { identityRules: ["exact-named-version"] }, status: "TIDAL_VERIFIED_ROON_PENDING", roon: {} })) };
}
function fixture({ missing = [], noNext = [], rejectDispatch = [] } = {}) {
  const roon = Object.create(RoonClient.prototype), resolutions = [], dispatches = [], queueOrder = [];
  roon.getZone = () => ({ settings: {} }); roon.zoneOrOutputId = zone => zone; roon.emit = () => {};
  roon.resolveSearchAction = async (value, _zone, mode) => {
    resolutions.push({ id: value.id, mode });
    if (missing.includes(value.id)) return { success: false, failureType: "not_found", reason: "Direct catalogue miss." };
    const action = mode === "next" && !noNext.includes(value.id) ? "Add Next" : "Queue";
    return { success: true, session: `session-${value.id}`, match: { title: value.title, subtitle: value.artist },
      playable: { title: action, item_key: `${action === "Add Next" ? "next" : "append"}:${value.id}` }, action, mode };
  };
  roon.browse = { browse(args, callback) {
    const [action, id] = args.item_key.split(":");
    dispatches.push({ id, action, hierarchy: args.hierarchy });
    if (rejectDispatch.includes(id)) return callback("Disconnected after dispatch");
    if (action === "next") queueOrder.unshift(id); else queueOrder.push(id);
    callback(null, { action: "message", message: "Acknowledged" });
  } };
  return { roon, resolutions, dispatches, queueOrder };
}
function bridgeFixture(q) {
  const calls = [];
  const bridge = { async resolve(row, input) {
    calls.push({ id: row.track.id, mode: input.mode, requireNextAction: input.requireNextAction });
    const token = `private-bridge-token-${row.track.id}`;
    const result = { success: true, session: "bridge-session", hierarchy: "playlists", match: { title: row.track.title, subtitle: row.track.artist },
      playable: { title: "Add Next", item_key: `next:${row.track.id}` }, action: "Add Next", identityEvidence: { accepted: true } };
    q.roon.exactQueueActions ||= new Map();
    q.roon.exactQueueActions.set(token, { track: row.track, zoneId: "zone", mode: input.mode, browse: q.roon.browse, createdAt: Date.now(), result });
    return { ...result, queueToken: token, playlistId: "designated" };
  } };
  return { bridge, calls };
}
function privateDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rh-supplied-next-"));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test("invalid supplied mode rejects before verification, save, bridge or queue effects", async () => {
  let effects = 0;
  const queue = new ExternalTrackQueue({ verify: () => effects++, save: () => effects++, bridge: { resolve: () => effects++ }, roon: { queueTracks: () => effects++ } });
  await assert.rejects(queue.queue({ tracks: [track(0)], zoneId: "zone", mode: "replace", queuePolicy: "strict" }), /append or next/);
  assert.equal(effects, 0);
  await assert.rejects(queue.queue({ tracks: [track(0)], zoneId: "zone", diagnostics: "yes" }), /diagnostics must be boolean/);
  assert.equal(effects, 0);
});

test("mixed TIDAL failures retain exact input and diagnostics with no Roon or bridge action", async () => {
  const tracks = Array.from({ length: 5 }, (_, index) => track(index)), logs = [];
  const queue = new ExternalTrackQueue({ diagnostics: true, logger: entry => logs.push(entry), verify: async body => {
    assert.equal(body.diagnostics, true);
    return { tracks: body.tracks.map((value, index) => ({ index, input: value, status: index < 3 ? "NOT_FOUND" : "VERSION_MISMATCH", usable: false,
      tidal: { verified: false }, identityOutcome: "REJECTED", reasons: ["Candidate evidence preserved"], identityDiagnostics: { candidateIdentities: [{ id: `candidate-${index}` }] } })) };
  }, roon: { queueTracks: () => { throw Error("No queue permitted"); } }, bridge: { resolve: () => { throw Error("No bridge permitted"); } } });
  const result = await queue.queue({ tracks, zoneId: "zone", mode: "next", queuePolicy: "strict" });
  assert.deepEqual(result.failedTracks.map(row => row.status), ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "VERSION_MISMATCH", "VERSION_MISMATCH"]);
  assert.deepEqual(result.failedTracks.map(row => row.track), tracks);
  assert.equal(result.failedTracks[4].identityDiagnostics.candidateIdentities[0].id, "candidate-4");
  assert.equal(result.resolvedCount, 0); assert.equal(result.tidalVerifiedCount, 0); assert.equal(result.resolutionScope, "tidal-verified");
  assert.equal(result.mode, "next"); assert.equal(result.effectiveMode, "next"); assert.equal(result.queuedCount, 0);
  assert.equal(logs.at(-1).event, "supplied_queue_complete");
});

test("strict next reverses chunks and insertion while reports preserve all 85 original indices", async () => {
  const q = fixture(), batches = [], tracks = Array.from({ length: 85 }, (_, index) => track(index));
  const queue = new ExternalTrackQueue({ roon: q.roon, verify: async body => { batches.push(body.tracks.map(value => value.id)); return verified(body.tracks); } });
  const result = await queue.queue({ tracks, zoneId: "zone", queuePolicy: "strict", verifyBeforeQueue: true, mode: "next" });
  assert.deepEqual(batches.map(batch => batch.length), [5, 40, 40]);
  assert.deepEqual(batches.map(batch => batch[0]), ["80", "40", "0"]);
  assert.deepEqual(q.dispatches.map(row => row.id), tracks.map(value => value.id).reverse());
  assert.deepEqual(q.queueOrder, tracks.map(value => value.id));
  assert.deepEqual(result.queuedTracks.map(row => row.index), Array.from({ length: 85 }, (_, index) => index));
  assert.deepEqual(result.queuedTracks.map(row => row.track), tracks);
  assert.equal(result.resolvedCount, 85); assert.equal(result.tidalVerifiedCount, 85); assert.equal(result.queuedCount, 85);
  assert.ok(q.resolutions.every(row => row.mode === "next"));
});

test("fast next preserves order across 101 rows using the actual bulk dispatcher", async () => {
  const q = fixture(), tracks = Array.from({ length: 101 }, (_, index) => track(index));
  const queue = new ExternalTrackQueue({ roon: q.roon, verify: () => { throw Error("Fast must not verify"); } });
  const result = await queue.queue({ tracks, zoneId: "zone", mode: "next" });
  assert.deepEqual(q.queueOrder, tracks.map(value => value.id));
  assert.deepEqual(result.queuedTracks.map(row => row.index), Array.from({ length: 101 }, (_, index) => index));
  assert.equal(result.resolvedCount, 101); assert.equal(result.tidalVerificationPerformed, false);
});

test("all direct and bridge next actions resolve before the first dispatch, preserving mixed order", async () => {
  const q = fixture({ missing: ["1"] }), b = bridgeFixture(q), result = verified([track(0), track(1), track(2)]), events = [];
  const originalResolve = q.roon.resolveSearchAction;
  q.roon.resolveSearchAction = async (...args) => { events.push(`resolve:${args[0].id}`); return originalResolve(...args); };
  const originalBridge = b.bridge.resolve;
  b.bridge.resolve = async (...args) => { events.push(`bridge:${args[0].track.id}`); return originalBridge(...args); };
  const originalBrowse = q.roon.browse.browse;
  q.roon.browse.browse = (...args) => { events.push(`dispatch:${args[0].item_key}`); return originalBrowse(...args); };
  const response = await queueExactTracks(result, { zoneId: "zone", mode: "next", retries: 0 }, q.roon, { bridge: b.bridge });
  assert.deepEqual(b.calls, [{ id: "1", mode: "next", requireNextAction: true }]);
  assert.ok(events.indexOf("dispatch:next:2") > events.indexOf("resolve:2"));
  assert.deepEqual(q.queueOrder, ["0", "1", "2"]);
  assert.deepEqual(response.queuedTracks.map(row => row.index), [0, 1, 2]);
  assert.equal(q.dispatches.find(row => row.id === "1").hierarchy, "playlists");
});

test("append-mode token is not reused when verified queue changes to next", async () => {
  const q = fixture(), result = verified([track(0)]);
  await resolveVerifiedTracksForRoon(result, { zoneId: "zone", mode: "append", retries: 0 }, { roon: q.roon });
  const previousToken = result.tracks[0].roon.queueToken;
  assert.equal(q.roon.hasVerifiedQueueAction(previousToken, { mode: "next" }), false);
  const response = await queueExactTracks(result, { zoneId: "zone", mode: "next", retries: 0 }, q.roon);
  assert.deepEqual(q.resolutions.map(row => row.mode), ["queue", "next"]);
  assert.deepEqual(q.dispatches.map(row => row.action), ["next"]);
  assert.equal(response.queuedCount, 1); assert.equal(result.tracks[0].roon.mode, "next");
});

test("reversed dispatch failure attaches attempts, uncertainty and results to the correct row", async () => {
  const q = fixture({ rejectDispatch: ["2"] }), result = verified([track(0), track(1), track(2)]);
  const response = await queueExactTracks(result, { zoneId: "zone", mode: "next", retries: 0 }, q.roon);
  assert.deepEqual(q.dispatches.map(row => row.id), ["2", "1", "0"]);
  assert.deepEqual(response.queuedTracks.map(row => row.index), [0, 1]);
  assert.deepEqual(response.failedTracks.map(row => row.index), [2]);
  assert.ok(result.tracks[0].queuedAt); assert.ok(result.tracks[1].queuedAt);
  assert.equal(result.tracks[2].queuedAt, undefined); assert.ok(result.tracks[2].queueAttemptedAt);
  const repeat = await queueExactTracks(result, { zoneId: "zone", mode: "next" }, q.roon);
  assert.equal(repeat.alreadyQueuedCount, 2); assert.equal(q.dispatches.length, 3);
  assert.match(repeat.failedTracks[0].error, /uncertain/);
});

test("verified next rejects a direct append fallback before any dispatch", async () => {
  const q = fixture({ noNext: ["0"] }), result = verified([track(0)]);
  const response = await queueExactTracks(result, { zoneId: "zone", mode: "next", allowBridge: false, retries: 0 }, q.roon);
  assert.equal(response.queuedCount, 0); assert.equal(q.dispatches.length, 0);
  assert.match(response.failedTracks[0].error, /Add Next/);
  assert.equal(result.tracks[0].queueAttemptedAt, undefined);
  assert.equal(q.roon.exactQueueActions?.size || 0, 0);
});

test("supplied strict retry refuses an uncertain write before re-verification or retransmission", async () => {
  for (const mode of ["next", "append"]) {
    const q = fixture({ rejectDispatch: ["0"] }); let verifications = 0, bridgeCalls = 0;
    const queue = new ExternalTrackQueue({ roon: q.roon, verify: async body => { verifications++; return verified(body.tracks); },
      bridge: { resolve: () => { bridgeCalls++; throw Error("Unexpected bridge"); } } });
    const response = await queue.queue({ tracks: [track(0)], zoneId: "zone", queuePolicy: "strict", mode });
    assert.equal(response.queuedCount, 0); assert.equal(response.failedCount, 1);
    assert.equal(response.failedTracks[0].queueOutcomeUncertain, true);
    assert.ok(response.failedTracks[0].queueAttemptedAt);
    const resolutions = q.resolutions.length;
    await assert.rejects(queue.queue({ retryFailures: true, zoneId: "zone", queuePolicy: "strict", mode }), /uncertain; inspect Roon/);
    assert.equal(verifications, 1); assert.equal(q.resolutions.length, resolutions);
    assert.equal(q.dispatches.length, 1); assert.equal(bridgeCalls, 0);
    assert.equal(queue.lastFailures[0].queueOutcomeUncertain, true);
  }
});

test("default supplied fast retry preserves actual-dispatch uncertainty and refuses policy switching", async () => {
  for (const mode of ["next", "append"]) {
    const q = fixture({ missing: ["1"], rejectDispatch: ["2"] }); let effects = 0;
    const queue = new ExternalTrackQueue({ roon: q.roon, verify: () => { effects++; throw Error("No re-verification permitted"); },
      bridge: { resolve: () => { effects++; throw Error("No bridge permitted"); } } });
    const response = await queue.queue({ tracks: [track(0), track(1), track(2)], zoneId: "zone", mode });
    assert.deepEqual(response.failedTracks.map(row => row.index), [1, 2]);
    assert.equal(response.failedTracks[0].queueOutcomeUncertain, false);
    assert.equal(response.failedTracks[0].queueAttemptedAt, "");
    assert.equal(response.failedTracks[1].queueOutcomeUncertain, true);
    assert.ok(response.failedTracks[1].queueAttemptedAt);
    assert.equal(response.resolvedCount, 2);
    const resolutions = q.resolutions.length, dispatches = q.dispatches.length;
    for (const queuePolicy of ["fast", "strict"]) {
      await assert.rejects(queue.queue({ retryFailures: true, zoneId: "zone", queuePolicy, mode }), /uncertain; inspect Roon/);
    }
    assert.equal(q.resolutions.length, resolutions); assert.equal(q.dispatches.length, dispatches);
    assert.equal(effects, 0); assert.equal(queue.lastFailures[1].queueOutcomeUncertain, true);
  }
});

test("fast lookup misses remain retryable because no queue write was attempted", async () => {
  const q = fixture({ missing: ["0"] }), queue = new ExternalTrackQueue({ roon: q.roon });
  await queue.queue({ tracks: [track(0)], zoneId: "zone", mode: "next" });
  const retry = await queue.queue({ retryFailures: true, zoneId: "zone", mode: "next" });
  assert.equal(retry.failedCount, 1); assert.equal(retry.failedTracks[0].queueOutcomeUncertain, false);
  assert.equal(retry.failedTracks[0].queueAttemptedAt, "");
  assert.equal(q.resolutions.length, 2); assert.equal(q.dispatches.length, 0);
});

test("supplied fast next also rejects append fallback while unrelated caller keeps its fallback", async () => {
  const q = fixture({ noNext: ["0"] });
  const response = await new ExternalTrackQueue({ roon: q.roon }).queue({ tracks: [track(0)], zoneId: "zone", mode: "next" });
  assert.equal(response.queuedCount, 0); assert.equal(q.dispatches.length, 0);
  const legacy = await q.roon.queueTracks([track(0)], "zone", { mode: "next" });
  assert.equal(legacy.queuedCount, 1); assert.match(legacy.warning, /normal queue action/);
  assert.deepEqual(q.dispatches.map(row => row.action), ["append"]);
});

test("allowBridge false retains a TIDAL-resolved row without invoking the bridge", async () => {
  const q = fixture({ missing: ["0"] }); let bridgeCalls = 0;
  const queue = new ExternalTrackQueue({ roon: q.roon, verify: async body => verified(body.tracks), bridge: { resolve: () => bridgeCalls++ } });
  const response = await queue.queue({ tracks: [track(0)], zoneId: "zone", queuePolicy: "strict", mode: "next", allowBridge: false });
  assert.equal(bridgeCalls, 0); assert.equal(q.dispatches.length, 0); assert.equal(response.queuedCount, 0);
  assert.equal(response.resolvedCount, 1); assert.equal(response.tidalVerifiedCount, 1); assert.equal(response.failedCount, 1);
});

test("opt-in supplied diagnostics trace modes and bridge work without executable tokens", async () => {
  const q = fixture({ missing: ["0"] }), b = bridgeFixture(q), logs = [], bodies = [];
  const queue = new ExternalTrackQueue({ roon: q.roon, bridge: b.bridge, logger: entry => logs.push(entry), verify: async body => { bodies.push(body); return verified(body.tracks); } });
  await queue.queue({ tracks: [track(1)], zoneId: "zone", queuePolicy: "strict" });
  assert.equal(logs.length, 0); assert.equal(bodies[0].diagnostics, false);
  await queue.queue({ tracks: [track(0)], zoneId: "zone", queuePolicy: "strict", mode: "next", diagnostics: true });
  assert.equal(bodies[1].diagnostics, true);
  assert.ok(logs.some(entry => entry.event === "roon_search_start" && entry.effectiveMode === "next"));
  assert.ok(logs.some(entry => entry.event === "roon_bridge_start"));
  assert.ok(logs.some(entry => entry.event === "roon_bridge_final"));
  assert.ok(!JSON.stringify(logs).includes("private-bridge-token"));
  assert.ok(!logs.some(entry => Object.hasOwn(entry, "queueToken") || Object.hasOwn(entry, "verifiedQueueToken")));
});

test("bridge forwards next-action requirement and normalizes append to internal queue", async t => {
  const directory = privateDirectory(t), observed = [], source = track(0);
  const bridge = new ExactRoonBridge({ file: path.join(directory, "bridge.json"), syncDelaysMs: [0],
    profile: { isConfigured: () => true, getUserPlaylists: async () => ({ connected: true, playlists: [{ id: "designated", title: "Rabbit Hole Exact Verification Bridge" }] }), addTrackToPlaylist: async () => ({ duplicate: true }) },
    roon: { resolveExactPlaylistAction: async (_track, _zone, _title, options) => { observed.push(options); return { success: true, queueToken: "fixture-token" }; } } });
  await bridge.resolve({ track: source, roon: { zoneId: "zone" } }, { mode: "next", requireNextAction: true });
  await bridge.resolve({ track: source, roon: { zoneId: "zone" } }, { mode: "append" });
  assert.deepEqual(observed.map(value => [value.mode, value.requireNextAction]), [["next", true], ["queue", false]]);
});

test("real bridge browse refuses queue-only actions for strict next without creating a token", async () => {
  const roon = Object.create(RoonClient.prototype); let page = "root", dispatches = 0;
  roon.zoneOrOutputId = zone => zone;
  roon.browse = {
    browse(args, callback) {
      if (args.pop_all) page = "root";
      if (args.item_key === "playlist") page = "tracks";
      if (args.item_key === "track") page = "actions";
      if (args.item_key === "append") dispatches++;
      callback(null, {});
    },
    load(_args, callback) { callback(null, { items: page === "root" ? [{ title: "Rabbit Hole Exact Verification Bridge", item_key: "playlist" }]
      : page === "tracks" ? [{ title: track(0).title, subtitle: track(0).artist, item_key: "track", hint: "action_list" }]
        : [{ title: "Queue", item_key: "append", hint: "action" }] }); }
  };
  const result = await roon.resolveExactPlaylistAction(track(0), "zone", "Rabbit Hole Exact Verification Bridge", { mode: "next", requireNextAction: true });
  assert.equal(result.success, false); assert.equal(result.failureType, "next_action_unavailable");
  assert.equal(dispatches, 0); assert.equal(roon.exactQueueActions?.size || 0, 0);
});

test("verified invalid mode fails before preflight and append behavior remains unchanged", async () => {
  const q = fixture(), result = verified([track(0), track(1)]);
  await assert.rejects(queueExactTracks(result, { zoneId: "zone", mode: "replace" }, q.roon), /append or next/);
  assert.equal(q.resolutions.length, 0); assert.equal(q.dispatches.length, 0);
  const response = await queueExactTracks(result, { zoneId: "zone", mode: "append" }, q.roon);
  assert.deepEqual(q.dispatches.map(row => row.id), ["0", "1"]);
  assert.ok(q.dispatches.every(row => row.action === "append")); assert.equal(response.effectiveMode, "append");
});
