"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { normalizeQuery } = require("./databaseBrowserCatalog");

class DatabaseBrowserService {
  constructor({ dbFile, sonicDbFile = dbFile, enabled = true, timeoutMs = 30_000 }) {
    Object.assign(this, { dbFile, sonicDbFile, enabled, timeoutMs });
    this.worker = null;
    this.pending = new Map();
    this.nextId = 0;
  }
  request(action, query, refresh = false) {
    if (!this.enabled) return Promise.reject(Object.assign(new Error("The music database is unavailable."), { statusCode: 503 }));
    if (this.pending.size >= 16) return Promise.reject(Object.assign(new Error("The database browser is busy. Try again shortly."), { statusCode: 503 }));
    if (!this.worker) {
      const worker = this.worker = new Worker(path.join(__dirname, "databaseBrowserWorker.js"), { workerData: { dbFile: this.dbFile, sonicDbFile: this.sonicDbFile } });
      worker.on("message", ({ id, result, error, statusCode }) => {
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        if (error) request.reject(Object.assign(new Error(error), { statusCode })); else request.resolve(result);
        if (!this.pending.size) worker.unref();
      });
      worker.on("error", error => this.fail(worker, error));
      worker.on("exit", () => this.fail(worker, new Error("The database reader stopped. Please retry.")));
    }
    const worker = this.worker;
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.fail(worker, new Error("The database reader timed out. Please retry."));
        worker.terminate();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, action, query, refresh });
    });
  }
  fail(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Object.assign(error, { statusCode: 503 })); }
    this.pending.clear();
  }
  browse(query = {}) {
    const refresh = query instanceof URLSearchParams ? query.get("refresh") === "true" : query.refresh === true;
    return this.request("browse", normalizeQuery(query), refresh);
  }
  detail(id) { return this.request("detail", { id: Number(id) }); }
  async close() {
    const worker = this.worker;
    if (!worker) return;
    this.fail(worker, new Error("Database browser closed."));
    await worker.terminate();
  }
}

module.exports = { DatabaseBrowserService };
