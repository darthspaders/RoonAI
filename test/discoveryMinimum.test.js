"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { belowMinimumSoftRejectReason, discoverTracks, rejectReason, scoreBreakdownFor } = require("../src/discoveryEngine");

test("extended mix preference boosts extended versions over short base cuts", () => {
  const options = {
    request: "Find deep progressive house, prefer extended mixes when available",
    genres: "progressive house",
    years: "2025",
    mood: "hypnotic long tracks"
  };
  const base = scoreBreakdownFor({
    artist: "D-Nox, Elan Myles",
    title: "Peace",
    album: "Peace",
    label: "Mango Alley",
    year: 2025,
    releaseDate: "2025-04-18",
    durationMs: 212000,
    query: "D-Nox progressive house 2025"
  }, options);
  const extended = scoreBreakdownFor({
    artist: "D-Nox, Elan Myles",
    title: "Peace (Extended Mix)",
    album: "Peace",
    label: "Mango Alley",
    year: 2025,
    releaseDate: "2025-04-18",
    durationMs: 430000,
    query: "D-Nox extended mix 2025"
  }, options);

  assert.ok(base.versionPreferenceAdjustment < 0);
  assert.ok(extended.versionPreferenceAdjustment > 0);
  assert.ok(extended.total > base.total);
});

test("minimum match is a soft floor when candidates are otherwise valid", async () => {
  const returned = new Set();
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async searchTracks(query) {
      if (returned.has("quiet-signal")) return [];
      returned.add("quiet-signal");
      return [{
        artist: "Leftfield Test",
        title: "Quiet Signal",
        album: "Signals",
        label: "",
        year: null,
        durationMs: 180000,
        tidalUrl: "https://tidal.com/browse/track/1001",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 2 music discoveries",
      count: "2",
      minScore: "experimental"
    },
    history: null,
    tasteProfile: null
  });

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].belowMinimum, true);
  assert.equal(result.verification.belowMinimumKept, 1);
  assert.equal(result.verification.aboveMinimumKept, 0);
  assert.equal(result.verification.minScoreSoftFallback, true);
  assert.equal(result.discarded.some((track) => /below minimum/i.test(track.reason || "")), false);
});

test("minimum match does not keep explicit-genre wrong results", async () => {
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async searchTracks(query) {
      if (!/bedrock/i.test(query)) return [];
      return [{
        artist: "Wild Rivers",
        title: "Bedrock",
        album: "Sidelines",
        label: "Wild Rivers Ltd. Nettwerk Music Group Inc",
        year: 2022,
        releaseDate: "2022-02-04",
        releaseEvidence: { albumYear: 2022, isrcYear: 2021 },
        durationMs: 212000,
        tidalUrl: "https://tidal.com/browse/track/wild-rivers-bedrock",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find progressive house tracks with great synths and basslines",
      genres: "progressive house",
      years: "2020-2026",
      count: "1",
      minScore: "experimental",
      llmSearchPlan: {
        searchQueries: ["Bedrock 2024"]
      }
    },
    history: null,
    tasteProfile: null
  });

  assert.equal(result.tracks.length, 0);
  assert.equal(result.verification.belowMinimumKept, 0);
  assert.ok(result.discarded.some((track) => /not close enough|weak prompt|weak requested-genre/i.test(track.reason || "")));
  assert.ok(result.verification.poolDiagnostics);
  assert.ok(result.verification.poolDiagnostics.buckets.some((bucket) => /below minimum|weak match/i.test(bucket.label)));
  assert.ok(result.verification.poolDiagnostics.buckets.some((bucket) => bucket.examples.length));
});

test("minimum soft floor keeps trusted Roon scene anchors", () => {
  const reason = belowMinimumSoftRejectReason({
    belowMinimum: true,
    score: 70,
    roonRescueSceneAnchor: "Khen",
    scoreBreakdown: {
      total: 70,
      promptMatch: { percent: 25 },
      genreMatch: 4
    }
  }, {
    targetGenres: ["progressive house", "progressive trance"]
  });

  assert.equal(reason, "");
});

test("release-date year match can override older ISRC year", () => {
  const reason = rejectReason({
    artist: "Signal Test",
    title: "New Season",
    album: "New Season",
    label: "Anjunadeep",
    year: 2025,
    releaseDate: "2026-05-29",
    releaseEvidence: {
      albumDate: "2026-05-29",
      albumYear: 2026,
      isrcYear: 2025
    },
    durationMs: 420000,
    query: "progressive house 2026"
  }, {
    request: "Find fresh underground progressive house tracks released this year",
    genres: "progressive house",
    years: "2026",
    mood: "underground"
  });

  assert.equal(reason, "");
});

test("progressive year search crawls past shallow artist album windows", async () => {
  const albumCalls = [];
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums(artist, options = {}) {
      albumCalls.push({ artist, limit: options.limit });
      if (!/^andre moret$/i.test(artist)) return [];
      return [
        { id: "old-1", title: "Older One", artist, year: 2022, releaseDate: "2022-01-01" },
        { id: "old-2", title: "Older Two", artist, year: 2023, releaseDate: "2023-01-01" },
        { id: "old-3", title: "Older Three", artist, year: 2024, releaseDate: "2024-01-01" },
        { id: "old-4", title: "Older Four", artist, year: 2025, releaseDate: "2025-01-01" },
        { id: "old-5", title: "Older Five", artist, year: 2025, releaseDate: "2025-06-01" },
        { id: "new-6", title: "Crossroads EP", artist, label: "Mango Alley", year: 2026, releaseDate: "2026-06-19" }
      ];
    },
    async getAlbumTracks(album) {
      if (album.id !== "new-6") return [];
      return [{
        artist: "Andre Moret",
        title: "Crossroads",
        album: "Crossroads EP",
        label: "Mango Alley",
        year: 2026,
        releaseDate: "2026-06-19",
        releaseEvidence: { albumYear: 2026, albumDate: "2026-06-19" },
        durationMs: 480000,
        tidalUrl: "https://tidal.com/browse/track/andre-moret-crossroads"
      }];
    },
    async searchTracks() {
      return [];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find fresh underground progressive house tracks released this year",
      genres: "progressive house",
      years: "2026",
      mood: "underground",
      count: "1",
      minScore: "60",
      scoringMode: "taste-guided"
    },
    history: null,
    tasteProfile: null
  });

  assert.ok(albumCalls.some((call) => call.artist === "Andre Moret" && call.limit >= 12));
  assert.ok(albumCalls.findIndex((call) => call.artist === "Andre Moret") >= 0);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].title, "Crossroads");
});

test("undershot minimum-match runs can keep valid branch-out candidates below the floor", async () => {
  let servedSearch = false;
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      if (servedSearch) return [];
      servedSearch = true;
      return [
        {
          artist: "Hobin Rude",
          title: "Strong Scene Anchor",
          album: "Strong Scene Anchor",
          label: "Sudbeat Music",
          year: 2026,
          releaseDate: "2026-02-13",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-02-13" },
          durationMs: 424000,
          tidalUrl: "https://tidal.com/browse/track/strong-anchor",
          query
        },
        {
          artist: "Branch One",
          title: "Low Light Signal",
          album: "Low Light Signal",
          label: "",
          year: 2026,
          releaseDate: "2026-03-01",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-03-01" },
          durationMs: 421000,
          tidalUrl: "https://tidal.com/browse/track/branch-one",
          query
        },
        {
          artist: "Branch Two",
          title: "Basement Orbit",
          album: "Basement Orbit",
          label: "",
          year: 2026,
          releaseDate: "2026-04-01",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-04-01" },
          durationMs: 418000,
          tidalUrl: "https://tidal.com/browse/track/branch-two",
          query
        }
      ];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 3 underground progressive house tracks this year",
      genres: "progressive house",
      years: "2026",
      mood: "underground",
      count: "3",
      minScore: "worth",
      scoringMode: "taste-guided",
      llmSearchPlan: {
        candidateArtists: ["Branch One", "Branch Two"],
        searchQueries: ["underground progressive house 2026"]
      }
    },
    history: null,
    tasteProfile: null
  });

  assert.equal(result.tracks.length, 3);
  assert.equal(result.verification.belowMinimumRescueKept, 2);
  assert.equal(result.verification.belowMinimumKept, 2);
  assert.deepEqual(new Set(result.tracks.map((track) => track.artist)), new Set(["Hobin Rude", "Branch One", "Branch Two"]));
  assert.equal(result.discarded.some((track) => /Branch One|Branch Two/.test(`${track.artist} ${track.title}`)), false);
});

test("explicit fresh-artist requests reject artists already surfaced in discovery history", async () => {
  let servedSearch = false;
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      if (servedSearch) return [];
      servedSearch = true;
      return [
        {
          artist: "Familiar Producer",
          title: "Known Orbit",
          album: "Known Orbit",
          label: "Mango Alley",
          year: 2026,
          releaseDate: "2026-02-01",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-02-01" },
          durationMs: 430000,
          tidalUrl: "https://tidal.com/browse/track/familiar-known",
          query
        },
        {
          artist: "Fresh Signal",
          title: "New Orbit",
          album: "New Orbit",
          label: "Mango Alley",
          year: 2026,
          releaseDate: "2026-03-01",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-03-01" },
          durationMs: 431000,
          tidalUrl: "https://tidal.com/browse/track/fresh-new",
          query
        },
        {
          artist: "New Current",
          title: "First Light",
          album: "First Light",
          label: "Sudbeat Music",
          year: 2026,
          releaseDate: "2026-04-01",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-04-01" },
          durationMs: 432000,
          tidalUrl: "https://tidal.com/browse/track/new-current",
          query
        }
      ];
    }
  };
  const history = {
    entryFor() {
      return null;
    },
    isRecent() {
      return false;
    },
    artistExposureFor(track) {
      if (track.artist === "Familiar Producer") {
        return {
          artist: "Familiar Producer",
          trackCount: 3,
          shownCount: 4,
          recent: true
        };
      }
      return null;
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 2 progressive house tracks this year from artists you have not recommended before",
      genres: "progressive house",
      years: "2026",
      count: "2",
      scoringMode: "taste-guided",
      llmSearchPlan: {
        searchQueries: ["progressive house 2026"]
      }
    },
    history,
    tasteProfile: null
  });

  assert.deepEqual(result.tracks.map((track) => track.artist).sort(), ["Fresh Signal", "New Current"]);
  assert.ok(result.discarded.some((track) => (
    track.artist === "Familiar Producer" &&
    /already recommended|not recommended before/i.test(track.reason || "")
  )));
});

test("fresh-artist requests still allow low-exposure artists unless strict novelty is requested", async () => {
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks() {
      return [{
        artist: "Lightly Surfaced",
        title: "Open Signal",
        album: "Open Signal",
        label: "Mango Alley",
        year: 2026,
        releaseDate: "2026-03-01",
        releaseEvidence: { albumYear: 2026, albumDate: "2026-03-01" },
        durationMs: 431000,
        tidalUrl: "https://tidal.com/browse/track/lightly-open"
      }];
    }
  };
  const history = {
    entryFor() {
      return null;
    },
    isRecent() {
      return false;
    },
    artistExposureFor() {
      return {
        artist: "Lightly Surfaced",
        trackCount: 1,
        shownCount: 1,
        recent: true
      };
    }
  };
  const baseOptions = {
    request: "Find 1 progressive house track this year from artists you have not recommended before",
    genres: "progressive house",
    years: "2026",
    count: "1",
    scoringMode: "taste-guided",
    llmSearchPlan: {
      searchQueries: ["progressive house 2026"]
    }
  };

  const relaxed = await discoverTracks({
    tidal: fakeTidal,
    options: baseOptions,
    history,
    tasteProfile: null
  });
  assert.equal(relaxed.tracks.length, 1);
  assert.equal(relaxed.tracks[0].artist, "Lightly Surfaced");

  const strict = await discoverTracks({
    tidal: fakeTidal,
    options: {
      ...baseOptions,
      request: "Find 1 progressive house track this year from strictly only artists you have not recommended before"
    },
    history,
    tasteProfile: null
  });
  assert.equal(strict.tracks.length, 0);
  assert.ok(strict.discarded.some((track) => /already recommended|not recommended before/i.test(track.reason || "")));
});

test("fresh-artist fallback spreads across repeated artists before taking duplicates", async () => {
  let servedSearch = false;
  const returnedTracks = [
    ["Repeated Anchor", "High Score One", "First Window", 450000],
    ["Repeated Anchor", "High Score Two", "Second Window", 449000],
    ["Repeated Anchor", "High Score Three", "Third Window", 448000],
    ["Branch Signal", "Side Path", "Branch Signal", 431000],
    ["Label Signal", "Open Circuit", "Label Signal", 430000],
    ["Radio Signal", "Outer Current", "Radio Signal", 429000]
  ].map(([artist, title, album, durationMs], index) => ({
    artist,
    title,
    album,
    label: "Mango Alley",
    year: 2026,
    releaseDate: "2026-04-01",
    releaseEvidence: { albumYear: 2026, albumDate: "2026-04-01" },
    durationMs,
    tidalUrl: `https://tidal.com/browse/track/fresh-fallback-${index}`
  }));
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      if (servedSearch) return [];
      servedSearch = true;
      return returnedTracks.map((track) => ({ ...track, query }));
    }
  };
  const history = {
    entryFor() {
      return null;
    },
    isRecent() {
      return false;
    },
    artistExposureFor(track) {
      return {
        artist: track.artist,
        trackCount: 3,
        shownCount: 3,
        recent: false
      };
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 4 progressive house tracks this year from artists you have not recommended before",
      genres: "progressive house",
      years: "2026",
      count: "4",
      scoringMode: "taste-guided",
      llmSearchPlan: {
        searchQueries: ["progressive house 2026"]
      }
    },
    history,
    tasteProfile: null
  });

  assert.equal(result.tracks.length, 4);
  assert.equal(result.verification.artistNoveltyFallbackKept, 4);
  assert.equal(result.tracks.filter((track) => track.artist === "Repeated Anchor").length, 1);
  assert.deepEqual(
    new Set(result.tracks.map((track) => track.artist)),
    new Set(["Repeated Anchor", "Branch Signal", "Label Signal", "Radio Signal"])
  );
});

test("fresh-artist requests do not seed liked artists or explicit liked-artist queries", async () => {
  const albumCalls = [];
  const searchQueries = [];
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums(artist) {
      albumCalls.push(artist);
      return [];
    },
    async searchTracks(query) {
      searchQueries.push(query);
      return [];
    }
  };
  const tasteProfile = {
    read() {
      return {
        artists: {
          "d nox": { name: "D-Nox", score: 5, up: 3 },
          "andre moret": { name: "Andre Moret", score: 4, up: 2 }
        }
      };
    },
    getTopArtists() {
      return ["D-Nox", "Andre Moret"];
    },
    adjustmentFor() {
      return { value: 0, reasons: [] };
    },
    getFeedbackFor() {
      return "";
    },
    summary() {
      return {};
    }
  };

  await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 5 fresh underground progressive house tracks released this year from artists you have not recommended before",
      genres: "progressive house",
      years: "2026",
      mood: "underground",
      count: "5",
      minScore: "60",
      scoringMode: "taste-guided",
      llmSearchPlan: {
        candidateArtists: ["D-Nox", "Andre Moret", "Fresh Branch"],
        searchQueries: ["D-Nox 2026", "Andre Moret progressive house 2026", "progressive house 2026"]
      }
    },
    history: null,
    tasteProfile
  });

  assert.equal(albumCalls.some((artist) => /d-nox|andre moret/i.test(artist)), false);
  assert.equal(searchQueries.some((query) => /d-nox|andre moret/i.test(query)), false);
  assert.ok(searchQueries.some((query) => /progressive house 2026/i.test(query)));
});

test("fresh-artist requests reject liked artists as already known", async () => {
  let servedSearch = false;
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      if (servedSearch) return [];
      servedSearch = true;
      return [
        {
          artist: "D-Nox",
          title: "Known Signal",
          album: "Known Signal",
          label: "Mango Alley",
          year: 2026,
          releaseDate: "2026-05-01",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-05-01" },
          durationMs: 431000,
          tidalUrl: "https://tidal.com/browse/track/known-liked",
          query
        },
        {
          artist: "Fresh Signal",
          title: "Open Field",
          album: "Open Field",
          label: "Mango Alley",
          year: 2026,
          releaseDate: "2026-05-02",
          releaseEvidence: { albumYear: 2026, albumDate: "2026-05-02" },
          durationMs: 432000,
          tidalUrl: "https://tidal.com/browse/track/fresh-open",
          query
        }
      ];
    }
  };
  const tasteProfile = {
    read() {
      return {
        artists: {
          "d nox": { name: "D-Nox", score: 5, up: 3 }
        }
      };
    },
    getTopArtists() {
      return ["D-Nox"];
    },
    adjustmentFor() {
      return { value: 0, reasons: [] };
    },
    getFeedbackFor() {
      return "";
    },
    summary() {
      return {};
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 1 progressive house track this year from artists you have not recommended before",
      genres: "progressive house",
      years: "2026",
      count: "1",
      scoringMode: "taste-guided",
      llmSearchPlan: {
        searchQueries: ["progressive house 2026"]
      }
    },
    history: null,
    tasteProfile
  });

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].artist, "Fresh Signal");
  assert.ok(result.discarded.some((track) => (
    track.artist === "D-Nox" &&
    /liked artist profile|not recommended before/i.test(track.reason || "")
  )));
});

test("small fresh progressive searches branch beyond fixed familiar anchors", async () => {
  const albumCalls = [];
  const familiarFreshAnchors = new Set([
    "D-Nox Andre Moret",
    "D-Nox",
    "Andre Moret",
    "Ruben Karapetyan",
    "Hobin Rude",
    "Cid Inc.",
    "Guy J",
    "Khen",
    "GMJ Matter",
    "Kamilo Sanclemente",
    "Paul Thomas",
    "Ezequiel Arias",
    "Sebastian Sellares",
    "Nicolas Rada",
    "Forty Cats",
    "Dmitry Molosh"
  ]);
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums(artist) {
      albumCalls.push(artist);
      return [];
    },
    async searchTracks() {
      return [];
    }
  };

  await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 5 fresh underground progressive house tracks released this year",
      genres: "progressive house",
      years: "2026",
      mood: "underground",
      count: "5",
      minScore: "60",
      scoringMode: "taste-guided"
    },
    history: null,
    tasteProfile: null
  });

  assert.ok(albumCalls.length >= 8);
  assert.ok(albumCalls.some((artist) => !familiarFreshAnchors.has(artist)));
  assert.ok(albumCalls.filter((artist) => familiarFreshAnchors.has(artist)).length < albumCalls.length);
});

test("explicit Taste Guided searches expand similar branch seeds before liked artists", async () => {
  const albumCalls = [];
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums(artist) {
      albumCalls.push(artist);
      return [];
    },
    async searchTracks() {
      return [];
    }
  };
  const tasteProfile = {
    getTopArtists() {
      return ["Liked Anchor One", "Liked Anchor Two", "Liked Anchor Three"];
    },
    adjustmentFor() {
      return { value: 0, reasons: [] };
    },
    getFeedbackFor() {
      return "";
    },
    summary() {
      return {};
    },
    read() {
      return {};
    }
  };

  await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 8 melodic techno discoveries",
      genres: "melodic techno",
      count: "8",
      scoringMode: "taste-guided",
      similarArtistSeeds: ["Adjacent Branch One", "Adjacent Branch Two"],
      llmSearchPlan: {
        candidateArtists: []
      }
    },
    history: null,
    tasteProfile
  });

  assert.ok(albumCalls.includes("Adjacent Branch One"));
  assert.ok(albumCalls.includes("Adjacent Branch Two"));
  assert.equal(albumCalls.some((artist) => /^Liked Anchor/.test(artist)), false);
});
