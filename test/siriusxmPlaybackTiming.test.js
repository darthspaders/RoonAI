const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {channelId,playbackClock}=require('../src/siriusxmPlaybackClock');
const {SiriusXmLiveMetadata}=require('../src/siriusxmLiveMetadata');
const {SiriusXmMetadata}=require('../src/siriusxmMetadata');
const {sourceFor}=require('../src/lyrionClient');
test('only exact SiriusXM schemes and local plugin URLs identify channels',()=>{
 for(const url of ['sxm:9472','http://localhost:9999/9472.m3u8']){assert.equal(channelId(url),'9472');assert.equal(sourceFor(url),'SiriusXM');}
 for(const url of ['http://evil.test:9999/9472.m3u8','http://localhost:3777/9472.m3u8','sxm:../bad'])assert.equal(channelId(url),null);
});
test('PDT timing is bounded, channel-specific and does not advance on wall clock alone',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sxm-clock-'));const now=Date.now(),file=path.join(directory,'pdt_9472.txt');
 try{fs.writeFileSync(file,new Date(now-25000).toISOString());assert.equal(playbackClock('9472',{now,directory}).time,now-45000);assert.equal(playbackClock('9472',{now:now+1000,directory}).time,now-45000);assert.equal(playbackClock('9472',{now:now+65000,directory}).time,undefined);assert.equal(playbackClock('../bad',{now,directory}).time,undefined);}finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});
test('a fresh, advancing buffered stream remains aligned beyond five minutes',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sxm-clock-')),now=Date.now(),file=path.join(directory,'pdt_9472.txt');
 const write=(segment,mtime)=>{fs.writeFileSync(file,new Date(segment).toISOString());fs.utimesSync(file,mtime/1000,mtime/1000);};
 try{
  write(now-360000,now);
  assert.equal(playbackClock('9472',{now,directory}).time,now-380000);
  write(now-330000,now+30000);
  assert.equal(playbackClock('9472',{now:now+30000,directory}).time,now-350000);
  write(now-270000,now+90000);
  assert.equal(playbackClock('9472',{now:now+90000,directory}).time,now-290000);
 }finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});
test('touching a frozen PDT file cannot keep stale metadata alive',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sxm-clock-')),now=Date.now(),file=path.join(directory,'pdt_9472.txt');
 try{
  fs.writeFileSync(file,new Date(now-360000).toISOString());fs.utimesSync(file,now/1000,now/1000);
  assert.equal(playbackClock('9472',{now,directory}).time,now-380000);
  fs.utimesSync(file,(now+61000)/1000,(now+61000)/1000);
  assert.equal(playbackClock('9472',{now:now+61000,directory}).reason,'Stream timestamp stopped advancing');
  fs.writeFileSync(file,new Date(now-299000).toISOString());fs.utimesSync(file,(now+61000)/1000,(now+61000)/1000);
  assert.equal(playbackClock('9472',{now:now+61000,directory}).time,now-319000);
 }finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});
test('PDT rejects future and out-of-history timestamps even with a fresh file',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sxm-clock-')),now=Date.now(),file=path.join(directory,'pdt_9472.txt');
 try{
  for(const segment of [now+1,now-6*60*60*1000-1]){
   fs.writeFileSync(file,new Date(segment).toISOString());fs.utimesSync(file,now/1000,now/1000);
   assert.equal(playbackClock('9472',{now,directory}).time,undefined);
  }
 }finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});
test('alternating old PDT values cannot pretend that playback is advancing',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sxm-clock-')),now=Date.now(),file=path.join(directory,'pdt_9472.txt');
 const write=(segment,mtime)=>{fs.writeFileSync(file,new Date(segment).toISOString());fs.utimesSync(file,mtime/1000,mtime/1000);};
 try{
  write(now-360000,now);assert.equal(playbackClock('9472',{now,directory}).time,now-380000);
  write(now-370000,now+30000);assert.equal(playbackClock('9472',{now:now+30000,directory}).reason,'Stream timestamp regressed');
  write(now-360000,now+61000);assert.equal(playbackClock('9472',{now:now+61000,directory}).reason,'Stream timestamp stopped advancing');
  write(now-300000,now+62000);assert.equal(playbackClock('9472',{now:now+62000,directory}).time,now-320000);
 }finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});
test('a one-cut feed retains the previous cut until buffered playback reaches the next one',async()=>{
 let now=100000,cut={name:'A',validFrom:new Date(50000).toISOString()};
 const live=new SiriusXmLiveMetadata({clock:()=>now,ttl:1,fetchImpl:async()=>({ok:true,json:async()=>({channels:{id:{cuts:[cut]}}})})});
 assert.equal((await live.get('id',80000)).cut.name,'A');now+=1000;cut={name:'B',validFrom:new Date(100000).toISOString()};
 assert.equal((await live.get('id',85000)).cut.name,'A');assert.equal((await live.get('id',100000)).cut.name,'B');
});
test('overlay rejects regressions, keeps players separate, and falls back when alignment is unknown',async()=>{
 let now=200000,start=150000,title='B',time=180000;
 const service=new SiriusXmMetadata({clock:()=>now,readPlaybackClock:()=>({time})});
 service.getChannelMetadata=async()=>({metadata:{currentTrack:title,currentArtist:'Artist',trackStart:new Date(start).toISOString(),liveMetadataSource:'siriusxm-lookaround'},diagnostics:{}});
 const raw={playerId:'one',state:'playing',nowPlaying:{source:'SiriusXM',url:'sxm:9472',title:'Raw'}};
 assert.equal((await service.overlay(raw)).displayPlaybackState.nowPlaying.title,'B');start=100000;title='A';assert.equal((await service.overlay(raw)).displayPlaybackState.nowPlaying.title,'B');
 assert.equal((await service.overlay({...raw,playerId:'two'})).displayPlaybackState.nowPlaying.title,'A');
 time=undefined;now+=61000;assert.equal((await service.overlay(raw)).displayPlaybackState.nowPlaying.title,'Raw');
 assert.equal(raw.nowPlaying.title,'Raw');
});
