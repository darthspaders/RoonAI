'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { install, update, remove, renderPackage, getInstallationReadiness, digest, inside, PACKAGE, PACKAGE_FILE, PLACEHOLDER, renameState } = require('./install.cjs');
const TEMPLATE = `# harmless fixture, never executed\nSTATE = ${PLACEHOLDER}\n`;

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-now-playing-'));
  t.after(async () => {
    const resolved = path.resolve(temp), parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(parent) && path.basename(resolved).startsWith('rh-now-playing-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const source = path.join(temp, 'source'), roots = { install: path.join(temp, 'G-Force'), runtime: path.join(temp, 'private') };
  const statePath = path.join(temp, 'private-install.json'), sourceFile = path.join(source, PACKAGE, '_package.py'), target = path.join(roots.install, PACKAGE_FILE);
  await fs.mkdir(path.dirname(sourceFile), { recursive: true }); await fs.writeFile(sourceFile, TEMPLATE);
  const originals = [
    [path.join(roots.install, 'Packages/G-Force.Sprite.package/_package.py'), '# vendor package'],
    [path.join(roots.install, 'Packages/RabbitHole.HQPlayerInput.package/_package.py'), '# independent add-on'],
    [path.join(temp, 'profile/Preferences (Standalone).txt'), 'Theme.StartupTheme = "Rabbit Hole - darthspader"\nAudio.InputSource = "existing"\n'],
    [path.join(temp, 'profile/Themes/My theme.txt'), 'original theme'],
    [path.join(roots.runtime, 'now-playing.json'), '{"private":"keep"}'],
    [path.join(roots.runtime, 'artwork-' + 'a'.repeat(64) + '.png'), 'original artwork'],
    [path.join(roots.runtime, 'publisher.log'), 'private log']
  ];
  for (const [filename, content] of originals) { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content); }
  let checks = 0;
  return { source, roots, statePath, sourceFile, target, originals, assertInactive: async () => { checks++; }, checks: () => checks };
}
async function assertOriginals(f) { for (const [filename, content] of f.originals) assert.equal(await fs.readFile(filename, 'utf8'), content); }

test('one independently owned rendered package installs/removes without touching preferences, other add-ons or private metadata', async t => {
  const f = await fixture(t);
  assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'not-installed' }); assert.equal(f.checks(), 0);
  assert.deepEqual(await install(f), { installedFiles: 1, preferencesChanged: false });
  const state = JSON.parse(await fs.readFile(f.statePath)); assert.equal(state.entries.length, 1); assert.equal(state.entries[0].relative, PACKAGE_FILE);
  const bytes = await fs.readFile(f.target); assert.equal(digest(bytes), state.entries[0].sha256);
  assert.equal(bytes.toString(), renderPackage(TEMPLATE, f.roots.runtime)); assert.doesNotMatch(bytes.toString(), /__RH_/);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), ['_package.py']);
  assert.deepEqual(await getInstallationReadiness(f), { ready: true, reason: '' }); assert.equal(f.checks(), 1, 'readiness has no process gate');
  await assertOriginals(f);
  assert.deepEqual(await remove(f), { removedFiles: 1, preserved: [], preferencesChanged: false });
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' }); await assert.rejects(fs.access(f.statePath), { code: 'ENOENT' });
  await assertOriginals(f); assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'not-installed' });
});

test('an existing package directory, even empty, is never adopted or overwritten', async t => {
  for (const occupied of [false, true]) {
    const f = await fixture(t); await fs.mkdir(path.dirname(f.target), { recursive: true });
    if (occupied) await fs.writeFile(f.target, 'unowned Python');
    await assert.rejects(install(f), /already exists/); await assert.rejects(fs.access(f.statePath), { code: 'ENOENT' });
    if (occupied) assert.equal(await fs.readFile(f.target, 'utf8'), 'unowned Python');
    await assertOriginals(f);
  }
});

test('closed G-Force guard runs before every mutation and cannot be bypassed by an existing manifest', async t => {
  const f = await fixture(t), blocked = { ...f, assertInactive: async () => { throw Error('Close G-Force Standalone first.'); } };
  await assert.rejects(install(blocked), /Close G-Force/); await assert.rejects(fs.access(f.statePath), { code: 'ENOENT' });
  await install(f); const before = await fs.readFile(f.statePath), bytes = await fs.readFile(f.target);
  await assert.rejects(update(blocked), /Close G-Force/); await assert.rejects(remove(blocked), /Close G-Force/);
  assert.deepEqual(await fs.readFile(f.statePath), before); assert.deepEqual(await fs.readFile(f.target), bytes);
});

test('denied partial installation retains ownership and same rendered source can resume without overwrites', async t => {
  const f = await fixture(t), write = fs.writeFile; let denied = false;
  t.mock.method(fs, 'writeFile', async (filename, ...args) => {
    if (filename === f.target && !denied) { denied = true; throw Object.assign(Error('fixture denied'), { code: 'EACCES' }); }
    return write(filename, ...args);
  });
  await assert.rejects(install(f), error => error.code === 'EACCES' && error.needsPackageElevation === true);
  assert.equal(JSON.parse(await fs.readFile(f.statePath)).stage, 'installing');
  assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'incomplete-install' });
  assert.equal((await install(f)).installedFiles, 1); assert.deepEqual(await getInstallationReadiness(f), { ready: true, reason: '' });
  await assertOriginals(f);
});

test('changed partial source and edited partial target are protected; removal handles missing copied files', async t => {
  const f = await fixture(t); await install(f); let state = JSON.parse(await fs.readFile(f.statePath));
  state.stage = 'installing'; await fs.writeFile(f.statePath, JSON.stringify(state)); await fs.unlink(f.target);
  await fs.appendFile(f.sourceFile, '# new source\n'); await assert.rejects(install(f), /restore an interrupted/);
  assert.equal((await remove(f)).removedFiles, 0); await assertOriginals(f);
  const g = await fixture(t); await install(g); state = JSON.parse(await fs.readFile(g.statePath)); state.stage = 'installing';
  await fs.writeFile(g.statePath, JSON.stringify(state)); await fs.writeFile(g.target, '# user edit');
  await assert.rejects(install(g), /edited/); assert.equal((await remove(g)).removedFiles, 0); assert.equal(await fs.readFile(g.target, 'utf8'), '# user edit');
});

test('readiness requires installed owned bytes, matching rendered source and only the intended package member', async t => {
  const f = await fixture(t); await install(f); const original = await fs.readFile(f.target);
  await fs.writeFile(f.target, '# changed'); assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'package-changed' });
  await fs.writeFile(f.target, original); await fs.appendFile(f.sourceFile, '# changed source\n');
  assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'source-changed' }); await fs.writeFile(f.sourceFile, TEMPLATE);
  const foreign = path.join(path.dirname(f.target), 'foreign.py'); await fs.writeFile(foreign, '# unowned');
  assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'package-changed' }); await assert.rejects(update(f), /changed/);
  assert.equal((await remove(f)).removedFiles, 1); assert.equal(await fs.readFile(foreign, 'utf8'), '# unowned');
  await assertOriginals(f);
});

test('owned updates keep a private exact backup and removal preserves every backup', async t => {
  const f = await fixture(t); await install(f); const original = await fs.readFile(f.target);
  await fs.appendFile(f.sourceFile, '# revised source\n'); assert.deepEqual(await update(f), { updatedFiles: 1, preferencesChanged: false });
  const state = JSON.parse(await fs.readFile(f.statePath)), backup = inside(f.roots.runtime, state.updates[0].backup);
  assert.deepEqual(await fs.readFile(backup), original); assert.equal(state.pendingUpdate, undefined);
  assert.deepEqual(await getInstallationReadiness(f), { ready: true, reason: '' }); assert.equal((await update(f)).updatedFiles, 0);
  await remove(f); assert.deepEqual(await fs.readFile(backup), original); await assertOriginals(f);
});

test('edited owned packages are never updated or removed', async t => {
  const f = await fixture(t); await install(f); const record = await fs.readFile(f.statePath);
  await fs.writeFile(f.target, '# user changes'); await assert.rejects(update(f), /edited/); assert.deepEqual(await fs.readFile(f.statePath), record);
  assert.deepEqual(await remove(f), { removedFiles: 0, preserved: [PACKAGE_FILE], preferencesChanged: false });
  assert.equal(await fs.readFile(f.target, 'utf8'), '# user changes'); assert.equal(JSON.parse(await fs.readFile(f.statePath)).stage, 'partially-removed');
  await assertOriginals(f);
});

async function interruptUpdate(t, f) {
  await install(f); await fs.appendFile(f.sourceFile, '# pending revision\n'); const rename = fs.rename; let interrupted = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.target && !interrupted) { interrupted = true; throw Object.assign(Error('fixture interruption'), { code: 'EIO' }); }
    return rename(from, to);
  });
  await assert.rejects(update(f), /fixture interruption/);
  assert.equal(JSON.parse(await fs.readFile(f.statePath)).stage, 'updating');
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), ['_package.py'], 'interrupted temps are outside the package loader');
}

test('interrupted updates resume the recorded source or can be removed without source files', async t => {
  const f = await fixture(t); await interruptUpdate(t, f); assert.equal((await update(f)).updatedFiles, 1);
  assert.deepEqual(await getInstallationReadiness(f), { ready: true, reason: '' });
  t.mock.restoreAll(); const g = await fixture(t); await interruptUpdate(t, g); await fs.unlink(g.sourceFile);
  assert.equal((await remove(g)).removedFiles, 1); await assertOriginals(g);
});

test('interrupted replacement is removable and cannot adopt a different source revision', async t => {
  const f = await fixture(t); await interruptUpdate(t, f);
  const state = JSON.parse(await fs.readFile(f.statePath)), replacement = Buffer.from(renderPackage(await fs.readFile(f.sourceFile, 'utf8'), f.roots.runtime));
  assert.equal(digest(replacement), state.pendingUpdate.nextSha256); await fs.writeFile(f.target, replacement);
  await fs.appendFile(f.sourceFile, '# unrelated next version\n'); await assert.rejects(update(f), /source changed/);
  assert.equal((await remove(f)).removedFiles, 1); await assertOriginals(f);
});

test('malformed/traversing ownership records fail closed and never delete an unrelated file', async t => {
  for (const tamper of [
    state => { state.entries[0].relative = 'Packages/../unrelated.txt'; },
    state => { state.entries.push({ ...state.entries[0] }); },
    state => { state.entries[0].root = 'runtime'; },
    state => { state.stage = 'updating'; state.pendingUpdate = { sha256: state.entries[0].sha256, nextSha256: 'a'.repeat(64), backup: '../unrelated.txt' }; }
  ]) {
    const f = await fixture(t); await install(f); const bytes = await fs.readFile(f.target), state = JSON.parse(await fs.readFile(f.statePath));
    tamper(state); await fs.writeFile(f.statePath, JSON.stringify(state));
    assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'invalid-record' });
    await assert.rejects(update(f), /ownership/); await assert.rejects(remove(f), /ownership/);
    assert.deepEqual(await fs.readFile(f.target), bytes); await assertOriginals(f);
  }
});

test('hardlinked ownership/package files fail closed without deleting or replacing their other name', async t => {
  const f = await fixture(t); await install(f); const alias = path.join(f.roots.runtime, 'alias.py'); await fs.link(f.target, alias);
  assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'unavailable' }); await assert.rejects(update(f), /link/); await assert.rejects(remove(f), /link/);
  assert.equal(await fs.readFile(alias, 'utf8'), renderPackage(TEMPLATE, f.roots.runtime));
  await fs.unlink(alias); const recordAlias = path.join(f.roots.runtime, 'manifest-alias.json'); await fs.link(f.statePath, recordAlias);
  await assert.rejects(remove(f), /link/); await fs.access(f.target);
});

test('a junction/symlink package path never redirects installation or removal into another directory', async t => {
  const f = await fixture(t), foreign = path.join(f.roots.runtime, 'foreign-package'), directory = path.dirname(f.target);
  await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, '_package.py'), '# preserve foreign target');
  await fs.symlink(foreign, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(install(f), /link/); await assert.rejects(fs.access(f.statePath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(foreign, '_package.py'), 'utf8'), '# preserve foreign target');
  assert.deepEqual(await getInstallationReadiness(f), { ready: false, reason: 'not-installed' });
});

test('safe Python2 Unicode literals have exactly one fixed absolute state filename', () => {
  const root = path.join(os.tmpdir(), 'Beyonc\u00e9\u2028\ud83c\udfb5');
  const rendered = renderPackage(TEMPLATE, root);
  assert.match(rendered, /STATE = u"/); assert.match(rendered, /\\u00e9/); assert.match(rendered, /\\u2028/); assert.match(rendered, /\\ud83c\\udfb5/);
  assert.equal([...rendered].every(character => character.charCodeAt(0) < 128), true);
  assert.throws(() => renderPackage('no placeholder', root), /one now-playing/);
  assert.throws(() => renderPackage(TEMPLATE + PLACEHOLDER, root), /one now-playing/);
  assert.throws(() => renderPackage(TEMPLATE + '__RH_OTHER_PATH__', root), /unrendered/);
  assert.throws(() => renderPackage(TEMPLATE, 'unsafe\npath'), /Unsupported/);
  assert.throws(() => inside(root, '../elsewhere'), /Invalid/);
});

test('state rename retry is finite and never unlinks the current ownership record', async () => {
  const waits = []; let attempts = 0;
  await renameState('from', 'to', { rename: async () => { if (++attempts < 3) throw Object.assign(Error('busy'), { code: 'EPERM' }); }, wait: async ms => waits.push(ms) });
  assert.equal(attempts, 3); assert.deepEqual(waits, [20, 40]); attempts = 0;
  await assert.rejects(renameState('from', 'to', { rename: async () => { attempts++; throw Object.assign(Error('busy'), { code: 'EBUSY' }); }, wait: async () => {} }), /busy/);
  assert.equal(attempts, 6);
});

test('import and filesystem readiness never execute a child, invoke elevation, create a file or require audio modules', async t => {
  const f = await fixture(t), filename = path.join(__dirname, 'install.cjs'), source = await fs.readFile(filename, 'utf8'); let childCalls = 0;
  const module = { exports: {} };
  vm.runInNewContext(source, { require: name => {
    if (name === 'node:child_process') return { execFile: () => { childCalls++; throw Error('No child permitted'); } };
    assert.doesNotMatch(name, /audio|gstreamer|controller/i); return require(name);
  }, module, exports: module.exports, __dirname, __filename: filename, process, Buffer, TextDecoder, console, setTimeout });
  assert.equal(childCalls, 0); assert.equal((await module.exports.getInstallationReadiness(f)).ready, false);
  assert.equal(childCalls, 0); await assert.rejects(fs.access(f.statePath), { code: 'ENOENT' }); await assert.rejects(fs.access(f.target), { code: 'ENOENT' });
});

test('elevation helper is fixed-action, same-SID and hidden; generated argv remains quoted without executing any process', async () => {
  const filename = path.join(__dirname, 'install.cjs'), source = await fs.readFile(filename, 'utf8'), calls = [], module = { exports: {} };
  const execFile = () => { throw Error('No real executable permitted'); };
  execFile[promisify.custom] = async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; };
  const fakeProcess = { platform: 'win32', execPath: path.join(os.tmpdir(), "Node O'Brien", 'node.exe'), env: {}, argv: [] };
  vm.runInNewContext(source + '\nmodule.exports.testElevation = requestElevation;', { require: name => name === 'node:child_process' ? { execFile } : require(name), module, exports: module.exports,
    __dirname, __filename: filename, process: fakeProcess, Buffer, TextDecoder, console, setTimeout });
  const sid = 'S-1-5-21-1-2-3-1001';
  await assert.rejects(module.exports.testElevation('anything-else', sid), /Invalid elevation/); assert.equal(calls.length, 0);
  await module.exports.testElevation('install', sid); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe'); const command = calls[0][1].at(-1);
  assert.match(command, /-Verb RunAs -WindowStyle Hidden/); assert.ok(command.includes("Node O''Brien"));
  assert.ok(command.includes('"--elevated-worker" "--expected-sid" "' + sid + '"'));
  assert.ok(command.includes(filename)); assert.equal(calls[0][2].windowsHide, true);
});
