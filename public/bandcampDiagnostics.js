"use strict";
(() => {
  let pending = false;
  function render(parent, key, report, recent) {
    if (!parent) return;
    let root = document.getElementById(key);
    if (!root) {
      root = document.createElement("details"); root.id = key; root.className = "sourceReportCard";
      parent.insertAdjacentElement("afterend", root);
    }
    const summary = document.createElement("summary");
    const unavailable = Object.entries(report.counts || {}).filter(([key]) => !["ANALYZED", "NOT_CHECKED", "CHECKING"].includes(key)).reduce((n, [, count]) => n + count, 0);
    summary.textContent = `Bandcamp listening notes · ${report.counts?.ANALYZED || 0} analyzed · ${unavailable} unavailable or deferred · ${report.counts?.NOT_CHECKED || 0} not checked${report.cooldownUntil ? " · requests paused" : ""}`;
    const budget = document.createElement("p"); budget.className = "muted";
    budget.textContent = `${report.requestsLast24h}/${report.policy.requestsPerDay} requests and ${report.streamAttemptsLast24h}/${report.policy.streamsPerDay} stream attempts in 24 hours (Rabbit Hole limits).`;
    const state = document.createElement("p");
    state.textContent = report.stateAvailable === false ? "Safety history unavailable; Bandcamp access is stopped."
      : report.cooldownUntil ? `Requests paused: ${report.cooldownReason}. Retry after ${new Date(report.cooldownUntil).toLocaleString()}.`
      : "Beatport is checked first. Bandcamp's remaining-play quota is unknown. A stream refusal is never bypassed.";
    const list = document.createElement("ul");
    for (const row of report.items || []) {
      const item = document.createElement("li");
      item.textContent = `${row.artist} — ${row.title}: ${row.message}${row.checkedAt ? ` (${new Date(row.checkedAt).toLocaleString()})` : ""}`;
      list.append(item);
    }
    const note = document.createElement("p"); note.className = "muted";
    note.textContent = "A track can still receive a recommendation from other evidence when Sonic has not listened. Existing analysis and usage history are reused.";
    const recentDetails = document.createElement("details"), recentTitle = document.createElement("summary");
    recentTitle.textContent = "Recent Bandcamp attempts across all analysis"; recentDetails.append(recentTitle);
    for (const row of recent || []) {
      const item = document.createElement("p"); item.textContent = `${row.artist} — ${row.title}: ${row.message}`; recentDetails.append(item);
    }
    root.replaceChildren(summary, budget, state, list, note, recentDetails);
  }
  async function refresh() {
    if (pending || document.hidden) return;
    const discovery = document.getElementById("resultTitle")?.closest(".formHead"), standby = document.getElementById("standbyStatus");
    const visible = node => node && node.getClientRects().length > 0;
    if (!visible(discovery) && !visible(standby)) return;
    pending = true;
    try {
      const current = typeof state === "object" ? state : {};
      const discoveryTracks = current.displayedTracks || [], standbyTracks = current.standbyTracks || [];
      const id = track => String(track.tidal?.id || track.tidalId || track.tidalTrackId || "");
      const ids = tracks => tracks.map(id).filter(value => /^\d{1,20}$/.test(value)).slice(0, 40).join(",");
      const labels = new Map([...discoveryTracks, ...standbyTracks].map(track => [id(track), track]));
      const query = new URLSearchParams({ discovery: ids(discoveryTracks), standby: ids(standbyTracks) });
      const response = await fetch(`/api/sonic/bandcamp-status?${query}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error(); const data = await response.json();
      for (const report of [data.discovery, data.standby]) for (const row of report.items) {
        const track = labels.get(row.tidalId); if (track) { row.artist ||= track.artist; row.title ||= track.title; }
      }
      if (visible(discovery)) render(discovery, "discoveryBandcampNotes", data.discovery, data.items);
      if (visible(standby)) render(standby, "standbyBandcampNotes", data.standby, data.items);
    } catch {
      for (const id of ["discoveryBandcampNotes", "standbyBandcampNotes"]) {
        const root = document.getElementById(id); if (root) root.querySelector("summary").textContent = "Bandcamp listening notes unavailable · retrying status shortly";
      }
    } finally { pending = false; }
  }
  setInterval(refresh, 10000); document.addEventListener("visibilitychange", refresh); refresh();
})();
