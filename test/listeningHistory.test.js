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

  const added = history.recordState({
    zones: [{
      state: "playing",
      zone_id: "zone-1",
      display_name: "HQPlayer",
      now_playing: {
        length: 540,
        image_key: "stale-moneybagg-cover",
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
  assert.equal(history.data.plays[0].imageKey, "");
  assert.equal(isNonContributoryPlay(history.data.plays[0]), false);
  assert.equal(added.length, 1);
  assert.equal(added[0].title, "Medicine Drum");
  assert.equal(history.recordState({
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
  }).length, 0);
});

test("history report exposes deeper taste DNA from feedback and track memory", () => {
  const file = tempHistoryFile();
  fs.writeFileSync(file, JSON.stringify({
    plays: [{
      title: "Orbital Drift",
      artist: "Signal Pilot",
      album: "Deep Space",
      lengthSeconds: 540,
      zoneName: "HQPlayer",
      state: "playing",
      playedAt: Date.now()
    }]
  }, null, 2));

  const history = new ListeningHistory({ file });
  const tasteProfile = {
    read() {
      return {
        feedback: {
          loved: {
            rating: "love",
            artist: "Signal Pilot",
            title: "Orbital Drift",
            label: "Mango Alley",
            discoverySource: "Similar artist",
            discoveryLane: "branch"
          },
          skipped: {
            rating: "skip",
            artist: "Flat Result",
            title: "Short Edit",
            label: "Generic Uploads",
            discoverySource: "TIDAL search",
            discoveryLane: "core"
          }
        },
        artists: {
          "signal pilot": { name: "Signal Pilot", score: 3, up: 1, down: 0 },
          "flat result": { name: "Flat Result", score: -1, up: 0, down: 1 }
        },
        labels: {
          "mango alley": { name: "Mango Alley", score: 3, up: 1, down: 0 },
          "generic uploads": { name: "Generic Uploads", score: -1, up: 0, down: 1 }
        },
        calibration: {
          likedLongShots: 1,
          sources: [{ source: "Similar artist", total: 1, likedLongShots: 1, modelMisses: 0 }],
          labels: [{ label: "Mango Alley", total: 1, likedLongShots: 1, modelMisses: 0 }]
        }
      };
    }
  };
  const trackMemory = {
    entries: new Map([[
      "signal pilot|orbital drift",
      {
        artist: "Signal Pilot",
        title: "Orbital Drift",
        album: "Deep Space",
        label: "Mango Alley",
        durationMs: 540000,
        score: 52,
        scoreBreakdown: {
          vibeInference: {
            matchedTerms: ["hypnotic", "cosmic"]
          },
          genreInference: {
            inferredGenres: ["progressive house"]
          }
        },
        why: ["7+ minute track length preference"]
      }
    ], [
      "flat result|short edit",
      {
        artist: "Flat Result",
        title: "Short Edit",
        album: "Short Edit",
        label: "Generic Uploads",
        durationMs: 180000,
        scoreBreakdown: {
          vibeInference: {
            matchedTerms: ["vocal-driven"]
          },
          genreInference: {
            inferredGenres: ["house"]
          }
        }
      }
    ]])
  };

  const report = history.report({ tasteProfile, trackMemory });

  assert.equal(report.tasteDna.confidence.feedbackCount, 2);
  assert.equal(report.tasteDna.confidence.detailedMemoryCount, 2);
  assert.ok(report.tasteDna.traits.some((entry) => entry.name === "Hypnotic"));
  assert.ok(report.tasteDna.genres.some((entry) => entry.name === "Progressive House"));
  assert.ok(report.tasteDna.formats.some((entry) => /long-form/i.test(entry.name)));
  assert.ok(report.tasteDna.sources.some((entry) => /Similar Artist/i.test(entry.name)));
  assert.ok(report.tasteDna.avoid.some((entry) => /Generic Uploads/i.test(entry.name)));
  assert.match(report.tasteNarrative, /2 ratings/);
  assert.match(report.tasteNarrative, /hypnotic|cosmic/i);
});
