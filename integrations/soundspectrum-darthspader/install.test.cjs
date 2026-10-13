"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { install, remove, update, addCategories, changeStartup, inside, digest } = require("./install.cjs");

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rh-darthspader-"));
  t.after(async () => {
    // The fully resolved temporary root is checked before recursive removal.
    assert.ok(temp.startsWith(path.resolve(os.tmpdir()) + path.sep + "rh-darthspader-"));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const roots = { install: path.join(temp, "native"), profile: path.join(temp, "profile") };
  const statePath = path.join(temp, "state/install.json"), source = path.join(temp, "source");
  await fs.mkdir(roots.profile, { recursive: true });
  const preferences = path.join(roots.profile, "Preferences (Standalone).txt");
  const original = Buffer.from('Audio.InputSource = "Keep exact input"\r\nPrefs.Version = 500\r\nTheme.StartupTheme = "Custom 1"\r\n');
  await fs.writeFile(preferences, original);
  const relative = "Packages/RabbitHole.Darthspader.package/WaveShapes/Rabbit Hole - darthspader.txt";
  const packageFile = path.join(source, relative.replace("Packages/", ""));
  await fs.mkdir(path.dirname(packageFile), { recursive: true });
  await fs.writeFile(packageFile, 'X0="s"\nY0="mag(s)"\n');
  await fs.mkdir(path.join(source, "profile/Themes"), { recursive: true });
  await fs.writeFile(path.join(source, "profile/Themes/Rabbit Hole - darthspader.txt"), 'Version = 1\n');
  return { roots, statePath, source, preferences, original, target: inside(roots.install, relative) };
}

test("install and remove restore original startup and exact audio preferences", async t => {
  const f = await fixture(t);
  assert.equal((await install(f)).installedFiles, 2);
  assert.match((await fs.readFile(f.preferences)).toString(), /Theme.StartupTheme = "Rabbit Hole - darthspader"/);
  assert.equal((await remove(f)).removedFiles, 2);
  assert.deepEqual(await fs.readFile(f.preferences), f.original);
  await assert.rejects(fs.access(f.statePath), { code: "ENOENT" });
});

test("existing unrelated files prevent all installation writes", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.target), { recursive: true });
  await fs.writeFile(f.target, "User file");
  await assert.rejects(install(f), /already exists/);
  assert.deepEqual(await fs.readFile(f.preferences), f.original);
  await assert.rejects(fs.access(f.statePath), { code: "ENOENT" });
});

test("removal preserves later audio changes, selected theme changes and modified add-on files", async t => {
  const f = await fixture(t);
  await install(f);
  await fs.writeFile(f.target, "User edited preset");
  await fs.writeFile(f.preferences, 'Prefs.Version = 500\nAudio.InputSource = "New exact input"\nTheme.StartupTheme = "User theme"\n');
  const result = await remove(f);
  assert.equal(result.preserved.length, 1);
  assert.equal(result.startupRestored, false);
  assert.equal(await fs.readFile(f.target, "utf8"), "User edited preset");
  assert.match(await fs.readFile(f.preferences, "utf8"), /User theme/);
});

test("UTF-16 BOM and non-ASCII preferences survive startup roundtrip", () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Prefs.Version = 500\r\nAudio.InputSource = "Mikrofón"\r\nTheme.StartupTheme = "旧"\r\n', "utf16le")]);
  const changed = changeStartup(bytes);
  assert.deepEqual(changeStartup(changed.bytes, changed.saved).bytes, bytes);
});

test("tampered ownership paths cannot remove files outside the package", async t => {
  const f = await fixture(t);
  await install(f);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  state.entries[0].relative = "Packages/RabbitHole.Darthspader.package/../../private.txt";
  await fs.writeFile(f.statePath, JSON.stringify(state));
  await assert.rejects(remove(f), /Invalid add-on path/);
  assert.equal(await fs.readFile(f.target, "utf8"), 'X0="s"\nY0="mag(s)"\n');
});

test("update replaces owned configs, preserves preferences and keeps removal history", async t => {
  const f = await fixture(t);
  await install(f);
  const before = await fs.readFile(f.preferences);
  const old = await fs.readFile(f.target);
  const source = path.join(f.source, "RabbitHole.Darthspader.package/WaveShapes/Rabbit Hole - darthspader.txt");
  await fs.writeFile(source, 'X0="s"\nY0=".3*mag(s)"\n');
  assert.equal((await update(f)).updatedFiles, 1);
  assert.deepEqual(await fs.readFile(f.preferences), before);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(state.stage, "installed");
  assert.equal(state.startup.original, 'Theme.StartupTheme = "Custom 1"\r\n');
  assert.deepEqual(await fs.readFile(path.join(state.updates[0].backup, state.entries.find(e => e.root === "install").relative)), old);
  assert.equal((await update(f)).updatedFiles, 0);
  await remove(f);
  assert.deepEqual(await fs.readFile(f.preferences), f.original);
});

test("update refuses edited installed files before writing configs or preferences", async t => {
  const f = await fixture(t);
  await install(f);
  const before = await fs.readFile(f.preferences), record = await fs.readFile(f.statePath);
  await fs.writeFile(f.target, "User-edited waveform");
  await assert.rejects(update(f), /edited/);
  assert.equal(await fs.readFile(f.target, "utf8"), "User-edited waveform");
  assert.deepEqual(await fs.readFile(f.preferences), before);
  assert.deepEqual(await fs.readFile(f.statePath), record);
});

test("update resumes after config replacement interrupted manifest completion", async t => {
  const f = await fixture(t);
  await install(f);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  const entry = state.entries.find(e => e.root === "install");
  const next = Buffer.from('X0="s"\nY0="fft(s)"\n');
  await fs.writeFile(path.join(f.source, entry.relative.slice("Packages/".length)), next);
  await fs.writeFile(f.target, next);
  state.stage = "updating";
  state.pendingUpdate = { backup: path.join(path.dirname(f.statePath), "prior-backup"), entries: [{ ...entry, nextSha256: digest(next) }] };
  await fs.writeFile(f.statePath, JSON.stringify(state));
  assert.equal((await update(f)).updatedFiles, 1);
  const completed = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(completed.stage, "installed");
  assert.equal(completed.pendingUpdate, undefined);
  await remove(f);
  assert.deepEqual(await fs.readFile(f.preferences), f.original);
});

test("removal recovers owned replacement after an interrupted update", async t => {
  const f = await fixture(t);
  await install(f);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  const entry = state.entries.find(e => e.root === "install");
  const next = Buffer.from('X0="s"\nY0="fft(s)"\n');
  await fs.writeFile(f.target, next);
  state.stage = "updating";
  state.pendingUpdate = { backup: path.join(path.dirname(f.statePath), "prior-backup"), entries: [{ ...entry, nextSha256: digest(next) }] };
  await fs.writeFile(f.statePath, JSON.stringify(state));
  const result = await remove(f);
  assert.equal(result.removedFiles, 2);
  assert.deepEqual(result.preserved, []);
  assert.deepEqual(await fs.readFile(f.preferences), f.original);
  await assert.rejects(fs.access(f.target), { code: "ENOENT" });
  await assert.rejects(fs.access(f.statePath), { code: "ENOENT" });
});

const categoryRelative = type => `Categories/${type}/Rabbit Hole - darthspader.txt`;
async function categorySources(f, types = ["Particle", "Sprite"]) {
  for (const type of types) {
    const target = path.join(f.source, "profile", categoryRelative(type));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'CategoryTitle = "Rabbit Hole - darthspader"\nCategoryFlags = 0\nVersion = 1\nInclude.List = "\n"\nExclude.List = "\n"\n');
  }
}

test("category migration preserves edited theme/categories/package/preferences and original removal history", async t => {
  const f = await fixture(t);
  await categorySources(f, ["WaveShape", "ColorMap", "FlowField"]);
  await install(f);
  await categorySources(f);
  const theme = path.join(f.roots.profile, "Themes/Rabbit Hole - darthspader.txt");
  const userFiles = [[theme, "User-edited theme"], [f.target, "User-edited package"],
    ...["WaveShape", "ColorMap", "FlowField"].map(type => [path.join(f.roots.profile, categoryRelative(type)), `User-edited ${type} selection`])];
  for (const [file, text] of userFiles) await fs.writeFile(file, text);
  const prefs = Buffer.from('Prefs.Version = 500\nAudio.InputSource = "New exact input"\nTheme.StartupTheme = "Rabbit Hole - darthspader"\n');
  await fs.writeFile(f.preferences, prefs);
  const before = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  before.updates = [{ backup: "existing-private-backup", updatedFiles: 1 }];
  await fs.writeFile(f.statePath, JSON.stringify(before));
  const result = await addCategories(f);
  assert.deepEqual(result, { addedFiles: 2, preserved: [], preferencesChanged: false });
  for (const [file, text] of userFiles) assert.equal(await fs.readFile(file, "utf8"), text);
  assert.deepEqual(await fs.readFile(f.preferences), prefs);
  const after = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
  assert.deepEqual(after.startup, before.startup);
  assert.deepEqual(after.updates, before.updates);
  assert.equal(after.entries.length, before.entries.length + 2);
  assert.equal(after.stage, "installed"); assert.equal(after.pendingCategories, undefined);
});

test("category addition rerun preserves edited added categories and removal protects them", async t => {
  const f = await fixture(t);
  await install(f); await categorySources(f); await addCategories(f);
  const particle = path.join(f.roots.profile, categoryRelative("Particle"));
  await fs.writeFile(particle, "User's selected particles");
  const record = await fs.readFile(f.statePath);
  assert.deepEqual(await addCategories(f), { addedFiles: 0, preserved: [categoryRelative("Particle")], preferencesChanged: false });
  assert.deepEqual(await fs.readFile(f.statePath), record);
  const result = await remove(f);
  assert.deepEqual(result.preserved, [categoryRelative("Particle")]);
  assert.equal(await fs.readFile(particle, "utf8"), "User's selected particles");
  await assert.rejects(fs.access(path.join(f.roots.profile, categoryRelative("Sprite"))), { code: "ENOENT" });
});

test("unowned category collision refuses both additions without adopting matching bytes", async t => {
  const f = await fixture(t);
  await install(f); await categorySources(f);
  const sprite = path.join(f.roots.profile, categoryRelative("Sprite"));
  await fs.mkdir(path.dirname(sprite), { recursive: true });
  const bytes = await fs.readFile(path.join(f.source, "profile", categoryRelative("Sprite")));
  await fs.writeFile(sprite, bytes);
  const record = await fs.readFile(f.statePath), prefs = await fs.readFile(f.preferences);
  await assert.rejects(addCategories(f), /already exists/);
  assert.deepEqual(await fs.readFile(sprite), bytes);
  assert.deepEqual(await fs.readFile(f.statePath), record);
  assert.deepEqual(await fs.readFile(f.preferences), prefs);
  await assert.rejects(fs.access(path.join(f.roots.profile, categoryRelative("Particle"))), { code: "ENOENT" });
});

async function interruptedCategories(f) {
  await install(f); await categorySources(f);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  const entries = [];
  for (const type of ["Particle", "Sprite"]) {
    const relative = categoryRelative(type), bytes = await fs.readFile(path.join(f.source, "profile", relative));
    entries.push({ root: "profile", relative, sha256: digest(bytes) });
  }
  state.entries.push(...entries); state.stage = "adding-categories";
  state.pendingCategories = { entries };
  await fs.writeFile(f.statePath, JSON.stringify(state));
  const relative = categoryRelative("Particle"), target = path.join(f.roots.profile, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(f.source, "profile", relative), target);
}

test("interrupted category creation resumes missing files or removes created ownership safely", async t => {
  const f = await fixture(t); await interruptedCategories(f);
  assert.equal((await addCategories(f)).addedFiles, 1);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(state.stage, "installed"); assert.equal(state.pendingCategories, undefined);
  assert.equal(new Set(state.entries.map(entry => `${entry.root}/${entry.relative}`)).size, state.entries.length);
  const g = await fixture(t); await interruptedCategories(g);
  assert.equal((await remove(g)).removedFiles, 3);
  assert.deepEqual(await fs.readFile(g.preferences), g.original);
  await assert.rejects(fs.access(g.statePath), { code: "ENOENT" });
});

test("interrupted addition refuses source drift before creating any remaining category", async t => {
  const f = await fixture(t); await interruptedCategories(f);
  const record = await fs.readFile(f.statePath), particle = await fs.readFile(path.join(f.roots.profile, categoryRelative("Particle")));
  await fs.appendFile(path.join(f.source, "profile", categoryRelative("Sprite")), "// Changed after interruption\n");
  await assert.rejects(addCategories(f), /source changed during an interrupted addition/);
  assert.deepEqual(await fs.readFile(f.statePath), record);
  assert.deepEqual(await fs.readFile(path.join(f.roots.profile, categoryRelative("Particle"))), particle);
  await assert.rejects(fs.access(path.join(f.roots.profile, categoryRelative("Sprite"))), { code: "ENOENT" });
  assert.equal((await remove(f)).removedFiles, 3);
});

test("edited interrupted category is preserved and removal keeps a valid filtered journal", async t => {
  const f = await fixture(t); await interruptedCategories(f);
  const particle = path.join(f.roots.profile, categoryRelative("Particle"));
  await fs.writeFile(particle, "User edited interrupted category");
  await assert.rejects(addCategories(f), /category changed during interrupted addition/);
  assert.deepEqual((await remove(f)).preserved, [categoryRelative("Particle")]);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.deepEqual(state.pendingCategories.entries.map(entry => entry.relative), [categoryRelative("Particle")]);
  assert.deepEqual((await remove(f)).preserved, [categoryRelative("Particle")]);
});

test("source category junction is refused before ownership or profile writes", async t => {
  const f = await fixture(t); await install(f); await categorySources(f);
  const folder = path.dirname(path.join(f.source, "profile", categoryRelative("Sprite"))), linked = folder + "-linked";
  await fs.rename(folder, linked);
  await fs.symlink(linked, folder, process.platform === "win32" ? "junction" : "dir");
  const record = await fs.readFile(f.statePath);
  await assert.rejects(addCategories(f), /symbolic link/);
  assert.deepEqual(await fs.readFile(f.statePath), record);
  await assert.rejects(fs.access(path.join(f.roots.profile, categoryRelative("Particle"))), { code: "ENOENT" });
});

test("pending category ownership cannot escape the two exact named profile paths", async t => {
  const f = await fixture(t); await interruptedCategories(f);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  state.pendingCategories.entries[0].relative = "Categories/Particle/Another Category.txt";
  await fs.writeFile(f.statePath, JSON.stringify(state));
  const record = await fs.readFile(f.statePath), prefs = await fs.readFile(f.preferences);
  await assert.rejects(addCategories(f), /Unexpected installed profile path/);
  await assert.rejects(remove(f), /Unexpected installed profile path/);
  assert.deepEqual(await fs.readFile(f.statePath), record);
  assert.deepEqual(await fs.readFile(f.preferences), prefs);
});
