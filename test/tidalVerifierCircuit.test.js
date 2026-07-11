"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TidalVerifier, trackSourceQualityFromMetadata } = require("../src/tidalVerifier");

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

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/vnd.api+json" },
    json: async () => body
  };
}

test("source quality formatter renders exact Roon-style values when present", () => {
  const quality = trackSourceQualityFromMetadata({
    mediaTags: ["LOSSLESS"],
    sampleRate: 44100,
    bitDepth: 24,
    channels: 2
  }, { source: "TIDAL" });

  assert.equal(quality.display, "TIDAL FLAC 44.1kHz 24bit 2ch");
  assert.equal(quality.exact, true);
});

test("source quality formatter uses TIDAL tags without inventing exact values", () => {
  const quality = trackSourceQualityFromMetadata({
    mediaTags: ["HIRES_LOSSLESS", "LOSSLESS"]
  }, { source: "TIDAL" });

  assert.equal(quality.display, "TIDAL FLAC HiRes Lossless");
  assert.equal(quality.exact, false);
  assert.equal(quality.sampleRateKhz, null);
  assert.equal(quality.bitDepth, null);
});

test("TIDAL verifier prefers exact remix result over earlier loose title hit", async () => {
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    countryCode: "US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/searchResults/")) {
        return jsonResponse({
          data: [
            { id: "wrong", type: "tracks" },
            { id: "correct", type: "tracks" }
          ],
          included: [
            {
              id: "wrong",
              type: "tracks",
              attributes: {
                title: "In Your Arms (For An Angel)",
                externalLinks: [{ href: "https://tidal.com/browse/track/wrong" }]
              },
              relationships: {
                artists: { data: [{ id: "topic", type: "artists" }, { id: "pvd", type: "artists" }] },
                albums: { data: [{ id: "wrong-album", type: "albums" }] }
              }
            },
            {
              id: "correct",
              type: "tracks",
              attributes: {
                title: "For An Angel (PvD's E-Werk Club Mix)",
                externalLinks: [{ href: "https://tidal.com/browse/track/correct" }]
              },
              relationships: {
                artists: { data: [{ id: "pvd", type: "artists" }] },
                albums: { data: [{ id: "correct-album", type: "albums" }] }
              }
            },
            { id: "topic", type: "artists", attributes: { name: "Topic" } },
            { id: "pvd", type: "artists", attributes: { name: "Paul van Dyk" } },
            { id: "wrong-album", type: "albums", attributes: { title: "In Your Arms (For An Angel)" } },
            { id: "correct-album", type: "albums", attributes: { title: "For An Angel (30th Anniversary Edition)" } }
          ]
        });
      }
      if (parsed.pathname === "/v2/tracks/correct") {
        return jsonResponse({
          data: {
            id: "correct",
            type: "tracks",
            attributes: {
              title: "For An Angel (PvD's E-Werk Club Mix)",
              externalLinks: [{ href: "https://tidal.com/browse/track/correct" }]
            },
            relationships: {
              artists: { data: [{ id: "pvd", type: "artists" }] },
              albums: { data: [{ id: "correct-album", type: "albums" }] }
            }
          },
          included: [
            { id: "pvd", type: "artists", attributes: { name: "Paul van Dyk" } },
            { id: "correct-album", type: "albums", attributes: { title: "For An Angel (30th Anniversary Edition)" } }
          ]
        });
      }
      return jsonResponse({}, 404);
    }
  });

  const result = await tidal.verify({
    artist: "Paul van Dyk",
    title: "For An Angel (PvD's E-Werk Club Mix)"
  });

  assert.equal(result.id, "correct");
  assert.equal(result.title, "For An Angel (PvD's E-Werk Club Mix)");
  assert.equal(result.artist, "Paul van Dyk");
});

test("TIDAL verifier retries catalog lookup with client credentials after stale manual token", async () => {
  const authorizations = [];
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "stale-token",
    clientId: "client-id",
    clientSecret: "client-secret",
    countryCode: "US",
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const authorization = options.headers?.authorization || "";
      authorizations.push(authorization);
      if (parsed.hostname === "auth.tidal.com") {
        return jsonResponse({
          access_token: "fresh-token",
          expires_in: 3600
        });
      }
      if (authorization === "Bearer stale-token") return jsonResponse({ error: "unauthorized" }, 401);
      assert.equal(authorization, "Bearer fresh-token");
      return jsonResponse({ data: [], included: [] });
    }
  });

  const result = await tidal.searchTracks("Amand Capoon khen Ouverture", { limit: 1 });

  assert.deepEqual(result, []);
  assert.equal(authorizations.some((value) => value === "Bearer stale-token"), true);
  assert.equal(authorizations.some((value) => value === "Bearer fresh-token"), true);
});

test("TIDAL verifier reports rejected manual token when no client credentials are configured", async () => {
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "stale-token",
    countryCode: "US",
    fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401)
  });

  await assert.rejects(
    () => tidal.searchTracks("Amand Capoon khen Ouverture", { limit: 1 }),
    /TIDAL_ACCESS_TOKEN was rejected/
  );
});

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
