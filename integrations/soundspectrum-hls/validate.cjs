'use strict';
// Explicit bounded synthetic transport validation; no application/native window,
// audio, playback, saved settings, or production ownership record is touched.
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), net = require('node:net');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { buildPipeline, relayConfig, ASSET_NAME } = require('./index.cjs');
const { captureEnvironment } = require('../../scripts/soundspectrum-capture.cjs');
const root = path.resolve(__dirname, '../..'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function run(rate) {
  const directory = path.join(root, 'data/soundspectrum-hls-validation', String(Date.now())); await fs.mkdir(directory, { recursive: true });
  const session = { epoch: crypto.randomBytes(16).toString('hex'), user: crypto.randomBytes(16).toString('hex'), password: crypto.randomBytes(16).toString('hex'), mediaPath: 'video',
    ports: { rtmp: await freePort(), api: await freePort(), hls: await freePort() }, profile: { width: 3840, height: 2160, fps: 60, targetBitrateMbps: rate },
    nativeIdentity: { pid: 1, executable: 'C:\\WhiteCap Standalone.x64.exe', windowHandle: '1', startTimeTicks: '638000000000000001', windowClass: 'Test',
      windowTitle: 'Rabbit Hole WhiteCap RH-12345678-1234-1234-1234-123456789abc' } };
  if (new Set(Object.values(session.ports)).size !== 3) throw Error('port-allocation-collision');
  const gst = path.join(root, 'data/soundspectrum-gstreamer/1.26.11/bin/gst-launch-1.0.exe'), relay = path.join(root, 'data/soundspectrum-obs-webrtc/mediamtx/mediamtx.exe');
  const env = { ...captureEnvironment(gst, Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GST_|MTX_|RTSP_|RTMP_)/i.test(key)))), GST_DEBUG: '2', GST_DEBUG_NO_COLOR: '1' };
  const relaySettings = relayConfig(session);
  const configFile = path.join(directory, 'mediamtx.json'); await fs.writeFile(configFile, JSON.stringify(relaySettings));
  const children = [], result = { at: new Date().toISOString(), requestedBitrateMbps: rate, synthetic: true, samples: [], errorClasses: [], diagnostics: [], cleanup: {} };
  let encodedBytes = 0, encodedFrames = 0;
  function child(executable, args, encoder) {
    const value = spawn(executable, args, { cwd: path.dirname(executable), env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { value, kind: encoder ? 'encoder' : 'relay', exited: false }; children.push(entry); let tail = '';
    value.once('exit', code => { entry.exited = true; entry.exitCode = code; }); value.once('error', () => { entry.exited = true; result.errorClasses.push('child-spawn-error'); });
    const classify = text => {
      for (const [code, expression] of [['relay-configuration', /ERR.*(?:yaml|json|invalid|unmarshal)/i], ['native-error', /\bERROR\b/], ['pipeline-parse', /erroneous pipeline/], ['segment-size-limit', /maximum segment size/i], ['muxer-frame-drop', /reader is too slow, discarding/i]]) if (expression.test(text) && !result.errorClasses.includes(code)) result.errorClasses.push(code);
      for (const line of text.split(/\r?\n/)) if (/erroneous pipeline|\bERROR\b|\bERR\b|^Setting pipeline|^Pipeline is|^Progress:|\[RTMP\]|\[HLS\]/.test(line) && result.diagnostics.length < 30) {
        let safe = line; for (const secret of [session.password, session.user, session.epoch]) safe = safe.split(secret).join('[redacted]');
        safe = safe.replace(/(?:rtmp|rtsp|https?):\/\/\S+/g, '[private endpoint]'); result.diagnostics.push(safe.slice(0, 240));
      }
    };
    value.stderr.on('data', chunk => classify(chunk.toString()));
    value.stdout.on('data', chunk => { classify(chunk.toString()); if (!encoder) return; const lines = (tail + chunk.toString()).split(/\r?\n/); tail = lines.pop().slice(-32768);
      for (const line of lines) if (line.includes('GstIdentity:OwnedHlsBytes') && line.includes('last-message = chain')) { const count = Number(/\((\d+) bytes/.exec(line)?.[1]); if (Number.isSafeInteger(count) && count > 0) { encodedBytes += count; encodedFrames++; } } });
    return entry;
  }
  async function request(port, resource) {
    const authorization = port === session.ports.hls ? 'Bearer ' + session.password : 'Basic ' + Buffer.from(session.user + ':' + session.password).toString('base64');
    const response = await fetch(`http://127.0.0.1:${port}/${resource}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw Error('http-media-unavailable'); } return response;
  }
  try {
    child(relay, [configFile], false);
    const relayDeadline = performance.now() + 10000;
    for (;;) { try { const response = await request(session.ports.api, 'v3/config/global/get'); await response.body.cancel(); break; } catch { if (performance.now() > relayDeadline || children.some(entry => entry.exited)) throw Error('relay-not-ready'); await sleep(100); } }
    const args = buildPipeline({ adapterIndex: 0 }, session), firstBang = args.indexOf('!');
    args.splice(2, firstBang - 2, 'd3d11testsrc', 'is-live=true', 'pattern=snow', 'adapter=0');
    child(gst, args, true);
    const deadline = performance.now() + 30000; let first = null, priorBytes = 0, priorAt = performance.now(), mediaName = null;
    while (performance.now() < deadline) {
      if (children.some(entry => entry.exited)) throw Error('owned-validation-child-exited');
      try {
        const master = await (await request(session.ports.hls, 'video/index.m3u8')).text();
        result.masterSummary = master.split(/\r?\n/).filter(line => !/(?:password|user=|pass=|https?:)/i.test(line)).slice(0, 15);
        mediaName = master.split(/\r?\n/).find(line => line && !line.startsWith('#'));
        if (!ASSET_NAME.test(mediaName || '') || !mediaName.endsWith('.m3u8')) throw Error('unexpected-media-playlist');
        const playlist = await (await request(session.ports.hls, 'video/' + mediaName)).text();
        result.mediaSummary = playlist.split(/\r?\n/).filter(line => !/(?:password|user=|pass=|https?:)/i.test(line)).slice(-15);
        const parts = playlist.split(/\r?\n/).filter(line => line.startsWith('#EXT-X-PART:'));
        const latest = parts.at(-1), file = /URI="([^"]+)"/.exec(latest || '')?.[1];
        if (!ASSET_NAME.test(file || '')) throw Error('no-completed-part');
        const response = await request(session.ports.hls, 'video/' + file); let bytes = 0; for await (const chunk of response.body) bytes += chunk.length;
        const now = performance.now(); if (first === null) first = now;
        const sample = { elapsedMs: Math.round(now - first), partBytes: bytes, partDurationSeconds: Number(/DURATION=([\d.]+)/.exec(latest)?.[1]),
          mediaSequence: Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)?.[1]), encodedFrames, encodedMbps: (encodedBytes - priorBytes) * 8 / (now - priorAt) / 1000 };
        result.samples.push(sample); priorBytes = encodedBytes; priorAt = now;
        if (now - first >= 20000) { result.pass = true; break; }
      } catch (error) { result.lastMediaError = /^[-a-z]+$/.test(error.message) ? error.message : 'media-request-failed'; result.lastMediaErrorName = /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : 'unknown'; result.lastMediaErrorCode = /^[A-Za-z0-9_]+$/.test(error.cause?.code || '') ? error.cause.code : null; if (first !== null) throw error; }
      await sleep(1000);
    }
    if (!result.pass || result.samples.length < 10 || result.samples.at(-1).mediaSequence <= result.samples[0].mediaSequence || result.errorClasses.length) throw Error('hls-validation-incomplete');
    result.encodedBytes = encodedBytes; result.encodedFrames = encodedFrames;
  } catch (error) { result.pass = false; result.failure = /^[-a-z]+$/.test(error.message) ? error.message : 'validation-failed'; }
  finally {
    result.encodedBytes = encodedBytes; result.encodedFrames = encodedFrames;
    for (const entry of [...children].reverse()) if (!entry.exited) { entry.value.kill(); const end = performance.now() + 5000; while (!entry.exited && performance.now() < end) await sleep(50); }
    result.cleanup.childrenExited = children.every(entry => entry.exited); result.cleanup.exits = children.map(entry => ({ kind: entry.kind, exitCode: entry.exitCode ?? null })); if (!result.cleanup.childrenExited) result.pass = false;
    await fs.unlink(configFile); await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ pass: result.pass, failure: result.failure || null, samples: result.samples.length,
      maximumPartBytes: Math.max(0, ...result.samples.map(sample => sample.partBytes)), encodedFrames: result.encodedFrames || 0,
      errorClasses: result.errorClasses, lastMediaError: result.lastMediaError, lastMediaErrorName: result.lastMediaErrorName, lastMediaErrorCode: result.lastMediaErrorCode, masterSummary: result.masterSummary, mediaSummary: result.mediaSummary, diagnostics: result.diagnostics, cleanup: result.cleanup, receipt: path.join(directory, 'receipt.json') }));
    process.exitCode = result.pass ? 0 : 1;
  }
}
if (process.argv.length === 4 && process.argv[2] === '--run' && ['--rate=50', '--rate=600'].includes(process.argv[3])) run(Number(process.argv[3].slice(7))).catch(() => { console.error('Bounded HLS validation failed before its receipt; inspect owned test children.'); process.exitCode = 1; });
else console.log('Prepared only. Explicit --run --rate=50|600 runs a bounded synthetic loopback HLS check without music or native visuals.');
