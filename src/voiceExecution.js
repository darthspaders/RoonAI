"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");
const storage = new AsyncLocalStorage();
const contexts = new Map();
function current() { return storage.getStore(); }
function check() {
  if (current()?.controller.signal.aborted) throw Object.assign(new Error("Voice request cancelled."), { name: "AbortError" });
}
function create() {
  const ctx = { id: randomUUID(), controller: new AbortController(), actions: [] };
  contexts.set(ctx.id, ctx);
  return ctx;
}
module.exports = { current, check, create, run: (ctx, fn) => storage.run(ctx, fn),
  release: ctx => contexts.delete(ctx.id), fromHeader: id => contexts.get(id) };
