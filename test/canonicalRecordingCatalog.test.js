"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { browseCatalog } = require('../src/databaseBrowserCatalog');
function row(id, patch = {}) { return { id, title: 'Song', artist: 'Artist', album: 'Album', albumKey: 'a', year: 2000, label: 'First', tidalId: '10', genres: ['House'], tags: [], sonicTags: [], providers: ['tidal'], sources: [], rating: '', searchText: 'artist song', durationMs: 300000, ...patch }; }
const snapshot = () => ({ records: [row(1, { rating: 'love' }), row(2, { year: 2020, label: 'Second' }), row(3, { title: 'Other', searchText: 'other' })], recordingGroups: { groups: [{ id: 'uuid', title: 'Song (Original Mix)', rowIds: [1, 2] }] }, sonicAvailable: true });
test('recordings group before pagination and retain unresolved rows and raw-source fallback', () => {
  const s = snapshot(), first = browseCatalog(s, { view: 'recordings', limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.catalogTracks, 3); assert.equal(first.verifiedRecordings, 1);
  const all = browseCatalog(s, { view: 'recordings' });
  assert.deepEqual(all.items.map(r => r.identityStatus).sort(), ['unresolved', 'verified']);
  assert.equal(browseCatalog(s, { view: 'tracks' }).total, 3);
  assert.equal(browseCatalog({ ...s, recordingGroups: { groups: [] } }, { view: 'recordings' }).total, 3);
});
test('combined filters require one appearance and facets count recordings once', () => {
  const s = snapshot();
  assert.equal(browseCatalog(s, { view: 'recordings', yearMin: 2010, label: 'First' }).total, 0);
  const all = browseCatalog(s, { view: 'recordings' });
  assert.equal(all.facets.genre[0].count, 2);
  const filtered = browseCatalog(s, { view: 'recordings', yearMin: 2010 });
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0].id, 'recording:uuid');
  assert.equal(filtered.items[0].year, 2000); assert.deepEqual(filtered.items[0].matchingSourceIds, [2]);
  assert.equal(filtered.items[0].sourceRecords.length, 2);
});
test('rating provenance preserves Love against unrated sources and exposes disagreement', () => {
  const s = snapshot();
  let grouped = browseCatalog(s, { view: 'recordings', q: 'song' }).items[0];
  assert.equal(grouped.rating, 'love'); assert.equal(grouped.sourceRecords[1].rating, '');
  s.records[1].rating = 'never';
  grouped = browseCatalog(s, { view: 'recordings', q: 'song' }).items[0];
  assert.equal(grouped.ratingConflict, true); assert.equal(grouped.rating, '');
  assert.ok(!JSON.stringify(grouped).includes('searchText'));
});
