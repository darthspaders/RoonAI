"use strict";

const state = {
  zones: [],
  selectedZoneId: localStorage.getItem("zoneId") || "",
  lastTracks: [],
  lastResult: null,
  playlists: [],
  playlistSeedTracks: [],
  savedTracks: [],
  feedbackByKey: {},
  appUpdatedAt: "",
  savedVersion: "",
  sessionUpdatedAt: "",
  tasteUpdatedAt: "",
  feedbackVersion: "",
  memory: null,
  historyReport: null,
  historyNeedsRefresh: true,
  nowTrack: null,
  nowTrackSource: "",
  nowMatchIndex: -1,
  nowSavedIndex: -1,
  rabbitHoleGraph: null,
  rabbitHoleKey: "",
  isSeeking: false,
  playerMaximized: localStorage.getItem("playerMaximized") === "1",
  llmStatus: null
};

const $ = (selector) => document.querySelector(selector);

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
  const roonImageUrl = !rawNow?.radio_lookup && rawNow?.image_key
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
    imageUrl: enriched?.imageUrl || roonImageUrl,
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

  const index = state.lastTracks.findIndex((track) => trackMatchesNow(track, now));
  if (index >= 0) return { index, savedIndex: -1, track: withLocalFeedback(state.lastTracks[index]), source: "current" };

  const savedIndex = state.savedTracks.findIndex((track) => trackMatchesNow(track, now));
  if (savedIndex >= 0) return { index: -1, savedIndex, track: withLocalFeedback(state.savedTracks[savedIndex]), source: "saved" };

  if (zone?.memoryTrack && trackMatchesNow(zone.memoryTrack, now)) {
    return { index: -1, savedIndex: -1, track: withLocalFeedback(zone.memoryTrack), source: "memory" };
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

function plainList(tracks) {
  return (tracks || []).map((track) => `${track.artist} - ${track.title}`).join("\n");
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
  return `<span class="scoreBadge ${escapeHtml(band.className)}">Discovery ${escapeHtml(score)} - ${escapeHtml(band.label)}</span>`;
}

function normalizeFeedbackValue(value) {
  const rating = String(value || "").toLowerCase();
  if (rating === "love") return "love";
  if (rating === "good" || rating === "up") return "good";
  if (rating === "ok" || rating === "okay") return "ok";
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
    { value: "skip", label: "&#128078; Skip", aria: "Skip" },
    { value: "never", label: "&#128683; Never Again", aria: "Never Again" }
  ];
  return options.map((option) => `
    <button type="button" class="feedbackButton ${escapeHtml(option.value)} ${feedback === option.value ? "active" : ""}" ${attr}="${escapeHtml(option.value)}" ${indexAttr}="${index}" aria-label="${escapeHtml(option.aria)}" aria-pressed="${feedback === option.value}">${option.label}</button>
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

function nowPlayingBadgeHtml(track = {}, source = "") {
  const scoreBadge = compactScoreBadgeHtml(track);
  if (scoreBadge) return scoreBadge;
  const label = source === "saved" ? "Saved candidate" : source === "memory" ? "Remembered track" : "Unscored now playing";
  return `<span class="scoreBadge unscored">${escapeHtml(label)}</span>`;
}

function updateNowDiscoveryTools(zone = activeZone()) {
  const tools = $("#nowDiscoveryTools");
  const feedback = $("#nowFeedback");
  const badge = $("#nowDiscoveryBadge");
  const jump = $("#jumpToNowTrack");
  const saveNow = $("#saveNowCandidate");
  const openRabbitHole = $("#openRabbitHole");
  const rabbitHolePanel = $("#rabbitHolePanel");
  if (!tools || !feedback || !badge || !jump || !saveNow || !openRabbitHole || !rabbitHolePanel) return;

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
    jump.disabled = true;
    jump.textContent = "Jump to track";
    saveNow.disabled = true;
    saveNow.textContent = "Add candidate";
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
  jump.textContent = match.source === "saved" ? "Jump to saved" : "Jump to track";
  jump.disabled = match.index < 0 && match.savedIndex < 0;
  const saved = isSavedCandidate(match.track);
  saveNow.disabled = saved;
  saveNow.textContent = saved ? "In candidates" : "Add candidate";
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

  if (breakdown.tasteAdjustment) {
    rows.push(["Taste Adjustment", breakdown.tasteAdjustment, 12]);
  }

  return `
    <div class="scoreBox">
      <div class="scoreTotal">
        <span>Discovery Score: <strong>${escapeHtml(score)}</strong></span>
        <span class="scoreBadge ${escapeHtml(band.className)}">${escapeHtml(band.label)}</span>
      </div>
      <div class="scoreGrid">
        ${rows.map(([label, value, max]) => `
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}${label === "Taste Adjustment" ? "" : `/${escapeHtml(max)}`}</strong>
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
      ${statuses.map((status) => `<span class="statusChip">${escapeHtml(status)}</span>`).join("")}
    </div>
  `;
}

function queueReportHtml(result = {}) {
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const queued = Array.isArray(result.queued) ? result.queued : [];
  const title = `Queued ${result.queuedCount || queued.length}/${result.requested || queued.length + failed.length}`;
  const targetReached = Number(result.queuedCount || queued.length) >= Number(result.requested || 0);
  const backupCount = queued.filter((item) => item.isAlternate).length;
  return `
    <div>
      <strong>${escapeHtml(title)}</strong>
      ${backupCount ? `<p>${escapeHtml(backupCount)} backup track${backupCount === 1 ? "" : "s"} used to fill the queue.</p>` : ""}
      ${result.warning ? `<p>${escapeHtml(result.warning)}</p>` : ""}
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

function intentListValue(value, fallback = "not specified") {
  if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
  const text = String(value || "").trim();
  return text || fallback;
}

function intentDebugHtml(intent = {}) {
  const rows = [
    ["Requested genre", intent.requestedGenre || "open-ended"],
    ["Requested vibe", intent.requestedVibe || "not specified"],
    ["Era / date range", intent.requestedEraDateRange || "not specified"],
    ["Requested length", intent.requestedLength || "not specified"],
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
  const meta = [
    track.artist,
    track.releaseDate || track.tidal?.releaseDate || track.year || "",
    track.durationMs ? formatDuration(track.durationMs) : ""
  ].filter(Boolean).join(" - ");
  return `
    <div class="track" id="track-${index}" data-track-index="${index}">
      <div class="trackMain">
        <strong class="trackTitle">${index + 1}. ${escapeHtml(track.title)}</strong>
        <span class="trackMeta">${escapeHtml(meta)}</span>
        <p class="trackLabel">${label ? escapeHtml(label) : "Label unavailable"}</p>
        ${matchSplitHtml(track)}
        ${scoreBreakdownHtml(track)}
        ${whyMatchedHtml(track)}
        <p class="sourceLine">Source: <strong>${escapeHtml(track.discoverySource || "TIDAL search")}</strong></p>
        ${statusChecksHtml(track)}
        ${track.tidal ? `<p class="muted">TIDAL: ${track.tidal.tidalUrl ? `<a href="${escapeHtml(track.tidal.tidalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(track.tidal.title || track.title)}</a>` : escapeHtml(track.tidal.title || track.title)}${track.tidal.artist ? ` - ${escapeHtml(track.tidal.artist)}` : ""}</p>` : ""}
        ${track.roon?.match ? `<p class="muted">Roon: ${escapeHtml(track.roon.match.title)}${track.roon.match.subtitle ? ` - ${escapeHtml(track.roon.match.subtitle)}` : ""}</p>` : ""}
        <div class="feedbackButtons" aria-label="Track feedback">${feedbackButtonsHtml(track, index)}</div>
      </div>
      <div class="trackActions">
        ${track.tidal?.tidalUrl ? `<a class="buttonLink" href="${escapeHtml(track.tidal.tidalUrl)}" target="_blank" rel="noreferrer">TIDAL</a>` : ""}
        <button data-save-track='${escapeHtml(JSON.stringify(track))}' ${saved ? "disabled" : ""}>${saved ? "Saved" : "Save"}</button>
        <button data-queue-next='${escapeHtml(JSON.stringify(track))}'>Add Next</button>
        <button data-track='${escapeHtml(JSON.stringify(track))}'>Play Roon</button>
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
  $("#queueAll").disabled = !state.lastTracks.length;
  $("#queueAllNext").disabled = !state.lastTracks.length;
  $("#copyList").disabled = !state.lastTracks.length;
  $("#exportCsv").disabled = !state.lastTracks.length;

  const discarded = state.lastResult.verification?.discarded || 0;
  const generated = state.lastResult.verification?.generated || state.lastTracks.length;
  const verifierLabel = state.lastResult.verification?.tidal ? "TIDAL" : "Roon";
  const queueableLabel = state.lastResult.verification?.roonQueueable ? "Roon-queueable" : "verified";
  const strictRoon = Boolean(state.lastResult.verification?.roonQueueable || state.lastResult.verification?.roonStrict);
  const minScore = Number(state.lastResult.verification?.minScore || 0);
  const minimumLabel = state.lastResult.verification?.minScoreLabel || minimumScoreLabel(minScore);
  const filteredByScore = Number(state.lastResult.verification?.scoreFiltered || 0);
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
        ? `No tracks reached ${minimumLabel}. Lower the Minimum match picker or broaden the seed/year range.`
        : `No tracks survived ${verifierLabel} catalogue filters. Try a broader year range or seed around a known artist/label.`;

  const titlePrefix = minScore ? `${state.lastTracks.length} ${minimumScoreLabel(minScore)} ${queueableLabel} tracks` : `${state.lastTracks.length} ${queueableLabel} tracks`;
  const filterSuffix = filteredByScore ? `, ${filteredByScore} below minimum` : "";
  $("#resultTitle").textContent = discarded
    ? `${titlePrefix} (${discarded} discarded from ${generated}${filterSuffix})`
    : titlePrefix;
  $("#tracks").innerHTML = state.lastTracks.length
    ? state.lastTracks.map(trackCardHtml).join("")
    : emptyResultHtml(emptyReason, state.lastResult.verification || {});
  showQueueReport(null);
  showIntentDebug(state.lastResult.verification?.intent || null);
  cleanRenderedArtifacts($("#tracks"));
  updateNowDiscoveryTools(activeZone());
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

  if (session.result?.verification?.roonQueueable) {
    renderResults(session.result);
  } else if (session.result) {
    state.lastResult = null;
    state.lastTracks = [];
    $("#queueAll").disabled = true;
    $("#copyList").disabled = true;
    $("#exportCsv").disabled = true;
    $("#resultTitle").textContent = "Previous results need Roon verification";
    $("#tracks").innerHTML = "<p class=\"muted\">Generate again to rebuild this list with strict TIDAL plus Roon verification. Old TIDAL-only session results are hidden so they do not look playable.</p>";
    showQueueReport(null);
    showIntentDebug(null);
  }
}

async function refreshSession() {
  const session = await getJson("/api/session");
  applySession(session);
}

function applyAppState(app = {}) {
  if (!app) return;
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

  const saved = applyFeedbackToTracks(app.saved || []);
  const savedVersion = savedVersionFor(saved);
  if (savedVersion !== state.savedVersion) {
    state.savedTracks = saved;
    state.savedVersion = savedVersion;
    renderSaved();
    if (state.lastResult) renderResults(state.lastResult);
  }

  const session = app.session || {};
  if (session.updatedAt && session.updatedAt !== state.sessionUpdatedAt) {
    applySession(session);
  }
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
  if (!state.zones.some((zone) => zone.zone_id === state.selectedZoneId)) {
    state.selectedZoneId = state.zones[0]?.zone_id || "";
  }

  $("#connection").textContent = payload.connected
    ? `Connected to ${payload.core.name}`
    : "Enable this extension in Roon Settings > Extensions";

  const phoneUrl = (payload.urls || []).find((url) => !url.includes("localhost"));
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
    $("#playlistStatus").textContent = state.playlists.length ? `${state.playlists.length} Roon playlists available` : "No Roon playlists found";
  } catch (error) {
    $("#playlistStatus").textContent = error.message;
  }
}

async function refreshSaved() {
  const result = await getJson("/api/saved");
  state.savedTracks = applyFeedbackToTracks(result.tracks || []);
  state.savedVersion = savedVersionFor(state.savedTracks);
  renderSaved();
  if (state.lastResult) renderResults(state.lastResult);
}

function renderSaved() {
  $("#savedTitle").textContent = `${state.savedTracks.length} playlist candidate${state.savedTracks.length === 1 ? "" : "s"}`;
  $("#queueSaved").disabled = !state.savedTracks.length;
  $("#queueSavedNext").disabled = !state.savedTracks.length;
  $("#copySaved").disabled = !state.savedTracks.length;
  $("#exportSaved").disabled = !state.savedTracks.length;
  $("#savedTracks").innerHTML = state.savedTracks.length ? state.savedTracks.map((track, index) => `
    <div class="track savedCandidate" id="saved-track-${index}">
      <div class="trackMain">
        <strong class="trackTitle">${index + 1}. ${escapeHtml(track.title)}</strong>
        <span class="trackMeta">${escapeHtml(track.artist)}${track.releaseDate || track.year ? ` - ${escapeHtml(track.releaseDate || track.year)}` : ""}${track.durationMs ? ` - ${escapeHtml(formatDuration(track.durationMs))}` : ""}</span>
        ${track.score ? compactScoreBadgeHtml(track) : ""}
        ${track.tidal?.tidalUrl ? `<p class="muted">TIDAL: <a href="${escapeHtml(track.tidal.tidalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(track.tidal.title || track.title)}</a></p>` : ""}
      </div>
      <div class="trackActions">
        ${track.tidal?.tidalUrl ? `<a class="buttonLink" href="${escapeHtml(track.tidal.tidalUrl)}" target="_blank" rel="noreferrer">TIDAL</a>` : ""}
        <button data-queue-saved="${index}">Queue</button>
        <button data-queue-next-saved="${index}">Add Next</button>
        <button data-play-saved="${index}">Play Roon</button>
        <button data-remove-saved="${escapeHtml(track.key)}">Remove</button>
      </div>
    </div>
  `).join("") : "<p class=\"muted\">Save from the Current Rabbit Hole list to build playlist candidates here. Searches can change freely without clearing this pile.</p>";
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
  const art = item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="">` : `<span class="rowIndex">${index + 1}</span>`;

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
  const art = play.imageUrl ? `<img src="${escapeHtml(play.imageUrl)}" alt="">` : "<span class=\"rowIndex\">></span>";
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
  $("#tasteNarrative").textContent = report.tasteNarrative || "No taste report yet.";
  $("#historyMetrics").innerHTML = [
    metricCardHtml("Observed plays", metrics.observedPlays || 0, "Recorded while this app is running"),
    metricCardHtml("Listening time", formatHours(metrics.knownDurationSeconds), "Known track durations"),
    metricCardHtml("Active days", metrics.activeDays || 0),
    metricCardHtml("Feedback", metrics.feedbackCount || 0, "Love, Good, OK, Skip, Never Again signals"),
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

function setPlayerMaximized(value) {
  state.playerMaximized = Boolean(value);
  localStorage.setItem("playerMaximized", state.playerMaximized ? "1" : "0");
  applyPlayerMaximized();
}

function setActiveView(view) {
  const target = view === "history" ? "history" : "player";
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === target);
  });
  $("#playerView").classList.toggle("isActive", target === "player");
  $("#historyView").classList.toggle("isActive", target === "history");
  if (target === "history" && state.historyNeedsRefresh) {
    refreshHistoryReport().catch((error) => {
      $("#tasteNarrative").textContent = error.message;
    });
  }
  updateJumpTopVisibility();
}

$("#zoneSelect").addEventListener("change", (event) => {
  state.selectedZoneId = event.target.value;
  localStorage.setItem("zoneId", state.selectedZoneId);
  renderState({ connected: true, core: { name: $("#connection").textContent.replace("Connected to ", "") }, zones: state.zones });
});

$("#jumpToNowTrack").addEventListener("click", () => {
  if (state.nowMatchIndex >= 0) scrollToDiscoveryTrack(state.nowMatchIndex);
  else if (state.nowSavedIndex >= 0) scrollToSavedTrack(state.nowSavedIndex);
});

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

$("#saveNowCandidate").addEventListener("click", async (event) => {
  const track = state.nowTrack;
  if (!track) return;
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    await api("/api/saved/add", { track });
    button.textContent = "In candidates";
    await refreshSaved();
    updateNowDiscoveryTools(activeZone());
  } catch (error) {
    button.textContent = originalText;
    alert(error.message);
  } finally {
    button.disabled = isSavedCandidate(track);
  }
});

$("#jumpTop").addEventListener("click", () => {
  document.querySelector(".player")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#togglePlayerMax").addEventListener("click", () => {
  setPlayerMaximized(!state.playerMaximized);
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
    await api("/api/feedback", { track, rating });
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

$("#refreshHistory").addEventListener("click", () => {
  refreshHistoryReport().catch((error) => {
    $("#tasteNarrative").textContent = error.message;
  });
});

$("#tastePrompt").addEventListener("click", () => {
  const request = $("#request");
  const genres = document.querySelector("[name='genres']");
  const mood = document.querySelector("[name='mood']");
  const count = document.querySelector("[name='count']");
  const scoringMode = document.querySelector("[name='scoringMode']");
  request.value = "find tracks that match my current taste profile, but go deeper, less obvious, and avoid repeats";
  genres.value = "";
  mood.value = "";
  count.value = "";
  if (scoringMode) scoringMode.value = "";
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
    const scoringMode = document.querySelector("[name='scoringMode']");
    const releasePreset = $("#releasePreset");

    if (button.dataset.preset === "now" && now?.title) {
      request.value = `find tracks like ${now.artist} - ${now.title}, but deeper and less obvious`;
      mood.value = "";
      if (scoringMode) scoringMode.value = "";
    }

    if (button.dataset.preset === "artist") {
      const artist = now?.artist || "";
      request.value = artist
        ? `find tracks like ${artist}, but deeper and less obvious`
        : "find music from an artist or scene I can explore";
      mood.value = "";
      if (scoringMode) scoringMode.value = "";
    }

    if (button.dataset.preset === "long") {
      request.value = "find long, detailed electronic tracks released this week";
      genres.value = "";
      mood.value = "";
      count.value = "";
      if (releasePreset) releasePreset.value = "";
      if (scoringMode) scoringMode.value = "";
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

$("#usePlaylistSeed").addEventListener("click", async () => {
  const itemKey = $("#playlistSelect").value;
  if (!itemKey) return;
  const selectedPlaylist = state.playlists.find((playlist) => playlist.id === itemKey);

  $("#playlistStatus").textContent = "Loading playlist tracks...";
  try {
    const playlist = await api("/api/roon/playlist-tracks", { itemKey, title: selectedPlaylist?.title || "" });
    state.playlistSeedTracks = playlist.tracks || [];
    const seedLines = state.playlistSeedTracks
      .slice(0, 80)
      .map((track) => `${track.artist || "Unknown Artist"} - ${track.title}`)
      .join("\n");
    $("#reference").value = seedLines;
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
  body.requireRoonQueueable = "true";
  if (submitButton) submitButton.disabled = true;
  $("#busy").textContent = "Searching Roon + TIDAL...";
  $("#resultTitle").textContent = "Building rabbit hole...";
  $("#tracks").innerHTML = "";
  state.lastTracks = [];
  state.lastResult = null;
  $("#queueAll").disabled = true;
  $("#queueAllNext").disabled = true;
  $("#copyList").disabled = true;
  $("#exportCsv").disabled = true;
  showIntentDebug(null);
  $("#tracks").innerHTML = `
    <div class="emptyState isWorking">
      <strong>Searching Roon first, then TIDAL metadata.</strong>
      <p>Matching to queueable Roon results can take a moment when the prompt is narrow.</p>
    </div>
  `;

  try {
    const result = await api("/api/ai/playlist", body);
    renderResults(result);
  } catch (error) {
    $("#resultTitle").textContent = "Generation failed";
    $("#tracks").innerHTML = emptyResultHtml(error.message, {});
  } finally {
    $("#busy").textContent = "";
    if (submitButton) submitButton.disabled = false;
  }
});

$("#copyList").addEventListener("click", async () => {
  await navigator.clipboard.writeText(plainList(state.lastTracks));
  $("#copyList").textContent = "Copied";
  setTimeout(() => {
    $("#copyList").textContent = "Copy list";
  }, 1200);
});

$("#exportCsv").addEventListener("click", () => {
  downloadCsv("roon-local-ai-discovery.csv", state.lastTracks);
});

$("#queueAll").addEventListener("click", () => {
  queueTrackList(state.lastTracks, $("#queueAll"), {
    alternates: state.lastResult?.alternates || [],
    targetCount: state.lastTracks.length
  });
});

$("#queueAllNext").addEventListener("click", () => {
  queueTrackList(state.lastTracks, $("#queueAllNext"), {
    alternates: state.lastResult?.alternates || [],
    targetCount: state.lastTracks.length,
    mode: "next"
  });
});

$("#copySaved").addEventListener("click", async () => {
  await navigator.clipboard.writeText(plainList(state.savedTracks));
  $("#copySaved").textContent = "Copied";
  setTimeout(() => {
    $("#copySaved").textContent = "Copy candidates";
  }, 1200);
});

$("#exportSaved").addEventListener("click", () => {
  downloadCsv("rabbit-hole-playlist-candidates.csv", state.savedTracks);
});

$("#queueSaved").addEventListener("click", () => {
  queueTrackList(state.savedTracks, $("#queueSaved"));
});

$("#queueSavedNext").addEventListener("click", () => {
  queueTrackList(state.savedTracks, $("#queueSavedNext"), {
    mode: "next"
  });
});

$("#purgeMemory").addEventListener("click", async (event) => {
  if (!confirm("Purge remembered discovery scores and track memory? Your Love/Good/OK/Skip/Never Again taste profile stays intact.")) return;
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
  const feedbackButton = event.target.closest("[data-feedback]");
  if (feedbackButton) {
    const index = Number(feedbackButton.dataset.index);
    const track = state.lastTracks[index];
    if (!track) return;

    const rating = normalizeFeedbackValue(feedbackButton.dataset.feedback);
    const originalText = feedbackButton.textContent;
    feedbackButton.disabled = true;
    feedbackButton.textContent = "Saving...";
    try {
      await api("/api/feedback", { track, rating });
      track.feedback = rating;
      state.feedbackByKey[trackKeyFor(track)] = rating;
      if (state.lastResult?.tracks?.[index]) state.lastResult.tracks[index] = track;
      renderResults(state.lastResult || { tracks: state.lastTracks });
    } catch (error) {
      feedbackButton.textContent = originalText;
      alert(error.message);
    } finally {
      feedbackButton.disabled = false;
    }
    return;
  }

  if (event.target.dataset.saveTrack) {
    event.target.disabled = true;
    event.target.textContent = "Saving...";
    try {
      await api("/api/saved/add", { track: JSON.parse(event.target.dataset.saveTrack) });
      event.target.textContent = "Saved";
      await refreshSaved();
    } catch (error) {
      event.target.textContent = "Failed";
      alert(error.message);
    } finally {
      event.target.disabled = false;
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

  const key = event.target.dataset.removeSaved;
  if (!key) return;
  await api("/api/saved/remove", { key });
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
refresh().catch(() => {});
refreshLlmStatus().catch(() => {});
setInterval(() => {
  refreshLlmStatus().catch(() => {});
}, 10_000);
refreshSession().catch(() => {});
refreshSaved().catch(() => {});
refreshPlaylists().catch(() => {});
refreshHistoryReport().catch(() => {});
