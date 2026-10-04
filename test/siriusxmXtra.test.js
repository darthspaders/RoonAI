"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {SiriusXmArtistStations}=require("../src/siriusxmArtistStations");
const {SiriusXmOnDemand}=require("../src/siriusxmOnDemand");
const {createSiriusXmOnDemandApi}=require("../src/siriusxmOnDemandApi");
const XTRA="channel-xtra",ALL="403ab6a5-d3c9-4c2a-a722-a94a6a5fd056";
const item=(id,type=XTRA)=>({entity:{id,type,texts:{title:{default:"Zen "+id},description:{default:"Music for meditation"}},images:{tile:{aspect_1x1:{preferred:{url:"aem/zen.jpeg"}}}}},decorations:{channelNumber:1236}});
const container=items=>({container:{sets:[{items}]}});
function setup(){
  const catalog=new SiriusXmOnDemand({file:null}),calls=[];let queue=[],mode="playing";
  const lyrion={exclusive:f=>f(),handoff:async()=>calls.push("handoff"),client:{requirePlayer:async()=>{},rpc:async(p,c)=>{calls.push(c);if(c[1]==="play")queue=[];queue.push(c[2]);},status:async()=>({connected:true,state:mode,queueCount:queue.length,queueIndex:0,nowPlaying:{url:queue[0]}})}};
  const radio=new SiriusXmArtistStations({catalog,lyrion,pollMs:0});
  radio.remember([item("exact",XTRA)],XTRA);return{catalog,calls,lyrion,radio,queue:()=>queue,setMode:m=>mode=m};
}
const tracks=(ids)=>ids.map(id=>({id,urls:[{url:"https://feed.streaming.siriusxm.com/"+id+".m3u8",encryptionKeyId:"key",validUntil:new Date(Date.now()+3600000).toISOString()}],metadata:{xtra:{channelNumber:1236,channelName:"Zen",items:[{id,type:"xtra-channel-track",name:id,artistName:"Artist",duration:222756}]}}}));

test("Xtra search preserves exact type, channel art and description without admitting broadcasts or artists",async()=>{
 const x=setup();x.catalog.api=async()=>container([item("zen"),item("artist","artist-station"),item("live","channel-linear"),item("zen")]);
 const result=await x.radio.search("Zen",XTRA);assert.equal(result.length,1);assert.equal(result[0].id,"zen");assert.equal(result[0].type,XTRA);assert.equal(result[0].channelNumber,1236);assert.equal(result[0].description,"Music for meditation");assert.match(result[0].artwork,/imgsrv-sxm/);assert.deepEqual(x.calls,[]);
});

test("Xtra browse walks past linear-only pages, stops on repeats, and coalesces/caches catalog requests",async()=>{
 const x=setup(),routes=[];x.catalog.api=async route=>{routes.push(route);if(route.startsWith("page/"))return{page:{containers:[{url:"relationship/v1/container/all-channels?entityId="+ALL+"&entityType=curated-grouping&containerId=catalog&setResponseStructure=default"}]}};
 const offset=Number(new URL(route,"https://api.edge-gateway.siriusxm.com/").searchParams.get("offset"));return container(offset===0?[item("linear","channel-linear")]:[item("zen")]);};
 const [first,second]=await Promise.all([x.radio.browseXtra(),x.radio.browseXtra()]);assert.deepEqual(first.map(i=>i.id),["zen"]);assert.deepEqual(second,first);assert.equal(routes.length,4);await x.radio.browseXtra();assert.equal(routes.length,4);assert.deepEqual(x.calls,[]);
 const urls=routes.slice(1).map(r=>new URL(r,"https://api.edge-gateway.siriusxm.com/"));assert.deepEqual(urls.map(u=>u.searchParams.get("offset")),["0","1","2"]);assert.ok(urls.every(u=>u.searchParams.get("maxResponses")==="30"));
});

test("catalog descriptor cannot redirect authenticated requests to another host or another entity",async()=>{
 for(const descriptor of ["https://evil.com/relationship/v1/container/all-channels?entityId="+ALL+"&entityType=curated-grouping&containerId=x","relationship/v1/container/all-channels?entityId=wrong&entityType=curated-grouping&containerId=x"]){
  const x=setup();let count=0;x.catalog.api=async()=>{count++;return{page:{containers:[{url:descriptor}]}};};await assert.rejects(x.radio.browseXtra(),/catalog identity/);assert.equal(count,1);
 }
});

test("Xtra favorites persist independently even when artist and channel IDs collide",()=>{
 const x=setup();x.radio.remember([item("exact","artist-station")]);x.radio.favorite("add","exact",XTRA);x.radio.favorite("add","exact",XTRA);assert.equal(x.radio.favorites(XTRA).length,1);assert.equal(x.radio.favorites().length,0);
 const restored=new SiriusXmOnDemand({file:null});restored.saved=JSON.parse(JSON.stringify(x.catalog.saved));const radio=new SiriusXmArtistStations({catalog:restored,lyrion:{},pollMs:0});assert.equal(radio.favorites(XTRA)[0].type,XTRA);radio.favorite("remove","exact",XTRA);assert.equal(radio.favorites(XTRA).length,0);assert.deepEqual(x.calls,[]);
});

test("Xtra playback and refill use exact channel identity/cursor and retain highest-quality HLS metadata",async()=>{
 const x=setup(),requests=[];let count=0;x.catalog.api=async(route,body)=>{requests.push({route,body});return{id:"exact",type:XTRA,sequenceToken:"page-"+(++count),streams:tracks(count===1?["one","two","three"]:["three","four"])};};
 await x.radio.start("player","exact",XTRA);assert.equal(x.queue().length,3);assert.equal(x.radio.status("player").type,XTRA);const track=x.radio.identify(x.queue()[0]);assert.equal(track.title,"one");assert.equal(track.artist,"Artist");assert.equal(track.duration,222.756);assert.equal(track.source,"SiriusXM Xtra channel");assert.match(x.queue()[0],/\.flac$/);
 await x.radio.tick();assert.equal(x.queue().length,4);assert.equal(requests[1].body.sequenceToken,"page-1");assert.ok(requests.every(r=>r.body.id==="exact"&&r.body.type===XTRA&&r.body.mediaFormat==="HLS"));assert.equal(x.calls.filter(c=>c==="handoff").length,1);assert.equal(x.calls.filter(c=>Array.isArray(c)&&c[1]==="play").length,1);
 x.radio.stop("player");await x.radio.tick();assert.equal(x.queue().length,4);
});

test("wrong Xtra tune identity cannot replace a user's existing queue",async()=>{
 const x=setup();x.catalog.api=async()=>({id:"exact",type:"artist-station",streams:tracks(["one"])});await assert.rejects(x.radio.start("player","exact",XTRA),/identity/);assert.deepEqual(x.calls,[]);
});

test("Xtra skips respect current limits and send the Xtra type, never artist-station",async()=>{
 const x=setup(),requests=[];x.catalog.api=async(route,body)=>{requests.push(body);return route.endsWith("skip")?{skipAllowed:false}:{id:"exact",type:XTRA,sequenceToken:"cursor",streams:tracks(["one"])};};
 await x.radio.start("player","exact",XTRA);await assert.rejects(x.radio.skip("player","next"),/no skips/);assert.equal(requests[1].type,XTRA);assert.equal(requests[1].sequenceToken,"cursor");assert.equal(requests[1].direction,"forward");
});

test("Xtra API returns saved exact items and its stop action cannot stop an unrelated artist session",async()=>{
 const x=setup();let body={};const api=createSiriusXmOnDemandApi({catalog:x.catalog,lyrion:x.lyrion,readJson:async()=>body,sendJson:(res,status,data)=>data});
 // The API owns the shared queue engine; no audio decoding is required for catalog actions.
 api.artists.remember([item("same","artist-station")]);api.artists.sessions.set("player",{type:"artist-station",station:{id:"same",title:"Artist"},active:true,urls:new Set()});
 const req={method:"POST",headers:{origin:"http://localhost:3777"}},res={setHeader(){}};
 body={action:"add",id:"exact"};const favorites=await api.handle(req,res,new URL("http://localhost:3777/api/siriusxm/ondemand/xtra/favorites"));assert.equal(favorites.items[0].type,XTRA);
 body={playerId:"player"};const status=await api.handle(req,res,new URL("http://localhost:3777/api/siriusxm/ondemand/xtra/stop"));assert.equal(status.station,null);assert.equal(api.artists.status("player").active,true);
 api.artists.sessions.set("player",{type:XTRA,station:{id:"exact",title:"Zen"},active:true,urls:new Set()});
 const artist=await api.handle(req,res,new URL("http://localhost:3777/api/siriusxm/ondemand/artist/stop"));assert.equal(artist.station,null);assert.equal(api.artists.status("player").active,true);
 clearInterval(api.artists.timer);assert.deepEqual(x.calls,[]);
});
