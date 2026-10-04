"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const {
  LocalLibraryMetadataEnricher,
  LocalLibraryMetadataStore,
  completenessFor,
  resolveMetadata,
  trackFromFfprobe
} = require("../src/localLibraryMetadataEnrichment");

function tempDbFile(name = "local-library") {
  return path.join(os.tmpdir(), `rabbit-hole-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

test("FFprobe metadata parser extracts tags and technical properties", () => {
  const track = trackFromFfprobe("Z:\\Music\\song.flac", {
    format: {
      format_name: "flac",
      duration: "321.5",
      tags: {
        ARTIST: "Artist",
        TITLE: "Song",
        ALBUM: "Album",
        DATE: "2024-03-01",
        GENRE: "Progressive House",
        BPM: "124",
        LABEL: "Label"
      }
    },
    streams: [{ codec_type: "audio", sample_rate: "48000", bits_per_sample: 24, channels: 2 }]
  });
  assert.equal(track.artist, "Artist");
  assert.equal(track.title, "Song");
  assert.equal(track.year, 2024);
  assert.equal(track.durationMs, 321500);
  assert.equal(track.sampleRate, 48000);
  assert.equal(track.bitDepth, 24);
  assert.equal(track.channels, 2);
});

test("field resolution preserves embedded values and fills missing fields from stronger context", () => {
  const result = resolveMetadata({ artist: "Artist", title: "Song", genre: "Rock" }, [
    { source: "embedded", confidence: 100, values: { artist: "Artist", title: "Song", genre: "Rock" }, matchType: "EMBEDDED" },
    { source: "beatport", confidence: 99, values: { artist: "Artist", title: "Song (Extended Mix)", genre: "Progressive House", label: "Label", bpm: 124 }, matchType: "RELATED_VERSION" }
  ]);
  assert.equal(result.metadata.genre, "Rock");
  assert.equal(result.metadata.label, "Label");
  assert.equal(result.metadata.bpm, 124);
  assert.equal(result.fieldSources.genre.source, "embedded");
  assert.equal(result.fieldSources.label.source, "beatport");
});

test("completeness score separates identity, classification, electronic, and external groups", () => {
  const result = completenessFor({
    artist: "Artist",
    title: "Song",
    album: "Album",
    durationMs: 300000,
    genre: "Progressive House",
    year: 2024,
    label: "Label",
    bpm: 124,
    isrc: "USABC2400001"
  });
  assert.equal(result.classification, "mostly complete");
  assert.equal(result.groups.identity.present, 4);
  assert.equal(result.groups.external.present, 1);
});

test("local metadata store persists resolved files, field provenance, matches, and jobs", () => {
  const musicMemory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  const store = new LocalLibraryMetadataStore({ musicMemory, logger: null });
  const result = {
    filePath: "Z:\\Music\\song.flac",
    fileHash: "a".repeat(64),
    fileSize: 123,
    modifiedAt: new Date(0).toISOString(),
    scannedAt: new Date(0).toISOString(),
    metadata: { artist: "Artist", title: "Song", rawTags: { artist: "Artist" }, fileFormat: "flac" },
    fieldSources: { artist: { source: "embedded", confidence: 100 } },
    completeness: completenessFor({ artist: "Artist", title: "Song" }),
    evidence: [{ source: "embedded", confidence: 100, matchType: "EMBEDDED", values: { artist: "Artist", title: "Song" }, raw: { artist: "Artist" } }],
    matches: [{ provider: "beatport", artist: "Other", title: "Song", confidence: 70, matchType: "AMBIGUOUS", accepted: false, reason: "artist mismatch", raw: {} }],
    status: "processed"
  };
  store.saveResult(result, { providerSet: "embedded,memory" });
  store.saveResult({
    ...result,
    fileHash: "b".repeat(64),
    metadata: { ...result.metadata, rawTags: { artist: "Artist", label: "Label" } },
    scannedAt: new Date(1).toISOString()
  }, { providerSet: "embedded,memory" });
  store.saveJob({ jobId: "job-1", rootPath: "Z:\\Music", status: "running", filesSeen: 1, filesProcessed: 1 });
  assert.equal(store.status().fileCount, 1);
  assert.equal(store.status().fieldEvidenceCount, 2);
  assert.equal(store.status().ambiguousMatchCount, 1);
  assert.ok(store.reusableFile("Z:\\Music\\song.flac", { size: 123, mtimeMs: 0 }, "embedded,memory"));
  assert.ok(store.reusableFile("Z:\\Music\\song.flac", { size: 123, mtimeMs: 0 }, "embedded"));
  store.close();
  musicMemory.close();
});

test("local enricher is source-independent and accepts injected PCM metadata probing", async () => {
  const enricher = new LocalLibraryMetadataEnricher({
    probe: async () => ({ format: { format_name: "wav", duration: "10" }, streams: [{ codec_type: "audio", sample_rate: "44100", channels: 2 }] }),
    hash: async () => "b".repeat(64),
    logger: null
  });
  const result = await enricher.enrichFile("Z:\\Music\\song.wav", {
    stat: { size: 100, mtimeMs: 0 },
    providers: ["embedded"]
  });
  assert.equal(result.fileHash, "b".repeat(64));
  assert.equal(result.metadata.fileFormat, "wav");
  assert.equal(result.metadata.sampleRate, 44100);
  assert.equal(result.status, "processed");
});

test("local enricher rejects partial artist credits from external matches", async () => {
  const enricher = new LocalLibraryMetadataEnricher({
    probe: async () => ({
      format: {
        format_name: "flac",
        duration: "180",
        tags: { ARTIST: "Artist A, Artist B", TITLE: "Song" }
      },
      streams: [{ codec_type: "audio", sample_rate: "44100", channels: 2 }]
    }),
    hash: async () => "c".repeat(64),
    beatport: {
      isConfigured: () => true,
      findTrack: async () => ({
        id: "bp-1",
        artist: "Artist A",
        title: "Song",
        genre: "Wrong Match Genre"
      })
    },
    musicBrainzIndex: {
      searchRecordings: () => [{
        id: "mb-partial",
        title: "Song",
        "artist-credit": [{ artist: { name: "Artist A" } }]
      }, {
        id: "mb-full",
        title: "Song",
        "artist-credit": [{ artist: { name: "Artist A" } }, { artist: { name: "Artist B" } }],
        releases: [{ id: "release-1", title: "Song", genres: [{ name: "Correct Genre" }] }]
      }]
    },
    logger: null
  });
  const result = await enricher.enrichFile("Z:\\Music\\song.flac", {
    stat: { size: 100, mtimeMs: 0 },
    providers: ["embedded", "beatport", "musicbrainz"]
  });
  assert.equal(result.metadata.genre, "Correct Genre");
  assert.equal(result.matches.find((match) => match.raw?.id === "mb-partial").accepted, false);
  assert.equal(result.matches.find((match) => match.raw?.id === "mb-full").accepted, true);
  assert.equal(result.matches.find((match) => match.raw?.id === "bp-1").accepted, false);
});

test("local enricher rejects unsafe Beatport version proxies without exact evidence", async () => {
  const enricher = new LocalLibraryMetadataEnricher({
    probe: async () => ({
      format: {
        format_name: "flac",
        duration: "180",
        tags: { ARTIST: "Artist", TITLE: "Song" }
      },
      streams: [{ codec_type: "audio", sample_rate: "44100", channels: 2 }]
    }),
    hash: async () => "d".repeat(64),
    beatport: {
      isConfigured: () => true,
      findTrack: async () => ({
        id: "bp-remix",
        artist: "Artist",
        title: "Song",
        mixName: "Someone Else Remix",
        genre: "Remix Genre"
      })
    },
    logger: null
  });
  const result = await enricher.enrichFile("Z:\\Music\\song.flac", {
    stat: { size: 100, mtimeMs: 0 },
    providers: ["embedded", "beatport"]
  });
  assert.equal(result.metadata.genre, "");
  assert.equal(result.matches[0].accepted, false);
  assert.match(result.matches[0].reason, /unsafe remix/);
});

test("local enricher accepts an unsafe Beatport descriptor only when the local title carries that exact version", async () => {
  const enricher = new LocalLibraryMetadataEnricher({
    probe: async () => ({
      format: {
        format_name: "flac",
        duration: "180",
        tags: { ARTIST: "H.E.R.", TITLE: "Damage (Joel Corry Remix)" }
      },
      streams: [{ codec_type: "audio", sample_rate: "44100", channels: 2 }]
    }),
    hash: async () => "g".repeat(64),
    beatport: {
      isConfigured: () => true,
      findTrack: async () => ({
        id: "bp-version",
        artist: "H.E.R.",
        title: "Damage",
        mixName: "Joel Corry Remix",
        genre: "Trap / Future Bass"
      })
    },
    logger: null
  });
  const result = await enricher.enrichFile("Z:\\Music\\damage.flac", {
    stat: { size: 100, mtimeMs: 0 },
    providers: ["embedded", "beatport"]
  });
  assert.equal(result.matches[0].accepted, true);
  assert.equal(result.matches[0].matchType, "RELATED_VERSION");
  assert.equal(result.metadata.genre, "Trap / Future Bass");
});

test("local enricher uses Discogs as a bounded release-context fallback", async () => {
  const enricher = new LocalLibraryMetadataEnricher({
    probe: async () => ({
      format: {
        format_name: "flac",
        duration: "240",
        tags: { ARTIST: "Pink Floyd", TITLE: "Time", ALBUM: "The Dark Side of the Moon" }
      },
      streams: [{ codec_type: "audio", sample_rate: "44100", channels: 2 }]
    }),
    hash: async () => "h".repeat(64),
    discogs: {
      isConfigured: () => true,
      findTrack: async () => ({
        source: "discogs",
        id: "123:4",
        discogsId: "123",
        masterId: "456",
        artist: "Pink Floyd",
        title: "Time",
        album: "The Dark Side of the Moon",
        label: "Harvest",
        catalogNumber: "SHVL 804",
        genre: "Rock",
        subgenre: "Progressive Rock",
        releaseDate: "1973-03-01",
        year: 1973,
        durationMs: 412000,
        confidence: 99
      })
    },
    logger: null
  });
  const result = await enricher.enrichFile("Z:\\Music\\time.flac", {
    stat: { size: 100, mtimeMs: 0 },
    providers: ["embedded", "discogs"]
  });
  assert.equal(result.metadata.label, "Harvest");
  assert.equal(result.metadata.catalogNumber, "SHVL 804");
  assert.equal(result.metadata.discogsId, "123");
  assert.equal(result.metadata.subgenre, "Progressive Rock");
  assert.equal(result.matches.find((match) => match.provider === "discogs").accepted, true);
});

test("database-only enrichment reuses stored provenance and fills missing fields", async () => {
  const enricher = new LocalLibraryMetadataEnricher({
    discogs: {
      isConfigured: () => true,
      findTrack: async () => ({
        source: "discogs",
        discogsId: "release-1",
        artist: "Artist",
        title: "Song",
        label: "Harvest",
        genre: "Rock"
      })
    },
    logger: null
  });
  const result = await enricher.enrichStoredRow({
    file_path: "Z:\\Music\\song.flac",
    file_hash: "i".repeat(64),
    file_size: 100,
    file_modified_at: new Date(0).toISOString(),
    artist: "Artist",
    title: "Song",
    genre: "Progressive Rock",
    raw_tags_json: "{}",
    field_sources_json: JSON.stringify({
      artist: { source: "embedded", confidence: 100, matchType: "EMBEDDED" },
      title: { source: "embedded", confidence: 100, matchType: "EMBEDDED" },
      genre: { source: "embedded", confidence: 100, matchType: "EMBEDDED" }
    })
  }, { providers: ["discogs"] });
  assert.equal(result.fileHash, "i".repeat(64));
  assert.equal(result.metadata.genre, "Progressive Rock");
  assert.equal(result.metadata.label, "Harvest");
  assert.equal(result.metadata.discogsId, "release-1");
  assert.equal(result.fieldSources.genre.source, "embedded");
  assert.equal(result.fieldSources.label.source, "discogs");
});

test("review queue flags incomplete metadata and related Beatport versions without changing rows", () => {
  const musicMemory = new MusicMemoryStore({ dbFile: tempDbFile("local-library-review"), logger: null });
  const store = new LocalLibraryMetadataStore({ musicMemory, logger: null });
  store.saveResult({
    filePath: "Z:\\Music\\partial.flac",
    fileHash: "e".repeat(64),
    fileSize: 123,
    modifiedAt: new Date(0).toISOString(),
    metadata: { artist: "Partial Artist", title: "Partial Song", durationMs: 180000, fileFormat: "flac" },
    fieldSources: {},
    completeness: completenessFor({ artist: "Partial Artist", title: "Partial Song", durationMs: 180000 }),
    evidence: [],
    matches: [{
      provider: "beatport",
      artist: "Partial Artist",
      title: "Partial Song",
      confidence: 0,
      matchType: "AMBIGUOUS",
      accepted: false,
      reason: "unsafe remix version",
      raw: { id: "bp-rejected", mixName: "Someone Else Remix" }
    }],
    status: "processed"
  }, { providerSet: "embedded,beatport" });
  store.saveResult({
    filePath: "Z:\\Music\\related.flac",
    fileHash: "f".repeat(64),
    fileSize: 456,
    modifiedAt: new Date(0).toISOString(),
    metadata: {
      artist: "Complete Artist", title: "Complete Song", album: "Album", durationMs: 180000,
      genre: "Progressive House", year: 2025, label: "Label", bpm: 124, keyName: "F minor",
      camelot: "4A", isrc: "USABC2500001", beatportId: "bp-related", musicBrainzId: "mb-1",
      fileFormat: "flac"
    },
    fieldSources: {},
    completeness: completenessFor({
      artist: "Complete Artist", title: "Complete Song", album: "Album", durationMs: 180000,
      genre: "Progressive House", year: 2025, label: "Label", bpm: 124, keyName: "F minor",
      camelot: "4A", isrc: "USABC2500001", beatportId: "bp-related", musicBrainzId: "mb-1"
    }),
    evidence: [],
    matches: [{
      provider: "beatport",
      artist: "Complete Artist",
      title: "Complete Song",
      confidence: 100,
      matchType: "EXACT",
      accepted: true,
      reason: "ISRC match",
      raw: { id: "bp-related", durationMs: 420000, mixName: "Extended Mix", isrc: "USABC2500001", label: "Label" }
    }],
    status: "processed"
  }, { providerSet: "embedded,beatport" });

  const before = store.status();
  const review = store.reviewQueue();
  const after = store.status();
  assert.equal(review.summary.filesScanned, 2);
  assert.equal(review.summary.partialCount, 1);
  assert.equal(review.summary.relatedVersionCount, 1);
  assert.equal(review.summary.severeVersionCount, 1);
  assert.equal(review.summary.reviewItems, 2);
  assert.equal(review.items[0].priority, "high");
  assert.deepEqual(review.items[0].reasons, ["INCOMPLETE_METADATA", "UNRESOLVED_EXTERNAL_MATCH"]);
  assert.ok(review.items[1].reasons.includes("RELATED_VERSION_REVIEW"));
  assert.equal(review.items[1].relatedVersions[0].durationDeltaMs, 240000);
  assert.deepEqual(after, before);
  store.close();
  musicMemory.close();
});
