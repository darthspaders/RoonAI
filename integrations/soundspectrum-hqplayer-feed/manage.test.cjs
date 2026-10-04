'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { manage, parseArguments } = require('./manage.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hqp-config-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, 'settings.json'), sharedSettingsPath = path.join(dir, 'lyrion.json');
  const route = { fingerprint: 'a'.repeat(64) }; let discoveries = 0, probed;
  const output = { discoverOutput: async () => { discoveries++; return { available: true, route }; },
    probeOutput: async options => { probed = options; return { available: options.settings?.enabled === true, reason: options.settings ? '' : 'disabled' }; } };
  return { settingsPath, sharedSettingsPath, output, route, discoveries: () => discoveries, probed: () => probed };
}

test('first enable requires exact IDs and only writes independent private settings after route verification', async t => {
  const f = await fixture(t); await assert.rejects(manage('--enable', f), /exact Roon HQPlayer IDs/);
  await assert.rejects(fs.access(f.settingsPath), { code: 'ENOENT' });
  const result = await manage('--enable', { ...f, zoneId: 'zone-one', outputId: 'output-one' });
  assert.equal(result.enabled, true); assert.equal(f.discoveries(), 1);
  const settings = JSON.parse(await fs.readFile(f.settingsPath)); assert.equal(settings.zoneId, 'zone-one'); assert.equal(settings.outputId, 'output-one'); assert.deepEqual(settings.route, f.route);
  assert.equal(f.probed().settings.enabled, true);
  await manage('--disable', f); assert.equal(JSON.parse(await fs.readFile(f.settingsPath)).enabled, false);
  await manage('--enable', f); assert.equal(f.discoveries(), 1);
});

test('existing shared cable identity is copied once without changing the Lyrion settings', async t => {
  const f = await fixture(t), shared = JSON.stringify({ version: 1, enabled: true, route: f.route, privateSentinel: 'preserve' });
  await fs.writeFile(f.sharedSettingsPath, shared);
  await manage('--enable', { ...f, zoneId: 'zone-one', outputId: 'output-one' });
  assert.equal(f.discoveries(), 0); assert.equal(await fs.readFile(f.sharedSettingsPath, 'utf8'), shared);
  await fs.unlink(f.sharedSettingsPath); await manage('--enable', f); assert.equal(f.discoveries(), 0);
});

test('unsafe cable enable does not publish settings and status/disable do not start monitoring', async t => {
  const f = await fixture(t);
  await assert.rejects(manage('--enable', { ...f, zoneId: 'zone-one', outputId: 'output-one',
    output: { ...f.output, probeOutput: async () => ({ available: false, reason: 'listen-enabled' }) } }), /listen-enabled/);
  await assert.rejects(fs.access(f.settingsPath), { code: 'ENOENT' });
  assert.equal((await manage('--status', f)).enabled, false); assert.equal(f.discoveries(), 1);
  await manage('--disable', f); assert.equal(JSON.parse(await fs.readFile(f.settingsPath)).enabled, false);
});

test('CLI rejects duplicates, missing IDs and unrelated commands', () => {
  assert.deepEqual(parseArguments(['--enable', '--zone', 'a', '--output', 'b']), { action: '--enable', options: { zoneId: 'a', outputId: 'b' } });
  for (const args of [['--enable', '--zone'], ['--enable', '--port', '4321'], ['--enable', '--zone', 'a', '--zone', 'b'], ['--status', '--zone', 'a'], ['--play']]) assert.throws(() => parseArguments(args));
});
