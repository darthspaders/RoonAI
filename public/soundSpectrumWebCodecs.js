"use strict";
(() => {
  const errors = {
    "codec-unsupported": "Chrome does not report support for this stream with hardware decoding preferred. Try 60 Mbps, then Start visuals.",
    "decode-error": "The decoder rejected the video. Try a lower bitrate, then Start visuals.",
    "decoder-stalled": "The decoder or renderer stopped progressing. Stop visuals and retry at a lower bitrate.",
    "decoder-overflow": "The decoder produced too many queued frames. Stop visuals and retry.",
    "buffer-limit": "The video exceeds the memory limit for this playback buffer. Increase the MB limit or lower the bitrate/buffer time.",
    "buffer-timeout": "The compressed playback buffer did not fill in time. Choose a smaller buffer or retry the connection.",
    "network-timeout": "Video delivery timed out. Check the tablet Wi-Fi connection and retry.",
    "network-error": "Video delivery could not recover. Check the connection and Start visuals again.",
    "session-ended": "This video session ended or access was denied. Start visuals again.",
    "decoder-overloaded": "Playback repeatedly fell behind. Lower the bitrate, then Start visuals again.",
    "history-expired": "Video delivery fell behind the available history. Start visuals again.",
    "media-discontinuity": "Video timestamps changed. Start visuals again.",
    "codec-changed": "The stream format changed. Start visuals again.",
    "media-limit": "A video segment exceeded the experimental receiver limit.",
    "media-format": "The experimental receiver could not read this video format.",
    "renderer-unavailable": "This browser could not start the experimental video renderer."
  };
  window.soundSpectrumWebCodecsSupport = () => window.isSecureContext !== true ?
    "WebCodecs needs trusted local HTTPS. Open the secure LAN address; a certificate warning must be resolved first." :
    typeof window.VideoDecoder !== "function" || typeof window.Worker !== "function" ||
    typeof window.HTMLCanvasElement?.prototype?.transferControlToOffscreen !== "function" ?
      "This browser does not provide WebCodecs with worker canvas rendering." : "";
  window.createSoundSpectrumWebCodecs = function ({ surface, backdrop, backdropEnabled = true, onReady, onError, onStats }) {
    let worker = null, canvas = null, ready = false, mb = 32, bufferMs = 750, bitrate = 60, targetFps = 60, generation = null, value = {}, epoch = 0;
    let backdropTimer = null;
    function stats() { return { ...value, transport: "webcodecs", generation }; }
    function visibility() { worker?.postMessage({ type: "visibility", hidden: document.hidden === true }); }
    function stop() {
      epoch++; worker?.terminate(); worker = null; clearInterval(backdropTimer); backdropTimer = null;
      document.removeEventListener("visibilitychange", visibility);
      canvas?.remove(); canvas = null; backdrop.hidden = true;
      generation = null; value = {}; const wasReady = ready; ready = false; if (wasReady) onReady?.(false);
    }
    function fail(reason) {
      const snapshot = stats(); stop();
      const detail = snapshot.wcHttpStatus >= 400 ? " (HTTP " + snapshot.wcHttpStatus + "; " + (["playlist", "init", "segment"].includes(snapshot.wcRequestKind) ? snapshot.wcRequestKind : "video") + ")" : "";
      onError?.("webcodecs: " + (errors[reason] || errors["renderer-unavailable"]) + detail, snapshot);
    }
    function start(viewerId, transport, nextGeneration, options = {}) {
      stop(); const unavailable = window.soundSpectrumWebCodecsSupport();
      if (unavailable) { onError?.("webcodecs: " + unavailable); return; }
      if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 0 || !/^[\w-]{20,100}$/.test(viewerId)) { fail("network-error"); return; }
      if (Number.isInteger(options.bitrateMbps)) bitrate = options.bitrateMbps;
      if ([60,120].includes(options.targetFps)) targetFps = options.targetFps;
      generation = nextGeneration; const token = epoch;
      try {
        canvas = document.createElement("canvas"); canvas.className = "lyrionVisualWebRTC";
        canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "SoundSpectrum WebCodecs visuals");
        canvas.hidden = true; surface.prepend(canvas);
        const offscreen = canvas.transferControlToOffscreen();
        worker = new Worker("/soundSpectrumWebCodecsWorker.js?v=20261012-webcodecs-120-2");
        worker.onmessage = ({ data }) => {
          if (token !== epoch) return;
          if (data.type === "stats") { value = { ...value, ...data.value }; onStats?.(); }
          else if (data.type === "capability") { value.capability = data.value; onStats?.(); }
          else if (data.type === "ready") { canvas.hidden = false; ready = true; onReady?.(true); }
          else if (data.type === "error") { value = { ...value, ...data.stats }; fail(data.reason); }
        };
        worker.onerror = () => { if (token === epoch) fail("renderer-unavailable"); };
        const url = new URL("/api/soundspectrum/hls/" + generation + "/index.m3u8", location.href);
        url.searchParams.set("viewerId", viewerId);
        worker.postMessage({ type: "start", url: url.href, canvas: offscreen, mb, bitrate, bufferMs, targetFps }, [offscreen]);
        document.addEventListener("visibilitychange", visibility); visibility();
        // Reuse the foreground for the decorative backdrop without a second decoder.
        if (backdropEnabled) backdropTimer = setInterval(() => {
          if (!ready || document.hidden || !canvas) return;
          try { if (backdrop.width !== 320 || backdrop.height !== 180) { backdrop.width = 320; backdrop.height = 180; }
            backdrop.getContext("2d", { alpha: false })?.drawImage(canvas, 0, 0, 320, 180); backdrop.hidden = false; } catch {}
        }, 250);
      } catch { fail("renderer-unavailable"); }
    }
    return { start, stop, stats, ready: () => ready,
      setFrameRate(n) { if (![60,120].includes(n) || worker) return false; targetFps = n; return true; },
      setPlaybackBuffer(n) { if (![500,750,1000,1500,2000].includes(n) || worker) return false; bufferMs = n; return true; },
      setBufferTarget(n) { if (!Number.isInteger(n) || n < 1 || n > 1000 || worker) return false; mb = n; return true; },
      setBitrateTarget(n) { if (!Number.isInteger(n) || n < 50 || n > 600 || worker) return false; bitrate = n; return true; } };
  };
})();
