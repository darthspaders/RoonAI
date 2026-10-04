"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const config = require('../src/config');
const { acquireProcessLock } = require('../src/processLock');
const { parse, previewForFile, initializeMetadata, summarize } = require('../src/localMediaMetadata');
const { memoryEvidenceForTrack } = require('../src/localLibraryMetadataEnrichment');

async function main() {
  const online = process.argv.includes('--online');
  const musicbrainz = process.argv.includes('--musicbrainz');
  const dbFile = config.musicMemory.dbFile;
  const lock = acquireProcessLock(`${dbFile}.local-metadata.lock`, 'Local media metadata gathering');
  const db = new DatabaseSync(dbFile); db.exec('PRAGMA busy_timeout=10000;');
  try {
    await backup(db, `${dbFile}.before-local-metadata-${Date.now()}.bak`);
    initializeMetadata(db);
    const rows = db.prepare("SELECT * FROM local_media_file WHERE availability='available' ORDER BY id").all();
    const oldMatch = db.prepare(`SELECT m.provider,m.accepted,m.candidate_json FROM local_library_match m
      JOIN local_library_file f ON f.id=m.local_file_id WHERE f.file_hash=?`);
    const prior = db.prepare('SELECT * FROM local_media_metadata WHERE local_media_id=? AND file_hash=?');
    const save = db.prepare(`INSERT INTO local_media_metadata VALUES(?,?,?,?,?) ON CONFLICT(local_media_id) DO UPDATE SET
      file_hash=excluded.file_hash,result_json=excluded.result_json,lookup_json=excluded.lookup_json,updated_at=excluded.updated_at`);
    const clients = {};
    if (online) {
      const { BeatportClient } = require('../src/beatportClient');
      const { DiscogsClient } = require('../src/discogsClient');
      const { DiscogsOAuth } = require('../src/discogsOAuth');
      clients.beatport = new BeatportClient({ ...config.beatport });
      clients.discogs = new DiscogsClient({ ...config.discogs, oauth: new DiscogsOAuth({ ...config.discogs, tokenFile: config.discogs.oauthTokenFile }) });
    }
    const items = [];
    const mbResults = new Map();
    if (musicbrainz) {
      const { MusicBrainzLocalIndex, bucketForTitle } = require('../src/musicBrainzLocalIndex');
      const mb = new MusicBrainzLocalIndex({ ...config.musicBrainzLocal });
      if (!mb.isAvailable()) throw new Error('MusicBrainz local index is unavailable.');
      const known = new Set(db.prepare("SELECT f.file_hash FROM local_library_match m JOIN local_library_file f ON f.id=m.local_file_id WHERE m.provider='musicbrainz'").all().map(r => r.file_hash));
      const pending = rows.filter(row => !known.has(row.file_hash) && !parse(prior.get(row.id, row.file_hash)?.lookup_json).musicbrainz);
      console.log(JSON.stringify({ musicbrainzPending: pending.length }));
      const buckets = new Map();
      for (const row of pending) { const key = bucketForTitle(parse(row.metadata_json).title); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); }
      let bucketsDone = 0;
      for (const group of buckets.values()) {
      const batch = mb.searchRecordingsBatch(group.map(row => parse(row.metadata_json)));
      group.forEach((row, i) => mbResults.set(row.id, (batch[i] || []).map(recording => ({
        source: 'musicbrainz', id: recording.id, title: recording.title,
        artist: (recording['artist-credit'] || []).map(c => c.artist?.name || c.name).filter(Boolean).join(', '),
        durationMs: recording.length, genre: [...(recording.genres || []), ...(recording.tags || [])].map(t => t.name).filter(Boolean).join(', '),
        album: recording.releases?.[0]?.title, releaseDate: recording.releases?.[0]?.date,
        isrc: (recording.isrcs || []).find(isrc => isrc === parse(row.metadata_json).isrc) || recording.isrcs?.[0] || ''
      }))));
      for (const row of group) {
        const previous = prior.get(row.id, row.file_hash);
        if (!previous) continue;
        const stored = previous ? parse(previous.result_json).candidates || [] : [];
        const lookup = previous ? parse(previous.lookup_json) : {};
        lookup.musicbrainz = mbResults.get(row.id).length ? 'looked_up' : 'not_found';
        const updated = previewForFile(row, [...stored, ...mbResults.get(row.id)]);
        updated.lookup = lookup;
        save.run(row.id, row.file_hash, JSON.stringify(updated), JSON.stringify(lookup), new Date().toISOString());
      }
      console.log(JSON.stringify({ stage: 'musicbrainz', bucketsDone: ++bucketsDone, bucketsTotal: buckets.size, filesChecked: mbResults.size }));
      }
    }
    const reportFile = path.join(path.dirname(dbFile), 'local-media-metadata-preview.json');
    const checkpoint = complete => {
      const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), complete, mode: online ? 'online-gap-fill' : 'stored-provider-evidence',
        policy: { writesAudioFiles: false, fillsOnlyMissingTags: true, overwritesExistingTags: false, exactTitleArtistAndDurationRequired: true, releaseFieldsRequireReview: true },
        summary: { ...summarize(items), inventoryFiles: rows.length }, items };
      const destination = complete ? reportFile : reportFile.replace('.json', '.progress.json');
      fs.writeFileSync(`${destination}.tmp`, JSON.stringify(report)); fs.renameSync(`${destination}.tmp`, destination);
      console.log(JSON.stringify({ complete, ...report.summary, reportFile }));
    };
    for (const row of rows) {
      const local = parse(row.metadata_json);
      const previous = prior.get(row.id, row.file_hash);
      const candidates = previous ? parse(previous.result_json).candidates || [] : [];
      const lookup = previous ? parse(previous.lookup_json) : {};
      const matches = previous ? [] : oldMatch.all(row.file_hash);
      for (const match of matches) {
        lookup[match.provider] ||= 'stored_lookup';
        if (match.accepted) candidates.push({ ...parse(match.candidate_json), source: match.provider });
      }
      for (const item of (previous ? [] : memoryEvidenceForTrack({ db }, local).evidence)) {
        if (item.source && item.values) candidates.push({ ...item.values, source: item.raw?.provider || item.source, id: item.raw?.provider_track_id || '', requiresReview: true, rawEvidence: item.raw });
      }
      if (mbResults.has(row.id)) { candidates.push(...mbResults.get(row.id)); lookup.musicbrainz = mbResults.get(row.id).length ? 'looked_up' : 'not_found'; }
      let unique = [...new Map(candidates.map(c => [JSON.stringify([c.source,c.id,c.title,c.mixName,c.mixVersion,c.isrc,c.album,c.genre,c.subgenre,c.bpm,c.keyName,c.durationMs,c.requiresReview]),c])).values()];
      let preview = previewForFile(row, unique);
      // Online requests fill gaps; existing strict matches are already useful metadata.
      if (online && !preview.verifiedCandidates && local.artist && local.title) {
        for (const [provider, client] of Object.entries(clients)) {
          if (lookup[provider] === 'looked_up' || lookup[provider] === 'not_found') continue;
          if (!client.isConfigured()) { lookup[provider] = 'unavailable'; continue; }
          try {
            const candidate = await client.findTrack(local);
            lookup[provider] = candidate ? 'looked_up' : 'not_found';
            if (candidate) unique.push({ ...candidate, source: provider });
          } catch (error) { lookup[provider] = `error: ${error.message}`; }
        }
        preview = previewForFile(row, unique);
      }
      preview.lookup = lookup;
      save.run(row.id, row.file_hash, JSON.stringify(preview), JSON.stringify(lookup), new Date().toISOString());
      items.push(preview);
      if (items.length % 250 === 0) checkpoint(false);
    }
    checkpoint(true);
  } finally { db.close(); lock.release(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
