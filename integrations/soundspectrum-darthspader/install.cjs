"use strict";

// This optional add-on does not import into or restart either music application.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const PACKAGE = "RabbitHole.Darthspader.package";
const THEME = "Rabbit Hole - darthspader";
const PREF = "Theme.StartupTheme";
const ADDED_CATEGORIES = ["Particle", "Sprite"].map(type => `Categories/${type}/${THEME}.txt`);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function inside(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Invalid add-on path.");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error("Add-on path leaves its root.");
  return resolved;
}

async function readOptional(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function assertNoLinks(root, relative) {
  const pieces = relative.split(/[\\/]/);
  let target = path.resolve(root);
  for (const piece of ["", ...pieces]) {
    if (piece) target = path.join(target, piece);
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Add-on path contains a symbolic link."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function decodePreferences(bytes) {
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) throw new Error("Unsupported preference encoding; preferences were preserved.");
  const bom = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? 2 : bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const encoding = bom === 2 ? "utf16le" : "utf8";
  if (encoding === "utf8") new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(bom));
  const text = bytes.subarray(bom).toString(encoding);
  if (!/^Prefs\.Version\s*=\s*\d+\s*$/m.test(text)) throw new Error("Open G-Force Standalone once before installing this add-on.");
  return { text, encode: value => Buffer.concat([bytes.subarray(0, bom), Buffer.from(value, encoding)]) };
}

function changeStartup(bytes, saved = null) {
  const { text, encode } = decodePreferences(bytes);
  const expression = /^Theme\.StartupTheme[ \t]*=[^\r\n]*(?:\r?\n|$)/gm;
  const lines = [...text.matchAll(expression)].map(match => match[0]);
  if (lines.length > 1) throw new Error("G-Force has duplicate startup-theme settings; preferences were preserved.");
  const owned = `${PREF} = ${JSON.stringify(THEME)}`;
  if (saved) {
    if (lines[0]?.trim() !== owned) return { bytes, changed: false };
    return { bytes: encode(text.replace(expression, () => saved.original)), changed: true };
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const original = lines[0] || "";
  const next = original ? text.replace(expression, () => owned + newline) : text + (text.endsWith("\n") ? "" : newline) + owned + newline;
  return { bytes: encode(next), saved: { original }, changed: true };
}

async function listFiles(root, prefix = "") {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Add-on source contains a symbolic link.");
    if (entry.isDirectory()) result.push(...await listFiles(path.join(root, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

function validateEntry(entry) {
  if (!["install", "profile"].includes(entry.root) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid add-on install record.");
  const relative = entry.relative.replaceAll("\\", "/");
  if (path.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("Invalid add-on path.");
  if (entry.root === "install" && !relative.startsWith(`Packages/${PACKAGE}/`)) throw new Error("Unexpected installed package path.");
  if (entry.root === "profile" && !new RegExp(`^(Themes|Categories/(WaveShape|ColorMap|FlowField|Particle|Sprite))/${THEME}\\.txt$`).test(relative)) throw new Error("Unexpected installed profile path.");
  return entry;
}

function validatePendingUpdate(state) {
  if (!state.pendingUpdate) return;
  if (!Array.isArray(state.pendingUpdate.entries)) throw new Error("Invalid pending add-on update.");
  for (const pending of state.pendingUpdate.entries) {
    validateEntry(pending);
    if (pending.root !== "install" || !/^[a-f0-9]{64}$/.test(pending.nextSha256) || !state.entries.some(entry => entry.root === pending.root && entry.relative === pending.relative && entry.sha256 === pending.sha256)) throw new Error("Invalid pending add-on ownership.");
  }
}

function validatePendingCategories(state) {
  if (!state.pendingCategories) return;
  const entries = state.pendingCategories.entries;
  if (!Array.isArray(entries) || !entries.length || entries.length > ADDED_CATEGORIES.length) throw new Error("Invalid pending category addition.");
  const seen = new Set();
  for (const entry of entries) {
    validateEntry(entry);
    if (entry.root !== "profile" || !ADDED_CATEGORIES.includes(entry.relative) || seen.has(entry.relative) || !state.entries.some(owned => owned.root === entry.root && owned.relative === entry.relative && owned.sha256 === entry.sha256)) throw new Error("Invalid pending category ownership.");
    seen.add(entry.relative);
  }
}

async function saveState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: "wx" });
  await fs.rename(temporary, statePath);
}

async function install({ source = __dirname, roots, statePath }) {
  const existing = await readOptional(statePath);
  if (existing) throw new Error("This add-on has an install record. Remove it before reinstalling; local changes are protected.");
  const packageRoot = path.join(source, PACKAGE);
  const profileRoot = path.join(source, "profile");
  const entries = [];
  for (const [root, sourceRoot, prefix] of [["install", packageRoot, `Packages/${PACKAGE}`], ["profile", profileRoot, ""]]) {
    for (const relative of await listFiles(sourceRoot)) {
      const bytes = await fs.readFile(inside(sourceRoot, relative));
      const entry = validateEntry({ root, relative: prefix ? `${prefix}/${relative}` : relative, sha256: digest(bytes) });
      await assertNoLinks(roots[root], entry.relative);
      if (await readOptional(inside(roots[root], entry.relative))) throw new Error(`A file already exists at ${entry.relative}; nothing was replaced.`);
      entries.push({ ...entry, bytes });
    }
  }
  const preferences = path.join(roots.profile, "Preferences (Standalone).txt");
  await assertNoLinks(roots.profile, "Preferences (Standalone).txt");
  const original = await fs.readFile(preferences);
  const patched = changeStartup(original);
  const state = { version: 1, stage: "installing", startup: patched.saved, entries: entries.map(({ bytes, ...entry }) => entry) };
  // Persist ownership before creating anything, so an interrupted install can be removed.
  await saveState(statePath, state);
  for (const entry of entries) {
    const target = inside(roots[entry.root], entry.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.bytes, { flag: "wx" });
  }
  // Refuse to overwrite concurrent preference changes.
  if (digest(await fs.readFile(preferences)) !== digest(original)) throw new Error("G-Force preferences changed during installation. Run remove to recover the owned files.");
  await fs.writeFile(preferences, patched.bytes);
  state.stage = "installed";
  await saveState(statePath, state);
  return { theme: THEME, installedFiles: entries.length };
}

async function remove({ roots, statePath }) {
  const record = await readOptional(statePath);
  if (!record) return { removedFiles: 0, preserved: [], startupRestored: false };
  const state = JSON.parse(record);
  if (state.version !== 1 || !Array.isArray(state.entries) || typeof state.startup?.original !== "string") throw new Error("Invalid add-on install record; nothing was removed.");
  state.entries.forEach(validateEntry);
  validatePendingUpdate(state);
  validatePendingCategories(state);
  const preferences = path.join(roots.profile, "Preferences (Standalone).txt");
  await assertNoLinks(roots.profile, "Preferences (Standalone).txt");
  const patched = changeStartup(await fs.readFile(preferences), state.startup);
  if (patched.changed) await fs.writeFile(preferences, patched.bytes);
  const remaining = [], directories = new Set();
  let removedFiles = 0;
  for (const entry of state.entries) {
    await assertNoLinks(roots[entry.root], entry.relative);
    const target = inside(roots[entry.root], entry.relative);
    const bytes = await readOptional(target);
    const pending = state.pendingUpdate?.entries.find(item => item.root === entry.root && item.relative === entry.relative);
    if (bytes && digest(bytes) !== entry.sha256 && digest(bytes) !== pending?.nextSha256) { remaining.push(entry); continue; }
    if (bytes) { await fs.unlink(target); removedFiles++; }
    let directory = path.dirname(target);
    const minimum = path.resolve(roots[entry.root], entry.root === "install" ? `Packages/${PACKAGE}` : ".");
    while (directory === minimum || directory.startsWith(minimum + path.sep)) {
      if (directory === path.resolve(roots.profile)) break;
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  // Remove only empty directories already verified under this add-on's roots.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await fs.rmdir(directory).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
  }
  if (remaining.length) {
    const nextState = { ...state, stage: "partially-removed", entries: remaining };
    if (nextState.pendingUpdate) nextState.pendingUpdate = { ...nextState.pendingUpdate, entries: nextState.pendingUpdate.entries.filter(pending => remaining.some(entry => entry.root === pending.root && entry.relative === pending.relative)) };
    if (nextState.pendingCategories) {
      const entries = nextState.pendingCategories.entries.filter(pending => remaining.some(entry => entry.root === pending.root && entry.relative === pending.relative));
      if (entries.length) nextState.pendingCategories = { ...nextState.pendingCategories, entries };
      else delete nextState.pendingCategories;
    }
    await saveState(statePath, nextState);
  }
  else await fs.unlink(statePath);
  return { removedFiles, preserved: remaining.map(entry => entry.relative), startupRestored: patched.changed };
}

async function update({ source = __dirname, roots, statePath }) {
  const state = JSON.parse((await fs.readFile(statePath)).toString("utf8"));
  if (state.version !== 1 || !["installed", "updating"].includes(state.stage) || !Array.isArray(state.entries)) throw new Error("The add-on needs a completed installation before updating.");
  state.entries.forEach(validateEntry);
  validatePendingUpdate(state);
  validatePendingCategories(state);
  if (state.pendingCategories) throw new Error("Finish the pending category addition before updating package configs.");
  const changes = [];
  for (const entry of state.entries.filter(entry => entry.root === "install")) {
    await assertNoLinks(roots.install, entry.relative);
    await assertNoLinks(source, entry.relative.slice("Packages/".length));
    const target = inside(roots.install, entry.relative);
    const current = await fs.readFile(target);
    const next = await fs.readFile(inside(source, entry.relative.slice("Packages/".length)));
    const currentSha = digest(current), nextSha = digest(next);
    const pending = state.pendingUpdate?.entries?.find(item => item.relative === entry.relative);
    if (currentSha !== entry.sha256 && currentSha !== pending?.nextSha256) throw new Error(`An installed file was edited: ${entry.relative}; it was preserved.`);
    if (pending && nextSha !== pending.nextSha256) throw new Error("The source changed during an interrupted update; restore that source before resuming.");
    if (nextSha !== entry.sha256) changes.push({ ...entry, nextSha256: nextSha, target, current, next });
  }
  if (!changes.length) return { updatedFiles: 0, theme: THEME };
  if (!state.pendingUpdate) {
    const backup = path.join(path.dirname(statePath), "soundspectrum-darthspader-updates", crypto.randomUUID());
    await fs.mkdir(backup, { recursive: true });
    for (const entry of changes) {
      await fs.mkdir(path.dirname(inside(backup, entry.relative)), { recursive: true });
      await fs.writeFile(inside(backup, entry.relative), entry.current, { flag: "wx" });
    }
    state.stage = "updating";
    state.pendingUpdate = { backup, entries: changes.map(({ root, relative, sha256, nextSha256 }) => ({ root, relative, sha256, nextSha256 })) };
    await saveState(statePath, state);
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
  for (const entry of changes) state.entries.find(item => item.root === "install" && item.relative === entry.relative).sha256 = entry.nextSha256;
  state.updates = [...(state.updates || []), { backup: state.pendingUpdate.backup, updatedFiles: changes.length }];
  delete state.pendingUpdate;
  state.stage = "installed";
  await saveState(statePath, state);
  return { updatedFiles: changes.length, theme: THEME, preferencesChanged: false };
}

async function addCategories({ source = __dirname, roots, statePath }) {
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (state.version !== 1 || !["installed", "adding-categories"].includes(state.stage) || !Array.isArray(state.entries) || typeof state.startup?.original !== "string" || state.pendingUpdate) throw new Error("Complete the existing add-on installation/update before adding categories.");
  state.entries.forEach(validateEntry);
  validatePendingCategories(state);
  if ((state.stage === "adding-categories") !== Boolean(state.pendingCategories)) throw new Error("Invalid category addition recovery record.");
  const identities = state.entries.map(entry => `${entry.root}/${entry.relative}`);
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate add-on ownership record.");
  await assertNoLinks(path.dirname(statePath), path.basename(statePath));
  const sourceRoot = path.join(source, "profile"), additions = [], preserved = [];
  // Preflight both source/target paths before changing the record or creating
  // files. Existing theme, categories, package files and preferences are never
  // read for synchronization and never rewritten by this additive action.
  for (const relative of ADDED_CATEGORIES) {
    await assertNoLinks(sourceRoot, relative);
    await assertNoLinks(roots.profile, relative);
    const bytes = await fs.readFile(inside(sourceRoot, relative)), sha256 = digest(bytes);
    const owned = state.entries.find(entry => entry.root === "profile" && entry.relative === relative);
    const pending = state.pendingCategories?.entries.find(entry => entry.relative === relative);
    const current = await readOptional(inside(roots.profile, relative));
    if (!owned && current) throw new Error(`A file already exists at ${relative}; it was preserved and nothing was added.`);
    if (state.pendingCategories) {
      if (!pending) continue; // Resume only the previously reserved additions.
      if (sha256 !== pending.sha256) throw new Error("The category source changed during an interrupted addition; restore that source before resuming.");
      if (current && digest(current) !== pending.sha256) throw new Error(`A category changed during interrupted addition: ${relative}; it was preserved.`);
      additions.push({ ...pending, bytes, exists: Boolean(current) });
    } else if (owned && current) {
      if (digest(current) !== owned.sha256) preserved.push(relative);
    } else {
      if (owned && sha256 !== owned.sha256) throw new Error("The source for a missing owned category changed; it was preserved.");
      additions.push({ root: "profile", relative, sha256, bytes, exists: false });
    }
  }
  if (!additions.length) return { addedFiles: 0, preserved, preferencesChanged: false };
  if (!state.pendingCategories) {
    const entries = additions.map(({ bytes, exists, ...entry }) => entry);
    for (const entry of entries) if (!state.entries.some(owned => owned.root === entry.root && owned.relative === entry.relative)) state.entries.push(entry);
    state.stage = "adding-categories";
    state.pendingCategories = { entries };
    // Reserve ownership first; missing/complete matching additions can then
    // be resumed or removed after interruption without changing user files.
    await saveState(statePath, state);
  }
  let addedFiles = 0;
  for (const entry of additions) {
    if (entry.exists) continue;
    const target = inside(roots.profile, entry.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.bytes, { flag: "wx" });
    addedFiles++;
  }
  state.stage = "installed";
  delete state.pendingCategories;
  await saveState(statePath, state);
  return { addedFiles, preserved, preferencesChanged: false };
}

async function main() {
  const action = process.argv[2];
  if (!["install", "remove", "update", "add-categories"].includes(action)) throw new Error("Usage: node install.cjs install|remove|update|add-categories");
  if (process.platform !== "win32") throw new Error("This optional G-Force add-on requires Windows.");
  const active = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-Process -Name 'G-Force Standalone','G-Force Standalone.x64' -ErrorAction SilentlyContinue).Count"], { encoding: "utf8", windowsHide: true }).trim();
  if (!["update", "add-categories"].includes(action) && active !== "0") throw new Error("Stop the G-Force visualizer before changing its add-on. Music can stay playing.");
  const appData = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"], { encoding: "utf8", windowsHide: true }).trim();
  const roots = { install: path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SoundSpectrum", "G-Force"), profile: path.join(appData, "SoundSpectrum", "G-Force") };
  const statePath = path.resolve(__dirname, "../../data/soundspectrum-darthspader-install.json");
  console.log(JSON.stringify(await ({ install, remove, update, "add-categories": addCategories }[action])({ roots, statePath })));
}

module.exports = { install, remove, update, addCategories, changeStartup, inside, digest };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
