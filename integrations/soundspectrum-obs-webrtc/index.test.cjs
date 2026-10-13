'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { createIntegration, ObsClient, PROFILE, PROFILES, checkPorts, checkSrtPort } = require('./index.cjs');

const OFFER = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n';
const VIEWER = 'viewer_abcdefghijklmnopqrstuv';
const identity = { pid: 510, windowHandle: '910', windowTitle: 'Rabbit Hole G-Force RH-7af40e64-8e98-4b2b-a9ed-83458e4c4723',
  windowClass: 'Owned:Class#1', executable: 'C:\\Program Files\\SoundSpectrum\\G-Force Standalone.x64.exe', startTimeTicks: '638980000000000000' };
const encode = value => value.replace(/#/g, '#22').replace(/:/g, '#3A');
const captureSelector = identity => `${encode(identity.windowTitle)}:${encode(identity.windowClass)}:${encode(path.win32.basename(identity.executable))}`;
const expectedWindow = captureSelector(identity);
const productIdentity = (product, suffix = '.x64', captureId = '7af40e64-8e98-4b2b-a9ed-83458e4c4723') => ({ ...identity,
  windowTitle: `Rabbit Hole ${product} RH-${captureId}`, executable: `C:\\Program Files\\SoundSpectrum\\${product} Standalone${suffix}.exe` });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-obs-offline-'));
  t.after(async () => {
    await provider.stop().catch(() => {});
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rh-obs-offline-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  let selectedIdentity = overrides.nativeIdentity || identity;
  const obsRoot = path.join(root, 'obs'), obsExecutable = path.join(obsRoot, 'bin', '64bit', 'obs64.exe'), relayExecutable = path.join(root, 'mediamtx', 'mediamtx.exe');
  for (const file of [obsExecutable, relayExecutable]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'offline fixture; never executed'); }
  const config = { version: 1, obsVersion: '32.2.2', mediaMtxVersion: '1.21.1', obsRoot, obsExecutable, relayExecutable,
    lanAddress: '192.168.50.119', ports: { obs: 4565, http: 8899, api: 9996, udp: 8199 } };
  if (Object.hasOwn(overrides, 'qualityProfile')) config.qualityProfile = overrides.qualityProfile;
  if (Object.hasOwn(overrides, 'srtExperiment')) config.srtExperiment = overrides.srtExperiment;
  const quality = PROFILES[config.qualityProfile] || PROFILE;
  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(config));
  const calls = [], diagnostics = [], children = [], requests = [], relayRequests = [], failures = [], scheduled = [], waits = []; let active = true, inputSettings, bytes = 10000, clockValue = 10000, srtEnabled = false;
  const obs = {
    connect: async () => {}, close: () => calls.push('obs-close'),
    request: async (name, data = {}, timeoutMs) => {
      requests.push({ name, data, timeoutMs });
      if (overrides.obsRequest) { const custom = await overrides.obsRequest(name, data); if (custom !== undefined) return custom; }
      if (name === 'GetVersion') return { obsVersion: '32.2.2' };
      if (name === 'GetInputList') return { inputs: [] };
      if (name === 'GetSpecialInputs') return { desktop1: null, desktop2: null, mic1: null, mic2: null, mic3: null, mic4: null };
      if (name === 'GetVideoSettings') return { baseWidth: quality.width, baseHeight: quality.height, outputWidth: quality.width, outputHeight: quality.height, fpsNumerator: quality.targetFps, fpsDenominator: 1 };
      if (name === 'CreateInput') return { sceneItemId: 1 };
      if (name === 'GetSceneItemTransform') return { sceneItemTransform: { sourceWidth: quality.width, sourceHeight: quality.height, scaleX: 1, scaleY: 1, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: quality.width, boundsHeight: quality.height } };
      if (name === 'GetInputPropertiesListPropertyItems') return { propertyItems: [{ itemValue: captureSelector(selectedIdentity), itemEnabled: true }] };
      if (name === 'SetInputSettings') inputSettings = data.inputSettings;
      if (name === 'GetInputSettings') return { inputSettings };
      return {};
    }
  };
  const provider = createIntegration({ runtimeRoot: overrides.runtimeRoot || root, clock: () => clockValue, sleep: async (ms, signal) => {
    waits.push(ms); await overrides.sleep?.(ms, signal); clockValue += ms;
  },
    processProbe: overrides.processProbe, ownerFs: overrides.ownerFs,
    onStartupDiagnostic: value => { diagnostics.push(value); overrides.onStartupDiagnostic?.(value); },
    highBitrate: overrides.highBitrate || { inspect: async () => ({ available: false }) },
    checkPorts: async () => calls.push('ports'), createObsClient: () => obs,
    checkSrtPort: async value => { calls.push({ srtPort: value.srtExperiment.port, address: value.lanAddress }); if (overrides.checkSrtPort) await overrides.checkSrtPort(value); },
    setTimeoutImpl: (fn, ms) => { const timer = { fn, ms, unref() {} }; scheduled.push(timer); return timer; },
    spawnImpl: (executable, args, opts) => { const child = new EventEmitter(); child.pid = 700 + children.length; child.kill = () => { calls.push(`handle-kill-${child.pid}`); queueMicrotask(() => child.emit('exit')); return true; }; children.push({ child, executable, args, opts }); return child; },
    processAction: async (action, data) => {
      calls.push({ action, data });
      if (overrides.processAction) { const custom = await overrides.processAction(action, data); if (custom !== undefined) return custom; }
      return action === 'identity' ? { pid: data.ProcessId, executable: data.ExpectedExecutable, startTimeTicks: '638980000000000000' } : { terminated: true };
    },
    fetchImpl: async (url, init) => {
      relayRequests.push({ url, init });
      if (overrides.fetchImpl) { const custom = await overrides.fetchImpl(url, init); if (custom !== undefined) return custom; }
      if (new URL(url).pathname === '/v3/config/global/patch') { srtEnabled = JSON.parse(init.body).srt; return new Response(JSON.stringify({ status: 'ok' }), { status: 200 }); }
      if (new URL(url).pathname === '/v3/config/global/get') return new Response(JSON.stringify({ srt: srtEnabled }), { status: 200 });
      if (new URL(url).pathname === '/v3/srt/conns/list') return new Response(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }), { status: 200 });
      if (new URL(url).pathname.startsWith('/v3/paths/get/')) return new Response(JSON.stringify({ ready: true, bytesReceived: bytes += 10000, tracks: ['H264', 'Opus'] }), { status: 200 });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(OFFER, { status: 201, headers: { 'Content-Type': 'application/sdp', Location: `${new URL(url).pathname}/1b26a3cb-9f3d-4bd4-8e76-632b4e450403` } });
    }
  });
  const start = extra => provider.start({ window: { ...selectedIdentity, width: quality.width, height: quality.height }, nativeIdentity: selectedIdentity,
    observeWindow: async () => ({ ...selectedIdentity, width: quality.width, height: quality.height }), generation: 4, isCurrent: () => active,
    onReady: () => calls.push('ready'), onFailure: error => failures.push(error.message), ...extra });
  return { provider, start, config, root, obs, calls, diagnostics, children, requests, relayRequests, failures, waits,
    setIdentity: value => { selectedIdentity = value; }, deactivate: () => { active = false; }, advance: ms => { clockValue += ms; },
    tickMonitor: async () => { const timer = scheduled.shift(); assert.ok(timer, 'existing publisher monitor is scheduled'); assert.equal(timer.ms, 2000); await timer.fn(); } };
}

test('inspection reads preparation only and exposes configured values', async t => {
  const f = await fixture(t); const value = await f.provider.inspect();
  assert.equal(value.available, true); assert.deepEqual(value.profile, PROFILE);
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0); assert.equal(f.relayRequests.length, 0);
  await fs.writeFile(path.join(f.root, 'runtime.json'), JSON.stringify({ ...f.config, lanAddress: '192.168.999.2' }));
  assert.equal((await f.provider.inspect()).available, false); assert.equal(f.calls.length, 0);
});

for (const qualityProfile of ['4k60', '4k60-60']) test(`${qualityProfile} is immutable and inspection is passive`, async t => {
  const f = await fixture(t, { qualityProfile }); const value = await f.provider.inspect();
  assert.equal(PROFILE.id, '1080p60'); assert.equal(PROFILE.nativeWindowMode, 'windowed');
  assert.equal(value.available, true); assert.deepEqual(value.profile, PROFILES[qualityProfile]);
  assert.equal(value.profile.nativeWindowMode, 'borderless-fullscreen');
  assert.throws(() => { PROFILES[qualityProfile].width = 1920; }, TypeError);
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0); assert.equal(f.relayRequests.length, 0);
});

test('4K startup preserves native capture size, configures 80 Mbps and retains its selected profile', async t => {
  const f = await fixture(t, { qualityProfile: '4k60' }); const value = await f.start({ expectedProfileId: '4k60' });
  assert.deepEqual(value.profile, PROFILES['4k60']); assert.equal(value.state, 'running');
  for (const name of ['nativeClientResolution', 'captureSourceResolution', 'outputSettingsResolution']) assert.deepEqual(value[name], { width: 3840, height: 2160 });
  assert.equal(f.requests.find(x => x.name === 'SetSceneItemTransform').data.sceneItemTransform.boundsWidth, 3840);
  assert.equal(f.requests.find(x => x.name === 'SetSceneItemTransform').data.sceneItemTransform.boundsHeight, 2160);
  const profileRoot = path.join(f.config.obsRoot, 'config', 'obs-studio', 'basic', 'profiles', 'RabbitHoleVisualizer');
  const ini = await fs.readFile(path.join(profileRoot, 'basic.ini'), 'utf8');
  assert.match(ini, /BaseCX=3840\nBaseCY=2160\nOutputCX=3840\nOutputCY=2160\n/);
  assert.match(ini, /FPSCommon=60\nColorFormat=NV12\nColorSpace=709\nColorRange=Partial\n/);
  const encoder = JSON.parse(await fs.readFile(path.join(profileRoot, 'streamEncoder.json')));
  assert.equal(encoder.rate_control, 'CBR'); assert.equal(encoder.bitrate, 80000); assert.equal(encoder.max_bitrate, 80000);
  assert.equal(encoder.bf, 0); assert.equal(encoder.preset, 'p5'); assert.equal(encoder.tune, 'll'); assert.equal(encoder.lookahead, false);
  await fs.writeFile(path.join(f.root, 'runtime.json'), JSON.stringify({ ...f.config, qualityProfile: '1080p60' }));
  assert.equal((await f.provider.inspect()).profile.id, '1080p60');
  value.profile.width = 1; assert.deepEqual(f.provider.snapshot().profile, PROFILES['4k60']);
  await f.provider.stop();
  assert.deepEqual(f.calls.filter(x => x.action === 'terminate').map(x => x.data.ProcessId), [701, 700]);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

test('invalid quality profiles fail before acquiring ownership or writing an OBS profile', async t => {
  const f = await fixture(t);
  for (const qualityProfile of [null, '', 'maximum', 'toString', 4]) {
    await fs.writeFile(path.join(f.root, 'runtime.json'), JSON.stringify({ ...f.config, qualityProfile }));
    assert.equal((await f.provider.inspect()).available, false);
    await assert.rejects(f.start(), /configuration is invalid/);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0); assert.equal(f.relayRequests.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.config.obsRoot, 'config')), { code: 'ENOENT' });
});

for (const [before, after] of [['1080p60', '4k60'], ['4k60', '4k60-60'], ['4k60-60', '4k60']]) test(`a quality profile changed from ${before} to ${after} after inspection is rejected before ownership or native observation`, async t => {
  const f = await fixture(t, { qualityProfile: before }); const inspected = await f.provider.inspect();
  await fs.writeFile(path.join(f.root, 'runtime.json'), JSON.stringify({ ...f.config, qualityProfile: after }));
  let observed = false;
  await assert.rejects(f.start({ expectedProfileId: inspected.profile.id, observeWindow: async () => { observed = true; return {}; } }), /quality profile changed/);
  assert.equal(observed, false); assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

test('4K rejects a smaller initial client area before starting helpers', async t => {
  const f = await fixture(t, { qualityProfile: '4k60' });
  await assert.rejects(f.start({ expectedProfileId: '4k60', window: { ...identity, width: 1920, height: 1080 } }), /upscaling is disabled/);
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

for (const qualityProfile of ['4k60', '4k60-60']) test(`${qualityProfile} rejects a changed initial client area before starting helpers`, async t => {
  const f = await fixture(t, { qualityProfile });
  await assert.rejects(f.start({ expectedProfileId: qualityProfile, observeWindow: async () => ({ ...identity, width: 1920, height: 1080 }) }), /upscaling is disabled/);
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

for (const qualityProfile of ['4k60', '4k60-60']) test(`${qualityProfile} output settings cannot silently fall back to a lower resolution`, async t => {
  const f = await fixture(t, { qualityProfile, obsRequest: name => name === 'GetVideoSettings' ? { baseWidth: 3840, baseHeight: 2160, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 } : undefined });
  await assert.rejects(f.start({ expectedProfileId: qualityProfile }), /video profile/);
  assert.equal(f.requests.some(x => x.name === 'StartStream'), false);
  assert.deepEqual(f.calls.filter(x => x.action === 'terminate').map(x => x.data.ProcessId), [701, 700]);
});

test('4K does not report a lower resolution source as a successful 4K capture', async t => {
  const f = await fixture(t, { qualityProfile: '4k60', obsRequest: name => name === 'GetSceneItemTransform' ? { sceneItemTransform: { sourceWidth: 1920, sourceHeight: 1080 } } : undefined });
  await assert.rejects(f.start({ expectedProfileId: '4k60' }), /capture surface/);
  assert.equal(f.calls.includes('ready'), false);
  assert.deepEqual(f.calls.filter(x => x.action === 'terminate').map(x => x.data.ProcessId), [701, 700]);
});

for (const qualityProfile of ['4k60', '4k60-60']) for (const product of ['G-Force', 'Aeon', 'WhiteCap']) {
  const targetBitrateMbps = PROFILES[qualityProfile].targetBitrateMbps;
  test(`${product} ${qualityProfile} uses its exact owned 4K WGC selector and video-only ${targetBitrateMbps} Mbps profile`, async t => {
    const nativeIdentity = productIdentity(product), f = await fixture(t, { qualityProfile, nativeIdentity });
    const inspected = await f.provider.inspect(); assert.deepEqual(inspected.profile, PROFILES[qualityProfile]);
    const value = await f.start({ expectedProfileId: inspected.profile.id });
    assert.equal(value.state, 'running'); assert.deepEqual(value.profile, inspected.profile);
    for (const field of ['nativeClientResolution', 'captureSourceResolution', 'outputSettingsResolution']) assert.deepEqual(value[field], { width: 3840, height: 2160 });
    const settings = f.requests.find(request => request.name === 'SetInputSettings').data.inputSettings;
    assert.deepEqual(settings, { window: captureSelector(nativeIdentity), method: 2, priority: 0, cursor: false, capture_audio: false, client_area: true, force_sdr: true });
    const profileRoot = path.join(f.config.obsRoot, 'config', 'obs-studio', 'basic', 'profiles', 'RabbitHoleVisualizer');
    const encoder = JSON.parse(await fs.readFile(path.join(profileRoot, 'streamEncoder.json')));
    assert.equal(encoder.bitrate, targetBitrateMbps * 1000); assert.equal(encoder.max_bitrate, targetBitrateMbps * 1000);
    assert.equal(encoder.bf, 0); assert.equal(encoder.rate_control, 'CBR');
    assert.match(await fs.readFile(path.join(profileRoot, 'basic.ini'), 'utf8'), /BaseCX=3840\nBaseCY=2160\nOutputCX=3840\nOutputCY=2160\n/);
    assert.equal(f.children.length, 2); assert.equal(f.requests.filter(request => request.name === 'StartStream').length, 1);
    const reader = await f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER });
    assert.equal(reader.status, 201);
    await f.provider.stop();
    assert.equal(f.provider.snapshot().generation, null);
    assert.equal(f.relayRequests.filter(request => request.init.method === 'DELETE').length, 1);
    await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
  });

  test(`${product} ${qualityProfile} retry selects its new capture identity and rejects the old generation`, async t => {
    const firstIdentity = productIdentity(product), f = await fixture(t, { qualityProfile, nativeIdentity: firstIdentity });
    await f.start({ expectedProfileId: qualityProfile });
    await f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER });
    await f.provider.stop();
    const nextIdentity = { ...productIdentity(product, '.x64', 'ed0c53f5-f7ef-42ef-a80c-ac6d5462db5b'), pid: 511, windowHandle: '911', startTimeTicks: '638980000000000001' };
    f.setIdentity(nextIdentity);
    const restarted = await f.start({ expectedProfileId: qualityProfile, generation: 5 });
    assert.equal(restarted.generation, 5); assert.equal(restarted.state, 'running');
    const selections = f.requests.filter(request => request.name === 'SetInputSettings').map(request => request.data.inputSettings.window);
    assert.deepEqual(selections, [captureSelector(firstIdentity), captureSelector(nextIdentity)]);
    await assert.rejects(f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER }), /unavailable/);
    assert.equal((await f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 5, body: OFFER })).status, 201);
    assert.equal(f.children.length, 4);
    await f.provider.stop();
    assert.deepEqual(f.calls.filter(call => call.action === 'terminate').map(call => call.data.ProcessId), [701, 700, 703, 702]);
  });

  test(`${product} ${qualityProfile} rejects initial client upscaling and a lower OBS capture surface`, async t => {
    const nativeIdentity = productIdentity(product); let lowerSource = true;
    const f = await fixture(t, { qualityProfile, nativeIdentity,
      obsRequest: name => name === 'GetSceneItemTransform' && lowerSource ? { sceneItemTransform: { sourceWidth: 1920, sourceHeight: 1080 } } : undefined });
    await assert.rejects(f.start({ expectedProfileId: qualityProfile, window: { ...nativeIdentity, width: 1920, height: 1080 } }), /upscaling is disabled/);
    assert.equal(f.children.length, 0); assert.equal(f.calls.length, 0);
    await assert.rejects(f.start({ expectedProfileId: qualityProfile }), /capture surface/);
    assert.equal(f.calls.includes('ready'), false);
    assert.equal(f.provider.snapshot().state, 'idle');
    await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
    lowerSource = false;
    assert.equal((await f.start({ expectedProfileId: qualityProfile, generation: 5 })).state, 'running', 'A failed startup must release only its helpers and permit explicit retry');
  });
}

test('cross-product native titles and executable names fail before ownership or capture', async t => {
  const f = await fixture(t, { qualityProfile: '4k60' });
  for (const titledProduct of ['G-Force', 'Aeon', 'WhiteCap']) for (const executableProduct of ['G-Force', 'Aeon', 'WhiteCap']) {
    if (titledProduct === executableProduct) continue;
    const mixedIdentity = { ...productIdentity(titledProduct), executable: productIdentity(executableProduct).executable };
    let observed = false;
    await assert.rejects(f.start({ nativeIdentity: mixedIdentity, window: { ...mixedIdentity, width: 3840, height: 2160 },
      observeWindow: async () => { observed = true; return mixedIdentity; } }), /exact owned/);
    assert.equal(observed, false);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.relayRequests.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

test('every product rejects ambiguous OBS selectors and a different same-product window', async t => {
  for (const product of ['G-Force', 'Aeon', 'WhiteCap']) for (const ambiguous of [true, false]) {
    const nativeIdentity = productIdentity(product), anotherIdentity = productIdentity(product, '.x64', 'ed0c53f5-f7ef-42ef-a80c-ac6d5462db5b');
    const values = ambiguous ? [captureSelector(nativeIdentity), captureSelector(nativeIdentity)] : [captureSelector(anotherIdentity)];
    const f = await fixture(t, { qualityProfile: '4k60', nativeIdentity,
      obsRequest: name => name === 'GetInputPropertiesListPropertyItems' ? { propertyItems: values.map(itemValue => ({ itemValue, itemEnabled: true })) } : undefined });
    await assert.rejects(f.start({ expectedProfileId: '4k60' }), /uniquely select/);
    assert.equal(f.requests.some(request => request.name === 'SetInputSettings' || request.name === 'StartStream'), false);
    assert.equal(f.calls.includes('ready'), false); assert.equal(f.provider.snapshot().state, 'idle');
    assert.deepEqual(f.calls.filter(call => call.action === 'terminate').map(call => call.data.ProcessId), [701, 700]);
    await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
  }
});

test('all three product identities retain 32-bit filename support and case-insensitive correlation', async t => {
  for (const product of ['G-Force', 'Aeon', 'WhiteCap']) {
    const nativeIdentity = productIdentity(product, ''); nativeIdentity.executable = nativeIdentity.executable.toUpperCase();
    const f = await fixture(t, { nativeIdentity });
    assert.equal((await f.start()).state, 'running');
    assert.equal(f.requests.find(request => request.name === 'SetInputSettings').data.inputSettings.window, captureSelector(nativeIdentity));
    await f.provider.stop();
  }
});

test('malformed title or executable identities fail safely before helper acquisition', async t => {
  const f = await fixture(t);
  for (const replacement of [{ executable: null }, { executable: 3 }, { windowTitle: null }, { windowTitle: {} },
    { windowTitle: 'Rabbit Hole Aeon RH-not-a-unique-id' }, { executable: 'C:\\Other\\Aeon.exe' }]) {
    await assert.rejects(f.start({ nativeIdentity: { ...identity, ...replacement } }), /exact owned/);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
});

test('owned start keeps audio disabled, exact WGC selection, portable profile and private endpoints', async t => {
  const f = await fixture(t); const value = await f.start();
  assert.deepEqual(value.profile, PROFILE); assert.equal(value.profile.targetBitrateMbps, 25);
  assert.equal(value.state, 'running'); assert.deepEqual(value.outputSettingsResolution, { width: 1920, height: 1080 });
  assert.deepEqual(value.captureSourceResolution, { width: 1920, height: 1080 }); assert.deepEqual(value.nativeClientResolution, { width: 1920, height: 1080 });
  assert.equal(value.payloadBitrateMbps, null); assert.equal(f.calls.filter(x => x === 'ready').length, 1);
  assert.equal(f.children.length, 2);
  assert.ok(f.children[1].args.includes('--portable')); assert.ok(f.children[1].args.includes('--disable-shutdown-check'));
  assert.ok(f.children.every(x => x.opts.windowsHide && x.opts.shell === false));
  assert.ok(f.children.every(x => !Object.keys(x.opts.env).some(key => /^(MTX_|RTSP_)/i.test(key))));
  const set = f.requests.find(x => x.name === 'SetInputSettings').data.inputSettings;
  assert.deepEqual(set, { window: expectedWindow, method: 2, priority: 0, cursor: false, capture_audio: false, client_area: true, force_sdr: true });
  const scene = JSON.parse(await fs.readFile(path.join(f.config.obsRoot, 'config', 'obs-studio', 'basic', 'scenes', 'RabbitHoleVisualizer.json')));
  const encoder = JSON.parse(await fs.readFile(path.join(f.config.obsRoot, 'config', 'obs-studio', 'basic', 'profiles', 'RabbitHoleVisualizer', 'streamEncoder.json')));
  assert.equal(encoder.bitrate, 25000); assert.equal(encoder.max_bitrate, 25000);
  assert.equal(scene.desktop_audio_device1, null); assert.equal(scene.aux_audio_device1, null);
  assert.deepEqual(scene.sources.map(x => x.id), ['scene']);
  const portableUser = await fs.readFile(path.join(f.config.obsRoot, 'config', 'obs-studio', 'user.ini'), 'utf8');
  assert.match(portableUser, /\[Video\]\nAdapterIdx=0\n/);
  const relay = JSON.parse(await fs.readFile(path.join(f.root, 'mediamtx.json')));
  assert.equal(relay.apiAddress, '127.0.0.1:9996'); assert.equal(relay.webrtcAddress, '127.0.0.1:8899');
  assert.equal(relay.rtsp, false); assert.equal(relay.rtmp, false); assert.equal(relay.moq, false);
  assert.deepEqual(relay.authInternalUsers[0].ips, ['127.0.0.1', '::1']);
  await Promise.all([f.provider.stop(), f.provider.stop()]);
  assert.deepEqual(f.calls.filter(x => x.action === 'terminate').map(x => x.data.ProcessId), [701, 700]);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

test('missing exact window choice fails closed without starting the stream', async t => {
  const f = await fixture(t, { obsRequest: name => name === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [{ itemValue: 'Some other window:Class:app.exe', itemEnabled: true }] } : undefined });
  await assert.rejects(f.start(), /uniquely select/); assert.equal(f.requests.some(x => x.name === 'StartStream'), false);
  assert.equal(f.calls.filter(x => x.action === 'terminate').length, 2);
});

test('existing audio device rejects before capture is enabled', async t => {
  const f = await fixture(t, { obsRequest: name => name === 'GetSpecialInputs' ? { desktop1: 'Desktop Audio' } : undefined });
  await assert.rejects(f.start(), /audio device/); assert.equal(f.requests.some(x => x.name === 'CreateInput'), false);
});

test('unowned generic native title never starts helpers', async t => {
  const f = await fixture(t); await assert.rejects(f.start({ nativeIdentity: { ...identity, windowTitle: 'G-Force' } }), /exact owned/);
  assert.equal(f.children.length, 0); assert.equal(f.calls.length, 0);
});

test('stop waits for delayed helper identity and then releases that exact helper', async t => {
  const pending = deferred(), entered = deferred();
  const f = await fixture(t, { processAction: async (action, data) => {
    if (action === 'identity' && data.ProcessId === 700) { entered.resolve(); await pending.promise; }
  } });
  const starting = f.start(); const rejected = assert.rejects(starting, /session changed/); await entered.promise;
  const stopping = f.provider.stop(); assert.equal(f.calls.some(x => x.action === 'terminate'), false);
  pending.resolve(); await stopping; await rejected;
  assert.deepEqual(f.calls.filter(x => x.action === 'terminate').map(x => x.data.ProcessId), [700]);
  assert.equal(f.children.length, 1);
});

test('failed identity only kills the process handle returned by this spawn', async t => {
  const f = await fixture(t, { processAction: (action, data) => action === 'identity' && data.ProcessId === 700 ? {} : undefined });
  await assert.rejects(f.start(), /identity/); assert.ok(f.calls.includes('handle-kill-700'));
  assert.equal(f.calls.some(x => x.action === 'terminate'), false);
});

test('failed exact helper termination preserves the ownership record', async t => {
  const f = await fixture(t, { processAction: action => { if (action === 'terminate') throw Error('offline failure'); } });
  await f.start(); await assert.rejects(f.provider.stop(), /ownership record was preserved/);
  assert.ok((await fs.stat(path.join(f.root, 'owner.lock'))).isFile());
  await assert.rejects(f.start(), /already has an owner/);
});

function deadObsOwner(f) {
  const owner = { pid: 30101, executable: process.execPath, startTimeTicks: '638980000000000000' }, epoch = 'stale_owner_abcdefghijklmnopqrstuv';
  return { lock: { owner: { ...owner }, epoch }, record: { version: 1, owner: { ...owner }, epoch, processes: [
    { pid: 30102, executable: f.config.relayExecutable, startTimeTicks: '638980000000000001' },
    { pid: 30103, executable: f.config.obsExecutable, startTimeTicks: '638980000000000002' }
  ] } };
}
async function writeDeadObsOwner(f, value = deadObsOwner(f)) {
  const lock = JSON.stringify(value.lock), record = JSON.stringify(value.record);
  await fs.writeFile(path.join(f.root, 'owner.lock'), lock); await fs.writeFile(path.join(f.root, 'owner.json'), record);
  return { lock, record };
}
async function assertObsOwner(f, bytes) {
  assert.equal(await fs.readFile(path.join(f.root, 'owner.lock'), 'utf8'), bytes.lock);
  assert.equal(await fs.readFile(path.join(f.root, 'owner.json'), 'utf8'), bytes.record);
}

test('explicit Start recovers only a complete matching OBS record with absent parent and both private helpers', async t => {
  const seen = [], f = await fixture(t, { processProbe: pid => { seen.push(pid); return 'absent'; } });
  const old = deadObsOwner(f); await writeDeadObsOwner(f, old); await f.start();
  assert.deepEqual(seen, [30101, 30102, 30103, 30101, 30102, 30103]);
  const fresh = JSON.parse(await fs.readFile(path.join(f.root, 'owner.json')));
  assert.equal(fresh.owner.pid, process.pid); assert.notEqual(fresh.epoch, old.record.epoch); assert.equal(f.children.length, 2);
  assert.equal(f.calls.some(value => value.action === 'terminate'), false);
  await assert.rejects(fs.access(path.join(f.root, 'owner.lock.recovery')), { code: 'ENOENT' });
  await f.provider.stop(); await assert.rejects(fs.access(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.root, 'owner.json')), { code: 'ENOENT' });
});

test('OBS inspection never probes or changes stale ownership', async t => {
  let probes = 0; const f = await fixture(t, { processProbe: () => { probes++; return 'absent'; } });
  const bytes = await writeDeadObsOwner(f); await f.provider.inspect(); await assertObsOwner(f, bytes);
  assert.equal(probes, 0); assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  await assert.rejects(fs.access(path.join(f.root, 'owner.lock.recovery')), { code: 'ENOENT' });
});

test('live or reused OBS owner/helper PIDs and denied or unknown probes retain both ownership records', async t => {
  for (const pid of [30101, 30102, 30103]) for (const status of ['present', 'unknown', 'EPERM', 'unexpected-error']) {
    const f = await fixture(t, { processProbe: probed => {
      if (probed !== pid) return 'absent';
      if (status === 'EPERM' || status === 'unexpected-error') throw Object.assign(Error('denied'), { code: status });
      return status;
    } });
    const bytes = await writeDeadObsOwner(f); await assert.rejects(f.start(), /already has an owner/); await assertObsOwner(f, bytes);
    assert.equal(f.children.length, 0); assert.equal(f.calls.some(value => value.action === 'terminate'), false);
  }
});

test('mismatched, partial, pending or unfamiliar OBS ownership cannot authorize recovery', async t => {
  const mutations = [
    value => { value.lock.epoch = 'different_owner_abcdefghijklmnopqrstuv'; }, value => { value.lock.owner.pid = 30109; },
    value => { value.lock.owner.startTimeTicks = '638980000000000003'; }, value => { value.record.version = 2; },
    value => { value.record.processes.pop(); }, value => { value.record.processes[0].pendingIdentity = true; },
    value => { value.record.processes[0].pid = null; }, value => { value.record.processes[0].pid = value.record.owner.pid; },
    value => { value.record.processes[0].startTimeTicks = null; }, value => { value.record.processes[0].executable = process.execPath; },
    value => { value.record.processes[1] = { ...value.record.processes[0], pid: 30104 }; },
    value => { value.record.owner.executable = value.lock.owner.executable = 'unknown-node.exe'; },
    value => { value.record.unknown = true; }, value => { value.lock.unknown = true; }
  ];
  for (const mutate of mutations) {
    let probes = 0; const f = await fixture(t, { processProbe: () => { probes++; return 'absent'; } }), value = deadObsOwner(f); mutate(value);
    const bytes = await writeDeadObsOwner(f, value); await assert.rejects(f.start(), /already has an owner/); await assertObsOwner(f, bytes);
    assert.equal(probes, 0); assert.equal(f.children.length, 0);
  }
  for (const which of ['owner.lock', 'owner.json']) for (const content of [null, '{partial', ' '.repeat(65537)]) {
    const f = await fixture(t, { processProbe: () => 'absent' }); await writeDeadObsOwner(f);
    if (content === null) await fs.rm(path.join(f.root, which)); else await fs.writeFile(path.join(f.root, which), content);
    // A missing lock is a normal wx claim, so test only missing JSON under an existing lock.
    if (which === 'owner.lock' && content === null) continue;
    await assert.rejects(f.start(), /already has an owner/); assert.equal(f.children.length, 0);
    if (content !== null) assert.equal(await fs.readFile(path.join(f.root, which), 'utf8'), content);
  }
});

test('an unknown OBS recovery marker remains fenced and unchanged', async t => {
  let probes = 0; const f = await fixture(t, { processProbe: () => { probes++; return 'absent'; } });
  const bytes = await writeDeadObsOwner(f), file = path.join(f.root, 'owner.lock.recovery'), marker = JSON.stringify({ ownerPid: 30109, epoch: 'old' });
  await fs.writeFile(file, marker); await assert.rejects(f.start(), /already has an owner/); await assertObsOwner(f, bytes);
  assert.equal(await fs.readFile(file, 'utf8'), marker); assert.equal(probes, 0); assert.equal(f.children.length, 0);
});

test('Stop while an OBS stale-process probe is pending prevents removal and late helper startup', async t => {
  const entered = deferred(), pending = deferred(), f = await fixture(t, { processProbe: () => { entered.resolve(); return pending.promise; } });
  const bytes = await writeDeadObsOwner(f), start = f.start(), rejected = assert.rejects(start, /session changed/);
  await entered.promise; const stop = f.provider.stop(); pending.resolve('absent'); await rejected; await stop;
  await assertObsOwner(f, bytes); assert.equal(f.children.length, 0);
  await assert.rejects(fs.access(path.join(f.root, 'owner.lock.recovery')), { code: 'ENOENT' });
});

test('an OBS parent or helper becoming live on the final probe keeps both records', async t => {
  for (const pid of [30101, 30102, 30103]) {
    const counts = new Map(), f = await fixture(t, { processProbe: probed => {
      counts.set(probed, (counts.get(probed) || 0) + 1); return probed === pid && counts.get(probed) === 2 ? 'present' : 'absent';
    } });
    const bytes = await writeDeadObsOwner(f); await assert.rejects(f.start(), /already has an owner/); await assertObsOwner(f, bytes);
    assert.equal(f.children.length, 0);
  }
});

test('changed or recreated OBS records and replaced recovery guards are never reclaimed', async t => {
  for (const which of ['owner.lock', 'owner.json', 'owner.lock.recovery']) for (const recreate of [false, true]) {
    let changed = false, f; f = await fixture(t, { processProbe: async () => {
      if (!changed) {
        changed = true; const file = path.join(f.root, which), content = await fs.readFile(file, 'utf8');
        if (recreate) { await fs.rm(file); await fs.writeFile(file, content); }
        else { const value = JSON.parse(content); value.epoch = 'changed_owner_abcdefghijklmnopqrstuv'; await fs.writeFile(file, JSON.stringify(value)); }
      }
      return 'absent';
    } });
    await writeDeadObsOwner(f); await assert.rejects(f.start(), /already has an owner/);
    assert.equal(f.children.length, 0); await fs.access(path.join(f.root, 'owner.lock')); await fs.access(path.join(f.root, 'owner.json'));
    if (which === 'owner.lock.recovery') await fs.access(path.join(f.root, which));
  }
});

test('two OBS recovery claimers preserve exactly one fresh owner', async t => {
  const entered = deferred(), pending = deferred(); let first = true;
  const a = await fixture(t, { processProbe: () => { if (first) { first = false; entered.resolve(); return pending.promise; } return 'absent'; } });
  const b = await fixture(t, { runtimeRoot: a.root, processProbe: () => 'absent' }); await writeDeadObsOwner(a);
  const starting = a.start(); await entered.promise; await assert.rejects(b.start(), /already has an owner/); pending.resolve('absent'); await starting;
  const owner = JSON.parse(await fs.readFile(path.join(a.root, 'owner.json')));
  assert.equal(a.children.length, 2); assert.equal(b.children.length, 0); await b.provider.stop();
  assert.equal(JSON.parse(await fs.readFile(path.join(a.root, 'owner.json'))).epoch, owner.epoch);
});

test('an ordinary wx claimant winning the OBS recovery gap retains both fresh records', async t => {
  let f, claimed = false, winner;
  const ownerFs = { ...fs, rm: async (file, options) => {
    await fs.rm(file, options);
    if (!claimed && file === path.join(f.root, 'owner.lock')) {
      claimed = true; winner = deadObsOwner(f); winner.lock.epoch = winner.record.epoch = 'fresh_owner_abcdefghijklmnopqrstuv';
      await fs.writeFile(file, JSON.stringify(winner.lock), { flag: 'wx' }); await fs.writeFile(path.join(f.root, 'owner.json'), JSON.stringify(winner.record));
    }
  } };
  f = await fixture(t, { ownerFs, processProbe: () => 'absent' }); await writeDeadObsOwner(f);
  await assert.rejects(f.start(), /already has an owner/);
  await assertObsOwner(f, { lock: JSON.stringify(winner.lock), record: JSON.stringify(winner.record) }); assert.equal(f.children.length, 0);
});

test('a lock replaced between the two stale-file removals is preserved', async t => {
  let f, changed = false, replacement;
  const ownerFs = { ...fs, rm: async (file, options) => {
    await fs.rm(file, options);
    if (!changed && file === path.join(f.root, 'owner.json')) {
      changed = true; replacement = deadObsOwner(f).lock; replacement.epoch = 'new_owner_abcdefghijklmnopqrstuv';
      await fs.writeFile(path.join(f.root, 'owner.lock'), JSON.stringify(replacement));
    }
  } };
  f = await fixture(t, { ownerFs, processProbe: () => 'absent' }); await writeDeadObsOwner(f); await assert.rejects(f.start(), /already has an owner/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'owner.lock'))), replacement); assert.equal(f.children.length, 0);
});

test('failed OBS guard finalization closes the newly claimed handle and starts no helpers', async t => {
  const handles = []; let f;
  const ownerFs = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args), record = { closed: false }; handles.push(record);
    const close = handle.close.bind(handle); handle.close = async () => { try { await close(); } finally { record.closed = true; } }; return handle;
  }, rm: async (file, options) => {
    if (file === path.join(f.root, 'owner.lock.recovery')) throw Object.assign(Error('guard removal denied'), { code: 'EPERM' });
    return fs.rm(file, options);
  } };
  f = await fixture(t, { ownerFs, processProbe: () => 'absent' }); await writeDeadObsOwner(f); await assert.rejects(f.start(), /already has an owner/);
  assert.ok(handles.length > 0); assert.ok(handles.every(value => value.closed)); assert.equal(f.children.length, 0);
  await assert.rejects(fs.access(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.root, 'owner.json')), { code: 'ENOENT' }); await fs.access(path.join(f.root, 'owner.lock.recovery'));
});

test('nonregular, junction and hard-linked OBS ownership paths remain fenced', async t => {
  for (const which of ['owner.lock', 'owner.json']) for (const kind of ['directory', 'junction', 'hardlink']) {
    let probes = 0; const f = await fixture(t, { processProbe: () => { probes++; return 'absent'; } }); await writeDeadObsOwner(f);
    const file = path.join(f.root, which), target = path.join(f.root, 'linked-target'); await fs.rm(file);
    if (kind === 'directory') await fs.mkdir(file);
    else if (kind === 'junction') { await fs.mkdir(target); await fs.symlink(target, file, 'junction'); }
    else { await fs.writeFile(target, JSON.stringify(which === 'owner.lock' ? deadObsOwner(f).lock : deadObsOwner(f).record)); await fs.link(target, file); }
    await assert.rejects(f.start(), /already has an owner/); assert.equal(probes, 0); assert.equal(f.children.length, 0); await fs.lstat(file);
  }
});

test('SDP readers have opaque viewer-bound identities and no internal URLs or passwords', async t => {
  const f = await fixture(t); await f.start();
  const result = await f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER });
  assert.equal(result.status, 201); assert.match(result.sessionId, /^[a-zA-Z0-9_-]{16,128}$/);
  assert.deepEqual(result.headers, { 'Content-Type': 'application/sdp' });
  assert.equal(JSON.stringify(result).includes('127.0.0.1'), false); assert.equal(JSON.stringify(f.provider.snapshot()).includes('rabbit-hole:'), false);
  await assert.rejects(f.provider.signal({ method: 'DELETE', viewerId: VIEWER + 'x', generation: 4, sessionId: result.sessionId }), /belong/);
  f.deactivate(); // a revoked service lease may still clean its own reader
  assert.equal((await f.provider.signal({ method: 'DELETE', viewerId: VIEWER, generation: 4, sessionId: result.sessionId })).status, 204);
  assert.equal(f.relayRequests.filter(x => x.init.method === 'DELETE').length, 1);
});

test('replacement at the eight-viewer limit deletes only its previous reader', async t => {
  const f = await fixture(t); await f.start();
  for (let i = 0; i < 8; i++) await f.provider.signal({ method: 'POST', viewerId: VIEWER + i, generation: 4, body: OFFER });
  await assert.rejects(f.provider.signal({ method: 'POST', viewerId: VIEWER + '9', generation: 4, body: OFFER }), /limit/);
  await f.provider.signal({ method: 'POST', viewerId: VIEWER + '0', generation: 4, body: OFFER });
  assert.equal(f.relayRequests.filter(x => x.init.method === 'DELETE').length, 1);
});

test('viewer release during an SDP POST deletes the late response resource', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, { fetchImpl: async (url, init) => { if (init.method === 'POST') { entered.resolve(); await gate.promise; } } });
  await f.start(); const offer = f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER });
  const rejected = assert.rejects(offer, /released/); await entered.promise;
  await f.provider.releaseViewer({ viewerId: VIEWER, generation: 4 }); gate.resolve(); await rejected;
  assert.equal(f.relayRequests.filter(x => x.init.method === 'DELETE').length, 1);
});

test('malformed, audio-bearing, oversized and stale offers never reach the relay', async t => {
  const f = await fixture(t); await f.start(); const before = f.relayRequests.length;
  for (const body of ['invalid', OFFER + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', OFFER + 'x'.repeat(128 * 1024)]) {
    await assert.rejects(f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body }), /video-only/);
  }
  await assert.rejects(f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 3, body: OFFER }), /unavailable/);
  assert.equal(f.relayRequests.length, before);
});

test('relay redirects and foreign session URLs never become stored readers', async t => {
  const f = await fixture(t, { fetchImpl: (url, init) => init.method === 'POST' ? new Response(OFFER, { status: 201, headers: { Location: 'http://evil.invalid/whep/secret' } }) : undefined });
  await f.start(); await assert.rejects(f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER }), /invalid reader/);
  assert.ok(f.relayRequests.every(x => x.init.redirect === 'error' && new URL(x.url).hostname === '127.0.0.1'));
});

test('response body reads are bounded even without Content-Length', async t => {
  const f = await fixture(t, { fetchImpl: (url, init) => init.method === 'POST' ? new Response(OFFER + 'x'.repeat(256 * 1024), { status: 201, headers: { Location: `${new URL(url).pathname}/1b26a3cb-9f3d-4bd4-8e76-632b4e450403` } }) : undefined });
  await f.start(); await assert.rejects(f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER }), /too large/);
  assert.equal(f.relayRequests.filter(x => x.init.method === 'DELETE').length, 1);
});

test('a created reader with malformed SDP is still released', async t => {
  const f = await fixture(t, { fetchImpl: (url, init) => init.method === 'POST' ? new Response('malformed answer', { status: 201, headers: { Location: `${new URL(url).pathname}/1b26a3cb-9f3d-4bd4-8e76-632b4e450403` } }) : undefined });
  await f.start(); await assert.rejects(f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER }), /establish video/);
  assert.equal(f.relayRequests.filter(x => x.init.method === 'DELETE').length, 1);
});

test('OBS v5 Hello authenticates without a nonexistent obsStudioVersion field', async () => {
  const sent = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; queueMicrotask(() => this.emit('message', JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1, authentication: { salt: 'fixture-salt', challenge: 'fixture-challenge' } } }))); }
    send(text) { const value = JSON.parse(text); sent.push(value); queueMicrotask(() => this.emit('message', JSON.stringify(value.op === 1 ? { op: 2, d: { negotiatedRpcVersion: 1 } } : { op: 7, d: { requestId: value.d.requestId, requestStatus: { result: true }, responseData: { obsVersion: '32.2.2' } } }))); }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const client = new ObsClient({ port: 4565, password: 'fixture-secret', socketImpl: Socket });
  await client.connect(); assert.equal((await client.request('GetVersion')).obsVersion, '32.2.2');
  const secret = crypto.createHash('sha256').update('fixture-secretfixture-salt').digest('base64');
  assert.equal(sent[0].d.authentication, crypto.createHash('sha256').update(secret + 'fixture-challenge').digest('base64'));
  assert.equal(JSON.stringify(sent).includes('fixture-secret'), false); client.close();
});

test('OBS request failures retain only a whitelisted type and bounded numeric code', async () => {
  let code = 600;
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; queueMicrotask(() => this.emit('message', JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { salt: 'fixture-salt', challenge: 'fixture-challenge' } } }))); }
    send(text) {
      const value = JSON.parse(text);
      queueMicrotask(() => this.emit('message', JSON.stringify(value.op === 1 ? { op: 2, d: { negotiatedRpcVersion: 1 } } :
        { op: 7, d: { requestId: value.d.requestId, requestStatus: { result: false, code, comment: 'private password and local URL' }, responseData: { private: 'secret' } } })));
    }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const client = new ObsClient({ port: 4565, password: 'fixture-secret', socketImpl: Socket }); await client.connect();
  await assert.rejects(client.request('GetSceneList'), error => {
    assert.equal(error.obsRequestType, 'GetSceneList'); assert.equal(error.obsStatusCode, 600);
    assert.equal(JSON.stringify(error).includes('private'), false); assert.equal(error.message.includes('password'), false); return true;
  });
  for (const invalid of ['600', -1, 1e6, null]) {
    code = invalid; await assert.rejects(client.request('unrecognized-private-type'), error => {
      assert.equal(Object.hasOwn(error, 'obsRequestType'), false); assert.equal(Object.hasOwn(error, 'obsStatusCode'), false); return true;
    });
  }
  client.close();
});

test('provider startup diagnostics use fixed stages and omit raw response, request arguments and secrets', async t => {
  for (const [request, stage] of [['GetVersion', 'obs-version'], ['GetInputList', 'obs-inputs'], ['GetSpecialInputs', 'obs-audio-inputs'], ['GetVideoSettings', 'obs-video-settings']]) {
    const f = await fixture(t, { obsRequest: name => {
      if (name === request) throw Object.assign(Error('private raw response'), { obsRequestType: request, obsStatusCode: 600, private: 'password URL' });
    } });
    await assert.rejects(f.start(), error => {
      assert.equal(error.stage, stage); assert.equal(error.obsRequestType, request); assert.equal(error.obsStatusCode, 600);
      assert.equal(error.message.includes('private'), false); return true;
    });
    const diagnostic = f.diagnostics[0];
    assert.deepEqual(diagnostic, { stage, obsRequestType: request, obsStatusCode: 600 });
    assert.equal(JSON.stringify(diagnostic).includes('private'), false); assert.equal(f.requests.some(value => value.name === 'CreateInput'), false);
  }
  const f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') throw Object.assign(Error('private'), { stage: 'private URL', obsRequestType: 'unrecognized', obsStatusCode: '600' }); } });
  await assert.rejects(f.start(), error => {
    assert.equal(error.stage, 'obs-version'); assert.equal(Object.hasOwn(error, 'obsRequestType'), false); assert.equal(Object.hasOwn(error, 'obsStatusCode'), false); return true;
  });
  assert.deepEqual(f.diagnostics[0], { stage: 'obs-version' });
});

const obsNotReady = request => Object.assign(Error('private server readiness comment'), { obsRequestType: request, obsStatusCode: 207 });

test('initial OBS NotReady version probes retry before configuring or starting the stream once', async t => {
  let versions = 0;
  const f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion' && ++versions < 3) throw obsNotReady(name); } });
  const value = await f.start();
  assert.equal(value.state, 'running'); assert.equal(versions, 3);
  assert.deepEqual(f.waits, [250, 250]); assert.equal(f.children.length, 2);
  assert.deepEqual(f.requests.slice(0, 4).map(value => value.name), ['GetVersion', 'GetVersion', 'GetVersion', 'GetInputList']);
  assert.deepEqual(f.requests.filter(value => value.name === 'GetVersion').map(value => value.timeoutMs), [5000, 5000, 5000]);
  assert.equal(f.requests.filter(value => value.name === 'CreateInput').length, 1);
  assert.equal(f.requests.filter(value => value.name === 'StartStream').length, 1);
  assert.equal(f.calls.filter(value => value === 'ready').length, 1); assert.deepEqual(f.diagnostics, []);
});

test('permanent OBS NotReady stops at the original startup deadline without configuration', async t => {
  const f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') throw obsNotReady(name); } });
  await assert.rejects(f.start(), error => error.stage === 'obs-version' && error.obsRequestType === 'GetVersion' && error.obsStatusCode === 207);
  assert.equal(f.requests.length, 120); assert.ok(f.requests.every(value => value.name === 'GetVersion'));
  assert.equal(f.waits.reduce((sum, ms) => sum + ms, 0), 30000);
  assert.equal(f.requests.at(-1).timeoutMs, 250); assert.equal(f.calls.includes('ready'), false);
  assert.deepEqual(f.calls.filter(value => value.action === 'terminate').map(value => value.data.ProcessId), [701, 700]);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

test('the OBS readiness retry does not renew time spent by the first request', async t => {
  let f;
  f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') { f.advance(29900); throw obsNotReady(name); } } });
  await assert.rejects(f.start(), error => error.obsStatusCode === 207);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.waits, [100]);
  assert.equal(f.requests.some(value => value.name === 'CreateInput'), false); assert.equal(f.calls.includes('ready'), false);
});

test('a version response arriving at the startup deadline never configures OBS', async t => {
  let f;
  f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') { f.advance(30000); return { obsVersion: '32.2.2' }; } } });
  await assert.rejects(f.start(), /control did not become ready/);
  assert.deepEqual(f.requests.map(value => value.name), ['GetVersion']); assert.deepEqual(f.waits, []);
  assert.equal(f.calls.includes('ready'), false);
});

test('genuine version failures and untrusted NotReady metadata are never retried', async t => {
  for (const [obsRequestType, obsStatusCode] of [['GetVersion', 600], ['GetVersion', '207'], ['GetInputList', 207], [undefined, 207]]) {
    const f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') throw Object.assign(Error('private'), { obsRequestType, obsStatusCode }); } });
    await assert.rejects(f.start());
    assert.deepEqual(f.requests.map(value => value.name), ['GetVersion']); assert.deepEqual(f.waits, []);
    assert.equal(f.calls.includes('ready'), false);
  }
});

test('NotReady from later read or mutating configuration requests is never replayed', async t => {
  for (const request of ['GetInputList', 'CreateInput', 'StartStream']) {
    const f = await fixture(t, { obsRequest: name => { if (name === request) throw obsNotReady(name); } });
    await assert.rejects(f.start(), error => error.obsRequestType === request && error.obsStatusCode === 207);
    assert.equal(f.requests.filter(value => value.name === 'GetVersion').length, 1);
    assert.equal(f.requests.filter(value => value.name === request).length, 1); assert.deepEqual(f.waits, []);
    assert.equal(f.calls.includes('ready'), false);
  }
});

test('the exact pinned OBS version is still required after a readiness retry', async t => {
  let versions = 0;
  const f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') { if (++versions === 1) throw obsNotReady(name); return { obsVersion: 'other' }; } } });
  await assert.rejects(f.start(), /version does not match/);
  assert.equal(versions, 2); assert.deepEqual(f.waits, [250]);
  assert.equal(f.requests.some(value => value.name === 'CreateInput'), false);
});

test('generation changes during an OBS NotReady response stop before any retry', async t => {
  let f;
  f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') { f.deactivate(); throw obsNotReady(name); } } });
  await assert.rejects(f.start(), /session changed/);
  assert.deepEqual(f.requests.map(value => value.name), ['GetVersion']); assert.deepEqual(f.waits, []);
  assert.equal(f.calls.includes('ready'), false);
});

test('Stop during an OBS readiness wait cancels before another probe or configuration', async t => {
  const entered = deferred(), released = deferred();
  const f = await fixture(t, { obsRequest: name => { if (name === 'GetVersion') throw obsNotReady(name); }, sleep: (ms, signal) => {
    entered.resolve(); signal.addEventListener('abort', () => released.resolve(), { once: true }); return released.promise;
  } });
  const starting = f.start(); const rejected = assert.rejects(starting, /session changed|cancelled/);
  await entered.promise; await f.provider.stop(); await rejected;
  assert.deepEqual(f.requests.map(value => value.name), ['GetVersion']); assert.equal(f.calls.includes('ready'), false);
  assert.deepEqual(f.calls.filter(value => value.action === 'terminate').map(value => value.data.ProcessId), [701, 700]);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});

test('OBS request deadlines can shorten only the local pending response wait', async () => {
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; }
    send() {}
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const client = new ObsClient({ port: 4565, password: 'fixture-secret', socketImpl: Socket }); client.socket = new Socket();
  await assert.rejects(client.request('GetVersion', {}, 1), /request timed out/); assert.equal(client.pending.size, 0);
  for (const timeout of [0, -1, 5001, '250', 1.5]) await assert.rejects(client.request('GetVersion', {}, timeout), /deadline is invalid/);
  assert.equal(client.pending.size, 0); client.close();
});

const SRT_CONFIG = Object.freeze({ enabled: true, port: 8890, latencyMs: 250 });
const srtSelection = (viewerId = VIEWER, generation = 4) => ({ viewerId, generation });
const relayFile = async f => JSON.parse(await fs.readFile(path.join(f.root, 'mediamtx.json')));
const srtPatches = f => f.relayRequests.filter(value => new URL(value.url).pathname === '/v3/config/global/patch').map(value => JSON.parse(value.init.body));

for (const srtExperiment of [undefined, { enabled: false }, { enabled: false, port: 8890, latencyMs: 250 }]) {
  test(`SRT ${JSON.stringify(srtExperiment)} is passive, disabled, and never probes or samples an optional port`, async t => {
    const f = await fixture(t, srtExperiment === undefined ? {} : { srtExperiment });
    const inspected = await f.provider.inspect();
    assert.equal(inspected.srtExperiment.enabled, false); assert.equal(inspected.srtExperiment.available, false);
    assert.equal(f.calls.length, 0); assert.equal(f.relayRequests.length, 0);
    await f.start(); await f.tickMonitor();
    const relay = await relayFile(f);
    assert.equal(relay.srt, false); assert.equal(relay.srtAddress, undefined); assert.equal(relay.authInternalUsers.length, 1);
    assert.equal(Object.values(relay.paths)[0].srtReadPassphrase, undefined);
    assert.equal(f.calls.some(value => value.srtPort), false);
    assert.equal(f.relayRequests.some(value => new URL(value.url).pathname.startsWith('/v3/srt/')), false);
    assert.equal(f.provider.snapshot().srtExperiment.state, 'disabled');
    await assert.rejects(f.provider.srtConnection(srtSelection()), /unavailable/);
  });
}

test('invalid SRT fields fail before native observation, ownership, helpers, or optional port probing', async t => {
  const f = await fixture(t);
  for (const srtExperiment of [null, [], true, { enabled: 'yes' }, { ...SRT_CONFIG, surprise: 1 },
    { enabled: true }, { ...SRT_CONFIG, port: 1023 }, { ...SRT_CONFIG, port: 65536 }, { ...SRT_CONFIG, port: 8890.5 },
    { ...SRT_CONFIG, port: 8199 }, { ...SRT_CONFIG, port: 4565 }, { ...SRT_CONFIG, latencyMs: 250000 },
    { ...SRT_CONFIG, latencyMs: '250' }, { ...SRT_CONFIG, enabled: false, port: 9996 }]) {
    await fs.writeFile(path.join(f.root, 'runtime.json'), JSON.stringify({ ...f.config, srtExperiment }));
    assert.equal((await f.provider.inspect()).available, false);
    await assert.rejects(f.start({ observeWindow: () => { throw Error('must not observe'); } }), /SRT experiment configuration/);
    assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  }
});

test('ordinary port checking retains four listeners; explicit SRT probe binds only the configured LAN address', async () => {
  const binds = [], closes = [];
  const handle = type => Object.assign(new EventEmitter(), {
    listen(port, address, done) { binds.push({ type, port, address }); queueMicrotask(done); },
    bind(port, address, done) { binds.push({ type, port, address }); queueMicrotask(done); },
    close(done) { closes.push(type); done(); }
  });
  const config = { lanAddress: '192.168.50.119', ports: { obs: 4565, http: 8899, api: 9996, udp: 8199 }, srtExperiment: SRT_CONFIG };
  await checkPorts(config, { createServer: () => handle('tcp'), createSocket: () => handle('udp') });
  assert.deepEqual(binds, [
    { type: 'tcp', port: 4565, address: '0.0.0.0' }, { type: 'tcp', port: 8899, address: '0.0.0.0' },
    { type: 'tcp', port: 9996, address: '0.0.0.0' }, { type: 'udp', port: 8199, address: '0.0.0.0' }
  ]);
  assert.equal(closes.length, 4);
  await checkSrtPort(config, { createSocket: () => handle('srt') });
  assert.deepEqual(binds.at(-1), { type: 'srt', port: 8890, address: '192.168.50.119' }); assert.equal(closes.at(-1), 'srt');
});

test('an occupied SRT port releases its probe handle and leaves the shared WebRTC publisher intact', async t => {
  let closed = false;
  const socket = Object.assign(new EventEmitter(), {
    bind() { queueMicrotask(() => this.emit('error', Error('offline occupied port'))); }, close(done) { closed = true; done(); }
  });
  await assert.rejects(checkSrtPort({ lanAddress: '192.168.50.119', srtExperiment: SRT_CONFIG }, { createSocket: () => socket }), /already in use/);
  assert.equal(closed, true);
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, checkSrtPort: () => { throw Error('offline occupied port'); } });
  await f.start(); await assert.rejects(f.provider.srtConnection(srtSelection()), /occupied port/);
  assert.equal(f.provider.snapshot().state, 'running'); assert.equal(f.provider.snapshot().srtExperiment.state, 'idle');
  assert.deepEqual(srtPatches(f), []); assert.equal(f.children.length, 2); assert.equal(f.failures.length, 0);
});

test('SRT preparation preserves loopback publishing, requires encrypted read-only LAN credentials, and opens no listener', async t => {
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, qualityProfile: '4k60-60' });
  const inspected = await f.provider.inspect();
  assert.deepEqual(inspected.srtExperiment, { enabled: true, available: true, requestedLatencyMs: 250, state: 'idle', readers: null, observedAt: null, stats: [], videoTargetsMbps: [60] });
  assert.equal(f.calls.length, 0); await f.start();
  const relay = await relayFile(f), publisher = relay.authInternalUsers[0], reader = relay.authInternalUsers[1], [streamPath] = Object.keys(relay.paths);
  assert.equal(relay.srt, false); assert.equal(relay.srtAddress, '192.168.50.119:8890'); assert.equal(relay.logLevel, 'warn');
  assert.equal(relay.webrtc, true); assert.equal(relay.webrtcAddress, '127.0.0.1:8899'); assert.equal(relay.apiAddress, '127.0.0.1:9996');
  assert.deepEqual(publisher.ips, ['127.0.0.1', '::1']); assert.deepEqual(publisher.permissions.map(value => value.action), ['publish', 'read', 'api']);
  assert.deepEqual(reader.ips, ['192.168.50.0/24']); assert.deepEqual(reader.permissions, [{ action: 'read', path: streamPath }]);
  assert.match(reader.user, /^srt-[a-zA-Z0-9_-]{32}$/); assert.match(reader.pass, /^[a-zA-Z0-9_-]{32}$/);
  assert.notEqual(reader.pass, publisher.pass); assert.match(relay.paths[streamPath].srtReadPassphrase, /^[a-f0-9]{32}$/);
  assert.equal(f.calls.some(value => value.srtPort), false); assert.deepEqual(srtPatches(f), []);
  assert.equal(f.provider.snapshot().srtExperiment.state, 'idle'); assert.equal(f.provider.snapshot().srtExperiment.readers, null);
  const encoder = JSON.parse(await fs.readFile(path.join(f.config.obsRoot, 'config', 'obs-studio', 'basic', 'profiles', 'RabbitHoleVisualizer', 'streamEncoder.json')));
  assert.equal(encoder.bitrate, 60000); assert.equal(f.requests.filter(value => value.name === 'StartStream').length, 1);
});

test('only the exact ready owner can open SRT, and its Larix URL has caller mode, encoded identity and millisecond latency', async t => {
  const f = await fixture(t, { srtExperiment: SRT_CONFIG });
  await assert.rejects(f.provider.srtConnection(srtSelection()), /unavailable/); await f.start();
  for (const selection of [{ viewerId: 'bad', generation: 4 }, srtSelection(VIEWER, 3), srtSelection(VIEWER, '4')]) await assert.rejects(f.provider.srtConnection(selection), /unavailable/);
  assert.deepEqual(srtPatches(f), []);
  const result = await f.provider.srtConnection(srtSelection()), url = new URL(result.url), relay = await relayFile(f), reader = relay.authInternalUsers[1], [streamPath] = Object.keys(relay.paths);
  assert.equal(result.transport, 'srt'); assert.equal(result.client, 'larix-player'); assert.equal(result.latencyUnit, 'milliseconds'); assert.equal(result.requestedLatencyMs, 250);
  assert.equal(result.generation, 4); assert.equal(url.host, '192.168.50.119:8890'); assert.equal(url.searchParams.get('mode'), 'caller');
  assert.equal(url.searchParams.get('latency'), '250'); assert.equal(url.searchParams.get('pbkeylen'), '16');
  assert.equal(url.searchParams.get('streamid'), `read:${streamPath}:${reader.user}:${reader.pass}`);
  assert.equal(url.searchParams.get('passphrase'), relay.paths[streamPath].srtReadPassphrase); assert.match(result.url, /streamid=read%3A/);
  assert.deepEqual(srtPatches(f), [{ srt: true }]); assert.equal(f.provider.snapshot().srtExperiment.state, 'ready');
  assert.equal(f.provider.snapshot().srtExperiment.readers, null, 'a ready listener is not a native client connection');
  assert.equal((await f.provider.srtConnection(srtSelection())).url, result.url); assert.equal(srtPatches(f).length, 1);
  await assert.rejects(f.provider.srtConnection(srtSelection(VIEWER + 'other')), /Another viewer/);
  const publicState = JSON.stringify([f.provider.snapshot(), await f.provider.inspect(), f.provider.fidelity()]);
  for (const secret of [reader.user, reader.pass, streamPath, relay.paths[streamPath].srtReadPassphrase, f.config.lanAddress, result.url]) assert.equal(publicState.includes(secret), false);
});

test('exact SRT release disables its listener without stopping OBS, browser readers or the encoded publisher', async t => {
  const f = await fixture(t, { srtExperiment: SRT_CONFIG }); await f.start();
  const browser = await f.provider.signal({ method: 'POST', viewerId: VIEWER + 'browser', generation: 4, body: OFFER });
  await f.provider.srtConnection(srtSelection()); const before = f.relayRequests.length;
  assert.deepEqual(await f.provider.releaseSrt(srtSelection(VIEWER + 'other')), { released: false });
  assert.deepEqual(await f.provider.releaseSrt(srtSelection(VIEWER, 3)), { released: false }); assert.equal(f.relayRequests.length, before);
  assert.deepEqual(await f.provider.releaseSrt(srtSelection()), { released: true }); assert.deepEqual(srtPatches(f), [{ srt: true }, { srt: false }]);
  assert.equal(f.provider.snapshot().state, 'running'); assert.equal(f.provider.snapshot().srtExperiment.state, 'idle');
  assert.equal(f.provider.snapshot().srtExperiment.readers, null); assert.equal(f.requests.filter(value => value.name === 'StartStream').length, 1);
  assert.equal(f.calls.some(value => value.action === 'terminate'), false);
  assert.equal((await f.provider.signal({ method: 'DELETE', viewerId: VIEWER + 'browser', generation: 4, sessionId: browser.sessionId })).status, 204);
});

test('SRT enable and a concurrent exact Stop serialize, leaving no listener active', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/v3/config/global/patch' && JSON.parse(init.body).srt) { entered.resolve(); await gate.promise; }
  } });
  await f.start(); const opening = f.provider.srtConnection(srtSelection()); await entered.promise;
  const closing = f.provider.releaseSrt(srtSelection()); gate.resolve();
  await opening; assert.deepEqual(await closing, { released: true });
  assert.deepEqual(srtPatches(f), [{ srt: true }, { srt: false }]); assert.equal(f.provider.snapshot().srtExperiment.state, 'idle');
});

test('a new SRT owner waits for prior Stop closure before reopening the owned listener', async t => {
  const gate = deferred(), entered = deferred(); let blockClose = false;
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: async (url, init) => {
    if (blockClose && new URL(url).pathname === '/v3/config/global/patch' && JSON.parse(init.body).srt === false) { entered.resolve(); await gate.promise; }
  } });
  await f.start(); await f.provider.srtConnection(srtSelection()); blockClose = true;
  const closing = f.provider.releaseSrt(srtSelection()); await entered.promise;
  const opening = f.provider.srtConnection(srtSelection(VIEWER + 'next')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(srtPatches(f), [{ srt: true }, { srt: false }]); gate.resolve();
  await closing; await opening; assert.deepEqual(srtPatches(f), [{ srt: true }, { srt: false }, { srt: true }]);
  assert.equal(f.provider.snapshot().srtExperiment.state, 'ready');
});

test('failed SRT closure preserves its owner and reports error until exact Stop verification succeeds', async t => {
  let rejectVerification = false;
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: (url, init) => {
    if (rejectVerification && new URL(url).pathname === '/v3/config/global/get') return new Response(JSON.stringify({ srt: true }), { status: 200 });
  } });
  await f.start(); await f.provider.srtConnection(srtSelection()); rejectVerification = true;
  await assert.rejects(f.provider.releaseSrt(srtSelection()), /could not be closed/);
  assert.equal(f.provider.snapshot().srtExperiment.state, 'error'); assert.equal(f.provider.snapshot().state, 'running');
  await assert.rejects(f.provider.srtConnection(srtSelection()), /Stop the current/);
  rejectVerification = false; assert.deepEqual(await f.provider.releaseSrt(srtSelection()), { released: true });
  assert.equal(f.provider.snapshot().srtExperiment.state, 'idle');
});

test('publisher shutdown fences a pending SRT opening, disables it and releases only its exact helpers', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/v3/config/global/patch' && JSON.parse(init.body).srt) { entered.resolve(); await gate.promise; }
  } });
  await f.start(); const opening = f.provider.srtConnection(srtSelection()); const rejected = assert.rejects(opening, /session changed/); await entered.promise;
  const stopping = f.provider.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(value => value.action === 'terminate'), false); gate.resolve(); await stopping; await rejected;
  assert.deepEqual(srtPatches(f), [{ srt: true }, { srt: false }]); assert.equal(f.provider.snapshot().state, 'idle');
  assert.deepEqual(f.calls.filter(value => value.action === 'terminate').map(value => value.data.ProcessId), [701, 700]);
  await assert.rejects(f.provider.srtConnection(srtSelection()), /unavailable/);
});

test('a changed publisher generation rotates private SRT credentials and rejects old URL requests', async t => {
  const f = await fixture(t, { srtExperiment: SRT_CONFIG }); await f.start();
  const first = new URL((await f.provider.srtConnection(srtSelection())).url); await f.provider.stop(); await f.start({ generation: 5 });
  await assert.rejects(f.provider.srtConnection(srtSelection()), /unavailable/);
  const next = new URL((await f.provider.srtConnection(srtSelection(VIEWER, 5))).url);
  assert.notEqual(next.searchParams.get('streamid'), first.searchParams.get('streamid'));
  assert.notEqual(next.searchParams.get('passphrase'), first.searchParams.get('passphrase'));
  assert.deepEqual(await f.provider.releaseSrt(srtSelection()), { released: false }); assert.equal(f.provider.snapshot().srtExperiment.state, 'ready');
});

test('SRT counters use the existing monitor and expose only finite whitelisted statistics for its exact path and user', async t => {
  let srtBody;
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: url => new URL(url).pathname === '/v3/srt/conns/list' ? new Response(JSON.stringify(srtBody), { status: 200 }) : undefined });
  await f.start(); await f.tickMonitor();
  assert.equal(f.relayRequests.some(value => new URL(value.url).pathname === '/v3/srt/conns/list'), false);
  await f.provider.srtConnection(srtSelection()); const relay = await relayFile(f), [streamPath] = Object.keys(relay.paths), user = relay.authInternalUsers[1].user;
  srtBody = { pageCount: 1, itemCount: 4, items: [
    { state: 'publish', path: streamPath, user, bytesSent: 999 }, { state: 'read', path: 'foreign', user, bytesSent: 999 },
    { state: 'read', path: streamPath, user: 'foreign', bytesSent: 999 },
    { state: 'read', path: streamPath, user, remoteAddr: 'private-address', query: 'private-query', id: 'private-id', secret: 'private-value',
      bytesSent: 4000000, packetsSent: 0, packetsRetrans: 12, packetsSendLoss: 14, packetsSendDrop: -2,
      outboundFramesDiscarded: 0, mbpsSendRate: 60.5, msRTT: 1.5, msSendBuf: '250', msSendTsbPdDelay: 250, bytesAvailSendBuf: null }
  ] };
  await f.tickMonitor(); const state = f.provider.snapshot().srtExperiment;
  assert.equal(state.readers, 1); assert.equal(state.observedAt, 10000);
  assert.deepEqual(state.stats, [{ slot: 1, bytesSent: 4000000, packetsSent: 0, packetsRetrans: 12, packetsSendLoss: 14, packetsSendDrop: null,
    outboundFramesDiscarded: 0, mbpsSendRate: 60.5 * 1048576 / 1e6, msRTT: 1.5, msSendBuf: null, msSendTsbPdDelay: 250, bytesAvailSendBuf: null }]);
  assert.equal(JSON.stringify(state).includes('private'), false); assert.equal(JSON.stringify(state).includes(streamPath), false);
  state.stats[0].bytesSent = 1; assert.equal(f.provider.snapshot().srtExperiment.stats[0].bytesSent, 4000000);
  f.advance(6001); assert.equal(f.provider.snapshot().srtExperiment.readers, null); assert.deepEqual(f.provider.snapshot().srtExperiment.stats, []);
  srtBody = { pageCount: 0, itemCount: 0, items: [] }; await f.tickMonitor(); assert.equal(f.provider.snapshot().srtExperiment.readers, 0);
  assert.equal(f.children.length, 2); assert.equal(f.requests.filter(value => value.name === 'StartStream').length, 1);
});

test('malformed, oversized, failed or incomplete SRT statistics never fail the shared publisher or invent a zero-reader measurement', async t => {
  let reply = () => { throw Error('private network error'); };
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: url => new URL(url).pathname === '/v3/srt/conns/list' ? reply() : undefined });
  await f.start(); await f.provider.srtConnection(srtSelection());
  for (const response of [
    () => { throw Error('private network error'); }, () => new Response('broken', { status: 200 }),
    () => new Response('{}', { status: 503 }), () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 }),
    () => new Response(JSON.stringify({ pageCount: 2, items: [] }), { status: 200 }),
    () => new Response(JSON.stringify({ items: [] }), { status: 200 })
  ]) {
    reply = response; await f.tickMonitor(); assert.equal(f.provider.snapshot().state, 'running');
    assert.equal(f.provider.snapshot().srtExperiment.readers, null); assert.equal(f.provider.snapshot().srtExperiment.observedAt, null);
    assert.equal(f.failures.length, 0);
  }
});

test('a late SRT statistics response cannot contaminate stopped or replaced publisher state', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: async url => {
    if (new URL(url).pathname === '/v3/srt/conns/list') { entered.resolve(); await gate.promise; return new Response(JSON.stringify({ pageCount: 0, items: [] }), { status: 200 }); }
  } });
  await f.start(); await f.provider.srtConnection(srtSelection()); const observing = f.tickMonitor(); await entered.promise;
  await f.provider.stop(); await f.start({ generation: 5 }); gate.resolve(); await observing;
  assert.equal(f.provider.snapshot().generation, 5); assert.equal(f.provider.snapshot().srtExperiment.readers, null);
  assert.equal(f.provider.snapshot().srtExperiment.observedAt, null); assert.equal(f.provider.snapshot().srtExperiment.state, 'idle');
});

test('the owned SRT API reload does not turn its transient publisher query closure into a WebRTC failure', async t => {
  const gate = deferred(), entered = deferred(); let interruptQuery = false;
  const f = await fixture(t, { srtExperiment: SRT_CONFIG, fetchImpl: async url => {
    if (interruptQuery && new URL(url).pathname.startsWith('/v3/paths/get/')) {
      interruptQuery = false; entered.resolve(); await gate.promise; throw Error('offline API reload');
    }
  } });
  await f.start(); interruptQuery = true; const observing = f.tickMonitor(); await entered.promise;
  await f.provider.srtConnection(srtSelection()); gate.resolve(); await observing;
  assert.equal(f.failures.length, 0); assert.equal(f.provider.snapshot().state, 'running');
  assert.equal(f.requests.filter(value => value.name === 'StartStream').length, 1);
  assert.deepEqual(srtPatches(f), [{ srt: true }]);
});

function independentFixture(overrides = {}) {
  const calls = []; let state = 'idle', onFailure;
  const videoProfile = { requestedBitrateMbps: 600, configuredBitrateMbps: 599.999488, encoderMode: 'independent-srt',
    width: 3840, height: 2160, fps: 60, videoBitrateMbps: null, videoBitrateObservedAt: null, videoBitrateWindowMs: null, observedCodec: null };
  return { calls, fail: () => { state = 'error'; onFailure?.(); },
    integration: {
      inspect: async () => ({ available: overrides.available !== false }),
      start: async details => { calls.push({ action: 'start', details }); onFailure = details.onFailure; state = 'starting';
        if (overrides.start) await overrides.start(details); state = 'ready';
        return { transport: 'srt', generation: details.generation, client: 'larix-player', latencyUnit: 'milliseconds', requestedLatencyMs: 250,
          url: 'srt://192.168.50.119:8891?mode=caller&latency=250&pbkeylen=16&streamid=read%3Aprivate&passphrase=private', videoProfile }; },
      stop: async details => { calls.push({ action: 'stop', details }); if (overrides.stop) await overrides.stop(details); state = 'idle'; return { released: true }; },
      snapshot: () => ({ state, videoProfile: { ...videoProfile }, readers: null, observedAt: null, stats: [] })
    } };
}
test('600 is advertised only for a prepared separate encoder and4K source; ordinary WebRTC starts no new branch', async t => {
  for (const qualityProfile of ['1080p60', '4k60-60']) {
    const high = independentFixture(); const f = await fixture(t, { qualityProfile, srtExperiment: SRT_CONFIG, highBitrate: high.integration });
    const inspected = await f.provider.inspect(); assert.deepEqual(inspected.srtExperiment.videoTargetsMbps, qualityProfile === '1080p60' ? [60] : [60, 600]);
    await f.start(); assert.equal(high.calls.length, 0); assert.equal(f.children.length, 2); assert.deepEqual(srtPatches(f), []);
  }
  const high = independentFixture(); const disabled = await fixture(t, { qualityProfile: '4k60-60', highBitrate: high.integration });
  assert.deepEqual((await disabled.provider.inspect()).srtExperiment.videoTargetsMbps, []); await disabled.start(); assert.equal(high.calls.length, 0);
});
test('600 receives exact current native ownership, bounded deadline and forbidden ports without changing existing OBS/WebRTC files', async t => {
  const high = independentFixture(), f = await fixture(t, { qualityProfile: '4k60-60', srtExperiment: SRT_CONFIG, highBitrate: high.integration });
  await f.start(); const files = [path.join(f.root, 'runtime.json'), path.join(f.root, 'mediamtx.json'),
    path.join(f.config.obsRoot, 'config', 'obs-studio', 'basic', 'profiles', 'RabbitHoleVisualizer', 'basic.ini'),
    path.join(f.config.obsRoot, 'config', 'obs-studio', 'basic', 'profiles', 'RabbitHoleVisualizer', 'streamEncoder.json')];
  const before = await Promise.all(files.map(file => fs.readFile(file))); const callsBefore = f.requests.length;
  const result = await f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600, expiresAt: 310000 });
  assert.equal(result.videoProfile.encoderMode, 'independent-srt'); assert.equal(result.videoProfile.configuredBitrateMbps, 599.999488);
  const options = high.calls[0].details; assert.deepEqual(options.nativeIdentity, identity); assert.equal(options.generation, 4); assert.equal(options.viewerId, VIEWER);
  assert.equal(options.expiresAt, 310000); assert.equal(options.lanAddress, f.config.lanAddress); assert.deepEqual(options.forbiddenPorts, [4565, 8899, 9996, 8199, 8890]);
  assert.equal(options.isCurrent(), true); assert.equal((await options.observeWindow()).width, 3840);
  assert.equal(f.requests.length, callsBefore); assert.equal(f.children.length, 2); assert.deepEqual(srtPatches(f), []);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before); assert.equal(f.provider.snapshot().profile.targetBitrateMbps, 60);
  assert.equal(f.provider.snapshot().srtExperiment.state, 'ready'); assert.doesNotMatch(JSON.stringify(f.provider.snapshot().srtExperiment), /192\.168|passphrase|private/);
});
test('600 Stop releases only the independent branch while the browser, OBS and shared publisher remain running', async t => {
  const high = independentFixture(), f = await fixture(t, { qualityProfile: '4k60-60', srtExperiment: SRT_CONFIG, highBitrate: high.integration });
  await f.start(); await f.provider.signal({ method: 'POST', viewerId: VIEWER, generation: 4, body: OFFER });
  await f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 });
  assert.deepEqual(await f.provider.releaseSrt({ ...srtSelection(), viewerId: 'other_abcdefghijklmnopqrstuv' }), { released: false });
  assert.deepEqual(await f.provider.releaseSrt({ ...srtSelection(), generation: 3 }), { released: false });
  assert.deepEqual(await f.provider.releaseSrt(srtSelection()), { released: true });
  assert.deepEqual(high.calls.filter(value => value.action === 'stop').map(value => value.details), [srtSelection()]);
  assert.equal(f.provider.snapshot().state, 'running'); assert.equal(f.provider.snapshot().srtExperiment.state, 'idle'); assert.deepEqual(srtPatches(f), []);
  assert.equal(f.calls.some(value => value.action === 'terminate'), false); assert.equal(f.relayRequests.filter(value => value.init.method === 'DELETE').length, 0);
});
test('unsupported or unprepared600 never silently falls back to the shared60 stream', async t => {
  const unavailable = independentFixture({ available: false }), f = await fixture(t, { qualityProfile: '4k60-60', srtExperiment: SRT_CONFIG, highBitrate: unavailable.integration });
  await f.start(); await assert.rejects(f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 }), /Prepare the isolated/);
  for (const target of [80, '600', 600000, 0]) await assert.rejects(f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: target }), /Choose the 60 or 600/);
  assert.deepEqual(unavailable.calls, []); assert.equal(f.provider.snapshot().state, 'running'); assert.deepEqual(srtPatches(f), []);
  const high = independentFixture(), low = await fixture(t, { srtExperiment: SRT_CONFIG, highBitrate: high.integration }); await low.start();
  await assert.rejects(low.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 }), /actual running 4K60/); assert.deepEqual(high.calls, []);
});
test('repeated or conflicting600 requests preserve exact active ownership until Stop', async t => {
  const high = independentFixture(), f = await fixture(t, { qualityProfile: '4k60-60', srtExperiment: SRT_CONFIG, highBitrate: high.integration }); await f.start();
  await f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 });
  await assert.rejects(f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 }), /already active/);
  await assert.rejects(f.provider.srtConnection(srtSelection()), /before changing/);
  await assert.rejects(f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600, viewerId: 'other_abcdefghijklmnopqrstuv' }), /Another viewer/);
  assert.equal(high.calls.filter(value => value.action === 'start').length, 1); await f.provider.releaseSrt(srtSelection()); assert.equal(high.calls.filter(value => value.action === 'stop').length, 1);
});
test('an independent600 transport failure and optional reader diagnostics never fail the shared publisher', async t => {
  const high = independentFixture(), f = await fixture(t, { qualityProfile: '4k60-60', srtExperiment: SRT_CONFIG, highBitrate: high.integration }); await f.start();
  await f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 }); high.fail(); f.advance(2000); await f.tickMonitor();
  assert.equal(f.provider.snapshot().srtExperiment.state, 'error'); assert.equal(f.provider.snapshot().state, 'running'); assert.equal(f.failures.length, 0);
  assert.equal(f.relayRequests.some(value => new URL(value.url).pathname === '/v3/srt/conns/list'), false); await f.provider.releaseSrt(srtSelection());
});
test('Stop racing independent setup fences its stale connection result and closes only owned new helpers', async t => {
  const entered = deferred(), gate = deferred(), high = independentFixture({ start: async () => { entered.resolve(); await gate.promise; } });
  const f = await fixture(t, { qualityProfile: '4k60-60', srtExperiment: SRT_CONFIG, highBitrate: high.integration }); await f.start();
  const pending = f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 }), rejected = assert.rejects(pending, /session changed/); await entered.promise;
  const stopped = f.provider.stop(); gate.resolve(); await rejected; await stopped;
  assert.equal(high.calls.filter(value => value.action === 'stop').length, 1); assert.equal(f.provider.snapshot().state, 'idle'); assert.deepEqual(srtPatches(f), []);
});
test('a failed600 cleanup preserves its owner and exact Stop retry while closing shared session helpers on shutdown', async t => {
  let fail = true; const high = independentFixture({ stop: async () => { if (fail) throw Error('offline helper close denied'); } });
  const f = await fixture(t, { qualityProfile: '4k60-60', srtExperiment: SRT_CONFIG, highBitrate: high.integration }); await f.start();
  await f.provider.srtConnection({ ...srtSelection(), videoBitrateMbps: 600 }); await assert.rejects(f.provider.releaseSrt(srtSelection()), /could not close/);
  assert.equal(f.provider.snapshot().srtExperiment.state, 'error'); assert.equal(f.provider.snapshot().state, 'running');
  await assert.rejects(f.provider.stop(), /Retry Stop/); assert.ok(await fs.stat(path.join(f.root, 'owner.lock')));
  assert.deepEqual(f.calls.filter(value => value.action === 'terminate').map(value => value.data.ProcessId), [701, 700]);
  fail = false; await f.provider.stop(); assert.equal(f.provider.snapshot().state, 'idle'); await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});
