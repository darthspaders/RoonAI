"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mcpRoot = path.resolve(root, "..", "rabbit-hole-mcp");
const children = [];
let shuttingDown = false;

function spawnService(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.push({ name, child });
  child.stdout.on("data", chunk => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${name}] exited with ${signal || code}; stopping Rabbit Hole services.`);
    stopChildren();
    process.exit(typeof code === "number" ? code : 1);
  });
  return child;
}

function stopChildren() {
  for (const { child } of children) {
    if (!child.killed) child.kill();
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChildren();
}

if (!fs.existsSync(path.join(mcpRoot, "package.json"))) {
  console.error(`Missing MCP wrapper repo: ${mcpRoot}`);
  process.exit(1);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

spawnService("rabbit-hole", "node", ["src/server.js"], root);
spawnService("rabbit-hole-mcp", "node", ["src/server.js"], mcpRoot);
