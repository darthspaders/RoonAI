"use strict";

// Explicit, bounded QA only. The app never imports or runs this script.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createSoundSpectrumNative } = require("../../src/soundSpectrumNative");
const { JpegFrames } = require("../../src/soundSpectrum");
const { buildCaptureCommand } = require("../../scripts/soundspectrum-capture.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function main() {
  if (process.platform !== "win32") throw new Error("Native QA requires Windows.");
  const inputId = process.argv[2] || "generator:fluid";
  if (!["generator:fluid", "generator:high-energy", "generator:chill"].includes(inputId)) throw new Error("QA accepts only native no-mic generators.");
  const root = path.resolve(__dirname, "../../data/soundspectrum-darthspader-qa");
  const label = inputId.split(":")[1];
  const output = path.join(root, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${label}`);
  const installed = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SoundSpectrum/G-Force/Packages/RabbitHole.Darthspader.package/_package.py");
  await fs.access(installed);
  const duration = Number(process.argv[3] || 26000);
  if (!Number.isInteger(duration) || duration < 26000 || duration > 120000) throw new Error("QA duration must be 26000-120000 ms.");
  const native = createSoundSpectrumNative({ backupRoot: path.join(root, "native-backups") });
  let capture;
  const preferences = path.join(process.env.APPDATA, "SoundSpectrum/G-Force/Preferences (Standalone).txt");
  const original = await fs.readFile(preferences);
  await fs.mkdir(output, { recursive: true });
  const report = { input: inputId, source: "actual G-Force window through Windows Graphics Capture", effectVerified: false, verificationNote: "Captures require visual inspection of the lettering; animated frames alone are insufficient.", frames: 0, changedFrames: 0, captures: [] };
  let previous = "", started, window;
  const saves = [];
  try {
    const session = await native.start({ visualizer: "g-force", inputId });
    window = session.windowHandle;
    const command = buildCaptureCommand({ windowHandle: window, width: 800, height: 450, fps: 30, quality: 65 });
    report.jpegQuality = command.quality;
    started = Date.now();
    const targets = [...new Set([1000, 11000, 21000, 24000, duration - 4000, duration - 1000])].sort((a, b) => a - b);
    const lateTimes = [];
    let nextSequenceAt = duration - 6000;
    report.sequenceFrames = 0;
    const parser = new JpegFrames(frame => {
      const elapsed = Date.now() - started;
      report.frames++;
      if (elapsed >= duration - 10000) lateTimes.push(elapsed);
      const checksum = hash(frame);
      if (previous && previous !== checksum) report.changedFrames++;
      previous = checksum;
      if (duration >= 35000 && elapsed >= nextSequenceAt && report.sequenceFrames < 60) {
        const filename = `sequence-${String(report.sequenceFrames++).padStart(3, "0")}.jpg`;
        saves.push(fs.writeFile(path.join(output, filename), frame));
        nextSequenceAt = elapsed + 100;
      }
      if (targets.length && elapsed >= targets[0]) {
        const filename = `native-${targets.shift()}.jpg`;
        report.captures.push(filename);
        saves.push(fs.writeFile(path.join(output, filename), frame));
      }
    });
    capture = spawn(command.command, command.args, { env: command.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "";
    capture.stdout.on("data", chunk => parser.push(chunk));
    capture.stderr.on("data", chunk => { if (diagnostics.length < 4000) diagnostics += chunk.toString(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, duration);
      capture.once("error", error => { clearTimeout(timer); reject(error); });
      capture.once("exit", () => { clearTimeout(timer); reject(new Error(`Capture stopped early: ${diagnostics}`)); });
    });
    report.durationMs = Date.now() - started;
    report.captureFps = report.frames * 1000 / report.durationMs;
    report.settledCaptureFps = lateTimes.length > 1 ? (lateTimes.length - 1) * 1000 / (lateTimes.at(-1) - lateTimes[0]) : null;
    if (report.frames < 20 || report.changedFrames < 10) throw new Error("Native frames did not animate.");
  } finally {
    capture?.kill();
    const saved = await Promise.allSettled(saves);
    await native.stop();
    report.preferencesRestored = hash(await fs.readFile(preferences)) === hash(original);
    report.nativeStopped = native.status().state === "stopped";
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, ...report }));
    const failure = saved.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  if (!report.preferencesRestored || !report.nativeStopped) throw new Error("Native cleanup needs inspection.");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
