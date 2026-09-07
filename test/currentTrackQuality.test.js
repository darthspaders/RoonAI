"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  currentQualitySourceLabel,
  currentTrackQualityPayload,
  extractTidalTrackId,
  fallbackQualityPayload,
  playbackSourceQualityPayload,
  trackHasTidalId
} = require("../src/currentTrackQuality");

test("TIDAL identity helpers accept direct ids and track URLs", () => {
  assert.equal(trackHasTidalId({ tidalId: "123" }), true);
  assert.equal(trackHasTidalId({ id: "https://tidal.com/browse/track/123" }), false);
  assert.equal(trackHasTidalId({ tidalUrl: "https://tidal.com/browse/track/abc%20123?x=1" }), true);
  assert.equal(extractTidalTrackId({ tidalUrl: "https://tidal.com/browse/track/abc%20123?x=1" }), "abc 123");
  assert.equal(extractTidalTrackId({ tidal: { id: "456" } }), "456");
});

test("current track quality prefers explicit TIDAL metadata over playback source format", () => {
  const payload = currentTrackQualityPayload({
    artist: "Artist",
    title: "Track",
    tidalId: "123",
    audioQuality: "HI_RES_LOSSLESS",
    codec: "FLAC",
    sampleRateKhz: 96,
    bitDepth: 24
  }, null, "provided-tidal-id", {
    sourceName: "HQPlayer",
    codec: "MP3",
    sampleRateKhz: 44.1,
    bitDepth: 16,
    channels: 2,
    display: "MP3 44.1kHz 16bit 2ch"
  });

  assert.equal(payload.source, "TIDAL");
  assert.equal(payload.codec, "FLAC");
  assert.equal(payload.sampleRateKhz, 96);
  assert.equal(payload.track.id, "123");
});

test("current track quality uses live playback format when no TIDAL identity is present", () => {
  const payload = fallbackQualityPayload({ artist: "Radio", title: "Cut" }, {
    sourceName: "HQPlayer",
    codec: "MP3",
    sampleRateKhz: 44.1,
    bitDepth: 16,
    channels: 2,
    bitrate: 320,
    display: "MP3 44.1kHz 2ch 320kbps"
  });

  assert.equal(payload.resolvedBy, "live-playback-source");
  assert.equal(payload.source, "MP3");
  assert.equal(payload.display, "MP3 44.1kHz 2ch 320kbps");
  assert.equal(payload.playbackSource.bitrate, 320);
});

test("current quality source label uses playback source for non-TIDAL tracks", () => {
  assert.equal(currentQualitySourceLabel({ provider: "tidal" }, "", { sourceName: "HQPlayer" }), "TIDAL");
  assert.equal(currentQualitySourceLabel({}, "", { sourceName: "HQPlayer", display: "FLAC 44.1kHz" }), "HQPlayer");
});

test("playback source quality payload keeps track metadata compact", () => {
  const payload = playbackSourceQualityPayload({
    tidal: { artist: "Nested Artist", title: "Nested Track" },
    url: "https://tidal.com/browse/track/789"
  }, null);

  assert.equal(payload.source, "ROON");
  assert.equal(payload.track.id, "789");
  assert.equal(payload.track.artist, "Nested Artist");
  assert.equal(payload.track.title, "Nested Track");
});
