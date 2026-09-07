"use strict";
const { normalize, artists } = require('./exactTrackVerification');

function identity(track, item = {}, policy = 'flexible') {
  const suffix = item.version || item.remix;
  const title = suffix && !normalize(item.title).includes(normalize(suffix)) ? `${item.title} ${suffix}` : item.title;
  const credit = item.artist || String(item.subtitle || '').split(/\s+-\s+/)[0];
  const wanted = artists(track.artist).split('|').filter(Boolean).map(value => value.replace(/\s/g, ''));
  const credited = artists(credit).split('|').map(value => value.replace(/\s/g, ''));
  const artistExact = wanted.length > 0 && wanted.every(value => credited.includes(value));
  const compact = value => normalize(value).replace(/\s/g, '');
  const titleExact = compact(track.title) === compact(title);
  const id = String(track.tidalTrackId || track.tidal?.id || '');
  const otherId = String(item.tidalTrackId || item.tidal?.id || '');
  const idMatch = Boolean(id && otherId && id === otherId);
  const isrcMatch = Boolean(track.isrc && item.isrc && normalize(track.isrc) === normalize(item.isrc));
  const duration = Number(item.durationMs || (item.length || item.duration || 0) * 1000);
  const durationMatch = Boolean(track.durationMs && duration && Math.abs(track.durationMs - duration) <= 2000);
  const albumMatch = Boolean(track.album && item.album && normalize(track.album) === normalize(item.album));
  const conflict = Boolean((id && otherId && id !== otherId) || (track.isrc && item.isrc && !isrcMatch) || (track.durationMs && duration && !durationMatch));
  // Only generic mix suffixes may be absent; named remixes must remain distinct.
  const base = value => compact(String(value).replace(/\s*(?:[([]| - )?\s*(?:extended|original)\s+(?:mix|version)\s*[)\]]?\s*$/i, ''));
  const sameBase = base(track.title) === base(title);
  const strong = idMatch || isrcMatch || (albumMatch && durationMatch);
  const explicitGeneric = value => /(?:extended|original)\s+(?:mix|version)\s*[)\]]?\s*$/i.test(String(value));
  const accepted = !conflict && artistExact && (titleExact || (policy === 'flexible' && sameBase && strong && !(explicitGeneric(track.title) && explicitGeneric(title)))) ;
  return { accepted, titleExact, artistExact, idMatch, isrcMatch, durationMatch, albumMatch,
    confidence: accepted ? (idMatch ? 1 : isrcMatch ? 0.99 : titleExact ? 0.96 : 0.9) : 0,
    method: idMatch ? 'tidal_identity' : isrcMatch ? 'isrc' : 'artist_title',
    failureType: conflict ? 'identity_mismatch' : artistExact && !titleExact ? 'version_mismatch' : 'not_found' };
}

const trackSchema = { type: 'object', properties: {
  artist: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 },
  album: { type: 'string' }, tidalTrackId: { type: 'string' }, isrc: { type: 'string' },
  durationMs: { type: 'integer', minimum: 1 }, queueToken: { type: 'string' }
}, required: ['artist', 'title'], additionalProperties: false };
const policySchema = { type: 'string', enum: ['flexible', 'strict'], default: 'flexible' };
function validate(input, search = false) {
  const policy = input.matchPolicy || 'flexible', mode = input.mode || 'append';
  if (!['flexible', 'strict'].includes(policy) || !['append', 'next'].includes(mode)) throw new Error('Invalid matchPolicy or mode.');
  const tracks = search ? [input] : input.tracks;
  if (!Array.isArray(tracks) || !tracks.length || tracks.length > 500) throw new Error('Provide a structured array of 1–500 track objects.');
  return { policy, mode, tracks: tracks.map((track, index) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) throw new Error(`Track ${index + 1} must be an object, not a parsed list string.`);
    const out = {};
    for (const key of Object.keys(trackSchema.properties)) {
      if (track[key] === undefined) continue;
      if (key === 'durationMs') { if (!Number.isInteger(track[key]) || track[key] <= 0) throw new Error('durationMs must be a positive integer.'); out[key] = track[key]; }
      else { if (typeof track[key] !== 'string') throw new Error(`${key} must be a string.`); out[key] = track[key].trim(); }
    }
    if (!out.artist || !out.title) throw new Error(`Track ${index + 1} requires artist and title.`);
    return out;
  }) };
}
function failureStatus(type = '', reason = '') {
  if (type === 'bridge_resolution_failed') return 'BRIDGE_RESOLUTION_FAILED';
  if (type === 'roon_catalog_missing') return 'ROON_CATALOG_MISSING';
  if (type === 'queue_failed') return 'QUEUE_FAILED';
  if (/timeout|timed out/i.test(type + reason)) return 'ROON_TIMEOUT';
  if (/version|identity_mismatch/.test(type)) return 'VERSION_MISMATCH';
  if (type === 'ambiguous') return 'AMBIGUOUS';
  return 'NOT_FOUND';
}
class DirectRoonQueue {
  constructor(roon, logger = () => {}, knownTracks = () => []) { this.roon = roon; this.logger = logger; this.knownTracks = knownTracks; this.tail = Promise.resolve(); }
  enrich(track) {
    // Read existing verified metadata only. No TIDAL lookup or bridge creation.
    const known = this.knownTracks().find(item =>
      (track.tidalTrackId && String(item.tidalTrackId || item.id) === track.tidalTrackId) ||
      (track.isrc && item.isrc && normalize(item.isrc) === normalize(track.isrc)));
    if (!known) return track;
    return { ...track, album: track.album || known.album || '', durationMs: track.durationMs || known.durationMs || 0,
      isrc: track.isrc || known.isrc || '', tidalTrackId: track.tidalTrackId || String(known.tidalTrackId || known.id || '') };
  }
  queue(input) {
    const validated = validate(input); // Reject malformed batches before any writes.
    const work = this.tail.catch(() => {}).then(() => this.run(input, validated));
    this.tail = work.catch(() => {}); return work;
  }
  async run(input, { tracks, policy, mode }) {
    const started = Date.now(), results = [], warnings = [];
    this.roon.getZone(input.zoneId);
    this.logger({ event: 'start', batchSize: tracks.length, zone: input.zoneId, mode, matchPolicy: policy });
    const indexed = tracks.map((track, index) => ({ track, index }));
    const batches = [];
    for (let offset = 0; offset < indexed.length; offset += 50) batches.push(indexed.slice(offset, offset + 50));
    // Add Next inserts at the front: later chunks must go first, too.
    if (mode === 'next') batches.reverse();
    for (const batch of batches) {
      let result;
      try {
        result = await this.roon.queueTracks(batch.map(({ track }) => ({ ...this.enrich(track), directMatchPolicy: policy, verifiedQueueToken: track.queueToken || '' })), input.zoneId,
          { mode, matchPolicy: policy, targetCount: batch.length, preferExtendedMixes: false, allowBridge: input.allowBridge === true, bridgeSyncDelaysMs: input.bridgeSyncDelaysMs, bridgeLookupTimeoutMs: input.bridgeLookupTimeoutMs });
      } catch (error) {
        result = { queued: [], failed: batch.map((entry, index) => ({ index, reason: error.message, failureType: 'queue_failed' })) };
      }
      if (result.warning) warnings.push(result.warning);
      const execution = mode === 'next' ? batch.slice().reverse() : batch;
      for (const [success, rows] of [[true, result.queued], [false, result.failed]]) for (const row of rows) {
        const { track, index } = execution[row.index];
        const evidence = row.identityEvidence || {};
        const entry = { index, requestedArtist: track.artist, requestedTitle: track.title,
          resolvedArtist: row.match?.artist || String(row.match?.subtitle || '').split(/\s+-\s+/)[0], resolvedTitle: row.match?.title || '',
          status: success ? 'QUEUED' : failureStatus(row.failureType, row.reason), matchPolicy: policy,
          matchConfidence: evidence.confidence || 0, queueable: success || Boolean(row.resolved), queued: success,
          queueToken: '', failureType: success ? '' : row.failureType || 'not_found', reason: row.reason || '',
          resolutionMethod: row.resolutionMethod || evidence.method || '', searchVariants: row.attempts?.map(a => a.query) || [],
          bridge: row.bridge || null, directFailure: row.directFailure || null, album: row.match?.album || '', albumFallback: row.albumFallback || null,
          queueAction: row.action || '', elapsedMs: row.elapsedMs || 0, requestedTrack: track };
        results.push(entry);
        this.logger({ event: 'track', index, status: entry.status, zone: input.zoneId, resolutionMethod: entry.resolutionMethod,
          searchVariants: entry.searchVariants, matchConfidence: entry.matchConfidence, queueAction: entry.queueAction, elapsedMs: entry.elapsedMs, failureType: entry.failureType });
      }
    }
    results.sort((a, b) => a.index - b.index);
    const queued = results.filter(r => r.queued).length;
    const output = { requested: tracks.length, resolved: results.filter(r => r.queueable).length, queued, failed: tracks.length - queued,
      zoneId: input.zoneId, mode, matchPolicy: policy, results, failures: results.filter(r=>!r.queued), failedRequestedTracks: results.filter(r=>!r.queued).map(r=>r.requestedTrack), warnings: [...new Set(warnings)], elapsedMs: Date.now() - started };
    this.logger({ event: 'complete', requested: tracks.length, queued, failed: output.failed, elapsedMs: output.elapsedMs });
    return output;
  }
  async search(input) {
    const { tracks: [track], policy } = validate(input, true);
    const lookup = this.enrich(track);
    const result = await this.roon.canQueueTrack({ ...lookup, directMatchPolicy: policy }, input.zoneId, { matchPolicy: policy });
    const candidates = [result.match, ...(result.candidates || [])].filter(Boolean);
    const seen = new Set();
    return { zoneId: input.zoneId, matchPolicy: policy, queueable: Boolean(result.success), queueToken: result.queueToken || '',
      resolutionMethod: result.resolutionMethod || '', albumFallback: result.albumFallback || null,
      failureType: result.failureType || '', reason: result.reason || '', searchVariants: result.attempts?.map(a => a.query) || [],
      matches: candidates.filter(item => { const key = item.item_key || item.key || JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; }).map((item, index) => ({
        artist: item.artist || String(item.subtitle || '').split(/\s+-\s+/)[0], title: item.title || '', album: item.album || '',
        durationMs: item.durationMs || (item.length ? item.length * 1000 : null), version: item.version || item.remix || String(item.title || '').match(/[([]([^\])]*(?:mix|edit|version)[^\])]*)[)\]]/i)?.[1] || '',
        queueable: index === 0 && Boolean(result.success), confidence: identity(lookup, item, policy).confidence,
        internalActionIdentity: index === 0 ? result.queueToken || '' : ''
      })) };
  }
}
module.exports = { DirectRoonQueue, identity, trackSchema, policySchema, validate };
