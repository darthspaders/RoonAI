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

test("TIDAL verifier retries catalog lookup with profile OAuth token after rejected client token", async () => {
  const authorizations = [];
  const tidal = new TidalVerifier({
    enabled: true,
    clientId: "client-id",
    clientSecret: "client-secret",
    countryCode: "US",
    profileAccessTokenProvider: async () => "profile-token",
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const authorization = options.headers?.authorization || "";
      authorizations.push(authorization);
      if (parsed.hostname === "auth.tidal.com") {
        return jsonResponse({
          access_token: "client-token",
          expires_in: 3600
        });
      }
      if (authorization === "Bearer client-token") return jsonResponse({ error: "unauthorized" }, 401);
      assert.equal(authorization, "Bearer profile-token");
      return jsonResponse({ data: [], included: [] });
    }
  });

  const result = await tidal.searchTracks("nayuta Farblos", { limit: 1 });

  assert.deepEqual(result, []);
  assert.equal(authorizations.some((value) => value === "Bearer client-token"), true);
  assert.equal(authorizations.some((value) => value === "Bearer profile-token"), true);
  assert.equal(tidal.status().usingProfileTokenFallback, true);
});

test("TIDAL verifier enriches tracks-only v2 search results before exact matching", async () => {
  const calls = [];
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    countryCode: "US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.toString());
      if (parsed.pathname.includes("/searchResults/")) {
        assert.equal(parsed.searchParams.get("include"), "tracks");
        return jsonResponse({
          data: [
            { id: "101", type: "tracks" },
            { id: "202", type: "tracks" }
          ],
          included: [
            {
              id: "101",
              type: "tracks",
              attributes: {
                title: "Jigsaw",
                externalLinks: [{ href: "https://tidal.com/browse/track/101" }]
              }
            },
            {
              id: "202",
              type: "tracks",
              attributes: {
                title: "Jigsaw (Levitone Remix)",
                externalLinks: [{ href: "https://tidal.com/browse/track/202" }]
              }
            }
          ]
        });
      }
      if (parsed.pathname === "/v2/tracks/101") {
        return jsonResponse({
          data: {
            id: "101",
            type: "tracks",
            attributes: { title: "Jigsaw" },
            relationships: {
              artists: { data: [{ id: "other", type: "artists" }] },
              albums: { data: [{ id: "wrong-album", type: "albums" }] }
            }
          },
          included: [
            { id: "other", type: "artists", attributes: { name: "Other Artist" } },
            { id: "wrong-album", type: "albums", attributes: { title: "Jigsaw", releaseDate: "2024-01-01" } }
          ]
        });
      }
      if (parsed.pathname === "/v2/tracks/202") {
        return jsonResponse({
          data: {
            id: "202",
            type: "tracks",
            attributes: {
              title: "Jigsaw (Levitone Remix)",
              duration: "PT7M39S",
              externalLinks: [{ href: "https://tidal.com/browse/track/202" }]
            },
            relationships: {
              artists: { data: [{ id: "fact", type: "artists" }, { id: "allanmcloud", type: "artists" }] },
              albums: { data: [{ id: "correct-album", type: "albums" }] }
            }
          },
          included: [
            { id: "fact", type: "artists", attributes: { name: "F-act" } },
            { id: "allanmcloud", type: "artists", attributes: { name: "Allan McLoud" } },
            { id: "correct-album", type: "albums", attributes: { title: "Jigsaw (Levitone Remix)", releaseDate: "2026-04-10" } }
          ]
        });
      }
      return jsonResponse({}, 404);
    }
  });

  const result = await tidal.verify({
    artist: "F-act, Allan McLoud",
    title: "Jigsaw (Levitone Remix)"
  });

  assert.equal(result.id, "202");
  assert.equal(result.artist, "F-act, Allan McLoud");
  assert.equal(result.year, 2026);
  assert.equal(calls.some((url) => new URL(url).hostname === "api.tidal.com"), false);
});

test("standby search fetches related metadata in one request and retains version identity", async () => {
  let calls=0;
  const tidal=new TidalVerifier({enabled:true,accessToken:"token",countryCode:"US",fetchImpl:async url=>{
    calls++;
    assert.equal(new URL(url).searchParams.get("include"),"tracks.artists,tracks.albums");
    return jsonResponse({data:[{id:"1",type:"tracks"}],included:[
      {id:"1",type:"tracks",attributes:{title:"Flashes",version:"D-Nox & Beckers Remix",duration:"PT7M",externalLinks:[{href:"https://tidal.com/track/1"}]},relationships:{artists:{data:[{id:"a",type:"artists"}]},albums:{data:[{id:"b",type:"albums"}]}}},
      {id:"a",type:"artists",attributes:{name:"Stereo Underground, Sealine"}},
      {id:"b",type:"albums",attributes:{title:"Flashes",releaseDate:"2026-01-01"}}
    ]});
  }});
  const tracks=await tidal.searchTracks("Flashes",{standbyFresh:true,detailLimit:0});
  assert.equal(calls,1);assert.equal(tracks.length,1);
  assert.equal(tracks[0].title,"Flashes (D-Nox & Beckers Remix)");
});

test("TIDAL searchTracks enriches tracks-only v2 search rows before filtering", async () => {
  const detailCalls = [];
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    countryCode: "US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/searchResults/")) {
        assert.equal(parsed.searchParams.get("include"), "tracks");
        return jsonResponse({
          data: [
            { id: "1", type: "tracks" },
            { id: "2", type: "tracks" },
            { id: "3", type: "tracks" }
          ],
          included: ["1", "2", "3"].map((id) => ({
            id,
            type: "tracks",
            attributes: {
              title: `Track ${id}`,
              externalLinks: [{ href: `https://tidal.com/browse/track/${id}` }]
            }
          }))
        });
      }
      const trackId = parsed.pathname.split("/").pop();
      detailCalls.push(trackId);
      return jsonResponse({
        data: {
          id: trackId,
          type: "tracks",
          attributes: {
            title: `Track ${trackId}`,
            duration: "PT7M",
            externalLinks: [{ href: `https://tidal.com/browse/track/${trackId}` }]
          },
          relationships: {
            artists: { data: [{ id: `artist-${trackId}`, type: "artists" }] },
            albums: { data: [{ id: `album-${trackId}`, type: "albums" }] }
          }
        },
        included: [
          { id: `artist-${trackId}`, type: "artists", attributes: { name: `Artist ${trackId}` } },
          { id: `album-${trackId}`, type: "albums", attributes: { title: `Album ${trackId}`, releaseDate: "2026-01-01" } }
        ]
      });
    }
  });

  const results = await tidal.searchTracks("progressive house 2026", { limit: 3, detailLimit: 1 });

  assert.equal(results.length, 3);
  assert.deepEqual(detailCalls, ["1", "2", "3"]);
  assert.equal(results[2].artist, "Artist 3");
});

test("TIDAL exact lookup stops after the first high-confidence tracks-only match", async () => {
  const detailCalls = [];
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    countryCode: "US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/searchResults/")) {
        assert.equal(parsed.searchParams.get("include"), "tracks");
        return jsonResponse({
          data: [
            { id: "1", type: "tracks" },
            { id: "2", type: "tracks" },
            { id: "3", type: "tracks" }
          ],
          included: ["1", "2", "3"].map((id) => ({
            id,
            type: "tracks",
            attributes: {
              title: id === "1" ? "Jigsaw (Levitone Remix)" : `Other ${id}`,
              externalLinks: [{ href: `https://tidal.com/browse/track/${id}` }]
            }
          }))
        });
      }
      const trackId = parsed.pathname.split("/").pop();
      detailCalls.push(trackId);
      return jsonResponse({
        data: {
          id: trackId,
          type: "tracks",
          attributes: {
            title: trackId === "1" ? "Jigsaw (Levitone Remix)" : `Other ${trackId}`,
            duration: "PT7M",
            externalLinks: [{ href: `https://tidal.com/browse/track/${trackId}` }]
          },
          relationships: {
            artists: { data: [{ id: `artist-${trackId}`, type: "artists" }] },
            albums: { data: [{ id: `album-${trackId}`, type: "albums" }] }
          }
        },
        included: [
          { id: `artist-${trackId}`, type: "artists", attributes: { name: trackId === "1" ? "F-act" : `Artist ${trackId}` } },
          {
            id: `album-${trackId}`,
            type: "albums",
            attributes: { title: `Album ${trackId}`, releaseDate: "2026-01-01" },
            relationships: {
              coverArt: { data: [{ id: `art-${trackId}`, type: "artworks" }] }
            }
          },
          {
            id: `art-${trackId}`,
            type: "artworks",
            attributes: {
              files: [
                { href: `https://resources.tidal.com/${trackId}-small.jpg`, meta: { width: 80, height: 80 } },
                { href: `https://resources.tidal.com/${trackId}-large.jpg`, meta: { width: 640, height: 640 } }
              ]
            }
          }
        ]
      });
    }
  });

  const result = await tidal.findExactTrack({
    artist: "F-act",
    title: "Jigsaw (Levitone Remix)"
  }, { limit: 3 });

  assert.equal(result.id, "1");
  assert.equal(result.title, "Jigsaw (Levitone Remix)");
  assert.equal(result.imageUrl, "https://resources.tidal.com/1-large.jpg");
  assert.deepEqual(detailCalls, ["1"]);
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

test("TIDAL verifier retries transient DNS lookup failures before opening circuit", async () => {
  let calls = 0;
  const tidal = new TidalVerifier({
    enabled: true,
    accessToken: "token",
    timeoutMs: 1000,
    failureThreshold: 1,
    circuitCooldownMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 2) {
        const error = new TypeError("fetch failed");
        const code = calls === 1 ? "EAI_AGAIN" : "ENOTFOUND";
        error.cause = {
          code,
          message: `getaddrinfo ${code} api.tidal.com`
        };
        throw error;
      }
      return jsonResponse({ data: [], included: [] });
    }
  });

  const result = await tidal.searchTracks("nayuta Farblos", { limit: 1 });

  assert.deepEqual(result, []);
  assert.equal(calls, 3);
  assert.equal(tidal.status().circuit.state, "closed");
  assert.equal(tidal.status().circuit.failureCount, 0);
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
