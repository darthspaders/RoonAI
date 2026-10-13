"use strict";

// Optional, independently removable native package. Never imports the app,
// changes preferences/themes, or starts a renderer, audio input or playback.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const PACKAGE = "RabbitHole.Meters.package";
const NAMES = Object.freeze(["Rabbit Hole - Emerald VU", "Rabbit Hole - Twin Cyan VU", "Rabbit Hole - Prism Spectrum"]);
const CATEGORY = "Categories/WaveShape/Rabbit Hole - darthspader.txt";
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const backupPath = statePath => statePath + ".category-before";
function updateBackupRoot(statePath, id) {
  if (!UUID.test(id)) throw Error("Invalid meters update backup identity.");
  return path.join(path.dirname(statePath), "soundspectrum-meters-updates", id);
}

function inside(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(piece => ["..", ".", ""].includes(piece))) throw Error("Invalid meters add-on path.");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw Error("Meters add-on path leaves its root.");
  return resolved;
}
function packageRelative(relative) {
  if (relative === "_package.py") return true;
  return ["WaveShapes", "ColorMaps"].some(type => NAMES.some(name => relative === `${type}/${name}.txt`));
}
function validateFile(entry) {
  const prefix = `Packages/${PACKAGE}/`;
  const allowed = entry && typeof entry.relative === "string" && (entry.relative.startsWith(prefix) && packageRelative(entry.relative.slice(prefix.length)) || NAMES.some(name => entry.relative === `Scripts/${name}.py`));
  if (!allowed || !HASH.test(entry.sha256)) throw Error("Invalid meters package ownership.");
  return entry;
}
async function readOptional(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error("Meters add-on file is not a bounded regular file.");
    return await fs.readFile(file);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function assertNoLinks(root, relative) {
  // Check ancestors as well as the final root, including Windows junctions.
  const resolved = inside(root, relative), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const piece of resolved.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, piece);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error("Meters add-on path contains a symbolic link or junction."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
async function listFiles(root, prefix = "") {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error("Meters source contains a symbolic link.");
    if (entry.isDirectory()) result.push(...await listFiles(path.join(root, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw Error("Meters source contains an unsupported entry.");
  }
  return result.sort();
}
function categoryDocument(bytes) {
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) throw Error("Unsupported category encoding; category was preserved.");
  const bom = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? 2 : bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const encoding = bom === 2 ? "utf16le" : "utf8", content = bytes.subarray(bom);
  if (encoding === "utf8") new TextDecoder("utf-8", { fatal: true }).decode(content);
  else if (content.length % 2) throw Error("Malformed UTF-16 category; category was preserved.");
  const text = content.toString(encoding);
  if ((text.match(/^CategoryTitle[ \t]*=/gm) || []).length !== 1 || !/^CategoryTitle[ \t]*=[ \t]*"Rabbit Hole - darthspader"[ \t]*\r?$/m.test(text)) throw Error("The existing Darthspader WaveShape category was not recognized.");
  if ((text.match(/^Include\.List[ \t]*=/gm) || []).length !== 1) throw Error("The WaveShape category must contain exactly one Include.List.");
  const match = /^Include\.List[ \t]*=[ \t]*"(\r?\n[^\"]*)"(?=[ \t]*(?:\r?\n|$))/m.exec(text);
  if (!match) throw Error("Unsupported WaveShape Include.List grammar; category was preserved.");
  const bodyStart = match.index + match[0].indexOf('"') + 1;
  return { text, body: match[1], bodyStart, newline: match[1].startsWith("\r\n") ? "\r\n" : "\n",
    encode: value => Buffer.concat([bytes.subarray(0, bom), Buffer.from(value, encoding)]) };
}
function categoryNames(bytes) { return categoryDocument(bytes).body.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
function appendNames(bytes) {
  const doc = categoryDocument(bytes), existing = new Set(categoryNames(bytes));
  const addedNames = NAMES.filter(name => !existing.has(name));
  const insertion = addedNames.length ? (doc.body.endsWith("\n") ? "" : doc.newline) + addedNames.join(doc.newline) + doc.newline : "";
  const end = doc.bodyStart + doc.body.length;
  return { bytes: doc.encode(doc.text.slice(0, end) + insertion + doc.text.slice(end)), addedNames };
}
function removeNames(bytes, names) {
  if (!Array.isArray(names) || names.some(name => !NAMES.includes(name))) throw Error("Invalid owned WaveShape names.");
  const doc = categoryDocument(bytes), owned = new Set(names);
  const lines = doc.body.match(/[^\r\n]*(?:\r?\n|$)/g) || [];
  const body = lines.filter(line => !owned.has(line.replace(/\r?\n$/, "").trim())).join("");
  return doc.encode(doc.text.slice(0, doc.bodyStart) + body + doc.text.slice(doc.bodyStart + doc.body.length));
}
async function sourceFiles(source) {
  const root = path.join(source, PACKAGE);
  await assertNoLinks(source, PACKAGE);
  const files = await listFiles(root);
  if (files.some(relative => !packageRelative(relative))) throw Error("Meters source contains an unexpected package file.");
  for (const required of ["_package.py", ...NAMES.map(name => `WaveShapes/${name}.txt`)]) if (!files.includes(required)) throw Error(`Meters source is missing ${required}.`);
  const result = await Promise.all(files.map(async relative => {
    const bytes = await readOptional(inside(root, relative));
    if (!bytes) throw Error("Meters source changed while reading it.");
    return { relative: `Packages/${PACKAGE}/${relative}`, sha256: digest(bytes), bytes };
  }));
  await assertNoLinks(source, "Scripts");
  let scripts = [];
  try { scripts = await listFiles(path.join(source, "Scripts")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (scripts.some(relative => !NAMES.some(name => relative === `${name}.py`))) throw Error("Meters source contains an unexpected script.");
  for (const relative of scripts) {
    const bytes = await readOptional(inside(path.join(source, "Scripts"), relative));
    if (!bytes) throw Error("Meters script source changed while reading it.");
    result.push({ relative: `Scripts/${relative}`, sha256: digest(bytes), bytes });
  }
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}
function validateState(state) {
  if (!state || state.version !== 1 || state.packageName !== PACKAGE || !["installing", "installed", "updating", "removing", "partially-removed"].includes(state.stage) || !Array.isArray(state.files) || !state.files.length || state.files.length > 10) throw Error("Invalid meters install record.");
  const seen = new Set();
  for (const entry of state.files) { validateFile(entry); if (seen.has(entry.relative)) throw Error("Duplicate meters ownership entry."); seen.add(entry.relative); }
  const category = state.category;
  if (!category || category.relative !== CATEGORY || !HASH.test(category.beforeSha256) || !HASH.test(category.installedSha256) || !Array.isArray(category.addedNames) || new Set(category.addedNames).size !== category.addedNames.length || category.addedNames.some(name => !NAMES.includes(name))) throw Error("Invalid meters category ownership.");
  if (state.stage === "updating" && !state.pendingUpdate) throw Error("Meters update is missing its journal.");
  if (state.pendingUpdate) {
    const pending = state.pendingUpdate, entries = pending.entries;
    if (!["updating", "removing", "partially-removed"].includes(state.stage) || !UUID.test(pending.id) || !Array.isArray(entries) || !entries.length || entries.length > state.files.length) throw Error("Invalid pending meters update.");
    const seenUpdates = new Set();
    for (const entry of entries) {
      if (!entry || !HASH.test(entry.previousSha256) || !HASH.test(entry.nextSha256) || entry.previousSha256 === entry.nextSha256 || !state.files.some(owned => owned.relative === entry.relative && owned.sha256 === entry.previousSha256) || seenUpdates.has(entry.relative)) throw Error("Invalid pending meters ownership.");
      validateFile({ relative: entry.relative, sha256: entry.previousSha256 }); seenUpdates.add(entry.relative);
    }
  }
  return state;
}
async function readState(statePath) {
  await assertNoLinks(path.dirname(statePath), path.basename(statePath));
  const bytes = await readOptional(statePath);
  return bytes ? validateState(JSON.parse(bytes.toString("utf8"))) : null;
}
async function categoryBytes(roots) {
  await assertNoLinks(roots.profile, CATEGORY);
  const bytes = await readOptional(inside(roots.profile, CATEGORY));
  if (!bytes) throw Error("Install the existing Darthspader WaveShape category first; nothing was created or replaced.");
  categoryDocument(bytes);
  return bytes;
}
async function planInstall({ source = __dirname, roots, statePath }) {
  const state = await readState(statePath), files = await sourceFiles(source), original = await categoryBytes(roots);
  if (state?.stage === "updating") throw Error("Finish the pending meters update before installing again.");
  if (state && ["removing", "partially-removed"].includes(state.stage)) throw Error("Finish removing the previous meters installation first.");
  if (state) {
    if (files.length !== state.files.length || files.some(entry => !state.files.some(owned => owned.relative === entry.relative && owned.sha256 === entry.sha256))) throw Error("Meters source changed after the installation journal was created; existing files were preserved.");
    if (state.stage === "installing" && ![state.category.beforeSha256, state.category.installedSha256].includes(digest(original))) throw Error("WaveShape category changed during installation; it was preserved.");
  }
  for (const entry of files) {
    await assertNoLinks(roots.install, entry.relative);
    const current = await readOptional(inside(roots.install, entry.relative));
    if (current && (!state || digest(current) !== entry.sha256)) throw Error(`A file already exists or was edited at ${entry.relative}; nothing was replaced.`);
    if (!current && state?.stage === "installed") throw Error("An installed meters file is missing; remove the recorded installation before reinstalling.");
  }
  const patched = appendNames(original);
  return { action: state?.stage === "installed" ? "already-installed" : state ? "resume-install" : "install", packageName: PACKAGE,
    files: files.map(({ relative, sha256 }) => ({ relative, sha256 })), category: CATEGORY,
    addedNames: state ? [...state.category.addedNames] : patched.addedNames,
    categoryBeforeSha256: state?.category.beforeSha256 || digest(original), categoryAfterSha256: state?.category.installedSha256 || digest(patched.bytes),
    preferencesChanged: false, themeChanged: false };
}
async function planUpdate({ source = __dirname, roots, statePath }) {
  const state = await readState(statePath);
  if (!state || !["installed", "updating"].includes(state.stage)) throw Error("Complete the meters installation before updating it.");
  const files = await sourceFiles(source);
  if (files.length !== state.files.length || files.some(file => !state.files.some(owned => owned.relative === file.relative))) throw Error("Meters update must use the exact same owned file set; new or missing files were not adopted.");
  const changes = [];
  for (const file of files) {
    const owned = state.files.find(entry => entry.relative === file.relative), pending = state.pendingUpdate?.entries.find(entry => entry.relative === file.relative);
    if (state.pendingUpdate && file.sha256 !== (pending?.nextSha256 || owned.sha256)) throw Error("Meters source changed during a pending update; restore its intended source before resuming.");
    await assertNoLinks(roots.install, file.relative);
    const bytes = await readOptional(inside(roots.install, file.relative));
    if (!bytes) throw Error(`An owned meters file is missing: ${file.relative}; nothing was replaced.`);
    const hash = digest(bytes);
    if (hash !== owned.sha256 && hash !== pending?.nextSha256) throw Error(`An installed meters file was edited: ${file.relative}; it was preserved.`);
    if (owned.sha256 !== file.sha256) changes.push({ relative: file.relative, previousSha256: owned.sha256, nextSha256: file.sha256 });
  }
  if (state.pendingUpdate) {
    const backupRoot = updateBackupRoot(statePath, state.pendingUpdate.id);
    for (const entry of state.pendingUpdate.entries) {
      await assertNoLinks(backupRoot, entry.relative);
      const bytes = await readOptional(inside(backupRoot, entry.relative));
      if (!bytes || digest(bytes) !== entry.previousSha256) throw Error("Meters update backup is missing or edited; no targets were changed.");
    }
  }
  return { action: state.pendingUpdate ? "resume-update" : changes.length ? "update" : "already-current", packageName: PACKAGE,
    files: files.map(({ relative, sha256 }) => ({ relative, sha256 })), changes,
    categoryChanged: false, preferencesChanged: false, themeChanged: false };
}
async function saveState(statePath, state, exclusive = false) {
  await assertNoLinks(path.dirname(statePath), path.basename(statePath));
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const bytes = JSON.stringify(state, null, 2) + "\n";
  if (exclusive) { await fs.writeFile(statePath, bytes, { flag: "wx" }); return; }
  const temporary = statePath + "." + crypto.randomUUID() + ".tmp";
  try { await fs.writeFile(temporary, bytes, { flag: "wx" }); await fs.rename(temporary, statePath); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function withLock(statePath, fn, isProcessAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }) {
  const lockPath = statePath + ".lock", token = crypto.randomUUID();
  await assertNoLinks(path.dirname(lockPath), path.basename(lockPath));
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ version: 1, token, pid: process.pid }));
  try { await fs.writeFile(lockPath, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = await readOptional(lockPath), parsed = old && JSON.parse(old.toString("utf8"));
    if (!parsed || parsed.version !== 1 || !Number.isInteger(parsed.pid) || parsed.pid < 1 || typeof parsed.token !== "string" || isProcessAlive(parsed.pid)) throw Error("Another meters installer owns the operation lock.");
    if (!(await fs.readFile(lockPath)).equals(old)) throw Error("Meters operation lock changed; retry after the other installer finishes.");
    await fs.unlink(lockPath); await fs.writeFile(lockPath, bytes, { flag: "wx" });
  }
  try { return await fn(); }
  finally { if ((await readOptional(lockPath))?.equals(bytes)) await fs.unlink(lockPath); }
}
async function replaceCategory(roots, before, after, guard) {
  if (before.equals(after)) return;
  await guard(); await assertNoLinks(roots.profile, CATEGORY);
  const target = inside(roots.profile, CATEGORY), temporary = target + ".rh-meters-" + crypto.randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, after, { flag: "wx" });
    if (!(await fs.readFile(target)).equals(before)) throw Error("WaveShape category changed before replacement; it was preserved.");
    await guard(); await assertNoLinks(roots.profile, CATEGORY);
    if (!(await fs.readFile(target)).equals(before)) throw Error("WaveShape category changed before replacement; it was preserved.");
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function install(options) {
  const { source = __dirname, roots, statePath, guard = async () => {}, isProcessAlive } = options;
  await guard();
  return withLock(statePath, async () => {
    const plan = await planInstall({ source, roots, statePath });
    if (plan.action === "already-installed") return { ...plan, installedFiles: 0, categoryChanged: false };
    const files = await sourceFiles(source), original = await categoryBytes(roots);
    if (files.length !== plan.files.length || files.some(entry => !plan.files.some(planned => planned.relative === entry.relative && planned.sha256 === entry.sha256))) throw Error("Meters source changed after preflight; nothing was installed.");
    let state = await readState(statePath);
    if (!state) {
      const patched = appendNames(original);
      if (digest(original) !== plan.categoryBeforeSha256 || digest(patched.bytes) !== plan.categoryAfterSha256) throw Error("WaveShape category changed after preflight; it was preserved.");
      const backup = backupPath(statePath);
      await assertNoLinks(path.dirname(backup), path.basename(backup));
      if (await readOptional(backup)) throw Error("An earlier meters category backup exists without its journal; preserve it for review.");
      state = { version: 1, packageName: PACKAGE, stage: "installing", files: plan.files,
        category: { relative: CATEGORY, beforeSha256: digest(original), installedSha256: digest(patched.bytes), addedNames: patched.addedNames } };
      await guard(); await fs.writeFile(backup, original, { flag: "wx" }); await saveState(statePath, state, true);
    }
    await assertNoLinks(path.dirname(statePath), path.basename(backupPath(statePath)));
    const saved = await readOptional(backupPath(statePath));
    if (!saved || digest(saved) !== state.category.beforeSha256) throw Error("Meters category backup is missing or edited; no targets were changed.");
    const intended = appendNames(saved).bytes;
    if (digest(intended) !== state.category.installedSha256) throw Error("Meters category journal does not match its backup.");
    let installedFiles = 0;
    for (const entry of files) {
      const target = inside(roots.install, entry.relative);
      await guard(); await assertNoLinks(roots.install, entry.relative);
      const current = await readOptional(target);
      if (current) { if (digest(current) !== entry.sha256) throw Error("Meters installed file changed; it was preserved."); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.bytes, { flag: "wx" }); installedFiles++;
    }
    const current = await categoryBytes(roots), hash = digest(current);
    if (![state.category.beforeSha256, state.category.installedSha256].includes(hash)) throw Error("WaveShape category changed during installation; it was preserved.");
    await replaceCategory(roots, current, intended, guard);
    state.stage = "installed"; await saveState(statePath, state);
    return { packageName: PACKAGE, installedFiles, addedNames: [...state.category.addedNames], categoryChanged: !current.equals(intended), preferencesChanged: false, themeChanged: false };
  }, isProcessAlive);
}
async function update(options) {
  const { source = __dirname, roots, statePath, guard = async () => {}, isProcessAlive } = options;
  await guard();
  return withLock(statePath, async () => {
    const plan = await planUpdate({ source, roots, statePath });
    if (!plan.changes.length) return { ...plan, updatedFiles: 0 };
    const files = await sourceFiles(source), state = await readState(statePath);
    if (files.length !== plan.files.length || files.some(entry => !plan.files.some(planned => planned.relative === entry.relative && planned.sha256 === entry.sha256))) throw Error("Meters source changed after update preflight; nothing was updated.");
    if (!state.pendingUpdate) {
      const id = crypto.randomUUID(), backupRoot = updateBackupRoot(statePath, id);
      for (const entry of plan.changes) {
        await guard(); await assertNoLinks(roots.install, entry.relative); await assertNoLinks(backupRoot, entry.relative);
        const current = await readOptional(inside(roots.install, entry.relative));
        if (!current || digest(current) !== entry.previousSha256) throw Error("Meters installed file changed while preparing its update backup; it was preserved.");
        const backup = inside(backupRoot, entry.relative);
        await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.writeFile(backup, current, { flag: "wx" });
      }
      state.stage = "updating"; state.pendingUpdate = { id, entries: plan.changes };
      await guard(); await saveState(statePath, state);
    }
    const backupRoot = updateBackupRoot(statePath, state.pendingUpdate.id);
    let updatedFiles = 0;
    for (const entry of state.pendingUpdate.entries) {
      await guard(); await assertNoLinks(roots.install, entry.relative); await assertNoLinks(backupRoot, entry.relative);
      const backup = await readOptional(inside(backupRoot, entry.relative));
      if (!backup || digest(backup) !== entry.previousSha256) throw Error("Meters update backup changed; existing targets were preserved.");
      const file = files.find(value => value.relative === entry.relative);
      if (!file || digest(file.bytes) !== entry.nextSha256) throw Error("Meters intended update source changed; existing targets were preserved.");
      const target = inside(roots.install, entry.relative), current = await readOptional(target);
      if (!current) throw Error("An owned meters file disappeared during update; nothing was recreated.");
      const hash = digest(current);
      if (hash === entry.nextSha256) continue;
      if (hash !== entry.previousSha256) throw Error("An installed meters file changed during update; it was preserved.");
      const temporary = target + ".rh-meters-update-" + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, file.bytes, { flag: "wx" });
        await guard(); await assertNoLinks(roots.install, entry.relative);
        if (!(await fs.readFile(target)).equals(current)) throw Error("Meters installed file changed before update replacement; it was preserved.");
        await fs.rename(temporary, target); updatedFiles++;
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }
    const completed = state.pendingUpdate;
    for (const entry of completed.entries) state.files.find(file => file.relative === entry.relative).sha256 = entry.nextSha256;
    state.updates = [...(state.updates || []), { id: completed.id, entries: completed.entries }];
    delete state.pendingUpdate; state.stage = "installed"; await saveState(statePath, state);
    return { packageName: PACKAGE, updatedFiles, plannedFiles: completed.entries.length, backupDirectory: backupRoot,
      categoryChanged: false, preferencesChanged: false, themeChanged: false };
  }, isProcessAlive);
}
async function remove(options) {
  const { roots, statePath, guard = async () => {}, isProcessAlive } = options;
  await guard();
  return withLock(statePath, async () => {
    const state = await readState(statePath);
    if (!state) return { removedFiles: 0, preserved: [], categoryChanged: false };
    // Validate every target before removing even the first one.
    for (const entry of state.files) await assertNoLinks(roots.install, entry.relative);
    await assertNoLinks(roots.profile, CATEGORY);
    const original = await readOptional(inside(roots.profile, CATEGORY));
    // A user may have removed the old category independently. Preserve that
    // deletion while still allowing this separate package to be uninstalled.
    let next = original ? removeNames(original, state.category.addedNames) : null;
    // If no one has edited the category since install, restore its exact bytes.
    // Otherwise remove only our added names from the user's current document.
    if (original && digest(original) === state.category.installedSha256) {
      await assertNoLinks(path.dirname(statePath), path.basename(backupPath(statePath)));
      const saved = await readOptional(backupPath(statePath));
      if (!saved || digest(saved) !== state.category.beforeSha256) throw Error("Meters category backup is missing or edited; nothing was removed.");
      next = saved;
    }
    state.stage = "removing"; await saveState(statePath, state);
    if (original) await replaceCategory(roots, original, next, guard);
    const remaining = [], directories = new Set(); let removedFiles = 0;
    for (const entry of state.files) {
      await guard(); await assertNoLinks(roots.install, entry.relative);
      const target = inside(roots.install, entry.relative), bytes = await readOptional(target);
      const pending = state.pendingUpdate?.entries.find(update => update.relative === entry.relative);
      if (bytes && digest(bytes) !== entry.sha256 && digest(bytes) !== pending?.nextSha256) { remaining.push(entry); continue; }
      if (bytes) { await fs.unlink(target); removedFiles++; }
      const minimum = path.resolve(roots.install, "Packages", PACKAGE); let directory = path.dirname(target);
      while (directory === minimum || directory.startsWith(minimum + path.sep)) { directories.add(directory); directory = path.dirname(directory); }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await fs.rmdir(directory).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
    if (remaining.length) {
      state.stage = "partially-removed"; state.files = remaining;
      if (state.pendingUpdate) {
        state.pendingUpdate.entries = state.pendingUpdate.entries.filter(entry => remaining.some(file => file.relative === entry.relative));
        if (!state.pendingUpdate.entries.length) delete state.pendingUpdate;
      }
      await saveState(statePath, state);
    }
    else {
      await fs.unlink(statePath);
      const backup = backupPath(statePath);
      await assertNoLinks(path.dirname(backup), path.basename(backup));
      const saved = await readOptional(backup);
      if (saved && digest(saved) === state.category.beforeSha256) await fs.unlink(backup);
    }
    return { packageName: PACKAGE, removedFiles, preserved: remaining.map(entry => entry.relative), categoryChanged: !!original && !next.equals(original), preferencesChanged: false, themeChanged: false };
  }, isProcessAlive);
}
function assertNativeClosed(run = execFileSync) {
  const count = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-Process -Name 'G-Force Standalone','G-Force Standalone.x64','G-Force Toolbar' -ErrorAction SilentlyContinue).Count"], { encoding: "utf8", windowsHide: true }).trim();
  if (count !== "0") throw Error("Close G-Force Standalone and G-Force Toolbar before changing the meters add-on. Music can keep playing.");
}
async function main() {
  const action = process.argv[2];
  if (!["plan", "plan-update", "install", "update", "remove"].includes(action)) throw Error("Usage: node install.cjs plan|plan-update|install|update|remove");
  if (process.platform !== "win32") throw Error("This optional meters add-on requires Windows.");
  const appData = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"], { encoding: "utf8", windowsHide: true }).trim();
  if (!appData || !path.isAbsolute(appData)) throw Error("The current Windows account's profile was not resolved.");
  const options = { roots: { install: path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "SoundSpectrum", "G-Force"), profile: path.join(appData, "SoundSpectrum", "G-Force") }, statePath: path.resolve(__dirname, "../../data/soundspectrum-meters-install.json"), guard: async () => assertNativeClosed() };
  console.log(JSON.stringify(await ({ plan: planInstall, "plan-update": planUpdate, install, update, remove }[action])(options), null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { PACKAGE, NAMES, CATEGORY, digest, inside, appendNames, removeNames, planInstall, planUpdate, install, update, remove, assertNativeClosed };
