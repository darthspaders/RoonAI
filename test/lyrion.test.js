"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { LyrionClient, resolveAction, sourceFor } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");
test("SlimBrowse inherits root item parameters and honors disabled actions and browse aliases", () => {
  const base={actions:{play:{cmd:["siriusxm","playlist","play"],params:{menu:"siriusxm"},itemsParams:"params"}}};
  assert.deepEqual(resolveAction({params:{item_id:"2_query.0"}},base,"play").params,{menu:"siriusxm",item_id:"2_query.0"});
  assert.equal(resolveAction({actions:{play:null}},base,"play"),null);
  assert.equal(resolveAction({playAction:"go"},base,"play"),null);
  assert.equal(resolveAction({},base,"play"),null);
});
test("source actions are bound to player, expire, and cannot cross read/write routes", async () => {
  const client=new LyrionClient();
  const token=client.remember({kind:"play",cmd:["playlist","play"],params:{}},"p1","SoundCloud");
  assert.throws(()=>client.getAction(token,"p2"),/expired/);
  await assert.rejects(client.browse("p1",{token}),/queue endpoint/);
  await assert.rejects(client.execute("p1",token,"add"),/Unsupported/);
  client.actions.get(token).expires=0;assert.throws(()=>client.getAction(token,"p1"),/expired/);
});
test("search input stays one JSON parameter, artwork proxies locally, live metadata has no invented duration", async () => {
  const client=new LyrionClient();
  assert.deepEqual(client.command({kind:"browse",cmd:["siriusxm","items"],params:{search:"__TAGGEDINPUT__"}},"x: y",0,50),["siriusxm","items",0,50,"search:x: y"]);
  assert.match(client.artwork({artwork_url:"/music/12/cover.jpg"}),/^\/api\/lyrion\/artwork\?/);
  const remote="http://pri.art.prod.streaming.siriusxm.com/images/chan/logo.png";
  const proxied=client.artwork({artwork_url:remote});
  assert.equal(new URL(proxied,"https://tablet.example").searchParams.get("path"),`/imageproxy/${encodeURIComponent(remote)}/image.png`);
  assert.equal(client.artwork({artwork_url:proxied}),proxied);
  client.rpc=async()=>({mode:"play",player_connected:1,playlist_tracks:1,playlist_cur_index:0,playlist_loop:[{title:"Station",url:"sxm:1","playlist index":0}],remoteMeta:{title:"Track",artist:"Artist",url:"sxm:1"},time:20});
  const status=await client.status("p1"); assert.equal(status.nowPlaying.title,"Track");assert.equal(status.duration,0);assert.equal(status.nowPlaying.source,"SiriusXM");
  assert.equal(sourceFor("file:///nas/track.flac"),"Local");
});
test("handoff pauses the old frontend before playback and failed pause aborts", async () => {
  const calls=[]; const client={players:async()=>[{id:"p",playing:true,connected:true}],control:async(...args)=>calls.push(args)};
  const roon={getState:()=>({zones:[{zone_id:"r",state:"playing"}]}),control:async(...args)=>calls.push(args)};
  const api=createLyrionApi({roon,client,file:"does-not-exist",readJson:async()=>({}),sendJson:()=>{}});
  await api.handoff("lyrion"); assert.deepEqual(calls,[["r","pause"]]);
  await api.handoff("roon"); assert.deepEqual(calls[1],["p","pause"]);
  roon.control=async()=>{throw new Error("pause failed");}; await assert.rejects(api.handoff("lyrion"),/pause failed/);
});
test("unavailable optional Lyrion leaves Roon available unless Lyrion owns playback", async () => {
  const client={players:async()=>{throw new Error("offline");}};
  const api=createLyrionApi({roon:{getState:()=>({zones:[]})},client,file:"does-not-exist"});
  await api.handoff("roon"); await api.handoff("lyrion"); await assert.rejects(api.handoff("roon"),/Cannot safely/);
});
test("playback revision records newer pause and frontend intents without changing their transport behavior",async()=>{
 let body={action:"pause",playerId:"p"};const calls=[],client={requirePlayer:async()=>{},control:async(...args)=>calls.push(args),players:async()=>[]};
 const api=createLyrionApi({roon:{getState:()=>({zones:[]})},client,file:"does-not-exist",readJson:async()=>body,sendJson:()=>{}});
 const req={method:"POST",headers:{}},res={};assert.equal(api.playbackRevision(),0);
 await api.handle(req,res,new URL("http://localhost:3777/api/lyrion/control"));assert.equal(api.playbackRevision(),1);assert.deepEqual(calls,[["p","pause"]]);
 await api.handoff("roon");assert.equal(api.playbackRevision(),2);assert.deepEqual(calls,[["p","pause"]]);
});
test("discovery isolates service failures and reports browse-only capabilities", async () => {
  const c=new LyrionClient();c.sources=async()=>[{id:"local",title:"Local"},{id:"broken",title:"Broken",actions:{browse:"x"}},{id:"radio",title:"Radio",actions:{browse:"y"}}];
  c.browse=async(p,opts)=>{if(opts.token==="x")throw new Error("Plugin login required");return {items:opts.token?[]:[{title:"track"}],count:1};};
  const result=await c.search("p","track");assert.equal(result.results[0].items.length,1);assert.match(result.results[1].error,/login/);assert.equal(result.results[2].searchable,false);
});
test("parallel frontend starts serialize and internal Roon playback remains reentrant", async () => {
  const calls=[];
  const client={players:async()=>[{id:"l",playing:true,connected:true}],control:async(id,cmd)=>{calls.push(`lyrion:${cmd}`);}};
  const roon={getState:()=>({zones:[]}),control:async(id,cmd)=>{calls.push(`roon:${cmd}`);},playFromHere:async()=>{await roon.control("r","play");}};
  const api=createLyrionApi({roon,client,file:"does-not-exist"});api.installPlaybackHandoffs();
  await roon.playFromHere();assert.deepEqual(calls,["lyrion:pause","lyrion:pause","roon:play"]);
  calls.length=0;await roon.control("r","pause");assert.deepEqual(calls,["roon:pause"]);
});
test("queue and transport produce documented JSON-RPC commands without live playback",async()=>{
 const calls=[];const c=new LyrionClient({fetchImpl:async(url,opts)=>{calls.push(JSON.parse(opts.body).params);return{ok:true,json:async()=>({result:{}})};}});
 for(const action of ["play","pause","next","previous","clear"])await c.control("p",action);
 assert.deepEqual(calls,[["p",["play"]],["p",["pause",1]],["p",["playlist","index","+1"]],["p",["playlist","index","-1"]],["p",["playlist","clear"]]]);
 for(const [kind,command] of [["play","play"],["add","add"],["next","insert"]]){const token=c.remember({kind,cmd:["siriusxm","playlist",command],params:{item_id:"2.0"}},"p","SiriusXM");await c.execute("p",token,kind);assert.deepEqual(calls.at(-1),["p",["siriusxm","playlist",command,"item_id:2.0"]]);}
});
