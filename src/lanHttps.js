"use strict";
const fs = require("node:fs"), path = require("node:path"), https = require("node:https");
function privateIPv4(host) {
  if (typeof host !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const p = host.split(".").map(Number);
  return p.every(n => n <= 255) && (p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || host === "127.0.0.1");
}
function start(httpServer, root = path.resolve(__dirname, ".."), log = console) {
  const directory = path.join(root, "data", "lan-https"), configPath = path.join(directory, "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    if (config.enabled !== true) return null;
    if (!privateIPv4(config.host) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || [3777, 3797].includes(config.port)) throw Error("Invalid LAN TLS configuration");
    // Reuse handlers directly: remoteAddress stays the tablet's, not loopback.
    // This preserves local-only API restrictions; no proxy forwards credentials.
    const server = https.createServer({ pfx: fs.readFileSync(path.join(directory, "server.pfx")),
      passphrase: config.passphrase, minVersion: "TLSv1.2" }, (req, res) => httpServer.emit("request", req, res));
    server.on("upgrade", (req, socket, head) => httpServer.emit("upgrade", req, socket, head));
    server.on("error", () => log.warn("[lan-https] Secure LAN listener unavailable; HTTP remains active."));
    server.listen(config.port, config.host, () => log.log("[lan-https] Secure LAN listener ready on port " + config.port));
    return server;
  } catch { log.warn("[lan-https] Could not load local TLS files; HTTP remains active."); return null; }
}
module.exports = { start, privateIPv4 };
