"use strict";
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {readCatalog,artwork,safeImage}=require('../src/databaseBrowserCatalog');
const parse=s=>{try{return JSON.parse(s||'{}')||{};}catch{return {};}};
const tally=rows=>rows.reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{});
function audit(db) {
  const records=readCatalog(db,null).records;
  const evidence=new Map(),observations=new Map();
  const aliases=new Map(db.prepare('SELECT * FROM track_identity_alias').all().map(r=>[r.alias_identity_id,r]));
  for(const r of db.prepare('SELECT * FROM provider_enrichment ORDER BY fetched_at DESC,id DESC').iterate()) {
    if(!evidence.has(r.track_identity_id))evidence.set(r.track_identity_id,[]);
    evidence.get(r.track_identity_id).push({...r,raw:parse(r.raw_json)});
  }
  for(const r of db.prepare('SELECT track_identity_id,raw_json FROM track_observation').iterate()) {
    const raw=parse(r.raw_json);
    if(raw.imageKey)observations.set(r.track_identity_id,raw.imageKey);
  }
  const rows=records.map(r=>{
    const entries=evidence.get(r.id)||[], latest=[...new Map([...entries].reverse().map(e=>[e.provider,e])).values()];
    const historyArt=entries.filter(e=>artwork(e.raw,e.provider));
    const rawImages=entries.filter(e=>e.raw.images?.some(i=>safeImage(i.uri)));
    let reason=r.imageUrl?'available':!r.providers.length?(observations.has(r.id)?'roon-image-key-only':'no-provider-artwork-evidence'):historyArt.length?'historical-artwork-release-conflict':rawImages.length?'release-image-role-unresolved':'provider-metadata-has-no-artwork';
    const sameAlbum=e=>e.release_title&&r.album&&e.release_title.toLowerCase().trim()===r.album.toLowerCase().trim();
    if(!r.imageUrl&&((rawImages.length&&!rawImages.some(sameAlbum))||(latest.length&&!latest.some(sameAlbum)&&!historyArt.length)))reason='provider-release-association-conflict';
    if(r.artworkRecovery)reason=r.artworkRecovery.reason;
    return {id:r.id,identityKey:r.identityKey,artist:r.artist,title:r.title,album:r.album,albumKey:r.albumKey,chosenUrl:r.imageUrl,provider:r.artworkSource,
      reason,fallback:r.artworkRecovery?.reason||r.artworkProjection?.reason||(r.imageUrl?'legacy-provider-artwork':'placeholder'),recovery:r.artworkRecovery||null,projection:r.artworkProjection||null,
      urlHealth:'UNCHECKED',releaseAssociations:latest.map(e=>({provider:e.provider,providerTrackId:e.provider_track_id,providerReleaseId:e.release_id,releaseTitle:e.release_title,snapshotId:e.id,confidence:e.confidence})),
      hasRoonImageKey:observations.has(r.id), historicalArtSnapshots:historyArt.map(e=>({id:e.id,provider:e.provider,releaseId:e.release_id,releaseTitle:e.release_title,url:artwork(e.raw,e.provider)})),
      legacyAlias:aliases.get(r.id)||null,
      flags:{providerReleaseIdMissing:latest.some(e=>!e.release_id),sourceReleaseTitleDiffers:latest.some(e=>e.release_title&&r.album&&e.release_title.toLowerCase().trim()!==r.album.toLowerCase().trim()),malformedArtworkField:latest.some(e=>[e.raw.imageUrl,e.raw.sourceImageUrl,e.raw.coverUrl,e.raw.artworkUrl].some(u=>u&&!safeImage(u))),cachedImageWithoutOriginal:latest.some(e=>String(e.raw.imageUrl||'').includes('art.darthspader.com')&&!e.raw.sourceImageUrl)},
      unresolvedRelease:!latest.some(e=>e.release_id)&&!r.albumKey.startsWith('beatport-album:')};
  });
  const groups=new Map();for(const row of rows.filter(r=>r.albumKey)){if(!groups.has(row.albumKey))groups.set(row.albumKey,[]);groups.get(row.albumKey).push(row);}
  const releases=[...groups].map(([key,rs])=>({key,tracks:rs.length,missingArtwork:rs.every(r=>!r.chosenUrl),urls:[...new Set(rs.map(r=>r.chosenUrl).filter(Boolean))]}));
  return {at:new Date().toISOString(),readOnly:true,counts:{tracks:rows.length,artworkBefore:rows.filter(r=>r.chosenUrl&&!r.recovery).length,missingBefore:rows.filter(r=>!r.chosenUrl||r.recovery).length,repaired:rows.filter(r=>r.recovery).length,cachePrecedenceRepairs:rows.filter(r=>r.projection).length,artworkAfter:rows.filter(r=>r.chosenUrl).length,missingAfter:rows.filter(r=>!r.chosenUrl).length,missingReasons:tally(rows.filter(r=>!r.chosenUrl).map(r=>r.reason)),repairReasons:tally(rows.filter(r=>r.recovery).map(r=>r.reason)),releaseGroups:releases.length,releaseGroupsMissingArtwork:releases.filter(r=>r.missingArtwork).length},rows,releases};
}
async function probe(url) {
  const allowed=['resources.tidal.com','geo-media.beatport.com','i.discogs.com','coverartarchive.org','archive.org','art.darthspader.com'];
  const permitted=url=>{try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&allowed.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));}catch{return false;}};
  if(!permitted(url))return {url,health:'NOT_PROBED',reason:'outside-known-artwork-hosts'};
  let current=url;
  try {
    for(let redirects=0;redirects<6;redirects++) {
      const response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'User-Agent':'RabbitHoleArtworkAudit/1.0'}});
      if(response.status>=300&&response.status<400){const next=new URL(response.headers.get('location'),current).href;await response.body?.cancel();if(!permitted(next))return {url,health:'NOT_PROBED',reason:'redirect-outside-known-hosts'};current=next;continue;}
      const type=response.headers.get('content-type')||'';
      if(!response.ok){await response.body?.cancel();return {url,health:[404,410].includes(response.status)?'DEAD':'NETWORK_FAILURE',status:response.status};}
      const reader=response.body.getReader();const first=await reader.read();await reader.cancel();
      const bytes=Buffer.from(first.value||[]);
      const magic=bytes.subarray(0,3).toString('hex')==='ffd8ff'||bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'||bytes.subarray(0,3).toString()==='GIF'||bytes.subarray(8,12).toString()==='WEBP';
      return {url,health:type.startsWith('image/')&&magic?'OK':'INVALID',status:response.status,contentType:type,checkedAt:new Date().toISOString()};
    }
    return {url,health:'NETWORK_FAILURE',reason:'redirect-limit'};
  }catch(error){return {url,health:'NETWORK_FAILURE',reason:error.name,message:error.message,cause:error.cause?.code};}
}
async function main() {
  const args=process.argv.slice(2),value=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
  const db=new DatabaseSync(value('--db',require('../src/config').musicMemory.dbFile),{readOnly:true});
  db.exec('BEGIN');const report=audit(db);db.exec('ROLLBACK');db.close();
  if(args.includes('--probe')) {
    const urls=new Set(report.rows.filter(r=>r.recovery).map(r=>r.chosenUrl));
    if(args.includes('--probe-bridge'))for(const row of report.rows)if(row.chosenUrl.includes('art.darthspader.com'))urls.add(row.chosenUrl);
    if(args.includes('--probe-changed'))for(const row of report.rows)if(row.projection){urls.add(row.chosenUrl);urls.add(row.projection.originalUrl);}
    const byHost={};for(const r of report.rows.filter(r=>r.chosenUrl)){const host=new URL(r.chosenUrl).hostname;byHost[host]??=new Set();if(byHost[host].size<12)byHost[host].add(r.chosenUrl);}
    for(const group of Object.values(byHost))for(const url of group)urls.add(url);
    report.probes=[];
    const queue=[...urls]; await Promise.all(Array.from({length:4},async()=>{while(queue.length)report.probes.push(await probe(queue.shift()));}));
    const health=new Map(report.probes.map(p=>[p.url,p.health]));for(const row of report.rows)row.urlHealth=health.get(row.chosenUrl)||'UNCHECKED';
    report.probeCounts=tally(report.probes.map(p=>p.health));
    report.probeScope=`All recovered URLs plus up to 12 distinct selected URLs per host; all remaining bridge URLs: ${args.includes('--probe-bridge')}; all changed original/replacement URLs: ${args.includes('--probe-changed')}. Not a visual-content test.`;
    report.counts.selectedUrlHealth=tally(report.rows.filter(r=>r.chosenUrl).map(r=>r.urlHealth));
    report.counts.confirmedUnavailable=report.rows.filter(r=>['DEAD','INVALID'].includes(r.urlHealth)).length;
  }
  const out=path.resolve(value('--out','.codex-verify/canonical-phase1/artwork.json'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,counts:report.counts,probeCounts:report.probeCounts}));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={audit,probe};
