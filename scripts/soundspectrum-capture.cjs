'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const BOUNDARY = 'rabbit-hole-soundspectrum';
const RUNTIME_VERSION = '1.26.11';
const RUNTIME_CONFIG_PATH = path.join(__dirname, '..', 'data', 'soundspectrum-runtime.json');
const APP_RUNTIME_ROOT = path.join(__dirname, '..', 'data', 'soundspectrum-gstreamer', RUNTIME_VERSION);
const CAPTURE_BUILD = 'window-wgc-low-latency-v5';
let lastFailureDiagnostic = '';

function environmentValue(env, name) {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function configuredRuntime(diagnostic) {
  try {
    const saved = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    if (diagnostic) diagnostic.config = { version: saved.version, executable: saved.executable, valid: saved.version === RUNTIME_VERSION && typeof saved.executable === 'string' && path.isAbsolute(saved.executable) };
    if (saved.version === RUNTIME_VERSION && typeof saved.executable === 'string' && path.isAbsolute(saved.executable)) return saved.executable;
  } catch (error) { if (diagnostic) diagnostic.config = { error: error.code || error.name }; }
  return null;
}

function findExecutable(root, diagnostic) {
  if (!root) return null;
  const candidates = [
    root,
    path.join(root, 'bin', 'gst-launch-1.0.exe'),
    path.join(root, 'GStreamer', '1.0', 'msvc_x86_64', 'bin', 'gst-launch-1.0.exe'),
    path.join(root, 'gstreamer', '1.0', 'msvc_x86_64', 'bin', 'gst-launch-1.0.exe'),
    path.join(root, 'Program Files', 'gstreamer', '1.0', 'msvc_x86_64', 'bin', 'gst-launch-1.0.exe'),
  ];
  return candidates.find(candidate => {
    if (path.basename(candidate).toLowerCase() !== 'gst-launch-1.0.exe') return false;
    try {
      const file = fs.statSync(candidate).isFile();
      if (diagnostic && diagnostic.candidates.length < 32) diagnostic.candidates.push({ path: candidate, file });
      return file;
    } catch (error) {
      if (diagnostic && diagnostic.candidates.length < 32) diagnostic.candidates.push({ path: candidate, error: error.code || error.name });
      return false;
    }
  }) || null;
}

function resolveGStreamer(env = process.env, diagnostic) {
  const localAppData = environmentValue(env, 'LOCALAPPDATA');
  const programFiles = environmentValue(env, 'ProgramFiles');
  const roots = [
    environmentValue(env, 'RH_SOUNDSPECTRUM_GST'),
    configuredRuntime(diagnostic),
    APP_RUNTIME_ROOT,
    localAppData && path.join(localAppData, 'RabbitHole', 'gstreamer', RUNTIME_VERSION),
    localAppData && path.join(localAppData, 'Programs', 'gstreamer', '1.0', 'msvc_x86_64'),
    programFiles && path.join(programFiles, 'gstreamer', '1.0', 'msvc_x86_64'),
    'C:\\gstreamer\\1.0\\msvc_x86_64',
    ...String(environmentValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'gst-launch-1.0.exe')),
  ];
  for (const root of roots) {
    const executable = findExecutable(root, diagnostic);
    if (executable) return executable;
  }
  return null;
}

function logProbeFailure(reason, env, detail) {
  const diagnostic = { build: CAPTURE_BUILD, reason, module: __filename, configPath: RUNTIME_CONFIG_PATH, candidates: [] };
  try { diagnostic.source = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 16); }
  catch (error) { diagnostic.sourceError = error.code || error.name; }
  resolveGStreamer(env, diagnostic);
  if (detail) diagnostic.detail = detail;
  const serialized = JSON.stringify(diagnostic);
  if (serialized !== lastFailureDiagnostic) {
    lastFailureDiagnostic = serialized;
    // Private server stderr only: no full environment, account tokens or API
    // response paths. The marker distinguishes an old loaded module from ACLs.
    process.stderr.write(`[soundspectrum-capture] ${serialized}\n`);
  }
}

function boundedInteger(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return number;
}

function captureEnvironment(executable, env = process.env) {
  const bin = path.dirname(executable);
  const root = path.dirname(bin);
  return {
    ...env,
    PATH: `${bin}${path.delimiter}${environmentValue(env, 'PATH') || ''}`,
    GST_PLUGIN_PATH_1_0: path.join(root, 'lib', 'gstreamer-1.0'),
    GST_PLUGIN_SYSTEM_PATH_1_0: path.join(root, 'lib', 'gstreamer-1.0'),
    GST_DEBUG_NO_COLOR: '1',
  };
}

function buildCaptureCommand(options = {}, env = process.env) {
  if (process.platform !== 'win32' && !options.executable) throw new Error('SoundSpectrum window capture requires Windows.');
  const handle = String(options.windowHandle ?? options.window ?? '');
  if (!/^\d{1,20}$/.test(handle) || BigInt(handle) <= 0n || BigInt(handle) > 18446744073709551615n) throw new Error('A valid nonzero windowHandle is required.');
  const width = boundedInteger(options.width, 800, 320, 960, 'width');
  const height = boundedInteger(options.height, 450, 180, 720, 'height');
  const fps = boundedInteger(options.fps, 30, 1, 30, 'fps');
  const quality = boundedInteger(options.quality, 65, 30, 85, 'quality');
  const executable = options.executable || resolveGStreamer(env);
  if (!executable) throw new Error('SoundSpectrum capture runtime is missing. Run scripts/soundspectrum-setup.ps1.');

  // WGC captures this HWND's own surface, including when other windows cover it.
  // Do not replace this source with desktop capture/cropping: that can leak windows.
  // Both queues are bounded and discard late frames instead of building latency.
  const args = [
    '-q',
    'd3d11screencapturesrc', 'capture-api=wgc', `window-handle=${handle}`, 'window-capture-mode=client', 'show-cursor=false',
    '!', `video/x-raw(memory:D3D11Memory),framerate=${fps}/1`,
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=1', 'max-size-bytes=0', 'max-size-time=0',
    '!', 'd3d11convert',
    // JPEG needs full-range YUV. Otherwise NV12 video-range conversion visibly
    // lifts black and dulls colors even though the JPEG decodes successfully.
    '!', `video/x-raw(memory:D3D11Memory),format=NV12,width=${width},height=${height},pixel-aspect-ratio=1/1,colorimetry=1:4:7:1`,
    '!', 'd3d11download',
    '!', 'video/x-raw,format=NV12,colorimetry=1:4:7:1',
    '!', 'jpegenc', `quality=${quality}`,
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=1', 'max-size-bytes=0', 'max-size-time=0',
    '!', 'multipartmux', `boundary=${BOUNDARY}`,
    '!', 'fdsink', 'fd=1', 'sync=false',
  ];
  return { command: executable, args, env: captureEnvironment(executable, env), boundary: BOUNDARY, width, height, fps, quality };
}

function runInspection(executable, element, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(path.dirname(executable), 'gst-inspect-1.0.exe'), [element], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('GStreamer inspection timed out.')); }, 15000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (output.length < 200000) output += chunk.toString(); });
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

async function probeCaptureRuntime(env = process.env) {
  const executable = resolveGStreamer(env);
  if (!executable) {
    logProbeFailure('runtime-missing', env);
    return { available: false, reason: 'runtime-missing', setup: 'scripts/soundspectrum-setup.ps1' };
  }
  try {
    const captureEnv = captureEnvironment(executable, env);
    for (const element of ['d3d11screencapturesrc', 'd3d11convert', 'd3d11download', 'jpegenc', 'multipartmux', 'fdsink']) {
      const result = await runInspection(executable, element, captureEnv);
      if (result.code !== 0) { logProbeFailure('element-missing', env, { element, exit: result.code }); return { available: false, reason: 'element-missing', element }; }
      if (element === 'd3d11screencapturesrc' && (!result.output.includes('window-capture-mode') || !result.output.includes('Windows Graphics Capture'))) { logProbeFailure('window-capture-unsupported', env); return { available: false, reason: 'window-capture-unsupported' }; }
    }
    lastFailureDiagnostic = '';
    return { available: true, executable, capture: 'window-client-wgc', audio: false, boundary: BOUNDARY };
  } catch (error) {
    logProbeFailure('runtime-unavailable', env, { error: error.code || error.name });
    return { available: false, reason: 'runtime-unavailable', message: error.message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--probe') {
    process.stdout.write(`${JSON.stringify(await probeCaptureRuntime())}\n`);
    return;
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--window', '--width', '--height', '--fps', '--quality'].includes(key) || !argv[index + 1]) throw new Error('Use --window HWND [--width 800 --height 450 --fps 30 --quality 65], or --probe.');
    options[key.slice(2)] = argv[index + 1];
  }
  const capture = buildCaptureCommand(options);
  const child = spawn(capture.command, capture.args, { env: capture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let ending = false;
  const stop = () => { if (!ending) { ending = true; child.kill(); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.on('error', stop);
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = ending ? 0 : (code || 0); });
}

module.exports = { BOUNDARY, RUNTIME_VERSION, RUNTIME_CONFIG_PATH, CAPTURE_BUILD, resolveGStreamer, captureEnvironment, buildCaptureCommand, probeCaptureRuntime };
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
