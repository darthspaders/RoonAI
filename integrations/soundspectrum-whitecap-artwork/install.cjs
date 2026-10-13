"use strict";
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { promisify } = require('node:util'), { execFile } = require('node:child_process');
const PACKAGE = 'RabbitHole.WhiteCapArtwork.package';
const names = ['_package.py', 'Rabbit Hole - Floating Artwork.py'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function config(options = {}) {
  const runtime = path.resolve(options.runtime || path.join(__dirname, '../../data/soundspectrum-whitecap-artwork'));
  return { runtime, directory: path.resolve(options.directory || path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'SoundSpectrum/WhiteCap/Packages', PACKAGE)),
    record: path.join(runtime, 'installation.json'), assertClosed: options.assertClosed || assertClosed };
}
async function assertClosed() {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name 'WhiteCap Standalone','WhiteCap Standalone.x64' -ErrorAction SilentlyContinue).Count"], { windowsHide: true, timeout: 5000 });
  if (stdout.trim() !== '0') throw Error('WhiteCap is running. Stop visuals before installing this add-on.');
}
async function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    const stat = await fs.lstat(current).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (stat && (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1)) throw Error('Linked add-on path preserved.');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
async function optional(filename) {
  await noLinks(filename);
  return fs.readFile(filename).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
}
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error('Shared metadata validation source changed.');
  return text.slice(a, b);
}
async function desired(options = {}) {
  const c = config(options);
  const shared = await fs.readFile(path.join(__dirname, '../soundspectrum-now-playing/RabbitHole.NowPlaying.package/_package.py'), 'utf8');
  const validators = between(shared, 'class PrivateJSONReader(object):', 'def _bootstrap(') + between(shared, 'def _integer(', 'class MetadataReader(object):');
  const literal = 'u' + JSON.stringify(path.join(c.runtime, 'now-playing.json')).replace(/[^\x20-\x7e]/g, x => '\\u' + x.charCodeAt(0).toString(16).padStart(4, '0'));
  const result = {};
  for (const name of names) {
    let source = await fs.readFile(path.join(__dirname, name), 'utf8');
    if (name === '_package.py') source = source.replace('__RH_WHITE_ART_STATE__', () => literal).replace('__RH_READER_CODE__', () => validators);
    if (/__RH_[A-Z_]+__/.test(source)) throw Error('Unrendered add-on placeholder.');
    result[name] = Buffer.from(source);
  }
  return result;
}
async function readiness(options = {}) {
  try {
    const c = config(options), bytes = await optional(c.record);
    if (!bytes) return { ready: false, reason: 'not-installed' };
    const record = JSON.parse(bytes), files = await desired(options);
    if (record.version !== 1 || record.stage !== 'installed') return { ready: false, reason: 'incomplete' };
    const members = await fs.readdir(c.directory);
    if (members.length !== 2 || members.some(n => !names.includes(n))) return { ready: false, reason: 'files-changed' };
    for (const name of names) {
      const installed = await optional(path.join(c.directory, name));
      if (!installed || hash(installed) !== record.files[name] || hash(files[name]) !== record.files[name]) return { ready: false, reason: 'files-changed' };
    }
    return { ready: true };
  } catch { return { ready: false, reason: 'unavailable' }; }
}
async function install(options = {}) {
  const c = config(options); await c.assertClosed();
  await noLinks(c.directory); await noLinks(c.runtime);
  const files = await desired(options), prior = await optional(c.record);
  const members = await fs.readdir(c.directory).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  let old = prior ? JSON.parse(prior) : null;
  if (old && (old.version !== 1 || !['installed', 'installing'].includes(old.stage) || Object.keys(old.files || {}).length !== 2 || names.some(n => !/^[a-f0-9]{64}$/.test(old.files[n] || '')))) throw Error('Invalid ownership record preserved.');
  if (!old && members !== null || members?.some(n => !names.includes(n))) throw Error('Unowned package files preserved.');
  for (const name of names) {
    const current = await optional(path.join(c.directory, name));
    if (current && hash(current) !== old?.files[name] && hash(current) !== old?.previous?.[name] && hash(current) !== hash(files[name])) throw Error('Edited package preserved.');
  }
  await fs.mkdir(c.runtime, { recursive: true });
  if (old?.stage === 'installed') {
    const backup = path.join(c.runtime, 'backup-' + crypto.randomUUID()); await fs.mkdir(backup);
    for (const name of names) { const current = await optional(path.join(c.directory, name)); if (current) await fs.writeFile(path.join(backup, name), current, { flag: 'wx' }); }
    await fs.writeFile(path.join(backup, 'installation.json'), prior, { flag: 'wx' });
  }
  const record = { version: 1, stage: 'installing', previous: old?.previous || old?.files,
    files: Object.fromEntries(names.map(n => [n, hash(files[n])])) };
  await fs.writeFile(c.record, JSON.stringify(record, null, 2));
  await fs.mkdir(c.directory, { recursive: true });
  for (const name of names) await fs.writeFile(path.join(c.directory, name), files[name]);
  record.stage = 'installed'; delete record.previous; await fs.writeFile(c.record, JSON.stringify(record, null, 2));
  if (!(await readiness(options)).ready) throw Error('Installed add-on verification failed.');
  return { installedFiles: 2, preferencesChanged: false };
}
async function remove(options = {}) {
  const c = config(options); await c.assertClosed();
  if (!(await readiness(options)).ready) throw Error('Only an intact owned package can be removed.');
  for (const name of names) await fs.unlink(path.join(c.directory, name));
  await fs.rmdir(c.directory);
  await fs.rename(c.record, path.join(c.runtime, 'removed-' + crypto.randomUUID() + '.json'));
  return { removedFiles: 2, privateMetadataPreserved: true };
}
module.exports = { install, readiness, desired, remove };
if (require.main === module) (process.argv[2] === 'install' ? install() : process.argv[2] === 'remove' ? remove() : readiness()).then(x => console.log(JSON.stringify(x))).catch(e => { console.error(e.message); process.exitCode = 1; });
