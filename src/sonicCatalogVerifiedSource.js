"use strict";

// Additive private source admission. Existing exact snapshots retain their v1
// implementation; v2 records one narrowly proved Original/unlabeled relation.
// No provider, filesystem, inference, database or playback operations occur here.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const original = require("./sonicCandidateCorpus");
const { scoreTidalIdentity } = require("./exactTrackVerification");
const { matchBeatportVersionToTidal } = require("./beatportVersionMatch");
const { normalizeCatalogText, normalizeArtistCreditNames, parseCanonicalCatalogIdentity,
  versionDescriptorFromTitle, classifyVersionText } = require("./catalogIdentityNormalization");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { validateStoredResult, createPrivateResultReceipt, readPrivateResultReceipt } = require("./sonicAnchorExperiment");

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const RELATION = "ORIGINAL_EQUIVALENT_TO_UNLABELED";
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function text(value, label) {
  assert.ok(typeof value === "string" && value.trim() && value.length <= 4096 && !/[\x00-\x1f]/.test(value), `Invalid verified source ${label}.`);
  return value.trim();
}
function date(value) {
  value = text(value, "release date"); assert.match(value, /^\d{4}-\d{2}-\d{2}$/, "An ISO calendar release date is required.");
  const parsed = new Date(value + "T00:00:00Z");
  assert.ok(Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, "Invalid ISO calendar release date.");
  return value;
}
function year(value) {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return undefined;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) value = Number(date(value).slice(0, 4));
  if (typeof value === "string" && /^\d{4}$/.test(value)) value = Number(value);
  assert.ok(Number.isInteger(value) && value >= 1000 && value <= 9999, "Invalid verified source year."); return value;
}
function rejectOverrides(input) {
  for (const key of ["artistAliases", "artistAliasSource", "strongIdentityOverrideApplied", "canonicalMainMixApplied", "allowVersionProxy"])
    assert.ok(input[key] === undefined || input[key] === false || Array.isArray(input[key]) && !input[key].length, "Artist aliases and identity overrides are not source proof.");
}
function artistCredits(input) {
  const names = normalizeArtistCreditNames(text(input.artist, "named artist credits")).sort();
  assert.ok(names.length, "Nonempty named artist credits are required.");
  if (input.artists !== undefined) {
    assert.ok(Array.isArray(input.artists) && input.artists.length > 0 && input.artists.length <= 50, "Invalid explicit artist credit array.");
    assert.deepEqual(normalizeArtistCreditNames(input.artists).sort(), names, "Explicit artist credits conflict with the named artist set.");
  }
  return names;
}
function canonicalTrack(input) {
  assert.ok(plain(input), "A canonical TIDAL track is required."); rejectOverrides(input); artistCredits(input);
  const identityKey = text(input.identityKey, "TIDAL identity"), id = identityKey.match(/^tidal:([1-9]\d*)$/)?.[1];
  assert.ok(id, "An exact canonical TIDAL identity is required.");
  const explicit = [];
  for (const part of [input, input.tidal].filter(Boolean)) {
    assert.ok(plain(part));
    if (part.identityKey !== undefined) assert.equal(part.identityKey, identityKey, "Conflicting canonical identity.");
    for (const key of ["id", "tidalId", "tidalTrackId", "trackId", "track_id"])
      if (part[key] !== undefined && part[key] !== null && part[key] !== "") explicit.push(String(part[key]));
    for (const key of ["tidalUrl", "tidal_url", "url"]) if (part[key]) {
      const value = text(part[key], "TIDAL URL");
      assert.match(value, /^https:\/\/(?:www\.)?(?:listen\.)?tidal\.com\/(?:browse\/)?track\/[1-9]\d*(?:[/?#]|$)/i);
      assert.equal(value.match(/\/track\/(\d+)/)?.[1], id, "Conflicting canonical TIDAL URL.");
    }
  }
  assert.ok(explicit.length && explicit.every(value => value === id), "Conflicting or missing explicit canonical TIDAL IDs.");
  const track = { identityKey, tidalId: id, artist: text(input.artist, "artist"), title: text(input.title, "title") };
  for (const key of ["mixVersion", "album", "isrc", "label", "releaseDate"]) if (input[key] !== undefined && input[key] !== "") track[key] = text(input[key], key);
  for (const key of ["mixName", "version", "remix"]) if (input[key] !== undefined && input[key] !== "") {
    assert.equal(classifyVersionText(input[key]).kind, "none", "A TIDAL equivalent source cannot have a version descriptor.");
    // An explicit unrecognised version is also unsafe for an unlabeled target.
    throw Error("A TIDAL equivalent source must remain unlabeled.");
  }
  if (input.durationMs !== undefined) { assert.ok(Number.isFinite(input.durationMs) && input.durationMs > 0); track.durationMs = input.durationMs; }
  const knownYear = year(input.year); if (knownYear !== undefined) track.year = knownYear;
  const bpIds = [input.beatportTrackId, input.beatportId, input.beatport?.id].filter(value => value !== undefined && value !== "").map(String);
  if (bpIds.length) { assert.ok(bpIds.every(value => /^[1-9]\d*$/.test(value) && value === bpIds[0]), "Conflicting explicit Beatport IDs."); track.beatportTrackId = bpIds[0]; }
  return track;
}
function providerTrack(input) {
  assert.ok(plain(input), "A Beatport source track is required."); rejectOverrides(input); artistCredits(input);
  const ids = [input.id, input.trackId, input.track_id, input.beatportTrackId, input.beatportId, input.beatport?.id,
    input.rawJson?.id, input.rawJson?.track_id, input.rawJson?.attributes?.id, input.rawJson?.attributes?.track_id]
    .filter(value => value !== undefined && value !== null && value !== "").map(String);
  assert.ok(ids.length && ids.every(value => /^[1-9]\d*$/.test(value) && value === ids[0]), "Conflicting or missing Beatport source IDs.");
  const out = { id: ids[0], artist: text(input.artist, "source artist"), title: text(input.title, "source title") };
  for (const key of ["mixName", "mixVersion", "version", "remix", "album", "isrc", "label", "releaseDate"])
    if (input[key] !== undefined && input[key] !== "") out[key] = text(input[key], "source " + key);
  if (input.durationMs !== undefined) { assert.ok(Number.isFinite(input.durationMs) && input.durationMs > 0); out.durationMs = input.durationMs; }
  const knownYear = year(input.year); if (knownYear !== undefined) out.year = knownYear;
  return out;
}
function normalizedIsrc(value) {
  value = text(value, "ISRC").replace(/[^a-z0-9]/gi, "").toUpperCase();
  assert.match(value, /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/, "A nonempty canonical ISRC is required."); return value;
}
function consistentVersions(input) {
  const identity = parseCanonicalCatalogIdentity(input), fromTitle = versionDescriptorFromTitle(input.title);
  for (const version of [fromTitle.explicit ? fromTitle : null,
    ...["mixVersion", "mixName", "version", "remix"].filter(key => input[key]).map(key => classifyVersionText(input[key]))].filter(Boolean))
    assert.ok(version.kind === identity.versionKind && version.semantic === identity.version.semantic
      && (version.kind !== "none" || version.normalized === identity.normalizedVersion), "Conflicting explicit source version fields.");
}
function equivalentAdmission(trackInput, providerInput) {
  const track = canonicalTrack(trackInput), sourceTrack = providerTrack(providerInput);
  const target = parseCanonicalCatalogIdentity(track), provider = parseCanonicalCatalogIdentity(sourceTrack);
  assert.equal(target.versionKind, "none", "Only an unlabeled TIDAL original is eligible.");
  assert.equal(target.normalizedVersion, "", "The TIDAL original must have no explicit version.");
  assert.equal(provider.versionKind, "original", "Only a Beatport Original Mix is eligible.");
  assert.equal(provider.version.semantic, "", "Named Original versions are not equivalent source proof.");
  for (const value of [sourceTrack.mixName, sourceTrack.mixVersion, sourceTrack.version, sourceTrack.remix].filter(Boolean))
    assert.match(normalizeCatalogText(value), /^original(?: mix| version)?$/, "All Beatport version fields must say Original.");
  const titleVersion = versionDescriptorFromTitle(sourceTrack.title);
  assert.ok(!titleVersion.explicit || titleVersion.kind === "original" && !titleVersion.semantic, "A conflicting Beatport title version is unsafe.");
  const artists = normalizeArtistCreditNames(track.artist).sort(), providerArtists = normalizeArtistCreditNames(sourceTrack.artist).sort();
  assert.ok(artists.length); assert.deepEqual(artists, providerArtists, "Full named artist credits must match without aliases or subsets.");
  assert.deepEqual(target.normalizedFeaturedArtists, provider.normalizedFeaturedArtists, "Featured credits must match exactly.");
  assert.ok(target.normalizedBaseTitle && target.normalizedBaseTitle === provider.normalizedBaseTitle, "Base titles must match exactly.");
  const isrc = normalizedIsrc(track.isrc); assert.equal(normalizedIsrc(sourceTrack.isrc), isrc, "ISRC conflict.");
  assert.ok(Number.isFinite(track.durationMs) && Number.isFinite(sourceTrack.durationMs), "Both recording durations are required.");
  const durationDeltaMs = Math.abs(track.durationMs - sourceTrack.durationMs);
  assert.ok(durationDeltaMs <= 1000, "Equivalent recording duration differs by more than 1000ms.");
  assert.ok(target.normalizedAlbumFamily && target.normalizedAlbumFamily === provider.normalizedAlbumFamily, "Canonical album families must agree.");
  const label = normalizeCatalogText(text(track.label, "label")); assert.ok(label && label === normalizeCatalogText(text(sourceTrack.label, "source label")), "Nonempty labels must agree.");
  const releaseDate = date(track.releaseDate); assert.equal(date(sourceTrack.releaseDate), releaseDate, "ISO release dates must agree.");
  const requested = { ...sourceTrack, mixVersion: sourceTrack.mixName || sourceTrack.mixVersion || sourceTrack.version || sourceTrack.remix,
    beatportTrackId: sourceTrack.id }; delete requested.id;
  const tidal = scoreTidalIdentity(requested, track);
  const beatport = matchBeatportVersionToTidal(track, sourceTrack, { allowVersionProxy: false, requestedBeatportTrackId: track.beatportTrackId || sourceTrack.id });
  assert.ok(tidal.matched && tidal.outcome === "VERIFIED_EQUIVALENT_RECORDING" && tidal.reasons.includes(RELATION)
    && ["exact-artist-set", "reordered-equivalent"].includes(tidal.artistRelation?.type) && !tidal.artistAliasApplied && !tidal.strongIdentityOverrideApplied && !tidal.canonicalMainMixApplied,
  "The existing TIDAL matcher must verify only the Original/unlabeled relation.");
  const diagnostics = beatport.diagnostics;
  assert.ok(beatport.matched && beatport.relation === "equivalent-recording" && diagnostics?.canonicalVersionRelation === RELATION
    && diagnostics.artistMatch && !diagnostics.artistAliasApplied && !diagnostics.strongIdentityOverrideApplied,
  "The existing Beatport matcher must verify the same relation with no proxy.");
  const proof = { version: 1, policy: "verified-original-unlabeled-v1", relation: RELATION, artistCredits: artists,
    normalizedBaseTitle: target.normalizedBaseTitle, isrc, durationDeltaMs, normalizedAlbumFamily: target.normalizedAlbumFamily,
    normalizedLabel: label, releaseDate,
    tidal: { matched: true, outcome: tidal.outcome, artistRelation: tidal.artistRelation.type, versionRelation: RELATION,
      isrcMatch: tidal.isrcMatch, albumFamilyAgreement: tidal.albumFamilyAgreement, labelAgreement: tidal.labelAgreement,
      releaseDateAgreement: tidal.releaseDateAgreement, strongIdentityOverrideApplied: false, artistAliasApplied: false, canonicalMainMixApplied: false },
    beatport: { matched: true, relation: beatport.relation, versionRelation: diagnostics.canonicalVersionRelation,
      isrcMatch: diagnostics.isrcMatch, albumFamilyAgreement: diagnostics.albumFamilyAgreement, labelAgreement: diagnostics.labelMatch,
      releaseDateAgreement: diagnostics.releaseDateMatch, beatportTrackId: sourceTrack.id, strongIdentityOverrideApplied: false, artistAliasApplied: false,
      allowVersionProxy: false } };
  return { track, sourceTrack, proof };
}
function admissionFor(track, sourceTrack) {
  // Delegate the exact branch to precisely the old source normalisation and
  // matcher, without extending its accepted identities or changing its output.
  try {
    consistentVersions(track); consistentVersions(sourceTrack); artistCredits(track); artistCredits(sourceTrack);
    const exact = original.freezeSonicSourceSnapshot({ track, sourceTrack, sourceType: "beatport-preview", allowVersionProxy: false,
      audioBytes: new Uint8Array([0]), durationSeconds: 30 });
    const requested = { ...exact.sourceTrack, mixVersion: exact.sourceTrack.mixName || exact.sourceTrack.mixVersion,
      beatportTrackId: exact.sourceTrack.id }; delete requested.id;
    const tidal = scoreTidalIdentity(requested, track);
    assert.ok(tidal.matched && ["VERIFIED_EXACT", "VERIFIED_EQUIVALENT_RECORDING"].includes(tidal.outcome)
      && !tidal.strongIdentityOverrideApplied && !tidal.artistAliasApplied && !tidal.canonicalMainMixApplied
      && tidal.isrcMatch !== false && ["exact-artist-set", "reordered-equivalent"].includes(tidal.artistRelation?.type),
    "New exact-source admission requires a non-proxy TIDAL match without identity overrides.");
    return freeze({ accepted: true, reason: "strict-exact", version: 1, identityRelation: "exact", proof: null });
  } catch { /* Only the narrowly proved relation may use a new source version. */ }
  try {
    const checked = equivalentAdmission(track, sourceTrack);
    return freeze({ accepted: true, reason: "verified-original-unlabeled", version: 2, identityRelation: "equivalent-recording", proof: checked.proof });
  } catch (error) {
    return freeze({ accepted: false, reason: "source-identity-rejected", version: null, identityRelation: "rejected", proof: null,
      rejection: error.message.split("\n")[0].slice(0, 300) });
  }
}
function centeredSpans(durationSeconds) {
  assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 7200, "Verified preview duration must be from 30 to 7200 seconds.");
  const start = Math.round((durationSeconds - 30) / 2 * 1e6) / 1e6;
  return [[start, Math.round((start + 30) * 1e6) / 1e6]];
}
function v2Body(input) {
  assert.equal(input.sourceType, "beatport-preview", "Equivalent sources require Beatport preview bytes.");
  assert.equal(input.allowVersionProxy, false, "Version proxies cannot be frozen.");
  assert.ok(input.localFileId === undefined && input.linkStatus === undefined, "Preview source cannot carry local source proof.");
  const checked = equivalentAdmission(input.track, input.sourceTrack), spans = centeredSpans(input.durationSeconds);
  assert.ok(/^[a-f0-9]{64}$/.test(input.sourceSha256 || "") && Number.isInteger(input.byteLength) && input.byteLength > 0 && input.byteLength <= MAX_SOURCE_BYTES,
    "Invalid original preview hash or bounded size.");
  assert.ok(Array.isArray(input.spans) && input.spans.length === 1 && Array.isArray(input.spans[0]) && input.spans[0].length === 2
    && input.spans[0].every((value, i) => Number.isFinite(value) && Math.abs(value - spans[0][i]) <= .000001), "The original centered 30s span changed.");
  const track = checked.track;
  return { version: 2, identityKey: track.identityKey, recordingDescriptor: { identityKey: track.identityKey, artist: track.artist,
    title: track.title, mixVersion: track.mixVersion || "", isrc: track.isrc || "", durationMs: track.durationMs },
    canonicalTrack: track, sourceType: "beatport-preview", sourceSha256: input.sourceSha256, byteLength: input.byteLength,
    durationSeconds: input.durationSeconds, spans, canonicalProvider: "tidal", canonicalTrackId: track.tidalId,
    sourceProvider: "beatport", sourceTrackId: checked.sourceTrack.id, sourceTrack: checked.sourceTrack,
    identityRelation: "equivalent-recording", allowVersionProxy: false, partialPreview: true, equivalenceProof: checked.proof };
}
function freezeSonicSourceSnapshot(input = {}) {
  const admission = input.sourceType === "beatport-preview" ? admissionFor(input.track, input.sourceTrack) : null;
  if (!admission || admission.accepted && admission.version === 1) return original.freezeSonicSourceSnapshot(input);
  assert.ok(admission.accepted, "No verified source identity admission.");
  const allowed = ["track", "sourceType", "audioBytes", "durationSeconds", "sourceTrack", "allowVersionProxy", "spans"];
  assert.ok(plain(input) && Object.keys(input).every(key => allowed.includes(key)), "Invalid equivalent source input fields.");
  assert.ok(input.audioBytes instanceof Uint8Array && input.audioBytes.byteLength > 0 && input.audioBytes.byteLength <= MAX_SOURCE_BYTES, "Original bounded audio bytes are required.");
  const body = v2Body({ ...input, sourceSha256: hash(input.audioBytes), byteLength: input.audioBytes.byteLength,
    spans: input.spans === undefined ? centeredSpans(input.durationSeconds) : input.spans });
  return freeze({ ...body, snapshotKey: `sonic-source-v2-${hash(json(body))}` });
}
function assertSonicSourceSnapshot(snapshot, { track, audioBytes } = {}) {
  if (snapshot?.version === 1) return original.assertSonicSourceSnapshot(snapshot, { track, audioBytes });
  assert.ok(plain(snapshot) && snapshot.version === 2, "A frozen verified source v1 or v2 is required.");
  const body = v2Body({ ...snapshot, track });
  assert.equal(json(snapshot.canonicalTrack), json(body.canonicalTrack), "Canonical recording evidence changed.");
  assert.equal(snapshot.snapshotKey, `sonic-source-v2-${hash(json(body))}`, "The verified source snapshot proof changed.");
  assert.equal(json(snapshot), json({ ...body, snapshotKey: snapshot.snapshotKey }), "Verified source fields or proof changed.");
  if (audioBytes !== undefined) assert.ok(audioBytes instanceof Uint8Array && audioBytes.byteLength === snapshot.byteLength
    && hash(audioBytes) === snapshot.sourceSha256, "Original preview bytes changed.");
  return true;
}
function validateReceiptSource(source, spec) {
  assert.deepEqual(spec, analysisSpec(spec?.id), "A pinned registered MERT specification is required.");
  assert.ok(["mert-fullsong", "mert-30s"].includes(spec.id));
  assertSonicSourceSnapshot(source, { track: source?.canonicalTrack });
}
function createVerifiedResultReceipt(result, spec, source) {
  if (source?.version === 1) return createPrivateResultReceipt(result, spec, source);
  validateReceiptSource(source, spec); validateStoredResult(result, spec, source);
  return { version: 1, sourceSnapshotKey: source.snapshotKey, sourceSha256: source.sourceSha256,
    specKey: spec.key, revision: spec.revision, resultSha256: hash(JSON.stringify(result)), result: clone(result) };
}
function readVerifiedResultReceipt(receipt, spec, source) {
  if (source?.version === 1) return readPrivateResultReceipt(receipt, spec, source);
  validateReceiptSource(source, spec);
  assert.ok(plain(receipt) && Object.keys(receipt).every(key => ["version", "sourceSnapshotKey", "sourceSha256", "specKey", "revision", "resultSha256", "result"].includes(key)), "Invalid typed source result receipt fields.");
  assert.equal(receipt.version, 1); assert.equal(receipt.sourceSnapshotKey, source.snapshotKey, "Result source snapshot changed.");
  assert.equal(receipt.sourceSha256, source.sourceSha256, "Result audio source changed.");
  assert.equal(receipt.specKey, spec.key); assert.equal(receipt.revision, spec.revision);
  assert.equal(receipt.resultSha256, hash(JSON.stringify(receipt.result)), "Result content changed.");
  validateStoredResult(receipt.result, spec, source); return receipt.result;
}

module.exports = { MAX_SOURCE_BYTES, RELATION, admissionFor, freezeSonicSourceSnapshot, assertSonicSourceSnapshot,
  freezeVerifiedSonicSourceSnapshot: freezeSonicSourceSnapshot, assertVerifiedSonicSourceSnapshot: assertSonicSourceSnapshot,
  createVerifiedResultReceipt, readVerifiedResultReceipt };
