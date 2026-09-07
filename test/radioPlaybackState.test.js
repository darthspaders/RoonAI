"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanArtworkUrl,
  cleanHttpUrl,
  normalizeRadioText,
  parseRoonPresenceNowState,
  radioEnrichmentHasArtwork,
  radioEnrichmentKey,
  radioEnrichmentResultKey,
  radioTrackFromZone,
  splitRadioArtistTitle,
  summarizeZoneTrack
} = require("../src/radioPlaybackState");

test("summarizeZoneTrack keeps normal Roon now-playing metadata compact", () => {
  assert.deepEqual(summarizeZoneTrack({
    now_playing: {
      two_line: { line1: "Track", line2: "Artist" },
      three_line: { line3: "Album" },
      length: 123
    }
  }), {
    title: "Track",
    artist: "Artist",
    album: "Album",
    durationMs: 123000
  });
});

test("radioTrackFromZone parses stream-style artist-title rows and rejects non-music status", () => {
  const parsed = radioTrackFromZone({
    display_name: "Proton Radio",
    is_seek_allowed: false,
    now_playing: {
      two_line: { line1: "Proton Radio", line2: "D-SHIFT - City Lights" },
      length: 456
    }
  });

  assert.equal(parsed.artist, "D-SHIFT");
  assert.equal(parsed.title, "City Lights");
  assert.equal(parsed.source, "Roon radio metadata");
  assert.equal(parsed.durationMs, 456000);
  assert.equal(radioTrackFromZone({
    is_seek_allowed: false,
    now_playing: { two_line: { line1: "Muted detected", line2: "system output" } }
  }), null);
});

test("radioTrackFromZone marks program-like stream titles as not catalog-enrichable", () => {
  const parsed = radioTrackFromZone({
    display_name: "DI.FM",
    is_seek_allowed: false,
    now_playing: {
      two_line: { line1: "DI.FM", line2: "Somebody - Monthly Mix September 2026" }
    }
  });

  assert.equal(parsed.artist, "Somebody");
  assert.equal(parsed.isRadioProgram, true);
  assert.equal(parsed.catalogEnrichmentAllowed, false);
});

test("radio helper keys and URL cleanup preserve current normalization behavior", () => {
  assert.deepEqual(splitRadioArtistTitle("A - B - C"), { artist: "A", title: "B - C" });
  assert.equal(normalizeRadioText("M.Ö.S. & Friends"), "m o s and friends");
  assert.equal(cleanHttpUrl("ftp://example.com/a.jpg"), "");
  assert.equal(cleanArtworkUrl("http://resources.tidal.com/images/a.jpg"), "https://resources.tidal.com/images/a.jpg");
  assert.equal(radioEnrichmentKey({ artist: "D-SHIFT", title: "City Lights" }), "d shift|city lights");
  assert.equal(radioEnrichmentResultKey({ lookup: { artist: "D-SHIFT", title: "City Lights" } }), "d shift|city lights");
  assert.equal(radioEnrichmentHasArtwork({ imageUrl: "http://i.scdn.co/image/abc" }), true);
});

test("parseRoonPresenceNowState accepts structured and legacy pipe payloads", () => {
  assert.deepEqual(parseRoonPresenceNowState({
    nowPlaying: {
      title: "Track",
      artist: "Artist",
      album: "Album",
      albumArtUrl: "https://example.com/a.jpg",
      tidalUrl: "https://tidal.com/browse/track/1",
      signalPath: "lossless"
    }
  }), {
    key: "artist|track",
    title: "Track",
    artist: "Artist",
    album: "Album",
    albumArtUrl: "https://example.com/a.jpg",
    tidalUrl: "https://tidal.com/browse/track/1",
    signalPath: "lossless",
    source: "roonpresence"
  });

  assert.deepEqual(parseRoonPresenceNowState({
    version: "Artist | Track | https://example.com/a.jpg | https://tidal.com/browse/track/1 | lossless"
  }), {
    key: "artist|track",
    title: "Track",
    artist: "Artist",
    albumArtUrl: "https://example.com/a.jpg",
    tidalUrl: "https://tidal.com/browse/track/1",
    signalPath: "lossless",
    source: "roonpresence"
  });
});
