"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TidalVerifier } = require("../src/tidalVerifier");

function abortingFetch(callCounter) {
  return async (url, options = {}) => {
    callCounter.count += 1;
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };
}

test("TIDAL verifier aborts stalled search fetches per request", async () => {
  const calls = { count: 0 };
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    timeoutMs: 15,
    failureThreshold: 3,
    circuitCooldownMs: 1000,
    fetchImpl: abortingFetch(calls)
  });

  await assert.rejects(
    () => tidal.searchTracks("slow search", { limit: 1 }),
    /TIDAL API lookup timed out/
  );
  assert.equal(calls.count, 1);
  assert.equal(tidal.status().circuit.failureCount, 1);
});

test("TIDAL verifier opens circuit after repeated fetch failures", async () => {
  const calls = { count: 0 };
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    timeoutMs: 15,
    failureThreshold: 2,
    circuitCooldownMs: 1000,
    fetchImpl: abortingFetch(calls)
  });

  await assert.rejects(() => tidal.searchTracks("slow one", { limit: 1 }), /timed out/);
  await assert.rejects(() => tidal.searchTracks("slow two", { limit: 1 }), /timed out/);
  assert.equal(tidal.status().circuit.state, "open");

  await assert.rejects(
    () => tidal.searchTracks("slow three", { limit: 1 }),
    /temporarily unavailable/
  );
  assert.equal(calls.count, 2);
});

test("TIDAL verifier half-open circuit closes after successful request", async () => {
  let now = 0;
  let fail = true;
  let calls = 0;
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    timeoutMs: 50,
    failureThreshold: 1,
    circuitCooldownMs: 100,
    clock: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (fail) {
        const error = new Error("fetch failed");
        error.code = "ECONNRESET";
        throw error;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], included: [] })
      };
    }
  });

  await assert.rejects(() => tidal.searchTracks("failing search", { limit: 1 }), /fetch failed/);
  assert.equal(tidal.status().circuit.state, "open");

  now = 1001;
  fail = false;
  const result = await tidal.searchTracks("healthy search", { limit: 1 });
  assert.deepEqual(result, []);
  assert.equal(calls, 2);
  assert.equal(tidal.status().circuit.state, "closed");
});
