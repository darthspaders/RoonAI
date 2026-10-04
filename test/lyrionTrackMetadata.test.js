const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createLyrionTrackMetadata}=require('../src/lyrionTrackMetadata');
const {MetadataEnrichmentService}=require('../src/metadataEnrichmentService');

test('Lyrion misses expire quickly, successes cache, concurrent requests coalesce',async()=>{
 let now=0,calls=0,found=false;
 const lookup=createLyrionTrackMetadata({async lookupBeatport(t,options){calls++;assert.equal(options.retryMissingAfterMs,60000);return found?{confidence:99,beatport:{id:1}}:null;}},()=>now);
 const track={title:'Title',artist:'Artist'};
 await Promise.all([lookup(track),lookup(track)]);assert.equal(calls,1);
 now=59000;await lookup(track);assert.equal(calls,1);
 now=65000;found=true;assert.equal((await lookup(track)).metadata.id,1);assert.equal(calls,2);
 now=200000;await lookup(track);assert.equal(calls,2);
});

test('Lyrion retry option preserves default and rate-limit cooldowns',async()=>{
 let calls=0,status='missing',age=65000;
 const service=new MetadataEnrichmentService({cacheFile:__filename+'.nonexistent',clock:()=>100000,
  beatport:{isConfigured:()=>true,findTrack:async()=>{calls++;return null;}},
  musicMemory:{beatportLookupBlocked:()=>true,latestEnrichmentAttempt:()=>({status,fetched_at:new Date(100000-age).toISOString()})}
 });
 await service.lookupBeatport({});assert.equal(calls,0);
 await service.lookupBeatport({},{retryMissingAfterMs:60000});assert.equal(calls,1);
 status='rate_limited';await service.lookupBeatport({},{retryMissingAfterMs:60000});assert.equal(calls,1);
 status='failed';age=1000;await service.lookupBeatport({},{retryMissingAfterMs:60000});assert.equal(calls,1);
 age=65000;await service.lookupBeatport({},{retryMissingAfterMs:60000});assert.equal(calls,2);
});
test('late exact catalogue identity bypasses a cached radio miss without trusting client metadata',async()=>{
 let match=null,calls=0;
 const lookup=createLyrionTrackMetadata({async lookupBeatport(track){calls++;return track.isrc==='VERIFIED'?{confidence:100,beatport:{id:9}}:null;}},()=>0,{async lookup(){return match;}});
 const track={title:'Radio title',artist:'Artist'};
 assert.equal((await lookup(track)).metadata,null);
 match={id:'123',title:'Radio title',artist:'Artist',isrc:'VERIFIED'};
 const result=await lookup({...track,tidal:{id:'123',title:'Wrong title',artist:'Wrong artist',isrc:'UNTRUSTED'}});
 assert.equal(result.metadata.id,9);assert.equal(result.catalogue.tidal.isrc,'VERIFIED');
 assert.equal(calls,3);
 await lookup({...track,tidal:{id:'123'}});assert.equal(calls,3);
});

function harness({manual=false}={}){
 let now=0,id=0;const timers=new Map(),nodes=new Map(),events={},requests=[],replies=[];
 function node(){return {value:'',textContent:'',hidden:false,children:[],classList:{contains:()=>true},setAttribute(){},append(...items){this.children.push(...items);},before(){},replaceChildren(...items){this.children=items;},querySelector:()=>node(),querySelectorAll:()=>[],addEventListener:(name,fn)=>events[name]=fn};}
 const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 const context={AbortSignal,document:{getElementById:get,createElement:node},localStorage:{getItem:()=>null,setItem(){}},Option:function(){},MutationObserver:class{observe(){}},
  setTimeout:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
  fetch:async(url,options)=>{requests.push(JSON.parse(options.body).track);if(manual)return new Promise(resolve=>replies.push(result=>resolve({ok:true,json:async()=>result})));return {ok:true,json:async()=>({metadata:null})};}
 };
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/lyrionDiscoveryRail.js'),'utf8'),context);
 return {requests,timers,get,reply:(i,result)=>replies[i](result),track:detail=>events['lyrion-track']({detail}),async advance(ms){now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}for(let i=0;i<10;i++)await Promise.resolve();}};
}

test('UI waits for stable identity, retries misses and caps attempts',async()=>{
 const h=harness();const a={title:'A',artist:'Artist'},b={title:'B',artist:'Artist'};
 h.track(a);await h.advance(4000);assert.equal(h.requests.length,0);
 h.track(b);await h.advance(4000);assert.equal(h.requests.length,0);
 h.track(b);await h.advance(1000);assert.deepEqual(h.requests,[b]);
 await h.advance(65000);assert.equal(h.requests.length,2);
 await h.advance(120000);await h.advance(120000);assert.equal(h.requests.length,4);
 h.track(b);await h.advance(600000);assert.equal(h.requests.length,4);
 h.track(a);await h.advance(5000);assert.equal(h.requests.length,5);
 h.track(null);assert.equal(h.timers.size,0);
});

test('a late exact catalogue identity refreshes an earlier miss and preserves the exact track ID',async()=>{
 const h=harness(),track={title:'Title',artist:'Artist',url:'sxm:channel'};
 h.track(track);await h.advance(5000);assert.equal(h.requests.length,1);
 const catalogue={tidal:{id:'123456',title:'Title',artist:'Artist',tidalUrl:'https://tidal.com/browse/track/123456'}};
 h.track({...track,catalogue});await h.advance(5000);
 assert.equal(h.requests.length,2);assert.equal(h.requests[1].tidal.id,'123456');
 assert.equal(h.requests[1].tidal.tidalUrl,catalogue.tidal.tidalUrl);
 h.track({...track,catalogue});await h.advance(3000);assert.equal(h.requests.length,2);
});

test('metadata arriving after the next track cannot replace the new track details',async()=>{
 const h=harness({manual:true});
 h.track({title:'Old',artist:'Artist'});await h.advance(5000);
 h.track({title:'New',artist:'Artist'});await h.advance(5000);
 h.reply(1,{metadata:{id:'22',label:'Current label'}});await h.advance(0);
 assert.equal(h.get('lyrionBeatportFields').children[1].textContent,'Current label');
 h.reply(0,{metadata:{id:'11',label:'Stale label'}});await h.advance(0);
 assert.equal(h.get('lyrionBeatportFields').children[1].textContent,'Current label');
 assert.equal(h.get('lyrionBeatportLink').href,'https://www.beatport.com/track/-/22');
});
