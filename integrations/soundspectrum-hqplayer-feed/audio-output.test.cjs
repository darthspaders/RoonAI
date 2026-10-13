'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { discoverOutput, probeOutput, buildOutputCommand, validateOutput, watchOutput, createInputProvider, CAPTURE_NAME } = require('./audio-output.cjs');

const renderGuid = '11111111-1111-1111-1111-111111111111';
const captureGuid = '22222222-2222-2222-2222-222222222222';
const cable = {
  render: [{ id: `{0.0.0.00000000}.{${renderGuid}}`, sourceId: renderGuid, description: 'Stereo In', interfaceName: 'SoundSpectrum Audio Cable', name: 'Stereo In (SoundSpectrum Audio Cable)', state: 1, deviceIdentity: '{1}.ROOT\\MEDIA\\0002' }],
  capture: [{ id: `{0.0.1.00000000}.{${captureGuid}}`, sourceId: captureGuid, description: 'Stereo Out', interfaceName: 'SoundSpectrum Audio Cable', name: CAPTURE_NAME, state: 1, deviceIdentity: '{1}.ROOT\\MEDIA\\0002', listenKnown: true, listenEnabled: false }]
};

async function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'soundspectrum-output-'));
  const settingsPath = path.join(root, 'settings.json');
  let devices = structuredClone(cable);
  let calls = 0;
  const executable = path.join(root, 'bin', 'gst-launch-1.0.exe');
  const runtimeIdentity = crypto.createHash('sha256').update(root).digest('hex');
  const isolatedEnv = Object.freeze({ PATH: path.join(root, 'bin'), GST_PLUGIN_PATH_1_0: path.join(root, 'audio-only'),
    GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_REGISTRY_1_0: path.join(root, 'audio-only.registry.bin'), PRIVATE_TEST_SECRET: 'private runtime secret' });
  const options = { platform: 'win32', settingsPath, runDeviceProbe: async () => { calls++; return structuredClone(devices); },
    probeRuntime: async () => ({ executable }),
    prepareAudioRuntime: async selected => { assert.equal(selected, executable); return { executable, identity: runtimeIdentity, env: isolatedEnv }; } };
  const discovered = await discoverOutput(options);
  assert.equal(discovered.available, true);
  const settings = { version: 1, enabled: true, route: discovered.route };
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith('soundspectrum-output-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { options, settingsPath, settings, executable, runtimeIdentity, isolatedEnv,
    setDevices: value => { devices = structuredClone(value); }, calls: () => calls };
}

test('read-only discovery fingerprints the one exact SoundSpectrum cable pair without enabling settings', async t => {
  const f = await fixture(t);
  await fs.unlink(f.settingsPath);
  const discovered = await discoverOutput(f.options);
  assert.equal(discovered.available, true);
  assert.equal(discovered.route.renderId, cable.render[0].id);
  assert.equal(discovered.route.captureId, cable.capture[0].id);
  assert.equal(discovered.route.captureSourceId, captureGuid);
  assert.match(discovered.route.fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(f.settingsPath), { code: 'ENOENT' });
  assert.equal((await probeOutput(f.options)).reason, 'disabled');
});

test('output never falls back when disabled, missing a fingerprint, inactive, renamed, swapped, or Listen is unsafe', async t => {
  const f = await fixture(t);
  for (const [change, reason] of [
    [{ enabled: false }, 'disabled'],
    [{ route: { ...f.settings.route, fingerprint: undefined } }, 'route-not-configured'],
    [{ route: { ...f.settings.route, renderId: '' } }, 'route-not-configured']
  ]) {
    await fs.writeFile(f.settingsPath, JSON.stringify({ ...f.settings, ...change }));
    assert.equal((await probeOutput(f.options)).reason, reason);
  }
  await fs.writeFile(f.settingsPath, JSON.stringify(f.settings));
  for (const [change, reason] of [
    [{ state: 2 }, 'cable-inactive'],
    [{ listenKnown: false, listenEnabled: null }, 'listen-state-unknown'],
    [{ listenEnabled: true }, 'listen-enabled'],
    [{ interfaceName: 'VB-Audio Virtual Cable' }, 'cable-identity-mismatch'],
    [{ name: 'Different recording input' }, 'cable-identity-mismatch'],
    [{ deviceIdentity: '{1}.ROOT\\MEDIA\\0007' }, 'cable-identity-mismatch']
  ]) {
    const devices = structuredClone(cable); Object.assign(devices.capture[0], change); f.setDevices(devices);
    assert.equal((await probeOutput(f.options)).reason, reason);
  }
  f.setDevices({ render: [], capture: [] });
  assert.equal((await probeOutput(f.options)).reason, 'cable-unavailable');
});

test('shared WASAPI PCM command uses only the fresh verified immutable route and an explicit format', async t => {
  const f = await fixture(t);
  const probe = await probeOutput(f.options);
  assert.equal(probe.available, true);
  const command = buildOutputCommand({ probe, env: {} });
  assert.ok(command.args.includes('fd=0'));
  assert.ok(command.args.includes('pcm-format=s16le'));
  assert.ok(command.args.includes('sample-rate=44100'));
  assert.ok(command.args.includes('num-channels=2'));
  assert.ok(command.args.includes('wasapisink'));
  assert.ok(command.args.includes(`device=${cable.render[0].id}`));
  assert.ok(command.args.includes('exclusive=false'));
  assert.ok(command.args.includes('sync=false'), 'the supervisor-paced copy must survive raw timestamp gaps');
  assert.equal(command.args.includes('sync=true'), false);
  assert.equal(command.args.some(value => /asio|autoaudiosink|directsoundsink|device=default/i.test(value)), false);
  assert.deepEqual(command.inputFormat, { format: 'S16LE', sampleRate: 44100, channels: 2 });
  assert.deepEqual(command.env, f.isolatedEnv);
  assert.equal(Object.hasOwn(probe, 'env'), false);
  assert.equal(Object.hasOwn(probe, 'identity'), false);
  assert.doesNotMatch(JSON.stringify(probe), /private runtime secret|GST_PLUGIN|GST_REGISTRY/);
  assert.throws(() => buildOutputCommand({ probe: { ...probe } }), /fresh verified/);
  assert.throws(() => { probe.route.renderId = 'default'; }, TypeError);
  assert.throws(() => buildOutputCommand(), /fresh verified/);
});

test('the optional music input provider requires the exact native ID, name, interface and enabled route', async t => {
  const f = await fixture(t);
  const provider = createInputProvider(f.options);
  const raw = { id: captureGuid, name: CAPTURE_NAME, interfaceName: 'SoundSpectrum Audio Cable' };
  assert.deepEqual(await provider.list([raw]), [{ id: 'feed:hqplayer-analysis', name: 'HQPlayer music analysis (experimental)', kind: 'music-feed' }]);
  assert.deepEqual(await provider.resolve('feed:hqplayer-analysis', [raw]), { id: 'feed:hqplayer-analysis', name: CAPTURE_NAME, kind: 'music-feed' });
  assert.equal(await provider.resolve(captureGuid, [raw]), null);
  assert.deepEqual(await provider.list([{ ...raw, id: renderGuid }]), []);
  assert.deepEqual(await provider.list([{ ...raw, name: 'Microphone' }]), []);
  assert.deepEqual(await provider.list([{ ...raw, interfaceName: 'VB-Audio Virtual Cable' }]), []);
  await assert.rejects(provider.resolve('feed:hqplayer-analysis', []), /verified SoundSpectrum recording input/);
  await fs.writeFile(f.settingsPath, JSON.stringify({ ...f.settings, enabled: false }));
  assert.deepEqual(await provider.list([raw]), []);
  await assert.rejects(provider.resolve('feed:hqplayer-analysis', [raw]), /unavailable \(disabled\)/);
});

test('periodic validation fails closed exactly once when Listen changes after initial verification', async t => {
  const f = await fixture(t);
  const probe = await probeOutput(f.options);
  const unsafe = structuredClone(cable); unsafe.capture[0].listenEnabled = true; f.setDevices(unsafe);
  assert.equal((await validateOutput(probe, f.options)).reason, 'listen-enabled');
  let callbacks = 0;
  let resolveFailure;
  const failure = new Promise(resolve => { resolveFailure = resolve; });
  const stop = watchOutput(probe, result => { callbacks++; resolveFailure(result); }, { ...f.options, intervalMs: 250 });
  t.after(stop);
  const timeout = setTimeout(() => resolveFailure({ reason: 'test-timeout' }), 2000);
  const result = await failure; clearTimeout(timeout);
  assert.equal(result.reason, 'listen-enabled'); assert.equal(callbacks, 1);
  stop();
});

test('unavailable device probes and audio runtimes return safe reasons without constructing any pipeline', async t => {
  const f = await fixture(t);
  assert.equal((await probeOutput({ ...f.options, runDeviceProbe: async () => { throw new Error('Registry permission denied'); } })).reason, 'device-probe-unavailable');
  assert.equal((await probeOutput({ ...f.options, probeRuntime: async () => { throw new Error('runtime-unavailable'); } })).reason, 'runtime-unavailable');
  assert.equal((await probeOutput({ ...f.options, platform: 'linux' })).reason, 'windows-required');
});

test('six audio-only inspectors run sequentially and simultaneous probes share the validated runtime checks', async t => {
  const f = await fixture(t), inspected = []; let preparing = 0, inFlight = 0, peak = 0;
  const options = { ...f.options, probeRuntime: undefined, resolveGStreamer: () => f.executable,
    prepareAudioRuntime: async executable => { preparing++; return f.options.prepareAudioRuntime(executable); },
    runRuntimeInspection: async (executable, args, childOptions) => {
      assert.equal(executable, path.join(path.dirname(f.executable), 'gst-inspect-1.0.exe'));
      assert.deepEqual(childOptions.env, f.isolatedEnv);
      assert.equal(childOptions.windowsHide, true); assert.equal(childOptions.timeout, 8000);
      inspected.push(args[0]); inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve)); inFlight--;
      return { stdout: 'device : exact endpoint\nexclusive : false' };
    } };
  const probes = await Promise.all([probeOutput(options), probeOutput(options)]);
  assert.ok(probes.every(probe => probe.available)); assert.equal(preparing, 2); assert.equal(peak, 1);
  assert.deepEqual(inspected, ['fdsrc', 'rawaudioparse', 'queue', 'audioconvert', 'audioresample', 'wasapisink']);
  await probeOutput(options); assert.equal(preparing, 3); assert.equal(inspected.length, 6);
});

test('prepared runtime identity changes invalidate checks and preparation still validates every warm probe', async t => {
  const f = await fixture(t); let identity = f.runtimeIdentity, inspections = 0, preparationFails = false;
  const options = { ...f.options, probeRuntime: undefined, resolveGStreamer: () => f.executable,
    prepareAudioRuntime: async executable => {
      if (preparationFails) throw Error('runtime-plugin-membership-invalid');
      return { ...(await f.options.prepareAudioRuntime(executable)), identity };
    }, runRuntimeInspection: async () => { inspections++; return { stdout: 'device : endpoint\nexclusive : false' }; } };
  assert.equal((await probeOutput(options)).available, true); assert.equal(inspections, 6);
  assert.equal((await probeOutput(options)).available, true); assert.equal(inspections, 6);
  identity = 'b'.repeat(64);
  assert.equal((await probeOutput(options)).available, true); assert.equal(inspections, 12);
  preparationFails = true;
  const unavailable = await probeOutput(options);
  assert.equal(unavailable.available, false); assert.equal(unavailable.reason, 'runtime-plugin-membership-invalid'); assert.equal(inspections, 12);
  assert.throws(() => buildOutputCommand({ probe: unavailable }), /fresh verified/);
});

test('writer remains bound to its private isolated environment even with ambient and explicit broad plugin overrides', async t => {
  const f = await fixture(t), mutablePreparedEnv = { ...f.isolatedEnv };
  const broadEnv = { GST_PLUGIN_PATH_1_0: 'unsafe-video-directory', GST_PLUGIN_SYSTEM_PATH_1_0: 'unsafe-system-directory',
    GST_REGISTRY_1_0: 'unsafe-video-registry', PRIVATE_TEST_SECRET: 'ambient secret' };
  const probe = await probeOutput({ ...f.options, env: broadEnv, prepareAudioRuntime: async (executable, env) => {
    assert.equal(env, broadEnv); return { executable, identity: f.runtimeIdentity, env: mutablePreparedEnv };
  } });
  assert.equal(probe.available, true); mutablePreparedEnv.GST_PLUGIN_PATH_1_0 = 'mutated-video-directory';
  const command = buildOutputCommand({ probe, env: broadEnv });
  assert.equal(command.env.GST_PLUGIN_PATH_1_0, f.isolatedEnv.GST_PLUGIN_PATH_1_0);
  assert.equal(command.env.GST_PLUGIN_SYSTEM_PATH_1_0, ''); assert.equal(command.env.GST_REGISTRY_1_0, f.isolatedEnv.GST_REGISTRY_1_0);
  assert.equal(command.env.PRIVATE_TEST_SECRET, 'private runtime secret');
  assert.throws(() => { command.env.GST_PLUGIN_PATH_1_0 = 'unsafe-video-directory'; }, TypeError);
  assert.doesNotMatch(JSON.stringify(probe), /ambient secret|private runtime secret|unsafe|GST_/);
});

test('warm runtime checks retain each fresh probe environment privately instead of reusing the first child environment', async t => {
  const f = await fixture(t); let envVersion = 1, inspections = 0;
  const options = { ...f.options, probeRuntime: undefined, resolveGStreamer: () => f.executable,
    prepareAudioRuntime: async executable => ({ executable, identity: f.runtimeIdentity, env: { ...f.isolatedEnv, TEST_ENV_VERSION: String(envVersion) } }),
    runRuntimeInspection: async () => { inspections++; return { stdout: 'device : endpoint\nexclusive : false' }; } };
  const first = await probeOutput(options); envVersion = 2; const second = await probeOutput(options);
  assert.equal(inspections, 6); assert.equal(buildOutputCommand({ probe: first }).env.TEST_ENV_VERSION, '1');
  assert.equal(buildOutputCommand({ probe: second }).env.TEST_ENV_VERSION, '2');
  assert.equal(Object.hasOwn(first, 'env'), false); assert.equal(Object.hasOwn(second, 'env'), false);
});

test('failed inspector checks stop the sequence safely and can be retried after cache eviction', async t => {
  const f = await fixture(t); let fail = true, inspections = 0;
  const options = { ...f.options, probeRuntime: undefined, resolveGStreamer: () => f.executable,
    runRuntimeInspection: async () => {
      inspections++; if (fail) throw Error('private child failure with a path');
      return { stdout: 'device : endpoint\nexclusive : false' };
    } };
  assert.equal((await probeOutput(options)).reason, 'runtime-unavailable'); assert.equal(inspections, 1);
  fail = false; assert.equal((await probeOutput(options)).available, true); assert.equal(inspections, 7);
});

test('missing shared WASAPI properties and invalid prepared identities fail closed before writer construction', async t => {
  const f = await fixture(t); let inspections = 0;
  const options = { ...f.options, probeRuntime: undefined, resolveGStreamer: () => f.executable,
    runRuntimeInspection: async () => { inspections++; return { stdout: 'exclusive : false' }; } };
  const unavailable = await probeOutput(options); assert.equal(unavailable.reason, 'shared-wasapi-unavailable'); assert.equal(inspections, 6);
  assert.throws(() => buildOutputCommand({ probe: unavailable }), /fresh verified/);
  for (const changed of [{ identity: 'bad' }, { executable: 'relative-gst-launch.exe' }, { env: null }]) {
    assert.equal((await probeOutput({ ...f.options, prepareAudioRuntime: async executable => ({
      ...(await f.options.prepareAudioRuntime(executable)), ...changed }) })).reason, 'runtime-unavailable');
  }
});
