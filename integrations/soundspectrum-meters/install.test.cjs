"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PACKAGE, NAMES, CATEGORY, digest, inside, appendNames, removeNames, planInstall, planUpdate, install, update, remove, assertNativeClosed } = require("./install.cjs");

const category = (members = ["Rabbit Hole - darthspader"], newline = "\r\n") => [
  'About = "User note"', 'CategoryTitle = "Rabbit Hole - darthspader"', 'CategoryFlags = 0', 'Version = 1',
  'Include.ConfigFlagMatchMask = 0', 'Include.ConfigFlagSelectMask = 6', 'Include.Pattern = ""', 'Exclude.Pattern = ""',
  'Include.List = "', ...members, '"', 'Exclude.List = "', 'Bass Bars', '"', 'LastModified = 0x6AC604B3', ""
].join(newline);

async function fixture(t, { colors = true, scripts = true, members, bytes } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rh-meters-install-"));
  t.after(async () => {
    const resolved = path.resolve(temp), allowed = path.resolve(os.tmpdir()) + path.sep + "rh-meters-install-";
    assert.ok(resolved.startsWith(allowed) && resolved.length > allowed.length);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const roots = { install: path.join(temp, "native"), profile: path.join(temp, "profile") };
  const source = path.join(temp, "source"), statePath = path.join(temp, "state", "meters.json");
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
  await write(path.join(source, PACKAGE, "_package.py"), "def ExportPackage(inPathname):\n    return VisPackage(inPathname)\n");
  for (const name of NAMES) {
    await write(path.join(source, PACKAGE, "WaveShapes", name + ".txt"), `// ${name}\nX0=\"s\"\nY0=\"mag(s)\"\n`);
    if (colors) await write(path.join(source, PACKAGE, "ColorMaps", name + ".txt"), 'H=".5"\nS="1"\nV="i"\n');
    if (scripts) await write(path.join(source, "Scripts", name + ".py"), `vis.StartConfig(0, 'WaveShape', '${name}')\n`);
  }
  const categoryFile = inside(roots.profile, CATEGORY), original = bytes || Buffer.from(category(members));
  await write(categoryFile, original);
  const protectedFiles = new Map([
    [path.join(roots.profile, "Preferences (Standalone).txt"), Buffer.from('Audio.InputSource = "Keep exact audio input"\nTheme.StartupTheme = "Rabbit Hole - darthspader"\n')],
    [path.join(roots.profile, "Themes/Rabbit Hole - darthspader.txt"), Buffer.from('WaveShape.CategoryExpr = "+Rabbit Hole - darthspader"\nParticle.CategoryExpr = "+Reactive"\n')],
    [path.join(roots.install, "Packages/RabbitHole.Darthspader.package/_package.py"), Buffer.from("Legacy loader\n")],
    [path.join(roots.install, "Packages/RabbitHole.Darthspader.package/WaveShapes/Rabbit Hole - darthspader.txt"), Buffer.from("Legacy lettering\n")],
    [path.join(temp, "state/soundspectrum-darthspader-install.json"), Buffer.from('{"legacy":"original history"}\n')]
  ]);
  for (const type of ["Particle", "Sprite", "ColorMap", "FlowField"]) protectedFiles.set(path.join(roots.profile, `Categories/${type}/Rabbit Hole - darthspader.txt`), Buffer.from(`${type} user members\n`));
  for (const [file, content] of protectedFiles) await write(file, content);
  const assertProtected = async () => { for (const [file, content] of protectedFiles) assert.deepEqual(await fs.readFile(file), content, file); };
  return { roots, source, statePath, categoryFile, original, protectedFiles, assertProtected, write, temp,
    firstShape: path.join(roots.install, "Packages", PACKAGE, "WaveShapes", NAMES[0] + ".txt") };
}
async function missing(file) { await assert.rejects(fs.access(file), { code: "ENOENT" }); }

test("plan reads only and identifies the separate package plus exact scripts and category additions", async t => {
  const f = await fixture(t), plan = await planInstall(f);
  assert.equal(plan.packageName, PACKAGE); assert.equal(plan.files.length, 10); assert.deepEqual(plan.addedNames, NAMES);
  assert.equal(plan.preferencesChanged, false); assert.equal(plan.themeChanged, false);
  assert.equal(plan.files.filter(file => file.relative.startsWith("Scripts/")).length, 3);
  await missing(f.statePath); await missing(f.statePath + ".category-before"); await missing(f.firstShape);
  assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
});

test("install and removal roundtrip exact category bytes without changing the legacy package, theme, preferences or categories", async t => {
  const f = await fixture(t), added = await install(f);
  assert.equal(added.installedFiles, 10); assert.deepEqual(added.addedNames, NAMES);
  const patched = await fs.readFile(f.categoryFile), state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.deepEqual(patched, appendNames(f.original).bytes); assert.deepEqual(await fs.readFile(f.statePath + ".category-before"), f.original);
  assert.equal(state.stage, "installed"); assert.equal(state.category.beforeSha256, digest(f.original));
  await f.assertProtected();
  const result = await remove(f); assert.equal(result.removedFiles, 10); assert.deepEqual(result.preserved, []);
  assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
  await missing(f.statePath); await missing(f.statePath + ".category-before"); await missing(f.firstShape);
});

test("existing category names are never claimed, duplicated or removed", async t => {
  const f = await fixture(t, { colors: false, scripts: false, members: ["Rabbit Hole - darthspader", NAMES[1], "Circle"] });
  const result = await install(f); assert.equal(result.installedFiles, 4); assert.deepEqual(result.addedNames, [NAMES[0], NAMES[2]]);
  const current = (await fs.readFile(f.categoryFile, "utf8")).replace('About = "User note"', 'About = "Later note"').replace("Circle\r\n", "Circle\r\nLater WaveShape\r\n");
  await fs.writeFile(f.categoryFile, current); await remove(f);
  const next = await fs.readFile(f.categoryFile, "utf8"); assert.match(next, /Later WaveShape/); assert.match(next, /Later note/);
  assert.ok(next.includes(NAMES[1])); assert.ok(!next.includes(NAMES[0])); assert.ok(!next.includes(NAMES[2])); assert.match(next, /Exclude.List = "\r\nBass Bars\r\n"/);
  await f.assertProtected();
});

test("existing target conflicts reject all install targets before the ownership journal or category changes", async t => {
  const f = await fixture(t); await f.write(f.firstShape, "Existing user's preset");
  await assert.rejects(install(f), /already exists or was edited/);
  assert.equal(await fs.readFile(f.firstShape, "utf8"), "Existing user's preset"); assert.deepEqual(await fs.readFile(f.categoryFile), f.original);
  await missing(f.statePath); await missing(f.statePath + ".category-before"); await f.assertProtected();
});

test("unknown package files and unknown scripts are rejected before journal or target writes", async t => {
  for (const extra of [`${PACKAGE}/WaveShapes/Unknown.txt`, "Scripts/Key 1.py", "Scripts/nested/Rabbit Hole - Emerald VU.py"]) {
    const f = await fixture(t); await f.write(path.join(f.source, extra), "Unowned source");
    await assert.rejects(install(f), /unexpected package file|unexpected script/);
    await missing(f.statePath); await missing(f.firstShape); assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
  }
});

test("interrupted install resumes its exact journal and existing unchanged files", async t => {
  const f = await fixture(t); let failed = false;
  const guard = async () => { if (!failed && await fs.access(f.firstShape).then(() => true, () => false)) { failed = true; throw Error("Simulated closed-state guard interruption"); } };
  await assert.rejects(install({ ...f, guard }), /guard interruption/);
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).stage, "installing");
  assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
  const plan = await planInstall(f); assert.equal(plan.action, "resume-install");
  await install(f); assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).stage, "installed");
  assert.deepEqual(await fs.readFile(f.categoryFile), appendNames(f.original).bytes); await remove(f); await f.assertProtected();
});

test("source changes after interruption refuse resume and can still be independently removed", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(install({ ...f, guard: async () => { if (++calls === 4) throw Error("Interrupted"); } }), /Interrupted/);
  await fs.writeFile(path.join(f.source, PACKAGE, "WaveShapes", NAMES[0] + ".txt"), "Different source");
  await assert.rejects(install(f), /source changed/);
  await remove(f); assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
});

test("category edits during interrupted install block resume without losing the edits", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(install({ ...f, guard: async () => { if (++calls === 4) throw Error("Interrupted"); } }), /Interrupted/);
  const edited = Buffer.from(category(["Rabbit Hole - darthspader", "New user member"])); await fs.writeFile(f.categoryFile, edited);
  await assert.rejects(install(f), /category changed during installation/); assert.deepEqual(await fs.readFile(f.categoryFile), edited);
  await remove(f); assert.deepEqual(await fs.readFile(f.categoryFile), edited); await f.assertProtected();
});

test("edited package and script files survive removal while unchanged owned files and own category names are removed", async t => {
  const f = await fixture(t); await install(f);
  const script = path.join(f.roots.install, "Scripts", NAMES[0] + ".py"); await fs.writeFile(f.firstShape, "User-edited shape"); await fs.writeFile(script, "User-edited script");
  const result = await remove(f); assert.equal(result.removedFiles, 8); assert.equal(result.preserved.length, 2);
  assert.equal(await fs.readFile(f.firstShape, "utf8"), "User-edited shape"); assert.equal(await fs.readFile(script, "utf8"), "User-edited script");
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).stage, "partially-removed");
  assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
});

test("tampered ownership cannot touch legacy package, unrelated scripts or profile files", async t => {
  for (const relative of ["Packages/RabbitHole.Darthspader.package/_package.py", "Scripts/Key 1.py", `Packages/${PACKAGE}/../../Preferences.txt`]) {
    const f = await fixture(t); await install(f);
    const state = JSON.parse(await fs.readFile(f.statePath, "utf8")); state.files[0].relative = relative; await fs.writeFile(f.statePath, JSON.stringify(state));
    await assert.rejects(remove(f), /Invalid meters package ownership/); await f.assertProtected(); assert.deepEqual(await fs.readFile(f.categoryFile), appendNames(f.original).bytes);
  }
});

test("UTF-8 BOM, UTF-16 BOM, CRLF/LF and non-ASCII category fields are preserved", () => {
  for (const newline of ["\n", "\r\n"]) for (const encoding of ["utf8", "utf16le"]) {
    const bom = Buffer.from(encoding === "utf16le" ? [0xff, 0xfe] : [0xef, 0xbb, 0xbf]);
    const original = Buffer.concat([bom, Buffer.from(category(["Rabbit Hole - darthspader", "旧の波形"], newline).replace("User note", "Mikrofón 旧"), encoding)]);
    const patched = appendNames(original); assert.deepEqual(removeNames(patched.bytes, patched.addedNames), original);
    assert.deepEqual(patched.bytes.subarray(0, bom.length), bom);
  }
});

test("ambiguous or unsupported category grammar is rejected without category or package writes", async t => {
  for (const value of [category() + 'Include.List = "\n"\n', category().replace('CategoryTitle = "Rabbit Hole - darthspader"', 'CategoryTitle = "Different"'), category().replace('Include.List = "\r\n', 'Include.List = "Inline"\r\n')]) {
    const f = await fixture(t, { bytes: Buffer.from(value) });
    await assert.rejects(install(f), /Include.List|category was not recognized/); await missing(f.statePath); await missing(f.firstShape);
    assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
  }
});

test("closed-state guards block every CLI write path and check both Standalone variants plus Toolbar without starting anything", async t => {
  const f = await fixture(t); await assert.rejects(install({ ...f, guard: async () => { throw Error("Still open"); } }), /Still open/); await missing(f.statePath); await missing(f.firstShape);
  let command;
  assertNativeClosed((file, args, options) => { command = { file, args, options }; return "0\r\n"; });
  assert.equal(command.file, "powershell.exe"); assert.equal(command.options.windowsHide, true);
  assert.match(command.args.at(-1), /G-Force Standalone\.x64/); assert.match(command.args.at(-1), /G-Force Toolbar/);
  assert.throws(() => assertNativeClosed(() => "1\r\n"), /Close G-Force/); assert.throws(() => assertNativeClosed(() => "unexpected"), /Close G-Force/);
  await install(f); await assert.rejects(remove({ ...f, guard: async () => { throw Error("Still open"); } }), /Still open/);
  assert.deepEqual(await fs.readFile(f.categoryFile), appendNames(f.original).bytes); await f.assertProtected();
});

test("an already installed package is idempotent and leaves later category edits untouched", async t => {
  const f = await fixture(t); await install(f);
  const edited = Buffer.from((await fs.readFile(f.categoryFile, "utf8")).replace("User note", "Later note")); await fs.writeFile(f.categoryFile, edited);
  const result = await install(f); assert.equal(result.action, "already-installed"); assert.equal(result.installedFiles, 0); assert.equal(result.categoryChanged, false);
  assert.deepEqual(await fs.readFile(f.categoryFile), edited); await f.assertProtected();
});

test("an interrupted install can be removed without finishing it and only journals its own additions", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(install({ ...f, guard: async () => { if (++calls === 4) throw Error("Interrupted"); } }), /Interrupted/);
  await remove(f); assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await missing(f.statePath); await f.assertProtected();
});

test("a same-installation operation lock rejects parallel installers and can reclaim a confirmed dead owner", async t => {
  const f = await fixture(t), lock = f.statePath + ".lock"; await f.write(lock, JSON.stringify({ version: 1, token: "old-owner", pid: 1234 }));
  await assert.rejects(install({ ...f, isProcessAlive: () => true }), /owns the operation lock/); await missing(f.firstShape);
  await install({ ...f, isProcessAlive: () => false }); await missing(lock); await f.assertProtected();
});

test("a user-deleted legacy category is not recreated and does not prevent independent package removal", async t => {
  const f = await fixture(t); await install(f); await fs.unlink(f.categoryFile);
  const result = await remove(f); assert.equal(result.removedFiles, 10); assert.equal(result.categoryChanged, false);
  await missing(f.categoryFile); await missing(f.statePath); await missing(f.firstShape); await f.assertProtected();
});

test("a category edit during the last closed-state guard is rechecked before replacement", async t => {
  const f = await fixture(t); let edited;
  const guard = async () => {
    if (!edited && (await fs.readdir(path.dirname(f.categoryFile))).some(name => name.includes(".rh-meters-"))) {
      edited = Buffer.from(category(["Rabbit Hole - darthspader", "User's concurrent member"])); await fs.writeFile(f.categoryFile, edited);
    }
  };
  await assert.rejects(install({ ...f, guard }), /category changed before replacement/);
  assert.deepEqual(await fs.readFile(f.categoryFile), edited); await remove(f);
  assert.deepEqual(await fs.readFile(f.categoryFile), edited); await f.assertProtected();
});

async function correctedSources(f) {
  const shapeRelative = `Packages/${PACKAGE}/WaveShapes/${NAMES[0]}.txt`, scriptRelative = `Scripts/${NAMES[0]}.py`;
  const shape = Buffer.from('// Corrected stroke\nX0="s"\nY0=".4*mag(s)"\n'), script = Buffer.from(`vis.StartConfig(0, 'WaveShape', '${NAMES[0]}')\nvis.StartConfig(0, 'ColorMap', '${NAMES[0]}')\n`);
  await fs.writeFile(path.join(f.source, PACKAGE, "WaveShapes", NAMES[0] + ".txt"), shape);
  await fs.writeFile(path.join(f.source, "Scripts", NAMES[0] + ".py"), script);
  return { shapeRelative, scriptRelative, shape, script };
}

test("update plan exposes exact old/new owned hashes without changing receipts, category or installed files", async t => {
  const f = await fixture(t); await install(f); const receipt = await fs.readFile(f.statePath), original = await fs.readFile(f.firstShape);
  const next = await correctedSources(f), plan = await planUpdate(f);
  assert.equal(plan.action, "update"); assert.equal(plan.changes.length, 2);
  assert.deepEqual(plan.changes.find(entry => entry.relative === next.shapeRelative), { relative: next.shapeRelative, previousSha256: digest(original), nextSha256: digest(next.shape) });
  assert.equal(plan.categoryChanged, false); assert.equal(plan.themeChanged, false); assert.equal(plan.preferencesChanged, false);
  assert.deepEqual(await fs.readFile(f.statePath), receipt); assert.deepEqual(await fs.readFile(f.firstShape), original);
  assert.deepEqual(await fs.readFile(f.categoryFile), appendNames(f.original).bytes); await f.assertProtected();
});

test("explicit update backs up and replaces only changed owned files, preserves user category edits and remains independently removable", async t => {
  const f = await fixture(t); await install(f);
  const originalShape = await fs.readFile(f.firstShape), scriptTarget = path.join(f.roots.install, "Scripts", NAMES[0] + ".py"), originalScript = await fs.readFile(scriptTarget);
  const edited = Buffer.from((await fs.readFile(f.categoryFile, "utf8")).replace("User note", "Keep later user note")); await fs.writeFile(f.categoryFile, edited);
  const next = await correctedSources(f), result = await update(f);
  assert.equal(result.updatedFiles, 2); assert.equal(result.plannedFiles, 2); assert.equal(result.categoryChanged, false);
  assert.deepEqual(await fs.readFile(f.firstShape), next.shape); assert.deepEqual(await fs.readFile(scriptTarget), next.script);
  assert.deepEqual(await fs.readFile(path.join(result.backupDirectory, next.shapeRelative)), originalShape);
  assert.deepEqual(await fs.readFile(path.join(result.backupDirectory, next.scriptRelative)), originalScript);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8")); assert.equal(state.stage, "installed"); assert.equal(state.pendingUpdate, undefined); assert.equal(state.updates.length, 1);
  assert.equal(state.files.find(entry => entry.relative === next.shapeRelative).sha256, digest(next.shape));
  assert.deepEqual(await fs.readFile(f.categoryFile), edited); await f.assertProtected();
  assert.equal((await update(f)).updatedFiles, 0); assert.equal((await remove(f)).removedFiles, 10);
  const remainingCategory = await fs.readFile(f.categoryFile, "utf8"); assert.match(remainingCategory, /Keep later user note/); for (const name of NAMES) assert.ok(!remainingCategory.includes(name));
  await f.assertProtected();
});

test("update refuses any edited owned file before replacing even another valid changed file", async t => {
  const f = await fixture(t); await install(f); const receipt = await fs.readFile(f.statePath), original = await fs.readFile(f.firstShape);
  await correctedSources(f); const script = path.join(f.roots.install, "Scripts", NAMES[2] + ".py"); await fs.writeFile(script, "User edited this script");
  await assert.rejects(update(f), /installed meters file was edited/);
  assert.deepEqual(await fs.readFile(f.statePath), receipt); assert.deepEqual(await fs.readFile(f.firstShape), original); assert.equal(await fs.readFile(script, "utf8"), "User edited this script");
  await f.assertProtected();
});

test("update cannot adopt additional optional files or lose recorded scripts from its owned file set", async t => {
  const f = await fixture(t, { colors: false }); await install(f); const receipt = await fs.readFile(f.statePath);
  await f.write(path.join(f.source, PACKAGE, "ColorMaps", NAMES[0] + ".txt"), 'H=".3"\n');
  await assert.rejects(update(f), /exact same owned file set/); assert.deepEqual(await fs.readFile(f.statePath), receipt);
  await fs.unlink(path.join(f.source, PACKAGE, "ColorMaps", NAMES[0] + ".txt")); await fs.unlink(path.join(f.source, "Scripts", NAMES[1] + ".py"));
  await assert.rejects(update(f), /exact same owned file set/); assert.deepEqual(await fs.readFile(f.statePath), receipt); await f.assertProtected();
});

test("an interrupted update resumes unchanged intended sources with both old and already-replaced files", async t => {
  const f = await fixture(t); await install(f); const next = await correctedSources(f); let interrupted = false;
  const guard = async () => { if (!interrupted && digest(await fs.readFile(f.firstShape)) === digest(next.shape)) { interrupted = true; throw Error("Interrupted after first replacement"); } };
  await assert.rejects(update({ ...f, guard }), /Interrupted after first replacement/);
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).stage, "updating"); assert.equal((await planUpdate(f)).action, "resume-update");
  const result = await update(f); assert.equal(result.updatedFiles, 1); assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).stage, "installed");
  assert.deepEqual(await fs.readFile(f.firstShape), next.shape); assert.deepEqual(await fs.readFile(path.join(f.roots.install, next.scriptRelative)), next.script);
  assert.deepEqual(await fs.readFile(f.categoryFile), appendNames(f.original).bytes); await f.assertProtected();
});

test("a different source revision cannot resume a pending update and removal recognizes its old/new owned hashes", async t => {
  const f = await fixture(t); await install(f); const next = await correctedSources(f); let interrupted = false;
  await assert.rejects(update({ ...f, guard: async () => { if (!interrupted && digest(await fs.readFile(f.firstShape)) === digest(next.shape)) { interrupted = true; throw Error("Interrupted"); } } }), /Interrupted/);
  await fs.writeFile(path.join(f.source, PACKAGE, "WaveShapes", NAMES[0] + ".txt"), "Third unintended revision");
  await assert.rejects(update(f), /source changed during a pending update/);
  const result = await remove(f); assert.equal(result.removedFiles, 10); assert.deepEqual(result.preserved, []); await missing(f.statePath);
  assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
});

test("pending update removal preserves a subsequently edited file and keeps only its remaining ownership", async t => {
  const f = await fixture(t); await install(f); const next = await correctedSources(f); let interrupted = false;
  await assert.rejects(update({ ...f, guard: async () => { if (!interrupted && digest(await fs.readFile(f.firstShape)) === digest(next.shape)) { interrupted = true; throw Error("Interrupted"); } } }), /Interrupted/);
  await fs.writeFile(f.firstShape, "Later user edit");
  const result = await remove(f); assert.equal(result.removedFiles, 9); assert.equal(result.preserved.length, 1);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8")); assert.equal(state.stage, "partially-removed"); assert.equal(state.files.length, 1); assert.equal(state.pendingUpdate.entries.length, 1);
  assert.equal(await fs.readFile(f.firstShape, "utf8"), "Later user edit"); assert.deepEqual(await fs.readFile(f.categoryFile), f.original); await f.assertProtected();
});

test("edited pending update backups and tampered pending paths are rejected without replacement", async t => {
  for (const tamper of ["backup", "path"]) {
    const f = await fixture(t); await install(f); await correctedSources(f); let calls = 0;
    await assert.rejects(update({ ...f, guard: async () => { if (++calls === 5) throw Error("Interrupted before replacing targets"); } }), /Interrupted/);
    const state = JSON.parse(await fs.readFile(f.statePath, "utf8")); assert.equal(state.stage, "updating"); const targetBefore = await fs.readFile(f.firstShape);
    if (tamper === "backup") await fs.writeFile(path.join(path.dirname(f.statePath), "soundspectrum-meters-updates", state.pendingUpdate.id, state.pendingUpdate.entries[0].relative), "Edited backup");
    else { state.pendingUpdate.entries[0].relative = "Scripts/Key 1.py"; await fs.writeFile(f.statePath, JSON.stringify(state)); }
    await assert.rejects(update(f), /backup is missing or edited|Invalid pending meters ownership/);
    assert.deepEqual(await fs.readFile(f.firstShape), targetBefore); await f.assertProtected();
  }
});

test("the last closed-state update guard cannot overwrite a concurrent user file edit", async t => {
  const f = await fixture(t); await install(f); await correctedSources(f); let edited = false;
  const guard = async () => {
    if (!edited && (await fs.readdir(path.dirname(f.firstShape))).some(name => name.includes(".rh-meters-update-"))) { edited = true; await fs.writeFile(f.firstShape, "Concurrent user edit"); }
  };
  await assert.rejects(update({ ...f, guard }), /changed before update replacement/);
  assert.equal(await fs.readFile(f.firstShape, "utf8"), "Concurrent user edit"); await f.assertProtected();
});

test("updates need completed ownership and a closed-state guard before writing receipts or backups", async t => {
  const f = await fixture(t); await assert.rejects(planUpdate(f), /Complete the meters installation/);
  await install(f); await correctedSources(f); const receipt = await fs.readFile(f.statePath), original = await fs.readFile(f.firstShape);
  await assert.rejects(update({ ...f, guard: async () => { throw Error("Native still open"); } }), /Native still open/);
  assert.deepEqual(await fs.readFile(f.statePath), receipt); assert.deepEqual(await fs.readFile(f.firstShape), original); await f.assertProtected();
});
