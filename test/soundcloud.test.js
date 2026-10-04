"use strict";
const {test}=require("node:test");const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {SoundCloudClient}=require("../src/soundcloudClient");
const {LyrionClient}=require("../src/lyrionClient");
test('SoundCloud search preserves exact result identity and encodes the query without writes',async()=>{
 const c=new SoundCloudClient({file:null});let calls=0;
 c.request=async(route,options)=>{calls++;assert.equal(options,undefined);const url=new URL(route,'https://api.soundcloud.com');assert.equal(url.pathname,'/tracks');assert.equal(url.searchParams.get('q'),'Artist & Remix');return {collection:[{id:42,title:'Exact mix',duration:180000,user:{username:'Uploader'},permalink_url:'https://soundcloud.com/u/exact'}]};};
 const rows=await c.search('Artist & Remix');assert.equal(rows[0].urn,'soundcloud:tracks:42');assert.equal(rows[0].duration,180);assert.equal(rows[0].url,'https://soundcloud.com/u/exact');assert.equal(calls,1);await assert.rejects(c.search(''),/Enter/);
});
function fixture(){
  const c=new SoundCloudClient({file:null});const writes=[];let ids=["soundcloud:tracks:1","soundcloud:tracks:2"];
  const playlist={urn:"soundcloud:playlists:10",title:"Synapse Finds",user:{urn:"soundcloud:users:7"},sharing:"private"};
  c.request=async(route,options={})=>{
    const u=new URL(route,"https://api.soundcloud.com");
    if(options.method){writes.push({route,...options});if(options.method==="PUT")ids=options.body.playlist.tracks.map(t=>t.urn);return playlist;}
    if(u.pathname==="/me")return {urn:"soundcloud:users:7"};
    if(u.pathname==="/me/playlists")return {collection:[playlist]};
    if(u.pathname.endsWith("/tracks"))return {collection:ids.map(urn=>({urn,title:urn}))};
    return {...playlist,track_count:ids.length};
  };
  return {c,writes,playlist,setIds:v=>ids=v};
}
test("playlist additions preserve order, use URNs, avoid duplicates; removal preserves unrelated entries",async()=>{
  const {c,writes}=fixture();const added=await c.update({tracks:["2","soundcloud://soundcloud:tracks:3","3"]});
  assert.equal(added.changed,1);assert.equal(added.duplicateCount,1);
  assert.deepEqual(writes[0].body.playlist.tracks,[{urn:"soundcloud:tracks:1"},{urn:"soundcloud:tracks:2"},{urn:"soundcloud:tracks:3"}]);
  await c.update({tracks:["3"]});assert.equal(writes.length,1);
  const removed=await c.update({tracks:["2"],remove:true});assert.deepEqual(removed.tracks.map(t=>t.urn),["soundcloud:tracks:1","soundcloud:tracks:3"]);
});
test("same-title concurrent additions serialize and create reuses the existing playlist",async()=>{
  const {c,writes}=fixture();await Promise.all([c.update({tracks:["3"]}),c.update({tracks:["4"]})]);
  assert.deepEqual(writes.at(-1).body.playlist.tracks.map(t=>t.urn),[1,2,3,4].map(id=>`soundcloud:tracks:${id}`));
  assert.equal((await c.create()).created,false);assert.equal(writes.length,2);
});
test("foreign ownership, incomplete playlists, ambiguous names, and external concurrent edits abort before writes",async()=>{
  const f=fixture();f.playlist.user.urn="soundcloud:users:8";await assert.rejects(f.c.update({tracks:["3"]}),/not owned/);assert.equal(f.writes.length,0);
  const g=fixture();g.c.all=async(route)=>route.startsWith('/me')?[g.playlist,g.playlist]:[];
  await assert.rejects(g.c.find(),/Multiple/);await assert.rejects(g.c.details("10"),/incomplete/);
  const h=fixture();const details=h.c.details.bind(h.c);let reads=0;h.c.details=async id=>{if(++reads===2)h.setIds(["soundcloud:tracks:1"]);return details(id);};
  await assert.rejects(h.c.update({tracks:["3"]}),/changed/);assert.equal(h.writes.length,0);
});
test("missing playlist creates private only when requested; invalid title resolution never searches",async()=>{
  const {c,writes}=fixture();c.find=async()=>null;
  await assert.rejects(c.update({tracks:["1"]}),/not found/);assert.equal(writes.length,0);
  const result=await c.update({tracks:["1"],createIfMissing:true});assert.equal(result.created,true);assert.equal(writes[0].body.playlist.sharing,"private");
  await assert.rejects(c.resolve("Artist - Title"),/exact/);
});
test("OAuth validates expiring state and PKCE and serializes rotating refresh tokens",async()=>{
  let now=1000,calls=0;const sent=[];
  const c=new SoundCloudClient({file:null,clientId:"id",clientSecret:"secret",clock:()=>now,fetchImpl:async(url,opts)=>{
    sent.push({url:String(url),body:Object.fromEntries(opts.body||[])});
    if(String(url).includes('/oauth/token')){calls++;return{ok:true,json:async()=>({access_token:"new",refresh_token:"rotated",expires_in:3600})};}
    return{ok:true,json:async()=>({urn:"soundcloud:users:7",username:"tester"})};
  }});
  await assert.rejects(c.callback("bad","code"),/invalid/);assert.equal(calls,0);
  const auth=new URL(c.begin().authorizationUrl);assert.equal(auth.searchParams.get("code_challenge_method"),"S256");
  await c.callback(auth.searchParams.get("state"),"code");assert.ok(sent[0].body.code_verifier);assert.equal(c.status().account.username,"tester");
  assert.equal(JSON.stringify(c.status()).includes('rotated'),false);
  now+=3600000;await Promise.all([c.accessToken(),c.accessToken()]);assert.equal(calls,2);
  await assert.rejects(c.callback(auth.searchParams.get("state"),"code"),/invalid/);
});
test("pagination and redirects cannot exfiltrate tokens; writes are not retried",async()=>{
  let calls=0;
  const c=new SoundCloudClient({file:null,fetchImpl:async()=>{calls++;return{status:302,headers:new Headers({location:"https://other.example/steal"})};}});
  c.tokens={access_token:"secret",expiresAt:Date.now()+3600000};
  await assert.rejects(c.resolve("https://soundcloud.com/artist/track"),/Invalid SoundCloud API/);assert.equal(calls,1);
  c.fetch=async()=>{calls++;throw Error("timeout");};await assert.rejects(c.request('/playlists',{method:"POST",body:{}}),/uncertain/);assert.equal(calls,2);
});
test("exact Lyrion SoundCloud identity survives restart and queues without artist-title rematching",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lyrion-exact-'));
  try{
    const file=path.join(dir,'items.json'),c=new LyrionClient({itemsFile:file});
    const item=c.menu({count:1,item_loop:[{text:"Mix (120:00)\nArtist",presetParams:{favorites_type:"audio",favorites_url:"soundcloud://soundcloud:tracks:123"}}]},"p","SoundCloud").items[0];
    assert.equal(item.soundcloudUrn,"soundcloud:tracks:123");assert.equal(item.duration,7200);
    const restored=new LyrionClient({itemsFile:file});let command;restored.rpc=async(p,cmd)=>{command=cmd;};
    await restored.executeExact("p",{referenceId:item.referenceId},"next");assert.deepEqual(command,["playlist","insert","soundcloud://soundcloud:tracks:123"]);
    assert.equal(restored.items.recent(10,"SoundCloud")[0].soundcloudUrn,item.soundcloudUrn);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("authorization retries only temporary DNS failures, never uncertain exchanges",async()=>{
  let calls=0;const client=new SoundCloudClient({file:null,fetchImpl:async()=>{calls++;if(calls<3)throw Object.assign(Error("fetch failed"),{cause:{code:"EAI_AGAIN"}});return {ok:true,status:200,json:async()=>({access_token:"test",expires_in:3600})};}});
  assert.equal((await client.tokenRequest({})).access_token,"test");assert.equal(calls,3);
  calls=0;client.fetch=async()=>{calls++;throw Object.assign(Error("fetch failed"),{cause:{code:"ECONNRESET"}});};
  await assert.rejects(client.tokenRequest({}),/Cannot reach SoundCloud authorization/);assert.equal(calls,1);
});
