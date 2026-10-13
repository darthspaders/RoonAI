"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRabbitHoleMcpTools } = require("../src/mcpHttpServer");

test("main MCP supplied queue declares and forwards next, verification and bridge flags", async () => {
  const calls = [];
  const tools = createRabbitHoleMcpTools({ fetchImpl: async (url, options) => {
    calls.push({ url, body: options.body && JSON.parse(options.body) });
    const result = url.endsWith("/api/status") ? { zones: [{ zone_id: "fixture-zone", state: "paused" }] }
      : { mode: "next", requested: 1, resolvedCount: 0, queued: 0, failed: 1 };
    return { ok: true, text: async () => JSON.stringify(result) };
  } });
  const tool = tools.queue_supplied_tracks;
  assert.deepEqual(tool.inputSchema.properties.mode.enum, ["append", "next"]);
  assert.equal(tool.inputSchema.properties.allowBridge.type, "boolean");
  assert.equal(tool.inputSchema.properties.preferExtendedMixes.type, "boolean");
  const input = { tracks: [{ artist: "Budakid", title: "Lovin' Sun (Guy J Remix)" }],
    mode: "next", queuePolicy: "strict", verifyBeforeQueue: true, allowBridge: true, preferExtendedMixes: true };
  const result = await tool.handler(input);
  assert.equal(result.mode, "next");
  assert.deepEqual(calls[1].body, { ...input, zoneId: "fixture-zone" });
  assert.ok(calls[1].url.endsWith("/api/tracks/supplied/queue"));
});
