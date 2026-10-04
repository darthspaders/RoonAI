"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTrack, exactIntent, exactMatch, chooseExact, verifyExactTracks, artistCreditRelation, scoreTidalIdentity, sameTidalRecording } = require("../src/exactTrackVerification");
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
  assert.equal(result.tracks[0].identityDiagnostics.failureType, "NOT_FOUND");
  assert.equal(result.verifiedCount, 10); assert.equal(result.roonQueueableCount, 10);
});

test("exact TIDAL request is bounded, carries no limit parameter and never retries 400", async () => {
  const logs = []; let calls = 0;
  const tidal = new TidalVerifier({ enabled: true, accessToken: "secret", fetchImpl: async url => {
    calls++; const u = new URL(url);
    assert.equal(u.pathname, "/v2/searchResults");
    assert.ok(u.searchParams.get("filter[query]"));
    assert.equal(u.searchParams.has("limit"), false);
    assert.equal(u.searchParams.get("include"), "tracks,tracks.artists,tracks.albums");
    return { ok: false, status: 400 };
  } });
  const result = await verifyExactTracks({ tracks: [tracks[0], tracks[1]] }, { tidal, logger: entry => logs.push(entry) });
  assert.equal(result.errorCount, 2); assert.equal(calls, 2);
  assert.equal(logs[0].httpStatus, 400); assert.ok(!JSON.stringify(logs).includes("secret"));
});

test("exact verification path reuses the validated identity store before NOT_FOUND", async () => {
  const lookupArtists = [];
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "secret",
    validatedIdentityLookup: track => {
      lookupArtists.push(track.artist);
      return track.artist === "James Holden" ? [{
        id: "2352515",
        tidalId: "2352515",
        artist: "James Holden",
        title: "A Break In The Clouds (Main Mix)",
        mixVersion: "Main Mix",
        releaseDate: "2004-01-01",
        validatedIdentitySource: "music-memory-track-identity"
      }] : [];
    },
    fetchImpl: async url => {
      if (new URL(url).pathname.endsWith("/tracks/2352515")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ data: {
            id: "2352515",
            attributes: { title: "A Break In The Clouds", version: "Main Mix", releaseDate: "2004-01-01", duration: 420 },
            artists: [{ id: "james-holden", name: "James Holden" }],
            album: { title: "A Break In The Clouds", releaseDate: "2004-01-01" }
          } })
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [] }) };
    }
  });
  const result = await verifyExactTracks({ tracks: [{ artist: "Holden", title: "A Break in the Clouds" }] }, { tidal });
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.tracks[0].tidalTrackId, "2352515");
  assert.equal(result.tracks[0].identityDiagnostics.validatedIdentityReuse, true);
  assert.equal(result.tracks[0].identityDiagnostics.expectedLegacyEra, 2004);
  assert.equal(result.tracks[0].identityDiagnostics.expectedLegacyEraSource, "validated-identity-release-year");
  assert.equal(result.tracks[0].identityDiagnostics.validatedIdentityReuseDiagnostics.lookup.aliasLookupAttempted, true);
  assert.equal(result.tracks[0].identityDiagnostics.validatedIdentityReuseDiagnostics.lookup.normalizedBaseTitle, "a break in the clouds");
  assert.equal(result.tracks[0].identityDiagnostics.validatedIdentityReuseDiagnostics.acceptedId, "2352515");
  assert.equal(result.tracks[0].identityDiagnostics.validatedIdentityReuseDiagnostics.candidates[0].revalidation.revalidationReason, "tidal-id-revalidated-compatible");
  assert.ok(lookupArtists.includes("James Holden"));
});

test("a principal release Main Mix can resolve an unversioned canonical TIDAL request", () => {
  const result = chooseExact({ artist: "Nathan Fake", title: "Outhouse" }, [{
    id: "2385618",
    artist: "Nathan Fake",
    title: "Outhouse",
    mixVersion: "Main Mix",
    album: "Outhouse",
    label: "Border Community",
    releaseDate: "2003-01-01"
  }]);

  assert.equal(result.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(result.match.id, "2385618");
  assert.equal(result.canonicalCandidateSelected.identityDiagnostics.canonicalMainMixApplied, true);
  assert.equal(result.canonicalCandidateSelected.legacyIdentityDiagnostics.canonicalVersionRelation, "CANONICAL_MAIN_MIX");
});

test("validated identity reuse rejects a named alternate for an unversioned request", async () => {
  const verifier = new TidalVerifier({
    enabled: true,
    accessToken: "secret",
    validatedIdentityLookup: () => [{
      id: "65491317",
      tidalId: "65491317",
      artist: "Reflekt, Delline Bass",
      title: "Need To Feel Loved",
      mixVersion: "Adam K & Soha Vocal Mix",
      releaseDate: "2021-10-01",
      validatedIdentitySource: "music-memory-track-identity"
    }],
    fetchImpl: async url => {
      if (new URL(url).pathname.endsWith("/tracks/65491317")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ data: {
            id: "65491317",
            attributes: { title: "Need To Feel Loved", version: "Adam K & Soha Vocal Mix", releaseDate: "2021-10-01", duration: 420 },
            artists: [
              { id: "reflekt", name: "Reflekt" },
              { id: "delline-bass", name: "Delline Bass" }
            ],
            album: { title: "Need To Feel Loved", releaseDate: "2021-10-01" }
          } })
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [] }) };
    }
  });

  const result = await verifier.findExactTrack({ artist: "Reflekt", title: "Need To Feel Loved" }, { strict: true, maxQueries: 1 });
  assert.equal(result, null);
  assert.equal(verifier.lastExactIdentityDiagnostics.finalIdentityOutcome, "NOT_FOUND");
  assert.equal(verifier.lastExactIdentityDiagnostics.validatedIdentityReuseDiagnostics.accepted, false);
  assert.equal(verifier.lastExactIdentityDiagnostics.validatedIdentityReuseDiagnostics.candidates[0].versionReason, "named-alternate-version-not-reused");
  assert.equal(verifier.lastExactIdentityDiagnostics.validatedIdentityReuseDiagnostics.candidates[0].revalidation.revalidationReason, "tidal-id-revalidated-compatible");
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
  assert.equal(mismatch.tracks[0].identityDiagnostics.failureType, 'VERSION_MISMATCH');
  assert.equal(mismatch.tracks[0].identityDiagnostics.candidateIdentities[0].title, 'Train');
  assert.equal(mismatch.usable.length, 0);
});

test('TIDAL credit supersets are accepted when the requested primary artist and title agree', () => {
  for (const [artist, title, expectedOverlap] of [
    ['Simon Doty', 'Universal Language', 'requested-artists-subset'],
    ['Joachim Pastor', 'Be Someone', 'requested-artists-subset']
  ]) {
    const result = chooseExact({ artist, title }, [{
      artist: `${artist}, ${artist === 'Simon Doty' ? 'Roland Clark' : 'EKE'}`,
      title,
      id: `${artist}-tidal`,
      durationMs: 312000
    }]);
    assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
    assert.equal(result.identityOutcome, 'VERIFIED_EQUIVALENT_RECORDING');
    assert.equal(result.identityDiagnostics.identityDiagnostics.artistOverlapType, expectedOverlap);
    assert.deepEqual(result.identityDiagnostics.identityDiagnostics.requestedArtistCredits, [artist]);
  }
});

test('base-title requests accept an Original Mix but explicit versions remain fail-closed', () => {
  const base = chooseExact({ artist: 'Dosem', title: 'Projection' }, [{
    artist: 'Dosem', title: 'Projection', version: 'Original Mix', id: 'projection-original'
  }]);
  assert.equal(base.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(base.identityOutcome, 'VERIFIED_BASE_TITLE_WITH_VERSION_PROXY');
  assert.equal(base.identityDiagnostics.identityDiagnostics.candidateVersion.kind, 'original');

  const mismatch = chooseExact({ artist: 'Dosem', title: 'Projection (Extended Mix)' }, [{
    artist: 'Dosem', title: 'Projection', version: 'Original Mix', id: 'projection-original'
  }]);
  assert.equal(mismatch.status, 'VERSION_MISMATCH');
  assert.equal(mismatch.identityOutcome, 'VERSION_MISMATCH');
  assert.equal(mismatch.candidateIdentities[0].identityDiagnostics.rejectionReason, 'version-kind-mismatch');
});

test('artist ordering and punctuation/stylization are equivalent without allowing a missing artist', () => {
  const relation = artistCreditRelation(
    { artist: 'Booka Shade, M.A.N.D.Y.' },
    { artist: 'MANDY, Booka Shade' }
  );
  assert.equal(relation.type, 'alias-equivalent');
  assert.equal(relation.matched, true);
  const conflict = chooseExact({ artist: 'Booka Shade', title: 'Body Language' }, [{
    artist: 'Other Artist', title: 'Body Language', id: 'wrong-artist'
  }]);
  assert.equal(conflict.status, 'ARTIST_CONFLICT');
  assert.equal(conflict.candidateIdentities[0].identityDiagnostics.artistOverlapType, 'conflicting-artist-identity');
});

test('compilation copies of one Body Language recording collapse to a canonical candidate', () => {
  const result = chooseExact({ artist: 'Booka Shade', title: 'Body Language' }, [
    { artist: 'Booka Shade, M.A.N.D.Y.', title: 'Body Language', id: 'body-album', isrc: 'DE-A1-123', durationMs: 381000, album: 'Body Language' },
    { artist: 'Booka Shade, M.A.N.D.Y.', title: 'Body Language', id: 'body-compilation', isrc: 'DE A1 123', durationMs: 380500, album: 'Various Artists: Electronic Collection' }
  ]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.candidatesCollapsedAsSameRecording, true);
  assert.equal(result.collapsedRecordingCount, 1);
  assert.equal(result.match.id, 'body-album');
});

test('distinct exact-title recordings stay ambiguous, while matching identity evidence selects one', () => {
  const ambiguous = chooseExact({ artist: 'Joris Voorn', title: 'Ringo' }, [
    { artist: 'Joris Voorn', title: 'Ringo', id: 'ringo-1', isrc: 'ISRC-1', durationMs: 402000, album: 'Ringo' },
    { artist: 'Joris Voorn', title: 'Ringo', id: 'ringo-2', isrc: 'ISRC-2', durationMs: 298000, album: 'Ringo Remixes' }
  ]);
  assert.equal(ambiguous.status, 'AMBIGUOUS');
  assert.equal(ambiguous.candidateIdentities.length, 2);

  const selected = chooseExact({ artist: 'Rodriguez Jr.', title: 'Amargosa', isrc: 'ISRC-AMARGOSA', durationMs: 360000 }, [
    { artist: 'Rodriguez Jr.', title: 'Amargosa', id: 'amargosa-wrong', isrc: 'ISRC-OTHER', durationMs: 290000, album: 'Compilation' },
    { artist: 'Rodriguez Jr.', title: 'Amargosa', id: 'amargosa-right', isrc: 'ISRC-AMARGOSA', durationMs: 360000, album: 'Amargosa' }
  ]);
  assert.equal(selected.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(selected.match.id, 'amargosa-right');
  assert.equal(selected.identityDiagnostics.identityDiagnostics.isrcMatch, true);
  assert.equal(selected.identityDiagnostics.identityDiagnostics.durationDeltaMs, 0);
});

test('canonical plain recordings beat named alternate versions for unversioned requests', () => {
  for (const [requested, candidates, preferenceApplied] of [
    [{ artist: 'Guy J', title: 'Dizzy Moments' }, [
      { artist: 'Guy J', title: 'Dizzy Moments', id: 'dizzy-plain', durationMs: 402000, album: 'Dizzy Moments' },
      { artist: 'Guy J', title: 'Dizzy Moments (Am Mix)', id: 'dizzy-am', durationMs: 402000, album: 'Dizzy Moments Remixes' }
    ], true],
    [{ artist: 'Nick Warren', title: 'Buenos Aires' }, [
      { artist: 'Nick Warren', title: 'Buenos Aires', id: 'buenos-plain', durationMs: 390000, album: 'Buenos Aires' },
      { artist: 'Nick Warren', title: 'Buenos Aires (Dub Mix)', id: 'buenos-dub', durationMs: 390000, album: 'Buenos Aires Remixes' }
    ], false],
    [{ artist: 'Agents Of Time', title: 'Dream Vision' }, [
      { artist: 'Agents Of Time', title: 'Dream Vision', id: 'dream-plain', durationMs: 360000, album: 'Dream Vision' },
      { artist: 'Agents Of Time', title: 'Dream Vision (Orchestra Version)', id: 'dream-orchestra', durationMs: 360000, album: 'Dream Vision Versions' }
    ], true]
  ]) {
    const result = chooseExact(requested, candidates);
    assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
    assert.equal(result.match.id, candidates[0].id);
    assert.equal(result.versionPreferenceApplied, preferenceApplied);
    assert.equal(result.ambiguityResolvedBy, preferenceApplied ? 'canonical-version-preference' : 'single-canonical-recording-group');
    assert.equal(result.canonicalCandidateGroups.length, preferenceApplied ? 2 : 1);
    assert.equal(result.canonicalCandidateGroups[0].canonicalCandidate.id, candidates[0].id);
  }
});

test('an explicitly requested alternate version still wins exact canonical preference', () => {
  const result = chooseExact({ artist: 'Agents Of Time', title: 'Dream Vision (Orchestra Version)' }, [
    { artist: 'Agents Of Time', title: 'Dream Vision', id: 'dream-plain', durationMs: 360000 },
    { artist: 'Agents Of Time', title: 'Dream Vision (Orchestra Version)', id: 'dream-orchestra', durationMs: 360000 }
  ]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.match.id, 'dream-orchestra');
  assert.equal(result.versionPreferenceApplied, false);
  assert.equal(result.ambiguityResolvedBy, 'single-canonical-recording-group');

  const mismatch = chooseExact({ artist: 'Agents Of Time', title: 'Dream Vision (Orchestra Version)' }, [
    { artist: 'Agents Of Time', title: 'Dream Vision (Orchestra Mix)', id: 'dream-orchestra-mix', durationMs: 360000 }
  ]);
  assert.equal(mismatch.status, 'VERSION_MISMATCH');
  assert.equal(mismatch.candidateIdentities[0].identityDiagnostics.rejectionReason, 'version-descriptor-mismatch');
});

test('a collapsed equivalent TIDAL recording resolves after canonical grouping', () => {
  const result = chooseExact({ artist: 'Above & Beyond', title: 'Sun & Moon' }, [
    { artist: 'Above & Beyond', title: 'Sun & Moon', id: 'sun-album', isrc: 'GB-SUN-MOON-1', durationMs: 500000, album: 'Group Therapy' },
    { artist: 'Above & Beyond', title: 'Sun & Moon', id: 'sun-compilation', isrc: 'GB SUN MOON 1', durationMs: 499500, album: 'Various Artists: Electronic Collection' }
  ]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.identityOutcome, 'VERIFIED_EXACT');
  assert.equal(result.candidatesCollapsedAsSameRecording, true);
  assert.equal(result.collapsedRecordingCount, 1);
  assert.equal(result.canonicalCandidateGroups.length, 1);
  assert.equal(result.canonicalCandidateGroups[0].memberCount, 2);
  assert.equal(result.ambiguityResolvedBy, 'equivalent-recording-collapse');
  assert.equal(result.finalIdentityOutcome, result.identityOutcome);
});

test('confidence margin resolves distinct canonical recordings only when configured evidence is strong', () => {
  const resolved = chooseExact({ artist: 'Rodriguez Jr.', title: 'Amargosa', durationMs: 360000 }, [
    { artist: 'Rodriguez Jr.', title: 'Amargosa', id: 'amargosa-a', durationMs: 360000, album: 'Amargosa' },
    { artist: 'Rodriguez Jr.', title: 'Amargosa', id: 'amargosa-b', durationMs: 380000, album: 'Amargosa Remixes' }
  ], { highConfidenceThreshold: 0.8, confidenceMargin: 0.03 });
  assert.equal(resolved.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(resolved.ambiguityResolvedBy, 'confidence-margin');
  assert.ok(resolved.topCandidateScore >= 0.8);
  assert.ok(resolved.confidenceMargin >= 0.03);
});

test('identity diagnostics include the full evidence packet for a credit-equivalent anchor', async () => {
  const result = await verifyExactTracks({ tracks: [{ artist: 'Simon Doty', title: 'Universal Language' }] }, {
    tidal: { isConfigured: () => true, searchExactCandidates: async () => [{
      artist: 'Simon Doty, Roland Clark', title: 'Universal Language', id: 'universal-language', album: 'Universal Language', label: 'Anjunadeep', releaseDate: '2026-01-02', durationMs: 360000
    }] }
  });
  const diagnostics = result.tracks[0].identityDiagnostics;
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.tracks[0].identityOutcome, 'VERIFIED_EQUIVALENT_RECORDING');
  assert.deepEqual(diagnostics.requestedArtistCredits, ['Simon Doty']);
  assert.deepEqual(diagnostics.candidateArtistCredits, ['Simon Doty', 'Roland Clark']);
  assert.equal(diagnostics.artistOverlapType, 'requested-artists-subset');
  assert.equal(diagnostics.normalizedBaseTitleMatch, true);
  assert.equal(typeof diagnostics.candidateConfidenceScore, 'number');
  assert.ok(Array.isArray(diagnostics.candidateIdentities));
  assert.ok(Array.isArray(diagnostics.canonicalCandidateGroups));
  assert.equal(diagnostics.finalIdentityOutcome, 'VERIFIED_EQUIVALENT_RECORDING');
});

test('identity scorer exposes conservative outcomes for unsupported proxies', () => {
  const evidence = scoreTidalIdentity(
    { artist: 'Fluke', title: 'Bullet (Nick Warren & Nicolas Rada Remix)' },
    { artist: 'Fluke', title: 'Bullet (Radio Edit)', id: 'radio' }
  );
  assert.equal(evidence.matched, false);
  assert.equal(evidence.outcome, 'VERSION_MISMATCH');
  assert.equal(evidence.rejectionReason, 'version-kind-mismatch');
  assert.equal(evidence.normalizedBaseTitleMatch, true);
});

test('legacy artist spelling uses a diacritic-insensitive comparison key without changing display text', () => {
  const result = chooseExact({ artist: 'Trentemoller', title: 'Moan' }, [{
    artist: 'Trentemøller', title: 'Moan', id: 'moan'
  }]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.match.artist, 'Trentemøller');
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.normalizedArtistKey.requested, 'trentemoller');
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.normalizedArtistKey.candidate, 'trentemoller');
});

test('legacy title and mixVersion placement share one canonical version identity', () => {
  const result = chooseExact({ artist: 'James Holden', title: 'A Break In The Clouds (Main Mix)' }, [{
    artist: 'James Holden', title: 'A Break In The Clouds', mixVersion: 'Main Mix', id: 'break-clouds'
  }]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.match.title, 'A Break In The Clouds');
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.canonicalVersionRelation, 'same-version');
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.normalizedBaseTitle.requested, 'a break in the clouds');
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.normalizedBaseTitle.candidate, 'a break in the clouds');
});

test('legacy featured-artist title text does not create a base-title mismatch', () => {
  const result = chooseExact({ artist: 'Paul van Dyk', title: 'Nothing But You', isrc: 'DE-PAUL-001', durationMs: 300000 }, [{
    artist: 'Paul van Dyk',
    title: 'Nothing But You feat. Hemstock, Jennings',
    isrc: 'DE PAUL 001',
    durationMs: 300016,
    id: 'nothing-but-you'
  }]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.identityOutcome, 'VERIFIED_EXACT');
  assert.deepEqual(result.identityDiagnostics.legacyIdentityDiagnostics.normalizedFeaturedArtists.candidate, ['hemstock', 'jennings']);
  assert.equal(result.identityDiagnostics.identityDiagnostics.normalizedBaseTitleMatch, true);
});

test('plain title and Original Mix remain equivalent only when duration evidence agrees', () => {
  const result = chooseExact({ artist: 'deadmau5', title: 'Faxing Berlin', durationMs: 360000 }, [{
    artist: 'deadmau5', title: 'Faxing Berlin', mixVersion: 'Original Mix', durationMs: 360016, id: 'faxing-original'
  }]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.identityOutcome, 'VERIFIED_BASE_TITLE_WITH_VERSION_PROXY');
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.durationFormRelation, 'same-form');
});

test('duration shape keeps Sasha Xpander short and long forms from collapsing', () => {
  const short = { artist: 'Sasha', title: 'Xpander', isrc: 'GB-XPANDER-1', durationMs: 220000, id: 'xpander-short' };
  const long = { artist: 'Sasha', title: 'Xpander', isrc: 'GB-XPANDER-1', durationMs: 690000, id: 'xpander-long' };
  assert.equal(sameTidalRecording(short, long), false);
  const selected = chooseExact({ artist: 'Sasha', title: 'Xpander', durationMs: 690000 }, [short, long]);
  assert.equal(selected.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(selected.match.id, 'xpander-long');
  assert.equal(selected.identityDiagnostics.legacyIdentityDiagnostics.recordingForm.candidate, 'long-form-club');
});

test('recording era is supporting evidence for legacy catalog disambiguation', () => {
  const result = chooseExact({ artist: 'Push', title: 'Strange World', recordingYear: 2000 }, [
    { artist: 'Push', title: 'Strange World', recordingYear: 2000, catalogReleaseYear: 2000, id: 'strange-original' },
    { artist: 'Push', title: 'Strange World', recordingYear: 2025, catalogReleaseYear: 2025, id: 'strange-modern' }
  ]);
  assert.equal(result.status, 'VERIFIED_TIDAL_ONLY');
  assert.equal(result.match.id, 'strange-original');
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.eraDistance, 0);
  assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.eraAdjustment, 0.03);
});

test('legacy compilation copies collapse without merging distinct recording forms', () => {
  for (const [artist, title, isrc, durationMs] of [
    ['Chicane', 'Saltwater', 'GB-SALTWATER-1', 250000],
    ['BT', 'Dreaming', 'US-DREAMING-1', 300000],
    ['Gabriel & Dresden', 'Arcadia', 'US-ARCADIA-1', 360000],
    ['Sander Kleinenberg', 'My Lexicon', 'NL-LEXICON-1', 390000]
  ]) {
    const result = chooseExact({ artist, title }, [
      { artist, title, isrc, durationMs, album: title, id: `${title}-canonical` },
      { artist, title, isrc: ` ${isrc} `, durationMs: durationMs - 500, album: 'Various Artists Compilation', id: `${title}-compilation` }
    ]);
    assert.equal(result.status, 'VERIFIED_TIDAL_ONLY', title);
    assert.equal(result.candidatesCollapsedAsSameRecording, true, title);
    assert.equal(result.canonicalCandidateGroups[0].canonicalGroupType, 'equivalent-recording', title);
  }
});

test('explicit Original Mix resolves against an unlabeled exact TIDAL ID when recording evidence agrees', () => {
  for (const [artist, title] of [["deadmau5", "Faxing Berlin"], ["Gabriel & Dresden", "Arcadia"]]) {
    const result = chooseExact({
      artist,
      title: `${title} (Original Mix)`,
      id: `tidal-${title}`,
      isrc: `ISRC-${title}`,
      durationMs: 360000,
      album: title,
      releaseDate: "2006-01-01"
    }, [{
      artist,
      title,
      id: `tidal-${title}`,
      isrc: `ISRC-${title}`,
      durationMs: 360004,
      album: title,
      releaseDate: "2006-01-01"
    }]);
    assert.equal(result.status, "VERIFIED_TIDAL_ONLY", artist);
    assert.equal(result.identityOutcome, "VERIFIED_EQUIVALENT_RECORDING", artist);
    assert.equal(result.identityDiagnostics.legacyIdentityDiagnostics.canonicalVersionRelation, "ORIGINAL_EQUIVALENT_TO_UNLABELED", artist);
  }
});

test('legacy canonical preference selects original-era exact-artist recordings over modern reinterpretations', () => {
  for (const [artist, title, year] of [
    ["Sander Kleinenberg", "My Lexicon", 2000],
    ["Mylo", "Drop The Pressure", 2004]
  ]) {
    const result = chooseExact({ artist, title }, [
      { artist, title, year, album: title, id: `${artist}-original` },
      { artist: `${artist}, New Collaborator`, title, year: 2025, album: `${title} Rework`, id: `${artist}-modern` }
    ]);
    assert.equal(result.status, "VERIFIED_TIDAL_ONLY", artist);
    assert.equal(result.match.id, `${artist}-original`, artist);
    assert.equal(result.legacyCanonicalPreferenceApplied, true, artist);
    assert.equal(result.ambiguityResolvedBy, "legacy-canonical-era-preference", artist);
    assert.equal(result.canonicalCandidateGroups[0].originalEraCandidate, true, artist);
    assert.ok(result.canonicalCandidateGroups[1].modernReinterpretationPenalty > 0, artist);
  }
});

test('legacy album suffixes compare as one family while unrelated releases remain separate', () => {
  const related = chooseExact({ artist: "Moby", title: "Destroy Rock & Roll", album: "Destroy Rock & Roll" }, [{
    artist: "Moby", title: "Destroy Rock & Roll", album: "Destroy Rock & Roll (2005 Remaster)", id: "remaster"
  }]);
  assert.equal(related.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(related.identityDiagnostics.identityDiagnostics.albumFamilyAgreement, true);
  assert.equal(related.identityDiagnostics.legacyIdentityDiagnostics.normalizedAlbumFamily.candidate, "destroy rock and roll");

  const distinct = chooseExact({ artist: "Moby", title: "Destroy Rock & Roll" }, [
    { artist: "Moby", title: "Destroy Rock & Roll", album: "Destroy Rock & Roll", durationMs: 300000, id: "album-a" },
    { artist: "Moby", title: "Destroy Rock & Roll", album: "Destroy Rock & Roll Remixes", durationMs: 300000, id: "album-b" }
  ]);
  assert.equal(distinct.status, "AMBIGUOUS");
});

test('canonical fallback searches beyond a rejected radio/edit result before returning VERSION_MISMATCH', async () => {
  const calls = [];
  const result = await verifyExactTracks({ tracks: [
    { artist: "Tiësto", title: "Traffic" },
    { artist: "Faithless", title: "I Want More" },
    { artist: "Armin van Buuren", title: "Shivers" },
    { artist: "Reflekt", title: "Need To Feel Loved" },
    { artist: "Junior Jack", title: "Stupidisco" },
    { artist: "Deep Dish", title: "Say Hello" }
  ] }, {
    tidal: {
      isConfigured: () => true,
      searchExactCandidates: async (track, options = {}) => {
        calls.push({ title: track.title, queryOverride: options.queryOverride || "" });
        if (!options.queryOverride) return [{ artist: track.artist, title: `${track.title} (Radio Edit)`, id: `radio-${track.artist}` }];
        return [{ artist: track.artist, title: track.title, id: `canonical-${track.artist}`, durationMs: 360000 }];
      }
    }
  });
  assert.equal(result.verifiedCount, 6);
  for (const row of result.tracks) {
    assert.equal(row.status, "TIDAL_VERIFIED_ROON_PENDING", row.requestedTitle);
    assert.equal(row.identityDiagnostics.canonicalFallbackAttempted, true, row.requestedTitle);
    assert.equal(row.identityDiagnostics.canonicalFallbackOutcome, "resolved", row.requestedTitle);
  }
  assert.ok(calls.some(call => call.queryOverride), "canonical fallback should issue a query override");
});
