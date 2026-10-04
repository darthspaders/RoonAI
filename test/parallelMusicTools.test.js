const {test}=require("node:test");const assert=require("node:assert/strict");
const {createParallelMusicTools}=require("../src/parallelMusicTools");
test("parallel music tools preserve exact Lyrion, SoundCloud and SiriusXM identities",async()=>{
  const calls=[];const tools=createParallelMusicTools(async(route,options)=>{calls.push({route,...options});return{ok:true};});
  await tools.lyrion_queue_next.handler({playerId:"p",referenceId:"saved-exact"});
  assert.deepEqual(calls[0],{route:"/api/lyrion/queue",body:{playerId:"p",referenceId:"saved-exact",action:"next"}});
  await tools.lyrion_skip.handler({playerId:"p"});assert.equal(calls[1].route,"/api/lyrion/control");
  await tools.soundcloud_add_to_playlist.handler({tracks:["soundcloud:tracks:123"],title:"Synapse Finds"});
  assert.deepEqual(calls[2].body.tracks,["soundcloud:tracks:123"]);
  await tools.lyrion_browse.handler({playerId:"p"});assert.equal(calls[3].route,"/api/lyrion/sources?playerId=p");
  assert.throws(()=>tools.lyrion_queue_next.handler({playerId:"p",title:"rematch"}),/Unknown field/);
  await tools.siriusxm_queue_episode.handler({playerId:"p",type:"episode-audio",id:"exact-episode",action:"next"});
  assert.deepEqual(calls[4],{route:"/api/siriusxm/ondemand/queue",body:{playerId:"p",type:"episode-audio",id:"exact-episode",action:"next"}});
  assert.equal(Object.keys(tools).length,35);
});

test("legacy Lyrion status action remains read only",async()=>{const tools=createParallelMusicTools(async(route,options)=>({route,options}));assert.deepEqual(await tools.lyrion_playback.handler({playerId:"p",action:"status"}),{route:"/api/lyrion/status?playerId=p",options:{}});});

test('artist station MCP preparation gets its own bounded deadline without changing transport deadlines',async()=>{
 const tools=createParallelMusicTools(async(route,options)=>({route,options}));
 const result=await tools.siriusxm_play_artist_station.handler({playerId:'p',id:'exact-station'});
 assert.deepEqual(result,{route:'/api/siriusxm/ondemand/artist/play',options:{body:{playerId:'p',id:'exact-station'},timeoutMs:300000}});
 const pause=await tools.lyrion_pause.handler({playerId:'p'});assert.equal(pause.options.timeoutMs,undefined);
});
