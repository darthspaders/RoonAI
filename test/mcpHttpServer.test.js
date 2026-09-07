"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createRabbitHoleMcpHttpHandler } = require("../src/mcpHttpServer");

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function startHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function startMcpServer(handler) {
  return startHttpServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1")));
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

test("HTTP MCP handler exposes Rabbit Hole tools over JSON-RPC", async (t) => {
  const api = await startHttpServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, {
        connected: true,
        core: { display_name: "Test Core" },
        zones: [
          {
            zone_id: "zone-1",
            display_name: "HQPlayer",
            state: "playing",
            now_playing: {
              two_line: {
                line1: "Test Track",
                line2: "Test Artist"
              },
              three_line: {
                line1: "Test Album"
              },
              image_key: "image-key",
              seek_position: 10,
              length: 300
            }
          }
        ],
        app: {
          session: {
            updatedAt: "2026-09-04T00:00:00.000Z",
            result: {
              tracks: [
                {
                  artist: "Session Artist",
                  title: "Session Track",
                  score: 91
                }
              ],
              alternates: [],
              discarded: []
            }
          },
          standby: {
            count: 1,
            targetCount: 25,
            ready: true,
            refreshing: false
          },
          tidal: {
            connected: true
          },
          llm: {
            reachable: true
          }
        }
      });
    }
    if (req.method === "POST" && url.pathname === "/api/control") {
      return sendJson(res, 200, {
        ok: true,
        result: { accepted: true }
      });
    }
    if (req.method === "POST" && url.pathname === "/api/tracks/verify") {
      return sendJson(res, 200, {
        requestedCount: 1,
        checkedCount: 1,
        usableCount: 1,
        verifiedCount: 1,
        rejectedCount: 0,
        tracks: [
          {
            index: 0,
            usable: true,
            verdict: "verified",
            track: {
              artist: "Verified Artist",
              title: "Verified Track",
              tidalUrl: "https://tidal.com/browse/track/123"
            },
            tidal: { verified: true },
            roon: { checked: false }
          }
        ]
      });
    }
    return sendJson(res, 404, { error: "not found" });
  });
  t.after(() => closeHttpServer(api.server));

  const mcp = await startMcpServer(createRabbitHoleMcpHttpHandler({
    baseUrl: api.url,
    sessionId: "test-session",
    serverVersion: "test"
  }));
  t.after(() => closeHttpServer(mcp.server));

  const init = await postJson(`${mcp.url}/mcp`, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" }
  });
  assert.equal(init.response.status, 200);
  assert.equal(init.response.headers.get("mcp-session-id"), "test-session");
  assert.equal(init.payload.result.protocolVersion, "2025-03-26");
  assert.equal(init.payload.result.serverInfo.name, "rabbit-hole");

  const listed = await postJson(`${mcp.url}/mcp`, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  });
  assert.equal(listed.response.status, 200);
  const toolNames = listed.payload.result.tools.map((tool) => tool.name);
  assert.equal(toolNames.length, 24);
  for (const name of ["roon_queue_tracks", "roon_search_track", "roon_get_queue", "retry_pending_bridge_tracks"]) assert.ok(toolNames.includes(name));
  assert.ok(toolNames.includes("get_rabbit_hole_status"));
  assert.ok(toolNames.includes("search_rabbit_hole"));
  assert.ok(toolNames.includes("verify_tracks"));
  assert.ok(toolNames.includes("control_roon"));
  assert.equal(
    listed.payload.result.tools.find((tool) => tool.name === "get_rabbit_hole_status").annotations.readOnlyHint,
    true
  );

  const status = await postJson(`${mcp.url}/mcp`, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "get_rabbit_hole_status",
      arguments: {}
    }
  });
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.result.structuredContent.connected, true);
  assert.equal(status.payload.result.structuredContent.nowPlaying.title, "Test Track");
  assert.match(status.payload.result.content[0].text, /Test Track/);

  const control = await postJson(`${mcp.url}/mcp`, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "control_roon",
      arguments: { control: "next" }
    }
  });
  assert.equal(control.response.status, 200);
  assert.equal(control.payload.result.structuredContent.control, "next");
  assert.equal(control.payload.result.structuredContent.ok, true);

  const verified = await postJson(`${mcp.url}/mcp`, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "verify_tracks",
      arguments: {
        tracks: [{ artist: "Verified Artist", title: "Verified Track" }]
      }
    }
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.payload.result.structuredContent.usableCount, 1);
  assert.equal(verified.payload.result.structuredContent.tracks[0].verdict, "verified");
});

test("HTTP MCP handler can require a bearer token", async (t) => {
  const mcp = await startMcpServer(createRabbitHoleMcpHttpHandler({
    baseUrl: "http://127.0.0.1:1",
    sessionId: "secure-session",
    token: "secret"
  }));
  t.after(() => closeHttpServer(mcp.server));

  const unauthorized = await fetch(`${mcp.url}/mcp`, { method: "GET" });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${mcp.url}/mcp`, {
    method: "GET",
    headers: {
      authorization: "Bearer secret"
    }
  });
  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.endpoint, "/mcp");
});
