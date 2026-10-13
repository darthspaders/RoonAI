"use strict";
(function (global) {
  const MAX_DURATION_MS = 600000, POLL_MS = 3000, FRESH_MS = 5000;
  const RECOVERY_KEY = "soundSpectrum.srtExperimentController.v1";
  const safeGeneration = value => Number.isSafeInteger(value) && value > 0;
  const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const videoTarget = value => value === 60 || value === 600;
  const failureMessages = Object.freeze({
    "child-exit": "The SRT sender process exited.",
    "child-error": "The SRT sender process could not run.",
    "native-identity-lost": "The SRT sender lost the visualizer’s PC window.",
    "listener-lost": "The sender’s SRT listener ended.",
    "encoded-output-stale": "The SRT sender stopped producing fresh encoded video.",
    "send-buffer-full": "The SRT sender ran out of send buffer and disconnected the player. Start a new connection after this trial has stopped.",
    "monitor-error": "The SRT sender’s health check failed.",
    "cleanup-failed": "SRT sender cleanup failed."
  });
  function failureMessage(diagnostics) {
    const code = diagnostics?.failureCode;
    if (typeof code !== "string" || !Object.hasOwn(failureMessages, code)) return "The SRT experiment failed; its sender cause could not be confirmed.";
    let message = failureMessages[code];
    if (code === "child-exit") {
      if (Number.isSafeInteger(diagnostics.exitCode) && diagnostics.exitCode >= -2147483648 && diagnostics.exitCode <= 4294967295) message += " Exit code " + diagnostics.exitCode + ".";
      if (["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT", "SIGHUP", "SIGQUIT"].includes(diagnostics.signal)) message += " Signal " + diagnostics.signal + ".";
    }
    return message;
  }
  function verifiedVideoProfile(value) {
    if (!value || !videoTarget(value.requestedBitrateMbps) || !finite(value.configuredBitrateMbps) || value.configuredBitrateMbps <= 0 ||
        Math.abs(value.configuredBitrateMbps - value.requestedBitrateMbps) >= 1 ||
        value.encoderMode !== (value.requestedBitrateMbps === 600 ? "independent-srt" : "shared-publisher") ||
        !Number.isSafeInteger(value.width) || value.width <= 0 || !Number.isSafeInteger(value.height) || value.height <= 0 ||
        !finite(value.fps) || value.fps <= 0) return null;
    return { requestedBitrateMbps: value.requestedBitrateMbps, configuredBitrateMbps: value.configuredBitrateMbps,
      encoderMode: value.encoderMode, width: value.width, height: value.height, fps: value.fps,
      videoBitrateMbps: value.videoBitrateMbps, videoBitrateObservedAt: value.videoBitrateObservedAt, videoBitrateWindowMs: value.videoBitrateWindowMs,
      observedCodec: value.observedCodec };
  }
  function privateConnection(value) {
    if (typeof value !== "string" || value.length > 2048) return "";
    try {
      const url = new URL(value), octets = url.hostname.split(".").map(Number);
      if (url.protocol !== "srt:" || url.username || url.password || !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
          octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255) ||
          !(octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
          !/^\d{1,5}$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535 || url.hash) return "";
      return url.href;
    } catch { return ""; }
  }
  function createSrtExperimentController(options = {}) {
    const document = options.document || global.document, request = options.fetch || global.fetch.bind(global);
    const crypto = options.crypto || global.crypto, navigator = options.navigator || global.navigator;
    const later = options.setTimeout || global.setTimeout.bind(global), cancel = options.clearTimeout || global.clearTimeout.bind(global);
    const now = options.now || Date.now, elements = {};
    let storage;
    try { storage = Object.hasOwn(options, "storage") ? options.storage : global.localStorage; } catch {}
    for (const id of ["srtStart", "srtStop", "srtRefresh", "srtStatus", "srtExpiry", "srtProfile", "srtVideoBitrate", "srtVideoTargetHelp", "srtRequestedRate", "srtConfiguredRate", "srtVideoProfile", "srtEncoderMode", "srtEncodedRate", "srtObservedCodec", "srtVisualDelay", "srtConnection", "srtConnectionUrl", "srtCopy", "srtNativeLink", "srtCopyStatus", "srtConnected", "srtNegotiatedDelay", "srtSendRate", "srtRetransmits", "srtDropped", "srtMetricsStatus", "srtMeasurementNote"]) elements[id] = document.getElementById(id);
    elements.srtVideoBitrate.value = "600";
    let viewerId = "", generation = null, expiresAt = 0, timer = null, expiryTimer = null, busy = false, epoch = 0, running = null, phase = "checking", connectionUrl = "", lastMetrics = null, lastMetricsReadAt = null, lastVideoProfile = null;
    let recoveryRecord = null, recoveryUnavailable = !storage, recovered = false, stopAuthorized = false, independentCleanupPending = false, senderFailed = false;
    function newCapability() {
      try {
        const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
        return "srt-" + [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
      } catch { return ""; } // No non-cryptographic fallback for a lease identifier.
    }
    viewerId = newCapability();
    function validRecord(value) {
      return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === "expiresAt,generation,startedAt,version,viewerId" &&
        value.version === 1 && /^srt-[a-f0-9]{32}$/.test(value.viewerId || "") && safeGeneration(value.generation) &&
        Number.isSafeInteger(value.startedAt) && value.startedAt >= 0 && value.startedAt <= now() && Number.isSafeInteger(value.expiresAt) &&
        value.expiresAt > value.startedAt && value.expiresAt - value.startedAt <= MAX_DURATION_MS && value.expiresAt > now() && value.expiresAt <= now() + MAX_DURATION_MS;
    }
    function readRecovery() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(RECOVERY_KEY); if (raw === null) return null;
        let value; try { if (typeof raw === "string" && raw.length <= 512) value = JSON.parse(raw); } catch {}
        if (validRecord(value)) return value;
        if (storage.getItem(RECOVERY_KEY) === raw) storage.removeItem(RECOVERY_KEY);
      } catch { recoveryUnavailable = true; }
      return null;
    }
    function sameRecord(a, b) {
      return !!a && !!b && a.viewerId === b.viewerId && a.generation === b.generation && a.startedAt === b.startedAt && a.expiresAt === b.expiresAt;
    }
    function clearRecovery() {
      if (storage && recoveryRecord) {
        try { const current = readRecovery(); if (sameRecord(current, recoveryRecord)) storage.removeItem(RECOVERY_KEY); } catch { recoveryUnavailable = true; }
      }
      recoveryRecord = null;
    }
    function saveRecovery(record) {
      if (!storage) { recoveryUnavailable = true; return true; }
      try {
        const current = readRecovery();
        if (current && !(current.viewerId === viewerId && current.generation === record.generation)) return false;
        storage.setItem(RECOVERY_KEY, JSON.stringify(record));
        recoveryUnavailable = false; recoveryRecord = record; return true;
      } catch { recoveryUnavailable = true; return true; }
    }
    async function saveConfirmedRecovery(record) {
      if (saveRecovery(record)) return;
      // localStorage has no cross-tab compare-and-set. An accepted Start can
      // race a rejected tab's provisional record; replace only a record whose
      // exact controller is confirmed inactive through a passive server read.
      try {
        const conflicting = readRecovery();
        if (!conflicting) { if (ownsExperiment()) saveRecovery(record); return; }
        const status = await json("/api/soundspectrum/srt?" + new URLSearchParams({ viewerId: conflicting.viewerId }));
        if (!ownsExperiment() || generation !== record.generation || viewerId !== record.viewerId) return;
        if (["idle", "stopped", "expired"].includes(status.state)) {
          const current = readRecovery();
          if (!current || sameRecord(current, conflicting)) {
            if (current) storage.removeItem(RECOVERY_KEY);
            saveRecovery(record); return;
          }
        }
      } catch {}
      recoveryUnavailable = true;
    }
    function restoreRecovery() {
      if (safeGeneration(generation)) return false;
      const record = readRecovery(); if (!record) return false;
      viewerId = record.viewerId; generation = record.generation; expiresAt = record.expiresAt; recoveryRecord = record;
      recovered = true; stopAuthorized = false; phase = "checking"; scheduleExpiry(); return true;
    }
    const text = (id, value) => { elements[id].textContent = value; };
    function clearConnection() {
      connectionUrl = ""; elements.srtConnectionUrl.value = ""; elements.srtNativeLink.removeAttribute("href");
      elements.srtConnection.hidden = true; text("srtCopyStatus", "");
    }
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function clearExpiryTimer() { if (expiryTimer !== null) cancel(expiryTimer); expiryTimer = null; }
    function scheduleExpiry() {
      clearExpiryTimer(); if (!ownsExperiment()) return;
      expiryTimer = later(() => { expiryTimer = null; expire(); }, Math.max(1, expiresAt - now()));
    }
    function ownsExperiment() { return safeGeneration(generation) && expiresAt > now(); }
    const selectedTarget = () => elements.srtVideoBitrate.value === "600" ? 600 : elements.srtVideoBitrate.value === "60" ? 60 : null;
    const targetAvailable = () => videoTarget(selectedTarget()) && Array.isArray(running?.srtExperiment?.videoTargetsMbps) && running.srtExperiment.videoTargetsMbps.includes(selectedTarget());
    function publisherReady() {
      return viewerId && running?.state === "running" && running.transport === "obs-webrtc" && safeGeneration(running.generation) &&
        running.srtExperiment?.available === true && running.srtExperiment?.enabled !== false;
    }
    function canStart() { return publisherReady() && targetAvailable(); }
    function renderMetrics() {
      const metrics = lastMetrics, observedAt = metrics?.observedAt, independent = lastVideoProfile?.encoderMode === "independent-srt";
      const age = finite(observedAt) ? now() - observedAt : null, fresh = !independent && age !== null && age >= 0 && age <= FRESH_MS;
      const readers = Number.isSafeInteger(metrics?.readers) && metrics.readers >= 0 ? metrics.readers : null;
      text("srtConnected", independentCleanupPending ? "Unknown · cleanup pending" : senderFailed ? "Unknown · sender failed" : independent ? "Unknown · native delivery not measured" : fresh && readers !== null ? readers > 0 ? readers + (readers === 1 ? " receiver connected" : " receivers connected") : "Not connected" : lastMetrics ? "Unknown · measurements stale or unavailable" : "Not connected");
      const stats = fresh && Array.isArray(metrics?.stats) ? metrics.stats.slice(0, 8) : [];
      const values = key => stats.map(item => item?.[key]).filter(finite);
      const sum = key => { const list = values(key); return list.length ? list.reduce((a, b) => a + b, 0) : null; };
      const delays = [...new Set(values("msSendTsbPdDelay"))];
      text("srtNegotiatedDelay", independent ? "Unknown · not measured" : delays.length ? delays.map(value => Math.round(value) + " ms").join(" / ") : "Unknown until a receiver connects");
      const rate = sum("mbpsSendRate"), retransmits = sum("packetsRetrans"), drops = sum("packetsSendDrop");
      text("srtSendRate", rate === null ? "Unknown" : rate.toFixed(1) + " Mbps");
      text("srtRetransmits", retransmits === null ? "Unknown" : String(Math.round(retransmits)));
      text("srtDropped", drops === null ? "Unknown" : String(Math.round(drops)));
      text("srtMetricsStatus", independentCleanupPending ? "Independent SRT cleanup is pending; connection and live measurements are not verified." :
        senderFailed ? "Sender failure reported. This page does not measure Larix receiving or decoding." :
        independent ? "Native delivery counters are unavailable for independent SRT. Fresh encoded-video observations appear above." : fresh ? "Server measurements · " + (age / 1000).toFixed(1) + " seconds old. Listener readiness does not mean a native receiver has connected." :
        lastMetricsReadAt !== null ? "Measurements are stale or unavailable; connection and timing are not verified." : "No receiver measurements yet.");
      text("srtMeasurementNote", independent ? "Independent SRT counts H.264 access-unit bytes before MPEG-TS and SRT for its encoded-video rate. Native receiver count, SRT send rate, retransmissions, drops and negotiated delay are not measured. The 250 ms value is a request only. This page receives no video or audio and does not measure native decoding or physical display timing." :
        lastVideoProfile?.encoderMode === "shared-publisher" ? "Shared-publisher encoded video uses the server’s incoming H.264 byte rate, including RTP framing. MediaMTX counters show SRT send rate, transport overhead and recovery when fresh. They do not measure the tablet’s decoded frames or physical display timing. This page receives no video or audio." :
        "Encoded video rate and native delivery counters are separate measurements. Start a test to see which observations are available. This page receives no video or audio and does not measure native decoding or physical display timing.");
    }
    function render() {
      elements.srtStart.disabled = busy || ownsExperiment() || phase === "conflict" || !canStart();
      elements.srtStop.disabled = busy || !ownsExperiment() || !stopAuthorized; elements.srtRefresh.disabled = busy;
      elements.srtVideoBitrate.disabled = busy || ownsExperiment();
      const target = selectedTarget();
      text("srtVideoTargetHelp", !videoTarget(target) ? "Choose a supported SRT video target." :
        !targetAvailable() ? target + " Mbps SRT is not available on the loaded server. Refresh after this target is prepared, or explicitly choose another available target. No fallback is applied." :
        target === 600 ? "600 Mbps uses an independent SRT encoder. WebRTC keeps its current profile. This stress test may exceed the tablet’s decoder limits; compatibility is unverified. For a baseline, explicitly select 60 Mbps before a new test. No automatic fallback is applied." :
        "60 Mbps reuses the current compressed publisher for a baseline comparison. WebRTC keeps its current profile.");
      if (ownsExperiment()) {
        const seconds = Math.max(0, Math.ceil((expiresAt - now()) / 1000));
        const remaining = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
        text("srtExpiry", independentCleanupPending ? "Stop retry remains available for " + remaining + ". The original 10-minute limit is unchanged." :
          "Expires in " + remaining + ". Switching apps keeps the experiment running.");
      } else text("srtExpiry", phase === "expired" ? "The experiment has ended. Start again only when you want another comparison." : "No SRT experiment is active from this page.");
      if (recoveryUnavailable) text("srtExpiry", elements.srtExpiry.textContent + " Recovery controls could not be saved; keep this tab open to retain its Stop control.");
      const profile = running?.videoStats;
      text("srtProfile", finite(profile?.width) && finite(profile?.height) && finite(profile?.targetFps) && finite(profile?.configuredBitrateMbps) ?
        profile.width + " × " + profile.height + " · " + profile.targetFps + " fps · " + profile.configuredBitrateMbps + " Mbps target" : "No running OBS profile");
      text("srtRequestedRate", lastVideoProfile ? lastVideoProfile.requestedBitrateMbps + " Mbps · server confirmed" : videoTarget(target) ? target + " Mbps · selected only" : "Unknown");
      text("srtConfiguredRate", lastVideoProfile ? (Number.isInteger(lastVideoProfile.configuredBitrateMbps) ? "" : "≈ ") + lastVideoProfile.configuredBitrateMbps.toFixed(1) + " Mbps · configured, not measured" : "Not confirmed");
      text("srtVideoProfile", lastVideoProfile ? lastVideoProfile.width + " × " + lastVideoProfile.height + " · " + lastVideoProfile.fps + " fps target" : "Not confirmed");
      text("srtEncoderMode", lastVideoProfile ? lastVideoProfile.encoderMode === "independent-srt" ? "Independent SRT encoder" : "Shared WebRTC publisher" : "Not confirmed");
      const videoAge = finite(lastVideoProfile?.videoBitrateObservedAt) ? now() - lastVideoProfile.videoBitrateObservedAt : null;
      const videoFresh = videoAge !== null && videoAge >= 0 && videoAge <= FRESH_MS && finite(lastVideoProfile?.videoBitrateWindowMs) && lastVideoProfile.videoBitrateWindowMs > 0;
      text("srtEncodedRate", videoFresh && finite(lastVideoProfile?.videoBitrateMbps) ? lastVideoProfile.videoBitrateMbps.toFixed(1) + " Mbps · " +
        (lastVideoProfile.videoBitrateWindowMs / 1000).toFixed(1) + " second window · " + (videoAge / 1000).toFixed(1) + " seconds old" : "Unknown · no fresh video measurement");
      const codec = lastVideoProfile?.observedCodec, codecAge = finite(codec?.observedAt) ? now() - codec.observedAt : null;
      const codecFresh = codecAge !== null && codecAge >= 0 && codecAge <= FRESH_MS && codec?.measurement === "gstreamer-h264parse-caps" &&
        ["baseline", "constrained-baseline", "main", "high", "high-10", "high-4:2:2", "high-4:4:4"].includes(codec.profile) && /^\d{1,2}(?:\.\d)?$/.test(codec.level || "");
      text("srtObservedCodec", codecFresh ? "H.264 " + codec.profile + " · level " + codec.level + " · observed, not a configuration claim" : "Unknown · no fresh codec observation");
      text("srtVisualDelay", finite(running?.visualDelay?.currentMs) ? running.visualDelay.currentMs + " ms · unchanged" : "Unknown · unchanged");
      renderMetrics();
    }
    async function json(url, method = "GET", body) {
      const controller = new AbortController(), timeout = later(() => controller.abort(), 20000);
      try {
        const response = await request(url, { method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: body ? { "Content-Type": "application/json" } : undefined, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.ok) {
          let code; try { const body = await response.json(); if (response.status === 409 && body?.error === "Stop the current SRT experiment before starting another.") code = "SRT_ALREADY_ACTIVE"; } catch {}
          throw Object.assign(Error("Request failed"), { status: response.status, code });
        }
        const value = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid response");
        return value;
      } finally { cancel(timeout); }
    }
    const statusUrl = () => "/api/soundspectrum/srt?" + new URLSearchParams({ viewerId });
    function expire(message = "The experiment expired. Start the main player’s visuals to return to WebRTC.", failed = false) {
      clearRecovery(); recovered = false; stopAuthorized = false; independentCleanupPending = false;
      senderFailed = failed;
      epoch++; generation = null; expiresAt = 0; phase = "expired"; lastMetrics = null; lastMetricsReadAt = null; lastVideoProfile = null;
      clearTimer(); clearExpiryTimer(); clearConnection(); text("srtStatus", message); render();
    }
    function applyOwnStatus(value) {
      if (["idle", "stopped", "expired"].includes(value.state)) {
        if (safeGeneration(generation)) expire(value.state === "expired" ? undefined : "The experiment stopped. Other browser viewers may continue normally.");
        return false;
      }
      if (value.state === "error") {
        const cause = failureMessage(value.diagnostics); senderFailed = true;
        const profile = verifiedVideoProfile(value.videoProfile);
        if (ownsExperiment() && value.generation === generation && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now() &&
            profile?.requestedBitrateMbps === 600 && profile.encoderMode === "independent-srt" && selectedTarget() === 600) {
          expiresAt = Math.min(expiresAt, value.expiresAt);
          if (recoveryRecord && expiresAt < recoveryRecord.expiresAt && !saveRecovery({ ...recoveryRecord, expiresAt })) recoveryUnavailable = true;
          clearConnection(); lastMetrics = null; lastMetricsReadAt = null;
          lastVideoProfile = { ...profile, videoBitrateMbps: null, videoBitrateObservedAt: null, videoBitrateWindowMs: null, observedCodec: null };
          independentCleanupPending = true; stopAuthorized = true; phase = "error"; scheduleExpiry();
          text("srtStatus", cause + " Cleanup is still pending; tap Stop to retry. Its private connection and live measurements are cleared. WebRTC viewers can continue. Larix receiving and decoding are not measured here.");
          render(); return true;
        }
        expire(cause + " An active experiment was not confirmed for this controller. Larix receiving and decoding are not measured here. Check the PC and refresh the main player before starting another experiment.", true); running = null; render(); return false;
      }
      if (safeGeneration(generation) && value.generation !== generation) {
        expire("The visualizer changed. The old connection is cleared; refresh before another experiment."); return false;
      }
      if (!["ready", "active", "starting", "stopping"].includes(value.state)) throw Error("Invalid experiment state");
      if (!ownsExperiment()) return false;
      if (finite(value.expiresAt)) expiresAt = Math.min(expiresAt, value.expiresAt);
      if (!ownsExperiment()) { expire(); return false; }
      if (recoveryRecord && expiresAt < recoveryRecord.expiresAt) {
        if (!saveRecovery({ ...recoveryRecord, expiresAt })) recoveryUnavailable = true;
      }
      scheduleExpiry();
      stopAuthorized = true; independentCleanupPending = false; senderFailed = false;
      const confirmedProfile = verifiedVideoProfile(value.videoProfile);
      const profileChanged = lastVideoProfile && confirmedProfile && lastVideoProfile.requestedBitrateMbps !== confirmedProfile.requestedBitrateMbps;
      lastVideoProfile = profileChanged ? null : confirmedProfile;
      if (!lastVideoProfile) clearConnection();
      if (lastVideoProfile) elements.srtVideoBitrate.value = String(lastVideoProfile.requestedBitrateMbps);
      lastMetrics = value.metrics && typeof value.metrics === "object" ? value.metrics : null; lastMetricsReadAt = now();
      phase = value.state;
      const metricAge = finite(lastMetrics?.observedAt) ? now() - lastMetrics.observedAt : null;
      const independent = lastVideoProfile?.encoderMode === "independent-srt";
      const connected = !independent && metricAge !== null && metricAge >= 0 && metricAge <= FRESH_MS && Number.isSafeInteger(lastMetrics?.readers) && lastMetrics.readers > 0;
      text("srtStatus", phase === "starting" ? "SRT setup is still in progress. The private connection is not ready; you can Stop this bounded experiment." :
        phase === "stopping" ? "SRT cleanup is still in progress. Native connection details are cleared." :
        !lastVideoProfile ? "The SRT video profile could not be confirmed. Its private connection is cleared. Tap Stop, then Refresh status before another test." :
        !connectionUrl ? recovered ? "Recovered the existing experiment’s Stop control. Its private connection is not stored. Tap Stop, then explicitly Start for a fresh connection." : "The experiment is still active, but its private connection was cleared. Stop, then explicitly Start again for a fresh connection." :
        independent ? "Independent SRT stream ready. Open the private connection in Larix Player. Native delivery counters are not measured." :
        connected ? "A native receiver is connected. Compare its picture and the server counters below." :
        "SRT listener ready. Open the private connection in Larix Player; a native receiver is not yet verified.");
      if (["starting", "stopping"].includes(phase)) clearConnection();
      render(); return true;
    }
    function schedulePoll() {
      clearTimer(); if (!ownsExperiment()) return;
      timer = later(() => { timer = null; void poll(); }, Math.min(POLL_MS, Math.max(1, expiresAt - now())));
    }
    async function poll() {
      if (!ownsExperiment()) { if (generation !== null) expire(); return; }
      const requestEpoch = epoch;
      try {
        const value = await json(statusUrl()); if (requestEpoch !== epoch) return;
        if (!ownsExperiment()) { expire(); return; }
        applyOwnStatus(value);
      } catch {
        if (requestEpoch !== epoch) return;
        clearConnection(); lastVideoProfile = null; lastMetrics = null; phase = "error";
        text("srtStatus", "Status could not be checked. The private connection is cleared. Retry Stop or refresh; the server’s 10-minute limit still applies."); render();
      } finally { if (requestEpoch === epoch) schedulePoll(); }
    }
    async function refresh() {
      if (busy) return;
      restoreRecovery();
      busy = true; render(); const requestEpoch = epoch;
      try {
        const [current, own] = await Promise.all([json("/api/soundspectrum/status"), json(statusUrl())]);
        if (requestEpoch !== epoch) return; running = current;
        if (safeGeneration(generation)) applyOwnStatus(own);
        else {
          senderFailed = false;
          phase = "idle";
          text("srtStatus", !viewerId ? "Secure random identifiers are unavailable. Use a current browser before starting the experiment." : canStart() ?
            "The OBS visualizer is running. Start this experiment when you are ready to compare." :
            publisherReady() && !targetAvailable() ? "The selected SRT target is unavailable on the loaded server. No experiment was started. Choose an available target explicitly or refresh after preparation." :
            running.srtExperiment?.available === false || running.srtExperiment?.enabled === false ? "The optional SRT experiment is unavailable on this server." :
            "Start visuals with OBS / WebRTC in the main player first, then refresh this status.");
        }
      } catch {
        if (requestEpoch !== epoch) return; clearConnection(); lastVideoProfile = null; lastMetrics = null; running = null; phase = "error";
        text("srtStatus", "Rabbit Hole status is unavailable. Check the connection and tap Refresh status.");
      } finally { busy = false; render(); if (requestEpoch === epoch) schedulePoll(); }
    }
    async function start() {
      if (busy || ownsExperiment() || phase === "conflict" || !viewerId) return;
      const requestedVideoTarget = selectedTarget();
      busy = true; phase = "starting"; independentCleanupPending = false; senderFailed = false; clearConnection(); lastVideoProfile = null; text("srtStatus", "Checking the running visualizer and selected SRT target…"); render();
      const requestEpoch = ++epoch;
      try {
        running = await json("/api/soundspectrum/status");
        if (requestEpoch !== epoch) return;
        if (!publisherReady()) throw Object.assign(Error("Publisher unavailable"), { status: 409 });
        if (!targetAvailable() || selectedTarget() !== requestedVideoTarget) throw Object.assign(Error("SRT target unavailable"), { code: "SRT_TARGET_UNAVAILABLE" });
        const requestedGeneration = running.generation;
        const existing = readRecovery();
        if (existing) {
          phase = "conflict"; text("srtStatus", "Another tab has saved an unexpired experiment control. Tap Refresh status to recover its Stop control before starting another experiment."); return;
        }
        // New trials get a new capability even when the shared publisher keeps
        // the same generation. A stale recovered tab can only stop its old trial.
        const previousViewer = viewerId; let freshViewer = "";
        for (let attempt = 0; attempt < 3 && (!freshViewer || freshViewer === previousViewer); attempt++) freshViewer = newCapability();
        if (!freshViewer || freshViewer === previousViewer) throw Error("Fresh controller identifier unavailable");
        viewerId = freshViewer;
        // Unknown POST outcomes remain bounded and stoppable. Refresh must
        // confirm idle before another Start can request the same private lease.
        const requestedAt = now();
        generation = requestedGeneration; expiresAt = requestedAt + MAX_DURATION_MS; stopAuthorized = true; recovered = false;
        if (!saveRecovery({ version: 1, viewerId, generation, startedAt: requestedAt, expiresAt })) {
          generation = null; expiresAt = 0; stopAuthorized = false; phase = "conflict";
          text("srtStatus", "Another tab has saved an unexpired experiment control. Tap Refresh status to recover its Stop control."); return;
        }
        scheduleExpiry();
        const value = await json("/api/soundspectrum/srt", "POST", { action: "start", viewerId, generation: requestedGeneration, videoBitrateMbps: requestedVideoTarget });
        if (requestEpoch !== epoch) return;
        const privateUrl = privateConnection(value.connectionUrl);
        if (value.generation !== requestedGeneration || !["ready", "active"].includes(value.state) || !finite(value.expiresAt) || value.expiresAt <= now()) throw Error("Invalid start receipt");
        const confirmedProfile = verifiedVideoProfile(value.videoProfile);
        if (!confirmedProfile || confirmedProfile.requestedBitrateMbps !== requestedVideoTarget) throw Error("SRT video target not confirmed");
        // A valid lease receipt remains stoppable even when the private URL is invalid.
        if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt > now() + MAX_DURATION_MS) throw Error("Invalid server expiry");
        // A successful receipt supplies the original authoritative server
        // deadline; later GETs and recovered pages may only shorten it.
        expiresAt = value.expiresAt;
        await saveConfirmedRecovery({ version: 1, viewerId, generation, startedAt: Math.max(0, expiresAt - MAX_DURATION_MS), expiresAt });
        if (requestEpoch !== epoch) return;
        if (!privateUrl) throw Error("Invalid private connection");
        connectionUrl = privateUrl; elements.srtConnectionUrl.value = privateUrl; elements.srtNativeLink.setAttribute("href", privateUrl); elements.srtConnection.hidden = false;
        applyOwnStatus(value);
      } catch (error) {
        if (requestEpoch !== epoch) return;
        clearConnection(); phase = "error";
        if (error.code === "SRT_ALREADY_ACTIVE") {
          clearRecovery(); generation = null; expiresAt = 0; stopAuthorized = false; clearTimer(); clearExpiryTimer(); phase = "conflict";
          text("srtStatus", "Another SRT experiment is still active. Reopen its original tab or wait for its 10-minute limit, then Refresh status. This page did not start it.");
        } else text("srtStatus", error.code === "SRT_TARGET_UNAVAILABLE" ? "The selected SRT target is unavailable on the loaded server. No experiment was started and no fallback was applied. Refresh after preparation or explicitly choose another target." :
          error.status === 409 ? "The running visualizer changed or is not ready. Refresh after starting OBS / WebRTC visuals in the main player." :
          "The SRT experiment could not be confirmed. Tap Stop if available; a server-started experiment expires after 10 minutes. Refresh before trying again.");
      } finally { busy = false; render(); if (requestEpoch === epoch) schedulePoll(); }
    }
    async function stop() {
      if (busy || !ownsExperiment() || !stopAuthorized) return;
      const stoppedGeneration = generation, independent = selectedTarget() === 600, requestEpoch = ++epoch;
      busy = true; phase = "stopping"; clearTimer(); clearConnection(); text("srtStatus", "Stopping this experiment’s native connection…"); render();
      try {
        const value = await json("/api/soundspectrum/srt", "POST", { action: "stop", viewerId, generation: stoppedGeneration });
        if (requestEpoch !== epoch) return;
        if (!["idle", "stopped", "expired"].includes(value.state)) throw Error("Stop not confirmed");
        clearRecovery(); recovered = false; stopAuthorized = false; independentCleanupPending = false; senderFailed = false;
        generation = null; expiresAt = 0; clearExpiryTimer(); phase = "idle"; lastMetrics = null; lastMetricsReadAt = null; lastVideoProfile = null;
        text("srtStatus", "SRT experiment stopped. Start visuals in the main player to compare WebRTC again.");
      } catch (error) {
        if (requestEpoch !== epoch) return;
        if (independent && error.status === 502) {
          independentCleanupPending = true; lastMetrics = null; lastMetricsReadAt = null;
          if (lastVideoProfile) lastVideoProfile = { ...lastVideoProfile, videoBitrateMbps: null, videoBitrateObservedAt: null, videoBitrateWindowMs: null, observedCodec: null };
        }
        phase = "error"; text("srtStatus", error.status === 502 && independent ? "Independent SRT cleanup could not be confirmed. Tap Stop to retry; the original 10-minute deadline still applies. WebRTC viewers can continue." :
          error.status === 502 ? "SRT cleanup failed. Shared visuals may have stopped for cleanup. Check the PC and tap Refresh status before another experiment." :
          "Stop could not be confirmed. Tap Stop again; the server’s fixed 10-minute expiry still applies.");
      } finally { busy = false; render(); if (requestEpoch === epoch) schedulePoll(); }
    }
    async function copy() {
      if (!connectionUrl || !ownsExperiment()) return;
      const value = connectionUrl, requestEpoch = epoch;
      try {
        if (typeof navigator?.clipboard?.writeText !== "function") throw Error("Clipboard unavailable");
        await navigator.clipboard.writeText(value);
        if (requestEpoch === epoch && connectionUrl === value) text("srtCopyStatus", "Connection copied. Paste it into Larix Player.");
      } catch {
        if (requestEpoch !== epoch || connectionUrl !== value) return;
        elements.srtConnectionUrl.focus(); elements.srtConnectionUrl.select();
        text("srtCopyStatus", "Copy is unavailable here. The connection is selected; use your device’s Copy command.");
      }
    }
    elements.srtStart.addEventListener("click", () => { void start(); }); elements.srtStop.addEventListener("click", () => { void stop(); });
    elements.srtRefresh.addEventListener("click", () => { void refresh(); }); elements.srtCopy.addEventListener("click", () => { void copy(); });
    elements.srtVideoBitrate.addEventListener("change", () => { render(); });
    // Native-app switching may hide this page. The fixed server lease, not a
    // page visibility heartbeat, owns expiry; no automatic Stop or media opens.
    restoreRecovery(); render();
    return { refresh, start, stop, copy, state: () => ({ phase, generation, expiresAt, active: ownsExperiment() }) };
  }
  global.createSrtExperimentController = createSrtExperimentController;
  if (global.document?.getElementById("experiment")) {
    const controller = createSrtExperimentController(); void controller.refresh();
  }
})(window);
