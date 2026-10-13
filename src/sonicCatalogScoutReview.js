"use strict";

// Private frozen-comparison review adapter. No provider, inference or DB writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID, randomInt } = require("node:crypto");
const { assertSonicSourceSnapshot } = require("./sonicCandidateCorpus");
const { recordingGroup } = require("./sonicAnalysisPilot");
const KIND = "catalog-scout-comparison";
const PURPOSE = "Judge how well each differing candidate fits beside this anchor.";
const ARMS = Object.freeze(["current-production", "mert-fullsong", "mert-30s", "ensemble"]);
const ROOT = path.resolve(__dirname, "..");
const TRACK_FIELDS = ["identityKey", "tidalId", "artist", "title", "mixVersion", "album", "durationMs", "isrc", "genre", "subgenre", "label", "bpm", "key", "keyName", "camelot", "releaseDate", "year", "beatportTrackId"];
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const isSha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function text(value, label, max = 4096) {
  assert.ok(typeof value === "string" && value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value), `Invalid ${label}.`);
  return value;
}
function fields(value, allowed, label) {
  assert.ok(plain(value) && Object.keys(value).every(key => allowed.includes(key)), `Invalid ${label} fields.`);
}
function storedTrack(value) {
  text(value?.identityKey, "catalog identity"); text(value.artist, "artist", 1000); text(value.title, "title", 1000);
  assert.ok(/^tidal:[1-9]\d*$/.test(value.identityKey) && String(value.tidalId) === value.identityKey.slice(6), "Exact TIDAL identity is required.");
  return clone(Object.fromEntries(TRACK_FIELDS.filter(key => value[key] !== undefined).map(key => [key, value[key]])));
}
function below(file, directory, label) {
  const actual = fs.realpathSync(text(file, label)), base = fs.realpathSync(directory), relative = path.relative(base, actual);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${label} escapes its declared private root.`);
  assert.ok(fs.statSync(actual).isFile(), `Invalid ${label}.`); return actual;
}
function artifact(binding, artifactRoot) {
  fields(binding, ["file", "sha256"], "artifact binding"); assert.ok(isSha(binding.sha256), "Invalid frozen artifact hash.");
  const file = below(binding.file, path.join(artifactRoot, "data"), "frozen artifact");
  assert.ok(fs.statSync(file).size <= 64 * 1024 * 1024, "Frozen artifact exceeds its bound.");
  const bytes = fs.readFileSync(file); assert.equal(hash(bytes), binding.sha256, "Frozen comparison or pool changed.");
  return JSON.parse(bytes);
}
function exactReference(value, artifactRoot) {
  fields(value, ["track", "verification", "source", "sourceFile", "metadata"], "catalog pool entry");
  const track = storedTrack(value.track), verification = value.verification;
  fields(verification, ["provider", "verified", "identityKey", "canonicalTrack"], "canonical verification");
  assert.ok(verification.provider === "tidal" && verification.verified === true && verification.identityKey === track.identityKey, "Verified canonical TIDAL evidence is required.");
  assertSonicSourceSnapshot(value.source, { track: value.track });
  assertSonicSourceSnapshot(value.source, { track: verification.canonicalTrack });
  assert.ok(value.source.sourceType === "beatport-preview" && value.source.identityRelation === "exact" && value.source.allowVersionProxy === false,
    "Scout review requires exact catalog preview sources.");
  assert.ok(value.source.durationSeconds >= 30 && value.source.spans[0][1] - value.source.spans[0][0] >= 29.999998,
    "A complete thirty-second excerpt is required.");
  if (value.metadata !== undefined) {
    fields(value.metadata, ["query", "discoverySource", "discoveryLane", "beatportGenre", "beatportSubgenre", "label", "bpm"], "catalog admission metadata");
    for (const [key, item] of Object.entries(value.metadata)) {
      if (key === "bpm") assert.ok(Number.isFinite(item) && item > 0, "Invalid catalog bpm.");
      else text(item, `catalog ${key}`, 1000);
    }
  }
  const sourceFile = below(value.sourceFile, path.join(artifactRoot, "data"), "frozen source");
  return { track, verification: clone(verification), source: clone(value.source), sourceFile };
}
function readFrozenArtifacts(comparisonBinding, poolBinding, artifactRoot = ROOT) {
  const comparison = artifact(comparisonBinding, artifactRoot), pool = artifact(poolBinding, artifactRoot);
  assert.equal(pool.version, 1); assert.equal(pool.kind, "catalog-scout-pilot-pool");
  assert.equal(comparison.version, 1);
  assert.ok(plain(comparison.recipe) && comparison.recipe.kind === "catalog-scout-end-to-end" && comparison.recipe.finalCount === 3
    && comparison.recipe.scoutCount === 6 && comparison.recipe.agreementWeight === 0 && comparison.recipe.productionApplied === false,
  "A frozen shadow final-three comparison is required.");
  assert.ok(Array.isArray(comparison.code?.files) && comparison.code.files.length >= 1 && comparison.code.files.length <= 100,
    "Frozen comparison code receipts are required.");
  const seenCode = new Set();
  for (const entry of comparison.code.files) {
    fields(entry, ["path", "sha256"], "frozen code receipt"); text(entry.path, "code path");
    assert.ok(!path.isAbsolute(entry.path) && !entry.path.split(/[\\/]/).includes("..") && isSha(entry.sha256), "Invalid frozen code receipt.");
    const file = below(path.join(artifactRoot, entry.path), artifactRoot, "frozen code");
    assert.ok(!seenCode.has(file), "Duplicate frozen code receipt."); seenCode.add(file);
    assert.equal(hash(fs.readFileSync(file)), entry.sha256, "Frozen comparison code changed.");
  }
  assert.ok(Array.isArray(pool.entries) && pool.entries.length >= 2 && pool.entries.length <= 100, "Catalog pool must contain at most 100 exact sources.");
  const entries = new Map(), owners = new Map();
  for (const input of pool.entries) {
    const entry = exactReference(input, artifactRoot), key = entry.track.identityKey;
    assert.ok(!entries.has(key), "Duplicate exact catalog identity.");
    assert.ok(!owners.has(entry.source.sourceSha256), "Distinct catalog entries cannot share original source bytes.");
    entries.set(key, entry); owners.set(entry.source.sourceSha256, key);
  }
  assert.ok(Array.isArray(pool.requests) && pool.requests.length >= 1 && pool.requests.length <= 6);
  assert.ok(Array.isArray(comparison.requests) && comparison.requests.length === pool.requests.length, "Comparison request coverage changed.");
  const requests = [], requestIds = new Set(), anchorIds = new Set();
  for (const request of pool.requests) {
    text(request.requestId, "request ID", 256); assert.ok(!requestIds.has(request.requestId), "Duplicate request ID."); requestIds.add(request.requestId);
    const anchor = entries.get(request.anchorIdentityKey); assert.ok(anchor, "Request anchor is missing from the frozen pool.");
    assert.ok(!anchorIds.has(anchor.track.identityKey), "Duplicate request anchor."); anchorIds.add(anchor.track.identityKey);
    assert.ok(Array.isArray(request.candidateIdentityKeys) && request.candidateIdentityKeys.length <= 100
      && new Set(request.candidateIdentityKeys).size === request.candidateIdentityKeys.length, "Invalid frozen eligible candidate list.");
    const eligible = new Set(request.candidateIdentityKeys);
    for (const key of eligible) {
      const entry = entries.get(key); assert.ok(entry, "Eligible candidate is missing from the frozen pool.");
      assert.ok(key !== anchor.track.identityKey && entry.source.sourceSha256 !== anchor.source.sourceSha256
        && recordingGroup(entry.track) !== recordingGroup(anchor.track), "A request cannot retrieve its anchor recording.");
    }
    const matches = comparison.requests.filter(row => row.requestId === request.requestId);
    assert.equal(matches.length, 1, "Missing or duplicate comparison request."); const result = matches[0];
    assert.equal(result.anchorIdentityKey, request.anchorIdentityKey, "Comparison anchor changed.");
    assert.deepEqual(Object.keys(result.arms || {}).sort(), [...ARMS].sort(), "All four frozen comparison arms are required.");
    const nominations = new Map(), armCounts = {};
    for (const arm of ARMS) {
      const tracks = result.arms[arm]?.tracks;
      assert.ok(Array.isArray(tracks) && tracks.length <= 3, "Only actual bounded final-three tracks can be reviewed.");
      armCounts[arm] = tracks.length; const seen = new Set();
      tracks.forEach((selected, index) => {
        const track = storedTrack(selected?.track), entry = entries.get(track.identityKey);
        assert.ok(entry && eligible.has(track.identityKey), "Final selection is outside the request's frozen candidate pool.");
        assert.deepEqual(track, entry.track, "Final selection recording descriptor changed.");
        assert.ok(!seen.has(track.identityKey), "Duplicate final selection within an arm."); seen.add(track.identityKey);
        const list = nominations.get(track.identityKey) || []; list.push({ analyzer: arm, rank: index + 1 }); nominations.set(track.identityKey, list);
      });
    }
    const common = [...nominations].filter(([, list]) => list.length === ARMS.length).map(([key]) => key).sort();
    const differing = [...nominations].filter(([, list]) => list.length !== ARMS.length).sort(([a], [b]) => a.localeCompare(b));
    requests.push({ requestId: request.requestId, anchor, armCounts, common, differing });
  }
  assert.equal(new Set(comparison.requests.map(row => row.requestId)).size, requestIds.size, "Unexpected comparison request.");
  return { comparison, pool, entries, requests };
}
function clipFor(reference) {
  const [start, end] = reference.source.spans[0];
  const clip = { start, end, sourceSha256: reference.source.sourceSha256, sourceFile: reference.sourceFile,
    sourceType: "beatport-preview", sourceSnapshotKey: reference.source.snapshotKey };
  clip.clipId = hash(JSON.stringify([clip.sourceSha256, start, end, "pcm_s16le-mono-24000-v1"])); return clip;
}
function planIdentity(plan) {
  const frozen = clone(plan); delete frozen.planKey; delete frozen.preparationRequest; delete frozen.preparationRequestKey;
  for (const clip of Object.values(frozen.clips)) delete clip.wavSha256;
  return digest(frozen);
}
function shuffle(list) {
  const result = [...list]; for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
function buildCatalogScoutReviewPlan({ roundId, title = "Catalog scout listening comparison", comparison, pool } = {}, { artifactRoot = ROOT } = {}) {
  assert.ok(typeof roundId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(roundId), "Choose a stable scout round ID."); text(title, "review title", 120);
  const frozen = readFrozenArtifacts(comparison, pool, artifactRoot), clips = {}, groups = [];
  for (const request of frozen.requests) {
    if (!request.differing.length) continue;
    const anchorClip = clipFor(request.anchor); clips[anchorClip.clipId] = anchorClip;
    const candidates = shuffle(request.differing.map(([key, nominations]) => {
      const entry = frozen.entries.get(key), clip = clipFor(entry); clips[clip.clipId] ||= clip;
      return { track: entry.track, clipId: clip.clipId, nominations,
        reference: { verification: entry.verification, source: entry.source } };
    }));
    groups.push({ sessionId: `sonic-review:${randomUUID()}`, requestId: request.requestId, anchor: request.anchor.track,
      anchorReference: { verification: request.anchor.verification, source: request.anchor.source }, anchorClip: anchorClip.clipId,
      purpose: PURPOSE, candidates, commonCount: request.common.length, armCounts: request.armCounts });
  }
  if (!groups.length) return null;
  const plan = { version: 5, kind: KIND, batchId: `blind:${randomUUID()}`, roundId, createdAt: new Date().toISOString(), title,
    models: [...ARMS], count: groups.reduce((n, group) => n + group.candidates.length, 0), anchorCount: groups.length,
    comparison: clone(comparison), pool: clone(pool), recipe: clone(frozen.comparison.recipe), requestCount: frozen.requests.length,
    armSlots: Object.fromEntries(ARMS.map(arm => [arm, frozen.requests.reduce((n, request) => n + request.armCounts[arm], 0)])),
    excludedCommonPairs: frozen.requests.reduce((n, request) => n + request.common.length, 0), groups, clips,
    method: "Differing final selections only; common-to-all-four pairs omitted; shuffled once; no full-list quality rate." };
  plan.planKey = planIdentity(plan); validateCatalogScoutReviewPlan(plan, { artifactRoot }); return plan;
}
function validatePreparedWave(file, clip) {
  const stat = fs.statSync(file); assert.ok(stat.isFile() && stat.size >= 44 && stat.size <= 2 * 1024 * 1024, "A prepared bounded WAV is required.");
  const bytes = fs.readFileSync(file); assert.equal(hash(bytes), clip.wavSha256, "Prepared scout WAV changed.");
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF"); assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, "Invalid WAV byte length."); let format = null, samples = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    assert.ok(start + size <= bytes.length, "Truncated prepared WAV.");
    if (id === "fmt ") { assert.ok(size >= 16 && !format); format = [bytes.readUInt16LE(start), bytes.readUInt16LE(start + 2), bytes.readUInt32LE(start + 4), bytes.readUInt16LE(start + 14)]; }
    if (id === "data") { assert.ok(size % 2 === 0); samples += size / 2; } offset = start + size + size % 2;
  }
  assert.deepEqual(format, [1, 1, 24000, 16]);
  assert.ok(samples > 0 && Math.abs(samples - Math.round((clip.end - clip.start) * 24000)) <= 1, "Prepared WAV differs from its exact span.");
}
function assertFreshAnchors(plan, db) {
  for (const row of db.prepare("SELECT batch_id,private_plan_json FROM sonic_blind_review_batch").all()) {
    if (row.batch_id === plan.batchId) continue; const prior = JSON.parse(row.private_plan_json);
    for (const group of prior.groups || []) {
      const exposed = [group.anchor, ...(group.candidates || []).map(candidate => candidate.track)];
      const hashes = [prior.clips?.[group.anchorClip]?.sourceSha256, ...(group.candidates || []).map(candidate => prior.clips?.[candidate.clipId]?.sourceSha256)];
      for (const current of plan.groups) assert.ok(!exposed.some(track => track.identityKey === current.anchor.identityKey
        || recordingGroup(track) === recordingGroup(current.anchor)
        || track.isrc && current.anchor.isrc && String(track.isrc).toUpperCase() === String(current.anchor.isrc).toUpperCase())
        && !hashes.includes(plan.clips[current.anchorClip].sourceSha256),
      "Scout anchors must be unexposed exact recordings.");
    }
  }
}
function validateCatalogScoutReviewPlan(plan, { db, requirePrepared = false, cacheDirectory = path.join(ROOT, "data/sonic-blind-audio"), artifactRoot = ROOT } = {}) {
  fields(plan, ["version", "kind", "batchId", "roundId", "createdAt", "title", "models", "count", "anchorCount", "comparison", "pool", "recipe", "requestCount",
    "armSlots", "excludedCommonPairs", "groups", "clips", "method", "planKey", "preparationRequest", "preparationRequestKey"], "scout review plan");
  assert.equal(plan.version, 5); assert.equal(plan.kind, KIND); assert.deepEqual(plan.models, [...ARMS]);
  text(plan.batchId, "batch identity"); text(plan.title, "review title", 120);
  assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.roundId || "") && Number.isFinite(Date.parse(plan.createdAt)));
  const frozen = readFrozenArtifacts(plan.comparison, plan.pool, artifactRoot);
  assert.deepEqual(plan.recipe, frozen.comparison.recipe, "Frozen comparison recipe changed.");
  assert.deepEqual(plan.armSlots, Object.fromEntries(ARMS.map(arm => [arm, frozen.requests.reduce((n, request) => n + request.armCounts[arm], 0)])));
  assert.equal(plan.requestCount, frozen.requests.length); assert.equal(plan.excludedCommonPairs, frozen.requests.reduce((n, row) => n + row.common.length, 0));
  const expected = frozen.requests.filter(request => request.differing.length), used = new Set(), sessions = new Set();
  assert.ok(Array.isArray(plan.groups) && plan.groups.length > 0 && plan.groups.length === expected.length && plain(plan.clips));
  assert.equal(plan.anchorCount, plan.groups.length); let count = 0;
  plan.groups.forEach((group, index) => {
    fields(group, ["sessionId", "requestId", "anchor", "anchorReference", "anchorClip", "purpose", "candidates", "commonCount", "armCounts"], "scout review group");
    const request = expected[index]; assert.equal(group.requestId, request.requestId); assert.deepEqual(group.anchor, request.anchor.track);
    assert.deepEqual(group.anchorReference, { verification: request.anchor.verification, source: request.anchor.source });
    assert.equal(group.purpose, PURPOSE); assert.equal(group.commonCount, request.common.length); assert.deepEqual(group.armCounts, request.armCounts);
    text(group.sessionId, "session identity"); assert.ok(!sessions.has(group.sessionId)); sessions.add(group.sessionId);
    assert.ok(Array.isArray(group.candidates) && group.candidates.length === request.differing.length); const keys = new Set();
    const validateClip = (clipId, reference) => {
      const clip = plan.clips[clipId]; fields(clip, ["clipId", "start", "end", "sourceSha256", "sourceFile", "sourceType", "sourceSnapshotKey", "wavSha256"], "scout clip");
      const actual = { ...clip }; delete actual.wavSha256; assert.deepEqual(actual, clipFor(reference), "Exact catalog source or excerpt changed.");
      assert.equal(clipId, clip.clipId); assert.ok(clip.wavSha256 === undefined || isSha(clip.wavSha256)); used.add(clipId);
    };
    validateClip(group.anchorClip, request.anchor);
    for (const candidate of group.candidates) {
      fields(candidate, ["track", "clipId", "nominations", "reference"], "scout candidate");
      const key = candidate.track?.identityKey, nominations = request.differing.find(([identity]) => identity === key)?.[1];
      assert.ok(nominations && !keys.has(key), "Differing-only membership changed."); keys.add(key); const entry = frozen.entries.get(key);
      assert.deepEqual(candidate.track, entry.track, "Exact candidate descriptor changed."); assert.deepEqual(candidate.nominations, nominations, "Final arm ranks changed.");
      assert.deepEqual(candidate.reference, { verification: entry.verification, source: entry.source }); validateClip(candidate.clipId, entry); count++;
    }
  });
  assert.equal(plan.count, count); assert.ok(count <= 72); assert.deepEqual(Object.keys(plan.clips).sort(), [...used].sort());
  assert.equal(plan.planKey, planIdentity(plan), "Frozen scout review plan identity changed.");
  if (db) assertFreshAnchors(plan, db);
  if (requirePrepared) {
    assert.ok(db, "Publication requires the review-state freshness audit.");
    for (const entry of frozen.entries.values()) assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: fs.readFileSync(entry.sourceFile) });
    for (const clip of Object.values(plan.clips)) { assert.ok(isSha(clip.wavSha256), "All scout WAVs must be prepared before publication."); validatePreparedWave(path.join(cacheDirectory, `${clip.clipId}.wav`), clip); }
  }
  return true;
}
function completedScoutReport(plan, snapshot) {
  const invalid = snapshot.groups.flatMap(group => group.items).filter(item => item.review?.reviewer !== "human"
    || !["KEEP", "WRONG_LANE", "SKIP", "UNSURE"].includes(item.review?.decision) || item.review.decision !== "UNSURE" && item.review.listened !== true).length;
  if (invalid) return { ok: true, ready: false, remaining: invalid, kind: KIND, productionPromotionAllowed: false };
  const arms = ARMS.map(analyzer => {
    const decisions = { KEEP: 0, WRONG_LANE: 0, SKIP: 0, UNSURE: 0 };
    for (const [gi, group] of plan.groups.entries()) for (const [i, candidate] of group.candidates.entries())
      if (candidate.nominations.some(nomination => nomination.analyzer === analyzer)) decisions[snapshot.groups[gi].items[i].review.decision]++;
    return { analyzer, selectedSlots: plan.armSlots[analyzer], missingSlots: plan.requestCount * 3 - plan.armSlots[analyzer],
      omittedCommonNominations: plan.excludedCommonPairs, differingNominations: Object.values(decisions).reduce((n, value) => n + value, 0), decisions };
  });
  return { ok: true, ready: true, batchId: snapshot.batchId, kind: KIND, purpose: PURPOSE, comparisonScope: "differing-final-selections-only",
    requestCount: plan.requestCount, anchorCount: snapshot.anchorCount, decisions: snapshot.count, excludedCommonPairs: plan.excludedCommonPairs, arms,
    productionApplied: false, productionPromotionAllowed: false, globalRatingsChanged: false,
    notes: ["Only differing final selections were listened to; common-to-all-four selections were omitted.",
      "Arm counts describe this differing subset and cannot establish full-list acceptance rates or a held-out production gain.",
      "Shared pairs reuse one human judgment. Uncertainty remains unresolved; missing slots are not fabricated or scored as failures.",
      "Findings apply to these exact catalog previews and remain separate from global taste, ratings and queue behavior."] };
}
module.exports = { buildCatalogScoutReviewPlan, validateCatalogScoutReviewPlan, completedScoutReport, KIND, PURPOSE, ARMS };
