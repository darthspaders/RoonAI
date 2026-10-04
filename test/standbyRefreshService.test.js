"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStandbyRefreshService } = require("../src/standbyRefreshService");

class TestFreshPool {
  constructor({ events = [], target = 25 } = {}) {
    this.events = events;
    this.target = target;
    this.rawTarget = target;
    this.diagnostics = {};
  }

  blockEvents(events = []) {
    this.events = events;
  }

  eligible(track = {}) {
    return !track.blocked;
  }
}

function createService(overrides = {}) {
  const sessionStore = overrides.sessionStore || {
    read: () => ({ options: {} })
  };
  const standbyStore = overrides.standbyStore || {
    read: () => ({ candidates: [], standbyHistory: [], lastRefreshAt: "" }),
    summary: () => ({ tracks: [], count: 0 }),
    markRefreshStart: () => {},
    markRefreshEnd: (summary) => ({ tracks: [], count: 0, ...summary }),
    replace: (tracks) => ({ tracks })
  };
  const tasteProfile = overrides.tasteProfile || {
    getTopArtists: () => [],
    read: () => ({ feedback: {} })
  };
  const discoveryHistory = overrides.discoveryHistory || {
    uniqueEntries: () => []
  };
  const listeningHistory = overrides.listeningHistory || {
    data: { plays: [] }
  };

  return createStandbyRefreshService({
    booleanFlag: overrides.booleanFlag || ((value) => /^(1|true|yes)$/i.test(String(value || ""))),
    candidateIdentityKeys: overrides.candidateIdentityKeys || ((track = {}) => [track.key || `${track.artist || ""}|${track.title || ""}`]),
    config: overrides.config || {},
    discoverTracks: overrides.discoverTracks || (async () => ({ tracks: [], alternates: [], verification: {} })),
    discoveryHistory,
    FreshPool: overrides.FreshPool || TestFreshPool,
    generateSearchPlan: overrides.generateSearchPlan || (async () => ({ plan: null })),
    generateStandbySearchPlan: overrides.generateStandbySearchPlan || (async () => ({ plan: null, routing: {} })),
    genreProfileStore: overrides.genreProfileStore || {
      augmentOptions: (options) => options
    },
    getModelRouter: overrides.getModelRouter || (() => null),
    lastFmHistoryForDiscovery: overrides.lastFmHistoryForDiscovery || (async () => ({ tracksByKey: {} })),
    listeningHistory,
    normalizeMatchText: overrides.normalizeMatchText || ((value = "") => String(value || "").toLowerCase()),
    queryYieldTracker: overrides.queryYieldTracker || {},
    recordRefresh: overrides.recordRefresh || (() => []),
    reviewStandbyPool: overrides.reviewStandbyPool || (async (tracks) => ({ tracks, review: {} })),
    scheduleBroadcast: overrides.scheduleBroadcast || (() => {}),
    searchFreshPool: overrides.searchFreshPool || (async () => ({ tracks: [], novelty: { rawCandidatesGenerated: 0 }, review: {}, searches: [] })),
    sessionStore,
    STANDBY_ERROR_REFRESH_INTERVAL_MS: 10_000,
    STANDBY_MODEL_TIMEOUT_MS: 1000,
    STANDBY_PARTIAL_REFRESH_INTERVAL_MS: 5000,
    STANDBY_REFRESH_INTERVAL_MS: 20_000,
    STANDBY_REFRESH_TIMEOUT_MS: 1000,
    STANDBY_TARGET_COUNT: overrides.targetCount || 3,
    standbyEvents: overrides.standbyEvents || { entries: [] },
    standbyFreshSourcePasses: overrides.standbyFreshSourcePasses || (() => []),
    standbyIdentityKeys: overrides.standbyIdentityKeys || ((track) => [track.key || track.title]),
    standbyStore,
    summarizeStandbyFreshness: overrides.summarizeStandbyFreshness || ((summary) => ({ visible: summary.visibleTracks.length, stored: summary.storedTracks.length })),
    tasteProfile,
    tidal: overrides.tidal || { status: () => ({ circuit: { state: "closed" } }) },
    trackMemory: overrides.trackMemory || { record: () => {} },
    previouslySuggestedTrack: overrides.previouslySuggestedTrack || (() => false),
    voiceExecution: overrides.voiceExecution || { check: () => {} },
    withNormalizedYearFilter: overrides.withNormalizedYearFilter || ((options) => options),
    withTimeout: overrides.withTimeout || ((promise) => promise)
  });
}

test("standbySearchOptions uses explicit overrides instead of session options", () => {
  const service = createService({
    sessionStore: {
      read: () => ({ options: { request: "session request", genres: "session genre", zoneId: "zone-session" } })
    },
    tasteProfile: {
      getTopArtists: () => ["Guy J"],
      read: () => ({ feedback: {} })
    }
  });

  const options = service.standbySearchOptions({ request: "manual request", genres: "manual genre" }, { useSession: true });

  assert.match(options.request, /^manual request Standby pool:/);
  assert.equal(options.genres, "manual genre");
  assert.equal(options.zoneId, "zone-session");
  assert.equal(options.count, "3");
  assert.equal(options.standbyPool, "true");
});

test("standby defaults to a multi-facet taste reservoir instead of a progressive-only lane", () => {
  const service = createService({
    tasteProfile: {
      getTopArtists: () => ["Guy J", "Mersiv"],
      read: () => ({
        feedback: {},
        labels: { one: { name: "Anjunadeep", score: 4 } }
      })
    }
  });
  const options = service.standbySearchOptions({}, { useSession: false });

  assert.equal(options.genres, undefined);
  assert.equal(options.years, undefined);
  assert.equal(options.minScore, "50");
  assert.equal(options.scoringMode, "taste-guided");
  assert.deepEqual(options.learnedTasteArtists, ["Guy J", "Mersiv"]);
  assert.deepEqual(options.learnedTasteLabels, ["Anjunadeep"]);
  assert.match(options.request, /soft multi-facet taste guide/i);
  assert.equal(options.mood, undefined);
  assert.doesNotMatch(options.request, /Taste anchors:/i);
  assert.doesNotMatch(options.request, /Guy J|Mersiv|Anjunadeep/i);
  assert.doesNotMatch(options.request, /radio-like|underground/i);
});

test("standbyPlanAnchorMatches filters query-anchored tracks that do not match metadata", () => {
  const service = createService();
  const options = {
    requirePlanQueryAnchor: "true",
    llmSearchPlan: {
      candidateLabels: ["Lost & Found"]
    }
  };

  assert.equal(service.standbyPlanAnchorMatches({
    query: "lost & found progressive",
    artist: "Other",
    title: "Track",
    label: "Other Label"
  }, options), false);

  assert.equal(service.standbyPlanAnchorMatches({
    query: "lost & found progressive",
    artist: "Other",
    title: "Track",
    label: "Lost & Found"
  }, options), true);
});

test("standby activity cutoff ignores suggestions created by the current refresh", () => {
  const service = createService({
    discoveryHistory: {
      uniqueEntries: () => [
        { artist: "Old Artist", title: "Old Track", lastShownAt: 900 },
        { artist: "Current Artist", title: "Current Track", lastShownAt: 1100 }
      ]
    }
  });

  const events = service.standbyActivityEvents({ discoveryBefore: 1000 });

  assert.deepEqual(events.filter(event => event.kind === "discovery").map(event => event.title), ["Old Track"]);
});

test("standby does not treat a failed Roon queue attempt as completed activity", () => {
  const service = createService({
    standbyEvents: {
      entries: [{ key: "retry:1", kind: "queued", artist: "Retry Artist", title: "Retry Track", at: 1000 }]
    },
    candidateIdentityKeys: track => [track.key || `${track.artist || ""}|${track.title || ""}`],
    standbyStore: {
      read: () => ({
        candidates: [{ key: "retry:1", artist: "Retry Artist", title: "Retry Track", standbyQueueFailure: {
          failureType: "error",
          reason: "Roon browse service is not connected.",
          retainUntil: Date.now() + 60_000
        } }]
      })
    }
  });

  assert.equal(service.standbyActivityEvents().some(event => event.kind === "queued"), false);
});

test("standby display keeps a candidate when its own discovery record is newer than standby entry", () => {
  const service = createService({
    FreshPool: class extends TestFreshPool {
      constructor(options = {}) {
        super(options);
        this.events = options.events || [];
      }

      eligible(track = {}) {
        return !this.events.some(event => (event.kind === "suggested" || event.kind === "discovery") && event.key === track.key);
      }
    },
    candidateIdentityKeys: track => [track.key || ""],
    discoveryHistory: {
      uniqueEntries: () => [{ key: "standby:1", artist: "Current Artist", title: "Current Track", lastShownAt: 2000 }]
    },
    standbyStore: {
      summary: () => ({
        tracks: [{ key: "standby:1", artist: "Current Artist", title: "Current Track", standbyAddedAt: 1000 }],
        count: 1,
        nextRefreshAt: "later"
      })
    }
  });

  const summary = service.standbyFreshSummary();

  assert.equal(summary.count, 1);
  assert.equal(summary.filteredPreviouslySuggested, 0);
});

test("standbyFreshSummary filters newly ineligible tracks and reports hidden count", () => {
  const service = createService({
    FreshPool: class extends TestFreshPool {
      eligible(track = {}) {
        return !track.blocked;
      }
    },
    standbyStore: {
      summary: () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "B", title: "Two", blocked: true }
        ],
        count: 2,
        nextRefreshAt: "later"
      })
    }
  });

  const summary = service.standbyFreshSummary();

  assert.equal(summary.count, 1);
  assert.equal(summary.ready, false);
  assert.equal(summary.filteredPreviouslySuggested, 1);
  assert.equal(summary.nextRefreshAt, "later");
  assert.deepEqual(summary.freshness, { visible: 1, stored: 2 });
});

test("refreshStandbyPool keeps prior display and marks carryover when TIDAL circuit is open", async () => {
  let endSummary = null;
  let broadcasts = 0;
  const service = createService({
    tidal: { status: () => ({ circuit: { state: "open" } }) },
    standbyStore: {
      read: () => ({ candidates: [{ artist: "A", title: "One" }], standbyHistory: [], lastRefreshAt: "2026-01-01T00:00:00.000Z" }),
      summary: () => ({ tracks: [{ artist: "A", title: "One" }], count: 1 }),
      markRefreshStart: () => {},
      markRefreshEnd: (summary) => {
        endSummary = summary;
        return { tracks: [{ artist: "A", title: "One" }], count: 1, ...summary };
      },
      replace: () => {
        throw new Error("replace should not run on TIDAL circuit failure");
      }
    },
    scheduleBroadcast: () => {
      broadcasts += 1;
    }
  });

  const summary = await service.refreshStandbyPool({ force: true, reason: "manual" });

  assert.equal(summary.count, 1);
  assert.match(summary.lastError || summary.error || endSummary.error, /TIDAL search circuit is open/);
  assert.equal(endSummary.kept, 1);
  assert.equal(endSummary.diagnostics.novelty.carriedOver, 1);
  assert.equal(broadcasts, 2);
});
