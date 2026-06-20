"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { TidalProfileAuth, TidalProfileTokenStore } = require("../src/tidalProfileAuth");

function tempTokenFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tidal-profile-auth-"));
  return path.join(dir, "token.json");
}

test("TIDAL profile auth creates PKCE authorization URL and stores callback state", () => {
  const file = tempTokenFile();
  const auth = new TidalProfileAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:3777/api/tidal/oauth/callback",
    tokenFile: file
  });

  const url = new URL(auth.createAuthorizationUrl());
  assert.equal(url.origin + url.pathname, "https://login.tidal.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:3777/api/tidal/oauth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(url.searchParams.get("state"));

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.oauthState.state, url.searchParams.get("state"));
  assert.ok(saved.oauthState.codeVerifier);
});

test("TIDAL profile auth strips legacy scopes from normal OAuth requests", () => {
  const auth = new TidalProfileAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:3777/api/tidal/oauth/callback",
    scopes: "user.read playlists.read r_usr recommendations.read",
    tokenFile: tempTokenFile()
  });

  const url = new URL(auth.createAuthorizationUrl());
  assert.equal(url.searchParams.get("scope"), "user.read playlists.read recommendations.read");
  assert.equal(auth.status().scopes, "user.read playlists.read recommendations.read");
});

test("TIDAL profile auth can opt into legacy scopes for manual experiments", () => {
  const auth = new TidalProfileAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:3777/api/tidal/oauth/callback",
    scopes: "user.read r_usr",
    allowLegacyScope: true,
    tokenFile: tempTokenFile()
  });

  const url = new URL(auth.createAuthorizationUrl());
  assert.equal(url.searchParams.get("scope"), "user.read r_usr");
});

test("TIDAL profile auth exchanges callback code and stores refresh token", async () => {
  const file = tempTokenFile();
  const store = new TidalProfileTokenStore(file);
  store.saveOAuthState({ state: "expected-state", codeVerifier: "verifier" });
  const calls = [];
  const auth = new TidalProfileAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:3777/api/tidal/oauth/callback",
    store,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: String(options.body), headers: options.headers });
      return new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 14400,
        token_type: "Bearer",
        scope: "user.read playlists.read"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const token = await auth.exchangeAuthorizationCode({ code: "auth-code", state: "expected-state" });
  assert.equal(token.accessToken, "access-token");
  assert.equal(token.refreshToken, "refresh-token");
  assert.match(calls[0].body, /grant_type=authorization_code/);
  assert.match(calls[0].body, /code=auth-code/);
  assert.match(calls[0].body, /code_verifier=verifier/);

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.refreshToken, "refresh-token");
  assert.equal(saved.oauthState, undefined);
});

test("TIDAL profile auth refreshes expired stored access token", async () => {
  const file = tempTokenFile();
  const store = new TidalProfileTokenStore(file);
  store.save({
    accessToken: "old-access",
    refreshToken: "refresh-token",
    expiresAtMs: Date.now() - 1000
  });
  const calls = [];
  const auth = new TidalProfileAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    store,
    fetchImpl: async (url, options) => {
      calls.push(String(options.body));
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 14400
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const token = await auth.getAccessToken();
  assert.equal(token, "new-access");
  assert.match(calls[0], /grant_type=refresh_token/);
  assert.match(calls[0], /refresh_token=refresh-token/);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.accessToken, "new-access");
  assert.equal(saved.refreshToken, "new-refresh");
});
