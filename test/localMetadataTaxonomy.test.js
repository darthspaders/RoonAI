"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanClassification } = require('../src/localMetadataTaxonomy');
const { previewForFile } = require('../src/localMediaMetadata');

test('Synapse review: deduplicate MusicBrainz labels and separate family from style', () => {
  const cleaned = cleanClassification({ source: 'musicbrainz', genre: 'alternative rock, rock, Alternative Rock, rock, alt-rock' });
  assert.equal(cleaned.genre, 'Rock'); assert.equal(cleaned.subgenre, 'Alternative Rock');
  assert.ok(cleaned.classificationReviewReasons.includes('MUSICBRAINZ_CLASSIFICATION_REVIEW'));
});

test('mixed release styles remain review-only and unknown labels are retained as evidence', () => {
  const original = { source: 'discogs', genre: 'Electronic', subgenre: 'Electro House, Dubstep, Glitch Hop, Progressive House, seen live' };
  const cleaned = cleanClassification(original);
  assert.equal(cleaned.genre, 'Electronic');
  assert.deepEqual(cleaned.unclassifiedTags, ['seen live']);
  assert.ok(cleaned.classificationReviewReasons.includes('RELEASE_STYLE_INHERITANCE_REVIEW'));
  assert.deepEqual(cleanClassification({ ...original, ...cleaned }), cleaned);
});

test('classification review never downgrades strong BPM/key/Camelot evidence', () => {
  const local = { artist: 'Nine Inch Nails', title: 'Eraser', durationMs: 294000, rawTags: {} };
  const row = { id: 1, file_path: 'C:/Music/Eraser.flac', file_hash: 'hash', availability: 'available', metadata_json: JSON.stringify(local) };
  const candidate = { ...local, source: 'beatport', genre: 'Rock', subgenre: 'Industrial Metal, Industrial, Alternative Rock', bpm: 130, keyName: 'F Minor', camelot: '4A' };
  const result = previewForFile(row, [candidate]);
  for (const field of ['bpm', 'keyName', 'camelot']) assert.equal(result.changes.find(c => c.field === field).decision, 'safe_fill');
  assert.equal(result.changes.find(c => c.field === 'subgenre').decision, 'manual_review');
});

test('specific style removes redundant parent and existing embedded tags stay untouched', () => {
  const cleaned = cleanClassification({ source: 'beatport', genre: 'House', subgenre: 'Progressive House' });
  assert.equal(cleaned.genre, 'Electronic'); assert.equal(cleaned.subgenre, 'Progressive House');
  const local = { artist: 'Artist', title: 'Track', durationMs: 240000, genre: 'My personal genre', rawTags: { GENRE: 'My personal genre' } };
  const preview = previewForFile({ id: 1, file_path: 'C:/Music/a.flac', availability: 'available', metadata_json: JSON.stringify(local) }, [{ ...local, source: 'beatport', genre: 'House' }]);
  assert.equal(preview.changes.some(c => c.field === 'genre'), false);
});
