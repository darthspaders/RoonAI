"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fetchWithTimeout } = require("./tidalRequestGuard");

const DEFAULT_API_BASE_URL = "https://api.discogs.com";
const DEFAULT_AUTHORIZE_URL = "https://www.discogs.com/oauth/authorize";
const DEFAULT_REQUEST_TOKEN_URL = `${DEFAULT_API_BASE_URL}/oauth/request_token`;
const DEFAULT_ACCESS_TOKEN_URL = `${DEFAULT_API_BASE_URL}/oauth/access_token`;
const DEFAULT_TIMEOUT_MS = 8_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function redactToken(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  if (text.length <= 10) return "configured";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function oauthEncode(value = "") {
  return encodeURIComponent(String(value ?? ""))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function randomNonce() {
  return crypto.randomBytes(32).toString("hex");
}

function timestampSeconds(clock = Date.now) {
  return Math.floor(Number(clock()) / 1000);
}

function parseFormEncoded(text = "") {
  return Object.fromEntries(new URLSearchParams(String(text || "")).entries());
}

function oauthHeader({
  consumerKey,
  consumerSecret,
  token = "",
  tokenSecret = "",
  callback = "",
  verifier = "",
  clock = Date.now,
  nonce = randomNonce()
} = {}) {
  const values = {
    oauth_consumer_key: cleanText(consumerKey),
    oauth_nonce: cleanText(nonce),
    oauth_signature: `${consumerSecret || ""}&${tokenSecret || ""}`,
    oauth_signature_method: "PLAINTEXT",
    oauth_timestamp: String(timestampSeconds(clock)),
    oauth_version: "1.0"
  };
  if (token) values.oauth_token = cleanText(token);
  if (callback) values.oauth_callback = callback;
  if (verifier) values.oauth_verifier = cleanText(verifier);

  return `OAuth ${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    // Discogs documents PLAINTEXT signatures as `consumer_secret&token_secret`
    // in the OAuth header. Keep that value literal for compatibility with the
    // Discogs endpoint; other header values remain RFC 3986 encoded.
    .map(([key, value]) => `${oauthEncode(key)}="${key === "oauth_signature" ? value : oauthEncode(value)}"`)
    .join(", ")}`;
}

class DiscogsOAuthTokenStore {
  constructor(file = path.join(__dirname, "..", "data", "discogs-oauth-token.json")) {
    this.file = file;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  write(next = {}) {
    ensureDir(this.file);
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  saveAccessToken({ oauth_token, oauth_token_secret, accessToken, accessTokenSecret } = {}) {
    const current = this.read();
    const next = {
      ...current,
      accessToken: cleanText(oauth_token || accessToken || current.accessToken),
      accessTokenSecret: cleanText(oauth_token_secret || accessTokenSecret || current.accessTokenSecret),
      updatedAt: new Date().toISOString()
    };
    delete next.oauthState;
    return this.write(next);
  }

  saveRequestToken({ oauthToken, oauthTokenSecret, redirectUri } = {}) {
    const current = this.read();
    const next = {
      ...current,
      oauthState: {
        oauthToken: cleanText(oauthToken),
        oauthTokenSecret: cleanText(oauthTokenSecret),
        redirectUri: cleanText(redirectUri),
        createdAtMs: Date.now()
      }
    };
    return this.write(next).oauthState;
  }

  consumeRequestToken(oauthToken = "") {
    const current = this.read();
    const saved = current.oauthState || {};
    const matches = cleanText(saved.oauthToken) && cleanText(saved.oauthToken) === cleanText(oauthToken);
    const fresh = Number(saved.createdAtMs) > 0 && Date.now() - Number(saved.createdAtMs) < OAUTH_STATE_TTL_MS;
    const next = { ...current };
    delete next.oauthState;
    this.write(next);
    return matches && fresh ? saved : null;
  }

  status() {
    const token = this.read();
    const pending = token.oauthState || {};
    return {
      tokenFile: this.file,
      accessTokenStored: Boolean(token.accessToken && token.accessTokenSecret),
      accessTokenPreview: redactToken(token.accessToken),
      updatedAt: cleanText(token.updatedAt),
      pendingAuthorization: Boolean(pending.oauthToken),
      pendingCreatedAt: pending.createdAtMs ? new Date(Number(pending.createdAtMs)).toISOString() : ""
    };
  }
}

class DiscogsOAuth {
  constructor({
    enabled = true,
    consumerKey = "",
    consumerSecret = "",
    redirectUri = "http://127.0.0.1:3777/api/discogs/oauth/callback",
    authorizeUrl = DEFAULT_AUTHORIZE_URL,
    requestTokenUrl = DEFAULT_REQUEST_TOKEN_URL,
    accessTokenUrl = DEFAULT_ACCESS_TOKEN_URL,
    tokenFile = path.join(__dirname, "..", "data", "discogs-oauth-token.json"),
    accessToken = "",
    accessTokenSecret = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = "RabbitHole/0.1.0 (Discogs OAuth)",
    fetchImpl = globalThis.fetch,
    store = null,
    clock = Date.now,
    logger = console
  } = {}) {
    this.enabled = enabled !== false;
    this.consumerKey = cleanText(consumerKey);
    this.consumerSecret = cleanText(consumerSecret);
    this.redirectUri = cleanText(redirectUri);
    this.authorizeUrl = cleanText(authorizeUrl || DEFAULT_AUTHORIZE_URL);
    this.requestTokenUrl = cleanText(requestTokenUrl || DEFAULT_REQUEST_TOKEN_URL);
    this.accessTokenUrl = cleanText(accessTokenUrl || DEFAULT_ACCESS_TOKEN_URL);
    this.timeoutMs = Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.userAgent = cleanText(userAgent) || "RabbitHole/0.1.0 (Discogs OAuth)";
    this.fetchImpl = fetchImpl;
    this.store = store || new DiscogsOAuthTokenStore(tokenFile);
    this.clock = typeof clock === "function" ? clock : Date.now;
    this.logger = logger;
    if (accessToken || accessTokenSecret) {
      this.store.saveAccessToken({ accessToken, accessTokenSecret });
    }
  }

  hasConsumerCredentials() {
    return Boolean(this.consumerKey && this.consumerSecret);
  }

  credentials() {
    const stored = this.store.read();
    return {
      accessToken: cleanText(stored.accessToken),
      accessTokenSecret: cleanText(stored.accessTokenSecret)
    };
  }

  isConnected() {
    const credentials = this.credentials();
    return this.enabled && this.hasConsumerCredentials() && Boolean(credentials.accessToken && credentials.accessTokenSecret);
  }

  isConfigured() {
    return this.isConnected();
  }

  status() {
    return {
      enabled: this.enabled,
      clientConfigured: this.hasConsumerCredentials(),
      configured: this.isConnected(),
      redirectUri: this.redirectUri,
      authorizeUrl: this.authorizeUrl,
      ...this.store.status()
    };
  }

  authorizationHeader({ token = "", tokenSecret = "", callback = "", verifier = "" } = {}) {
    return oauthHeader({
      consumerKey: this.consumerKey,
      consumerSecret: this.consumerSecret,
      token,
      tokenSecret,
      callback,
      verifier,
      clock: this.clock
    });
  }

  async requestForm(url, { method = "GET", headerOptions = {}, label } = {}) {
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        accept: "application/x-www-form-urlencoded, text/plain",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": this.userAgent,
        authorization: this.authorizationHeader(headerOptions)
      }
    }, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      label: label || "Discogs OAuth request"
    });
    const text = await response.text();
    const body = parseFormEncoded(text);
    if (!response.ok) {
      const message = cleanText(body.oauth_problem || body.error || text || response.status);
      throw new Error(`${label || "Discogs OAuth request"} failed: ${message}`);
    }
    return body;
  }

  async createAuthorizationUrl({ redirectUri = "" } = {}) {
    if (!this.enabled || !this.hasConsumerCredentials()) {
      throw new Error("DISCOGS_CONSUMER_KEY and DISCOGS_CONSUMER_SECRET are required for Discogs OAuth.");
    }
    const callback = cleanText(redirectUri) || this.redirectUri;
    if (!callback) throw new Error("A Discogs OAuth callback URL is required.");
    const result = await this.requestForm(this.requestTokenUrl, {
      headerOptions: { callback },
      label: "Discogs OAuth request token"
    });
    const oauthToken = cleanText(result.oauth_token);
    const oauthTokenSecret = cleanText(result.oauth_token_secret);
    if (!oauthToken || !oauthTokenSecret) throw new Error("Discogs did not return an OAuth request token.");
    this.store.saveRequestToken({ oauthToken, oauthTokenSecret, redirectUri: callback });
    const url = new URL(this.authorizeUrl);
    url.searchParams.set("oauth_token", oauthToken);
    return url.toString();
  }

  async exchangeAuthorizationCode({ oauthToken = "", verifier = "", oauthVerifier = "" } = {}) {
    const token = cleanText(oauthToken);
    const verification = cleanText(verifier || oauthVerifier);
    if (!token || !verification) throw new Error("Discogs authorization callback did not include an OAuth token and verifier.");
    const saved = this.store.consumeRequestToken(token);
    if (!saved) throw new Error("Discogs OAuth state expired or did not match. Start authorization again.");
    const result = await this.requestForm(this.accessTokenUrl, {
      method: "POST",
      headerOptions: {
        token,
        tokenSecret: saved.oauthTokenSecret,
        verifier: verification
      },
      label: "Discogs OAuth access token"
    });
    const accessToken = cleanText(result.oauth_token);
    const accessTokenSecret = cleanText(result.oauth_token_secret);
    if (!accessToken || !accessTokenSecret) throw new Error("Discogs did not return an OAuth access token.");
    this.store.saveAccessToken({ oauth_token: accessToken, oauth_token_secret: accessTokenSecret });
    return {
      accessToken,
      accessTokenSecret,
      username: cleanText(result.username)
    };
  }

  authHeaders() {
    if (!this.isConnected()) return {};
    const credentials = this.credentials();
    return {
      authorization: this.authorizationHeader({
        token: credentials.accessToken,
        tokenSecret: credentials.accessTokenSecret
      })
    };
  }
}

module.exports = {
  DEFAULT_ACCESS_TOKEN_URL,
  DEFAULT_API_BASE_URL,
  DEFAULT_AUTHORIZE_URL,
  DEFAULT_REQUEST_TOKEN_URL,
  DiscogsOAuth,
  DiscogsOAuthTokenStore,
  oauthEncode,
  oauthHeader,
  parseFormEncoded
};
