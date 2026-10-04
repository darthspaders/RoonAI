const assert = require("node:assert/strict");
const test = require("node:test");
const { TidalVerifier, buildExactSearchPlans } = require("../src/tidalVerifier");
const { parseCanonicalCatalogIdentity } = require("../src/catalogIdentityNormalization");
const { currentSearchDocument, isCurrentSearchRequest } = require("./tidalSearchFixture");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body
  };
}

function row(id, artist, title, { album = "", year = null, version = "" } = {}) {
  const attributes = {
    title,
    externalLinks: [{ href: `https://tidal.com/browse/track/${id}` }]
  };
  if (version) attributes.version = version;
  if (year) attributes.releaseDate = `${year}-01-01`;
  return {
    id: String(id),
    type: "tracks",
    attributes,
    artists: artist ? artist.split(/\s*,\s*/).map((name, index) => ({ id: `${id}-artist-${index}`, name })) : [],
    album: album ? { id: `${id}-album`, title: album, releaseDate: year ? `${year}-01-01` : "" } : {}
  };
}

test("legacy exact retrieval keeps generic-title collisions below artist-constrained candidates", async () => {
  const queries = [];
  const verifier = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    fetchImpl: async url => {
      const searchUrl = new URL(url);
      assert.ok(isCurrentSearchRequest(searchUrl));
      const query = searchUrl.searchParams.get("filter[query]");
      queries.push(query);
      const items = query.toLowerCase().includes("james holden")
        ? [row("sinatra", "Frank Sinatra", "Nothing"), row("holden", "James Holden", "Nothing")]
        : [row("sinatra-title", "Frank Sinatra", "Nothing"), row("holden-title", "James Holden", "Nothing")];
      return jsonResponse(currentSearchDocument({
        data: items.map(({ id, type }) => ({ id, type })),
        included: items
      }, "tracks", query));
    }
  });

  const result = await verifier.findExactTrack({ artist: "James Holden", title: "Nothing" }, { maxQueries: 4, limit: 5 });
  assert.equal(result.id, "holden");
  assert.match(queries[0], /james holden/i);
  assert.equal(result.legacySearchDiagnostics.queriesAttempted[0].artistConstraintApplied, true);
  assert.equal(result.legacySearchDiagnostics.topCandidatesBeforeFilter.some(candidate => candidate.artist === "Frank Sinatra"), true);
  assert.equal(result.legacySearchDiagnostics.topCandidatesAfterFilter.some(candidate => candidate.artist === "Frank Sinatra"), false);
  assert.equal(result.legacySearchDiagnostics.candidatePreFilterCounts.rejectionReasons["no-artist-overlap-or-alias"], 1);
});

test("exact lookup reuses a validated TIDAL identity before declaring a legacy title missing", async () => {
  const verifier = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    validatedIdentityLookup: () => [{
      id: "2352515",
      tidalId: "2352515",
      artist: "James Holden",
      title: "A Break In The Clouds (Main Mix)",
      mixVersion: "Main Mix",
      releaseDate: "2004-01-01",
      validatedIdentitySource: "music-memory-track-identity"
    }],
    fetchImpl: async url => new URL(url).pathname.endsWith("/tracks/2352515")
      ? jsonResponse({ data: row("2352515", "James Holden", "A Break In The Clouds", { album: "A Break In The Clouds", year: 2004, version: "Main Mix" }) })
      : jsonResponse({ items: [] })
  });

  const result = await verifier.findExactTrack({ artist: "Holden", title: "A Break in the Clouds" }, { strict: true, maxQueries: 1 });
  assert.equal(result.id, "2352515");
  assert.equal(result.validatedIdentityReuse, true);
  assert.equal(verifier.lastExactIdentityDiagnostics.validatedIdentityReuse, true);
  assert.equal(verifier.lastExactIdentityDiagnostics.expectedLegacyEra, 2004);
  assert.equal(verifier.lastExactIdentityDiagnostics.expectedLegacyEraSource, "validated-identity-release-year");
  assert.equal(verifier.lastExactIdentityDiagnostics.identityRules[0], "validated-tidal-identity-reused-before-not-found");
});

test("legacy search plans apply album and era constraints before title-only fallback", () => {
  const plans = buildExactSearchPlans({
    artist: "Rank 1",
    title: "Airwave",
    album: "Symsonic",
    recordingYear: 2000
  });
  assert.equal(plans[0].searchStage, "exact-artist-title");
  assert.equal(plans[0].artistConstraintApplied, true);
  const albumIndex = plans.findIndex(plan => plan.searchStage === "artist-album-base-title");
  const eraIndex = plans.findIndex(plan => plan.searchStage === "artist-era-base-title");
  const titleOnlyIndex = plans.findIndex(plan => plan.titleOnlyFallback);
  assert.ok(albumIndex > 0);
  assert.ok(eraIndex > albumIndex);
  assert.ok(titleOnlyIndex > eraIndex);
  assert.equal(plans[albumIndex].albumConstraintApplied, true);
  assert.equal(plans[eraIndex].eraConstraintApplied, true);
});

test("early-EDM legacy titles keep artist-constrained retrieval ahead of title-only fallback", () => {
  const cases = [
    ["Infusion", "Girls Can Be Cruel"],
    ["Silicone Soul", "Right On!"],
    ["Cass & Slide", "Perception"],
    ["Rank 1", "Airwave"],
    ["Gabriel & Dresden", "Tracking Treasure Down"],
    ["Push", "Universal Nation"],
    ["OceanLab", "Clear Blue Water"],
    ["Markus Schulz", "Without You Near"],
    ["Armin van Buuren", "Burned With Desire"]
  ];

  for (const [artist, title] of cases) {
    const plans = buildExactSearchPlans({ artist, title, recordingYear: 2004 }, { strict: false });
    assert.ok(plans.length >= 2, `${artist} - ${title} should have a fallback plan`);
    assert.equal(plans[0].artistConstraintApplied, true, `${artist} - ${title} should start artist-constrained`);
    const artistTokens = artist.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    assert.ok(artistTokens.every(token => plans[0].query.toLowerCase().includes(token)), `${artist} - ${title} should include the requested artist`);
    const titleOnlyIndex = plans.findIndex(plan => plan.titleOnlyFallback);
    assert.ok(titleOnlyIndex > 0, `${artist} - ${title} should defer title-only fallback`);
    assert.equal(plans.at(-1).titleOnlyFallback, true, `${artist} - ${title} should end with title-only fallback`);
  }
});

test("retrieval suppresses unrequested remix pollution without removing it from before-filter diagnostics", async () => {
  const verifier = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    fetchImpl: async () => jsonResponse({ items: [
      row("rework", "Push", "Universal Nation (Charlotte de Witte Rework)", { year: 2024, version: "Charlotte de Witte Rework" }),
      row("original", "Push", "Universal Nation", { year: 2000 })
    ] })
  });
  const result = await verifier.findExactTrack({ artist: "Push", title: "Universal Nation", recordingYear: 2000 }, { maxQueries: 1, limit: 5 });
  assert.equal(result.id, "original");
  assert.equal(result.legacySearchDiagnostics.remixSuppressionApplied, true);
  assert.equal(result.legacySearchDiagnostics.topCandidatesBeforeFilter.some(candidate => candidate.id === "rework"), true);
  assert.equal(result.legacySearchDiagnostics.topCandidatesAfterFilter.some(candidate => candidate.id === "rework"), true, "same-artist alternate remains available for strict identity diagnostics");
});

test("explicit stored artist aliases constrain retrieval and participate in exact identity safely", async () => {
  const verifier = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    artistAliases: [{
      canonicalArtistIdentity: "Cass & Slide",
      aliases: ["Cass (UK)"],
      source: "manual-catalog-mapping"
    }],
    fetchImpl: async () => jsonResponse({ items: [row("perception", "Cass (UK)", "Perception")] })
  });
  const result = await verifier.findExactTrack({ artist: "Cass & Slide", title: "Perception" }, { strict: true, maxQueries: 1, limit: 5 });
  assert.equal(result.id, "perception");
  assert.equal(result.identityDiagnostics.artistRelation.type, "alias-equivalent");
  assert.equal(result.legacySearchDiagnostics.artistAliasApplied, true);
  assert.equal(result.legacySearchDiagnostics.aliasSource, "manual-catalog-mapping");
  assert.equal(result.legacySearchDiagnostics.canonicalArtistIdentity, "Cass & Slide");
});

test("ordinary title words containing with remain title text, while structural with credits still parse", () => {
  const title = parseCanonicalCatalogIdentity({ title: "Burned With Desire" });
  assert.equal(title.normalizedBaseTitle, "burned with desire");
  assert.deepEqual(title.normalizedFeaturedArtists, []);

  const credit = parseCanonicalCatalogIdentity({ title: "Track - with Desire" });
  assert.equal(credit.normalizedBaseTitle, "track");
  assert.deepEqual(credit.normalizedFeaturedArtists, ["desire"]);
});

test("exact candidate retrieval exposes its query envelope to MCP verification", async () => {
  const verifier = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    fetchImpl: async () => jsonResponse({ items: [row("moan", "Trentemøller", "Moan")] })
  });
  const candidates = await verifier.searchExactCandidates({ artist: "Trentemoller", title: "Moan" });
  assert.equal(candidates.length, 1);
  assert.equal(candidates.legacySearchDiagnostics.queriesAttempted.length, 1);
  assert.equal(candidates.legacySearchDiagnostics.queriesAttempted[0].artistConstraintApplied, true);
  assert.equal(candidates.legacySearchDiagnostics.candidateCountPerQuery[0].accepted, 1);
});
