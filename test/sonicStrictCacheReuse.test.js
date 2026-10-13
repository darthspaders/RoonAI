"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");
const { storedSonicIdentityMatches } = require("../src/sonicProfileIdentity");

// Unique historical profiles from the saved final-failure-categories.json audit.
// These are catalog fixtures only: no live database or provider is accessed.
const historicalProxies = [
  ["451599197", "D-Nox", "Your Love", "20939594"],
  ["524343896", "HUGEL, Imael Angel, Ultra Nate", "Movin' To The Sun", "29014720"],
  ["432944536", "M.O.S.", "Immensity", "20376859"],
  ["449458566", "Ezequiel Arias", "ReAnimation", "20715597"],
  ["515951511", "Beckers, D-Nox", "You Get Me", "28492740"],
  ["518372600", "Chris Lake, ATRIP", "Make You Fight", "28490349"],
  ["554208227", "Quivver", "Deception", "29899952"],
  ["555732256", "D-Nox, M.O.S.", "Dream On", "30374303"]
];
const historicalUnprovenLocalProfiles = [
  ["461664962", "Ilias Katelanos, Plecta", "Won't Let Go (Jiminy Hop Remix)"],
  ["307301880", "Jimi Jules, Anyma, Cassian", "My City's On Fire (Anyma & Cassian Remix)"],
  ["522245393", "Shouse", "Won't Forget You (Edit)"]
];

function vector(x = 1, y = 0) {
  return [x, y, ...Array(1278).fill(0)];
}

function createEngine(t) {
  const engine = new RecommendationEngineV2({
    enabled: true,
    dbFile: ":memory:",
    logger: null,
    embeddingProviderInstance: {
      name: "discogs-effnet",
      modelVersion: "1",
      status: () => ({ available: true, model: "discogs-effnet", modelVersion: "1" }),
      extractBuffer: () => { throw new Error("Offline cache tests must not extract audio"); }
    }
  });
  assert.equal(engine.store.enabled, true);
  t.after(() => engine.store.close());
  return engine;
}

function putProfile(engine, tidalId, relation, {
  artist = "Cache Artist", title = "Cache Track", sourceType = "beatport-preview",
  sourceTrackId = "101", embedding = vector(), extraMetadata = {}
} = {}) {
  return engine.store.upsertEmbedding({
    identityKey: `tidal:${tidalId}`,
    track: { tidalId, artist, title },
    vector: embedding,
    model: "discogs-effnet",
    modelVersion: "1",
    sourceSha256: `offline-audio-${tidalId}`,
    metadata: {
      sourceType,
      ...(relation === undefined ? {} : { identityRelation: relation }),
      canonicalProvider: "tidal",
      canonicalTrackId: tidalId,
      sourceTrackId,
      ...extraMetadata
    }
  });
}

for (const [tidalId, artist, title, sourceTrackId] of historicalProxies) {
  test(`strict cache reuse rejects historical version proxy: ${artist} - ${title}`, t => {
    const engine = createEngine(t);
    const profile = putProfile(engine, tidalId, "version-proxy", {
      artist, title, sourceTrackId, sourceType: "beatport-preview-version-proxy"
    });
    assert.equal(storedSonicIdentityMatches(profile), false);
    assert.equal(engine.findStoredSonicProfile({ tidalId }, { allowVersionProxy: false }), null);
    assert.equal(engine.findStoredSonicProfile({ tidalId }).identityKey, profile.identityKey);
    assert.equal(engine.findStoredSonicProfile({ tidalId }, { allowVersionProxy: true }).identityKey, profile.identityKey);
    assert.equal(engine.store.getEmbedding(profile.identityKey).track.metadata.identityRelation, "version-proxy");
  });
}

for (const [tidalId, artist, title] of historicalUnprovenLocalProfiles) {
  test(`strict cache reuse rejects unproven historical local profile: ${artist} - ${title}`, t => {
    const engine = createEngine(t);
    const profile = putProfile(engine, tidalId, undefined, {
      artist, title, sourceType: "local-file-beatport-backed", sourceTrackId: ""
    });
    assert.equal(storedSonicIdentityMatches(profile), false);
    assert.equal(engine.findStoredSonicProfile(profile.identityKey, { allowVersionProxy: false }), null);
    assert.equal(engine.findStoredSonicProfile(profile.identityKey).identityKey, profile.identityKey);
  });
}

for (const relation of ["", "unknown", "EXACT", "related-version"]) {
  test(`strict cache reuse rejects unsupported recorded relationship ${JSON.stringify(relation)}`, t => {
    const engine = createEngine(t);
    const profile = putProfile(engine, "101", relation);
    assert.equal(storedSonicIdentityMatches(profile), false);
    assert.equal(engine.findStoredSonicProfile("tidal:101", { allowVersionProxy: false }), null);
  });
}

for (const relation of ["exact", "equivalent-recording"]) {
  test(`strict prepare reuses ${relation} cache despite historical proxy sourceType`, async t => {
    const engine = createEngine(t);
    const profile = putProfile(engine, "101", relation, { sourceType: "beatport-preview-version-proxy" });
    let resolverCalls = 0;
    let preparationCalls = 0;
    engine.resolveTidalTrackReference = async () => { resolverCalls += 1; throw new Error("Cached safe identity must not resolve again"); };
    engine.analyzeBeatportPreviewForTidalTrack = async () => { preparationCalls += 1; throw new Error("Cached safe identity must not prepare again"); };
    assert.equal(storedSonicIdentityMatches(profile, { tidalUrl: "https://tidal.com/browse/track/101" }), true);
    assert.equal(engine.findStoredSonicProfile("tidal:101", { allowVersionProxy: false }).identityKey, profile.identityKey);
    const result = await engine.prepareSonicAnchor("tidal:101", { allowVersionProxy: false });
    assert.equal(result.ready, true);
    assert.equal(result.prepared, false);
    assert.equal(result.source, "stored-sonic-embedding");
    assert.equal(resolverCalls, 0);
    assert.equal(preparationCalls, 0);
  });
}

function confirmedProfile() {
  return {
    identityKey: "tidal:101",
    track: {
      tidalId: "101",
      metadata: { identityRelation: "exact", canonicalProvider: "tidal", canonicalTrackId: "101" }
    }
  };
}

const explicitConflicts = [
  ["reference identity key", profile => [profile, "tidal:102"]],
  ["reference TIDAL ID", profile => [profile, { tidalId: "102" }]],
  ["reference URL", profile => [profile, { tidalUrl: "https://tidal.com/browse/track/102" }]],
  ["contradictory reference URL and ID", profile => [profile, { tidalId: "101", tidalUrl: "https://tidal.com/browse/track/102" }]],
  ["contradictory reference provider ID aliases", profile => [profile, { tidalId: "101", tidalTrackId: "102" }]],
  ["contradictory nested reference provider ID", profile => [profile, { tidalId: "101", tidal: { tidalId: "102" } }]],
  ["nested reference TIDAL URL", profile => [profile, { tidal: { tidalUrl: "https://tidal.com/browse/track/102" } }]],
  ["contradictory reference URL aliases", profile => [profile, { tidalUrl: "https://tidal.com/browse/track/101", tidal_url: "https://tidal.com/browse/track/102" }]],
  ["contradictory reference identity aliases", profile => [profile, { identityKey: "tidal:101", identity_key: "tidal:102" }]],
  ["profile track TIDAL ID", profile => { profile.track.tidalId = "102"; return [profile, "tidal:101"]; }],
  ["profile track URL", profile => { profile.track.tidalUrl = "https://tidal.com/browse/track/102"; return [profile, "tidal:101"]; }],
  ["recorded canonical TIDAL ID", profile => { profile.track.metadata.canonicalTrackId = "102"; return [profile, "tidal:101"]; }],
  ["recorded metadata TIDAL ID", profile => { profile.track.metadata.tidalId = "102"; return [profile, "tidal:101"]; }]
];
for (const [description, input] of explicitConflicts) {
  test(`strict recorded identity rejects ${description} conflict`, () => {
    assert.equal(storedSonicIdentityMatches(...input(confirmedProfile())), false);
  });
}

test("strict recorded identity does not reinterpret a bare catalog ID as TIDAL", () => {
  assert.equal(storedSonicIdentityMatches(confirmedProfile(), { id: "999", tidalId: "101" }), true);
});

test("strict cache lookup rejects a recorded canonical conflict while permissive lookup stays compatible", t => {
  const engine = createEngine(t);
  putProfile(engine, "101", "exact", { extraMetadata: { canonicalTrackId: "102" } });
  assert.equal(engine.findStoredSonicProfile("tidal:101", { allowVersionProxy: false }), null);
  assert.equal(engine.findStoredSonicProfile("tidal:101").identityKey, "tidal:101");
});

test("strict reprepare attempts fresh validation and preserves the old cache if preparation fails", async t => {
  const engine = createEngine(t);
  const before = putProfile(engine, "555732256", "version-proxy", {
    artist: "D-Nox, M.O.S.", title: "Dream On", sourceType: "beatport-preview-version-proxy"
  });
  const failure = Object.assign(new Error("No safe exact recording available"), { statusCode: 422 });
  let preparationCalls = 0;
  engine.resolveTidalTrackReference = async () => ({ tidalId: "555732256", artist: "D-Nox, M.O.S.", title: "Dream On" });
  engine.analyzeBeatportPreviewForTidalTrack = async (_track, options) => {
    preparationCalls += 1;
    assert.equal(options.allowVersionProxy, false);
    throw failure;
  };
  await assert.rejects(engine.prepareSonicAnchor("tidal:555732256", { allowVersionProxy: false }), error => error === failure);
  assert.equal(preparationCalls, 1);
  assert.deepEqual(engine.store.getEmbedding(before.identityKey), before);
  assert.equal(engine.findStoredSonicProfile(before.identityKey, { allowVersionProxy: false }), null);
});

test("strict prepare rejects when post-analysis reread still finds legacy proxy provenance", async t => {
  const engine = createEngine(t);
  const before = putProfile(engine, "101", "version-proxy");
  let preparationCalls = 0;
  engine.resolveTidalTrackReference = async () => ({ tidalId: "101", artist: "Cache Artist", title: "Cache Track" });
  engine.analyzeBeatportPreviewForTidalTrack = async (_track, options) => {
    preparationCalls += 1;
    assert.equal(options.allowVersionProxy, false);
    // Reproduces hash-based audio reuse retaining older provenance: the analysis
    // result alone must not override the persisted profile's strict validation.
    return { identityKey: before.identityKey, model: before.model, modelVersion: before.modelVersion };
  };
  await assert.rejects(engine.prepareSonicAnchor("tidal:101", { allowVersionProxy: false }), error => {
    assert.equal(error.statusCode, 422);
    assert.ok(error.identityDiagnostics?.identityRules?.includes("stored-sonic-provenance-unverified"));
    return true;
  });
  assert.equal(preparationCalls, 1);
  assert.deepEqual(engine.store.getEmbedding(before.identityKey), before);
});

function neighborFixture(t) {
  const engine = createEngine(t);
  putProfile(engine, "101", "exact");
  putProfile(engine, "102", "version-proxy");
  putProfile(engine, "103", undefined, { embedding: vector(0.99, 0.1), sourceType: "local-file-beatport-backed" });
  putProfile(engine, "104", "exact", { embedding: vector(0.98, 0.1), extraMetadata: { canonicalTrackId: "999" } });
  putProfile(engine, "105", "exact", { embedding: vector(0.8, 0.6) });
  putProfile(engine, "106", "equivalent-recording", { embedding: vector(0.7, 0.7), sourceType: "beatport-preview-version-proxy" });
  return engine;
}

test("strict post-preparation validation rejects a safe profile for a different canonical track", async t => {
  const engine = createEngine(t);
  putProfile(engine, "102", "exact");
  engine.resolveTidalTrackReference = async () => ({ tidalId: "101", artist: "Requested", title: "Recording" });
  engine.analyzeBeatportPreviewForTidalTrack = async () => ({ identityKey: "tidal:102", model: "discogs-effnet", modelVersion: "1" });
  await assert.rejects(() => engine.prepareSonicAnchor("tidal:101", { allowVersionProxy: false }),
    error => error.statusCode === 422 && error.identityDiagnostics.identityRules.includes("stored-sonic-provenance-unverified"));
  assert.equal(engine.findStoredSonicProfile("tidal:101"), null);
  assert.equal(engine.findStoredSonicProfile("tidal:102", { allowVersionProxy: false }).identityKey, "tidal:102");
});

test("strict nearest lookup filters unsafe provenance before the requested count slice", t => {
  const engine = neighborFixture(t);
  const options = { track: "tidal:101", model: "discogs-effnet", modelVersion: "1", count: 1 };
  assert.deepEqual(engine.store.findNearest(options).map(row => row.identityKey), ["tidal:102"]);
  assert.deepEqual(engine.store.findNearest({ ...options, allowVersionProxy: false }).map(row => row.identityKey), ["tidal:105"]);
});

test("strict direct nearest lookup rejects an unsafe stored anchor even with an explicit vector and model", t => {
  const engine = neighborFixture(t);
  const options = {
    track: "tidal:102", vector: vector(), model: "discogs-effnet", modelVersion: "1", count: 1
  };
  assert.equal(engine.store.findNearest(options).length, 1);
  assert.deepEqual(engine.store.findNearest({ ...options, allowVersionProxy: false }), []);
});

for (const policyLocation of ["input", "options"]) {
  test(`strict neighbor ${policyLocation} policy retains later exact/equivalent candidates`, t => {
    const engine = neighborFixture(t);
    const input = { track: "tidal:101", count: 2, analyzeIfMissing: false };
    const options = {};
    (policyLocation === "input" ? input : options).allowVersionProxy = false;
    const result = engine.sonic.findSonicNeighbors(input, 2, options);
    assert.deepEqual(result.neighbors.map(row => row.identityKey), ["tidal:105", "tidal:106"]);
    assert.equal(result.query.identityKey, "tidal:101");
  });
}

for (const tidalId of ["102", "103", "104"]) {
  test(`strict neighbor query rejects unsafe cached anchor tidal:${tidalId} without affecting permissive calls`, t => {
    const engine = neighborFixture(t);
    assert.throws(() => engine.sonic.findSonicNeighbors({ track: `tidal:${tidalId}`, count: 1, allowVersionProxy: false, analyzeIfMissing: false }));
    assert.equal(engine.sonic.findSonicNeighbors({ track: `tidal:${tidalId}`, count: 1, analyzeIfMissing: false }).query.identityKey, `tidal:${tidalId}`);
  });
}
