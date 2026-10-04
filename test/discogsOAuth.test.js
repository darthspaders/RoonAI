"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DiscogsClient } = require("../src/discogsClient");
const { DiscogsOAuth, DiscogsOAuthTokenStore } = require("../src/discogsOAuth");

function tempTokenFile() {
  return path.join(os.tmpdir(), `rabbit-hole-discogs-oauth-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return body; }
  };
}

test("Discogs OAuth completes request-token, browser authorization, and access-token exchange", async () => {
  const calls = [];
  const tokenFile = tempTokenFile();
  const oauth = new DiscogsOAuth({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    tokenFile,
    redirectUri: "http://127.0.0.1:3777/api/discogs/oauth/callback",
    minIntervalMs: 0,
    clock: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/oauth/request_token")) {
        return response("oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true");
      }
      return response("oauth_token=access-token&oauth_token_secret=access-secret&username=spade");
    }
  });

  const authorizeUrl = await oauth.createAuthorizationUrl({
    redirectUri: "http://localhost:3777/api/discogs/oauth/callback"
  });
  assert.equal(new URL(authorizeUrl).searchParams.get("oauth_token"), "request-token");
  assert.match(calls[0].options.headers.authorization, /oauth_callback="http%3A%2F%2Flocalhost%3A3777%2Fapi%2Fdiscogs%2Foauth%2Fcallback"/);
  assert.match(calls[0].options.headers.authorization, /oauth_signature_method="PLAINTEXT"/);

  const token = await oauth.exchangeAuthorizationCode({
    oauthToken: "request-token",
    verifier: "verifier"
  });
  assert.equal(token.accessToken, "access-token");
  assert.equal(token.username, "spade");
  assert.equal(oauth.status().configured, true);
  assert.equal(oauth.status().pendingAuthorization, false);
  assert.match(calls[1].options.headers.authorization, /oauth_token="request-token"/);
  assert.match(calls[1].options.headers.authorization, /oauth_verifier="verifier"/);

  const stored = new DiscogsOAuthTokenStore(tokenFile).read();
  assert.equal(stored.accessToken, "access-token");
  assert.equal(stored.accessTokenSecret, "access-secret");
  assert.equal(stored.oauthState, undefined);
});

test("Discogs client uses OAuth authorization after browser connection", async () => {
  const tokenFile = tempTokenFile();
  const oauth = new DiscogsOAuth({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    tokenFile,
    accessToken: "access-token",
    accessTokenSecret: "access-secret",
    clock: () => 1_700_000_000_000
  });
  const calls = [];
  const client = new DiscogsClient({
    oauth,
    cacheFile: "",
    minIntervalMs: 0,
    maxReleaseLookups: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/database/search")) return {
        ok: true,
        status: 200,
        async json() { return { results: [{ id: 101 }] }; }
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 101,
            title: "Dream On",
            artists: [{ name: "D-Nox" }],
            tracklist: [{ position: "1", title: "Dream On", artists: [{ name: "D-Nox" }] }]
          };
        }
      };
    }
  });

  assert.equal(client.isConfigured(), true);
  const result = await client.findTrack({ artist: "D-Nox", title: "Dream On" });
  assert.equal(result.discogsId, "101");
  assert.match(calls[0].options.headers.authorization, /^OAuth /);
  assert.match(calls[0].options.headers.authorization, /oauth_token="access-token"/);
});

test("Discogs OAuth fails closed without consumer credentials", async () => {
  let called = false;
  const oauth = new DiscogsOAuth({
    fetchImpl: async () => {
      called = true;
      return response("");
    }
  });
  await assert.rejects(() => oauth.createAuthorizationUrl(), /DISCOGS_CONSUMER_KEY/);
  assert.equal(called, false);
});
