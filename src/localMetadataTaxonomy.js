"use strict";

// Applies the cleanup rules visible in Synapse's review, not unobserved edits
// from its generated attachment. Unknown classifications remain review evidence.
const POLICY = 'synapse-review-rules-v1';
const key = value => String(value || '').trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ');
const families = new Map(['Electronic', 'Rock', 'Metal', 'Pop', 'Hip Hop', 'Jazz', 'Classical', 'Blues', 'Country', 'Folk', 'Reggae', 'Soul', 'R&B'].map(name => [key(name), name]));
const styles = new Map(Object.entries({
  'alternative rock': ['Alternative Rock', 'Rock'], 'alt rock': ['Alternative Rock', 'Rock'],
  'alternative metal': ['Alternative Metal', 'Metal'], 'alt metal': ['Alternative Metal', 'Metal'],
  'progressive rock': ['Progressive Rock', 'Rock'], 'hard rock': ['Hard Rock', 'Rock'],
  'industrial rock': ['Industrial Rock', 'Rock'], 'industrial metal': ['Industrial Metal', 'Metal'],
  'industrial': ['Industrial', null], 'ambient': ['Ambient', null],
  'house': ['House', 'Electronic'], 'progressive house': ['Progressive House', 'Electronic'],
  'electro house': ['Electro House', 'Electronic'], 'deep house': ['Deep House', 'Electronic'],
  'tech house': ['Tech House', 'Electronic'], 'melodic house': ['Melodic House', 'Electronic'],
  'techno': ['Techno', 'Electronic'], 'melodic techno': ['Melodic Techno', 'Electronic'],
  'trance': ['Trance', 'Electronic'], 'progressive trance': ['Progressive Trance', 'Electronic'],
  'psytrance': ['Psytrance', 'Electronic'], 'dubstep': ['Dubstep', 'Electronic'],
  'glitch hop': ['Glitch Hop', 'Electronic'], 'drum and bass': ['Drum & Bass', 'Electronic'],
  'drum & bass': ['Drum & Bass', 'Electronic'], 'dnb': ['Drum & Bass', 'Electronic'],
  'breakbeat': ['Breakbeat', 'Electronic'], 'breaks': ['Breakbeat', 'Electronic'],
  'downtempo': ['Downtempo', 'Electronic'], 'electronica': ['Electronica', 'Electronic'],
  'synthpop': ['Synthpop', 'Pop'], 'synth pop': ['Synthpop', 'Pop']
}));
const aliases = new Map([['hiphop', 'hip hop'], ['rhythm and blues', 'r&b']]);
function split(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/[,;\u0000]+/)).map(v => String(v).trim()).filter(Boolean);
}

function cleanClassification(candidate) {
  const original = candidate.classificationOriginal || { genre: candidate.genre || '', subgenre: candidate.subgenre || candidate.subGenre || '' };
  const broad = new Set(), specific = new Set(), unknown = new Set();
  for (const token of [...split(original.genre), ...split(original.subgenre)]) {
    const normalized = aliases.get(key(token)) || key(token);
    if (families.has(normalized)) broad.add(families.get(normalized));
    else if (styles.has(normalized)) { const [name, parent] = styles.get(normalized); specific.add(name); if (parent) broad.add(parent); }
    else unknown.add(token);
  }
  for (const parent of ['House', 'Trance', 'Techno']) {
    if ([...specific].some(style => style !== parent && style.endsWith(` ${parent}`))) specific.delete(parent);
  }
  const reasons = [];
  if (candidate.source === 'musicbrainz') reasons.push('MUSICBRAINZ_CLASSIFICATION_REVIEW');
  if (candidate.source === 'discogs' && (specific.size > 1 || (candidate.rawJson?.styles || []).length > 1)) reasons.push('RELEASE_STYLE_INHERITANCE_REVIEW');
  if (specific.size > 1) reasons.push('MULTIPLE_STYLES_NEED_TRACK_REVIEW');
  if (broad.size > 1) reasons.push('MULTIPLE_GENRES_NEED_TRACK_REVIEW');
  if (unknown.size) reasons.push('UNMAPPED_CLASSIFICATION_REVIEW');
  return { genre: [...broad].sort().join('; '), subgenre: [...specific].sort().join('; '),
    classificationOriginal: original, classificationReviewReasons: reasons,
    unclassifiedTags: [...unknown], classificationPolicy: POLICY };
}

module.exports = { POLICY, cleanClassification };
