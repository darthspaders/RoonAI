"use strict";
(() => {
  // Receive the owned server's video-only HLS feed in the existing foreground.
  // The backdrop reuses that decoder; audio and PCM delay remain owned elsewhere.
  window.createSoundSpectrumHLS = function ({ video, backdrop, backdropEnabled = true, presentation, onReady, onError, onStats }) {
    const background = backdropEnabled ? backdrop.getContext?.("2d", { alpha: false }) : null;
    let epoch = 0, active = false, ready = false, player = null, generation = null, deadline = 0;
    let frameCallback = 0, frameKind = "", frames = 0, backgroundFrames = 0, lastFrameAt = 0;
    let bufferMB = 32, bitrateMbps = 600, loadedBytes = 0, loadedSegments = 0, loadedParts = 0, firstLoadAt = null;
    let progressAt = null, lastGapMs = null, maxGapMs = null, visibilityListening = false;
    let codec = null, transmitted = null, qualityBaseline = null, statsNotifyAt = -Infinity;
    const paintDurations = [];
    const callbackRate = {}, presentationRate = {}, playbackRate = {};
    let visibleCallbacks = 0;
    let filling = false, manifestReady = false, reserveTimer = 0, lastError = null;
    let touch = null;
    try { touch = window.matchMedia?.("(pointer: coarse) and (hover: none)"); } catch {}
    const now = () => performance.now();
    const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
    const current = (token, connection) => active && token === epoch && connection === player;
    function notifyStats(force = false) {
      const at = now(); if (!force && at - statsNotifyAt < 1000) return; statsNotifyAt = at;
      try { onStats?.(); } catch { /* Diagnostics cannot interrupt playback. */ }
    }
    function bufferConfig() {
      // A byte loading budget alone does not create a playback reserve. Leave
      // room for the selected reserve plus two 200 ms segments, and start far
      // enough behind live that hls.js does not seek away the queued video.
      const seconds = bufferMB * 8 / bitrateMbps;
      return { maxBufferSize: bufferMB * 1000000, maxBufferLength: seconds + 0.4,
        maxMaxBufferLength: Math.max(60, seconds + 0.4), backBufferLength: 0,
        liveSyncDuration: seconds + 0.4, liveMaxLatencyDuration: Infinity,
        maxLiveSyncPlaybackRate: 1 };
    }
    function bufferState() {
      return { state: active ? "applied" : "idle", supported: typeof window.Hls?.isSupported === "function" && window.Hls.isSupported(),
        requestedMB: bufferMB, requestedBytes: bufferMB * 1000000, targetBitrateMbps: bitrateMbps,
        estimatedSeconds: bufferMB * 8 / bitrateMbps, isMemoryCap: false };
    }
    function setBufferTarget(value) {
      if (!Number.isInteger(value) || value < 1 || value > 1000) return false;
      const changed = value !== bufferMB;
      const increased = value > bufferMB;
      bufferMB = value;
      if (player) {
        Object.assign(player.config, bufferConfig());
        if (increased && manifestReady) beginFilling(epoch, player);
        if (filling) { if (changed) armFillDeadline(epoch, player); checkReserve(epoch, player); }
      }
      notifyStats(true); return bufferState();
    }
    function setBitrateTarget(value) {
      if (!Number.isInteger(value) || value < 50 || value > 600) return false;
      bitrateMbps = value; if (player) Object.assign(player.config, bufferConfig()); notifyStats(true); return bufferState();
    }
    const visible = () => {
      try { return typeof document === "undefined" || document.hidden !== true && document.visibilityState !== "hidden"; }
      catch { return false; }
    };
    function resetRate(rate) { rate.first = rate.last = rate.sample = null; }
    function resetRates() { resetRate(callbackRate); resetRate(presentationRate); resetRate(playbackRate); visibleCallbacks = 0; }
    // The callback runs on the main thread and can miss video presentations.
    // Keep its cadence separate from compositor and playback-quality counters.
    // https://wicg.github.io/video-rvfc/#dom-videoframecallbackmetadata-presentedframes
    // https://w3c.github.io/media-playback-quality/
    function recordRate(rate, at, count, dropped = 0, sampledAt = at) {
      const validCount = value => Number.isSafeInteger(value) && value >= 0;
      if (!Number.isFinite(at) || at < 0 || !Number.isFinite(sampledAt) || sampledAt < at ||
          !validCount(count) || !validCount(dropped) || dropped > count) { resetRate(rate); return; }
      const point = { at, count, dropped };
      if (rate.last && (at < rate.last.at || count < rate.last.count || dropped < rate.last.dropped ||
        count - rate.last.count < dropped - rate.last.dropped)) resetRate(rate);
      rate.last = point;
      if (!rate.first) { rate.first = point; return; }
      const seconds = (at - rate.first.at) / 1000;
      if (seconds < 1) return;
      const total = count - rate.first.count, lost = dropped - rate.first.dropped;
      rate.sample = total / seconds <= 240 ? { at: sampledAt, seconds, totalFps: total / seconds,
        displayedFps: (total - lost) / seconds, droppedFps: lost / seconds, dropPercent: total > 0 ? lost * 100 / total : null } : null;
      rate.first = point;
    }
    function measuredRate(rate, at) {
      const sample = rate.sample, age = sample && at >= sample.at ? at - sample.at : null;
      return { age, seconds: sample?.seconds ?? null, value: active && visible() && age !== null && age <= 3000 ? sample : null };
    }
    function resetProgress() { progressAt = lastGapMs = null; resetRates(); }
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
      if (progressAt !== null && at >= progressAt) { lastGapMs = at - progressAt; maxGapMs = Math.max(maxGapMs ?? 0, lastGapMs); }
      else lastGapMs = null;
      progressAt = at;
      recordRate(callbackRate, at, ++visibleCallbacks);
      const presentationAt = Number.isFinite(metadata?.presentationTime) && metadata.presentationTime >= 0 && metadata.presentationTime <= at ? metadata.presentationTime : at;
      recordRate(presentationRate, presentationAt, metadata?.presentedFrames, 0, at);
    }
    function mark(value) { if (ready === value) return; ready = value; onReady?.(value); }
    function cancelFrames() {
      if (frameCallback) { if (frameKind === "video") video.cancelVideoFrameCallback?.(frameCallback); else cancelAnimationFrame(frameCallback); }
      frameCallback = 0; frameKind = "";
    }
    function stop() {
      epoch++; active = false; clearTimeout(deadline); deadline = 0; cancelFrames(); unlistenVisibility();
      clearTimeout(reserveTimer); reserveTimer = 0; filling = manifestReady = false; lastError = null;
      video.onloadeddata = video.onplaying = video.onerror = video.onwaiting = null;
      const previous = player; player = null;
      try { previous?.destroy(); } catch { /* Continue retiring the media element. */ }
      video.pause?.(); video.srcObject = null; video.removeAttribute?.("src"); video.load?.(); video.hidden = true;
      backdrop.hidden = true; background?.clearRect(0, 0, backdrop.width, backdrop.height);
      generation = null; codec = transmitted = qualityBaseline = null; statsNotifyAt = -Infinity;
      frames = backgroundFrames = lastFrameAt = loadedBytes = loadedSegments = loadedParts = 0; firstLoadAt = null;
      resetProgress(); maxGapMs = null; paintDurations.length = 0; mark(false);
    }
    function fail(token, connection, reason) {
      if (!current(token, connection)) return;
      let snapshot; try { snapshot = stats(false); } catch {}
      stop(); onError?.(reason, snapshot);
    }
    function backdropProfile() { let mode; try { mode = presentation?.(); } catch {} return touch?.matches && ["windowed", "player-fullscreen"].includes(mode) ? "windowed-touch" : "full"; }
    function paintBackdrop() {
      if (!background || !video.videoWidth || !video.videoHeight || video.readyState < 2) return;
      const scale = backdropProfile() === "windowed-touch" ? Math.min(1, 320 / video.videoWidth, 180 / video.videoHeight) : 1;
      const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
      if (backdrop.width !== width || backdrop.height !== height) { backdrop.width = width; backdrop.height = height; }
      background.drawImage(video, 0, 0, width, height); backdrop.hidden = false; backgroundFrames++; return true;
    }
    function observeFrames(token, connection) {
      function frame(at, metadata) {
        if (!current(token, connection)) return;
        frameCallback = 0;
        if (!filling && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          if (frameKind === "video" || frames === 0 || video.currentTime !== lastFrameAt) {
            recordProgress(at, frameKind === "video" ? metadata : undefined); const started = now();
            try { if (paintBackdrop()) {
              const duration = now() - started;
              if (Number.isFinite(duration) && duration >= 0) { paintDurations.push(duration); if (paintDurations.length > 120) paintDurations.shift(); }
            } } catch { /* A decorative backdrop failure does not retire healthy video. */ }
            frames++; lastFrameAt = video.currentTime;
          }
          video.hidden = false; clearTimeout(deadline); deadline = 0; mark(true);
        }
        if (!current(token, connection)) return;
        if (typeof video.requestVideoFrameCallback === "function") { frameKind = "video"; frameCallback = video.requestVideoFrameCallback(frame); }
        else { frameKind = "raf"; frameCallback = requestAnimationFrame(frame); }
      }
      if (typeof video.requestVideoFrameCallback === "function") { frameKind = "video"; frameCallback = video.requestVideoFrameCallback(frame); }
      else { frameKind = "raf"; frameCallback = requestAnimationFrame(frame); }
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
    function playbackQuality() {
      try { const value = video.getVideoPlaybackQuality?.(); return { total: finite(value?.totalVideoFrames), dropped: finite(value?.droppedVideoFrames) }; }
      catch { return { total: null, dropped: null }; }
    }
    function bufferedSeconds() {
      if (!active) return null;
      try { const ranges = video.buffered, at = video.currentTime;
        for (let i = 0; i < (ranges?.length || 0); i++) if (ranges.start(i) <= at && ranges.end(i) >= at) return ranges.end(i) - at;
        return 0;
      } catch { return null; }
    }
    function armFillDeadline(token, connection) {
      clearTimeout(deadline);
      deadline = setTimeout(() => fail(token, connection, "buffer-fill-timeout"), Math.max(20000, bufferMB * 8 / bitrateMbps * 2000 + 10000));
    }
    function beginFilling(token, connection) {
      if (!current(token, connection) || filling) return;
      // Keep an already displayed frame/immersive view during a refill.
      // Startup remains unready until its first frame after the reserve fills.
      filling = true; video.pause?.(); resetProgress();
      if (!current(token, connection)) return;
      armFillDeadline(token, connection);
      notifyStats(true);
    }
    function checkReserve(token, connection) {
      if (!current(token, connection) || !filling || !manifestReady) return;
      clearTimeout(reserveTimer); reserveTimer = 0;
      const target = bufferMB * 8 / bitrateMbps;
      if (video.readyState >= 2 && bufferedSeconds() >= target) {
        filling = false; resetProgress();
        try { Promise.resolve(video.play?.()).catch(() => fail(token, connection)); }
        catch { fail(token, connection); }
        notifyStats(true);
      } else {
        notifyStats();
        reserveTimer = setTimeout(() => checkReserve(token, connection), 100);
      }
    }
    function stats(includeFidelity = true) {
      const at = now();
      const quality = active ? playbackQuality() : null;
      if (active && visible()) recordRate(playbackRate, at, quality?.total, quality?.dropped);
      else resetRate(playbackRate);
      const sinceStart = key => quality?.[key] !== null && qualityBaseline?.[key] !== null && quality?.[key] >= qualityBaseline?.[key] ? quality[key] - qualityBaseline[key] : null;
      const totalFrames = sinceStart("total"), droppedFrames = sinceStart("dropped");
      const displayedFrames = totalFrames !== null && droppedFrames !== null && totalFrames >= droppedFrames ? totalFrames - droppedFrames : null;
      const callbacks = measuredRate(callbackRate, at), presentations = measuredRate(presentationRate, at), playback = measuredRate(playbackRate, at);
      const elapsed = firstLoadAt !== null && at > firstLoadAt ? (at - firstLoadAt) / 1000 : 0;
      const payloadMbps = elapsed > 0 ? loadedBytes * 8 / elapsed / 1000000 : null;
      const hls = { requestedBufferMB: bufferMB, requestedBufferBytes: bufferMB * 1000000, targetBitrateMbps: bitrateMbps,
        playbackBufferState: active ? filling ? "filling" : "playing" : "idle", reserveTargetSeconds: bufferMB * 8 / bitrateMbps,
        bufferTargetIsMemoryCap: false, bufferedSeconds: bufferedSeconds(), latencySeconds: active ? finite(player?.latency) : null,
        loadedBytes, loadedSegments, loadedParts, payloadMbps, averagingSeconds: elapsed, totalFrames, droppedFrames, displayedFrames, framesDropped: droppedFrames,
        presentedFps: presentations.value?.totalFps ?? null, callbackFps: callbacks.value?.totalFps ?? null,
        presentationIntervalSeconds: presentations.seconds, presentationSampleAgeMs: presentations.age,
        playbackTotalFps: playback.value?.totalFps ?? null, playbackDisplayedFps: playback.value?.displayedFps ?? null,
        playbackDroppedFps: playback.value?.droppedFps ?? null, dropPercent: playback.value?.dropPercent ?? null,
        playbackIntervalSeconds: playback.seconds, playbackSampleAgeMs: playback.age,
        // Playback-quality total includes dropped frames and is not a decode counter.
        framesDecoded: null };
      const pendingGap = active && visible() && progressAt !== null && Number.isFinite(at) && at >= progressAt ? at - progressAt : null;
      const latestGap = pendingGap === null ? null : Math.max(lastGapMs ?? 0, pendingGap);
      if (latestGap !== null) maxGapMs = Math.max(maxGapMs ?? 0, latestGap);
      const value = { transport: active ? "hls" : "idle", frames, receivedFrames: null, decodedFrames: null,
        displayedFps: hls.presentedFps, callbackFps: hls.callbackFps, receiveFps: null, decodeFps: null, meanDecodeMs: null,
        lastPaintGapMs: latestGap, maxPaintGapMs: maxGapMs,
        meanPaintMs: paintDurations.length ? paintDurations.reduce((sum, value) => sum + value, 0) / paintDurations.length : null,
        backgroundFrames, backdropProfile: backdropProfile(), hls,
        hlsBufferSeconds: hls.bufferedSeconds, hlsRequestedMB: bufferMB, hlsReserveSeconds: hls.reserveTargetSeconds,
        hlsMaxBufferSeconds: finite(player?.config?.maxMaxBufferLength), hlsLoadedBytes: loadedBytes,
        hlsMediaTime: finite(video.currentTime), hlsReadyState: finite(video.readyState),
        hlsDroppedFrames: droppedFrames, hlsDropPercent: hls.dropPercent, hlsBufferState: hls.playbackBufferState,
        hlsPaused: video.paused === true, hlsSeeking: video.seeking === true, hlsLastError: lastError };
      if (!includeFidelity) return value;
      const intrinsic = active && ready ? resolution(video.videoWidth, video.videoHeight) : null, behind = active && !backdrop.hidden ? resolution(backdrop.width, backdrop.height) : null;
      const foreground = surface(video, intrinsic), backgroundSurface = surface(backdrop, behind, background);
      const dpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 && window.devicePixelRatio <= 16 ? window.devicePixelRatio : null;
      const scale = (css, backing) => css && backing ? { cssX: css.width / backing.width, cssY: css.height / backing.height,
        deviceX: dpr ? css.width * dpr / backing.width : null, deviceY: dpr ? css.height * dpr / backing.height : null } : null;
      value.fidelity = { active, generation, format: "HLS", codec, codecParameters: null,
        transmittedResolution: transmitted, decodedResolution: intrinsic,
        foregroundCanvasResolution: null, backgroundCanvasResolution: behind, displayedCssResolution: foreground.css, displayedImageCssResolution: foreground.imageCss,
        backgroundDisplayedCssResolution: backgroundSurface.css, backgroundImageCssResolution: backgroundSurface.imageCss, devicePixelRatio: dpr,
        displayDevicePixels: foreground.imageCss && dpr ? resolution(Math.round(foreground.imageCss.width * dpr), Math.round(foreground.imageCss.height * dpr)) : null,
        foregroundScale: scale(foreground.imageCss, intrinsic), backgroundScale: scale(backgroundSurface.imageCss, behind),
        jpegPayloadMbps: null, wireMbps: payloadMbps, averagingSeconds: elapsed, bitrateScope: "Completed HLS segment/part payload bytes since first media request; excludes HTTP overhead",
        canvasColorSpace: null, canvasColorType: null, backgroundCanvasColorSpace: backgroundSurface.colorSpace, backgroundCanvasColorType: backgroundSurface.colorType,
        foregroundPresentation: foreground.presentation, backgroundPresentation: backgroundSurface.presentation,
        decoderColorSpace: "Browser video decoder; decoded color precision not verified", nativeColorSpace: "Unknown", hls: { ...hls } };
      return value;
    }
    function start(viewerId, transport, expectedGeneration) {
      stop();
      if (transport !== "hls" || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 ||
          typeof viewerId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(viewerId) || !window.Hls?.isSupported?.()) { onError?.(); return; }
      active = true; generation = expectedGeneration; const token = epoch;
      const path = "/api/soundspectrum/hls/" + generation + "/";
      let connection;
      function authorizedUrl(value) {
        if (!current(token, connection)) throw Error("HLS request retired");
        const url = new URL(value, location.href), origin = new URL(location.href).origin;
        if (url.origin !== origin || !url.pathname.startsWith(path) || url.username || url.password || url.hash ||
            url.searchParams.has("viewerId") && url.searchParams.get("viewerId") !== viewerId) throw Error("HLS resource unavailable");
        url.searchParams.set("viewerId", viewerId); return url.href;
      }
      try {
        connection = new window.Hls({ ...bufferConfig(), enableWorker: true, lowLatencyMode: false, debug: false,
          // All media stays on this generation and origin. The server also
          // rewrites playlist children so their authorization is explicit.
          xhrSetup: (xhr, url) => { xhr.open("GET", authorizedUrl(url), true); },
          fetchSetup: (context, init) => new Request(authorizedUrl(context.url), { ...init, credentials: "same-origin" }) });
        player = connection; listenVisibility();
        video.muted = true; video.autoplay = false; video.playsInline = true;
        qualityBaseline = playbackQuality();
        beginFilling(token, connection);
        const loaded = () => {
          if (!current(token, connection) || filling || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
          clearTimeout(deadline); deadline = 0; video.hidden = false; mark(true);
        };
        video.onloadeddata = video.onplaying = loaded; video.onerror = () => fail(token, connection);
        video.onwaiting = () => {
          if (!current(token, connection) || !manifestReady || filling || video.seeking ||
              bufferedSeconds() >= Math.min(0.1, bufferMB * 4 / bitrateMbps)) return;
          beginFilling(token, connection); checkReserve(token, connection);
        };
        const events = window.Hls.Events;
        connection.on(events.MEDIA_ATTACHED, () => {
          if (!current(token, connection)) return;
          qualityBaseline = playbackQuality();
          try { connection.loadSource(authorizedUrl(path + "index.m3u8")); } catch { fail(token, connection); }
        });
        connection.on(events.MANIFEST_PARSED, () => {
          if (!current(token, connection)) return;
          manifestReady = true; checkReserve(token, connection);
        });
        connection.on(events.FRAG_BUFFERED, () => checkReserve(token, connection));
        connection.on(events.FRAG_LOADING, () => { if (current(token, connection) && firstLoadAt === null) firstLoadAt = now(); });
        connection.on(events.FRAG_LOADED, (_event, data) => {
          if (!current(token, connection)) return;
          const bytes = finite(data?.part?.stats?.loaded ?? data?.frag?.stats?.loaded ?? data?.payload?.byteLength);
          if (bytes !== null) { loadedBytes += bytes; if (data?.part) loadedParts++; else loadedSegments++; }
          notifyStats();
        });
        connection.on(events.BUFFER_CODECS, (_event, data) => {
          if (!current(token, connection)) return;
          const track = data?.video || data?.tracks?.video, value = track?.codec;
          codec = typeof value === "string" && /^[a-zA-Z0-9.,_-]{1,80}$/.test(value) ? value : null;
          transmitted = resolution(track?.metadata?.width, track?.metadata?.height); notifyStats();
        });
        connection.on(events.ERROR, (_event, data) => {
          if (!current(token, connection)) return;
          lastError = data?.details === "bufferFullError" ? "quota" :
            ["bufferStalledError", "bufferNudgeOnStall", "bufferSeekOverHole"].includes(data?.details) ? "starved" :
            ["fragLoadError", "fragLoadTimeOut", "levelLoadError", "levelLoadTimeOut"].includes(data?.details) ? "load" :
            ["bufferAppendError", "bufferAppendingError", "bufferAppendNoProgress"].includes(data?.details) ? "append" : "other";
          notifyStats(true);
          // A paused startup cannot free forward media to satisfy a browser
          // quota. Explain the rejected target instead of waiting for minutes.
          if (filling && data?.details === "bufferFullError") fail(token, connection, "buffer-limit");
          else if (data?.fatal === true) fail(token, connection);
        });
        observeFrames(token, connection); connection.attachMedia(video);
      } catch { if (player) fail(token, player); else { stop(); onError?.(); } }
    }
    return { start, stop, ready: () => ready, stats, setBufferTarget, setBitrateTarget, bufferState };
  };
})();
