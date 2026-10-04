"use strict";
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const wslPath = value => String(value).replace(/^([a-z]):[\\/]/i, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");

class SonicAnalysisWorker {
  constructor({ timeoutMs = 540000, idleMs = 45000, device = process.env.SONIC_ANALYSIS_DEVICE || "cuda" } = {}) {
    this.timeoutMs = timeoutMs; this.idleMs = idleMs; this.device = device;
    this.child = null; this.pending = null; this.runtime = ""; this.timer = null; this.stderr = "";
  }
  start(runtime) {
    if (this.child && this.runtime === runtime) return;
    this.stop();
    const launcher = path.join(__dirname, "..", "scripts", "sonic-analysis-wsl.sh");
    const child = process.platform === "win32"
      ? spawn("wsl.exe", ["-d", "Ubuntu", "--", "bash", wslPath(launcher), runtime, this.device], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn("bash", [launcher, runtime, this.device], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.runtime = runtime; this.stderr = "";
    child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.stdin.on("error", error => this.fail(error, child));
    createInterface({ input: child.stdout }).on("line", line => {
      if (line.length > 4 * 1024 * 1024) return this.fail(new Error("Analysis worker output exceeded its bound."), child);
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.ready) { child.linuxPid = message.pid; return; }
      if (this.child !== child || message.id !== this.pending?.id) return;
      const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending.resolve(message.result);
      this.timer = setTimeout(() => this.stop(), this.idleMs); this.timer.unref?.();
    });
    child.on("error", error => this.fail(error, child));
    child.on("exit", code => this.fail(new Error(`Sonic analysis worker exited (${code}). ${this.stderr.slice(-1000)}`), child));
  }
  fail(error, child = this.child) {
    if (child !== this.child) return;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    this.stop();
  }
  run(file, spec) {
    if (this.pending) return Promise.reject(new Error("Sonic analysis concurrency is limited to one."));
    clearTimeout(this.timer); this.start(spec.runtime);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => this.fail(new Error("Sonic analysis timed out.")), this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(JSON.stringify({ id, file: process.platform === "win32" ? wslPath(file) : file, spec }) + "\n");
    });
  }
  stop() {
    clearTimeout(this.timer);
    const child = this.child; this.child = null; this.runtime = "";
    if (!child) return;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error("Analysis stopped; queued work can resume.")); this.pending = null; }
    child.stdin.end();
    if (process.platform === "win32" && Number.isSafeInteger(child.linuxPid)) {
      // No shell interpolation; terminate the exact Python process we started.
      const killer = spawn("wsl.exe", ["-d", "Ubuntu", "--", "kill", "-TERM", String(child.linuxPid)], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {});
    }
    child.kill();
  }
}
module.exports = { SonicAnalysisWorker, wslPath };
