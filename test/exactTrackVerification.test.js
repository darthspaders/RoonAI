"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTrack, exactIntent, exactMatch, chooseExact, verifyExactTracks } = require("../src/exactTrackVerification");
const { TidalVerifier } = require("../src/tidalVerifier");
const { createRabbitHoleMcpTools } = require("../src/mcpHttpServer");
const list = `Quivver — Visitor
Jamie Stevens & Kasey Taylor — Hocu Pocu
Guy J — Placebo
Fluke — Bullet (Nick Warren & Nicolas Rada Remix)
DJ Ruby — Crossing the Styx (Extended Remix)
Abity & Luca Abayan — Afterimage (DJ Ruby Remix)
DAVI — In Deep (Extended Mix)
Ezequiel Arias & FJL — Color Divino (Extended Mix)
Drunken Kong & D-SHIFT — City Lights (HAFT Remix)
Digital Mess & Astral Base — Turbulence (Ewan Rill Extended Remix)
Mattias Herrera — Lumara (Extended Mix)
Ignacio Tuzio — Train (Extended Mix)`;
const tracks = list.split("\n").map(parseTrack);

test("exact 12-track intent preserves every title and bypasses discovery", async () => {
  const intent = exactIntent({ request: `Verify these tracks before queueing:\n${list}` });
  assert.deepEqual(intent.tracks, tracks);
  assert.equal(exactIntent({ request: `Discover tracks like these:\n${list}` }), null);
  let active = 0, peak = 0, calls = 0;
  const tidal = { isConfigured: () => true, searchExactCandidates: async track => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, 2)); active--;
    return [{ ...track, id: String(calls), tidalUrl: `https://tidal.com/track/${calls}`, durationMs: 450000 }];
  } };
  const result = await verifyExactTracks({ tracks: intent.tracks, allowKnown: false, years: "2026", scoringMode: "pure" }, { tidal, roon: { canQueueTrack: () => { throw new Error("Must not queue/check without request"); } } });
  assert.equal(calls, 12); assert.equal(peak, 3);
  assert.equal(result.verifiedCount, 12); assert.equal(result.roonQueueableCount, 0);
  assert.deepEqual(result.tracks.map(t => t.requestedTitle), tracks.map(t => t.title));
});

test("matching normalizes punctuation, artist order and version formatting without substitution", () => {
  const requested = tracks[7];
  assert.ok(exactMatch(requested, { artist: "FJL and Ezequiel Arias", title: "Color Divino - Extended Mix" }));
  assert.ok(!exactMatch(requested, { ...requested, title: "Color Divino" }));
  assert.equal(chooseExact(requested, [{ ...requested, title: "Color Divino" }]).status, "VERSION_MISMATCH");
  assert.equal(chooseExact(tracks[3], [{ ...tracks[3], title: "Bullet (Original Mix)" }]).status, "VERSION_MISMATCH");
  assert.equal(chooseExact(requested, [{ ...requested, id: "1" }, { ...requested, id: "2" }]).status, "AMBIGUOUS");
});

test("HTTP 400 affects one track; Roon availability remains distinct", async () => {
  const tidal = { isConfigured: () => true, searchExactCandidates: async t => {
    if (t.artist === "Guy J") throw Object.assign(new Error("HTTP 400"), { status: 400 });
    if (t.artist === "Quivver") return [];
    return [{ ...t, id: t.artist, durationMs: 450000 }];
  } };
  const roon = { canQueueTrack: async () => ({ success: true, match: { title: "Exact" } }) };
  const result = await verifyExactTracks({ tracks, checkRoon: true, zoneId: "zone" }, { tidal, roon });
  assert.equal(result.errorCount, 1); assert.equal(result.notFoundCount, 1);
  assert.equal(result.verifiedCount, 10); assert.equal(result.roonQueueableCount, 10);
});

test("exact TIDAL request is bounded, carries no limit parameter and never retries 400", async () => {
  const logs = []; let calls = 0;
  const tidal = new TidalVerifier({ enabled: true, accessToken: "secret", fetchImpl: async url => {
    calls++; const u = new URL(url);
    assert.equal(u.searchParams.has("limit"), false);
    assert.equal(u.searchParams.get("include"), "tracks.artists,tracks.albums");
    return { ok: false, status: 400 };
  } });
  const result = await verifyExactTracks({ tracks: [tracks[0], tracks[1]] }, { tidal, logger: entry => logs.push(entry) });
  assert.equal(result.errorCount, 2); assert.equal(calls, 2);
  assert.equal(logs[0].httpStatus, 400); assert.ok(!JSON.stringify(logs).includes("secret"));
});

test("per-track timeout aborts actual catalogue I/O", async () => {
  let aborted = false;
  const tidal = new TidalVerifier({ enabled: true, accessToken: "secret", fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  }) });
  const result = await verifyExactTracks({ tracks: [tracks[0]], perTrackTimeoutMs: 100 }, { tidal });
  assert.equal(result.errorCount, 1); assert.ok(aborted);
});

test("MCP routes exact list to verification endpoint and preserves structured result", async () => {
  const urls = [];
  const tools = createRabbitHoleMcpTools({ fetchImpl: async (url, options) => {
    urls.push(new URL(url).pathname);
    return { ok: true, text: async () => JSON.stringify(new URL(url).pathname === "/api/status" ? { zones: [] } : { mode: "exact_track_verification", requestedCount: JSON.parse(options.body).tracks.length }) };
  } });
  const result = await tools.search_rabbit_hole.handler({ request: `Verify these tracks:\n${list}` });
  assert.equal(result.mode, "exact_track_verification"); assert.equal(result.requestedCount, 12);
  assert.ok(!urls.includes("/api/ai/playlist"));
});

test("single inline pair routes to exact verification", () => {
  assert.deepEqual(exactIntent({ request: 'Verify Quivver — Visitor' }).tracks, [tracks[0]]);
});

test("Roon rejects version substitution before opening any playback actions", async () => {
  const { RoonClient } = require('../src/roonClient');
  const fake = { search: async () => ({ verified: true, match: { item_key: 'item', title: 'Bullet (Original Mix)', subtitle: 'Fluke - Album' } }) };
  const result = await RoonClient.prototype.resolveSearchAction.call(fake, { ...tracks[3], exactVerification: true }, 'zone', 'queue', {});
  assert.equal(result.success, false);
  assert.match(result.reason, /forbids substitution/);
});

test("TIDAL separate version metadata participates in exact matching", async () => {
  const tidal = new TidalVerifier({ enabled: true, accessToken: 'secret', fetchImpl: async () => ({ ok: true, json: async () => ({
    data: [{ id: '1', type: 'tracks' }], included: [
      { id: '1', type: 'tracks', attributes: { title: 'Color Divino', version: 'Extended Mix', duration: 'PT7M' }, relationships: { artists: { data: [{ id: 'a', type: 'artists' }, { id: 'b', type: 'artists' }] } } },
      { id: 'a', type: 'artists', attributes: { name: 'Ezequiel Arias' } },
      { id: 'b', type: 'artists', attributes: { name: 'FJL' } }
    ]
  }) }) });
  const result = await verifyExactTracks({ tracks: [tracks[7]] }, { tidal });
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.tracks[0].matchedTitle, tracks[7].title);
});

const { parseTrackList, queueExactTracks } = require('../src/exactTrackVerification');
const { RoonClient } = require('../src/roonClient');

test('parser retains all 12 rows through instruction prefixes, blank lines and trailing prose', () => {
  const variants = [
    `Please verify the following 12 exact tracks on TIDAL:\n\n${list}\n\nPreserve remix/version identity exactly.`,
    `Please verify the following exact tracks: ${list}. Preserve remix/version identity exactly.`,
    `Verify these tracks:\n${list.replaceAll('\n', '\n\n')}\nPreserve identity - do not queue.\nFake Artist - Prose item`,
    `${list.replaceAll(' — ', ' - ')}\n.\nPreserve remix/version identity exactly.`,
    `${list.replaceAll(' — ', ' – ')}\n\nOnly queue after approval.`,
    list.split('\n').map((line, i) => `${i + 1}. ${line}`).join('\n')
  ];
  for (const input of variants) {
    const parsed = parseTrackList(input);
    assert.deepEqual(parsed, tracks);
    assert.equal(parsed[0].artist, 'Quivver');
    assert.equal(parsed.at(-1).title, 'Train (Extended Mix)');
  }
  assert.deepEqual(parseTrackList('This is explanatory prose without a track list.'), []);
  assert.deepEqual(parseTrackList('Band and Guest - Dr. Sunshine (A & B Remix)'), [{ artist: 'Band and Guest', title: 'Dr. Sunshine (A & B Remix)' }]);
});

test('stored Roon action queues directly without discovery, lookup, or substitutions', async () => {
  const dispatched = [];
  const fake = {
    browse: { browse: (input, cb) => { dispatched.push(input); cb(null, { action: 'message', is_error: false, message: 'Added to queue' }); } },
    resolveSearchAction: async () => ({ success: true, session: 'verified-session', playable: { title: 'Queue', item_key: 'verified-action' }, match: { title: 'Placebo', subtitle: 'Guy J' } }),
    zoneOrOutputId: zone => zone,
    queueVerifiedTrack: RoonClient.prototype.queueVerifiedTrack
  };
  Object.setPrototypeOf(fake,RoonClient.prototype); fake.getZone=()=>({});
  const verified = await RoonClient.prototype.canQueueTrack.call(fake, { artist: 'Guy J', title: 'Placebo', id: '551357260', exactVerification: true }, 'zone-1');
  fake.resolveSearchAction = () => { throw Error('Queue must not search'); };
  const saved = { tracks: [{ index: 0, tidal:{verified:true}, track:{artist:'Guy J',title:'Placebo',id:'551357260'}, usable: true, queueable: true, status: 'ROON_QUEUEABLE', tidalTrackId: '551357260', matchedArtist: 'Guy J', matchedTitle: 'Placebo', roon: { queueToken: verified.queueToken, zoneId: 'zone-1' } }] };
  const result = await queueExactTracks(saved, {}, fake);
  assert.deepEqual([result.requestedToQueue, result.queued, result.failed], [1, 1, 0]);
  assert.deepEqual(dispatched, [{ hierarchy: 'search', multi_session_key: 'verified-session', item_key: 'verified-action', zone_or_output_id: 'zone-1' }]);
  const replay = await queueExactTracks(saved, {}, fake);
  assert.equal(replay.alreadyQueuedCount, 1);
  assert.equal(dispatched.length, 1);
});

test('verified queue can opt into permanent bridge after direct Roon miss', async () => {
  const saved = { tracks: [{ index: 0, tidal:{verified:true}, track:{artist:'M.O.S.',title:'Immensity (Extended Mix)',id:'432944544'}, usable: true, status: 'TIDAL_VERIFIED_ROON_PENDING', tidalTrackId: '432944544', matchedArtist: 'M.O.S.', matchedTitle: 'Immensity (Extended Mix)', roon: { zoneId: 'zone-1' } }] };
  let bridgeCalls = 0;
  const fake = {
    canQueueTrack: async () => ({ success: false, failureType: 'not_found', reason: 'direct miss' }),
    queueTracks: async (tracks, zoneId) => {
      assert.equal(zoneId, 'zone-1');
      assert.equal(tracks[0].verifiedQueueToken, 'bridge-token');
      return { queued: [{ index: 0, action: 'Queue' }], failed: [] };
    }
  };
  const bridge = {
    resolve: async (row, input) => {
      bridgeCalls++;
      assert.equal(row.tidalTrackId, '432944544');
      assert.equal(input.allowBridge, true);
      return { queueToken: 'bridge-token', playlistId: 'permanent', title: 'Rabbit Hole Exact Verification Bridge', match: { title: row.track.title, subtitle: row.track.artist } };
    }
  };
  const result = await queueExactTracks(saved, { allowBridge: true }, fake, { bridge });
  assert.equal(bridgeCalls, 1);
  assert.equal(result.queuedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(saved.tracks[0].status, 'ROON_QUEUED');
});

test('stored queue handles reject zone changes and expired sessions without rediscovery', async () => {
  const fake = { browse: {}, zoneOrOutputId: z => z, resolveSearchAction: async () => ({ success: true, session: 's', playable: { item_key: 'a', title: 'Queue' } }) };
  Object.setPrototypeOf(fake,RoonClient.prototype);
  const result = await RoonClient.prototype.canQueueTrack.call(fake, { artist: 'Guy J', title: 'Placebo', exactVerification: true }, 'z');
  await assert.rejects(RoonClient.prototype.queueVerifiedTrack.call(fake, result.queueToken, 'other'), /differs/);
  fake.exactQueueActions.get(result.queueToken).createdAt = 0;
  await assert.rejects(RoonClient.prototype.queueVerifiedTrack.call(fake, result.queueToken, 'z'), /expired/);
});

test('legacy MCP queue uses exact source even when discovery session has no tracks', async () => {
  const paths = [];
  const tools = createRabbitHoleMcpTools({ fetchImpl: async (url, options) => {
    const path = new URL(url).pathname; paths.push(path);
    const result = path === '/api/status' ? { app: { latestResultSource: 'exact_verification', session: { result: { tracks: [] } } } }
      : { requestedToQueue: 1, queued: 1, failed: 0 };
    return { ok: true, text: async () => JSON.stringify(result) };
  } });
  assert.ok(tools.verify_exact_tracks);
  const result = await tools.queue_rabbit_hole_tracks.handler({});
  assert.equal(result.queued, 1);
  assert.deepEqual(paths, ['/api/status', '/api/status', '/api/tracks/verified/queue']);
});

test('batch retains Roon queue token and exact parsing counts', async () => {
  const result = await verifyExactTracks({ tracks: `Please verify these tracks: ${list}. Preserve remix/version identity exactly.`, checkRoon: true, zoneId: 'z' }, {
    tidal: { isConfigured: () => true, searchExactCandidates: async t => t.artist === 'Guy J' ? [{ ...t, id: '551357260' }] : [] },
    roon: { canQueueTrack: async () => ({ success: true, queueToken: 'stored-handle', match: { title: 'Placebo' } }) }
  });
  assert.equal(result.parsedCount, 12);
  assert.equal(result.requestedCount, 12);
  assert.equal(result.roonQueueableCount, 1);
  assert.equal(result.tracks[2].roon.queueToken, 'stored-handle');
  assert.equal(result.tracks.at(-1).requestedTitle, 'Train (Extended Mix)');
});

test('one controlled base-title fallback recovers an exact remix without accepting originals', async () => {
  const queries = [];
  const requested = { artist: 'Fluke', title: 'Bullet (Nick Warren & Nicolas Rada Remix)' };
  const result = await verifyExactTracks({ tracks: [requested] }, {
    tidal: { isConfigured: () => true, searchExactCandidates: async track => {
      queries.push(track.title);
      return track.title === 'bullet' ? [{ ...requested, id: 'exact' }, { artist: 'Fluke', title: 'Bullet (Original Mix)', id: 'wrong' }] : [];
    } }
  });
  assert.deepEqual(queries, [requested.title, 'bullet']);
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.tracks[0].track.id, 'exact');
  assert.equal(result.tracks[0].requestedTitle, requested.title);
  const mismatch = await verifyExactTracks({ tracks: [{ artist: 'Ignacio Tuzio', title: 'Train (Extended Mix)' }] }, {
    tidal: { isConfigured: () => true, searchExactCandidates: async () => [{ artist: 'Ignacio Tuzio', title: 'Train', id: 'original' }] }
  });
  assert.equal(mismatch.tracks[0].status, 'VERSION_MISMATCH');
  assert.equal(mismatch.usable.length, 0);
});
