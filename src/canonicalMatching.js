"use strict";
const { parseCanonicalCatalogIdentity } = require('./catalogIdentityNormalization');
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const isrc = value => { const s=String(value||'').replace(/[-\s]/g,'').toUpperCase(); return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s)?s:''; };
function recordingEvidence(a,b) {
  // Audit records carry a parsed version object. Only original text is evidence;
  // coercing that object to "[object Object]" invents an explicit version.
  const original = row => ({ ...row, version: typeof row.version === 'string' ? row.version : '' });
  const x=parseCanonicalCatalogIdentity(original(a)), y=parseCanonicalCatalogIdentity(original(b));
  const conflicts=[], unknown=[];
  // Raw band names containing '&' are opaque; never split them into invented artists.
  const credits = (row,p) => JSON.stringify(row.credits?.length ? row.credits.map(c=>[c.artistId||normalize(c.name),c.role||'primary']) : [normalize(row.artist),...p.featuredArtists.map(normalize)]);
  if((!a.artist&&!a.credits?.length)||(!b.artist&&!b.credits?.length)) unknown.push('artist-credits');
  else if(credits(a,x)!==credits(b,y)) conflicts.push('artist-credits');
  if(x.normalizedBaseTitle!==y.normalizedBaseTitle) conflicts.push('base-title');
  if(!x.version.explicit||!y.version.explicit) unknown.push('version');
  else if(x.version.normalized!==y.version.normalized) conflicts.push('version-semantics');
  if(a.performanceContext&&b.performanceContext&&normalize(a.performanceContext)!==normalize(b.performanceContext)) conflicts.push('performance-context');
  if(isrc(a.isrc)&&isrc(b.isrc)&&isrc(a.isrc)!==isrc(b.isrc)) conflicts.push('contradictory-isrc');
  const delta=a.durationMs>0&&b.durationMs>0?Math.abs(a.durationMs-b.durationMs):null;
  if(delta===null) unknown.push('full-duration'); else if(delta>5000) conflicts.push('duration'); else if(delta>2000) unknown.push('duration-review');
  return { state:'PROPOSED', eligible:!conflicts.length, conflicts, unknown, durationDeltaMs:delta,
    sameProviderObject:!!a.provider&&a.provider===b.provider&&!!a.providerTrackId&&String(a.providerTrackId)===String(b.providerTrackId),
    sameIsrc:!!isrc(a.isrc)&&isrc(a.isrc)===isrc(b.isrc), ruleset:'canonical-foundation-v1' };
}
function releaseEvidence(a,b) {
  const conflicts=[],unknown=[];
  for(const field of ['artist','title','upc','catalogNumber','label']) {
    if(!a[field]||!b[field]) unknown.push(field);
    else if(normalize(a[field])!==normalize(b[field])) conflicts.push(field);
  }
  for(const field of ['edition','releaseType','territory','format','masteringContext','releaseDate']) {
    if(!a[field]||!b[field]) unknown.push(field); else if(normalize(a[field])!==normalize(b[field])) conflicts.push(field);
  }
  const sameProviderObject=!!a.provider&&a.provider===b.provider&&!!a.providerReleaseId&&String(a.providerReleaseId)===String(b.providerReleaseId);
  // Full ordered tracklists must carry recording/version evidence, not title-only equality.
  const orderedTracklist = a.tracklist?.length && a.completeTracklist && b.completeTracklist ? JSON.stringify(a.tracklist)===JSON.stringify(b.tracklist):null;
  if(orderedTracklist===null) unknown.push('complete-ordered-tracklist'); else if(!orderedTracklist) conflicts.push('ordered-tracklist');
  return {state:'PROPOSED',eligible:!conflicts.length,conflicts,unknown,sameProviderObject,orderedTracklist,
    identifiers:{upc:!!a.upc&&a.upc===b.upc,catalog:!!a.catalogNumber&&a.catalogNumber===b.catalogNumber&&!!a.label&&normalize(a.label)===normalize(b.label)},ruleset:'canonical-foundation-v1'};
}
module.exports={recordingEvidence,releaseEvidence,normalize,isrc};
