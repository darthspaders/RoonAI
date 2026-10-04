"use strict";
const norm = value => String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
// Phase 1 legacy repair is strictly same-row, same stored provider object and edition.
// It does not turn enrichment confidence into a canonical VERIFIED link.
function recoverLegacyArtwork(record, history, artwork, safeImage) {
  const latest=new Map();
  const sorted=[...history].sort((a,b)=>String(b.fetched_at).localeCompare(String(a.fetched_at))||b.id-a.id);
  for(const entry of sorted) if(!latest.has(entry.provider)) latest.set(entry.provider,entry);
  const candidates=[];
  for(const entry of sorted) {
    const current=latest.get(entry.provider);
    if(!entry.release_id||!entry.provider_track_id||entry.release_id!==current.release_id||entry.provider_track_id!==current.provider_track_id) continue;
    if(!record.album||norm(entry.release_title)!==norm(record.album)||norm(current.release_title)!==norm(record.album)) continue;
    if(Number(entry.confidence)<99||Number(current.confidence)<99) continue;
    let url=artwork(entry.raw,entry.provider), reason='same-provider-release-history';
    // Cover Art Archive URLs encode an exact edition. Historical adapter bugs
    // sometimes copied an image from another MusicBrainz release into this row.
    const archiveRelease=String(entry.raw.sourceImageUrl||url).match(/coverartarchive\.org\/release\/([^/]+)/i)?.[1];
    if(archiveRelease&&archiveRelease!==String(entry.release_id)) continue;
    if(entry.provider==='discogs'&&String(entry.raw.id)===String(entry.release_id)) {
      const position=String(entry.provider_track_id).slice(String(entry.release_id).length+1);
      const member=entry.raw.tracklist?.find(t=>String(t.position)===position);
      const titleAgrees=member&&norm(member.title)===norm(record.title);
      const primary=(entry.raw.images||[]).filter(i=>i.type==='primary').map(i=>safeImage(i.uri)).filter(Boolean).sort()[0];
      if(titleAgrees&&primary) {url=primary;reason='stored-provider-release-primary';}
    }
    if(!url) continue;
    candidates.push({url,provider:entry.provider,providerTrackId:entry.provider_track_id,providerReleaseId:entry.release_id,snapshotId:entry.id,reason,fetchedAt:entry.fetched_at});
  }
  candidates.sort((a,b)=>({tidal:0,beatport:1,discogs:2,musicbrainz:3}[a.provider]??4)-({tidal:0,beatport:1,discogs:2,musicbrainz:3}[b.provider]??4)||b.fetchedAt.localeCompare(a.fetchedAt)||b.snapshotId-a.snapshotId||a.url.localeCompare(b.url));
  return candidates[0]||null;
}
// Future canonical consumers must supply current reviewed relationships. This pure
// policy is deliberately not wired into the legacy catalog or discovery.
function selectDisplayArtwork({releaseId,appearanceId,trackSourceId,primaryProvider,candidates=[]}) {
  const ranked=[];
  for(const item of candidates) {
    if(!item.verified||['DEAD','INVALID','NETWORK_FAILURE'].includes(item.health)||!item.url) continue;
    let rank=99;
    if(releaseId&&item.releaseId===releaseId) rank=appearanceId&&item.appearanceId===appearanceId?0:item.provider===primaryProvider?1:2;
    else if(item.trackSourceId===trackSourceId&&trackSourceId&&!item.releaseId) rank=3;
    if(rank<99) ranked.push({...item,rank});
  }
  ranked.sort((a,b)=>a.rank-b.rank||String(a.provider).localeCompare(String(b.provider))||String(a.id).localeCompare(String(b.id))||a.url.localeCompare(b.url));
  const chosen=ranked[0];
  return chosen?{url:chosen.url,variantId:chosen.id,path:['exact-appearance','primary-release','alternate-release','verified-track'][chosen.rank],reason:null}:{url:'',variantId:null,path:'placeholder',reason:'unresolved-or-unavailable-artwork'};
}
module.exports={recoverLegacyArtwork,selectDisplayArtwork};
