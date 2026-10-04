"use strict";

// A review artifact, deliberately without --apply, migration, or write connection.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { readSnapshot, buildReport } = require("./audit-recording-duplicates");
const { readReleaseEvidence, releaseEvidence, buildSourceInventory } = require("./audit-release-identities");
const { recordingEvidence, releaseEvidence: compareReleases } = require("../src/canonicalMatching");
const { captureTidalEvidence } = require("../src/providerSourceEvidence");

const RULESET = "canonical-proposals-2026-09-18-v1";
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const uniq = values => [...new Set(values.filter(Boolean))];
const tally = values => values.reduce((result, value) => (result[value] = (result[value] || 0) + 1, result), {});
const parse = value => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
const hasTable = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const BASIS_TABLES = ["track_identity", "beatport_enrichment", "provider_enrichment", "track_identity_alias", "track_observation", "taste_feedback", "sonic_coverage_work", "canonical_source_object", "canonical_source_snapshot", "canonical_artwork_repair", "canonical_recording_link", "canonical_release_link", "canonical_membership_link"];
const CODE_FILES = [__filename, require.resolve("./audit-recording-duplicates"), require.resolve("./audit-release-identities"), require.resolve("../src/canonicalMatching"), require.resolve("../src/catalogIdentityNormalization"), require.resolve("../src/artistIdentity"), require.resolve("../src/providerSourceEvidence"), require.resolve("../src/databaseBrowserCatalog")];

function basis(db) {
  const tables = {};
  for (const table of BASIS_TABLES) {
    if (!hasTable(db, table)) { tables[table] = null; continue; }
    const digest = createHash("sha256");
    let count = 0;
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) { digest.update(JSON.stringify(row) + "\n"); count++; }
    tables[table] = { count, hash: digest.digest("hex") };
  }
  const code = Object.fromEntries(CODE_FILES.map(file => [path.basename(file), hash(fs.readFileSync(file, "utf8"))]));
  return { tables, code, fingerprint: hash({ tables, code }) };
}

function collectExtra(db) {
  const releases = readReleaseEvidence(db);
  const sourceEvidence = [];
  // Preserve future nested adapter evidence without exposing it to legacy grouping.
  for (const row of db.prepare("SELECT id,track_identity_id,raw_json,fetched_at FROM provider_enrichment ORDER BY id").iterate()) {
    for (const evidence of parse(row.raw_json).sourceEvidence || []) sourceEvidence.push({ rowId: row.track_identity_id, table: "provider_enrichment", snapshotId: row.id, at: row.fetched_at, evidence });
  }
  if (hasTable(db, "canonical_source_snapshot")) {
    for (const row of db.prepare("SELECT s.*,o.provider,o.kind FROM canonical_source_snapshot s JOIN canonical_source_object o ON o.id=s.source_id ORDER BY s.id").iterate()) {
      const raw = parse(row.raw_json);
      if (row.provider !== "tidal" || row.kind !== "track" || !raw.data) continue;
      const albumRef = raw.data.relationships?.albums?.data?.[0];
      const album = (raw.included || []).find(item => item.type === "albums" && String(item.id) === String(albumRef?.id)) || {};
      const legacy = row.legacy_table === "provider_enrichment" ? db.prepare("SELECT track_identity_id FROM provider_enrichment WHERE id=?").get(row.legacy_row_key) : null;
      sourceEvidence.push({ rowId: legacy?.track_identity_id || null, table: "canonical_source_snapshot", snapshotId: row.id, at: row.retrieved_at, evidence: captureTidalEvidence(raw.data, album, raw) });
    }
  }
  for (const source of sourceEvidence) {
    const evidence = source.evidence, release = evidence.release;
    if (!release?.id || !source.rowId || !["tidal", "beatport", "musicbrainz", "discogs"].includes(evidence.provider)) continue;
    const claim = releaseEvidence({ track_identity_id: source.rowId, provider_track_id: evidence.providerTrackId || evidence.recordingId, release_id: release.id, release_title: release.title, release_date: release.releaseDate, fetched_at: source.at, raw_json: JSON.stringify({ album: { id: release.id, title: release.title, artists: release.credits, numberOfTracks: release.trackCount }, albumArtist: (release.credits || []).map(c => c.name).filter(Boolean).join(", ") }) }, evidence.provider, source.table);
    Object.assign(claim, { snapshotId: source.snapshotId, explicitMembership: evidence.membership, originalReleaseDate: release.originalReleaseDate, sourceAmbiguities: evidence.ambiguities || [] });
    releases.evidence.push(claim);
  }
  return { releases, sourceEvidence, basis: basis(db) };
}

function recordingProposal(pair, byId) {
  const left = byId.get(pair.a), right = byId.get(pair.b);
  const strict = recordingEvidence(left.primary, right.primary);
  const conflicts = uniq([...left.conflicts, ...right.conflicts, ...strict.conflicts]);
  const priorPositive = ["exact_duplicate", "different_release"].includes(pair.category);
  const assessment = conflicts.length ? "BLOCKED_CONFLICT" : priorPositive && !strict.unknown.length ? "READY_FOR_REVIEW" : "NEEDS_EVIDENCE";
  return {
    id: `recording:${hash([RULESET, pair.a, pair.b]).slice(0, 24)}`, kind: "recording-equivalence", state: "PROPOSED", assessment,
    sourceRows: [pair.a, pair.b], canonicalTargetId: null, automaticVerificationAllowed: false,
    retrievalReasons: pair.candidateReasons, evidence: pair.evidence, conflicts,
    missingEvidence: strict.unknown, auditAssessment: pair.category, strictEvidence: strict,
    reason: conflicts.length ? "Reconcile source contradictions before any assignment." : "Pairwise review only; no transitive grouping or recording UUID has been created."
  };
}

function releaseFact(release) {
  const one = values => values?.length === 1 ? values[0] : "";
  return { provider: release.provider, providerReleaseId: release.providerReleaseId, title: one(release.titles), artist: one(release.primaryArtistCredits),
    releaseType: one(release.releaseTypes), edition: release.editionMarkers.join(" / "), releaseDate: one(release.releaseDates), format: one(release.formats),
    label: one(release.labels), catalogNumber: one(release.catalogNumbers), upc: one(release.barcodes), completeTracklist: false };
}

function buildProposals(snapshot) {
  const audit = buildReport(snapshot), byId = new Map(audit.records.map(record => [record.id, record]));
  const recordings = audit.pairs.map(pair => recordingProposal(pair, byId));
  const inventory = buildSourceInventory(snapshot.extra.releases.evidence);
  const releaseByKey = new Map(inventory.releases.map(release => [release.key, release]));
  const releasePairs = new Map();
  const releaseBlocks = inventory.groups.map(group => group.sourceReleaseKeys);
  const identifiers = new Map();
  for (const release of inventory.releases) {
    const keys = [...release.barcodes.map(value => `upc:${value}`), ...release.catalogNumbers.flatMap(number => release.labels.map(label => `catalog:${label.toLowerCase()}:${number.toLowerCase()}`))];
    for (const key of keys) { if (!identifiers.has(key)) identifiers.set(key, new Set()); identifiers.get(key).add(release.key); }
  }
  releaseBlocks.push(...[...identifiers.values()].map(keys => [...keys]));
  for (const block of releaseBlocks) {
    const keys = [...block].sort();
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) releasePairs.set(JSON.stringify([keys[i], keys[j]]), [keys[i], keys[j]]);
  }
  const releases = [...releasePairs.values()].map(([a, b]) => {
    const evidence = compareReleases(releaseFact(releaseByKey.get(a)), releaseFact(releaseByKey.get(b)));
    return { id: `release:${hash([RULESET, a, b]).slice(0, 24)}`, kind: "release-equivalence", state: "PROPOSED", sourceReleaseKeys: [a, b], canonicalTargetId: null,
      assessment: evidence.conflicts.length ? "BLOCKED_CONFLICT" : "NEEDS_EVIDENCE", automaticVerificationAllowed: false, evidence,
      reason: "Shared title-family is retrieval only. Cached textual tracklists are not verified ordered recording memberships." };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const memberships = snapshot.extra.releases.evidence.filter(claim => claim.releaseId).map(claim => ({
    id: `membership:${hash([claim.slot, claim.rowId, claim.provider, claim.providerTrackId, claim.releaseId, claim.fetchedAt, claim.snapshotId]).slice(0, 24)}`,
    kind: "release-membership", state: "PROPOSED", sourceRow: claim.rowId, provider: claim.provider,
    sourceTrackKind: claim.provider === "musicbrainz" ? "recording-claim" : claim.provider === "discogs" ? "appearance-claim" : "provider-track",
    providerTrackId: claim.providerTrackId, providerReleaseId: claim.releaseId, sourceTable: claim.slot, snapshotId: claim.snapshotId || null,
    fetchedAt: claim.fetchedAt, position: claim.explicitMembership?.position || null, disc: claim.explicitMembership?.disc || null,
    assessment: byId.get(claim.rowId)?.conflicts.length || claim.sourceAmbiguities?.length ? "BLOCKED_CONFLICT" : "NEEDS_EVIDENCE",
    canonicalTargetId: null, automaticVerificationAllowed: false,
    reason: "Source association preserved; original observed appearance and recording identity still require review."
  }));
  const sourceObjects = new Map();
  for (const row of audit.records) for (const fact of [...row.facts, ...row.secondaryProviders]) {
    const provider = fact.source === "track_identity" ? "tidal" : fact.source;
    if (!["tidal", "beatport", "musicbrainz", "discogs"].includes(provider)) continue;
    const externalId = fact.source === "track_identity" ? fact.tidalId : fact.providerTrackId;
    if (!externalId) continue;
    const kind = provider === "musicbrainz" ? "recording-claim" : provider === "discogs" ? "appearance-claim" : "track";
    const key = JSON.stringify([provider, kind, externalId]);
    if (!sourceObjects.has(key)) sourceObjects.set(key, { provider, kind, externalId, rowIds: new Set(), assertions: [] });
    const object = sourceObjects.get(key); object.rowIds.add(row.id); object.assertions.push({ rowId: row.id, fact });
  }
  const objects = [...sourceObjects.values()].map(object => ({ ...object, rowIds: [...object.rowIds].sort((a, b) => a - b), canonicalIdentityVerified: false }));
  const report = {
    ruleset: RULESET, generatedAt: snapshot.generatedAt, readOnly: true, connectionChanges: snapshot.connectionChanges,
    behaviorEnabled: false, basis: snapshot.extra.basis, sourceObjects: objects, sourceReleases: inventory.releases,
    capturedSourceEvidence: snapshot.extra.sourceEvidence, records: audit.records, recordings, releases, memberships,
    quarantinedRows: audit.records.filter(record => record.conflicts.length).map(record => ({ id: record.id, identityKey: record.identityKey, conflicts: record.conflicts })),
    counts: { identityRows: audit.records.length, sourceObjects: objects.length, repeatedSourceObjects: objects.filter(o => o.rowIds.length > 1).length, sourceReleases: inventory.releases.length,
      recordings: tally(recordings.map(p => p.assessment)), releases: tally(releases.map(p => p.assessment)), memberships: tally(memberships.map(p => p.assessment)), capturedSourceSnapshots: snapshot.extra.sourceEvidence.length, verifiedLinksCreated: 0 }
  };
  report.manifestHash = hash(report);
  return report;
}

function validateManifest(report, currentBasis) {
  const { manifestHash, ...content } = report;
  if (hash(content) !== manifestHash) return { valid: false, reason: "manifest-content-changed" };
  if (report.ruleset !== RULESET || report.basis.fingerprint !== currentBasis.fingerprint) return { valid: false, reason: "stale-source-or-ruleset" };
  return { valid: true, reason: "current-review-artifact-only", applySupported: false };
}

function renderMarkdown(report) {
  const records = new Map(report.records.map(row => [row.id, row]));
  const cell = value => String(value).replace(/[\r\n|]/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = ["# Canonical link proposal review", "", `Ruleset: ${report.ruleset}. Read-only snapshot: ${report.generatedAt}.`, "", "No identity links, canonical entities, corrections or grouped views were created. All entries are PROPOSED; there is no apply command. Pair recommendations cannot be joined transitively.", "", "```json", JSON.stringify(report.counts, null, 2), "```", "", "## First review candidates", "", "| Proposal | Source rows | Recording | Assessment | Missing evidence |", "| --- | --- | --- | --- | --- |"];
  const candidates = [...report.recordings].filter(p => p.assessment !== "BLOCKED_CONFLICT").sort((a, b) => Number(b.assessment === "READY_FOR_REVIEW") - Number(a.assessment === "READY_FOR_REVIEW") || a.id.localeCompare(b.id));
  for (const p of candidates.slice(0, 60)) {
    const row = records.get(p.sourceRows[0]);
    lines.push(`| ${p.id} | ${p.sourceRows.join(", ")} | ${cell(row.primary.artist)} — ${cell(row.primary.title)} | ${p.assessment} | ${p.missingEvidence.join(", ")} |`);
  }
  lines.push("", "## Calinerie and Sting exclusions", "");
  for (const id of [115, 4723, 8050, 1351, 1352, 1353, 6556]) {
    const row = records.get(id); if (!row) continue;
    lines.push(`- Row ${id}: ${cell(row.primary.artist)} — ${cell(row.primary.title)}. ${row.conflicts.length ? "Quarantined: " + row.conflicts.map(cell).join("; ") : "No source contradiction found by these rules; missing evidence still requires review."}`);
  }
  lines.push("", "## How to review", "", "Open proposals.json for source objects, distinct provider namespaces, attributed recording facts, release claims, unknown positions and every pair. Re-run --validate against live data before reviewing a decision. It rejects edited artifacts and changed database/code evidence. A valid artifact is not authorization to verify links. Review each entire proposed group pairwise; retain conflicts, missing versions and incomplete release metadata. Source-object repetition, recording equivalence, release equivalence and appearance membership are separate sections, not one deduplication operation.", "");
  return lines.join("\n");
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!["--db", "--out", "--validate"].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw Error(`Unsupported/incomplete argument: ${argv[i]}`);
    args[argv[i].slice(2)] = path.resolve(argv[++i]);
  }
  const dbFile = args.db || require("../src/config").musicMemory.dbFile;
  if (args.validate) {
    const db = new DatabaseSync(dbFile, { readOnly: true }); db.exec("PRAGMA query_only=ON; BEGIN");
    try { const result = validateManifest(JSON.parse(fs.readFileSync(args.validate, "utf8")), basis(db)); console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 1; }
    finally { db.exec("ROLLBACK"); db.close(); }
    return;
  }
  if (!args.out || fs.existsSync(args.out)) throw Error("--out must name a new directory; previous review artifacts are immutable");
  const report = buildProposals(readSnapshot(dbFile, { extraRead: collectExtra }));
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, "proposals.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  fs.writeFileSync(path.join(args.out, "review.md"), renderMarkdown(report), { flag: "wx" });
  console.log(JSON.stringify({ out: args.out, counts: report.counts, connectionChanges: report.connectionChanges, fingerprint: report.basis.fingerprint }));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { basis, collectExtra, recordingProposal, buildProposals, validateManifest, renderMarkdown, hash, RULESET };
