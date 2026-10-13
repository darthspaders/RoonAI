"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { TidalVerifier, buildExactSearchPlans } = require("../src/tidalVerifier");

const examples = [
  {
    name: "Lion's Mane / Dmitry Molosh",
    requested: { artist: "Madloch, Subnode", title: "Lion's Mane (Dmitry Molosh Remix)" },
    queries: ["Madloch Subnode Lion's Mane (Dmitry Molosh Remix)", "Madloch Subnode Lion's Mane"],
    fallback: "Madloch Subnode Lion s Mane",
    candidate: { id: "125960824", artist: "Madloch, Subnode", title: "Lion's Mane (Dmitry Molosh Remix)", duration: "PT7M12S", isrc: "US83Z1936005", releaseDate: "2020-01-27" },
    wrongRemix: "Lion's Mane (Navar Remix)",
    original: "Lion's Mane",
    outcome: "VERIFIED_EXACT"
  },
  {
    name: "L'Amour Toujours / Hernan Cattaneo and Kevin Di Serna",
    requested: { artist: "Christian Smith, Kevin di Serna", title: "L'Amour Toujours (Hernan Cattaneo & Kevin Di Serna Remix)" },
    queries: ["Christian Smith Kevin di Serna L'Amour Toujours (Hernan Cattaneo Kevin Di Serna Remix)", "Christian Smith Kevin di Serna L'Amour Toujours"],
    fallback: "Christian Smith Kevin di Serna L Amour Toujours",
    candidate: { id: "456999004", artist: "Christian Smith", title: "L'Amour Toujours (Hernan Cattaneo & Kevin Di Serna Remix)", duration: "PT7M2S", isrc: "GBKQU2589040", releaseDate: "2025-09-05" },
    wrongRemix: "L'Amour Toujours (Vantage Remix)",
    original: "L'Amour Toujours (Extended Mix)",
    outcome: "VERIFIED_EQUIVALENT_RECORDING"
  }
];

function catalogRow(candidate) {
  return {
    id: candidate.id,
    type: "tracks",
    attributes: {
      title: candidate.title,
      duration: candidate.duration,
      isrc: candidate.isrc,
      releaseDate: candidate.releaseDate,
      externalLinks: [{ href: `https://tidal.com/browse/track/${candidate.id}` }]
    },
    artists: candidate.artist.split(/\s*,\s*/).map((name, index) => ({ id: `${candidate.id}-artist-${index}`, name })),
    album: { id: `${candidate.id}-album`, title: "Fixture release", releaseDate: candidate.releaseDate }
  };
}

function lookupFixture(example, fallbackRows) {
  const queries = [];
  const verifier = new TidalVerifier({
    enabled: true,
    accessToken: "fixture-only-token",
    clock: () => 0,
    sleep: async () => {},
    artistAliasFile: path.join(__dirname, "fixtures", "absent-apostrophe-artist-aliases.json"),
    catalogPaginationFile: path.join(__dirname, "fixtures", "absent-apostrophe-pagination.json"),
    fetchImpl: async input => {
      const url = new URL(input);
      assert.equal(url.hostname, "openapi.tidal.com");
      assert.ok(url.pathname === "/v2/searchResults", "fixtures must never request live track details or authentication");
      assert.equal(url.searchParams.has("limit"), false);
      const query = url.searchParams.get("filter[query]");
      queries.push(query);
      assert.ok([...example.queries, example.fallback].includes(query), `Unexpected query: ${query}`);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ items: query === example.fallback ? fallbackRows : [] })
      };
    }
  });
  return { verifier, queries };
}

for (const example of examples) {
  test(`${example.name}: original queries miss, apostrophe-spaced base query recovers the strict recording`, async () => {
    const requested = Object.freeze({ ...example.requested });
    const before = { ...requested };
    const correct = catalogRow(example.candidate);
    const wrong = catalogRow({ ...example.candidate, id: "999", title: example.wrongRemix, isrc: "ZZZZZ0000000" });
    const { verifier, queries } = lookupFixture(example, [wrong, correct]);

    const originalOnly = await verifier.findExactTrack(requested, { strict: true, limit: 10, maxQueries: 2 });
    assert.equal(originalOnly, null);
    assert.deepEqual(queries, example.queries);

    const result = await verifier.findExactTrack(requested, { strict: true, limit: 10, maxQueries: 6 });
    assert.equal(result.id, example.candidate.id);
    assert.equal(result.title, example.requested.title);
    assert.equal(result.artist, example.candidate.artist);
    assert.equal(result.isrc, example.candidate.isrc);
    assert.equal(result.identityOutcome, example.outcome);
    assert.deepEqual(result.identityDiagnostics.artistRelation.requestedCredits, example.requested.artist.split(/\s*,\s*/));
    assert.equal(result.identityDiagnostics.artistAliasApplied, false);
    assert.deepEqual(requested, before);
    assert.deepEqual(queries.slice(2), [...example.queries, example.fallback]);
    assert.equal(verifier.lastExactIdentityDiagnostics.legacySearchDiagnostics.queriesAttempted.at(-1).candidateSourceQuery, example.fallback);
  });

  test(`${example.name}: punctuation fallback rejects another named remix`, async () => {
    const wrong = catalogRow({ ...example.candidate, title: example.wrongRemix });
    const { verifier, queries } = lookupFixture(example, [wrong]);
    assert.equal(await verifier.findExactTrack(example.requested, { strict: true, limit: 10, maxQueries: 6 }), null);
    assert.deepEqual(queries, [...example.queries, example.fallback]);
    assert.equal(verifier.lastExactIdentityDiagnostics.finalIdentityOutcome, "VERSION_MISMATCH");
  });

  test(`${example.name}: punctuation fallback rejects the original or extended mix`, async () => {
    const original = catalogRow({ ...example.candidate, title: example.original });
    const { verifier } = lookupFixture(example, [original]);
    assert.equal(await verifier.findExactTrack(example.requested, { strict: true, limit: 10, maxQueries: 6 }), null);
  });

  test(`${example.name}: punctuation fallback rejects a different artist with the same remix title`, async () => {
    const wrongArtist = catalogRow({ ...example.candidate, artist: "Unrelated Artist" });
    const { verifier } = lookupFixture(example, [wrongArtist]);
    assert.equal(await verifier.findExactTrack(example.requested, { strict: true, limit: 10, maxQueries: 6 }), null);
  });
}

test("apostrophe base fallback stays before aliases and inside the six-query budget", () => {
  const plans = buildExactSearchPlans({ ...examples[0].requested, artistAliases: ["Alias A", "Alias B", "Alias C"], album: "Release", year: 2020 }, { strict: true });
  assert.equal(plans[2].query, examples[0].fallback);
  assert.equal(plans[2].searchStage, "exact-artist-base-title-apostrophe-fallback");
  assert.equal(plans[2].artistConstraintApplied, true);
  assert.equal(plans[2].titleConstraintApplied, true);
  assert.equal(plans[2].artistAliasApplied, false);
  assert.equal(plans[2].titleOnlyFallback, false);
  assert.equal(plans.some(plan => plan.query.startsWith("Subnode Lion")), false, "component credits must not become identity aliases");
});

test("apostrophe base fallback supports typographic apostrophes and deduplicates plain titles", () => {
  const plans = buildExactSearchPlans({ artist: "Artist", title: "Lion\u2019s Mane (Named Remix)" }, { strict: true });
  assert.equal(plans[2].query, "Artist Lion s Mane");
  assert.deepEqual(buildExactSearchPlans({ artist: "Artist", title: "Plain Title (Named Remix)" }, { strict: true }).map(plan => plan.query), ["Artist Plain Title (Named Remix)", "Artist Plain Title"]);
  const bare = buildExactSearchPlans({ artist: "Artist", title: "L'Amour" }, { strict: true });
  assert.deepEqual(bare.map(plan => plan.query), ["Artist L'Amour", "Artist L Amour"]);
  assert.equal(buildExactSearchPlans({ artist: "Artist", title: "' (Named Remix)" }, { strict: true }).some(plan => plan.searchStage.endsWith("apostrophe-fallback")), false, "never create an artist-only fallback");
});

test("strict lookup still honors a one-query cap instead of forcing the fallback", async () => {
  for (const example of examples) {
    const { verifier, queries } = lookupFixture(example, [catalogRow(example.candidate)]);
    assert.equal(await verifier.findExactTrack(example.requested, { strict: true, limit: 10, maxQueries: 1 }), null);
    assert.deepEqual(queries, [example.queries[0]]);
  }
});
