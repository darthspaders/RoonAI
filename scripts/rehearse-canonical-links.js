"use strict";
// Synthetic lifecycle canary in a newly created SQLite backup, never live data.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync, backup } = require('node:sqlite');
const { inventory } = require('./canonical-phase1');
const { migrate, snapshotSource, createEntity, decide, status } = require('../src/canonicalFoundation');

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!['--db', '--out'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Expected --db and --out');
    args[argv[i].slice(2)] = path.resolve(argv[++i]);
  }
  if (!args.db || !args.out || fs.existsSync(args.out)) throw Error('Provide source database and a new output directory');
  fs.mkdirSync(args.out, { recursive: true });
  const copy = path.join(args.out, 'rehearsal.sqlite');
  const sourceDb = new DatabaseSync(args.db, { readOnly: true });
  try { await backup(sourceDb, copy); } finally { sourceDb.close(); }
  let db = new DatabaseSync(copy);
  const stages = [];
  try {
    migrate(db);
    const before = inventory(db);
    const unchanged = name => {
      const after = inventory(db);
      assert.deepEqual(after.tables, before.tables, 'Legacy data/metadata changed');
      assert.deepEqual(after.counts, before.counts, 'Legacy catalog projection changed');
      assert.deepEqual(after.foreignKeyViolations, []);
      stages.push({ name, unchangedLegacyTables: Object.keys(before.tables).length, counts: after.counts });
    };
    const source = snapshotSource(db, { provider: 'rehearsal', kind: 'track', externalId: 'synthetic-canary', raw: { purpose: 'copy-only lifecycle test; not a musical identity decision' } });
    const targetId = createEntity(db, 'recording', { preferred_title: 'Synthetic copy-only canary', state: 'VERIFIED' });
    const input = { sourceId: source.sourceId, targetId, sourceRevision: source.revision, state: 'VERIFIED',
      ruleset: 'copy-only-canary-v1', reviewer: 'automated safety rehearsal', reason: 'Synthetic canary, no real recording equivalence asserted', evidence: { copyOnly: true, snapshot: source.snapshotId } };
    const first = decide(db, 'recording', input);
    assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified WHERE source_id=?').get(source.sourceId).n, 1);
    assert.throws(() => decide(db, 'recording', input), /already has/);
    unchanged('verified-canary');
    db.close(); db = new DatabaseSync(copy); migrate(db); migrate(db);
    assert.equal(db.prepare('SELECT target_id FROM canonical_recording_link_verified WHERE source_id=?').get(source.sourceId).target_id, targetId);
    const revoked = decide(db, 'recording', { ...input, state: 'REVOKED', supersedesId: first, reason: 'Copy-only revocation test' });
    assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified WHERE source_id=?').get(source.sourceId).n, 0);
    unchanged('restart-idempotence-revocation');
    decide(db, 'recording', { ...input, supersedesId: revoked });
    snapshotSource(db, { provider: 'rehearsal', kind: 'track', externalId: 'synthetic-canary', raw: { changed: true } });
    assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified WHERE source_id=?').get(source.sourceId).n, 0);
    assert.throws(() => decide(db, 'recording', input), /stale source/);
    unchanged('stale-source-invalidates-link');
    const result = { copyOnly: true, syntheticCanary: true, liveWrites: 0, copy, stages,
      status: status(db), quickCheck: db.prepare('PRAGMA quick_check').all(), baseline: before };
    fs.writeFileSync(path.join(args.out, 'safety.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ copyOnly: true, stages: stages.map(s => s.name), unchangedLegacyTables: Object.keys(before.tables).length, quickCheck: result.quickCheck }));
  } finally { db.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
