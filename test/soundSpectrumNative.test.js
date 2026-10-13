"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createSoundSpectrumNative, microphoneInputs, patchStandalonePreferences, PRODUCTS, NO_MIC_INPUTS } = require("../src/soundSpectrumNative");

const MIC = { id: "11111111-2222-3333-4444-555555555555", name: "Microphone (USB Audio Device)" };
const CABLE = { id: "22222222-2222-3333-4444-555555555555", name: "Microphone (VB-Audio Virtual Cable)" };
const original = Buffer.from('Prefs.Version = 8\r\nAudio.InputSource = "Previous source"\r\nAudio.AutoDetect.Enabled = 1\r\nGraphics.TargetFrameRate = 60\r\n');

test("WhiteCap pilot selection is process-local and preserves the exact startup theme and theme file", async t => {
  const f = await fixture(t, { themeInventory: async () => [{ id: "current", available: true }, { id: "nasa-layers", available: true }] });
  const preferences = Buffer.concat([original, Buffer.from('Theme.StartupTheme = "(Custom Theme)"\r\n')]);
  await fs.writeFile(f.prefPath("whitecap"), preferences);
  const themePath = path.join(path.dirname(f.prefPath("whitecap")), "Themes", "(Custom Theme).txt");
  const theme = Buffer.from('ThemeName = "(Custom Theme)"\r\nBackground.CategoryExpr = "+My existing collection"\r\n');
  await fs.mkdir(path.dirname(themePath)); await fs.writeFile(themePath, theme);
  await f.service.start({ visualizer: "whitecap", inputId: MIC.id, whitecapTheme: "nasa-layers" });
  assert.equal(f.child().spawnOptions.env.RABBIT_HOLE_WHITECAP_THEME, "nasa-layers");
  assert.match(await fs.readFile(f.prefPath("whitecap"), "utf8"), /Theme.StartupTheme = "\(Custom Theme\)"\r\n/);
  await f.service.stop(); assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), preferences);
  assert.deepEqual(await fs.readFile(themePath), theme);
  await f.service.start({ visualizer: "whitecap", inputId: MIC.id });
  assert.equal(f.child().spawnOptions.env.RABBIT_HOLE_WHITECAP_THEME, "current");
  assert.equal(f.service.status().whitecapTheme, "current");
});

test("missing or invalid WhiteCap theme fails before preferences or a process can change", async t => {
  const f = await fixture(t, { themeInventory: async () => [{ id: "current", available: true }] });
  for (const [visualizer, whitecapTheme] of [["whitecap", "nasa-layers"], ["aeon", "nasa-layers"], ["whitecap", "../theme"], ["whitecap", null]]) {
    await assert.rejects(f.service.start({ visualizer, inputId: MIC.id, whitecapTheme }), /theme|NASA layer/);
  }
  assert.equal(f.spawned(), 0); assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
});

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
  const helpers = [], diagnostics = [];
  const runWindowCommand = async (action, details = {}) => {
    helpers.push({ action, details });
    if (options.helperOverride) {
      const result = await options.helperOverride(action, details);
      if (result !== undefined) return result;
    }
    if (action === "inspect") return { inputs: options.inputs || [MIC, CABLE], processes: options.existing || (running ? [{ pid: child.pid, executable: child.executable, startTimeTicks: "123456789012345678" }] : []), owner: details.OwnerProcessId ? { pid: process.pid, executable: process.execPath, startTimeTicks: "555555555555555555" } : null, profile: options.missingProfile ? null : { roamingAppDataPath: path.dirname(preferencesRoot), profilePath: path.join(root, "profile") } };
    if (action === "inputs") return { inputs: options.inputs || [MIC, CABLE] };
    if (action === "close") { closes++; if (!options.closeFails) { running = false; if (!options.closeDelaysExit) child.emit("exit", 0); } return { closed: !options.closeFails }; }
    if (!running) return { exited: true };
    if (action === "window" || action === "prepare") return { pid: child.pid, startTimeTicks: "123456789012345678", window: { windowHandle: "98765", windowTitle: "G-Force Standalone", width: 800, height: 450, minimized: false } };
    throw new Error("Unexpected helper action.");
  };
  const service = createSoundSpectrumNative({
    platform: "win32", installRoot, preferencesRoot: options.useDefaultPreferences ? undefined : preferencesRoot, backupRoot, runWindowCommand,
    onDiagnostic: record => { diagnostics.push(record); options.onDiagnostic?.(record); },
    additionalInputProvider: options.additionalInputProvider,
    themeInventory: options.themeInventory,
    spawnImpl: (executable, args, spawnOptions) => {
      spawned++;
      if (options.spawnThrows) throw new Error("Fixture start failure.");
      child = new EventEmitter(); child.pid = 42; child.executable = executable; child.args = args; child.spawnOptions = spawnOptions;
      child.kill = () => { if (!options.killFails) { running = false; child.emit("exit", 1); } };
      running = true;
      return child;
    }
  });
  t.after(async () => {
    await service.stop().catch(() => {});
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "soundspectrum-native-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { service, root, backupRoot, preferencesRoot, helpers, diagnostics, runWindowCommand, installRoot, endChild: (code = 0, signal = null) => { running = false; child?.emit("exit", code, signal); }, child: () => child, spawned: () => spawned, closes: () => closes,
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

test("the optional capture target preserves encoding and unrelated graphics preferences", () => {
  const text = original.toString() + 'Graphics.Quality = "Best"\r\nGraphics.SyncFramesWithRefresh = 1\r\n';
  const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const patched = patchStandalonePreferences(encoded, MIC.name, "whitecap", 120);
  assert.deepEqual(patched.subarray(0, 2), encoded.subarray(0, 2));
  assert.match(patched.subarray(2).toString("utf16le"), /Graphics.TargetFrameRate = 120\r\n/);
  assert.match(patched.subarray(2).toString("utf16le"), /Graphics.Quality = "Best"\r\nGraphics.SyncFramesWithRefresh = 1\r\n/);
  for (const value of [60, 119, 121, "120", null, NaN, Infinity]) {
    assert.throws(() => patchStandalonePreferences(encoded, MIC.name, "whitecap", value), /frame target must be 120/);
  }
});

for (const product of PRODUCTS) {
  test(`${product.name} capture target is temporary and restores exact preferences without touching Global`, async t => {
    const f = await fixture(t), globalPath = path.join(path.dirname(f.prefPath(product.id)), "Global Preferences.txt");
    const global = Buffer.from('Graphics.SyncFramesWithRefresh = 1\r\nGraphics.Quality = "Best"\r\n');
    await fs.writeFile(globalPath, global);
    await f.service.start({ visualizer: product.id, inputId: MIC.id, targetFrameRate: 120 });
    assert.match(await fs.readFile(f.prefPath(product.id), "utf8"), /Graphics.TargetFrameRate = 120\r\n/);
    const manifest = JSON.parse(await fs.readFile(path.join(f.backupRoot, `session-${product.id}.json`), "utf8"));
    assert.deepEqual(await fs.readFile(path.join(f.backupRoot, manifest.backupFile)), original);
    for (const other of PRODUCTS.filter(value => value.id !== product.id)) assert.deepEqual(await fs.readFile(f.prefPath(other.id)), original);
    await f.service.stop();
    assert.deepEqual(await fs.readFile(f.prefPath(product.id)), original);
    assert.deepEqual(await fs.readFile(globalPath), global);
    assert.deepEqual(await fs.readdir(f.backupRoot), []);
    assert.ok(f.helpers.filter(call => call.action === "close").every(call => call.details.ProcessId === 42 && call.details.StartTimeTicks === "123456789012345678"));
  });
}

test("native session reuse includes the target and invalid targets cannot retire an active renderer", async t => {
  const f = await fixture(t), selection = { visualizer: "whitecap", inputId: MIC.id };
  for (const targetFrameRate of [60, 119, 121, "120", null, NaN, Infinity]) {
    await assert.rejects(f.service.start({ ...selection, targetFrameRate }), /frame target must be 120/);
  }
  assert.equal(f.helpers.length, 0); assert.equal(f.spawned(), 0);
  await f.service.start({ ...selection, targetFrameRate: 120 });
  await f.service.start({ ...selection, targetFrameRate: 120 });
  assert.equal(f.spawned(), 1);
  const patched = await fs.readFile(f.prefPath("whitecap")), helperCount = f.helpers.length;
  await assert.rejects(f.service.start({ ...selection, targetFrameRate: "120" }), /frame target must be 120/);
  assert.equal(f.helpers.length, helperCount); assert.equal(f.closes(), 0);
  assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), patched);
  await f.service.start(selection);
  assert.equal(f.spawned(), 2); assert.equal(f.closes(), 1);
  assert.match(await fs.readFile(f.prefPath("whitecap"), "utf8"), /Graphics.TargetFrameRate = 60\r\n/);
  await f.service.start({ ...selection, targetFrameRate: 120 });
  assert.equal(f.spawned(), 3); assert.equal(f.closes(), 2);
  await f.service.stop();
  assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
});

test("capture target spawn failure restores the original Standalone bytes and removes ownership", async t => {
  const f = await fixture(t, { spawnThrows: true });
  await assert.rejects(f.service.start({ visualizer: "whitecap", inputId: MIC.id, targetFrameRate: 120 }), /Fixture start failure/);
  assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
  assert.deepEqual(await fs.readdir(f.backupRoot), []);
  assert.equal(f.service.status().state, "stopped");
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

test("OBS window preparation requests real 1080p and an exact temporary capture title, restoring it before close", async t => {
  let title = "G-Force Standalone", width = 800, height = 450;
  const f = await fixture(t, { helperOverride: (action, details) => {
    if (action === "prepare") { title = details.WindowAlias; width = details.Width; height = details.Height; }
    if (action === "title") { title = details.WindowAlias; return { renamed: true }; }
    if (action === "window" || action === "prepare") return { pid: 42, startTimeTicks: "123456789012345678", window: {
      windowHandle: "98765", windowTitle: title, windowClass: "GForceClass", width, height, minimized: false
    } };
  } });
  await assert.rejects(async () => f.service.captureIdentity(), /unavailable/);
  const selection = { visualizer: "g-force", inputId: MIC.id, width: 1920, height: 1080, uniqueCaptureTitle: true };
  const started = await f.service.start(selection);
  assert.equal(started.width, 1920); assert.equal(started.height, 1080);
  assert.match(started.windowTitle, /^Rabbit Hole G-Force RH-[0-9a-f-]{36}$/);
  const identity = f.service.captureIdentity();
  assert.equal(identity.pid, 42); assert.equal(identity.executable, f.child().executable);
  assert.equal(identity.startTimeTicks, "123456789012345678");
  assert.equal(identity.windowTitle, started.windowTitle); assert.equal(identity.windowClass, "GForceClass");
  assert.ok(Object.isFrozen(identity));
  await f.service.start(selection);
  assert.equal(f.spawned(), 1);
  await f.service.stop();
  const rename = f.helpers.findIndex(call => call.action === "title"), close = f.helpers.findIndex(call => call.action === "close");
  assert.ok(rename >= 0 && rename < close);
  assert.equal(f.helpers[rename].details.WindowAlias, "G-Force Standalone");
  assert.equal(f.helpers[rename].details.StartTimeTicks, "123456789012345678");
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
});

test("unsupported native size and alias options cannot start or touch preferences", async t => {
  const f = await fixture(t);
  for (const extra of [{ width: 3840 }, { height: 2160 }, { width: 319 }, { height: 179 }, { width: "1920" }, { height: 450.5 }, { uniqueCaptureTitle: "true" }]) {
    await assert.rejects(f.service.start({ visualizer: "g-force", inputId: MIC.id, ...extra }), /dimensions/);
  }
  await assert.rejects(f.service.start({ visualizer: "unknown", inputId: MIC.id, uniqueCaptureTitle: true }), /Choose Aeon, G-Force, or WhiteCap/);
  assert.equal(f.spawned(), 0); assert.equal(f.helpers.length, 0);
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
});

test("a refused OBS title or size is cleaned up rather than silently upscaled", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.start({ visualizer: "g-force", inputId: MIC.id, width: 1920, height: 1080, uniqueCaptureTitle: true }), /requested title and resolution/);
  assert.equal(f.closes(), 1); assert.equal(f.service.status().state, "stopped");
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
});

async function fullscreenFixture(t, override = () => undefined, productId = "g-force") {
  const product = PRODUCTS.find(value => value.id === productId), windowClass = product.name.replaceAll("-", "") + "Class";
  let title = `${product.name} Standalone`, width = 800, height = 450, closed = false;
  return fixture(t, { helperOverride: (action, details) => {
    if (action === "inspect") closed = false;
    if (action === "close") closed = true;
    const custom = override(action, details);
    if (custom !== undefined) return custom;
    if (action === "prepare") { title = details.WindowAlias || title; width = details.Width; height = details.Height; }
    if (action === "title") { title = details.WindowAlias; return { renamed: true }; }
    if (!closed && (action === "window" || action === "prepare")) return { pid: 42, startTimeTicks: "123456789012345678", window: {
      windowHandle: "98765", windowTitle: title, windowClass, width, height, minimized: false
    } };
  } });
}
const FULLSCREEN = { visualizer: "g-force", inputId: MIC.id, width: 3840, height: 2160, uniqueCaptureTitle: true, windowMode: "borderless-fullscreen" };

test("borderless fullscreen prepares only the exact owned G-Force window at 4K and restores original preferences", async t => {
  const f = await fullscreenFixture(t); const started = await f.service.start(FULLSCREEN);
  assert.equal(started.windowMode, "borderless-fullscreen"); assert.equal(started.width, 3840); assert.equal(started.height, 2160);
  assert.equal(started.windowHandle, "98765"); assert.equal(started.windowClass, "GForceClass");
  const prepare = f.helpers.find(call => call.action === "prepare");
  assert.equal(prepare.details.ExpectedWindowHandle, "98765"); assert.equal(prepare.details.WindowMode, "borderless-fullscreen");
  assert.equal(prepare.details.ExpectedWindowClass, "GForceClass"); assert.equal(prepare.details.ExpectedWindowTitle, "G-Force Standalone");
  assert.equal(prepare.details.ProcessId, 42); assert.equal(prepare.details.StartTimeTicks, "123456789012345678");
  assert.equal(prepare.details.ExpectedExecutable, f.child().executable); assert.equal(prepare.details.WindowAlias, started.windowTitle);
  await f.service.start(FULLSCREEN); assert.equal(f.spawned(), 1);
  await f.service.stop(); assert.equal(f.closes(), 1); assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
});

for (const product of PRODUCTS.filter(value => value.id !== "g-force")) {
  test(`${product.name} prepares its exact owned 4K window and restores only its own preferences and title`, async t => {
    const f = await fullscreenFixture(t, undefined, product.id);
    const selection = { ...FULLSCREEN, visualizer: product.id };
    const started = await f.service.start(selection), expectedClass = product.name + "Class";
    assert.equal(started.visualizer, product.id); assert.equal(started.windowMode, "borderless-fullscreen");
    assert.equal(started.width, 3840); assert.equal(started.height, 2160); assert.equal(started.windowClass, expectedClass);
    assert.match(started.windowTitle, new RegExp(`^Rabbit Hole ${product.name} RH-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
    const prepare = f.helpers.find(call => call.action === "prepare");
    assert.deepEqual(prepare.details, {
      ProcessId: 42, ExpectedExecutable: path.join(f.installRoot, product.folder, product.executable),
      StartTimeTicks: "123456789012345678", Width: 3840, Height: 2160, WindowAlias: started.windowTitle,
      WindowMode: "borderless-fullscreen", ExpectedWindowHandle: "98765", ExpectedWindowClass: expectedClass,
      ExpectedWindowTitle: `${product.name} Standalone`
    });
    const identity = f.service.captureIdentity();
    assert.ok(Object.isFrozen(identity)); assert.equal(identity.executable, prepare.details.ExpectedExecutable);
    assert.equal(identity.windowHandle, "98765"); assert.equal(identity.windowClass, expectedClass); assert.equal(identity.windowTitle, started.windowTitle);
    assert.equal(identity.startTimeTicks, prepare.details.StartTimeTicks);
    for (const other of PRODUCTS.filter(value => value.id !== product.id)) assert.deepEqual(await fs.readFile(f.prefPath(other.id)), original);
    await f.service.start(selection); assert.equal(f.spawned(), 1);
    await f.service.stop(); assert.equal(f.closes(), 1);
    const renamed = f.helpers.findIndex(call => call.action === "title"), closed = f.helpers.findIndex(call => call.action === "close");
    assert.ok(renamed >= 0 && renamed < closed); assert.equal(f.helpers[renamed].details.WindowAlias, `${product.name} Standalone`);
    for (const existing of PRODUCTS) assert.deepEqual(await fs.readFile(f.prefPath(existing.id)), original);
    assert.deepEqual(await fs.readdir(f.backupRoot), []);
  });

  test(`${product.name} also supports its unique owned windowed 1080p alias without raising ordinary size limits`, async t => {
    const f = await fullscreenFixture(t, undefined, product.id);
    const selection = { ...FULLSCREEN, visualizer: product.id, width: 1920, height: 1080, windowMode: "windowed" };
    const started = await f.service.start(selection);
    assert.equal(started.width, 1920); assert.equal(started.height, 1080);
    assert.ok(started.windowTitle.startsWith(`Rabbit Hole ${product.name} RH-`));
    const before = f.helpers.length, patched = await fs.readFile(f.prefPath(product.id));
    await assert.rejects(f.service.start({ ...selection, width: 3840, height: 2160 }), /dimensions/);
    assert.equal(f.helpers.length, before); assert.equal(f.spawned(), 1); assert.equal(f.closes(), 0);
    assert.equal(f.service.status().state, "running"); assert.deepEqual(await fs.readFile(f.prefPath(product.id)), patched);
    await f.service.stop(); assert.deepEqual(await fs.readFile(f.prefPath(product.id)), original);
  });

  test(`${product.name} rejects prepared identity, alias and resolution mismatches before becoming ready`, async t => {
    for (const changed of [{ pid: 43 }, { startTimeTicks: "987654321098765432" }, { windowHandle: "98766" }, { windowClass: "ForeignClass" },
      { windowTitle: "Rabbit Hole G-Force RH-01234567-89ab-cdef-0123-456789abcdef" }, { width: 1920 }, { height: 1080 }]) {
      const f = await fullscreenFixture(t, (action, details) => action === "prepare" ? {
        pid: changed.pid || 42, startTimeTicks: changed.startTimeTicks || "123456789012345678", window: {
          windowHandle: changed.windowHandle || "98765", windowClass: changed.windowClass || product.name + "Class",
          windowTitle: changed.windowTitle || details.WindowAlias, width: changed.width || 3840, height: changed.height || 2160, minimized: false
        }
      } : undefined, product.id);
      await assert.rejects(f.service.start({ ...FULLSCREEN, visualizer: product.id }), /changed during fullscreen|requested title and resolution/);
      assert.equal(f.closes(), 1); assert.equal(f.service.status().state, "stopped");
      for (const existing of PRODUCTS) assert.deepEqual(await fs.readFile(f.prefPath(existing.id)), original);
      assert.deepEqual(await fs.readdir(f.backupRoot), []);
    }
  });

  test(`${product.name} refuses invalid initial window identity without preparing any window`, async t => {
    for (const changed of [{ pid: 43 }, { windowHandle: "0" }, { windowHandle: "18446744073709551616" }, { windowClass: "" },
      { windowTitle: "" }, { windowTitle: "invalid\nwindow" }, { windowClass: "invalid\0class" }]) {
      let initial = true;
      const f = await fullscreenFixture(t, action => {
        if (action !== "window" || !initial) return;
        initial = false;
        return { pid: changed.pid || 42, startTimeTicks: "123456789012345678", window: {
          windowHandle: "98765", windowClass: product.name + "Class", windowTitle: `${product.name} Standalone`, width: 800, height: 450,
          minimized: false, ...Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "pid"))
        } };
      }, product.id);
      await assert.rejects(f.service.start({ ...FULLSCREEN, visualizer: product.id }), /exact owned/);
      assert.equal(f.helpers.some(call => call.action === "prepare"), false); assert.equal(f.closes(), 1);
      for (const existing of PRODUCTS) assert.deepEqual(await fs.readFile(f.prefPath(existing.id)), original);
      assert.deepEqual(await fs.readdir(f.backupRoot), []);
    }
  });
}

test("unknown product selections leave a current owned G-Force session and all preference files intact", async t => {
  const f = await fullscreenFixture(t); const started = await f.service.start(FULLSCREEN);
  const before = f.helpers.length, currentPreferences = await fs.readFile(f.prefPath("g-force"));
  for (const visualizer of ["unknown", "Aeon", "WhiteCap", "../whitecap", "g-force.exe", null, { id: "aeon" }]) {
    await assert.rejects(f.service.start({ ...FULLSCREEN, visualizer }), /Choose Aeon, G-Force, or WhiteCap/);
    assert.equal(f.helpers.length, before); assert.equal(f.spawned(), 1); assert.equal(f.closes(), 0);
    assert.equal(f.service.status().windowTitle, started.windowTitle); assert.equal(f.service.status().state, "running");
    assert.deepEqual(await fs.readFile(f.prefPath("g-force")), currentPreferences);
    for (const other of PRODUCTS.filter(value => value.id !== "g-force")) assert.deepEqual(await fs.readFile(f.prefPath(other.id)), original);
  }
});

test("PowerShell capture alias validation binds each product UUID to its exact executable without native calls", { skip: process.platform !== "win32" }, async () => {
  const source = await fs.readFile(path.join(__dirname, "../scripts/soundspectrum-window.ps1"), "utf8");
  const validation = source.match(/function Get-CaptureAliasProduct \{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(validation); assert.doesNotMatch(validation, /Get-Process|Add-Type|SoundSpectrumWindow\]::|Start-Process|Stop-Process/);
  // Only extract and evaluate this pure string-validation function. Never run
  // or dot-source the native helper, its Add-Type block or process inspection.
  const script = `${validation}
    $ErrorActionPreference = 'Stop'
    $taskUuid = '01234567-89ab-cdef-0123-456789abcdef'
    $taskAccepted = 0; $taskRejected = 0
    foreach ($taskProduct in @('Aeon','G-Force','WhiteCap')) {
      foreach ($taskSuffix in @(' Standalone.exe',' Standalone.x64.exe')) {
        $taskAlias = 'Rabbit Hole ' + $taskProduct + ' RH-' + $taskUuid
        $taskExecutable = 'C:\\fixtures\\' + $taskProduct + $taskSuffix
        if ((Get-CaptureAliasProduct $taskAlias $taskExecutable '123456789012345678') -cne $taskProduct) { throw 'Product identity changed.' }
        $taskAccepted++
      }
    }
    $taskCases = @(
      @('Rabbit Hole Aeon RH-' + $taskUuid, 'C:\\fixtures\\WhiteCap Standalone.x64.exe', '123456789012345678'),
      @('Rabbit Hole WhiteCap RH-' + $taskUuid, 'C:\\fixtures\\G-Force Standalone.x64.exe', '123456789012345678'),
      @('Rabbit Hole G-Force RH-' + $taskUuid, 'C:\\fixtures\\Aeon Standalone.x64.exe', '123456789012345678'),
      @('Rabbit Hole Other RH-' + $taskUuid, 'C:\\fixtures\\Other Standalone.x64.exe', '123456789012345678'),
      @('Rabbit Hole aeon RH-' + $taskUuid, 'C:\\fixtures\\Aeon Standalone.x64.exe', '123456789012345678'),
      @('Rabbit Hole Aeon RH-' + ('-' * 36), 'C:\\fixtures\\Aeon Standalone.x64.exe', '123456789012345678'),
      @('Rabbit Hole Aeon RH-' + $taskUuid + [char]10, 'C:\\fixtures\\Aeon Standalone.x64.exe', '123456789012345678'),
      @('Rabbit Hole Aeon RH-' + $taskUuid, 'C:\\fixtures\\Aeon Toolbar.exe', '123456789012345678'),
      @('Rabbit Hole Aeon RH-' + $taskUuid, 'C:\\fixtures\\Aeon Standalone.x64.exe', ''),
      @('Rabbit Hole Aeon RH-' + $taskUuid, 'C:\\fixtures\\Aeon Standalone.x64.exe', '123456789012345678' + [char]10)
    )
    foreach ($taskCase in $taskCases) {
      $taskFailed = $false
      try { $null = Get-CaptureAliasProduct $taskCase[0] $taskCase[1] $taskCase[2] } catch { $taskFailed = $true }
      if (-not $taskFailed) { throw 'Invalid identity was accepted.' }
      $taskRejected++
    }
    @{accepted=$taskAccepted;rejected=$taskRejected} | ConvertTo-Json -Compress
  `;
  const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim());
  assert.deepEqual(result, { accepted: 6, rejected: 10 });
  assert.ok(source.indexOf("before.windowClass,expectedClass") < source.indexOf("SetStyle(hwnd,-16,style &"));
  assert.ok(source.indexOf("before.windowTitle,expectedTitle") < source.indexOf("SetStyle(hwnd,-16,style &"));
});

test("window mode participates in native reuse even when client dimensions and source match", async t => {
  const f = await fullscreenFixture(t);
  const selection = { ...FULLSCREEN, width: 1920, height: 1080 };
  await f.service.start({ ...selection, windowMode: "windowed" }); await f.service.start(selection);
  assert.equal(f.spawned(), 2); assert.equal(f.closes(), 1); assert.equal(f.service.status().windowMode, "borderless-fullscreen");
  assert.deepEqual(f.helpers.filter(call => call.action === "prepare").map(call => call.details.WindowMode || "windowed"), ["windowed", "borderless-fullscreen"]);
});

test("fullscreen mode rejects unknown modes, unowned aliases, unknown products and sizes above 4K before mutation", async t => {
  const f = await fixture(t);
  for (const extra of [{ windowMode: "exclusive" }, { uniqueCaptureTitle: false }, { uniqueCaptureTitle: "true" }, { visualizer: "other-product" },
    { visualizer: "Aeon" }, { width: 3841 }, { height: 2161 }, { width: "3840" }, { windowMode: "windowed" }]) {
    await assert.rejects(f.service.start({ ...FULLSCREEN, ...extra }), /window mode|capture identity|dimensions|Choose Aeon, G-Force, or WhiteCap/);
  }
  assert.equal(f.spawned(), 0); assert.equal(f.helpers.length, 0); assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
});

test("fullscreen fails closed if preparation changes the owned PID, start identity, HWND or class", async t => {
  for (const changed of [{ pid: 43 }, { startTimeTicks: "987654321098765432" }, { windowHandle: "98766" }, { windowClass: "ForeignClass" }]) {
    const f = await fullscreenFixture(t, (action, details) => action === "prepare" ? {
      pid: changed.pid || 42, startTimeTicks: changed.startTimeTicks || "123456789012345678", window: {
        windowHandle: changed.windowHandle || "98765", windowClass: changed.windowClass || "GForceClass", windowTitle: details.WindowAlias,
        width: 3840, height: 2160, minimized: false
      }
    } : undefined);
    await assert.rejects(f.service.start(FULLSCREEN), /changed during fullscreen/); assert.equal(f.closes(), 1);
    assert.equal(f.service.status().state, "stopped"); assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
  }
});

test("a monitor resolution mismatch stops only the newly owned renderer and restores preferences", async t => {
  const f = await fullscreenFixture(t, action => { if (action === "prepare") throw Error("The current monitor resolution does not match the requested visualizer resolution."); });
  await assert.rejects(f.service.start(FULLSCREEN), /monitor resolution/); assert.equal(f.spawned(), 1); assert.equal(f.closes(), 1);
  assert.equal(f.service.status().state, "stopped"); assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
  assert.deepEqual(await fs.readdir(f.backupRoot), []);
});

test("capture reconnect validates the exact owned process and observes its fresh window without mutation", async t => {
  let freshWindow = false;
  const window = { windowHandle: "112233", windowTitle: "G-Force Standalone", width: 3840, height: 2160, minimized: false };
  const f = await fixture(t, { helperOverride: action => freshWindow && action === "window" ? {
    pid: 42, startTimeTicks: "123456789012345678", window
  } : undefined });
  await f.service.start({ visualizer: "g-force", inputId: MIC.id });
  const preferences = await fs.readFile(f.prefPath("g-force"));
  const manifest = await fs.readFile(path.join(f.backupRoot, "session-g-force.json"));
  const before = f.helpers.length;
  freshWindow = true;
  const current = await f.service.captureWindow();
  assert.equal(current.pid, 42); assert.equal(current.windowHandle, window.windowHandle);
  assert.equal(current.width, 3840); assert.equal(current.height, 2160); assert.equal(current.state, "running");
  assert.deepEqual(f.helpers.slice(before), [{ action: "window", details: {
    ProcessId: 42, ExpectedExecutable: f.child().executable, StartTimeTicks: "123456789012345678"
  } }]);
  assert.equal(f.spawned(), 1); assert.equal(f.closes(), 0);
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), preferences);
  assert.deepEqual(await fs.readFile(path.join(f.backupRoot, "session-g-force.json")), manifest);
  freshWindow = false;
});

test("capture reconnect refuses stopped, departed, changed and unavailable renderers without preparing a window", async t => {
  let result;
  const f = await fixture(t, { helperOverride: action => action === "window" ? result : undefined });
  await assert.rejects(f.service.captureWindow(), /owned SoundSpectrum renderer is unavailable/);
  assert.equal(f.helpers.length, 0); assert.equal(f.spawned(), 0);
  await f.service.start({ visualizer: "g-force", inputId: MIC.id });
  const before = f.helpers.length;
  const valid = { pid: 42, startTimeTicks: "123456789012345678", window: {
    windowHandle: "98765", windowTitle: "G-Force Standalone", width: 800, height: 450, minimized: false
  } };
  for (const unavailable of [
    { exited: true }, { ...valid, pid: 43 }, { ...valid, startTimeTicks: "999999999999999999" },
    { ...valid, window: null }, { ...valid, window: { ...valid.window, minimized: true } },
    { ...valid, window: { ...valid.window, windowHandle: "0" } },
    { ...valid, window: { ...valid.window, windowHandle: "other-window" } },
    { ...valid, window: { ...valid.window, windowHandle: "18446744073709551616" } },
    { ...valid, window: { ...valid.window, width: 0 } }
  ]) {
    result = unavailable;
    await assert.rejects(f.service.captureWindow(), /unavailable|no longer available/);
    assert.equal(f.service.status().windowHandle, "98765");
  }
  assert.ok(f.helpers.slice(before).every(call => call.action === "window"));
  assert.equal(f.spawned(), 1); assert.equal(f.closes(), 0);
  result = undefined;
});

test("an in-flight capture validation cannot accept a window after its renderer exits or is replaced", async t => {
  for (const change of ["exit", "replacement"]) {
    let releaseWindow, enteredWindow;
    const pending = new Promise(resolve => { releaseWindow = resolve; });
    const entered = new Promise(resolve => { enteredWindow = resolve; });
    let hold = false;
    const f = await fixture(t, { helperOverride: action => {
      if (hold && action === "window") { hold = false; enteredWindow(); return pending; }
    } });
    await f.service.start({ visualizer: "g-force", inputId: MIC.id });
    hold = true;
    const validating = f.service.captureWindow();
    await entered;
    if (change === "exit") f.endChild(3221225477);
    else {
      await f.service.stop();
      await f.service.start({ visualizer: "whitecap", inputId: MIC.id });
    }
    releaseWindow({ pid: 42, startTimeTicks: "123456789012345678", window: {
      windowHandle: "retired-window", windowTitle: "G-Force Standalone", width: 800, height: 450, minimized: false
    } });
    await assert.rejects(validating, /renderer changed/);
    if (change === "replacement") assert.equal(f.service.status().visualizer, "whitecap");
    await f.service.stop();
  }
});

test("capture validation fails once Stop is requested even while the exact renderer is still alive", async t => {
  let releaseWindow, enteredWindow, releaseClose, enteredClose;
  const pendingWindow = new Promise(resolve => { releaseWindow = resolve; });
  const pendingClose = new Promise(resolve => { releaseClose = resolve; });
  const windowEntered = new Promise(resolve => { enteredWindow = resolve; });
  const closeEntered = new Promise(resolve => { enteredClose = resolve; });
  let holdWindow = false, holdClose = false;
  const f = await fixture(t, { helperOverride: async action => {
    if (holdWindow && action === "window") { holdWindow = false; enteredWindow(); return pendingWindow; }
    if (holdClose && action === "close") { holdClose = false; enteredClose(); await pendingClose; }
  } });
  await f.service.start({ visualizer: "g-force", inputId: MIC.id });
  holdWindow = true;
  const validating = f.service.captureWindow();
  await windowEntered;
  holdClose = true;
  const stopping = f.service.stop();
  await closeEntered;
  releaseWindow({ pid: 42, startTimeTicks: "123456789012345678", window: {
    windowHandle: "112233", windowTitle: "G-Force Standalone", width: 1920, height: 1080, minimized: false
  } });
  await assert.rejects(validating, /renderer changed/);
  const before = f.helpers.length;
  await assert.rejects(f.service.captureWindow(), /renderer is unavailable/);
  assert.equal(f.helpers.length, before);
  releaseClose(); await stopping;
});

test("spontaneous native exits retain a safe private diagnostic through restoration even if its observer throws", async t => {
  const f = await fixture(t, { onDiagnostic: () => { throw new Error("Diagnostic observer failed"); } });
  await f.service.start({ visualizer: "g-force", inputId: MIC.id });
  f.endChild(3221225477, null);
  await f.service.stop();
  assert.equal(f.diagnostics.length, 1);
  const record = f.diagnostics[0];
  assert.deepEqual(Object.keys(record).sort(), ["at", "code", "event", "pid", "signal", "stopRequested", "visualizer"]);
  assert.equal(record.event, "native-exit"); assert.equal(record.pid, 42); assert.equal(record.visualizer, "g-force");
  assert.equal(record.code, 3221225477); assert.equal(record.signal, null); assert.equal(record.stopRequested, false);
  assert.ok(Number.isFinite(Date.parse(record.at)));
  assert.equal(f.service.status().state, "stopped");
  assert.equal(Object.hasOwn(f.service.status(), "lastNativeExit"), false);
  assert.deepEqual(await fs.readFile(f.prefPath("g-force")), original);
});

test("intentional native Stop is distinguished from a spontaneous exit", async t => {
  const f = await fixture(t);
  await f.service.start({ visualizer: "g-force", inputId: MIC.id });
  await f.service.stop();
  assert.equal(f.diagnostics.length, 1); assert.equal(f.diagnostics[0].stopRequested, true);
  assert.equal(f.diagnostics[0].code, 0); assert.equal(f.diagnostics[0].signal, null);
});

test("a retired native child exit cannot replace the active renderer diagnostic", async t => {
  const f = await fixture(t, { closeDelaysExit: true });
  await f.service.start({ visualizer: "g-force", inputId: MIC.id });
  const retired = f.child();
  await f.service.stop();
  await f.service.start({ visualizer: "whitecap", inputId: MIC.id });
  retired.emit("exit", 3221225477, "SIGABRT");
  assert.equal(f.diagnostics.length, 0); assert.equal(f.service.status().visualizer, "whitecap");
  f.endChild(null, "SIGTERM");
  await f.service.stop();
  assert.equal(f.diagnostics.length, 1); assert.equal(f.diagnostics[0].visualizer, "whitecap");
  assert.equal(f.diagnostics[0].code, null); assert.equal(f.diagnostics[0].signal, "SIGTERM");
  assert.equal(f.diagnostics[0].stopRequested, false);
  assert.deepEqual(await fs.readFile(f.prefPath("whitecap")), original);
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
