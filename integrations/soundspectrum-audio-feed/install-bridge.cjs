"use strict";
// Default is a read-only plan. Install/uninstall never restart Lyrion or playback.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = "1.0.40";
const EXPECTED = Object.freeze({
  "Player.pm": "251dc37498f9fcee89261931c9dd15c3926bc970b79741e4cbe5ea40b7b0b0a6",
  "Stream.pm": "fb7222844c85917e5e99becfc9d3535ca2b7fd272a461a3cdf5fb76ee881eb64",
  "install.xml": "dce4d8c0053951bc38e77ed9d5f43a775bd22c6ccd7c536612729cfa514b1283"
});
const MODULE_NAME = "RabbitHoleAudioTap.pm";
const CONFIG_NAME = "RabbitHoleAudioTap.config.json";
const MARKER = "Rabbit Hole optional audio feed v1";
const APP_ROOT = path.resolve(__dirname, "../..");
const PLUGIN_ROOT = "C:/ProgramData/Lyrion/Cache/InstalledPlugins/Plugins/HQPlayerBridge";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

function block(name, body, newline) {
  return `# BEGIN ${MARKER}: ${name}${newline}${body.replace(/\n/g, newline)}${newline}# END ${MARKER}: ${name}${newline}`;
}

function patchSources(sources, expected = EXPECTED) {
  for (const name of Object.keys(EXPECTED)) {
    if (!Buffer.isBuffer(sources[name]) || sha(sources[name]) !== expected[name]) {
      throw new Error(`HQPlayerBridge ${name} changed; refusing to patch an unreviewed source.`);
    }
  }
  if (!sources["install.xml"].toString("utf8").includes(`<version>${VERSION}</version>`)) {
    throw new Error(`Only the reviewed HQPlayerBridge ${VERSION} is supported.`);
  }
  const patches = [];
  const append = (name, anchor, label, body, before = false) => {
    const original = sources[name];
    const newline = original.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    const needle = Buffer.from(anchor.replace(/\n/g, newline));
    const at = original.indexOf(needle);
    if (at < 0 || original.indexOf(needle, at + 1) >= 0) throw new Error(`Ambiguous ${name} ${label} hook.`);
    const inserted = Buffer.from(block(label, body, newline));
    const offset = before ? at : at + needle.length;
    sources[name] = Buffer.concat([original.subarray(0, offset), inserted, original.subarray(offset)]);
    patches.push({ name, label, inserted: inserted.toString("utf8") });
  };
  append("Player.pm", "sub nextChunk {\n", "load", `our $RABBIT_HOLE_AUDIO_TAP = 0;
{
    my $rh_module = __FILE__;
    $rh_module =~ s{[^\\\\/]+$}{${MODULE_NAME}};
    if (-f $rh_module) {
        $RABBIT_HOLE_AUDIO_TAP = eval {
            require $rh_module;
            Plugins::HQPlayerBridge::RabbitHoleAudioTap::init();
            1;
        } ? 1 : 0;
    }
}`, true);
  append("Player.pm", "    my $ref = $self->SUPER::nextChunk(@_);\n", "copy", `    eval { Plugins::HQPlayerBridge::RabbitHoleAudioTap::copy_chunk($self, $ref) }
        if $RABBIT_HOLE_AUDIO_TAP;`);
  append("Player.pm", "    @{ $self->chunks } = ();\n", "close", `    eval { Plugins::HQPlayerBridge::RabbitHoleAudioTap::end($self) }
        if $Plugins::HQPlayerBridge::Player::RABBIT_HOLE_AUDIO_TAP;`);
  append("Stream.pm", "    my $prelude = _flacPrelude($client);\n", "begin", `    eval { Plugins::HQPlayerBridge::RabbitHoleAudioTap::begin($client, $prelude) }
        if $Plugins::HQPlayerBridge::Player::RABBIT_HOLE_AUDIO_TAP;`);
  return { sources, patches };
}

function removeBlocks(buffer, patches) {
  for (const patch of patches) {
    const needle = Buffer.from(patch.inserted);
    const at = buffer.indexOf(needle);
    if (at < 0 || buffer.indexOf(needle, at + 1) >= 0) throw new Error(`Own ${patch.label} patch changed; refusing automatic removal.`);
    buffer = Buffer.concat([buffer.subarray(0, at), buffer.subarray(at + needle.length)]);
  }
  return buffer;
}

function readSources(pluginRoot) {
  return Object.fromEntries(Object.keys(EXPECTED).map(name => [name, fs.readFileSync(path.join(pluginRoot, name))]));
}

function atomicWrite(file, bytes) {
  const temporary = `${file}.rhaudiofeed-${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: "wx" });
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function resolvePaths(options = {}) {
  const appRoot = path.resolve(options.appRoot || APP_ROOT);
  const pluginRoot = path.resolve(options.pluginRoot || PLUGIN_ROOT);
  const stateRoot = path.join(appRoot, "data", "soundspectrum-audio-feed");
  return { appRoot, pluginRoot, stateRoot,
    manifestPath: path.join(stateRoot, "bridge-manifest.json"),
    modulePath: path.join(pluginRoot, MODULE_NAME),
    configPath: path.join(pluginRoot, CONFIG_NAME),
    demandPath: path.join(stateRoot, "demand.json") };
}

function plan(options = {}) {
  const locations = resolvePaths(options);
  if (fs.existsSync(locations.manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(locations.manifestPath, "utf8"));
    if (manifest.installed) {
      if (manifest.version !== 1 || path.resolve(manifest.pluginRoot) !== locations.pluginRoot ||
          path.resolve(manifest.modulePath) !== locations.modulePath || path.resolve(manifest.configPath) !== locations.configPath ||
          sha(fs.readFileSync(locations.modulePath)) !== manifest.moduleSha256 || sha(fs.readFileSync(locations.configPath)) !== manifest.configSha256) {
        throw new Error("Installed optional helper ownership changed; refusing automatic replacement.");
      }
      for (const record of manifest.files) {
        if (!["Player.pm", "Stream.pm"].includes(record.name)) throw new Error("Unexpected owned source.");
        removeBlocks(fs.readFileSync(path.join(locations.pluginRoot, record.name)), record.patches);
      }
      return { mode: "plan", installed: true, needsRestart: true, pluginVersion: VERSION, manifestPath: locations.manifestPath };
    }
  }
  const originals = readSources(locations.pluginRoot);
  const { sources, patches } = patchSources({ ...originals });
  for (const file of [locations.modulePath, locations.configPath]) {
    if (fs.existsSync(file)) throw new Error(`An unowned optional helper already exists at ${path.basename(file)}.`);
  }
  return { mode: "plan", installed: false, needsRestart: true, pluginVersion: VERSION,
    manifestPath: locations.manifestPath,
    files: ["Player.pm", "Stream.pm"].map(name => ({ name, beforeSha256: sha(originals[name]), afterSha256: sha(sources[name]) })),
    hooks: patches.map(({ name, label }) => ({ name, label })) };
}

function install(options = {}) {
  const locations = resolvePaths(options);
  const reviewed = plan(options);
  if (reviewed.installed) return reviewed;
  const originals = readSources(locations.pluginRoot);
  const { sources, patches } = patchSources({ ...originals });
  const module = fs.readFileSync(path.join(__dirname, "lyrion", "AudioTap.pm"));
  const config = Buffer.from(JSON.stringify({ version: 1, demandFile: locations.demandPath }, null, 2) + "\n");
  fs.mkdirSync(locations.stateRoot, { recursive: true });
  const backupRoot = path.join(locations.stateRoot, "bridge-backups", new Date().toISOString().replace(/[^\dTZ]/g, "") + "-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(backupRoot, { recursive: true });
  const manifest = { version: 1, build: 1, pluginVersion: VERSION, installed: true, needsRestart: true,
    installedAt: new Date().toISOString(), modulePath: locations.modulePath, moduleSha256: sha(module),
    configPath: locations.configPath, configSha256: sha(config), pluginRoot: locations.pluginRoot,
    files: ["Player.pm", "Stream.pm"].map(name => ({ name, beforeSha256: sha(originals[name]), afterSha256: sha(sources[name]),
      backupPath: path.join(backupRoot, name + ".original"), patches: patches.filter(patch => patch.name === name) })) };
  for (const record of manifest.files) fs.writeFileSync(record.backupPath, originals[record.name], { flag: "wx" });
  const changed = [];
  try {
    fs.writeFileSync(locations.modulePath, module, { flag: "wx" }); changed.push({ file: locations.modulePath, installed: module });
    fs.writeFileSync(locations.configPath, config, { flag: "wx" }); changed.push({ file: locations.configPath, installed: config });
    for (const name of ["Player.pm", "Stream.pm"]) {
      if (sha(fs.readFileSync(path.join(locations.pluginRoot, name))) !== sha(originals[name])) throw new Error("Plugin changed during installation.");
      atomicWrite(path.join(locations.pluginRoot, name), sources[name]);
      changed.push({ file: path.join(locations.pluginRoot, name), installed: sources[name], original: originals[name] });
    }
    atomicWrite(locations.manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  } catch (error) {
    for (const record of changed.reverse()) {
      if (fs.existsSync(record.file) && sha(fs.readFileSync(record.file)) === sha(record.installed)) {
        if (record.original) atomicWrite(record.file, record.original); else fs.unlinkSync(record.file);
      }
    }
    throw error;
  }
  return { mode: "installed", installed: true, needsRestart: true, pluginVersion: VERSION, manifestPath: locations.manifestPath };
}

function uninstall(options = {}) {
  const locations = resolvePaths(options);
  const manifest = JSON.parse(fs.readFileSync(locations.manifestPath, "utf8"));
  if (!manifest.installed) return { mode: "uninstalled", installed: false, needsRestart: true };
  if (manifest.version !== 1 || path.resolve(manifest.pluginRoot) !== locations.pluginRoot ||
      path.resolve(manifest.modulePath) !== locations.modulePath || path.resolve(manifest.configPath) !== locations.configPath) {
    throw new Error("Optional helper ownership does not match this plugin directory.");
  }
  const replacements = manifest.files.map(record => {
    if (!["Player.pm", "Stream.pm"].includes(record.name)) throw new Error("Unexpected owned source.");
    const file = path.join(locations.pluginRoot, record.name);
    const original = fs.readFileSync(file);
    return { file, original, next: removeBlocks(original, record.patches) };
  });
  // Validate every file before touching any file. Preserve unrelated new edits.
  const ownedFiles = [[locations.modulePath, manifest.moduleSha256], [locations.configPath, manifest.configSha256]].map(([file, expected]) => {
    const original = fs.readFileSync(file);
    if (sha(original) !== expected) throw new Error(`Own ${path.basename(file)} changed; refusing automatic removal.`);
    return { file, original };
  });
  const changed = [];
  try {
    for (const record of replacements) { atomicWrite(record.file, record.next); changed.push(record); }
    fs.unlinkSync(locations.modulePath);
    fs.unlinkSync(locations.configPath);
    manifest.installed = false;
    manifest.needsRestart = true;
    manifest.removedAt = new Date().toISOString();
    atomicWrite(locations.manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  } catch (error) {
    for (const record of ownedFiles) {
      if (!fs.existsSync(record.file)) fs.writeFileSync(record.file, record.original, { flag: "wx" });
    }
    for (const record of changed.reverse()) {
      if (sha(fs.readFileSync(record.file)) === sha(record.next)) atomicWrite(record.file, record.original);
    }
    throw error;
  }
  return { mode: "uninstalled", installed: false, needsRestart: true, manifestPath: locations.manifestPath };
}

module.exports = { VERSION, EXPECTED, MODULE_NAME, CONFIG_NAME, sha, patchSources, removeBlocks, resolvePaths, plan, install, uninstall };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const value = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
    const options = { appRoot: value("--app-root"), pluginRoot: value("--plugin-root") };
    const modes = ["--plan", "--install", "--uninstall"].filter(flag => args.includes(flag));
    if (modes.length > 1) throw new Error("Choose one operation.");
    const result = modes[0] === "--install" ? install(options) : modes[0] === "--uninstall" ? uninstall(options) : plan(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
