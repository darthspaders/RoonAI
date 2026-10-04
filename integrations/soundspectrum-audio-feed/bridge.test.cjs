"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dgram = require("node:dgram");
const { spawn, spawnSync } = require("node:child_process");
const installer = require("./install-bridge.cjs");

// Optional integration tests need reviewed third-party sources supplied locally.
// They never read or change an installed plugin unless its fixture is explicitly selected.
const livePlugin = process.env.RH_HQPLAYER_BRIDGE_TEST_PLUGIN_ROOT || "";
const fixtureAppRoot = process.env.RH_HQPLAYER_BRIDGE_TEST_APP_ROOT || "";
const perl = process.env.RH_HQPLAYER_BRIDGE_TEST_PERL || (process.platform === "win32" ? "C:/Program Files/Lyrion/Perl/perl/bin/perl.exe" : "perl");
const available = !!livePlugin && (process.platform !== "win32" || fs.existsSync(perl)) && fs.existsSync(path.join(livePlugin, "Player.pm"));
const sha = installer.sha;
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-audio-feed-fixture-"));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function originals() {
  const locations = installer.resolvePaths({ pluginRoot: livePlugin, ...(fixtureAppRoot ? { appRoot: fixtureAppRoot } : {}) });
  const manifest = fs.existsSync(locations.manifestPath) ? JSON.parse(fs.readFileSync(locations.manifestPath)) : null;
  return Object.fromEntries(Object.keys(installer.EXPECTED).map(name => {
    let bytes = fs.readFileSync(path.join(livePlugin, name));
    if (sha(bytes) !== installer.EXPECTED[name]) {
      const record = manifest?.files?.find(record => record.name === name);
      assert.ok(record && manifest.installed && manifest.pluginRoot === locations.pluginRoot, `Reviewed ${name} fixture unavailable.`);
      // Use only verified original backups; never alter or remove live hooks.
      bytes = fs.readFileSync(record.backupPath);
      assert.equal(sha(bytes), installer.EXPECTED[name]);
    }
    return [name, bytes];
  }));
}
function patched() { return installer.patchSources(originals()); }
function setupHarness(t, { helper = true, port = 12345, demand = {} } = {}) {
  const root = temporary(t);
  const result = patched();
  const player = result.sources["Player.pm"].toString("utf8");
  const load = result.patches.find(patch => patch.label === "load").inserted;
  const next = player.match(/sub nextChunk \{[\s\S]*?\n\}/)[0];
  const close = player.match(/sub closeStream \{[\s\S]*?\n\}/)[0];
  const snippet = `package Plugins::HQPlayerBridge::Player;\nuse strict;\nuse warnings;\nmy $log;\n${close}\n${load}\n${next}\n1;`;
  const snippetPath = path.join(root, "snippet.pl");
  fs.writeFileSync(snippetPath, snippet);
  fs.copyFileSync(path.join(__dirname, "lyrion", "bridge-harness.pl"), path.join(root, "harness.pl"));
  const demandPath = path.join(root, "demand.json");
  fs.writeFileSync(demandPath, JSON.stringify({ version: 1, port, token: "a".repeat(64), playerId: "aa:bb:cc:dd:ee:ff", expiresAt: Date.now() + 20000, ...demand }));
  if (helper) {
    fs.copyFileSync(path.join(__dirname, "lyrion", "AudioTap.pm"), path.join(root, installer.MODULE_NAME));
    fs.writeFileSync(path.join(root, installer.CONFIG_NAME), JSON.stringify({ version: 1, demandFile: demandPath }));
  }
  return { root, snippetPath, demandPath };
}
function runHarness(fixture, mode, audioPath = "") {
  const result = spawnSync(perl, [path.join(fixture.root, "harness.pl"), mode, fixture.snippetPath, audioPath, fixture.demandPath], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, PERL_BADLANG: "0", LC_ALL: "C", LANG: "C" }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("bridge install plan is read-only, exact version/source checked, and blocks remove byte-for-byte", { skip: !available }, t => {
  const before = originals();
  const liveBefore = Object.fromEntries(["Player.pm", "Stream.pm"].map(name => [name, sha(fs.readFileSync(path.join(livePlugin, name)))]));
  const result = patched();
  for (const name of ["Player.pm", "Stream.pm"]) {
    assert.deepEqual(installer.removeBlocks(result.sources[name], result.patches.filter(patch => patch.name === name)), before[name]);
    assert.equal(sha(fs.readFileSync(path.join(livePlugin, name))), liveBefore[name]);
  }
  const changed = { ...before, "Player.pm": Buffer.concat([before["Player.pm"], Buffer.from("\n# unknown edit")]) };
  assert.throws(() => installer.patchSources(changed), /unreviewed source/);
  const privateRoot = temporary(t);
  const fixturePlugin = path.join(privateRoot, "plugin");
  fs.mkdirSync(fixturePlugin);
  for (const [name, bytes] of Object.entries(before)) fs.writeFileSync(path.join(fixturePlugin, name), bytes);
  const plan = installer.plan({ appRoot: privateRoot, pluginRoot: fixturePlugin });
  assert.equal(plan.installed, false);
  assert.equal(fs.existsSync(path.join(privateRoot, "data")), false);
});

test("bridge uninstall preserves unrelated later source edits and rejects changed owned blocks", { skip: !available }, t => {
  const root = temporary(t);
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(pluginRoot);
  for (const [name, bytes] of Object.entries(originals())) fs.writeFileSync(path.join(pluginRoot, name), bytes);
  const options = { appRoot: root, pluginRoot };
  const installed = installer.install(options);
  assert.equal(installed.installed, true);
  const manifest = JSON.parse(fs.readFileSync(installed.manifestPath));
  assert.equal(manifest.pluginVersion, "1.0.40");
  for (const record of manifest.files) assert.equal(sha(fs.readFileSync(record.backupPath)), record.beforeSha256);
  fs.appendFileSync(path.join(pluginRoot, "Player.pm"), "\r\n# unrelated later change\r\n");
  installer.uninstall(options);
  assert.deepEqual(fs.readFileSync(path.join(pluginRoot, "Player.pm")), Buffer.concat([originals()["Player.pm"], Buffer.from("\r\n# unrelated later change\r\n")]));
  assert.deepEqual(fs.readFileSync(path.join(pluginRoot, "Stream.pm")), originals()["Stream.pm"]);
  assert.equal(fs.existsSync(path.join(pluginRoot, installer.MODULE_NAME)), false);
  assert.equal(JSON.parse(fs.readFileSync(installed.manifestPath)).installed, false);
  const result = patched();
  const altered = Buffer.from(result.sources["Player.pm"].toString("utf8").replace("copy_chunk($self, $ref)", "copy_chunk($self, undef)"));
  assert.throws(() => installer.removeBlocks(altered, result.patches.filter(patch => patch.name === "Player.pm")), /patch changed/);
});

for (const mode of ["absent", "normal", "throw", "udp-fail", "broken-load"]) {
  test(`primary chunk remains identical when optional helper is ${mode}`, { skip: !available }, t => {
    const fixture = setupHarness(t, { helper: mode !== "absent" });
    if (mode === "broken-load") fs.writeFileSync(path.join(fixture.root, installer.MODULE_NAME), "die 'offline load failure';\n");
    let audioPath = "";
    if (mode === "udp-fail") {
      audioPath = path.join(fixture.root, "fixture.flac");
      fs.writeFileSync(audioPath, Buffer.from("fLaC" + "x".repeat(1000)));
    }
    const result = runHarness(fixture, mode, audioPath);
    assert.equal(result.sameRef, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.calls, 2);
    assert.equal(result.closed, 1);
    assert.equal(result.loaded, !["absent", "broken-load"].includes(mode));
  });
}

test("Perl demand rejects expired, oversized, forged and out-of-range receiver configuration", { skip: !available }, t => {
  for (const demand of [
    { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 60000 }, { version: 2 },
    { token: "wrong" }, { token: { injected: true } }, { playerId: "arbitrary-player" },
    { port: 0 }, { port: 65536 }, { port: "localhost:12345" }
  ]) {
    const fixture = setupHarness(t, { demand });
    const result = runHarness(fixture, "normal");
    assert.equal(result.status.demand, 0);
    assert.equal(result.sameRef, true);
  }
  const fixture = setupHarness(t);
  fs.writeFileSync(fixture.demandPath, "x".repeat(4097));
  assert.equal(runHarness(fixture, "normal").status.demand, 0);
});

test("only the explicitly demanded LMS player can send side-copy packets", { skip: !available }, async t => {
  const socket = dgram.createSocket("udp4");
  t.after(() => socket.close());
  await new Promise(resolve => socket.bind(0, "127.0.0.1", resolve));
  const fixture = setupHarness(t, { port: socket.address().port, demand: { playerId: "11:22:33:44:55:66" } });
  const audioPath = path.join(fixture.root, "fixture.flac");
  fs.writeFileSync(audioPath, Buffer.from("fLaC" + "x".repeat(1000)));
  let packets = 0;
  socket.on("message", () => { packets++; });
  const result = runHarness(fixture, "udp", audioPath);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(packets, 0);
  assert.equal(result.status.demand, 1);
  assert.equal(result.sameRef, true);
  assert.equal(result.unchanged, true);
});

async function collectFixture(t, mode) {
  const socket = dgram.createSocket("udp4");
  t.after(() => socket.close());
  await new Promise(resolve => socket.bind(0, "127.0.0.1", resolve));
  socket.setRecvBufferSize(2 * 1024 * 1024);
  const fixture = setupHarness(t, { port: socket.address().port });
  const audioPath = path.join(fixture.root, "fixture.flac");
  const encoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=713:sample_rate=44100:duration=8", "-ac", "2", "-c:a", "flac", "-y", audioPath], { timeout: 15000 });
  assert.equal(encoded.status, 0, String(encoded.stderr));
  const packets = [];
  socket.on("message", (bytes, remote) => {
    assert.equal(remote.address, "127.0.0.1");
    const at = bytes.indexOf(10);
    assert.ok(at > 0 && at <= 1024);
    packets.push({ header: JSON.parse(bytes.subarray(0, at)), payload: bytes.subarray(at + 1) });
  });
  const child = spawn(perl, [path.join(fixture.root, "harness.pl"), mode, fixture.snippetPath, audioPath, fixture.demandPath], {
    env: { ...process.env, PERL_BADLANG: "0", LC_ALL: "C", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "", error = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { error += bytes; });
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(exit, 0, error);
  await new Promise(resolve => setTimeout(resolve, 100));
  const result = JSON.parse(output);
  assert.equal(result.sameRef, true);
  assert.equal(result.unchanged, true);
  assert.ok(packets.length >= 3);
  assert.equal(packets[0].header.type, "begin");
  assert.equal(packets.at(-1).header.type, "end");
  packets.forEach((packet, sequence) => {
    assert.equal(packet.header.sequence, sequence);
    assert.equal(packet.header.generation, packets[0].header.generation);
    assert.equal(packet.header.token, "a".repeat(64));
    assert.equal(packet.header.playerId, "aa:bb:cc:dd:ee:ff");
    assert.equal(packet.header.format, "flac");
    assert.ok(packet.payload.length <= 32768);
  });
  return { fixture, audioPath, packets, result };
}

test("UDP side copy matches every FLAC byte without a second playback read", { skip: !available }, async t => {
  const { audioPath, packets } = await collectFixture(t, "udp");
  assert.equal(packets[0].payload.length, 0);
  assert.deepEqual(Buffer.concat(packets.filter(packet => packet.header.type === "data").map(packet => packet.payload)), fs.readFileSync(audioPath));
});

test("late demand gets valid streaming FLAC header and decoded PCM after frame resynchronization", { skip: !available }, async t => {
  const { packets, result } = await collectFixture(t, "midstream");
  assert.equal(packets[0].payload.length, 42);
  assert.equal(packets[0].payload.subarray(0, 4).toString(), "fLaC");
  const tail = Buffer.concat(packets.filter(packet => packet.header.type === "data").map(packet => packet.payload));
  assert.equal(tail.length, result.fixtureBytes - result.joinOffset);
  const decoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "flac", "-i", "pipe:0", "-f", "s16le", "pipe:1"], {
    input: Buffer.concat([packets[0].payload, tail]), timeout: 10000, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(decoded.status, 0, String(decoded.stderr));
  assert.ok(decoded.stdout.length > 44100 * 2 * 2);
  assert.ok(decoded.stdout.some(byte => byte !== 0));
});
