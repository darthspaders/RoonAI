"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createSoundSpectrumNative, microphoneInputs, patchStandalonePreferences, PRODUCTS, NO_MIC_INPUTS } = require("../src/soundSpectrumNative");

const MIC = { id: "11111111-2222-3333-4444-555555555555", name: "Microphone (USB Audio Device)" };
const CABLE = { id: "22222222-2222-3333-4444-555555555555", name: "Microphone (VB-Audio Virtual Cable)" };
const original = Buffer.from('Prefs.Version = 8\r\nAudio.InputSource = "Previous source"\r\nAudio.AutoDetect.Enabled = 1\r\nGraphics.TargetFrameRate = 60\r\n');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "soundspectrum-native-"));
  const installRoot = path.join(root, "install"), preferencesRoot = path.join(root, "profile", "Roaming", "SoundSpectrum"), backupRoot = path.join(root, "backups");
  for (const product of PRODUCTS) {
    await fs.mkdir(path.join(installRoot, product.folder), { recursive: true });
    await fs.mkdir(path.join(preferencesRoot, product.folder), { recursive: true });
    await fs.writeFile(path.join(installRoot, product.folder, product.executable), "fixture");
    await fs.writeFile(path.join(preferencesRoot, product.folder, "Preferences (Standalone).txt"), original);
  }
  let child = null, running = false, spawned = 0, closes = 0;
  const helpers = [];
  const runWindowCommand = async (action, details = {}) => {
    helpers.push({ action, details });
    if (action === "inspect") return { inputs: options.inputs || [MIC, CABLE], processes: options.existing || (running ? [{ pid: child.pid, executable: child.executable, startTimeTicks: "123456789012345678" }] : []), owner: details.OwnerProcessId ? { pid: process.pid, executable: process.execPath, startTimeTicks: "555555555555555555" } : null, profile: options.missingProfile ? null : { roamingAppDataPath: path.dirname(preferencesRoot), profilePath: path.join(root, "profile") } };
    if (action === "inputs") return { inputs: options.inputs || [MIC, CABLE] };
    if (action === "close") { closes++; if (!options.closeFails) { running = false; child.emit("exit", 0); } return { closed: !options.closeFails }; }
    if (!running) return { exited: true };
    if (action === "window" || action === "prepare") return { pid: child.pid, startTimeTicks: "123456789012345678", window: { windowHandle: "98765", windowTitle: "G-Force Standalone", width: 800, height: 450, minimized: false } };
    throw new Error("Unexpected helper action.");
  };
  const service = createSoundSpectrumNative({
    platform: "win32", installRoot, preferencesRoot: options.useDefaultPreferences ? undefined : preferencesRoot, backupRoot, runWindowCommand,
    additionalInputProvider: options.additionalInputProvider,
    spawnImpl: (executable, args, spawnOptions) => {
      spawned++;
      if (options.spawnThrows) throw new Error("Fixture start failure.");
      child = new EventEmitter(); child.pid = 42; child.executable = executable; child.args = args; child.spawnOptions = spawnOptions;
      child.kill = () => { if (!options.killFails) { running = false; child.emit("exit", 1); } };
      running = true;
      return child;
    }
  });
  t.after(async () => { await service.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { service, root, backupRoot, preferencesRoot, helpers, runWindowCommand, installRoot, endChild: () => { running = false; child?.emit("exit", 0); }, child: () => child, spawned: () => spawned, closes: () => closes,
    prefPath: product => path.join(preferencesRoot, PRODUCTS.find(value => value.id === product).folder, "Preferences (Standalone).txt") };
}

test("native source inventory exposes only named physical microphones", () => {
  assert.deepEqual(microphoneInputs([MIC, CABLE, { ...MIC, name: "Stereo Mix (Realtek USB Audio)" }, { ...MIC, name: "Voicemeeter Out B1" }, { ...MIC, id: "default" }, { ...MIC, name: "Stereo Out (SoundSpectrum Audio Cable)" }]), [MIC]);
  assert.deepEqual(microphoneInputs([{ ...MIC, name: "Input (UMIK-2)", formFactor: 2 }, { ...MIC, name: "USB recording input", formFactor: 4 }]), [{ id: MIC.id, name: "Input (UMIK-2)" }, { id: MIC.id, name: "USB recording input" }]);
  assert.deepEqual(microphoneInputs([{ ...MIC, name: "Microphone", interfaceName: "NVIDIA Broadcast", formFactor: 4 }]), []);
});

test("native preferences retain unrelated settings and disable source fallback and Toolbar", () => {
  const patched = patchStandalonePreferences(original, MIC.name, "g-force").toString();
  assert.match(patched, /Audio.InputSource = "Microphone \(USB Audio Device\)"/);
  assert.match(patched, /Audio.AutoDetect.Enabled = 0/);
  assert.match(patched, /G-Force.AutoOpenToolbar = 0/);
  assert.match(patched, /Graphics.TargetFrameRate = 60\r\n/);
  assert.throws(() => patchStandalonePreferences(original, 'mic\nAudio.InputSource="Other"', "aeon"));
  assert.throws(() => patchStandalonePreferences(Buffer.from("No initialized preference version"), MIC.name, "aeon"));
});

test("native preferences preserve UTF-16 byte order and microphone text", () => {
  const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(original.toString(), "utf16le")]);
  const patched = patchStandalonePreferences(encoded, "Microphone (音声 USB)", "whitecap");
  assert.deepEqual(patched.subarray(0, 2), encoded.subarray(0, 2));
  assert.match(patched.subarray(2).toString("utf16le"), /Microphone \(音声 USB\)/);
});

test("owned renderer receives an explicit microphone and restores original preferences exactly", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.service.inspect()).inputs, [MIC]);
  const started = await f.service.start({ visualizer: "g-force", inputId: MIC.id });
  assert.equal(started.pid, 42); assert.equal(started.windowHandle, "98765"); assert.equal(started.visualizer, "g-force");
  assert.deepEqual(started.audioInput, MIC); assert.equal(started.owned, true);
  const modified = await fs.readFile(f.prefPath("g-force"), "utf8");
  assert.match(modified, /Audio.AutoDetect.Enabled = 0/);
  assert.equal((await fs.readdir(f.backupRoot)).length, 2);
  assert.equal((await f.service.start({ visualizer: "g-force", inputId: MIC.id })).pid, 42);
  assert.equal(f.spawned(), 1);
  await f.service.stop();
  assert.equal(f.closes(), 1); assert.equal(f.service.status().state, "stopped");
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
  assert.deepEqual(await fs.readdir(f.backupRoot), []);
  assert.ok(f.helpers.filter(call => call.action === "close").every(call => call.details.ProcessId === 42 && call.details.StartTimeTicks === "123456789012345678"));
});

test("unavailable or virtual microphone selections never start or modify preferences", async t => {
  const f = await fixture(t, { inputs: [CABLE] });
  assert.deepEqual(await f.service.listAudioInputs(), []);
  await assert.rejects(f.service.start({ visualizer: "aeon", inputId: CABLE.id }), /unavailable/);
  await assert.rejects(f.service.start({ visualizer: "aeon" }), /exact PC microphone/);
  assert.equal(f.spawned(), 0);
  assert.deepEqual(await fs.readFile(f.prefPath("aeon")), original);
});

test("preexisting manual product process is refused and never closed", async t => {
  const f = await fixture(t, { existing: [{ pid: 999, executable: "C:\\SoundSpectrum\\Aeon\\Aeon Standalone.x64.exe" }] });
  await assert.rejects(f.service.start({ visualizer: "aeon", inputId: MIC.id }), /existing Aeon/);
  await f.service.stop();
  assert.equal(f.spawned(), 0); assert.equal(f.closes(), 0);
  assert.deepEqual(await fs.readFile(f.prefPath("aeon")), original);
});

test("synchronous spawn failure restores preferences and deletes temporary backup", async t => {
  const f = await fixture(t, { spawnThrows: true });
  await assert.rejects(f.service.start({ visualizer: "whitecap", inputId: MIC.id }), /Fixture start failure/);
  assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
  assert.deepEqual(await fs.readdir(f.backupRoot), []);
  assert.equal(f.service.status().state, "stopped");
});

test("a failed graceful close terminates only the owned child before restoring preferences", async t => {
  const f = await fixture(t, { closeFails: true });
  await f.service.start({ visualizer: "aeon", inputId: MIC.id });
  await f.service.stop();
  assert.equal(f.closes(), 1);
  assert.deepEqual(await fs.readFile(f.prefPath("aeon")), original);
  assert.deepEqual(await fs.readdir(f.backupRoot), []);
});

test("when an owned child cannot close, original backup and ownership manifest remain", async t => {
  const f = await fixture(t, { closeFails: true, killFails: true });
  await f.service.start({ visualizer: "whitecap", inputId: MIC.id });
  await assert.rejects(f.service.stop(), /did not close/);
  const files = await fs.readdir(f.backupRoot);
  assert.equal(files.length, 2);
  const manifest = JSON.parse(await fs.readFile(path.join(f.backupRoot, "session-whitecap.json"), "utf8"));
  assert.equal(manifest.pid, 42); assert.equal(manifest.startTimeTicks, "123456789012345678");
  assert.deepEqual(await fs.readFile(path.join(f.backupRoot, manifest.backupFile)), original);
  f.endChild(); await f.service.stop();
  assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
});

async function orphanFixture(t, overrides = {}) {
  const f = await fixture(t);
  const visualizer = "g-force", product = PRODUCTS.find(value => value.id === visualizer);
  const executable = path.join(f.installRoot, product.folder, product.executable);
  const backupFile = `${visualizer}-${crypto.randomUUID()}.preferences.backup`;
  const manifest = { version: 1, visualizer, executable, pid: 1777, startTimeTicks: "123456789012345678", backupFile, originalSha256: crypto.createHash("sha256").update(original).digest("hex"), ownerPid: 1776, ownerExecutable: process.execPath, ownerStartTimeTicks: "555555555555555555", ...overrides.manifest };
  await fs.mkdir(f.backupRoot, { recursive: true });
  await fs.writeFile(path.join(f.backupRoot, backupFile), original);
  await fs.writeFile(path.join(f.backupRoot, `session-${visualizer}.json`), JSON.stringify(manifest));
  const patched = patchStandalonePreferences(original, MIC.name, visualizer);
  await fs.writeFile(f.prefPath(visualizer), patched);
  let processes = overrides.processes || [{ pid: manifest.pid, executable, startTimeTicks: "123456789012345678" }];
  const commands = [];
  const native = createSoundSpectrumNative({
    platform: "win32", installRoot: f.installRoot, preferencesRoot: f.preferencesRoot, backupRoot: f.backupRoot,
    spawnImpl: () => assert.fail("Recovery must never start a visualizer or microphone."),
    runWindowCommand: async (action, details = {}) => {
      commands.push({ action, details });
      if (action === "inspect") return { processes, inputs: [MIC], owner: overrides.owner || null };
      if (action === "close") { processes = []; return { closed: true }; }
      if (action === "window") return { exited: processes.length === 0 };
      throw new Error("Unexpected recovery helper action.");
    }
  });
  return { ...f, native, manifest, commands, patched, removeProcesses: () => { processes = []; } };
}

test("inspection recovers a verifiable owned orphan and restores exact original bytes without audio capture", async t => {
  const f = await orphanFixture(t);
  const result = await f.native.inspect();
  assert.equal(result.state, "stopped"); assert.equal(result.recoveryError, "");
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
  assert.deepEqual(await fs.readdir(f.backupRoot), []);
  const close = f.commands.find(call => call.action === "close");
  assert.equal(close.details.ProcessId, 1777); assert.equal(close.details.StartTimeTicks, f.manifest.startTimeTicks);
  assert.equal(close.details.ExpectedExecutable, f.manifest.executable);
});

test("recycled process identities and incomplete startup identities are never terminated", async t => {
  for (const manifest of [{ startTimeTicks: "999999999999999999" }, { startTimeTicks: null }]) {
    const f = await orphanFixture(t, { manifest });
    const result = await f.native.inspect();
    assert.match(result.recoveryError, /ownership cannot be verified/);
    assert.equal(f.commands.some(call => call.action === "close" || call.action === "terminate"), false);
    assert.deepEqual(await fs.readFile(f.prefPath("g-force")), f.patched);
    assert.equal((await fs.readdir(f.backupRoot)).length, 2);
    f.removeProcesses();
    assert.equal((await f.native.inspect()).recoveryError, "");
    assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
  }
});

test("invalid ownership manifest cannot redirect recovery to a different executable or preference file", async t => {
  const f = await orphanFixture(t, { manifest: { executable: "C:\\Windows\\unrelated.exe", preferencesPath: "C:\\Windows\\do-not-touch.txt" } });
  const result = await f.native.inspect();
  assert.match(result.recoveryError, /invalid/);
  assert.equal(f.commands.some(call => call.action === "close" || call.action === "terminate"), false);
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), f.patched);
  assert.equal((await fs.readdir(f.backupRoot)).length, 2);
});

test("a second app instance cannot recover or close the first app's active owned renderer", async t => {
  const f = await orphanFixture(t, { owner: { pid: 1776, executable: process.execPath, startTimeTicks: "555555555555555555" } });
  const result = await f.native.inspect();
  assert.match(result.recoveryError, /another running Rabbit Hole session/);
  assert.equal(f.commands.some(call => call.action === "close" || call.action === "terminate"), false);
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), f.patched);
  assert.equal((await fs.readdir(f.backupRoot)).length, 2);
});

test("missing APPDATA resolves preferences from the desktop user's verified KnownFolder", async t => {
  const prior = process.env.APPDATA;
  delete process.env.APPDATA;
  try {
    const f = await fixture(t, { useDefaultPreferences: true });
    await f.service.start({ visualizer: "whitecap", inputId: MIC.id });
    assert.match(await fs.readFile(f.prefPath("whitecap"), "utf8"), /Microphone \(USB Audio Device\)/);
    await f.service.stop();
    assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
  } finally {
    if (prior === undefined) delete process.env.APPDATA; else process.env.APPDATA = prior;
  }
});

test("unknown desktop profiles and relative overrides fail before changing any preferences", async t => {
  const f = await fixture(t, { useDefaultPreferences: true, missingProfile: true });
  await assert.rejects(f.service.start({ visualizer: "aeon", inputId: MIC.id }), /could not resolve the desktop user's/);
  assert.equal(f.spawned(), 0);
  assert.deepEqual(await fs.readFile(f.prefPath("aeon")), original);
  assert.throws(() => createSoundSpectrumNative({ preferencesRoot: "SoundSpectrum" }), /absolute desktop profile/);
});

test("all three native visualizers expose exact installed vendor no-mic modes while physical inventory stays separate", async t => {
  const f = await fixture(t, { inputs: [] });
  const result = await f.service.inspect();
  assert.deepEqual(result.inputs, []);
  const expected = [
    { id: "generator:fluid", name: "Sound Generator (Fluid)", kind: "no-mic" },
    { id: "generator:high-energy", name: "Sound Generator (High Energy)", kind: "no-mic" },
    { id: "generator:chill", name: "Sound Generator (Chill)", kind: "no-mic" }
  ];
  for (const product of PRODUCTS) assert.deepEqual(result.noMicInputs[product.id], expected);
});

test("each native generator starts with no microphone and sets only its exact built-in source", async t => {
  const f = await fixture(t, { inputs: [] });
  for (const product of PRODUCTS) for (const input of NO_MIC_INPUTS) {
    const started = await f.service.start({ visualizer: product.id, inputId: input.id });
    assert.deepEqual(started.audioInput, input);
    assert.equal(started.audioInput.kind, "no-mic");
    const preferences = await fs.readFile(f.prefPath(product.id), "utf8");
    assert.ok(preferences.includes(`Audio.InputSource = ${JSON.stringify(input.name)}`));
    assert.match(preferences, /Audio.AutoDetect.Enabled = 0/);
    await f.service.stop();
    assert.deepEqual(await fs.readFile(f.prefPath(product.id)), original);
  }
  assert.equal(f.spawned(), 9);
});

test("unrecognized generators and virtual devices cannot become no-mic modes by passing a kind", async t => {
  const f = await fixture(t, { inputs: [CABLE] });
  await assert.rejects(f.service.start({ visualizer: "aeon", inputId: "generator:invented", kind: "no-mic" }), /unavailable/);
  await assert.rejects(f.service.start({ visualizer: "aeon", inputId: CABLE.id, kind: "no-mic" }), /unavailable/);
  assert.equal(f.spawned(), 0);
  assert.deepEqual(await fs.readFile(f.prefPath("aeon")), original);
});

test("only an injected canonical provider enables the verified cable music feed", async t => {
  const cable = { id: CABLE.id, name: "Stereo Out (SoundSpectrum Audio Cable)", interfaceName: "SoundSpectrum Audio Cable" };
  const calls = [];
  const additionalInputProvider = {
    list: async rawInputs => { calls.push(rawInputs); return [{ id: "feed:pre-hqplayer", name: "Player audio before HQPlayer", kind: "music-feed" }]; },
    resolve: async (id, rawInputs) => { calls.push(rawInputs); return id === "feed:pre-hqplayer" && rawInputs.includes(cable) ? { id, name: cable.name, kind: "music-feed" } : null; }
  };
  const f = await fixture(t, { inputs: [MIC, cable], additionalInputProvider });
  const inventory = await f.service.inspect();
  assert.deepEqual(inventory.inputs, [MIC]);
  assert.deepEqual(inventory.musicInputs, [{ id: "feed:pre-hqplayer", name: "Player audio before HQPlayer", kind: "music-feed" }]);
  const started = await f.service.start({ visualizer: "aeon", inputId: "feed:pre-hqplayer", inputName: "Different device", inputKind: "microphone" });
  assert.deepEqual(started.audioInput, { id: "feed:pre-hqplayer", name: cable.name, kind: "music-feed" });
  assert.match(await fs.readFile(f.prefPath("aeon"), "utf8"), /Audio.InputSource = "Stereo Out \(SoundSpectrum Audio Cable\)"/);
  assert.equal(calls.length, 2);
  await f.service.stop();
  assert.deepEqual(await fs.readFile(f.prefPath("aeon")), original);
});

test("an absent or incorrect provider cannot turn an arbitrary virtual device into a music input", async t => {
  const disabled = await fixture(t, { inputs: [CABLE] });
  assert.deepEqual((await disabled.service.inspect()).musicInputs, []);
  await assert.rejects(disabled.service.start({ visualizer: "aeon", inputId: "feed:pre-hqplayer", inputKind: "music-feed", inputName: CABLE.name }), /unavailable/);
  const fake = await fixture(t, { inputs: [CABLE], additionalInputProvider: { list: async () => [], resolve: async id => ({ id, name: CABLE.name, kind: "music-feed" }) } });
  await assert.rejects(fake.service.start({ visualizer: "aeon", inputId: "feed:pre-hqplayer" }), /verified SoundSpectrum music input/);
  assert.equal(disabled.spawned(), 0); assert.equal(fake.spawned(), 0);
});

test("the canonical HQPlayer analysis input drives all three renderers through the same verified cable", async t => {
  const id = "feed:hqplayer-analysis", cable = { ...CABLE, name: "Stereo Out (SoundSpectrum Audio Cable)", interfaceName: "SoundSpectrum Audio Cable" };
  const resolutions = [];
  const f = await fixture(t, { inputs: [MIC, cable], additionalInputProvider: {
    list: async () => [{ id, name: "HQPlayer music analysis", kind: "music-feed" }, { id: "feed:arbitrary", name: "Other cable", kind: "music-feed" }],
    resolve: async (selected, raw) => { resolutions.push(selected); assert.ok(raw.includes(cable)); return { id: selected, name: cable.name, kind: "music-feed" }; }
  } });
  assert.deepEqual((await f.service.inspect()).musicInputs, [{ id, name: "HQPlayer music analysis", kind: "music-feed" }]);
  assert.deepEqual(await f.service.listAudioInputs(), [MIC]);
  for (const product of PRODUCTS) {
    const started = await f.service.start({ visualizer: product.id, inputId: id, inputName: "Default device", inputKind: "microphone" });
    assert.deepEqual(started.audioInput, { id, name: cable.name, kind: "music-feed" });
    const patched = await fs.readFile(f.prefPath(product.id), "utf8");
    assert.match(patched, /Audio.InputSource = "Stereo Out \(SoundSpectrum Audio Cable\)"/); assert.match(patched, /Audio.AutoDetect.Enabled = 0/);
    await f.service.stop(); assert.deepEqual(await fs.readFile(f.prefPath(product.id)), original);
  }
  assert.deepEqual(resolutions, [id, id, id]); assert.equal(f.spawned(), 3);
});

test("HQPlayer analysis cannot bypass canonical provider identity or cable presence", async t => {
  const id = "feed:hqplayer-analysis", cable = { ...CABLE, name: "Stereo Out (SoundSpectrum Audio Cable)", interfaceName: "SoundSpectrum Audio Cable" };
  for (const resolved of [null, { id: "feed:pre-hqplayer", name: cable.name, kind: "music-feed" }, { id, name: MIC.name, kind: "music-feed" }, { id, name: cable.name, kind: "microphone" }]) {
    const f = await fixture(t, { inputs: [MIC, cable], additionalInputProvider: { list: async () => [], resolve: async () => resolved } });
    await assert.rejects(f.service.start({ visualizer: "aeon", inputId: id, inputName: cable.name, inputKind: "music-feed" }), /verified SoundSpectrum music input/);
    assert.equal(f.spawned(), 0); assert.deepEqual(await fs.readFile(f.prefPath("aeon")), original);
  }
  const absent = await fixture(t, { inputs: [MIC], additionalInputProvider: { list: async () => [], resolve: async () => ({ id, name: cable.name, kind: "music-feed" }) } });
  await assert.rejects(absent.service.start({ visualizer: "aeon", inputId: id }), /verified SoundSpectrum music input/);
  assert.equal(absent.spawned(), 0);
});

test("reusing an HQPlayer native renderer rechecks its provider without changing preferences on failure", async t => {
  const id = "feed:hqplayer-analysis", cable = { ...CABLE, name: "Stereo Out (SoundSpectrum Audio Cable)", interfaceName: "SoundSpectrum Audio Cable" };
  let available = true, resolutions = 0;
  const f = await fixture(t, { inputs: [cable], additionalInputProvider: {
    list: async () => [{ id, name: "HQPlayer music analysis", kind: "music-feed" }],
    resolve: async () => { resolutions++; return available ? { id, name: cable.name, kind: "music-feed" } : null; }
  } });
  await f.service.start({ visualizer: "whitecap", inputId: id });
  const patched = await fs.readFile(f.prefPath("whitecap")); available = false;
  await assert.rejects(f.service.start({ visualizer: "whitecap", inputId: id }), /verified SoundSpectrum music input/);
  assert.equal(resolutions, 2); assert.equal(f.spawned(), 1); assert.equal(f.service.status().state, "running");
  assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), patched);
  await f.service.stop(); assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
});
