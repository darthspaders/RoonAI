"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { matchBeatportVersionToTidal, rankBeatportCandidates } = require("../src/beatportVersionMatch");
const anuqram = require("./fixtures/anuqram-remix.json");

const tidalTrack = {
  tidalId: "555732256",
  artist: "D-Nox, M.O.S.",
  title: "Dream On",
  label: "Sprout",
  releaseDate: "2026-09-11",
  durationMs: 232000,
  isrc: "US83Z2657966"
};

test("Beatport Extended Mix can be a high-confidence proxy for a shorter TIDAL version", () => {
  const result = matchBeatportVersionToTidal(tidalTrack, {
    id: "30374303",
    artist: "D-Nox, M.O.S.",
    title: "Dream On",
    mixName: "Extended Mix",
    label: "Sprout",
    releaseDate: "2026-09-11",
    durationMs: 410322,
    isrc: "US83Z2657964"
  });

  assert.equal(result.matched, true);
  assert.equal(result.relation, "version-proxy");
  assert.equal(result.confidence, "high");
  assert.equal(result.diagnostics.isrcMatch, false);
  assert.ok(result.warnings.some((warning) => warning.includes("ISRC differs")));
});

test("Beatport bare mix names are normalized as safe version proxies", () => {
  const result = matchBeatportVersionToTidal({
    artist: "NOTSOBAD / Able Faces",
    title: "Hollow Ground",
    label: "Selected.",
    releaseDate: "2024-06-14",
    durationMs: 169000,
    isrc: "DES232400220"
  }, {
    id: "19033363",
    artist: "Able Faces, NOTSOBAD",
    title: "Hollow Ground",
    mixName: "Extended",
    label: "Selected.",
    releaseDate: "2024-06-14",
    durationMs: 217352,
    isrc: "DES232400221"
  }, { requestedBeatportTrackId: "19033363" });

  assert.equal(result.matched, true);
  assert.equal(result.relation, "version-proxy");
  assert.equal(result.diagnostics.beatportDescriptor, "extended mix");
  assert.ok(result.reasons.some((reason) => reason.includes("extended mix")));
});

test("title overlap alone cannot create a Beatport version proxy", () => {
  const result = matchBeatportVersionToTidal(tidalTrack, {
    artist: "A Different Artist",
    title: "Dream On",
    mixName: "Extended Mix",
    label: "Sprout",
    releaseDate: "2026-09-11"
  });

  assert.equal(result.matched, false);
  assert.equal(result.relation, "rejected");
  assert.match(result.reasons.join("; "), /artist credits do not match exactly/);
});

test("artist punctuation and duplicate credits are normalized without weakening strict artist sets", () => {
  const result = matchBeatportVersionToTidal({
    artist: "Luci / Point.Blank / Point Blank",
    title: "Wonky",
    isrc: "QMBZ92039199"
  }, {
    id: "17771962",
    artist: "Luci, Point.Blank",
    title: "Wonky",
    isrc: "QMBZ92039199"
  }, { requestedBeatportTrackId: "17771962" });

  assert.equal(result.matched, true);
  assert.equal(result.relation, "exact");
  assert.equal(result.diagnostics.artistMatchMethod, "normalized-credit-set");
  assert.equal(result.diagnostics.beatportTrackIdMatch, true);
  assert.ok(result.reasons.some((reason) => reason.includes("17771962")));

  const extraArtist = matchBeatportVersionToTidal({
    artist: "Luci / Point.Blank / Point Blank",
    title: "Wonky",
    isrc: "QMBZ92039199"
  }, {
    id: "17771962",
    artist: "Luci, Point.Blank, Another Artist",
    title: "Wonky",
    isrc: "QMBZ92039199"
  }, { requestedBeatportTrackId: "17771962" });
  assert.equal(extraArtist.matched, false);
  assert.match(extraArtist.reasons.join("; "), /artist credits do not match exactly/);
});

test("a supplied Beatport track id must agree with the fetched candidate", () => {
  const result = matchBeatportVersionToTidal({
    artist: "D-Nox, M.O.S.",
    title: "Dream On",
    isrc: "US83Z2657966"
  }, {
    id: "30374303",
    artist: "D-Nox, M.O.S.",
    title: "Dream On",
    mixName: "Extended Mix",
    label: "Sprout",
    releaseDate: "2026-09-11",
    isrc: "US83Z2657964"
  }, { requestedBeatportTrackId: "99999999" });

  assert.equal(result.matched, false);
  assert.match(result.reasons.join("; "), /Beatport track ID does not match/);
  assert.equal(result.diagnostics.beatportTrackIdMatch, false);
});

test("remix and bootleg versions fail closed", () => {
  for (const mixName of ["Remix", "Bootleg", "VIP", "Radio Edit"]) {
    const result = matchBeatportVersionToTidal(tidalTrack, {
      artist: tidalTrack.artist,
      title: tidalTrack.title,
      mixName,
      label: tidalTrack.label,
      releaseDate: tidalTrack.releaseDate
    });
    assert.equal(result.matched, false, mixName);
    assert.equal(result.relation, "rejected", mixName);
  }
});

test("the verified ANUQRAM remix is an exact recording even with version proxies disabled", () => {
  for (const track of [anuqram.tidal, { ...anuqram.tidal, title: "A Better Place", version: "ANUQRAM Remix" }]) {
    const result = matchBeatportVersionToTidal(track, anuqram.beatport, {
      allowVersionProxy: false, requestedBeatportTrackId: "24501011"
    });
    assert.equal(result.matched, true);
    assert.equal(result.relation, "exact");
    assert.equal(result.diagnostics.exactRemixIdentity, true);
    assert.equal(result.diagnostics.durationDeltaMs, 200);
    assert.equal(result.diagnostics.isrcMatch, true);
  }
});

test("matching a named remix requires agreeing ISRCs and close known durations", () => {
  for (const change of [
    { isrc: "" }, { isrc: "US83Z2612358" }, { durationMs: null },
    { durationMs: anuqram.tidal.durationMs + 5001 }
  ]) {
    const result = matchBeatportVersionToTidal(anuqram.tidal, { ...anuqram.beatport, ...change });
    assert.equal(result.matched, false, JSON.stringify(change));
  }
  const missingDuration = matchBeatportVersionToTidal({ ...anuqram.tidal, durationMs: null }, anuqram.beatport);
  assert.equal(missingDuration.matched, false);
});

test("the same ISRC and Beatport ID never override a different remix or recording form", () => {
  for (const mixName of [
    "Other Artist Remix", "ANUQRAM Extended Remix", "ANUQRAM Remix Edit",
    "ANUQRAM Radio Edit", "ANUQRAM Rework", "Original Mix", ""
  ]) {
    const result = matchBeatportVersionToTidal(anuqram.tidal, { ...anuqram.beatport, mixName }, {
      requestedBeatportTrackId: "24501011"
    });
    assert.equal(result.matched, false, mixName);
  }
  for (const title of ["A Better Place", "A Better Place (Original Mix)"]) {
    const result = matchBeatportVersionToTidal({ ...anuqram.tidal, title }, anuqram.beatport);
    assert.equal(result.matched, false, title);
  }
});

test("a matching remix descriptor cannot override artist, title, or requested ID conflicts", () => {
  for (const change of [{ artist: "Different Artist" }, { title: "Different Track" }, { id: "24501012" }]) {
    const result = matchBeatportVersionToTidal(anuqram.tidal, { ...anuqram.beatport, ...change }, {
      requestedBeatportTrackId: "24501011"
    });
    assert.equal(result.matched, false, JSON.stringify(change));
  }
});

test("conflicting version fields cannot hide an edit or a different remix", () => {
  for (const track of [
    { ...anuqram.tidal, version: "Other Artist Remix" },
    { ...anuqram.tidal, title: "A Better Place (Mixed)", version: "ANUQRAM Remix" },
    { ...anuqram.tidal, mixVersion: "ANUQRAM Remix", version: "ANUQRAM Remix Edit" }
  ]) {
    assert.equal(matchBeatportVersionToTidal(track, anuqram.beatport).matched, false);
  }
  const candidate = { ...anuqram.beatport, title: "A Better Place (ANUQRAM Remix Edit)" };
  assert.equal(matchBeatportVersionToTidal(anuqram.tidal, candidate).matched, false);
});

test("candidate ranking does not penalize a verified remix as an unsafe proxy", () => {
  const ranked = rankBeatportCandidates(anuqram.tidal, [
    { ...anuqram.beatport, id: "other", mixName: "Other Artist Remix" },
    { ...anuqram.beatport, id: "original", mixName: "Original Mix" },
    anuqram.beatport
  ]);
  assert.equal(ranked.best.id, "24501011");
  assert.equal(ranked.safeCount, 1);
  assert.equal(ranked.evaluated[0].candidate.id, "24501011");
  assert.equal(ranked.evaluated[0].rejectedDescriptor, false);
  assert.ok(!ranked.selectionReasons.includes("unsafe-remix-or-edit-descriptor"));
});

test("Beatport and TIDAL artist keys ignore harmless legacy diacritics", () => {
  const result = matchBeatportVersionToTidal({
    artist: "Trentemoller", title: "Moan", isrc: "DK-MOAN-001"
  }, {
    artist: "Trentemøller", title: "Moan", isrc: "DK MOAN 001"
  });
  assert.equal(result.matched, true);
  assert.equal(result.relation, "exact");
  assert.equal(result.diagnostics.legacyIdentityDiagnostics.normalizedArtistKey.tidal, "trentemoller");
  assert.equal(result.diagnostics.legacyIdentityDiagnostics.normalizedArtistKey.beatport, "trentemoller");
});

test("mix/version descriptors can move between provider title and mixVersion fields", () => {
  const result = matchBeatportVersionToTidal({
    artist: "James Holden",
    title: "A Break In The Clouds (Main Mix)",
    label: "Border Community",
    releaseDate: "2004-01-01",
    durationMs: 420000
  }, {
    artist: "James Holden",
    title: "A Break In The Clouds",
    mixName: "Main Mix",
    label: "Border Community",
    releaseDate: "2004-01-01",
    durationMs: 420010
  });
  assert.equal(result.matched, true);
  assert.equal(result.relation, "exact");
  assert.equal(result.diagnostics.legacyIdentityDiagnostics.canonicalVersionRelation, "same-version");
  assert.equal(result.diagnostics.legacyIdentityDiagnostics.normalizedBaseTitle.tidal, "a break in the clouds");
  assert.equal(result.diagnostics.legacyIdentityDiagnostics.normalizedBaseTitle.beatport, "a break in the clouds");
});

test("featured artist text is separated from the Beatport base-title comparison", () => {
  const result = matchBeatportVersionToTidal({
    artist: "Paul van Dyk", title: "Nothing But You", isrc: "DE-NOTHING-001", durationMs: 300000
  }, {
    artist: "Paul van Dyk", title: "Nothing But You feat. Hemstock, Jennings",
    isrc: "DE NOTHING 001", durationMs: 300016
  });
  assert.equal(result.matched, true);
  assert.equal(result.relation, "exact");
  assert.equal(result.diagnostics.titleMatch, true);
  assert.deepEqual(result.diagnostics.legacyIdentityDiagnostics.normalizedFeaturedArtists.beatport, ['hemstock', 'jennings']);
});

test("Original Mix and an unlabeled TIDAL title resolve as the same recording with strong evidence", () => {
  for (const artist of ["deadmau5", "Gabriel & Dresden"]) {
    const result = matchBeatportVersionToTidal({
      artist,
      title: artist === "deadmau5" ? "Faxing Berlin (Original Mix)" : "Arcadia (Original Mix)",
      isrc: `${artist}-ISRC`,
      durationMs: 360000,
      album: artist === "deadmau5" ? "Faxing Berlin" : "Arcadia"
    }, {
      artist,
      title: artist === "deadmau5" ? "Faxing Berlin" : "Arcadia",
      isrc: `${artist}-ISRC`,
      durationMs: 360004,
      album: artist === "deadmau5" ? "Faxing Berlin" : "Arcadia"
    });
    assert.equal(result.matched, true, artist);
    assert.equal(result.relation, "equivalent-recording", artist);
    assert.equal(result.diagnostics.legacyIdentityDiagnostics.canonicalVersionRelation, "ORIGINAL_EQUIVALENT_TO_UNLABELED", artist);
  }
});

test("a catalog-supported Beatport Original Mix is canonical for an unversioned TIDAL track", () => {
  const result = matchBeatportVersionToTidal({
    artist: "Minilogue",
    title: "The Leopard",
    album: "Leopard EP",
    year: 2006
  }, {
    id: "145728",
    artist: "Minilogue",
    title: "The Leopard",
    mixName: "Original Mix",
    album: "Leopard EP",
    releaseDate: "2006-06-06"
  });

  assert.equal(result.matched, true);
  assert.equal(result.relation, "equivalent-recording");
  assert.equal(result.diagnostics.originalMixNormalizationApplied, true);
  assert.equal(result.diagnostics.legacyIdentityDiagnostics.canonicalVersionRelation, "ORIGINAL_MIX_CATALOG_EQUIVALENT_TO_UNLABELED");

  const remix = matchBeatportVersionToTidal({
    artist: "Minilogue", title: "The Leopard", album: "Leopard EP", year: 2006
  }, {
    id: "145729", artist: "Minilogue", title: "The Leopard", mixName: "Extrawelt Remix",
    album: "Leopard EP", releaseDate: "2006-06-06"
  });
  assert.equal(remix.matched, false);
  assert.equal(remix.diagnostics.originalMixNormalizationApplied, false);
});

test("an exact ISRC can override harmless provider artist-credit layout differences", () => {
  for (const [tidalArtist, beatportArtist, title] of [
    ["Bedrock", "Nick Muir, Bedrock, John Digweed", "Heaven Scent"],
    ["BT, Kirsty Hawkshaw", "BT", "Dreaming"]
  ]) {
    const result = matchBeatportVersionToTidal({ artist: tidalArtist, title, isrc: "GB-STRONG-1", durationMs: 500000 }, {
      artist: beatportArtist, title, isrc: "GB STRONG 1", durationMs: 500354
    });
    assert.equal(result.matched, true, title);
    assert.equal(result.diagnostics.strongIdentityOverrideApplied, true, title);
    assert.match(result.diagnostics.strongIdentityOverrideReason, /isrc/i);
    assert.equal(result.diagnostics.legacyIdentityDiagnostics.strongIdentityOverrideApplied, true, title);
  }
});

test("an exact ISRC does not override a genuinely conflicting artist identity", () => {
  const result = matchBeatportVersionToTidal({
    artist: "Bedrock", title: "Heaven Scent", isrc: "GB-STRONG-2", durationMs: 500000
  }, {
    artist: "A Different Artist", title: "Heaven Scent", isrc: "GB-STRONG-2", durationMs: 500002
  });
  assert.equal(result.matched, false);
  assert.equal(result.diagnostics.strongIdentityOverrideApplied, false);
  assert.match(result.reasons.join("; "), /artist credits do not match exactly/);
});

test("one canonical Beatport version wins over a modern collaboration without leaking mix metadata into the base title", () => {
  const result = matchBeatportVersionToTidal({
    artist: "Above & Beyond", title: "Alone Tonight", isrc: "ALONE-1", durationMs: 400000
  }, {
    artist: "Above & Beyond", title: "Alone Tonight", mixName: "Above & Beyond Extended Club Mix",
    isrc: "ALONE-1", durationMs: 400004
  });
  assert.equal(result.matched, true);
  assert.equal(result.diagnostics.normalizedBaseTitle.beatport, "alone tonight");
  assert.match(result.diagnostics.beatportDescriptor, /extended club mix/);
});

test("provider mix-name artist text never leaks into the Satellite base title", () => {
  const result = matchBeatportVersionToTidal({
    artist: "OceanLab, Above & Beyond", title: "Satellite", isrc: "SATELLITE-1", durationMs: 420000
  }, {
    artist: "OceanLab, Above & Beyond", title: "Satellite",
    mixName: "Above & Beyond Extended Club Mix", isrc: "SATELLITE-1", durationMs: 420003
  });
  assert.equal(result.matched, true);
  assert.equal(result.diagnostics.normalizedBaseTitle.beatport, "satellite");
  assert.equal(result.diagnostics.legacyIdentityDiagnostics.normalizedBaseTitle.beatport, "satellite");
});
