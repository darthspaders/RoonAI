'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveGStreamer, captureEnvironment } = require('../../scripts/soundspectrum-capture.cjs');

const execFileAsync = promisify(execFile);
const INPUT_ID = 'feed:pre-hqplayer';
const INPUT_NAME = 'Player audio before HQPlayer';
const INTERFACE_NAME = 'SoundSpectrum Audio Cable';
const CAPTURE_NAME = `Stereo Out (${INTERFACE_NAME})`;
const SETTINGS_PATH = path.join(__dirname, '../../data/soundspectrum-audio-feed/settings.json');
const HELPER_PATH = path.join(__dirname, 'audio-device-probe.ps1');
const GUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const RENDER_ID = new RegExp(`^\\{0\\.0\\.0\\.00000000\\}\\.\\{${GUID}\\}$`, 'i');
const CAPTURE_ID = new RegExp(`^\\{0\\.0\\.1\\.00000000\\}\\.\\{${GUID}\\}$`, 'i');
const verifiedProbes = new WeakSet();
const runtimeChecks = new Map();

async function runDeviceProbe(route = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH];
  if (route.renderId) args.push('-RenderId', route.renderId);
  if (route.captureId) args.push('-CaptureId', route.captureId);
  const result = await execFileAsync('powershell.exe', args, { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

function routeFingerprint(render, capture) {
  const identity = [render, capture].map(device => ({
    id: device.id.toLowerCase(), sourceId: device.sourceId.toLowerCase(),
    description: device.description, interfaceName: device.interfaceName,
    name: device.name, deviceIdentity: device.deviceIdentity.toLowerCase()
  }));
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function verifyPair(render, capture) {
  if (!render || !capture || !RENDER_ID.test(render.id || '') || !CAPTURE_ID.test(capture.id || '')) throw new Error('cable-unavailable');
  if (render.state !== 1 || capture.state !== 1) throw new Error('cable-inactive');
  if (render.description !== 'Stereo In' || capture.description !== 'Stereo Out' ||
      render.interfaceName !== INTERFACE_NAME || capture.interfaceName !== INTERFACE_NAME ||
      render.name !== `Stereo In (${INTERFACE_NAME})` || capture.name !== CAPTURE_NAME) throw new Error('cable-identity-mismatch');
  if (render.sourceId !== render.id.slice(-37, -1) || capture.sourceId !== capture.id.slice(-37, -1) ||
      typeof render.deviceIdentity !== 'string' || !/ROOT\\MEDIA\\\d+/i.test(render.deviceIdentity) ||
      render.deviceIdentity.toLowerCase() !== capture.deviceIdentity?.toLowerCase()) throw new Error('cable-identity-mismatch');
  if (capture.listenKnown !== true) throw new Error('listen-state-unknown');
  if (capture.listenEnabled !== false) throw new Error('listen-enabled');
  return {
    renderId: render.id, captureId: capture.id, captureSourceId: capture.sourceId,
    captureName: capture.name, fingerprint: routeFingerprint(render, capture)
  };
}

async function probeRuntime(options) {
  if (options.probeRuntime) return options.probeRuntime();
  const env = options.env || process.env;
  const executable = resolveGStreamer(env);
  if (!executable) throw new Error('runtime-missing');
  if (!runtimeChecks.has(executable)) {
    const promise = (async () => {
      const runtimeEnv = captureEnvironment(executable, env);
      const checks = await Promise.allSettled(['fdsrc', 'rawaudioparse', 'queue', 'audioconvert', 'audioresample', 'wasapisink'].map(async element => {
        const result = await execFileAsync(path.join(path.dirname(executable), 'gst-inspect-1.0.exe'), [element], { env: runtimeEnv, windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8' });
        if (element === 'wasapisink' && (!/\bdevice\s*:/.test(result.stdout) || !/\bexclusive\s*:/.test(result.stdout))) throw new Error('shared-wasapi-unavailable');
      }));
      if (checks.some(result => result.status === 'rejected')) throw new Error('runtime-unavailable');
      return { executable };
    })();
    runtimeChecks.set(executable, promise);
    promise.catch(() => runtimeChecks.delete(executable));
  }
  return runtimeChecks.get(executable);
}

function unavailable(reason) { return { available: false, reason, inputId: INPUT_ID, kind: 'music-feed' }; }

// Used by the app's explicit enable action to persist this machine's identity.
// Discovery is read-only and does not enable the feed or write settings.
async function discoverOutput(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return unavailable('windows-required');
  try {
    const devices = await (options.runDeviceProbe || runDeviceProbe)();
    const renders = (devices.render || []).filter(device => device.interfaceName === INTERFACE_NAME && device.description === 'Stereo In');
    const captures = (devices.capture || []).filter(device => device.interfaceName === INTERFACE_NAME && device.description === 'Stereo Out');
    if (renders.length !== 1 || captures.length !== 1) return unavailable('cable-unavailable');
    const route = verifyPair(renders[0], captures[0]);
    return { available: true, inputId: INPUT_ID, kind: 'music-feed', route };
  } catch (error) { return unavailable(error.message?.startsWith('cable-') || error.message?.startsWith('listen-') ? error.message : 'device-probe-unavailable'); }
}

async function probeOutput(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return unavailable('windows-required');
  try {
    const settings = options.settings || JSON.parse(await fs.readFile(options.settingsPath || SETTINGS_PATH, 'utf8'));
    if (settings.version !== 1 || settings.enabled !== true) return unavailable('disabled');
    const configured = settings.route;
    if (!configured || !RENDER_ID.test(configured.renderId || '') || !CAPTURE_ID.test(configured.captureId || '') ||
        configured.captureName !== CAPTURE_NAME || !/^[a-f0-9]{64}$/.test(configured.fingerprint || '')) return unavailable('route-not-configured');
    const devices = await (options.runDeviceProbe || runDeviceProbe)(configured);
    const render = (devices.render || []).find(device => device.id.toLowerCase() === configured.renderId.toLowerCase());
    const capture = (devices.capture || []).find(device => device.id.toLowerCase() === configured.captureId.toLowerCase());
    const route = verifyPair(render, capture);
    if (route.fingerprint !== configured.fingerprint) return unavailable('cable-identity-mismatch');
    const runtime = await probeRuntime(options);
    if (!runtime?.executable) return unavailable('runtime-missing');
    const result = Object.freeze({ available: true, inputId: INPUT_ID, kind: 'music-feed', captureName: CAPTURE_NAME, route: Object.freeze(route), executable: runtime.executable, checkedAt: Date.now() });
    verifiedProbes.add(result);
    return result;
  } catch (error) {
    if (error.code === 'ENOENT') return unavailable('disabled');
    const reason = /^(?:cable-|listen-|runtime-|shared-wasapi-)/.test(error.message || '') ? error.message : 'device-probe-unavailable';
    return unavailable(reason);
  }
}

function buildOutputCommand({ probe, env = process.env } = {}) {
  if (!probe?.available || !verifiedProbes.has(probe) || Date.now() - probe.checkedAt > 5000) throw new Error('A fresh verified SoundSpectrum audio route is required.');
  // Only raw 44.1 kHz stereo S16LE from the isolated decoder enters stdin.
  // Shared WASAPI targets this cable by exact ID; there is no default fallback.
  // The supervisor already paces and rebases this disposable live copy. Raw
  // parser timestamps count submitted samples, so a skipped callback gap makes
  // them permanently late. Render at the current hardware-buffer position;
  // synchronizing those old timestamps can silently discard subsequent PCM.
  const args = [
    '-q', 'fdsrc', 'fd=0', 'blocksize=1764',
    '!', 'rawaudioparse', 'format=pcm', 'pcm-format=s16le', 'sample-rate=44100', 'num-channels=2', 'interleaved=true',
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=0', 'max-size-bytes=0', 'max-size-time=200000000',
    '!', 'audioconvert', '!', 'audioresample',
    '!', 'audio/x-raw,format=F32LE,rate=44100,channels=2,layout=interleaved',
    '!', 'wasapisink', `device=${probe.route.renderId}`, 'exclusive=false', 'sync=false', 'provide-clock=false', 'buffer-time=100000', 'latency-time=20000'
  ];
  return { command: probe.executable, args, env: captureEnvironment(probe.executable, env), inputFormat: { format: 'S16LE', sampleRate: 44100, channels: 2 } };
}

async function validateOutput(probe, options = {}) {
  if (!probe?.available || !verifiedProbes.has(probe)) return unavailable('route-not-verified');
  const current = await probeOutput(options);
  if (current.available && current.route.fingerprint !== probe.route.fingerprint) return unavailable('cable-identity-mismatch');
  return current;
}

// The parent owns decoder/writer lifecycle. Call this guard immediately before
// launch and throughout the session; onUnavailable must close the owned writer.
function watchOutput(probe, onUnavailable, options = {}) {
  if (typeof onUnavailable !== 'function') throw new Error('An output shutdown callback is required.');
  let stopped = false;
  let timer;
  const intervalMs = Math.min(2000, Math.max(250, Number(options.intervalMs) || 1000));
  const check = async () => {
    if (stopped) return;
    let result;
    try { result = await validateOutput(probe, options); }
    catch { result = unavailable('device-probe-unavailable'); }
    if (stopped) return;
    if (!result.available) {
      stopped = true;
      // The parent callback owns cleanup diagnostics; the detached timer must
      // not turn a shutdown error into an unhandled rejection in the player.
      try { await onUnavailable(result); } catch {}
      return;
    }
    timer = setTimeout(check, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(check, 0);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}

function createInputProvider(options = {}) {
  function exactInput(probe, rawInputs) {
    return rawInputs.find(input => input.id?.toLowerCase() === probe.route.captureSourceId.toLowerCase() && input.name === CAPTURE_NAME && input.interfaceName === INTERFACE_NAME);
  }
  return {
    inspect: () => probeOutput(options),
    async list(rawInputs = []) {
      const probe = await probeOutput(options);
      return probe.available && exactInput(probe, rawInputs) ? [{ id: INPUT_ID, name: INPUT_NAME, kind: 'music-feed' }] : [];
    },
    async resolve(inputId, rawInputs = []) {
      if (inputId !== INPUT_ID) return null;
      const probe = await probeOutput(options);
      if (!probe.available) throw new Error(`Player audio visualization is unavailable (${probe.reason}).`);
      if (!exactInput(probe, rawInputs)) throw new Error('The verified SoundSpectrum recording input is unavailable.');
      return { id: INPUT_ID, name: CAPTURE_NAME, kind: 'music-feed' };
    }
  };
}

module.exports = { INPUT_ID, INPUT_NAME, CAPTURE_NAME, SETTINGS_PATH, discoverOutput, probeOutput, buildOutputCommand, validateOutput, watchOutput, createInputProvider };

if (require.main === module) {
  const flag = process.argv[2];
  if (!['--probe', '--discover'].includes(flag) || process.argv.length !== 3) {
    process.stderr.write('Use --probe or --discover. Audio output is launched only by the parent service.\n');
    process.exitCode = 1;
  } else (flag === '--discover' ? discoverOutput() : probeOutput()).then(result => process.stdout.write(`${JSON.stringify(result)}\n`));
}
