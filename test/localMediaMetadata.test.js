"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewForFile } = require('../src/localMediaMetadata');
const local = { artist: 'deadmau5', title: 'Example (Extended Mix)', durationMs: 240000, album: 'My album', rawTags: { artist: 'deadmau5', title: 'Example (Extended Mix)' } };
const row = { id: 1, file_path: 'C:/Music/song.flac', file_hash: 'abc', availability: 'available', metadata_json: JSON.stringify(local) };
const candidate = { source: 'beatport', artist: 'deadmau5', title: 'Example', mixName: 'Extended Mix', durationMs: 240500, bpm: 128, genre: 'House', label: 'Label', releaseDate: '2023-01-01' };
test('only missing recording descriptors auto-fill; release fields stay reviewable', () => {
  const p = previewForFile(row, [candidate]);
  assert.equal(p.changes.find(c => c.field === 'bpm').decision, 'safe_fill');
  assert.equal(p.changes.find(c => c.field === 'label').decision, 'manual_review');
  assert.equal(p.changes.find(c => c.field === 'releaseDate').decision, 'manual_review');
  assert.equal(p.changes.some(c => c.field === 'album'), false);
});
test('remix/version, duration, ISRC and memory-version gaps prevent automatic tag writes', () => {
  for (const change of [{ mixName: 'Radio Edit' }, { durationMs: 220000 }, { durationMs: null }, { artist: 'Someone else' }, { requiresReview: true }]) {
    assert.ok(previewForFile(row, [{ ...candidate, ...change }]).changes.every(c => c.decision === 'manual_review'));
  }
  const isrcRow = { ...row, metadata_json: JSON.stringify({ ...local, isrc: 'USAAA1234567' }) };
  assert.ok(previewForFile(isrcRow, [{ ...candidate, isrc: 'USBBB1234567' }]).changes.every(c => c.decision === 'manual_review'));
});
test('provider conflicts and existing embedded aliases cannot be overwritten', () => {
  const p = previewForFile(row, [candidate, { ...candidate, source: 'discogs', bpm: 126 }]);
  assert.equal(p.changes.find(c => c.field === 'bpm').decision, 'manual_review');
  const tagged = { ...row, metadata_json: JSON.stringify({ ...local, rawTags: { TEMPO: '123' } }) };
  assert.equal(previewForFile(tagged, [candidate]).changes.some(c => c.field === 'bpm'), false);
});
