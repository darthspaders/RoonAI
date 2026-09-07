"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const config = require("../src/config");
const { BeatportTokenStore, redactToken } = require("../src/beatportClient");

function usage() {
  console.error("Usage:");
  console.error("  npm run beatport:token");
  console.error("  npm run beatport:token -- C:\\path\\to\\beatport-token.json");
  console.error("");
  console.error("Paste or pass the full JSON response from Beatport's /auth/o/token/ request, or paste a raw Bearer JWT.");
}

function decodeJwtPayload(token = "") {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function tokenFromRawText(text = "") {
  const token = String(text || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/\\_/g, "_");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const payload = decodeJwtPayload(token);
  return {
    access_token: token,
    token_type: "Bearer",
    scope: payload.scope || "",
    expiresAtMs: payload.exp ? Number(payload.exp) * 1000 : 0
  };
}

function parseTokenInput(text = "") {
  const trimmed = String(text || "").trim().replace(/\\_/g, "_");
  if (!trimmed) throw new Error("No token JSON was provided.");
  const rawToken = tokenFromRawText(trimmed);
  if (rawToken) return rawToken;

  const jsonText = trimmed.startsWith("{") ? trimmed : `{${trimmed}`;
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Beatport token must be a JSON object.");
  }
  const accessToken = parsed.access_token || parsed.accessToken;
  const refreshToken = parsed.refresh_token || parsed.refreshToken;
  if (!accessToken && !refreshToken) {
    throw new Error("Token JSON must include access_token/accessToken or refresh_token/refreshToken.");
  }
  return parsed;
}

async function readStdin() {
  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8");
  }

  console.log("Paste Beatport token JSON, then press Enter on a blank line:");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  for await (const line of rl) {
    if (!line.trim() && lines.length) break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
  const raw = inputPath ? fs.readFileSync(inputPath, "utf8") : await readStdin();
  const token = parseTokenInput(raw);
  const store = new BeatportTokenStore(config.beatport.tokenFile);
  const saved = store.save(token);

  console.log(`Saved Beatport token to ${store.file}`);
  console.log(`Access token: ${redactToken(saved.accessToken) || "none"}`);
  console.log(`Refresh token: ${saved.refreshToken ? "stored" : "none"}`);
  console.log(`Expires: ${saved.expiresAtMs ? new Date(Number(saved.expiresAtMs)).toISOString() : "unknown"}`);
  if (!config.beatport.enabled) {
    console.log("BEATPORT_ENABLED is still false. Set it to true and restart Rabbit Hole when you want lookups active.");
  }
}

main().catch((error) => {
  console.error(`Beatport token was not saved: ${error.message}`);
  usage();
  process.exitCode = 1;
});
