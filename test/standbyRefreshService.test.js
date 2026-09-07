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
