"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { acquireProcessLock, processIsAlive } = require("../src/processLock");

const root = path.resolve(__dirname, "..");
const mcpRoot = path.resolve(root, "..", "rabbit-hole-mcp");
const pidFile = path.join(root, "data", "service-supervisor.pid");
const logFile = path.join(root, "service-supervisor.log");
const services = new Map();
const restartState = new Map();
const restartTimers = new Set();
let shuttingDown = false;
let supervisorLock;
let stdoutAvailable = true;

// A launcher/terminal closing its output pipe must not take the services down.
process.stdout.on("error", () => { stdoutAvailable = false; });

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
  if (stdoutAvailable) process.stdout.write(line);
}

function serviceOutput(name, stream, chunk) {
  const text = String(chunk);
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${name}/${stream}] ${text}`); } catch {}
  if (stdoutAvailable) process.stdout.write(`[${name}/${stream}] ${text}`);
}

function restartDelay(name) {
  const state = restartState.get(name) || { attempts: 0 };
  state.attempts += 1;
  restartState.set(name, state);
  return Math.min(30_000, 1_000 * (2 ** Math.min(state.attempts - 1, 5)));
}

function spawnService(name, command, args, cwd, env = {}) {
  const existing = services.get(name);
  if (existing && processIsAlive(existing.child.pid)) {
    writeLog(`[${name}] spawn skipped; existing child pid ${existing.child.pid} is still alive.`);
    return existing.child;
  }
  if (existing) services.delete(name);

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const record = { name, child, command, args, cwd, env };
  services.set(name, record);
  child.stdout.on("data", chunk => serviceOutput(name, "stdout", chunk));
  child.stderr.on("data", chunk => serviceOutput(name, "stderr", chunk));
  let settled = false;
  let stableTimer;
  const handleExit = (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(stableTimer);
    if (shuttingDown) return;
    if (services.get(name)?.child !== child) return;
    services.delete(name);
    if (code === 75) {
      writeLog(`[${name}] refused to start because another instance owns its process lock; not restarting.`);
      return;
    }
    const delay = restartDelay(name);
    writeLog(`[${name}] exited with ${signal || code}; restarting this service in ${delay}ms.`);
    // Keep the supervisor alive even when BOTH services have exited.
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      if (shuttingDown || services.has(name)) return;
      spawnService(name, command, args, cwd, env);
    }, delay);
    restartTimers.add(timer);
  };
  child.on("error", error => {
    writeLog(`[${name}] process error: ${error.message}`);
    // A failed spawn emits error/close, but may never emit exit.
    handleExit(null, "spawn-error");
  });
  child.on("exit", handleExit);
  stableTimer = setTimeout(() => {
    if (services.get(name)?.child === child) restartState.delete(name);
  }, 60_000);
  stableTimer.unref();
  writeLog(`[${name}] started with pid ${child.pid}.`);
  return child;
}

function stopChildren() {
  for (const timer of restartTimers) clearTimeout(timer);
  restartTimers.clear();
  for (const { child } of services.values()) {
    if (!child.killed) child.kill();
  }
  services.clear();
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  writeLog("Supervisor shutting down.");
  stopChildren();
  try { supervisorLock?.release(); } catch (_) {}
  try {
    if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(pidFile);
  } catch {}
}

if (!fs.existsSync(path.join(mcpRoot, "package.json"))) {
  console.error(`Missing MCP wrapper repo: ${mcpRoot}`);
  process.exit(1);
}

try {
  supervisorLock = acquireProcessLock(path.join(root, "data", "rabbit-hole.supervisor.lock"), "Rabbit Hole supervisor");
} catch (error) {
  console.error(`[lifecycle] ${error.message}`);
  process.exit(75);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

fs.mkdirSync(path.dirname(pidFile), { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));

writeLog(`Supervisor started with pid ${process.pid}; parent pid ${process.ppid}.`);
spawnService("rabbit-hole", process.execPath, ["src/server.js"], root);
spawnService("rabbit-hole-mcp", process.execPath, ["src/server.js"], mcpRoot);
