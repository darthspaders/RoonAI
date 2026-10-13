"use strict";
(() => {
  // Decode once and acknowledge the decoder, independently of the next paint.
  // One pending bitmap is replaced by the newest frame while rAF is delayed.
  window.createSoundSpectrumVideo = function ({ image, canvas, backdrop, backdropEnabled = true, presentation, onReady, onError }) {
    const context = canvas.getContext?.("2d", { alpha: false });
    const background = backdropEnabled ? backdrop.getContext?.("2d", { alpha: false }) : null;
    let socket = null, animation = 0, deadline = 0, epoch = 0, presentationRevision = 0, active = false, ready = false, decoder = null, generation = 0, pendingFrame = null;
    let mode = "idle", frames = 0, receivedFrames = 0, decodedFrames = 0, replacedFrames = 0, busyDroppedFrames = 0, reportedAt = -Infinity, lastAt = 0;
    let backgroundFrames = 0, lastBackgroundAt = -Infinity, activeBackdropProfile = "";
    const received = [], decoded = [], painted = [], backgroundPainted = [];
    // These observations describe this browser's existing stream, not the native
    // framebuffer. They never request another frame or change its presentation.
    const receivedBytes = [];
    let transmitted = null, decodedResolution = null;
    let touchWindow = null;
    try { touchWindow = window.matchMedia?.("(pointer: coarse) and (hover: none)"); } catch {}
    const now = () => performance.now();
    function prune(samples, at) { while (samples.length && (samples.length > 120 || samples[0].at < at - 5000)) samples.shift(); }
    function sample(samples, value) { samples.push(value); prune(samples, value.at); }
    function rate(samples) { const span = samples.length > 1 ? samples.at(-1).at - samples[0].at : 0; return span > 0 ? (samples.length - 1) * 1000 / span : 0; }
    function mean(samples, key) { return samples.length ? samples.reduce((sum, value) => sum + value[key], 0) / samples.length : 0; }
    function resolution(width, height) {
      return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 131072 && height <= 131072 ? { width, height } : null;
    }
    function jpegDescription(bytes) {
      // Inspect only bounded JPEG marker headers before the compressed scan.
      // Missing/unsupported headers remain unknown; decoder behavior is intact.
      const end = Math.min(bytes.length - 2, 65536); let offset = 22;
      for (let markers = 0; markers < 128 && offset < end; markers++) {
        if (bytes[offset++] !== 0xff) return null;
        while (offset < end && bytes[offset] === 0xff) offset++;
        if (offset >= end) return null;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9 || marker === 0x00) return null;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > end) return null;
        const length = bytes[offset] * 256 + bytes[offset + 1], data = offset + 2;
        if (length < 2 || offset + length > end) return null;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          if (length < 8) return null;
          const precisionBits = bytes[data], components = bytes[data + 5];
          const size = resolution(bytes[data + 3] * 256 + bytes[data + 4], bytes[data + 1] * 256 + bytes[data + 2]);
          if (!size || precisionBits < 1 || precisionBits > 16 || components < 1 || components > 4 || length !== 8 + components * 3) return null;
          const sampling = [];
          for (let component = 0; component < components; component++) {
            const value = bytes[data + 7 + component * 3], x = value >> 4, y = value & 15;
            if (!x || !y || x > 4 || y > 4) return null;
            sampling.push({ x, y });
          }
          let subsampling = components === 1 ? "grayscale" : sampling.map(value => `${value.x}x${value.y}`).join(":");
          if (components === 3 && sampling[1].x === sampling[2].x && sampling[1].y === sampling[2].y) {
            const x = sampling[0].x / sampling[1].x, y = sampling[0].y / sampling[1].y;
            subsampling = x === 1 && y === 1 ? "4:4:4" : x === 2 && y === 1 ? "4:2:2" : x === 2 && y === 2 ? "4:2:0" : subsampling;
          }
          return { resolution: size, precisionBits, subsampling };
        }
        offset += length;
      }
      return null;
    }
    function resetFidelity() { transmitted = decodedResolution = null; receivedBytes.length = 0; }
    function pruneBytes(at) { while (receivedBytes.length && (receivedBytes.length > 300 || receivedBytes[0].at < at - 5000)) receivedBytes.shift(); }
    function observePacket(bytes, at) {
      transmitted = jpegDescription(bytes);
      receivedBytes.push({ at, jpeg: bytes.byteLength - 20, wire: bytes.byteLength }); pruneBytes(at);
    }
    function surfaceDescription(element, source, drawingContext) {
      let css = null, style = null, attributes = null;
      try { const box = element.getBoundingClientRect?.(); css = box ? resolution(box.width, box.height) : null; } catch {}
      try { style = window.getComputedStyle?.(element); } catch {}
      try { attributes = drawingContext?.getContextAttributes?.(); } catch {}
      const text = value => typeof value === "string" && value.length <= 80 ? value : null;
      let imageCss = css;
      if (css && source && ["contain", "cover", "scale-down", "none"].includes(style?.objectFit)) {
        const fit = style.objectFit;
        const scale = fit === "none" ? 1 : fit === "cover" ? Math.max(css.width / source.width, css.height / source.height) : Math.min(fit === "scale-down" ? 1 : Infinity, css.width / source.width, css.height / source.height);
        imageCss = resolution(source.width * scale, source.height * scale);
      }
      return { css, imageCss, colorSpace: text(attributes?.colorSpace), colorType: text(attributes?.colorType),
        presentation: { opacity: text(style?.opacity), filter: text(style?.filter), imageRendering: text(style?.imageRendering), objectFit: text(style?.objectFit),
          imageSmoothingEnabled: typeof drawingContext?.imageSmoothingEnabled === "boolean" ? drawingContext.imageSmoothingEnabled : null,
          imageSmoothingQuality: text(drawingContext?.imageSmoothingQuality) } };
    }
    function fidelityStats(at) {
      pruneBytes(at);
      const live = active && mode !== "idle", foregroundCanvas = live && mode === "websocket" && !canvas.hidden ? resolution(canvas.width, canvas.height) : null;
      const backgroundCanvas = live && !backdrop.hidden ? resolution(backdrop.width, backdrop.height) : null;
      const source = live && mode === "mjpeg" && ready ? resolution(image.naturalWidth, image.naturalHeight) : decodedResolution;
      const foreground = surfaceDescription(mode === "mjpeg" ? image : canvas, source, mode === "mjpeg" ? null : context);
      const behind = surfaceDescription(backdrop, backgroundCanvas, background);
      const dpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 && window.devicePixelRatio <= 16 ? window.devicePixelRatio : null;
      const scale = (css, backing) => css && backing ? { cssX: css.width / backing.width, cssY: css.height / backing.height,
        deviceX: dpr ? css.width * dpr / backing.width : null, deviceY: dpr ? css.height * dpr / backing.height : null } : null;
      const seconds = receivedBytes.length > 1 ? (receivedBytes.at(-1).at - receivedBytes[0].at) / 1000 : 0;
      const bitrate = key => live && mode === "websocket" && seconds > 0 ? receivedBytes.slice(1).reduce((sum, value) => sum + value[key], 0) * 8 / seconds / 1000000 : null;
      return { active: live, generation: live && mode === "websocket" ? generation : null, format: mode === "websocket" ? "JPEG" : mode === "mjpeg" ? "MJPEG" : null,
        transmittedResolution: live ? transmitted?.resolution || null : null, jpegPrecisionBits: live ? transmitted?.precisionBits || null : null, jpegSubsampling: live ? transmitted?.subsampling || null : null,
        decodedResolution: live ? source : null, foregroundCanvasResolution: foregroundCanvas, backgroundCanvasResolution: backgroundCanvas,
        displayedCssResolution: foreground.css, displayedImageCssResolution: foreground.imageCss, backgroundDisplayedCssResolution: behind.css, backgroundImageCssResolution: behind.imageCss,
        devicePixelRatio: dpr, displayDevicePixels: foreground.imageCss && dpr ? resolution(Math.round(foreground.imageCss.width * dpr), Math.round(foreground.imageCss.height * dpr)) : null,
        foregroundScale: scale(foreground.imageCss, mode === "mjpeg" ? source : foregroundCanvas), backgroundScale: scale(behind.imageCss, backgroundCanvas),
        jpegPayloadMbps: bitrate("jpeg"), wireMbps: bitrate("wire"), averagingSeconds: live && mode === "websocket" ? seconds : 0,
        bitrateScope: mode === "websocket" ? "Received JPEG bytes and 20-byte Rabbit Hole header; excludes WebSocket/TCP/TLS overhead" : "MJPEG image transport does not expose received byte counts",
        canvasColorSpace: foreground.colorSpace, canvasColorType: foreground.colorType, backgroundCanvasColorSpace: behind.colorSpace, backgroundCanvasColorType: behind.colorType,
        foregroundPresentation: foreground.presentation, backgroundPresentation: behind.presentation,
        decoderColorSpace: "Browser default conversion; not verified", nativeColorSpace: "Unknown" };
    }
    function stats(includeFidelity = true) {
      const at = now(); for (const samples of [received, decoded, painted, backgroundPainted]) prune(samples, at);
      return { transport: mode, frames, receivedFrames, decodedFrames, replacedFrames, busyDroppedFrames,
        receiveFps: rate(received), decodeFps: rate(decoded), displayedFps: rate(painted), meanDecodeMs: mean(decoded, "ms"),
        meanPaintMs: mean(painted, "ms"), meanRafWaitMs: mean(painted, "wait"),
        maxPaintGapMs: painted.reduce((gap, value) => Math.max(gap, value.gap), 0), lastPaintGapMs: painted.at(-1)?.gap || 0,
        backgroundFrames, backgroundFps: rate(backgroundPainted), backdropProfile: activeBackdropProfile || backdropProfile(),
        ...(includeFidelity ? { fidelity: fidelityStats(at) } : {}) };
    }
    function report(force = false) {
      const at = now(); if (!canvas.dataset || !force && at - reportedAt < 1000) return;
      reportedAt = at;
      const value = stats(false);
      canvas.dataset.videoTransport = value.transport;
      canvas.dataset.videoFrames = String(value.frames);
      canvas.dataset.videoFps = value.displayedFps.toFixed(1);
      canvas.dataset.videoDecodeMs = value.meanDecodeMs.toFixed(1);
      canvas.dataset.videoReceivedFrames = String(value.receivedFrames);
      canvas.dataset.videoDecodedFrames = String(value.decodedFrames);
      canvas.dataset.videoReplacedFrames = String(value.replacedFrames);
      canvas.dataset.videoBusyDroppedFrames = String(value.busyDroppedFrames);
      canvas.dataset.videoReceiveFps = value.receiveFps.toFixed(1);
      canvas.dataset.videoDecodeFps = value.decodeFps.toFixed(1);
      canvas.dataset.videoPaintMs = value.meanPaintMs.toFixed(1);
      canvas.dataset.videoRafWaitMs = value.meanRafWaitMs.toFixed(1);
      canvas.dataset.videoMaxPaintGapMs = value.maxPaintGapMs.toFixed(1);
      canvas.dataset.videoLastPaintGapMs = value.lastPaintGapMs.toFixed(1);
      canvas.dataset.videoBackgroundFrames = String(value.backgroundFrames);
      canvas.dataset.videoBackgroundFps = value.backgroundFps.toFixed(1);
      canvas.dataset.videoBackdropProfile = value.backdropProfile;
    }
    function resetStats() { frames = receivedFrames = decodedFrames = replacedFrames = busyDroppedFrames = backgroundFrames = lastAt = 0; received.length = decoded.length = painted.length = backgroundPainted.length = 0; reportedAt = -Infinity; }
    function backdropProfile() {
      let value;
      try { value = presentation?.(); } catch {}
      return touchWindow?.matches && ["windowed", "player-fullscreen"].includes(value) ? "windowed-touch" : "full";
    }
    function resetBackdropCadence() { lastBackgroundAt = -Infinity; activeBackdropProfile = ""; }
    function mark(value) { if (ready === value) return; ready = value; onReady?.(value); }
    function cancelPending() { cancelAnimationFrame(animation); animation = 0; pendingFrame?.bitmap.close(); pendingFrame = null; }
    function clearSurfaces() {
      // Capture recovery keeps its socket and generation, but retires imagery
      // already being decoded or waiting for presentation.
      ++presentationRevision;
      cancelPending();
      resetBackdropCadence();
      resetFidelity();
      image.hidden = true; canvas.hidden = true; backdrop.hidden = true;
      context?.clearRect(0, 0, canvas.width, canvas.height);
      background?.clearRect(0, 0, backdrop.width, backdrop.height);
      mark(false);
    }
    function stop() {
      ++epoch; active = false; clearTimeout(deadline);
      const previous = socket; socket = null;
      if (previous) { previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null; previous.close(); }
      image.onload = image.onerror = null; image.removeAttribute("src"); mode = "idle"; report(true);
      clearSurfaces();
    }
    function paintBackground(source, at, fullInterval = 0) {
      if (!background) return;
      const sourceWidth = source.naturalWidth || source.width, sourceHeight = source.naturalHeight || source.height;
      if (!sourceWidth || !sourceHeight) return;
      const profile = backdropProfile(), changed = profile !== activeBackdropProfile;
      const scale = profile === "windowed-touch" ? Math.min(1, 320 / sourceWidth, 180 / sourceHeight) : 1;
      const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
      const resized = backdrop.width !== width || backdrop.height !== height;
      if (!changed && !resized && !backdrop.hidden && at - lastBackgroundAt < fullInterval) return;
      if (resized) { backdrop.width = width; backdrop.height = height; }
      // Touch tablets use fewer pixels for decorative blur while both surfaces
      // advance together. Keep the foreground at its original size.
      if (profile === "windowed-touch") background.drawImage(source, 0, 0, width, height);
      else background.drawImage(source, 0, 0);
      backdrop.hidden = false; lastBackgroundAt = at;
      if (changed) backgroundPainted.length = 0;
      activeBackdropProfile = profile; backgroundFrames++; sample(backgroundPainted, { at: now() });
    }
    function paint(bitmap) {
      if (context) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
        context.drawImage(bitmap, 0, 0); canvas.hidden = false;
      }
      paintBackground(bitmap, now());
    }
    function queuePaint(bitmap, incomingGeneration, ws, current, viewerId) {
      if (pendingFrame) { pendingFrame.bitmap.close(); replacedFrames++; }
      pendingFrame = { bitmap, generation: incomingGeneration };
      if (animation) return;
      const scheduledAt = now();
      const presentation = presentationRevision;
      animation = requestAnimationFrame(() => {
        if (current !== epoch || socket !== ws || !active || mode !== "websocket" || presentation !== presentationRevision) return;
        animation = 0;
        const frame = pendingFrame; pendingFrame = null;
        if (!frame) return;
        try {
          if (frame.generation !== generation) return;
          const paintAt = now(); paint(frame.bitmap); image.hidden = true;
          const at = now(); sample(painted, { at, ms: at - paintAt, wait: paintAt - scheduledAt, gap: frames ? at - lastAt : 0 });
          frames++; lastAt = at; report(frames === 1); mark(true);
        } catch { if (current === epoch && socket === ws) fallback(viewerId, current); }
        finally { frame.bitmap.close(); }
      });
    }
    function fallback(viewerId, current) {
      if (!active || current !== epoch) return;
      clearTimeout(deadline);
      const previous = socket; socket = null;
      if (previous) { previous.onmessage = previous.onerror = previous.onclose = null; previous.close(); }
      clearSurfaces(); mode = "mjpeg"; resetStats(); report(true); image.hidden = false;
      image.onerror = () => { if (active && current === epoch) { stop(); onError?.(); } };
      image.onload = () => {
        if (!active || current !== epoch) return;
        image.onload = null;
        mark(true);
        function redraw(at) {
          if (!active || current !== epoch || mode !== "mjpeg") return;
          paintBackground(image, at, 30); report();
          animation = requestAnimationFrame(redraw);
        }
        animation = requestAnimationFrame(redraw);
      };
      image.src = "/api/soundspectrum/video?" + new URLSearchParams({ viewerId });
    }
    function start(viewerId, transport) {
      stop(); active = true; const current = epoch;
      resetStats(); generation = 0;
      if (transport !== "websocket-ack-jpeg" || !window.WebSocket || !window.createImageBitmap || !context) { fallback(viewerId, current); return; }
      mode = "websocket"; report(true);
      const url = new URL("/api/soundspectrum/frames", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("viewerId", viewerId);
      let ws;
      try { ws = new WebSocket(url); } catch { fallback(viewerId, current); return; }
      socket = ws; ws.binaryType = "arraybuffer";
      deadline = setTimeout(() => fallback(viewerId, current), 5000);
      ws.onerror = ws.onclose = () => { if (socket === ws && active && current === epoch) fallback(viewerId, current); };
      ws.onmessage = async event => {
        if (current !== epoch || socket !== ws || !active) return;
        if (typeof event.data === "string") {
          try { const state = JSON.parse(event.data); if (Number.isInteger(state.generation) && state.generation > generation) { generation = state.generation; clearSurfaces(); } else if (state.state === "starting") clearSurfaces(); } catch {}
          return;
        }
        const buffer = event.data;
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24 || buffer.byteLength > 2 * 1024 * 1024 + 20) { fallback(viewerId, current); return; }
        const header = new DataView(buffer), bytes = new Uint8Array(buffer);
        if (header.getUint32(0) !== 0x52485353 || bytes[20] !== 0xff || bytes[21] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) { fallback(viewerId, current); return; }
        const sequence = header.getUint32(4), incomingGeneration = header.getUint32(8);
        const acknowledge = () => {
          if (socket !== ws || current !== epoch || ws.readyState !== WebSocket.OPEN) return;
          try { ws.send(JSON.stringify({ ack: sequence })); } catch { fallback(viewerId, current); }
        };
        receivedFrames++; sample(received, { at: now() });
        if (incomingGeneration > generation) { generation = incomingGeneration; clearSurfaces(); }
        if (incomingGeneration >= generation) observePacket(bytes, now());
        if (incomingGeneration < generation || decoder) { if (decoder) busyDroppedFrames++; acknowledge(); report(); return; }
        const token = {}; decoder = token;
        const presentation = presentationRevision;
        const decodeAt = now(); let bitmap;
        try {
          bitmap = await createImageBitmap(new Blob([bytes.subarray(20)], { type: "image/jpeg" }));
          if (current !== epoch || socket !== ws || !active) return;
          const decodedAt = now(); decodedFrames++; sample(decoded, { at: decodedAt, ms: decodedAt - decodeAt });
          if (incomingGeneration < generation || presentation !== presentationRevision) { acknowledge(); return; }
          decodedResolution = resolution(bitmap.width, bitmap.height);
          // Hidden Chrome pages can suspend rAF while receiving healthy video.
          // Successful current decoding establishes transport readiness; only
          // the later paint should make the visual surface visible.
          clearTimeout(deadline);
          queuePaint(bitmap, incomingGeneration, ws, current, viewerId); bitmap = null;
          acknowledge(); report();
        } catch {
          if (current === epoch && socket === ws) {
            if (incomingGeneration < generation || presentation !== presentationRevision) acknowledge();
            else fallback(viewerId, current);
          }
        }
        finally { bitmap?.close(); if (decoder === token) decoder = null; }
      };
    }
    return { start, stop, stats, ready: () => ready };
  };
})();
