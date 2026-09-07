"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BeatportClient,
  BeatportTokenStore,
  beatportTrackIdFromUrl,
  extractBeatportTracks,
  parseRetryAfterMs,
  normalizeBeatportToken,
  normalizeBeatportTrack
} = require("../src/beatportClient");

function tempTokenFile() {
  return path.join(os.tmpdir(), `rabbit-hole-beatport-token-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function jsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const lower = String(name).toLowerCase();
        const found = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
        return found ? found[1] : null;
      },
      forEach(callback) {
        for (const [key, value] of Object.entries(headers)) callback(value, key);
      }
    },
    json: async () => payload
  };
}

test("Beatport client stays inactive until enabled with an access token", () => {
  assert.equal(new BeatportClient({ enabled: true, tokenFile: tempTokenFile() }).isConfigured(), false);
  assert.equal(new BeatportClient({ accessToken: "token", tokenFile: tempTokenFile() }).isConfigured(), false);
  assert.equal(new BeatportClient({ enabled: true, accessToken: "token", tokenFile: tempTokenFile() }).isConfigured(), true);
});

test("Beatport token store normalizes pasted OAuth JSON", () => {
  const file = tempTokenFile();
  const store = new BeatportTokenStore(file);
  const saved = store.save({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "read"
  });

  assert.equal(saved.accessToken, "access-token");
  assert.equal(saved.refreshToken, "refresh-token");
  assert.equal(saved.tokenType, "Bearer");
  assert.equal(saved.scope, "read");
  assert.ok(saved.expiresAtMs > Date.now());
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).accessToken, "access-token");
});

test("Beatport client does not persist static access tokens into the token file", () => {
  const file = tempTokenFile();
  const store = new BeatportTokenStore(file);
  store.save({ access_token: "saved-access", refresh_token: "saved-refresh" });

  const client = new BeatportClient({
    enabled: true,
    accessToken: "static-access",
    tokenFile: file
  });

  assert.equal(client.isConfigured(), true);
  assert.equal(store.read().accessToken, "saved-access");
  assert.equal(store.read().refreshToken, "saved-refresh");
});


test("Beatport token normalization preserves refresh token when refreshing access token", () => {
  const normalized = normalizeBeatportToken(
    { access_token: "new-access", expires_in: 3600 },
    { accessToken: "old-access", refreshToken: "saved-refresh" },
    1000
  );

  assert.equal(normalized.accessToken, "new-access");
  assert.equal(normalized.refreshToken, "saved-refresh");
  assert.equal(normalized.expiresAtMs, 3601000);
});

test("Beatport retry-after parser accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("2", 1000), 2000);
  assert.equal(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1000), 2000);
  assert.equal(parseRetryAfterMs("", 1000), 0);
});

test("Beatport token command accepts a raw bearer JWT", async () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  const tokenFile = tempTokenFile();
  const inputFile = tempTokenFile();
  const payload = Buffer.from(JSON.stringify({ exp: 1788807213, scope: "app:docs user:dj" })).toString("base64url");
  const bearer = `Bearer header.${payload}.signature_with_underscore`.replace(/_/g, "\\_");
  fs.writeFileSync(inputFile, bearer);

  await execFileAsync(process.execPath, ["scripts/save-beatport-token.js", inputFile], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      BEATPORT_TOKEN_FILE: tokenFile
    }
  });

  const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  assert.equal(saved.accessToken, `header.${payload}.signature_with_underscore`);
  assert.equal(saved.tokenType, "Bearer");
  assert.equal(saved.scope, "app:docs user:dj");
  assert.equal(saved.expiresAtMs, 1788807213000);
});

test("Beatport token command accepts copied JSON fragments with escaped underscores", async () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  const tokenFile = tempTokenFile();
  const inputFile = tempTokenFile();
  fs.writeFileSync(inputFile, `"access\\_token":"access-token","expires\\_in":600,"token\\_type":"Bearer","scope":"app:docs user:dj","refresh\\_token":"refresh-token"}`);

  await execFileAsync(process.execPath, ["scripts/save-beatport-token.js", inputFile], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      BEATPORT_TOKEN_FILE: tokenFile
    }
  });

  const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  assert.equal(saved.accessToken, "access-token");
  assert.equal(saved.refreshToken, "refresh-token");
  assert.equal(saved.tokenType, "Bearer");
  assert.equal(saved.scope, "app:docs user:dj");
  assert.ok(saved.expiresAtMs > Date.now());
});

test("Beatport track normalization keeps EDM metadata fields", () => {
  const normalized = normalizeBeatportTrack({
    id: 123,
    name: "City Lights",
    mix_name: "HAFT Remix",
    artists: [{ name: "D-SHIFT" }, { name: "Drunken Kong" }],
    remixers: [{ name: "HAFT" }],
    release: {
      name: "City Lights",
      label: { name: "Tronic" },
      publish_date: "2026-01-16"
    },
    genre: { name: "Techno" },
    sub_genre: { name: "Peak Time / Driving" },
    bpm: 132,
    key: { name: "A Minor", camelot: "8A" },
    length_ms: 421000,
    isrc: "GBKQU2599999",
    slug: "city-lights-haft-remix"
  });

  assert.equal(normalized.title, "City Lights");
  assert.equal(normalized.mixName, "HAFT Remix");
  assert.equal(normalized.artist, "D-SHIFT, Drunken Kong");
  assert.equal(normalized.label, "Tronic");
  assert.equal(normalized.genre, "Techno");
  assert.equal(normalized.subGenre, "Peak Time / Driving");
  assert.deepEqual(normalized.beatportTags, ["Techno", "Peak Time / Driving"]);
  assert.equal(normalized.bpm, 132);
  assert.equal(normalized.keyName, "A Minor");
  assert.equal(normalized.camelot, "8A");
  assert.equal(normalized.durationMs, 421000);
  assert.equal(normalized.isrc, "GBKQU2599999");
  assert.match(normalized.beatportUrl, /beatport\.com\/track\/city-lights-haft-remix\/123/);
});

test("Beatport track id can be extracted from an ISRC store URL", () => {
  assert.equal(beatportTrackIdFromUrl("https://www.beatport.com/track/solar-extended-mix/23107095/"), "23107095");
  assert.equal(beatportTrackIdFromUrl("https://www.beatport.com/release/solar/3250657"), "");
});

test("Beatport track extraction accepts common catalog response shapes", () => {
  assert.deepEqual(extractBeatportTracks({ tracks: { data: [{ id: 1 }] } }), [{ id: 1 }]);
  assert.deepEqual(extractBeatportTracks({ results: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(extractBeatportTracks({ data: [{ id: 3 }] }), [{ id: 3 }]);
});

test("Beatport search sends bearer auth and normalizes the first track", async () => {
  const requests = [];
  const client = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tracks: {
            data: [{
              id: 77,
              name: "Solar",
              artists: [{ name: "Ezequiel Arias" }],
              genre: { name: "Melodic House & Techno" },
              sub_genre: { name: "Progressive House" }
            }]
          }
        })
      };
    },
    logger: null
  });

  const result = await client.findTrack({ artist: "Ezequiel Arias", title: "Solar" });

  assert.equal(result.id, "77");
  assert.equal(result.artist, "Ezequiel Arias");
  assert.equal(result.subGenre, "Progressive House");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/catalog\/search\/\?/);
  assert.match(requests[0].url, /type=tracks/);
  assert.equal(requests[0].options.headers.authorization, "Bearer abc123");
});

test("Beatport requests are throttled through one client limiter", async () => {
  let now = 1000;
  const sleeps = [];
  const requests = [];
  const client = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    requestsPerSecond: 2,
    now: () => now,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetchImpl: async (url) => {
      requests.push({ url, at: now });
      return jsonResponse(200, { results: [{ id: requests.length, name: "Solar", artists: [{ name: "Ezequiel Arias" }] }] });
    },
    logger: null
  });

  await client.requestJson("/catalog/search/", { q: "one", type: "tracks" });
  await client.requestJson("/catalog/search/", { q: "two", type: "tracks" });

  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [500]);
  assert.equal(requests[1].at - requests[0].at, 500);
  assert.equal(client.status().throttle.minSpacingMs, 500);
});

test("Beatport successful GET responses are cached by URL", async () => {
  const requests = [];
  const client = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    fetchImpl: async (url) => {
      requests.push(url);
      return jsonResponse(200, { results: [{ id: 77, name: "Solar" }] });
    },
    logger: null
  });

  const first = await client.requestJson("/catalog/search/", { q: "Solar", type: "tracks" });
  const second = await client.requestJson("/catalog/search/", { q: "Solar", type: "tracks" });

  assert.deepEqual(second, first);
  assert.equal(requests.length, 1);
  assert.equal(client.diagnostics().cacheHits, 1);
  assert.equal(client.diagnostics().cacheEntries, 1);
});

test("Beatport 429 honors Retry-After and records rate-limit diagnostics", async () => {
  let now = 1000;
  const sleeps = [];
  const responses = [
    jsonResponse(429, { detail: "slow down" }, { "Retry-After": "2", "X-RateLimit-Limit": "120" }),
    jsonResponse(200, { results: [{ id: 91, name: "Recovered" }] })
  ];
  const client = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    maxRetries: 2,
    now: () => now,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetchImpl: async () => responses.shift(),
    logger: null
  });

  const result = await client.requestJson("/catalog/search/", { q: "Recovered", type: "tracks" });

  assert.equal(result.results[0].id, 91);
  assert.ok(sleeps.includes(2000));
  assert.equal(client.diagnostics().status429Count, 1);
  assert.deepEqual(client.diagnostics().retryAfterValues, ["2"]);
  assert.equal(client.diagnostics().rateLimitHeaders["X-RateLimit-Limit"], "120");
});

test("Beatport 429 without Retry-After uses exponential backoff", async () => {
  let now = 1000;
  const sleeps = [];
  const responses = [
    jsonResponse(429, { detail: "slow down" }),
    jsonResponse(429, { detail: "still slow" }),
    jsonResponse(200, { results: [{ id: 92, name: "Recovered" }] })
  ];
  const client = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    maxRetries: 2,
    now: () => now,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetchImpl: async () => responses.shift(),
    logger: null
  });

  const result = await client.requestJson("/catalog/search/", { q: "Recovered", type: "tracks" });

  assert.equal(result.results[0].id, 92);
  assert.ok(sleeps.includes(1000));
  assert.ok(sleeps.includes(2000));
  assert.equal(client.diagnostics().status429Count, 2);
});

test("Beatport 5xx retries are bounded and 404 is permanent", async () => {
  let attempts = 0;
  const retryingClient = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    maxRetries: 1,
    sleepFn: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(503, { detail: "busy" })
        : jsonResponse(200, { results: [{ id: 93, name: "Recovered" }] });
    },
    logger: null
  });
  assert.equal((await retryingClient.requestJson("/catalog/search/", { q: "Recovered", type: "tracks" })).results[0].id, 93);
  assert.equal(attempts, 2);

  attempts = 0;
  const permanentClient = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    maxRetries: 2,
    sleepFn: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse(404, { detail: "missing" });
    },
    logger: null
  });
  assert.equal(await permanentClient.requestJson("/catalog/tracks/404/"), null);
  assert.equal(attempts, 1);
});

test("Beatport exhausted 429 is surfaced for durable retry bookkeeping", async () => {
  const client = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    maxRetries: 0,
    sleepFn: async () => {},
    fetchImpl: async () => jsonResponse(429, { detail: "slow down" }, { "Retry-After": "3" }),
    logger: null
  });

  await assert.rejects(
    () => client.requestJson("/catalog/search/", { q: "Later", type: "tracks" }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 3000);
      return true;
    }
  );
});

test("Beatport ISRC lookup follows store URL to catalog track detail", async () => {
  const requests = [];
  const client = new BeatportClient({
    enabled: true,
    accessToken: "abc123",
    tokenFile: tempTokenFile(),
    fetchImpl: async (url) => {
      requests.push(url);
      if (String(url).includes("/catalog/tracks/store/GBEWA2100645/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ store_url: "https://www.beatport.com/track/solar-extended-mix/23107095/" })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 23107095,
          name: "Solar",
          mix_name: "Extended Mix",
          isrc: "GBEWA2100645",
          artists: [{ name: "Ezequiel Arias" }],
          genre: { name: "Melodic House & Techno" },
          key: { name: "Gb Major", camelot_number: 2, camelot_letter: "B" }
        })
      };
    },
    logger: null
  });

  const result = await client.findTrack({ artist: "Ezequiel Arias", title: "Solar", isrc: "GBEWA2100645" });

  assert.equal(result.id, "23107095");
  assert.equal(result.genre, "Melodic House & Techno");
  assert.equal(result.camelot, "2B");
  assert.equal(requests.length, 2);
  assert.match(requests[1], /\/catalog\/tracks\/23107095\//);
});


test("Beatport client refreshes expired token from token file before search", async () => {
  const file = tempTokenFile();
  const store = new BeatportTokenStore(file);
  store.save({
    access_token: "expired-access",
    refresh_token: "refresh-token",
    expiresAtMs: Date.now() - 1000
  });

  let now = 1000;
  const requests = [];
  const sleeps = [];
  const client = new BeatportClient({
    enabled: true,
    clientId: "client-id",
    tokenFile: file,
    requestsPerSecond: 2,
    now: () => now,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (String(url).includes("/auth/o/token/")) {
        return jsonResponse(200, { access_token: "fresh-access", expires_in: 3600 });
      }
      assert.equal(options.headers.authorization, "Bearer fresh-access");
      return jsonResponse(200, { results: [{ id: 88, name: "Damage", artists: [{ name: "Agustin Pietrocola" }] }] });
    },
    logger: null
  });

  const result = await client.findTrack({ artist: "Agustin Pietrocola", title: "Damage" });

  assert.equal(result.id, "88");
  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [500]);
  assert.match(String(requests[0].options.body), /grant_type=refresh_token/);
  assert.match(String(requests[0].options.body), /refresh_token=refresh-token/);
  assert.match(String(requests[0].options.body), /client_id=client-id/);
});
