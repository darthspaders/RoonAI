"use strict";

// Pure catalog retrieval. Source acquisition, inference, cache writes and final
// discovery policy belong to the caller; this module never queues playback.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { assertSonicSourceSnapshot } = require("./sonicCatalogVerifiedSource");
const { normalizeVector } = require("./sonicEmbeddingStore");
const { storedRankings } = require("./sonicEnsembleEvaluation");
const { fuseSonicRankings } = require("./sonicEnsemble");

const MODELS = Object.freeze(["mert-fullsong", "mert-30s"]);
const SELECTORS = Object.freeze([...MODELS, "ensemble"]);
const MAX_POOL = 100, MAX_SCOUTS = 20;
const INTERNAL_KEYS = new Set(["file", "filepath", "sourcefile", "sourcepath", "audiopath", "audiobytes", "analysislocal",
  "sourcesha256", "sourcesnapshotkey", "snapshotkey", "receipt", "result", "resultsha256",
  "vector", "embedding", "embeddingbase64", "review", "reviews", "reviewnote", "reviewer", "judgment", "judgments",
  "decision", "rating", "feedback", "listened", "nominations", "sonicscout", "recommendationv2", "score", "scorebreakdown",
  "token", "accesstoken", "refreshtoken", "secret", "authorization", "cookie"]);
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function boundedInteger(value, fallback, maximum, name) {
  value = value === undefined ? fallback : value;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Catalog scout ${name} must be an integer from 1 to ${maximum}.`);
  return value;
}
function metadataView(value, depth = 0) {
  if (depth > 8) throw new Error("Catalog scout metadata nesting exceeds its bound.");
  if (typeof value === "string") {
    if (value.length > 8192) throw new Error("Catalog scout metadata text exceeds its bound.");
    return /^(?:[a-z]:[\\/]|\\\\|\/(?:mnt|home|users|tmp|var|etc|usr)\/)/i.test(value) || /^[a-f0-9]{64}$/i.test(value) ? undefined : value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Catalog scout metadata must be finite.");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error("Catalog scout metadata arrays exceed their bound.");
    return value.map(item => metadataView(item, depth + 1)).filter(item => item !== undefined);
  }
  if (plain(value)) {
    if (Object.keys(value).length > 128) throw new Error("Catalog scout metadata fields exceed their bound.");
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (INTERNAL_KEYS.has(normalizedKey) || ["source", "provenance"].includes(normalizedKey) && typeof item !== "string"
        || key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const copied = metadataView(item, depth + 1);
      if (copied !== undefined) out[key] = copied;
    }
    return out;
  }
  if (value === undefined) return undefined;
  throw new Error("Catalog scout metadata must contain JSON values only.");
}
function trackView(input) {
  if (!plain(input) || typeof input.identityKey !== "string" || !/^(?:tidal|text|isrc|roon|file):.+$/.test(input.identityKey)
    || input.identityKey.length > 4096 || !input.artist || !input.title) throw new Error("Catalog scouts require an exact typed recording identity and musical names.");
  const out = metadataView(input);
  for (const field of ["identityKey", "artist", "title", "mixVersion", "album", "isrc", "genre", "subgenre", "label"])
    if (out[field] !== undefined && (typeof out[field] !== "string" || out[field].length > 4096)) throw new Error("Invalid catalog scout musical metadata.");
  if (Buffer.byteLength(JSON.stringify(out)) > 32768) throw new Error("Catalog scout metadata exceeds its bounded size.");
  return out;
}
function descriptor(track) {
  return { identityKey: track.identityKey, tidalId: String(track.tidalId || ""), artist: track.artist, title: track.title,
    mixVersion: track.mixVersion || "", isrc: track.isrc || "", durationMs: track.durationMs ?? null };
}
function sameVersion(left, right) {
  return recordingGroup(left) === recordingGroup(right)
    && (!left.isrc || !right.isrc || left.isrc.toUpperCase() === right.isrc.toUpperCase());
}
function catalogItem(input) {
  if (!plain(input)) throw new Error("Invalid frozen catalog scout item.");
  const track = trackView(input.track), verification = input.verification;
  if (!/^tidal:[1-9]\d*$/.test(track.identityKey) || !plain(verification) || verification.provider !== "tidal"
    || verification.verified !== true || verification.identityKey !== track.identityKey)
    throw new Error("Catalog scouts require exact verified TIDAL candidates.");
  assert.deepEqual(descriptor(trackView(verification.canonicalTrack)), descriptor(track), "Catalog scout canonical recording changed.");
  assertSonicSourceSnapshot(input.source, { track });
  return { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) },
    source: clone(input.source), recordingGroup: recordingGroup(track) };
}
function poolBody(items) { return { version: 1, kind: "frozen-catalog-scout-pool", items }; }
function freezeSonicCatalogScoutPool({ items } = {}) {
  if (!Array.isArray(items) || items.length > MAX_POOL) throw new Error("Catalog scout pools accept at most 100 explicit candidates.");
  const validated = items.map(catalogItem).sort((a, b) => a.track.identityKey.localeCompare(b.track.identityKey)
    || a.source.snapshotKey.localeCompare(b.source.snapshotKey));
  const identities = new Map(), sources = new Map(), groups = new Set(), accepted = [], duplicates = [];
  for (const item of validated) {
    const key = item.track.identityKey, previous = identities.get(key), sameSource = sources.get(item.source.sourceSha256);
    if (previous) {
      assert.deepEqual(previous, item, "Conflicting frozen catalog scout identity or source.");
      duplicates.push({ identityKey: key, reason: "duplicate-identity" }); continue;
    }
    if (sameSource && (!sameVersion(sameSource.track, item.track)
      || JSON.stringify(sameSource.source.spans) !== JSON.stringify(item.source.spans)))
      throw new Error("One catalog audio source cannot represent conflicting versions or excerpts.");
    identities.set(key, item);
    if (sameSource || groups.has(item.recordingGroup)) {
      duplicates.push({ identityKey: key, reason: sameSource ? "duplicate-source-recording" : "duplicate-recording-group" }); continue;
    }
    sources.set(item.source.sourceSha256, item); groups.add(item.recordingGroup); accepted.push(item);
  }
  const body = poolBody(accepted);
  return freeze({ ...body, poolKey: `sonic-catalog-scout-pool-v1-${digest(body)}`,
    diagnostics: { inputCount: items.length, count: accepted.length, duplicates } });
}
function assertPool(pool) {
  if (!plain(pool) || pool.version !== 1 || pool.kind !== "frozen-catalog-scout-pool" || !Array.isArray(pool.items))
    throw new Error("A frozen catalog scout pool is required.");
  const checked = freezeSonicCatalogScoutPool({ items: pool.items });
  assert.equal(pool.poolKey, checked.poolKey, "Frozen catalog scout pool changed.");
  assert.deepEqual(pool.items, checked.items, "Frozen catalog scout order or descriptors changed.");
  return checked;
}
function anchorView(anchor) {
  if (!plain(anchor)) throw new Error("A frozen catalog scout anchor is required.");
  const track = trackView(anchor.track), source = plain(anchor.source) ? clone(anchor.source) : null;
  if (!plain(source) || !/^[a-f0-9]{64}$/.test(source.sourceSha256 || "")
    || !["beatport-preview", "verified-local-file"].includes(source.sourceType)
    || !Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0 || source.durationSeconds > 7200
    || !Array.isArray(source.spans) || source.spans.length !== 1 || !Array.isArray(source.spans[0]) || source.spans[0].length !== 2
    || source.spans[0].some(value => !Number.isFinite(value)) || source.spans[0][0] < 0 || source.spans[0][1] <= source.spans[0][0]
    || source.spans[0][1] > source.durationSeconds + .000002 || source.spans[0][1] - source.spans[0][0] > 30.000002)
    throw new Error("Catalog scout anchor needs exact original-source and excerpt evidence.");
  if (source.snapshotKey) assertSonicSourceSnapshot(source, { track });
  else if (source.sourceType !== "verified-local-file" || !/^(?:text|isrc|roon|file):/.test(track.identityKey))
    throw new Error("Catalog preview anchors require a frozen source snapshot.");
  return { track, source };
}
function validatedRecord(record, item, spec) {
  if (!plain(record) || record.identityKey !== item.track.identityKey || record.analyzer !== spec.id || record.repo !== spec.repo
    || record.specKey !== spec.key || record.revision !== spec.revision || record.sampleRate !== spec.sampleRate
    || record.dimensions !== spec.dimensions || record.sourceSha256 !== item.source.sourceSha256
    || record.sourceSnapshotKey !== item.source.snapshotKey || JSON.stringify(record.spans) !== JSON.stringify(item.source.spans))
    throw new Error("Catalog scout model record has mismatched identity, repository/specification, source or excerpt provenance.");
  if (!Array.isArray(record.vector) || record.vector.length !== spec.dimensions || !record.vector.every(Number.isFinite))
    throw new Error("Catalog scout model record requires a finite exact-dimension embedding.");
  const vector = normalizeVector(record.vector);
  if (vector.length !== spec.dimensions) throw new Error("Catalog scout model record cannot contain a zero embedding.");
  return { vector, evidence: { sourceSha256: item.source.sourceSha256, spans: clone(item.source.spans) } };
}
function selectionConfig(options) {
  if (!plain(options) || Object.keys(options).some(key => !["anchor", "pool", "matrices", "selector", "mode", "scoutCount", "finalCount", "agreementWeight"].includes(key)))
    throw new Error("Invalid catalog scout options.");
  const selector = options.selector ?? "mert-30s", mode = options.mode ?? "off";
  if (!SELECTORS.includes(selector) || !["off", "observe"].includes(mode)) throw new Error("Choose a supported catalog scout selector and off/observe mode.");
  const scoutCount = boundedInteger(options.scoutCount, 6, MAX_SCOUTS, "count"), finalCount = boundedInteger(options.finalCount, 3, MAX_SCOUTS, "final count");
  if (finalCount > scoutCount) throw new Error("Catalog scout final count cannot exceed scout count.");
  const agreementWeight = options.agreementWeight ?? 0;
  if (!Number.isFinite(agreementWeight) || agreementWeight < 0 || agreementWeight > .1 || selector !== "ensemble" && agreementWeight !== 0)
    throw new Error("Catalog scout agreement weight must be bounded from 0 to 0.1 and applies only to ensemble selection.");
  return { selector, mode, scoutCount, finalCount, agreementWeight };
}
function buildSonicCatalogScouts(options = {}) {
  const configuration = selectionConfig(options), { selector, mode, scoutCount, finalCount, agreementWeight } = configuration;
  const empty = reason => ({ version: 1, ...configuration, scouts: [], modelLists: [],
    diagnostics: { mode, selector, reason, neutral: true, fallback: true, productionApplied: false, requestedScoutCount: scoutCount,
      requestedFinalCount: finalCount, returnedScoutCount: 0 }, productionApplied: false, productionPromotionAllowed: false, queueable: false });
  if (mode === "off") return empty("mode-off");
  const anchor = anchorView(options.anchor), pool = assertPool(options.pool), matrices = options.matrices;
  if (!(matrices instanceof Map) || matrices.size > MODELS.length || [...matrices.keys()].some(id => !MODELS.includes(id)))
    throw new Error("Catalog scouts require separate supported model matrices.");
  const normalized = new Map(), missingByModel = [];
  for (const id of MODELS) {
    const spec = analysisSpec(id), matrix = matrices.get(id), records = new Map();
    if (matrix) {
      assert.deepEqual(matrix.spec, spec, "Catalog scout matrix specification changed.");
      if (!(matrix.records instanceof Map) || matrix.records.size > MAX_POOL + 1)
        throw new Error("Catalog scout matrices require bounded exact identity maps.");
      const allowed = new Map([[anchor.track.identityKey, anchor], ...pool.items.map(item => [item.track.identityKey, item])]);
      // A candidate with the anchor's identity must not replace its source proof.
      allowed.set(anchor.track.identityKey, anchor);
      for (const [key, record] of matrix.records) {
        if (!allowed.has(key)) throw new Error("Catalog scout model record lies outside the frozen pool and anchor.");
        records.set(key, validatedRecord(record, allowed.get(key), spec));
      }
    }
    normalized.set(id, { spec, records });
    missingByModel.push({ analyzer: id, repo: spec.repo, specKey: spec.key, anchorAvailable: records.has(anchor.track.identityKey),
      missingCandidateCount: pool.items.filter(item => !records.has(item.track.identityKey)).length });
  }
  const anchorGroup = recordingGroup(anchor.track);
  const eligible = pool.items.filter(item => item.track.identityKey !== anchor.track.identityKey
    && item.recordingGroup !== anchorGroup && item.source.sourceSha256 !== anchor.source.sourceSha256);
  const manifest = { items: [{ track: anchor.track, recordingGroup: anchorGroup }, ...eligible] };
  const lists = storedRankings(manifest, normalized, anchor.track, scoutCount);
  const outputLists = lists.map(list => ({ analyzer: list.analyzer, repo: analysisSpec(list.analyzer).repo, specKey: list.specKey,
    status: list.status, candidates: list.candidates.map(({ track, rank, similarity }) => ({ track: trackView(pool.items.find(item => item.track.identityKey === track.identityKey).track), rank, similarity })) }));
  let nominations;
  if (selector === "ensemble") {
    nominations = fuseSonicRankings({ anchor: anchor.track, lists, count: scoutCount, agreementWeight }).candidates;
  } else {
    const list = lists.find(item => item.analyzer === selector);
    nominations = list.candidates.map(item => ({ track: item.track,
      nominations: [{ analyzer: selector, specKey: list.specKey, identityKey: item.track.identityKey, rank: item.rank, similarity: item.similarity }],
      baseRankScore: 1 / item.rank, agreement: false, agreementBonus: 0, ensembleScore: 1 / item.rank }));
  }
  const scouts = nominations.map(entry => ({ ...trackView(pool.items.find(item => item.track.identityKey === entry.track.identityKey).track),
    sonicScout: { selector, nominations: clone(entry.nominations), baseRankScore: entry.baseRankScore, agreement: entry.agreement,
      agreementBonus: entry.agreementBonus, rankScore: entry.ensembleScore, shadowOnly: true, queueable: false } }));
  const selectedModels = selector === "ensemble" ? missingByModel : missingByModel.filter(item => item.analyzer === selector);
  const partialCoverage = selectedModels.some(item => !item.anchorAvailable || item.missingCandidateCount);
  const fallback = !scouts.length || partialCoverage;
  return { version: 1, ...configuration, poolKey: pool.poolKey, anchor: trackView(anchor.track), scouts, modelLists: outputLists,
    diagnostics: { mode, selector, reason: !eligible.length ? "no-eligible-catalog-candidates" : !scouts.length ? "no-selected-model-coverage" : partialCoverage ? "partial-model-coverage" : "catalog-scouts-computed", neutral: !scouts.length,
      fallback, productionApplied: false, poolCount: pool.items.length, eligiblePoolCount: eligible.length,
      excludedSelfCount: pool.items.length - eligible.length, duplicateCount: pool.diagnostics?.duplicates?.length || 0,
      requestedScoutCount: scoutCount, requestedFinalCount: finalCount, returnedScoutCount: scouts.length,
      missingCoverage: missingByModel, partialCoverage, missingCoverageIsNegative: false,
      singleModelFallback: selector === "ensemble" && lists.filter(item => item.status === "available").length === 1,
      agreementWeight, vectorSpacesMixed: false, sourcePathsExposed: false },
    productionApplied: false, productionPromotionAllowed: false, queueable: false };
}
function evaluateSonicCatalogScouts(options = {}, { finalizeCandidates } = {}) {
  const result = buildSonicCatalogScouts(options);
  if (!result.scouts.length) return { ...result, finalized: null };
  if (typeof finalizeCandidates !== "function") throw new Error("Catalog scout evaluation requires the actual shared discovery finalizer.");
  const finalized = finalizeCandidates(clone(result.scouts), { selector: result.selector, anchor: clone(result.anchor), requestedCount: result.finalCount });
  if (!plain(finalized) || !Array.isArray(finalized.tracks) || finalized.tracks.length > result.finalCount)
    throw new Error("Shared discovery finalizer returned an invalid or oversized shortlist.");
  const allowed = new Map(result.scouts.map(track => [track.identityKey, track])), identities = new Set();
  for (const track of finalized.tracks) {
    if (!plain(track) || !allowed.has(track.identityKey) || identities.has(track.identityKey))
      throw new Error("Shared discovery finalizer returned an unknown or duplicate scout identity.");
    assert.deepEqual(descriptor(track), descriptor(allowed.get(track.identityKey)), "Shared discovery finalizer changed the exact scout recording.");
    identities.add(track.identityKey);
  }
  return { ...result, finalized: clone(finalized) };
}

module.exports = { MODELS, SELECTORS, MAX_POOL, MAX_SCOUTS, freezeSonicCatalogScoutPool, buildSonicCatalogScouts, evaluateSonicCatalogScouts };
