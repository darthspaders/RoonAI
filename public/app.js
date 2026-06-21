"use strict";

const state = {
  zones: [],
  selectedZoneId: localStorage.getItem("zoneId") || "",
  lastTracks: [],
  displayedTracks: [],
  lastResult: null,
  playlists: [],
  playlistSeedTracks: [],
  savedLists: [],
  activeSavedListId: "",
  savedTracks: [],
  feedbackByKey: {},
  calibration: null,
  calibrationVersion: "",
  appUpdatedAt: "",
  savedVersion: "",
  sessionUpdatedAt: "",
  tasteUpdatedAt: "",
  feedbackVersion: "",
  memory: null,
  historyReport: null,
  historyNeedsRefresh: true,
  tidalMixes: null,
  tidalVisibleMixes: [],
  tidalMixesNeedsRefresh: true,
  tidalPlaylists: [],
  tidalPlaylistsLoaded: false,
  tidalPlaylistsLoading: false,
  tidalPlaylistsError: "",
  selectedTidalPlaylistId: localStorage.getItem("tidalPlaylistId") || "",
  selectedTidalSeedPlaylistId: localStorage.getItem("tidalSeedPlaylistId") || "",
  tidalPlaylistSeedTracks: [],
  appStatus: null,
  connectionStatus: { connected: false, coreName: "" },
  nowTrack: null,
  nowTrackSource: "",
  nowMatchIndex: -1,
  nowSavedIndex: -1,
  rabbitHoleGraph: null,
  rabbitHoleKey: "",
  isSeeking: false,
  playerMaximized: localStorage.getItem("playerMaximized") === "1",
  llmStatus: null,
  rejectedDebugOpen: false,
  resultArtistConfirmedOnly: false
};

const $ = (selector) => document.querySelector(selector);

const TIDAL_RADIO_RECENT_KEY = "rabbitHole.tidalRadioRecent.v1";
const TIDAL_RADIO_RECENT_TTL_MS = 24 * 60 * 60 * 1000;
const TIDAL_RADIO_RECENT_MAX = 160;

let screenWakeLock = null;
let screenWakeLockDesired = false;
let screenWakeLockPending = null;
const screenWakeFallback = {
  video: null,
  stream: null,
  timer: null,
  canvas: null,
  flip: false
};

function setScoringMode(value = "") {
  const normalized = ["pure", "explore", "similar"].includes(String(value || "")) ? String(value || "") : "";
  const input = $("#scoringMode") || document.querySelector("[name='scoringMode']");
  if (input) input.value = normalized;

  document.querySelectorAll("[data-scoring-mode]").forEach((button) => {
    const active = String(button.dataset.scoringMode || "") === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function moveScoringModeSelection(currentButton, direction) {
  const buttons = Array.from(document.querySelectorAll("[data-scoring-mode]"));
  if (!buttons.length) return;
  const currentIndex = Math.max(0, buttons.indexOf(currentButton));
  const nextButton = buttons[(currentIndex + direction + buttons.length) % buttons.length];
  setScoringMode(nextButton.dataset.scoringMode || "");
  nextButton.focus();
}

const SCORE_MAX = {
  freshness: 19,
  labelMatch: 19,
  artistMatch: 19,
  lengthPreference: 19,
  genreMatch: 24
};

function activeZone() {
  return state.zones.find((zone) => zone.zone_id === state.selectedZoneId) || state.zones[0] || null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function safeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function summarizeNowPlaying(zone) {
  const now = zone?.now_playing;
  if (!now) return null;
  const enriched = now.radio_enrichment;
  const radioLookup = now.radio_lookup;
  if (radioLookup?.title && radioLookup?.artist) {
    return {
      title: radioLookup.title,
      artist: radioLookup.artist,
      album: enriched?.album || radioLookup.album || ""
    };
  }
  if (enriched?.title && enriched?.artist) {
    return {
      title: enriched.title,
      artist: enriched.artist,
      album: enriched.album || now.three_line?.line3 || ""
    };
  }

  return {
    title: now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1 || "",
    artist: now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2 || "",
    album: now.three_line?.line3 || ""
  };
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripVersionText(value) {
  return String(value || "")
    .replace(/\s*[\[(][^)\]]*\b(?:remix|mix|rework|rerub|dub|edit|version)\b[^)\]]*[\])]/gi, "")
    .trim();
}

function splitMatchArtists(value) {
  return String(value || "")
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map(normalizeMatchText)
    .filter((part) => part && part.length > 1);
}

function titleMatchesNow(trackTitle, nowTitle) {
  const track = normalizeMatchText(trackTitle);
  const now = normalizeMatchText(nowTitle);
  const trackBase = normalizeMatchText(stripVersionText(trackTitle));
  const nowBase = normalizeMatchText(stripVersionText(nowTitle));
  if (!track || !now) return false;
  return track === now ||
    now.includes(track) ||
    track.includes(now) ||
    (trackBase && nowBase && (trackBase === nowBase || nowBase.includes(trackBase) || trackBase.includes(nowBase)));
}

function artistMatchesNow(trackArtist, nowArtist) {
  const trackArtists = splitMatchArtists(trackArtist);
  const nowArtists = splitMatchArtists(nowArtist);
  if (!trackArtists.length || !nowArtists.length) return false;
  return trackArtists.some((artist) => nowArtists.some((now) => now === artist || now.includes(artist) || artist.includes(now)));
}

function trackMatchesNow(track, now) {
  return Boolean(track && now?.title && titleMatchesNow(track.title, now.title) && artistMatchesNow(track.artist, now.artist));
}

function withLocalFeedback(track = null) {
  if (!track) return null;
  const key = trackKeyFor(track);
  const feedback = key ? state.feedbackByKey[key] : "";
  return feedback && !track.feedback ? { ...track, feedback } : track;
}

function nowPlayingTrack(zone = activeZone()) {
  const now = summarizeNowPlaying(zone);
  if (!now?.title) return null;
  const rawNow = zone?.now_playing;
  const enriched = rawNow?.radio_enrichment;
  const roonImageUrl = rawNow?.image_key && rawNow?.radio_lookup?.catalogEnrichmentAllowed !== false
    ? `/api/roon/image/${encodeURIComponent(rawNow.image_key)}?width=360&height=360`
    : "";
  return withLocalFeedback({
    artist: now.artist || "Unknown artist",
    title: now.title,
    album: now.album || "",
    durationMs: zone?.now_playing?.length ? Number(zone.now_playing.length) * 1000 : null,
    label: enriched?.label || "",
    year: enriched?.year || null,
    releaseDate: enriched?.releaseDate || "",
    tidal: enriched || null,
    tidalUrl: enriched?.tidalUrl || "",
    imageUrl: roonImageUrl || enriched?.imageUrl,
    discoverySource: "Now playing",
    statusChecks: ["Now playing in Roon"],
    roon: {
      verified: true,
      match: {
        title: now.title,
        subtitle: now.artist || ""
      }
    }
  });
}

function rabbitHoleContextTracks(zone = activeZone()) {
  const items = displayQueueItems(zone);
  return items.slice(0, 50).map((item) => {
    const subtitleParts = String(item.subtitle || "").split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    return {
      title: item.title || "",
      artist: subtitleParts[0] || item.subtitle || "",
      album: item.album || subtitleParts.slice(1).join(" - ") || "",
      durationMs: item.length ? Number(item.length) * 1000 : null,
      source: "Roon live queue"
    };
  }).filter((track) => track.title && track.artist);
}

function findNowPlayingMatch(zone = activeZone()) {
  const now = summarizeNowPlaying(zone);
  const fallback = nowPlayingTrack(zone);
  if (!now?.title) return { index: -1, savedIndex: -1, track: null, source: "" };

  function withLiveNowPlayingMedia(track) {
    const localTrack = withLocalFeedback(track);
    if (!localTrack || !fallback) return localTrack;
    return {
      ...localTrack,
      album: fallback.album || localTrack.album || "",
      durationMs: fallback.durationMs || localTrack.durationMs || null,
      imageUrl: fallback.imageUrl || localTrack.imageUrl || "",
      tidal: localTrack.tidal || fallback.tidal || null,
      tidalUrl: localTrack.tidalUrl || fallback.tidalUrl || ""
    };
  }

  const index = state.lastTracks.findIndex((track) => trackMatchesNow(track, now));
  if (index >= 0) return { index, savedIndex: -1, track: withLiveNowPlayingMedia(state.lastTracks[index]), source: "current" };

  const savedIndex = state.savedTracks.findIndex((track) => trackMatchesNow(track, now));
  if (savedIndex >= 0) return { index: -1, savedIndex, track: withLiveNowPlayingMedia(state.savedTracks[savedIndex]), source: "saved" };

  if (zone?.memoryTrack && trackMatchesNow(zone.memoryTrack, now)) {
    return { index: -1, savedIndex: -1, track: withLiveNowPlayingMedia(zone.memoryTrack), source: "memory" };
  }

  return { index: -1, savedIndex: -1, track: fallback, source: "now" };
}

function formatDuration(durationMs) {
  const seconds = Math.round(Number(durationMs || 0) / 1000);
  return formatSeconds(seconds);
}

function formatHours(seconds) {
  const hours = Number(seconds || 0) / 3600;
  if (!hours) return "0 h";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatQueueSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  if (!seconds) return "";
  if (seconds < 3600) return formatSeconds(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${remainder}`;
}

function formatHealthSeconds(value) {
  const seconds = Math.ceil(Number(value || 0) / 1000);
  if (!seconds) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatHealthTimeout(value) {
  const ms = Number(value || 0);
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms timeout`;
  return `${Math.round(ms / 100) / 10}s timeout`;
}

function providerHealthClass(level) {
  if (level === "bad") return "healthBad";
  if (level === "warn") return "healthWarn";
  if (level === "unknown") return "healthUnknown";
  return "healthOk";
}

function circuitHealth(provider = {}, options = {}) {
  const circuit = provider.circuit || provider.tidalCircuit || {};
  const configured = provider.configured !== undefined ? Boolean(provider.configured) : true;
  const enabled = provider.enabled !== false;
  const stateLabel = String(circuit.state || "unknown");
  const failures = Number(circuit.failureCount || 0);
  const threshold = Number(circuit.failureThreshold || 0);
  const retryAfterMs = Number(circuit.retryAfterMs || 0);
  const timeoutText = formatHealthTimeout(provider.timeoutMs || provider.tidalTimeoutMs);
  const lastError = String(circuit.lastError || "").trim();

  if (!enabled) {
    return { level: "unknown", status: "disabled", detail: timeoutText || "not active" };
  }
  if (!configured) {
    return { level: "warn", status: "not configured", detail: "missing credentials" };
  }
  if (stateLabel === "open") {
    return {
      level: "bad",
      status: `backing off for ${formatHealthSeconds(retryAfterMs)}`,
      detail: lastError || timeoutText || "repeated fetch failures"
    };
  }
  if (stateLabel === "half-open") {
    return {
      level: "warn",
      status: "retrying after backoff",
      detail: lastError || timeoutText || "checking recovery"
    };
  }
  if (failures > 0) {
    return {
      level: "warn",
      status: `${failures}${threshold ? `/${threshold}` : ""} recent failures`,
      detail: lastError || timeoutText || "watching TIDAL"
    };
  }
  return {
    level: "ok",
    status: options.readyText || "ready",
    detail: timeoutText || "healthy"
  };
}

function llmHealthSummary(app = {}) {
  const status = state.llmStatus || {};
  const llm = app.llm || {};
  const label = status.label || llm.label || "Local model";
  const model = status.model || llm.model || "";
  const detail = [label, model].filter(Boolean).join(" ");
  if (status.online && status.loaded !== false) return { level: "ok", status: "ready", detail };
  if (status.checking) return { level: "unknown", status: "checking", detail };
  if (status.reachable && status.loaded === false) return { level: "warn", status: "model not loaded", detail: status.message || detail };
  if (state.llmStatus) return { level: "bad", status: "offline", detail: status.message || detail };
  return { level: "unknown", status: "not checked yet", detail };
}

function lastFmHealthSummary(app = {}) {
  const lastfm = app.lastfm || {};
  if (lastfm.enabled === false) return { level: "unknown", status: "disabled", detail: "Last.fm lookup off" };
  if (!lastfm.apiKeyConfigured) return { level: "warn", status: "API key missing", detail: "taste history unavailable" };
  if (!lastfm.usernameConfigured) return { level: "warn", status: "username missing", detail: "scrobble history unavailable" };
  if (lastfm.usernameValid === false) return { level: "bad", status: "username invalid", detail: "check LASTFM_USERNAME" };
  if (lastfm.configured) return { level: "ok", status: "connected", detail: "taste history available" };
  return { level: "unknown", status: "not checked", detail: "waiting for status" };
}

function tidalProfileMixesHealthSummary(app = {}) {
  const mixes = app.tidalProfileMixes || {};
  if (mixes.enabled === false) return { level: "unknown", status: "disabled", detail: "profile mixes off" };
  if (!mixes.configured) return { level: "warn", status: "profile token missing", detail: "personal mixes unavailable" };
  const circuit = mixes.circuit || {};
  if (circuit.state === "open") return { level: "bad", status: "backing off", detail: circuit.lastError || "profile fetch failed" };
  if (circuit.state === "half-open") return { level: "warn", status: "retrying", detail: circuit.lastError || "checking recovery" };
  if (mixes.lastError) return { level: "warn", status: "last fetch empty", detail: mixes.lastError };
  return { level: "ok", status: "ready", detail: "personal mixes available" };
}

function healthCardHtml(item = {}) {
  const level = providerHealthClass(item.level);
  return `
    <article class="healthCard ${level}">
      <div>
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.status || "")}</strong>
      </div>
      <small>${escapeHtml(item.detail || "")}</small>
    </article>
  `;
}

function renderSystemHealth() {
  const container = $("#systemHealth");
  if (!container) return;
  const app = state.appStatus || {};
  const connection = state.connectionStatus || {};
  const roon = connection.connected
    ? { level: "ok", label: "Roon", status: "connected", detail: connection.coreName || "Core ready" }
    : { level: "bad", label: "Roon", status: "not connected", detail: "extension not linked" };
  const tidal = circuitHealth(app.tidal || {}, { readyText: "ready" });
  const radioTidal = circuitHealth(app.radioMetadata || {}, { readyText: "ready" });
  const llm = llmHealthSummary(app);
  const lastfm = lastFmHealthSummary(app);
  const tidalProfile = tidalProfileMixesHealthSummary(app);
  const updatedAt = app.updatedAt ? `Updated ${formatDateTime(Date.parse(app.updatedAt))}` : "";

  container.innerHTML = `
    <div class="systemHealthHead">
      <span>System Health</span>
      ${updatedAt ? `<small>${escapeHtml(updatedAt)}</small>` : ""}
    </div>
    <div class="healthGrid">
      ${healthCardHtml(roon)}
      ${healthCardHtml({ label: "TIDAL Search", ...tidal })}
      ${healthCardHtml({ label: "Radio Art TIDAL", ...radioTidal })}
      ${healthCardHtml({ label: "TIDAL Profile", ...tidalProfile })}
      ${healthCardHtml({ label: "Local Model", ...llm })}
      ${healthCardHtml({ label: "Last.fm", ...lastfm })}
    </div>
  `;
}

function isLiveRadioZone(zone = {}) {
  const now = zone?.now_playing || {};
  if (Number(now.length || 0) > 0) return false;
  if (zone?.is_seek_allowed) return false;
  const text = [
    zone?.display_name,
    now.two_line?.line1,
    now.two_line?.line2,
    now.three_line?.line1,
    now.three_line?.line2
  ].filter(Boolean).join(" ");
  return /\b(?:di\.?fm|fm|radio|station|stream|live|premium)\b/i.test(text);
}

function queueRemainingCount(zone = {}, fallback = 0) {
  if (zone?.queue_items_remaining !== undefined && zone?.queue_items_remaining !== null) {
    const value = Number(zone.queue_items_remaining);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return Math.max(0, fallback);
}

function formatQueueInfo(zone) {
  if (isLiveRadioZone(zone)) return "Live radio - no fixed end";
  const queueItems = displayQueueItems(zone).length;
  const count = queueRemainingCount(zone, queueItems);
  const remaining = Math.max(0, Number(zone?.queue_time_remaining || 0));
  const time = formatQueueSeconds(remaining);
  if (count > 0 && time) return `${count} queued - ${time} left`;
  if (count > 0) return `${count} queued`;
  if (time) return `${time} remaining`;
  return "";
}

function formatDateTime(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatVolume(volume) {
  if (!volume) return "No volume control";
  if (volume.value === undefined || volume.value === null) return volume.is_muted ? "Muted" : "Step volume";
  return `${volume.value}${volume.unit || ""}${volume.is_muted ? " muted" : ""}`;
}

function isHqPlayerOutput(zone, output) {
  return /hqplayer/i.test(`${zone?.display_name || ""} ${output?.display_name || ""}`);
}

function hqplayerStatusFor(zone, output) {
  return output?.hqplayer || zone?.hqplayer || {};
}

function hqplayerOutputForZone(zone = {}) {
  return (zone.outputs || []).find((output) => isHqPlayerOutput(zone, output)) || null;
}

function hqplayerInlineSignal(zone = {}) {
  const output = hqplayerOutputForZone(zone);
  if (!output && !/hqplayer/i.test(zone?.display_name || "")) return "";
  const status = hqplayerStatusFor(zone, output || {});
  const filter = status.filter || "";
  const rate = [status.format, status.rate].filter(Boolean).join(" ");
  return [filter, rate].filter(Boolean).join(" ") || status.signalPath || "";
}

function zoneDisplayLabel(zone = {}) {
  const name = zone.display_name || "Unknown zone";
  const signal = hqplayerInlineSignal(zone);
  return signal ? `${name} ${signal}` : name;
}

function hqplayerSignalHtml(zone, output) {
  const status = hqplayerStatusFor(zone, output);
  const filter = status.filter || "";
  const rate = [status.format, status.rate].filter(Boolean).join(" ");
  const signalPath = status.signalPath || "";

  return `
    <div class="outputMain hqOutputMain">
      <strong>HQPlayer current filter and rate</strong>
      <div class="hqSignalRows">
        <p><span>Filter</span><b>${escapeHtml(filter || signalPath || "Waiting for HQPlayer filter")}</b></p>
        <p><span>Rate</span><b>${escapeHtml(rate || "Waiting for live rate")}</b></p>
      </div>
      ${signalPath && signalPath !== filter ? `<p class="muted hqSignalPath">${escapeHtml(signalPath)}</p>` : ""}
    </div>
  `;
}

function queueItemMatchesNow(item = {}, now = {}) {
  if (!item?.title || !now?.title) return false;
  const itemArtist = String(item.subtitle || "").split(/\s+-\s+/)[0] || item.subtitle || "";
  return titleMatchesNow(item.title, now.title) && artistMatchesNow(itemArtist, now.artist);
}

function displayQueueItems(zone = {}) {
  const items = Array.isArray(zone?.queue?.items) ? zone.queue.items : [];
  const now = summarizeNowPlaying(zone);
  if (!now?.title) return items;
  return items.filter((item) => !queueItemMatchesNow(item, now));
}

function liveQueueHtml(zone = {}) {
  const queue = zone.queue || {};
  const rawItems = Array.isArray(queue.items) ? queue.items : [];
  const items = displayQueueItems(zone);
  const remaining = queueRemainingCount(zone, items.length);
  const time = formatQueueSeconds(zone.queue_time_remaining || 0);
  const countLabel = remaining || items.length;
  const suffix = [
    countLabel ? `${countLabel} remaining` : "",
    time ? `${time} left` : ""
  ].filter(Boolean).join(" - ");

  if (!items.length && !remaining) return "";

  return `
    <div class="liveQueueHead">
      <strong>Roon queue</strong>
      ${suffix ? `<span>${escapeHtml(suffix)}</span>` : ""}
    </div>
    ${items.length ? `
      <ol>
        ${items.slice(0, 8).map((item) => `
          <li>
            ${item.imageKey ? `<span class="queueArt" style="background-image:url('/api/roon/image/${encodeURIComponent(item.imageKey)}?width=80&height=80')"></span>` : "<span class=\"queueArt queueArtEmpty\"></span>"}
            <span class="queueText">
              <strong>${escapeHtml(item.title || "Unknown track")}</strong>
              <small>${escapeHtml([item.subtitle, item.album].filter(Boolean).join(" - "))}</small>
            </span>
          </li>
        `).join("")}
      </ol>
    ` : (rawItems.length ? "<p>Current track removed from Rabbit Hole queue view.</p>" : "<p>Roon is reporting queued time, but has not sent the queue item list yet.</p>")}
  `;
}

function outputHtml(zone, output) {
  if (isHqPlayerOutput(zone, output)) {
    return `<div class="output hqOutput">${hqplayerSignalHtml(zone, output)}</div>`;
  }

  return `
    <div class="output">
      <div class="outputMain">
        <strong>${escapeHtml(output.display_name)}</strong>
        <p class="muted">${escapeHtml(formatVolume(output.volume))}</p>
      </div>
      ${output.volume ? `<div class="volumeButtons"><button data-output="${escapeHtml(output.output_id)}" data-volume="-1">Vol -</button><button data-output="${escapeHtml(output.output_id)}" data-volume="1">Vol +</button></div>` : ""}
    </div>
  `;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${path}`);
    }
  }
  if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function getJson(path) {
  const response = await fetch(path);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${path}`);
    }
  }
  if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function deleteJson(path, body) {
  const response = await fetch(path, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${path}`);
    }
  }
  if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function plainList(tracks) {
  return (tracks || []).map((track) => `${track.artist} - ${track.title}`).join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFetchDrop(error = {}) {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(String(error.message || error));
}

function normalizeKeyText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function trackKeyFor(track = {}) {
  const tidalUrl = String(track.tidal?.tidalUrl || track.tidalUrl || "").trim();
  if (tidalUrl) return tidalUrl.toLowerCase();
  return `${normalizeKeyText(track.artist)}|${normalizeKeyText(track.title)}`;
}

function savedVersionFor(tracks = []) {
  return (tracks || []).map((track) => `${track.key || trackKeyFor(track)}:${track.feedback || ""}:${track.savedAt || ""}`).join("|");
}

function normalizeSavedSnapshot(payload = {}) {
  if (Array.isArray(payload)) {
    return {
      activeListId: "default",
      lists: [{ id: "default", name: "Candidates", count: payload.length }],
      tracks: payload
    };
  }

  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  const lists = Array.isArray(payload.lists) && payload.lists.length
    ? payload.lists.map((list) => ({
      id: String(list.id || "").trim() || "default",
      name: String(list.name || "").trim() || "Candidates",
      count: Number(list.count ?? list.tracks?.length ?? 0),
      createdAt: list.createdAt || 0,
      updatedAt: list.updatedAt || 0
    }))
    : [{ id: "default", name: "Candidates", count: tracks.length }];
  const activeListId = lists.some((list) => list.id === payload.activeListId)
    ? payload.activeListId
    : lists[0].id;

  return { activeListId, lists, tracks };
}

function savedSnapshotVersion(snapshot = {}) {
  return [
    snapshot.activeListId || "",
    (snapshot.lists || []).map((list) => `${list.id}:${list.name}:${list.count}:${list.updatedAt || ""}`).join("|"),
    savedVersionFor(snapshot.tracks || [])
  ].join("||");
}

function applySavedSnapshot(payload = {}) {
  const snapshot = normalizeSavedSnapshot(payload);
  state.savedLists = snapshot.lists;
  state.activeSavedListId = snapshot.activeListId;
  state.savedTracks = applyFeedbackToTracks(snapshot.tracks || []);
  state.savedVersion = savedSnapshotVersion({ ...snapshot, tracks: state.savedTracks });
  return snapshot;
}

function activeSavedList() {
  return state.savedLists.find((list) => list.id === state.activeSavedListId) || state.savedLists[0] || {
    id: "default",
    name: "Candidates",
    count: state.savedTracks.length
  };
}

function savedListFilename(extension) {
  const slug = normalizeKeyText(activeSavedList().name).replace(/\s+/g, "-") || "playlist-candidates";
  return `rabbit-hole-${slug}.${extension}`;
}

function savedListOptionsHtml(selectedId = state.activeSavedListId) {
  const lists = state.savedLists.length ? state.savedLists : [activeSavedList()];
  return lists.map((list) => `
    <option value="${escapeHtml(list.id)}" ${list.id === selectedId ? "selected" : ""}>
      ${escapeHtml(list.name)}
    </option>
  `).join("");
}

function savedMoveOptionsHtml(sourceListId = state.activeSavedListId) {
  return (state.savedLists || [])
    .filter((list) => list.id !== sourceListId)
    .map((list) => `
      <option value="${escapeHtml(list.id)}">${escapeHtml(list.name)} (${Number(list.count || 0)})</option>
    `).join("");
}

function candidateListById(listId = "") {
  return state.savedLists.find((list) => list.id === listId) || activeSavedList();
}

function renderNowCandidateListMenu() {
  const menu = $("#nowCandidateListMenu");
  if (!menu) return;
  const lists = state.savedLists.length ? state.savedLists : [activeSavedList()];
  menu.innerHTML = lists.map((list) => `
    <button type="button" data-now-candidate-list="${escapeHtml(list.id)}">
      Add to ${escapeHtml(list.name)}${Number.isFinite(Number(list.count)) ? ` (${Number(list.count)})` : ""}
    </button>
  `).join("");
}

function toggleNowCandidateListMenu(show = null) {
  const menu = $("#nowCandidateListMenu");
  if (!menu) return;
  const nextVisible = show === null ? menu.hidden : Boolean(show);
  if (nextVisible) renderNowCandidateListMenu();
  menu.hidden = !nextVisible;
}

function updateNowCandidateSaveState(track = state.nowTrack) {
  const button = $("#saveNowCandidate");
  if (!button) return;
  if (!track) {
    button.disabled = true;
    button.textContent = "Add candidate";
    toggleNowCandidateListMenu(false);
    return;
  }

  button.disabled = false;
  button.textContent = "Add candidate";
  button.title = "Choose a candidate list";
  renderNowCandidateListMenu();
}

function feedbackMapFromServer(feedback = {}) {
  const map = {};
  for (const [key, entry] of Object.entries(feedback || {})) {
    const rating = typeof entry === "string" ? entry : entry?.rating;
    if (!rating) continue;
    map[String(key).toLowerCase()] = rating;
    const normalizedKey = trackKeyFor({
      artist: entry?.artist || "",
      title: entry?.title || "",
      tidalUrl: entry?.tidalUrl || ""
    });
    if (normalizedKey && normalizedKey !== "|") map[normalizedKey] = rating;
  }
  return map;
}

function applyFeedbackToTrack(track = {}) {
  const key = trackKeyFor(track);
  return key && state.feedbackByKey[key] ? { ...track, feedback: state.feedbackByKey[key] } : track;
}

function applyFeedbackToTracks(tracks = []) {
  return (tracks || []).map(applyFeedbackToTrack);
}

function calibrationVersion(calibration = null) {
  if (!calibration) return "";
  return JSON.stringify({
    total: calibration.total || 0,
    reviewed: calibration.reviewed || 0,
    promptMismatches: calibration.promptMismatches || 0,
    modelMisses: calibration.modelMisses || 0,
    badBoosts: calibration.badBoosts || 0,
    missedLikes: calibration.missedLikes || 0,
    updatedAt: calibration.updatedAt || "",
    recent: (calibration.recent || []).map((item) => `${item.recordedAt || ""}:${item.rating || ""}:${item.modelAction || ""}:${item.artist || ""}:${item.title || ""}`)
  });
}

function applyCalibration(calibration = null) {
  const nextVersion = calibrationVersion(calibration);
  if (nextVersion === state.calibrationVersion) return false;
  state.calibration = calibration || null;
  state.calibrationVersion = nextVersion;
  if (state.lastResult) {
    state.lastResult.verification = {
      ...(state.lastResult.verification || {}),
      feedbackCalibration: state.calibration
    };
    showSourceReport(state.lastResult);
  }
  return true;
}

function applyFeedbackResponse(result = {}) {
  const calibration = result.profile?.calibration || null;
  if (calibration) applyCalibration(calibration);
}

function renderMemoryStatus() {
  const element = $("#memoryStatus");
  if (!element) return;
  const memory = state.memory || {};
  const count = Number(memory.count || 0);
  const mb = Number(memory.mb || 0);
  const maxMb = Number(memory.maxMb || 250);
  element.textContent = `Track memory: ${count} remembered track${count === 1 ? "" : "s"} - ${mb.toFixed(2)} MB / ${maxMb} MB`;
}

function isSavedCandidate(track = {}) {
  const key = trackKeyFor(track);
  return Boolean(key && key !== "|" && state.savedTracks.some((saved) => saved.key === key || trackKeyFor(saved) === key));
}

function textList(value) {
  if (Array.isArray(value)) return value.join("; ");
  return String(value || "");
}

function csvForTracks(tracks) {
  const headers = [
    "artist",
    "title",
    "album",
    "label",
    "year",
    "releaseDate",
    "duration",
    "discoveryScore",
    "scoreBand",
    "freshness",
    "labelMatch",
    "artistMatch",
    "lengthPreference",
    "genreMatch",
    "tasteAdjustment",
    "feedback",
    "discoverySource",
    "whyMatched",
    "status",
    "tidalUrl",
    "why"
  ];
  const rows = (tracks || []).map((track) => [
    track.artist,
    track.title,
    track.album,
    track.label || track.tidal?.label || "",
    track.year || "",
    track.releaseDate || track.tidal?.releaseDate || "",
    formatDuration(track.durationMs),
    track.score || track.scoreBreakdown?.total || "",
    scoreBandFor(track.score || track.scoreBreakdown?.total).label,
    track.scoreBreakdown?.freshness || "",
    track.scoreBreakdown?.labelMatch || "",
    track.scoreBreakdown?.artistMatch || "",
    track.scoreBreakdown?.lengthPreference || "",
    track.scoreBreakdown?.genreMatch || "",
    track.scoreBreakdown?.tasteAdjustment || "",
    track.feedback || "",
    track.discoverySource || "",
    textList(track.why),
    textList(track.statusChecks),
    track.tidal?.tidalUrl || "",
    track.reason || ""
  ]);
  return [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`).join(",")).join("\r\n");
}

function downloadCsv(filename, tracks) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csvForTracks(tracks)], { type: "text/csv" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function scoreBandFor(scoreValue) {
  const score = Number(scoreValue || 0);
  if (score >= 90) return { label: "Excellent", className: "excellent" };
  if (score >= 80) return { label: "Strong", className: "strong" };
  if (score >= 70) return { label: "Worth checking", className: "worth" };
  if (score >= 60) return { label: "Experimental", className: "experimental" };
  return { label: "Long shot", className: "longshot" };
}

function minimumScoreLabel(scoreValue) {
  const score = Number(scoreValue || 0);
  return score > 0 ? `${scoreBandFor(score).label}+` : "verified";
}

function compactScoreBadgeHtml(track) {
  const score = track?.score || track?.scoreBreakdown?.total || "";
  if (!score) return "";
  const band = scoreBandFor(score);
  const suffix = track?.belowMinimum ? " - below minimum" : "";
  return `<span class="scoreBadge ${escapeHtml(band.className)}">Discovery ${escapeHtml(score)} - ${escapeHtml(band.label)}${escapeHtml(suffix)}</span>`;
}

function trackPayload(track = {}) {
  const { _resultIndex, ...payload } = track || {};
  return payload;
}

function artistCreditConfirmed(track = {}) {
  const checks = Array.isArray(track.statusChecks) ? track.statusChecks.join(" ") : "";
  return Boolean(track.roon?.artistCreditConfirmed || /Exact artist credit confirmed/i.test(checks));
}

function roonVisibleTrack(track = {}) {
  const source = `${track.discoverySource || ""} ${track.verificationSource || ""}`;
  return Boolean(track.roon?.verified || /\bRoon\b/i.test(source));
}

function artistConfirmationBadgeHtml(track = {}) {
  if (!roonVisibleTrack(track)) return "";
  if (artistCreditConfirmed(track)) {
    const artist = track.roon?.artistCreditConfirmed || "";
    return `<span class="artistCreditBadge exact" title="Roon artist credit matched exactly">${artist ? `Exact artist: ${escapeHtml(artist)}` : "Exact artist"}</span>`;
  }
  return `<span class="artistCreditBadge broad" title="Roon found this through broader search, not exact artist crawl">Broader Roon match</span>`;
}

function displayedResultTracks(tracks = []) {
  const entries = (tracks || []).map((track, resultIndex) => ({ ...track, _resultIndex: resultIndex }));
  return state.resultArtistConfirmedOnly
    ? entries.filter(artistCreditConfirmed)
    : entries;
}

function updateResultTrackFeedback(updatedTrack = {}, rating = "") {
  const key = trackKeyFor(updatedTrack);
  if (!key) return;
  const apply = (track) => (trackKeyFor(track) === key ? { ...track, feedback: rating } : track);
  if (state.lastResult?.tracks) state.lastResult.tracks = state.lastResult.tracks.map(apply);
  state.lastTracks = state.lastTracks.map(apply);
  state.displayedTracks = state.displayedTracks.map(apply);
}

function resultDiagnosticsFor(track = {}) {
  const breakdown = track.scoreBreakdown || {};
  const score = Number(track.score || breakdown.total || 0);
  const promptPercent = Number(breakdown.promptMatch?.percent ?? track.promptMatch?.percent ?? 0);
  const genreMatch = Number(breakdown.genreMatch ?? 0);
  const genreInference = breakdown.genreInference || {};
  const genreConfidence = Number(genreInference.confidence || 0);
  const kept = [];
  const risks = [];
  const checks = Array.isArray(track.statusChecks) ? track.statusChecks.join(" ") : "";
  const titleAlbum = `${track.title || ""} ${track.album || ""}`;
  const titleAlbumNormalized = normalizeMatchText(titleAlbum);
  const label = track.label || track.tidal?.label || "";
  const durationMs = Number(track.durationMs || track.tidal?.durationMs || 0);

  if (track.roon?.verified || /Roon queue action ready/i.test(checks)) kept.push("Roon queueable");
  if (track.tidal?.verified || track.tidal?.tidalUrl || track.tidalUrl) kept.push("TIDAL verified");
  if (track.releaseDate || track.year || track.tidal?.releaseDate || track.tidal?.year) kept.push("date matched");
  if (label) kept.push(`${label} label metadata`);
  if (/Not previously suggested/i.test(checks)) kept.push("not previously suggested");
  if (durationMs) kept.push(`${formatDuration(durationMs)} playable length`);
  if (genreConfidence >= 45 && genreInference.summary) kept.push(`genre inferred from ${genreInference.summary}`);
  if (breakdown.tasteAdjustment > 0) kept.push("taste signal boost");
  if (track.discoveryLane === "adjacent") kept.push("adjacent discovery lane");
  if (track.autoBroadened) kept.push("broadened search pass");
  if (artistCreditConfirmed(track)) kept.push("exact artist credit confirmed");
  if (!kept.length) kept.push(track.discoverySource || "closest catalogue match");

  if (track.belowMinimum) risks.push(`below ${track.minimumScoreLabel || "minimum"} floor`);
  if (score && score < 60) risks.push("long-shot score");
  if (promptPercent && promptPercent < 50) risks.push("weak prompt match");
  if (genreMatch && genreMatch < 12 && genreConfidence < 35) risks.push("weak inferred genre evidence");
  if (genreInference.weakOfficialGenre && genreConfidence < 45) risks.push("official genre tag is generic");
  if (!label) risks.push("no trusted label metadata");
  if (durationMs && durationMs < 240000) risks.push("short track length");
  if (track.discoveryQuotaRisk) risks.push("feedback calibration risk");
  if (/Roon verification timed out/i.test(checks)) risks.push("Roon action not verified");
  if (roonVisibleTrack(track) && !artistCreditConfirmed(track)) risks.push("broader Roon match");
  if (/\b(?:edm|house|techno|trance|progressive|melodic|deep|vibes?|fusions?|mix 20\d{2}|playlist|hits?)\b/.test(titleAlbumNormalized) &&
      (titleAlbum.includes("/") || /\b(?:vibes?|fusions?|playlist|hits?|mix 20\d{2})\b/.test(titleAlbumNormalized))) {
    risks.push("generic genre-title wording");
  }

  const show = Boolean(
    track.belowMinimum ||
    (score && score < 60) ||
    (promptPercent && promptPercent < 55) ||
    track.discoveryQuotaRisk ||
    risks.length >= 2
  );

  return {
    show,
    kept: Array.from(new Set(kept)).slice(0, 4),
    risks: Array.from(new Set(risks)).slice(0, 4)
  };
}

function resultDiagnosticsHtml(track = {}, index = 0) {
  const diagnostics = resultDiagnosticsFor(track);
  if (!diagnostics.show) return "";
  const rejected = normalizeFeedbackValue(track.feedback) === "reject_similar";
  return `
    <div class="resultDiagnostics">
      <div class="resultDiagnosticsHead">
        <span>Why is this here?</span>
        <button type="button" data-reject-similar="${index}" ${rejected ? "disabled" : ""}>${rejected ? "Rejected similar" : "Reject similar"}</button>
      </div>
      <p><strong>Kept because:</strong> ${escapeHtml(diagnostics.kept.join(", "))}</p>
      <p><strong>Risk:</strong> ${escapeHtml((diagnostics.risks.length ? diagnostics.risks : ["limited metadata support"]).join(", "))}</p>
    </div>
  `;
}

function normalizeFeedbackValue(value) {
  const rating = String(value || "").toLowerCase();
  if (rating === "love") return "love";
  if (rating === "good" || rating === "up") return "good";
  if (rating === "ok" || rating === "okay") return "ok";
  if (rating === "wrong_genre" || rating === "wrong genre" || rating === "wrong" || rating === "not what i asked for" || rating === "not_asked") return "wrong_genre";
  if (rating === "reject_similar" || rating === "reject similar" || rating === "similar_bad" || rating === "similar") return "reject_similar";
  if (rating === "skip" || rating === "down") return "skip";
  if (rating === "never" || rating === "never_again" || rating === "never again") return "never";
  return "";
}

function feedbackButtonsHtml(track, index, prefix = "") {
  const feedback = normalizeFeedbackValue(track?.feedback || "");
  const attr = prefix ? `data-${prefix}-feedback` : "data-feedback";
  const indexAttr = prefix ? `data-${prefix}-index` : "data-index";
  const options = [
    { value: "love", label: "&#10084;&#65039; Love", aria: "Love" },
    { value: "good", label: "&#128077; Good", aria: "Good" },
    { value: "ok", label: "&#128076; OK", aria: "OK" },
    { value: "wrong_genre", label: "Wrong Genre", aria: "Not what I asked for" },
    { value: "skip", label: "&#128078; Skip", aria: "Skip" },
    { value: "never", label: "&#128683; Never Again", aria: "Never Again" }
  ];
  return options.map((option) => `
    <button type="button" class="feedbackButton ${escapeHtml(option.value)} ${feedback === option.value ? "active" : ""}" ${attr}="${escapeHtml(option.value)}" ${indexAttr}="${index}" aria-label="${escapeHtml(option.aria)}" title="${escapeHtml(option.aria)}" aria-pressed="${feedback === option.value}">${option.label}</button>
  `).join("");
}

function displayArtists(value) {
  return String(value || "")
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part && part.length <= 70);
}

function remixersFromTitle(title) {
  const remixers = [];
  for (const match of String(title || "").matchAll(/[\[(]([^)\]]*(?:remix|rework|rerub|dub|edit|mix)[^)\]]*)[\])]/gi)) {
    const text = match[1]
      .replace(/\b(?:original|extended|club|radio|vocal|instrumental|dub|edit|mix|remix|rework|rerub|version)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text && !/^original$/i.test(text)) remixers.push(text);
  }
  return Array.from(new Set(remixers));
}

function rabbitHoleTextFor(track = {}) {
  const artists = displayArtists(track.artist || track.tidal?.artist);
  const label = track.label || track.tidal?.label || "";
  const primaryArtist = artists[0] || track.artist || "this artist";
  return `Find tracks like ${primaryArtist}${label ? ` connected to ${label}` : ""}, but go deeper and less obvious. Follow the prompt intent first, avoid repeats, and only return Roon-queueable matches.`;
}

function rabbitNodePayload(node = {}) {
  return escapeHtml(JSON.stringify({
    type: node.type,
    name: node.name,
    prompt: node.prompt,
    track: node.track || null
  }));
}

function rabbitNodeHtml(node = {}, extra = false) {
  const meta = [
    node.type,
    node.source || (node.sources || [])[0] || "",
    node.track?.releaseDate || node.track?.year || "",
    node.track?.durationMs ? formatDuration(node.track.durationMs) : ""
  ].filter(Boolean).join(" - ");
  return `
    <button type="button" class="rabbitNode rabbitNode-${escapeHtml(node.type || "entity")}${extra ? " rabbitNodeExtra" : ""}" data-rabbit-node='${rabbitNodePayload(node)}'>
      <strong>${escapeHtml(node.name || "Unknown")}</strong>
      ${meta ? `<span>${escapeHtml(meta)}</span>` : ""}
    </button>
  `;
}

function rabbitSectionLimit(section = {}) {
  if (section.id === "artist") return 4;
  if (section.id === "collaborators") return 8;
  if (section.id === "labels") return 8;
  if (section.id === "relatedArtists") return 8;
  return 6;
}

function rabbitSectionHtml(section = {}) {
  const items = section.items || [];
  const limit = rabbitSectionLimit(section);
  const visible = items.slice(0, limit);
  const extra = items.slice(limit);
  return `
    <section class="rabbitDepth rabbitDepth${escapeHtml(section.depth || 1)}">
      <div class="rabbitDepthHead">
        <div>
          <span>Depth ${escapeHtml(section.depth || 1)}</span>
          <strong>${escapeHtml(section.label || "Rabbit Hole")}</strong>
        </div>
        <em>${escapeHtml(items.length)} found</em>
      </div>
      <div class="rabbitNodes">
        ${items.length ? [
          ...visible.map((item) => rabbitNodeHtml(item)),
          ...extra.map((item) => rabbitNodeHtml(item, true)),
          extra.length ? `<button type="button" class="rabbitMore" data-rabbit-more="${extra.length}">Show ${extra.length} more</button>` : ""
        ].join("") : "<p class=\"muted\">No concrete entities found yet.</p>"}
      </div>
    </section>
  `;
}

function rabbitHoleGraphHtml(graph = {}) {
  const seed = graph.seed || {};
  const sections = graph.sections || {};
  const provider = graph.providerStatus || {};
  const ordered = [
    sections.artist,
    sections.collaborators,
    sections.labels,
    sections.relatedArtists,
    sections.hiddenGems,
    sections.deepCatalog
  ].filter(Boolean);

  return `
    <div class="rabbitHero">
      <div>
        <p class="eyebrow">Rabbit Hole Graph ${graph.cached ? "- cached" : ""}</p>
        <h3>${escapeHtml(seed.title || "Current track")}</h3>
        <p>${escapeHtml([seed.artist, seed.label, seed.year].filter(Boolean).join(" - "))}</p>
      </div>
      <div class="rabbitHeroActions">
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.artist || rabbitHoleTextFor(seed))}">Explore Artist</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.label || graph.prompts?.artist || "")}">Explore Label</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.similarArtists || graph.prompts?.artist || "")}">Similar Artists</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.hiddenGems || graph.prompts?.artist || "")}">Hidden Gems</button>
        <button type="button" data-rabbit-prompt="${escapeHtml(graph.prompts?.graph || graph.prompts?.artist || "")}">Generate Prompt</button>
        <button type="button" data-rabbit-run="${escapeHtml(graph.prompts?.graph || graph.prompts?.artist || "")}">Run Discovery</button>
        <button type="button" data-rabbit-refresh="true">Refresh Graph</button>
      </div>
    </div>
    <div class="rabbitProviderStatus">
      ${Object.entries(provider).map(([key, value]) => `<span>${escapeHtml(key)}: ${escapeHtml(value)}</span>`).join("")}
    </div>
    <div class="rabbitDepths">
      ${ordered.map(rabbitSectionHtml).join("")}
    </div>
  `;
}

function setRabbitPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return;
  $("#request").value = text;
  const genres = document.querySelector("[name='genres']");
  const mood = document.querySelector("[name='mood']");
  const years = document.querySelector("[name='years']");
  const count = document.querySelector("[name='count']");
  if (genres && !genres.value.trim()) genres.value = "";
  if (mood && !mood.value.trim()) mood.value = "";
  if (years && !years.value.trim()) years.value = "";
  if (count && !count.value.trim()) count.value = "";
  document.querySelector(".composer")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function runRabbitPrompt(prompt) {
  setRabbitPrompt(prompt);
  $("#playlistForm").requestSubmit();
}

function jumpToTrackIdentity(track = {}) {
  const key = trackKeyFor(track);
  const currentIndex = state.lastTracks.findIndex((candidate) => trackKeyFor(candidate) === key);
  if (currentIndex >= 0) {
    scrollToDiscoveryTrack(currentIndex);
    return true;
  }
  const savedIndex = state.savedTracks.findIndex((candidate) => trackKeyFor(candidate) === key);
  if (savedIndex >= 0) {
    scrollToSavedTrack(savedIndex);
    return true;
  }
  if (track.tidalUrl || track.tidal?.tidalUrl) {
    window.open(track.tidalUrl || track.tidal.tidalUrl, "_blank", "noreferrer");
    return true;
  }
  return false;
}

async function loadRabbitHole(track, { force = false } = {}) {
  const panel = $("#rabbitHolePanel");
  const content = $("#rabbitHoleContent");
  if (!panel || !content || !track) return;
  const key = trackKeyFor(track);
  if (!force && state.rabbitHoleGraph && state.rabbitHoleKey === key) {
    content.innerHTML = rabbitHoleGraphHtml(state.rabbitHoleGraph);
    cleanRenderedArtifacts(content);
    return;
  }

  content.innerHTML = "<p class=\"muted\">Building Rabbit Hole graph...</p>";
  try {
    const graph = await api("/api/rabbit-hole", {
      track,
      force,
      contextTracks: rabbitHoleContextTracks()
    });
    state.rabbitHoleGraph = graph;
    state.rabbitHoleKey = key;
    content.innerHTML = rabbitHoleGraphHtml(graph);
    cleanRenderedArtifacts(content);
  } catch (error) {
    content.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function scrollToDiscoveryTrack(index) {
  const target = document.getElementById(`track-${index}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("trackFocus");
  setTimeout(() => target.classList.remove("trackFocus"), 1800);
}

function scrollToSavedTrack(index) {
  const target = document.getElementById(`saved-track-${index}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("trackFocus");
  setTimeout(() => target.classList.remove("trackFocus"), 1800);
}

function scrollToCandidatesList() {
  const target = $("#candidatesPanel");
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("trackFocus");
  setTimeout(() => target.classList.remove("trackFocus"), 1800);
}

function nowPlayingBadgeHtml(track = {}, source = "") {
  const scoreBadge = compactScoreBadgeHtml(track);
  if (scoreBadge) return scoreBadge;
  const label = source === "saved" ? "Saved candidate" : source === "memory" ? "Remembered track" : "Unscored now playing";
  return `<span class="scoreBadge unscored">${escapeHtml(label)}</span>`;
}

function selectedTidalPlaylist() {
  return state.tidalPlaylists.find((playlist) => playlist.id === state.selectedTidalPlaylistId) || state.tidalPlaylists[0] || null;
}

function selectedTidalSeedPlaylist() {
  return state.tidalPlaylists.find((playlist) => playlist.id === state.selectedTidalSeedPlaylistId) || state.tidalPlaylists[0] || null;
}

function tidalPlaylistOptionsKey() {
  return state.tidalPlaylists.map((playlist) => `${playlist.id}:${playlist.title}:${Number(playlist.itemCount || 0)}`).join("|");
}

function tidalPlaylistOptionsHtml() {
  return state.tidalPlaylists.map((playlist) => {
    const count = Number(playlist.itemCount || 0);
    const suffix = count ? ` (${count})` : "";
    return `<option value="${escapeHtml(playlist.id)}">${escapeHtml(playlist.title + suffix)}</option>`;
  }).join("");
}

function setSelectOptionsIfChanged(select, html, renderKey) {
  if (select.dataset.renderKey === renderKey) return;
  const currentValue = select.value;
  select.innerHTML = html;
  select.dataset.renderKey = renderKey;
  if (currentValue && Array.from(select.options).some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function renderNowTidalPlaylistControl(track = state.nowTrack) {
  const select = $("#nowTidalPlaylistSelect");
  const button = $("#addNowToTidalPlaylist");
  const status = $("#nowTidalPlaylistStatus");
  if (!select || !button || !status) return;

  if (state.tidalPlaylistsLoading) {
    setSelectOptionsIfChanged(select, "<option value=\"\">Loading TIDAL playlists...</option>", "loading");
    select.disabled = true;
    button.disabled = true;
    status.textContent = "";
    return;
  }

  if (state.tidalPlaylistsError) {
    setSelectOptionsIfChanged(select, "<option value=\"\">TIDAL playlists unavailable</option>", `error:${state.tidalPlaylistsError}`);
    select.disabled = false;
    button.disabled = true;
    status.textContent = state.tidalPlaylistsError;
    return;
  }

  if (!state.tidalPlaylistsLoaded) {
    setSelectOptionsIfChanged(select, "<option value=\"\">Load TIDAL playlists...</option>", "not-loaded");
    select.disabled = true;
    button.disabled = true;
    status.textContent = "";
    return;
  }

  if (!state.tidalPlaylists.length) {
    setSelectOptionsIfChanged(select, "<option value=\"\">No TIDAL playlists found</option>", "empty");
    select.disabled = false;
    button.disabled = true;
    status.textContent = "Create a playlist in TIDAL, then open this selector to refresh.";
    return;
  }

  if (!state.tidalPlaylists.some((playlist) => playlist.id === state.selectedTidalPlaylistId)) {
    state.selectedTidalPlaylistId = state.tidalPlaylists[0].id;
    localStorage.setItem("tidalPlaylistId", state.selectedTidalPlaylistId);
  }
  setSelectOptionsIfChanged(select, tidalPlaylistOptionsHtml(), `ready:${tidalPlaylistOptionsKey()}`);
  if (select.value !== state.selectedTidalPlaylistId) select.value = state.selectedTidalPlaylistId;
  select.disabled = false;
  button.disabled = !track || !state.selectedTidalPlaylistId;
}

function renderTidalPlaylistSeedControl() {
  const select = $("#tidalPlaylistSeedSelect");
  const button = $("#useTidalPlaylistSeed");
  const status = $("#tidalPlaylistSeedStatus");
  if (!select || !button || !status) return;

  if (state.tidalPlaylistsLoading) {
    setSelectOptionsIfChanged(select, "<option value=\"\">Loading TIDAL playlists...</option>", "loading");
    select.disabled = true;
    button.disabled = true;
    status.textContent = "Loading TIDAL playlists...";
    return;
  }

  if (state.tidalPlaylistsError) {
    setSelectOptionsIfChanged(select, "<option value=\"\">TIDAL playlists unavailable</option>", `error:${state.tidalPlaylistsError}`);
    select.disabled = false;
    button.disabled = true;
    status.textContent = state.tidalPlaylistsError;
    return;
  }

  if (!state.tidalPlaylistsLoaded) {
    setSelectOptionsIfChanged(select, "<option value=\"\">Load TIDAL playlists...</option>", "not-loaded");
    select.disabled = false;
    button.disabled = true;
    status.textContent = "Refresh TIDAL to load playlists.";
    return;
  }

  if (!state.tidalPlaylists.length) {
    setSelectOptionsIfChanged(select, "<option value=\"\">No TIDAL playlists found</option>", "empty");
    select.disabled = false;
    button.disabled = true;
    status.textContent = "No TIDAL playlists found";
    return;
  }

  if (!state.tidalPlaylists.some((playlist) => playlist.id === state.selectedTidalSeedPlaylistId)) {
    state.selectedTidalSeedPlaylistId = state.tidalPlaylists[0].id;
    localStorage.setItem("tidalSeedPlaylistId", state.selectedTidalSeedPlaylistId);
  }
  setSelectOptionsIfChanged(select, tidalPlaylistOptionsHtml(), `ready:${tidalPlaylistOptionsKey()}`);
  if (select.value !== state.selectedTidalSeedPlaylistId) select.value = state.selectedTidalSeedPlaylistId;
  select.disabled = false;
  button.disabled = !state.selectedTidalSeedPlaylistId;
  if (!status.textContent || /^(?:Loading|Refresh TIDAL|No TIDAL|TIDAL playlists unavailable)/i.test(status.textContent)) {
    status.textContent = `${state.tidalPlaylists.length} TIDAL playlists available`;
  }
}

async function loadTidalPlaylists({ force = false } = {}) {
  if (state.tidalPlaylistsLoading) return;
  if (!force && state.tidalPlaylistsLoaded) {
    renderNowTidalPlaylistControl();
    renderTidalPlaylistSeedControl();
    return;
  }
  state.tidalPlaylistsLoading = true;
  state.tidalPlaylistsError = "";
  renderNowTidalPlaylistControl();
  renderTidalPlaylistSeedControl();
  try {
    const result = await getJson(`/api/tidal/playlists${force ? "?refresh=1" : ""}`);
    state.tidalPlaylists = Array.isArray(result.playlists) ? result.playlists : [];
    state.tidalPlaylistsLoaded = true;
    state.tidalPlaylistsError = result.connected === false ? (result.error || "Connect TIDAL profile access first.") : "";
  } catch (error) {
    state.tidalPlaylists = [];
    state.tidalPlaylistsLoaded = false;
    state.tidalPlaylistsError = error.message;
  } finally {
    state.tidalPlaylistsLoading = false;
    renderNowTidalPlaylistControl();
    renderTidalPlaylistSeedControl();
  }
}

async function addNowTrackToTidalPlaylist(button = $("#addNowToTidalPlaylist")) {
  const track = state.nowTrack || nowPlayingTrack(activeZone());
  const playlist = selectedTidalPlaylist();
  const status = $("#nowTidalPlaylistStatus");
  if (!track) return alert("There is no current track to add.");
  if (!playlist?.id) return alert("Choose a TIDAL playlist first.");

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Adding...";
  if (status) status.textContent = "";
  try {
    const result = await api("/api/tidal/playlist-track", {
      playlistId: playlist.id,
      playlistTitle: playlist.title,
      track
    });
    button.textContent = "Added";
    if (status) {
      const title = result.track?.title || track.title || "Current track";
      const artist = result.track?.artist || track.artist || "";
      status.textContent = `Added ${[artist, title].filter(Boolean).join(" - ")} to ${playlist.title}.`;
    }
  } catch (error) {
    button.textContent = originalText;
    if (status) status.textContent = error.message;
    alert(error.message);
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !state.nowTrack || !selectedTidalPlaylist();
    }, 900);
  }
}

function updateNowDiscoveryTools(zone = activeZone()) {
  const tools = $("#nowDiscoveryTools");
  const feedback = $("#nowFeedback");
  const badge = $("#nowDiscoveryBadge");
  const saveNow = $("#saveNowCandidate");
  const jumpCandidates = $("#jumpToCandidatesList");
  const openRabbitHole = $("#openRabbitHole");
  const rabbitHolePanel = $("#rabbitHolePanel");
  if (!tools || !feedback || !badge || !saveNow || !jumpCandidates || !openRabbitHole || !rabbitHolePanel) return;

  const match = findNowPlayingMatch(zone);
  state.nowMatchIndex = match.index;
  state.nowSavedIndex = match.savedIndex;
  state.nowTrack = match.track;
  state.nowTrackSource = match.source;

  if (!match.track) {
    tools.hidden = true;
    feedback.innerHTML = "";
    feedback.dataset.renderKey = "";
    badge.innerHTML = "";
    updateNowCandidateSaveState(null);
    renderNowTidalPlaylistControl(null);
    jumpCandidates.disabled = true;
    openRabbitHole.disabled = true;
    rabbitHolePanel.hidden = true;
    return;
  }

  tools.hidden = false;
  const feedbackRenderKey = `${trackKeyFor(match.track)}|${normalizeFeedbackValue(match.track.feedback || "")}`;
  if (feedback.dataset.renderKey !== feedbackRenderKey) {
    feedback.innerHTML = feedbackButtonsHtml(match.track, 0, "now");
    feedback.dataset.renderKey = feedbackRenderKey;
  }
  badge.innerHTML = nowPlayingBadgeHtml(match.track, match.source);
  updateNowCandidateSaveState(match.track);
  renderNowTidalPlaylistControl(match.track);
  if (!state.tidalPlaylistsLoaded && !state.tidalPlaylistsLoading && !state.tidalPlaylistsError) {
    loadTidalPlaylists().catch(() => {});
  }
  jumpCandidates.disabled = false;
  jumpCandidates.title = `Jump to ${activeSavedList().name}`;
  openRabbitHole.disabled = false;
  if (!rabbitHolePanel.hidden) {
    const nextKey = trackKeyFor(match.track);
    if (state.rabbitHoleKey !== nextKey) {
      loadRabbitHole(match.track).catch(() => {});
    }
  }
  cleanRenderedArtifacts(tools);
}

function setFeedbackButtonsActive(container, rating) {
  const normalized = normalizeFeedbackValue(rating);
  container.querySelectorAll(".feedbackButton").forEach((button) => {
    const buttonRating = normalizeFeedbackValue(button.dataset.nowFeedback || button.dataset.feedback);
    const active = buttonRating === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  container.dataset.renderKey = `${trackKeyFor(state.nowTrack)}|${normalized}`;
}

function scoreBreakdownHtml(track) {
  const breakdown = track.scoreBreakdown || {};
  const score = track.score || breakdown.total || "";
  if (!score && !Object.keys(breakdown).length) return "";
  const band = scoreBandFor(score);

  const rows = [
    ["Freshness", breakdown.freshness, breakdown.max?.freshness || SCORE_MAX.freshness],
    ["Label Match", breakdown.labelMatch, breakdown.max?.labelMatch || SCORE_MAX.labelMatch],
    ["Artist Match", breakdown.artistMatch, breakdown.max?.artistMatch || SCORE_MAX.artistMatch],
    ["Length Preference", breakdown.lengthPreference, breakdown.max?.lengthPreference || SCORE_MAX.lengthPreference],
    ["Genre Match", breakdown.genreMatch, breakdown.max?.genreMatch || SCORE_MAX.genreMatch]
  ].filter((row) => row[1] !== undefined && row[1] !== null && row[1] !== "");

  if (breakdown.genreInference?.confidence) {
    rows.push(["Genre Confidence", breakdown.genreInference.confidence, 100]);
  }

  if (breakdown.tasteAdjustment) {
    rows.push(["Taste Adjustment", breakdown.tasteAdjustment, 12]);
  }
  if (breakdown.artistDiversityAdjustment) {
    rows.push(["Artist Diversity Adjustment", breakdown.artistDiversityAdjustment, 12]);
  }
  if (breakdown.calibrationAdjustment) {
    rows.push(["Calibration Adjustment", breakdown.calibrationAdjustment, 10]);
  }

  return `
    <div class="scoreBox">
      <div class="scoreTotal">
        <span>Discovery Score: <strong>${escapeHtml(score)}</strong></span>
        <span class="scoreBadge ${escapeHtml(band.className)}">${escapeHtml(track.belowMinimum ? `${band.label} - below minimum` : band.label)}</span>
      </div>
      <div class="scoreGrid">
        ${rows.map(([label, value, max]) => `
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}${label.endsWith("Adjustment") ? "" : `/${escapeHtml(max)}`}</strong>
        `).join("")}
      </div>
    </div>
  `;
}

function matchSplitHtml(track) {
  const breakdown = track.scoreBreakdown || {};
  const prompt = breakdown.promptMatch || track.promptMatch || {};
  const taste = breakdown.tasteMatch || track.tasteMatch || {};
  const genre = breakdown.matchGenre || track.matchGenre || "";
  const why = Array.isArray(breakdown.matchWhy) && breakdown.matchWhy.length
    ? breakdown.matchWhy
    : (Array.isArray(track.matchWhy) ? track.matchWhy : []);
  const hasPrompt = prompt.percent !== undefined && prompt.percent !== null && prompt.percent !== "";
  const hasTaste = taste.percent !== undefined && taste.percent !== null && taste.percent !== "";
  if (!hasPrompt && !hasTaste && !genre && !why.length) return "";

  return `
    <div class="matchInsight">
      <div class="matchMeters">
        ${hasPrompt ? `
          <div class="matchMeter prompt">
            <span>Prompt Match</span>
            <strong>${escapeHtml(prompt.percent)}%</strong>
            ${prompt.label ? `<em>${escapeHtml(prompt.label)}</em>` : ""}
          </div>
        ` : ""}
        ${hasTaste ? `
          <div class="matchMeter taste">
            <span>Taste Match</span>
            <strong>${escapeHtml(taste.percent)}%</strong>
            ${taste.label ? `<em>${escapeHtml(taste.label)}</em>` : ""}
          </div>
        ` : ""}
      </div>
      ${genre ? `<p class="matchGenre"><span>Genre:</span> <strong>${escapeHtml(genre)}</strong></p>` : ""}
      ${why.length ? `
        <div class="matchWhy">
          <span>Why:</span>
          <ul>${why.slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      ` : ""}
    </div>
  `;
}

function whyMatchedHtml(track) {
  const bullets = Array.isArray(track.why) && track.why.length
    ? track.why
    : (track.reason ? String(track.reason).split(/\s*;\s*/).filter(Boolean) : []);
  if (!bullets.length) return "";
  return `
    <div class="reasonBlock">
      <p class="reasonTitle">Why this matched</p>
      <ul>
        ${bullets.slice(0, 6).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function statusChecksHtml(track) {
  const statuses = Array.isArray(track.statusChecks) && track.statusChecks.length
    ? track.statusChecks
    : ["TIDAL verified", "History status not checked"];
  return `
    <div class="statusBlock">
      ${statuses.map((status) => {
        const label = status === "Scrobble history not connected" ? "Scrobble history not checked" : status;
        return `<span class="statusChip">${escapeHtml(label)}</span>`;
      }).join("")}
    </div>
  `;
}

function queueReportHtml(result = {}) {
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const queued = Array.isArray(result.queued) ? result.queued : [];
  const title = `Queued ${result.queuedCount || queued.length}/${result.requested || queued.length + failed.length}`;
  const targetReached = Number(result.queuedCount || queued.length) >= Number(result.requested || 0);
  const backupCount = queued.filter((item) => item.isAlternate).length;
  const actionText = result.topOfQueue ? "added next after the current track" : "added to the existing Roon queue";
  const addedTracks = queued.slice(0, 18);
  return `
    <div>
      <strong>${escapeHtml(title)}</strong>
      ${queued.length ? `<p>${escapeHtml(`${queued.length} Rabbit Hole track${queued.length === 1 ? "" : "s"} ${actionText}. Existing queue items may still appear above them in Roon.`)}</p>` : ""}
      ${backupCount ? `<p>${escapeHtml(backupCount)} backup track${backupCount === 1 ? "" : "s"} used to fill the queue.</p>` : ""}
      ${result.warning ? `<p>${escapeHtml(result.warning)}</p>` : ""}
      ${addedTracks.length ? `
        <div class="queueReportAdded">
          <span>Added tracks</span>
          <ol>
            ${addedTracks.map((item) => {
              const track = item.track || {};
              const subtitle = [
                track.artist,
                track.album,
                track.year || ""
              ].filter(Boolean).join(" - ");
              return `
                <li>
                  <strong>${escapeHtml(track.title || "Unknown title")}</strong>
                  <span>${escapeHtml(subtitle || "Rabbit Hole result")}</span>
                </li>
              `;
            }).join("")}
          </ol>
        </div>
      ` : ""}
      ${failed.length ? `
        <p>${escapeHtml(failed.length)} queue attempt${failed.length === 1 ? "" : "s"} failed${targetReached ? ", but the target count was reached." : ":"}</p>
        <ul>
          ${failed.slice(0, 12).map((item) => `
            <li>
              <strong>${escapeHtml(item.track?.artist || "Unknown artist")} - ${escapeHtml(item.track?.title || "Unknown title")}</strong>
              <span>${escapeHtml(item.reason || "No usable Roon action.")}</span>
            </li>
          `).join("")}
        </ul>
      ` : "<p>All displayed tracks were accepted by Roon.</p>"}
    </div>
  `;
}

function showQueueReport(result = null) {
  const report = $("#queueReport");
  if (!report) return;
  if (!result) {
    report.hidden = true;
    report.innerHTML = "";
    return;
  }
  report.hidden = false;
  report.innerHTML = queueReportHtml(result);
}

function tidalPlaylistReportHtml(result = {}) {
  const playlist = result.playlist || {};
  const url = safeHttpUrl(playlist.url);
  const skipped = Number(result.skippedCount || 0);
  const added = Number(result.addedCount || 0);
  const requested = Number(result.requested || 0);
  return `
    <div>
      <strong>Created TIDAL playlist${playlist.title ? `: ${escapeHtml(playlist.title)}` : ""}</strong>
      <p>Added ${escapeHtml(added)} of ${escapeHtml(requested)} track${requested === 1 ? "" : "s"} by TIDAL ID${skipped ? `; skipped ${escapeHtml(skipped)} without TIDAL IDs` : ""}.</p>
      ${url ? `<p><a class="buttonLink" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open TIDAL playlist</a></p>` : ""}
      <p>After TIDAL syncs, refresh Roon playlists if you want to queue the playlist from Roon.</p>
    </div>
  `;
}

function showTidalPlaylistReport(result = null) {
  const report = $("#queueReport");
  if (!report) return;
  if (!result) {
    showQueueReport(null);
    return;
  }
  report.hidden = false;
  report.innerHTML = tidalPlaylistReportHtml(result);
}

function discardedReasonSummary(discarded = []) {
  const counts = new Map();
  for (const item of discarded) {
    const reason = String(item.reason || "No reason provided").replace(/\s+/g, " ").trim();
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10);
}

function incrementCount(map, key, amount = 1) {
  const label = String(key || "").trim() || "Unknown";
  map.set(label, (map.get(label) || 0) + amount);
}

function sortedCounts(map, limit = 8) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function rejectionBucketFor(item = {}) {
  const reason = String(item.reason || "").toLowerCase();
  if (/\b(?:seo|catalogue filler|catalog filler|genre date|mix compilation|filler|sludge)\b/.test(reason)) return "SEO/catalog sludge";
  if (/\b(?:roon|queueable|queue action|exact queueable match|best result)\b/.test(reason)) return "Roon not queueable";
  if (/\b(?:outside the requested|genre\/vibe|requested genre|scene|wrong genre|does not confirm|search query|corroborat|metadata)\b/.test(reason)) return "Genre/scene mismatch";
  if (/\b(?:release|year|date|outside \d{4}|range)\b/.test(reason)) return "Date/range mismatch";
  if (/\b(?:previously suggested|held back|history)\b/.test(reason)) return "Previously suggested";
  if (/\b(?:below minimum|minimum)\b/.test(reason)) return "Below minimum";
  if (/\b(?:short|radio edit)\b/.test(reason)) return "Short/edit";
  if (/\b(?:tidal|verified|verification)\b/.test(reason)) return "TIDAL verification";
  return "Other discarded";
}

function sourceReportFor(result = {}) {
  const verification = result.verification || {};
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const sources = new Map();
  const lanes = new Map();
  const rejectionBuckets = new Map();

  for (const track of tracks) {
    incrementCount(sources, track.discoverySource || "TIDAL search");
    incrementCount(lanes, track.discoveryLane || "core");
  }
  for (const item of discarded) {
    incrementCount(rejectionBuckets, rejectionBucketFor(item));
  }

  const autoBroaden = verification.autoBroaden || {};
  const laneQuotas = verification.laneQuotas || {};
  const lastfm = verification.lastfm || {};
  const calibration = verification.feedbackCalibration || state.calibration || {};
  const queryYield = verification.queryYield || {};
  const exactArtistMatches = tracks.filter(artistCreditConfirmed).length;
  const broaderRoonMatches = tracks.filter((track) => roonVisibleTrack(track) && !artistCreditConfirmed(track)).length;
  const metrics = [
    ["Generated", verification.generated || tracks.length + discarded.length || tracks.length],
    ["Kept", verification.kept ?? tracks.length],
    ["Discarded", verification.discarded ?? discarded.length],
    ["Roon checked", verification.roonChecked || 0],
    ["Roon rejected", verification.roonRejected || 0],
    ["Exact artist", exactArtistMatches],
    ["Broader Roon", broaderRoonMatches],
    ["Below floor kept", verification.belowMinimumKept || 0],
    ["Auto-broaden added", autoBroaden.added || 0],
    ["Yield retries", autoBroaden.yieldAware ? (autoBroaden.lanes || []).filter((lane) => lane.yieldAware).length || 1 : 0],
    ["Last.fm scrobbles", lastfm.checked ? (lastfm.returned || 0) : "not checked"],
    ["Last.fm top artists", lastfm.checked ? (lastfm.topArtistsReturned || 0) : "not checked"],
    ["Query accepted", queryYield.accepted || 0],
    ["Query sludge", Number(queryYield.seoRejects || 0) + Number(queryYield.genreRejects || 0)],
    ["Queries skipped", queryYield.prunedCount || 0],
    ["Model misses", calibration.modelMisses || 0]
  ];

  return {
    metrics,
    sources: sortedCounts(sources, 8),
    lanes: sortedCounts(lanes, 8),
    rejectionBuckets: sortedCounts(rejectionBuckets, 8),
    autoBroaden,
    model: {
      queryCount: verification.modelPlanQueryCount || 0,
      skipped: verification.modelSkipped || "",
      error: verification.modelError || "",
      review: verification.modelCandidateReview || null
    },
    roon: {
      checked: verification.roonChecked || 0,
      rejected: verification.roonRejected || 0,
      limit: verification.roonCheckLimit || 0,
      queueable: Boolean(verification.roonQueueable),
      error: verification.roonVerificationError || ""
    },
    laneQuotas,
    lastfm,
    calibration,
    queryYield
  };
}

function fallbackPoolDiagnosticsFor(result = {}) {
  const verification = result.verification || {};
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const alternates = Array.isArray(result.alternates) ? result.alternates : [];
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  const groups = discardedReasonSummary(discarded);
  return {
    requested: verification.requested || result.requestedCount || tracks.length,
    generated: verification.generated || tracks.length + alternates.length + discarded.length,
    kept: verification.kept ?? tracks.length,
    alternates: alternates.length,
    discarded: verification.discarded ?? discarded.length,
    retainedPool: tracks.length + alternates.length,
    candidatePoolTarget: verification.candidatePoolTarget || 0,
    usefulCandidateTarget: verification.usefulCandidateTarget || 0,
    budgetExhausted: Boolean(verification.budgetExhausted),
    scoreFiltered: verification.scoreFiltered || 0,
    previousHeldBack: verification.previouslySuggestedHeldBack || 0,
    rescueAvailable: verification.belowMinimumRescueAvailable || 0,
    rescueKept: verification.belowMinimumRescueKept || 0,
    queryYield: {
      attempted: verification.queryYield?.attempted || 0,
      returned: verification.queryYield?.returned || 0,
      accepted: verification.queryYield?.accepted || 0,
      rejected: verification.queryYield?.rejected || 0,
      sludge: Number(verification.queryYield?.seoRejects || 0) + Number(verification.queryYield?.genreRejects || 0),
      errors: verification.queryYield?.errorCount || 0,
      pruned: verification.queryYield?.prunedCount || 0,
      laneBudgetStops: Array.isArray(verification.queryYield?.laneBudgetStops)
        ? verification.queryYield.laneBudgetStops.length
        : 0
    },
    lanes: {
      selected: verification.laneQuotas?.selected || {},
      available: verification.laneQuotas?.available || {},
      targets: verification.laneQuotas?.targets || {}
    },
    buckets: groups.map(([label, count]) => ({
      label,
      count,
      examples: discarded
        .filter((item) => rejectionBucketFor(item) === label)
        .slice(0, 3)
        .map((item) => ({
          label: [item.artist, item.title].filter(Boolean).join(" - ") || item.query || "Unknown candidate",
          reason: item.reason || "No reason provided"
        }))
    })),
    notes: [
      verification.budgetExhausted ? "Runtime budget was exhausted before every crawl/search path could finish." : "",
      verification.previouslySuggestedHeldBack ? `${verification.previouslySuggestedHeldBack} previously suggested candidate${verification.previouslySuggestedHeldBack === 1 ? "" : "s"} held back for novelty.` : "",
      verification.belowMinimumRescueAvailable ? `${verification.belowMinimumRescueAvailable} below-floor candidate${verification.belowMinimumRescueAvailable === 1 ? "" : "s"} eligible as branch-out fallback.` : ""
    ].filter(Boolean)
  };
}

function poolDiagnosticsFor(result = {}) {
  const diagnostics = result.verification?.poolDiagnostics;
  if (diagnostics && typeof diagnostics === "object") {
    return {
      ...fallbackPoolDiagnosticsFor(result),
      ...diagnostics,
      queryYield: {
        ...fallbackPoolDiagnosticsFor(result).queryYield,
        ...(diagnostics.queryYield || {})
      },
      lanes: {
        ...fallbackPoolDiagnosticsFor(result).lanes,
        ...(diagnostics.lanes || {})
      },
      buckets: Array.isArray(diagnostics.buckets) ? diagnostics.buckets : fallbackPoolDiagnosticsFor(result).buckets,
      notes: Array.isArray(diagnostics.notes) ? diagnostics.notes : fallbackPoolDiagnosticsFor(result).notes
    };
  }
  return fallbackPoolDiagnosticsFor(result);
}

function poolBucketRowsHtml(buckets = []) {
  if (!buckets.length) return `<p class="sourceReportEmpty">No discarded candidates</p>`;
  return buckets.slice(0, 6).map((bucket) => {
    const examples = Array.isArray(bucket.examples) ? bucket.examples : [];
    const firstExample = examples[0];
    return `
      <li>
        <div>
          <strong>${escapeHtml(bucket.label || "Other discarded")}</strong>
          <b>${escapeHtml(bucket.count || 0)}</b>
        </div>
        ${firstExample ? `<span>${escapeHtml(firstExample.label || "Example")} - ${escapeHtml(firstExample.reason || "")}</span>` : ""}
      </li>
    `;
  }).join("");
}

function poolLaneRowsHtml(lanes = {}) {
  const selected = lanes.selected || {};
  const available = lanes.available || {};
  const targets = lanes.targets || {};
  const names = Array.from(new Set([...Object.keys(targets), ...Object.keys(available), ...Object.keys(selected)]))
    .filter((name) => Number(targets[name] || available[name] || selected[name] || 0) > 0);
  if (!names.length) return `<p class="sourceReportEmpty">No lane quota data</p>`;
  return names.slice(0, 8).map((name) => `
    <p>
      <span>${escapeHtml(name)}</span>
      <b>${escapeHtml(`${selected[name] || 0}/${available[name] || 0} kept${targets[name] ? `, target ${targets[name]}` : ""}`)}</b>
    </p>
  `).join("");
}

function poolDiagnosticsHtml(result = {}) {
  const diagnostics = poolDiagnosticsFor(result);
  const query = diagnostics.queryYield || {};
  const summary = `${diagnostics.kept || 0}/${diagnostics.requested || 0} kept, ${diagnostics.discarded || 0} rejected`;
  const metrics = [
    ["Generated", diagnostics.generated || 0],
    ["Retained pool", diagnostics.retainedPool || 0],
    ["Alternates", diagnostics.alternates || 0],
    ["Target pool", diagnostics.usefulCandidateTarget || diagnostics.candidatePoolTarget || "n/a"],
    ["Below-floor considered", diagnostics.scoreFiltered || 0],
    ["Previous held", diagnostics.previousHeldBack || 0],
    ["Rescue kept", diagnostics.rescueKept || 0],
    ["Query sludge", query.sludge || 0],
    ["Queries skipped", query.pruned || 0]
  ];
  const queryLine = [
    query.attempted ? `${query.attempted} searches` : "",
    query.returned ? `${query.returned} returned` : "",
    query.accepted ? `${query.accepted} accepted` : "0 accepted by query-yield",
    query.pruned ? `${query.pruned} skipped` : "",
    query.errors ? `${query.errors} errors` : ""
  ].filter(Boolean).join(", ");
  return `
    <div class="poolDiagnosticsCard">
      <div class="intentDebugHead">
        <span>Pool Diagnostics</span>
        <strong>${escapeHtml(summary)}</strong>
      </div>
      <div class="sourceReportMetrics poolMetrics">
        ${metrics.map(([label, value]) => `
          <p>
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
          </p>
        `).join("")}
      </div>
      <div class="poolDiagnosticsGrid">
        <section>
          <h3>Top losses</h3>
          <ol>${poolBucketRowsHtml(diagnostics.buckets || [])}</ol>
        </section>
        <section>
          <h3>Lane availability</h3>
          <div class="sourceReportGrid">${poolLaneRowsHtml(diagnostics.lanes || {})}</div>
        </section>
      </div>
      <div class="sourceReportNotes poolNotes">
        <p><span>Budget</span><b>${diagnostics.budgetExhausted ? "runtime exhausted" : "completed within budget"}</b></p>
        <p><span>Query yield</span><b>${escapeHtml(queryLine || "no search query data")}</b></p>
        ${(diagnostics.notes || []).slice(0, 4).map((note) => `<p><span>Note</span><b>${escapeHtml(note)}</b></p>`).join("")}
      </div>
    </div>
  `;
}

function showPoolDiagnostics(result = null) {
  const panel = $("#poolDiagnostics");
  if (!panel) return;
  if (!result) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = poolDiagnosticsHtml(result);
}

function sourceReportGridHtml(items = [], emptyText = "none") {
  if (!items.length) return `<p class="sourceReportEmpty">${escapeHtml(emptyText)}</p>`;
  return items.map(([label, count]) => `
    <p>
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(count)}</b>
    </p>
  `).join("");
}

function modelAuditDeltaText(item = {}) {
  if (item.after === null || item.after === undefined) return `was ${item.before || 0}`;
  const delta = Number(item.delta || 0);
  const sign = delta > 0 ? "+" : "";
  return `${item.before || 0} -> ${item.after || 0} (${sign}${delta})`;
}

function modelAuditItemsHtml(items = [], emptyText = "none") {
  if (!items.length) return `<p class="sourceReportEmpty">${escapeHtml(emptyText)}</p>`;
  return items.map((item) => `
    <li>
      <strong>${escapeHtml(item.label || "Unknown track")}</strong>
      <span>${escapeHtml(modelAuditDeltaText(item))} · model ${escapeHtml(item.modelScore || 0)} · genre ${escapeHtml(item.genreConfidence || 0)}</span>
      <em>${escapeHtml(item.reason || "Model score adjustment")}</em>
    </li>
  `).join("");
}

function modelReviewAuditHtml(audit = null) {
  if (!audit) return "";
  const total = Number(audit.boostedCount || 0) +
    Number(audit.downrankedCount || 0) +
    Number(audit.rejectedCount || 0) +
    Number(audit.warningCount || 0) +
    Number(audit.unchangedCount || 0);
  if (!total) return "";
  return `
    <details class="modelAudit">
      <summary>
        Model Review Audit
        <span>${escapeHtml(`${audit.boostedCount || 0} boosted, ${audit.downrankedCount || 0} downranked, ${audit.rejectedCount || 0} rejected`)}</span>
      </summary>
      <div class="modelAuditGrid">
        <section>
          <h3>Boosted</h3>
          <ol>${modelAuditItemsHtml(audit.boosted || [], "No boosted candidates")}</ol>
        </section>
        <section>
          <h3>Downranked</h3>
          <ol>${modelAuditItemsHtml(audit.downranked || [], "No downranked candidates")}</ol>
        </section>
        <section>
          <h3>Rejected / warned</h3>
          <ol>${modelAuditItemsHtml([...(audit.rejected || []), ...(audit.warnings || [])], "No model rejects or warnings")}</ol>
        </section>
      </div>
    </details>
  `;
}

function calibrationIssueLabel(issue = "") {
  const normalized = String(issue || "").toLowerCase();
  if (normalized === "wrong_genre") return "Wrong genre";
  if (normalized === "bad_boost") return "Bad boost";
  if (normalized === "liked_downranked") return "Liked but downranked";
  if (normalized === "negative_model_approved") return "Negative on approved track";
  if (normalized === "model_miss") return "Model miss";
  return normalized ? normalized.replace(/_/g, " ") : "Feedback mismatch";
}

function calibrationRecentHtml(items = []) {
  if (!items.length) return `<p class="sourceReportEmpty">No feedback mismatches yet</p>`;
  return items.slice(0, 6).map((item) => `
    <li>
      <strong>${escapeHtml([item.title, item.artist].filter(Boolean).join(" - ") || "Unknown track")}</strong>
      <span>${escapeHtml(`${calibrationIssueLabel(item.issue)}; you marked ${item.rating || "feedback"}; model ${item.modelAction || "unreviewed"}`)}</span>
      <em>${escapeHtml(`${item.source || "Unknown source"}${item.modelScore ? `; model ${item.modelScore}` : ""}${item.genreConfidence ? `; genre ${item.genreConfidence}` : ""}`)}</em>
    </li>
  `).join("");
}

function calibrationSourcesHtml(sources = []) {
  if (!sources.length) return `<p class="sourceReportEmpty">No calibrated sources yet</p>`;
  return sources.slice(0, 6).map((source) => `
    <p>
      <span>${escapeHtml(source.source || source.label || source.lane || source.name || "Unknown source")}</span>
      <b>${escapeHtml(`${source.modelMisses || 0}/${source.total || 0} misses`)}</b>
    </p>
  `).join("");
}

function feedbackCalibrationHtml(calibration = null) {
  if (!calibration || !Number(calibration.total || 0)) return "";
  const summary = `${calibration.modelMisses || 0} model misses, ${calibration.promptMismatches || 0} wrong genre`;
  const watchedBuckets = [
    ...(calibration.sources || []).map((item) => ({ ...item, name: item.source })),
    ...(calibration.labels || []).map((item) => ({ ...item, name: item.label })),
    ...(calibration.lanes || []).map((item) => ({ ...item, name: item.lane }))
  ].sort((left, right) => Number(right.modelMisses || 0) - Number(left.modelMisses || 0) || Number(right.total || 0) - Number(left.total || 0));
  return `
    <details class="feedbackCalibration" open>
      <summary>
        Feedback Calibration
        <span>${escapeHtml(summary)}</span>
      </summary>
      <div class="feedbackCalibrationGrid">
        <section>
          <h3>Calibration totals</h3>
          <div class="sourceReportGrid">
            ${sourceReportGridHtml([
              ["Feedback with context", calibration.total || 0],
              ["Model-reviewed", calibration.reviewed || 0],
              ["Model misses", calibration.modelMisses || 0],
              ["Bad boosts", calibration.badBoosts || 0],
              ["Liked downranks", calibration.missedLikes || 0]
            ])}
          </div>
        </section>
        <section>
          <h3>Sources / labels to watch</h3>
          <div class="sourceReportGrid">${calibrationSourcesHtml(watchedBuckets)}</div>
        </section>
        <section>
          <h3>Recent mismatches</h3>
          <ol>${calibrationRecentHtml(calibration.recent || [])}</ol>
        </section>
      </div>
    </details>
  `;
}

function queryYieldRowsHtml(items = [], emptyText = "none") {
  if (!items.length) return `<p class="sourceReportEmpty">${escapeHtml(emptyText)}</p>`;
  return items.slice(0, 6).map((item) => {
    const label = item.query || item.template || "Unknown query";
    const detail = [
      item.accepted !== undefined ? `${item.accepted || 0} accepted` : "",
      item.returned !== undefined ? `${item.returned || 0} returned` : "",
      item.rejected !== undefined ? `${item.rejected || 0} rejected` : "",
      item.seoRejects ? `${item.seoRejects} SEO` : "",
      item.genreRejects ? `${item.genreRejects} genre` : "",
      item.errorCount ? `${item.errorCount} errors` : "",
      item.quality !== undefined ? `quality ${item.quality}` : ""
    ].filter(Boolean).join(", ");
    return `
      <li>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(detail || "No yield details")}</span>
      </li>
    `;
  }).join("");
}

function queryYieldHtml(queryYield = {}) {
  const hasDetails = Boolean(
    (queryYield.best || []).length ||
    (queryYield.worst || []).length ||
    (queryYield.adjustments || []).length ||
    (queryYield.pruned || []).length
  );
  if (!hasDetails) return "";
  return `
    <details class="queryYieldDebug">
      <summary>
        Query Yield
        <span>${escapeHtml(`${queryYield.accepted || 0} accepted, ${Number(queryYield.seoRejects || 0) + Number(queryYield.genreRejects || 0)} sludge`)}</span>
      </summary>
      <div class="modelAuditGrid">
        <section>
          <h3>Best this run</h3>
          <ol>${queryYieldRowsHtml(queryYield.best || [], "No accepted query patterns")}</ol>
        </section>
        <section>
          <h3>Worst this run</h3>
          <ol>${queryYieldRowsHtml(queryYield.worst || [], "No weak query patterns")}</ol>
        </section>
        <section>
          <h3>Memory adjustments</h3>
          <ol>${queryYieldRowsHtml(queryYield.adjustments || [], "No prior query memory used")}</ol>
        </section>
        <section>
          <h3>Skipped before crawl</h3>
          <ol>${queryYieldRowsHtml(queryYield.pruned || [], "No query families skipped")}</ol>
        </section>
      </div>
    </details>
  `;
}

function sourceReportHtml(result = {}) {
  const report = sourceReportFor(result);
  const autoLanes = Array.isArray(report.autoBroaden.lanes) ? report.autoBroaden.lanes : [];
  const autoSummary = report.autoBroaden.attempted
    ? `${report.autoBroaden.attempted} pass${report.autoBroaden.attempted === 1 ? "" : "es"}, ${report.autoBroaden.added || 0} added`
    : "not needed";
  const yieldRetrySummary = report.autoBroaden.yieldAware && report.autoBroaden.queryYieldHealth
    ? report.autoBroaden.queryYieldHealth.summary || "weak query yield"
    : "";
  const modelSummary = report.model.error
    ? `model error: ${report.model.error}`
    : (report.model.skipped || `${report.model.queryCount} planned queries`);
  const review = report.model.review;
  const reviewSummary = review?.enabled
    ? `${review.scored || 0} reviewed, ${review.rejected || 0} rejected`
    : (review?.error || "not run");
  const roonSummary = report.roon.error
    ? report.roon.error
    : `${report.roon.checked}/${report.roon.limit || report.roon.checked || 0} checked, ${report.roon.rejected} rejected`;
  const quotaSummary = report.laneQuotas?.enabled
    ? Object.entries(report.laneQuotas.selected || {})
      .filter(([, count]) => Number(count || 0) > 0)
      .map(([bucket, count]) => `${bucket}: ${count}`)
      .join(", ") || "none selected"
    : "not run";
  const quotaAdjustmentSummary = report.laneQuotas?.calibrationAdjustments?.length
    ? report.laneQuotas.calibrationAdjustments
      .map((item) => `${item.bucket}: ${item.target}->${item.adjustedTarget}`)
      .join(", ")
    : "";
  const lastfmSummary = report.lastfm.checked
    ? `${report.lastfm.returned || 0} scrobbles, ${report.lastfm.topArtistsReturned || 0} top artists${report.lastfm.topArtistPeriod ? ` (${report.lastfm.topArtistPeriod})` : ""}${report.lastfm.topArtistsError ? `; top artists: ${report.lastfm.topArtistsError}` : ""}`
    : (report.lastfm.error || report.lastfm.reason || "not checked");
  const queryYieldSummary = report.queryYield.recordCount
    ? `${report.queryYield.attempted || 0} queries, ${report.queryYield.accepted || 0} accepted, ${Number(report.queryYield.seoRejects || 0) + Number(report.queryYield.genreRejects || 0)} sludge, ${report.queryYield.prunedCount || 0} skipped`
    : (report.queryYield.enabled ? "no search queries recorded" : "run-only until server tracker records data");

  return `
    <div class="sourceReportCard">
      <div class="intentDebugHead">
        <span>Candidate Source Report</span>
        <strong>${escapeHtml(autoSummary)}</strong>
      </div>
      <div class="sourceReportMetrics">
        ${report.metrics.map(([label, value]) => `
          <p>
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
          </p>
        `).join("")}
      </div>
      <div class="sourceReportColumns">
        <section>
          <h3>Kept sources</h3>
          <div class="sourceReportGrid">${sourceReportGridHtml(report.sources, "No kept tracks")}</div>
        </section>
        <section>
          <h3>Discovery lanes</h3>
          <div class="sourceReportGrid">${sourceReportGridHtml(report.lanes, "No lanes")}</div>
        </section>
        <section>
          <h3>Rejected buckets</h3>
          <div class="sourceReportGrid">${sourceReportGridHtml(report.rejectionBuckets, "No discarded candidates")}</div>
        </section>
      </div>
      <div class="sourceReportNotes">
        <p><span>Roon</span><b>${escapeHtml(roonSummary)}</b></p>
        <p><span>Model plan</span><b>${escapeHtml(modelSummary)}</b></p>
        <p><span>Model review</span><b>${escapeHtml(reviewSummary)}</b></p>
        <p><span>Lane quotas</span><b>${escapeHtml(quotaSummary)}</b></p>
        ${quotaAdjustmentSummary ? `<p><span>Quota dampening</span><b>${escapeHtml(quotaAdjustmentSummary)}</b></p>` : ""}
        <p><span>Last.fm</span><b>${escapeHtml(lastfmSummary)}</b></p>
        <p><span>Query yield</span><b>${escapeHtml(queryYieldSummary)}</b></p>
        ${yieldRetrySummary ? `<p><span>Yield retry</span><b>${escapeHtml(yieldRetrySummary)}</b></p>` : ""}
      </div>
      ${feedbackCalibrationHtml(report.calibration)}
      ${modelReviewAuditHtml(review?.audit)}
      ${queryYieldHtml(report.queryYield)}
      ${autoLanes.length ? `
        <details>
          <summary>Auto-broaden passes</summary>
          <ol>
            ${autoLanes.map((lane) => `
              <li>
                <strong>${escapeHtml(lane.label || lane.lane || "Broadened search")}</strong>
                <span>${escapeHtml(`${lane.added || 0} added from ${lane.generated || 0} generated. ${lane.reason || ""}`)}</span>
              </li>
            `).join("")}
          </ol>
        </details>
      ` : ""}
    </div>
  `;
}

function showSourceReport(result = null) {
  const panel = $("#sourceReport");
  if (!panel) return;
  if (!result) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = sourceReportHtml(result);
}

function rejectedDebugHtml(result = {}) {
  const discarded = Array.isArray(result.discarded) ? result.discarded : [];
  if (!discarded.length) return "";
  const groups = discardedReasonSummary(discarded);
  return `
    <div class="rejectedDebugCard">
      <div class="intentDebugHead">
        <span>Rejected / discarded</span>
        <strong>${escapeHtml(discarded.length)} candidates</strong>
      </div>
      <div class="rejectedGroups">
        ${groups.map(([reason, count]) => `
          <p>
            <b>${escapeHtml(count)}</b>
            <span>${escapeHtml(reason)}</span>
          </p>
        `).join("")}
      </div>
      <details>
        <summary>Show examples</summary>
        <ol>
          ${discarded.slice(0, 80).map((item) => `
            <li>
              <strong>${escapeHtml([item.artist, item.title].filter(Boolean).join(" - ") || item.query || "Unknown candidate")}</strong>
              <span>${escapeHtml(item.reason || "No reason provided")}</span>
            </li>
          `).join("")}
        </ol>
      </details>
    </div>
  `;
}

function updateRejectedDebug() {
  const panel = $("#rejectedDebug");
  const button = $("#toggleRejected");
  if (!panel || !button) return;
  const discarded = Array.isArray(state.lastResult?.discarded) ? state.lastResult.discarded : [];
  button.disabled = !discarded.length;
  button.textContent = discarded.length ? `Rejected (${discarded.length})` : "Rejected";
  if (!discarded.length || !state.rejectedDebugOpen) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = rejectedDebugHtml(state.lastResult);
}

function intentListValue(value, fallback = "not specified") {
  if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
  const text = String(value || "").trim();
  return text || fallback;
}

function intentDebugHtml(intent = {}) {
  const rows = [
    ["Requested genre", intent.requestedGenre || "open-ended"],
    ["Requested vibe", intent.requestedVibe || "not specified"],
    ["Vibe source", intent.requestedVibeSource || "not specified"],
    ["Era / date range", intent.requestedEraDateRange || "not specified"],
    ["Requested length", intent.requestedLength || "not specified"],
    ["Characteristics", intentListValue(intent.requestedCharacteristics, "not specified")],
    ["Artist seed", intentListValue(intent.requestedArtists, "none selected")],
    ["Labels", intentListValue(intent.requestedLabels, "none selected")],
    ["Scoring mode", intent.scoringModeLabel || "Taste Guided"],
    ["Learned taste", intent.learnedTaste || "lightly"],
    ["Progressive bias", intent.progressiveBias || "off unless explicitly requested"]
  ];
  return `
    <div class="intentDebugCard">
      <div class="intentDebugHead">
        <span>Intent Parsed</span>
        <strong>${escapeHtml(intent.scoringModeLabel || "Taste Guided")}</strong>
      </div>
      <div class="intentDebugGrid">
        ${rows.map(([label, value]) => `
          <p>
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
          </p>
        `).join("")}
      </div>
    </div>
  `;
}

function showIntentDebug(intent = null) {
  const panel = $("#intentDebug");
  if (!panel) return;
  if (!intent) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = intentDebugHtml(intent);
}

function cleanRenderedArtifacts(root) {
  root.querySelectorAll(".trackMeta").forEach((element) => {
    element.textContent = element.textContent.replace(/\s*\u00e2\u20ac\u00a2\s*/g, " - ");
  });
}

function emptyResultHtml(reason, verification = {}) {
  const modelErrorText = String(verification.modelError || "");
  const contextLimitHit = /\b(?:context|token|tokens|maximum context|too many|too large|exceed|exceeded|length)\b/i.test(modelErrorText);
  const issues = [
    verification.discoveryError ? `TIDAL discovery: ${verification.discoveryError}` : "",
    verification.roonVerificationError ? `Roon queue verification: ${verification.roonVerificationError}` : "",
    verification.roonFirstError ? `Roon search: ${verification.roonFirstError}` : "",
    verification.modelError ? `Local model: ${verification.modelError}` : "",
    verification.tidalError ? `TIDAL verification: ${verification.tidalError}` : ""
  ].filter(Boolean);
  const tips = [
    contextLimitHit ? "The local model likely hit its context/token limit. Reduce seed playlist text, lower requested tracks, or start a fresh Generate run with less reference data." : "",
    verification.yearRange ? "Strict year ranges need reliable TIDAL release-year metadata." : "",
    verification.minScore ? "Try lowering Minimum match one step if you want more output." : "",
    "Try a broader seed artist, label, or year range if the run was too narrow."
  ].filter(Boolean);

  return `
    <div class="emptyState">
      <strong>No tracks returned for this run.</strong>
      <p>${escapeHtml(reason)}</p>
      ${issues.length ? `
        <div>
          <span>What happened</span>
          <ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>
        </div>
      ` : ""}
      ${contextLimitHit ? "<p><strong>Context limit hit:</strong> The Rabbit Hole starts each Generate request fresh, so trim the prompt/reference payload and run it again.</p>" : ""}
      <div>
        <span>Try next</span>
        <ul>${tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ul>
      </div>
    </div>
  `;
}

function trackCardHtml(track, index) {
  const label = track.label || track.tidal?.label || "";
  const saved = isSavedCandidate(track);
  const tidalUrl = safeHttpUrl(track.tidal?.tidalUrl);
  const resultIndex = Number.isFinite(Number(track._resultIndex)) ? Number(track._resultIndex) : index;
  const payload = trackPayload(track);
  const meta = [
    track.artist,
    track.releaseDate || track.tidal?.releaseDate || track.year || "",
    track.durationMs ? formatDuration(track.durationMs) : ""
  ].filter(Boolean).join(" - ");
  return `
    <div class="track" id="track-${resultIndex}" data-track-index="${resultIndex}">
      <div class="trackMain">
        <strong class="trackTitle">${index + 1}. ${escapeHtml(track.title)}</strong>
        <span class="trackMeta">${escapeHtml(meta)}</span>
        <div class="trackBadges">
          ${artistConfirmationBadgeHtml(track)}
          ${track.roon?.queueActionPresumed ? "<span class=\"artistCreditBadge queue\">Queue presumed</span>" : ""}
        </div>
        <p class="trackLabel">${label ? escapeHtml(label) : "Label unavailable"}</p>
        ${matchSplitHtml(track)}
        ${scoreBreakdownHtml(track)}
        ${whyMatchedHtml(track)}
        <p class="sourceLine">Source: <strong>${escapeHtml(track.discoverySource || "TIDAL search")}</strong></p>
        ${statusChecksHtml(track)}
        ${track.tidal ? `<p class="muted">TIDAL: ${tidalUrl ? `<a href="${escapeHtml(tidalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(track.tidal.title || track.title)}</a>` : escapeHtml(track.tidal.title || track.title)}${track.tidal.artist ? ` - ${escapeHtml(track.tidal.artist)}` : ""}</p>` : ""}
        ${track.roon?.match ? `<p class="muted">Roon: ${escapeHtml(track.roon.match.title)}${track.roon.match.subtitle ? ` - ${escapeHtml(track.roon.match.subtitle)}` : ""}</p>` : ""}
        ${resultDiagnosticsHtml(track, index)}
        <div class="feedbackButtons" aria-label="Track feedback">${feedbackButtonsHtml(track, index)}</div>
      </div>
      <div class="trackActions">
        ${tidalUrl ? `<a class="buttonLink" href="${escapeHtml(tidalUrl)}" target="_blank" rel="noreferrer">TIDAL</a>` : ""}
        <div class="candidateSaveGroup" data-active-saved="${saved ? "true" : "false"}">
          <select data-save-list aria-label="Candidate list">
            ${savedListOptionsHtml()}
          </select>
          <button data-save-track='${escapeHtml(JSON.stringify(payload))}' ${saved ? "disabled" : ""}>${saved ? "Saved" : "Add"}</button>
        </div>
        <button data-queue-next='${escapeHtml(JSON.stringify(payload))}'>Add Next</button>
        <button data-track='${escapeHtml(JSON.stringify(payload))}'>Play Roon</button>
      </div>
    </div>
  `;
}

function renderResults(result = {}) {
  state.lastResult = {
    ...result,
    tracks: applyFeedbackToTracks(result.tracks || [])
  };
  state.lastTracks = state.lastResult.tracks || [];
  state.displayedTracks = displayedResultTracks(state.lastTracks);
  const filterToggle = $("#artistConfirmedOnly");
  const exactConfirmedCount = state.lastTracks.filter(artistCreditConfirmed).length;
  if (filterToggle) {
    filterToggle.checked = state.resultArtistConfirmedOnly;
    filterToggle.disabled = !state.lastTracks.length;
    filterToggle.title = `Audit only: ${exactConfirmedCount}/${state.lastTracks.length} exact artist-confirmed results`;
  }
  $("#queueAll").disabled = !state.displayedTracks.length;
  $("#queueAllNext").disabled = !state.displayedTracks.length;
  $("#sendTidalQueue").disabled = !state.displayedTracks.length;
  $("#copyList").disabled = !state.displayedTracks.length;
  $("#exportCsv").disabled = !state.displayedTracks.length;
  updateRejectedDebug();

  const discarded = state.lastResult.verification?.discarded || 0;
  const generated = state.lastResult.verification?.generated || state.displayedTracks.length;
  const verifierLabel = state.lastResult.verification?.tidal ? "TIDAL" : "Roon";
  const queueableLabel = state.lastResult.verification?.roonQueueable ? "Roon-queueable" : "verified";
  const strictRoon = Boolean(state.lastResult.verification?.roonQueueable || state.lastResult.verification?.roonStrict);
  const minScore = Number(state.lastResult.verification?.minScore || 0);
  const minimumLabel = state.lastResult.verification?.minScoreLabel || minimumScoreLabel(minScore);
  const filteredByScore = Number(state.lastResult.verification?.scoreFiltered || 0);
  const belowMinimumKept = Number(state.lastResult.verification?.belowMinimumKept || 0);
  const aboveMinimumKept = minScore
    ? Number(state.lastResult.verification?.aboveMinimumKept ?? Math.max(0, state.displayedTracks.length - belowMinimumKept))
    : state.displayedTracks.length;
  const emptyReason = state.lastResult.verification?.discoveryError
    ? `Generation ran, but discovery did not finish cleanly. ${state.lastResult.verification.discoveryError}`
    : state.lastResult.verification?.roonVerificationError
      ? `Generation ran, but Roon queue verification timed out. ${state.lastResult.verification.roonVerificationError}`
      : state.lastResult.verification?.modelError && !generated
        ? `The local model did not return usable candidates. ${state.lastResult.verification.modelError}`
        : state.lastResult.verification?.tidalError
    ? `TIDAL verification failed: ${state.lastResult.verification.tidalError}. Roon fallback also did not verify these tracks.`
    : strictRoon
      ? "TIDAL found candidates, but none passed strict Roon verification for the selected output zone. Broaden the prompt or try a different Roon zone."
      : minScore
        ? `No queueable tracks were close enough to the request. Lower the Minimum match picker or broaden the seed/year range.`
        : `No tracks survived ${verifierLabel} catalogue filters. Try a broader year range or seed around a known artist/label.`;

  const titleCount = state.resultArtistConfirmedOnly
    ? `${state.displayedTracks.length} exact-artist shown from ${state.lastTracks.length}`
    : `${state.displayedTracks.length}`;
  const titlePrefix = minScore && belowMinimumKept
    ? `${titleCount} ${queueableLabel} tracks`
    : (minScore ? `${titleCount} ${minimumScoreLabel(minScore)} ${queueableLabel} tracks` : `${titleCount} ${queueableLabel} tracks`);
  const filterSuffix = minScore && belowMinimumKept
    ? `, ${aboveMinimumKept} ${minimumLabel}, ${belowMinimumKept} below minimum kept`
    : (filteredByScore ? `, ${filteredByScore} below minimum considered` : "");
  $("#resultTitle").textContent = discarded
    ? `${titlePrefix} (${discarded} discarded from ${generated}${filterSuffix})`
    : titlePrefix;
  showPoolDiagnostics(state.lastResult);
  $("#tracks").innerHTML = state.displayedTracks.length
    ? state.displayedTracks.map(trackCardHtml).join("")
    : (state.lastTracks.length && state.resultArtistConfirmedOnly
      ? emptyResultHtml("No exact artist-confirmed tracks are visible with the current filter. Turn off Exact artists to inspect broader Roon matches.", state.lastResult.verification || {})
      : emptyResultHtml(emptyReason, state.lastResult.verification || {}));
  showQueueReport(null);
  showIntentDebug(state.lastResult.verification?.intent || null);
  showSourceReport(state.lastResult);
  updateRejectedDebug();
  cleanRenderedArtifacts($("#tracks"));
  updateNowDiscoveryTools(activeZone());
}

function isLegacyUnverifiedResult(result = {}) {
  if (!result) return false;
  const verification = result.verification || {};
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  if (!tracks.length) return false;
  if (verification.roonQueueable || verification.roonStrict) return false;
  if (verification.discoveryError || verification.roonVerificationError || verification.strategy) return false;
  return true;
}

function applySession(session = {}) {
  if (!session.updatedAt) return;
  state.sessionUpdatedAt = session.updatedAt;
  const options = session.options || {};
  for (const field of ["request"]) {
    const element = document.querySelector(`[name="${field}"]`) || $(`#${field}`);
    const value = options[field];
    if (element && typeof value !== "object" && value !== undefined && value !== null) {
      element.value = value;
    }
  }

  for (const field of ["reference", "genres", "years", "mood", "language", "count", "scoringMode", "minScore", "releasePreset", "releaseExactDate", "releaseStartDate", "releaseEndDate"]) {
    const element = document.querySelector(`[name="${field}"]`) || $(`#${field}`);
    if (!element) continue;
    const value = options[field];
    element.value = typeof value === "object" || value === undefined || value === null ? "" : value;
  }
  setScoringMode(options.scoringMode || "");

  if (session.result && !isLegacyUnverifiedResult(session.result)) {
    renderResults(session.result);
  } else if (session.result) {
    state.lastResult = null;
    state.lastTracks = [];
    state.displayedTracks = [];
    $("#queueAll").disabled = true;
    $("#queueAllNext").disabled = true;
    $("#sendTidalQueue").disabled = true;
    $("#copyList").disabled = true;
    $("#exportCsv").disabled = true;
    $("#resultTitle").textContent = "Previous results need Roon verification";
    showPoolDiagnostics(null);
    $("#tracks").innerHTML = "<p class=\"muted\">Generate again to rebuild this list with strict TIDAL plus Roon verification. Old TIDAL-only session results are hidden so they do not look playable.</p>";
    showQueueReport(null);
    showIntentDebug(null);
    showSourceReport(null);
  }
}

async function refreshSession() {
  const session = await getJson("/api/session");
  applySession(session);
}

async function recoverGeneratedSession(startedAt = Date.now()) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(attempt < 2 ? 1200 : 1800);
    try {
      const session = await getJson("/api/session");
      const updatedAt = Date.parse(session.updatedAt || "");
      if (session.result && Number.isFinite(updatedAt) && updatedAt >= startedAt - 2000) {
        applySession(session);
        renderResults(session.result);
        return true;
      }
    } catch {
      // Keep polling briefly; the server may be restarting or finishing the request.
    }
  }
  return false;
}

function applyAppState(app = {}) {
  if (!app) return;
  state.appStatus = app;
  state.memory = app.memory || state.memory;
  renderMemoryStatus();

  const llm = app.llm || {};
  const systemTag = $("#systemTag");
  if (systemTag) {
    const provider = String(llm.label || "LOCAL MODEL").toUpperCase();
    const model = llm.model ? ` - ${String(llm.model).toUpperCase()}` : "";
    systemTag.textContent = `${provider}${model} - TIDAL - ROON MATCHING: STRICT`;
  }
  if (!state.llmStatus && llm.label) {
    renderLlmStatus({ ...llm, checking: true });
  }

  applyCalibration(app.taste?.calibration || null);

  const feedbackMap = feedbackMapFromServer(app.feedback || {});
  const feedbackVersion = Object.entries(feedbackMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rating]) => `${key}:${rating}`)
    .join("|");
  if (feedbackVersion !== state.feedbackVersion) {
    state.feedbackByKey = feedbackMap;
    state.feedbackVersion = feedbackVersion;
    state.tasteUpdatedAt = app.taste?.updatedAt || "";
    if (state.lastResult) renderResults(state.lastResult);
    renderSaved();
    updateNowDiscoveryTools(activeZone());
    state.historyNeedsRefresh = true;
  }

  const savedSnapshot = normalizeSavedSnapshot(app.saved || []);
  const savedVersion = savedSnapshotVersion({
    ...savedSnapshot,
    tracks: applyFeedbackToTracks(savedSnapshot.tracks || [])
  });
  if (savedVersion !== state.savedVersion) {
    applySavedSnapshot(savedSnapshot);
    renderSaved();
    if (state.lastResult) renderResults(state.lastResult);
  }

  const session = app.session || {};
  if (session.updatedAt && session.updatedAt !== state.sessionUpdatedAt) {
    applySession(session);
  }
  renderSystemHealth();
}

function renderLlmStatus(status = {}) {
  const pill = $("#llmStatus");
  if (!pill) return;
  state.llmStatus = status;
  const label = String(status.label || "Local model");
  const model = status.model ? ` ${String(status.model).replace(/^qwen\//i, "")}` : "";
  const online = Boolean(status.online && status.loaded !== false);
  const checking = Boolean(status.checking && !status.reachable && status.loaded !== false);
  pill.classList.toggle("statusOffline", !online && !checking);
  pill.classList.toggle("statusUnknown", checking);
  pill.title = status.message || "";
  pill.textContent = online
    ? `${label}${model}`
    : (status.reachable && status.loaded === false ? `${label}: model not loaded` : `${label}: offline`);
  renderSystemHealth();
}

function setCoverImage(cover, urls = []) {
  const candidates = urls.map((url) => String(url || "").trim()).filter(Boolean);
  const signature = candidates.join("\n");
  if (cover.dataset.coverSignature === signature) return;
  cover.dataset.coverSignature = signature;

  if (!candidates.length) {
    cover.style.backgroundImage = "";
    cover.classList.remove("hasArt");
    return;
  }

  const tryCandidate = (index) => {
    if (cover.dataset.coverSignature !== signature) return;
    const url = candidates[index];
    if (!url) {
      cover.style.backgroundImage = "";
      cover.classList.remove("hasArt");
      return;
    }

    const image = new Image();
    image.onload = () => {
      if (cover.dataset.coverSignature !== signature) return;
      cover.style.backgroundImage = `url("${url.replace(/"/g, "%22")}")`;
      cover.classList.add("hasArt");
    };
    image.onerror = () => tryCandidate(index + 1);
    image.src = url;
  };

  tryCandidate(0);
}

async function refreshLlmStatus() {
  const current = state.llmStatus || {};
  if (!current.online && !current.reachable) renderLlmStatus({ ...current, checking: true, label: current.label || "Local model" });
  try {
    renderLlmStatus(await getJson("/api/llm-status"));
  } catch (error) {
    renderLlmStatus({
      ...(state.llmStatus || {}),
      online: false,
      reachable: false,
      loaded: false,
      message: error.message,
      label: state.llmStatus?.label || "Local model"
    });
  }
}

function renderState(payload) {
  state.zones = payload.zones || [];
  state.connectionStatus = {
    connected: Boolean(payload.connected),
    coreName: payload.core?.name || ""
  };
  if (!state.zones.some((zone) => zone.zone_id === state.selectedZoneId)) {
    state.selectedZoneId = state.zones[0]?.zone_id || "";
  }

  $("#connection").textContent = payload.connected
    ? `Connected to ${payload.core.name}`
    : "Enable this extension in Roon Settings > Extensions";

  const phoneUrl = safeHttpUrl((payload.urls || []).find((url) => !url.includes("localhost")));
  $("#phoneAccess").innerHTML = phoneUrl
    ? `<span class="phoneLabel">Phone</span><a href="${escapeHtml(phoneUrl)}">${escapeHtml(phoneUrl)}</a>`
    : "";

  const select = $("#zoneSelect");
  select.innerHTML = state.zones.map((zone) => (
    `<option value="${escapeHtml(zone.zone_id)}">${escapeHtml(zoneDisplayLabel(zone))}</option>`
  )).join("");
  select.value = state.selectedZoneId;

  const zone = activeZone();
  const now = zone?.now_playing;
  const displayNow = summarizeNowPlaying(zone);
  $("#nowTitle").textContent = displayNow?.title || zone?.display_name || "No active zone";
  $("#nowSubtitle").textContent = [displayNow?.artist, displayNow?.album].filter(Boolean).join(" - ") || zone?.state || "";

  const length = Math.max(0, Number(now?.length || 0));
  const position = Math.max(0, Math.min(length || Infinity, Number(now?.seek_position || 0)));
  const liveRadio = isLiveRadioZone(zone);
  const slider = $("#seekSlider");
  $("#playState").textContent = zone?.state || "stopped";
  $("#queueInfo").textContent = formatQueueInfo(zone);
  $("#seekPosition").textContent = formatSeconds(position) || "0:00";
  $("#seekLength").textContent = liveRadio ? "Live radio" : (formatSeconds(length) || "0:00");
  slider.max = String(liveRadio ? 1 : (length || 0));
  slider.disabled = liveRadio || !zone?.is_seek_allowed || !length;
  if (!state.isSeeking) slider.value = String(liveRadio ? 0 : (position || 0));

  const liveQueue = $("#liveQueue");
  const queueHtml = zone ? liveQueueHtml(zone) : "";
  if (queueHtml) {
    liveQueue.hidden = false;
    liveQueue.innerHTML = queueHtml;
  } else {
    liveQueue.hidden = true;
    liveQueue.innerHTML = "";
  }

  const cover = $("#cover");
  setCoverImage(cover, [
    now?.radio_enrichment?.imageUrl,
    !now?.radio_lookup && now?.image_key ? `/api/roon/image/${encodeURIComponent(now.image_key)}?width=360&height=360` : ""
  ]);

  const outputs = $("#outputs");
  if (outputs) {
    outputs.hidden = true;
    outputs.innerHTML = "";
  }
  updateNowDiscoveryTools(zone);
  updateJumpTopVisibility();
  renderSystemHealth();
}

async function refresh() {
  const payload = await getJson("/api/status");
  renderState(payload);
  applyAppState(payload.app);
}

async function queueTrackList(tracks, button, options = {}) {
  const zone = activeZone();
  if (!zone) return alert("Select a Roon zone first.");
  if (!tracks.length) return alert("There are no tracks to queue.");

  const originalText = button.textContent;
  const mode = options.mode || "append";
  const nextMode = mode === "next";
  button.disabled = true;
  button.textContent = "Adding...";
  $("#busy").textContent = nextMode
    ? `Adding ${tracks.length} track${tracks.length === 1 ? "" : "s"} next in the Roon queue...`
    : `Adding ${tracks.length} tracks to the existing Roon queue...`;

  try {
    const result = await api("/api/roon/queue-tracks", {
      zoneId: zone.zone_id,
      tracks,
      alternates: options.alternates || [],
      targetCount: options.targetCount || tracks.length,
      mode
    });
    console.info("Roon queue result", result);
    button.textContent = result.failedCount
      ? `Added ${result.queuedCount}/${result.requested}`
      : (nextMode ? "Added next" : "Added");
    const notes = [];
    if (result.shuffleDisabled) notes.push("Shuffle turned off");
    if (result.topOfQueue) notes.push("Added next after the current track");
    else if (result.appendOnly) notes.push("Added to existing queue");
    if (result.startReset?.reset) notes.push("Started at 0:00");
    if (result.startReset && !result.startReset.reset) notes.push(result.startReset.error || "Could not reset start position");
    if (result.warning) notes.push(result.warning);
    if (result.playbackStartRequested) notes.push("Playback started");
    if (result.playbackStartError) notes.push(`Queued, but playback did not start: ${result.playbackStartError}`);
    if (result.alternateCount) notes.push(`${result.alternateCount} backup track${result.alternateCount === 1 ? "" : "s"} available`);
    if (result.failedCount) notes.push(`${result.failedCount} queue attempt${result.failedCount === 1 ? "" : "s"} failed`);
    $("#busy").textContent = notes.join(" - ") || "Roon queue updated";
    showQueueReport(result);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
      $("#busy").textContent = "";
    }, 2200);
  } catch (error) {
    button.textContent = "Failed";
    $("#busy").textContent = "";
    alert(error.message);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
    }, 1600);
  }
}

async function sendTracksToTidalPlaylist(tracks, button, options = {}) {
  if (!tracks.length) return alert("There are no tracks to send to TIDAL.");
  const originalText = button.textContent;
  const title = options.title || "";
  button.disabled = true;
  button.textContent = "Sending...";
  $("#busy").textContent = `Creating TIDAL playlist from ${tracks.length} track${tracks.length === 1 ? "" : "s"}...`;

  try {
    const result = await api("/api/tidal/queue-playlist", {
      tracks,
      title,
      description: options.description || "Temporary Rabbit Hole queue. Created by Rabbit Hole so TIDAL/Roon can sync the exact TIDAL tracks."
    });
    button.textContent = "Sent to TIDAL";
    $("#busy").textContent = `TIDAL playlist ready: ${result.addedCount || 0} track${Number(result.addedCount || 0) === 1 ? "" : "s"}`;
    showTidalPlaylistReport(result);
    if (state.tidalMixes) state.tidalMixesNeedsRefresh = true;
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
      $("#busy").textContent = "";
    }, 2600);
  } catch (error) {
    button.textContent = "Failed";
    $("#busy").textContent = "";
    alert(error.message);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = !tracks.length;
    }, 1600);
  }
}

function tidalMixTrackLimit(mix = {}) {
  const itemCount = Number(mix.itemCount || 0);
  if (Number.isFinite(itemCount) && itemCount > 0) {
    return Math.max(1, Math.min(50, Math.floor(itemCount)));
  }
  return 20;
}

function queuedTrackFromItem(item = {}) {
  const subtitleParts = String(item.subtitle || "").split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  return {
    title: item.title || "",
    artist: subtitleParts[0] || item.subtitle || "",
    album: item.album || subtitleParts.slice(1).join(" - ") || "",
    durationMs: item.length ? Number(item.length) * 1000 : null
  };
}

function tidalRadioTrackKey(track = {}) {
  const tidalId = String(track.tidal?.id || track.tidalId || track.id || "").trim();
  if (tidalId) return `tidal:${tidalId.toLowerCase()}`;
  const title = normalizeMatchText(track.title || track.tidal?.title || "");
  const artist = normalizeMatchText(track.artist || track.tidal?.artist || "");
  return title && artist ? `${artist}::${title}` : "";
}

function tidalRadioMemoryKey(mix = {}) {
  return String(mix.pinnedKey || mix.id || mix.title || "artist-radio").trim();
}

function readTidalRadioRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TIDAL_RADIO_RECENT_KEY) || "{}");
    const now = Date.now();
    const next = {};
    for (const [key, tracks] of Object.entries(parsed || {})) {
      const fresh = Array.isArray(tracks)
        ? tracks.filter((track) => now - Number(track.addedAt || 0) < TIDAL_RADIO_RECENT_TTL_MS)
        : [];
      if (fresh.length) next[key] = fresh.slice(0, TIDAL_RADIO_RECENT_MAX);
    }
    if (JSON.stringify(parsed) !== JSON.stringify(next)) {
      localStorage.setItem(TIDAL_RADIO_RECENT_KEY, JSON.stringify(next));
    }
    return next;
  } catch {
    return {};
  }
}

function writeTidalRadioRecent(data = {}) {
  try {
    localStorage.setItem(TIDAL_RADIO_RECENT_KEY, JSON.stringify(data));
  } catch {
    // Browser storage can be unavailable in private modes; queueing should still work.
  }
}

function tidalRadioRecentTracksForMix(mix = {}) {
  const key = tidalRadioMemoryKey(mix);
  if (!key) return [];
  return readTidalRadioRecent()[key] || [];
}

function rememberTidalRadioTracks(mix = {}, tracks = []) {
  const key = tidalRadioMemoryKey(mix);
  if (!key || !Array.isArray(tracks) || !tracks.length) return;
  const now = Date.now();
  const recent = readTidalRadioRecent();
  const existing = recent[key] || [];
  const byKey = new Map(existing.map((track) => [tidalRadioTrackKey(track), track]).filter(([trackKey]) => trackKey));
  for (const track of tracks) {
    const memoryKey = tidalRadioTrackKey(track);
    if (!memoryKey) continue;
    byKey.set(memoryKey, {
      title: track.title || track.tidal?.title || "",
      artist: track.artist || track.tidal?.artist || "",
      album: track.album || track.tidal?.album || "",
      tidalId: track.tidal?.id || track.tidalId || track.id || "",
      tidalUrl: track.tidalUrl || track.tidal?.tidalUrl || "",
      addedAt: now
    });
  }
  recent[key] = Array.from(byKey.values())
    .sort((left, right) => Number(right.addedAt || 0) - Number(left.addedAt || 0))
    .slice(0, TIDAL_RADIO_RECENT_MAX);
  writeTidalRadioRecent(recent);
}

function freshArtistRadioArtistId(mix = {}) {
  if (!mix?.pinned) return "";
  if (mix.pinnedKind === "artist-radio" && mix.artistRadio?.artistId) return String(mix.artistRadio.artistId);
  const match = String(mix.pinnedKey || "").match(/^artist-radio:(.+)$/i);
  return match?.[1] || "";
}

function isPinnedArtistRadioMix(mix = {}) {
  if (!mix?.pinned) return false;
  const text = `${mix.category || ""} ${mix.subtitle || ""} ${mix.pinnedKind || ""}`;
  return /artist\s+radio/i.test(text);
}

function tidalArtistRadioExcludeTracks(zone = activeZone(), mix = {}) {
  return [
    nowPlayingTrack(zone),
    ...displayQueueItems(zone).map(queuedTrackFromItem),
    ...tidalRadioRecentTracksForMix(mix)
  ].filter((track) => track?.title && track?.artist);
}

async function queueTidalMix(mix, button, options = {}) {
  const zone = activeZone();
  if (!zone) return alert("Select a Roon zone first.");
  if (!mix?.id) return alert("This TIDAL mix is missing an id.");

  const limit = tidalMixTrackLimit(mix);
  const artistRadioId = freshArtistRadioArtistId(mix);
  const freshArtistRadio = Boolean(artistRadioId);
  const artistRadioLike = freshArtistRadio || isPinnedArtistRadioMix(mix);
  const excludeTracks = artistRadioLike ? tidalArtistRadioExcludeTracks(zone, mix) : [];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Loading...";
  $("#busy").textContent = artistRadioLike
    ? `Loading ${mix.title || "Artist Radio"} and skipping current queue repeats...`
    : `Loading ${limit} track${limit === 1 ? "" : "s"} from ${mix.title || "TIDAL mix"}...`;

  try {
    const result = await api("/api/tidal/mix-tracks", {
      mixId: mix.id,
      limit,
      freshArtistRadio,
      artistRadioArtistId: artistRadioId,
      excludeTracks
    });
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    if (!tracks.length) {
      const excluded = Number(result.excludedCount || 0);
      throw new Error(excluded
        ? `TIDAL returned ${excluded} Artist Radio track${excluded === 1 ? "" : "s"}, but they are already in the current queue. Try this radio again later.`
        : "TIDAL returned this mix, but no playable tracks were found.");
    }
    button.textContent = originalText;
    button.disabled = false;
    const skipped = Number(result.excludedCount || 0);
    $("#busy").textContent = `${options.mode === "replace" ? "Playing" : "Queueing"} ${tracks.length} track${tracks.length === 1 ? "" : "s"} from ${result.mix?.title || mix.title || "TIDAL mix"}${skipped ? `, skipped ${skipped} already in queue` : ""}...`;
    await queueTrackList(tracks, button, {
      targetCount: tracks.length,
      mode: options.mode || "append"
    });
    if (artistRadioLike) rememberTidalRadioTracks(mix, tracks);
  } catch (error) {
    button.textContent = "Failed";
    $("#busy").textContent = "";
    alert(error.message);
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1800);
  }
}

async function playTrackInRoon(track, button) {
  const zone = activeZone();
  if (!zone) return alert("Select a Roon zone first.");

  button.disabled = true;
  button.textContent = "Searching...";
  try {
    const result = await api("/api/roon/play-search-match", {
      zoneId: zone.zone_id,
      track
    });
    button.textContent = result.played ? "Playing" : "No Exact Match";
    if (!result.played) {
      console.warn("Roon did not expose a safe play action for this match.", result);
      button.title = result.reason || "Roon did not find an exact artist/title match.";
    }
  } catch (error) {
    button.textContent = "Failed";
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refreshPlaylists() {
  $("#playlistStatus").textContent = "Loading playlists...";
  try {
    const result = await getJson("/api/roon/playlists");
    state.playlists = result.playlists || [];
    $("#playlistSelect").innerHTML = state.playlists.length
      ? state.playlists.map((playlist) => `<option value="${escapeHtml(playlist.id)}">${escapeHtml(playlist.title)}${playlist.subtitle ? ` - ${escapeHtml(playlist.subtitle)}` : ""}</option>`).join("")
      : "<option value=\"\">No playlists found</option>";
    const hiddenTidalCount = Number(result.hiddenTidalPlaylistCount || 0);
    const hiddenNote = hiddenTidalCount ? ` (${hiddenTidalCount} TIDAL-backed hidden)` : "";
    $("#playlistStatus").textContent = state.playlists.length ? `${state.playlists.length} Roon local playlists available${hiddenNote}` : `No Roon local playlists found${hiddenNote}`;
  } catch (error) {
    $("#playlistStatus").textContent = error.message;
  }
}

function seedLinesFromTracks(tracks = []) {
  return tracks
    .slice(0, 80)
    .map((track) => `${track.artist || "Unknown Artist"} - ${track.title || "Untitled"}`)
    .join("\n");
}

async function useTidalPlaylistSeed() {
  const playlist = selectedTidalSeedPlaylist();
  const status = $("#tidalPlaylistSeedStatus");
  if (!playlist?.id) return;

  status.textContent = "Loading TIDAL playlist tracks...";
  try {
    const result = await api("/api/tidal/playlist-tracks", {
      playlistId: playlist.id,
      title: playlist.title,
      limit: 80
    });
    state.tidalPlaylistSeedTracks = result.tracks || [];
    const title = result.mix?.title || playlist.title || "TIDAL playlist";
    $("#reference").value = seedLinesFromTracks(state.tidalPlaylistSeedTracks);
    if (!$("#request").value.trim()) {
      $("#request").value = `find similar discoveries to ${title}`;
    }
    status.textContent = `${title}: ${state.tidalPlaylistSeedTracks.length} TIDAL seed tracks loaded`;
  } catch (error) {
    status.textContent = error.message;
  }
}

function tidalMixCardHtml(mix = {}, index = 0) {
  const imageUrl = safeHttpUrl(mix.imageUrl);
  const externalUrl = safeHttpUrl(mix.url);
  const prompt = `find discoveries inspired by my TIDAL ${mix.category || "mix"} ${mix.title || ""}`.trim();
  const itemLabel = Number(mix.itemCount || 0) ? `${Number(mix.itemCount)} tracks` : "";
  const pinnedKey = mix.pinnedKey || "";
  return `
    <article class="tidalMixCard">
      <div class="tidalMixArt">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : `<span>${escapeHtml(String(index + 1).padStart(2, "0"))}</span>`}
      </div>
      <div class="tidalMixBody">
        <div class="tidalMixTypeRow">
          <span class="tidalMixType">${escapeHtml(mix.category || "Mix")}</span>
          ${mix.pinned ? "<span class=\"tidalPinnedBadge\">Pinned</span>" : ""}
        </div>
        <h3>${escapeHtml(mix.title || "Untitled mix")}</h3>
        ${mix.subtitle ? `<p>${escapeHtml(mix.subtitle)}</p>` : ""}
        ${mix.rawType || itemLabel ? `<small>${escapeHtml([mix.rawType, itemLabel].filter(Boolean).join(" - "))}</small>` : ""}
      </div>
      <div class="tidalMixActions">
        <button type="button" data-tidal-mix-play="${index}">Play Roon</button>
        <button type="button" data-tidal-mix-next="${index}">Add Next</button>
        <button type="button" data-tidal-mix-queue="${index}">Queue</button>
        <button type="button" data-tidal-mix-prompt="${escapeHtml(prompt)}">Use as prompt</button>
        ${externalUrl ? `<a class="buttonLink" href="${escapeHtml(externalUrl)}" target="_blank" rel="noreferrer">Open TIDAL</a>` : ""}
        ${mix.pinned && pinnedKey ? `<button type="button" data-tidal-pinned-remove="${escapeHtml(pinnedKey)}">Remove pin</button>` : ""}
      </div>
    </article>
  `;
}

function renderTidalMixes(result = state.tidalMixes) {
  const status = $("#tidalMixStatus");
  const grid = $("#tidalMixesGrid");
  const pinnedStatus = $("#tidalPinnedStatus");
  if (!status || !grid) return;
  const mixes = Array.isArray(result?.mixes) ? result.mixes : [];
  const pinnedMixes = Array.isArray(result?.pinnedMixes) ? result.pinnedMixes : [];
  const pinnedErrors = Array.isArray(result?.pinnedErrors) ? result.pinnedErrors : [];
  const pinnedItems = Array.isArray(result?.pinnedItems) ? result.pinnedItems : [];
  state.tidalVisibleMixes = [...pinnedMixes, ...mixes];

  if (!result) {
    status.textContent = "TIDAL profile mixes have not been loaded yet.";
    if (pinnedStatus) pinnedStatus.textContent = "";
    grid.innerHTML = "";
    return;
  }

  const fetchedAt = result.fetchedAt ? ` Updated ${formatDateTime(Date.parse(result.fetchedAt))}.` : "";
  if (result.error && !mixes.length && !pinnedMixes.length) {
    status.textContent = `${result.error}${fetchedAt}`;
    if (pinnedStatus) pinnedStatus.textContent = pinnedItems.length ? `${pinnedItems.length} pinned item${pinnedItems.length === 1 ? "" : "s"} could not be refreshed.` : "";
    grid.innerHTML = `
      <div class="panel tidalMixEmpty">
        <strong>No TIDAL profile mixes loaded.</strong>
        <p>Use Connect TIDAL to authorize Rabbit Hole and save a refreshable profile token locally. Catalog search credentials cannot read personal mixes.</p>
      </div>
    `;
    return;
  }

  const fullShelfNote = result.fullShelfAvailable === false && result.missingLegacyScope
    ? (result.artistRadioFallbackAvailable
      ? ` Added ${Number(result.artistRadioFallbackCount || 0)} Artist Radio fallback${Number(result.artistRadioFallbackCount || 0) === 1 ? "" : "s"}.`
      : " Full Mixes & Radio needs a TIDAL legacy scope; showing only official TIDAL profile mixes.")
    : (result.fullShelfAvailable ? " Full Mixes & Radio shelf loaded." : "");
  const total = mixes.length + pinnedMixes.length;
  const pinnedNote = pinnedMixes.length
    ? ` ${pinnedMixes.length} pinned TIDAL item${pinnedMixes.length === 1 ? "" : "s"}.`
    : "";
  status.textContent = total
    ? `${total} mix/radio item${total === 1 ? "" : "s"} found.${pinnedNote}${fullShelfNote}${fetchedAt}`
    : `${result.warning || "TIDAL responded, but no personal mixes were found."}${fetchedAt}`;
  if (pinnedStatus) {
    pinnedStatus.textContent = pinnedErrors.length
      ? `${pinnedErrors.length} pinned item${pinnedErrors.length === 1 ? "" : "s"} could not be refreshed.`
      : (pinnedItems.length ? `${pinnedItems.length} pinned item${pinnedItems.length === 1 ? "" : "s"} saved locally.` : "");
  }

  const pinnedErrorHtml = pinnedErrors.length ? `
    <div class="panel tidalMixEmpty">
      <strong>Pinned import warning</strong>
      <p>${escapeHtml(pinnedErrors.map((entry) => entry.error).filter(Boolean).join(" - "))}</p>
    </div>
  ` : "";
  const pinnedHtml = pinnedMixes.length ? `
    <section class="tidalMixSection">
      <div class="tidalSectionTitle">
        <h3>Pinned TIDAL</h3>
        <span>${pinnedMixes.length} imported</span>
      </div>
      ${pinnedMixes.map((mix, index) => tidalMixCardHtml(mix, index)).join("")}
    </section>
  ` : "";
  const officialHtml = mixes.length ? `
    <section class="tidalMixSection">
      <div class="tidalSectionTitle">
        <h3>Official Profile Mixes</h3>
        <span>${mixes.length} available</span>
      </div>
      ${mixes.map((mix, index) => tidalMixCardHtml(mix, index + pinnedMixes.length)).join("")}
    </section>
  ` : "";
  grid.innerHTML = total || pinnedErrorHtml
    ? [pinnedErrorHtml, pinnedHtml, officialHtml].filter(Boolean).join("")
    : `
      <div class="panel tidalMixEmpty">
        <strong>No mix or radio cards found in the TIDAL response.</strong>
        <p>The endpoint is reachable, but Rabbit Hole did not see My Mix, Daily Discovery, New Arrivals, Track Radio, or Artist Radio items.</p>
      </div>
    `;
}

async function importPinnedTidalMix(input, button) {
  const status = $("#tidalPinnedStatus");
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Importing...";
  }
  if (status) status.textContent = "Importing TIDAL item...";
  try {
    state.tidalMixes = await api("/api/tidal/pinned-mixes", { url: input });
    state.tidalMixesNeedsRefresh = false;
    renderTidalMixes(state.tidalMixes);
    if (status) status.textContent = "Pinned TIDAL item saved.";
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "Import";
    }
  }
}

async function removePinnedTidalMix(key, button) {
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Removing...";
  }
  try {
    state.tidalMixes = await deleteJson("/api/tidal/pinned-mixes", { key });
    renderTidalMixes(state.tidalMixes);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "Remove pin";
    }
  }
}

async function refreshTidalMixes({ force = false } = {}) {
  const button = $("#refreshTidalMixes");
  const status = $("#tidalMixStatus");
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing...";
  }
  if (status) status.textContent = "Loading TIDAL profile mixes...";
  try {
    state.tidalMixes = await getJson(`/api/tidal/mixes${force ? "?refresh=1" : ""}`);
    state.tidalMixesNeedsRefresh = false;
    renderTidalMixes(state.tidalMixes);
  } catch (error) {
    state.tidalMixes = { mixes: [], error: error.message };
    renderTidalMixes(state.tidalMixes);
  } finally {
    if (button) {
      button.textContent = originalText || "Refresh mixes";
      button.disabled = false;
    }
  }
}

async function refreshSaved() {
  const result = await getJson("/api/saved");
  applySavedSnapshot(result);
  renderSaved();
  if (state.lastResult) renderResults(state.lastResult);
  updateNowDiscoveryTools(activeZone());
}

function applySavedChange(result = {}) {
  applySavedSnapshot(result);
  renderSaved();
  if (state.lastResult) renderResults(state.lastResult);
  updateNowDiscoveryTools(activeZone());
  const listNameInput = $("#savedListName");
  if (listNameInput) listNameInput.value = activeSavedList().name;
}

function renderSaved() {
  const selectedList = activeSavedList();
  const listSelect = $("#savedListSelect");
  if (listSelect) {
    listSelect.innerHTML = state.savedLists.map((list) => `
      <option value="${escapeHtml(list.id)}" ${list.id === state.activeSavedListId ? "selected" : ""}>
        ${escapeHtml(list.name)} (${Number(list.count || 0)})
      </option>
    `).join("");
  }
  const listNameInput = $("#savedListName");
  if (listNameInput && document.activeElement !== listNameInput && !listNameInput.value.trim()) {
    listNameInput.value = selectedList.name;
  }
  updateNowCandidateSaveState(state.nowTrack);

  $("#savedTitle").textContent = `${selectedList.name}: ${state.savedTracks.length} playlist candidate${state.savedTracks.length === 1 ? "" : "s"}`;
  $("#queueSaved").disabled = !state.savedTracks.length;
  $("#queueSavedNext").disabled = !state.savedTracks.length;
  $("#sendSavedTidalQueue").disabled = !state.savedTracks.length;
  $("#copySaved").disabled = !state.savedTracks.length;
  $("#exportSaved").disabled = !state.savedTracks.length;
  const deleteListButton = $("#deleteSavedList");
  if (deleteListButton) deleteListButton.disabled = state.savedLists.length <= 1;
  $("#savedTracks").innerHTML = state.savedTracks.length ? state.savedTracks.map((track, index) => {
    const key = track.key || trackKeyFor(track);
    const moveOptions = savedMoveOptionsHtml(selectedList.id);
    const tidalUrl = safeHttpUrl(track.tidal?.tidalUrl);
    return `
      <div class="track savedCandidate" id="saved-track-${index}">
        <div class="trackMain">
          <strong class="trackTitle">${index + 1}. ${escapeHtml(track.title)}</strong>
          <span class="trackMeta">${escapeHtml(track.artist)}${track.releaseDate || track.year ? ` - ${escapeHtml(track.releaseDate || track.year)}` : ""}${track.durationMs ? ` - ${escapeHtml(formatDuration(track.durationMs))}` : ""}</span>
          ${track.score ? compactScoreBadgeHtml(track) : ""}
          ${tidalUrl ? `<p class="muted">TIDAL: <a href="${escapeHtml(tidalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(track.tidal.title || track.title)}</a></p>` : ""}
        </div>
        <div class="trackActions">
          ${tidalUrl ? `<a class="buttonLink" href="${escapeHtml(tidalUrl)}" target="_blank" rel="noreferrer">TIDAL</a>` : ""}
          <button data-queue-saved="${index}">Queue</button>
          <button data-queue-next-saved="${index}">Add Next</button>
          <button data-play-saved="${index}">Play Roon</button>
          ${moveOptions ? `
            <div class="savedMoveGroup">
              <select data-move-list aria-label="Move to candidate list">
                ${moveOptions}
              </select>
              <button data-move-saved="${escapeHtml(key)}">Move</button>
            </div>
          ` : ""}
          <button data-remove-saved="${escapeHtml(key)}">Remove</button>
        </div>
      </div>
    `;
  }).join("") : `<p class="muted">Save from the Current Rabbit Hole list to build ${escapeHtml(selectedList.name)}. Searches can change freely without clearing other candidate lists.</p>`;
}

function metricCardHtml(label, value, note = "") {
  return `
    <div class="metricCard">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
    </div>
  `;
}

function reportRowHtml(item = {}, index = 0, mode = "artist") {
  const title = mode === "track" ? item.title || item.name : item.name || item.title;
  const subtitle = mode === "track"
    ? [item.artist, `${item.plays || 0} play${item.plays === 1 ? "" : "s"}`, formatHours(item.totalSeconds)].filter(Boolean).join(" - ")
    : [`${item.plays || 0} play${item.plays === 1 ? "" : "s"}`, formatHours(item.totalSeconds)].filter(Boolean).join(" - ");
  const imageUrl = safeHttpUrl(item.imageUrl);
  const art = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : `<span class="rowIndex">${index + 1}</span>`;

  return `
    <div class="reportRow">
      ${art}
      <div>
        <strong>${index + 1}. ${escapeHtml(title || "Unknown")}</strong>
        <span>${escapeHtml(subtitle)}</span>
      </div>
    </div>
  `;
}

function recentPlayHtml(play = {}) {
  const imageUrl = safeHttpUrl(play.imageUrl);
  const art = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="">` : "<span class=\"rowIndex\">></span>";
  return `
    <div class="reportRow">
      ${art}
      <div>
        <strong>${escapeHtml(play.title || "Unknown track")}</strong>
        <span>${escapeHtml([play.artist, formatDateTime(play.playedAt), play.zoneName].filter(Boolean).join(" - "))}</span>
      </div>
    </div>
  `;
}

function signalGroupHtml(title, entries = [], emptyText = "No signal yet") {
  return `
    <div class="signalGroup">
      <strong>${escapeHtml(title)}</strong>
      ${entries.length ? entries.map((entry) => `
        <span>${escapeHtml(entry.name)} <em>${entry.score > 0 ? "+" : ""}${escapeHtml(entry.score)}</em></span>
      `).join("") : `<p class="muted">${escapeHtml(emptyText)}</p>`}
    </div>
  `;
}

function renderHistoryReport(report = {}) {
  state.historyReport = report;
  state.historyNeedsRefresh = false;
  const metrics = report.metrics || {};
  const ignoredRadio = Number(metrics.ignoredRadioPlays || 0);
  $("#tasteNarrative").textContent = report.tasteNarrative || "No taste report yet.";
  $("#historyMetrics").innerHTML = [
    metricCardHtml("Observed plays", metrics.observedPlays || 0, ignoredRadio ? `${ignoredRadio} radio placeholders ignored` : "Recorded while this app is running"),
    metricCardHtml("Listening time", formatHours(metrics.knownDurationSeconds), "Known track durations"),
    metricCardHtml("Active days", metrics.activeDays || 0),
    metricCardHtml("Feedback", metrics.feedbackCount || 0, "Love, Good, OK, Wrong Genre, Skip, Never Again signals"),
    metricCardHtml("Discovery pool", metrics.discoveryCount || 0, "Previously suggested tracks")
  ].join("");

  $("#topArtists").innerHTML = report.topArtists?.length
    ? report.topArtists.map((artist, index) => reportRowHtml(artist, index, "artist")).join("")
    : "<p class=\"muted\">No artist history yet. Start playback in Roon and leave this page open.</p>";

  $("#topTracks").innerHTML = report.topTracks?.length
    ? report.topTracks.map((track, index) => reportRowHtml(track, index, "track")).join("")
    : "<p class=\"muted\">No track history yet.</p>";

  $("#tasteSignals").innerHTML = [
    signalGroupHtml("Liked artists", report.likedArtists || []),
    signalGroupHtml("Liked labels", report.likedLabels || []),
    signalGroupHtml("Rejected artists", report.rejectedArtists || [], "No rejected artist signal yet"),
    signalGroupHtml("Rejected labels", report.rejectedLabels || [], "No rejected label signal yet")
  ].join("");

  $("#recentPlays").innerHTML = report.recentPlays?.length
    ? report.recentPlays.slice(0, 12).map(recentPlayHtml).join("")
    : "<p class=\"muted\">Recent plays will fill in as Roon changes tracks.</p>";
}

async function refreshHistoryReport() {
  $("#tasteNarrative").textContent = "Refreshing listening report...";
  renderHistoryReport(await getJson("/api/history-report"));
}

function updateJumpTopVisibility() {
  const button = $("#jumpTop");
  const player = document.querySelector(".player");
  const playerViewActive = $("#playerView")?.classList.contains("isActive");
  if (!button || !player || !playerViewActive || state.playerMaximized) {
    if (button) button.hidden = true;
    return;
  }

  const rect = player.getBoundingClientRect();
  const visible = rect.bottom > 96 && rect.top < window.innerHeight - 96;
  button.hidden = visible;
}

function applyPlayerMaximized() {
  const player = document.querySelector(".player");
  const button = $("#togglePlayerMax");
  if (!player || !button) return;
  player.classList.toggle("isMaximized", state.playerMaximized);
  document.body.classList.toggle("playerMaximized", state.playerMaximized);
  button.textContent = state.playerMaximized ? "Minimize Player" : "Maximize Player";
  button.setAttribute("aria-pressed", String(state.playerMaximized));
  updateJumpTopVisibility();
}

function playerFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function drawScreenWakeFallbackFrame() {
  const canvas = screenWakeFallback.canvas;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  screenWakeFallback.flip = !screenWakeFallback.flip;
  context.fillStyle = screenWakeFallback.flip ? "#12031f" : "#160526";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = screenWakeFallback.flip ? "#c780ff" : "#65f4ff";
  context.fillRect(0, 0, 1, 1);
}

function stopScreenWakeFallback() {
  if (screenWakeFallback.timer) {
    clearInterval(screenWakeFallback.timer);
    screenWakeFallback.timer = null;
  }
  if (screenWakeFallback.video) {
    try {
      screenWakeFallback.video.pause();
    } catch {
      // Best effort cleanup; playback state is browser-owned.
    }
    screenWakeFallback.video.srcObject = null;
    screenWakeFallback.video.remove();
    screenWakeFallback.video = null;
  }
  if (screenWakeFallback.stream) {
    screenWakeFallback.stream.getTracks().forEach((track) => track.stop());
    screenWakeFallback.stream = null;
  }
  screenWakeFallback.canvas = null;
}

async function startScreenWakeFallback() {
  if (screenWakeFallback.video && !screenWakeFallback.video.paused) return true;
  if (!HTMLCanvasElement.prototype.captureStream) return false;

  stopScreenWakeFallback();
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  screenWakeFallback.canvas = canvas;
  drawScreenWakeFallbackFrame();

  const stream = canvas.captureStream(1);
  const video = document.createElement("video");
  video.className = "screenWakeVideo";
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.srcObject = stream;
  document.body.append(video);

  screenWakeFallback.stream = stream;
  screenWakeFallback.video = video;
  screenWakeFallback.timer = setInterval(drawScreenWakeFallbackFrame, 30_000);

  try {
    await video.play();
    return true;
  } catch {
    stopScreenWakeFallback();
    return false;
  }
}

async function acquireScreenWakeLock() {
  screenWakeLockDesired = true;
  if (document.visibilityState && document.visibilityState !== "visible") return false;
  if (screenWakeLock) return true;
  if (screenWakeLockPending) return screenWakeLockPending;

  screenWakeLockPending = (async () => {
    try {
      if (navigator.wakeLock?.request) {
        const lock = await navigator.wakeLock.request("screen");
        screenWakeLock = lock;
        stopScreenWakeFallback();
        lock.addEventListener("release", () => {
          if (screenWakeLock === lock) screenWakeLock = null;
          if (screenWakeLockDesired && document.visibilityState === "visible") {
            setTimeout(() => {
              acquireScreenWakeLock().catch(() => {});
            }, 500);
          }
        });
        return true;
      }
    } catch {
      screenWakeLock = null;
    }

    return startScreenWakeFallback();
  })();

  try {
    return await screenWakeLockPending;
  } finally {
    screenWakeLockPending = null;
  }
}

async function releaseScreenWakeLock() {
  screenWakeLockDesired = false;
  stopScreenWakeFallback();
  const lock = screenWakeLock;
  screenWakeLock = null;
  if (lock) {
    try {
      await lock.release();
    } catch {
      // Already released by the browser.
    }
  }
}

function syncScreenWakeLock() {
  const player = document.querySelector(".player");
  const full = player && playerFullscreenElement() === player;
  if (full) {
    acquireScreenWakeLock().catch(() => {});
  } else {
    releaseScreenWakeLock().catch(() => {});
  }
}

function applyPlayerFullscreenState() {
  const player = document.querySelector(".player");
  const button = $("#togglePlayerFull");
  if (!player || !button) return;
  const full = playerFullscreenElement() === player;
  player.classList.toggle("isFullWindow", full);
  document.body.classList.toggle("playerFullWindow", full);
  button.textContent = full ? "Exit Full Window" : "Full Window";
  button.setAttribute("aria-pressed", String(full));
  syncScreenWakeLock();
}

function setPlayerMaximized(value) {
  state.playerMaximized = Boolean(value);
  localStorage.setItem("playerMaximized", state.playerMaximized ? "1" : "0");
  applyPlayerMaximized();
}

async function setPlayerFullWindow(value) {
  const player = document.querySelector(".player");
  if (!player) return;
  const full = playerFullscreenElement() === player;
  if (value && !full) {
    setPlayerMaximized(true);
    const request = player.requestFullscreen || player.webkitRequestFullscreen;
    if (!request) return alert("This browser does not allow full-window mode from a web page. Use Add to Home Screen or browser fullscreen if available.");
    try {
      await request.call(player, { navigationUI: "hide" });
    } catch {
      await request.call(player);
    }
    applyPlayerFullscreenState();
    return;
  }
  if (!value && full) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) await exit.call(document);
  }
  applyPlayerFullscreenState();
}

function setActiveView(view) {
  const target = ["history", "tidal"].includes(view) ? view : "player";
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === target);
  });
  $("#playerView").classList.toggle("isActive", target === "player");
  $("#historyView").classList.toggle("isActive", target === "history");
  $("#tidalView")?.classList.toggle("isActive", target === "tidal");
  if (target === "history" && state.historyNeedsRefresh) {
    refreshHistoryReport().catch((error) => {
      $("#tasteNarrative").textContent = error.message;
    });
  }
  if (target === "tidal" && state.tidalMixesNeedsRefresh) {
    refreshTidalMixes().catch((error) => {
      $("#tidalMixStatus").textContent = error.message;
    });
  }
  updateJumpTopVisibility();
}

$("#zoneSelect").addEventListener("change", (event) => {
  state.selectedZoneId = event.target.value;
  localStorage.setItem("zoneId", state.selectedZoneId);
  renderState({ connected: true, core: { name: $("#connection").textContent.replace("Connected to ", "") }, zones: state.zones });
});

$("#jumpToCandidatesList").addEventListener("click", scrollToCandidatesList);

$("#openRabbitHole").addEventListener("click", () => {
  const panel = $("#rabbitHolePanel");
  const track = state.nowTrack;
  if (!panel || !track) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) loadRabbitHole(track).catch(() => {});
});

$("#rabbitHolePanel").addEventListener("click", (event) => {
  const more = event.target.closest("[data-rabbit-more]");
  if (more) {
    const section = more.closest(".rabbitDepth");
    const expanded = section?.classList.toggle("expanded");
    more.textContent = expanded ? "Show fewer" : `Show ${more.dataset.rabbitMore} more`;
    return;
  }

  const refresh = event.target.closest("[data-rabbit-refresh]");
  if (refresh && state.nowTrack) {
    loadRabbitHole(state.nowTrack, { force: true }).catch(() => {});
    return;
  }

  const run = event.target.closest("[data-rabbit-run]");
  if (run) {
    runRabbitPrompt(run.dataset.rabbitRun);
    return;
  }

  const prompt = event.target.closest("[data-rabbit-prompt]");
  if (prompt) {
    setRabbitPrompt(prompt.dataset.rabbitPrompt);
    return;
  }

  const nodeButton = event.target.closest("[data-rabbit-node]");
  if (!nodeButton) return;
  let node = {};
  try {
    node = JSON.parse(nodeButton.dataset.rabbitNode || "{}");
  } catch {
    node = {};
  }
  if (node.type === "track" && node.track && jumpToTrackIdentity(node.track)) return;
  setRabbitPrompt(node.prompt || rabbitHoleTextFor({ artist: node.name, title: "" }));
});

async function saveNowCandidateToList(listId, button = $("#saveNowCandidate")) {
  const track = state.nowTrack;
  if (!track) return;
  const originalText = button.textContent;
  const list = candidateListById(listId);
  button.disabled = true;
  button.textContent = `Saving to ${list.name}...`;
  try {
    const result = await api("/api/saved/add", {
      track,
      listId: list.id
    });
    button.textContent = result.added === false ? "Already saved" : `Added to ${list.name}`;
    toggleNowCandidateListMenu(false);
    applySavedChange(result);
  } catch (error) {
    button.textContent = originalText;
    alert(error.message);
  } finally {
    setTimeout(() => updateNowCandidateSaveState(track), 700);
  }
}

$("#saveNowCandidate").addEventListener("click", () => {
  if (!state.nowTrack) return;
  const lists = state.savedLists.length ? state.savedLists : [activeSavedList()];
  if (lists.length <= 1) {
    saveNowCandidateToList(lists[0]?.id || state.activeSavedListId).catch((error) => alert(error.message));
    return;
  }
  toggleNowCandidateListMenu();
});

$("#nowCandidateListMenu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-now-candidate-list]");
  if (!button) return;
  saveNowCandidateToList(button.dataset.nowCandidateList, $("#saveNowCandidate")).catch((error) => alert(error.message));
});

$("#nowTidalPlaylistSelect")?.addEventListener("focus", () => {
  loadTidalPlaylists({
    force: Boolean(state.tidalPlaylistsError || (state.tidalPlaylistsLoaded && !state.tidalPlaylists.length))
  }).catch(() => {});
});

$("#nowTidalPlaylistSelect")?.addEventListener("change", (event) => {
  state.selectedTidalPlaylistId = event.target.value || "";
  if (state.selectedTidalPlaylistId) localStorage.setItem("tidalPlaylistId", state.selectedTidalPlaylistId);
  renderNowTidalPlaylistControl();
});

$("#addNowToTidalPlaylist")?.addEventListener("click", () => {
  addNowTrackToTidalPlaylist().catch((error) => alert(error.message));
});

$("#jumpTop").addEventListener("click", () => {
  document.querySelector(".player")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#togglePlayerMax").addEventListener("click", () => {
  setPlayerMaximized(!state.playerMaximized);
});

$("#togglePlayerFull").addEventListener("click", () => {
  const player = document.querySelector(".player");
  setPlayerFullWindow(playerFullscreenElement() !== player).catch((error) => alert(error.message));
});

document.addEventListener("fullscreenchange", applyPlayerFullscreenState);
document.addEventListener("webkitfullscreenchange", applyPlayerFullscreenState);
document.addEventListener("visibilitychange", syncScreenWakeLock);
window.addEventListener("pageshow", syncScreenWakeLock);
window.addEventListener("pagehide", () => {
  releaseScreenWakeLock().catch(() => {});
});

$("#nowFeedback").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-now-feedback]");
  if (!button) return;
  const track = state.nowTrack;
  if (!track) return;
  if (button.dataset.saving === "true") return;

  const rating = normalizeFeedbackValue(button.dataset.nowFeedback);
  button.dataset.saving = "true";
  button.classList.add("isSaving");
  track.feedback = rating;
  setFeedbackButtonsActive($("#nowFeedback"), rating);
  try {
    const result = await api("/api/feedback", { track, rating });
    applyFeedbackResponse(result);
    state.feedbackByKey[trackKeyFor(track)] = rating;
    if (state.nowMatchIndex >= 0 && state.lastResult?.tracks?.[state.nowMatchIndex]) {
      state.lastResult.tracks[state.nowMatchIndex].feedback = rating;
    }
    if (state.nowSavedIndex >= 0 && state.savedTracks[state.nowSavedIndex]) {
      state.savedTracks[state.nowSavedIndex].feedback = rating;
    }
    if (state.lastResult) renderResults(state.lastResult);
    else updateNowDiscoveryTools(activeZone());
    renderSaved();
  } catch (error) {
    alert(error.message);
  } finally {
    button.dataset.saving = "false";
    button.classList.remove("isSaving");
  }
});

window.addEventListener("scroll", updateJumpTopVisibility, { passive: true });
window.addEventListener("resize", updateJumpTopVisibility);

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setActiveView(button.dataset.view));
});

document.querySelectorAll("[data-scoring-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    setScoringMode(button.dataset.scoringMode || "");
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveScoringModeSelection(button, 1);
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveScoringModeSelection(button, -1);
    }
  });
});
setScoringMode($("#scoringMode")?.value || "");

$("#refreshHistory").addEventListener("click", () => {
  refreshHistoryReport().catch((error) => {
    $("#tasteNarrative").textContent = error.message;
  });
});

$("#refreshTidalMixes")?.addEventListener("click", () => {
  refreshTidalMixes({ force: true }).catch((error) => {
    $("#tidalMixStatus").textContent = error.message;
  });
});

$("#tidalPinnedForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#tidalPinnedInput");
  const value = input?.value?.trim() || "";
  const button = event.submitter || event.currentTarget.querySelector("button[type='submit']");
  importPinnedTidalMix(value, button).then(() => {
    if (input) input.value = "";
  }).catch((error) => {
    $("#tidalPinnedStatus").textContent = error.message;
  });
});

$("#tidalMixesGrid")?.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-tidal-pinned-remove]");
  if (removeButton) {
    removePinnedTidalMix(removeButton.dataset.tidalPinnedRemove, removeButton).catch((error) => alert(error.message));
    return;
  }

  const actionButton = event.target.closest("[data-tidal-mix-play], [data-tidal-mix-next], [data-tidal-mix-queue]");
  if (actionButton) {
    const index = Number(actionButton.dataset.tidalMixPlay ?? actionButton.dataset.tidalMixNext ?? actionButton.dataset.tidalMixQueue);
    const mix = state.tidalVisibleMixes?.[index];
    if (!mix) return;
    const mode = actionButton.dataset.tidalMixPlay !== undefined
      ? "replace"
      : (actionButton.dataset.tidalMixNext !== undefined ? "next" : "append");
    queueTidalMix(mix, actionButton, { mode }).catch((error) => alert(error.message));
    return;
  }

  const button = event.target.closest("[data-tidal-mix-prompt]");
  if (!button) return;
  const request = $("#request");
  request.value = button.dataset.tidalMixPrompt || "";
  setScoringMode("");
  setActiveView("player");
  request.focus();
});

$("#tastePrompt").addEventListener("click", () => {
  const request = $("#request");
  const genres = document.querySelector("[name='genres']");
  const mood = document.querySelector("[name='mood']");
  const count = document.querySelector("[name='count']");
  request.value = "find tracks that match my current taste profile, but go deeper, less obvious, and avoid repeats";
  genres.value = "";
  mood.value = "";
  count.value = "";
  setScoringMode("");
  setActiveView("player");
  request.focus();
});

$("#seekSlider").addEventListener("pointerdown", () => {
  state.isSeeking = true;
});

$("#seekSlider").addEventListener("input", (event) => {
  state.isSeeking = true;
  $("#seekPosition").textContent = formatSeconds(event.target.value) || "0:00";
});

$("#seekSlider").addEventListener("change", async (event) => {
  const zone = activeZone();
  if (!zone) return;
  try {
    await api("/api/seek", { zoneId: zone.zone_id, seconds: Number(event.target.value) });
  } catch (error) {
    alert(error.message);
  } finally {
    state.isSeeking = false;
  }
});

$("#seekSlider").addEventListener("blur", () => {
  state.isSeeking = false;
});

document.addEventListener("click", async (event) => {
  const control = event.target.dataset.control;
  const volume = event.target.dataset.volume;
  const zone = activeZone();

  try {
    if (control && zone) await api("/api/control", { zoneId: zone.zone_id, control });
    if (volume) await api("/api/volume", { outputId: event.target.dataset.output, how: "relative_step", value: Number(volume) });
  } catch (error) {
    alert(error.message);
  }
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const zone = activeZone();
    const now = summarizeNowPlaying(zone);
    const request = $("#request");
    const genres = document.querySelector("[name='genres']");
    const mood = document.querySelector("[name='mood']");
    const count = document.querySelector("[name='count']");
    const releasePreset = $("#releasePreset");

    if (button.dataset.preset === "now" && now?.title) {
      request.value = `find tracks like ${now.artist} - ${now.title}, but deeper and less obvious`;
      mood.value = "";
      setScoringMode("");
    }

    if (button.dataset.preset === "artist") {
      const artist = now?.artist || "";
      request.value = artist
        ? `find tracks like ${artist}, but deeper and less obvious`
        : "find music from an artist or scene I can explore";
      mood.value = "";
      setScoringMode("");
    }

    if (button.dataset.preset === "long") {
      request.value = "find long, detailed electronic tracks released this week";
      genres.value = "";
      mood.value = "";
      count.value = "";
      if (releasePreset) releasePreset.value = "";
      setScoringMode("");
    }
  });
});

$("#releasePreset")?.addEventListener("change", (event) => {
  if (!event.target.value) return;
  for (const name of ["releaseExactDate", "releaseStartDate", "releaseEndDate"]) {
    const input = document.querySelector(`[name='${name}']`);
    if (input) input.value = "";
  }
});

for (const name of ["releaseExactDate", "releaseStartDate", "releaseEndDate"]) {
  document.querySelector(`[name='${name}']`)?.addEventListener("input", (event) => {
    if (!event.target.value) return;
    const quick = $("#releasePreset");
    if (quick) quick.value = "";
    if (name === "releaseExactDate") {
      for (const rangeName of ["releaseStartDate", "releaseEndDate"]) {
        const input = document.querySelector(`[name='${rangeName}']`);
        if (input) input.value = "";
      }
    } else {
      const exact = document.querySelector("[name='releaseExactDate']");
      if (exact) exact.value = "";
    }
  });
}

$("#refreshPlaylists").addEventListener("click", refreshPlaylists);

$("#refreshTidalSeedPlaylists")?.addEventListener("click", () => {
  loadTidalPlaylists({ force: true }).catch((error) => {
    const status = $("#tidalPlaylistSeedStatus");
    if (status) status.textContent = error.message;
  });
});

$("#tidalPlaylistSeedSelect")?.addEventListener("focus", () => {
  loadTidalPlaylists({
    force: Boolean(state.tidalPlaylistsError || (state.tidalPlaylistsLoaded && !state.tidalPlaylists.length))
  }).catch(() => {});
});

$("#tidalPlaylistSeedSelect")?.addEventListener("change", (event) => {
  state.selectedTidalSeedPlaylistId = event.target.value || "";
  if (state.selectedTidalSeedPlaylistId) localStorage.setItem("tidalSeedPlaylistId", state.selectedTidalSeedPlaylistId);
  const button = $("#useTidalPlaylistSeed");
  if (button) button.disabled = !state.selectedTidalSeedPlaylistId;
});

$("#useTidalPlaylistSeed")?.addEventListener("click", () => {
  useTidalPlaylistSeed().catch((error) => {
    const status = $("#tidalPlaylistSeedStatus");
    if (status) status.textContent = error.message;
  });
});

$("#usePlaylistSeed").addEventListener("click", async () => {
  const itemKey = $("#playlistSelect").value;
  if (!itemKey) return;
  const selectedPlaylist = state.playlists.find((playlist) => playlist.id === itemKey);

  $("#playlistStatus").textContent = "Loading playlist tracks...";
  try {
    const playlist = await api("/api/roon/playlist-tracks", { itemKey, title: selectedPlaylist?.title || "" });
    state.playlistSeedTracks = playlist.tracks || [];
    $("#reference").value = seedLinesFromTracks(state.playlistSeedTracks);
    if (!$("#request").value.trim()) {
      $("#request").value = `find similar discoveries to ${playlist.title}`;
    }
    $("#playlistStatus").textContent = `${playlist.title}: ${state.playlistSeedTracks.length} seed tracks loaded`;
  } catch (error) {
    $("#playlistStatus").textContent = error.message;
  }
});

$("#playlistForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = event.submitter || event.target.querySelector("button[type='submit']");
  const form = new FormData(event.target);
  const body = Object.fromEntries(form.entries());
  for (const field of [
    "reference",
    "genres",
    "years",
    "mood",
    "language",
    "count",
    "scoringMode",
    "minScore",
    "releasePreset",
    "releaseExactDate",
    "releaseStartDate",
    "releaseEndDate"
  ]) {
    if (body[field] !== undefined && !String(body[field] || "").trim()) delete body[field];
  }
  const zone = activeZone();
  body.zoneId = zone?.zone_id || "";
  body.nowPlaying = summarizeNowPlaying(zone);
  body.requireRoonQueueable = "";
  const generateStartedAt = Date.now();
  if (submitButton) submitButton.disabled = true;
  $("#busy").textContent = "Searching TIDAL + discovery sources...";
  $("#resultTitle").textContent = "Building rabbit hole...";
  $("#tracks").innerHTML = "";
  state.resultArtistConfirmedOnly = false;
  const artistConfirmedToggle = $("#artistConfirmedOnly");
  if (artistConfirmedToggle) artistConfirmedToggle.checked = false;
  state.lastTracks = [];
  state.displayedTracks = [];
  state.lastResult = null;
  state.rejectedDebugOpen = false;
  $("#queueAll").disabled = true;
  $("#queueAllNext").disabled = true;
  $("#sendTidalQueue").disabled = true;
  $("#copyList").disabled = true;
  $("#exportCsv").disabled = true;
  updateRejectedDebug();
  showIntentDebug(null);
  showPoolDiagnostics(null);
  showSourceReport(null);
  $("#rejectedDebug").hidden = true;
  $("#rejectedDebug").innerHTML = "";
  $("#tracks").innerHTML = `
    <div class="emptyState isWorking">
      <strong>Building a TIDAL-first discovery pool.</strong>
      <p>Rabbit Hole is scoring fresh candidates first; Send to TIDAL can bridge the final list into playback.</p>
    </div>
  `;

  try {
    const result = await api("/api/ai/playlist", body);
    renderResults(result);
  } catch (error) {
    if (isFetchDrop(error)) {
      $("#resultTitle").textContent = "Connection dropped";
      $("#tracks").innerHTML = `
        <div class="emptyState isWorking">
          <strong>Checking whether the search finished...</strong>
          <p>The phone lost the request to Rabbit Hole. If the server completed the run, this will recover the saved result automatically.</p>
        </div>
      `;
      if (await recoverGeneratedSession(generateStartedAt)) return;
    }
    $("#resultTitle").textContent = "Generation failed";
    $("#tracks").innerHTML = emptyResultHtml(error.message, {});
    showPoolDiagnostics(null);
    showSourceReport(null);
    state.rejectedDebugOpen = false;
    updateRejectedDebug();
  } finally {
    $("#busy").textContent = "";
    if (submitButton) submitButton.disabled = false;
  }
});

$("#copyList").addEventListener("click", async () => {
  await navigator.clipboard.writeText(plainList(state.displayedTracks.map(trackPayload)));
  $("#copyList").textContent = "Copied";
  setTimeout(() => {
    $("#copyList").textContent = "Copy list";
  }, 1200);
});

$("#exportCsv").addEventListener("click", () => {
  downloadCsv("roon-local-ai-discovery.csv", state.displayedTracks.map(trackPayload));
});

$("#toggleRejected").addEventListener("click", () => {
  state.rejectedDebugOpen = !state.rejectedDebugOpen;
  updateRejectedDebug();
});

$("#artistConfirmedOnly").addEventListener("change", (event) => {
  state.resultArtistConfirmedOnly = Boolean(event.target.checked);
  if (state.lastResult) renderResults(state.lastResult);
});

$("#queueAll").addEventListener("click", () => {
  const tracks = state.displayedTracks.map(trackPayload);
  queueTrackList(tracks, $("#queueAll"), {
    alternates: state.lastResult?.alternates || [],
    targetCount: tracks.length
  });
});

$("#queueAllNext").addEventListener("click", () => {
  const tracks = state.displayedTracks.map(trackPayload);
  queueTrackList(tracks, $("#queueAllNext"), {
    alternates: state.lastResult?.alternates || [],
    targetCount: tracks.length,
    mode: "next"
  });
});

$("#sendTidalQueue").addEventListener("click", () => {
  const tracks = state.displayedTracks.map(trackPayload);
  sendTracksToTidalPlaylist(tracks, $("#sendTidalQueue"), {
    title: `Rabbit Hole Queue - ${new Date().toLocaleString()}`,
    description: `Rabbit Hole generated queue with ${tracks.length} displayed track${tracks.length === 1 ? "" : "s"}.`
  });
});

$("#savedListSelect").addEventListener("change", async (event) => {
  try {
    const result = await api("/api/saved/list/select", { listId: event.target.value });
    applySavedChange(result);
  } catch (error) {
    alert(error.message);
    await refreshSaved();
  }
});

$("#createSavedList").addEventListener("click", async (event) => {
  const input = $("#savedListName");
  const name = input?.value?.trim() || "New candidates";
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await api("/api/saved/list/create", { name });
    applySavedChange(result);
    button.textContent = "Created";
  } catch (error) {
    button.textContent = originalText;
    alert(error.message);
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 900);
  }
});

$("#renameSavedList").addEventListener("click", async (event) => {
  const input = $("#savedListName");
  const name = input?.value?.trim();
  if (!name) return alert("Enter a candidate list name first.");
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Renaming...";
  try {
    const result = await api("/api/saved/list/rename", {
      listId: state.activeSavedListId,
      name
    });
    applySavedChange(result);
    button.textContent = "Renamed";
  } catch (error) {
    button.textContent = originalText;
    alert(error.message);
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 900);
  }
});

$("#deleteSavedList").addEventListener("click", async (event) => {
  const selectedList = activeSavedList();
  if (state.savedLists.length <= 1) return alert("Create another candidate list before deleting this one.");
  if (!confirm(`Delete candidate list "${selectedList.name}"? Tracks in that list will be removed from Rabbit Hole candidates.`)) return;
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Deleting...";
  try {
    const result = await api("/api/saved/list/delete", { listId: selectedList.id });
    applySavedChange(result);
    button.textContent = "Deleted";
  } catch (error) {
    button.textContent = originalText;
    alert(error.message);
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 900);
  }
});

$("#copySaved").addEventListener("click", async () => {
  await navigator.clipboard.writeText(plainList(state.savedTracks));
  $("#copySaved").textContent = "Copied";
  setTimeout(() => {
    $("#copySaved").textContent = "Copy candidates";
  }, 1200);
});

$("#exportSaved").addEventListener("click", () => {
  downloadCsv(savedListFilename("csv"), state.savedTracks);
});

$("#queueSaved").addEventListener("click", () => {
  queueTrackList(state.savedTracks, $("#queueSaved"));
});

$("#queueSavedNext").addEventListener("click", () => {
  queueTrackList(state.savedTracks, $("#queueSavedNext"), {
    mode: "next"
  });
});

$("#sendSavedTidalQueue").addEventListener("click", () => {
  const list = activeSavedList();
  sendTracksToTidalPlaylist(state.savedTracks, $("#sendSavedTidalQueue"), {
    title: `Rabbit Hole - ${list.name} - ${new Date().toLocaleString()}`,
    description: `Rabbit Hole candidate list: ${list.name}.`
  });
});

$("#purgeMemory").addEventListener("click", async (event) => {
  if (!confirm("Purge remembered discovery scores and track memory? Your Love/Good/OK/Wrong Genre/Skip/Never Again taste profile stays intact.")) return;
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Purging...";
  try {
    state.memory = await api("/api/memory/purge", {});
    renderMemoryStatus();
    button.textContent = "Purged";
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
  } catch (error) {
    button.textContent = originalText;
    button.disabled = false;
    alert(error.message);
  }
});

$("#tracks").addEventListener("click", async (event) => {
  const rejectSimilarButton = event.target.closest("[data-reject-similar]");
  if (rejectSimilarButton) {
    const index = Number(rejectSimilarButton.dataset.rejectSimilar);
    const track = state.displayedTracks[index];
    if (!track) return;
    const payload = trackPayload(track);

    const diagnostics = resultDiagnosticsFor(track);
    const reason = [
      diagnostics.risks.length ? `Risk: ${diagnostics.risks.join(", ")}` : "",
      diagnostics.kept.length ? `Kept because: ${diagnostics.kept.join(", ")}` : ""
    ].filter(Boolean).join(" | ");
    const originalText = rejectSimilarButton.textContent;
    rejectSimilarButton.disabled = true;
    rejectSimilarButton.textContent = "Saving...";
    try {
      const result = await api("/api/feedback", {
        track: payload,
        rating: "reject_similar",
        reason: reason || "Rejected similar weak discovery result."
      });
      applyFeedbackResponse(result);
      state.feedbackByKey[trackKeyFor(payload)] = "reject_similar";
      updateResultTrackFeedback(payload, "reject_similar");
      renderResults(state.lastResult || { tracks: state.lastTracks });
    } catch (error) {
      rejectSimilarButton.textContent = originalText;
      rejectSimilarButton.disabled = false;
      alert(error.message);
    }
    return;
  }

  const feedbackButton = event.target.closest("[data-feedback]");
  if (feedbackButton) {
    const index = Number(feedbackButton.dataset.index);
    const track = state.displayedTracks[index];
    if (!track) return;
    const payload = trackPayload(track);

    const rating = normalizeFeedbackValue(feedbackButton.dataset.feedback);
    const originalText = feedbackButton.textContent;
    feedbackButton.disabled = true;
    feedbackButton.textContent = "Saving...";
    try {
      const result = await api("/api/feedback", { track: payload, rating });
      applyFeedbackResponse(result);
      state.feedbackByKey[trackKeyFor(payload)] = rating;
      updateResultTrackFeedback(payload, rating);
      renderResults(state.lastResult || { tracks: state.lastTracks });
    } catch (error) {
      feedbackButton.textContent = originalText;
      alert(error.message);
    } finally {
      feedbackButton.disabled = false;
    }
    return;
  }

  const saveTrackButton = event.target.closest("[data-save-track]");
  if (saveTrackButton) {
    const saveGroup = saveTrackButton.closest(".candidateSaveGroup");
    const listId = saveGroup?.querySelector("[data-save-list]")?.value || state.activeSavedListId;
    const originalText = saveTrackButton.textContent;
    saveTrackButton.disabled = true;
    saveTrackButton.textContent = "Saving...";
    try {
      const result = await api("/api/saved/add", {
        track: JSON.parse(saveTrackButton.dataset.saveTrack),
        listId
      });
      saveTrackButton.textContent = result.added === false ? "Already saved" : "Added";
      applySavedChange(result);
    } catch (error) {
      saveTrackButton.textContent = "Failed";
      alert(error.message);
    } finally {
      setTimeout(() => {
        saveTrackButton.textContent = originalText;
        saveTrackButton.disabled = false;
      }, 900);
    }
    return;
  }

  if (event.target.dataset.queueNext) {
    await queueTrackList([JSON.parse(event.target.dataset.queueNext)], event.target, {
      targetCount: 1,
      mode: "next"
    });
    return;
  }

  if (!event.target.dataset.track) return;
  await playTrackInRoon(JSON.parse(event.target.dataset.track), event.target);
});

$("#tracks").addEventListener("change", (event) => {
  const listSelect = event.target.closest("[data-save-list]");
  if (!listSelect) return;
  const group = listSelect.closest(".candidateSaveGroup");
  const button = group?.querySelector("[data-save-track]");
  if (!group || !button) return;
  const savedInActiveList = group.dataset.activeSaved === "true";
  const selectedActiveList = listSelect.value === state.activeSavedListId;
  const savedHere = savedInActiveList && selectedActiveList;
  button.disabled = savedHere;
  button.textContent = savedHere ? "Saved" : "Add";
});

$("#savedTracks").addEventListener("click", async (event) => {
  if (event.target.dataset.queueSaved) {
    const track = state.savedTracks[Number(event.target.dataset.queueSaved)];
    if (!track) return;
    await queueTrackList([track], event.target, { targetCount: 1 });
    return;
  }

  if (event.target.dataset.queueNextSaved) {
    const track = state.savedTracks[Number(event.target.dataset.queueNextSaved)];
    if (!track) return;
    await queueTrackList([track], event.target, { targetCount: 1, mode: "next" });
    return;
  }

  if (event.target.dataset.playSaved) {
    const track = state.savedTracks[Number(event.target.dataset.playSaved)];
    if (!track) return;
    await playTrackInRoon(track, event.target);
    return;
  }

  if (event.target.dataset.moveSaved) {
    const button = event.target;
    const group = button.closest(".savedMoveGroup");
    const toListId = group?.querySelector("[data-move-list]")?.value || "";
    if (!toListId) return alert("Choose a destination candidate list first.");
    const destination = candidateListById(toListId);
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Moving...";
    try {
      const result = await api("/api/saved/move", {
        key: button.dataset.moveSaved,
        fromListId: state.activeSavedListId,
        toListId
      });
      applySavedChange(result);
      $("#busy").textContent = result.duplicate
        ? `Already in ${destination.name}; removed from current list`
        : `Moved to ${destination.name}`;
      setTimeout(() => {
        $("#busy").textContent = "";
      }, 1800);
    } catch (error) {
      button.textContent = originalText;
      alert(error.message);
    } finally {
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 900);
    }
    return;
  }

  const key = event.target.dataset.removeSaved;
  if (!key) return;
  await api("/api/saved/remove", { key, listId: state.activeSavedListId });
  await refreshSaved();
});

const events = new EventSource("/api/events");
events.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  renderState(payload);
  applyAppState(payload.app);
  state.historyNeedsRefresh = true;
};
applyPlayerMaximized();
applyPlayerFullscreenState();
refresh().catch(() => {});
refreshLlmStatus().catch(() => {});
setInterval(() => {
  refreshLlmStatus().catch(() => {});
}, 10_000);
refreshSession().catch(() => {});
refreshSaved().catch(() => {});
refreshPlaylists().catch(() => {});
loadTidalPlaylists().catch(() => {});
refreshHistoryReport().catch(() => {});
