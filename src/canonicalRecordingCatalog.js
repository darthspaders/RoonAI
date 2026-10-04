"use strict";
const { makeRecord } = require('../scripts/audit-recording-duplicates');
const { parseCanonicalCatalogIdentity } = require('./catalogIdentityNormalization');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exists = (db, table) => db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table);

function currentEvidence(db, id) {
  const row = db.prepare('SELECT * FROM track_identity WHERE id=?').get(id);
  if (!row) return null;
  const providers = new Map();
  for (const item of db.prepare('SELECT * FROM provider_enrichment WHERE track_identity_id=? ORDER BY fetched_at DESC,id DESC').all(id)) if (!providers.has(item.provider)) providers.set(item.provider, item);
  const record = makeRecord(row, db.prepare('SELECT * FROM beatport_enrichment WHERE track_identity_id=?').get(id), [...providers.values()]);
  const alias = exists(db, 'track_identity_alias') && db.prepare('SELECT * FROM track_identity_alias WHERE alias_identity_id=?').get(id);
  record.alias = alias ? { canonicalId: alias.canonical_identity_id, relation: alias.relation, confidence: alias.confidence, source: alias.source } : null;
  const coverage = exists(db, 'sonic_coverage_work') && db.prepare('SELECT state,resolved_identity_key FROM sonic_coverage_work WHERE identity_key=?').get(row.identity_key);
  record.coverage = coverage ? { state: coverage.state, resolvedKey: coverage.resolved_identity_key } : null;
  return record;
}

function readRecordingGroups(db) {
  if (!exists(db, 'canonical_recording_link_current')) return { groups: [], unavailable: false };
  const groups = [];
  for (const recording of db.prepare("SELECT * FROM canonical_recording WHERE state='VERIFIED'").all()) {
    const links = db.prepare('SELECT l.*,s.provider,s.kind,s.external_id,s.revision AS current_revision,p.raw_json FROM canonical_recording_link_current l JOIN canonical_source_object s ON s.id=l.source_id JOIN canonical_source_snapshot p ON p.source_id=l.source_id AND p.source_revision=l.source_revision WHERE l.target_id=?').all(recording.id);
    if (!links.length || links.some(l => l.state !== 'VERIFIED' || l.current_revision !== l.source_revision)) continue;
    const legacy = links.filter(l => l.provider === 'rabbit-hole' && l.kind === 'legacy');
    if (legacy.length < 2) continue;
    const ids = legacy.map(l => Number(l.external_id)).sort((a, b) => a - b);
    let valid = true;
    const expected = new Set(legacy.map(link => `rabbit-hole:legacy:${link.external_id}`));
    for (const link of links) {
      const evidence = JSON.parse(link.evidence_json);
      if (!equal([...(evidence.sourceRows || [])].sort((a, b) => a - b), ids)) valid = false;
    }
    for (const link of legacy) {
      const stored = JSON.parse(link.raw_json), current = currentEvidence(db, Number(link.external_id));
      for (const id of [stored.primary?.tidalId, stored.primary?.providerIds?.tidal].filter(Boolean)) expected.add(`tidal:track:${id}`);
      for (const fact of stored.facts || []) if (['tidal', 'beatport'].includes(fact.source) && fact.providerTrackId) expected.add(`${fact.source}:track:${fact.providerTrackId}`);
      if (!current || current.conflicts.length || !['primary', 'facts', 'secondaryProviders', 'alias', 'coverage'].every(field => equal(current[field], stored[field]))) valid = false;
    }
    const actual = new Set(links.map(link => `${link.provider}:${link.kind}:${link.external_id}`));
    if ([...expected].some(key => !actual.has(key))) valid = false;
    const version = JSON.parse(recording.version_json || '{}');
    const title = recording.preferred_title;
    const displayTitle = version.explicit && version.label && !parseCanonicalCatalogIdentity({ title }).version.explicit ? `${title} (${version.label})` : title;
    if (valid) groups.push({ id: recording.id, title: displayTitle, rowIds: ids });
  }
  // Never turn overlapping verified targets into a transitive group.
  const counts = new Map();
  for (const group of groups) for (const id of group.rowIds) counts.set(id, (counts.get(id) || 0) + 1);
  const safe = groups.filter(group => group.rowIds.every(id => counts.get(id) === 1));
  const safeRows = new Set(safe.flatMap(group => group.rowIds));
  const linkedRows = db.prepare("SELECT DISTINCT s.external_id FROM canonical_recording_link_current l JOIN canonical_source_object s ON s.id=l.source_id WHERE s.provider='rabbit-hole' AND s.kind='legacy'").all().map(row => Number(row.external_id));
  return { groups: safe, blockedRowIds: linkedRows.filter(id => !safeRows.has(id)), unavailable: false };
}

function browseRecordings(snapshot, query) {
  const { matches, FACETS, compareItems, publicRecord } = require('./databaseBrowserCatalog');
  const byId = new Map(snapshot.records.map(row => [row.id, row]));
  const used = new Set();
  let groups = [];
  for (const group of snapshot.recordingGroups?.groups || []) {
    const members = group.rowIds.map(id => byId.get(id));
    if (members.some(row => !row)) continue;
    members.sort((a, b) => Number(Boolean(b.tidalId)) - Number(Boolean(a.tidalId)) || a.id - b.id);
    groups.push({ key: `recording:${group.id}`, title: group.title, members, verified: true });
    members.forEach(row => used.add(row.id));
  }
  for (const row of snapshot.records) if (!used.has(row.id)) groups.push({ key: `source:${row.id}`, members: [row], verified: false });
  if (snapshot.displayGroups) groups = snapshot.displayGroups;
  const matching = groups.filter(group => group.members.some(row => matches(row, query)));
  const facets = {};
  for (const [field, getter] of Object.entries(FACETS)) {
    const counts = new Map();
    for (const group of groups) {
      const values = new Map();
      for (const row of group.members.filter(row => matches(row, query, field))) for (const value of getter(row).filter(Boolean)) values.set(value.toLowerCase(), value);
      for (const [key, value] of values) { const entry = counts.get(key) || { value, count: 0 }; entry.count++; counts.set(key, entry); }
    }
    facets[field] = [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  const items = matching.map(group => {
    const ratings = [...new Set(group.members.map(row => row.rating).filter(Boolean))];
    return { ...group.members[0], id: group.key, title: group.title || group.members[0].title,
      identityStatus: group.verified ? 'verified' : group.matched ? 'source-matched' : 'unresolved', sourceCount: group.members.length,
      matchReason: group.matchReason || '', verifiedSourceIds: group.verifiedRowIds || [],
      rating: ratings.length === 1 ? ratings[0] : '', ratingConflict: ratings.length > 1,
      sourceRecords: group.members.map(publicRecord), matchingSourceIds: group.members.filter(row => matches(row, query)).map(row => row.id) };
  }).sort(compareItems(query));
  const offset = items.length ? Math.min(query.offset, Math.floor((items.length - 1) / query.limit) * query.limit) : 0;
  const albumCollection = snapshot.albumCollections?.find(c => c.id === query.album || c.albumSources.some(source => source.key === query.album));
  return { enabled: true, view: 'recordings', query, total: items.length, matchingTracks: matching.length, catalogTracks: snapshot.records.length,
    catalogRecordings: groups.length, verifiedRecordings: groups.filter(g => g.verified).length, matchedRecordings: groups.filter(g => g.matched).length, unresolvedRecords: groups.filter(g => !g.verified && !g.matched).length,
    albumSources: albumCollection?.albumSources || [], albumCollectionKey: albumCollection?.id || '',
    canonicalUnavailable: Boolean(snapshot.recordingGroups?.unavailable), sonicAvailable: snapshot.sonicAvailable, generatedAt: snapshot.generatedAt,
    offset, limit: query.limit, items: items.slice(offset, offset + query.limit).map(publicRecord), facets, missingAlbumCount: 0 };
}
module.exports = { readRecordingGroups, browseRecordings, currentEvidence };
