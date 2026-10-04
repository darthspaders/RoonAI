'use strict';

// Only private configuration is changed. No driver/default device, Listen,
// HQPlayer control, Roon transport, network connection or writer is opened.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { SETTINGS, readSettings, validId } = require('./index.cjs');

async function writeSettings(settings, file = SETTINGS) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function manage(action, options = {}) {
  const settingsPath = options.settingsPath || SETTINGS, output = options.output || require('./audio-output.cjs');
  const saved = await readSettings(settingsPath);
  if (action === '--enable') {
    const zoneId = options.zoneId || saved.zoneId, outputId = options.outputId || saved.outputId;
    if (!validId(zoneId) || !validId(outputId)) throw Error('Supply the exact Roon HQPlayer IDs with --zone <zoneId> --output <outputId>.');
    let route = saved.route;
    if (!route) {
      const sharedSettingsPath = options.sharedSettingsPath || path.join(__dirname, '../../data/soundspectrum-audio-feed/settings.json');
      try { const shared = JSON.parse(await fs.readFile(sharedSettingsPath, 'utf8')); if (shared.version === 1) route = shared.route; }
      catch (error) { if (error.code !== 'ENOENT') throw Error('The existing dedicated cable settings need repair.'); }
    }
    if (!route) {
      const discovery = await output.discoverOutput();
      if (!discovery.available) throw Error('Cannot configure the dedicated SoundSpectrum cable: ' + discovery.reason);
      route = discovery.route;
    }
    const settings = { version: 1, enabled: true, zoneId, outputId, route };
    const probe = await output.probeOutput({ settings });
    if (!probe.available) throw Error('Cannot enable HQPlayer analysis output: ' + probe.reason);
    await writeSettings(settings, settingsPath);
    return { enabled: true, zoneId, outputId, message: 'HQPlayer analysis is enabled for explicit Start visuals only. No monitoring connection or audio output was started.' };
  }
  if (action === '--disable') {
    await writeSettings({ ...saved, enabled: false }, settingsPath);
    return { enabled: false, message: 'HQPlayer analysis is off. An active feed stops at its next local safety check.' };
  }
  if (action === '--status') {
    const probe = await output.probeOutput({ settingsPath });
    return { enabled: saved.enabled, zoneId: saved.zoneId || '', outputId: saved.outputId || '',
      cableAvailable: probe.available === true, reason: probe.reason || '' };
  }
  throw Error('Use --status, --disable, or --enable --zone <zoneId> --output <outputId>.');
}

function parseArguments(argv) {
  const action = argv[0]; if (!['--status', '--disable', '--enable'].includes(action)) throw Error('Choose --status, --disable or --enable.');
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i] === '--zone' ? 'zoneId' : argv[i] === '--output' ? 'outputId' : '';
    if (action !== '--enable' || !key || options[key] || !validId(argv[i + 1])) throw Error('Invalid HQPlayer analysis configuration arguments.');
    options[key] = argv[i + 1];
  }
  return { action, options };
}

module.exports = { manage, writeSettings, parseArguments };
if (require.main === module) {
  Promise.resolve().then(() => parseArguments(process.argv.slice(2))).then(({ action, options }) => manage(action, options))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
