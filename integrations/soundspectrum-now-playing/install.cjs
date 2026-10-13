'use strict';

// Independent optional metadata package. Import/readiness never launches a
// process, connects a socket, creates a file, or changes preferences/audio.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const PACKAGE = 'RabbitHole.NowPlaying.package';
const PACKAGE_FILE = `Packages/${PACKAGE}/_package.py`;
const PLACEHOLDER = '__RH_NOWPLAYING_STATE_PATH__';
const HASH = /^[a-f0-9]{64}$/;
const MAX_PACKAGE_BYTES = 256 * 1024, MAX_RECORD_BYTES = 64 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Invalid now-playing add-on path.');
  const result = path.resolve(root, relative), relation = path.relative(path.resolve(root), result);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw Error('Now-playing add-on path leaves its root.');
  return result;
}
function constantPath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f"]/.test(value)) throw Error('Unsupported now-playing path.');
  return path.resolve(value);
}
function renderPackage(template, runtimeRoot) {
  if (typeof template !== 'string' || Buffer.byteLength(template) > MAX_PACKAGE_BYTES || template.split(PLACEHOLDER).length !== 2) throw Error('Expected one now-playing state placeholder; no package was installed.');
  const filename = constantPath(inside(constantPath(runtimeRoot), 'now-playing.json'));
  const literal = 'u' + JSON.stringify(filename).replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const rendered = template.replace(PLACEHOLDER, () => literal);
  if (/__RH_[A-Z0-9_]+__/.test(rendered)) throw Error('An unrendered now-playing package placeholder remains; nothing was installed.');
  return rendered;
}
function configuration(options = {}) {
  const source = constantPath(options.source || __dirname);
  const runtime = constantPath(options.roots?.runtime || path.join(source, '../../data/soundspectrum-now-playing'));
  return { source, roots: { runtime, install: constantPath(options.roots?.install || path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SoundSpectrum/G-Force')) },
    statePath: constantPath(options.statePath || path.join(source, '../../data/soundspectrum-now-playing-install.json')),
    assertInactive: options.assertInactive || assertGForceClosed };
}
async function assertNoLinks(filename) {
  const target = path.resolve(filename), parsed = path.parse(target); let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    let stat; try { stat = await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw Error('Now-playing add-on path contains a link; it was preserved.');
  }
}
async function readOptional(filename, limit = MAX_RECORD_BYTES) {
  await assertNoLinks(filename);
  let stat; try { stat = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > limit) throw Error('Unexpected or excessive now-playing add-on file; it was preserved.');
  return fs.readFile(filename);
}
async function assertGForceClosed() {
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name 'G-Force Standalone','G-Force Standalone.x64' -ErrorAction SilentlyContinue).Count"], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 });
  if (stdout.trim() !== '0') throw Error('Close G-Force Standalone before installing, updating or removing this add-on.');
}
function validateState(state) {
  if (state?.version !== 1 || !['installing', 'installed', 'updating', 'partially-removed'].includes(state.stage) || !Array.isArray(state.entries) || state.entries.length !== 1) throw Error('Invalid now-playing ownership record; files were preserved.');
  const entry = state.entries[0];
  if (entry?.root !== 'install' || entry.relative !== PACKAGE_FILE || !HASH.test(entry.sha256)) throw Error('Invalid now-playing ownership record; files were preserved.');
  if (state.pendingUpdate && (state.stage !== 'updating' || state.pendingUpdate.sha256 !== entry.sha256 || !HASH.test(state.pendingUpdate.nextSha256) || !/^updates\/[a-f0-9-]{36}\/_package\.py$/.test(state.pendingUpdate.backup || ''))) throw Error('Invalid pending now-playing ownership record; files were preserved.');
  if (state.stage === 'updating' && !state.pendingUpdate) throw Error('Invalid pending now-playing ownership record; files were preserved.');
  return state;
}
async function renameState(from, to, { rename = (a, b) => fs.rename(a, b), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const delays = [20, 40, 80, 160, 160];
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error; await wait(delays[attempt]); }
  }
}
async function saveState(filename, state, exclusive = false) {
  await assertNoLinks(filename); await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx' });
    if (exclusive) await fs.link(temporary, filename); else await renameState(temporary, filename);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function desiredPackage(config) {
  const sourcePath = inside(config.source, `${PACKAGE}/_package.py`), source = await readOptional(sourcePath, MAX_PACKAGE_BYTES);
  if (!source) throw Error('The now-playing source package is unavailable.');
  const bytes = Buffer.from(renderPackage(new TextDecoder('utf-8', { fatal: true }).decode(source), config.roots.runtime));
  return { root: 'install', relative: PACKAGE_FILE, sha256: digest(bytes), bytes };
}
async function packageMembers(config) {
  const directory = inside(config.roots.install, `Packages/${PACKAGE}`); await assertNoLinks(directory);
  try { return await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function getInstallationReadiness(options = {}) {
  try {
    const config = configuration(options), record = await readOptional(config.statePath);
    if (!record) return { ready: false, reason: 'not-installed' };
    let state; try { state = validateState(JSON.parse(record)); } catch { return { ready: false, reason: 'invalid-record' }; }
    if (state.stage !== 'installed') return { ready: false, reason: 'incomplete-install' };
    const members = await packageMembers(config);
    if (!members || members.length !== 1 || members[0] !== '_package.py') return { ready: false, reason: 'package-changed' };
    const current = await readOptional(inside(config.roots.install, PACKAGE_FILE), MAX_PACKAGE_BYTES);
    if (!current || digest(current) !== state.entries[0].sha256) return { ready: false, reason: 'package-changed' };
    const desired = await desiredPackage(config);
    return desired.sha256 === state.entries[0].sha256 ? { ready: true, reason: '' } : { ready: false, reason: 'source-changed' };
  } catch { return { ready: false, reason: 'unavailable' }; }
}
async function writePackage(config, bytes, exclusive) {
  const target = inside(config.roots.install, PACKAGE_FILE); await assertNoLinks(target);
  try { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: exclusive ? 'wx' : 'w' }); }
  catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) error.needsPackageElevation = true; throw error; }
}
async function install(options = {}) {
  const config = configuration(options); await config.assertInactive();
  const desired = await desiredPackage(config), record = await readOptional(config.statePath);
  let state;
  if (record) {
    state = validateState(JSON.parse(record));
    if (state.stage !== 'installing' || state.entries[0].sha256 !== desired.sha256) throw Error('The now-playing add-on already has an ownership record. Use update/remove, or restore an interrupted install source.');
    const members = await packageMembers(config);
    if (members?.some(name => name !== '_package.py')) throw Error('An unowned file exists in the now-playing package; nothing was replaced.');
    const current = await readOptional(inside(config.roots.install, PACKAGE_FILE), MAX_PACKAGE_BYTES);
    if (current && digest(current) !== desired.sha256) throw Error('The interrupted package was edited; it was preserved.');
    if (!current) await writePackage(config, desired.bytes, true);
  } else {
    if (await packageMembers(config)) throw Error('The now-playing package directory already exists; nothing was replaced.');
    state = { version: 1, stage: 'installing', entries: [{ root: desired.root, relative: desired.relative, sha256: desired.sha256 }] };
    // Reserve exact ownership before copying; a denied/interrupted copy can be
    // resumed by the same rendered source, including the same-SID UAC worker.
    await saveState(config.statePath, state, true); await writePackage(config, desired.bytes, true);
  }
  state.stage = 'installed'; await saveState(config.statePath, state);
  return { installedFiles: 1, preferencesChanged: false };
}
async function update(options = {}) {
  const config = configuration(options); await config.assertInactive();
  const state = validateState(JSON.parse(await readOptional(config.statePath)));
  if (!['installed', 'updating'].includes(state.stage)) throw Error('Complete the now-playing installation before updating.');
  const members = await packageMembers(config);
  if (!members || members.some(name => name !== '_package.py')) throw Error('The owned now-playing package changed; it was preserved.');
  const target = inside(config.roots.install, PACKAGE_FILE), current = await readOptional(target, MAX_PACKAGE_BYTES), desired = await desiredPackage(config), originalHash = state.entries[0].sha256;
  if (!current || ![originalHash, state.pendingUpdate?.nextSha256].includes(digest(current))) throw Error('The installed now-playing file was edited; it was preserved.');
  if (state.pendingUpdate && desired.sha256 !== state.pendingUpdate.nextSha256) throw Error('The source changed during an interrupted update; restore it before resuming.');
  if (desired.sha256 === originalHash) return { updatedFiles: 0, preferencesChanged: false };
  if (!state.pendingUpdate) {
    const backup = `updates/${crypto.randomUUID()}/_package.py`, backupPath = inside(config.roots.runtime, backup);
    await assertNoLinks(backupPath); await fs.mkdir(path.dirname(backupPath), { recursive: true }); await fs.writeFile(backupPath, current, { flag: 'wx' });
    state.stage = 'updating'; state.pendingUpdate = { sha256: originalHash, nextSha256: desired.sha256, backup }; await saveState(config.statePath, state);
  }
  if (digest(current) !== desired.sha256) {
    // Keep interrupted temporary files out of G-Force's package scan. The
    // current deployment uses the same Windows volume for runtime/install.
    const temporary = inside(config.roots.runtime, `updates/${crypto.randomUUID()}.tmp`);
    try {
      await assertNoLinks(temporary); await fs.mkdir(path.dirname(temporary), { recursive: true });
      await fs.writeFile(temporary, desired.bytes, { flag: 'wx' });
      const latest = await readOptional(target, MAX_PACKAGE_BYTES);
      if (!latest || digest(latest) !== originalHash) throw Error('The installed now-playing file changed during update; it was preserved.');
      await renameState(temporary, target);
    } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) error.needsPackageElevation = true; throw error; }
    finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  state.updates = [...(Array.isArray(state.updates) ? state.updates : []), { backup: state.pendingUpdate.backup }].slice(-20);
  state.entries[0].sha256 = desired.sha256; delete state.pendingUpdate; state.stage = 'installed'; await saveState(config.statePath, state);
  return { updatedFiles: 1, preferencesChanged: false };
}
async function remove(options = {}) {
  const config = configuration(options); await config.assertInactive(); const record = await readOptional(config.statePath);
  if (!record) return { removedFiles: 0, preserved: [], preferencesChanged: false };
  const state = validateState(JSON.parse(record)), target = inside(config.roots.install, PACKAGE_FILE), current = await readOptional(target, MAX_PACKAGE_BYTES);
  if (current && ![state.entries[0].sha256, state.pendingUpdate?.nextSha256].includes(digest(current))) {
    state.stage = 'partially-removed'; delete state.pendingUpdate; await saveState(config.statePath, state);
    return { removedFiles: 0, preserved: [PACKAGE_FILE], preferencesChanged: false };
  }
  try {
    if (current) await fs.unlink(target);
    const directory = inside(config.roots.install, `Packages/${PACKAGE}`); await assertNoLinks(directory);
    await fs.rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) error.needsPackageElevation = true; throw error; }
  await fs.unlink(config.statePath);
  // Private metadata, art, logs and update backups are deliberately retained.
  return { removedFiles: current ? 1 : 0, preserved: [], preferencesChanged: false };
}
function powershellLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }
function windowsArgument(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
async function windowsSid() {
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 });
  const sid = stdout.trim(); if (!/^S-1-\d+(?:-\d+){1,15}$/.test(sid)) throw Error('The Windows installation user could not be verified.'); return sid;
}
async function requestElevation(action, sid) {
  if (!['install', 'update', 'remove'].includes(action) || !/^S-1-\d+(?:-\d+){1,15}$/.test(sid)) throw Error('Invalid elevation request.');
  const node = constantPath(process.execPath), script = constantPath(__filename);
  if (path.basename(node).toLowerCase() !== 'node.exe') throw Error('The existing Windows node.exe is required.');
  const args = [script, action, '--elevated-worker', '--expected-sid', sid].map(windowsArgument).join(' ');
  await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${powershellLiteral(node)} -Verb RunAs -WindowStyle Hidden -ArgumentList ${powershellLiteral(args)} | Out-Null`], { windowsHide: true, timeout: 60000, maxBuffer: 4096 });
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!['install', 'update', 'remove', 'status'].includes(action)) throw Error('Usage: node install.cjs install|update|remove|status');
  if (process.platform !== 'win32') throw Error('The optional G-Force now-playing package requires Windows.');
  const elevated = args[0] === '--elevated-worker';
  if (args.length && (!elevated || args.length !== 3 || args[1] !== '--expected-sid' || !/^S-1-\d+(?:-\d+){1,15}$/.test(args[2]))) throw Error('Invalid installer arguments.');
  if (action === 'status') { console.log(JSON.stringify(await getInstallationReadiness())); return; }
  const sid = await windowsSid(); if (elevated && args[2] !== sid) throw Error('Use the same Windows user who runs G-Force.');
  const config = configuration(), logPath = inside(config.roots.runtime, 'installer.log');
  try {
    const result = await ({ install, update, remove }[action])();
    if (elevated) { await assertNoLinks(logPath); await fs.mkdir(path.dirname(logPath), { recursive: true }); await fs.writeFile(logPath, JSON.stringify({ action, ok: true, result }) + '\n'); }
    console.log(JSON.stringify(result));
  } catch (error) {
    if (!elevated && error.needsPackageElevation) {
      await requestElevation(action, sid); console.log('Windows administrator prompt requested. Review data/soundspectrum-now-playing/installer.log and installer status.'); return;
    }
    if (elevated) { await assertNoLinks(logPath); await fs.mkdir(path.dirname(logPath), { recursive: true }); await fs.writeFile(logPath, JSON.stringify({ action, ok: false, reason: error.message }) + '\n'); }
    throw error;
  }
}

module.exports = { install, update, remove, renderPackage, getInstallationReadiness, digest, inside, PACKAGE, PACKAGE_FILE, PLACEHOLDER, renameState };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
