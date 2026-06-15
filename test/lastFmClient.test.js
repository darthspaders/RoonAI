"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { LastFmClient, normalizeUsername, trackHistoryKey } = require("../src/lastFmClient");

test("Last.fm status distinguishes API key from username configuration", () => {
  const missingUsername = new LastFmClient({ apiKey: "key", username: "" });
  assert.deepEqual(missingUsername.status(), {
    enabled: true,
    apiKeyConfigured: true,
    usernameConfigured: false,
    usernameValid: false,
    configured: false
  });

  const configured = new LastFmClient({ apiKey: "key", username: "listener" });
  assert.equal(configured.status().configured, true);
  assert.equal(configured.status().usernameValid, true);
});

test("Last.fm recent tracks normalize into a scrobble history snapshot", async () => {
  const calls = [];
  const client = new LastFmClient({
    apiKey: "key",
    username: "listener",
    historyLimit: 10,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes("user.gettopartists")) {
        return {
          ok: true,
          json: async () => ({
            topartists: {
              artist: [
                {
                  name: "Jody Wisternoff",
                  playcount: "42",
                  "@attr": { rank: "1" }
                },
                {
                  name: "M.O.S.",
                  playcount: "24",
                  "@attr": { rank: "2" }
                }
              ]
            }
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          recenttracks: {
            track: [
              {
                artist: { "#text": "Jody Wisternoff" },
                name: "The Sky Below",
                album: { "#text": "Album" },
                date: { uts: "1760000000" }
              },
              {
                artist: { "#text": "Jody Wisternoff" },
                name: "The Sky Below",
                date: { uts: "1760000100" }
              },
              {
                artist: { "#text": "M.O.S." },
                name: "Favourite Colours",
                "@attr": { nowplaying: "true" }
              }
            ]
          }
        })
      };
    }
  });

  const snapshot = await client.historySnapshot();
  assert.equal(calls.length, 2);
  assert.equal(snapshot.checked, true);
  assert.equal(snapshot.returned, 3);
  assert.equal(snapshot.tracksByKey["jody wisternoff|the sky below"].plays, 2);
  assert.equal(snapshot.tracksByKey["m o s|favourite colours"].nowPlaying, true);
  assert.equal(snapshot.topArtistsReturned, 2);
  assert.equal(snapshot.topArtistsByKey["jody wisternoff"].rank, 1);
  assert.equal(snapshot.topArtistsByKey["m o s"].plays, 24);
});

test("Last.fm requests abort on timeout", async () => {
  const client = new LastFmClient({
    apiKey: "key",
    username: "listener",
    timeoutMs: 5,
    fetch: async (_url, options = {}) => new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
  });

  await assert.rejects(
    () => client.recentTracks({ limit: 1 }),
    /Last\.fm request timed out/
  );
});

test("track history keys normalize punctuation and case", () => {
  assert.equal(trackHistoryKey({ artist: "M.O.S.", title: "Favourite Colours" }), "m o s|favourite colours");
});

test("Last.fm usernames are normalized from profile URLs and rejected when token-shaped", async () => {
  assert.equal(normalizeUsername("https://www.last.fm/user/darthspaders"), "darthspaders");
  assert.equal(normalizeUsername("@darthspaders # local profile"), "darthspaders");

  const invalid = new LastFmClient({ apiKey: "key", username: "123456789012345678901234567890123" });
  const snapshot = await invalid.historySnapshot();
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.usernameValid, false);
  assert.match(snapshot.reason, /does not look like/i);
});
