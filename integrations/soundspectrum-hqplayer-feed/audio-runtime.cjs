'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO_PLUGIN_FILES = Object.freeze([
  'gstcoreelements.dll', 'gstrawparse.dll', 'gstaudioconvert.dll',
  'gstaudioresample.dll', 'gstwasapi.dll',
]);
// Static PE imports of the bundled 1.26.11 audio plugins, including their
// recursive runtime dependencies. gstvideo is the CPU base library required
// by rawparse; none of these DLLs imports D3D, DXGI or a hardware video plugin.
const AUDIO_RUNTIME_DLLS = Object.freeze([
  'ffi-7.dll', 'glib-2.0-0.dll', 'gmodule-2.0-0.dll', 'gobject-2.0-0.dll',
  'gstaudio-1.0-0.dll', 'gstbase-1.0-0.dll', 'gstreamer-1.0-0.dll',
  'gsttag-1.0-0.dll', 'gstvideo-1.0-0.dll', 'intl-8.dll', 'orc-0.4-0.dll',
  'pcre2-8-0.dll', 'z-1.dll',
]);
// This reviewed MSVC x64 1.26.11 closure is deliberately immutable. An alternate
// install or changed DLL is unavailable until its imports and contents receive
// a new explicit review; deriving an identity is not approval of new binaries.
const REVIEWED_SOURCE_MANIFEST = Object.freeze({
  version: 1, runtimeVersion: '1.26.11',
  files: Object.freeze([
    ['bin/ffi-7.dll',31232,'7d38c1319a2209a6293703bc605172cc64f24bece7f67e115520079b4b3b2058'],
    ['bin/glib-2.0-0.dll',1432064,'52ffcad1def38b1dfaa8a4aeb7abedf3f24b0825ff16cc168d25152a010eb4a4'],
    ['bin/gmodule-2.0-0.dll',25088,'a5fc50c81d3c0f6d4409677358a439d3e2810e0af4a0ddb46f5948c3e3faebdd'],
    ['bin/gobject-2.0-0.dll',346624,'8306cc2c7ba5d1b64804784335015cb65ccd85296a64e9b55a027288868ef97a'],
    ['bin/gst-inspect-1.0.exe',61952,'2fe64504131d3e66671c361d67fdb5ccf7876bc5d061a5f9b97d1f4c03d04acd'],
    ['bin/gst-launch-1.0.exe',35840,'fca9e1c7c020f94fc941f9391dc6b5b3de758a062ff92e77a053f4a589833e34'],
    ['bin/gstaudio-1.0-0.dll',547328,'8978f2f4d9b1c6430ba019fa3c6247106b559afb9dcffc66d342a7491307d9d5'],
    ['bin/gstbase-1.0-0.dll',518656,'33160d36af07a794b72d89b40238b6ee1c78aa1d3ad9de3cc68f78fb35a3aa93'],
    ['bin/gstreamer-1.0-0.dll',1377280,'2d5a4e511fa2d306811e24ee9fe7e373e01554b07089c9584bcb23342c27e588'],
    ['bin/gsttag-1.0-0.dll',265216,'f2a95b392b5fbfa726a81195ea4f2fcb995284ded1c169e28302f02a5d3ba9d9'],
    ['bin/gstvideo-1.0-0.dll',883200,'712354d5711ba65e337f95d65bf835c14af261aa0e74f7a0dda42c4b4027b466'],
    ['bin/intl-8.dll',12800,'3e754c4e378f6a4e44268233dcf18dd68d2ef05e8edc1670f28ffa64ff0e0bf7'],
    ['bin/orc-0.4-0.dll',437248,'42dcb7649c460395ed1f083a1dc3005fa7036f057ac89d30e5ce8947af24feef'],
    ['bin/pcre2-8-0.dll',348160,'b7a66d42b86fa4203a58477bb458796a23c1f8923dbd44e897f2361703e5faf7'],
    ['bin/z-1.dll',91648,'fee5151ba5e9bec7835051c54eb5545031edb55e2318b0138e36304fc14144a0'],
    ['lib/gstreamer-1.0/gstaudioconvert.dll',36352,'d7fba1a7427e34b225a93671dfac62bc6deda3ebbc7976d2f7e831d162580ec4'],
    ['lib/gstreamer-1.0/gstaudioresample.dll',35328,'3c02bfe7aff0de91efa70797f5f9b735c38ccdcaf29aa31eb4d0f78a205acee9'],
    ['lib/gstreamer-1.0/gstcoreelements.dll',424960,'140e6cd93db3c6d06240360b69b0bab17f91ef693d1d051b154ad64ff0cb444a'],
    ['lib/gstreamer-1.0/gstrawparse.dll',64512,'993caf3b3cba42e56f1d4ef6fe73b14cac744b05645628dafe25c5713519a3f6'],
    ['lib/gstreamer-1.0/gstwasapi.dll',91136,'a0d4214f8cd58367a017a5b8a572eae13fcc5bbdec044a8973242a627d7e9b08'],
    ['libexec/gstreamer-1.0/gst-plugin-scanner.exe',11776,'c8cbb03749393a68533f3bb91886beb833abd24d21156e89a26ec4e0906f6bb6'],
  ].map(([name, bytes, sha256]) => Object.freeze({ name, bytes, sha256 }))),
});
const DEFAULT_STAGE_ROOT = path.join(__dirname, '../../data/soundspectrum-hqplayer-feed/audio-runtime');
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const preparations = new Map();

function failure(reason) { return new Error(`runtime-audio-${reason}`); }
function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function inspectPath(target, { directory = false, missing = false } = {}) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT' && missing) return null;
      throw failure('path-unavailable');
    }
    if (stat.isSymbolicLink()) throw failure('link-refused');
    if (current !== absolute && !stat.isDirectory()) throw failure('path-invalid');
    if (current === absolute) {
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw failure('path-invalid');
      if (!directory && stat.nlink !== 1) throw failure('link-refused');
      const real = await fsp.realpath(current);
      if (!samePath(real, absolute)) throw failure('link-refused');
      return stat;
    }
  }
  return fsp.lstat(root);
}

async function ensureDirectory(target) {
  if (await inspectPath(target, { directory: true, missing: true })) return;
  await ensureDirectory(path.dirname(target));
  try { await fsp.mkdir(target); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await inspectPath(target, { directory: true });
}

async function hashFile(file) {
  const before = await inspectPath(file);
  if (before.size < 1 || before.size > MAX_FILE_BYTES) throw failure('file-size');
  const hash = crypto.createHash('sha256');
  let read = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 128 * 1024 });
  for await (const chunk of stream) {
    read += chunk.length;
    if (read > before.size || read > MAX_FILE_BYTES) {
      stream.destroy();
      throw failure('source-changed');
    }
    hash.update(chunk);
  }
  const after = await inspectPath(file);
  if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw failure('source-changed');
  return { bytes: read, sha256: hash.digest('hex') };
}

async function sourceManifest(executable) {
  const bin = path.dirname(executable);
  const root = path.dirname(bin);
  const names = [
    'bin/gst-launch-1.0.exe', 'bin/gst-inspect-1.0.exe',
    'libexec/gstreamer-1.0/gst-plugin-scanner.exe',
    ...AUDIO_PLUGIN_FILES.map(name => `lib/gstreamer-1.0/${name}`),
    ...AUDIO_RUNTIME_DLLS.map(name => `bin/${name}`),
  ].sort();
  const files = [];
  let total = 0;
  for (const name of names) {
    const result = await hashFile(path.join(root, ...name.split('/')));
    total += result.bytes;
    if (total > MAX_SOURCE_BYTES) throw failure('source-size');
    files.push({ name, ...result });
  }
  return { version: 1, runtimeVersion: '1.26.11', files };
}

function approvedManifest(options, stageRoot) {
  const supplied = options.approvedManifest;
  const defaultRoot = path.resolve(DEFAULT_STAGE_ROOT);
  if (supplied && (!options.stageRoot || containsPath(defaultRoot, stageRoot) || containsPath(stageRoot, defaultRoot))) throw failure('fixture-override-refused');
  const manifest = supplied || REVIEWED_SOURCE_MANIFEST;
  if (!manifest || manifest.version !== 1 || manifest.runtimeVersion !== '1.26.11' || Object.keys(manifest).sort().join(',') !== 'files,runtimeVersion,version' || !Array.isArray(manifest.files)) throw failure('manifest-invalid');
  const names = new Set(REVIEWED_SOURCE_MANIFEST.files.map(row => row.name));
  if (manifest.files.length !== names.size) throw failure('manifest-invalid');
  const files = manifest.files.map(row => {
    if (!row || Object.keys(row).sort().join(',') !== 'bytes,name,sha256' || !names.delete(row.name) || !Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_FILE_BYTES || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw failure('manifest-invalid');
    return { name: row.name, bytes: row.bytes, sha256: row.sha256 };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { version: 1, runtimeVersion: '1.26.11', files };
}

async function exactEntries(directory, allowed) {
  await inspectPath(directory, { directory: true });
  const entries = await fsp.readdir(directory);
  if (entries.length > allowed.size || entries.some(name => !allowed.has(name))) throw failure('unexpected-file');
  return new Set(entries);
}

async function smallFile(file, limit) {
  const stat = await inspectPath(file);
  if (stat.size > limit) throw failure('file-size');
  return fsp.readFile(file, 'utf8');
}

async function validateRegistry(directory) {
  await inspectPath(directory, { directory: true });
  const entries = await fsp.readdir(directory);
  if (entries.length > 4) throw failure('unexpected-file');
  for (const name of entries) {
    if (!/^registry\.x86_64\.bin(?:\.tmp[A-Za-z0-9]{6})?$/.test(name)) throw failure('unexpected-file');
    const stat = await inspectPath(path.join(directory, name));
    if (stat.size > 8 * 1024 * 1024) throw failure('file-size');
  }
}

async function verifyStage(stage, manifestText, pluginRows, { preparing = false } = {}) {
  const entries = await exactEntries(stage, new Set(['manifest.json', 'plugins', 'registry']));
  if (!entries.has('manifest.json') || await smallFile(path.join(stage, 'manifest.json'), 16384) !== manifestText) throw failure('manifest-mismatch');
  if (!entries.has('plugins') && !preparing) throw failure('incomplete');
  const pluginNames = new Set(AUDIO_PLUGIN_FILES);
  if (preparing) for (const name of AUDIO_PLUGIN_FILES) pluginNames.add(`${name}.part`);
  const existing = entries.has('plugins') ? await exactEntries(path.join(stage, 'plugins'), pluginNames) : new Set();
  for (const row of pluginRows) {
    const name = path.basename(row.name);
    if (existing.has(name)) {
      const actual = await hashFile(path.join(stage, 'plugins', name));
      if (actual.sha256 !== row.sha256 || actual.bytes !== row.bytes) throw failure('hash-mismatch');
    } else if (!preparing) throw failure('incomplete');
    if (existing.has(`${name}.part`)) {
      const partial = await inspectPath(path.join(stage, 'plugins', `${name}.part`));
      if (partial.size > row.bytes) throw failure('file-size');
    }
  }
  if (entries.has('registry')) await validateRegistry(path.join(stage, 'registry'));
  else if (!preparing) throw failure('incomplete');
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireLock(lock) {
  const text = JSON.stringify({ version: 1, pid: process.pid, token: crypto.randomUUID() });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const handle = await fsp.open(lock, 'wx');
      try { await handle.writeFile(text); } finally { await handle.close(); }
      return async () => {
        if (await smallFile(lock, 2048).catch(() => '') === text) await fsp.unlink(lock);
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const oldText = await smallFile(lock, 2048);
    let old;
    try { old = JSON.parse(oldText); } catch { throw failure('lock-invalid'); }
    if (old.version !== 1 || !Number.isInteger(old.pid) || old.pid < 1 || old.pid > 0x7fffffff || typeof old.token !== 'string' || !/^[a-f0-9-]{36}$/.test(old.token)) throw failure('lock-invalid');
    if (!processAlive(old.pid)) {
      if (await smallFile(lock, 2048) !== oldText) continue;
      await fsp.unlink(lock);
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw failure('preparation-busy');
}

async function prepareStage(stageRoot, identity, manifest, sourceRoot) {
  await ensureDirectory(stageRoot);
  const stage = path.join(stageRoot, identity);
  const manifestText = JSON.stringify(manifest);
  const pluginRows = manifest.files.filter(row => row.name.startsWith('lib/gstreamer-1.0/'));
  if (await inspectPath(stage, { directory: true, missing: true })) {
    await verifyStage(stage, manifestText, pluginRows);
    return stage;
  }
  const release = await acquireLock(path.join(stageRoot, `${identity}.lock`));
  try {
    if (await inspectPath(stage, { directory: true, missing: true })) {
      await verifyStage(stage, manifestText, pluginRows);
      return stage;
    }
    const preparing = path.join(stageRoot, `${identity}.preparing`);
    if (await inspectPath(preparing, { directory: true, missing: true })) {
      await verifyStage(preparing, manifestText, pluginRows, { preparing: true });
    } else {
      await ensureDirectory(preparing);
      await fsp.writeFile(path.join(preparing, 'manifest.json'), manifestText, { flag: 'wx' });
    }
    await ensureDirectory(path.join(preparing, 'plugins'));
    for (const row of pluginRows) {
      const target = path.join(preparing, 'plugins', path.basename(row.name));
      if (await inspectPath(target, { missing: true })) continue;
      const partial = `${target}.part`;
      if (await inspectPath(partial, { missing: true })) await fsp.unlink(partial);
      await fsp.copyFile(path.join(sourceRoot, ...row.name.split('/')), partial, fs.constants.COPYFILE_EXCL);
      const copied = await hashFile(partial);
      if (copied.sha256 !== row.sha256 || copied.bytes !== row.bytes) throw failure('source-changed');
      await fsp.rename(partial, target);
    }
    await ensureDirectory(path.join(preparing, 'registry'));
    await verifyStage(preparing, manifestText, pluginRows);
    await fsp.rename(preparing, stage);
    await verifyStage(stage, manifestText, pluginRows);
    return stage;
  } finally { await release(); }
}

function audioEnvironment(executable, stage, env) {
  const isolated = {};
  // The child needs only Windows process/filesystem context. In particular it
  // does not need application tokens, inherited plugin controls or loader hooks.
  for (const name of ['SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'OS']) {
    const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
    if (key && typeof env[key] === 'string') isolated[name] = env[key];
  }
  const bin = path.dirname(executable);
  const pluginDirectory = path.join(stage, 'plugins');
  const registry = path.join(stage, 'registry', 'registry.x86_64.bin');
  const scanner = path.join(path.dirname(bin), 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe');
  const windows = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  return Object.freeze({
    ...isolated,
    SystemRoot: windows, windir: windows,
    PATH: [bin, path.win32.join(windows, 'System32'), windows].join(path.delimiter),
    GST_PLUGIN_PATH: pluginDirectory, GST_PLUGIN_PATH_1_0: pluginDirectory,
    GST_PLUGIN_SYSTEM_PATH: '', GST_PLUGIN_SYSTEM_PATH_1_0: '',
    GST_REGISTRY: registry, GST_REGISTRY_1_0: registry,
    GST_PLUGIN_SCANNER: scanner, GST_PLUGIN_SCANNER_1_0: scanner,
    GST_PLUGIN_LOADING_WHITELIST: `coreelements,rawparse,audioconvert,audioresample,wasapi@${pluginDirectory}`,
    GST_REGISTRY_UPDATE: 'yes', GST_DEBUG_NO_COLOR: '1',
  });
}

async function prepareAudioRuntime(executable, env = process.env, options = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'gst-launch-1.0.exe' || path.basename(path.dirname(executable)).toLowerCase() !== 'bin') throw failure('executable-invalid');
  const absolute = path.resolve(executable);
  const stageRoot = path.resolve(options.stageRoot || DEFAULT_STAGE_ROOT);
  if (absolute.includes(path.delimiter) || stageRoot.includes(path.delimiter)) throw failure('path-separator');
  const approved = approvedManifest(options, stageRoot);
  const approvedText = JSON.stringify(approved);
  const key = `${absolute}\0${stageRoot}\0${digest(approvedText)}`;
  let preparation = preparations.get(key);
  if (!preparation) {
    preparation = (async () => {
      const manifest = await sourceManifest(absolute);
      if (JSON.stringify(manifest) !== approvedText) throw failure('unreviewed-source');
      const identity = digest(JSON.stringify(manifest));
      const stage = await prepareStage(stageRoot, identity, manifest, path.dirname(path.dirname(absolute)));
      return { executable: absolute, identity, stage };
    })();
    preparations.set(key, preparation);
    preparation.finally(() => { if (preparations.get(key) === preparation) preparations.delete(key); }).catch(() => {});
  }
  const prepared = await preparation;
  return Object.freeze({ executable: prepared.executable, identity: prepared.identity, env: audioEnvironment(prepared.executable, prepared.stage, env) });
}

module.exports = { AUDIO_PLUGIN_FILES, AUDIO_RUNTIME_DLLS, REVIEWED_SOURCE_MANIFEST, prepareAudioRuntime };
