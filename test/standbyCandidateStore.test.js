"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  StandbyCandidateStore,
  isStandbySeoSludge,
  standbyTrackKey
} = require("../src/standbyCandidateStore");

function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standby-candidates-"));
  return new StandbyCandidateStore({
    file: path.join(dir, "standby.json"),
    targetCount: 3,
    ttlMs: 60_000,
    ...options
  });
}

test("standby pool dedupes tracks and keeps the highest scoring target set", () => {
  const store = tempStore();
  store.add([
    { artist: "Artist A", title: "One", score: 61 },
    { artist: "Artist B", title: "Two", score: 89 },
    { artist: "Artist C", title: "Three", score: 70 }
  ], { reason: "test" });

  store.add([
    { artist: "Artist A", title: "One", score: 92 },
    { artist: "Artist D", title: "Four", score: 72 }
  ], { reason: "refresh" });

  const summary = store.summary();
  assert.equal(summary.count, 3);
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.tracks.map((track) => track.title), ["One", "Two", "Four"]);
  assert.equal(summary.tracks[0].score, 92);
});

test("standby replace drops old candidates instead of merging them back in", () => {
  const store = tempStore();
  store.add([
    { artist: "Old Artist A", title: "Old One", score: 95 },
    { artist: "Old Artist B", title: "Old Two", score: 94 },
    { artist: "Old Artist C", title: "Old Three", score: 93 }
  ], { reason: "old" });

  const result = store.replace([
    { artist: "New Artist A", title: "New One", score: 61 },
    { artist: "New Artist B", title: "New Two", score: 62 }
  ], { reason: "refresh" });

  assert.equal(result.summary.count, 2);
  assert.deepEqual(result.summary.tracks.map((track) => track.title), ["New Two", "New One"]);
  assert.equal(result.summary.tracks.some((track) => /^Old /.test(track.title)), false);
});

test("standby pool drops expired candidates from summaries", () => {
  const store = tempStore({ ttlMs: 1 });
  store.add([{ artist: "Old Artist", title: "Old Track", score: 90 }]);
  const snapshot = store.read();
  snapshot.candidates[0].standbyExpiresAt = Date.now() - 1;
  store.write(snapshot);

  assert.equal(store.summary().count, 0);
  assert.equal(store.readyCount(), 0);
});

test("standby pool filters slash-separated genre SEO sludge", () => {
  const store = tempStore();
  const sludge = {
    artist: "Noctiv",
    title: "Hypnotic Deep House / Melodic Techno Journal",
    album: "Hypnotic Deep House / Melodic Techno Journal",
    score: 99
  };

  assert.equal(isStandbySeoSludge(sludge), true);

  store.add([
    sludge,
    { artist: "Real Artist", title: "Actual Track", album: "Actual EP", score: 70 }
  ]);

  assert.deepEqual(store.summary().tracks.map((track) => track.title), ["Actual Track"]);

  const snapshot = store.read();
  snapshot.candidates.push({
    artist: "Noctiv",
    title: "Stay //Hypnotic Deep House / Melodic Techno Journal",
    album: "Stay //Hypnotic Deep House / Melodic Techno Journal",
    key: "noctiv|stay hypnotic deep house melodic techno journal",
    standbyExpiresAt: Date.now() + 60_000,
    score: 100
  }, {
    artist: "Tobu",
    title: "Deep Progressive House Journey - Candyland",
    album: "Deep Progressive House Journey",
    key: "tobu|deep progressive house journey candyland",
    standbyExpiresAt: Date.now() + 60_000,
    score: 98
  }, {
    artist: "Japanese Nursery Remixes",
    title: "Akatonbo - Melodic Techno Progressive House Remix",
    album: "Akatonbo - Melodic Techno Progressive House Remix",
    key: "japanese nursery remixes|akatonbo melodic techno progressive house remix",
    standbyExpiresAt: Date.now() + 60_000,
    score: 97
  }, {
    artist: "Brother Ali, Ant",
    title: "Deep Cuts",
    album: "Satisfied Soul",
    label: "Mello Music Group",
    key: "brother ali ant|deep cuts",
    standbyFreshPass: "clean-refill-wide-sources",
    tidal: { query: "Anjunadeep melodic house", label: "Mello Music Group" },
    standbyExpiresAt: Date.now() + 60_000,
    score: 96
  }, {
    artist: "Alfred Heinrichs",
    title: "IAM Melodic Techno",
    album: "IAM Melodic Techno",
    key: "alfred heinrichs|iam melodic techno",
    standbyExpiresAt: Date.now() + 60_000,
    score: 95
  }, {
    artist: "Berlin Nox",
    title: "Deep Melodic Techno (Hypnotic Loop Mix)",
    album: "DARK BERLIN TECHNO",
    key: "berlin nox|deep melodic techno hypnotic loop mix",
    standbyExpiresAt: Date.now() + 60_000,
    score: 94
  }, {
    artist: "Berlin Nox",
    title: "Melodic Techno Buildup (Hypnotic Loop Mix)",
    album: "DARK BERLIN TECHNO",
    key: "berlin nox|melodic techno buildup hypnotic loop mix",
    standbyExpiresAt: Date.now() + 60_000,
    score: 93
  }, {
    artist: "Skywave",
    title: "lost woods (zelda melodic techno)",
    album: "lost woods (zelda melodic techno)",
    key: "skywave|lost woods zelda melodic techno",
    standbyExpiresAt: Date.now() + 60_000,
    score: 92
  }, {
    artist: "Progressive House, Deep Progressive House, Melodic Techno",
    title: "Resonance",
    album: "Resonance",
    key: "progressive house deep progressive house melodic techno|resonance",
    standbyExpiresAt: Date.now() + 60_000,
    score: 91
  }, {
    artist: "Arcturian, Cosmic Tekkno",
    title: "Crysis: Background Melodic Techno",
    album: "Channeling Techno : Contact Arcturus",
    key: "arcturian cosmic tekkno|crysis background melodic techno",
    standbyExpiresAt: Date.now() + 60_000,
    score: 90
  }, {
    artist: "Arcturian, Cosmic Tekkno",
    title: "Cyro Chamber: 1 Hour Melodic Techno",
    album: "Channeling Techno : Contact Arcturus",
    key: "arcturian cosmic tekkno|cyro chamber 1 hour melodic techno",
    standbyExpiresAt: Date.now() + 60_000,
    score: 89
  });
  store.write(snapshot);

  assert.deepEqual(store.summary().tracks.map((track) => track.title), ["Actual Track"]);
});

test("standby pool filters functional audio and low-evidence Roon fallback sludge", () => {
  const store = tempStore({ targetCount: 5 });
  const sludgeTracks = [
    {
      artist: "Namaste Healing Yoga, Marco Rinaldo",
      title: "Source of Oriental Bliss",
      score: 70,
      discoverySource: "Roon search",
      standbyFreshPass: "roon-local-library",
      query: "sources deep"
    },
    {
      artist: "Deep Sleep Hypnosis Masters, Marco Rinaldo",
      title: "Where the Spiral Slows",
      score: 70,
      discoverySource: "Roon search",
      standbyFreshPass: "roon-local-library",
      query: "sources deep"
    },
    {
      artist: "Rilvyk",
      title: "Source Control",
      score: 70,
      discoverySource: "Roon search",
      standbyFreshPass: "roon-local-library",
      query: "sources deep"
    },
    {
      artist: "Samantha Tonge",
      title: "Chapter 101 - The Time of My Life",
      album: "The Time of My Life (Unabridged)",
      label: "Boldwood Books",
      score: 47
    },
    {
      artist: "Jive Ass Sleepers",
      title: "Languid and Leftfield",
      album: "Alt Lounge, Set 7",
      label: "AudioSparx",
      score: 70
    }
  ];
  const keep = {
    artist: "Guy J",
    title: "Last Standing",
    album: "Last Standing",
    label: "Lost & Found",
    score: 70,
    discoverySource: "Roon search"
  };

  assert.equal(sludgeTracks.every(isStandbySeoSludge), true);
  assert.equal(isStandbySeoSludge(keep), false);

  store.add([...sludgeTracks, keep]);

  assert.deepEqual(store.summary().tracks.map((track) => track.title), ["Last Standing"]);
});

test("standby pool excludes weak low-score candidates", () => {
  const store = tempStore();
  store.add([
    { artist: "Low Artist", title: "Looks Real But Weak", album: "Weak EP", label: "Real Label", score: 49 },
    { artist: "Pass Artist", title: "Score Floor Pass", album: "Pass EP", label: "Real Label", score: 50 }
  ]);

  assert.deepEqual(store.summary().tracks.map((track) => track.title), ["Score Floor Pass"]);
});

test("standby summary caps repeated artist families across collaborations", () => {
  const store = tempStore({ targetCount: 5 });
  store.replace([
    {
      artist: "D-Nox, Beckers",
      title: "First D-Nox",
      album: "One",
      label: "Balance Music",
      score: 91,
      tidal: { id: "1", artists: [{ id: "dnox", name: "D-Nox" }, { id: "beckers", name: "Beckers" }] }
    },
    {
      artist: "Victor Ruiz, D-Nox",
      title: "Second D-Nox",
      album: "Two",
      label: "Sudbeat Music",
      score: 90,
      tidal: { id: "2", artists: [{ id: "victor", name: "Victor Ruiz" }, { id: "dnox", name: "D-Nox" }] }
    },
    {
      artist: "D-Nox",
      title: "Third D-Nox",
      album: "Three",
      label: "Balance Music",
      score: 89,
      tidal: { id: "3", artists: [{ id: "dnox", name: "D-Nox" }] }
    },
    { artist: "Maze 28", title: "Iguana", album: "Iguana", label: "Meanwhile", score: 70 },
    { artist: "Kamilo Sanclemente", title: "Stellar", album: "Stellar", label: "Mango Alley", score: 69 },
    { artist: "Hobin Rude", title: "Mirror", album: "Mirror", label: "Sound Avenue", score: 68 }
  ]);

  assert.deepEqual(
    store.summary().tracks.map((track) => track.title),
    ["First D-Nox", "Second D-Nox", "Iguana", "Stellar", "Mirror"]
  );
});

test("standby summary caps repeated albums and remix packs", () => {
  const store = tempStore({ targetCount: 4 });
  store.replace([
    { artist: "Artist A", title: "Original", album: "Strong EP", label: "Good Label", score: 90 },
    { artist: "Artist B", title: "Remix", album: "Strong EP", label: "Good Label", score: 89 },
    { artist: "Artist C", title: "Another Release", album: "Another Release", label: "Other Label", score: 88 },
    { artist: "Artist D", title: "Third Release", album: "Third Release", label: "Other Label", score: 87 }
  ]);

  assert.deepEqual(
    store.summary().tracks.map((track) => track.title),
    ["Original", "Another Release", "Third Release"]
  );
});

test("standby refresh status records success and errors", () => {
  const store = tempStore();
  const started = store.markRefreshStart({ reason: "manual" });
  assert.equal(started.refreshing, true);
  assert.equal(started.lastRun.reason, "manual");

  const finished = store.markRefreshEnd({
    reason: "manual",
    generated: 7,
    kept: 3,
    discarded: 4,
    runtimeMs: 1200,
    diagnostics: {
      standbyBroadening: {
        attempted: 2
      }
    }
  });
  assert.equal(finished.refreshing, false);
  assert.equal(finished.lastError, "");
  assert.equal(finished.lastRun.kept, 3);
  assert.equal(finished.lastRun.diagnostics.standbyBroadening.attempted, 2);

  const failed = store.markRefreshEnd({ reason: "background", error: "TIDAL unavailable" });
  assert.equal(failed.lastError, "TIDAL unavailable");
});

test("standby refresh is not due when the pool is full", () => {
  const store = tempStore();
  store.add([
    { artist: "Artist A", title: "One", score: 61 },
    { artist: "Artist B", title: "Two", score: 89 },
    { artist: "Artist C", title: "Three", score: 70 }
  ]);

  const snapshot = store.read();
  snapshot.lastRefreshAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  snapshot.nextRefreshAt = new Date(Date.now() + 60_000).toISOString();
  store.write(snapshot);

  const summary = store.summary();
  assert.equal(summary.ready, true);
  assert.equal(summary.nextRefreshAt, "");
  assert.equal(store.refreshDue(1), false);
});

test("standby queue failures are retained across automatic refresh replace", () => {
  const store = tempStore({ targetCount: 3 });
  store.replace([
    { artist: "Monkey Safari", title: "Gravity (with Delhia De France)", score: 88, tidal: { id: "162866784" } },
    { artist: "Fresh A", title: "One", score: 80 },
    { artist: "Fresh B", title: "Two", score: 79 }
  ]);

  store.retainQueueFailures([{
    track: { artist: "Monkey Safari", title: "Gravity (with Delhia De France)", tidalTrackId: "162866784" },
    reason: "Roon direct miss",
    failureType: "not_found",
    resolutionMethod: "roon_search"
  }], { source: "standby" });

  const refreshed = store.replace([
    { artist: "New A", title: "Three", score: 99 },
    { artist: "New B", title: "Four", score: 98 },
    { artist: "New C", title: "Five", score: 97 }
  ]);

  assert.equal(refreshed.summary.tracks[0].title, "Gravity (with Delhia De France)");
  assert.equal(refreshed.summary.tracks[0].standbyQueueFailure.failureType, "not_found");
  assert.equal(refreshed.summary.tracks[0].standbyQueueFailure.queueAttemptSource, "standby");
});

test("standby track key prefers TIDAL identity", () => {
  assert.equal(standbyTrackKey({
    artist: "Artist",
    title: "Title",
    tidal: { id: "123" }
  }), "tidal:123");
  assert.equal(standbyTrackKey({
    artist: "Artist",
    title: "Title"
  }), "artist|title");
});
