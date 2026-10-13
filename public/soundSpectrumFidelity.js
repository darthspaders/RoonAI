"use strict";
(() => {
  // Temporary, opt-in and read-only. No second media consumer or native Start.
  window.createSoundSpectrumFidelity = function ({ surface, getVideoStats, getRemote, isVisible, isReady, presentation }) {
    if (new URLSearchParams(location.search).get("visualDiagnostics") !== "1") return null;
    const panel = document.createElement("details"); panel.className = "soundSpectrumFidelity";
    const summary = document.createElement("summary"); summary.textContent = "Image quality diagnostics";
    const list = document.createElement("dl"), controls = document.createElement("div");
    const refresh = document.createElement("button"), note = document.createElement("p");
    refresh.type = "button"; refresh.textContent = "Update native measurement";
    note.className = "muted"; note.textContent = "Temporary · window size and internal render target are separate measurements.";
    controls.append(refresh); panel.append(summary, list, controls, note); surface.append(panel);
    panel.addEventListener("click", event => event.stopPropagation());
    const rows = new Map();
    let server = null, pending = null, revision = 0, lastGeneration = null, message = "";
    const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
    const size = value => number(value?.width) > 0 && number(value?.height) > 0 ? `${value.width.toFixed?.(1).replace(/\.0$/, "") || value.width} × ${value.height.toFixed?.(1).replace(/\.0$/, "") || value.height}` : "Unknown";
    const scalar = value => number(value) === null ? "Unknown" : value.toFixed(2);
    const text = value => typeof value === "string" && value.length <= 120 ? value : "Unknown";
    function row(label, value) {
      let element = rows.get(label);
      if (!element) { const title = document.createElement("dt"); title.textContent = label; element = document.createElement("dd"); list.append(title, element); rows.set(label, element); }
      if (element.textContent !== value) element.textContent = value;
    }
    function reset() { revision++; pending?.abort(); pending = null; server = null; message = ""; refresh.disabled = false; }
    function render() {
      const remote = getRemote?.() || {}, current = remote.generation;
      if (lastGeneration !== current) { reset(); lastGeneration = current; }
      const live = remote.state === "running" && isVisible?.() && isReady?.() !== false;
      panel.hidden = !live;
      if (!live) { if (pending || server) reset(); return; }
      if (!panel.open) return;
      let measurements, videoStats;
      try { videoStats = getVideoStats?.(); measurements = videoStats?.fidelity; } catch {}
      if (measurements?.active !== true || (measurements.generation !== null && measurements.generation !== current)) {
        reset(); panel.hidden = true; return;
      }
      const validServer = server?.generation === current && server.state === "running" ? server : null;
      const native = validServer?.native, capture = validServer?.capture, transmission = validServer?.transmission;
      const webRtc = measurements.format === "WebRTC" || remote.transport === "obs-webrtc";
      const hlsVideo = measurements.format === "HLS" || remote.transport === "hls", decodedVideo = webRtc || hlsVideo;
      const hls = videoStats?.hls || measurements.hls;
      const videoRoute = hlsVideo ? "HLS video" : "WebRTC video";
      row("Presentation", text(presentation?.()));
      row("Native window client", size(native?.clientResolution) + " px");
      row("Native measurement", native?.observedAt ? new Date(native.observedAt).toLocaleTimeString() + " · GetClientRect; tap Update after resizing" : "Not measured yet · tap Update");
      row("Native internal render target", "Unknown · not exposed by window capture");
      row("Capture surface", webRtc ? "OBS owned-window capture · actual capture method not verified here" : hlsVideo ? "Owned native-window capture · HLS publisher" : "Windows Graphics Capture · owned window client");
      row("Capture before scaling", size(capture?.inputResolution) + (webRtc && capture?.inputResolutionMeasurement === "obs-scene-item-source-size" ? " px · OBS scene-item source size (cached observation)" : " · negotiated input size not instrumented"));
      row("Capture after scaling", webRtc && transmission?.outputSettingsMeasurement === "obs-get-video-settings" ? size(transmission.outputSettingsResolution) + " px · OBS GetVideoSettings; output settings, not measured wire dimensions" : size(capture?.configuredResolution || remote.videoStats) + " px · configured");
      row("Transmitted JPEG", decodedVideo ? "Not used · " + videoRoute : size(measurements.transmittedResolution || transmission?.resolution) + " px · JPEG header");
      row("Received video", webRtc ? size(measurements.transmittedResolution) + " px · inbound RTP frame dimensions" : hlsVideo ? size(measurements.transmittedResolution) + " px · HLS video-track metadata" : "Not used · JPEG route");
      row("Decoded image", size(measurements.decodedResolution) + " px");
      row("Display element", size(measurements.displayedCssResolution) + " CSS px");
      row("Displayed image", size(measurements.displayedImageCssResolution) + " CSS px · includes object-fit");
      row("Canvas backing", decodedVideo ? "Foreground uses the decoded video directly" : size(measurements.foregroundCanvasResolution) + " px");
      row("Device pixel ratio", scalar(measurements.devicePixelRatio));
      row("Display pixel demand", size(measurements.displayDevicePixels) + " device px · CSS × DPR");
      row("Image enlargement", scalar(measurements.foregroundScale?.deviceX) + "× horizontal / " + scalar(measurements.foregroundScale?.deviceY) + "× vertical · device/backing");
      row("Format / quality", decodedVideo ? (hlsVideo ? "HLS" : "WebRTC") + " · " + text(measurements.codec) + " · " + scalar(transmission?.configuredBitrateMbps ?? (hlsVideo ? remote.videoStats?.configuredBitrateMbps : null)) + " Mbps publisher target (configured)" : text(measurements.format) + " · " + (number(transmission?.quality ?? remote.videoStats?.quality) ?? "Unknown") + " JPEG quality (configured)");
      row("JPEG precision / chroma", decodedVideo ? "Not used · negotiated video precision and chroma unverified" : (number(measurements.jpegPrecisionBits) ?? "Unknown") + " bits · " + text(measurements.jpegSubsampling) + " · header measurement");
      row("JPEG payload bitrate", decodedVideo ? "Not used · " + videoRoute : scalar(measurements.jpegPayloadMbps) + " Mbps · last " + scalar(measurements.averagingSeconds) + " s");
      row("Application wire bitrate", scalar(measurements.wireMbps) + (webRtc ? " Mbps · browser inbound RTP bytes; excludes network framing" : hlsVideo ? " Mbps · completed HLS segment/part bytes since first media request; excludes HTTP overhead" : " Mbps · JPEG + Rabbit Hole header; excludes network framing"));
      row("Capture payload bitrate", webRtc ? scalar(transmission?.payloadBitrateMbps) + " Mbps · " + (transmission?.bitrateScope === "publisher-stream-payload" ? "publisher stream payload, including Opus silence · server counter delta" : "publisher payload scope unverified") : scalar(transmission?.payloadBitrateMbps) + (hlsVideo ? " Mbps · server encoder counter; separate from received HLS" : " Mbps · server counter delta"));
      row("Capture conversion color", decodedVideo ? transmission ? (number(transmission.configuredBitDepth) ?? "Unknown") + " bits · " + text(transmission.configuredChromaSubsampling) + " · " + text(transmission.colorSpace) + " " + text(transmission.range) + " range (configured) · actual negotiated color unverified" : "Not measured yet · tap Update" : capture ? "NV12 · 8-bit · 4:2:0 · full range · sRGB transfer / BT.709 primaries / BT.601 matrix (configured)" : "Not measured yet · tap Update");
      row("Native / captured framebuffer color", webRtc ? "Native internal precision and capture color unknown · OBS configuration is separate" : "Native internal precision unknown · WGC BGRA/sRGB API contract; negotiated source not measured");
      row("Browser canvas color", decodedVideo ? "Foreground uses browser video decoder; canvas conversion not used" : text(measurements.canvasColorSpace) + " / " + text(measurements.canvasColorType));
      row("Browser decoder color", text(measurements.decoderColorSpace));
      row("Foreground composition", "Opacity " + text(measurements.foregroundPresentation?.opacity) + " · filter " + text(measurements.foregroundPresentation?.filter));
      row("Backdrop", size(measurements.backgroundCanvasResolution) + " backing px → " + size(measurements.backgroundDisplayedCssResolution) + " CSS px");
      row("Backdrop composition", "Opacity " + text(measurements.backgroundPresentation?.opacity) + " · filter " + text(measurements.backgroundPresentation?.filter));
      row("Sampling", text(measurements.foregroundPresentation?.imageRendering) + (decodedVideo ? " · browser video presentation" : " · canvas smoothing " + text(measurements.foregroundPresentation?.imageSmoothingQuality)));
      row("Video codec parameters", webRtc ? text(measurements.codecParameters) + " · negotiated; color depth not inferred" : hlsVideo ? text(measurements.codec) + " · HLS video track; color depth not inferred" : "Not used · JPEG route");
      row("Video decode / jitter buffer", webRtc ? scalar(measurements.rtc?.meanDecodeMs) + " / " + scalar(measurements.rtc?.meanJitterBufferMs) + " ms · cumulative averages" : hlsVideo ? "Not measured · HLS uses the browser video decoder" : "Not used · JPEG route");
      const rtc = videoStats?.rtc || measurements.rtc;
      const bufferMode = rtc?.bufferMode === "250ms" ? "250 ms" : rtc?.bufferMode === "automatic" ? "Automatic" : "Unknown";
      const bufferState = rtc?.bufferTargetState === "unsupported" ? "unsupported · browser default" : rtc?.bufferTargetState === "rejected" ? "rejected · previous buffering may remain" :
        rtc?.bufferTargetState === "applied" ? "browser setting verified · actual delay can differ" : "waiting for receiver";
      row("Video buffer preference", webRtc ? bufferMode + " · " + bufferState : hlsVideo ? scalar(hls?.requestedBufferMB) + " MB · video data target; segments and browser memory can exceed it" : "Not used · JPEG route");
      const age = number(rtc?.sampleAgeMs), interval = number(rtc?.bufferIntervalSeconds);
      const sampled = age !== null && age >= 0 && interval !== null && interval > 0;
      row("Video buffer actual / target / minimum", hlsVideo ? scalar(hls?.bufferedSeconds) + " s buffered ahead · " + scalar(hls?.latencySeconds) + " s behind live edge · no RTP jitter-buffer measurement" : !webRtc ? "Not used · JPEG route" : sampled ? scalar(rtc?.jitterBufferMs) + " / " + scalar(rtc?.jitterBufferTargetMs) + " / " + scalar(rtc?.jitterBufferMinimumMs) +
        " ms · last " + scalar(interval) + " s interval" + (age > 5000 ? " · stale" : "") : "Waiting for interval measurements");
      row("Video buffer sample age", hlsVideo ? "Current media-element buffered ranges" : !webRtc ? "Not used · JPEG route" : age !== null && age >= 0 ? scalar(age / 1000) + " s old" + (age > 5000 ? " · stale" : "") : "Unknown · waiting for measurements");
      row("Video frames dropped / packets lost", webRtc ? (number(measurements.rtc?.framesDropped) ?? "Unknown") + " / " + (number(measurements.rtc?.packetsLost) ?? "Unknown") : hlsVideo ? (number(hls?.droppedFrames) ?? "Unknown") + " since Start / Not measured · HLS HTTP transport" : "Not used · JPEG route");
      if (hlsVideo || rows.has("HLS video / callback fps")) {
        row("HLS video / callback fps", hlsVideo ? scalar(hls?.presentedFps) + " / " + scalar(hls?.callbackFps) + " fps · compositor counter / JavaScript callbacks" : "Not used · current transport");
        row("HLS frame drop interval", hlsVideo ? scalar(hls?.dropPercent) + "% · last " + scalar(hls?.playbackIntervalSeconds) + " s · video frames, not network packets" : "Not used · current transport");
        row("HLS video / drop sample age", hlsVideo ? scalar(number(hls?.presentationSampleAgeMs) === null ? null : hls.presentationSampleAgeMs / 1000) + " / " + scalar(number(hls?.playbackSampleAgeMs) === null ? null : hls.playbackSampleAgeMs / 1000) + " s old · rates unavailable after 3 s" : "Not used · current transport");
      }
      note.textContent = message || "Temporary · bitrate is variable. Unknown values are not estimates of native quality. Collapse this panel to inspect the picture.";
    }
    async function measure() {
      if (pending || panel.hidden || !panel.open) return;
      const remote = getRemote?.() || {}, current = remote.generation, attempt = ++revision, controller = new AbortController();
      pending = controller; refresh.disabled = true; message = "Reading the current owned window size…"; render();
      try {
        const response = await fetch("/api/soundspectrum/fidelity", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw Error("Native diagnostics are unavailable. Refresh after the server update is loaded.");
        const data = await response.json();
        if (attempt !== revision || (getRemote?.() || {}).generation !== current || panel.hidden) return;
        server = data?.generation === current ? data : null;
        message = server ? "Native size is from this query. Tap Update after resizing; browser dimensions and payload bitrate update with existing heartbeats." : "The renderer changed during measurement. Tap Update again.";
      } catch (error) { if (attempt === revision && error.name !== "AbortError") message = "Native measurement unavailable; browser measurements continue."; }
      finally { if (attempt === revision) { pending = null; refresh.disabled = false; render(); } }
    }
    panel.addEventListener("toggle", () => { if (panel.open) { render(); void measure(); } else { reset(); } });
    refresh.addEventListener("click", () => { void measure(); });
    return { render, clear: reset, contains: target => panel.contains?.(target) === true };
  };
})();
