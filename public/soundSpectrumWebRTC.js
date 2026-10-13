"use strict";
(() => {
  // Optional receive-only transport. OBS captures the owned native window;
  // this browser never captures media or opens a second audio/video consumer.
  window.createSoundSpectrumWebRTC = function ({ video, backdrop, backdropEnabled = true, presentation, onReady, onError, onStats }) {
    const background = backdropEnabled ? backdrop.getContext?.("2d", { alpha: false }) : null;
    let epoch = 0, active = false, ready = false, peer = null, request = null, resource = "", frameCallback = 0, frameKind = "", deadline = 0;
    let generation = null, frames = 0, backgroundFrames = 0, lastFrameAt = 0, backgroundAt = -Infinity, statsAt = -Infinity, statsPending = false, rtcStats = {}, previousRtp = null;
    let receiver = null, bufferTarget = 250, bufferRevision = 0, bufferSupport = null, bufferStatus = "idle", statsSampleAt = null, statsTimestamp = null;
    const painted = [], paintDurations = [];
    let progressAt = null, lastGapMs = null, maxGapMs = null, visibilityListening = false;
    let touch = null;
    try { touch = window.matchMedia?.("(pointer: coarse) and (hover: none)"); } catch {}
    const now = () => performance.now();
    const current = (token, connection) => active && token === epoch && connection === peer;
    function bufferState() {
      return { mode: bufferTarget === null ? "automatic" : "250ms", state: bufferStatus, supported: bufferSupport, requestedMs: bufferTarget };
    }
    function applyBufferTarget() {
      bufferStatus = "idle"; bufferSupport = null;
      if (!receiver) return;
      try {
        bufferSupport = "jitterBufferTarget" in receiver;
        if (!bufferSupport) { bufferStatus = "unsupported"; return; }
        // This requests the browser's total video jitter-buffer target. It is
        // neither an extra frame queue nor a delay on audible audio or PCM.
        receiver.jitterBufferTarget = bufferTarget;
        bufferStatus = receiver.jitterBufferTarget === bufferTarget ? "applied" : "rejected";
      } catch { bufferStatus = "rejected"; }
    }
    function setBufferTarget(value) {
      if (value !== null && value !== 250) return false;
      if (value !== bufferTarget) {
        bufferTarget = value; bufferRevision++;
        // Never attribute an interval spanning two choices to the new choice.
        rtcStats = {}; previousRtp = null; statsSampleAt = statsTimestamp = null;
      }
      applyBufferTarget(); return bufferState();
    }
    const visible = () => {
      try { return typeof document === "undefined" || document.hidden !== true && document.visibilityState !== "hidden"; }
      catch { return false; }
    };
    function resetProgress() { progressAt = lastGapMs = null; painted.length = 0; }
    function visibilityChanged() { resetProgress(); }
    function listenVisibility() {
      try { if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", visibilityChanged); visibilityListening = true;
      } } catch {}
    }
    function unlistenVisibility() {
      try { if (visibilityListening) document.removeEventListener("visibilitychange", visibilityChanged); } catch {}
      visibilityListening = false;
    }
    function recordProgress(at, metadata) {
      if (!visible() || !Number.isFinite(at)) { resetProgress(); return; }
      if (progressAt !== null && at >= progressAt) {
        lastGapMs = at - progressAt; maxGapMs = Math.max(maxGapMs ?? 0, lastGapMs);
      } else lastGapMs = null;
      progressAt = at;
      painted.push({ at, presented: metadata?.presentedFrames }); if (painted.length > 120) painted.shift();
    }
    function mark(value) { if (ready === value) return; ready = value; onReady?.(value); }
    function ownedResource(locationValue, viewerId, expectedGeneration) {
      if (!locationValue || typeof locationValue !== "string" || locationValue.length > 2048) return "";
      try {
        const url = new URL(locationValue, location.href), origin = new URL(location.href).origin;
        if (url.origin !== origin || url.pathname !== "/api/soundspectrum/webrtc" || url.hash || !/^[a-zA-Z0-9_-]{1,128}$/.test(url.searchParams.get("sessionId") || "")) return "";
        if (url.searchParams.has("viewerId") && url.searchParams.get("viewerId") !== viewerId || url.searchParams.has("generation") && url.searchParams.get("generation") !== String(expectedGeneration)) return "";
        url.searchParams.set("viewerId", viewerId); url.searchParams.set("generation", String(expectedGeneration));
        return url.pathname + url.search;
      } catch { return ""; }
    }
    function discard(url) {
      if (!url) return;
      // Delete this exact resource while its lease remains valid. If Stop or
      // expiry wins, server-side viewer cleanup owns retirement of the resource.
      // No gateway credentials reach the browser.
      void fetch(url, { method: "DELETE", keepalive: true }).catch(() => {});
    }
    function cancelFrames() {
      if (frameCallback) { if (frameKind === "video") video.cancelVideoFrameCallback?.(frameCallback); else cancelAnimationFrame(frameCallback); }
      frameCallback = 0; frameKind = "";
    }
    function stop() {
      epoch++; active = false; clearTimeout(deadline); deadline = 0; request?.abort(); request = null; cancelFrames(); unlistenVisibility();
      const previous = peer; peer = null; receiver = null; bufferSupport = null; bufferStatus = "idle";
      if (previous) { previous.ontrack = previous.onconnectionstatechange = previous.oniceconnectionstatechange = null; previous.close(); }
      const previousResource = resource; resource = ""; discard(previousResource);
      video.onloadeddata = video.onplaying = video.onerror = null;
      for (const track of video.srcObject?.getTracks?.() || []) track.onended = null;
      video.pause?.(); video.srcObject = null; video.removeAttribute?.("src"); video.hidden = true;
      backdrop.hidden = true; background?.clearRect(0, 0, backdrop.width, backdrop.height);
      generation = null; rtcStats = {}; previousRtp = null; painted.length = 0; statsPending = false; statsAt = -Infinity;
      statsSampleAt = statsTimestamp = null;
      resetProgress(); maxGapMs = null; paintDurations.length = 0;
      frames = backgroundFrames = lastFrameAt = 0; backgroundAt = -Infinity; mark(false);
    }
    function fail(token, connection) { if (!current(token, connection)) return; stop(); onError?.(); }
    function backdropProfile() { let mode; try { mode = presentation?.(); } catch {} return touch?.matches && ["windowed", "player-fullscreen"].includes(mode) ? "windowed-touch" : "full"; }
    function paintBackdrop(at) {
      if (!background || !video.videoWidth || !video.videoHeight || video.readyState < 2) return;
      const scale = backdropProfile() === "windowed-touch" ? Math.min(1, 320 / video.videoWidth, 180 / video.videoHeight) : 1;
      const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
      if (backdrop.width !== width || backdrop.height !== height) { backdrop.width = width; backdrop.height = height; }
      background.drawImage(video, 0, 0, width, height); backdrop.hidden = false; backgroundFrames++; backgroundAt = at; return true;
    }
    function observeFrames(token, connection) {
      function frame(at, metadata) {
        if (!current(token, connection)) return;
        frameCallback = 0;
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          if (frameKind === "video" || frames === 0 || video.currentTime !== lastFrameAt) {
            recordProgress(at, metadata);
            const paintStarted = now();
            try {
              if (paintBackdrop(at)) {
                const duration = now() - paintStarted;
                if (Number.isFinite(duration) && duration >= 0) { paintDurations.push(duration); if (paintDurations.length > 120) paintDurations.shift(); }
              }
            } catch { /* Decorative background failure does not retire healthy foreground video. */ }
            frames++;
            lastFrameAt = video.currentTime;
          }
          video.hidden = false; clearTimeout(deadline); deadline = 0; mark(true);
        }
        if (typeof video.requestVideoFrameCallback === "function") { frameKind = "video"; frameCallback = video.requestVideoFrameCallback(frame); }
        else { frameKind = "raf"; frameCallback = requestAnimationFrame(frame); }
      }
      if (typeof video.requestVideoFrameCallback === "function") { frameKind = "video"; frameCallback = video.requestVideoFrameCallback(frame); }
      else { frameKind = "raf"; frameCallback = requestAnimationFrame(frame); }
    }
    async function updateRtpStats() {
      const token = epoch, connection = peer, choice = bufferRevision, at = now();
      if (!active || !connection || statsPending || at - statsAt < 1000) return;
      statsPending = true; statsAt = at;
      try {
        const values = await connection.getStats(); if (!current(token, connection) || choice !== bufferRevision) return;
        let inbound = null;
        for (const value of values.values()) if (value.type === "inbound-rtp" && (value.kind === "video" || value.mediaType === "video") && !value.isRemote) { inbound = value; break; }
        if (!inbound) return;
        const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
        const previous = previousRtp, timestamp = finite(inbound.timestamp), bytes = finite(inbound.bytesReceived);
        const received = finite(inbound.framesReceived), decoded = finite(inbound.framesDecoded);
        const emitted = finite(inbound.jitterBufferEmittedCount), delay = finite(inbound.jitterBufferDelay);
        const targetDelay = finite(inbound.jitterBufferTargetDelay), minimumDelay = finite(inbound.jitterBufferMinimumDelay);
        const seconds = previous && previous.id === inbound.id && timestamp !== null && previous.timestamp !== null && timestamp > previous.timestamp ? (timestamp - previous.timestamp) / 1000 : 0;
        const rate = (value, before) => seconds > 0 && value !== null && Number.isFinite(before) && value >= before ? (value - before) / seconds : null;
        const byteRate = rate(bytes, previous?.bytes);
        const codec = values.get(inbound.codecId);
        const advanced = seconds > 0 && emitted !== null && previous.emitted !== null && emitted > previous.emitted;
        const reset = previous && [[bytes, previous.bytes], [received, previous.received], [decoded, previous.decoded],
          [delay, previous.delay], [targetDelay, previous.targetDelay], [minimumDelay, previous.minimumDelay]]
          .some(([value, before]) => value !== null && before !== null && value < before);
        const interval = (value, before) => advanced && !reset && value !== null && before !== null && value >= before ? (value - before) * 1000 / (emitted - previous.emitted) : null;
        // Do not make an unchanged cached RTC report appear newly measured.
        if (timestamp !== null && (statsTimestamp === null || !previous || previous.id !== inbound.id || timestamp !== statsTimestamp)) {
          // Include query latency in cache age: a late response is not fresh
          // merely because it has just arrived.
          statsSampleAt = at; statsTimestamp = timestamp;
        }
        rtcStats = { codec: typeof codec?.mimeType === "string" ? codec.mimeType.slice(0, 80) : null,
          codecParameters: typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine.slice(0, 120) : null,
          receivedBitrateMbps: byteRate === null ? null : byteRate * 8 / 1000000, averagingSeconds: seconds,
          receivedFrameWidth: finite(inbound.frameWidth), receivedFrameHeight: finite(inbound.frameHeight), framesReceived: received, framesDecoded: decoded, framesDropped: finite(inbound.framesDropped),
          receiveFps: rate(received, previous?.received), decodeFps: rate(decoded, previous?.decoded),
          framesPerSecond: finite(inbound.framesPerSecond), packetsLost: finite(inbound.packetsLost), jitterMs: finite(inbound.jitter) === null ? null : inbound.jitter * 1000,
          jitterBufferMs: interval(delay, previous?.delay ?? null), jitterBufferTargetMs: interval(targetDelay, previous?.targetDelay ?? null),
          jitterBufferMinimumMs: interval(minimumDelay, previous?.minimumDelay ?? null), bufferIntervalSeconds: advanced && !reset ? seconds : null,
          meanDecodeMs: inbound.framesDecoded > 0 && finite(inbound.totalDecodeTime) !== null ? inbound.totalDecodeTime * 1000 / inbound.framesDecoded : null,
          meanJitterBufferMs: inbound.jitterBufferEmittedCount > 0 && finite(inbound.jitterBufferDelay) !== null ? inbound.jitterBufferDelay * 1000 / inbound.jitterBufferEmittedCount : null };
        // An unchanged report cannot provide a new interval baseline.
        if (!previous || previous.id !== inbound.id || timestamp !== previous.timestamp) previousRtp = timestamp !== null ? { id: inbound.id, timestamp, bytes, received, decoded, emitted, delay, targetDelay, minimumDelay } : null;
        try { onStats?.(); } catch { /* Optional local diagnostics never interrupt video. */ }
      } catch { /* Optional stats must never affect viewing or the lease. */ }
      finally { if (token === epoch) statsPending = false; }
    }
    function resolution(width, height) { return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null; }
    function surface(element, intrinsic, context) {
      let css = null, style = null, attributes = null;
      try { const box = element.getBoundingClientRect?.(); css = box ? resolution(box.width, box.height) : null; } catch {}
      try { style = window.getComputedStyle?.(element); } catch {}
      try { attributes = context?.getContextAttributes?.(); } catch {}
      const text = value => typeof value === "string" && value.length <= 80 ? value : null;
      let imageCss = css;
      if (css && intrinsic && ["contain", "cover"].includes(style?.objectFit)) {
        const scale = style.objectFit === "cover" ? Math.max(css.width / intrinsic.width, css.height / intrinsic.height) : Math.min(css.width / intrinsic.width, css.height / intrinsic.height);
        imageCss = resolution(intrinsic.width * scale, intrinsic.height * scale);
      }
      return { css, imageCss, colorSpace: text(attributes?.colorSpace), colorType: text(attributes?.colorType), presentation: { opacity: text(style?.opacity), filter: text(style?.filter),
        imageRendering: text(style?.imageRendering), objectFit: text(style?.objectFit), imageSmoothingQuality: text(context?.imageSmoothingQuality) } };
    }
    function stats(includeFidelity = true) {
      void updateRtpStats(); const at = now(); while (painted.length && painted[0].at < at - 5000) painted.shift();
      const buffer = bufferState(), rtc = { jitterBufferMs: null, jitterBufferTargetMs: null, jitterBufferMinimumMs: null,
        bufferIntervalSeconds: null, ...rtcStats, bufferMode: buffer.mode, bufferTargetSupported: buffer.supported,
        bufferTargetState: buffer.state, requestedBufferMs: buffer.requestedMs,
        sampleAgeMs: statsSampleAt === null ? null : Math.max(0, at - statsSampleAt) };
      const span = painted.length > 1 ? painted.at(-1).at - painted[0].at : 0;
      // These existing heartbeat fields measure progressing video callbacks,
      // not optical screen refresh. The latest gap includes an ongoing wait;
      // retain the largest visible gap until Stop, even after smooth recovery.
      // Startup and hidden/resume waits have no baseline and are excluded.
      const pendingGap = active && visible() && progressAt !== null && Number.isFinite(at) && at >= progressAt ? at - progressAt : null;
      const latestGap = pendingGap === null ? null : Math.max(lastGapMs ?? 0, pendingGap);
      if (latestGap !== null) maxGapMs = Math.max(maxGapMs ?? 0, latestGap);
      const value = { transport: active ? "obs-webrtc" : "idle", frames, receivedFrames: rtcStats.framesReceived ?? null, decodedFrames: rtcStats.framesDecoded ?? null,
        displayedFps: span > 0 ? (painted.length - 1) * 1000 / span : null, receiveFps: rtcStats.receiveFps ?? null, decodeFps: rtcStats.decodeFps ?? null, meanDecodeMs: rtcStats.meanDecodeMs ?? null,
        lastPaintGapMs: latestGap, maxPaintGapMs: maxGapMs,
        meanPaintMs: paintDurations.length ? paintDurations.reduce((sum, value) => sum + value, 0) / paintDurations.length : null,
        backgroundFrames, backdropProfile: backdropProfile(), rtc };
      if (!includeFidelity) return value;
      const intrinsic = active && ready ? resolution(video.videoWidth, video.videoHeight) : null, behind = active && !backdrop.hidden ? resolution(backdrop.width, backdrop.height) : null;
      const foreground = surface(video, intrinsic), backgroundSurface = surface(backdrop, behind, background);
      const dpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 && window.devicePixelRatio <= 16 ? window.devicePixelRatio : null;
      const scale = (css, backing) => css && backing ? { cssX: css.width / backing.width, cssY: css.height / backing.height,
        deviceX: dpr ? css.width * dpr / backing.width : null, deviceY: dpr ? css.height * dpr / backing.height : null } : null;
      value.fidelity = { active, generation, format: "WebRTC", codec: rtcStats.codec || null, codecParameters: rtcStats.codecParameters || null,
        transmittedResolution: resolution(rtcStats.receivedFrameWidth, rtcStats.receivedFrameHeight), decodedResolution: intrinsic,
        foregroundCanvasResolution: null, backgroundCanvasResolution: behind, displayedCssResolution: foreground.css, displayedImageCssResolution: foreground.imageCss,
        backgroundDisplayedCssResolution: backgroundSurface.css, backgroundImageCssResolution: backgroundSurface.imageCss, devicePixelRatio: dpr,
        displayDevicePixels: foreground.imageCss && dpr ? resolution(Math.round(foreground.imageCss.width * dpr), Math.round(foreground.imageCss.height * dpr)) : null,
        foregroundScale: scale(foreground.imageCss, intrinsic), backgroundScale: scale(backgroundSurface.imageCss, behind),
        jpegPayloadMbps: null, wireMbps: rtcStats.receivedBitrateMbps ?? null, averagingSeconds: rtcStats.averagingSeconds || 0, bitrateScope: "WebRTC inbound RTP bytes; excludes transport overhead",
        canvasColorSpace: null, canvasColorType: null, backgroundCanvasColorSpace: backgroundSurface.colorSpace, backgroundCanvasColorType: backgroundSurface.colorType,
        foregroundPresentation: foreground.presentation, backgroundPresentation: backgroundSurface.presentation,
        decoderColorSpace: "Browser video decoder; negotiated color precision not verified", nativeColorSpace: "Unknown", rtc: { ...rtc } };
      return value;
    }
    async function start(viewerId, transport, expectedGeneration) {
      stop(); active = true; const token = epoch;
      generation = Number.isSafeInteger(expectedGeneration) && expectedGeneration > 0 ? expectedGeneration : null;
      if (transport !== "obs-webrtc" || generation === null || typeof window.RTCPeerConnection !== "function") { stop(); onError?.(); return; }
      let connection;
      try { connection = new RTCPeerConnection({ iceServers: [] }); } catch { stop(); onError?.(); return; }
      peer = connection; listenVisibility(); const controller = new AbortController(); request = controller;
      video.muted = true; video.autoplay = true; video.playsInline = true;
      deadline = setTimeout(() => fail(token, connection), 20000);
      connection.onconnectionstatechange = () => { if (current(token, connection) && ["failed", "closed"].includes(connection.connectionState)) fail(token, connection); };
      connection.oniceconnectionstatechange = () => { if (current(token, connection) && connection.iceConnectionState === "failed") fail(token, connection); };
      connection.ontrack = event => {
        if (!current(token, connection) || event.track?.kind !== "video" || video.srcObject) return;
        // Build a video-only stream even if the publisher accidentally offers audio.
        video.srcObject = new MediaStream([event.track]);
        video.onerror = () => fail(token, connection);
        const loaded = () => {
          if (!current(token, connection) || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
          // Hidden Chrome may suspend presentation callbacks while already
          // decoding healthy media. Loaded video, rather than its next paint,
          // establishes readiness and retires only the startup deadline.
          clearTimeout(deadline); deadline = 0; video.hidden = false; mark(true);
        };
        video.onloadeddata = video.onplaying = loaded;
        event.track.onended = () => fail(token, connection);
        Promise.resolve(video.play?.()).catch(() => fail(token, connection)); observeFrames(token, connection);
      };
      try {
        receiver = connection.addTransceiver("video", { direction: "recvonly" })?.receiver || null;
        applyBufferTarget();
        await connection.setLocalDescription(await connection.createOffer());
        if (!current(token, connection)) return;
        if (connection.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
          const change = () => { if (connection.iceGatheringState === "complete") { cleanup(); resolve(); } };
          const abort = () => { cleanup(); reject(Object.assign(Error("Cancelled"), { name: "AbortError" })); };
          const cleanup = () => { connection.removeEventListener("icegatheringstatechange", change); controller.signal.removeEventListener("abort", abort); };
          connection.addEventListener("icegatheringstatechange", change); controller.signal.addEventListener("abort", abort, { once: true }); change();
        });
        if (!current(token, connection)) return;
        const query = new URLSearchParams({ viewerId, generation: String(generation) });
        // Once POST begins, retain its response for cleanup even if Stop wins.
        // Server-side ownership bounds its lifetime when the page disappears.
        const response = await fetch("/api/soundspectrum/webrtc?" + query, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: connection.localDescription.sdp });
        const created = ownedResource(response.headers?.get("Location"), viewerId, expectedGeneration);
        if (!current(token, connection)) { discard(created); return; }
        if (!response.ok || !created) { discard(created); throw Error("WebRTC signaling unavailable"); }
        resource = created;
        const answer = await response.text();
        if (!current(token, connection)) return;
        if (!answer || answer.length > 65536) throw Error("Invalid WebRTC answer");
        await connection.setRemoteDescription({ type: "answer", sdp: answer });
      } catch { fail(token, connection); }
      finally { if (token === epoch && request === controller) request = null; }
    }
    return { start, stop, ready: () => ready, stats, setBufferTarget, bufferState };
  };
})();
