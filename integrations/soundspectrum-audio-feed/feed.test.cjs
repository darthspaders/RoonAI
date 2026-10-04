'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AudioFeed, packet, parsePacket, buildDecodeCommand } = require('./index.cjs');
const PLAYER = 'aa:bb:cc:dd:ee:ff', TOKEN = 'a'.repeat(64);
const FLAC = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(38)]);

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-audio-feed-'));
  const settingsPath = path.join(directory, 'settings.json'), demandPath = path.join(directory, 'demand.json');
  await fs.writeFile(settingsPath, JSON.stringify({ version: 1, enabled: true, delayMs: 0 }));
  const children = [], sockets = []; let now = 1000, safety = true, playerChecks = 0;
  const output = { probeOutput: async () => ({ available: safety, reason: 'listen-enabled' }), validateOutput: async () => ({ available: safety, reason: 'listen-enabled' }), buildOutputCommand: () => ({ command: 'dedicated-cable', args: ['exact-device', 'shared-mode'] }) };
  const f = new AudioFeed({ settingsPath, demandPath, output, clock: () => now, bridgeStatus: async () => ({ version: 1, loaded: 1, configured: 1 }), requirePlayer: async id => { assert.equal(id, PLAYER); playerChecks++; },
    socketFactory: () => { const socket = new EventEmitter(); socket.bind = (_port, address, callback) => { assert.equal(address, '127.0.0.1'); callback(); }; socket.address = () => ({ port: 34567 }); socket.close = () => { socket.closed = true; }; sockets.push(socket); return socket; },
    spawnImpl: (command, args) => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.command = command; child.args = args; child.kill = () => { child.killed = true; child.emit('close', 0); }; children.push(child); return child; }, ...overrides });
  t.after(async () => { await f.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { f, children, sockets, settingsPath, demandPath, get playerChecks() { return playerChecks; }, unsafe: () => { safety = false; }, advance: ms => { now += ms; }, send: (type, sequence, payload = Buffer.alloc(0), generation = 'stream-1') => f.receive(packet({ v: 1, token: f.token, playerId: PLAYER, generation, sequence, type, format: 'flac' }, payload), { address: '127.0.0.1' }) };
}

test('disabled inspection creates no socket, decoder, audio output or demand file', async t => {
  const q = await fixture(t);
  await fs.writeFile(q.settingsPath, JSON.stringify({ version: 1, enabled: false }));
  assert.equal((await q.f.inspect(true)).available, false);
  await assert.rejects(q.f.start({ playerId: PLAYER }), /off/);
  assert.equal(q.children.length, 0); assert.equal(q.sockets.length, 0); assert.equal(q.playerChecks, 0);
  await assert.rejects(fs.stat(q.demandPath), { code: 'ENOENT' });
});
test('unloaded bridge and noncanonical player never open an audio device', async t => {
  const q = await fixture(t, { bridgeStatus: async () => ({ version: 1, loaded: 0, configured: 1 }) });
  await assert.rejects(q.f.start({ playerId: PLAYER }), /restart/);
  await assert.rejects(q.f.start({ playerId: 'url-or-token' }), /Lyrion player/);
  assert.equal(q.children.length, 0);
});
test('authenticated loopback packets reject remote senders, spoofed players and malformed headers', () => {
  const header = { v: 1, token: TOKEN, playerId: PLAYER, generation: 'stream-1', sequence: 0, type: 'begin', format: 'flac' };
  const bytes = packet(header, FLAC);
  assert.equal(parsePacket(bytes, { address: '192.168.1.1' }, TOKEN, PLAYER), null);
  assert.equal(parsePacket(bytes, { address: '127.0.0.1' }, 'b'.repeat(64), PLAYER), null);
  assert.equal(parsePacket(bytes, { address: '127.0.0.1' }, TOKEN, '11:22:33:44:55:66'), null);
  assert.equal(parsePacket(Buffer.alloc(33793), { address: '127.0.0.1' }, TOKEN, PLAYER), null);
  assert.equal(parsePacket(packet({ ...header, sequence: -1 }), { address: '127.0.0.1' }, TOKEN, PLAYER), null);
  assert.deepEqual(parsePacket(bytes, { address: '127.0.0.1' }, TOKEN, PLAYER).payload, FLAC);
});
test('explicit start opens only the dedicated output; decoder receives copied bytes in order', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER });
  assert.equal(q.children.length, 1); assert.equal(q.f.state, 'waiting');
  const demand = JSON.parse(await fs.readFile(q.demandPath, 'utf8'));
  assert.equal(demand.playerId, PLAYER); assert.equal(demand.token.length, 64); assert.equal(demand.port, 34567);
  q.send('begin', 0, FLAC); q.send('data', 1, Buffer.from('copied-encoded-audio'));
  assert.equal(q.children.length, 2); const decoder = q.children[1];
  assert.deepEqual(decoder.stdin.read(), Buffer.concat([FLAC, Buffer.from('copied-encoded-audio')]));
  assert.equal(decoder.args.includes('pipe:0'), true); assert.equal(decoder.args.some(value => /https?:|stream\.mp3|\/hqp\//.test(value)), false);
  decoder.stdout.write(Buffer.from([1, 0, 2, 0, 3])); decoder.stdout.write(Buffer.from([0, 4, 0]));
  assert.equal(q.f.totalPcm, 8); assert.equal(q.f.state, 'receiving');
  q.advance(20); q.f.tick(q.f.epoch); assert.deepEqual(q.children[0].stdin.read().subarray(0, 8), Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
});
test('original FLAC headers can arrive in data after an empty begin', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER });
  q.send('begin', 0); q.send('data', 1, FLAC);
  assert.deepEqual(q.children[1].stdin.read(), FLAC);
});
test('sequence loss closes only the copy instead of decoding corrupt FLAC', async t => {
  const q = await fixture(t); let failure;
  await q.f.start({ playerId: PLAYER, onFailure: error => { failure = error; } }); q.send('begin', 0, FLAC); q.send('data', 2, Buffer.from('gap'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(q.f.state, 'error'); assert.match(q.f.reason, /packet was lost/); assert.ok(q.children.every(child => child.killed));
  await q.f.failureCleanup; assert.match(failure.message, /packet was lost/);
});
test('encoded copy overflow and changed cable safety fail locally with bounded memory', async t => {
  const q = await fixture(t, { maxEncoded: 42 }); await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  q.send('data', 1, Buffer.alloc(43)); assert.equal(q.f.state, 'error'); assert.equal(q.f.encodedSize, 0);
  await q.f.stop(); await q.f.start({ playerId: PLAYER }); q.unsafe(); await q.f.checkSafety(q.f.epoch);
  assert.equal(q.f.state, 'error'); assert.match(q.f.reason, /Listen to this device/);
});
test('new source generation discards stale PCM and rejects late old packets', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  const old = q.children[1]; old.stdout.write(Buffer.alloc(100, 1)); q.send('begin', 0, FLAC, 'stream-2');
  assert.equal(old.killed, true); assert.equal(q.f.pcmSize, 0);
  q.send('data', 1, Buffer.from('old-generation'), 'stream-1'); old.stdout.write(Buffer.alloc(100, 2));
  assert.equal(q.f.pcmSize, 0); assert.deepEqual(q.children[2].stdin.read(), FLAC);
});
test('stop removes only its own demand and leaves no owned child or buffer', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  await fs.writeFile(q.demandPath, JSON.stringify({ token: 'another-owner' }));
  await q.f.stop(); assert.equal(JSON.parse(await fs.readFile(q.demandPath, 'utf8')).token, 'another-owner');
  assert.ok(q.children.every(child => child.killed)); assert.equal(q.sockets[0].closed, true); assert.equal(q.f.pcmSize + q.f.encodedSize, 0);
});
test('configured visual delay affects only the copy pacing and never adds a URL input', async t => {
  const q = await fixture(t); await fs.writeFile(q.settingsPath, JSON.stringify({ version: 1, enabled: true, delayMs: 1000 }));
  await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC); q.children[1].stdout.write(Buffer.from([1, 0, 2, 0]));
  q.advance(20); q.f.tick(q.f.epoch); assert.equal(q.f.pcmSize, 4); assert.ok(q.children[0].stdin.read().every(value => value === 0));
  for (let i = 0; i < 49; i++) { q.advance(20); q.f.tick(q.f.epoch); q.children[0].stdin.read(); }
  assert.equal(q.f.pcmSize, 4);
  q.advance(20); q.f.tick(q.f.epoch); assert.deepEqual(q.children[0].stdin.read().subarray(0, 4), Buffer.from([1, 0, 2, 0]));
  assert.equal(buildDecodeCommand({}).args.includes('44100'), true);
});

test('stop during readiness cancels a pending music start before any child opens', async t => {
  let finish;
  const q = await fixture(t, { bridgeStatus: () => new Promise(resolve => { finish = resolve; }) });
  const pending = q.f.start({ playerId: PLAYER });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await q.f.stop(); finish({ version: 1, loaded: 1, configured: 1 });
  await assert.rejects(pending, /cancelled/);
  assert.equal(q.children.length, 0); assert.equal(q.sockets.length, 0);
});

test('duplicate and retired begin packets cannot resurrect an old decoder', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER });
  q.send('begin', 0, FLAC); q.send('begin', 0, FLAC);
  assert.equal(q.children.length, 2);
  q.send('begin', 0, FLAC, 'stream-2'); q.send('begin', 0, FLAC, 'stream-1');
  assert.equal(q.children.length, 3); assert.equal(q.f.streamGeneration, 'stream-2');
});

test('read-only bridge status reports an unsupported route without opening a decoder', async t => {
  let state = 'unsupported';
  const q = await fixture(t, { bridgeStatus: async () => ({ version: 1, loaded: 1, configured: 1, state }) });
  await q.f.start({ playerId: PLAYER }); q.advance(5000); await q.f.checkSafety(q.f.epoch);
  assert.equal(q.f.state, 'unsupported'); assert.equal(q.children.length, 1);
  state = 'waiting'; q.advance(5000); await q.f.checkSafety(q.f.epoch);
  assert.equal(q.f.state, 'waiting');
});

test('an exclusive private owner prevents a second instance from opening audio output', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER });
  const other = await fixture(t, { settingsPath: q.settingsPath, demandPath: q.demandPath });
  await assert.rejects(other.f.start({ playerId: PLAYER }), /owner/);
  assert.equal(other.children.length, 0); assert.equal(JSON.parse(await fs.readFile(q.demandPath, 'utf8')).token, q.f.token);
  await q.f.stop(); await other.f.start({ playerId: PLAYER });
  assert.equal(other.children.length, 1);
});

test('a delayed unsupported status cannot discard a newer supported stream', async t => {
  let finish, defer = false;
  const q = await fixture(t, { bridgeStatus: () => defer ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ version: 1, loaded: 1, configured: 1 }) });
  await q.f.start({ playerId: PLAYER }); defer = true; q.advance(5000);
  const check = q.f.checkSafety(q.f.epoch);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  q.send('begin', 0, FLAC); q.children[1].stdout.write(Buffer.alloc(4));
  finish({ version: 1, loaded: 1, configured: 1, state: 'unsupported' }); await check;
  assert.equal(q.f.state, 'receiving'); assert.equal(q.children[1].killed, undefined);
});

test('irregular callback times submit the exact elapsed frame total without fractional drift', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  let elapsed = 0, written = 0;
  for (const ms of [20, 21, 39, 20, 0.5, 0.5, 0.5, 0.5, 19]) {
    elapsed += ms; q.advance(ms); q.f.tick(q.f.epoch);
    const chunk = q.children[0].stdin.read(); if (chunk) written += chunk.length / 4;
  }
  assert.equal(written, Math.floor(elapsed * 44100 / 1000));
});

test('copy pacing bounds catch-up writes and drops only buffered copy PCM after a large stall', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  q.advance(200); q.f.tick(q.f.epoch); assert.equal(q.children[0].stdin.read().length, 17640);
  q.f.tick(q.f.epoch); assert.equal(q.children[0].stdin.read().length, 17640);
  q.f.offerPcm(Buffer.alloc(44100 * 4, 1)); q.advance(1000); q.f.tick(q.f.epoch);
  assert.equal(q.children[0].stdin.read().length, 17640);
  assert.equal(q.f.droppedPcm, 39690); assert.equal(q.f.pcmSize, 0);
  assert.equal(q.f.state, 'receiving'); assert.ok(q.children.every(child => !child.killed));
});

test('a new source resets old pacing debt and a delay crossing consumes only post-delay PCM', async t => {
  const q = await fixture(t); await fs.writeFile(q.settingsPath, JSON.stringify({ version: 1, enabled: true, delayMs: 15 }));
  await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC); q.f.offerPcm(Buffer.alloc(10000, 1));
  q.advance(20); q.f.tick(q.f.epoch); const value = q.children[0].stdin.read();
  assert.ok(value.subarray(0, 662 * 4).every(byte => byte === 0)); assert.ok(value.subarray(662 * 4).every(byte => byte === 1));
  q.advance(400); q.send('begin', 0, FLAC, 'stream-2'); q.f.offerPcm(Buffer.alloc(10000, 2));
  q.f.tick(q.f.epoch); assert.equal(q.children[0].stdin.read(), null); assert.equal(q.f.pcmSize, 10000);
});

test('decoded signal measures signed PCM amplitude and clipping, rather than counting bytes as music', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  const pcm = Buffer.alloc(8), values = [16384, -16384, 32767, -32768];
  values.forEach((value, index) => pcm.writeInt16LE(value, index * 2));
  q.f.offerPcm(pcm.subarray(0, 3)); q.f.offerPcm(pcm.subarray(3));
  const signal = q.f.snapshot().decodedSignal;
  assert.equal(signal.samples, 4); assert.equal(signal.nonzeroSamples, 4);
  assert.equal(signal.clippedSamples, 2); assert.equal(signal.peak, 1); assert.equal(signal.peakDbfs, 0);
  const expectedRms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / 4) / 32768;
  assert.equal(signal.rms, expectedRms); assert.equal(signal.silent, false);
  assert.equal(q.f.snapshot().submittedSignal, null);
});

test('submitted signal includes actual delay silence and distinguishes it from decoded music', async t => {
  const q = await fixture(t); await fs.writeFile(q.settingsPath, JSON.stringify({ version: 1, enabled: true, delayMs: 1000 }));
  await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  const pcm = Buffer.alloc(44100 * 4); for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(16384, offset);
  q.f.offerPcm(pcm);
  for (let index = 0; index < 50; index++) { q.advance(20); q.f.tick(q.f.epoch); q.children[0].stdin.read(); }
  let status = q.f.snapshot();
  assert.equal(status.decodedSignal.rms, 0.5); assert.equal(status.decodedSignal.silent, false);
  assert.equal(status.submittedSignal.samples, 88200); assert.equal(status.submittedSignal.nonzeroSamples, 0);
  assert.equal(status.submittedSignal.rms, 0); assert.equal(status.submittedSignal.rmsDbfs, null); assert.equal(status.submittedSignal.silent, true);
  for (let index = 0; index < 50; index++) { q.advance(20); q.f.tick(q.f.epoch); q.children[0].stdin.read(); }
  status = q.f.snapshot(); assert.equal(status.submittedSignal.rms, 0.5); assert.equal(status.submittedSignal.silent, false);
});

test('signal windows remain bounded and cannot survive a source generation or stop', async t => {
  const q = await fixture(t); await q.f.start({ playerId: PLAYER }); q.send('begin', 0, FLAC);
  q.f.offerPcm(Buffer.alloc(44100 * 4 * 2, 1));
  assert.equal(q.f.snapshot().decodedSignal.samples, 88200); assert.equal(q.f.decodedSignal.samples, 0);
  q.send('begin', 0, FLAC, 'stream-2');
  assert.equal(q.f.snapshot().decodedSignal, null); assert.equal(q.f.snapshot().submittedSignal, null);
  q.f.offerPcm(Buffer.alloc(100, 0)); assert.equal(q.f.snapshot().decodedSignal.silent, true);
  await q.f.stop(); assert.equal(q.f.snapshot().decodedSignal, null); assert.equal(q.f.snapshot().submittedSignal, null);
});
