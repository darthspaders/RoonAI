"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { assess } = require('../scripts/verify-canonical-proposals');
const fact = { artist: 'Artist', title: 'Song', mixVersion: 'Original Mix', durationMs: 300000, isrc: 'USABC1234567' };
const row = (id, patch = {}) => ({ id, primary: { ...fact, tidalId: String(id) }, conflicts: [], facts: [{ ...fact, ...patch }] });
const proposal = { id: 'pair', sourceRows: [1, 2] };
const sources = () => new Map([['1', { result: { ...fact, id: '1' } }], ['2', { result: { ...fact, id: '2' } }]]);
test('fresh compatible facts remain proposed with no canonical target', () => {
  const result = assess(proposal, new Map([[1, row(1)], [2, row(2)]]), sources());
  assert.equal(result.assessment, 'FRESH_EVIDENCE_COMPATIBLE');
  assert.equal(result.state, 'PROPOSED'); assert.equal(result.canonicalTargetId, null);
});
test('fresh exact ID does not override stale versions, missing versions or contradictory source facts', () => {
  for (const [patch, expected] of [[{ mixVersion: 'Ambient Version' }, 'BLOCKED_CONFLICT'], [{ mixVersion: '', version: { explicit: false } }, 'NEEDS_EVIDENCE'], [{ artist: 'Other' }, 'BLOCKED_CONFLICT']]) {
    assert.equal(assess(proposal, new Map([[1, row(1)], [2, row(2, patch)]]), sources()).assessment, expected);
  }
});
test('unavailable or incorrect exact provider result cannot verify a pair', () => {
  for (const value of [null, { ...fact, id: 'wrong' }]) {
    const fresh = sources(); fresh.set('2', { result: value });
    assert.equal(assess(proposal, new Map([[1, row(1)], [2, row(2)]]), fresh).assessment, 'NEEDS_EVIDENCE');
  }
});
