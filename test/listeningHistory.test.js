"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ListeningHistory, isNonContributoryPlay } = require("../src/listeningHistory");

function tempHistoryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-history-"));
  return path.join(dir, "listening-history.json");
}

test("radio station placeholders are excluded from top artists and tracks", () => {
  const file = tempHistoryFile();
  fs.writeFileSync(file, JSON.stringify({
    plays: [
      {
        title: "Progressive -DI.FM",
        artist: "Unknown Artist",
        album: "",
        lengthSeconds: 0,
        zoneName: "HQPlayer",
        state: "playing",
        playedAt: Date.now()
      },
      {
        title: "State of Progression (Dilby Extended Remix)",
        artist: "Ruben Karapetyan",
        album: "State of Progression",
        lengthSeconds: 440,
        zoneName: "HQPlayer",
        state: "playing",
        playedAt: Date.now() - 1000
      }
    ]
  }, null, 2));

  const history = new ListeningHistory({ file });
  const report = history.report();

  assert.equal(report.metrics.observedPlays, 1);
  assert.equal(report.metrics.ignoredRadioPlays, 1);
  assert.deepEqual(report.topArtists.map((entry) => entry.name), ["Ruben Karapetyan"]);
  assert.deepEqual(report.topTracks.map((entry) => entry.title), ["State of Progression (Dilby Extended Remix)"]);
});

test("radio programs are not recorded as listening-history plays", () => {
  const file = tempHistoryFile();
  const history = new ListeningHistory({ file });

  history.recordState({
    zones: [{
      state: "playing",
      zone_id: "zone-1",
      display_name: "HQPlayer",
      now_playing: {
        length: 0,
        two_line: {
          line1: "Progressive -DI.FM",
          line2: "Unknown Artist"
        },
        radio_lookup: {
          title: "Progressive -DI.FM",
          artist: "Unknown Artist",
          isRadioProgram: true,
          catalogEnrichmentAllowed: false
        }
      }
    }]
  });

  assert.equal(history.data.plays.length, 0);
});

test("real radio metadata can still record a real track", () => {
  const file = tempHistoryFile();
  const history = new ListeningHistory({ file });

  history.recordState({
    zones: [{
      state: "playing",
      zone_id: "zone-1",
      display_name: "HQPlayer",
      now_playing: {
        length: 540,
        two_line: {
          line1: "Progressive -DI.FM",
          line2: "Unknown Artist"
        },
        radio_lookup: {
          title: "Medicine Drum",
          artist: "Ancient Analog",
          album: "Songs From A Vortex Named WEHO",
          isRadioProgram: false,
          catalogEnrichmentAllowed: true
        }
      }
    }]
  });

  assert.equal(history.data.plays.length, 1);
  assert.equal(history.data.plays[0].artist, "Ancient Analog");
  assert.equal(history.data.plays[0].title, "Medicine Drum");
  assert.equal(isNonContributoryPlay(history.data.plays[0]), false);
});
