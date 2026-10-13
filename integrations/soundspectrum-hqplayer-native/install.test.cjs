"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { install, update, remove, renderPackage, launcherSource, digest, PACKAGE_FILE, renameState } = require("./install.cjs");
const TEMPLATE = "REQUEST = __RH_REQUEST_PATH__\nSTATUS = __RH_STATUS_PATH__\nLAUNCHER = __RH_LAUNCHER_PATH__\n";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rh-hqp-native-"));
  t.after(async () => {
    assert.ok(temp.startsWith(path.resolve(os.tmpdir()) + path.sep + "rh-hqp-native-"));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const source = path.join(temp, "source"), roots = { install: path.join(temp, "native"), runtime: path.join(temp, "private") };
  const statePath = path.join(temp, "state/install.json"), nodePath = path.join(temp, "Node runtime/node.exe");
  const packageSource = path.join(source, PACKAGE_FILE.slice("Packages/".length));
  await fs.mkdir(path.dirname(packageSource), { recursive: true });
  await fs.writeFile(packageSource, TEMPLATE);
  await fs.writeFile(path.join(source, "controller.cjs"), "// fixture; never launched\n");
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.writeFile(nodePath, "fixture; never launched");
  await fs.mkdir(roots.runtime, { recursive: true });
  await fs.writeFile(path.join(roots.runtime, "request.txt"), "keep request");
  await fs.writeFile(path.join(roots.runtime, "status.txt"), "keep status");
  await fs.writeFile(path.join(roots.runtime, "controller.log"), "keep log");
  const preference = path.join(temp, "Preferences (Standalone).txt"), original = 'Audio.InputSource = "Exact existing input"\nTheme.StartupTheme = "Custom 1"\n';
  await fs.writeFile(preference, original);
  return { source, roots, statePath, nodePath, packageSource, target: path.join(roots.install, PACKAGE_FILE), launcher: path.join(roots.runtime, "launch.vbs"), preference, original };
}

test("installs only the rendered package and hidden fixed launcher; removal preserves runtime and preferences", async t => {
  const f = await fixture(t);
  assert.deepEqual(await install(f), { installedFiles: 2, preferencesChanged: false });
  const rendered = await fs.readFile(f.target, "utf8"), launcher = await fs.readFile(f.launcher, "utf8");
  assert.ok(!rendered.includes("__RH_"));
  assert.match(rendered, /REQUEST = u"/);
  assert.ok(rendered.includes(JSON.stringify(path.join(f.roots.runtime, "request.txt"))));
  assert.ok(launcher.includes(f.nodePath));
  assert.ok(launcher.includes(path.join(f.source, "controller.cjs")));
  assert.match(launcher, /, 0, False\r\n$/);
  assert.match(launcher, /shell\.Run """/);
  assert.deepEqual(await remove(f), { removedFiles: 2, preserved: [], preferencesChanged: false });
  await assert.rejects(fs.access(f.target), { code: "ENOENT" });
  await assert.rejects(fs.access(f.launcher), { code: "ENOENT" });
  await assert.rejects(fs.access(f.statePath), { code: "ENOENT" });
  for (const [name, value] of [["request.txt", "keep request"], ["status.txt", "keep status"], ["controller.log", "keep log"]]) assert.equal(await fs.readFile(path.join(f.roots.runtime, name), "utf8"), value);
  assert.equal(await fs.readFile(f.preference, "utf8"), f.original);
});

test("unowned collisions abort before manifest/package writes", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.launcher, "user-owned launcher");
  await assert.rejects(install(f), /already exists/);
  await assert.rejects(fs.access(f.target), { code: "ENOENT" });
  await assert.rejects(fs.access(f.statePath), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.launcher, "utf8"), "user-owned launcher");
});

test("owner records block install/update/remove even if stale or empty", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.roots.runtime, "owner.json"), "");
  await assert.rejects(install(f), /Stop or recover/);
  await fs.unlink(path.join(f.roots.runtime, "owner.json"));
  await install(f);
  await fs.writeFile(path.join(f.roots.runtime, "owner.json"), '{"pid":999999999}');
  await assert.rejects(update(f), /Stop or recover/);
  await assert.rejects(remove(f), /Stop or recover/);
});

test("updates atomically owned files with backup and keeps removal available", async t => {
  const f = await fixture(t);
  await install(f);
  const original = await fs.readFile(f.target);
  await fs.appendFile(f.packageSource, "# revised source\n");
  assert.equal((await update(f)).updatedFiles, 1);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(state.stage, "installed");
  assert.equal(state.pendingUpdate, undefined);
  assert.deepEqual(await fs.readFile(path.join(state.updates[0].backup, "install", PACKAGE_FILE)), original);
  assert.equal((await update(f)).updatedFiles, 0);
  assert.equal((await remove(f)).removedFiles, 2);
  assert.equal(await fs.readFile(f.preference, "utf8"), f.original);
});

test("edited owned files are never replaced or removed", async t => {
  const f = await fixture(t);
  await install(f);
  const record = await fs.readFile(f.statePath);
  await fs.writeFile(f.target, "user edited native hook");
  await assert.rejects(update(f), /edited/);
  assert.deepEqual(await fs.readFile(f.statePath), record);
  const removed = await remove(f);
  assert.equal(removed.removedFiles, 1);
  assert.deepEqual(removed.preserved, [PACKAGE_FILE]);
  assert.equal(await fs.readFile(f.target, "utf8"), "user edited native hook");
});

async function interrupted(f) {
  await install(f);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  const entry = state.entries.find(item => item.root === "install");
  await fs.appendFile(f.packageSource, "# interrupted revision\n");
  const next = Buffer.from(renderPackage(await fs.readFile(f.packageSource, "utf8"), f.roots.runtime));
  await fs.writeFile(f.target, next);
  state.stage = "updating";
  state.pendingUpdate = { backup: path.join(f.roots.runtime, "prior-backup"), entries: [{ ...entry, nextSha256: digest(next) }] };
  await fs.writeFile(f.statePath, JSON.stringify(state));
}

test("interrupted replacement can resume update or be removed directly", async t => {
  const f = await fixture(t);
  await interrupted(f);
  assert.equal((await update(f)).updatedFiles, 1);
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).stage, "installed");
  const g = await fixture(t);
  await interrupted(g);
  assert.deepEqual(await remove(g), { removedFiles: 2, preserved: [], preferencesChanged: false });
  await assert.rejects(fs.access(g.statePath), { code: "ENOENT" });
});

test("interrupted update refuses new changes outside its recorded pending set", async t => {
  const f = await fixture(t);
  await interrupted(f);
  const record = await fs.readFile(f.statePath), launcher = await fs.readFile(f.launcher);
  f.nodePath = path.join(f.roots.runtime, "different-runtime/node.exe");
  await fs.mkdir(path.dirname(f.nodePath), { recursive: true });
  await fs.writeFile(f.nodePath, "fixture; never launched");
  await assert.rejects(update(f), /source changed during an interrupted update/);
  assert.deepEqual(await fs.readFile(f.statePath), record);
  assert.deepEqual(await fs.readFile(f.launcher), launcher);
  assert.equal((await remove(f)).removedFiles, 2);
});

test("ownership traversal or mismatched pending hashes cannot remove files", async t => {
  const f = await fixture(t);
  await interrupted(f);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  state.pendingUpdate.entries[0].relative = "Packages/../private.txt";
  await fs.writeFile(f.statePath, JSON.stringify(state));
  await assert.rejects(remove(f), /ownership/);
  await fs.access(f.target);
});

test("source symbolic links are rejected before private manifest writes", async t => {
  const f = await fixture(t);
  const packageRoot = path.dirname(f.packageSource), linked = path.join(f.source, "linked-package");
  await fs.rename(packageRoot, linked);
  // Directory junctions exercise the same reparse-path refusal without asking
  // Windows for the elevated privilege needed by file symbolic links.
  await fs.symlink(linked, packageRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(install(f), /symbolic link/);
  await assert.rejects(fs.access(f.statePath), { code: "ENOENT" });
});

test("literal rendering handles Unicode/space paths and refuses malformed or injectable paths", () => {
  const rendered = renderPackage(TEMPLATE, path.resolve("test path/Spáde"));
  assert.match(rendered, /Sp\\u00e1de/);
  assert.match(rendered, /u"/);
  assert.throws(() => renderPackage(TEMPLATE + "__RH_STATUS_PATH__", path.resolve("private")), /Expected one/);
  assert.throws(() => launcherSource('C:\\node.exe"\r\nevil', path.resolve("controller.cjs")), /Unsupported launcher path/);
});

test("state replacement retries transient Windows locks without changing target or rename paths", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.statePath), { recursive: true });
  const temporary = f.statePath + ".fixture.tmp";
  await fs.writeFile(f.statePath, "original record");
  await fs.writeFile(temporary, "replacement record");
  const errors = ["EPERM", "EACCES", "EBUSY"], delays = [];
  let attempts = 0;
  await renameState(temporary, f.statePath, {
    rename: async (from, to) => {
      assert.equal(from, temporary); assert.equal(to, f.statePath);
      assert.equal(await fs.readFile(to, "utf8"), "original record");
      if (attempts < errors.length) throw Object.assign(Error("temporary sharing violation"), { code: errors[attempts++] });
      attempts++; await fs.rename(from, to);
    }, wait: async value => { delays.push(value); }
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [20, 40, 80]);
  assert.equal(await fs.readFile(f.statePath, "utf8"), "replacement record");
});

test("persistent or unrelated state-rename failures are bounded and preserve both files", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.statePath), { recursive: true });
  const temporary = f.statePath + ".fixture.tmp";
  await fs.writeFile(f.statePath, "original record");
  await fs.writeFile(temporary, "replacement record");
  const error = Object.assign(Error("persistent sharing violation"), { code: "EPERM" });
  let attempts = 0, elapsed = 0;
  await assert.rejects(renameState(temporary, f.statePath, {
    rename: async () => { attempts++; throw error; }, wait: async value => { elapsed += value; }
  }), value => value === error);
  assert.equal(attempts, 6); assert.equal(elapsed, 460);
  assert.equal(await fs.readFile(f.statePath, "utf8"), "original record");
  assert.equal(await fs.readFile(temporary, "utf8"), "replacement record");
  attempts = 0;
  await assert.rejects(renameState(temporary, f.statePath, {
    rename: async () => { attempts++; throw Object.assign(Error("disk failed"), { code: "EIO" }); },
    wait: async () => assert.fail("unrelated failures must not retry")
  }), { code: "EIO" });
  assert.equal(attempts, 1);
});
