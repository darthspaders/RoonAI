"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

function createStatusDelivery({ files, musicMemory, targetCount = 25, timeoutMs = 15000, ttlMs = 30000,
  workerFactory = options => new Worker(path.join(__dirname, "statusDeliveryWorker.js"), options) } = {}) {
  let worker = null, pending = null, current = null, sequence = 0, closed = false;
  const unavailable = message => Object.assign(Error(message), { statusCode: 503 });
  function rejectPending(error) {
    const request = pending; pending = null;
    if (request) { clearTimeout(request.timer); request.reject(error); }
  }
  function startWorker() {
    if (worker) return worker;
    const owned = workerFactory({ workerData: { statusDelivery: true, files, musicMemory, targetCount, ttlMs },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } });
    worker = owned; owned.unref?.();
    owned.on("message", message => {
      if (worker !== owned || !pending || message?.id !== pending.id) return;
      const request = pending; pending = null; clearTimeout(request.timer);
      if (message.error) { request.reject(unavailable(message.error)); return; }
      if (message.changed) {
        if (![message.full, message.compact, message.session].every(value => value instanceof ArrayBuffer) || typeof message.sessionVersion !== "string") {
          request.reject(unavailable("The status worker returned an invalid snapshot.")); return;
        }
        current = { full: Buffer.from(message.full), compact: Buffer.from(message.compact), session: Buffer.from(message.session),
          snapshotVersion: message.snapshotVersion, sessionVersion: message.sessionVersion, musicMemory: message.musicMemory ?? null };
      }
      if (!current || current.snapshotVersion !== message.snapshotVersion) { request.reject(unavailable("The status cache needs rebuilding.")); return; }
      request.resolve(current);
    });
    owned.on("error", () => {
      if (worker !== owned) return;
      worker = null; rejectPending(unavailable("The saved status worker stopped. Try again.")); void owned.terminate();
    });
    owned.on("exit", () => {
      if (worker !== owned) return;
      worker = null; rejectPending(unavailable("The saved status worker closed. Try again."));
    });
    return owned;
  }
  function read() {
    if (closed) return Promise.reject(unavailable("Status delivery is shutting down."));
    if (pending) return pending.promise;
    let owned;
    try { owned = startWorker(); } catch { return Promise.reject(unavailable("The saved status worker could not start.")); }
    const id = ++sequence;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      if (pending?.id !== id) return;
      worker = null; rejectPending(unavailable("Saved status took too long to read. Try again.")); void owned.terminate();
    }, timeoutMs);
    timer.unref?.(); pending = { id, promise, resolve, reject, timer };
    try { owned.postMessage({ type: "refresh", id }); }
    catch { worker = null; rejectPending(unavailable("The saved status worker could not be reached.")); void owned.terminate(); }
    return promise;
  }
  async function close() {
    closed = true; const owned = worker; worker = null;
    rejectPending(unavailable("Status delivery is shutting down."));
    if (owned) {
      // Close the read-only SQLite handle on its owner thread; bound shutdown
      // if the worker is busy.
      let finish;
      const stopped = new Promise(resolve => { finish = resolve; });
      const onExit = () => finish(true);
      owned.once("exit", onExit);
      const timer = setTimeout(() => finish(false), 1000);
      try { owned.postMessage({ type: "close" }); } catch { finish(false); }
      const exited = await stopped;
      clearTimeout(timer); owned.removeListener("exit", onExit);
      if (!exited) await owned.terminate();
    }
  }
  return { read, close };
}

// The large UTF8 fragment stays preencoded. Only the current playback and
// in-memory service metadata are serialized on the server's video thread.
function statusChunks(playback, app, stored, compact = false) {
  const state = JSON.stringify(playback).slice(1, -1), live = JSON.stringify(app).slice(1, -1);
  const fragment = compact ? stored.compact : stored.full;
  return [Buffer.from(`{${state ? state + "," : ""}"app":{${live}${live && fragment.length ? "," : ""}`), fragment, Buffer.from("}}")];
}

module.exports = { createStatusDelivery, statusChunks };
