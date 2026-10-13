"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateDelayMs, MAX_DELAY_MS } = require("./soundSpectrumPcmDelay");

const SETTINGS_PATH = path.join(__dirname, "../data/soundspectrum/visual-delay.json");
const VISUALIZERS = Object.freeze(["aeon", "g-force", "whitecap"]);
const problem = (message, statusCode) => Object.assign(Error(message), { statusCode });

async function persistSettings(file, delayMs) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify({ version: 1, delayMs }) + "\n", { flag: "wx", mode: 0o600 });
    await fsp.rename(temporary, file);
  } finally {
    await fsp.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

// One setting for every renderer and both PCM music feeds. Construction only
// reads a small local file; no device, renderer, model or stream is started.
class SoundSpectrumDelay {
  constructor({ settingsPath = SETTINGS_PATH, readFile = fs.readFileSync, persist = persistSettings, apply = () => {}, available = true } = {}) {
    this.settingsPath = settingsPath; this.persist = persist; this.apply = apply;
    this.available = available; this.currentMs = 0; this.savedMs = 0;
    this.revision = 0; this.instanceId = randomUUID(); this.settingsError = ""; this.serial = Promise.resolve();
    try {
      const bytes = readFile(settingsPath, "utf8");
      if (Buffer.byteLength(bytes) > 1024) throw Error("Oversized settings");
      const value = JSON.parse(bytes);
      if (value?.version !== 1) throw Error("Invalid settings version");
      this.savedMs = this.currentMs = validateDelayMs(value.delayMs);
    } catch (error) {
      if (error.code !== "ENOENT") this.settingsError = "Saved visual delay could not be read. Reset and Save to replace it.";
    }
  }
  snapshot() {
    return { currentMs: this.currentMs, savedMs: this.savedMs, revision: this.revision, instanceId: this.instanceId,
      minMs: 0, maxMs: MAX_DELAY_MS, stepMs: 1, available: this.available,
      scope: "all-soundspectrum-music-feeds", supportedVisualizers: [...VISUALIZERS],
      ...(this.settingsError ? { settingsError: this.settingsError } : {}) };
  }
  bind(apply, available = true) {
    this.apply = apply; this.available = available;
    if (available) apply(this.currentMs);
    return this;
  }
  update(body = {}) {
    const operation = this.serial.then(() => this.performUpdate(body));
    this.serial = operation.catch(() => {});
    return operation;
  }
  async performUpdate(body) {
    if (!body || typeof body !== "object" || Array.isArray(body) || !["preview", "save"].includes(body.action)) {
      throw problem("Choose preview or save for visual delay.", 400);
    }
    if (!this.available) throw problem("The shared SoundSpectrum music feed is unavailable.", 503);
    let next;
    try { next = validateDelayMs(body.delayMs); }
    catch { throw problem("Visual delay must be a whole number from 0 to 5000 ms.", 400); }
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw problem("Refresh visual delay before changing it.", 400);
    }
    if (body.expectedInstanceId !== undefined && body.expectedInstanceId !== this.instanceId) {
      throw problem("Rabbit Hole reloaded. Review the current visual delay and try again.", 409);
    }
    if (body.expectedRevision !== this.revision) throw problem("Visual delay changed in another view. Review the current value and try again.", 409);
    if (next !== this.currentMs) {
      this.apply(next);
      this.currentMs = next; this.revision++;
    }
    if (body.action === "save") {
      // Serialize apply + persistence so another view cannot replace the value
      // being saved. An I/O failure retains the acknowledged live preview and
      // previous durable value, both included in the HTTP error snapshot.
      try { await this.persist(this.settingsPath, next); }
      catch { throw problem("Visual delay is applied but could not be saved. Try Save again.", 500); }
      if (this.savedMs !== next || this.settingsError) this.revision++;
      this.savedMs = next; this.settingsError = "";
    }
    return this.snapshot();
  }
}

module.exports = { SoundSpectrumDelay, SETTINGS_PATH, VISUALIZERS, persistSettings };
