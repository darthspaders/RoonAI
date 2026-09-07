"use strict";

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function parseBrokerId(value = "") {
  const raw = String(value).trim();
  const uuid = /^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})$/.exec(raw);
  if (uuid) {
    const [, a, b, c, d, e] = uuid;
    return Buffer.from(
      `${a.slice(6, 8)}${a.slice(4, 6)}${a.slice(2, 4)}${a.slice(0, 2)}` +
      `${b.slice(2, 4)}${b.slice(0, 2)}` +
      `${c.slice(2, 4)}${c.slice(0, 2)}` +
      d +
      e,
      "hex"
    );
  }
  const hex = raw.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("ROON_INTERNAL_BROKER_ID must be a dashed Core UUID or 16-byte hex broker id.");
  return Buffer.from(hex, "hex");
}

function withTimeout(label, ms, task, onTimeout = () => {}) {
  let timer;
  return Promise.race([
    task,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    })
  ]).finally(() => clearTimeout(timer));
}

class RoonInternalTidalSync {
  constructor(options = {}, logger = console) {
    this.options = {
      enabled: Boolean(options.enabled),
      tidalSyncEnabled: Boolean(options.tidalSyncEnabled),
      packagePath: options.packagePath || "",
      host: options.host || "127.0.0.1",
      port: Number(options.port || 9332),
      brokerId: options.brokerId || "",
      connectTimeoutMs: Number(options.connectTimeoutMs || 10000),
      settleMs: Number(options.settleMs || 2000)
    };
    this.logger = logger;
    this.tail = Promise.resolve();
  }

  isConfigured() {
    return Boolean(this.options.enabled && this.options.tidalSyncEnabled && this.options.packagePath && this.options.brokerId);
  }

  syncLibrary(context = {}) {
    const work = this.tail.catch(() => {}).then(() => this.syncLibraryNow(context));
    this.tail = work.catch(() => {});
    return work;
  }

  async syncLibraryNow(context = {}) {
    const startedAt = Date.now();
    if (!this.isConfigured()) {
      return { attempted: false, success: false, skipped: true, reason: "Roon internal TIDAL sync is not configured." };
    }

    let roon;
    try {
      const internalApi = require(this.options.packagePath);
      const { RoonClient, makeApi } = internalApi;
      roon = new RoonClient({
        host: this.options.host,
        port: this.options.port,
        serverBrokerId: parseBrokerId(this.options.brokerId),
        settleMs: this.options.settleMs
      });

      await withTimeout("Roon internal connect", this.options.connectTimeoutMs, roon.connect(), () => roon.close());
      const tidalOid = roon.serviceOid("Tidal").toString();
      makeApi(roon).tidal.syncLibrary();
      const result = {
        attempted: true,
        success: true,
        host: this.options.host,
        port: this.options.port,
        tidalOid,
        durationMs: Date.now() - startedAt,
        context
      };
      this.logger.info?.("[roon-internal-sync]", JSON.stringify({ ...result, context: scrubContext(context) }));
      return result;
    } catch (error) {
      const result = {
        attempted: true,
        success: false,
        reason: error.message,
        durationMs: Date.now() - startedAt,
        context
      };
      this.logger.warn?.("[roon-internal-sync]", JSON.stringify({ ...result, context: scrubContext(context) }));
      return result;
    } finally {
      try { roon?.close(); } catch (_) {}
    }
  }
}

function scrubContext(context = {}) {
  return {
    reason: context.reason || "",
    trackCount: context.trackCount || 0,
    playlistTitle: context.playlistTitle || ""
  };
}

module.exports = { RoonInternalTidalSync, parseBrokerId, enabled };
