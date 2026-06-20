"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  DEFAULT_TIDAL_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  positiveNumber
} = require("./tidalRequestGuard");

const TIDAL_AUTHORIZE_URL = "https://login.tidal.com/authorize";
const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const DEFAULT_SCOPES = "user.read playlists.read playlists.write recommendations.read collection.read search.read";
const REFRESH_SKEW_MS = 90_000;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripLegacyScopes(value = "") {
  return cleanText(value).split(/\s+/).filter((scope) => scope && scope !== "r_usr").join(" ");
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function redactToken(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  if (text.length <= 12) return "configured";
  return `${text.slice(0, 5)}...${text.slice(-5)}`;
}

class TidalProfileTokenStore {
  constructor(file = path.join(__dirname, "..", "data", "tidal-profile-token.json")) {
    this.file = file;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  save(token = {}) {
    const current = this.read();
    const now = Date.now();
    const expiresIn = Number(token.expires_in || token.expiresIn || 0);
    const next = {
      ...current,
      accessToken: cleanText(token.access_token || token.accessToken || current.accessToken),
      refreshToken: cleanText(token.refresh_token || token.refreshToken || current.refreshToken),
      tokenType: cleanText(token.token_type || token.tokenType || current.tokenType || "Bearer"),
      scope: cleanText(token.scope || current.scope),
      expiresAtMs: expiresIn ? now + Math.max(60, expiresIn) * 1000 : Number(token.expiresAtMs || current.expiresAtMs || 0),
      updatedAt: new Date(now).toISOString()
    };
    ensureDir(this.file);
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  saveOAuthState(state = {}) {
    const current = this.read();
    const next = {
      ...current,
      oauthState: {
        state: cleanText(state.state),
        codeVerifier: cleanText(state.codeVerifier),
        createdAtMs: Date.now()
      }
    };
    ensureDir(this.file);
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return next.oauthState;
  }

  consumeOAuthState(stateValue = "") {
    const current = this.read();
    const saved = current.oauthState || {};
    const matches = saved.state && saved.state === cleanText(stateValue);
    const fresh = saved.createdAtMs && Date.now() - Number(saved.createdAtMs) < 10 * 60_000;
    const next = { ...current };
    delete next.oauthState;
    ensureDir(this.file);
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return matches && fresh ? saved : null;
  }

  status() {
    const token = this.read();
    const now = Date.now();
    return {
      tokenFile: this.file,
      accessTokenStored: Boolean(token.accessToken),
      refreshTokenStored: Boolean(token.refreshToken),
      accessTokenPreview: redactToken(token.accessToken),
      expiresAt: token.expiresAtMs ? new Date(Number(token.expiresAtMs)).toISOString() : "",
      expiresInMs: token.expiresAtMs ? Math.max(0, Number(token.expiresAtMs) - now) : 0,
      scope: cleanText(token.scope),
      updatedAt: token.updatedAt || ""
    };
  }
}

class TidalProfileAuth {
  constructor(config = {}) {
    this.clientId = cleanText(config.clientId);
    this.clientSecret = cleanText(config.clientSecret);
    this.redirectUri = cleanText(config.redirectUri || "http://127.0.0.1:3777/api/tidal/oauth/callback");
    this.scopes = config.allowLegacyScope ? cleanText(config.scopes || DEFAULT_SCOPES) : stripLegacyScopes(config.scopes || DEFAULT_SCOPES);
    this.authorizationUrl = cleanText(config.authorizationUrl || TIDAL_AUTHORIZE_URL);
    this.tokenUrl = cleanText(config.tokenUrl || TIDAL_TOKEN_URL);
    this.staticAccessToken = cleanText(config.accessToken);
    this.staticRefreshToken = cleanText(config.refreshToken);
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.timeoutMs = positiveNumber(config.timeoutMs, DEFAULT_TIDAL_FETCH_TIMEOUT_MS, { min: 500, max: 120_000 });
    this.store = config.store || new TidalProfileTokenStore(config.tokenFile || undefined);
    if (this.staticAccessToken || this.staticRefreshToken) {
      this.store.save({
        accessToken: this.staticAccessToken,
        refreshToken: this.staticRefreshToken,
        expiresAtMs: Number(config.expiresAtMs || 0),
        scope: this.scopes
      });
    }
  }

  hasClientCredentials() {
    return Boolean(this.clientId && this.clientSecret);
  }

  status() {
    const store = this.store.status();
    return {
      configured: Boolean(store.accessTokenStored || this.staticAccessToken || store.refreshTokenStored || this.staticRefreshToken),
      clientConfigured: this.hasClientCredentials(),
      redirectUri: this.redirectUri,
      scopes: this.scopes,
      ...store
    };
  }

  createAuthorizationUrl() {
    if (!this.clientId) throw new Error("TIDAL_CLIENT_ID is required for profile authorization.");
    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    const codeChallenge = sha256Base64Url(codeVerifier);
    this.store.saveOAuthState({ state, codeVerifier });

    const url = new URL(this.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", this.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  authHeaders() {
    if (!this.hasClientCredentials()) return { accept: "application/json" };
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, "utf8").toString("base64");
    return {
      accept: "application/json",
      authorization: `Basic ${basic}`
    };
  }

  async postToken(params, label = "TIDAL profile token request") {
    const response = await fetchWithTimeout(this.tokenUrl, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(params)
    }, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      label
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.access_token) {
      const message = cleanText(json?.error_description || json?.error || response.status);
      throw new Error(`${label} failed: ${message}`);
    }
    return this.store.save(json);
  }

  async exchangeAuthorizationCode({ code, state } = {}) {
    const cleanCode = cleanText(code);
    if (!cleanCode) throw new Error("TIDAL authorization callback did not include a code.");
    const savedState = this.store.consumeOAuthState(state);
    if (!savedState) throw new Error("TIDAL authorization state expired or did not match. Start authorization again.");
    return this.postToken({
      grant_type: "authorization_code",
      code: cleanCode,
      redirect_uri: this.redirectUri,
      code_verifier: savedState.codeVerifier
    }, "TIDAL profile authorization");
  }

  async refreshAccessToken() {
    const token = this.store.read();
    const refreshToken = cleanText(token.refreshToken || this.staticRefreshToken);
    if (!refreshToken) throw new Error("TIDAL profile refresh token is missing. Reconnect TIDAL profile access.");
    return this.postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }, "TIDAL profile token refresh");
  }

  async getAccessToken() {
    const token = this.store.read();
    const accessToken = cleanText(token.accessToken || this.staticAccessToken);
    const expiresAtMs = Number(token.expiresAtMs || 0);
    if (accessToken && (!expiresAtMs || expiresAtMs - Date.now() > REFRESH_SKEW_MS)) return accessToken;
    if (token.refreshToken || this.staticRefreshToken) {
      const refreshed = await this.refreshAccessToken();
      return cleanText(refreshed.accessToken);
    }
    if (accessToken) return accessToken;
    return "";
  }
}

module.exports = {
  DEFAULT_SCOPES,
  TidalProfileAuth,
  TidalProfileTokenStore,
  redactToken
};
