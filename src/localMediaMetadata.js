"use strict";
const path = require('node:path');
const { TAG_FIELDS, rawTagPresent } = require('./localLibraryMetadataWritePreview');
const { formatPolicy } = require('./localLibraryMetadataTagWriter');
const { POLICY, cleanClassification } = require('./localMetadataTaxonomy');
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const norm = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const title = value => norm(value).replace(/\boriginal mix\b/g, '').replace(/\s+/g, ' ').trim();
const present = value => value !== null && value !== undefined && String(value).trim() !== '';

function candidateSafety(local, candidate) {
  const reasons = [];
  if (candidate.requiresReview) reasons.push('PROVIDER_VERSION_NOT_VERIFIED');
  if (!['beatport', 'musicbrainz', 'discogs'].includes(candidate.source)) reasons.push('PROVIDER_EVIDENCE_NEEDS_REVIEW');
  const mix = candidate.mixName || candidate.mixVersion || '';
  let candidateTitle = candidate.title || '';
  if (mix && !norm(candidateTitle).includes(norm(mix))) candidateTitle += ` (${mix})`;
  if (!norm(local.artist) || norm(local.artist) !== norm(candidate.artist)) reasons.push('ARTIST_CREDIT_MISMATCH');
  if (!title(local.title) || title(local.title) !== title(candidateTitle)) reasons.push('TITLE_OR_VERSION_MISMATCH');
  const a = Number(local.durationMs), b = Number(candidate.durationMs);
  if (!a || !b) reasons.push('DURATION_NOT_VERIFIED');
  else if (Math.abs(a - b) > 2000) reasons.push('DURATION_MISMATCH');
  if (local.isrc && candidate.isrc && norm(local.isrc) !== norm(candidate.isrc)) reasons.push('ISRC_CONFLICT');
  return { safe: !reasons.length, reasons };
}

function normalizeCandidate(candidate) {
  return { ...candidate, ...cleanClassification(candidate), keyName: candidate.keyName || candidate.key,
    album: candidate.album || candidate.releaseTitle, catalogNumber: candidate.catalogNumber || candidate.rawJson?.catalog_number };
}

function previewForFile(row, candidates) {
  const local = parse(row.metadata_json);
  const checked = candidates.map(candidate => ({ ...normalizeCandidate(candidate), validation: candidateSafety(local, candidate) }));
  const changes = [];
  const safeFields = new Set(['genre', 'subgenre', 'bpm', 'keyName', 'camelot']);
  for (const definition of TAG_FIELDS) {
    if (rawTagPresent(local.rawTags || {}, definition.aliases) || present(local[definition.field])) continue;
    const evidence = checked.filter(c => present(c[definition.field])).map(c => ({
      value: c[definition.field], source: c.source, sourceId: c.id || c.musicBrainzId || c.discogsId || '',
      verified: c.validation.safe, reasons: c.validation.reasons,
      classificationReviewReasons: c.classificationReviewReasons || []
    }));
    if (!evidence.length) continue;
    const verified = evidence.filter(e => e.verified);
    const preferred = verified[0] || evidence[0];
    const conflicts = new Set(verified.map(e => norm(e.value))).size > 1;
    const reasons = [];
    if (!verified.length) reasons.push('RECORDING_MATCH_NEEDS_REVIEW');
    if (conflicts) reasons.push('PROVIDERS_DISAGREE');
    if (['genre', 'subgenre'].includes(definition.field)) {
      reasons.push(...new Set(preferred.classificationReviewReasons));
    }
    if (!safeFields.has(definition.field)) reasons.push('RELEASE_OR_IDENTITY_FIELD_NEEDS_REVIEW');
    if (row.availability !== 'available') reasons.push('FILE_UNAVAILABLE');
    if (formatPolicy(row.file_path).status !== 'supported') reasons.push('UNSUPPORTED_WRITE_FORMAT');
    changes.push({ field: definition.field, tag: definition.tag, value: preferred.value, source: preferred.source,
      decision: reasons.length ? 'manual_review' : 'safe_fill', reasons, evidence });
  }
  return { file: { id: row.id, filePath: row.file_path, fileHash: row.file_hash, format: path.extname(row.file_path).slice(1), artist: local.artist || '', title: local.title || '' },
    rowReasons: row.availability === 'available' ? [] : ['FILE_UNAVAILABLE'], changes,
    candidateCount: checked.length, verifiedCandidates: checked.filter(c => c.validation.safe).length,
    candidates: checked, completeness: null, classificationPolicy: POLICY };
}

function initializeMetadata(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_media_metadata (
    local_media_id INTEGER PRIMARY KEY, file_hash TEXT NOT NULL, result_json TEXT NOT NULL,
    lookup_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
  )`);
}

function summarize(items) {
  return {
    filesScanned: items.length, filesWithCandidates: items.filter(i => i.candidateCount).length,
    filesWithVerifiedCandidates: items.filter(i => i.verifiedCandidates).length,
    filesWithChanges: items.filter(i => i.changes.length).length,
    safeFillFiles: items.filter(i => i.changes.some(c => c.decision === 'safe_fill')).length,
    safeFillChanges: items.reduce((n, i) => n + i.changes.filter(c => c.decision === 'safe_fill').length, 0),
    manualReviewFiles: items.filter(i => i.changes.some(c => c.decision === 'manual_review')).length,
    manualReviewChanges: items.reduce((n, i) => n + i.changes.filter(c => c.decision === 'manual_review').length, 0),
    filesWithoutCandidates: items.filter(i => !i.candidateCount).length
  };
}

module.exports = { parse, norm, candidateSafety, previewForFile, initializeMetadata, summarize };
