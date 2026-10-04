"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('../src/canonicalFoundation');
const { assessProviders, stagePair } = require('../scripts/stage-recording-review');
const fact = { artist: 'Artist', title: 'Song', mixVersion: 'Original Mix', durationMs: 300000, isrc: 'USABC1234567' };
const proposal = { id: 'pair', sourceRows: [1, 2] };
function fixture() {
  const rows = new Map([1, 2].map(id => [id, { id, primary: { ...fact, tidalId: '10' }, conflicts: [], secondaryProviders: [],
    facts: [{ ...fact, source: 'track_identity' }, { ...fact, source: 'beatport', providerTrackId: '20' }] }]));
  const sources = new Map(['tidal:10', 'beatport:20'].map(key => {
    const [provider, id] = key.split(':');
    return [key, { provider, requestedId: id, rawId: id, retrievedAt: new Date().toISOString(), result: { ...fact, id }, raw: { id } }];
  }));
  return { rows, sources };
}
test('fresh provider agreement supports only a proposed copy link', () => {
  const { rows, sources } = fixture();
  const result = assessProviders(proposal, rows, sources);
  assert.equal(result.assessment, 'SUPPORTED_FOR_COPY_PROPOSAL');
  assert.equal(result.state, 'PROPOSED'); assert.equal(result.automaticVerificationAllowed, false);
});
test('fresh Beatport conflict blocks even shared TIDAL identities', () => {
  for (const patch of [{ mixVersion: 'Radio Edit' }, { artist: 'Other Artist' }, { durationMs: 310000 }, { isrc: 'USABC1234568' }]) {
    const { rows, sources } = fixture(); Object.assign(sources.get('beatport:20').result, patch);
    assert.equal(assessProviders(proposal, rows, sources).assessment, 'BLOCKED_CONFLICT');
  }
});
test('missing raw provider ID and unreviewed secondary provider evidence prevent staging', () => {
  const { rows, sources } = fixture(); sources.get('beatport:20').rawId = undefined;
  assert.equal(assessProviders(proposal, rows, sources).assessment, 'NEEDS_EVIDENCE');
  sources.get('beatport:20').rawId = '20'; rows.get(1).secondaryProviders.push({ source: 'discogs' });
  assert.equal(assessProviders(proposal, rows, sources).assessment, 'NEEDS_EVIDENCE');
});
test('copy staging keeps legacy rows, distinct provider identities and nonverified targets', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec("CREATE TABLE track_identity(id INTEGER PRIMARY KEY,title TEXT); CREATE TABLE provider_enrichment(id INTEGER PRIMARY KEY); INSERT INTO track_identity VALUES(1,'Song'),(2,'Song');");
  migrate(db);
  const before = db.prepare('SELECT * FROM track_identity').all();
  const { rows, sources } = fixture();
  const result = stagePair(db, proposal, [...rows.values()], sources, assessProviders(proposal, rows, sources));
  assert.equal(result.links.length, 4);
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified').get().n, 0);
  assert.equal(db.prepare('SELECT state FROM canonical_recording').get().state, 'PROPOSED');
  assert.deepEqual(db.prepare('SELECT * FROM track_identity').all(), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
