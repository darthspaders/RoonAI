'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {roonIdentityEvidence,resolveVerifiedTracksForRoon}=require('../src/roonExactResolution');
const {RoonClient}=require('../src/roonClient');
const {ExactVerificationStore}=require('../src/exactVerificationStore');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const six=[['Fluke','Bullet (Nick Warren & Nicolas Rada Remix)'],['Abity, Luca Abayan','Afterimage (DJ Ruby Remix)'],['Davi','In Deep (Extended Mix)'],['Ezequiel Arias, Fjl','Color Divino (Extended Mix)'],['D-SHIFT, Drunken Kong','City Lights (HAFT Remix)'],['Mattias Herrera','Lumara (Extended Mix)']];
const fixture=()=>({tracks:six.map(([artist,title],i)=>({tidal:{verified:true},usable:true,tidalTrackId:String(i),matchedArtist:artist,matchedTitle:title,track:{artist,title,id:String(i)},roon:{zoneId:'z'}}))});

test('Roon credit augmentation never weakens full title/version matching',()=>{
 const track={artist:'Fluke',title:six[0][1],id:'545067468',isrc:'ABC',durationMs:539000};
 assert.ok(roonIdentityEvidence(track,{title:track.title,subtitle:'Fluke, Jon Fugler, Mike Tournier'}).accepted);
 assert.ok(!roonIdentityEvidence(track,{title:'Bullet (Original Mix)',subtitle:'Fluke'}).accepted);
 assert.ok(!roonIdentityEvidence(track,{title:track.title,subtitle:'Other Artist'}).accepted);
 assert.ok(!roonIdentityEvidence(track,{title:track.title,subtitle:'Fluke',tidalTrackId:'wrong'}).accepted);
 assert.ok(!roonIdentityEvidence(track,{title:track.title,subtitle:'Fluke',isrc:'OTHER'}).accepted);
 assert.ok(!roonIdentityEvidence(track,{title:track.title,subtitle:'Fluke',durationMs:300000}).accepted);
 assert.ok(!roonIdentityEvidence({artist:'Abity, Luca Abayan',title:'Afterimage'},{title:'Afterimage',subtitle:'Abity'}).accepted);
});

test('all six get their full search time after serialization, not from batch start',async()=>{
 const result=fixture(); const log=[];
 const roon={canQueueTrack:async t=>{await new Promise(r=>setTimeout(r,65));return {success:true,queueToken:'token-'+t.id,resultCount:1};}};
 await resolveVerifiedTracksForRoon(result,{roonTimeoutMs:100,retries:0},{roon,logger:e=>log.push(e)});
 assert.equal(result.roonQueueableCount,6);
 assert.ok(result.tracks.every(t=>t.status==='ROON_QUEUEABLE'));
 assert.equal(log.filter(e=>e.event==='roon_search_start').length,6);
 assert.equal(log.filter(e=>e.event==='roon_resolution_final').length,6);
});

test('timeout retries existing identity and does not block subsequent tracks',async()=>{
 const result=fixture(); const calls=[]; let first=true;
 const roon={canQueueTrack:async(t,z,opts)=>{
  calls.push({id:t.id,query:opts.query});
  if(first){first=false;return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(Error('timeout'),{code:'ETIMEDOUT'}))));}
  return {success:true,queueToken:'token-'+t.id,resultCount:1};
 }};
 await resolveVerifiedTracksForRoon(result,{roonTimeoutMs:100,retries:1},{roon});
 assert.equal(result.roonQueueableCount,6);
 assert.equal(result.tracks[0].roon.retryCount,1);
 assert.equal(calls.length,7);
 assert.equal(calls[0].id,calls[1].id);
 assert.notEqual(calls[0].query,calls[1].query);
});

test('explicit miss, version mismatch and timeout remain distinct and TIDAL rows survive',async()=>{
 const result=fixture(); result.tracks=result.tracks.slice(0,3);
 const roon={canQueueTrack:async t=>{
  if(t.id==='2')throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});
  return {success:false,failureType:t.id==='0'?'not_found':'version_mismatch',reason:'test'};
 }};
 await resolveVerifiedTracksForRoon(result,{retries:0},{roon});
 assert.deepEqual(result.tracks.map(r=>r.status),['ROON_NOT_FOUND','ROON_VERSION_MISMATCH','ROON_TIMEOUT']);
 assert.ok(result.tracks.every(r=>r.usable&&r.tidal.verified));
});

test('saved identities survive restart but executable handles do not',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-exact-'));
 const store=new ExactVerificationStore(path.join(dir,'exact.json'));
 const original=fixture(); original.tracks[0].roon.queueToken='secret-local-handle'; original.tracks[0].queueable=true;
 store.save(original);
 assert.ok(!fs.readFileSync(store.file,'utf8').includes('secret-local-handle'));
 const restored=store.read();
 assert.equal(restored.tracks.length,6);
 assert.equal(restored.tracks[0].track.id,'0');
 assert.equal(restored.tracks[0].status,'TIDAL_VERIFIED_ROON_PENDING');
 assert.equal(restored.roonQueueableCount,0);
 fs.unlinkSync(store.file); fs.rmdirSync(dir);
});

test('direct exact lookup creates only the accepted track action and abort stops further RPCs',async()=>{
 let loads=0;const browsed=[];
 const fake={zoneOrOutputId:z=>z,browse:{
  browse:(args,cb)=>{browsed.push(args);cb(null,{});},
  load:(_args,cb)=>cb(null,{items:loads++===0?[{title:six[0][1],subtitle:'Fluke, Jon Fugler, Mike Tournier',hint:'action_list',item_key:'exact-track'},{title:'Bullet (Original Mix)',subtitle:'Fluke',hint:'action_list',item_key:'wrong'}]:[{title:'Queue',hint:'action',item_key:'queue-exact'}]})
 }};
 Object.setPrototypeOf(fake,RoonClient.prototype);
 const result=await RoonClient.prototype.resolveExactSearchAction.call(fake,{artist:'Fluke',title:six[0][1]},'z',{query:'Fluke Bullet'});
 assert.equal(result.playable.item_key,'queue-exact');
 assert.equal(browsed[1].item_key,'exact-track');
 assert.equal(browsed.length,2);
 let lateCallback,loadCalls=0;
 const stalled={zoneOrOutputId:z=>z,browse:{browse:(_args,cb)=>{lateCallback=cb;},load:()=>{loadCalls++;}}};
 const controller=new AbortController();
 Object.setPrototypeOf(stalled,RoonClient.prototype);
 const pending=RoonClient.prototype.resolveExactSearchAction.call(stalled,{artist:'Fluke',title:six[0][1]},'z',{query:'q',signal:controller.signal});
 controller.abort();
 await assert.rejects(pending);
 lateCallback(null,{});
 await new Promise(r=>setImmediate(r));
 assert.equal(loadCalls,0);
});

test('identical nested Roon track wrapper retains strict identity before Queue',async()=>{
 let loads=0;const browsed=[];
 const exact={title:six[0][1],subtitle:'Fluke, Jon Fugler',hint:'action_list',item_key:'outer'};
 const fake={zoneOrOutputId:z=>z,browse:{browse:(a,cb)=>{browsed.push(a);cb(null,{});},load:(a,cb)=>cb(null,{items:loads++===0?[exact]:loads===2?[{...exact,item_key:'inner'}]:[{title:'Queue',hint:'action',item_key:'queue'}]})}};
 Object.setPrototypeOf(fake,RoonClient.prototype);
 const found=await RoonClient.prototype.resolveExactSearchAction.call(fake,{artist:'Fluke',title:six[0][1]},'z',{query:'q'});
 assert.equal(found.playable.item_key,'queue'); assert.equal(browsed[2].item_key,'inner');
});

test('bridge reuses persisted playlist and sends only verified track ID',async()=>{
 const {ExactRoonBridge}=require('../src/exactRoonBridge');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-bridge-')); const file=path.join(dir,'bridge.json');
 let creates=0,lists=0;const added=[];
 const profile={isConfigured:()=>true,getUserPlaylists:async()=>{lists++;return {connected:true,playlists:[]};},createPlaylist:async()=>{creates++;return {id:'designated'};},addTrackToPlaylist:async(id,t,options)=>{added.push([id,t.id,options.allowDuplicate,options.forceDuplicateCheck,options.verifyAfterWrite]);return {added:true};}};
 const roon={resolveExactPlaylistAction:async()=>({success:true,queueToken:'token'})};
 await new ExactRoonBridge({profile,roon,file}).resolve(fixture().tracks[0],{});
 await new ExactRoonBridge({profile,roon,file}).resolve(fixture().tracks[1],{});
 assert.equal(creates,1);assert.equal(lists,1);assert.deepEqual(added,[['designated','0',false,true,true],['designated','1',false,true,true]]);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('bridge reports sync-pending state when Roon playlist refresh still lags',async()=>{
 const {ExactRoonBridge}=require('../src/exactRoonBridge');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-bridge-lag-')); const file=path.join(dir,'bridge.json');
 const profile={isConfigured:()=>true,getUserPlaylists:async()=>({connected:true,playlists:[]}),createPlaylist:async()=>({id:'designated'}),addTrackToPlaylist:async()=>({added:true})};
 const roon={resolveExactPlaylistAction:async()=>({success:false,reason:'not visible yet'})};
 const bridge=new ExactRoonBridge({profile,roon,file,syncDelaysMs:[0,1],playlistLookupTimeoutMs:1000});
 await assert.rejects(bridge.resolve(fixture().tracks[0],{}),error=>{
  assert.equal(error.code,'EROON_BRIDGE_SYNC_PENDING');
  assert.equal(error.bridgeSync.requiresManualRefresh,true);
  assert.equal(error.bridgeSync.attempts.length,2);
  assert.match(error.message,/Refresh TIDAL playlists in Roon/);
  return true;
 });
 fs.rmSync(dir,{recursive:true,force:true});
});

test('bridge triggers internal TIDAL sync after playlist writes before polling Roon',async()=>{
 const {ExactRoonBridge}=require('../src/exactRoonBridge');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-bridge-sync-')); const file=path.join(dir,'bridge.json');
 const events=[];
 const profile={isConfigured:()=>true,getUserPlaylists:async()=>({connected:true,playlists:[]}),createPlaylist:async()=>({id:'designated'}),addTrackToPlaylist:async()=>{events.push('tidal-write');return {added:true};}};
 const roon={resolveExactPlaylistAction:async()=>{events.push('roon-poll');return {success:true,queueToken:'token'};}};
 const internalTidalSync={syncLibrary:async context=>{events.push(`sync-${context.trackCount}`);return {attempted:true,success:true,context};}};
 const bridge=new ExactRoonBridge({profile,roon,file,syncDelaysMs:[0],internalTidalSync});
 const result=await bridge.resolve(fixture().tracks[0],{});
 assert.equal(result.success,true);
 assert.deepEqual(events,['tidal-write','sync-1','roon-poll']);
 assert.equal(result.sync.internalSync.success,true);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('bridge preserves fallback behavior when internal TIDAL sync fails',async()=>{
 const {ExactRoonBridge}=require('../src/exactRoonBridge');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-bridge-sync-fail-')); const file=path.join(dir,'bridge.json');
 const profile={isConfigured:()=>true,getUserPlaylists:async()=>({connected:true,playlists:[]}),createPlaylist:async()=>({id:'designated'}),addTrackToPlaylist:async()=>({added:true})};
 const roon={resolveExactPlaylistAction:async()=>({success:false,reason:'not visible yet'})};
 const internalTidalSync={syncLibrary:async()=>{throw Error('internal sync failed');}};
 const bridge=new ExactRoonBridge({profile,roon,file,syncDelaysMs:[0],playlistLookupTimeoutMs:1000,internalTidalSync});
 await assert.rejects(bridge.resolve(fixture().tracks[0],{}),error=>{
  assert.equal(error.code,'EROON_BRIDGE_SYNC_PENDING');
  assert.equal(error.bridgeSync.internalSync.success,false);
  assert.match(error.message,/Refresh TIDAL playlists in Roon/);
  return true;
 });
 fs.rmSync(dir,{recursive:true,force:true});
});

test('optional bridge preserves direct failure and reports exact bridge success or failure',async()=>{
 const result=fixture();result.tracks=result.tracks.slice(0,2);
 const roon={canQueueTrack:async()=>({success:false,failureType:'not_found'})};
 const bridge={resolve:async row=>{if(row.track.id==='1'){const error=Error('playlist not visible');error.bridgeSync={requiresManualRefresh:true,attempts:[{attempt:1}]};throw error;}return {queueToken:'bridge-token',playlistId:'p'};}};
 await resolveVerifiedTracksForRoon(result,{retries:0,allowBridge:true},{roon,bridge});
 assert.equal(result.tracks[0].status,'TIDAL_VERIFIED_BRIDGE_AVAILABLE');assert.equal(result.tracks[0].roon.directFailureType,'not_found');
 assert.equal(result.tracks[1].status,'TIDAL_VERIFIED_BRIDGE_UNAVAILABLE');assert.equal(result.tracks[1].bridge.reason,'playlist not visible');
 assert.equal(result.tracks[1].bridge.requiresManualRefresh,true);
});
