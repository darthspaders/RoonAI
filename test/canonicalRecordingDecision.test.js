"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { migrate, decide, snapshotSource } = require('../src/canonicalFoundation');
const { verifyPair, checkedArtifact, rowEvidence } = require('../scripts/decide-recording-review');
const { hash } = require('../scripts/propose-canonical-links');
const fact = { artist: 'Artist', title: 'Song', mixVersion: 'Original Mix', durationMs: 300000, isrc: 'USABC1234567' };
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE track_identity(id INTEGER PRIMARY KEY); CREATE TABLE provider_enrichment(id INTEGER PRIMARY KEY); INSERT INTO track_identity VALUES(1),(2)'); migrate(db);
  const members = [1, 2].map(id => ({ id, primary: { ...fact, tidalId: '10' }, facts: [{ ...fact, source: 'track_identity' }, { ...fact, source: 'beatport', providerTrackId: '20' }], conflicts: [], secondaryProviders: [] }));
  const sources = new Map(['tidal:10', 'beatport:20'].map(key => { const [provider, id] = key.split(':'); return [key, { provider, requestedId: id, rawId: id, result: { ...fact, id }, retrievedAt: new Date().toISOString() }]; }));
  return { db, members, sources, proposal: { id: 'pair', sourceRows: [1, 2] } };
}
test('decision appends verified links, retains proposed history and is idempotent', t => {
  const { db, members, sources, proposal } = fixture(t);
  const result = verifyPair(db, proposal, members, sources, 'review');
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link').get().n, 8);
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified').get().n, 4);
  assert.equal(db.prepare('SELECT state FROM canonical_recording').get().state, 'VERIFIED');
  const repeated = verifyPair(db, proposal, members, sources, 'review');
  assert.equal(repeated.targetId, result.targetId); assert.equal(repeated.alreadyApplied, true);
  assert.equal(db.prepare('SELECT count(*) n FROM track_identity').get().n, 2);
  assert.throws(() => verifyPair(db, proposal, members, sources, 'different-review'), /separate review/);
});
test('revocation and source revision changes cannot be bypassed by replay', t => {
  const { db, members, sources, proposal } = fixture(t);
  const result = verifyPair(db, proposal, members, sources, 'review');
  const link = db.prepare('SELECT * FROM canonical_recording_link WHERE id=?').get(result.links[0]);
  decide(db, 'recording', { sourceId: link.source_id, sourceRevision: link.source_revision, targetId: link.target_id, state: 'REVOKED', supersedesId: link.id, reviewer: 'test', ruleset: 'test', reason: 'revoke', evidence: { test: true } });
  assert.throws(() => verifyPair(db, proposal, members, sources, 'review'), /separate review/);
  snapshotSource(db, { provider: 'tidal', kind: 'track', externalId: '10', raw: { changed: true } });
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified').get().n, 2);
});
test('review integrity and selected-row checks detect changed evidence', () => {
  const content = { reviewed: [1, 2] }, artifact = { ...content, manifestHash: hash(content) };
  assert.equal(checkedArtifact(artifact), artifact);
  assert.throws(() => checkedArtifact({ ...artifact, reviewed: [3] }), /Edited/);
  assert.notEqual(hash(rowEvidence({ primary: fact })), hash(rowEvidence({ primary: { ...fact, title: 'Other' } })));
});
