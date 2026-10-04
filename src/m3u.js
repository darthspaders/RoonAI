"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeM3uFileName(value = "rabbit-hole") {
  const base = cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[-. ]+$/g, "")
    .slice(0, 120)
    .trim();
  return `${base || "rabbit-hole"}.m3u`;
}

function trackUrl(track = {}) {
  const direct = [
    track.tidalUrl,
    track.tidal?.tidalUrl,
    track.url
  ].map(cleanText).find(value => /^https?:\/\//i.test(value));
  if (direct) return direct;

  const id = cleanText(track.tidal?.id || track.tidalId || track.id);
  return id ? `https://listen.tidal.com/track/${encodeURIComponent(id)}` : "";
}

function trackDurationSeconds(track = {}) {
  const milliseconds = Number(track.durationMs || track.tidal?.durationMs || 0);
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.max(1, Math.round(milliseconds / 1000))
    : -1;
}

function buildM3u({ title = "Rabbit Hole", tracks = [] } = {}) {
  const lines = ["#EXTM3U", `#PLAYLIST:${cleanText(title) || "Rabbit Hole"}`];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const url = trackUrl(track);
    if (!url) continue;
    const label = [cleanText(track.artist || track.tidal?.artist), cleanText(track.title || track.tidal?.title)]
      .filter(Boolean)
      .join(" - ") || "TIDAL track";
    lines.push(`#EXTINF:${trackDurationSeconds(track)},${label}`);
    lines.push(url);
  }
  return `${lines.join("\r\n")}\r\n`;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildCsv({ title = "Rabbit Hole", tracks = [] } = {}) {
  const rows = [
    ["playlist", cleanText(title) || "Rabbit Hole"],
    [],
    ["track_number", "artist", "title", "album", "duration_seconds", "tidal_url"]
  ];
  for (const [index, track] of (Array.isArray(tracks) ? tracks : []).entries()) {
    const url = trackUrl(track);
    if (!url) continue;
    const duration = trackDurationSeconds(track);
    rows.push([
      index + 1,
      cleanText(track.artist || track.tidal?.artist),
      cleanText(track.title || track.tidal?.title),
      cleanText(track.album || track.tidal?.album),
      duration < 0 ? "" : duration,
      url
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

module.exports = {
  buildCsv,
  buildM3u,
  safeM3uFileName,
  trackUrl
};
