"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCaptureCommand } = require("../scripts/soundspectrum-capture.cjs");
const options = { windowHandle: "1234", executable: "C:\\capture-test\\bin\\gst-launch-1.0.exe" };

test("window capture uses 30 fps with two single-frame leaky queues and preserves full-range color", () => {
  const command = buildCaptureCommand(options, {});
  assert.equal(command.fps, 30); assert.equal(command.quality, 65);
  assert.equal(command.width, 800); assert.equal(command.height, 450);
  assert.ok(command.args.includes("window-handle=1234")); assert.ok(command.args.includes("capture-api=wgc"));
  assert.ok(command.args.includes("window-capture-mode=client")); assert.ok(command.args.includes("show-cursor=false"));
  assert.ok(command.args.includes("video/x-raw(memory:D3D11Memory),framerate=30/1"));
  assert.equal(command.args.filter(value => value === "leaky=downstream").length, 2);
  assert.equal(command.args.filter(value => value === "max-size-buffers=1").length, 2);
  assert.ok(command.args.includes("video/x-raw,format=NV12,colorimetry=1:4:7:1"));
  assert.ok(command.args.includes("quality=65")); assert.ok(command.args.includes("sync=false"));
  assert.equal(command.args.some(value => /audiosrc|desktop|dxgiscreencap|show-cursor=true/.test(value)), false);
});

test("60 fps uses the same bounded window and JPEG pipeline as the 30 fps CLI default", () => {
  const standard = buildCaptureCommand(options, {});
  const smooth = buildCaptureCommand({ ...options, fps: 60 }, {});
  assert.equal(smooth.fps, 60);
  assert.ok(smooth.args.includes("video/x-raw(memory:D3D11Memory),framerate=60/1"));
  assert.deepEqual(smooth.args.map(value => value.replace("framerate=60/1", "framerate=30/1")), standard.args);
  for (const name of ["command", "boundary", "width", "height", "quality"]) assert.equal(smooth[name], standard[name]);
  assert.deepEqual(smooth.env, standard.env);
});

test("capture bounds reject desktop handles, rates above 60 fps and larger dimensions", () => {
  for (const change of [{ windowHandle: "0" }, { windowHandle: "https://desktop" }, { fps: 61 }, { fps: 0 }, { fps: 59.5 }, { width: 961 }, { height: 721 }, { quality: 86 }]) {
    assert.throws(() => buildCaptureCommand({ ...options, ...change }, {}));
  }
  assert.equal(buildCaptureCommand({ ...options, fps: 15 }, {}).fps, 15);
});
