"use strict";
importScripts("/soundSpectrumMP4.js?v=20261010-webcodecs-3");
let active = false, decoder, decoderConfig, decoderEpoch = 0, abort, canvas, ctx;
let queue = [], frames = [], queuedBytes = 0, target = 32000000, bufferMs = 750, bitrate = 60;
let targetFps = 60, paintRequest = null, paintCallbacks = 0, paintRateCount = 0, paintHz = 0;
let receiveRateCount = 0, decodeRateCount = 0, receiveFps = 0, decodeFps = 0, streamFrames = 0, streamDuration = 0;
let track, baseURL, nextSequence = null, lastEnd = null, accepted = false, reposition = false;
let filling = true, fillStarted = 0, clockPTS = 0, clockAt = 0, hiddenAt = null;
let received = 0, decoded = 0, presented = 0, dropped = 0, submitted = 0, loadedBytes = 0;
let lastPaint = 0, lastPTS = null, ready = false, timer, statsTimer, rateAt = 0, rateCount = 0, fps = 0, playStarted = 0;
let retries = 0, recoveries = 0, lastHTTP = 0, lastRequest = "", retrying = false, recoveryTimes = [], lastRecovery = -Infinity;
const segmentLimit = 64 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const queueSeconds = () => queue.length ? (queue.at(-1).timestamp + queue.at(-1).duration - queue[0].timestamp) / 1e6 : 0;
const aheadSeconds = () => lastEnd === null ? 0 : Math.max(0, (lastEnd - (lastPTS ?? queue[0]?.timestamp ?? lastEnd)) / 1e6);
const lateness = () => filling || lastPTS === null || hiddenAt !== null ? 0 : Math.max(0, (clockPTS + (performance.now() - clockAt) * 1000 - lastPTS) / 1000 - 1000 / targetFps);
function snapshot() {
  return { frames: presented, receivedFrames: received, decodedFrames: decoded, replacedFrames: dropped,
    displayedFps: fps, receiveFps, decodeFps, wcTargetFps: targetFps, wcPresentationHz: paintHz,
    wcStreamFps: streamDuration > 0 ? streamFrames * 1e6 / streamDuration : null,
    lastPaintGapMs: lastPaint ? performance.now() - lastPaint : null,
    wcBufferBytes: queuedBytes, wcBufferSeconds: queueSeconds(), wcAheadSeconds: aheadSeconds(), wcTargetMs: bufferMs,
    wcRequestedMB: target / 1e6, wcLoadedBytes: loadedBytes, wcDecodeQueue: decoder?.decodeQueueSize || 0,
    wcLatenessMs: lateness(), wcRetries: retries, wcRecoveries: recoveries, wcHttpStatus: lastHTTP, wcRequestKind: lastRequest,
    wcBufferState: retrying ? "retrying" : filling ? (reposition ? "recovering" : "filling") : "playing",
    codec: track?.codec, width: track?.codedWidth, height: track?.codedHeight };
}
function report() {
  const now = performance.now(), seconds = (now - rateAt) / 1000;
  if (seconds >= 1) { fps = hiddenAt === null ? (presented - rateCount) / seconds : 0; paintHz = hiddenAt === null ? (paintCallbacks - paintRateCount) / seconds : 0;
    receiveFps = (received - receiveRateCount) / seconds; decodeFps = (decoded - decodeRateCount) / seconds;
    receiveRateCount = received; decodeRateCount = decoded; paintRateCount = paintCallbacks; rateCount = presented; rateAt = now; }
  postMessage({ type: "stats", value: snapshot() });
}
function closeDecoder() {
  decoderEpoch++; try { decoder?.close(); } catch {} decoder = null;
  for (const frame of frames) frame.close(); frames = []; submitted = decoded;
}
function openDecoder() {
  const epoch = decoderEpoch;
  decoder = new VideoDecoder({ output(frame) {
    if (!active || epoch !== decoderEpoch) { frame.close(); return; }
    decoded++; frames.push(frame); if (frames.length > 24) finish("decoder-overflow");
  }, error() { if (epoch === decoderEpoch) finish("decode-error"); } });
  decoder.configure(decoderConfig);
}
function finish(reason) {
  if (!active) return;
  const stats = snapshot(); active = false; clearTimeout(timer); clearInterval(statsTimer); abort?.abort();
  if (paintRequest !== null) cancelAnimationFrame(paintRequest); paintRequest = null;
  closeDecoder(); queue = []; queuedBytes = 0;
  if (reason) postMessage({ type: "error", reason, stats });
}
function safeURL(value) {
  const u = new URL(value, baseURL), base = new URL(baseURL);
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1)) ||
      u.searchParams.get("viewerId") !== base.searchParams.get("viewerId") || u.username || u.password) throw Error("media-format");
  return u.href;
}
async function load(url, limit, kind) {
  const href = safeURL(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!active) throw Error("stopped");
    const requestAbort = new AbortController();
    const cancel = () => requestAbort.abort(); abort.signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false, reader;
    const timeout = setTimeout(() => { timedOut = true; requestAbort.abort(); }, 4000);
    lastRequest = kind; lastHTTP = 0;
    try {
      const r = await fetch(href, { signal: requestAbort.signal, credentials: "same-origin", redirect: "error", cache: "no-store" });
      lastHTTP = Number.isInteger(r.status) ? r.status : r.ok ? 200 : 0;
      if (!r.ok) { await r.body?.cancel?.(); throw Object.assign(Error("network-error"), { status: lastHTTP }); }
      if (Number(r.headers.get("content-length")) > limit) throw Error("media-limit");
      reader = r.body.getReader(); const parts = []; let length = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length;
        if (length > limit) throw Error("media-limit"); parts.push(value); }
      const data = new Uint8Array(length); let at = 0;
      for (const part of parts) { data.set(part, at); at += part.length; }
      retrying = false; return data;
    } catch (error) {
      try { await reader?.cancel(); } catch {}
      if (!active) throw Error("stopped");
      if (error.message === "media-limit") throw error;
      const status = error.status || 0;
      const transient = !status || [404,408,410,425,429,500,502,503,504].includes(status);
      if (!transient || attempt === 2) {
        retrying = false;
        throw Error(status === 401 || status === 403 || status === 409 ? "session-ended" :
          kind === "segment" && [404,410].includes(status) ? "history-expired" : timedOut ? "network-timeout" : "network-error");
      }
      retries++; retrying = true; report();
    } finally { clearTimeout(timeout); abort.signal.removeEventListener("abort", cancel); }
    await sleep(attempt ? 750 : 250);
  }
}
function playlist(text) {
  if (!text.startsWith("#EXTM3U") || /#EXT-X-(?:KEY|BYTERANGE|DISCONTINUITY)(?::|\r?$)/m.test(text)) throw Error("media-format");
  const lines = text.split(/\r?\n/), entries = []; let sequence = 0, duration = null, gap = false, map = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = Number(line.split(":")[1]);
    else if (line.startsWith("#EXT-X-MAP:")) { const match = /URI="([^"]+)"/.exec(line); if (match) map = safeURL(match[1]); }
    else if (line.startsWith("#EXTINF:")) duration = Number(line.slice(8).split(",")[0]);
    else if (line === "#EXT-X-GAP") gap = true;
    else if (line && !line.startsWith("#")) { entries.push({ sequence: sequence++, url: safeURL(line), duration, gap }); duration = null; gap = false; }
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw Error("media-format");
  return { entries, map, master: text.includes("#EXT-X-STREAM-INF:") };
}
function recover(reason) {
  if (reposition) return;
  const now = performance.now(); recoveryTimes = recoveryTimes.filter(t => now - t < 30000);
  if (recoveryTimes.length >= 3) { finish(reason === "late" ? "decoder-overloaded" : "history-expired"); return; }
  recoveryTimes.push(now); lastRecovery = now; recoveries++;
  closeDecoder(); queue = []; queuedBytes = 0; lastEnd = lastPTS = null; nextSequence = null; accepted = false;
  filling = true; reposition = true; fillStarted = now; report();
}
function paintFrame(due) {
  let frame;
  while (frames.length && frames[0].timestamp <= due) { if (frame) { frame.close(); dropped++; } frame = frames.shift(); }
  if (frame) {
    try { ctx.drawImage(frame, 0, 0, canvas.width, canvas.height); presented++; lastPaint = performance.now(); lastPTS = frame.timestamp; }
    finally { frame.close(); }
    if (!ready) { ready = true; postMessage({ type: "ready" }); }
  }
}
function presentationTick() {
  paintRequest = null;
  if (!active) return;
  paintCallbacks++;
  // Half a frame chooses the nearest due image despite sub-microsecond PTS rounding.
  // This counts draws on repaint callbacks, not physical panel scanout.
  if (!filling && hiddenAt === null) paintFrame(clockPTS + (performance.now() - clockAt) * 1000 + 500000 / targetFps);
  paintRequest = requestAnimationFrame(presentationTick);
}
function tick() {
  if (!active) return;
  try {
    if (hiddenAt === null) {
      if (filling && !reposition && queueSeconds() * 1000 >= bufferMs && queue.length && !frames.length && submitted === decoded) {
        filling = false; clockPTS = queue[0].timestamp; clockAt = performance.now() + 50; playStarted = performance.now(); report();
      }
      if (filling && performance.now() - fillStarted > 30000) throw Error("buffer-timeout");
      if (!filling) {
        const due = clockPTS + (performance.now() - clockAt) * 1000;
        if (lateness() > 750 && performance.now() - lastRecovery > 2000) recover("late");
        if (!filling) {
          // Bounded lookahead must accommodate decoder-internal picture retention.
          while (queue.length && submitted - decoded + frames.length < 24 && queue[0].timestamp <= due + 500000) {
            const s = queue.shift(); queuedBytes -= s.data.byteLength;
            decoder.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.timestamp, duration: s.duration, data: s.data })); submitted++;
          }
          if (targetFps === 60) paintFrame(due);
          if (performance.now() - Math.max(lastPaint, playStarted) > 15000) throw Error("decoder-stalled");
        }
      }
    }
    timer = setTimeout(tick, 4);
  } catch (error) { finish(error.message === "buffer-timeout" ? error.message : "decoder-stalled"); }
}
async function receive() {
  let mediaURL = baseURL, mapURL = null;
  while (active) {
    if (!reposition && aheadSeconds() >= bufferMs / 1000 + 0.2) { await sleep(50); continue; }
    const epoch = decoderEpoch;
    const list = playlist(new TextDecoder().decode(await load(mediaURL, 1048576, "playlist")));
    if (list.master) { if (!list.entries.length) throw Error("media-format"); mediaURL = list.entries[0].url; continue; }
    if (!list.map) { await sleep(200); continue; }
    if (!track) {
      mapURL = list.map; track = SoundSpectrumMP4.init(await load(mapURL, 1048576, "init"));
      decoderConfig = { codec: track.codec, codedWidth: track.codedWidth, codedHeight: track.codedHeight,
        description: track.description, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true };
      const support = await VideoDecoder.isConfigSupported(decoderConfig);
      if (!active) return;
      postMessage({ type: "capability", value: { supported: support.supported, codec: track.codec, width: track.codedWidth, height: track.codedHeight, preference: "prefer-hardware" } });
      if (!support.supported) throw Error("codec-unsupported");
      canvas.width = track.codedWidth; canvas.height = track.codedHeight; openDecoder();
    } else if (list.map !== mapURL) throw Error("codec-changed");
    if (epoch !== decoderEpoch) continue; // An in-flight response predates a recovery.
    const entries = list.entries.filter(e => !e.gap);
    if (nextSequence === null && entries.length) {
      let duration = 0, i = entries.length - 1;
      for (; i > 0 && duration < bufferMs / 1000; i--) duration += entries[i].duration || 0.2;
      nextSequence = entries[i].sequence;
      if (reposition) { openDecoder(); reposition = false; }
    }
    if (entries.length && nextSequence !== null && entries[0].sequence > nextSequence) { recover("history"); continue; }
    for (const entry of entries) {
      if (!active) return;
      if (epoch !== decoderEpoch) break;
      if (entry.sequence < nextSequence) continue;
      if (entry.sequence !== nextSequence) { recover("history"); break; }
      if (aheadSeconds() >= bufferMs / 1000 + 0.2) break;
      let payload;
      try { payload = await load(entry.url, segmentLimit, "segment"); }
      catch (error) { if (error.message !== "history-expired") throw error; recover("history"); break; }
      if (!active) return;
      if (epoch !== decoderEpoch) break;
      const batch = SoundSpectrumMP4.samples(payload, track); loadedBytes += payload.length;
      for (const sample of batch) {
        if (!accepted) { if (!sample.key) continue; accepted = true; }
        if (lastEnd !== null && Math.abs(sample.timestamp - lastEnd) > 2000) throw Error("media-discontinuity");
        if (queuedBytes + sample.data.length > target) throw Error("buffer-limit");
        lastEnd = sample.timestamp + sample.duration; queue.push(sample); queuedBytes += sample.data.length; received++; streamFrames++; streamDuration += sample.duration;
      }
      nextSequence++;
    }
    await sleep(100);
  }
}
onmessage = async ({ data }) => {
  if (data.type === "stop") { finish(); return; }
  if (data.type === "visibility") {
    if (data.hidden && hiddenAt === null) hiddenAt = performance.now();
    else if (!data.hidden && hiddenAt !== null) { const duration = performance.now() - hiddenAt; clockAt += duration; fillStarted += duration;
      playStarted += duration; if (lastPaint) lastPaint += duration; hiddenAt = null;
      if (duration > 2000 && active && track) recover("history"); }
    return;
  }
  if (data.type !== "start" || active) return;
  try {
    target = data.mb * 1e6; bitrate = data.bitrate; bufferMs = data.bufferMs ?? 750; targetFps = data.targetFps ?? 60;
    if (![60,120].includes(targetFps)) throw Error("invalid-config");
    if (targetFps === 120 && typeof requestAnimationFrame !== "function") throw Error("renderer-unavailable");
    if (!Number.isInteger(data.mb) || data.mb < 1 || data.mb > 1000 || !Number.isInteger(bitrate) || bitrate < 50 || bitrate > 600 || ![500,750,1000,1500,2000].includes(bufferMs)) throw Error("invalid-config");
    canvas = data.canvas; ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw Error("renderer-unavailable");
    baseURL = data.url; abort = new AbortController(); active = true; fillStarted = rateAt = performance.now();
    statsTimer = setInterval(report, 1000);
    if (targetFps === 120) paintRequest = requestAnimationFrame(presentationTick);
    tick(); await receive();
  } catch (error) {
    const allowed = ["codec-unsupported","codec-changed","media-discontinuity","network-timeout","network-error","session-ended","media-limit","history-expired","buffer-limit"];
    if (active) finish(allowed.includes(error.message) ? error.message : "media-format");
    else if (!abort) postMessage({ type: "error", reason: "renderer-unavailable" });
  }
};
