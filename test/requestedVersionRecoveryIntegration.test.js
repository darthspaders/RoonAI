"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TidalVerifier } = require("../src/tidalVerifier");
const { chooseExact, verifyExactTracks } = require("../src/exactTrackVerification");
const { createRequestedVersionEvidenceLookup } = require("../src/requestedVersionEvidence");

// These identities reproduce the October 9 supplied-track catalogue results.
// Provider calls below are fixtures; no test queues, plays, or changes a profile.
const cases = [
  {
    request: { artist: "Makebo", title: "From Zero (Original Mix)" },
    beatport: { id: "30626729", artist: "Makebo", title: "From Zero", mixName: "Original Mix", isrc: "GBLV62602095", durationMs: 411270, album: "From Zero", label: "Random Shadow", releaseDate: "2026-10-08" },
    tidal: { id: "565212426", artist: "Makebo", title: "From Zero", isrc: "GBLV62602095", durationMs: 411000, album: "From Zero", label: "Random Shadow", releaseDate: "2026-10-08" }
  },
  {
    request: { artist: "NAKSHATRA", title: "Sunset at Lake Pichola (Extended Mix)" },
    beatport: { id: "30572076", artist: "NAKSHATRA", title: "Sunset at Lake Pichola", mixName: "Extended Mix", isrc: "GBLV62601776", durationMs: 355680, album: "Sunset at Lake Pichola", label: "Polyptych Limited White", releaseDate: "2026-10-08" },
    tidal: { id: "565212415", artist: "NAKSHATRA", title: "Sunset at Lake Pichola", isrc: "GBLV62601779", durationMs: 235000, album: "Sunset at Lake Pichola", label: "Polyptych Limited White", releaseDate: "2026-10-08" }
  },
  {
    request: { artist: "Matthew Sona", title: "Prismatik (Original Mix)" },
    beatport: { id: "30545786", artist: "Matthew Sona", title: "Prismatik", mixName: "Original Mix", isrc: "HUDWQ2600001", durationMs: 383606, album: "Prismatik", label: "All That Is.", releaseDate: "2026-10-09" },
    tidal: { id: "565769183", artist: "Matthew Sona", title: "Prismatik", isrc: "HUDWQ2600002", durationMs: 206000, album: "Prismatik", label: "All That Is", releaseDate: "2026-10-09" }
  }
];

const normalizedTidal = track => ({ ...track, source: "tidal", tidalUrl: `https://tidal.com/browse/track/${track.id}` });
const normalizedBeatport = track => ({ ...track, source: "beatport", beatportUrl: `https://www.beatport.com/track/${track.id}` });

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => "application/vnd.api+json" }, json: async () => body };
}

function tidalJson(tracks) {
  const included = [];
  const data = tracks.map(track => {
    const artistId = `artist-${track.id}`, albumId = `album-${track.id}`;
    included.push({ id: artistId, type: "artists", attributes: { name: track.artist } });
    included.push({ id: albumId, type: "albums", attributes: { title: track.album, releaseDate: track.releaseDate, recordLabel: track.label } });
    const row = { id: track.id, type: "tracks", attributes: {
      title: track.title, version: track.mixVersion || null, isrc: track.isrc,
      duration: `PT${track.durationMs / 1000}S`, releaseDate: track.releaseDate, recordLabel: track.label,
      externalLinks: [{ href: `https://tidal.com/browse/track/${track.id}` }]
    }, relationships: { artists: { data: [{ id: artistId, type: "artists" }] }, albums: { data: [{ id: albumId, type: "albums" }] } } };
    included.push(row);
    return row;
  });
  return { data, included };
}

function harness(selectedCases = cases, { onlyIsrc = false, noEvidence = false, evidenceLookup, timeoutMs = 1000, clock = Date.now } = {}) {
  const requests = [], beatportSearches = [], beatportDetails = [];
  const beatport = {
    isConfigured: () => true,
    searchTracks: async ({ query, page, perPage }) => {
      beatportSearches.push({ query, page, perPage });
      return { tracks: selectedCases.map(entry => normalizedBeatport(entry.beatport)) };
    },
    getTrackById: async id => {
      beatportDetails.push(id);
      return normalizedBeatport(selectedCases.find(entry => entry.beatport.id === id).beatport);
    }
  };
  const tidal = new TidalVerifier({ enabled: true, accessToken: "fixture-token", countryCode: "US", sleep: async () => {}, clock,
    requestedRecordingEvidenceTimeoutMs: timeoutMs,
    fetchImpl: async url => {
      const parsed = new URL(url);
      requests.push(parsed);
      const wantedIsrc = parsed.searchParams.get("filter[isrc]");
      if (wantedIsrc) return jsonResponse(tidalJson(selectedCases.filter(entry => entry.tidal.isrc === wantedIsrc).map(entry => entry.tidal)));
      if (parsed.pathname === "/v2/searchResults") return jsonResponse(tidalJson(onlyIsrc ? [] : selectedCases.map(entry => entry.tidal)));
      const id = parsed.pathname.match(/\/tracks\/(\d+)$/)?.[1];
      if (id) return jsonResponse(tidalJson(selectedCases.filter(entry => entry.tidal.id === id).map(entry => entry.tidal)));
      return jsonResponse({ data: [], included: [] });
    }
  });
  // Year enrichment is orthogonal to recording verification and would otherwise
  // fetch public HTML. All identity and recording checks remain the real code.
  tidal.withPageYear = async track => track;
  tidal.withDetailYear = async track => track;
  if (!noEvidence) tidal.setRequestedRecordingEvidenceLookup(evidenceLookup || createRequestedVersionEvidenceLookup({ beatport }));
  return { tidal, requests, beatportSearches, beatportDetails };
}

const noQueueRoon = new Proxy({}, { get(_target, name) { return () => { throw new Error(`Verification must not call Roon.${String(name)}`); }; } });

test("supplied verification recovers only the independently proved Makebo recording", async () => {
  for (const entry of cases) assert.equal(chooseExact(entry.request, [normalizedTidal(entry.tidal)]).match, undefined);
  const { tidal, requests, beatportSearches, beatportDetails } = harness();
  tidal.searchExactCandidates = async () => cases.map(entry => normalizedTidal(entry.tidal));
  const originalRequests = structuredClone(cases.map(entry => entry.request));
  const result = await verifyExactTracks({ tracks: originalRequests, concurrency: 1, perTrackTimeoutMs: 2000 }, { tidal, roon: noQueueRoon });
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.versionMismatchCount, 2);
  assert.equal(result.apiErrorCount, 0);
  assert.equal(result.tracks[0].tidalTrackId, "565212426");
  assert.equal(result.tracks[0].matchedTitle, "From Zero");
  assert.equal(result.tracks[0].track.isrc, "GBLV62602095");
  assert.equal(result.tracks[0].track.durationMs, 411000);
  assert.equal(result.tracks[0].roon.checked, false);
  assert.equal(result.tracks[0].identityDiagnostics.requestedRecordingEvidence.outcome, "verified-equivalent-tidal-recording");
  assert.equal(result.tracks[0].identityDiagnostics.requestedRecordingEvidence.selectedTidalId, "565212426");
  for (const row of result.tracks.slice(1)) {
    assert.equal(row.status, "VERSION_MISMATCH");
    assert.equal(row.usable, false);
    assert.equal(row.tidal.verified, false);
    assert.equal(row.identityDiagnostics.requestedRecordingEvidence.outcome, "requested-recording-not-verified-in-tidal");
  }
  assert.deepEqual(originalRequests, cases.map(entry => entry.request));
  assert.equal(beatportSearches.length, 3);
  assert.equal(beatportDetails.length, 3);
  assert.deepEqual(requests.filter(url => url.searchParams.has("filter[isrc]")).map(url => url.searchParams.get("filter[isrc]")).sort(), ["GBLV62601776", "HUDWQ2600001"]);
});

test("Discovery verify uses the same requested recording proof while preserving canonical TIDAL identity", async () => {
  const { tidal, beatportSearches } = harness([cases[0]]);
  const result = await tidal.verify(cases[0].request);
  assert.ok(result);
  assert.equal(result.id, "565212426");
  assert.equal(result.source, "tidal");
  assert.equal(result.title, "From Zero");
  assert.equal(result.isrc, "GBLV62602095");
  assert.equal(result.durationMs, 411000);
  assert.equal(beatportSearches.length, 1);
  assert.ok(result.identityDiagnostics);
});

test("Discovery rejects the shorter NAKSHATRA and Matthew Sona recordings after independent evidence lookup", async () => {
  for (const entry of cases.slice(1)) {
    const { tidal, requests, beatportDetails } = harness([entry]);
    const result = await tidal.findExactTrack(entry.request, { strict: true, maxQueries: 1 });
    assert.equal(result, null);
    assert.equal(tidal.lastExactIdentityDiagnostics.failureType, "VERSION_MISMATCH");
    assert.equal(beatportDetails.length, 1);
    assert.deepEqual(requests.filter(url => url.searchParams.has("filter[isrc]")).map(url => url.searchParams.get("filter[isrc]")), [entry.beatport.isrc]);
  }
});

test("ISRC recovery searches the requested recording and returns its TIDAL ID rather than the Beatport ID", async () => {
  const { tidal, requests } = harness([cases[0]], { onlyIsrc: true });
  const result = await tidal.verify(cases[0].request, { strict: true });
  assert.ok(result);
  assert.equal(result.id, cases[0].tidal.id);
  assert.notEqual(result.id, cases[0].beatport.id);
  assert.equal(result.title, "From Zero");
  assert.equal(result.source, "tidal");
  const isrcRequests = requests.filter(url => url.searchParams.has("filter[isrc]"));
  assert.equal(isrcRequests.length, 1);
  assert.equal(isrcRequests[0].pathname, "/v2/tracks");
  assert.equal(isrcRequests[0].searchParams.get("countryCode"), "US");
  assert.equal(isrcRequests[0].searchParams.get("filter[isrc]"), "GBLV62602095");
  assert.equal(isrcRequests[0].searchParams.get("include"), "artists,albums");
});

test("requested recording evidence does not relax named remix matching", async () => {
  let evidenceCalls = 0;
  const { tidal } = harness([], { evidenceLookup: async () => { evidenceCalls++; throw new Error("Named remix must not use generic mix evidence"); } });
  tidal.searchExactCandidates = async () => [{ id: "400774270", source: "tidal", artist: "Budakid", title: "Lovin' Sun (Hernan Cattaneo & Kevin Di Serna Remix)", durationMs: 450000 }];
  const result = await verifyExactTracks({ tracks: [{ artist: "Budakid", title: "Lovin’ Sun (Guy J Remix)" }] }, { tidal, roon: noQueueRoon });
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.tracks[0].status, "VERSION_MISMATCH");
  assert.equal(evidenceCalls, 0);
});

test("both exact Budakid remixes still verify across apostrophe and separate version fields", async () => {
  let evidenceCalls = 0;
  const { tidal } = harness([], { evidenceLookup: async () => { evidenceCalls++; throw new Error("Exact remix must not need generic evidence"); } });
  const requests = [
    { artist: "Budakid", title: "Lovin’ Sun (Guy J Remix)" },
    { artist: "Budakid", title: "Lovin' Sun (Hernan Cattaneo & Kevin Di Serna Remix)" }
  ];
  tidal.searchExactCandidates = async () => [
    { id: "559345090", source: "tidal", artist: "Budakid", title: "Lovin' Sun", mixVersion: "Guy J Remix", durationMs: 450000 },
    { id: "400774270", source: "tidal", artist: "Budakid", title: "Lovin’ Sun (Hernan Cattaneo & Kevin Di Serna Remix)", durationMs: 450000 }
  ];
  const result = await verifyExactTracks({ tracks: requests }, { tidal, roon: noQueueRoon });
  assert.equal(result.verifiedCount, 2);
  assert.deepEqual(result.tracks.map(row => row.tidalTrackId), ["559345090", "400774270"]);
  assert.equal(evidenceCalls, 0);
});

test("an ambiguous exact candidate pool is not resolved by a generic evidence lookup", async () => {
  let evidenceCalls = 0;
  const { tidal } = harness([], { evidenceLookup: async () => { evidenceCalls++; return null; } });
  tidal.searchExactCandidates = async () => [
    { id: "11", source: "tidal", ...cases[0].request, isrc: "GBLV62602095", durationMs: 411000 },
    { id: "12", source: "tidal", ...cases[0].request, isrc: "GBLV62602096", durationMs: 500000 }
  ];
  const result = await verifyExactTracks({ tracks: [cases[0].request] }, { tidal, roon: noQueueRoon });
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.tracks[0].status, "AMBIGUOUS");
  assert.equal(evidenceCalls, 0);
});

test("independent provider proof cannot overwrite an explicit supplied ISRC conflict", async () => {
  const { tidal } = harness([cases[0]]);
  tidal.searchExactCandidates = async () => [normalizedTidal(cases[0].tidal)];
  const request = { ...cases[0].request, isrc: "GBLV62601776" };
  const result = await verifyExactTracks({ tracks: [request] }, { tidal, roon: noQueueRoon });
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.tracks[0].usable, false);
  assert.equal(request.isrc, "GBLV62601776");
});

test("unproved Original Mix remains rejected when no independent evidence provider is configured", async () => {
  const { tidal } = harness([cases[0]], { noEvidence: true });
  tidal.searchExactCandidates = async () => [normalizedTidal(cases[0].tidal)];
  const result = await verifyExactTracks({ tracks: [cases[0].request] }, { tidal, roon: noQueueRoon });
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.tracks[0].status, "VERSION_MISMATCH");
});

test("identity caches distinguish a weak title request from one carrying strong recording facts", async () => {
  const { tidal } = harness([cases[0]], { noEvidence: true });
  assert.equal(await tidal.verify(cases[0].request, { strict: true }), null);
  const stronger = { ...cases[0].request, isrc: cases[0].beatport.isrc, durationMs: cases[0].beatport.durationMs,
    album: cases[0].beatport.album, label: cases[0].beatport.label, releaseDate: cases[0].beatport.releaseDate };
  const result = await tidal.verify(stronger, { strict: true });
  assert.ok(result);
  assert.equal(result.id, cases[0].tidal.id);
});

test("a positive Discovery identity cache does not override alternate pinned TIDAL IDs or nested Beatport identity conflicts", async () => {
  const { tidal, beatportSearches } = harness([cases[0]]);
  const resolved = await tidal.verify(cases[0].request, { strict: true });
  assert.equal(resolved.id, cases[0].tidal.id);
  assert.equal(beatportSearches.length, 1);
  for (const identity of [{ tidalId: "565769183" }, { tidal_id: "565769183" }]) {
    const conflicting = await tidal.verify({ ...cases[0].request, ...identity }, { strict: true });
    assert.equal(conflicting, null);
    assert.equal(beatportSearches.length, 1, "Pinned TIDAL identity must not launch generic recording recovery");
  }
  const conflictingBeatport = await tidal.verify({ ...cases[0].request, beatport: { id: "30545786" } }, { strict: true });
  assert.equal(conflictingBeatport, null);
  assert.equal(beatportSearches.length, 2, "Nested supplied identity must receive an independent identity-cache entry");
});

test("adding the evidence lookup invalidates an earlier negative identity-cache result", async () => {
  const { tidal } = harness([cases[0]], { noEvidence: true });
  assert.equal(await tidal.findExactTrack(cases[0].request, { strict: true, maxQueries: 1 }), null);
  const beatport = { isConfigured: () => true, searchTracks: async () => ({ tracks: [normalizedBeatport(cases[0].beatport)] }), getTrackById: async () => normalizedBeatport(cases[0].beatport) };
  tidal.setRequestedRecordingEvidenceLookup(createRequestedVersionEvidenceLookup({ beatport }));
  const result = await tidal.findExactTrack(cases[0].request, { strict: true, maxQueries: 1 });
  assert.ok(result);
  assert.equal(result.id, cases[0].tidal.id);
});

test("negative identity caches expire so temporarily unavailable recording proof can recover", async () => {
  let now = Date.parse("2026-10-09T16:40:00Z"), available = false, evidenceCalls = 0;
  const { tidal } = harness([cases[0]], { clock: () => now, evidenceLookup: async () => {
    evidenceCalls++;
    return available ? { provider: "beatport", track: normalizedBeatport(cases[0].beatport),
      sourceUrl: `https://www.beatport.com/track/${cases[0].beatport.id}`, checkedAt: new Date(now).toISOString() } : null;
  } });
  assert.equal(await tidal.findExactTrack(cases[0].request, { strict: true, maxQueries: 1 }), null);
  assert.equal(evidenceCalls, 1);
  available = true;
  assert.equal(await tidal.findExactTrack(cases[0].request, { strict: true, maxQueries: 1 }), null);
  assert.equal(evidenceCalls, 1);
  now += 60001;
  const result = await tidal.findExactTrack(cases[0].request, { strict: true, maxQueries: 1 });
  assert.ok(result);
  assert.equal(result.id, cases[0].tidal.id);
  assert.equal(evidenceCalls, 2);
});

test("generic evidence fallback is bounded when a provider callback ignores cancellation", async () => {
  let callbackSignal;
  const { tidal, requests } = harness([cases[0]], { timeoutMs: 50, evidenceLookup: async (_track, { signal }) => {
    callbackSignal = signal;
    return new Promise(() => {});
  } });
  const started = Date.now();
  const recovery = await tidal.findRequestedVersionMatch(cases[0].request, [normalizedTidal(cases[0].tidal)], { timeoutMs: 50 });
  assert.ok(Date.now() - started < 1500);
  assert.equal(Boolean(recovery?.selection?.match), false);
  assert.equal(callbackSignal.aborted, true);
  assert.equal(requests.length, 0);
});

test("all pinned TIDAL identity forms prevent a replacement recording lookup", async () => {
  let evidenceCalls = 0;
  const { tidal } = harness([cases[0]], { evidenceLookup: async () => { evidenceCalls++; return null; } });
  for (const identity of [
    { id: "565769183" }, { tidalTrackId: "565769183" }, { tidalId: "565769183" }, { tidal_id: "565769183" },
    { tidalUrl: "https://tidal.com/browse/track/565769183" }, { url: "https://tidal.com/browse/track/565769183" }
  ]) {
    const recovery = await tidal.findRequestedVersionMatch({ ...cases[0].request, ...identity }, [normalizedTidal(cases[0].tidal)]);
    assert.equal(Boolean(recovery?.selection?.match), false);
  }
  assert.equal(evidenceCalls, 0);
});

test("the supplied per-track deadline stops the new provider fallback", async () => {
  let callbackSignal;
  const { tidal } = harness([cases[0]], { timeoutMs: 1000, evidenceLookup: async (_track, { signal }) => {
    callbackSignal = signal;
    return new Promise(() => {});
  } });
  tidal.searchExactCandidates = async () => [normalizedTidal(cases[0].tidal)];
  const started = Date.now();
  const result = await verifyExactTracks({ tracks: [cases[0].request], perTrackTimeoutMs: 100 }, { tidal, roon: noQueueRoon });
  assert.ok(Date.now() - started < 1500);
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.tracks[0].usable, false);
  assert.ok(callbackSignal);
  assert.equal(callbackSignal.aborted, true);
});
