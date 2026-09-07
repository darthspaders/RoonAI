"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  albumHintMatches,
  artistNameLooksClose,
  baseTitleForMatch,
  durationLooksClose,
  normalizeMatchText,
  playlistTitleMatches,
  splitArtistForMatch,
  tidalEnrichmentMatches,
  tidalPlaylistFallbackMatches,
  versionDescriptorTokens,
  weakTidalArtistHint
} = require("../src/tidalMatchRules");

test("match text normalization strips accents, punctuation, case, and spacing", () => {
  assert.equal(normalizeMatchText("  D-SHIFT, Café  "), "d shift cafe");
});

test("artist matching tolerates close artist spelling and collaboration splitting", () => {
  assert.equal(artistNameLooksClose("drunken kong", "drunken kong"), true);
  assert.equal(artistNameLooksClose("drunken kong", "drunken konh"), true);
  assert.deepEqual(splitArtistForMatch("D-SHIFT, Drunken Kong feat. XA"), ["d shift", "drunken kong", "xa"]);
});

test("title matching allows exact titles and descriptor-preserving base-title fallback", () => {
  assert.equal(baseTitleForMatch("City Lights (HAFT Remix)"), "city lights");
  assert.deepEqual(versionDescriptorTokens("City Lights (HAFT Remix)"), ["haft"]);
  assert.equal(playlistTitleMatches(
    { title: "City Lights (HAFT Remix)" },
    { title: "City Lights - HAFT Remix" }
  ), true);
  assert.equal(playlistTitleMatches(
    { title: "City Lights (HAFT Remix)" },
    { title: "City Lights" }
  ), false);
});

test("TIDAL enrichment requires close title and artist identity", () => {
  assert.equal(tidalEnrichmentMatches(
    { artist: "D-SHIFT, Drunken Kong", title: "City Lights (HAFT Remix)" },
    { artist: "D-SHIFT", title: "City Lights (HAFT Remix)" }
  ), true);
  assert.equal(tidalEnrichmentMatches(
    { artist: "D-SHIFT", title: "City Lights (HAFT Remix)" },
    { artist: "Wrong Artist", title: "City Lights (HAFT Remix)" }
  ), false);
});

test("playlist fallback allows weak artist, album, or close duration after title match", () => {
  assert.equal(weakTidalArtistHint("Various Artists"), true);
  assert.equal(albumHintMatches({ album: "Deep Series" }, { album: "Deep Series Vol. 1" }), true);
  assert.equal(durationLooksClose({ durationMs: 300000 }, { durationMs: 314000 }), true);
  assert.equal(tidalPlaylistFallbackMatches(
    { artist: "Unknown Artist", title: "Track", durationMs: 300000 },
    { artist: "Real Artist", title: "Track", durationMs: 360000 }
  ), true);
});
