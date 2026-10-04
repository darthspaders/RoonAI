'use strict';

// Explicit local configuration only. Never changes the default Windows device,
// Listen settings, an ASIO driver, a playlist, or a player transport.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SETTINGS, readSettings } = require('./index.cjs');
const output = require('./audio-output.cjs');
const execFileAsync = promisify(execFile);

async function writeSettings(settings, file = SETTINGS) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}
async function resolveFfmpeg() {
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command ffmpeg -ErrorAction Stop).Source'], { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
  const executable = result.stdout.trim();
  if (!path.isAbsolute(executable) || !/ffmpeg\.exe$/i.test(executable)) throw Error('The installed FFmpeg executable could not be resolved.');
  await execFileAsync(executable, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  return executable;
}
async function manage(action, value) {
  const saved = await readSettings();
  if (action === '--enable') {
    const discovered = await output.discoverOutput();
    if (!discovered.available) throw Error('Cannot enable the dedicated visualizer cable: ' + discovered.reason);
    const settings = { ...saved, version: 1, enabled: true, route: discovered.route, ffmpegExecutable: await resolveFfmpeg() };
    const probe = await output.probeOutput({ settings });
    if (!probe.available) throw Error('Cannot enable the audio-copy output: ' + probe.reason);
    await writeSettings(settings);
    return { enabled: true, message: 'Experimental input enabled. It starts only through Start visuals; bridge installation/restart may still be required.' };
  }
  if (action === '--disable') {
    await writeSettings({ ...saved, enabled: false });
    return { enabled: false, message: 'The experimental feed is off. An active copy shuts down at its next local safety check.' };
  }
  if (action === '--delay') {
    const delayMs = Number(value);
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) throw Error('Choose a visual delay from 0 through 30000 milliseconds.');
    await writeSettings({ ...saved, delayMs });
    return { enabled: saved.enabled, delayMs, message: 'Visual delay saved. Apply it on the next explicit Start visuals.' };
  }
  if (action === '--status') {
    const probe = await output.probeOutput();
    return { enabled: saved.enabled, delayMs: saved.delayMs, cableAvailable: probe.available, reason: probe.reason || '' };
  }
  throw Error('Use --enable, --disable, --status or --delay <milliseconds>.');
}
module.exports = { manage, writeSettings, resolveFfmpeg };
if (require.main === module) manage(process.argv[2], process.argv[3]).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
