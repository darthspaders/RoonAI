"use strict";
// Explicit, reversible recording decisions. Copy rehearsal is required for apply.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync, backup } = require('node:sqlite');
const { hash, basis } = require('./propose-canonical-links');
const { buildReport, readSnapshot } = require('./audit-recording-duplicates');
const { assessProviders, stagePair } = require('./stage-recording-review');
const { tidalIds } = require('./verify-canonical-proposals');
const { inventory } = require('./canonical-phase1');
const { decide, status } = require('../src/canonicalFoundation');
const { parseCanonicalCatalogIdentity } = require('../src/catalogIdentityNormalization');

function checkedArtifact(value) {
  const { manifestHash, ...content } = value;
  if (hash(content) !== manifestHash) throw Error('Edited review artifact');
  return value;
}
const rowEvidence = row => ({ primary: row.primary, facts: row.facts, secondaryProviders: row.secondaryProviders,
  conflicts: row.conflicts, alias: row.alias, coverage: row.coverage, linkedRowIds: row.linkedRowIds });

function verifyPair(db, proposal, members, sources, reviewHash) {
  const identities = new Map();
  for (const row of members) {
    identities.set(`rabbit-hole:legacy:${row.id}`, ['rabbit-hole', 'legacy', String(row.id)]);
    for (const id of tidalIds(row)) identities.set(`tidal:track:${id}`, ['tidal', 'track', id]);
    for (const fact of row.facts.filter(f => f.source === 'beatport')) identities.set(`beatport:track:${fact.providerTrackId}`, ['beatport', 'track', String(fact.providerTrackId)]);
  }
  const existing = [...identities.values()].flatMap(args => db.prepare('SELECT l.* FROM canonical_recording_link_current l JOIN canonical_source_object s ON s.id=l.source_id WHERE s.provider=? AND s.kind=? AND s.external_id=?').all(...args));
  if (existing.length) {
    if (existing.length === identities.size && new Set(existing.map(l => l.target_id)).size === 1 && existing.every(l => l.state === 'VERIFIED' && JSON.parse(l.evidence_json).reviewHash === reviewHash && db.prepare('SELECT 1 FROM canonical_recording_link_verified WHERE id=?').get(l.id))) {
      return { proposalId: proposal.id, targetId: existing[0].target_id, links: existing.map(l => l.id), alreadyApplied: true };
    }
    throw Error('Existing recording decision requires separate review');
  }
  const records = new Map(members.map(row => [row.id, row]));
  const assessment = assessProviders(proposal, records, sources);
  if (assessment.assessment !== 'SUPPORTED_FOR_COPY_PROPOSAL') throw Error('Fresh evidence no longer supports decision');
  const group = stagePair(db, proposal, members, sources, assessment);
  const tidal = sources.get(`tidal:${tidalIds(members[0])[0]}`).result;
  const parsed = parseCanonicalCatalogIdentity(tidal);
  db.prepare("UPDATE canonical_recording SET state='VERIFIED',preferred_title=?,normalized_base_title=?,version_json=?,original_version_text=?,duration_ms=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(tidal.title, parsed.normalizedBaseTitle, JSON.stringify(parsed.version), tidal.mixVersion || tidal.mixName || '', tidal.durationMs, group.targetId);
  const links = group.links.map(id => {
    const prior = db.prepare('SELECT * FROM canonical_recording_link WHERE id=?').get(id);
    return decide(db, 'recording', { sourceId: prior.source_id, sourceRevision: prior.source_revision, targetId: group.targetId,
      state: 'VERIFIED', supersedesId: id, ruleset: 'exact-provider-recording-review-v1', reviewer: 'Codex recording evidence review',
      reason: 'Shared exact TIDAL object; every attributed legacy fact and fresh TIDAL/Beatport source compared pairwise with explicit compatible versions and full durations.',
      evidence: { reviewHash, proposalId: proposal.id, sourceRows: proposal.sourceRows, assessment, playbackAuthority: 'unchanged-exact-tidal-roon', releaseEquivalence: false, embeddingReuse: false } });
  });
  return { proposalId: proposal.id, targetId: group.targetId, links, alreadyApplied: false };
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!['--mode', '--db', '--review', '--report', '--sources', '--out', '--rehearsal'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Invalid arguments');
    args[argv[i].slice(2)] = argv[++i];
  }
  if (!['copy', 'apply'].includes(args.mode) || !args.db || !args.review || !args.report || !args.sources || !args.out || fs.existsSync(args.out)) throw Error('Provide mode, inputs and a new output directory');
  const review = checkedArtifact(JSON.parse(fs.readFileSync(args.review, 'utf8')));
  const report = checkedArtifact(JSON.parse(fs.readFileSync(args.report, 'utf8')));
  const sourceList = fs.readFileSync(args.sources, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (review.sourcesHash !== hash(sourceList) || review.inputManifestHash !== report.manifestHash || review.codeHash !== hash(fs.readFileSync(require.resolve('./stage-recording-review'), 'utf8'))) throw Error('Source, proposal or staging-code mismatch');
  const codeHash = hash(fs.readFileSync(__filename, 'utf8'));
  if (args.mode === 'apply') {
    if (!args.rehearsal) throw Error('A successful copy rehearsal is required');
    const rehearsal = checkedArtifact(JSON.parse(fs.readFileSync(args.rehearsal, 'utf8')));
    if (rehearsal.mode !== 'copy' || rehearsal.reviewHash !== review.manifestHash || rehearsal.codeHash !== codeHash || !rehearsal.preservationPassed) throw Error('Mismatched copy rehearsal');
  }
  const sources = new Map(sourceList.map(s => [`${s.provider}:${s.requestedId}`, s]));
  for (const source of sourceList) {
    const age = Date.now() - Date.parse(source.retrievedAt);
    if (!Number.isFinite(age) || age < -60000 || age > 15 * 60 * 1000 || !source.result || String(source.rawId) !== source.requestedId || String(source.result.id) !== source.requestedId) throw Error('Expired or non-exact source evidence; refresh required');
  }
  fs.mkdirSync(args.out, { recursive: true });
  const backupFile = path.resolve(args.out, 'before.sqlite');
  const reader = new DatabaseSync(args.db, { readOnly: true });
  try { await backup(reader, backupFile); } finally { reader.close(); }
  const target = args.mode === 'copy' ? path.resolve(args.out, 'verified.sqlite') : path.resolve(args.db);
  if (args.mode === 'copy') fs.copyFileSync(backupFile, target, fs.constants.COPYFILE_EXCL);
  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    const before = inventory(db);
    if (hash(basis(db).code) !== hash(report.basis.code)) throw Error('Proposal rules changed');
    // The writer reservation excludes concurrent app writes while live facts are reread.
    const currentRows = new Map(buildReport(readSnapshot(target)).records.map(r => [r.id, r]));
    const oldRows = new Map(report.records.map(r => [r.id, r]));
    const results = [];
    for (const staged of review.staged) {
      const proposal = report.recordings.find(p => p.id === staged.proposalId);
      if (!proposal || proposal.assessment !== 'READY_FOR_REVIEW') throw Error('Ineligible proposal');
      const members = proposal.sourceRows.map(id => {
        const current = currentRows.get(id);
        if (!current || hash(rowEvidence(current)) !== hash(rowEvidence(oldRows.get(id)))) throw Error(`Stale source row ${id}`);
        return current;
      });
      if (new Set(members.flatMap(tidalIds)).size !== 1) throw Error('Different TIDAL objects need separate review');
      results.push(verifyPair(db, proposal, members, sources, review.manifestHash));
    }
    const after = inventory(db);
    assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.counts, before.counts); assert.deepEqual(after.foreignKeyViolations, []);
    db.exec('COMMIT');
    const result = { mode: args.mode, at: new Date().toISOString(), reviewHash: review.manifestHash, codeHash, preservationPassed: true,
      unchangedLegacyTables: Object.keys(before.tables).length, counts: after.counts, results, status: status(db), backupFile,
      quickCheck: db.prepare('PRAGMA quick_check').all() };
    result.manifestHash = hash(result);
    fs.writeFileSync(path.join(args.out, 'decision.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ mode: args.mode, recordings: results.length, links: results.reduce((n, r) => n + r.links.length, 0), unchangedLegacyTables: result.unchangedLegacyTables }));
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checkedArtifact, rowEvidence, verifyPair };
