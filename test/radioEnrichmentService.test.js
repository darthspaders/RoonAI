"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRadioEnrichmentService } = require("../src/radioEnrichmentService");

function createService(overrides = {}) {
  const keyFor = overrides.radioEnrichmentKey || ((lookup = {}) => lookup?.artist && lookup?.title
    ? `${lookup.artist.toLowerCase()}|${lookup.title.toLowerCase()}`
    : "");
  return createRadioEnrichmentService({
    cleanArtworkUrl: overrides.cleanArtworkUrl || ((value = "") => String(value || "").trim()),
    cleanHttpUrl: overrides.cleanHttpUrl || ((value = "") => String(value || "").trim()),
    cleanRadioText: overrides.cleanRadioText || ((value = "") => String(value || "").replace(/\s+/g, " ").trim()),
    config: overrides.config || {
      radioMetadata: {
        enabled: true,
        roonPresenceNowStateUrl: "",
        roonPresenceTimeoutMs: 1200
      }
    },
    fetchJsonWithTimeout: overrides.fetchJsonWithTimeout || (async () => ({ response: { ok: false }, body: null })),
    parseRoonPresenceNowState: overrides.parseRoonPresenceNowState || (() => null),
    radioEnrichmentHasArtwork: overrides.radioEnrichmentHasArtwork || ((entry = {}) => Boolean(entry.imageUrl || entry.albumArtUrl)),
    radioEnrichmentKey: keyFor,
    radioEnrichmentResultKey: overrides.radioEnrichmentResultKey || ((entry = {}) => entry.radioTrackKey || entry.key || ""),
    radioMetadataResolver: overrides.radioMetadataResolver || {
      lookup: async () => null
    },
    radioTrackFromZone: overrides.radioTrackFromZone || ((zone = {}) => zone.lookup || null),
    scheduleBroadcast: overrides.scheduleBroadcast || (() => {}),
    tidal: overrides.tidal || {
      isConfigured: () => false,
      verify: async () => null
    },
    tidalEnrichmentMatches: overrides.tidalEnrichmentMatches || ((lookup = {}, candidate = {}) => (
      keyFor(lookup) === keyFor(candidate)
    ))
  });
}

test("radioMetadataToEnrichment requires exact metadata when artist and title are known", () => {
  const service = createService();
  const loose = service.radioMetadataToEnrichment(
    { artist: "A", title: "T" },
    { artist: "Other", title: "T", albumArtUrl: "http://image" },
    null
  );
  const exact = service.radioMetadataToEnrichment(
    { artist: "A", title: "T" },
    { artist: "A", title: "T", album: "Album", albumArtUrl: "http://image", source: "discogs" },
    null
  );

  assert.equal(loose, null);
  assert.equal(exact.key, "a|t");
  assert.equal(exact.imageUrl, "http://image");
  assert.equal(exact.source, "radio-discogs");
});

test("resolveRadioEnrichment prefers matching RoonPresence artwork mirror", async () => {
  const service = createService({
    config: {
      radioMetadata: {
        enabled: true,
        roonPresenceNowStateUrl: "http://presence.local/now",
        roonPresenceTimeoutMs: 1200
      }
    },
    fetchJsonWithTimeout: async () => ({
      response: { ok: true },
      body: { ignored: true }
    }),
    parseRoonPresenceNowState: () => ({
      key: "a|t",
      albumArtUrl: "http://presence/art.jpg",
      source: "roon-presence"
    }),
    radioMetadataResolver: {
      lookup: async () => {
        throw new Error("metadata lookup should not run after RoonPresence hit");
      }
    }
  });

  const result = await service.resolveRadioEnrichment({ artist: "A", title: "T" }, "a|t");

  assert.equal(result.imageUrl, "http://presence/art.jpg");
  assert.equal(result.source, "radio-roon-presence");
});

test("scheduleRadioEnrichment caches results and later attaches them to playback state", async () => {
  let broadcasts = 0;
  const service = createService({
    radioMetadataResolver: {
      lookup: async () => ({
        artist: "A",
        title: "T",
        album: "Album",
        albumArtUrl: "http://image",
        source: "resolver"
      })
    },
    scheduleBroadcast: () => {
      broadcasts += 1;
    }
  });
  const state = { zones: [{ lookup: { artist: "A", title: "T" }, now_playing: {} }] };

  service.scheduleRadioEnrichment(state);
  await new Promise((resolve) => setImmediate(resolve));
  const enriched = service.attachRadioEnrichment(state);

  assert.equal(broadcasts, 1);
  assert.equal(enriched.zones[0].now_playing.radio_lookup.artist, "A");
  assert.equal(enriched.zones[0].now_playing.radio_enrichment.imageUrl, "http://image");
});

test("scheduleRadioEnrichment does nothing when metadata and TIDAL are disabled", async () => {
  let lookups = 0;
  const service = createService({
    config: {
      radioMetadata: {
        enabled: false,
        roonPresenceNowStateUrl: "",
        roonPresenceTimeoutMs: 1200
      }
    },
    radioMetadataResolver: {
      lookup: async () => {
        lookups += 1;
        return null;
      }
    },
    tidal: {
      isConfigured: () => false,
      verify: async () => {
        lookups += 1;
        return null;
      }
    }
  });

  service.scheduleRadioEnrichment({ zones: [{ lookup: { artist: "A", title: "T" } }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 0);
});
