"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { updatePrivateJson } = require("./sonicPrivateAtomicJson");
const { scoreTidalIdentity, normalize, artists } = require("./exactTrackVerification");
const { explicitTidalTrackId } = require("./tidalIdentity");

const DAY = 86400000;
const POLICY = Object.freeze({ requestsPerDay: 60, streamsPerDay: 8, candidatesPerLookup: 3,
  minimumRequestIntervalMs: 2000, maxAudioBytes: 20 * 1024 * 1024, maxPageBytes: 2 * 1024 * 1024,
  negativeCacheMs: DAY, refusalCooldownMs: DAY, automaticStreamAttemptsPerTrack: 1 });
const MESSAGES = Object.freeze({
  NOT_CHECKED: "Bandcamp has not been checked for this track. No Bandcamp listening evidence is available.",
  CHECKING: "Checking Bandcamp after an exact Beatport source was unavailable.",
  ANALYZED: "Analyzed an exact Bandcamp recording under its verified TIDAL identity.",
  TIDAL_UNAVAILABLE: "Bandcamp skipped: TIDAL streaming availability could not be confirmed in your region.",
  ROON_UNAVAILABLE: "Bandcamp skipped: an exact Roon queue action could not be confirmed. No Bandcamp request was made.",
  NO_MATCH: "No sufficiently exact Bandcamp recording was found within the bounded search.",
  AMBIGUOUS: "Multiple Bandcamp recordings matched. No stream was fetched.",
  NO_STREAM: "Bandcamp did not expose an available stream for this recording.",
  PLAY_LIMIT: "Bandcamp reported a streaming limit or purchase requirement. Automatic access to this track has stopped.",
  RATE_LIMIT: "Bandcamp returned HTTP 429 (too many requests). All Bandcamp requests are paused until the cooldown ends.",
  ACCESS_DENIED: "Bandcamp denied access. The reason is not confirmed; all Bandcamp requests are paused.",
  CHALLENGE: "Bandcamp requested a browser or human verification. Automatic Bandcamp access is paused.",
  COOLDOWN: "Bandcamp access is paused after a provider refusal. No new request was made.",
  LOCAL_BUDGET: "Rabbit Hole's own Bandcamp request or stream budget is reached. This is not a Bandcamp limit.",
  ALREADY_ATTEMPTED: "This Bandcamp stream was already attempted. Automatic repeat downloads are disabled; existing analysis is reused when available.",
  NETWORK_ERROR: "Bandcamp could not be reached. No streaming-limit conclusion can be drawn.",
  UPSTREAM_ERROR: "Bandcamp returned a service error. No streaming-limit conclusion can be drawn.",
  FORMAT_CHANGED: "Bandcamp's response could not be read safely. No usable audio was obtained.",
  UNSAFE_URL: "Bandcamp returned an unsupported destination. No request was sent to that destination.",
  AUDIO_LIMIT: "The Bandcamp response exceeded Rabbit Hole's size or duration limit.",
  ANALYSIS_FAILED: "Bandcamp audio was received, but Sonic analysis failed. The stream will not be downloaded again automatically.",
  STATE_UNAVAILABLE: "Bandcamp safety history could not be read or saved. Automatic access is stopped.",
  BUSY: "Another Bandcamp fallback is running. This track was deferred without a provider request.",
  BEATPORT_ERROR: "Bandcamp was not tried because Beatport returned an API or network error rather than a confirmed source miss."
});
function problem(code, extra = {}) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.FORMAT_CHANGED), { code, bandcamp: true, ...extra }); }
const idFor = track => explicitTidalTrackId({ tidal: track?.tidal, tidalId: track?.tidalId || track?.tidal_id,
  tidalTrackId: track?.tidalTrackId }) || String(track?.identityKey || "").match(/^tidal:(\d+)$/)?.[1] || "";
const iso = value => value ? new Date(value).toISOString() : null;
const text = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
function entity(value) {
  return String(value).replace(/&(?:quot|amp|apos|lt|gt|#(?:x[0-9a-f]+|\d+));/gi, token => {
    const named = { "&quot;": '"', "&amp;": "&", "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[token.toLowerCase()]) return named[token.toLowerCase()];
    const n = token.slice(2, -1), code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
function checkedUrl(input, kind) {
  let url; try { url = new URL(input); } catch { throw problem("UNSAFE_URL"); }
  const page = url.hostname === "bandcamp.com" || /^[a-z0-9-]+\.bandcamp\.com$/.test(url.hostname);
  const audio = /^[a-z0-9-]+\.bcbits\.com$/.test(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(kind === "audio" ? audio : page)) throw problem("UNSAFE_URL");
  return url;
}
function searchPages(html) {
  const links = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => entity(m[1]));
  const pages = [...new Set(links.flatMap(link => {
    try { const u = checkedUrl(link, "page"); return /^\/track\/[^/]+\/?$/.test(u.pathname) ? [u.origin + u.pathname] : []; } catch { return []; }
  }))];
  if (!pages.length && !/searchresult|search results|no results|did not match|no matching/i.test(html)) throw problem("FORMAT_CHANGED");
  return pages;
}
function parseTrackPage(html, pageUrl) {
  const raw = html.match(/data-tralbum\s*=\s*"([^"]+)"/i)?.[1] || html.match(/data-tralbum\s*=\s*'([^']+)'/i)?.[1];
  let data; try { data = JSON.parse(entity(raw || "")); } catch { throw problem("FORMAT_CHANGED"); }
  if (!Array.isArray(data.trackinfo)) throw problem("FORMAT_CHANGED");
  const slug = new URL(pageUrl).pathname.replace(/\/$/, "");
  const rows = data.trackinfo.filter(t => t.title_link && new URL(t.title_link, pageUrl).pathname.replace(/\/$/, "") === slug);
  if (rows.length !== 1) throw problem("FORMAT_CHANGED");
  const row = rows[0];
  return { id: String(row.track_id || row.id || ""), artist: text(row.artist || data.artist || data.current?.artist),
    title: text(row.title), album: text(data.album_title || (data.current?.type === "album" ? data.current.title : "")),
    durationMs: Number(row.duration) * 1000, isrc: text(row.isrc), pageUrl,
    streamUrl: row.file?.["mp3-128"] || "", restricted: row.streaming === 0 || row.streaming === false || data.current?.streaming === 0,
    playLimit: row.play_limit_reached === true || data.play_limit_reached === true };
}
function exactRecording(tidal, candidate) {
  // A provider's numeric id must never masquerade as a TIDAL id in the matcher.
  const source = { artist: candidate.artist, title: candidate.title, album: candidate.album, durationMs: candidate.durationMs, isrc: candidate.isrc };
  const wanted = { ...tidal, id: undefined, tidalId: undefined, tidalTrackId: undefined, tidal: undefined, tidalUrl: undefined };
  const evidence = scoreTidalIdentity(wanted, source);
  const credits = artists(tidal.artist).split("|").sort().join("|") === artists(candidate.artist).split("|").sort().join("|");
  const duration = Number(tidal.durationMs) > 0 && Number(candidate.durationMs) > 0 && Math.abs(tidal.durationMs - candidate.durationMs) <= 2000;
  const isrc = tidal.isrc && candidate.isrc && normalize(tidal.isrc) === normalize(candidate.isrc);
  const album = tidal.album && candidate.album && normalize(tidal.album) === normalize(candidate.album);
  return Boolean(evidence.matched && credits && duration && (isrc || album));
}

class BandcampAnalysisSource {
  constructor({ file = path.join(__dirname, "..", "data", "bandcamp-analysis.json"), fetchImpl = globalThis.fetch,
    verifyEligibility, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.file = file; this.fetch = fetchImpl; this.verifyEligibility = verifyEligibility; this.clock = clock; this.sleep = sleep;
    this.busy = false; this.state = { version: 1, requests: [], streams: [], attempts: {}, tracks: {}, cooldownUntil: 0, lastRequest: 0 };
    try { const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.requests) || !Array.isArray(saved.streams) || !saved.attempts || !saved.tracks) throw Error();
      this.state = saved;
    } catch (error) { if (error.code !== "ENOENT") this.stateError = true; }
  }
  save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); updatePrivateJson(path.resolve(this.file), this.state); }
    catch { this.stateError = true; throw problem("STATE_UNAVAILABLE"); }
  }
  prune() { for (const key of ["requests", "streams"]) this.state[key] = this.state[key].filter(t => t > this.clock() - DAY); }
  status() {
    this.prune(); return { enabled: true, mode: "exact-fallback", busy: this.busy, stateAvailable: !this.stateError,
      policy: POLICY, requestsLast24h: this.state.requests.length, streamAttemptsLast24h: this.state.streams.length,
      cooldownUntil: iso(this.state.cooldownUntil > this.clock() ? this.state.cooldownUntil : 0),
      cooldownReason: this.state.cooldownReason || "", providerQuotaRemaining: null,
      quotaNote: "Bandcamp does not expose a reliable remaining-play quota here. Rabbit Hole limits are local safeguards, not provider quotas." };
  }
  report(tracks = []) {
    const items = tracks.map(t => this.state.tracks[idFor(t)] || { tidalId: idFor(t), artist: text(t.artist), title: text(t.title),
      code: "NOT_CHECKED", message: MESSAGES.NOT_CHECKED, checkedAt: null });
    const counts = {}; for (const item of items) counts[item.code] = (counts[item.code] || 0) + 1;
    return { ...this.status(), counts, total: items.length, items: items.slice(0, 40) };
  }
  recent() { return { ...this.status(), items: Object.values(this.state.tracks).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, 20) }; }
  record(track, code, extra = {}) {
    const id = idFor(track); if (!id) return;
    if (this.state.tracks[id]?.code === "ANALYZED" && code !== "ANALYZED") return;
    this.state.tracks[id] = { tidalId: id, artist: text(track.artist), title: text(track.title), code, message: MESSAGES[code],
      checkedAt: iso(this.clock()), ...extra }; this.save();
  }
  pause(code, retryAfter) {
    const seconds = Number(retryAfter), date = Date.parse(retryAfter || "");
    const until = Number.isFinite(seconds) && seconds > 0 ? this.clock() + seconds * 1000 : Number.isFinite(date) ? date : 0;
    this.state.cooldownUntil = Math.max(this.clock() + POLICY.refusalCooldownMs, until);
    this.state.cooldownReason = code; this.save();
  }
  async request(input, kind = "page") {
    const url = checkedUrl(input, kind); this.prune();
    if (this.stateError) throw problem("STATE_UNAVAILABLE");
    if (this.state.cooldownUntil > this.clock()) throw problem("COOLDOWN", { retryAt: iso(this.state.cooldownUntil) });
    if (this.state.requests.length >= POLICY.requestsPerDay) throw problem("LOCAL_BUDGET", { retryAt: iso(this.state.requests[0] + DAY) });
    const wait = this.state.lastRequest + POLICY.minimumRequestIntervalMs - this.clock(); if (wait > 0) await this.sleep(wait);
    this.state.requests.push(this.clock()); this.state.lastRequest = this.clock(); this.save();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), kind === "audio" ? 45000 : 15000);
    let response;
    try {
      response = await this.fetch(url.href, { redirect: "manual", signal: controller.signal,
        headers: { "user-agent": "RabbitHole/0.1 (personal music analysis; bounded requests)", accept: kind === "audio" ? "audio/mpeg" : "text/html", "accept-encoding": "identity" } });
      if ([401, 403, 429].includes(response.status)) {
        const code = response.status === 429 ? "RATE_LIMIT" : "ACCESS_DENIED";
        this.pause(code, response.headers.get("retry-after")); throw problem(code, { httpStatus: response.status, retryAt: iso(this.state.cooldownUntil) });
      }
      if (response.status === 402) throw problem("PLAY_LIMIT", { httpStatus: 402 });
      if (response.status === 404 || response.status === 410) throw problem("NO_STREAM", { httpStatus: response.status });
      if (response.status >= 300 && response.status < 400) throw problem("UNSAFE_URL", { httpStatus: response.status });
      if (!response.ok) throw problem("UPSTREAM_ERROR", { httpStatus: response.status });
      const max = kind === "audio" ? POLICY.maxAudioBytes : POLICY.maxPageBytes;
      if (Number(response.headers.get("content-length")) > max) throw problem("AUDIO_LIMIT");
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > max) throw problem("AUDIO_LIMIT"); chunks.push(Buffer.from(chunk)); }
      const buffer = Buffer.concat(chunks), type = response.headers.get("content-type") || "";
      if (kind === "audio") {
        if (!/^audio\/(mpeg|mp3)(?:;|$)/i.test(type) || buffer.length < 1024) throw problem("FORMAT_CHANGED");
        return buffer;
      }
      const html = buffer.toString("utf8");
      if (/captcha|verify you are human|cf-chl-/i.test(html)) { this.pause("CHALLENGE"); throw problem("CHALLENGE"); }
      if (/play limit reached|streaming limit reached|purchase (?:this|the) (?:track|album) to continue/i.test(html)) throw problem("PLAY_LIMIT");
      return html;
    } catch (error) { if (error.bandcamp) throw error; throw problem("NETWORK_ERROR"); }
    finally { clearTimeout(timer); controller.abort(); try { await response?.body?.cancel(); } catch { /* consumed or locked */ } }
  }
  async acquire(track) {
    if (this.busy) throw problem("BUSY");
    this.busy = true;
    try {
      if (this.stateError) throw problem("STATE_UNAVAILABLE");
      const previous = this.state.tracks[idFor(track)];
      if (previous && previous.code !== "CHECKING" && previous.code !== "NOT_CHECKED") {
        if (["PLAY_LIMIT", "ANALYZED", "ANALYSIS_FAILED", "ALREADY_ATTEMPTED"].includes(previous.code)) throw problem("ALREADY_ATTEMPTED");
        if (Date.parse(previous.checkedAt) + POLICY.negativeCacheMs > this.clock()) throw problem(previous.code, { cached: true, retryAt: previous.retryAt });
      }
      const eligibility = await this.verifyEligibility?.(track);
      if (eligibility?.tidalAvailable !== true) throw problem("TIDAL_UNAVAILABLE");
      if (eligibility?.roonQueueable !== true) throw problem("ROON_UNAVAILABLE");
      this.record(track, "CHECKING");
      const query = encodeURIComponent(`${track.artist} ${track.title}`);
      const html = await this.request(`https://bandcamp.com/search?q=${query}&item_type=t`);
      const pages = searchPages(html).slice(0, POLICY.candidatesPerLookup), matches = [];
      for (const page of pages) {
        const candidate = parseTrackPage(await this.request(page), page);
        if (exactRecording(track, candidate)) matches.push(candidate);
      }
      const unique = [...new Map(matches.map(t => [t.id, t])).values()];
      if (!unique.length) throw problem("NO_MATCH");
      if (unique.length !== 1) throw problem("AMBIGUOUS");
      const selected = unique[0];
      if (selected.playLimit) throw problem("PLAY_LIMIT");
      if (!/^\d+$/.test(selected.id) || selected.restricted || !selected.streamUrl) throw problem("NO_STREAM");
      if (selected.durationMs > 20 * 60 * 1000) throw problem("AUDIO_LIMIT");
      checkedUrl(selected.streamUrl, "audio"); this.prune();
      if (this.state.attempts[selected.id]) throw problem("ALREADY_ATTEMPTED");
      if (this.state.streams.length >= POLICY.streamsPerDay) throw problem("LOCAL_BUDGET", { retryAt: iso(this.state.streams[0] + DAY) });
      // Reserve before touching the stream. Crash, timeout, or analysis failure cannot repeat a play.
      this.state.attempts[selected.id] = iso(this.clock()); this.state.streams.push(this.clock()); this.save();
      const buffer = await this.request(selected.streamUrl, "audio");
      const { streamUrl, ...source } = selected;
      return { buffer, source, eligibility, sha256: createHash("sha256").update(buffer).digest("hex") };
    } catch (error) {
      const safe = error.bandcamp ? error : problem("NETWORK_ERROR");
      if (!this.stateError && !safe.cached && safe.code !== "ALREADY_ATTEMPTED") this.record(track, safe.code, {
        httpStatus: safe.httpStatus || null, retryAt: safe.retryAt || null });
      throw safe;
    } finally { this.busy = false; }
  }
}
module.exports = { BandcampAnalysisSource, POLICY, MESSAGES, problem, checkedUrl, searchPages, parseTrackPage, exactRecording };
