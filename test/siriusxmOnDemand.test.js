"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {SiriusXmOnDemand,normalize,entities}=require('../src/siriusxmOnDemand');
const {safeMediaUrl,rewriteManifest,createSiriusXmOnDemandApi}=require('../src/siriusxmOnDemandApi');
const {LyrionClient}=require('../src/lyrionClient');
const {SiriusXmMetadata}=require('../src/siriusxmMetadata');
test('channel shows follow the exact channel container and exclude unrelated recommendations',async()=>{
 const c=new SiriusXmOnDemand({file:null});const id='4ebc3011-0ebe-a9ad-c58b-9a306f60fc2b';const calls=[];
 const url='recommender/v1/container/shows-podcasts?entityId='+id;
 c.api=async route=>{calls.push(route);return route.startsWith('page/')?{page:{containers:[{url},{url:'recommender/v1/container/related?entityId='+id}]}}:{container:{sets:[{items:[{entity:{id:'show-id',type:'show',texts:{title:{default:'Channel show'}}}},{entity:{id:'episode-id',type:'episode-audio'}}]}]}};};
 const items=await c.channelShows(id);assert.deepEqual(items.map(i=>i.id),['show-id']);assert.deepEqual(calls,['page/v1/page/channel-linear/'+id,url]);
 c.api=async()=>({page:{containers:[{url:'https://example.com/container/shows-podcasts?entityId='+id}]}});
 await assert.rejects(c.channelShows(id),/identity/);
});
test('catalog keeps exact episode identity, converts milliseconds, and preserves show metadata',()=>{
 const item={entity:{id:'exact-id',type:'episode-audio',texts:{title:{default:'Mix'}}},decorations:{duration:3593000}};
 assert.equal(normalize(item).duration,3593);assert.equal(entities({container:{sets:[{items:[item,{entity:{type:'channel-linear'}}]}]}}).length,1);
 const c=new SiriusXmOnDemand({file:null});c.remember([item]);c.saved.items['episode-audio:exact-id'].showTitle='Show';c.remember([item]);assert.equal(c.get('episode-audio','exact-id').showTitle,'Show');assert.throws(()=>c.get('episode-audio','other'));
});
test('subscriber login coalesces and stores only session, not the password',async()=>{
 const routes=[];let loginCount=0;
 const c=new SiriusXmOnDemand({file:null,getCredentials:()=>({handle:'test',password:'private'}),fetchImpl:async(u,o)=>{
  routes.push(new URL(u).pathname);let data={};
  if(u.endsWith('devices'))data={grant:'device'};
  if(u.endsWith('anonymous'))data={accessToken:'anon'};
  if(u.endsWith('password')){loginCount++;data={grant:'auth'};}
  if(u.endsWith('authenticated'))data={sessionType:'authenticated',accessToken:'access',accessTokenExpiresAt:new Date(Date.now()+3600000).toISOString()};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.deepEqual(await Promise.all([c.token(),c.token()]),['access','access']);assert.equal(loginCount,1);assert.equal(JSON.stringify(c.saved).includes('private'),false);assert.equal(routes.length,5);
});
test('manifest references are exact and cannot point at arbitrary hosts or local files',()=>{
 const refs=[];const result=rewriteManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://api.edge-gateway.siriusxm.com/playback/key/v1/exact"\nsegment.aac','https://aod-ftc-prod-device.streaming.siriusxm.com/path/list.m3u8',(url,key)=>{refs.push({url,key});return 'local-'+refs.length;});
 assert.match(result,/URI="local-1"/);assert.equal(refs[0].key,true);assert.equal(refs[1].url,'https://aod-ftc-prod-device.streaming.siriusxm.com/path/segment.aac');
 for(const url of ['http://127.0.0.1','file:///x','https://evil.com','https://streaming.siriusxm.com.evil.com/x','https://u:p@api.edge-gateway.siriusxm.com/x'])assert.throws(()=>safeMediaUrl(url));
});
test('recorded episode status never receives live metadata and duration survives Lyrion string zero',async()=>{
 const c=new LyrionClient();c.onDemandMetadata=url=>url==='http://local/episode'?{id:'episode',title:'Recorded mix',showTitle:'Diplo',duration:3593}:null;
 c.rpc=async()=>({mode:'play',time:42,playlist_tracks:1,playlist_loop:[{'playlist index':0,url:'http://local/episode',duration:'0'}]});
 const s=await c.status('player');assert.equal(s.duration,3593);assert.equal(s.nowPlaying.source,'SiriusXM on demand');
 const overlay=new SiriusXmMetadata();overlay.getChannelMetadata=()=>{throw Error('Must not call live metadata');};assert.equal((await overlay.overlay(s)).siriusxmMetadata,null);
});
test('queue actions preserve exact episode and do not handoff on add or next',async()=>{
 const catalog=new SiriusXmOnDemand({file:null});catalog.saved.items['episode-audio:exact']={id:'exact',type:'episode-audio',title:'Exact episode',playable:true};const commands=[],handoffs=[];
 catalog.tune=async()=>({streams:[{urls:[{url:'https://aod-ftc-prod-device.streaming.siriusxm.com/test.m3u8'}]}]});
 const lyrion={client:{requirePlayer:async()=>{},rpc:async(p,c)=>commands.push(c)},exclusive:f=>f(),handoff:async t=>handoffs.push(t)};
 let body;const api=createSiriusXmOnDemandApi({catalog,lyrion,readJson:async()=>body,sendJson:()=>{}});
 const req={method:'POST',headers:{origin:'http://localhost:3777'}},res={setHeader(){}};
 for(const action of ['add','next','play']){body={action,type:'episode-audio',id:'exact',playerId:'player'};await api.handle(req,res,new URL('http://localhost:3777/api/siriusxm/ondemand/queue'));}
 assert.deepEqual(commands.map(c=>c[1]),['add','insert','play']);assert.equal(new Set(commands.map(c=>c[2])).size,1);assert.deepEqual(handoffs,['lyrion']);assert.equal(api.identify(commands[0][2]).id,'exact');
});
