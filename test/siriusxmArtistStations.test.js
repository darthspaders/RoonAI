"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {SiriusXmArtistStations,mediaUrl}=require("../src/siriusxmArtistStations");
const {SiriusXmOnDemand}=require("../src/siriusxmOnDemand");
const {LyrionClient}=require("../src/lyrionClient");
function setup(){
  const catalog=new SiriusXmOnDemand({file:null});const calls=[];let queue=[],index=0,mode="playing";
  const lyrion={exclusive:f=>f(),handoff:async()=>calls.push("handoff"),client:{requirePlayer:async()=>{},
    rpc:async(player,command)=>{calls.push(command);if(command[1]==="play")queue=[];queue.push(command[2]);},
    status:async()=>({connected:true,state:mode,queueCount:queue.length,queueIndex:index,nowPlaying:{url:queue[index]}})}};
  const radio=new SiriusXmArtistStations({catalog,lyrion,pollMs:0});
  radio.remember([{entity:{type:"artist-station",id:"exact-station",texts:{title:{default:"Artist"}}}}]);
  const tuneCalls=[];let page=0;
  catalog.api=async(route,body)=>{tuneCalls.push({route,body});if(route.endsWith("skip"))return {skipAllowed:false};
    return {id:"exact-station",type:"artist-station",sequenceToken:"cursor-"+(++page),streams:["track-"+page,"track-"+(page+1),"track-"+(page+2)].map(id=>({id,urls:[{url:"https://feed.streaming.siriusxm.com/"+id+".mp4",validUntil:new Date(Date.now()+3600000).toISOString()}],metadata:{artist:{items:[{id,name:id,artistName:"Exact artist",albumName:"Album",duration:123000}]}}}))};};
  return {radio,catalog,lyrion,calls,tuneCalls,queue:()=>queue,setIndex:n=>index=n,setMode:m=>mode=m,replace:()=>queue=["other"]};
}
test("exact station identity, incremental cursor and duplicate suppression survive refill",async()=>{
  const x=setup();await x.radio.start("player","exact-station");assert.equal(x.queue().length,3);
  assert.equal(x.calls.filter(c=>c==="handoff").length,1);await x.radio.tick();assert.equal(x.queue().length,4);
  assert.equal(x.tuneCalls[1].body.sequenceToken,"cursor-1");assert.equal(x.tuneCalls[1].body.id,"exact-station");
  assert.equal(x.tuneCalls[0].body.mediaFormat,"HLS");assert.equal(x.tuneCalls[1].body.mediaFormat,"HLS");
  assert.equal(new Set(x.queue()).size,4);assert.equal(x.radio.identify(x.queue()[0]).artist,"Exact artist");
  assert.equal(x.calls.filter(c=>Array.isArray(c)&&c[1]==="play").length,1);
  await x.radio.tick();assert.equal(x.queue().length,4); // Enough tracks ahead: no speculative fetch.
});
test("paused players do not refill; clear/replacement and explicit stop cannot resurrect a station",async()=>{
  const x=setup();await x.radio.start("player","exact-station");x.setMode("paused");await x.radio.tick();assert.equal(x.queue().length,3);
  x.setMode("playing");x.replace();await x.radio.tick();assert.equal(x.radio.status("player").active,false);assert.deepEqual(x.queue(),["other"]);
  await x.radio.start("player","exact-station");x.radio.stop("player");const count=x.queue().length;await x.radio.tick();assert.equal(x.queue().length,count);
});
test("refill rechecks playback after fetching and fails closed on uncertain queue writes",async()=>{
  const x=setup();await x.radio.start("player","exact-station");const api=x.catalog.api;
  x.catalog.api=async(...args)=>{const data=await api(...args);x.replace();return data;};await x.radio.tick();assert.deepEqual(x.queue(),["other"]);assert.equal(x.radio.status("player").active,false);
  const y=setup();await y.radio.start("player","exact-station");y.lyrion.client.rpc=async()=>{throw Error("timeout");};await y.radio.tick();assert.equal(y.radio.status("player").active,false);assert.match(y.radio.status("player").reason,/not confirmed/);
});
test("empty, repeating, wrong identity and unavailable stations do not loop or replace playback",async()=>{
  const x=setup();x.catalog.api=async()=>({id:"wrong",type:"artist-station",streams:[]});await assert.rejects(x.radio.start("player","exact-station"),/identity/);assert.equal(x.calls.length,0);
  await assert.rejects(x.radio.start("player","unknown"),/available/);
  const y=setup();await y.radio.start("player","exact-station");y.catalog.api=async()=>({id:"exact-station",type:"artist-station",sequenceToken:"same",streams:[]});await y.radio.tick();assert.equal(y.radio.status("player").active,false);assert.equal(y.queue().length,3);
});
test("skip refusal is surfaced; station metadata remains separate from live channels",async()=>{
  const x=setup();await x.radio.start("player","exact-station");await assert.rejects(x.radio.skip("player","next"),/no skips/);
  const c=new LyrionClient();c.onDemandMetadata=u=>x.radio.identify(u);const track=c.track({url:x.queue()[0]});
  assert.equal(track.source,"SiriusXM artist station");assert.equal(track.duration,123);assert.equal(track.artist,"Exact artist");
  for(const u of ["http://127.0.0.1","https://evil.com/a.mp4","https://streaming.siriusxm.com.evil.com/a","https://user:pass@feed.streaming.siriusxm.com/a"])assert.throws(()=>mediaUrl(u));
});
test("library hydration and search accept only artist station identities",async()=>{
  const x=setup();x.catalog.api=async route=>route.endsWith("library/all")?{allDataMap:{a:{entityType:"artist-station",entityId:"library-station"},b:{entityType:"channel-linear",entityId:"channel"}}}:route.includes("hydration")?{entity:{artistStation:{id:"library-station",texts:{title:{default:"Library artist"}}}}}:{container:{sets:[{items:[{entity:{type:"artist-station",id:"found",texts:{title:{default:"Artist"}}}},{entity:{type:"channel-linear",id:"channel"}}]}]}};
  assert.deepEqual((await x.radio.library()).map(s=>s.id),["library-station"]);assert.deepEqual((await x.radio.search("artist")).map(s=>s.id),["found"]);
});

test("favorites persist exact identities, deduplicate and never change playback",()=>{
 const x=setup();x.radio.favorite('add','exact-station');x.radio.favorite('add','exact-station');assert.equal(x.radio.favorites().length,1);
 const restored=new SiriusXmOnDemand({file:null});restored.saved=JSON.parse(JSON.stringify(x.catalog.saved));const radio=new SiriusXmArtistStations({catalog:restored,lyrion:{},pollMs:0});assert.equal(radio.favorites()[0].id,'exact-station');
 assert.throws(()=>radio.favorite('add','unknown'));radio.favorite('remove','exact-station');assert.equal(radio.favorites().length,0);assert.equal(x.calls.length,0);
});

test("first track completion is a preflight: a broken upstream cannot replace playback",async()=>{
 const x=setup();x.replace();x.radio.prepareTrack=async()=>{throw Error("SiriusXM track audio was incomplete.");};
 await assert.rejects(x.radio.start("player","exact-station"),/incomplete/);
 assert.deepEqual(x.queue(),["other"]);assert.equal(x.calls.length,0);assert.equal(x.radio.sessions.size,0);
});

test("a disconnected setup request cannot change playback after preparation finishes",async()=>{
 const x=setup();x.replace();x.radio.prepareTrack=async()=>{};
 await assert.rejects(x.radio.start("player","exact-station","artist-station",{shouldContinue:()=>false}),/cancelled/);
 assert.deepEqual(x.queue(),["other"]);assert.equal(x.calls.length,0);assert.equal(x.radio.sessions.size,0);
});
test("slow preparation leaves the playback lock available; a new pause cancels the stale commit",async()=>{
 const x=setup();let serial=Promise.resolve(),release,entered;const gate=new Promise(resolve=>release=resolve),preparing=new Promise(resolve=>entered=resolve);
 x.lyrion.exclusive=fn=>{const result=serial.then(fn);serial=result.catch(()=>{});return result;};x.radio.prepareTrack=async()=>{entered();await gate;};
 const pending=x.radio.start("player","exact-station");await preparing;
 await x.lyrion.exclusive(async()=>{x.setMode("paused");});release();
 await assert.rejects(pending,/Playback changed/);assert.deepEqual(x.queue(),[]);assert.equal(x.calls.length,0);
});
test("a newer station request commits while old preparation is pending and the old request cannot replace it",async()=>{
 const x=setup();let release,entered,count=0;const gate=new Promise(resolve=>release=resolve),preparing=new Promise(resolve=>entered=resolve);
 x.radio.prepareTrack=async()=>{if(++count===1){entered();await gate;}};
 const old=x.radio.start("player","exact-station");await preparing;await x.radio.start("player","exact-station");const queue=x.queue().slice();release();
 await assert.rejects(old,/cancelled/);assert.deepEqual(x.queue(),queue);assert.equal(x.radio.identify(queue[0]).title,"track-2");assert.equal(x.calls.filter(call=>Array.isArray(call)&&call[1]==="play").length,1);
});
test("a newer playback intent cancels preparation even if the player's URL and state are unchanged",async()=>{
 const x=setup();let revision=0,release,entered;const gate=new Promise(resolve=>release=resolve),preparing=new Promise(resolve=>entered=resolve);
 x.lyrion.playbackRevision=()=>revision;x.radio.prepareTrack=async()=>{entered();await gate;};
 const pending=x.radio.start("player","exact-station");await preparing;revision++;release();
 await assert.rejects(pending,/Playback changed/);assert.deepEqual(x.queue(),[]);assert.equal(x.calls.length,0);
});

test("station start warms following exact tracks and refills only append without controlling playback",async()=>{
 const x=setup(),prepared=[];x.radio.prepareTrack=async key=>prepared.push(key);
 await x.radio.start("player","exact-station");assert.equal(prepared.length,3);
 const expected=x.queue().map(url=>new URL(url).pathname.match(/\/audio\/([a-f0-9]{64})\./)[1]);assert.deepEqual(prepared,expected);
 await x.radio.tick();assert.equal(prepared.length,4);assert.equal(x.calls.filter(c=>Array.isArray(c)&&c[1]==="play").length,1);
});

test("legacy M4A body is retried whole before exposure and keeps exact byte-range identity",async()=>{
 const x=setup(),key="a".repeat(64),response={};let calls=0;
 x.catalog.saved.artistMedia[key]={url:"https://feed.streaming.siriusxm.com/exact.mp4",expires:Date.now()+60000,hls:false};
 x.catalog.fetch=async(url,options)=>{assert.equal(options.headers.Range,"bytes=100-103");calls++;return new Response(calls===1?"bad":"good",{status:206,headers:{"Content-Length":"4","Content-Range":"bytes 100-103/200","Accept-Ranges":"bytes"}});};
 const res={destroyed:false,writeHead(status,headers){response.status=status;response.headers=headers;},end(data){response.data=data;}};
 await x.radio.audio({method:"GET",headers:{range:"bytes=100-103"},socket:{remoteAddress:"127.0.0.1"}},res,key,()=>{throw Error("Unexpected error response");});
 assert.equal(calls,2);assert.equal(response.status,206);assert.equal(response.headers["Content-Type"],"audio/mp4");assert.equal(response.headers["Content-Length"],4);
 assert.equal(response.headers["content-range"],"bytes 100-103/200");assert.equal(response.data.toString(),"good");
});
