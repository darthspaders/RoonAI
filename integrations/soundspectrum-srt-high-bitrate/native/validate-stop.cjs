'use strict';
// Explicit bounded native regression. A loopback SRT peer deliberately does not
// read; no capture, decoder, native visualizer, audio or application API is used.
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const root = path.resolve(__dirname, '../../..');
const { captureEnvironment } = require(path.join(root, 'scripts/soundspectrum-capture.cjs'));
const execute = promisify(execFile);
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function run() {
  const runtime = path.join(root, 'data/soundspectrum-gstreamer/1.26.11');
  const patched = path.join(root, 'data/soundspectrum-srt-high-bitrate/patched-plugin');
  const original = path.join(runtime, 'lib/gstreamer-1.0/gstsrt.dll');
  const before = await hash(original), artifact = await hash(path.join(patched, 'gstsrt.dll'));
  const manifest = JSON.parse(await fs.readFile(path.join(patched, 'backpressure-plugin.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.revision !== 'listener-backpressure-2' || manifest.sha256 !== artifact)
    throw Error('private-plugin-identity-mismatch');
  const env = { ...captureEnvironment(path.join(runtime, 'bin/gst-launch-1.0.exe'),
    Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GST_|MTX_|RTSP_)/i.test(key)))),
    GST_PLUGIN_PATH_1_0: patched, GST_REGISTRY_1_0: path.join(patched, 'validation-registry.bin'), GST_DEBUG: '0' };
  const inspection = await execute(path.join(runtime, 'bin/gst-inspect-1.0.exe'), ['srtsink'],
    { env, windowsHide: true, timeout: 20000, maxBuffer: 65536 });
  if (!/^\s*Version\s+1\.26\.11\.2\s*$/m.test(inspection.stdout) ||
      !inspection.stdout.toLowerCase().includes(path.join(patched, 'gstsrt.dll').toLowerCase()))
    throw Error('private-plugin-not-loaded');
  const socket = dgram.createSocket('udp4');
  let port;
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
    port = socket.address().port;
  } finally { await new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } }); }
  const result = await execute(path.join(patched, 'build/listener-stop.test.exe'), [String(port)],
    { env, windowsHide: true, timeout: 15000, maxBuffer: 262144 });
  const observation = JSON.parse(result.stdout.trim());
  if (observation.backpressureObserved !== true || observation.passed !== true ||
      !Number.isFinite(observation.stopMilliseconds) || observation.stopMilliseconds < 0 || observation.stopMilliseconds >= 2000)
    throw Error('native-stop-check-failed');
  const unchanged = before === await hash(original);
  if (!unchanged) throw Error('shared-runtime-changed');
  const receipt = { checkedAt: new Date().toISOString(), ...observation, pluginVersion: '1.26.11.2',
    sha256: artifact, sharedRuntimeUnchanged: unchanged, originalSha256: before,
    scope: 'real GStreamer state NULL and feeder join after a real SRT full send buffer; unread loopback peer' };
  await fs.writeFile(path.join(patched, `stop-validation-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
run().catch(error => { console.error(JSON.stringify({ passed: false,
  reason: /^[-a-z]+$/.test(error.message) ? error.message : error.killed ? 'native-stop-timeout' : 'native-stop-check-failed' })); process.exitCode = 1; });
