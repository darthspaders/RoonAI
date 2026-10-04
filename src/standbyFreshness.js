"use strict";
const voiceExecution = require("./voiceExecution");

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isStandbySeoSludge, standbyArtistKeys, diverseStandbyCandidates } = require("./standbyCandidateStore");
const DAY = 86400000;
const {identityKeys}=require("./standbyTrackIdentity");
const timestamp = value => typeof value === "number" ? value : Date.parse(value || "");
// The normal standby floor is 50. Historical recovery uses the same floor,
// but remains tightly bounded by activity checks, sludge filtering, and a
// small artist/album-diverse shortlist after fresh search is exhausted.
const HISTORY_FALLBACK_MIN_SCORE = 50;
const BLOCK_REASON_PRIORITY = {
  recentlyPlayedExcluded: 50,
  recentlyRatedExcluded: 45,
  recentlyQueuedExcluded: 40,
  recentStandbyExcluded: 30,
  recentlySuggestedExcluded: 20
};

function blockReasonPriority(reason = "") {
  return Number(BLOCK_REASON_PRIORITY[reason] || 0);
}

function settings(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key]);
    return Math.max(min, Math.min(max, Number.isFinite(value) && env[key] !== undefined ? value : fallback));
  };
  return {
    standbyRefreshes: Math.floor(number("STANDBY_COOLDOWN_REFRESHES", 10, 1, 100)),
    activityDays: number("STANDBY_ACTIVITY_COOLDOWN_DAYS", 30, 1, 3650),
    suggestedDays: number("STANDBY_SUGGESTED_COOLDOWN_DAYS", 30, 1, 3650),
    // Normal discovery suggestions should not starve the standby pool for a
    // full month. Standby suggestions and user activity retain their longer
    // safety windows; this is only the cooldown for ordinary discovery output.
    discoveryDays: number("STANDBY_DISCOVERY_COOLDOWN_DAYS", 7, 1, 3650),
    rawMultiplier: number("STANDBY_RAW_POOL_MULTIPLIER", 4, 2.4, 8),
    searchBudgetMs: number("STANDBY_SEARCH_BUDGET_MS", 120000, 10000, 600000)
  };
}

class FreshnessEvents {
  constructor(file = path.join(__dirname, "..", "data", "standby-activity.json")) {
    this.file = file;
    try { this.entries = JSON.parse(fs.readFileSync(file, "utf8")).entries || []; } catch { this.entries = []; }
  }
  record(kind, tracks, at = Date.now()) {
    const byKey = new Map(this.entries.map(entry => [`${entry.kind}:${identityKeys(entry)[0]}`, entry]));
    for (const track of tracks) {
      const keys = identityKeys(track);
      if (!keys.length) continue;
      byKey.set(`${kind}:${keys[0]}`, { kind, at, keys, artist: track.artist || "", title: track.title || "", version: track.version || track.tidal?.version || "", tidalTrackId: keys.find(k => k.startsWith("tidal:"))?.slice(6) || "" });
    }
    this.entries = [...byKey.values()];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, entries: this.entries }, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
  }
}

class FreshPool {
  constructor({ history = [], current = [], events = [], config = settings(), target = 25, now = Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.target = target;
    this.rawTarget = Math.max(target, Math.ceil(target * config.rawMultiplier));
    this.blocked = new Map();
    this.pool = [];
    this.seen = new Set();
    this.observed = new Set();
    this.excluded = new Set();
    this.diagnostics = Object.fromEntries(["rawCandidatesGenerated", "recentStandbyExcluded", "recentlyPlayedExcluded", "recentlyQueuedExcluded", "recentlyRatedExcluded", "recentlySuggestedExcluded", "duplicateIdsExcluded", "artistCapExcluded", "freshCandidatesRemaining", "replacementSearchPasses", "newTracksIntroduced", "carriedOver", "finalCount", "historyFallbackConsidered", "historyFallbackReviewed", "historyFallbackKept"].map(key => [key, 0]));
    const block = (track, reason) => {
      for (const key of [...identityKeys(track), ...(track.keys || [])]) {
        const previous = this.blocked.get(key);
        if (!previous || blockReasonPriority(reason) > blockReasonPriority(previous)) this.blocked.set(key, reason);
      }
    };
    // Activity must outrank suggestion history. A track that was recently
    // played, queued, or rated is not a harmless historical suggestion and
    // must never be admitted through the historical fallback reservoir.
    for (const event of events) {
      const days = event.kind === "discovery"
        ? config.discoveryDays
        : (event.kind === "suggested" || event.kind === "playlist" ? config.suggestedDays : config.activityDays);
      if (!(now - timestamp(event.at) < days * DAY)) continue;
      const reason = { played: "recentlyPlayedExcluded", queued: "recentlyQueuedExcluded", rated: "recentlyRatedExcluded", discovery: "recentlySuggestedExcluded", suggested: "recentlySuggestedExcluded", playlist: "recentlySuggestedExcluded" }[event.kind];
      if (reason) block(event, reason);
    }
    for (const run of history.slice(-config.standbyRefreshes)) for (const track of run.tracks || []) block(track, "recentStandbyExcluded");
    // A legacy visible pool may not have a recorded refresh yet.
    for (const track of current) block(track, "recentStandbyExcluded");
    for (const run of history) if (now - timestamp(run.timestamp) < config.suggestedDays * DAY) for (const track of run.tracks || []) block(track, "recentlySuggestedExcluded");
    this.deferred = [];
    this.deferredSeen = new Set();
  }
  blockEvents(events) {
    const extra=new FreshPool({events,config:this.config,now:this.now,target:this.target});
    for(const [key,reason] of extra.blocked) {
      const previous = this.blocked.get(key);
      if (!previous || blockReasonPriority(reason) > blockReasonPriority(previous)) this.blocked.set(key, reason);
    }
  }
  observe(track) {
    const keys = identityKeys(track);
    if (!keys.some(key => this.observed.has(key))) this.diagnostics.rawCandidatesGenerated++;
    for (const key of keys) this.observed.add(key);
    return this.eligible(track);
  }
  eligible(track) {
    const keys = identityKeys(track);
    const reason = keys.map(key => this.blocked.get(key)).find(Boolean);
    if (reason && !keys.some(key => this.excluded.has(key))) {
      this.diagnostics[reason]++;
      for (const key of keys) this.excluded.add(key);
    }
    return keys.length > 0 && !reason;
  }
  add(tracks) {
    for (const track of tracks) {
      const keys = identityKeys(track);
      const blockedReason = keys.map(key => this.blocked.get(key)).find(Boolean) || "";
      if (!this.observe(track)) {
        // A prior suggestion is not automatically bad forever. Keep a small,
        // reviewable reservoir for the end of a refresh, but never defer
        // recent playback/rating/queue activity or candidates already marked
        // as standby repeats. Quality and sludge checks happen before the
        // reservoir is allowed to reach model review.
        const score = Number(track.score ?? track.scoreBreakdown?.total ?? 0);
        const key = keys[0] || "";
        if (
          blockedReason === "recentlySuggestedExcluded" &&
          score >= HISTORY_FALLBACK_MIN_SCORE &&
          !isStandbySeoSludge(track) &&
          key &&
          !this.deferredSeen.has(key)
        ) {
          this.deferredSeen.add(key);
          this.deferred.push({
            ...track,
            standbyFallbackReason: "Previously surfaced, but not recently played, queued, or rated."
          });
          this.diagnostics.historyFallbackConsidered++;
        }
        continue;
      }
      if (keys.some(key => this.seen.has(key))) { this.diagnostics.duplicateIdsExcluded++; continue; }
      if (Number(track.score ?? track.scoreBreakdown?.total ?? 0) < 50 || isStandbySeoSludge(track)) continue;
      for (const key of keys) this.seen.add(key);
      const copy = { ...track };
      delete copy.standbyFinalRank; delete copy.standbySynapseRank; delete copy.standbyNovelty;
      this.pool.push(copy);
    }
    this.pool.sort((a, b) => Number(b.score) - Number(a.score));
  }
  select(allowSecond = false, allowThird = false) {
    const first = diverseStandbyCandidates(this.pool, this.target, 1);
    if (!allowSecond || first.length >= this.target) return first;
    // Album variety is preferred, but a short clean reservoir should not
    // discard excellent tracks merely because the same release supplied two
    // candidates. The caller only reaches this stage after the strict pass
    // undershoots, and the third pass remains capped at two per artist.
    const second = diverseStandbyCandidates([...first, ...this.pool.filter(t => !first.includes(t))], this.target, 2, 2);
    if (!allowThird || second.length >= this.target) return second;
    // Artist variety is preferred, not absolute. If the clean pool is still
    // short, let a third strong track from an artist through before asking
    // history or lower-confidence candidates to fill the gap.
    return diverseStandbyCandidates([...second, ...this.pool.filter(t => !second.includes(t))], this.target, 3, 2);
  }
  fallbackCandidates(limit = this.target) {
    const primaryKeys = new Set(this.pool.flatMap(identityKeys));
    const candidates = this.deferred
      .filter(track => !identityKeys(track).some(key => primaryKeys.has(key)))
      .sort((left, right) => Number(right.score ?? right.scoreBreakdown?.total ?? 0) - Number(left.score ?? left.scoreBreakdown?.total ?? 0));
    return diverseStandbyCandidates(candidates, Math.max(0, Number(limit || 0)), 2, 2);
  }
  finish(tracks, reason = "") {
    const runId = randomUUID();
    const selectedKeys = new Set(tracks.flatMap(identityKeys));
    const cap = this.select().length >= this.target ? 1 : 2;
    const counts = new Map();
    for (const track of tracks) for (const key of standbyArtistKeys(track)) counts.set(key, (counts.get(key) || 0) + 1);
    this.diagnostics.artistCapExcluded = this.pool.filter(t => !identityKeys(t).some(k=>selectedKeys.has(k)) && standbyArtistKeys(t).some(k => (counts.get(k) || 0) >= cap)).length;
    this.diagnostics.historyFallbackKept = tracks.filter(track => track.standbyFallbackReason).length;
    Object.assign(this.diagnostics, { freshCandidatesRemaining: this.pool.length, newTracksIntroduced: tracks.length, carriedOver: 0, finalCount: tracks.length, targetCount: this.target, rawCandidateTarget: this.rawTarget, shortfallReason: tracks.length < this.target ? reason || "Fresh search inventory exhausted." : "", cooldown: this.config });
    return tracks.map((track, rank) => ({ ...track, standbyFinalRank: { runId, rank } }));
  }
}

// Shared by production and regression tests: no old-pool or rejected-candidate refill path.
async function searchFreshPool({ pool, passes, search, review, budgetMs = pool.config.searchBudgetMs, clock = Date.now }) {
  const deadline = clock() + budgetMs;
  const searches = [];
  for (const [index, pass] of passes.entries()) {
    voiceExecution.check();
    const remainingMs = deadline - clock();
    if (remainingMs <= 0) break;
    if (index > 0) pool.diagnostics.replacementSearchPasses++;
    try {
      const result = await search(pass, { remainingMs, requestedCount: pool.rawTarget, acceptCandidate: t => pool.observe(t) });
      pool.add(result.tracks || []);
      searches.push({ pass: pass.id, returned: result.tracks?.length || 0, fresh: pool.select().length, diagnostics: result.diagnostics || null });
    } catch (error) { searches.push({ pass: pass.id, error: error.message }); }
    if (pool.select().length >= pool.target) break;
  }
  voiceExecution.check();
  const primaryShortlist = pool.select(true, true);
  const fallbackShortlist = primaryShortlist.length < pool.target
    ? pool.fallbackCandidates(pool.target - primaryShortlist.length)
    : [];
  pool.diagnostics.historyFallbackReviewed = fallbackShortlist.length;
  const shortlist = [...primaryShortlist, ...fallbackShortlist];
  const reviewed = await review(shortlist);
  voiceExecution.check();
  const tracks = pool.finish(reviewed.tracks, clock() >= deadline ? "Fresh search time budget exhausted." : "Fresh search passes exhausted.");
  return { tracks, review: reviewed.review, novelty: pool.diagnostics, searches };
}

module.exports = { identityKeys, settings, FreshPool, FreshnessEvents, searchFreshPool };
