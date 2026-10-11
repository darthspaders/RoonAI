"use strict";
(() => {
  const stage = document.querySelector("#playerView .player"), strip = document.getElementById("nowPlayback");
  if (!stage || !strip) return;
  const chain = document.getElementById("nowPlaybackChain"), signal = document.getElementById("nowPlaybackSignal");
  let zoneName = "", playing = false, request = 0;
  async function refreshSignal() {
    const asked = ++request;
    let text = "";
    try {
      const response = await fetch(`/api/roon/hqplayer?zone=${encodeURIComponent(zoneName)}`, { cache: "no-store" });
      if (response.ok) text = hqplayerSummary((await response.json()).hqplayer);
    } catch {}
    if (asked !== request) return;
    signal.textContent = text;
    signal.hidden = !text;
  }
  stage.addEventListener("roon-playback", ({ detail }) => {
    const changed = detail.zoneName !== zoneName, started = detail.state === "playing" && !playing;
    zoneName = detail.zoneName;
    playing = detail.state === "playing";
    chain.textContent = `Roon → ${zoneName} · ${detail.state}`;
    strip.hidden = !detail.connected || !zoneName;
    if (!zoneName) { request++; signal.textContent = ""; signal.hidden = true; return; }
    if (changed || started) void refreshSignal();
  });
  setInterval(() => { if (playing && zoneName && !document.hidden) void refreshSignal(); }, 5000);
})();
