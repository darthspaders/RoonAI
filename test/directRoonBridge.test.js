'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDirectBridge,createDirectBridgeBatch}=require('../src/directRoonBridge');const {RoonClient}=require('../src/roonClient');
const requested={artist:'M.O.S.',title:'Immensity (Extended Mix)',album:'Favourite Colours EP'};
const exact={...requested,id:'432944544',isrc:'GBEWA2502225',durationMs:434000};
test('saved exact identity reaches permanent bridge without TIDAL search',async()=>{
 let writes=0;const resolve=createDirectBridge({knownTracks:()=>[exact],tidal:{getTrack:()=>{throw Error('no lookup');}},bridge:{resolve:async(row,input)=>{writes++;assert.equal(row.track.id,exact.id);assert.equal(input.requireExisting,true);return {success:true,queueToken:'token',match:{title:exact.title,subtitle:'M.O.S. - Favourite Colours EP'},playlistId:'permanent'};}}});
 const r=await resolve(requested,'z','queue','strict');assert.equal(writes,1);assert.equal(r.resolutionMethod,'exact_tidal_bridge');assert.equal(r.identityEvidence.accepted,true);
});
test('wrong version and absent identity cannot write bridge',async()=>{
 const resolve=createDirectBridge({knownTracks:()=>[{...exact,title:'Immensity (Original Mix)'}],tidal:{getTrack:async()=>({...exact,title:'Immensity (Radio Edit)'})},bridge:{resolve:()=>{throw Error('must not write');}}});
 assert.equal((await resolve(requested,'z','queue','strict')).failureType,'not_found');assert.equal((await resolve({...requested,tidalTrackId:exact.id},'z','queue','strict')).failureType,'version_mismatch');
});
test('direct success bypasses bridge; direct+album miss invokes bridge only for queue execution',async()=>{
 let bridges=0;const fake={exactQueueActions:new Map(),resolveSearchAction:async()=>({success:true,playable:{item_key:'direct'}}),resolveDirectBridge:async()=>{bridges++;return {success:true,playable:{item_key:'bridge'},resolutionMethod:'exact_tidal_bridge'};}};
 await RoonClient.prototype.resolveDirectAction.call(fake,requested,'z','queue',{matchPolicy:'strict',allowBridge:true});assert.equal(bridges,0);
 fake.resolveSearchAction=async()=>({success:false,failureType:'not_found',albumFallback:{attempted:true}});
 await RoonClient.prototype.resolveDirectAction.call(fake,requested,'z','queue',{matchPolicy:'strict'});assert.equal(bridges,0);
 const r=await RoonClient.prototype.resolveDirectAction.call(fake,requested,'z','queue',{matchPolicy:'strict',allowBridge:true});assert.equal(bridges,1);assert.equal(r.success,true);assert.ok(r.albumFallback.attempted);
});
test('Roon bridge resolves strict playlist item on later pages and stores playlist action',async()=>{
 let layer=0;const filler=()=>Array.from({length:100},(_,i)=>({title:'Other '+i,item_key:'other'+i,hint:'list'}));const fake={zoneOrOutputId:z=>z,browse:{browse:(a,cb)=>{if(a.item_key==='permanent')layer=1;if(a.item_key==='exact')layer=2;cb(null,{});},load:(a,cb)=>cb(null,{items:layer===0?(a.offset===0?filler():[{title:'Rabbit Hole Exact Verification Bridge',item_key:'permanent',hint:'list'}]):layer===1?[{title:'Immensity (Original Mix)',subtitle:'M.O.S.',item_key:'wrong',hint:'action_list'},{title:exact.title,subtitle:'M.O.S. - Favourite Colours EP',item_key:'exact',hint:'action_list'}]:[{title:'Queue',item_key:'queue',hint:'action'}]})}};
 const result=await RoonClient.prototype.resolveExactPlaylistAction.call(fake,exact,'z','Rabbit Hole Exact Verification Bridge');assert.equal(result.success,true);assert.equal(result.hierarchy,'playlists');assert.equal(result.match.item_key,'exact');assert.ok(fake.exactQueueActions.has(result.queueToken));
});

test('Roon bridge trusts exact verified playlist item when Roon omits a co-artist',async()=>{
 const track={artist:'D-SHIFT, Drunken Kong',title:'City Lights (HAFT Remix)',tidalTrackId:'544016594',isrc:'US83Z2647768'};
 let layer=0;const fake={zoneOrOutputId:z=>z,browse:{browse:(a,cb)=>{if(a.item_key==='permanent')layer=1;if(a.item_key==='exact')layer=2;cb(null,{});},load:(a,cb)=>cb(null,{items:layer===0?[{title:'Rabbit Hole Exact Verification Bridge',item_key:'permanent',hint:'list'}]:layer===1?[{title:'City Lights (HAFT Remix)',subtitle:'D-SHIFT',item_key:'exact',hint:'action_list'}]:[{title:'Queue',item_key:'queue',hint:'action'}]})}};
 const result=await RoonClient.prototype.resolveExactPlaylistAction.call(fake,track,'z','Rabbit Hole Exact Verification Bridge');
 assert.equal(result.success,true);assert.equal(result.match.item_key,'exact');assert.equal(result.diagnostics.nearMatches[0].bridgeIdentityEvidence.trustedBridgeIdentity,true);
});

test('Roon bridge trusts a unique exact-title compilation row when Roon reports Various Artists',async()=>{
 const track={artist:'Analog Jungs',title:'Marbella',tidalTrackId:'222124691',isrc:'GB5ML2000012',durationMs:553000};
 let layer=0;const fake={zoneOrOutputId:z=>z,browse:{browse:(a,cb)=>{if(a.item_key==='permanent')layer=1;if(a.item_key==='exact')layer=2;cb(null,{});},load:(a,cb)=>cb(null,{items:layer===0?[{title:'Rabbit Hole Exact Verification Bridge',item_key:'permanent',hint:'list'}]:layer===1?[{title:'Marbella',subtitle:'Various Artists',item_key:'exact',hint:'action_list'}]:[{title:'Queue',item_key:'queue',hint:'action'}]})}};
 const result=await RoonClient.prototype.resolveExactPlaylistAction.call(fake,track,'z','Rabbit Hole Exact Verification Bridge');
 assert.equal(result.success,true);assert.equal(result.match.item_key,'exact');assert.equal(result.identityEvidence.accepted,true);assert.equal(result.identityEvidence.method,'bridge_verified_title_compilation_credit');
});

test('Roon bridge rejects ambiguous exact-title compilation rows',async()=>{
 const track={artist:'Analog Jungs',title:'Marbella',tidalTrackId:'222124691',isrc:'GB5ML2000012',durationMs:553000};
 let layer=0;const fake={zoneOrOutputId:z=>z,browse:{browse:(a,cb)=>{if(a.item_key==='permanent')layer=1;cb(null,{});},load:(a,cb)=>cb(null,{items:layer===0?[{title:'Rabbit Hole Exact Verification Bridge',item_key:'permanent',hint:'list'}]:[{title:'Marbella',subtitle:'Various Artists',item_key:'exact-a',hint:'action_list'},{title:'Marbella',subtitle:'Various Artists',item_key:'exact-b',hint:'action_list'}]})}};
 const result=await RoonClient.prototype.resolveExactPlaylistAction.call(fake,track,'z','Rabbit Hole Exact Verification Bridge');
 assert.equal(result.success,false);assert.match(result.reason,/exact artist\/title\/version/);
});

test('flexible policy never swaps explicit Extended and Original versions even with shared metadata',()=>{
 const {identity}=require('../src/directRoonQueue');assert.equal(identity({...exact,tidalTrackId:exact.id},{...exact,tidalTrackId:exact.id,title:'Immensity (Original Mix)'},'flexible').accepted,false);
});
test('direct bridge never recreates a missing permanent playlist',async()=>{
 const {ExactRoonBridge}=require('../src/exactRoonBridge');const fs=require('fs'),os=require('os'),path=require('path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-no-create-'));
 const bridge=new ExactRoonBridge({file:path.join(dir,'bridge.json'),profile:{isConfigured:()=>true,getUserPlaylists:async()=>({connected:true,playlists:[]}),createPlaylist:()=>{throw Error('must not create');}},roon:{}});
 await assert.rejects(bridge.resolve({track:exact,roon:{zoneId:'z'}},{requireExisting:true}),/permanent.*missing/);fs.rmdirSync(dir);
});

test('queue execution consumes the stored bridge action in playlist hierarchy without another search',async()=>{
 const dispatched=[];const fake={zoneOrOutputId:z=>z,exactQueueActions:new Map([['bridge-token',{}]]),resolveDirectAction:async()=>({success:true,queueToken:'bridge-token',session:'playlist-session',hierarchy:'playlists',playable:{item_key:'exact-queue',title:'Queue'},resolutionMethod:'exact_tidal_bridge'}),browse:{browse:(args,cb)=>{dispatched.push(args);cb(null,{action:'message',message:'Added to queue'});}}};
 const result=await RoonClient.prototype.performSearchAction.call(fake,requested,'z','queue',{matchPolicy:'strict'});assert.equal(result.success,true);assert.equal(dispatched.length,1);assert.equal(dispatched[0].hierarchy,'playlists');assert.equal(dispatched[0].item_key,'exact-queue');assert.equal(fake.exactQueueActions.size,0);
});

test('bulk queue groups strict TIDAL misses into one bridge sync before queueing',async()=>{
 const bridgeCalls=[];const tracks=[{...requested,tidalTrackId:'1'},{artist:'Mayro',title:'Same Idea',tidalTrackId:'2'}];
 const fake={
  getZone:()=>({settings:{}}),
  performSearchAction:async(track)=>{
   if(track.verifiedQueueToken)return {success:true,playable:{item_key:track.verifiedQueueToken,title:'Queue'},action:'Queue',match:{title:track.title,subtitle:track.artist}};
   return {success:false,resolved:false,reason:'Roon direct miss',failureType:'not_found'};
  },
  resolveDirectBridgeBatch:async(entries)=>{
   bridgeCalls.push(entries.map(entry=>entry.track.title));
   return entries.map(entry=>({...entry,result:{success:true,queueToken:`bridge-${entry.index}`,match:{title:entry.track.title,subtitle:entry.track.artist},resolutionMethod:'exact_tidal_bridge',bridge:{playlistId:'permanent',tidalTrackId:entry.track.tidalTrackId}}}));
  },
  emit:()=>{}
 };
 const result=await RoonClient.prototype.queueTracks.call(fake,tracks,'z',{matchPolicy:'strict',allowBridge:true,targetCount:2});
 assert.deepEqual(bridgeCalls,[['Immensity (Extended Mix)','Same Idea']]);
 assert.equal(result.queuedCount,2);
 assert.equal(result.failedCount,0);
 assert.equal(result.queued.every(item=>item.resolutionMethod==='exact_tidal_bridge'),true);
});

test('bulk queue sends strict TIDAL version mismatches to bridge instead of returning bridge null',async()=>{
 const bridgeCalls=[];const track={...requested,tidalTrackId:'432944544'};
 const fake={
  getZone:()=>({settings:{}}),
  performSearchAction:async(input)=>{
   if(input.verifiedQueueToken)return {success:true,playable:{item_key:input.verifiedQueueToken,title:'Queue'},action:'Queue',match:{title:input.title,subtitle:input.artist}};
   return {success:false,resolved:true,reason:'Roon metadata does not confirm the requested recording/version.',failureType:'version_mismatch',match:{title:'Immensity',subtitle:'M.O.S.'}};
  },
  resolveDirectBridgeBatch:async(entries)=>{
   bridgeCalls.push(entries.map(entry=>entry.track.tidalTrackId));
   return entries.map(entry=>({...entry,result:{success:true,queueToken:`bridge-${entry.index}`,match:{title:entry.track.title,subtitle:entry.track.artist},resolutionMethod:'exact_tidal_bridge',bridge:{playlistId:'permanent',tidalTrackId:entry.track.tidalTrackId}}}));
  },
  emit:()=>{}
 };
 const result=await RoonClient.prototype.queueTracks.call(fake,[track],'z',{matchPolicy:'strict',allowBridge:true,targetCount:1});
 assert.deepEqual(bridgeCalls,[['432944544']]);
 assert.equal(result.queuedCount,1);
 assert.equal(result.queued[0].directFailure.failureType,'version_mismatch');
 assert.equal(result.queued[0].bridge.tidalTrackId,'432944544');
});

test('Beatport chart rows verify through TIDAL before bridge insertion',async()=>{
 let tidalLookups=0;
 let bridgeRows=[];
 const chartTrack={artist:'Miraculum',title:'Aftermath (Original Mix)',source:'beatport_chart',beatportTrackId:'299',isrc:'GBABC2600001'};
 const tidalMatch={artist:'Miraculum',title:'Aftermath (Original Mix)',id:'987654321',isrc:'GBABC2600001',durationMs:420000};
 const resolve=createDirectBridgeBatch({
  knownTracks:()=>[],
  tidal:{
   getTrack:()=>{throw Error('must not use Beatport ID as TIDAL ID');},
   findExactTrack:async(track,options)=>{tidalLookups++;assert.equal(track.beatportTrackId,'299');assert.equal(options.strict,true);return tidalMatch;}
  },
  bridge:{resolveBatch:async(rows)=>{bridgeRows=rows;return {results:rows.map(()=>({success:true,queueToken:'token',playlistId:'permanent',match:{title:tidalMatch.title,subtitle:tidalMatch.artist}}))};}}
 });
 const result=await resolve([{index:0,track:chartTrack,mode:'queue',policy:'strict'}],'z',{mode:'queue'});
 assert.equal(tidalLookups,1);
 assert.equal(bridgeRows[0].track.tidalTrackId,'987654321');
 assert.equal(result[0].result.success,true);
 assert.equal(result[0].result.bridge.tidalTrackId,'987654321');
});

test('Beatport chart TIDAL verification accepts omitted generic mix when ISRC matches',async()=>{
 const chartTrack={artist:'Guy J',title:'Secret Serv1ce (Original Mix)',source:'beatport_chart',beatportTrackId:'305',isrc:'DEY032603175'};
 const tidalMatch={artist:'Guy J',title:'Secret Serv1ce',id:'551357259',isrc:'DEY032603175',durationMs:420000};
 const resolve=createDirectBridge({
  knownTracks:()=>[],
  tidal:{getTrack:()=>{throw Error('must not use Beatport ID as TIDAL ID');},findExactTrack:async()=>tidalMatch},
  bridge:{resolve:async(row)=>({success:true,queueToken:'token',playlistId:'permanent',match:{title:row.track.title,subtitle:row.track.artist}})}
 });
 const result=await resolve(chartTrack,'z','queue','strict');
 assert.equal(result.success,true);
 assert.equal(result.bridge.tidalTrackId,'551357259');
});

test('Beatport chart TIDAL verification rejects ISRC conflicts',async()=>{
 const chartTrack={artist:'DAVI',title:'In Deep (Extended Mix)',source:'beatport_chart',beatportTrackId:'306',isrc:'DEW872604607'};
 const tidalMatch={artist:'Davi',title:'In Deep',id:'551680775',isrc:'DEW872604608',durationMs:420000};
 const resolve=createDirectBridge({
  knownTracks:()=>[],
  tidal:{getTrack:()=>{throw Error('must not use Beatport ID as TIDAL ID');},findExactTrack:async()=>tidalMatch},
  bridge:{resolve:()=>{throw Error('must not bridge conflicting ISRC');}}
 });
 const result=await resolve(chartTrack,'z','queue','strict');
 assert.equal(result.success,false);
 assert.equal(result.failureType,'roon_catalog_missing');
});

test('exact bridge persists unresolved TIDAL bridge rows for later retry',async()=>{
 const {ExactRoonBridge}=require('../src/exactRoonBridge');const fs=require('fs'),os=require('os'),path=require('path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-pending-'));
 const file=path.join(dir,'bridge.json');fs.writeFileSync(file,JSON.stringify({playlistId:'permanent',title:'Rabbit Hole Exact Verification Bridge'}));
 let visible=false;
 const bridge=new ExactRoonBridge({
  file,
  profile:{isConfigured:()=>true,addTrackToPlaylist:async()=>({added:true})},
  internalTidalSync:{syncLibrary:async()=>({attempted:true,success:true})},
  roon:{resolveExactPlaylistAction:async()=>visible?{success:true,queueToken:'token',match:{title:exact.title,subtitle:exact.artist}}:{success:false,reason:'Bridge visible but item missing.'},queueVerifiedTrack:async()=>({success:true})}
 });
 const first=await bridge.resolveBatch([{track:exact,roon:{zoneId:'z'}}],{zoneId:'z',bridgeSyncDelaysMs:[0]});
 assert.equal(first.results[0].success,false);
 assert.equal(bridge.listPending().tracks.length,1);
 visible=true;
 const retry=await bridge.retryPending({zoneId:'z',queue:false,bridgeSyncDelaysMs:[0]});
 assert.equal(retry.resolved,1);
 assert.equal(bridge.listPending().tracks.length,1);
 const queued=await bridge.retryPending({zoneId:'z',queue:true,bridgeSyncDelaysMs:[0]});
 assert.equal(queued.queued,1);
 assert.equal(bridge.listPending().tracks.length,0);
 fs.rmSync(dir,{recursive:true,force:true});
});
