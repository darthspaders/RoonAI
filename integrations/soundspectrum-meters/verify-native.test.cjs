"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { patchTheme, patchQaPreferences, qaWindow, category, assertClosed, NAMES, CAPTURE } = require("./verify-native.cjs");
const { buildCaptureCommand } = require("../../scripts/soundspectrum-capture.cjs");

test("native QA patches exactly one theme and preserves unrelated preferences", () => {
  const original = Buffer.from('Audio.InputSourceName = "unchanged"\r\nTheme.StartupTheme = "Rabbit Hole - darthspader"\r\nParticle.Slideshow.EnableOnStartup = 1\r\n');
  const next = patchTheme(original, "QA one").toString();
  assert.equal(next, original.toString().replace('"Rabbit Hole - darthspader"', '"QA one"'));
  assert.throws(() => patchTheme(Buffer.from("none"), "QA"), /exactly one/);
  assert.throws(() => patchTheme(Buffer.from('Theme.StartupTheme = "a"\nTheme.StartupTheme = "b"'), "QA"), /exactly one/);
});

test("native QA refuses empty, malformed and active process inventories", async () => {
  await assertClosed(async () => ({ stdout: "0\r\n" }));
  for (const stdout of ["", " ", "N/A", "00", "1", "2"]) {
    await assert.rejects(assertClosed(async () => ({ stdout })), /Close G-Force/);
  }
});

test("native QA uses explicit exact preset membership", () => {
  for (const name of NAMES) {
    const text = category("QA one", name);
    assert.match(text, /Include.Pattern = ""/);
    assert.match(text, /Exclude.Pattern = ""/);
    assert.ok(text.includes(`Include.List = "\n${name}\n"`));
  }
  assert.throws(() => category("bad\nname", NAMES[0]), /Invalid QA/);
});

test("native QA capture fits the existing production helper's supported limits", () => {
  const command = buildCaptureCommand({ ...CAPTURE, windowHandle: "1", executable: "gst-launch-1.0.exe" });
  assert.equal(command.quality, 85);
  assert.deepEqual({ width: command.width, height: command.height, fps: command.fps }, { width: 960, height: 540, fps: 20 });
});

test("diagnostic QA patches only temporary transitions and optional line scale", () => {
  const original = Buffer.from('Theme.StartupTheme = "existing"\r\nWaveShape.Transition.Duration = 27\r\nFlowField.Transition.Duration = 17\r\nWaveShape.ConfigPrepTime = 3\r\nFlowField.ConfigPrepTime = 30\r\nWaveShape.AutoLineScale = 1\r\nWaveShape.LineWidth.Scale = 1.2\r\nWaveShape.LineWidth.Offset = 0\r\nAudio.InputSource = "untouched"\r\n');
  const normal = patchQaPreferences(original, "QA").toString();
  assert.match(normal, /WaveShape.AutoLineScale = 1\r\n/);
  assert.match(normal, /WaveShape.LineWidth.Scale = 1.2\r\n/);
  const diagnostic = patchQaPreferences(original, "QA", true).toString();
  assert.match(diagnostic, /WaveShape.AutoLineScale = 0\r\n/);
  assert.match(diagnostic, /WaveShape.LineWidth.Scale = 1\r\n/);
  assert.match(diagnostic, /Audio.InputSource = "untouched"\r\n/);
  assert.match(patchQaPreferences(original, "QA", .35).toString(), /WaveShape.LineWidth.Scale = 0.35\r\n/);
  assert.throws(() => patchQaPreferences(original, "QA", 20), /Unsupported temporary/);
  assert.equal(original.toString().includes('Theme.StartupTheme = "existing"'), true);
});

test("explicit 4K QA uses the existing guarded borderless window ownership", () => {
  assert.deepEqual(qaWindow(), { width: 1280, height: 720 });
  assert.deepEqual(qaWindow("4k"), { width: 3840, height: 2160, uniqueCaptureTitle: true, windowMode: "borderless-fullscreen" });
  assert.throws(() => qaWindow("arbitrary"), /Choose 720p or 4k/);
});
