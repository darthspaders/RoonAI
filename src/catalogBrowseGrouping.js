"use strict";
// Reversible browsing projection. Never writes identity, release or rating data.
const { createHash } = require('node:crypto');
const { parseCanonicalCatalogIdentity, normalizeCatalogText } = require('./catalogIdentityNormalization');
const { isrc } = require('./canonicalMatching');
const normalized = value => normalizeCatalogText(value).replace(/\s+/g, '');
// Do not split band names on '&', '+' or the word 'and'.
const credits = value => [...new Set(String(value || '').split(/\s*,\s*|\s+\/\s+/).map(normalized).filter(Boolean))].sort();
const creditKey = value => credits(value).join('|');
function rowCredits(row) {
  const names = row._artistCredits || [];
  const provider = names.map(normalized).sort().join('|');
  const split = String(row.artist || '').split(/\s*,\s*|\s+\/\s+|\s+&\s+/).map(normalized).filter(Boolean).sort().join('|');
  return names.length > 1 && split === provider ? provider : creditKey(row.artist);
}
const signature = row => parseCanonicalCatalogIdentity({ title: row.title, mixVersion: row.mixVersion || row.mixName || '' });
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
function compatible(a, b) {
  const x = signature(a), y = signature(b);
  if (!a.artist || !b.artist || rowCredits(a) !== rowCredits(b) || !x.normalizedBaseTitle || x.normalizedBaseTitle !== y.normalizedBaseTitle) return false;
  if (x.version.explicit && y.version.explicit && x.version.normalized !== y.version.normalized) return false;
  if (isrc(a.isrc) && isrc(b.isrc) && isrc(a.isrc) !== isrc(b.isrc)) return false;
  return a.durationMs > 0 && b.durationMs > 0 && Math.abs(a.durationMs - b.durationMs) <= 2000;
}
function sourceKeys(row) {
  const keys = [];
  const validFacts = (row._browseEvidence || []).filter(fact => compatible(row, fact));
  if (/^\d+$/.test(row.tidalId || '')) keys.push(`tidal:${row.tidalId}`);
  for (const fact of row._browseEvidence || []) {
    if (!['tidal', 'beatport'].includes(fact.provider) || !/^\d+$/.test(fact.id || '') || !compatible(row, fact)) continue;
    keys.push(`${fact.provider}:${fact.id}`);
  }
  const versions = [...new Set([row, ...validFacts].map(signature).filter(s => s.version.explicit).map(s => s.version.normalized))];
  const codes = [...new Set([row, ...validFacts].map(fact => isrc(fact.isrc)).filter(Boolean))];
  if (versions.length === 1 && codes.length === 1) keys.push(`isrc:${codes[0]}:${versions[0]}`);
  return [...new Set(keys)].sort();
}

function recordingGroups(records, verified = [], blockedRowIds = []) {
  const byId = new Map(records.map(row => [row.id, row]));
  const blocked = new Set(blockedRowIds);
  const keys = new Map(records.map(row => [row.id, blocked.has(row.id) ? [] : sourceKeys(row)]));
  const groups = [], used = new Set();
  // Verified groups retain their durable UUID. Exact source duplicates may extend
  // the browsing group, but do not acquire a verified database link themselves.
  for (const group of verified) {
    const members = group.rowIds.map(id => byId.get(id));
    if (members.some(row => !row || used.has(row.id))) continue;
    const common = keys.get(members[0].id).filter(key => members.every(row => keys.get(row.id).includes(key)));
    groups.push({ key: `recording:${group.id}`, title: group.title, members, common, verified: true, verifiedRowIds: group.rowIds });
    members.forEach(row => used.add(row.id));
  }
  const buckets = new Map();
  for (const row of records) for (const key of keys.get(row.id)) { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); }
  for (const group of groups) for (const key of group.common) for (const row of buckets.get(key) || []) {
    if (!group.common.includes(key)) continue;
    if (!used.has(row.id) && group.members.every(member => compatible(member, row))) { group.members.push(row); used.add(row.id); group.common = group.common.filter(k => keys.get(row.id).includes(k)); }
  }
  for (const [key, bucket] of [...buckets].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const candidates = bucket.filter(row => !used.has(row.id)).sort((a, b) => a.id - b.id);
    while (candidates.length) {
      const members = [candidates.shift()];
      for (let i = 0; i < candidates.length;) {
        if (members.every(member => compatible(member, candidates[i]))) members.push(...candidates.splice(i, 1)); else i++;
      }
      if (members.length < 2) continue;
      groups.push({ key: `provider-recording:${key}:${members[0].id}`, members, verified: false, matched: true, matchReason: key.startsWith('isrc:') ? 'Same attributed ISRC and explicit version; compatible credits and full duration' : `Same ${key.split(':')[0].toUpperCase()} track; compatible credits, version and duration` });
      members.forEach(row => used.add(row.id));
    }
  }
  for (const row of records) if (!used.has(row.id)) groups.push({ key: `source:${row.id}`, members: [row], verified: false });
  for (const group of groups) {
    group.members.sort((a, b) => Number(Boolean(b.tidalId)) - Number(Boolean(a.tidalId)) || a.id - b.id);
    for (const row of group.members) row.recordingKey = group.key;
  }
  return groups;
}

function albumCollections(records) {
  const albumYear = row => Object.hasOwn(row, 'albumYear') ? row.albumYear : row.year;
  const units = new Map();
  for (const row of records.filter(r => r.albumKey)) {
    if (!units.has(row.albumKey)) units.set(row.albumKey, { key: row.albumKey, name: row.album, rows: [] });
    units.get(row.albumKey).rows.push(row);
  }
  const families = [];
  // An exact release is one unit, even with guests/compilation artists. Related
  // units share an unstripped title and an artist common to every unit. They are
  // album collections, NOT a claim that regional/reissue editions are identical.
  for (const unit of [...units.values()].sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key))) {
    const sourceCredits = unit.rows.map(row => credits(row.albumArtist || row.artist));
    unit.common = sourceCredits[0].filter(name => sourceCredits.every(names => names.includes(name)));
    unit.titleKey = normalizeCatalogText(unit.name);
    const family = unit.common.length && families.find(f => f.titleKey === unit.titleKey && f.common.some(name => unit.common.includes(name)));
    if (family) { family.units.push(unit); family.common = family.common.filter(name => unit.common.includes(name)); }
    else families.push({ titleKey: unit.titleKey, common: unit.common, units: [unit] });
  }
  return families.map(family => {
    const all = family.units.flatMap(unit => unit.rows).sort((a, b) => Number(Boolean(b.tidalId)) - Number(Boolean(a.tidalId)) || a.id - b.id);
    const key = family.units.length === 1 ? family.units[0].key : `album-collection:${digest(family.titleKey + '|' + family.common.join('|'))}`;
    const names = all.flatMap(row => String(row.albumArtist || row.artist).split(/\s*,\s*|\s+\/\s+/));
    const artist = family.common.map(key => names.find(name => normalized(name) === key)).filter(Boolean).join(', ') || (new Set(all.map(row => row.artist)).size === 1 ? all[0].artist : 'Various artists');
    const years = [...new Set(all.map(albumYear).filter(Boolean))].sort();
    const contextualImages = all.map(row => row.albumImage).filter(Boolean);
    for (const row of all) row.albumCollectionKey = key;
    return { id: key, value: key, name: family.units[0].name, artist, year: years.length === 1 ? years[0] : null,
      images: [...new Set(contextualImages.length ? contextualImages : all.map(row => row.imageUrl).filter(Boolean))].slice(0, 4),
      sourceReleaseCount: family.units.length, sourceRows: all.map(row => row.id),
      albumSources: family.units.map(unit => ({ key: unit.key, name: unit.name, artist: unit.rows[0].albumArtist || unit.rows[0].artist,
        years: [...new Set(unit.rows.map(albumYear).filter(Boolean))].sort(), count: new Set(unit.rows.map(row => row.recordingKey || row.id)).size })) };
  });
}
function prepareBrowseGrouping(snapshot) {
  snapshot.browseRecords = snapshot.records.map(row => {
    const exact = (row._browseEvidence || []).find(fact => fact.provider === 'beatport' && normalized(row.artist) === normalized(fact.title) && normalized(row.title) === normalized(fact.artist) && row.durationMs > 0 && Math.abs(row.durationMs - fact.durationMs) <= 2000);
    return exact ? { ...row, artist: exact.artist, title: exact.title, originalMetadata: { artist: row.artist, title: row.title }, displayCorrection: 'Artist/title swapped in stored observation; exact provider metadata used for display' } : { ...row };
  });
  snapshot.displayGroups = recordingGroups(snapshot.browseRecords, snapshot.recordingGroups?.groups || [], snapshot.recordingGroups?.blockedRowIds || []);
  snapshot.albumCollections = albumCollections(snapshot.browseRecords);
  const projected = new Map(snapshot.browseRecords.map(row => [row.id, row]));
  for (const row of snapshot.records) { row.albumCollectionKey = projected.get(row.id).albumCollectionKey; row.recordingKey = projected.get(row.id).recordingKey; }
  return snapshot;
}
module.exports = { compatible, sourceKeys, recordingGroups, albumCollections, prepareBrowseGrouping, creditKey };
