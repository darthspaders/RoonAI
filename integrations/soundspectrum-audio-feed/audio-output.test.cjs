'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { discoverOutput, probeOutput, buildOutputCommand, validateOutput, watchOutput, createInputProvider, CAPTURE_NAME } = require('./audio-output.cjs');

const renderGuid = '11111111-1111-1111-1111-111111111111';
const captureGuid = '22222222-2222-2222-2222-222222222222';
const cable = {
  render: [{ id: `{0.0.0.00000000}.{${renderGuid}}`, sourceId: renderGuid, description: 'Stereo In', interfaceName: 'SoundSpectrum Audio Cable', name: 'Stereo In (SoundSpectrum Audio Cable)', state: 1, deviceIdentity: '{1}.ROOT\\MEDIA\\0002' }],
  capture: [{ id: `{0.0.1.00000000}.{${captureGuid}}`, sourceId: captureGuid, description: 'Stereo Out', interfaceName: 'SoundSpectrum Audio Cable', name: CAPTURE_NAME, state: 1, deviceIdentity: '{1}.ROOT\\MEDIA\\0002', listenKnown: true, listenEnabled: false }]
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soundspectrum-output-'));
  const settingsPath = path.join(root, 'settings.json');
  let devices = structuredClone(cable);
  let calls = 0;
  const options = { platform: 'win32', settingsPath, runDeviceProbe: async () => { calls++; return structuredClone(devices); }, probeRuntime: async () => ({ executable: path.join(root, 'bin', 'gst-launch-1.0.exe') }) };
  const discovered = await discoverOutput(options);
  assert.equal(discovered.available, true);
  const settings = { version: 1, enabled: true, route: discovered.route };
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { options, settingsPath, settings, setDevices: value => { devices = structuredClone(value); }, calls: () => calls };
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
  assert.throws(() => buildOutputCommand({ probe: { ...probe } }), /fresh verified/);
  assert.throws(() => { probe.route.renderId = 'default'; }, TypeError);
  assert.throws(() => buildOutputCommand(), /fresh verified/);
});

test('the optional music input provider requires the exact native ID, name, interface and enabled route', async t => {
  const f = await fixture(t);
  const provider = createInputProvider(f.options);
  const raw = { id: captureGuid, name: CAPTURE_NAME, interfaceName: 'SoundSpectrum Audio Cable' };
  assert.deepEqual(await provider.list([raw]), [{ id: 'feed:pre-hqplayer', name: 'Player audio before HQPlayer', kind: 'music-feed' }]);
  assert.deepEqual(await provider.resolve('feed:pre-hqplayer', [raw]), { id: 'feed:pre-hqplayer', name: CAPTURE_NAME, kind: 'music-feed' });
  assert.equal(await provider.resolve(captureGuid, [raw]), null);
  assert.deepEqual(await provider.list([{ ...raw, id: renderGuid }]), []);
  assert.deepEqual(await provider.list([{ ...raw, name: 'Microphone' }]), []);
  assert.deepEqual(await provider.list([{ ...raw, interfaceName: 'VB-Audio Virtual Cable' }]), []);
  await assert.rejects(provider.resolve('feed:pre-hqplayer', []), /verified SoundSpectrum recording input/);
  await fs.writeFile(f.settingsPath, JSON.stringify({ ...f.settings, enabled: false }));
  assert.deepEqual(await provider.list([raw]), []);
  await assert.rejects(provider.resolve('feed:pre-hqplayer', [raw]), /unavailable \(disabled\)/);
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
