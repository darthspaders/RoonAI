"use strict";
// Presentation-only repair. No MusicMemoryStore, search, queue or feedback writes.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {readCatalog,safeImage}=require('../src/databaseBrowserCatalog');
const {normalize,recordingEvidence}=require('../src/canonicalMatching');
const {snapshotSource}=require('../src/canonicalFoundation');
const {TidalVerifier}=require('../src/tidalVerifier');
const {probe}=require('./audit-artwork');
const {inventory}=require('./canonical-phase1');
async function main(){
  const args=process.argv.slice(2),value=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
  const dbFile=value('--db',require('../src/config').musicMemory.dbFile),out=value('--out','.codex-verify/canonical-phase1/refresh-plan.json');
  if(args.includes('--apply')){
    const report=JSON.parse(fs.readFileSync(out,'utf8')),db=new DatabaseSync(dbFile);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try{
      const before=inventory(db);
      const current=new Map(readCatalog(db,null).records.map(r=>[r.id,r]));let inserted=0;
      for(const item of report.items.filter(i=>i.status==='SAFE')){
        const row=current.get(item.legacyTrackId);
        if(!row||row.imageUrl!==item.originalUrl)continue;
        if(row.artist!==item.artist||row.title!==item.title)throw Error('Stale legacy identity in artwork repair plan');
        const latest=db.prepare("SELECT * FROM provider_enrichment WHERE track_identity_id=? AND provider='tidal' ORDER BY fetched_at DESC,id DESC LIMIT 1").get(row.id);
        if(!latest||latest.id!==item.legacySnapshotId||String(latest.provider_track_id)!==item.trackId)throw Error('Stale artwork repair plan');
        const snapshot=snapshotSource(db,{provider:'tidal',kind:'track',externalId:item.trackId,raw:item.raw,retrievedAt:item.retrievedAt,legacyTable:'provider_enrichment',legacyRowKey:String(latest.id)});
        db.prepare('INSERT INTO canonical_provider_track(source_id,original_artist,original_title,version_text,duration_ms,playback_url,snapshot_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET snapshot_id=excluded.snapshot_id').run(snapshot.sourceId,item.fresh.artist,item.fresh.title,item.fresh.mixVersion||'',item.fresh.durationMs,item.fresh.tidalUrl,snapshot.snapshotId);
        db.prepare('INSERT INTO canonical_artwork_variant(id,source_id,snapshot_id,url,role,retrieved_at,health,checked_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),snapshot.sourceId,snapshot.snapshotId,item.url,'front',item.retrievedAt,'OK',item.retrievedAt);
        db.prepare('INSERT INTO canonical_artwork_repair(id,legacy_track_id,original_url,replacement_url,source_id,snapshot_id,legacy_snapshot_id,evidence_json) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,item.originalUrl,item.url,snapshot.sourceId,snapshot.snapshotId,latest.id,JSON.stringify(item.evidence));inserted++;
      }
      const after=inventory(db),changed=Object.keys(before.tables).filter(t=>before.tables[t].sha256!==after.tables[t].sha256);
      if(changed.length)throw Error(`Legacy contents changed: ${changed.join(',')}`);
      const appliedTotal=db.prepare('SELECT count(*) n FROM canonical_artwork_repair WHERE revoked_at IS NULL').get().n;
      db.exec('COMMIT');fs.writeFileSync(out.replace(/\.json$/,`.applied-${Date.now()}.json`),JSON.stringify({inserted,appliedTotal,before,after,changedLegacyTables:changed},null,2));console.log(JSON.stringify({inserted,appliedTotal,changedLegacyTables:changed}));
    }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}return;
  }
  const db=new DatabaseSync(dbFile,{readOnly:true}),tidal=new TidalVerifier({...require('../src/config').tidal,timeoutMs:8000});
  const catalog=readCatalog(db,null).records.filter(r=>r.artworkSource==='tidal'&&r.imageUrl.startsWith('https://art.darthspader.com/art/'));
  const items=[];
  for(const row of catalog){
    const latest=db.prepare("SELECT * FROM provider_enrichment WHERE track_identity_id=? AND provider='tidal' ORDER BY fetched_at DESC,id DESC LIMIT 1").get(row.id),old=JSON.parse(latest.raw_json||'{}');
    const item={legacyTrackId:row.id,legacySnapshotId:latest.id,trackId:String(latest.provider_track_id),artist:row.artist,title:row.title,originalUrl:row.imageUrl,status:'UNRESOLVED'};
    items.push(item);
    if(!/^\d+$/.test(item.trackId)||Number(latest.confidence)<99||String(old.id)!==item.trackId){item.reason='provider-item-not-exact';continue;}
    const originalHealth=await probe(row.imageUrl);if(originalHealth.health!=='DEAD'){item.reason='cache-not-confirmed-dead';continue;}
    try{
      let raw;
      const originalFetch=tidal.fetchTidalJson.bind(tidal);
      tidal.fetchTidalJson=async(...a)=>{const result=await originalFetch(...a);raw=result;return result;};
      const fresh=await tidal.getTrack(item.trackId);
      tidal.fetchTidalJson=originalFetch;
      if(!fresh||String(raw?.data?.id)!==item.trackId){item.reason='exact-provider-retrieval-failed';continue;}
      const evidence=recordingEvidence({artist:old.artist,title:old.title,mixVersion:old.mixVersion||old.version,durationMs:old.durationMs,isrc:old.isrc},fresh);
      const albumAgrees=normalize(old.album)===normalize(fresh.album)&&normalize(row.album)===normalize(old.album);
      if(evidence.conflicts.length||!albumAgrees||evidence.durationDeltaMs===null||evidence.durationDeltaMs>2000){item.reason='changed-or-ambiguous-provider-evidence';item.evidence={...evidence,albumAgrees};continue;}
      const url=safeImage(fresh.imageUrl),health=await probe(url);
      if(!url||health.health!=='OK'){item.reason='fresh-artwork-unavailable';item.health=health;continue;}
      Object.assign(item,{status:'SAFE',url,fresh,raw,evidence:{...evidence,albumAgrees,exactProviderTrackId:item.trackId,originalHealth,health},retrievedAt:new Date().toISOString()});
    }catch(error){item.reason='provider-retrieval-failure';item.error=error.message;}
    if(items.length%20===0)console.log(JSON.stringify({inspected:items.length,total:catalog.length,safe:items.filter(i=>i.status==='SAFE').length}));
  }
  db.close();fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify({at:new Date().toISOString(),items},null,2));
  console.log(JSON.stringify({out,total:items.length,safe:items.filter(i=>i.status==='SAFE').length,unresolved:items.filter(i=>i.status!=='SAFE').reduce((a,i)=>(a[i.reason]=(a[i.reason]||0)+1,a),{})}));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
