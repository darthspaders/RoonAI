"use strict";
// Refresh selected evidence and stage PROPOSED links in a new backup only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync, backup } = require('node:sqlite');
const { basis, validateManifest, hash } = require('./propose-canonical-links');
const { assess, tidalIds } = require('./verify-canonical-proposals');
const { inventory } = require('./canonical-phase1');
const { snapshotSource, createEntity, decide, migrate, status } = require('../src/canonicalFoundation');
const { recordingEvidence } = require('../src/canonicalMatching');
const { TidalVerifier } = require('../src/tidalVerifier');
const { BeatportClient, extractBeatportTracks } = require('../src/beatportClient');

function assessProviders(proposal, records, sources) {
  const tidal = new Map([...sources.values()].filter(s => s.provider === 'tidal').map(s => [s.requestedId, s]));
  const result = assess(proposal, records, tidal);
  const freshFacts = [];
  for (const id of proposal.sourceRows) {
    const row = records.get(id);
    for (const sourceId of tidalIds(row)) {
      const item = sources.get(`tidal:${sourceId}`);
      if (item?.result) freshFacts.push(item.result);
    }
    if (row.secondaryProviders?.length) result.missing.push(`row:${id}:secondary-provider-review`);
    for (const fact of row.facts.filter(f => f.source === 'beatport')) {
      const item = sources.get(`beatport:${fact.providerTrackId}`);
      if (!item?.result || String(item.result.id) !== String(fact.providerTrackId) || String(item.rawId) !== String(fact.providerTrackId)) {
        result.missing.push(`row:${id}:exact-beatport-unavailable`); continue;
      }
      freshFacts.push(item.result);
      const comparison = recordingEvidence(fact, item.result);
      result.comparisons.push({ rowId: id, source: 'beatport-refresh', comparison });
      result.conflicts.push(...comparison.conflicts);
      result.missing.push(...comparison.unknown);
    }
  }
  // Check every fresh source against every other source, never a similarity chain.
  for (let a = 0; a < freshFacts.length; a++) for (let b = a + 1; b < freshFacts.length; b++) {
    const comparison = recordingEvidence(freshFacts[a], freshFacts[b]);
    result.comparisons.push({ source: 'all-fresh-pairwise', comparison });
    result.conflicts.push(...comparison.conflicts);
    result.missing.push(...comparison.unknown);
  }
  result.conflicts = [...new Set(result.conflicts)]; result.missing = [...new Set(result.missing)];
  result.assessment = result.conflicts.length ? 'BLOCKED_CONFLICT' : result.missing.length ? 'NEEDS_EVIDENCE' : 'SUPPORTED_FOR_COPY_PROPOSAL';
  return result;
}

function stagePair(db, proposal, rows, sources, evidence) {
  const title = rows[0].primary.title;
  const targetId = createEntity(db, 'recording', { preferred_title: title, state: 'PROPOSED' });
  const snapshots = [];
  for (const row of rows) snapshots.push(snapshotSource(db, { provider: 'rabbit-hole', kind: 'legacy', externalId: String(row.id), raw: row,
    legacyTable: 'track_identity', legacyRowKey: String(row.id) }));
  const keys = new Set(rows.flatMap(row => [...tidalIds(row).map(id => `tidal:${id}`),
    ...row.facts.filter(f => f.source === 'beatport').map(f => `beatport:${f.providerTrackId}`)]));
  for (const key of keys) {
    const item = sources.get(key);
    const snapshot = snapshotSource(db, { provider: item.provider, kind: 'track', externalId: item.requestedId, raw: item, retrievedAt: item.retrievedAt });
    db.prepare('INSERT INTO canonical_provider_track(source_id,original_artist,original_title,version_text,duration_ms,snapshot_id) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET original_artist=excluded.original_artist,original_title=excluded.original_title,version_text=excluded.version_text,duration_ms=excluded.duration_ms,snapshot_id=excluded.snapshot_id')
      .run(snapshot.sourceId, item.result.artist, item.result.title, item.result.mixVersion || item.result.mixName || '', item.result.durationMs || null, snapshot.snapshotId);
    snapshots.push(snapshot);
  }
  const links = snapshots.map(snapshot => decide(db, 'recording', { sourceId: snapshot.sourceId, sourceRevision: snapshot.revision, targetId,
    state: 'PROPOSED', evidence: { proposalId: proposal.id, freshReview: evidence, snapshotId: snapshot.snapshotId, copyOnly: true },
    ruleset: 'fresh-provider-copy-proposal-v1', reviewer: 'automated evidence staging', reason: 'Compatible fresh evidence; pending identity decision. Copy only.' }));
  return { proposalId: proposal.id, sourceRows: proposal.sourceRows, targetId, links, state: 'PROPOSED' };
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!['--db', '--report', '--selection', '--out'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Expected --db, --report, --selection and --out');
    args[argv[i].slice(2)] = path.resolve(argv[++i]);
  }
  if (!args.db || !args.report || !args.selection || !args.out || fs.existsSync(args.out)) throw Error('Provide inputs and a new output directory');
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const selection = JSON.parse(fs.readFileSync(args.selection, 'utf8'));
  const { manifestHash, ...selectedContent } = selection;
  if (hash(selectedContent) !== manifestHash) throw Error('Edited selection artifact');
  fs.mkdirSync(args.out, { recursive: true });
  const copy = path.join(args.out, 'staged.sqlite');
  const sourceDb = new DatabaseSync(args.db, { readOnly: true });
  try { await backup(sourceDb, copy); } finally { sourceDb.close(); }
  const db = new DatabaseSync(copy);
  try {
    if (!validateManifest(report, basis(db)).valid) throw Error('Stale proposal basis');
    migrate(db);
    const before = inventory(db), rows = new Map(report.records.map(row => [row.id, row]));
    const selectedIds = new Set(selection.decisions.filter(d => d.assessment === 'FRESH_EVIDENCE_COMPATIBLE').map(d => d.proposalId));
    const proposals = report.recordings.filter(p => selectedIds.has(p.id) && p.assessment === 'READY_FOR_REVIEW');
    const keys = new Set(proposals.flatMap(p => p.sourceRows.flatMap(id => {
      const row = rows.get(id);
      return [...tidalIds(row).map(id => `tidal:${id}`), ...row.facts.filter(f => f.source === 'beatport').map(f => `beatport:${f.providerTrackId}`)];
    })));
    const config = require('../src/config');
    const tidal = new TidalVerifier({ ...config.tidal, timeoutMs: 8000 });
    const beatport = new BeatportClient({ ...config.beatport, timeoutMs: 8000, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    let raw;
    const request = beatport.requestJson.bind(beatport);
    beatport.requestJson = async (...args) => { raw = await request(...args); return raw; };
    const sources = new Map();
    for (const key of keys) {
      const [provider, requestedId] = key.split(':');
      const item = { provider, requestedId, retrievedAt: new Date().toISOString() };
      try {
        item.result = provider === 'tidal' ? await tidal.getTrack(requestedId) : await beatport.getTrackById(requestedId);
        item.raw = provider === 'tidal' ? item.result?.sourceEvidence?.[0]?.raw : raw;
        item.rawId = provider === 'tidal' ? item.raw?.track?.id : (extractBeatportTracks(raw)[0] || raw?.data || raw)?.id;
        if (String(item.result?.id) !== requestedId || String(item.rawId) !== requestedId) { item.result = null; item.error = 'exact-source-id-unavailable'; }
      } catch { item.result = null; item.error = 'provider-request-failed'; }
      sources.set(key, item);
      fs.appendFileSync(path.join(args.out, 'sources.jsonl'), JSON.stringify(item) + '\n');
      if (sources.size % 10 === 0) console.log(JSON.stringify({ fetched: sources.size, total: keys.size }));
    }
    const decisions = proposals.map(p => assessProviders(p, rows, sources));
    const staged = [], used = new Set();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const decision of decisions.filter(d => d.assessment === 'SUPPORTED_FOR_COPY_PROPOSAL')) {
        const proposal = proposals.find(p => p.id === decision.proposalId);
        const members = proposal.sourceRows.map(id => rows.get(id));
        const identities = members.flatMap(row => [`legacy:${row.id}`, ...tidalIds(row).map(id => `tidal:${id}`), ...row.facts.filter(f => f.source === 'beatport').map(f => `beatport:${f.providerTrackId}`)]);
        if (identities.some(key => used.has(key))) { decision.assessment = 'NEEDS_GROUP_REVIEW'; continue; }
        staged.push(stagePair(db, proposal, members, sources, decision));
        identities.forEach(key => used.add(key));
      }
      const after = inventory(db);
      assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.counts, before.counts);
      assert.deepEqual(after.foreignKeyViolations, []);
      assert.equal(db.prepare("SELECT count(*) n FROM canonical_recording_link_verified").get().n, 0);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const result = { at: new Date().toISOString(), copyOnly: true, inputManifestHash: report.manifestHash,
      selectionManifestHash: manifestHash, codeHash: hash(fs.readFileSync(__filename, 'utf8')), sourcesHash: hash([...sources.values()]),
      selectedPairs: selectedIds.size, eligibleCurrentPairs: proposals.length, requestedSources: keys.size,
      retrievedSources: [...sources.values()].filter(s => s.result).length, unchangedLegacyTables: Object.keys(before.tables).length,
      verifiedLinksCreated: 0, staged, decisions, status: status(db), quickCheck: db.prepare('PRAGMA quick_check').all() };
    result.manifestHash = hash(result);
    fs.writeFileSync(path.join(args.out, 'review.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ stagedPairs: staged.length, stagedLinks: staged.reduce((n, p) => n + p.links.length, 0), requestedSources: keys.size,
      retrievedSources: result.retrievedSources, assessments: decisions.reduce((r, d) => (r[d.assessment] = (r[d.assessment] || 0) + 1, r), {}), unchangedLegacyTables: result.unchangedLegacyTables }));
  } finally { db.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assessProviders, stagePair };
