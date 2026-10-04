"use strict";
(() => {
  // Decode once, paint both views, then acknowledge presentation. The server
  // retains only its newest capture while this device is displaying a frame.
  window.createSoundSpectrumVideo = function ({ image, canvas, backdrop, onReady, onError }) {
    const context = canvas.getContext?.("2d", { alpha: false });
    const background = backdrop.getContext?.("2d", { alpha: false });
    let socket = null, animation = 0, deadline = 0, epoch = 0, active = false, ready = false, decoding = false, generation = 0, cancelPresentation = null;
    let mode = "", frames = 0, startedAt = 0, lastAt = 0, totalDecodeMs = 0, reportedAt = 0;
    const now = () => performance.now();
    const stats = () => ({ transport: mode, frames, displayedFps: lastAt > startedAt ? (frames - 1) * 1000 / (lastAt - startedAt) : 0,
      meanDecodeMs: frames ? totalDecodeMs / frames : 0 });
    function report() {
      if (!canvas.dataset || frames > 1 && lastAt - reportedAt < 1000) return;
      reportedAt = lastAt;
      const value = stats();
      canvas.dataset.videoTransport = value.transport;
      canvas.dataset.videoFrames = String(value.frames);
      canvas.dataset.videoFps = value.displayedFps.toFixed(1);
      canvas.dataset.videoDecodeMs = value.meanDecodeMs.toFixed(1);
    }
    function mark(value) { if (ready === value) return; ready = value; onReady?.(value); }
    function clearSurfaces() {
      image.hidden = true; canvas.hidden = true; backdrop.hidden = true;
      context?.clearRect(0, 0, canvas.width, canvas.height);
      background?.clearRect(0, 0, backdrop.width, backdrop.height);
      mark(false);
    }
    function stop() {
      ++epoch; active = false; clearTimeout(deadline); cancelAnimationFrame(animation); animation = 0; cancelPresentation?.(); cancelPresentation = null;
      const previous = socket; socket = null;
      if (previous) { previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null; previous.close(); }
      image.onload = image.onerror = null; image.removeAttribute("src"); decoding = false;
      if (canvas.dataset) canvas.dataset.videoTransport = "idle";
      clearSurfaces();
    }
    function paint(bitmap) {
      for (const [target, targetContext] of [[canvas, context], [backdrop, background]]) {
        if (!targetContext) continue;
        if (target.width !== bitmap.width || target.height !== bitmap.height) { target.width = bitmap.width; target.height = bitmap.height; }
        targetContext.drawImage(bitmap, 0, 0); target.hidden = false;
      }
    }
    function fallback(viewerId, current) {
      if (!active || current !== epoch) return;
      clearTimeout(deadline);
      const previous = socket; socket = null;
      if (previous) { previous.onmessage = previous.onerror = previous.onclose = null; previous.close(); }
      clearSurfaces(); mode = "mjpeg"; image.hidden = false;
      image.onerror = () => { if (active && current === epoch) { stop(); onError?.(); } };
      image.onload = () => {
        if (!active || current !== epoch) return;
        image.onload = null;
        mark(true);
        let paintedAt = 0;
        function redraw(at) {
          if (!active || current !== epoch || mode !== "mjpeg") return;
          if (background && image.naturalWidth && at - paintedAt >= 30) {
            if (backdrop.width !== image.naturalWidth || backdrop.height !== image.naturalHeight) { backdrop.width = image.naturalWidth; backdrop.height = image.naturalHeight; }
            background.drawImage(image, 0, 0); backdrop.hidden = false; paintedAt = at;
          }
          animation = requestAnimationFrame(redraw);
        }
        animation = requestAnimationFrame(redraw);
      };
      image.src = "/api/soundspectrum/video?" + new URLSearchParams({ viewerId });
    }
    function start(viewerId, transport) {
      stop(); active = true; const current = epoch;
      frames = 0; totalDecodeMs = 0; reportedAt = 0; startedAt = lastAt = now(); generation = 0;
      if (transport !== "websocket-ack-jpeg" || !window.WebSocket || !window.createImageBitmap || !context) { fallback(viewerId, current); return; }
      mode = "websocket";
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
          try { const state = JSON.parse(event.data); if (Number.isInteger(state.generation)) generation = Math.max(generation, state.generation); if (state.state === "starting") clearSurfaces(); } catch {}
          return;
        }
        const buffer = event.data;
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24 || buffer.byteLength > 2 * 1024 * 1024 + 20) { fallback(viewerId, current); return; }
        const header = new DataView(buffer), bytes = new Uint8Array(buffer);
        if (header.getUint32(0) !== 0x52485353 || bytes[20] !== 0xff || bytes[21] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) { fallback(viewerId, current); return; }
        const sequence = header.getUint32(4), incomingGeneration = header.getUint32(8);
        const acknowledge = () => { if (socket === ws && current === epoch && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ack: sequence })); };
        if (incomingGeneration < generation || decoding) { acknowledge(); return; }
        generation = incomingGeneration; decoding = true;
        const decodeAt = now(); let bitmap;
        try {
          bitmap = await createImageBitmap(new Blob([bytes.subarray(20)], { type: "image/jpeg" }));
          if (current !== epoch || socket !== ws || !active) return;
          if (incomingGeneration < generation) { acknowledge(); return; }
          totalDecodeMs += now() - decodeAt;
          await new Promise(resolve => { cancelPresentation = resolve; animation = requestAnimationFrame(() => {
            animation = 0; cancelPresentation = null;
            if (current === epoch && socket === ws && active) {
              if (incomingGeneration === generation) { paint(bitmap); image.hidden = true; if (!frames) startedAt = now(); frames++; lastAt = now(); report(); clearTimeout(deadline); mark(true); }
              acknowledge();
            }
            resolve();
          }); });
        } catch { if (current === epoch && socket === ws) fallback(viewerId, current); }
        finally { bitmap?.close(); if (current === epoch) decoding = false; }
      };
    }
    return { start, stop, stats, ready: () => ready };
  };
})();
