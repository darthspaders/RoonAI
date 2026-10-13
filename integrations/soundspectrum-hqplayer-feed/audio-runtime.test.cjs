'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { AUDIO_PLUGIN_FILES, AUDIO_RUNTIME_DLLS, prepareAudioRuntime } = require('./audio-runtime.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-audio-runtime-'));
  assert.ok(path.isAbsolute(root));
  assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const files = [
    'bin/gst-launch-1.0.exe', 'bin/gst-inspect-1.0.exe',
    'libexec/gstreamer-1.0/gst-plugin-scanner.exe',
    ...AUDIO_PLUGIN_FILES.map(name => `lib/gstreamer-1.0/${name}`),
    ...AUDIO_RUNTIME_DLLS.map(name => `bin/${name}`),
  ];
  for (const name of files) {
    const file = path.join(runtime, ...name.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `inert offline fixture: ${name}`);
  }
  // These files must never be copied into the audio plugin directory.
  for (const name of ['gstd3d11.dll', 'gstqsv.dll', 'gstnvcodec.dll']) {
    await fs.writeFile(path.join(runtime, 'lib/gstreamer-1.0', name), `unrelated inert plugin: ${name}`);
  }
  const stageRoot = path.join(root, 'private-stage');
  const executable = path.join(runtime, 'bin', 'gst-launch-1.0.exe');
  let approvedManifest;
  const approve = async () => {
    const rows = [];
    for (const name of [...files].sort()) {
      const bytes = await fs.readFile(path.join(runtime, ...name.split('/')));
      rows.push({ name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    approvedManifest = { version: 1, runtimeVersion: '1.26.11', files: rows };
  };
  await approve();
  const prepare = env => prepareAudioRuntime(executable, env || {}, { stageRoot, approvedManifest });
  return { root, runtime, stageRoot, executable, prepare, approve, getApproved: () => approvedManifest };
}

test('stages only the five audio plugins and pins isolated paths and registry', async t => {
  const f = await fixture(t);
  const ambient = {
    Path: 'untrusted ambient PATH', pAtH: 'another ambient PATH',
    GST_PLUGIN_PATH_1_0: 'broad plugins', gst_plugin_system_path: 'more plugins',
    gst_registry_1_0: 'shared cache', Gst_Plugin_Scanner: 'untrusted scanner',
    GST_TRACERS: 'unwanted tracer', GST_PLUGIN_LOADING_WHITELIST: '*',
    GST_REGISTRY_UPDATE: 'no', GST_REGISTRY_FORK: 'no',
    GST_DEBUG: '*:9', GIO_EXTRA_MODULES: 'untrusted modules', G_DEBUG: 'fatal-warnings',
    ORC_CODE: 'untrusted ORC option', APP_SECRET: 'not serialized or inherited', TEMP: os.tmpdir(),
  };
  const before = JSON.stringify(ambient);
  const result = await f.prepare(ambient);
  assert.match(result.identity, /^[a-f0-9]{64}$/);
  assert.equal(result.executable, f.executable);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.env));
  assert.deepEqual((await fs.readdir(result.env.GST_PLUGIN_PATH_1_0)).sort(), [...AUDIO_PLUGIN_FILES].sort());
  assert.equal(result.env.GST_PLUGIN_SYSTEM_PATH_1_0, '');
  assert.equal(result.env.GST_PLUGIN_SYSTEM_PATH, '');
  assert.equal(result.env.GST_PLUGIN_PATH, result.env.GST_PLUGIN_PATH_1_0);
  assert.equal(result.env.GST_REGISTRY, result.env.GST_REGISTRY_1_0);
  assert.ok(result.env.GST_REGISTRY_1_0.startsWith(path.join(f.stageRoot, result.identity)));
  assert.equal(result.env.GST_PLUGIN_SCANNER_1_0, path.join(f.runtime, 'libexec/gstreamer-1.0/gst-plugin-scanner.exe'));
  assert.equal(result.env.GST_REGISTRY_UPDATE, 'yes');
  assert.equal(result.env.GST_DEBUG_NO_COLOR, '1');
  for (const name of ['Path', 'pAtH', 'gst_plugin_system_path', 'gst_registry_1_0', 'Gst_Plugin_Scanner', 'GST_TRACERS', 'GST_DEBUG', 'GST_REGISTRY_FORK', 'GIO_EXTRA_MODULES', 'G_DEBUG', 'ORC_CODE']) assert.equal(result.env[name], undefined);
  assert.ok(result.env.PATH.startsWith(`${path.dirname(f.executable)}${path.delimiter}`));
  assert.ok(!result.env.PATH.includes('untrusted'));
  assert.equal(result.env.APP_SECRET, undefined);
  assert.equal(result.env.TEMP, ambient.TEMP);
  assert.equal(JSON.stringify(ambient), before);
  const manifestText = await fs.readFile(path.join(f.stageRoot, result.identity, 'manifest.json'), 'utf8');
  assert.ok(!manifestText.includes(ambient.APP_SECRET));
  assert.equal(await fs.readdir(path.join(f.stageRoot, result.identity, 'registry')).then(files => files.length), 0);
  assert.deepEqual(await fs.readdir(f.stageRoot), [result.identity]);
});

test('later preparation rejects an added GPU plugin instead of trusting a warm result', async t => {
  const f = await fixture(t);
  const result = await f.prepare();
  const added = path.join(result.env.GST_PLUGIN_PATH_1_0, 'gstd3d11.dll');
  await fs.writeFile(added, 'inert added file');
  await assert.rejects(f.prepare(), /runtime-audio-unexpected-file/);
  assert.equal(await fs.readFile(added, 'utf8'), 'inert added file');
});

test('later preparation rejects modified staged bytes and never repairs a ready directory', async t => {
  const f = await fixture(t);
  const result = await f.prepare();
  const file = path.join(result.env.GST_PLUGIN_PATH_1_0, AUDIO_PLUGIN_FILES[0]);
  await fs.writeFile(file, 'modified staged plugin');
  await assert.rejects(f.prepare(), /runtime-audio-hash-mismatch/);
  assert.equal(await fs.readFile(file, 'utf8'), 'modified staged plugin');
});

test('source changes fail closed until explicitly reviewed, then create a new content identity', async t => {
  const f = await fixture(t);
  const first = await f.prepare();
  const source = path.join(f.runtime, 'lib/gstreamer-1.0', AUDIO_PLUGIN_FILES[0]);
  await fs.appendFile(source, ' changed source');
  await assert.rejects(f.prepare(), /runtime-audio-unreviewed-source/);
  await f.approve();
  const second = await f.prepare();
  assert.notEqual(second.identity, first.identity);
  assert.equal(await fs.readFile(path.join(second.env.GST_PLUGIN_PATH_1_0, AUDIO_PLUGIN_FILES[0]), 'utf8'), await fs.readFile(source, 'utf8'));
  await fs.appendFile(path.join(f.runtime, 'bin', AUDIO_RUNTIME_DLLS[0]), ' changed dependency');
  await assert.rejects(f.prepare(), /runtime-audio-unreviewed-source/);
  await f.approve();
  const third = await f.prepare();
  assert.notEqual(third.identity, second.identity);
  assert.notEqual(third.env.GST_REGISTRY_1_0, second.env.GST_REGISTRY_1_0);
  assert.deepEqual((await fs.readdir(f.stageRoot)).sort(), [first.identity, second.identity, third.identity].sort());
});

test('missing source dependencies fail closed and a later corrected preparation can succeed', async t => {
  const f = await fixture(t);
  const source = path.join(f.runtime, 'bin', AUDIO_RUNTIME_DLLS[0]);
  const original = await fs.readFile(source);
  await fs.unlink(source);
  await assert.rejects(f.prepare(), /runtime-audio-path-unavailable/);
  await fs.writeFile(source, original);
  const result = await f.prepare();
  assert.match(result.identity, /^[a-f0-9]{64}$/);
});

test('concurrent preparation shares only staging work and preserves each caller environment', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.prepare({ TEMP: 'first-private-temp' }), f.prepare({ TEMP: 'second-private-temp' })]);
  assert.equal(first.identity, second.identity);
  assert.notEqual(first.env, second.env);
  assert.equal(first.env.TEMP, 'first-private-temp');
  assert.equal(second.env.TEMP, 'second-private-temp');
  assert.deepEqual(await fs.readdir(f.stageRoot), [first.identity]);
});

test('interrupted known preparation resumes bounded partial copies and publishes atomically', async t => {
  const f = await fixture(t);
  const first = await f.prepare();
  const ready = path.join(f.stageRoot, first.identity);
  const partial = `${ready}.preparing`;
  await fs.rename(ready, partial);
  const missing = path.join(partial, 'plugins', AUDIO_PLUGIN_FILES[0]);
  await fs.unlink(missing);
  await fs.writeFile(`${missing}.part`, 'partial');
  const result = await f.prepare();
  assert.equal(result.identity, first.identity);
  assert.deepEqual(await fs.readdir(f.stageRoot), [first.identity]);
  assert.deepEqual((await fs.readdir(result.env.GST_PLUGIN_PATH_1_0)).sort(), [...AUDIO_PLUGIN_FILES].sort());
});

test('interrupted preparation with unexpected files remains untouched and unavailable', async t => {
  const f = await fixture(t);
  const result = await f.prepare();
  const ready = path.join(f.stageRoot, result.identity);
  const partial = `${ready}.preparing`;
  await fs.rename(ready, partial);
  const foreign = path.join(partial, 'plugins', 'gstqsv.dll');
  await fs.writeFile(foreign, 'foreign inert file');
  await assert.rejects(f.prepare(), /runtime-audio-unexpected-file/);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign inert file');
  assert.deepEqual(await fs.readdir(f.stageRoot), [`${result.identity}.preparing`]);
});

test('source directory links and private stage links are refused', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'runtime-link');
  await fs.symlink(f.runtime, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareAudioRuntime(path.join(alias, 'bin', 'gst-launch-1.0.exe'), {}, { stageRoot: f.stageRoot, approvedManifest: f.getApproved() }), /runtime-audio-link-refused/);
  const other = path.join(f.root, 'stage-target');
  await fs.mkdir(other);
  await fs.symlink(other, f.stageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.prepare(), /runtime-audio-link-refused/);
  assert.deepEqual(await fs.readdir(other), []);
});

test('hard-linked source and staged plugin files are refused', async t => {
  const f = await fixture(t);
  const source = path.join(f.runtime, 'lib/gstreamer-1.0', AUDIO_PLUGIN_FILES[0]);
  const link = path.join(f.root, 'source-hardlink');
  await fs.link(source, link);
  await assert.rejects(f.prepare(), /runtime-audio-link-refused/);
  await fs.unlink(link);
  const result = await f.prepare();
  await fs.link(path.join(result.env.GST_PLUGIN_PATH_1_0, AUDIO_PLUGIN_FILES[0]), path.join(f.root, 'stage-hardlink'));
  await assert.rejects(f.prepare(), /runtime-audio-link-refused/);
});

test('ready manifest changes or unexpected cache-directory plugins fail closed', async t => {
  const f = await fixture(t);
  const result = await f.prepare();
  const manifest = path.join(f.stageRoot, result.identity, 'manifest.json');
  const original = await fs.readFile(manifest);
  await fs.appendFile(manifest, ' ');
  await assert.rejects(f.prepare(), /runtime-audio-manifest-mismatch/);
  await fs.writeFile(manifest, original);
  await fs.writeFile(path.join(path.dirname(result.env.GST_REGISTRY_1_0), 'gstd3d12.dll'), 'inert unexpected cache file');
  await assert.rejects(f.prepare(), /runtime-audio-unexpected-file/);
});

test('an active preparation owner is never stolen and waiting is bounded', async t => {
  const f = await fixture(t);
  const result = await f.prepare();
  await fs.rename(path.join(f.stageRoot, result.identity), path.join(f.stageRoot, `${result.identity}.preparing`));
  const lock = path.join(f.stageRoot, `${result.identity}.lock`);
  const owner = JSON.stringify({ version: 1, pid: process.pid, token: crypto.randomUUID() });
  await fs.writeFile(lock, owner);
  await assert.rejects(f.prepare(), /runtime-audio-preparation-busy/);
  assert.equal(await fs.readFile(lock, 'utf8'), owner);
  await fs.unlink(lock);
  assert.equal((await f.prepare()).identity, result.identity);
});

test('invalid executable and empty source files cannot prepare a runnable environment', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareAudioRuntime('gst-launch-1.0.exe', {}, { stageRoot: f.stageRoot }), /runtime-audio-executable-invalid/);
  const tools = path.join(f.runtime, 'tools');
  await fs.mkdir(tools);
  const unverified = path.join(tools, 'gst-launch-1.0.exe');
  await fs.writeFile(unverified, 'unhashed executable');
  await assert.rejects(prepareAudioRuntime(unverified, {}, { stageRoot: f.stageRoot }), /runtime-audio-executable-invalid/);
  await fs.writeFile(f.executable, '');
  await assert.rejects(f.prepare(), /runtime-audio-file-size/);
});

test('production approval rejects unknown bytes and fixture approval cannot affect the default stage', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareAudioRuntime(f.executable, {}, { stageRoot: f.stageRoot }), /runtime-audio-unreviewed-source/);
  await assert.rejects(prepareAudioRuntime(f.executable, {}, { approvedManifest: f.getApproved() }), /runtime-audio-fixture-override-refused/);
  const production = path.resolve(__dirname, '../../data/soundspectrum-hqplayer-feed/audio-runtime');
  for (const stageRoot of [production, path.join(production, 'fixture'), path.join(production, 'fake-production-identity', 'plugins'), path.dirname(production)]) {
    await assert.rejects(prepareAudioRuntime(f.executable, {}, { stageRoot, approvedManifest: f.getApproved() }), /runtime-audio-fixture-override-refused/);
  }
  const unknown = structuredClone(f.getApproved());
  unknown.files[0].name = 'bin/gstd3d11-1.0-0.dll';
  await assert.rejects(prepareAudioRuntime(f.executable, {}, { stageRoot: f.stageRoot, approvedManifest: unknown }), /runtime-audio-manifest-invalid/);
  assert.equal(await fs.stat(f.stageRoot).catch(error => error.code), 'ENOENT');
});

test('path-list separators cannot inject an additional plugin or dependency directory', async t => {
  const f = await fixture(t);
  const stageRoot = `${f.stageRoot}${path.delimiter}extra-path`;
  await assert.rejects(prepareAudioRuntime(f.executable, {}, { stageRoot, approvedManifest: f.getApproved() }), /runtime-audio-path-separator/);
  const executable = path.join(`${f.runtime}${path.delimiter}extra-path`, 'bin', 'gst-launch-1.0.exe');
  await assert.rejects(prepareAudioRuntime(executable, {}, { stageRoot: f.stageRoot, approvedManifest: f.getApproved() }), /runtime-audio-path-separator/);
});
