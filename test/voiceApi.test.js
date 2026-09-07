"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createVoiceApi, intent } = require("../src/voiceApi");
const { VoiceDeviceStore } = require("../src/voiceDeviceStore");
const execution = require("../src/voiceExecution");
const { createRabbitHoleMcpTools } = require("../src/mcpHttpServer");

async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-voice-"));
  const store = new VoiceDeviceStore(directory); const owner = store.issue("tablet"), other = store.issue("other");
  let calls = []; let routed = [];
  const tools = Object.fromEntries(["control_roon", "get_rabbit_hole_status", "rate_now_playing", "queue_standby_tracks", "queue_rabbit_hole_tracks", "refresh_standby_pool"].map(name => [name, { handler: async input => { calls.push({ name, input }); return { ok: true, queuedCount: 5, connected: true, nowPlaying: { artist: "Fluke", title: "Bullet" }, count: 19, ...overrides.toolResult }; } }]));
  const router = { respond: overrides.respond || (async input => { routed.push(input); return { text: "Found music.", provider: "SYNAPSE", model: "luna", status: { apiKey: "NEVER-RETURN-ME" } }; }) };
  const make = () => createVoiceApi({ tools, router, directory });
  let handler = make();
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  async function request(route, body, token = owner.token) {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/voice/${route}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { code: r.status, body: await r.json() };
  }
  async function finish(id) {
    for (let i = 0; i < 100; i++) { const r = await request(`jobs/${id}`); if (["completed", "failed", "cancelled"].includes(r.body.status)) return r.body; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("Job did not finish.");
  }
  return { request, finish, calls, routed, owner, other, directory, store, restart: () => { handler = make(); } };
}
test("fast intent grammar stays narrow and preserves discovery intent", () => {
  assert.deepEqual(intent("Hey Synapse, queue the next ten standby tracks."), { kind: "queue", count: 10 });
  assert.deepEqual(intent("q ten stand by tracks"), { kind: "queue", count: 10 });
  assert.equal(intent("find me ten fresh progressive house tracks over seven minutes").kind, "complex");
  assert.equal(intent("play music").control, "play");
  assert.equal(intent("love this track").rating, "love");
  assert.equal(intent("refresh standby").kind, "refresh");
  assert.equal(intent("pause and find me music").kind, "complex");
});
test("authentication, revocation, hashes and status sanitization", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("status", undefined, "wrong")).code, 401);
  const status = await f.request("status"); assert.equal(status.body.roon, true); assert.equal(status.body.nowPlaying, undefined);
  assert.ok(!fs.readFileSync(path.join(f.directory, "devices.json"), "utf8").includes(f.owner.token));
  f.store.revoke(f.owner.deviceId); assert.equal((await f.request("status")).code, 401);
});
test("duplicate POST and server reload never replay playback; devices cannot read others' jobs", async t => {
  const f = await fixture(t); const input = { text: "skip this track", requestId: randomUUID() };
  await Promise.all([f.request("command", input), f.request("command", input)]);
  const done = await f.finish(input.requestId); assert.equal(done.spokenResponse, "Skipped."); assert.equal(done.provider, "LOCAL");
  assert.equal(f.calls.filter(c => c.name === "control_roon").length, 1);
  assert.equal((await f.request(`jobs/${input.requestId}`, undefined, f.other.token)).code, 404);
  assert.equal((await f.request("command", { ...input, text: "pause" })).code, 409);
  f.restart(); assert.equal((await f.request("command", input)).body.status, "completed"); assert.equal(f.calls.length, 1);
});
test("complex discovery passes untouched to AUTO and never returns router status/secrets", async t => {
  const f = await fixture(t); const text = "Find 10 fresh progressive house tracks over 7 minutes"; const requestId = randomUUID();
  await f.request("command", { text, requestId, provider: "SYNAPSE", model: "client-must-not-pick" });
  const done = await f.finish(requestId);
  assert.deepEqual(f.routed, [{ message: text, mode: "auto" }]);
  assert.equal(done.model, "luna"); assert.ok(!JSON.stringify(done).includes("NEVER-RETURN-ME"));
});
test("unfinished durable jobs become interrupted on restart and are never replayed", async t => {
  const f = await fixture(t); const id = randomUUID();
  fs.writeFileSync(path.join(f.directory, "jobs.json"), JSON.stringify([{ id, requestId: id, deviceId: f.owner.deviceId, text: "skip", status: "running" }]));
  f.restart();
  assert.equal((await f.request(`jobs/${id}`)).body.status, "interrupted");
  assert.equal((await f.request("command", { text: "skip", requestId: id })).body.status, "interrupted");
  assert.equal(f.calls.length, 0);
});
test("partial queue results are reported honestly", async t => {
  const f = await fixture(t, { toolResult: { queuedCount: 3, failedCount: 2 } }); const requestId = randomUUID();
  await f.request("command", { text: "queue five standby tracks", requestId });
  const done = await f.finish(requestId); assert.equal(done.success, false); assert.match(done.spokenResponse, /Queued 3 tracks.*2 could not/);
});
test("cancel aborts context and blocks later discovery commit; cross-device cancel fails", async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; }); let resume;
  const gate = new Promise(resolve => { resume = resolve; }); let committed = false;
  const f = await fixture(t, { respond: async () => { entered(); await gate; execution.check(); committed = true; return { text: "Done" }; } });
  const requestId = randomUUID(); await f.request("command", { text: "find new music", requestId }); await ready;
  await f.request("cancel", { requestId }, f.other.token); assert.equal((await f.request(`jobs/${requestId}`)).body.status, "running");
  assert.equal((await f.request("cancel", { requestId })).body.status, "cancelled"); resume();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(committed, false); assert.equal((await f.finish(requestId)).status, "cancelled");
});
test("request size/text validation and unknown endpoint", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("command", { text: "pause" })).code, 400);
  assert.equal((await f.request("command", { text: "x".repeat(9000), requestId: randomUUID() })).code, 413);
  assert.equal((await f.request("unknown", {})).code, 404);
});
test("MCP bridge propagates cancellation context and records actual tool outcome", async t => {
  const ctx = execution.create(); let forwarded;
  const server = http.createServer((req, res) => {
    forwarded = execution.fromHeader(req.headers["x-rabbit-hole-voice-execution"]);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ connected: true, zones: [] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); execution.release(ctx); });
  const tools = createRabbitHoleMcpTools({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  await execution.run(ctx, () => tools.get_rabbit_hole_status.handler({}));
  assert.equal(forwarded, ctx); assert.equal(ctx.actions[0].success, true);
  ctx.controller.abort(); await assert.rejects(execution.run(ctx, () => tools.control_roon.handler({ control: "next" })), /cancelled/);
});
