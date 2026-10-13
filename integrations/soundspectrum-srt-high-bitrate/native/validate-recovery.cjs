'use strict';
// Bounded loopback-only proof. Compare the archived revision-1 plugin with
// revision 2 using the same compiled harness; never print raw native output.
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
  const args = process.argv.slice(2), baseline = args[0]?.startsWith('--baseline=') ? args[0].slice(11) : null;
  if (args.length > 1 || args.length === 1 && (!baseline || !/^listener-backpressure-1-\d{8}T\d{6}Z$/.test(baseline)))
    throw Error('invalid-bounded-test-arguments');
  const runtime = path.join(root, 'data/soundspectrum-gstreamer/1.26.11');
  const patched = path.join(root, 'data/soundspectrum-srt-high-bitrate/patched-plugin');
  const plugin = baseline ? path.join(root, 'data/soundspectrum-srt-high-bitrate/plugin-archive', baseline) : patched;
  const version = baseline ? '1.26.11.1' : '1.26.11.2';
  const revision = baseline ? 'listener-backpressure-1' : 'listener-backpressure-2';
  const original = path.join(runtime, 'lib/gstreamer-1.0/gstsrt.dll');
  const before = await hash(original), artifact = await hash(path.join(plugin, 'gstsrt.dll'));
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, 'backpressure-plugin.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.revision !== revision || manifest.sha256 !== artifact)
    throw Error('private-plugin-identity-mismatch');
  const env = { ...captureEnvironment(path.join(runtime, 'bin/gst-launch-1.0.exe'),
    Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GST_|MTX_|RTSP_)/i.test(key)))),
    GST_PLUGIN_PATH_1_0: plugin, GST_REGISTRY_1_0: path.join(plugin, 'recovery-registry.bin'), GST_DEBUG: '0' };
  const inspection = await execute(path.join(runtime, 'bin/gst-inspect-1.0.exe'), ['srtsink'],
    { env, windowsHide: true, timeout: 20000, maxBuffer: 65536 });
  if (!new RegExp('^\\s*Version\\s+' + version.replaceAll('.', '\\.') + '\\s*$', 'm').test(inspection.stdout) ||
      !inspection.stdout.toLowerCase().includes(path.join(plugin, 'gstsrt.dll').toLowerCase()))
    throw Error('private-plugin-not-loaded');
  const sockets = [], ports = [];
  try {
    for (let index = 0; index < 2; index++) {
      const socket = dgram.createSocket('udp4'); sockets.push(socket);
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
      ports.push(socket.address().port);
    }
  } finally { for (const socket of sockets) await new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } }); }
  let output;
  try {
    output = await execute(path.join(patched, 'build/listener-recovery.test.exe'),
      [...ports.map(String), baseline ? 'stall' : 'recover'],
      { env, windowsHide: true, timeout: 15000, maxBuffer: 524288 });
  } catch (error) {
    if (!error.killed && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) output = error;
    else throw Error(error.killed ? 'native-recovery-timeout' : 'native-recovery-exit-' + (Number.isSafeInteger(error.code) ? error.code : 'unknown'));
  }
  const raw = JSON.parse(output.stdout.trim());
  const keys = ['ackSuppressedMs', 'acksSuppressed', 'acceptedNewMessages', 'receivedNewMessages', 'sendDropTotal', 'stopMilliseconds'];
  if (keys.some(key => !Number.isFinite(raw[key]) || raw[key] < 0) ||
      ['expectedRecovery', 'backpressureObserved', 'directStatsRead', 'peerStayedConnected', 'passed'].some(key => typeof raw[key] !== 'boolean'))
    throw Error('invalid-native-recovery-observation');
  const observation = Object.fromEntries([...keys, 'expectedRecovery', 'backpressureObserved', 'directStatsRead', 'peerStayedConnected', 'passed'].map(key => [key, raw[key]]));
  const unchanged = before === await hash(original);
  const passed = observation.passed && observation.expectedRecovery === !baseline && observation.backpressureObserved && observation.directStatsRead &&
    observation.peerStayedConnected && observation.ackSuppressedMs >= 3000 && observation.ackSuppressedMs < 4500 &&
    observation.acksSuppressed > 0 && observation.stopMilliseconds < 2000 && unchanged &&
    (baseline ? observation.acceptedNewMessages <= 2 && observation.receivedNewMessages === 0 :
      observation.acceptedNewMessages > 10 && observation.receivedNewMessages > 10 && observation.sendDropTotal > 0);
  const receipt = { checkedAt: new Date().toISOString(), ...observation, passed,
    pluginVersion: version, revision, sha256: artifact, sharedRuntimeUnchanged: unchanged, originalSha256: before,
    scope: 'receiver ACK control packets suppressed for 3.2 seconds while peer drains; measures accepted and newly received payloads, not retransmitted datagrams' };
  await fs.writeFile(path.join(patched, `recovery-${baseline ? 'baseline' : 'fixed'}-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  if (!passed) process.exitCode = 1;
}
run().catch(error => { console.error(JSON.stringify({ passed: false,
  reason: /^[-a-z0-9]+$/.test(error.message) ? error.message : 'native-recovery-check-failed' })); process.exitCode = 1; });
