"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTidalLookupResolver } = require("../src/tidalLookupResolver");

function immediateWithTimeout(promise) {
  return promise;
}

test("current track quality resolves direct TIDAL id with catalogue detail", async () => {
  const resolver = createTidalLookupResolver({
    tidal: {
      isConfigured: () => true,
      getTrack: async () => ({
        id: "123",
        artist: "Artist",
        title: "Track",
        tidalUrl: "https://tidal.com/browse/track/123",
        codec: "FLAC",
        sampleRateKhz: 96,
        bitDepth: 24,
        mediaTags: ["HI_RES_LOSSLESS"]
      })
    },
    metadataEnrichment: { displayableCachedEntry: () => null },
    hqplayerStatus: { refreshNow: async () => ({ source: null }), getStatus: () => ({ source: null }) },
    withTimeout: immediateWithTimeout,
    qualityLookupTimeoutMs: 1000,
    playlistVerifyTimeoutMs: 1000,
    playlistFallbackTimeoutMs: 1000
  });

  const result = await resolver.resolveCurrentTrackQuality({
    artist: "Artist",
    title: "Track",
    tidalUrl: "https://tidal.com/browse/track/123"
  });

  assert.equal(result.resolvedBy, "tidal-detail");
  assert.equal(result.configured, true);
  assert.equal(result.track.id, "123");
  assert.equal(result.source, "TIDAL");
});

test("playlist resolution prefers metadata enrichment cache before catalogue lookup", async () => {
  let searched = false;
  const resolver = createTidalLookupResolver({
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => {
        searched = true;
        return null;
      },
      searchTracks: async () => []
    },
    metadataEnrichment: {
      displayableCachedEntry: () => ({
        artist: "Artist",
        title: "Track",
        tidalUrl: "https://tidal.com/browse/track/cache"
      })
    },
    hqplayerStatus: { getStatus: () => ({ source: null }) },
    withTimeout: immediateWithTimeout,
    qualityLookupTimeoutMs: 1000,
    playlistVerifyTimeoutMs: 1000,
    playlistFallbackTimeoutMs: 1000
  });

  const result = await resolver.resolveTidalTrackForPlaylist({ artist: "Artist", title: "Track" });

  assert.equal(result.resolvedBy, "metadata-enrichment-cache");
  assert.equal(result.track.tidalId, "cache");
  assert.equal(searched, false);
});

test("playlist resolution falls back to title search when exact catalogue misses", async () => {
  const queries = [];
  const resolver = createTidalLookupResolver({
    tidal: {
      isConfigured: () => true,
      findExactTrack: async () => null,
      searchTracks: async (query) => {
        queries.push(query);
        return [{
          artist: "Unknown Artist",
          title: "Track",
          album: "Album",
          tidalUrl: "https://tidal.com/browse/track/fallback"
        }];
      }
    },
    metadataEnrichment: { displayableCachedEntry: () => null },
    hqplayerStatus: { getStatus: () => ({ source: null }) },
    withTimeout: immediateWithTimeout,
    qualityLookupTimeoutMs: 1000,
    playlistVerifyTimeoutMs: 1000,
    playlistFallbackTimeoutMs: 1000
  });

  const result = await resolver.resolveTidalTrackForPlaylist({
    artist: "Various Artists",
    title: "Track"
  });

  assert.deepEqual(queries, ["Track"]);
  assert.equal(result.resolvedBy, "tidal-catalogue");
  assert.equal(result.track.tidalUrl, "https://tidal.com/browse/track/fallback");
});

test("radio current track quality uses live playback source without catalogue lookup", async () => {
  let getTrackCalled = false;
  const resolver = createTidalLookupResolver({
    tidal: {
      isConfigured: () => true,
      getTrack: async () => {
        getTrackCalled = true;
        return null;
      }
    },
    metadataEnrichment: { displayableCachedEntry: () => null },
    hqplayerStatus: {
      refreshNow: async () => ({
        source: {
          sourceName: "HQPlayer",
          codec: "MP3",
          sampleRateKhz: 44.1,
          channels: 2,
          display: "MP3 44.1kHz 2ch"
        }
      }),
      getStatus: () => ({ source: null })
    },
    isRadioPlaybackTrack: () => true,
    withTimeout: immediateWithTimeout,
    qualityLookupTimeoutMs: 1000,
    playlistVerifyTimeoutMs: 1000,
    playlistFallbackTimeoutMs: 1000
  });

  const result = await resolver.resolveCurrentTrackQuality({ artist: "Radio", title: "Track" });

  assert.equal(result.resolvedBy, "live-playback-source");
  assert.equal(result.display, "MP3 44.1kHz 2ch");
  assert.equal(getTrackCalled, false);
});
