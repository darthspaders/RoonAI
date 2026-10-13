"use strict";
// Finished-image publisher only: no NASA client, image worker, native installer,
// playback control, Windows preference write, hard link or filesystem watcher.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { read, atomic, noLinks, hash } = require('../soundspectrum-nasa-backgrounds/library.cjs');
const { eligible } = require('../soundspectrum-nasa-backgrounds/pipeline-sources.cjs');
const { validReceipt } = require('../soundspectrum-nasa-backgrounds/pipeline.cjs');
const ROOT = path.resolve(__dirname, '../..');
const HOME = path.join(ROOT, 'data/nasa-wallpaper');
const CATALOG_HOME = path.join(ROOT, 'data/nasa-whitecap/pipeline');
const OUTPUT = path.join(os.homedir(), 'Pictures/Rabbit Hole NASA Wallpapers');
const ID = /^nasa-(?:science-\d+|auto-[a-f0-9]{24})$/;
const MEMBER = /^NASA-([a-f0-9]{64})\.jpg$/;
const contains = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function dimensions(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw Error('Invalid finished JPEG');
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw Error('Invalid JPEG marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw Error('Truncated JPEG');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw Error('Invalid JPEG dimensions');
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw Error('Missing JPEG dimensions');
}
class Publisher {
  constructor(options = {}) {
    this.home = path.resolve(options.home || HOME);
    this.catalogHome = path.resolve(options.catalogHome || CATALOG_HOME);
    this.output = path.resolve(options.output || OUTPUT);
    this.staging = path.join(this.home, 'staging');
    this.quarantine = path.join(this.home, 'withdrawn');
    this.beforeRename = options.beforeRename;
    this.protected = [this.catalogHome, path.resolve(this.catalogHome, '..'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'SoundSpectrum'),
      ...(options.protectedDirectories || [])];
    for (const directory of [...this.protected, this.home]) {
      if (contains(directory, this.output) || contains(this.output, directory)) throw Error('Wallpaper folder overlaps protected assets or publisher state');
    }
    if (path.parse(this.output).root.toLowerCase() !== path.parse(this.staging).root.toLowerCase()) throw Error('Wallpaper staging and output must share a volume for atomic publication');
  }
  async lock(work) {
    await noLinks(this.home); await fs.mkdir(this.home, { recursive: true });
    const file = path.join(this.home, 'publisher.lock'); await noLinks(file);
    let handle;
    try { handle = await fs.open(file, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = await read(file, null);
      if (!Number.isInteger(old?.pid)) throw Error('Unrecognized wallpaper publisher lock');
      let alive = true;
      try { process.kill(old.pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
      if (alive) return { deferred: 'wallpaper publisher already running' };
      await fs.rename(file, file + '.interrupted-' + crypto.randomUUID());
      handle = await fs.open(file, 'wx');
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    try { return await work(); } finally { await handle.close(); await fs.unlink(file); }
  }
  async enable() {
    return this.lock(async () => {
      await noLinks(this.output); await fs.mkdir(this.output, { recursive: true });
      const prior = await read(path.join(this.home, 'manifest.json'), null);
      if (!prior && (await fs.readdir(this.output)).length) throw Error('Existing unowned wallpaper folder preserved');
      if (prior && prior.output !== this.output) throw Error('Wallpaper ownership folder mismatch');
      if (!prior) await atomic(path.join(this.home, 'manifest.json'), { version: 1, output: this.output, files: {} });
      await atomic(path.join(this.home, 'config.json'), { version: 1, enabled: true, output: this.output });
      return { enabled: true, output: this.output };
    });
  }
  async status() {
    const configuration = await read(path.join(this.home, 'config.json'), null);
    const latest = await read(path.join(this.home, 'status.json'), {});
    return { ...latest, enabled: configuration?.enabled === true, output: this.output };
  }
  async disable() {
    return this.lock(async () => {
      const configuration = await read(path.join(this.home, 'config.json'), {});
      await atomic(path.join(this.home, 'config.json'), { ...configuration, enabled: false });
      return { enabled: false, existingCopiesRetained: true };
    });
  }
  async validate(entry) {
    if (!ID.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.presentationSha256 || '')) throw Error('Invalid finished-image identity');
    const folder = path.join(this.catalogHome, 'assets', entry.id);
    const prepared = await validReceipt(folder, 'prepared.json');
    const masks = await validReceipt(folder, 'masks.json');
    if (!prepared || !masks || prepared.files['background-4k.jpg'] !== entry.presentationSha256 || masks.sourceSha256 !== entry.presentationSha256) throw Error('Finished-image receipts do not match the catalog');
    const source = path.join(folder, 'background-4k.jpg'); await noLinks(source);
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error('Invalid presentation file');
    const bytes = await fs.readFile(source);
    if (hash(bytes) !== entry.presentationSha256 || dimensions(bytes).join('x') !== '3840x2160') throw Error('Presentation must be the verified 3840x2160 JPEG');
    return bytes;
  }
  async sync({ catalog, onlyIds } = {}) {
    const configuration = await read(path.join(this.home, 'config.json'), null);
    if (!configuration?.enabled) return { enabled: false };
    if (configuration.version !== 1 || path.resolve(configuration.output) !== this.output) throw Error('Invalid wallpaper configuration');
    return this.lock(async () => {
      await noLinks(this.output); await noLinks(this.staging); await noLinks(this.quarantine);
      await fs.mkdir(this.output, { recursive: true }); await fs.mkdir(this.staging, { recursive: true }); await fs.mkdir(this.quarantine, { recursive: true });
      const record = path.join(this.home, 'manifest.json');
      const manifest = await read(record, null);
      if (manifest?.version !== 1 || manifest.output !== this.output || !manifest.files) throw Error('Missing wallpaper ownership');
      catalog ||= await read(path.join(this.catalogHome, 'catalog.json'), { assets: {} });
      const entries = Object.values(catalog.assets);
      const knownHashes = new Set(entries.map(e => e.presentationSha256).filter(Boolean));
      // Recognize only exact content-addressed crash orphans. User-added/edited
      // files are preserved and reported, never silently overwritten or removed.
      for (const name of await fs.readdir(this.output)) {
        const match = MEMBER.exec(name), file = path.join(this.output, name);
        await noLinks(file);
        if (!match || !(await fs.stat(file)).isFile()) throw Error('Unexpected member in dedicated wallpaper folder');
        if (!manifest.files[name]) {
          if (!knownHashes.has(match[1]) || hash(await fs.readFile(file)) !== match[1]) throw Error('Unowned wallpaper member preserved');
          manifest.files[name] = { sha256: match[1], ids: [], recoveredAfterInterruption: true };
        }
      }
      const result = { enabled: true, output: this.output, published: 0, alreadyPublished: 0, withdrawn: 0, errors: [], at: new Date().toISOString() };
      const desired = new Set();
      for (const entry of entries) {
        if (onlyIds && !onlyIds.includes(entry.id)) continue;
        if (entry.stage !== 'verified' || eligible(entry)) continue;
        try {
          const bytes = await this.validate(entry), digest = entry.presentationSha256, name = 'NASA-' + digest + '.jpg';
          const destination = path.join(this.output, name); await noLinks(destination);
          if (await fs.stat(destination).catch(e => { if (e.code !== 'ENOENT') throw e; return null; })) {
            if (hash(await fs.readFile(destination)) !== digest) throw Error('Edited wallpaper copy preserved');
            result.alreadyPublished++;
          } else {
            const temporary = path.join(this.staging, crypto.randomUUID() + '.part');
            const handle = await fs.open(temporary, 'wx');
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            if (hash(await fs.readFile(temporary)) !== digest) throw Error('Wallpaper staging checksum mismatch');
            if (this.beforeRename) await this.beforeRename({ temporary, destination });
            // Same-volume rename is the sole point where Windows can see the file.
            await fs.rename(temporary, destination); result.published++;
          }
          desired.add(name);
          const prior = manifest.files[name];
          manifest.files[name] = { sha256: digest, bytes: bytes.length, width: 3840, height: 2160,
            ids: [...new Set([...(prior?.ids || []), entry.id])], title: entry.title,
            sourceUrl: entry.sourceUrl, publishedAt: prior?.publishedAt || new Date().toISOString() };
          await atomic(record, manifest);
        } catch (e) { result.errors.push({ id: entry.id, reason: String(e.message).slice(0,240) }); }
      }
      if (!onlyIds) for (const [name, previous] of Object.entries(manifest.files)) {
        if (desired.has(name)) continue;
        if (!MEMBER.test(name)) throw Error('Invalid owned wallpaper filename');
        const file = path.join(this.output, name); await noLinks(file);
        const bytes = await fs.readFile(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        if (bytes) {
          if (hash(bytes) !== previous.sha256) { result.errors.push({ file: name, reason: 'Edited wallpaper copy preserved' }); continue; }
          await fs.rename(file, path.join(this.quarantine, crypto.randomUUID() + '-' + name)); result.withdrawn++;
        }
        delete manifest.files[name];
      }
      await atomic(record, manifest);
      result.total = Object.keys(manifest.files).length;
      await atomic(path.join(this.home, 'status.json'), result);
      return result;
    });
  }
}
async function publishFinished(options = {}) {
  let publisher;
  try { publisher = new Publisher(options); return await publisher.sync(options); }
  catch (e) {
    // A full/offline wallpaper destination must never turn a verified NASA
    // asset into a failure, stop collection, or reach the WhiteCap installer.
    const failure = { enabled: true, error: String(e.message).slice(0,240), at: new Date().toISOString() };
    if (publisher) await atomic(path.join(publisher.home, 'status.json'), failure).catch(() => {});
    return failure;
  }
}
async function main() {
  const command = process.argv[2] || 'status', publisher = new Publisher();
  if (command === 'enable') { await publisher.enable(); return publisher.sync(); }
  if (command === 'sync') return publisher.sync();
  if (command === 'status') return publisher.status();
  if (command === 'disable') return publisher.disable();
  throw Error('Commands: enable, sync, status, disable');
}
module.exports = { Publisher, publishFinished, dimensions, HOME, OUTPUT };
if (require.main === module) main().then(value => console.log(JSON.stringify(value, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
