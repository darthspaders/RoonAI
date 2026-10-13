"use strict";

// Optional metadata-only companion. It never opens an audio source or controls
// playback. The native package reads this small private file off its render thread.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const HASH = /^[a-f0-9]{64}$/;
const ART_FILE = /^artwork-[a-f0-9]{64}\.(jpg|png)$/;
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const text = (value, limit) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);

function getOwnedTarget(service, instance, visualizer = "g-force") {
  // Deliberately do not call service.status/inspect: that probes capture plugins.
  const captureRecovering = service.state === "starting" && service.captureRecovering === true;
  if (!["g-force", "whitecap"].includes(visualizer) || service.closed || (service.state !== "running" && !captureRecovering) || service.visualizer !== visualizer ||
      service.inputKind !== "music-feed" || !["roon-hqplayer", "lyrion"].includes(service.inputSource) ||
      ![...service.leases.values()].some(until => until > service.clock())) return null;
  const native = service.native.status?.();
  if (!native?.owned || native.state !== "running" || native.visualizer !== visualizer ||
      !Number.isSafeInteger(native.pid) || native.pid <= 0) return null;
  // A video-only reconnect retains the same native metadata authority. Ordinary
  // startup and a replacement renderer must still clear the prior overlay.
  if (captureRecovering && service.captureWindow?.pid !== native.pid) return null;
  const targetId = service.inputSource === "roon-hqplayer" ? service.zoneId : service.playerId;
  if (!targetId) return null;
  const selection = digest(`${service.inputSource}\0${targetId}`).slice(0, 16);
  return { session: `${instance}:${service.generation}:${native.pid}:${selection}`, nativePid: native.pid,
    source: service.inputSource, zoneId: service.zoneId, playerId: service.playerId };
}

async function safeDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  let current = path.resolve(directory);
  while (true) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("Unsafe private metadata directory.");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function renameAtomic(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

class NowPlayingBridge {
  constructor({ getTarget, provider, runtimeRoot = path.join(__dirname, "../../data/soundspectrum-now-playing"),
    readiness = () => require("./install.cjs").getInstallationReadiness(), clock = Date.now, monotonicClock = () => performance.now(),
    intervalMs = 1000, gapMs = 30000, warn = message => console.warn(message) } = {}) {
    this.getTarget = getTarget; this.provider = provider; this.root = path.resolve(runtimeRoot);
    this.stateFile = path.join(this.root, "now-playing.json");
    this.cacheFile = path.join(this.root, "artwork-cache.json"); this.clock = clock;
    this.monotonic = monotonicClock; this.gapMs = gapMs;
    this.warn = warn; this.closed = false; this.enabled = false; this.epoch = 0;
    this.target = null; this.track = null; this.artToken = ""; this.artAttemptAt = -Infinity;
    this.gapAt = null; this.metadataPending = null; this.artPending = null;
    this.controller = null; this.writeSerial = Promise.resolve(); this.warningSent = false;
    this.createdArt = new Map();
    this.ready = Promise.resolve().then(readiness).then(async proof => {
      if (this.closed || !proof?.ready) return false;
      await safeDirectory(this.root);
      await this.loadCache();
      if (this.closed) return false;
      this.enabled = true;
      await this.publish();
      return true;
    }).catch(() => { this.warning(); return false; });
    if (intervalMs) {
      this.timer = setInterval(() => { void this.tick().catch(() => this.warning()); }, intervalMs);
      this.timer.unref?.();
    }
  }
  warning() {
    if (this.warningSent) return;
    this.warningSent = true;
    // Never print track URLs, credentials, paired core addresses or private paths.
    this.warn("[soundspectrum] The optional now-playing add-on could not update; visuals and audio continue.");
  }
  current(epoch = this.epoch, session = this.target?.session) {
    return !this.closed && this.enabled && epoch === this.epoch && !!session &&
      this.target?.session === session && this.getTarget()?.session === session;
  }
  synchronize() {
    const next = this.closed ? null : this.getTarget();
    if ((next?.session || "") === (this.target?.session || "")) return;
    this.controller?.abort(); this.controller = next ? new AbortController() : null;
    this.artController?.abort(); this.artController = null;
    this.epoch++; this.target = next; this.track = null; this.artToken = "";
    this.artAttemptAt = -Infinity; this.gapAt = null;
    // Old requests may finish later. Their epoch and session cannot publish.
    this.metadataPending = null; this.artPending = null;
  }
  state() {
    const active = this.current();
    return { version: 1, updatedAt: this.clock(), active,
      session: active ? this.target.session : "", nativePid: active ? this.target.nativePid : 0,
      track: active ? this.track : null };
  }
  publish() {
    if (!this.enabled) return Promise.resolve();
    const write = this.writeSerial.then(async () => {
      const bytes = JSON.stringify(this.state());
      if (Buffer.byteLength(bytes) > 8192) throw Error("Metadata state exceeds its bound.");
      const temporary = `${this.stateFile}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await renameAtomic(temporary, this.stateFile);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.writeSerial = write.catch(() => { this.warning(); });
    return this.writeSerial;
  }
  async tick() {
    await this.ready;
    if (this.closed || !this.enabled) return;
    this.synchronize();
    // The heartbeat continues even while a bounded metadata/image read is busy.
    await this.publish();
    if (!this.target || this.metadataPending) return;
    const epoch = this.epoch, target = this.target, signal = this.controller.signal;
    const pending = this.readMetadata(epoch, target, signal);
    this.metadataPending = pending;
    try { await pending; }
    catch { if (this.current(epoch, target.session)) this.warning(); }
    finally { if (this.metadataPending === pending) this.metadataPending = null; }
  }
  async readMetadata(epoch, target, signal) {
    let result;
    try { result = await this.provider.readTrack(target, { signal }); }
    catch { result = { state: "waiting", track: null }; }
    if (!this.current(epoch, target.session)) return;
    if (result?.state === "unavailable") {
      this.artController?.abort(); this.artPending = null;
      this.track = null; this.artToken = ""; this.gapAt = null;
      await this.publish(); return;
    }
    if (!result?.track || !HASH.test(result.track.key || "")) {
      this.gapAt ??= this.monotonic();
      if (this.monotonic() - this.gapAt >= this.gapMs) {
        this.artController?.abort(); this.track = null; this.artToken = "";
      }
      await this.publish(); return;
    }
    this.gapAt = null;
    const incoming = result.track;
    if (incoming.key !== this.track?.key) {
      this.artController?.abort();
      // Clear the previous album immediately; never show it on a different song.
      this.track = { key: incoming.key, title: text(incoming.title, 240),
        artist: text(incoming.artist, 180), album: text(incoming.album, 180), artwork: null };
      this.artToken = ""; this.artAttemptAt = -Infinity; this.artPending = null;
    }
    // Metadata enrichment on the same recording does not replay its title fade.
    this.track.title = text(incoming.title, 240); this.track.artist = text(incoming.artist, 180);
    this.track.album = text(incoming.album, 180);
    const token = typeof incoming.artToken === "string" ? incoming.artToken : "";
    if (token !== this.artToken) {
      this.artController?.abort();
      this.artToken = token; this.track.artwork = null; this.artAttemptAt = -Infinity;
      this.artPending = null;
    }
    await this.publish();
    if (!this.current(epoch, target.session) || this.track?.key !== incoming.key || this.artToken !== token) return;
    if (token && !this.track.artwork && !this.artPending && this.monotonic() - this.artAttemptAt >= 5000) {
      this.artAttemptAt = this.monotonic();
      const control = new AbortController(); this.artController = control;
      const cancel = () => control.abort(signal.reason);
      if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
      const pending = this.readArtwork(incoming, epoch, target, control.signal);
      this.artPending = pending;
      void pending.catch(() => {}).finally(() => {
        signal.removeEventListener("abort", cancel);
        if (this.artPending === pending) this.artPending = null;
        if (this.artController === control) this.artController = null;
      });
    }
  }
  async readArtwork(incoming, epoch, target, signal) {
    const isCurrent = () => this.current(epoch, target.session) && this.track?.key === incoming.key && this.artToken === incoming.artToken;
    const image = await this.provider.readArt(incoming, { signal });
    if (!isCurrent() || !image) return;
    if (!Buffer.isBuffer(image.data) || image.data.length > 2 * 1024 * 1024 || image.data.length < 16 ||
        !["jpg", "png"].includes(image.extension) || ![image.width, image.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) return;
    const hash = digest(image.data), filename = `artwork-${hash}.${image.extension}`;
    const file = path.join(this.root, filename);
    try { await fs.writeFile(file, image.data, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== image.data.length || digest(await fs.readFile(file)) !== hash) return;
    }
    this.createdArt.set(filename, this.clock());
    if (!isCurrent()) return;
    this.track.artwork = { file: filename, width: image.width, height: image.height };
    await this.publish();
    await this.pruneArtwork();
  }
  async pruneArtwork() {
    // Keep a minute for a native asynchronous image read, and at most 12 recently
    // used assets. Remove only files this process created/verified by content hash.
    const entries = [...this.createdArt.entries()];
    for (const [filename, at] of entries.slice(0, Math.max(0, entries.length - 12))) {
      if (filename === this.track?.artwork?.file || this.clock() - at < 60000 || !ART_FILE.test(filename)) continue;
      const file = path.join(this.root, filename);
      const stat = await fs.lstat(file).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024 &&
          digest(await fs.readFile(file)) === filename.slice(8, 72)) await fs.unlink(file);
      this.createdArt.delete(filename);
    }
    await this.saveCache();
  }
  async loadCache() {
    const stat = await fs.lstat(this.cacheFile).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 16384) return;
    let rows;
    try { rows = JSON.parse(await fs.readFile(this.cacheFile, "utf8")); } catch { return; }
    if (!Array.isArray(rows) || rows.length > 128) return;
    for (const row of rows) {
      if (Array.isArray(row) && ART_FILE.test(row[0]) && Number.isSafeInteger(row[1]) && row[1] >= 0 && row[1] <= this.clock()) {
        this.createdArt.set(row[0], row[1]);
      }
    }
  }
  async saveCache() {
    const temporary = `${this.cacheFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify([...this.createdArt.entries()].slice(-128)), { flag: "wx", mode: 0o600 });
      await renameAtomic(temporary, this.cacheFile);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  invalidate() {
    if (!this.enabled || this.closed) return;
    this.synchronize();
    void this.publish();
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.unsubscribe?.();
    this.controller?.abort(); this.artController?.abort(); this.epoch++; this.target = null; this.track = null;
    this.provider.close?.();
    await this.ready;
    await this.publish();
  }
}

function attachNowPlaying({ service, getRoonState, getRoonCore, lyrionClient, artBridge, visualizer = "g-force", ...options }) {
  const instance = crypto.randomUUID();
  const provider = require("./provider.cjs").createNowPlayingProvider({ getRoonState, getRoonCore, lyrionClient, artBridge });
  const bridge = new NowPlayingBridge({ ...options, provider, getTarget: () => getOwnedTarget(service, instance, visualizer) });
  bridge.unsubscribe = service.onVideo(event => { if (event.type === "state") bridge.invalidate(); });
  return bridge;
}

module.exports = { NowPlayingBridge, attachNowPlaying, getOwnedTarget };
