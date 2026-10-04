"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordingGroups, albumCollections, compatible, prepareBrowseGrouping } = require('../src/catalogBrowseGrouping');
const { browseCatalog } = require('../src/databaseBrowserCatalog');
function row(id, patch = {}) { return { id, title: 'Song', artist: 'Artist', durationMs: 300000, tidalId: '', isrc: '', album: 'Album', albumKey: 'album:album|artist', year: 2000, genres: [], tags: [], sonicTags: [], sources: [], providers: ['beatport'], rating: '', searchText: 'artist song', _browseEvidence: [{ provider: 'beatport', id: '10', title: 'Song', artist: 'Artist', durationMs: 300000, mixVersion: 'Original Mix', isrc: 'USABC1234567' }], ...patch }; }
test('same exact source groups missing versions without calling them verified', () => {
  const groups = recordingGroups([row(1), row(2)]);
  assert.equal(groups.length, 1); assert.equal(groups[0].matched, true); assert.equal(groups[0].verified, false);
});
test('provider-confirmed separate artist credits support ampersand and slash spellings', () => {
  const fact = { provider: 'beatport', id: '10', title: 'Song', artist: 'Cid Inc., Orsen', durationMs: 300000 };
  const rows = ['Cid Inc., Orsen', 'Cid Inc / Orsen', 'Cid Inc. & Orsen'].map((artist, i) => row(i, { artist, _artistCredits: ['Cid Inc.', 'Orsen'], _browseEvidence: [fact] }));
  assert.equal(recordingGroups(rows).length, 1);
  assert.equal(compatible(row(1, { artist: 'Band & Name' }), row(2, { artist: 'Band, Name' })), false);
});
test('name-only homonyms, conflicting mixes, duration and ISRC remain separate', () => {
  for (const patch of [{ _browseEvidence: [] }, { mixVersion: 'Radio Edit' }, { durationMs: 310000 }, { isrc: 'USABC1234568' }, { artist: 'Other' }]) {
    assert.equal(recordingGroups([row(1), row(2, patch)]).length, 2);
  }
});
test('ISRC grouping requires an explicit compatible version, not merely the same code', () => {
  assert.equal(recordingGroups([row(1, { _browseEvidence: [], isrc: 'USABC1234567' }), row(2, { _browseEvidence: [], isrc: 'USABC1234567' })]).length, 2);
  const a = row(1, { isrc: 'USABC1234567', mixVersion: 'Original Mix', _browseEvidence: [] });
  assert.equal(recordingGroups([a, { ...a, id: 2 }]).length, 1);
});
test('blocked canonical decisions and similarity chains do not get grouped', () => {
  assert.equal(recordingGroups([row(1), row(2)], [], [1]).length, 2);
  const a = row(1, { tidalId: '1', _browseEvidence: [] });
  const b = row(2, { tidalId: '1' });
  const c = row(3);
  assert.ok(recordingGroups([a, b, c]).every(g => g.members.length <= 2));
});
test('related album collection preserves releases, collaborators and distinct full titles', () => {
  const rows = [row(1, { artist: 'deadmau5', albumKey: 'tidal-album:1' }), row(2, { artist: 'deadmau5, Guest', albumKey: 'album:album|guest' }), row(3, { artist: 'Other', albumKey: 'album:album|other' }), row(4, { album: 'Album Deluxe', albumKey: 'album:deluxe|artist' })];
  const collections = albumCollections(rows);
  assert.equal(collections.length, 3);
  assert.equal(collections.find(c => c.artist === 'deadmau5').sourceReleaseCount, 2);
  assert.equal(collections.find(c => c.artist === 'deadmau5').albumSources.length, 2);
});
test('album collections keep stable metadata under filtering and deduplicate recording counts', () => {
  const snapshot = { records: [row(1), row(2, { albumKey: 'beatport-album:2', year: 2020 })], sonicAvailable: true };
  prepareBrowseGrouping(snapshot);
  const all = browseCatalog(snapshot, { view: 'albums' });
  assert.equal(all.total, 1); assert.equal(all.items[0].count, 1); assert.equal(all.items[0].year, null);
  const filtered = browseCatalog(snapshot, { view: 'albums', yearMin: 2010 });
  assert.equal(filtered.items[0].id, all.items[0].id); assert.equal(filtered.items[0].year, null);
  assert.equal(browseCatalog(snapshot, { view: 'tracks' }).total, 2);
});
test('swapped display fields require exact reversed provider metadata and preserve original source', () => {
  const snapshot = { records: [row(1, { artist: 'Song', title: 'Artist' }), row(2)] };
  prepareBrowseGrouping(snapshot);
  assert.equal(snapshot.displayGroups.length, 1);
  assert.equal(snapshot.records[0].artist, 'Song');
  assert.equal(snapshot.browseRecords[0].originalMetadata.artist, 'Song');
});
