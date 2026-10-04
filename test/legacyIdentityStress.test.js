"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TidalVerifier } = require("../src/tidalVerifier");
const { chooseExact } = require("../src/exactTrackVerification");
const { matchBeatportVersionToTidal, rankBeatportCandidates } = require("../src/beatportVersionMatch");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body
  };
}

function tidalRow(id, artist, title, { album = "", year = null, version = "" } = {}) {
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
    artists: String(artist || "").split(/\s*,\s*/).filter(Boolean).map((name, index) => ({ id: `${id}-artist-${index}`, name })),
    album: album ? { id: `${id}-album`, title: album, releaseDate: year ? `${year}-01-01` : "" } : {}
  };
}

function verifierFor(row) {
  return new TidalVerifier({
    enabled: true,
    accessToken: "token",
    fetchImpl: async () => jsonResponse({ items: [row] })
  });
}

test("Body Language resolves M.A.N.D.Y. and Booka Shade credit punctuation safely", async () => {
  const result = await verifierFor(tidalRow("body-language", "MANDY, Booka Shade", "Body Language", { year: 2005 }))
    .findExactTrack({ artist: "M.A.N.D.Y. vs Booka Shade", title: "Body Language", recordingYear: 2005 }, { strict: true, maxQueries: 1, limit: 5 });

  assert.equal(result.id, "body-language");
  assert.equal(result.identityDiagnostics.artistRelation.type, "alias-equivalent");
  assert.equal(result.identityDiagnostics.artistAliasApplied, false);
  assert.equal(result.identityDiagnostics.artistCreditNormalizationRule, "punctuation-and-spacing-fold");
});

test("Cass & Slide uses the built-in trusted legacy alias", async () => {
  const result = await verifierFor(tidalRow("perception", "Cass (UK)", "Perception", { year: 2001 }))
    .findExactTrack({ artist: "Cass & Slide", title: "Perception", recordingYear: 2001 }, { strict: true, maxQueries: 1, limit: 5 });

  assert.equal(result.id, "perception");
  assert.equal(result.identityDiagnostics.artistAliasApplied, true);
  assert.equal(result.identityDiagnostics.aliasSource, "built-in-legacy-edm-alias");
  assert.deepEqual(result.identityDiagnostics.canonicalArtistCredits, ["Cass", "Slide"]);
});

test("James Holden accepts the trusted Holden/THOMPSON provider alias", async () => {
  const result = await verifierFor(tidalRow("nothing", "Holden, THOMPSON", "Nothing", { year: 2004 }))
    .findExactTrack({ artist: "James Holden", title: "Nothing", recordingYear: 2004 }, { strict: true, maxQueries: 1, limit: 5 });

  assert.equal(result.id, "nothing");
  assert.equal(result.identityDiagnostics.artistAliasApplied, true);
  assert.equal(result.identityDiagnostics.aliasSource, "built-in-legacy-edm-alias");
});

test("GusGus exposes the curated Gus Gus spacing alias", async () => {
  const result = await verifierFor(tidalRow("david", "Gus Gus", "David", { year: 1999 }))
    .findExactTrack({ artist: "GusGus", title: "David", recordingYear: 1999 }, { strict: true, maxQueries: 2, limit: 5 });

  assert.equal(result.id, "david");
  assert.equal(result.identityDiagnostics.artistAliasApplied, true);
  assert.equal(result.identityDiagnostics.aliasSource, "built-in-legacy-edm-alias");
});

test("legacy original-era candidates beat compilation duplicates across the stress anchors", () => {
  const cases = [
    ["Rank 1", "Airwave", 2000],
    ["Gabriel & Dresden", "Tracking Treasure Down", 2006],
    ["Max Graham", "Airtight", 2000],
    ["Dogzilla", "Without You", 2006],
    ["Motorcycle", "As The Rush Comes", 2003],
    ["Gui Boratto", "Beautiful Life", 2007]
  ];

  for (const [artist, title, year] of cases) {
    const original = {
      artist: artist === "Motorcycle" ? "Motorcycle, JES, Gabriel & Dresden" : artist,
      title,
      year,
      album: title,
      id: `${title}-original`,
      isrc: `${title}-ORIGINAL`,
      durationMs: 360000
    };
    const compilation = {
      artist: artist === "Gui Boratto" ? "Gui Boratto, Luciana Villanova" : artist,
      title,
      year: year + 8,
      album: `Various Artists: ${title}`,
      id: `${title}-compilation`,
      isrc: `${title}-COMPILATION`,
      durationMs: 300000
    };
    const result = chooseExact({ artist, title, recordingYear: year }, [compilation, original]);
    assert.equal(result.status, "VERIFIED_TIDAL_ONLY", `${artist} - ${title}`);
    assert.equal(result.match.id, original.id, `${artist} - ${title}`);
    assert.ok(result.expectedLegacyEra === year, `${artist} - ${title} should expose expected era`);
    assert.ok(result.canonicalCandidateGroups.every(group => Object.hasOwn(group, "compilationPenalty")), `${artist} - ${title} should expose tie-break diagnostics`);
  }
});

test("Reflekt 12-inch Club Mix can be principal only with original-release evidence", () => {
  const request = { artist: "Reflekt", title: "Need To Feel Loved", recordingYear: 2004 };
  const club = {
    id: "reflekt-12-inch-club",
    artist: "Reflekt, Delline Bass",
    title: "Need To Feel Loved (12\" Club Mix)",
    version: "12\" Club Mix",
    album: "Need To Feel Loved",
    year: 2004,
    durationMs: 447000
  };
  const result = chooseExact(request, [club]);
  assert.equal(result.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(result.match.id, club.id);
  assert.equal(result.canonicalPrincipalReleaseApplied, true);
  assert.equal(result.canonicalCandidateGroups[0].versionPreference.label, "canonical-12-inch-club-principal");

  const withPlain = chooseExact(request, [club, {
    id: "reflekt-plain",
    artist: "Reflekt",
    title: "Need To Feel Loved",
    album: "Need To Feel Loved",
    year: 2004,
    durationMs: 447000
  }]);
  assert.equal(withPlain.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(withPlain.match.id, "reflekt-plain");
  assert.equal(withPlain.canonicalCandidateGroups.find(group => group.canonicalCandidate.id === club.id).versionPreference.canonicalPrincipalReleaseApplied, false);
});

test("Gui Boratto plain canonical credit beats an equivalent added vocal credit", () => {
  const result = chooseExact({ artist: "Gui Boratto", title: "Beautiful Life" }, [
    {
      id: "gui-plain",
      artist: "Gui Boratto",
      title: "Beautiful Life",
      album: "Beautiful Life",
      label: "Kompakt",
      year: 2007,
      isrc: "plain-isrc"
    },
    {
      id: "gui-vocal-credit",
      artist: "Gui Boratto, Luciana Villanova",
      title: "Beautiful Life",
      album: "Beautiful Life",
      label: "Kompakt",
      year: 2007,
      isrc: "vocal-credit-isrc"
    }
  ]);

  assert.equal(result.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(result.match.id, "gui-plain");
  assert.equal(result.ambiguityResolvedBy, "canonical-lineage-tie-break");
  assert.equal(result.artistCreditPreferenceApplied, true);
  assert.ok(result.canonicalTieBreakReasons.includes("principal-canonical-artist-credit"));
});

test("catalog lineage can recover an original-era recording behind a reissue ISRC year", () => {
  const result = chooseExact({ artist: "Chicane", title: "Saltwater", recordingYear: 2000 }, [
    {
      id: "remixed-compilation",
      artist: "Chicane, Moya Brennan",
      title: "Saltwater",
      album: "Armada Classics - Remixed (Vol. 2)",
      year: 2020,
      isrcYear: 2008,
      durationMs: 203000
    },
    {
      id: "behind-the-sun-reissue",
      artist: "Chicane, Moya Brennan",
      title: "Saltwater",
      album: "Behind The Sun (2013 Deluxe Version)",
      year: 2000,
      isrcYear: 2013,
      durationMs: 203000
    }
  ]);

  assert.equal(result.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(result.match.id, "behind-the-sun-reissue");
  assert.equal(result.legacyCanonicalPreferenceApplied, true);
  assert.equal(result.canonicalCandidateGroups.find(group => group.canonicalCandidate.id === "behind-the-sun-reissue").candidateHasRequestedLegacyLineage, true);
});

test("Universal Nation Beatport preparation rejects the Charlotte de Witte rework when the original is present", () => {
  const tidal = { artist: "Push", title: "Universal Nation", recordingYear: 2000, durationMs: 390000, label: "Bonzai" };
  const ranked = rankBeatportCandidates(tidal, [
    { id: "rework", artist: "Push, Charlotte de Witte", title: "Universal Nation (Charlotte de Witte Rework)", year: 2024, durationMs: 330000 },
    { id: "original", artist: "Push", title: "Universal Nation", year: 2000, releaseDate: "2000-01-01", durationMs: 390000, label: "Bonzai" }
  ]);

  assert.equal(ranked.best.id, "original");
  assert.equal(ranked.selectedSafe, true);
  assert.ok(ranked.evaluated.find(item => item.candidate.id === "rework").rejectedDescriptor);
});

test("Universal Nation accepts aligned original catalog evidence despite a later ISRC year", () => {
  const result = chooseExact({ artist: "Push", title: "Universal Nation", recordingYear: 1999 }, [{
    id: "universal-nation-original",
    artist: "Push",
    title: "Universal Nation (Original Mix)",
    album: "Capsule",
    year: 1999,
    isrcYear: 2003,
    durationMs: 331000
  }]);

  assert.equal(result.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(result.match.id, "universal-nation-original");
  assert.equal(result.originalLineageEvidence.catalogOriginalLineage, true);
  assert.equal(result.originalLineageEvidence.reason, "original-catalog-lineage-compatible");
});

test("Without You Near Beatport preparation prefers the canonical form over a later remix", () => {
  const tidal = { artist: "Markus Schulz, Departure, Gabriel & Dresden", title: "Without You Near", recordingYear: 2007, durationMs: 400000, label: "Coldharbour Recordings" };
  const ranked = rankBeatportCandidates(tidal, [
    { id: "later-remix", artist: tidal.artist, title: "Without You Near", mixName: "Gabriel & Dresden Extended Remix", year: 2018, durationMs: 430000 },
    { id: "canonical", artist: tidal.artist, title: "Without You Near", year: 2007, releaseDate: "2007-01-01", durationMs: 400000, label: "Coldharbour Recordings" }
  ]);

  assert.equal(ranked.best.id, "canonical");
  assert.ok(ranked.evaluated.find(item => item.candidate.id === "later-remix").rejectedDescriptor);
});

test("Beachball does not substitute incompatible credits or form", () => {
  const tidal = { artist: "Nalin & Kane, Athenica", title: "Beachball", recordingYear: 1997, durationMs: 420000 };
  const result = matchBeatportVersionToTidal(tidal, {
    id: "wrong-credits",
    artist: "Nalin & Kane",
    title: "Beachball",
    year: 1997,
    durationMs: 220000
  });

  assert.equal(result.matched, false);
  assert.match(result.reasons.join("; "), /artist credits do not match exactly/);
});

test("strict legacy version safety remains fail-closed for unrequested club forms", () => {
  for (const [artist, title] of [
    ["Reflekt", "Need To Feel Loved"],
    ["Cosmic Gate", "Exploration of Space"],
    ["Deep Dish", "Flashdance"],
    ["Paul Oakenfold", "Southern Sun"]
  ]) {
    const result = chooseExact({ artist, title }, [{
      artist,
      title: `${title} (12\" Club Mix)`,
      version: "12\" Club Mix",
      id: `${title}-club`
    }]);
    assert.equal(result.status, "VERSION_MISMATCH", `${artist} - ${title}`);
  }
});

test("Universal Nation does not accept a later long-form Extended Mix as the 1999 original", () => {
  const result = chooseExact({ artist: "Push", title: "Universal Nation", recordingYear: 1999 }, [{
    id: "universal-nation-2009-extended",
    artist: "Push",
    title: "Universal Nation (Extended Mix)",
    version: "Extended Mix",
    album: "Universal Nation",
    year: 2009,
    durationMs: 500000
  }]);

  assert.equal(result.status, "VERSION_MISMATCH");
  assert.equal(result.canonicalPrincipalReleaseApplied, false);
  assert.equal(result.canonicalPrincipalReleaseReason, "not-12-inch-club-mix");
});

test("ATB 9 PM keeps the plain canonical recording when it is available", () => {
  const result = chooseExact({ artist: "ATB", title: "9 PM (Till I Come)", recordingYear: 1999 }, [
    { artist: "ATB", title: "9 PM (Till I Come) (Club Mix)", version: "Club Mix", year: 1999, id: "club" },
    { artist: "ATB", title: "9 PM (Till I Come)", year: 1999, id: "plain" }
  ]);
  assert.equal(result.status, "VERIFIED_TIDAL_ONLY");
  assert.equal(result.match.id, "plain");
});
