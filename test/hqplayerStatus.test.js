"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parsePlaylistSource } = require("../src/hqplayerStatus");

test("parses HQPlayer active playlist source format", () => {
  const source = parsePlaylistSource("[1] (44100/16/2/1411200) http://127.0.0.1:30000/stream.raw {application/x-hqplayer-raw}\n\t////Roon 0.000 (0) \"\"");

  assert.equal(source.codec, "");
  assert.equal(source.sampleRateKhz, 44.1);
  assert.equal(source.bitDepth, 16);
  assert.equal(source.channels, 2);
  assert.equal(source.bitrate, 1411200);
  assert.equal(source.sourceName, "Roon");
  assert.equal(source.display, "44.1kHz 16bit 2ch");
});

test("parses lossy HQPlayer playlist source format without invented bit depth", () => {
  const source = parsePlaylistSource("[1] (44100/16/2/320000) http://example.test/live.mp3 {audio/mpeg}\n\t////Roon 0.000 (0) \"\"");

  assert.equal(source.codec, "MP3");
  assert.equal(source.sampleRateKhz, 44.1);
  assert.equal(source.bitDepth, 16);
  assert.equal(source.channels, 2);
  assert.equal(source.bitrate, 320000);
  assert.equal(source.display, "MP3 44.1kHz 2ch 320kbps");
});

test("returns null when HQPlayer playlist source has no format tuple", () => {
  assert.equal(parsePlaylistSource("empty playlist"), null);
});
