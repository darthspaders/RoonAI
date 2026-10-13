"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { TidalVerifier } = require("../src/tidalVerifier");

test("supplied queue diagnostic logs all provider candidates and prefilter rejections only when enabled", async () => {
  const events = [];
  const tidal = new TidalVerifier({ enabled: true, accessToken: "fixture-secret-never-log",
    artistAliasFile: path.join(__dirname, "fixtures/absent-diagnostic-aliases.json"),
    catalogPaginationFile: path.join(__dirname, "fixtures/absent-diagnostic-pagination.json"),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ items: [
      { type: "tracks", id: "1", attributes: { title: "Lovin' Sun", version: "Guy J Remix" }, artists: [{ id: "a", name: "Budakid" }] },
      { type: "tracks", id: "2", attributes: { title: "Unrelated" }, artists: [{ id: "b", name: "Wrong artist" }] }
    ] }) }) });
  const track = { artist: "Budakid", title: "Lovin' Sun (Guy J Remix)" };
  await tidal.searchExactCandidates(track, { logger: entry => events.push(entry) });
  assert.deepEqual(events, []);
  const candidates = await tidal.searchExactCandidates(track, { diagnostics: true, logger: entry => events.push(entry) });
  assert.equal(candidates[0].title, track.title, "provider's separate version attribute must be retained");
  assert.equal(events[0].event, "tidal_exact_request");
  assert.equal(events[0].normalizedQuery, "Budakid Lovin' Sun (Guy J Remix)");
  const returned = events.find(entry => entry.event === "tidal_exact_candidates").candidates;
  assert.equal(returned.length, 2);
  assert.equal(returned[0].preFilterAccepted, true);
  assert.equal(returned[1].preFilterAccepted, false);
  assert.match(returned[1].rejectionReason, /incompatible-base-title/);
  assert.equal(JSON.stringify(events).includes("fixture-secret-never-log"), false);
});
