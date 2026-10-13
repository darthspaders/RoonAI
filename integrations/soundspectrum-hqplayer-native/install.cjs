"use strict";

// Optional, independent native menu hook. No preference or audio-device writes.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const PACKAGE = "RabbitHole.HQPlayerInput.package";
const PACKAGE_FILE = `Packages/${PACKAGE}/_package.py`;
const LAUNCHER_FILE = "launch.vbs";
const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const RENAME_RETRY_DELAYS = [20, 40, 80, 160, 160];

async function renameState(from, to, { rename = (a, b) => fs.rename(a, b), wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  // Windows indexers/antivirus can briefly hold the just-created manifest.
  // Retry the same atomic rename for at most 460ms; never unlink the target.
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= RENAME_RETRY_DELAYS.length) throw error;
      await wait(RENAME_RETRY_DELAYS[attempt]);
    }
  }
}

function inside(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Invalid add-on path.");
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error("Add-on path leaves its root.");
  return result;
}

async function readOptional(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function assertNoLinks(root, relative) {
  const target = inside(root, relative);
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Add-on path contains a symbolic link."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function constantPath(value) {
  const result = path.resolve(value);
  if (/["\r\n\0%]/.test(result)) throw new Error("Unsupported launcher path; no files were changed.");
  return result;
}

function pythonPath(value) {
  // ASCII-only Unicode literals are safe in G-Force's Python 2.7 interpreter.
  return "u" + JSON.stringify(constantPath(value)).replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function renderPackage(template, runtimeRoot) {
  let result = template;
  for (const [token, filename] of [["__RH_REQUEST_PATH__", "request.txt"], ["__RH_STATUS_PATH__", "status.txt"], ["__RH_LAUNCHER_PATH__", LAUNCHER_FILE]]) {
    if (result.split(token).length !== 2) throw new Error(`Expected one ${token} placeholder; nothing was installed.`);
    result = result.replace(token, () => pythonPath(inside(runtimeRoot, filename)));
  }
  return result;
}

function launcherSource(nodePath, controllerPath) {
  const command = `"${constantPath(nodePath)}" "${constantPath(controllerPath)}"`;
  return `Option Explicit\r\nDim shell\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Run "${command.replaceAll('"', '""')}", 0, False\r\n`;
}

function settings(options) {
  const source = path.resolve(options.source || __dirname);
  const runtime = path.resolve(options.roots?.runtime || path.join(source, "../../data/soundspectrum-hqplayer-native"));
  return {
    source, roots: { install: path.resolve(options.roots?.install || path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SoundSpectrum/G-Force")), runtime },
    statePath: path.resolve(options.statePath || path.join(source, "../../data/soundspectrum-hqplayer-native-install.json")),
    nodePath: constantPath(options.nodePath || process.execPath), controllerPath: constantPath(path.join(source, "controller.cjs"))
  };
}

async function assertIdle(config) {
  // Even a stale record requires the companion's explicit recovery, never theft.
  for (const name of ["owner.json", "session.json"]) {
    await assertNoLinks(config.roots.runtime, name);
    if (await readOptional(inside(config.roots.runtime, name))) throw new Error("Stop or recover the native HQPlayer companion before changing its add-on.");
  }
  await assertNoLinks(path.dirname(config.statePath), path.basename(config.statePath));
}

function validateEntry(entry) {
  if (!entry || !HASH.test(entry.sha256) || !((entry.root === "install" && entry.relative === PACKAGE_FILE) || (entry.root === "runtime" && entry.relative === LAUNCHER_FILE))) throw new Error("Invalid native add-on ownership record.");
}

function validateState(state) {
  if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 2) throw new Error("Invalid native add-on ownership record.");
  const keys = new Set();
  for (const entry of state.entries) {
    validateEntry(entry);
    const key = `${entry.root}/${entry.relative}`;
    if (keys.has(key)) throw new Error("Duplicate native add-on ownership record.");
    keys.add(key);
  }
  if (state.pendingUpdate) {
    if (!Array.isArray(state.pendingUpdate.entries)) throw new Error("Invalid pending native add-on update.");
    const pendingKeys = new Set();
    for (const pending of state.pendingUpdate.entries) {
      validateEntry(pending);
      const key = `${pending.root}/${pending.relative}`;
      if (pendingKeys.has(key) || !HASH.test(pending.nextSha256) || !state.entries.some(entry => entry.root === pending.root && entry.relative === pending.relative && entry.sha256 === pending.sha256)) throw new Error("Invalid pending native add-on ownership.");
      pendingKeys.add(key);
    }
  }
}

async function saveState(statePath, state, exclusive = false) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: "wx" });
    // Hard-link creation is atomic and fails if another install reserved the name.
    if (exclusive) await fs.link(temporary, statePath);
    else await renameState(temporary, statePath);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

async function desiredEntries(config) {
  await assertNoLinks(config.source, `${PACKAGE}/_package.py`);
  await assertNoLinks(config.source, "controller.cjs");
  await assertNoLinks(path.dirname(config.nodePath), path.basename(config.nodePath));
  for (const file of [config.nodePath, config.controllerPath]) if (!(await fs.stat(file)).isFile()) throw new Error("The fixed Node.js/controller launcher file is unavailable.");
  if (path.basename(config.nodePath).toLowerCase() !== "node.exe") throw new Error("Use the existing Windows node.exe for the native launcher.");
  const template = await fs.readFile(inside(config.source, `${PACKAGE}/_package.py`), "utf8");
  return [
    { root: "install", relative: PACKAGE_FILE, bytes: Buffer.from(renderPackage(template, config.roots.runtime)) },
    { root: "runtime", relative: LAUNCHER_FILE, bytes: Buffer.from(launcherSource(config.nodePath, config.controllerPath)) }
  ].map(entry => ({ ...entry, sha256: digest(entry.bytes) }));
}

async function install(options = {}) {
  const config = settings(options);
  await assertIdle(config);
  if (await readOptional(config.statePath)) throw new Error("The native add-on already has an install record. Use update or remove.");
  const entries = await desiredEntries(config);
  for (const entry of entries) {
    await assertNoLinks(config.roots[entry.root], entry.relative);
    if (await readOptional(inside(config.roots[entry.root], entry.relative))) throw new Error(`A file already exists at ${entry.relative}; nothing was replaced.`);
  }
  const state = { version: 1, stage: "installing", entries: entries.map(({ bytes, ...entry }) => entry) };
  await saveState(config.statePath, state, true);
  for (const entry of entries) {
    const target = inside(config.roots[entry.root], entry.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.bytes, { flag: "wx" });
  }
  state.stage = "installed";
  await saveState(config.statePath, state);
  return { installedFiles: entries.length, preferencesChanged: false };
}

async function update(options = {}) {
  const config = settings(options);
  await assertIdle(config);
  const state = JSON.parse(await fs.readFile(config.statePath, "utf8"));
  validateState(state);
  if (!["installed", "updating"].includes(state.stage) || state.entries.length !== 2) throw new Error("Complete the native add-on installation before updating.");
  const desired = await desiredEntries(config), changes = [];
  for (const entry of state.entries) {
    await assertNoLinks(config.roots[entry.root], entry.relative);
    const target = inside(config.roots[entry.root], entry.relative);
    const current = await fs.readFile(target);
    const next = desired.find(item => item.root === entry.root && item.relative === entry.relative);
    const pending = state.pendingUpdate?.entries.find(item => item.root === entry.root && item.relative === entry.relative);
    if (digest(current) !== entry.sha256 && digest(current) !== pending?.nextSha256) throw new Error(`An installed file was edited: ${entry.relative}; it was preserved.`);
    if (state.pendingUpdate && next.sha256 !== (pending?.nextSha256 || entry.sha256)) throw new Error("The source changed during an interrupted update; restore that source before resuming.");
    if (next.sha256 !== entry.sha256) changes.push({ ...entry, target, current, next: next.bytes, nextSha256: next.sha256 });
  }
  if (!changes.length) return { updatedFiles: 0, preferencesChanged: false };
  if (!state.pendingUpdate) {
    const backup = inside(config.roots.runtime, `updates/${crypto.randomUUID()}`);
    await assertNoLinks(config.roots.runtime, path.relative(config.roots.runtime, backup));
    for (const entry of changes) {
      const target = inside(backup, `${entry.root}/${entry.relative}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.current, { flag: "wx" });
    }
    state.stage = "updating";
    state.pendingUpdate = { backup, entries: changes.map(({ root, relative, sha256, nextSha256 }) => ({ root, relative, sha256, nextSha256 })) };
    await saveState(config.statePath, state);
  }
  for (const entry of changes) {
    if (digest(await fs.readFile(entry.target)) === entry.nextSha256) continue;
    const temporary = `${entry.target}.rh-update-${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, entry.next, { flag: "wx" });
      if (digest(await fs.readFile(entry.target)) !== entry.sha256) throw new Error("An installed file changed during update; it was preserved.");
      await fs.rename(temporary, entry.target);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  for (const change of changes) state.entries.find(entry => entry.root === change.root && entry.relative === change.relative).sha256 = change.nextSha256;
  state.updates = [...(state.updates || []), { backup: state.pendingUpdate.backup, updatedFiles: changes.length }];
  delete state.pendingUpdate;
  state.stage = "installed";
  await saveState(config.statePath, state);
  return { updatedFiles: changes.length, preferencesChanged: false };
}

async function remove(options = {}) {
  const config = settings(options);
  await assertIdle(config);
  const bytes = await readOptional(config.statePath);
  if (!bytes) return { removedFiles: 0, preserved: [], preferencesChanged: false };
  const state = JSON.parse(bytes);
  validateState(state);
  const remaining = [];
  let removedFiles = 0;
  for (const entry of state.entries) {
    await assertNoLinks(config.roots[entry.root], entry.relative);
    const target = inside(config.roots[entry.root], entry.relative), current = await readOptional(target);
    const pending = state.pendingUpdate?.entries.find(item => item.root === entry.root && item.relative === entry.relative);
    if (current && digest(current) !== entry.sha256 && digest(current) !== pending?.nextSha256) { remaining.push(entry); continue; }
    if (current) { await fs.unlink(target); removedFiles++; }
  }
  // Never remove the private runtime directory, queues, status, logs or backups.
  await fs.rmdir(inside(config.roots.install, `Packages/${PACKAGE}`)).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
  if (remaining.length) {
    state.stage = "partially-removed";
    state.entries = remaining;
    if (state.pendingUpdate) state.pendingUpdate.entries = state.pendingUpdate.entries.filter(pending => remaining.some(entry => entry.root === pending.root && entry.relative === pending.relative));
    await saveState(config.statePath, state);
  } else await fs.unlink(config.statePath);
  return { removedFiles, preserved: remaining.map(entry => entry.relative), preferencesChanged: false };
}

async function main() {
  const action = process.argv[2];
  if (!["install", "update", "remove"].includes(action)) throw new Error("Usage: node install.cjs install|update|remove");
  if (process.platform !== "win32") throw new Error("The optional native HQPlayer input requires Windows.");
  const config = settings({});
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8", windowsHide: true }).trim();
  if (process.env.RH_NATIVE_INSTALL_SID && process.env.RH_NATIVE_INSTALL_SID !== sid) throw new Error("Use the same Windows user who runs G-Force.");
  console.log(JSON.stringify(await ({ install, update, remove }[action])(config)));
}

module.exports = { install, update, remove, renderPackage, launcherSource, inside, digest, PACKAGE_FILE, renameState };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
