"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { feedbackIdentityMatchesLocalFile } = require("../scripts/enrich-rated-local");

test("rated enrichment rejects a generic title matched to the wrong local track", () => {
  assert.equal(feedbackIdentityMatchesLocalFile({
    artist: "Deep Progressive House, Electronic Gems, Copyright Free House Music",
    title: "Silence"
  }, {
    artist: "Astropilot, Unusual Cosmic Process",
    title: "In The Silence"
  }), false);
});

test("rated enrichment accepts reordered artist credits and credited remixers", () => {
  assert.equal(feedbackIdentityMatchesLocalFile({
    artist: "Audion / Ron Costa / Tiga / Eats Everything",
    title: "Dancing (Again!) (Radio Edit)"
  }, {
    artist: "Eats Everything, Tiga, Audion, Ron Costa",
    title: "Dancing (Again!) (Radio Edit)"
  }), true);

  assert.equal(feedbackIdentityMatchesLocalFile({
    artist: "Becky Hill / Chase & Status",
    title: "Disconnect (Tiësto Remix)"
  }, {
    artist: "Becky Hill, Chase & Status, Tiësto",
    title: "Disconnect (Tiësto Remix)"
  }), true);
});

test("rated enrichment rejects an artist/title collision even when the title overlaps", () => {
  assert.equal(feedbackIdentityMatchesLocalFile({
    artist: "Harax",
    title: "Fade"
  }, {
    artist: "Avicii",
    title: "Fade Into Darkness"
  }), false);
});
