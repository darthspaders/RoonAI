"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { RoonClient } = require("../src/roonClient");

test("Play from here dispatches the cached Roon queue item ID", async () => {
  const client = new RoonClient();
  const calls = [];
  client.transport = {
    play_from_here(target, queueItemId, callback) {
      calls.push({ target, queueItemId });
      callback({ name: "Success" }, null);
    }
  };
  client.zones.set("zone-1", {
    zone_id: "zone-1",
    outputs: [{ output_id: "output-1" }]
  });
  client.queues.set("zone-1", {
    items: [{ id: 42, title: "Queued track" }]
  });

  const result = await client.playFromHere("zone-1", "42");

  assert.equal(result, null);
  assert.deepEqual(calls, [{
    target: { output_id: "output-1" },
    queueItemId: 42
  }]);
});

test("Play from here refuses a stale queue item without calling Roon", async () => {
  const client = new RoonClient();
  let called = false;
  client.transport = {
    play_from_here() {
      called = true;
    }
  };
  client.zones.set("zone-1", { zone_id: "zone-1", outputs: [] });
  client.queues.set("zone-1", { items: [{ id: 7, title: "Current queue" }] });

  await assert.rejects(
    client.playFromHere("zone-1", "99"),
    /no longer in the live Roon queue/i
  );
  assert.equal(called, false);
});

test("queue surface exposes touch and keyboard queue actions", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

  assert.match(html, /Tap or hold a track for queue actions/);
  assert.match(html, /data-queue-action="play-from-here"/);
  assert.match(html, /data-queue-action="remove"[^>]+disabled/);
  assert.match(app, /data-queue-item-id/);
  assert.match(app, /function openQueueActionMenu\(/);
  assert.match(app, /pointerdown/);
  assert.match(app, /\/api\/roon\/queue-control/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /\.queueActionMenu\s*\{/);
  assert.match(css, /\.queueItemButton\s*\{/);
});
