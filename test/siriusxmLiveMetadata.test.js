const test=require('node:test'),assert=require('node:assert/strict');
const {SiriusXmLiveMetadata,current}=require('../src/siriusxmLiveMetadata');
const {SiriusXmMetadata}=require('../src/siriusxmMetadata');
const id='4ebc3011-0ebe-a9ad-c58b-9a306f60fc2b',start=Date.parse('2026-10-01T10:00:00Z');
const cut=(name,offset)=>({name,artistName:'Artist',validFrom:new Date(start+offset).toISOString()});
test('timestamps select current cut, ignore future and invalid entries, permit long mixes',()=>{
 assert.equal(current([cut('future',60000),cut('mix',-3600000),{name:'invalid'}],start,21600000).name,'mix');
 assert.equal(current([cut('old',-21600001)],start,21600000),undefined);
});
test('single shared feed cache coalesces channels, moves across timestamps and drops expired data on failure',async()=>{
 let now=start,calls=0,fail=false;const s=new SiriusXmLiveMetadata({clock:()=>now,fetchImpl:async()=>{calls++;if(fail)throw Error('offline');return {ok:true,json:async()=>({delta:false,channels:{[id]:{cuts:[cut('one',-10000),cut('two',20000)]}}})};}});
 const results=await Promise.all([s.get(id),s.get('other'),s.get(id)]);assert.equal(calls,1);assert.equal(results[0].cut.name,'one');assert.equal(results[1].cut,undefined);
 now+=21000;assert.equal((await s.get(id)).cut.name,'two');assert.equal(calls,1);
 now+=10000;fail=true;const r=await s.get(id);assert.equal(r.cut,undefined);assert.equal(r.diagnostics.fallbackReason,'offline');assert.equal(calls,2);
 await s.get(id);assert.equal(calls,2);
});
test('invalid delta feed falls back instead of treating it as a complete snapshot',async()=>{
 const s=new SiriusXmLiveMetadata({fetchImpl:async()=>({ok:true,json:async()=>({delta:true,channels:{}})})});assert.match((await s.get(id)).diagnostics.fallbackReason,/partial/);
});
test('live metadata preserves raw transport, clears old artist for ads, and does not attach unrelated show times',async()=>{
 const live={get:async received=>{assert.equal(received,id);return {cut:{name:'Guest mix',validFrom:new Date(start).toISOString(),isAd:false},show:{name:'Guest program'},diagnostics:{}};}};
 const s=new SiriusXmMetadata({liveMetadata:live,readPlaybackClock:()=>({time:start})});s.getPublicChannelMetadata=async()=>({metadata:{channelName:"Diplo's Revolution",currentShow:'Old schedule',showStart:'old',showEnd:'old',currentShowDescription:'old',nextShow:'Next'},diagnostics:{}});
 const raw={state:'playing',position:20,queue:[{id:'unchanged'}],nowPlaying:{source:'SiriusXM',url:'sxm:9472',title:'old',artist:'old artist'}};
 const result=await s.overlay(raw);assert.equal(result.displayPlaybackState.nowPlaying.title,'Guest mix');assert.equal(result.displayPlaybackState.nowPlaying.artist,'');assert.equal(raw.nowPlaying.title,'old');assert.equal(result.displayPlaybackState.position,20);assert.equal(result.queue,raw.queue);assert.equal(result.siriusxmMetadata.showEnd,null);assert.equal(result.siriusxmMetadata.nextShow,'Next');
});
