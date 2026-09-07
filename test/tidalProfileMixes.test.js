"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { TidalProfileMixes, normalizeTidalMixesPayload } = require("../src/tidalProfileMixes");

function tempTokenFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tidal-profile-mixes-"));
  return path.join(dir, "token.json");
}

test("TIDAL profile mix normalizer extracts nested personal mixes", () => {
  const payload = {
    rows: [
      {
        title: "For You",
        items: [
          {
            id: "mix-1",
            title: "My Mix 1",
            subTitle: "Guy J, Cid Inc, Hernan Cattaneo",
            imageId: "12345678-1234-1234-1234-123456789abc",
            type: "MIX"
          },
          {
            id: "daily",
            title: "My Daily Discovery",
            description: "Songs by new and familiar artists inspired by your listening.",
            imageUrl: "https://example.test/daily.jpg"
          },
          {
            id: "video-1",
            title: "My Mix Video",
            type: "VIDEO"
          }
        ]
      },
      {
        modules: [
          {
            uuid: "radio-1",
            header: "Track Radio Apollo",
            subtitle: "Personal radio",
            contentType: "RADIO"
          }
        ]
      }
    ]
  };

  const mixes = normalizeTidalMixesPayload(payload);
  assert.deepEqual(mixes.map((mix) => mix.title), [
    "My Daily Discovery",
    "My Mix 1",
    "Track Radio Apollo"
  ]);
  assert.equal(mixes[0].category, "Daily Discovery");
  assert.equal(mixes[1].category, "My Mix");
  assert.equal(mixes[2].category, "Track Radio");
  assert.match(mixes[1].imageUrl, /^https:\/\/resources\.tidal\.com\/images\//);
});

test("TIDAL profile mix client reports missing user token clearly", async () => {
  const client = new TidalProfileMixes({ accessToken: "", enabled: true, tokenFile: tempTokenFile() });
  const result = await client.getMixes();
  assert.equal(result.connected, false);
  assert.equal(result.configured, false);
  assert.match(result.error, /TIDAL_PROFILE_ACCESS_TOKEN/);
});

test("TIDAL profile mix client fetches configured endpoint with bearer token", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    tokenFile: tempTokenFile(),
    endpoint: "https://api.tidal.com/v1/pages/home",
    countryCode: "US",
    locale: "en_US",
    deviceType: "BROWSER",
    clock: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        items: [
          { id: "new-arrivals", title: "My New Arrivals", type: "MIX" }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await client.getMixes({ force: true });
  assert.equal(result.connected, true);
  assert.equal(result.mixes.length, 1);
  assert.equal(result.mixes[0].category, "New Arrivals");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /countryCode=US/);
  assert.match(calls[0].url, /deviceType=BROWSER/);
  assert.equal(calls[0].options.headers.authorization, "Bearer profile-token");
});

test("TIDAL profile mix client reads official recommendation playlists", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    clock: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/userRecommendations/me") {
        return new Response(JSON.stringify({
          data: {
            id: "me",
            type: "userRecommendations",
            relationships: {
              discoveryMixes: { data: [{ id: "daily", type: "playlists" }] },
              newArrivalMixes: { data: [] },
              myMixes: { data: [{ id: "mix1", type: "playlists" }] },
              offlineMixes: { data: [] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/daily") {
        return new Response(JSON.stringify({
          data: {
            id: "daily",
            type: "playlists",
            attributes: {
              name: "My Daily Discovery",
              description: "Songs by new and familiar artists.",
              playlistType: "MIX",
              externalLinks: [{ href: "https://listen.tidal.com/mix/daily" }]
            },
            relationships: {
              coverArt: { data: [{ id: "art-daily", type: "artworks" }] },
              items: { data: [{ id: "1", type: "tracks" }, { id: "2", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/mix1") {
        return new Response(JSON.stringify({
          data: {
            id: "mix1",
            type: "playlists",
            attributes: {
              name: "My Mix 1",
              description: "Guy J, Cid Inc and more",
              playlistType: "MIX",
              externalLinks: [{ href: "https://listen.tidal.com/mix/mix1" }]
            },
            relationships: {
              coverArt: { data: [{ id: "art-mix1", type: "artworks" }] },
              items: { data: [{ id: "3", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname.startsWith("/v2/artworks/")) {
        return new Response(JSON.stringify({
          data: {
            id: parsed.pathname.split("/").at(-1),
            type: "artworks",
            attributes: {
              mediaType: "IMAGE",
              files: [
                { href: "https://resources.tidal.com/small.jpg", meta: { width: 80, height: 80 } },
                { href: "https://resources.tidal.com/large.jpg", meta: { width: 640, height: 640 } }
              ]
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getMixes({ force: true });
  assert.equal(result.connected, true);
  assert.deepEqual(result.mixes.map((mix) => mix.title), ["My Daily Discovery", "My Mix 1"]);
  assert.equal(result.mixes[0].category, "Daily Discovery");
  assert.equal(result.mixes[0].itemCount, 2);
  assert.equal(result.mixes[0].imageUrl, "https://resources.tidal.com/large.jpg");
  assert.match(result.sourceEndpoint, /openapi\.tidal\.com\/v2\/userRecommendations\/me/);
  assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer profile-token"));
  assert.ok(calls.some((call) => call.url.includes("/v2/playlists/daily")));
});

test("TIDAL profile mix client adds full Mixes & Radio shelf when legacy scope is available", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    clientId: "client-id",
    scopes: "user.read playlists.read recommendations.read r_usr",
    allowLegacyScope: true,
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    clock: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/userRecommendations/me") {
        return new Response(JSON.stringify({
          data: {
            id: "me",
            type: "userRecommendations",
            relationships: {
              discoveryMixes: { data: [] },
              newArrivalMixes: { data: [] },
              myMixes: { data: [] },
              offlineMixes: { data: [] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v1/pages/home") {
        return new Response(JSON.stringify({
          rows: [
            {
              title: "Mixes & Radio",
              items: [
                {
                  uuid: "artist-radio-747",
                  title: "747",
                  subtitle: "Artist Radio",
                  contentType: "RADIO",
                  imageUrl: "https://images.tidal.com/artist-radio.jpg"
                }
              ]
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getMixes({ force: true });
  assert.equal(result.connected, true);
  assert.equal(result.fullShelfAvailable, true);
  assert.deepEqual(result.mixes.map((mix) => `${mix.category}: ${mix.title}`), ["Artist Radio: 747"]);
  assert.ok(calls.some((call) => call.url.includes("/v1/pages/home")));
  assert.ok(calls.some((call) => call.options.headers["x-tidal-token"] === "client-id"));
});

test("TIDAL profile mix client synthesizes Artist Radio from official mix artists without legacy scope", async () => {
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    clientId: "client-id",
    scopes: "user.read playlists.read recommendations.read",
    artistRadioFallback: true,
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    clock: () => 1_800_000_000_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/userRecommendations/me") {
        return new Response(JSON.stringify({
          data: {
            id: "me",
            type: "userRecommendations",
            relationships: {
              discoveryMixes: { data: [] },
              newArrivalMixes: { data: [] },
              myMixes: { data: [{ id: "mix1", type: "playlists" }] },
              offlineMixes: { data: [] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/mix1") {
        return new Response(JSON.stringify({
          data: {
            id: "mix1",
            type: "playlists",
            attributes: {
              name: "My Mix 1",
              description: "deadmau5, Kx5 and more",
              playlistType: "MIX"
            },
            relationships: {
              coverArt: { data: [] },
              items: { data: [{ id: "track1", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/searchResults/deadmau5/relationships/artists") {
        return new Response(JSON.stringify({
          data: [{ id: "3523908", type: "artists" }],
          included: [
            { id: "3523908", type: "artists", attributes: { name: "deadmau5" } },
            { id: "111", type: "artists", attributes: { name: "not deadmau5" } }
          ]
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/artists/3523908/relationships/radio") {
        return new Response(JSON.stringify({
          data: [{ id: "radio-playlist", type: "playlists" }]
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/radio-playlist") {
        return new Response(JSON.stringify({
          data: {
            id: "radio-playlist",
            type: "playlists",
            attributes: {
              name: "deadmau5",
              description: "Artist Radio",
              playlistType: "MIX"
            },
            relationships: {
              coverArt: { data: [] },
              items: { data: [{ id: "radio-track", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getMixes({ force: true });
  assert.equal(result.fullShelfAvailable, false);
  assert.equal(result.artistRadioFallbackAvailable, true);
  assert.equal(result.artistRadioFallbackCount, 1);
  assert.deepEqual(result.mixes.map((mix) => `${mix.category}: ${mix.title}`), [
    "My Mix: My Mix 1",
    "Artist Radio: deadmau5"
  ]);
});

test("TIDAL profile mix client does not synthesize Artist Radio by default", async () => {
  let artistRadioEndpointCalled = false;
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    clientId: "client-id",
    scopes: "user.read playlists.read recommendations.read",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    clock: () => 1_800_000_000_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes("/relationships/radio")) artistRadioEndpointCalled = true;
      if (parsed.pathname === "/v2/userRecommendations/me") {
        return new Response(JSON.stringify({
          data: {
            id: "me",
            type: "userRecommendations",
            relationships: {
              discoveryMixes: { data: [] },
              newArrivalMixes: { data: [] },
              myMixes: { data: [{ id: "mix1", type: "playlists" }] },
              offlineMixes: { data: [] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/mix1") {
        return new Response(JSON.stringify({
          data: {
            id: "mix1",
            type: "playlists",
            attributes: {
              name: "My Mix 1",
              description: "deadmau5, Kx5 and more",
              playlistType: "MIX"
            },
            relationships: {
              coverArt: { data: [] },
              items: { data: [{ id: "track1", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getMixes({ force: true });
  assert.equal(result.artistRadioFallbackAvailable, false);
  assert.equal(result.artistRadioFallbackCount, 0);
  assert.equal(artistRadioEndpointCalled, false);
  assert.deepEqual(result.mixes.map((mix) => `${mix.category}: ${mix.title}`), [
    "My Mix: My Mix 1"
  ]);
});

test("TIDAL profile mix client expands a mix into Roon-ready tracks", async () => {
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/mix1") {
        return new Response(JSON.stringify({
          data: {
            id: "mix1",
            type: "playlists",
            attributes: {
              name: "My Mix 1",
              description: "Guy J and more",
              playlistType: "MIX",
              externalLinks: [{ href: "https://listen.tidal.com/mix/mix1" }]
            },
            relationships: {
              coverArt: { data: [{ id: "art-mix1", type: "artworks" }] },
              items: { data: [{ id: "track1", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/artworks/art-mix1") {
        return new Response(JSON.stringify({
          data: {
            id: "art-mix1",
            type: "artworks",
            attributes: {
              mediaType: "IMAGE",
              files: [{ href: "https://resources.tidal.com/mix.jpg", meta: { width: 640, height: 640 } }]
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/mix1/relationships/items") {
        return new Response(JSON.stringify({
          data: [{ id: "track1", type: "tracks" }],
          included: [
            {
              id: "track1",
              type: "tracks",
              attributes: {
                title: "Deep Signal",
                version: "Extended Mix",
                duration: "PT7M8S",
                externalLinks: [{ href: "https://tidal.com/browse/track/track1" }]
              },
              relationships: {
                artists: { data: [{ id: "artist1", type: "artists" }] },
                albums: { data: [{ id: "album1", type: "albums" }] }
              }
            },
            { id: "artist1", type: "artists", attributes: { name: "Example Artist" } },
            { id: "album1", type: "albums", attributes: { title: "Deep Signal", releaseDate: "2026-06-01" } }
          ]
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getMixTracks("mix1");
  assert.equal(result.mix.title, "My Mix 1");
  assert.equal(result.count, 1);
  assert.deepEqual(result.tracks[0], {
    title: "Deep Signal (Extended Mix)",
    artist: "Example Artist",
    album: "Deep Signal",
    year: "2026",
    releaseDate: "2026-06-01",
    durationMs: 428000,
    artists: [{ id: "artist1", name: "Example Artist" }],
    artistIds: ["artist1"],
    label: "",
    source: "TIDAL profile mix",
    discoverySource: "TIDAL mix: My Mix 1",
    tidal: {
      id: "track1",
      title: "Deep Signal (Extended Mix)",
      artist: "Example Artist",
      artists: [{ id: "artist1", name: "Example Artist" }],
      artistIds: ["artist1"],
      album: "Deep Signal",
      durationMs: 428000,
      tidalUrl: "https://tidal.com/browse/track/track1",
      verified: true
    },
    tidalUrl: "https://tidal.com/browse/track/track1"
  });

  const filtered = await client.getMixTracks("mix1", {
    limit: 1,
    excludeTracks: [{ title: "Deep Signal", artist: "Example Artist" }]
  });
  assert.equal(filtered.fetchedCount, 1);
  assert.equal(filtered.excludedCount, 1);
  assert.equal(filtered.count, 0);
});

test("TIDAL profile mix client resolves pinned playlist imports", async () => {
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/pinned-mix") {
        return new Response(JSON.stringify({
          data: {
            id: "pinned-mix",
            type: "playlists",
            attributes: {
              name: "My Mix 9",
              description: "Sasha, Digweed and more",
              playlistType: "MIX",
              externalLinks: [{ href: "https://listen.tidal.com/mix/pinned-mix" }]
            },
            relationships: {
              coverArt: { data: [{ id: "art-pinned", type: "artworks" }] },
              items: { data: [{ id: "track1", type: "tracks" }, { id: "track2", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/artworks/art-pinned") {
        return new Response(JSON.stringify({
          data: {
            id: "art-pinned",
            type: "artworks",
            attributes: {
              files: [{ href: "https://resources.tidal.com/pinned.jpg", meta: { width: 640, height: 640 } }]
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getPinnedMixes([{
    key: "mix:pinned-mix",
    kind: "mix",
    id: "pinned-mix",
    sourceUrl: "https://listen.tidal.com/mix/pinned-mix",
    createdAt: 1_800_000_000_000
  }]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.mixes.length, 1);
  assert.equal(result.mixes[0].title, "My Mix 9");
  assert.equal(result.mixes[0].category, "My Mix");
  assert.equal(result.mixes[0].pinned, true);
  assert.equal(result.mixes[0].pinnedKey, "mix:pinned-mix");
  assert.equal(result.mixes[0].itemCount, 2);
  assert.equal(result.mixes[0].imageUrl, "https://resources.tidal.com/pinned.jpg");
});

test("TIDAL profile mix client resolves pinned artist radio imports to playable playlists", async () => {
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/artists/747/relationships/radio") {
        return new Response(JSON.stringify({
          data: [{ id: "radio-747", type: "playlists" }]
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/radio-747") {
        return new Response(JSON.stringify({
          data: {
            id: "radio-747",
            type: "playlists",
            attributes: {
              name: "747",
              description: "Artist Radio",
              playlistType: "MIX"
            },
            relationships: {
              coverArt: { data: [] },
              items: { data: [{ id: "track1", type: "tracks" }] }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getPinnedMixes([{
    key: "artist-radio:747",
    kind: "artist-radio",
    id: "747",
    sourceUrl: "https://tidal.com/browse/artist/747/radio"
  }]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.mixes.length, 1);
  assert.equal(result.mixes[0].id, "radio-747");
  assert.equal(result.mixes[0].title, "747");
  assert.equal(result.mixes[0].subtitle, "Artist Radio");
  assert.equal(result.mixes[0].category, "Artist Radio");
  assert.equal(result.mixes[0].pinnedKey, "artist-radio:747");
});

test("TIDAL profile mix client refreshes artist radio and filters queued repeats", async () => {
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    locale: "en_US",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/artists/747/relationships/radio") {
        return new Response(JSON.stringify({
          data: [{ id: "radio-747", type: "playlists" }]
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/radio-747") {
        return new Response(JSON.stringify({
          data: {
            id: "radio-747",
            type: "playlists",
            attributes: {
              name: "747",
              description: "Artist Radio",
              playlistType: "MIX"
            },
            relationships: {
              coverArt: { data: [] },
              items: {
                data: [
                  { id: "track1", type: "tracks" },
                  { id: "track2", type: "tracks" },
                  { id: "track3", type: "tracks" }
                ]
              }
            }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/radio-747/relationships/items") {
        return new Response(JSON.stringify({
          data: [
            { id: "track1", type: "tracks" },
            { id: "track2", type: "tracks" },
            { id: "track3", type: "tracks" }
          ],
          included: [
            {
              id: "track1",
              type: "tracks",
              attributes: { title: "Queued One", duration: "PT5M" },
              relationships: {
                artists: { data: [{ id: "artist1", type: "artists" }] },
                albums: { data: [{ id: "album1", type: "albums" }] }
              }
            },
            {
              id: "track2",
              type: "tracks",
              attributes: { title: "Fresh Two", duration: "PT6M" },
              relationships: {
                artists: { data: [{ id: "artist2", type: "artists" }] },
                albums: { data: [{ id: "album2", type: "albums" }] }
              }
            },
            {
              id: "track3",
              type: "tracks",
              attributes: { title: "Fresh Three", duration: "PT7M" },
              relationships: {
                artists: { data: [{ id: "artist3", type: "artists" }] },
                albums: { data: [{ id: "album3", type: "albums" }] }
              }
            },
            { id: "artist1", type: "artists", attributes: { name: "Queued Artist" } },
            { id: "artist2", type: "artists", attributes: { name: "Fresh Artist" } },
            { id: "artist3", type: "artists", attributes: { name: "Another Artist" } },
            { id: "album1", type: "albums", attributes: { title: "Queued Album", releaseDate: "2026-01-01" } },
            { id: "album2", type: "albums", attributes: { title: "Fresh Album", releaseDate: "2026-02-01" } },
            { id: "album3", type: "albums", attributes: { title: "Fresh Album 3", releaseDate: "2026-03-01" } }
          ]
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getFreshArtistRadioTracks("747", {
    limit: 2,
    excludeTracks: [{ artist: "Queued Artist", title: "Queued One" }]
  });

  assert.equal(result.freshArtistRadio, true);
  assert.equal(result.mix.title, "747");
  assert.equal(result.requested, 2);
  assert.equal(result.fetchedCount, 3);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.count, 2);
  assert.deepEqual(result.tracks.map((track) => `${track.artist} - ${track.title}`), [
    "Fresh Artist - Fresh Two",
    "Another Artist - Fresh Three"
  ]);
});

test("TIDAL profile mix client creates queue playlist from TIDAL track ids", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    clock: () => Date.UTC(2026, 5, 20, 12, 0, 0),
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists" && options.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            id: "queue-playlist",
            type: "playlists",
            attributes: {
              name: "Rabbit Hole Queue",
              externalLinks: [{ href: "https://listen.tidal.com/playlist/queue-playlist" }]
            }
          }
        }), { status: 201, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/queue-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.createQueuePlaylist([
    { title: "One", artist: "Artist", tidal: { id: "track-1" } },
    { title: "Duplicate", artist: "Artist", tidal: { id: "track-1" } },
    { title: "Two", artist: "Artist", tidalUrl: "https://tidal.com/browse/track/track-2" },
    { title: "Missing", artist: "Artist" }
  ], {
    title: "Rabbit Hole Queue"
  });

  assert.equal(result.playlist.id, "queue-playlist");
  assert.equal(result.addedCount, 2);
  assert.equal(result.addableCount, 2);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(result.trackIds, ["track-1", "track-2"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, "Bearer profile-token");
  assert.equal(calls[0].headers["content-type"], "application/vnd.api+json");
  assert.equal(calls[0].body.data.attributes.name, "Rabbit Hole Queue");
  assert.deepEqual(calls[1].body.data, [
    { id: "track-1", type: "tracks" },
    { id: "track-2", type: "tracks" }
  ]);
});

test("TIDAL profile mix client creates an empty playlist and clears playlist cache", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists" && options.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            id: "new-playlist",
            type: "playlists",
            attributes: {
              name: "Fresh Finds",
              description: "Created from Rabbit Hole.",
              externalLinks: [{ href: "https://listen.tidal.com/playlist/new-playlist" }]
            }
          }
        }), { status: 201, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });
  client.playlistCache = {
    result: { playlists: [{ id: "old-playlist", title: "Old Playlist" }] },
    fetchedAtMs: Date.now()
  };

  const result = await client.createPlaylist({
    title: "Fresh Finds",
    description: "Created from Rabbit Hole."
  });

  assert.equal(result.id, "new-playlist");
  assert.equal(result.title, "Fresh Finds");
  assert.equal(result.description, "Created from Rabbit Hole.");
  assert.equal(result.url, "https://listen.tidal.com/playlist/new-playlist");
  assert.equal(client.playlistCache, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer profile-token");
  assert.equal(calls[0].headers["content-type"], "application/vnd.api+json");
  assert.equal(calls[0].body.data.attributes.name, "Fresh Finds");
  assert.equal(calls[0].body.data.attributes.description, "Created from Rabbit Hole.");
});

test("TIDAL profile mix client lists user playlists with titles", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || "GET" });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists" && parsed.searchParams.get("filter[owners.id]") === "me") {
        return new Response(JSON.stringify({
          data: [
            {
              id: "playlist-b",
              type: "playlists",
              attributes: {
                name: "B Title",
                numberOfItems: 4
              }
            },
            {
              id: "playlist-a",
              type: "playlists",
              attributes: {
                name: "A Title",
                numberOfItems: 1,
                externalLinks: [{ href: "https://listen.tidal.com/playlist/playlist-a" }]
              }
            }
          ],
          links: { next: "" }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists" && parsed.searchParams.get("filter[collaborators.id]") === "me") {
        return new Response(JSON.stringify({
          data: []
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getUserPlaylists({ force: true });

  assert.equal(result.connected, true);
  assert.deepEqual(result.playlists.map((playlist) => playlist.title), ["A Title", "B Title"]);
  assert.equal(result.playlists[0].itemCount, 1);
  assert.equal(result.playlists[0].url, "https://listen.tidal.com/playlist/playlist-a");
  assert.ok(calls.some((call) => call.url.includes("/v2/playlists") && call.url.includes("filter%5Bowners.id%5D=me")));
  assert.ok(calls.some((call) => call.url.includes("/v2/playlists") && call.url.includes("filter%5Bcollaborators.id%5D=me")));
  assert.ok(calls.every((call) => !call.url.includes("/v2/users/me")));
});

test("TIDAL profile mix client falls back to legacy playlist relationships when playlist filters fail", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || "GET" });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists") {
        return new Response(JSON.stringify({ errors: [{ detail: "bad filter" }] }), {
          status: 400,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      if (parsed.pathname === "/v2/users/me") {
        return new Response(JSON.stringify({
          data: {
            id: "current-user",
            type: "users"
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/userCollections/current-user/relationships/playlists") {
        return new Response(JSON.stringify({
          data: [
            { id: "playlist-a", type: "playlists" }
          ]
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/playlist-a") {
        return new Response(JSON.stringify({
          data: {
            id: "playlist-a",
            type: "playlists",
            attributes: { name: "A Title" },
            relationships: { items: { data: [{ id: "track-1", type: "tracks" }] } }
          }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.getUserPlaylists({ force: true });

  assert.equal(result.connected, true);
  assert.deepEqual(result.playlists.map((playlist) => playlist.title), ["A Title"]);
  assert.equal(result.playlists[0].itemCount, 1);
  assert.ok(calls.some((call) => call.url.includes("/v2/playlists") && call.url.includes("filter%5Bowners.id%5D=me")));
  assert.ok(calls.some((call) => call.url.includes("/v2/userCollections/current-user/relationships/playlists")));
  assert.ok(calls.some((call) => call.url.includes("/v2/playlists/playlist-a")));
});

test("TIDAL profile mix client adds one track to an existing playlist", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify({
          data: [],
          included: []
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist"
  });

  assert.equal(result.addedCount, 1);
  assert.equal(result.playlist.title, "Target Playlist");
  assert.deepEqual(result.trackIds, ["current-track"]);
  assert.equal(result.duplicate, false);
  const postCall = calls.find((call) => call.method === "POST");
  assert.deepEqual(postCall.body.data, [{ id: "current-track", type: "tracks" }]);
});

test("TIDAL playlist write verification reports accepted-but-missing track", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify({ data: [], included: [] }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Missing After Write",
    artist: "Current Artist",
    id: "current-track"
  }, {
    playlistTitle: "Target Playlist",
    forceDuplicateCheck: true,
    verifyAfterWrite: true
  });

  assert.equal(result.added, false);
  assert.equal(result.addedCount, 0);
  assert.equal(result.writeVerificationFailed, true);
  assert.equal(result.writeVerification.verified, false);
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("TIDAL profile mix client detects duplicate playlist track before adding", async () => {
  const calls = [];
  const playlistItemsPayload = {
    data: [{ id: "current-track", type: "tracks" }],
    included: [
      {
        id: "current-track",
        type: "tracks",
        attributes: {
          title: "Current One",
          duration: "PT6M10S"
        },
        relationships: {
          artists: { data: [{ id: "artist-1", type: "artists" }] },
          albums: { data: [{ id: "album-1", type: "albums" }] }
        }
      },
      {
        id: "artist-1",
        type: "artists",
        attributes: { name: "Current Artist" }
      },
      {
        id: "album-1",
        type: "albums",
        attributes: { title: "Current Album", releaseDate: "2026-01-01" }
      }
    ]
  };
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify(playlistItemsPayload), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const duplicate = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist"
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.addedCount, 0);
  assert.equal(calls.some((call) => call.method === "POST"), false);
  const getCountBeforeOverride = calls.filter((call) => call.method === "GET").length;

  const added = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist",
    allowDuplicate: true
  });

  assert.equal(added.duplicate, false);
  assert.equal(added.added, true);
  assert.equal(added.addedCount, 1);
  assert.equal(calls.filter((call) => call.method === "GET").length, getCountBeforeOverride);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("TIDAL playlist duplicate check allows alternate versions with different track ids", async () => {
  const calls = [];
  const playlistItemsPayload = {
    data: [{ id: "current-track", type: "tracks" }],
    included: [
      {
        id: "current-track",
        type: "tracks",
        attributes: {
          title: "Current One",
          duration: "PT4M10S"
        },
        relationships: {
          artists: { data: [{ id: "artist-1", type: "artists" }] },
          albums: { data: [{ id: "album-1", type: "albums" }] }
        }
      },
      {
        id: "artist-1",
        type: "artists",
        attributes: { name: "Current Artist" }
      },
      {
        id: "album-1",
        type: "albums",
        attributes: { title: "Current Album", releaseDate: "2026-01-01" }
      }
    ]
  };
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify(playlistItemsPayload), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One (Extended Mix)",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track-extended"
  }, {
    playlistTitle: "Target Playlist"
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.added, true);
  assert.equal(result.addedCount, 1);
  const postCall = calls.find((call) => call.method === "POST");
  assert.deepEqual(postCall.body.data, [{ id: "current-track-extended", type: "tracks" }]);
});

test("TIDAL playlist duplicate check uses cached track ids after first access", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify({
          data: [],
          included: []
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const first = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist"
  });

  assert.equal(first.added, true);
  assert.equal(calls.filter((call) => call.method === "GET").length, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);

  const duplicate = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist"
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.duplicateCheck.source, "cache");
  assert.equal(duplicate.duplicateCheck.identityType, "provider");
  assert.equal(calls.filter((call) => call.method === "GET").length, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("TIDAL playlist duplicate cache falls back to ISRC when provider id is unavailable", async () => {
  const playlistItemsPayload = {
    data: [{ id: "existing-track", type: "tracks" }],
    included: [
      {
        id: "existing-track",
        type: "tracks",
        attributes: {
          title: "Current One",
          isrc: "USABC2400001",
          duration: "PT6M10S"
        },
        relationships: {
          artists: { data: [{ id: "artist-1", type: "artists" }] }
        }
      },
      {
        id: "artist-1",
        type: "artists",
        attributes: { name: "Current Artist" }
      }
    ]
  };
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify(playlistItemsPayload), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const duplicate = await client.playlistTrackDuplicate("target-playlist", {
    title: "Whatever Title",
    artist: "Different Artist",
    isrc: "USABC2400001"
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.source, "fresh-cache");
  assert.equal(duplicate.identityType, "isrc");
});

test("TIDAL playlist duplicate cache uses exact artist title only as last resort", async () => {
  const playlistItemsPayload = {
    data: [{ id: "existing-track", type: "tracks" }],
    included: [
      {
        id: "existing-track",
        type: "tracks",
        attributes: {
          title: "Current One",
          duration: "PT6M10S"
        },
        relationships: {
          artists: { data: [{ id: "artist-1", type: "artists" }] }
        }
      },
      {
        id: "artist-1",
        type: "artists",
        attributes: { name: "Current Artist" }
      }
    ]
  };
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify(playlistItemsPayload), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  await client.fetchPlaylistTrackCache("target-playlist");
  const cached = client.playlistTrackCache.get("target-playlist");
  cached.providerIds.clear();
  cached.isrcs.clear();

  const duplicate = await client.playlistTrackDuplicate("target-playlist", {
    title: "Current One",
    artist: "Current Artist"
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.source, "cache");
  assert.equal(duplicate.identityType, "text");
});

test("TIDAL playlist duplicate cache persists across client restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tidal-playlist-cache-"));
  const cacheFile = path.join(dir, "playlist-cache.json");
  const firstClient = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    playlistTrackCacheFile: cacheFile,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  await firstClient.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist",
    allowDuplicate: true
  });

  const calls = [];
  const secondClient = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    playlistTrackCacheFile: cacheFile,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || "GET" });
      return new Response("{}", { status: 500 });
    }
  });

  const duplicate = await secondClient.playlistTrackDuplicate("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.source, "cache");
  assert.equal(duplicate.identityType, "provider");
  assert.equal(calls.length, 0);
});

test("TIDAL playlist delete uses profile write API and clears local playlist caches", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/delete-me" && options.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });
  client.playlistCache = { playlists: [{ id: "delete-me", title: "Old One" }] };
  client.playlistTrackCache.set("delete-me", { playlistId: "delete-me" });

  const result = await client.deletePlaylist("delete-me", { title: "Old One" });

  assert.equal(result.deleted, true);
  assert.equal(result.playlist.id, "delete-me");
  assert.equal(client.playlistCache, null);
  assert.equal(client.playlistTrackCache.has("delete-me"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "DELETE");
  assert.doesNotMatch(calls[0].url, /countryCode=US/);
});

test("TIDAL playlist delete falls back to removing playlist from user collection on 403", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write collection.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      calls.push({
        path: parsed.pathname,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      if (parsed.pathname === "/v2/playlists/remove-me" && options.method === "DELETE") {
        return new Response(JSON.stringify({ errors: [{ detail: "You do not have permission to modify this resource" }] }), {
          status: 403,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      if (parsed.pathname === "/v2/users/me") {
        return new Response(JSON.stringify({
          data: { id: "current-user", type: "users" }
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      if (parsed.pathname === "/v2/userCollectionPlaylists/me/relationships/items" && options.method === "DELETE") {
        return new Response(JSON.stringify({ meta: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      return new Response("{}", { status: 404 });
    }
  });
  client.playlistCache = { playlists: [{ id: "remove-me", title: "Old One" }] };
  client.playlistTrackCache.set("remove-me", { playlistId: "remove-me" });

  const result = await client.deletePlaylist("remove-me", { title: "Old One" });

  assert.equal(result.deleted, true);
  assert.equal(result.fullDelete, false);
  assert.equal(result.removedFromCollection, true);
  assert.equal(client.playlistCache, null);
  assert.equal(client.playlistTrackCache.has("remove-me"), false);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "DELETE /v2/playlists/remove-me",
    "GET /v2/users/me",
    "DELETE /v2/userCollectionPlaylists/me/relationships/items"
  ]);
  assert.deepEqual(calls[2].body, {
    data: [{ id: "remove-me", type: "playlists" }]
  });
});

test("TIDAL playlist delete asks for reconnect when collection write scope is missing", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, method: options.method || "GET" });
      if (parsed.pathname === "/v2/playlists/remove-me" && options.method === "DELETE") {
        return new Response(JSON.stringify({ errors: [{ detail: "You do not have permission to modify this resource" }] }), {
          status: 403,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      return new Response("{}", { status: 404 });
    }
  });

  await assert.rejects(
    () => client.deletePlaylist("remove-me"),
    /collection\.write.*Reconnect TIDAL/i
  );
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "DELETE /v2/playlists/remove-me"
  ]);
});

test("TIDAL playlist duplicate checks coalesce concurrent playlist fetches", async () => {
  let getCalls = 0;
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        getCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({
          data: [],
          included: []
        }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const [first, second] = await Promise.all([
    client.playlistTrackDuplicate("target-playlist", {
      title: "First",
      artist: "Current Artist",
      tidal: { id: "first-track" }
    }),
    client.playlistTrackDuplicate("target-playlist", {
      title: "Second",
      artist: "Current Artist",
      tidal: { id: "second-track" }
    })
  ]);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(getCalls, 1);
});

test("TIDAL playlist duplicate check uses stale cache during rate limits", async () => {
  let now = 1_000;
  let getCalls = 0;
  const playlistItemsPayload = {
    data: [{ id: "existing-track", type: "tracks" }],
    included: [
      {
        id: "existing-track",
        type: "tracks",
        attributes: {
          title: "Existing One",
          duration: "PT6M10S"
        },
        relationships: {
          artists: { data: [{ id: "artist-1", type: "artists" }] }
        }
      },
      {
        id: "artist-1",
        type: "artists",
        attributes: { name: "Existing Artist" }
      }
    ]
  };
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    playlistTrackCacheMs: 1000,
    clock: () => now,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        getCalls += 1;
        if (getCalls === 1) {
          return new Response(JSON.stringify(playlistItemsPayload), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
        }
        return new Response(JSON.stringify({ errors: [{ detail: "Too many requests" }] }), {
          status: 429,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      return new Response("{}", { status: 404 });
    }
  });

  await client.fetchPlaylistTrackCache("target-playlist");
  now += 2_000;

  const miss = await client.playlistTrackDuplicate("target-playlist", {
    title: "New One",
    artist: "New Artist",
    tidal: { id: "new-track" }
  });

  assert.equal(miss.duplicate, false);
  assert.equal(miss.source, "stale-cache");
  assert.equal(miss.stale, true);
  assert.equal(miss.rateLimited, true);
  assert.match(miss.warning, /429/);
  assert.equal(getCalls, 2);

  const duplicate = await client.playlistTrackDuplicate("target-playlist", {
    title: "Existing One",
    artist: "Existing Artist",
    tidal: { id: "existing-track" }
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.source, "stale-cache");
  assert.equal(duplicate.rateLimited, true);
  assert.equal(duplicate.identityType, "provider");
  assert.equal(getCalls, 2);
});

test("TIDAL playlist duplicate check rate limit does not add without confirmation", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify({ errors: [{ detail: "Too many requests" }] }), {
          status: 429,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist"
  });

  assert.equal(result.added, false);
  assert.equal(result.duplicateCheckUnavailable, true);
  assert.match(result.duplicateCheckError, /429/);
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("TIDAL playlist duplicate check rate limit does not open profile mixes circuit", async () => {
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    failureThreshold: 1,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify({ errors: [{ detail: "Too many requests" }] }), {
          status: 429,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist"
  });

  assert.equal(result.added, false);
  assert.equal(result.duplicateCheckUnavailable, true);
  assert.equal(client.status().circuit.state, "closed");
});

test("TIDAL profile mixes circuit does not block playlist duplicate override writes", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    failureThreshold: 1,
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.hostname === "profile-fail.test") {
        return new Response(JSON.stringify({ errors: [{ detail: "temporary profile failure" }] }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  await assert.rejects(
    () => client.fetchJson("https://profile-fail.test/profile"),
    /HTTP 500/
  );
  assert.equal(client.status().circuit.state, "open");

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist",
    allowDuplicate: true
  });

  assert.equal(result.added, true);
  assert.equal(result.addedCount, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("TIDAL playlist duplicate override skips duplicate check", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && (options.method || "GET") === "GET") {
        return new Response(JSON.stringify({ errors: [{ detail: "Too many requests" }] }), {
          status: 429,
          headers: { "content-type": "application/vnd.api+json" }
        });
      }
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist",
    allowDuplicate: true
  });

  assert.equal(result.added, true);
  assert.equal(result.addedCount, 1);
  assert.equal(calls.filter((call) => call.method === "GET").length, 0);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("TIDAL playlist duplicate override seeds playlist track cache after add", async () => {
  const calls = [];
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read playlists.write",
    tokenFile: tempTokenFile(),
    countryCode: "US",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null
      });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/playlists/target-playlist/relationships/items" && options.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }
  });

  const result = await client.addTrackToPlaylist("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  }, {
    playlistTitle: "Target Playlist",
    allowDuplicate: true
  });

  assert.equal(result.added, true);
  assert.equal(calls.filter((call) => call.method === "GET").length, 0);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);

  const duplicate = await client.playlistTrackDuplicate("target-playlist", {
    title: "Current One",
    artist: "Current Artist",
    tidalUrl: "https://tidal.com/browse/track/current-track"
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.source, "cache");
  assert.equal(duplicate.identityType, "provider");
  assert.equal(calls.filter((call) => call.method === "GET").length, 0);
});

test("TIDAL profile mix client requires playlists.write for queue playlist creation", async () => {
  const client = new TidalProfileMixes({
    accessToken: "profile-token",
    scopes: "user.read playlists.read",
    tokenFile: tempTokenFile(),
    fetchImpl: async () => new Response("{}", { status: 500 })
  });

  await assert.rejects(
    () => client.createQueuePlaylist([{ title: "One", artist: "Artist", tidal: { id: "track-1" } }]),
    /playlists\.write/
  );
});
