"use strict";
// Exact provider reads only. This tool never opens a writable database.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { basis, validateManifest, hash } = require('./propose-canonical-links');
const { recordingEvidence } = require('../src/canonicalMatching');
const { TidalVerifier } = require('../src/tidalVerifier');

const tidalIds = row => [...new Set([row.primary.tidalId, row.primary.providerIds?.tidal,
  ...row.facts.filter(f => f.source === 'tidal').map(f => f.providerTrackId)].filter(Boolean).map(String))];

function assess(proposal, records, sources) {
  const rows = proposal.sourceRows.map(id => records.get(id));
  const conflicts = rows.flatMap(row => row.conflicts);
  const missing = [], comparisons = [], fresh = [];
  for (const row of rows) {
    const ids = tidalIds(row);
    if (ids.length !== 1) { missing.push(`row:${row.id}:exact-tidal-identity`); continue; }
    const source = sources.get(ids[0]);
    if (!source?.result || String(source.result.id) !== ids[0]) { missing.push(`row:${row.id}:exact-source-unavailable`); continue; }
    fresh.push(source.result);
    for (const fact of row.facts) {
      const comparison = recordingEvidence(fact, source.result);
      comparisons.push({ rowId: row.id, source: fact.source, comparison });
      conflicts.push(...comparison.conflicts.map(c => `row:${row.id}:${fact.source}:${c}`));
      missing.push(...comparison.unknown.map(c => `row:${row.id}:${fact.source}:${c}`));
    }
  }
  for (let a = 0; a < fresh.length; a++) for (let b = a + 1; b < fresh.length; b++) {
    const comparison = recordingEvidence(fresh[a], fresh[b]);
    comparisons.push({ source: 'fresh-pair', comparison });
    conflicts.push(...comparison.conflicts);
    missing.push(...comparison.unknown);
    if (String(fresh[a].id) !== String(fresh[b].id) && !comparison.sameIsrc) missing.push('independent-recording-identifier');
  }
  return { proposalId: proposal.id, sourceRows: proposal.sourceRows, state: 'PROPOSED',
    assessment: conflicts.length ? 'BLOCKED_CONFLICT' : missing.length ? 'NEEDS_EVIDENCE' : 'FRESH_EVIDENCE_COMPATIBLE',
    conflicts: [...new Set(conflicts)], missing: [...new Set(missing)], comparisons,
    automaticVerificationAllowed: false, canonicalTargetId: null };
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!['--db', '--report', '--out'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Expected --db, --report and --out');
    args[argv[i].slice(2)] = path.resolve(argv[++i]);
  }
  if (!args.db || !args.report || !args.out || fs.existsSync(args.out)) throw Error('Provide database, report and a new output directory');
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const db = new DatabaseSync(args.db, { readOnly: true });
  try { db.exec('BEGIN'); if (!validateManifest(report, basis(db)).valid) throw Error('Stale or edited proposal report'); }
  finally { db.close(); }
  const records = new Map(report.records.map(row => [row.id, row]));
  const proposals = report.recordings.filter(p => p.assessment === 'READY_FOR_REVIEW');
  const ids = [...new Set(proposals.flatMap(p => p.sourceRows.flatMap(id => tidalIds(records.get(id)))))].sort();
  fs.mkdirSync(args.out, { recursive: true });
  const verifier = new TidalVerifier({ ...require('../src/config').tidal, timeoutMs: 8000 });
  const sources = new Map();
  for (const id of ids) {
    const item = { provider: 'tidal', requestedId: id, retrievedAt: new Date().toISOString() };
    try { item.result = await verifier.getTrack(id); if (String(item.result?.id) !== id) { item.result = null; item.error = 'exact-item-unavailable'; } }
    catch { item.error = 'provider-request-failed'; }
    sources.set(id, item);
    fs.appendFileSync(path.join(args.out, 'sources.jsonl'), JSON.stringify(item) + '\n');
    if (sources.size % 10 === 0) console.log(JSON.stringify({ fetched: sources.size, total: ids.length }));
  }
  const decisions = proposals.map(p => assess(p, records, sources));
  const result = { generatedAt: new Date().toISOString(), proposalManifestHash: report.manifestHash,
    verifierCodeHash: hash(fs.readFileSync(__filename, 'utf8')), sourcesHash: hash([...sources.values()]),
    ruleset: 'fresh-exact-tidal-review-v1', readOnly: true, verifiedLinksCreated: 0,
    counts: { requestedSources: ids.length, retrievedSources: [...sources.values()].filter(s => s.result).length,
      proposals: decisions.length, assessments: decisions.reduce((r, d) => (r[d.assessment] = (r[d.assessment] || 0) + 1, r), {}) }, decisions };
  result.manifestHash = hash(result);
  fs.writeFileSync(path.join(args.out, 'verification.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result.counts));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assess, tidalIds };
