"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PRODUCTS = Object.freeze([
  { id: "aeon", name: "Aeon", folder: "Aeon", executable: "Aeon Standalone.x64.exe" },
  { id: "g-force", name: "G-Force", folder: "G-Force", executable: "G-Force Standalone.x64.exe" },
  { id: "whitecap", name: "WhiteCap", folder: "WhiteCap", executable: "WhiteCap Standalone.x64.exe" }
]);
// Exact built-in device names exposed by all three installed SoundSpectrum engines.
// These generators simulate visualization input inside SoundSpectrum; they never
// route generated sound to a speaker or select a Windows recording device.
const NO_MIC_INPUTS = Object.freeze([
  Object.freeze({ id: "generator:fluid", name: "Sound Generator (Fluid)", kind: "no-mic" }),
  Object.freeze({ id: "generator:high-energy", name: "Sound Generator (High Energy)", kind: "no-mic" }),
  Object.freeze({ id: "generator:chill", name: "Sound Generator (Chill)", kind: "no-mic" })
]);
const noMicInputs = () => Object.fromEntries(PRODUCTS.map(product => [product.id, NO_MIC_INPUTS.map(input => ({ ...input }))]));
const PHYSICAL_MICROPHONE = /\b(?:microphone|mikrofon|mic|headset|umik-[12]|umm-\d)\b/i;
const VIRTUAL_INPUT = /voicemeeter|vb[ -]?audio|virtual|cable|stereo\s*mix|what.+hear|loopback|streaming|sound.?spectrum|nvidia\s*broadcast|steelseries\s*sonar|krisp|\bobs\b/i;
const MUSIC_FEED_INPUT_IDS = new Set(["feed:pre-hqplayer", "feed:hqplayer-analysis"]);

function microphoneInputs(inputs = []) {
  return inputs.filter(input => input && /^[a-f0-9-]{36}$/i.test(input.id || "") &&
    (input.formFactor === 4 || PHYSICAL_MICROPHONE.test(`${input.name || ""} ${input.interfaceName || ""}`)) && !VIRTUAL_INPUT.test(`${input.name || ""} ${input.interfaceName || ""}`))
    .map(input => ({ id: input.id, name: input.name }));
}

function patchStandalonePreferences(original, inputName, visualizer) {
  if (typeof inputName !== "string" || !inputName.trim() || /[\r\n\0]/.test(inputName)) throw new Error("An exact SoundSpectrum input name is required.");
  let encoding = "utf8", offset = 0;
  if (original[0] === 0xff && original[1] === 0xfe) { encoding = "utf16le"; offset = 2; }
  else if (original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf) offset = 3;
  else if (original[0] === 0xfe && original[1] === 0xff) throw new Error("Unsupported SoundSpectrum preference encoding.");
  if (encoding === "utf8") new TextDecoder("utf-8", { fatal: true }).decode(original.subarray(offset));
  let text = original.subarray(offset).toString(encoding);
  if (!/^\s*Prefs\.Version\s*=\s*\d+\s*$/m.test(text)) throw new Error("Run SoundSpectrum Standalone once to initialize its preferences before connecting it.");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const values = {
    "Audio.InputSource": JSON.stringify(inputName),
    "Audio.AutoDetect.Enabled": "0"
  };
  if (visualizer === "g-force") values["G-Force.AutoOpenToolbar"] = "0";
  for (const [key, value] of Object.entries(values)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(`^[ \\t]*${escaped}[ \\t]*=[^\\r\\n]*`, "gm");
    let replaced = false;
    text = text.replace(expression, () => { replaced = true; return `${key} = ${value}`; });
    if (!replaced) text += `${text.endsWith("\n") ? "" : newline}${key} = ${value}${newline}`;
  }
  return Buffer.concat([original.subarray(0, offset), Buffer.from(text, encoding)]);
}

function createSoundSpectrumNative(options = {}) {
  const platform = options.platform || process.platform;
  const installRoot = options.installRoot || path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SoundSpectrum");
  let preferencesRoot = options.preferencesRoot || null;
  if (preferencesRoot && !path.isAbsolute(preferencesRoot)) throw new Error("SoundSpectrum preferencesRoot must be an absolute desktop profile path.");
  const backupRoot = options.backupRoot || path.join(__dirname, "..", "data", "soundspectrum-native");
  const helperPath = options.helperPath || path.join(__dirname, "..", "scripts", "soundspectrum-window.ps1");
  const spawnImpl = options.spawnImpl || spawn;
  const additionalInputProvider = options.additionalInputProvider || null;
  if (additionalInputProvider && (typeof additionalInputProvider.list !== "function" || typeof additionalInputProvider.resolve !== "function")) throw new Error("A canonical SoundSpectrum music input provider is required.");
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const windowTimeoutMs = options.windowTimeoutMs || 12000;
  const runWindowCommand = options.runWindowCommand || (async (action, details = {}) => {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath, "-Action", action];
    for (const [key, value] of Object.entries(details)) args.push(`-${key}`, String(value));
    const result = await execFileAsync("powershell.exe", args, { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  });
  let owned = null;
  let operation = Promise.resolve();
  let lastError = null;
  let ownerIdentity = null;

  const executablePath = product => path.join(installRoot, product.folder, product.executable);
  const preferencePath = product => {
    if (!preferencesRoot) throw new Error("Windows could not resolve the desktop user's SoundSpectrum preferences. No preferences were changed.");
    return path.join(preferencesRoot, product.folder, "Preferences (Standalone).txt");
  };
  function resolvePreferenceRoot(native) {
    if (options.preferencesRoot) return preferencesRoot;
    const roaming = native?.profile?.roamingAppDataPath;
    if (typeof roaming !== "string" || !path.isAbsolute(roaming)) throw new Error("Windows could not resolve the desktop user's SoundSpectrum preferences. No preferences were changed.");
    preferencesRoot = path.join(roaming, "SoundSpectrum");
    return preferencesRoot;
  }
  const manifestPath = product => path.join(backupRoot, `session-${product.id}.json`);
  const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  const hash = data => crypto.createHash("sha256").update(data).digest("hex");
  const isProductProcess = (candidate, product) => {
    const basename = path.win32.basename(candidate.executable || "").toLowerCase();
    return basename === product.executable.toLowerCase() || basename === product.executable.replace(".x64", "").toLowerCase();
  };
  const serialize = work => {
    const next = operation.then(work, work);
    operation = next.catch(() => {});
    return next;
  };
  const status = () => owned ? {
    state: owned.exited ? "cleanup-needed" : owned.ready ? "running" : "starting", visualizer: owned.product.id,
    pid: owned.child.pid, owned: true, audioInput: owned.input,
    windowHandle: owned.window?.windowHandle || null, windowTitle: owned.window?.windowTitle || null,
    width: owned.window?.width || null, height: owned.window?.height || null
  } : { state: "stopped", error: lastError };

  async function writeManifest(session) {
    if (!ownerIdentity) {
      const result = await runWindowCommand("inspect", { OwnerProcessId: process.pid });
      if (!result.owner || result.owner.pid !== process.pid || !samePath(result.owner.executable, process.execPath) || !/^\d{10,22}$/.test(String(result.owner.startTimeTicks || ""))) {
        throw new Error("Could not verify the Rabbit Hole process before starting SoundSpectrum.");
      }
      ownerIdentity = result.owner;
    }
    const target = manifestPath(session.product);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const manifest = {
      version: 1, visualizer: session.product.id, executable: session.executable,
      pid: session.child?.pid || null, startTimeTicks: session.startTimeTicks || null,
      backupFile: path.basename(session.backupPath), originalSha256: hash(session.original),
      ownerPid: ownerIdentity.pid, ownerExecutable: ownerIdentity.executable, ownerStartTimeTicks: String(ownerIdentity.startTimeTicks)
    };
    try {
      await fs.writeFile(temporary, JSON.stringify(manifest), { flag: "wx" });
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async function waitForExit(identity, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await runWindowCommand("window", identity)).exited) return true;
      await sleep(100);
    }
    return (await runWindowCommand("window", identity)).exited === true;
  }

  async function recoverOrphans() {
    if (platform !== "win32") return [];
    const recovered = [];
    for (const product of PRODUCTS) {
      if (owned?.product.id === product.id) continue;
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(manifestPath(product), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw new Error(`The ${product.name} ownership backup needs inspection before visuals can start.`); }
      const backupExpression = new RegExp(`^${product.id}-[a-f0-9-]{36}\\.preferences\\.backup$`, "i");
      if (manifest.version !== 1 || manifest.visualizer !== product.id ||
          typeof manifest.executable !== "string" || !samePath(manifest.executable, executablePath(product)) ||
          !backupExpression.test(manifest.backupFile || "") || !/^[a-f0-9]{64}$/.test(manifest.originalSha256 || "") ||
          manifest.pid !== null && (!Number.isInteger(manifest.pid) || manifest.pid <= 0) ||
          manifest.startTimeTicks !== null && !/^\d{10,22}$/.test(manifest.startTimeTicks || "") ||
          !Number.isInteger(manifest.ownerPid) || manifest.ownerPid <= 0 ||
          typeof manifest.ownerExecutable !== "string" || !samePath(manifest.ownerExecutable, process.execPath) ||
          !/^\d{10,22}$/.test(manifest.ownerStartTimeTicks || "")) {
        throw new Error(`The ${product.name} ownership backup is invalid; its original preferences have been preserved.`);
      }
      const backupPath = path.join(backupRoot, manifest.backupFile);
      const original = await fs.readFile(backupPath);
      if (hash(original) !== manifest.originalSha256) throw new Error(`The ${product.name} original preferences backup failed verification.`);
      let inventory = await runWindowCommand("inspect", { OwnerProcessId: manifest.ownerPid });
      resolvePreferenceRoot(inventory);
      if (inventory.owner && inventory.owner.pid === manifest.ownerPid && samePath(inventory.owner.executable, manifest.ownerExecutable) && String(inventory.owner.startTimeTicks) === manifest.ownerStartTimeTicks) {
        throw new Error(`${product.name} belongs to another running Rabbit Hole session; its renderer and preferences were left intact.`);
      }
      const matching = (inventory.processes || []).filter(candidate => isProductProcess(candidate, product));
      const tracked = matching.find(candidate => candidate.pid === manifest.pid);
      if (tracked) {
        if (!manifest.startTimeTicks || !samePath(tracked.executable, manifest.executable) || String(tracked.startTimeTicks) !== manifest.startTimeTicks) {
          throw new Error(`Close the existing ${product.name} window before recovering its backed-up preferences. Its ownership cannot be verified.`);
        }
        const identity = { ProcessId: manifest.pid, ExpectedExecutable: executablePath(product), StartTimeTicks: manifest.startTimeTicks };
        await runWindowCommand("close", identity);
        if (!await waitForExit(identity, 2500)) {
          await runWindowCommand("terminate", identity);
          if (!await waitForExit(identity, 2500)) throw new Error(`The previously owned ${product.name} renderer did not close; its preferences remain backed up.`);
        }
        inventory = await runWindowCommand("inspect");
      }
      if ((inventory.processes || []).some(candidate => isProductProcess(candidate, product))) throw new Error(`Close the existing ${product.name} window before recovering its backed-up preferences.`);
      await fs.writeFile(preferencePath(product), original);
      // Keep the original until both the restore and manifest removal succeed.
      await fs.unlink(manifestPath(product));
      await fs.unlink(backupPath).catch(() => {});
      recovered.push(product.id);
    }
    return recovered;
  }

  async function inspect() {
    let recoveryError = "";
    try { if ((await serialize(recoverOrphans)).length) lastError = null; }
    catch (error) { recoveryError = error.message; lastError = recoveryError; }
    const visualizers = await Promise.all(PRODUCTS.map(async product => {
      let available = false;
      if (platform === "win32") { try { await fs.access(executablePath(product)); available = true; } catch {} }
      return { id: product.id, name: product.name, available };
    }));
    if (platform !== "win32") return { visualizers, inputs: [], musicInputs: [], noMicInputs: noMicInputs(), ...status(), supported: false };
    const native = await runWindowCommand("inspect");
    if (native.profile) resolvePreferenceRoot(native);
    const musicInputs = await musicInputInventory(native.inputs || []);
    return { visualizers: visualizers.map(product => ({ ...product, alreadyRunning: (native.processes || []).some(candidate => isProductProcess(candidate, PRODUCTS.find(value => value.id === product.id))) })), inputs: microphoneInputs(native.inputs), musicInputs, noMicInputs: noMicInputs(), ...status(), supported: true, recoveryError };
  }

  async function listAudioInputs() {
    if (platform !== "win32") return [];
    return microphoneInputs((await runWindowCommand("inputs")).inputs);
  }

  async function musicInputInventory(rawInputs) {
    if (!additionalInputProvider) return [];
    const inputs = await additionalInputProvider.list(rawInputs);
    return (Array.isArray(inputs) ? inputs : []).filter(input => MUSIC_FEED_INPUT_IDS.has(input?.id) && input.kind === "music-feed" && typeof input.name === "string" && input.name.trim() && !/[\r\n\0]/.test(input.name))
      .map(input => ({ id: input.id, name: input.name, kind: "music-feed" }));
  }

  async function listMusicInputs() {
    if (platform !== "win32" || !additionalInputProvider) return [];
    return musicInputInventory((await runWindowCommand("inputs")).inputs || []);
  }

  async function resolveMusicInput(inputId, rawInputs) {
    if (!MUSIC_FEED_INPUT_IDS.has(inputId) || !additionalInputProvider) return null;
    const input = await additionalInputProvider.resolve(inputId, rawInputs);
    if (!input || input.id !== inputId || input.kind !== "music-feed" || input.name !== "Stereo Out (SoundSpectrum Audio Cable)" ||
        !rawInputs.some(raw => raw.name === input.name && raw.interfaceName === "SoundSpectrum Audio Cable")) throw new Error("The verified SoundSpectrum music input is unavailable.");
    return { id: input.id, name: input.name, kind: "music-feed" };
  }

  async function restoreSession(session) {
    if (session.restored) return;
    // Never restore while a different/manual instance could still write this file.
    const current = await runWindowCommand("inspect");
    const other = (current.processes || []).find(candidate => isProductProcess(candidate, session.product));
    if (other) throw new Error("SoundSpectrum preferences remain backed up until its running instance is closed.");
    await fs.writeFile(session.preferencesPath, session.original);
    await fs.unlink(manifestPath(session.product)).catch(error => { if (error.code !== "ENOENT") throw error; });
    session.restored = true;
    await fs.unlink(session.backupPath).catch(() => {});
    if (owned === session) owned = null;
  }

  async function stopOwned() {
    const session = owned;
    if (!session) return status();
    if (!session.child?.pid) {
      await restoreSession(session);
      return status();
    }
    const identity = { ProcessId: session.child.pid, ExpectedExecutable: session.executable };
    if (session.startTimeTicks) identity.StartTimeTicks = session.startTimeTicks;
    const current = await runWindowCommand("window", identity);
    if (!current.exited && !session.exited) {
      await runWindowCommand("close", identity);
      await waitForExit(identity, 2500);
      if (!session.exited) {
        const stillOwned = await runWindowCommand("window", identity);
        if (!stillOwned.exited) session.child.kill();
        await waitForExit(identity, 2500);
      }
      if (!session.exited && !(await runWindowCommand("window", identity)).exited) throw new Error("The owned SoundSpectrum renderer did not close.");
    }
    await restoreSession(session);
    return status();
  }

  async function startSession({ visualizer, inputId } = {}) {
    if (platform !== "win32") throw new Error("SoundSpectrum requires the Windows player PC.");
    const product = PRODUCTS.find(value => value.id === visualizer);
    if (!product) throw new Error("Choose Aeon, G-Force, or WhiteCap.");
    if (typeof inputId !== "string" || !inputId) throw new Error("Choose an exact PC microphone or SoundSpectrum no-mic preset.");
    if (owned?.ready && !owned.exited && owned.product.id === visualizer && owned.input.id === inputId) {
      if (MUSIC_FEED_INPUT_IDS.has(inputId)) await resolveMusicInput(inputId, (await runWindowCommand("inputs")).inputs || []);
      return status();
    }
    if (owned) await stopOwned();
    await recoverOrphans();
    const native = await runWindowCommand("inspect");
    if ((native.processes || []).some(candidate => isProductProcess(candidate, product))) throw new Error(`Close the existing ${product.name} Standalone window before starting it from Rabbit Hole.`);
    const input = NO_MIC_INPUTS.find(candidate => candidate.id === inputId) || microphoneInputs(native.inputs).find(candidate => candidate.id === inputId) || await resolveMusicInput(inputId, native.inputs || []);
    if (!input) throw new Error("The selected PC microphone is unavailable. Connect or enable it in Windows; virtual outputs are not selected automatically.");
    resolvePreferenceRoot(native);
    const executable = executablePath(product);
    await fs.access(executable);
    const preferencesPath = preferencePath(product);
    let original;
    try { original = await fs.readFile(preferencesPath); }
    catch { throw new Error(`Open ${product.name} Standalone once to initialize its local preferences.`); }
    const patched = patchStandalonePreferences(original, input.name, visualizer);
    await fs.mkdir(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, `${visualizer}-${crypto.randomUUID()}.preferences.backup`);
    await fs.writeFile(backupPath, original, { flag: "wx" });
    const session = { product, input, executable, preferencesPath, original, backupPath, exited: false, restored: false, ready: false };
    try {
      // Reserving the manifest before changing preferences also covers a crash before spawn.
      await writeManifest(session);
      await fs.writeFile(preferencesPath, patched);
    } catch (error) {
      await fs.writeFile(preferencesPath, original);
      await fs.unlink(manifestPath(product)).catch(() => {});
      await fs.unlink(backupPath).catch(() => {});
      throw error;
    }
    owned = session;
    lastError = null;
    try {
      // A native GUI window is deliberately visible for window-only video capture.
      session.child = spawnImpl(executable, [], { cwd: path.dirname(executable), windowsHide: false, stdio: "ignore" });
      let resolveExit;
      session.exitPromise = new Promise(resolve => { resolveExit = resolve; });
      session.child.once("exit", () => {
        session.exited = true; resolveExit();
        serialize(() => restoreSession(session)).catch(error => { lastError = error.message; });
      });
      session.child.once("error", error => { session.spawnError = error; session.exited = true; resolveExit(); });
      await writeManifest(session);
      const deadline = Date.now() + windowTimeoutMs;
      while (Date.now() < deadline) {
        if (session.spawnError) throw new Error(`Could not start ${product.name} Standalone.`);
        if (session.exited) throw new Error(`${product.name} Standalone closed before its visualizer window was ready.`);
        const result = await runWindowCommand("window", { ProcessId: session.child.pid, ExpectedExecutable: executable });
        if (result.startTimeTicks && session.startTimeTicks !== result.startTimeTicks) {
          session.startTimeTicks = result.startTimeTicks;
          await writeManifest(session);
        }
        if (result.window) {
          const prepared = await runWindowCommand("prepare", { ProcessId: session.child.pid, ExpectedExecutable: executable, StartTimeTicks: session.startTimeTicks, Width: 800, Height: 450 });
          if (!prepared.window?.windowHandle || prepared.window.minimized) throw new Error("The native visualizer window is unavailable for capture.");
          session.window = prepared.window;
          session.ready = true;
          return status();
        }
        await sleep(250);
      }
      throw new Error(`${product.name} did not open a visualizer window in time.`);
    } catch (error) {
      lastError = error.message;
      await stopOwned().catch(cleanupError => { lastError += ` ${cleanupError.message}`; });
      throw new Error(lastError);
    }
  }

  return { inspect, listAudioInputs, listMusicInputs, status, start: options => serialize(() => startSession(options)), stop: () => serialize(stopOwned) };
}

module.exports = { createSoundSpectrumNative, microphoneInputs, patchStandalonePreferences, PRODUCTS, NO_MIC_INPUTS };
