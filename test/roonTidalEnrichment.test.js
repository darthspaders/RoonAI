"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoonTidalEnricher } = require("../src/roonTidalEnrichment");

test("Roon TIDAL enrichment returns original tracks when TIDAL is not configured", async () => {
  const tracks = [{ artist: "A", title: "T" }];
  const enricher = createRoonTidalEnricher({
    tidal: { isConfigured: () => false }
  });

  const result = await enricher.enrichRoonTracksOpportunistically(tracks);

  assert.equal(result.tracks, tracks);
  assert.equal(result.stats.enabled, false);
  assert.equal(result.stats.skipped, true);
});

test("Roon TIDAL enrichment skips when the TIDAL circuit is open", async () => {
  const tracks = [{ artist: "A", title: "T" }];
  const enricher = createRoonTidalEnricher({
    tidal: {
      isConfigured: () => true,
      status: () => ({ circuit: { state: "open" } })
    }
  });

  const result = await enricher.enrichRoonTracksOpportunistically(tracks);

  assert.equal(result.tracks, tracks);
  assert.equal(result.stats.enabled, true);
  assert.equal(result.stats.skipped, true);
  assert.match(result.stats.reason, /open/);
});

test("Roon TIDAL enrichment attaches exact matched TIDAL metadata", async () => {
  const enricher = createRoonTidalEnricher({
    tidal: {
      isConfigured: () => true,
      status: () => ({ circuit: { state: "closed" } }),
      verify: async () => ({
        artist: "Artist",
        title: "Track",
        album: "Album",
        label: "Label",
        year: 2026,
        releaseDate: "2026-01-01",
        durationMs: 360000,
        tidalUrl: "https://tidal.com/browse/track/1"
      })
    },
    wait: async () => null
  });

  const result = await enricher.enrichRoonTracksOpportunistically([
    { artist: "Artist", title: "Track" }
  ], { limit: 1, concurrency: 1 });

  assert.equal(result.stats.enriched, 1);
  assert.equal(result.tracks[0].verificationSource, "roon+tidal");
  assert.equal(result.tracks[0].tidal.tidalUrl, "https://tidal.com/browse/track/1");
});

test("Roon TIDAL enrichment records identity conflict without replacing the track", async () => {
  const enricher = createRoonTidalEnricher({
    tidal: {
      isConfigured: () => true,
      status: () => ({ circuit: { state: "closed" } }),
      verify: async () => ({
        artist: "Other Name",
        title: "Track",
        tidalUrl: "https://tidal.com/browse/track/wrong"
      })
    },
    wait: async () => null
  });

  const result = await enricher.enrichRoonTrackWithTidal({ artist: "Artist", title: "Track" });

  assert.equal(result.artist, "Artist");
  assert.equal(result.title, "Track");
  assert.match(result.tidalError, /did not exactly match/);
});
