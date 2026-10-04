"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { LocalLibraryMetadataStore } = require("../src/localLibraryMetadataEnrichment");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const {
  TasteClusterStore,
  bootstrapTasteClusters,
  buildTasteClusterProfiles,
  linkLocalLibraryToTrackIdentities,
  identityTextCompatible,
  termsForLabel
} = require("../src/tasteClusterBootstrap");

function tempDbFile(name = "taste-clusters") {
  return path.join(os.tmpdir(), `rabbit-hole-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

test("metadata bootstrap creates overlapping, non-global facets", () => {
  const result = bootstrapTasteClusters([
    { id: 1, artist: "Progressive A", title: "One", genre: "Progressive House", subgenre: "Deep House", completeness_score: 98 },
    { id: 2, artist: "Progressive B", title: "Two", genre: "Progressive House", subgenre: "Progressive House", completeness_score: 88 },
    { id: 3, artist: "Tech A", title: "Three", genre: "Tech House", subgenre: "House", completeness_score: 90 },
    { id: 4, artist: "Tech B", title: "Four", genre: "Tech House", subgenre: "House", completeness_score: 90 },
    { id: 5, artist: "Unknown", title: "Five", genre: "Electronic", completeness_score: 50 },
    { id: 6, artist: "Missing", title: "Six", completeness_score: 0 }
  ], { minSupport: 2 });

  assert.ok(result.clusters.some((cluster) => cluster.name === "Progressive House"));
  assert.ok(result.clusters.some((cluster) => cluster.name === "Tech House"));
  assert.ok(!result.clusters.some((cluster) => cluster.name === "Electronic"));
  assert.ok(result.assignments.some((assignment) => assignment.localFileId === 1 && assignment.membershipKind === "primary"));
  assert.equal(result.summary.excludedNoUsefulFacet, 2);
  assert.equal(result.model.metadataOnly, true);
});

test("generic label words do not become independent facets", () => {
  const terms = termsForLabel("Electronic, Dance / Pop, 1985 Music");
  assert.ok(!terms.includes("electronic"));
  assert.ok(!terms.includes("dance"));
  assert.ok(!terms.includes("music"));
  assert.ok(!terms.includes("1985"));
});

test("provider IDs cannot override a contradictory artist and title", () => {
  assert.equal(identityTextCompatible(
    { artist: "John Summit, VLTRA (IT)", title: "Legacy" },
    { artist: "Ashterra", title: "The Pleiade's Legacy (Remastered 2023)" }
  ), false);
  assert.equal(identityTextCompatible(
    { artist: "Roger Sanchez", title: "Another Chance" },
    { artist: "Roger Sanchez / Roberto Sánchez", title: "Another Chance" }
  ), true);
});

test("equivalent duplicate identities prefer the direct TIDAL record", () => {
  const musicMemory = new MusicMemoryStore({ dbFile: tempDbFile("taste-cluster-identity-dedupe"), logger: null });
  const tidalIdentity = musicMemory.upsertTrackIdentity({ tidalId: "12345", artist: "Artist", title: "Track" });
  const textIdentity = musicMemory.upsertTrackIdentity({ artist: "Artist", title: "Track" });
  musicMemory.saveProviderEnrichment({ tidalId: "12345", artist: "Artist", title: "Track" }, "beatport", {
    providerTrackId: "bp-1",
    artist: "Artist",
    title: "Track",
    confidence: 100
  });
  musicMemory.saveProviderEnrichment({ artist: "Artist", title: "Track" }, "beatport", {
    providerTrackId: "bp-1",
    artist: "Artist",
    title: "Track",
    confidence: 100
  });
  const linked = linkLocalLibraryToTrackIdentities(musicMemory.db, [{
    id: 1,
    artist: "Artist",
    title: "Track",
    tidal_id: "12345",
    beatport_id: "bp-1"
  }]);
  assert.equal(linked.summary.exact, 1);
  assert.equal(linked.links[0].trackIdentityId, tidalIdentity.id);
  assert.match(linked.links[0].evidence.canonicalization, /TIDAL/i);
  assert.notEqual(textIdentity.id, tidalIdentity.id);
  musicMemory.close();
});

test("taste cluster store replaces only its provisional bootstrap rows", () => {
  const musicMemory = new MusicMemoryStore({ dbFile: tempDbFile(), logger: null });
  new LocalLibraryMetadataStore({ musicMemory, logger: null });
  musicMemory.db.prepare(`
    INSERT INTO local_library_file (
      file_hash, file_path, status, last_scanned_at, artist, title, completeness_class
    ) VALUES (?, ?, 'processed', ?, ?, ?, 'complete')
  `).run("f".repeat(64), "Z:\\Music\\one.flac", new Date(0).toISOString(), "Artist", "Track");
  const store = new TasteClusterStore({ db: musicMemory.db, logger: null });
  const result = bootstrapTasteClusters([{ id: 1, artist: "Artist", title: "Track", genre: "Progressive House" }], { minSupport: 1 });
  const status = store.replaceMetadataBootstrap(result);
  assert.equal(status.clusterCount, result.summary.clusterCount);
  assert.equal(status.memberAssignmentCount, result.summary.assignmentCount);
  assert.equal(musicMemory.db.prepare("SELECT COUNT(*) AS count FROM taste_cluster").get().count, result.summary.clusterCount);
  musicMemory.close();
});

test("local files link to stable identities and feedback profiles stay embedding-gated", () => {
  const dbFile = tempDbFile("taste-cluster-profiles");
  const musicMemory = new MusicMemoryStore({ dbFile, logger: null });
  new LocalLibraryMetadataStore({ musicMemory, logger: null });
  musicMemory.db.prepare(`
    INSERT INTO local_library_file (
      file_hash, file_path, status, last_scanned_at, artist, title, genre, completeness_class
    ) VALUES (?, ?, 'processed', ?, ?, ?, ?, 'complete')
  `).run("g".repeat(64), "Z:\\Music\\one.flac", new Date(0).toISOString(), "Artist", "Track", "Progressive House");
  const identity = musicMemory.saveTasteFeedback({ artist: "Artist", title: "Track" }, {
    rating: "love",
    sourceEventId: "test:love:artist-track"
  });
  musicMemory.saveTasteFeedback({ artist: "Artist", title: "Track" }, {
    rating: "wrong_genre",
    sourceEventId: "test:wrong-genre:artist-track"
  });
  const clusterStore = new TasteClusterStore({ db: musicMemory.db, logger: null });
  const clusterReport = bootstrapTasteClusters([
    { id: 1, artist: "Artist", title: "Track", genre: "Progressive House" }
  ], { minSupport: 1 });
  clusterStore.replaceMetadataBootstrap(clusterReport);
  const linked = linkLocalLibraryToTrackIdentities(musicMemory.db, [{
    id: 1,
    artist: "Artist",
    title: "Track",
    genre: "Progressive House"
  }]);
  assert.equal(linked.summary.highConfidence, 1);
  clusterStore.replaceIdentityLinks(linked.links);

  const sonicStore = new SonicEmbeddingStore({ enabled: true, dbFile, logger: null });
  sonicStore.upsertEmbedding({
    track: { identityKey: identity.identity_key, artist: "Artist", title: "Track" },
    vector: [1, 0, 0],
    model: "discogs-effnet",
    modelVersion: "1"
  });
  sonicStore.close();

  const profiles = buildTasteClusterProfiles(musicMemory.db, {
    model: "discogs-effnet",
    modelVersion: "1",
    minEmbeddings: 1,
    links: linked.links
  });
  assert.ok(profiles.summary.readyCount >= 1);
  assert.equal(profiles.profiles.find((profile) => profile.direction === "positive").status, "ready");
  clusterStore.replaceProfiles(profiles);
  assert.equal(clusterStore.profileStatus({ model: "discogs-effnet", modelVersion: "1" }).ready, profiles.summary.readyCount);
  musicMemory.close();
});

test("local-file sonic profiles bridge into feedback identities only through strong links", () => {
  const dbFile = tempDbFile("taste-cluster-local-sonic-bridge");
  const musicMemory = new MusicMemoryStore({ dbFile, logger: null });
  new LocalLibraryMetadataStore({ musicMemory, logger: null });
  const fileHash = "l".repeat(64);
  musicMemory.db.prepare(`
    INSERT INTO local_library_file (
      file_hash, file_path, status, last_scanned_at, artist, title, genre, completeness_class
    ) VALUES (?, ?, 'processed', ?, ?, ?, ?, 'complete')
  `).run(fileHash, "Z:\\Music\\Artist\\Track.flac", new Date(0).toISOString(), "Artist", "Track", "Progressive House");
  const identity = musicMemory.saveTasteFeedback({ artist: "Artist", title: "Track" }, {
    rating: "skip",
    sourceEventId: "test:local-file-skip:artist-track"
  });
  const clusterStore = new TasteClusterStore({ db: musicMemory.db, logger: null });
  clusterStore.replaceMetadataBootstrap(bootstrapTasteClusters([
    { id: 1, artist: "Artist", title: "Track", genre: "Progressive House" }
  ], { minSupport: 1 }));
  const linked = linkLocalLibraryToTrackIdentities(musicMemory.db, [{
    id: 1,
    file_hash: fileHash,
    artist: "Artist",
    title: "Track",
    genre: "Progressive House"
  }]);
  assert.equal(linked.summary.highConfidence, 1);
  clusterStore.replaceIdentityLinks(linked.links);

  const sonicStore = new SonicEmbeddingStore({ enabled: true, dbFile, logger: null });
  sonicStore.upsertEmbedding({
    track: { identityKey: `file:${fileHash}`, artist: "Artist", title: "Track" },
    vector: [0, 1, 0],
    model: "discogs-effnet",
    modelVersion: "1",
    sourceSha256: fileHash
  });
  sonicStore.close();

  const profiles = buildTasteClusterProfiles(musicMemory.db, {
    model: "discogs-effnet",
    modelVersion: "1",
    minEmbeddings: 1,
    links: linked.links
  });
  const progressiveNegative = profiles.profiles.find((profile) => (
    profile.clusterName === "Progressive House" && profile.direction === "negative"
  ));
  assert.equal(progressiveNegative.status, "ready");
  assert.equal(progressiveNegative.feedbackIdentityCount, 1);
  assert.equal(progressiveNegative.embeddingIdentityCount, 1);
  assert.deepEqual(progressiveNegative.vector, [0, 1, 0]);
  assert.equal(identity.identity_key, linked.links[0].evidence.identity.identityKey);
  musicMemory.close();
});

test("accepted Beatport negative seeds become cluster-scoped profiles", () => {
  const dbFile = tempDbFile("taste-cluster-external-negative");
  const musicMemory = new MusicMemoryStore({ dbFile, logger: null });
  new LocalLibraryMetadataStore({ musicMemory, logger: null });
  musicMemory.db.prepare(`
    INSERT INTO local_library_file (
      file_hash, file_path, status, last_scanned_at, artist, title, genre, completeness_class
    ) VALUES (?, ?, 'processed', ?, ?, ?, ?, 'complete')
  `).run("h".repeat(64), "Z:\\Music\\anchor.flac", new Date(0).toISOString(), "Anchor", "Track", "Deep House");
  const negative = musicMemory.saveTasteFeedback({ artist: "Negative", title: "Track" }, {
    rating: "skip",
    sourceEventId: "test:skip:negative-track"
  });
  musicMemory.saveBeatportEnrichment({ artist: "Negative", title: "Track" }, {
    id: "bp-negative-1",
    artist: "Negative",
    title: "Track",
    genre: "Deep House",
    rawJson: { id: "bp-negative-1", name: "Track" }
  }, { confidence: 99 });
  const clusterStore = new TasteClusterStore({ db: musicMemory.db, logger: null });
  clusterStore.replaceMetadataBootstrap(bootstrapTasteClusters([
    { id: 1, artist: "Anchor", title: "Track", genre: "Deep House" }
  ], { minSupport: 1 }));
  const sonicStore = new SonicEmbeddingStore({ enabled: true, dbFile, logger: null });
  sonicStore.upsertEmbedding({
    track: { identityKey: negative.identity_key, artist: "Negative", title: "Track" },
    vector: [0, 1, 0],
    model: "discogs-effnet",
    modelVersion: "1"
  });
  sonicStore.close();

  const profiles = buildTasteClusterProfiles(musicMemory.db, {
    model: "discogs-effnet",
    modelVersion: "1",
    minEmbeddings: 1,
    includeExternalNegativeSeeds: true,
    links: []
  });
  assert.equal(profiles.summary.externalNegativeSeedCount, 1);
  assert.equal(profiles.summary.externalNegativeAssignedCount, 1);
  assert.equal(profiles.summary.externalNegativeUnassignedCount, 0);
  const deepHouse = profiles.profiles.find((profile) => profile.clusterName === "Deep House" && profile.direction === "negative");
  assert.equal(deepHouse.status, "ready");
  assert.equal(deepHouse.linkedIdentityCount, 0);
  assert.equal(deepHouse.embeddingIdentityCount, 1);
  assert.equal(deepHouse.metadata.externalNegativeSeedCount, 1);
  assert.deepEqual(deepHouse.vector, [0, 1, 0]);
  musicMemory.close();
});
