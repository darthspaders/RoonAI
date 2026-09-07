"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const defaultDirectory = path.join(__dirname, "..", "data", "voice");
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
class VoiceDeviceStore {
  constructor(directory = defaultDirectory) { this.file = path.join(directory, "devices.json"); }
  read() { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : []; }
  issue(label) {
    const token = crypto.randomBytes(32).toString("base64url");
    const device = { id: crypto.randomUUID(), label: String(label || "Android tablet").slice(0, 100),
      hash: crypto.createHash("sha256").update(token).digest("hex"), createdAt: new Date().toISOString() };
    atomicWrite(this.file, [...this.read(), device]);
    return { deviceId: device.id, token };
  }
  revoke(id) {
    const devices = this.read();
    const device = devices.find(d => d.id === id);
    if (!device) throw new Error("Unknown device ID.");
    device.revokedAt = new Date().toISOString(); atomicWrite(this.file, devices);
  }
  authenticate(header = "") {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) return null;
    const hash = crypto.createHash("sha256").update(match[1]).digest();
    return this.read().find(d => !d.revokedAt && /^[a-f0-9]{64}$/.test(d.hash) && crypto.timingSafeEqual(Buffer.from(d.hash, "hex"), hash)) || null;
  }
}
module.exports = { VoiceDeviceStore, atomicWrite, defaultDirectory };
