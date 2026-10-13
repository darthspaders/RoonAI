"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const capture = require("./fixtures/supplied-track-retrieval-capture.json");
const { TidalVerifier } = require("../src/tidalVerifier");
const { verifyExactTracks } = require("../src/exactTrackVerification");

const requested = [
  { artist: "Budakid", title: "Lovin' Sun (Guy J Remix)" },
  { artist: "Budakid", title: "Lovin' Sun (Hernan Cattaneo & Kevin Di Serna Remix)" },
  { artist: "Makebo", title: "From Zero (Original Mix)" },
  { artist: "NAKSHATRA", title: "Sunset at Lake Pichola (Extended Mix)" },
  { artist: "Matthew Sona", title: "Prismatik (Original Mix)" }
];

function fixture({ filterRows } = {}) {
  const queries = [], searchOptions = [];
  const packets = new Map(capture.queries.map(entry => [entry.query, entry.response]));
  let verifier;
  verifier = new TidalVerifier({
    enabled: true,
    accessToken: "fixture-only-token",
    countryCode: capture.countryCode,
    clock: () => 0,
    sleep: async () => {},
    artistAliasFile: path.join(__dirname, "fixtures", "absent-retrieval-artist-aliases.json"),
    catalogPaginationFile: path.join(__dirname, "fixtures", "absent-retrieval-pagination.json"),
    validatedIdentityLookup: async () => [],
    fetchImpl: async input => {
      const url = new URL(input);
      assert.equal(url.hostname, "openapi.tidal.com");
      assert.ok(url.pathname === "/v2/searchResults", "no detail/auth/provider calls are allowed");
      const query = url.searchParams.get("filter[query]");
      assert.ok(packets.has(query), `Uncaptured query: ${query}`);
      queries.push(query);
      verifier.nextExactRequestAt = 0;
      const json = structuredClone(packets.get(query));
      if (filterRows) json.data = json.data.filter(row => filterRows(row, query));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => json };
    }
  });
  const search = verifier.searchExactCandidates.bind(verifier);
  verifier.searchExactCandidates = (track, options) => {
    searchOptions.push(options);
    return search(track, options);
  };
  return { verifier, queries, searchOptions };
}

for (const [index, id] of [[0, "559345090"], [1, "400774270"]]) {
  test(`captured trailing-apostrophe search recovers only ${requested[index].title}`, async () => {
    const { verifier, queries } = fixture();
    const result = await verifyExactTracks({ tracks: [requested[index]], concurrency: 1 }, { tidal: verifier });
    const row = result.tracks[0];
    assert.equal(row.status, "TIDAL_VERIFIED_ROON_PENDING");
    assert.equal(row.tidalTrackId, id);
    assert.equal(row.matchedTitle, requested[index].title);
    assert.equal(row.identityOutcome, "VERIFIED_EXACT");
    assert.deepEqual(queries.slice(-2), ["Budakid Lovin' Sun", "Budakid Lovin Sun"]);
    assert.equal(new Set(queries).size, queries.length, "initial query must not be repeated as fallback");
    assert.equal(row.identityDiagnostics.canonicalFallbackCandidates.at(-1).query, "Budakid Lovin Sun");
  });
}

test("captured Makebo candidate remains a version mismatch after later unrelated searches", async () => {
  const { verifier, queries } = fixture();
  const result = await verifyExactTracks({ tracks: [requested[2]], concurrency: 1 }, { tidal: verifier });
  const row = result.tracks[0];
  assert.equal(row.status, "VERSION_MISMATCH");
  assert.equal(result.verifiedCount, 0);
  assert.deepEqual(queries.slice(-2), ["From Zero (Original Mix)", "From Zero"]);
  assert.equal(row.identityDiagnostics.candidateIdentities.length, 1);
  assert.equal(row.identityDiagnostics.candidateIdentities[0].id, "565212426");
  assert.equal(row.identityDiagnostics.candidateIdentities[0].rejectionReason, "original-version-equivalence-lacks-strong-recording-evidence");
});

test("captured five-track replay recovers two named remixes and preserves three unproven versions", async () => {
  const { verifier } = fixture();
  const result = await verifyExactTracks({ tracks: requested, concurrency: 1 }, { tidal: verifier });
  assert.deepEqual(result.tracks.map(row => row.status), [
    "TIDAL_VERIFIED_ROON_PENDING", "TIDAL_VERIFIED_ROON_PENDING", "VERSION_MISMATCH", "VERSION_MISMATCH", "VERSION_MISMATCH"
  ]);
  assert.equal(result.verifiedCount, 2);
  assert.equal(result.tracks[3].identityDiagnostics.candidateIdentities[0].rejectionReason, "version-kind-mismatch");
  assert.equal(result.tracks[4].identityDiagnostics.candidateIdentities[0].rejectionReason, "original-version-equivalence-lacks-strong-recording-evidence");
});

test("broader punctuation retrieval still rejects a different named remix", async () => {
  const { verifier, queries } = fixture({ filterRows: row => row.id !== "559345090" });
  const result = await verifyExactTracks({ tracks: [requested[0]] }, { tidal: verifier });
  assert.ok(queries.includes("Budakid Lovin Sun"));
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.tracks[0].status, "VERSION_MISMATCH");
  assert.equal(result.tracks[0].identityDiagnostics.candidateIdentities[0].id, "400774270");
  assert.equal(result.tracks[0].identityDiagnostics.candidateIdentities[0].rejectionReason, "version-descriptor-mismatch");
});

test("verification diagnostics are opt-in, forwarded to searches, and contain safe identity decisions", async () => {
  for (const diagnostics of [undefined, false, true]) {
    const { verifier, searchOptions } = fixture();
    const events = [];
    const result = await verifyExactTracks({ tracks: [requested[2]], diagnostics }, { tidal: verifier, logger: entry => events.push(entry) });
    assert.equal(result.tracks[0].status, "VERSION_MISMATCH");
    assert.ok(searchOptions.every(options => options.diagnostics === (diagnostics === true)));
    const own = events.filter(entry => entry.event?.startsWith("exact_verification_"));
    if (diagnostics !== true) assert.equal(own.length, 0);
    else {
      const request = own.find(entry => entry.event === "exact_verification_request");
      assert.equal(request.requestedIdentity.title, requested[2].title);
      assert.equal(request.normalizedIdentity.baseTitle, "from zero");
      const candidates = own.filter(entry => entry.event === "exact_verification_candidates");
      assert.ok(candidates.some(entry => entry.query === "Makebo From Zero" && entry.candidates.some(candidate => candidate.id === "565212426")));
      const final = own.filter(entry => entry.event === "exact_verification_selection").at(-1);
      assert.equal(final.status, "VERSION_MISMATCH");
      assert.equal(final.candidates[0].tidalTrackId, "565212426");
      assert.equal(final.candidates[0].rejectionReason, "original-version-equivalence-lacks-strong-recording-evidence");
      assert.equal(final.candidates[0].versionRelation, "ORIGINAL_EQUIVALENT_TO_UNLABELED");
      assert.doesNotMatch(JSON.stringify(own), /fixture-only-token|authorization|accessToken|bearer|cookie/i);
    }
  }
});

test("throwing opt-in diagnostic sink cannot change exact verification", async () => {
  const { verifier } = fixture();
  const result = await verifyExactTracks({ tracks: [requested[0]], diagnostics: true }, {
    tidal: verifier, logger: () => { throw Error("diagnostic sink unavailable"); }
  });
  assert.equal(result.tracks[0].status, "TIDAL_VERIFIED_ROON_PENDING");
  assert.equal(result.tracks[0].tidalTrackId, "559345090");
});
