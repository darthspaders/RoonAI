"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {SiriusXmMetadata,normalize,epgTime}=require("../src/siriusxmMetadata");
const now=Date.parse("2026-10-01T04:30:00Z");

test('BPM mixes without cut artwork use their exact channel logo and preserve raw playback',async()=>{
 const service=new SiriusXmMetadata({clock:()=>now,readPlaybackClock:()=>({time:now})});
 const metadata={channelName:'BPM',channelNumber:52,channelArtwork:'https://example.test/bpm.svg',artwork:'wrong-scheduled-show.jpg',currentTrack:'Sat Night Remix',currentArtist:'@erinconstantine',trackStart:new Date(now-10000).toISOString(),liveMetadataSource:'siriusxm-lookaround'};
 service.getChannelMetadata=async()=>({metadata,diagnostics:{}});
 const raw={playerId:'p',state:'playing',position:50,duration:0,nowPlaying:{source:'SiriusXM',url:'sxm:thebeat',title:'Old track',artist:'Old artist',artwork:'old-track.jpg'},queue:[{id:'keep'}]};
 const original=JSON.stringify(raw),result=await service.overlay(raw),track=result.displayPlaybackState.nowPlaying;
 assert.equal(track.title,'Sat Night Remix');assert.equal(track.artwork,metadata.channelArtwork);assert.equal(track.artworkFallback,metadata.channelArtwork);
 assert.equal(JSON.stringify(raw),original);assert.equal(result.displayPlaybackState.position,50);assert.deepEqual(result.displayPlaybackState.queue,raw.queue);
 metadata.trackArtwork='exact-mix.jpg';assert.equal((await service.overlay(raw)).displayPlaybackState.nowPlaying.artwork,'exact-mix.jpg');
});
test('logo fallback survives missing public metadata and never borrows another channel logo',async()=>{
 const service=new SiriusXmMetadata({clock:()=>now,favorites:()=>[{url:'sxm:thebeat',title:'BPM (52)',artwork:'/api/lyrion/artwork?path=bpm'}]});
 service.getChannelMetadata=async()=>({metadata:null,diagnostics:{fallbackReason:'offline'}});
 const raw={playerId:'p',state:'playing',nowPlaying:{source:'SiriusXM',url:'sxm:thebeat',title:'Mix',artist:'DJ'}};
 const first=await service.overlay(raw);assert.equal(first.displayPlaybackState.nowPlaying.artwork,'/api/lyrion/artwork?path=bpm');assert.equal(raw.nowPlaying.artwork,undefined);
 for(const url of ['sxm:chill','sxm:unknown'])assert.equal((await service.overlay({...raw,nowPlaying:{...raw.nowPlaying,url}})).displayPlaybackState.nowPlaying.artwork,'');
 service.favorites=()=>{throw Error('Unreadable favorites');};assert.equal((await service.overlay(raw)).displayPlaybackState.nowPlaying.title,'Mix');
});
test('unavailable timing uses a channel logo without selecting future track or program artwork',async()=>{
 const service=new SiriusXmMetadata({clock:()=>now,readPlaybackClock:()=>({reason:'No timing'})});
 service.getChannelMetadata=async()=>({metadata:{channelArtwork:'bpm.svg',trackArtwork:'future.jpg',artwork:'scheduled.jpg',currentTrack:'Future',trackStart:new Date(now+10000).toISOString(),liveMetadataSource:'siriusxm-lookaround'},diagnostics:{}});
 const raw={state:'playing',nowPlaying:{source:'SiriusXM',url:'sxm:thebeat',title:'Current'}};
 const track=(await service.overlay(raw)).displayPlaybackState.nowPlaying;assert.equal(track.title,'Current');assert.equal(track.artwork,'bpm.svg');
});
test('channel and show art remain distinct, and mismatched live shows discard scheduled show art',async()=>{
 const namedGuide={chEpgInfo:{nowplaying:{episode:[{...guide.chEpgInfo.nowplaying.episode[0],pr:{pName:'Current',logo:'show.jpg'}}]}}};
 const publicMetadata=normalize({...channel,colorlogo:'channel.svg'},namedGuide,now);
 assert.equal(publicMetadata.artwork,'show.jpg');assert.equal(publicMetadata.showArtwork,'show.jpg');assert.equal(publicMetadata.channelArtwork,'channel.svg');
 const service=new SiriusXmMetadata({liveMetadata:{get:async()=>({show:{name:'Different live show'},diagnostics:{}})}});
 service.getPublicChannelMetadata=async()=>({metadata:publicMetadata,diagnostics:{}});
 const result=await service.getChannelMetadata('53');assert.equal(result.metadata.showArtwork,null);assert.equal(result.metadata.artwork,'channel.svg');
});
test('station-name cut cannot replace a song or survive in the fallback cache',async()=>{
 const service=new SiriusXmMetadata({clock:()=>now,readPlaybackClock:()=>({time:now})});
 let m={channelName:"Diplo's Revolution",currentTrack:'Revolution',currentArtist:"Diplo’s",trackStart:new Date(now-1000).toISOString(),liveMetadataSource:'siriusxm-lookaround',trackArtwork:'wrong.jpg'};
 service.getChannelMetadata=async()=>({metadata:m,diagnostics:{}});
 const raw={playerId:'p',state:'playing',nowPlaying:{source:'SiriusXM',url:'sxm:9472',title:'Five Hours',artist:'Deorro',album:"Diplo's Revolution",artwork:'correct.jpg'}};
 service.playbackMetadata.set('p',{id:'9472',start:now-1000,at:now,track:{title:'Revolution',artist:"Diplo's",artwork:'wrong.jpg'}});
 let out=await service.overlay(raw);assert.equal(out.displayPlaybackState.nowPlaying.title,'Five Hours');assert.equal(out.displayPlaybackState.nowPlaying.artwork,'correct.jpg');assert.match(out.siriusxmDiagnostics.playback.decision,/placeholder/);assert.equal(service.playbackMetadata.has('p'),false);
 service.playbackMetadata.set('p',{id:'9472',start:now-1000,at:now,track:{title:'Revolution',artist:"Diplo's",artwork:'wrong.jpg'}});m=null;
 out=await service.overlay(raw);assert.equal(out.displayPlaybackState.nowPlaying.title,'Five Hours');assert.equal(service.playbackMetadata.has('p'),false);
});
test('aligned cut never inherits another track artwork; matching raw artwork remains usable',async()=>{
 const service=new SiriusXmMetadata({clock:()=>now,readPlaybackClock:()=>({time:now})});
 let metadata={currentTrack:'Look Right Through',currentArtist:'Storm Queen',trackStart:new Date(now-10000).toISOString(),liveMetadataSource:'siriusxm-lookaround'};
 service.getChannelMetadata=async()=>({metadata,diagnostics:{}});
 const raw={playerId:'test',state:'playing',nowPlaying:{source:'SiriusXM',url:'sxm:9472',title:'Different track',artist:'Someone else',artwork:'old.jpg'}};
 let result=await service.overlay(raw);assert.equal(result.displayPlaybackState.nowPlaying.artwork,'');assert.equal(raw.nowPlaying.artwork,'old.jpg');
 raw.nowPlaying.title='Look Right Through';raw.nowPlaying.artist='Storm Queen';raw.nowPlaying.artwork='correct.jpg';
 result=await service.overlay(raw);assert.equal(result.displayPlaybackState.nowPlaying.artwork,'correct.jpg');
 metadata={...metadata,trackArtwork:'aligned.jpg'};result=await service.overlay(raw);assert.equal(result.displayPlaybackState.nowPlaying.artwork,'aligned.jpg');
 raw.nowPlaying.artist='Wrong artist';metadata={...metadata,trackArtwork:null};result=await service.overlay(raw);assert.equal(result.displayPlaybackState.nowPlaying.artwork,'');
});
const channel={channel_id:"9472",siriuschannelnumber:53,displayname:"Diplo's Revolution",pageurl:"https://www.siriusxm.com/channels/diplos-revolution",episode:{starttime:now-1800000,duration:3600,longTitle:"Live show"},content:{starttime:now-60000,title:"Song",artists:[{name:"Artist"},{name:"Guest"}]}};
const ep=(name,start,end)=>({channelKey:"9472",pgid:name,pr:{pName:name,longDesc:"Program description"},sc:{sTimeStr:start,eTimeStr:end}});
const guide={chEpgInfo:{nowplaying:{episode:[ep("Current","10.01.2026 00:00 EDT","10.01.2026 01:00 EDT"),ep("Next","10.01.2026 01:00 EDT","10.01.2026 02:00 EDT")]},dayChSchedules:[]}};
function fixture(options={}){let calls=0;const service=new SiriusXmMetadata({clock:()=>now,logger:{info(){}},fetchImpl:async url=>{calls++;return {ok:true,json:async()=>url.includes("mountain")?{channels:{9472:channel}}:guide};},...options});return {service,calls:()=>calls};}
test("matches numbers before IDs before exact normalized names; learns saved channels without fuzzy matching",()=>{
 const {service}=fixture({favorites:()=>[{url:"sxm:custom",title:"Custom Channel (123)"}]});
 assert.equal(service.match({channelNumber:53,channelId:"chill"}).id,"9472");assert.equal(service.match("diplos-revolution").method,"canonical-id");assert.equal(service.match(" Diplo’s Revolution ").method,"exact-name");assert.equal(service.match("123").id,"custom");assert.throws(()=>service.match("Diplo"),/exact/);assert.throws(()=>service.match({channelNumber:999,channelId:"9472"}),/Unknown/);
});
test("normalizes current and next shows using explicit UTC offsets, not server timezone",()=>{
 const m=normalize(channel,guide,now);assert.equal(m.showStart,"2026-10-01T04:00:00.000Z");assert.equal(m.currentShow,"Current");assert.equal(m.nextShow,"Next");assert.equal(m.nextShowStart,"2026-10-01T05:00:00.000Z");assert.equal(m.currentArtist,"Artist, Guest");assert.equal(m.schedule.length,2);assert.equal(epgTime("11.01.2026 01:00 EST"),Date.parse("2026-11-01T06:00:00Z"));
 const stale=normalize({...channel,episode:{},content:{...channel.content,starttime:now-3600000}},guide,now+86400000);assert.equal(stale.currentShow,null);assert.equal(stale.currentTrack,null);assert.equal(stale.nextShow,null);
});
test("45-second cache and concurrent request coalescing avoid repeated upstream calls",async()=>{
 let clock=now;const {service,calls}=fixture({clock:()=>clock});await Promise.all([service.getChannelMetadata("53"),service.getChannelMetadata("53")]);assert.equal(calls(),2);assert.equal((await service.getChannelMetadata("53")).diagnostics.cache,"hit");clock+=45001;await service.getChannelMetadata("53");assert.equal(calls(),4);
});
test("overlay preserves raw playback and transport; incomplete track pair keeps both Lyrion fields",async()=>{
 const {service}=fixture();const raw={state:"playing",position:99,duration:0,nowPlaying:{source:"SiriusXM",url:"sxm:9472",title:"Lyrion song",artist:"Lyrion artist"},queue:[{id:"keep"}]};const original=JSON.stringify(raw);
 const result=await service.overlay(raw);assert.equal(JSON.stringify(raw),original);assert.equal(result.nowPlaying.title,"Lyrion song");assert.equal(result.displayPlaybackState.nowPlaying.title,"Lyrion song");assert.equal(result.displayPlaybackState.position,99);assert.deepEqual(result.displayPlaybackState.queue,raw.queue);
 service.cache.clear();service.fetch=async url=>({ok:true,json:async()=>url.includes("mountain")?{channels:{9472:{...channel,content:{title:"Partial",starttime:now}}}}:guide});const partial=await service.overlay(raw);assert.equal(partial.displayPlaybackState.nowPlaying.title,"Lyrion song");assert.equal(partial.displayPlaybackState.nowPlaying.artist,"Lyrion artist");
});
test("outages and identity mismatches fall back; non-SiriusXM playback never fetches",async()=>{
 const {service}=fixture({fetchImpl:async()=>{throw Error("offline");}});const raw={nowPlaying:{source:"SiriusXM",url:"sxm:9472",title:"Keep"}};let r=await service.overlay(raw);assert.equal(r.siriusxmMetadata,null);assert.equal(r.displayPlaybackState.nowPlaying.title,"Keep");assert.match(r.siriusxmDiagnostics.fallbackReason,/offline/);
 const unaffected=await service.overlay({nowPlaying:{source:"SoundCloud"}});assert.equal(unaffected.siriusxmMetadata,null);
 service.cache.clear();service.fetch=async()=>({ok:true,json:async()=>({channels:{9472:{...channel,siriuschannelnumber:55}}})});r=await service.getChannelMetadata("53");assert.equal(r.metadata,null);assert.match(r.diagnostics.fallbackReason,/number changed/);
});
