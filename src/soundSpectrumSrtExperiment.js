"use strict";

const MAX_DURATION_MS = 10 * 60 * 1000;
const validViewer = value => typeof value === "string" && /^[a-zA-Z0-9_-]{20,100}$/.test(value);
const problem = (message, statusCode = 409) => Object.assign(Error(message), { statusCode });
const metricKeys = ["msSendTsbPdDelay", "msRTT", "mbpsSendRate", "bytesSent", "bytesSentUnique", "packetsRetrans", "packetsReceivedNAK", "packetsSendDrop", "outboundFramesDiscarded"];
const failureCodes = new Set(["child-exit", "child-error", "native-identity-lost", "listener-lost", "encoded-output-stale", "send-buffer-full", "monitor-error", "cleanup-failed"]);
const failureSignals = new Set(["SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2"]);
const endReasons = new Set(["user-stop", "startup-failed", "sender-failure", "expired", "generation-changed", "lease-lost", "shutdown"]);

function safeDiagnostics(value, at) {
  const empty = { failureCode: null, failureObservedAt: null, exitCode: null, signal: null };
  if (!Number.isSafeInteger(at) || at <= 0 || !value || typeof value !== "object" || Array.isArray(value) || !failureCodes.has(value.failureCode) ||
      !Number.isSafeInteger(value.failureObservedAt) || value.failureObservedAt <= 0 || value.failureObservedAt > at) return empty;
  return { failureCode: value.failureCode, failureObservedAt: value.failureObservedAt,
    exitCode: value.failureCode === "child-exit" && Number.isInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 4294967295 ? value.exitCode : null,
    signal: value.failureCode === "child-exit" && failureSignals.has(value.signal) ? value.signal : null };
}

function safeMetrics(value, at) {
  const observedAt = Number.isFinite(value?.observedAt) ? value.observedAt : null;
  const fresh = observedAt !== null && at >= observedAt && at - observedAt <= 5000;
  const stats = fresh && Array.isArray(value?.stats) ? value.stats.slice(0, 8).map(entry => Object.fromEntries(metricKeys.map(key => [key,
    Number.isFinite(entry?.[key]) && entry[key] >= 0 ? entry[key] : null]))) : [];
  const readers = fresh && Number.isSafeInteger(value?.readers) && value.readers >= 0 && value.readers <= 8 ? value.readers : null;
  return { readers, observedAt, fresh, stats };
}

function safeVideoProfile(value, at) {
  if (!value || ![60, 600].includes(value.requestedBitrateMbps) ||
      !["shared-publisher", "independent-srt"].includes(value.encoderMode) ||
      !Number.isFinite(value.configuredBitrateMbps) || value.configuredBitrateMbps <= 0 || value.configuredBitrateMbps > 600 ||
      !Number.isSafeInteger(value.width) || value.width <= 0 || value.width > 3840 ||
      !Number.isSafeInteger(value.height) || value.height <= 0 || value.height > 2160 || value.fps !== 60) return null;
  const observedAt = Number.isFinite(value.videoBitrateObservedAt) ? value.videoBitrateObservedAt : null;
  const fresh = observedAt !== null && at >= observedAt && at - observedAt <= 5000;
  const measured = fresh && Number.isFinite(value.videoBitrateMbps) && value.videoBitrateMbps >= 0 &&
    Number.isFinite(value.videoBitrateWindowMs) && value.videoBitrateWindowMs > 0;
  const codec = value.observedCodec;
  return { requestedBitrateMbps: value.requestedBitrateMbps, configuredBitrateMbps: value.configuredBitrateMbps,
    encoderMode: value.encoderMode, width: value.width, height: value.height, fps: value.fps,
    videoBitrateMbps: measured ? value.videoBitrateMbps : null,
    videoBitrateObservedAt: observedAt, videoBitrateWindowMs: measured ? value.videoBitrateWindowMs : null,
    observedCodec: codec && /^(?:baseline|constrained-baseline|main|high)$/.test(codec.profile || "") &&
      /^(?:[1-6](?:\.[0-2])?)$/.test(codec.level || "") && Number.isFinite(codec.observedAt) &&
      codec.observedAt <= at && codec.observedAt >= 0 && codec.measurement === "gstreamer-h264parse-caps" ?
      { profile: codec.profile, level: codec.level, observedAt: codec.observedAt, measurement: codec.measurement } : null };
}

class SoundSpectrumSrtExperiment {
  constructor(service) { this.service = service; this.run = null; this.last = null; }
  lifecycle(run, transition, { cleanupFailed = false } = {}) {
    // At most started/ready/end plus first failure and first cleanup failure.
    // Never log controller identities, connections, raw errors or provider data.
    try {
      if (!["started", "ready", "end", "error"].includes(transition)) return;
      const key = transition + (transition === "error" && cleanupFailed ? ":cleanup" : "");
      run.loggedTransitions ||= new Set();
      if (run.loggedTransitions.has(key)) return;
      run.loggedTransitions.add(key);
      const s = this.service, at = s.clock(), elapsed = at - run.startedAt;
      const diagnostics = safeDiagnostics(run.diagnostics, at);
      run.lifecycleFailureCode ||= diagnostics.failureCode || (cleanupFailed ? "cleanup-failed" : null);
      const pending = s.diagnostic?.({ event: "srt-" + transition,
        generation: Number.isSafeInteger(run.generation) && run.generation >= 0 ? run.generation : null,
        targetMbps: [60, 600].includes(run.videoBitrateMbps) ? run.videoBitrateMbps : null,
        originalExpiresAt: Number.isSafeInteger(run.expiresAt) && run.expiresAt > 0 ? run.expiresAt : null,
        elapsedMs: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null,
        leasePresent: s.leases.has(run.viewerId),
        reason: endReasons.has(run.endReason) ? run.endReason : null,
        failureCode: failureCodes.has(run.lifecycleFailureCode) ? run.lifecycleFailureCode : null,
        cleanupFailed: cleanupFailed === true });
      pending?.catch?.(() => {});
    } catch {} // A failed diagnostic sink cannot alter media or owned cleanup.
  }
  matches(run) {
    const s = this.service;
    return this.run === run && !run.cancelled && !s.closed && run.generation === s.generation && s.state === "running" && s.transport === "obs-webrtc" && s.obsSession?.ready;
  }
  captureDiagnostics(run, cached) {
    const s = this.service, at = s.clock();
    if (run.videoBitrateMbps === 600 && this.run === run && run.generation === s.generation && !run.diagnostics?.failureCode) {
      if (cached === undefined) { try { cached = s.obsTransport?.snapshot?.().srtExperiment; } catch {} }
      const value = safeDiagnostics(cached?.diagnostics, at);
      if (cached?.videoProfile?.requestedBitrateMbps === 600 && cached.videoProfile.encoderMode === "independent-srt" &&
          value.failureCode && value.failureObservedAt >= run.expiresAt - MAX_DURATION_MS) run.diagnostics = value;
    }
    return safeDiagnostics(run.diagnostics, at);
  }
  status(viewerId) {
    if (!validViewer(viewerId)) throw problem("Invalid SRT experiment controller.", 400);
    const s = this.service, run = this.run?.viewerId === viewerId ? this.run : null;
    if (!run) return { state: this.last?.viewerId === viewerId ? this.last.state : "idle", available: s.inventory?.srtExperiment?.available === true,
      requestedLatencyMs: 250, maxDurationMs: MAX_DURATION_MS, metrics: safeMetrics(null, s.clock()),
      diagnostics: safeDiagnostics(this.last?.viewerId === viewerId ? this.last.diagnostics : null, s.clock()) };
    let cached; try { cached = s.obsTransport?.snapshot?.().srtExperiment; } catch {}
    const profile = safeVideoProfile(cached?.videoProfile, s.clock());
    const videoProfile = profile?.requestedBitrateMbps === run.videoBitrateMbps ? profile : safeVideoProfile(run.videoProfile, s.clock());
    return { state: run.cleanupFailed || run.videoBitrateMbps === 600 && cached?.state === "error" ? "error" : run.stopping ? "stopping" : !this.matches(run) || s.clock() >= run.expiresAt ? "expired" : run.ready ? "ready" : "starting",
      available: true, generation: run.generation, expiresAt: run.expiresAt, maxDurationMs: MAX_DURATION_MS, requestedLatencyMs: 250,
      videoProfile, metrics: safeMetrics(cached, s.clock()), diagnostics: this.captureDiagnostics(run, cached) };
  }
  async start({ viewerId, generation, videoBitrateMbps = 60 }) {
    if (!validViewer(viewerId) || !Number.isSafeInteger(generation) || ![60, 600].includes(videoBitrateMbps)) throw problem("Invalid SRT experiment request.", 400);
    const s = this.service;
    if (this.run) throw problem("Stop the current SRT experiment before starting another.");
    if (s.leases.has(viewerId)) throw problem("Use a separate SRT experiment controller.");
    if (generation !== s.generation || s.state !== "running" || s.transport !== "obs-webrtc" || !s.obsSession?.ready) throw problem("Start OBS / WebRTC visuals in the main player first.");
    if (!s.obsTransport?.srtConnection || !s.obsTransport?.releaseSrt) throw problem("The SRT experiment is not installed.", 503);
    const startedAt = s.clock();
    const run = { viewerId, generation, videoBitrateMbps, startedAt, expiresAt: startedAt + MAX_DURATION_MS, cancelled: false, ready: false, joined: false, videoProfile: null };
    this.run = run;
    this.lifecycle(run, "started");
    try {
      const inventory = await s.inspect(true);
      if (!this.matches(run)) throw problem("The visualizer changed during SRT setup.");
      if (inventory.srtExperiment?.available !== true) throw problem("The private SRT experiment has not been prepared.", 503);
      if (videoBitrateMbps === 600 && !inventory.srtExperiment.videoTargetsMbps?.includes(600)) throw problem("The independent 600 Mbps SRT test is not prepared.", 503);
      run.joined = true;
      run.joinPromise = s.session({ action: "join", viewerId, generation, visualizer: s.visualizer,
        ...(s.whitecapTheme && s.whitecapTheme !== "current" ? { whitecapTheme: s.whitecapTheme } : {}),
        inputId: s.inputId, playerId: s.playerId, zoneId: s.zoneId, transport: s.transport });
      await run.joinPromise;
      if (!this.matches(run)) throw problem("The visualizer changed during SRT setup.");
      // Explicit native-player demand is bounded independently of Android's browser.
      s.leases.set(viewerId, run.expiresAt);
      const connection = await s.obsTransport.srtConnection({ viewerId, generation, videoBitrateMbps, expiresAt: run.expiresAt });
      if (!this.matches(run) || s.clock() >= run.expiresAt) throw problem("The SRT experiment ended during setup.");
      const url = new URL(connection.url);
      if (url.protocol !== "srt:" || connection.generation !== generation || connection.requestedLatencyMs !== 250) throw problem("The SRT connection could not be verified.");
      run.videoProfile = safeVideoProfile(connection.videoProfile, s.clock());
      if (videoBitrateMbps === 60 && (!run.videoProfile || run.videoProfile.requestedBitrateMbps !== 60 ||
          run.videoProfile.encoderMode !== "shared-publisher" || run.videoProfile.configuredBitrateMbps !== 60)) {
        throw problem("The shared SRT baseline is not configured at 60 Mbps.");
      }
      if (videoBitrateMbps === 600 && (!run.videoProfile || run.videoProfile.requestedBitrateMbps !== 600 ||
          run.videoProfile.encoderMode !== "independent-srt" || run.videoProfile.width !== 3840 || run.videoProfile.height !== 2160 ||
          run.videoProfile.configuredBitrateMbps !== 599.999488)) throw problem("The independent SRT encoder target could not be verified.");
      run.ready = true;
      this.lifecycle(run, "ready");
      return { ...this.status(viewerId), connectionUrl: connection.url, client: "larix-player", latencyUnit: "milliseconds" };
    } catch (error) {
      await this.stopRun(run, "stopped", "startup-failed");
      throw problem(error?.statusCode === 503 ? "The private SRT experiment is unavailable. Check preparation and select Start again." : "SRT setup ended or could not complete. Refresh the current visualizer and retry.", error?.statusCode || 409);
    }
  }
  async stop({ viewerId, generation }) {
    if (!validViewer(viewerId) || !Number.isSafeInteger(generation)) throw problem("Invalid SRT experiment request.", 400);
    const run = this.run;
    if (!run || run.viewerId !== viewerId) throw problem("This controller does not own the SRT experiment.", 403);
    if (run.generation !== generation) throw problem("The SRT experiment generation changed.");
    await this.stopRun(run, "stopped", "user-stop");
    return this.status(viewerId);
  }
  stopRun(run, state, reason) {
    if (run.stopping) return run.stopping;
    this.captureDiagnostics(run);
    if (!run.endReason && endReasons.has(reason)) run.endReason = reason;
    if (["startup-failed", "sender-failure"].includes(run.endReason)) this.lifecycle(run, "error");
    run.cancelled = true; run.cleanupFailed = false;
    run.stopping = (async () => {
      const s = this.service;
      try {
        // A cancelled join must finish before removing its lease, so a late
        // completion cannot recreate native demand after Stop has succeeded.
        await run.joinPromise?.catch(() => {});
        await s.obsTransport?.releaseSrt?.({ viewerId: run.viewerId, generation: run.generation });
      }
      catch {
        // This branch owns a separate encoder and relay. Keep its controller for
        // exact Stop retries; its failure cannot justify stopping shared WebRTC.
        if (run.videoBitrateMbps === 600) {
          run.cleanupFailed = true; run.stopping = null;
          this.last = { viewerId: run.viewerId, state: "error", diagnostics: this.captureDiagnostics(run) };
          this.lifecycle(run, "error", { cleanupFailed: true });
          throw problem("Independent SRT cleanup failed. Retry Stop; WebRTC can continue.", 502);
        }
        // A failed SRT revocation must not leave an unbounded native reader alive.
        if (run.generation === s.generation && !s.closed) {
          await s.fail(run.generation, problem("The SRT listener could not close. Shared visuals were stopped for cleanup.", 502));
          await s.serial;
        }
        this.last = { viewerId: run.viewerId, state: "error" };
        this.lifecycle(run, "error", { cleanupFailed: true });
        throw problem("SRT cleanup failed. Check the PC before starting another experiment.", 502);
      } finally {
        if (run.joined && !run.cleanupFailed) {
          s.leases.delete(run.viewerId); s.leaseVisibility.delete(run.viewerId); s.viewerPerformance.delete(run.viewerId);
          s.releaseObsViewer(run.viewerId, run.generation);
          if (!s.leases.size && ["starting", "running"].includes(s.state)) s.release("srt-experiment-ended");
        }
        if (this.run === run && !run.cleanupFailed) this.run = null;
        if (!run.cleanupFailed) this.lifecycle(run, "end");
      }
      this.last = { viewerId: run.viewerId, state, diagnostics: safeDiagnostics(run.diagnostics, s.clock()) };
    })();
    return run.stopping;
  }
  sweep() {
    const run = this.run;
    let failed = false; try { failed = run?.videoBitrateMbps === 600 && this.service.obsTransport?.snapshot?.().srtExperiment?.state === "error"; } catch {}
    if (run && !run.stopping && (failed || !this.matches(run) || this.service.clock() >= run.expiresAt || run.joined && !this.service.leases.has(run.viewerId))) {
      const reason = failed ? "sender-failure" : this.service.closed ? "shutdown" : this.service.clock() >= run.expiresAt ? "expired" : !this.matches(run) ? "generation-changed" : "lease-lost";
      void this.stopRun(run, failed ? "error" : this.service.clock() >= run.expiresAt ? "expired" : "stopped", reason).catch(() => {});
    }
  }
  async close() { if (this.run) await this.stopRun(this.run, "stopped", "shutdown"); }
}

module.exports = { SoundSpectrumSrtExperiment, MAX_DURATION_MS, safeMetrics, safeVideoProfile, safeDiagnostics };
