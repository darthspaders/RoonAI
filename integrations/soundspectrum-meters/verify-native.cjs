"use strict";

// Explicit generator-only QA. Never imported by the app or installer.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createSoundSpectrumNative } = require("../../src/soundSpectrumNative");
const { JpegFrames } = require("../../src/soundSpectrum");
const { buildCaptureCommand } = require("../../scripts/soundspectrum-capture.cjs");
const run = promisify(execFile);
const NAMES = ["Rabbit Hole - Emerald VU", "Rabbit Hole - Twin Cyan VU", "Rabbit Hole - Prism Spectrum"];
const CAPTURE = Object.freeze({ width: 960, height: 540, fps: 20, quality: 85 });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function qaWindow(mode = "720p") {
  if (mode === "720p") return { width: 1280, height: 720 };
  if (mode === "4k") return { width: 3840, height: 2160, uniqueCaptureTitle: true, windowMode: "borderless-fullscreen" };
  throw new Error("Choose 720p or 4k for explicit native QA.");
}

function patchTheme(bytes, name) {
  const text = bytes.toString("utf8");
  if (/["\r\n\0]/.test(name)) throw new Error("Invalid QA theme name.");
  if ((text.match(/^Theme\.StartupTheme[^\r\n]*$/gm) || []).length !== 1) throw new Error("Expected exactly one startup theme preference.");
  return Buffer.from(text.replace(/^Theme\.StartupTheme[^\r\n]*/m, `Theme.StartupTheme = "${name}"`));
}

function category(name, config) {
  if ([name, config].some(value => /["\r\n\0]/.test(value))) throw new Error("Invalid QA name.");
  return `CategoryTitle = "${name}"\nCategoryFlags = 0\nVersion = 1\nInclude.Pattern = ""\nExclude.Pattern = ""\nInclude.List = "\n${config}\n"\nExclude.List = "\n"\n`;
}

function patchQaPreferences(bytes, name, diagnosticLineScale = false) {
  if (![false, true, .35, .5].includes(diagnosticLineScale)) throw new Error("Unsupported temporary diagnostic line scale.");
  let text = patchTheme(bytes, name).toString("utf8");
  const settings = { "WaveShape.Transition.Duration": 0, "FlowField.Transition.Duration": 0,
    "WaveShape.ConfigPrepTime": 0, "FlowField.ConfigPrepTime": 0 };
  if (diagnosticLineScale) Object.assign(settings, { "WaveShape.AutoLineScale": 0,
    "WaveShape.LineWidth.Scale": diagnosticLineScale === true ? 1 : diagnosticLineScale, "WaveShape.LineWidth.Offset": 0 });
  for (const [key, value] of Object.entries(settings)) {
    const expression = new RegExp("^" + key.replaceAll(".", "\\.") + "[^\\r\\n]*", "m");
    if (!expression.test(text)) throw new Error(`Missing expected QA preference: ${key}`);
    text = text.replace(expression, `${key} = ${value}`);
  }
  return Buffer.from(text);
}

async function assertClosed(runner = run) {
  const { stdout } = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name 'G-Force Standalone','G-Force Standalone.x64','G-Force Toolbar' -ErrorAction SilentlyContinue).Count"], { windowsHide: true });
  if (stdout.trim() !== "0") throw new Error("Close G-Force Standalone and Toolbar before generator-only QA. Existing windows were left intact.");
}

async function stopCapture(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned capture child did not exit within three seconds.")), 3000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function verify(name, duration = 18000, inputId = "generator:high-energy", diagnosticLineScale = false, windowMode = "720p") {
  if (process.platform !== "win32") throw new Error("Native QA requires Windows.");
  if (!NAMES.includes(name)) throw new Error("Choose one of the three exact meter presets.");
  if (!["generator:fluid", "generator:high-energy", "generator:chill"].includes(inputId)) throw new Error("Only no-mic generators are allowed in QA.");
  if (!Number.isInteger(duration) || duration < 18000 || duration > 60000) throw new Error("QA duration must be 18000-60000 ms.");
  const window = qaWindow(windowMode);
  await assertClosed();
  const installRoot = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SoundSpectrum/G-Force");
  await fs.access(path.join(installRoot, "Packages/RabbitHole.Meters.package/WaveShapes", `${name}.txt`));
  const profile = path.join(process.env.APPDATA, "SoundSpectrum/G-Force");
  const preferences = path.join(profile, "Preferences (Standalone).txt");
  const original = await fs.readFile(preferences);
  const token = `Rabbit Hole meter QA ${crypto.randomUUID()}`;
  const patched = patchQaPreferences(original, token, diagnosticLineScale);
  const root = path.resolve(__dirname, "../../data/soundspectrum-meters-qa");
  const output = path.join(root, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${name.split(" - ")[1].replaceAll(" ", "-")}`);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "original.preferences.backup"), original, { flag: "wx" });
  const files = [
    [path.join(profile, "Categories/WaveShape", `${token}.txt`), category(token, name)],
    [path.join(profile, "Categories/ColorMap", `${token}.txt`), category(token, name)],
    [path.join(profile, "Categories/FlowField", `${token}.txt`), category(token, "Rabbit Hole - darthspader")],
    [path.join(profile, "Themes", `${token}.txt`), `ThemeName = "${token}"\nVersion = 1\nLocked = 0\nWaveShape.CategoryExpr = "+${token}"\nColorMap.CategoryExpr = "+${token}"\nFlowField.CategoryExpr = "+${token}"\n"FlowField Union.CategoryExpr" = "-(All)"\nParticle.CategoryExpr = "-(All)"\nSprite.CategoryExpr = "-(All)"\n`]
  ];
  const native = createSoundSpectrumNative({ backupRoot: path.join(root, "native-backups") });
  const created = [], saves = [];
  const report = { name, inputId, diagnosticLineScale, requestedWindow: window, temporaryFastTransitions: true, source: "actual G-Force window via Windows Graphics Capture", captureResolution: `${CAPTURE.width}x${CAPTURE.height}`, jpegQuality: CAPTURE.quality,
    nativeEffectVerified: false, verificationNote: "Inspect captures for the intended meter and absence of config errors; frame motion alone is insufficient.", frames: 0, changedFrames: 0, captures: [] };
  let capture, didPatch = false, previous = "", primaryError;
  try {
    for (const [filename, content] of files) {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, content, { flag: "wx" });
      created.push([filename, Buffer.from(content)]);
    }
    await assertClosed();
    if (sha(await fs.readFile(preferences)) !== sha(original)) throw new Error("Preferences changed while QA was preparing; preserved current settings.");
    await fs.writeFile(preferences, patched);
    didPatch = true;
    const session = await native.start({ visualizer: "g-force", inputId, ...window });
    report.nativeResolution = `${session.width}x${session.height}`;
    const command = buildCaptureCommand({ windowHandle: session.windowHandle, ...CAPTURE });
    const start = Date.now(), targets = [4000, 8000, 12000, duration - 1000];
    const parser = new JpegFrames(frame => {
      report.frames++;
      const checksum = sha(frame);
      if (previous && previous !== checksum) report.changedFrames++;
      previous = checksum;
      const elapsed = Date.now() - start;
      if (targets.length && elapsed >= targets[0]) {
        const filename = `native-${targets.shift()}.jpg`;
        report.captures.push(filename);
        saves.push(fs.writeFile(path.join(output, filename), frame));
      }
    });
    capture = spawn(command.command, command.args, { env: command.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    capture.stdout.on("data", chunk => parser.push(chunk));
    let diagnostics = "";
    capture.stderr.on("data", chunk => { if (diagnostics.length < 4000) diagnostics += chunk.toString(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, duration);
      capture.once("error", error => { clearTimeout(timer); reject(error); });
      capture.once("exit", () => { clearTimeout(timer); reject(new Error(`Capture exited early: ${diagnostics}`)); });
    });
    report.durationMs = Date.now() - start;
    report.captureFps = report.frames * 1000 / report.durationMs;
    if (report.frames < 20 || report.changedFrames < 10) throw new Error("Native output did not animate.");
  } catch (error) {
    primaryError = error;
    report.error = error.message;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { await stopCapture(capture); } catch (error) { cleanupErrors.push(error); }
    const saved = await Promise.allSettled(saves);
    try { await native.stop(); } catch (error) { cleanupErrors.push(error); }
    let closed = false;
    try { await assertClosed(); closed = true; } catch (error) { cleanupErrors.push(error); }
    if (closed) {
      if (didPatch) try {
        if (sha(await fs.readFile(preferences)) !== sha(patched)) throw new Error(`QA preference restore conflict. Original backup: ${output}`);
        await fs.writeFile(preferences, original);
      } catch (error) { cleanupErrors.push(error); }
      for (const [filename, bytes] of created.reverse()) try {
        if (sha(await fs.readFile(filename)) !== sha(bytes)) throw new Error(`QA file changed; preserved ${filename}`);
        await fs.unlink(filename);
      } catch (error) { cleanupErrors.push(error); }
    } else {
      report.preservedTemporaryFiles = created.map(([filename]) => filename);
    }
    try { report.preferencesRestored = sha(await fs.readFile(preferences)) === sha(original); }
    catch (error) { report.preferencesRestored = false; cleanupErrors.push(error); }
    report.nativeStopped = closed && native.status().state === "stopped";
    const failure = saved.find(result => result.status === "rejected");
    if (failure) cleanupErrors.push(failure.reason);
    report.cleanupErrors = cleanupErrors.map(error => error.message);
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, ...report }));
    if (cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors],
      `Native QA cleanup needs inspection: ${cleanupErrors.map(error => error.message).join(" ")} Report: ${output}`);
  }
  return { output, ...report };
}

if (require.main === module) verify(process.argv[2], Number(process.argv[3] || 18000), process.argv[4] || "generator:high-energy", process.argv[5] === "fixed-line-scale", process.argv[6] || "720p")
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { NAMES, CAPTURE, patchTheme, patchQaPreferences, qaWindow, category, assertClosed, verify };
