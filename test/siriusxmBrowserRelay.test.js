const test=require('node:test'),assert=require('node:assert/strict');
const {SiriusXmBrowserRelay}=require('../src/siriusxmBrowserRelay');
const {SiriusXmMetadata}=require('../src/siriusxmMetadata');
const {readSiriusXmPage}=require('../integrations/siriusxm-browser-helper/reader');
const url='https://www.siriusxm.com/player/channel-linear/diplo-s-revolution/4ebc3011-0ebe-a9ad-c58b-9a306f60fc2b';
test('reads observed semantic selectors only on linear channel pages',()=>{
 const fields={'entity-header-on-now-title':'@walkerandroyce - #RulesDontApply','entity-header-on-now-show':"Diplo's Revolution",'entity-header-subtitle':'Ch 53 • Diplo, Chris Lake, FISHER & more'};
 const doc={querySelector:s=>({innerText:fields[s.match(/"(.*?)"/)[1]]})};
 assert.deepEqual(readSiriusXmPage(doc,url,1000),{url,channelNumber:53,label:fields['entity-header-on-now-title'],show:fields['entity-header-on-now-show'],observedAt:1000});
 assert.equal(readSiriusXmPage(doc,'https://www.siriusxm.com/player/home'),null);
 delete fields['entity-header-on-now-title'];assert.equal(readSiriusXmPage(doc,url),null);
});
test('pairing, source validation, expiry and channel isolation',()=>{
 let now=1000;const relay=new SiriusXmBrowserRelay({file:null,clock:()=>now});
 assert.equal(relay.authorized('Bearer '+relay.key),true);assert.equal(relay.authorized('Bearer wrong'),false);
 relay.ingest({url,channelNumber:53,label:'Live mix',observedAt:now});assert.equal(relay.get(53).label,'Live mix');assert.equal(relay.get(52),null);
 assert.throws(()=>relay.ingest({url:'https://example.com',channelNumber:53,label:'bad',observedAt:now}));
 assert.throws(()=>relay.ingest({url,channelNumber:53,label:'stale',observedAt:now-100000}));
 assert.ok(!JSON.stringify(relay.status()).includes(relay.key));now+=90000;assert.equal(relay.get(53),null);
});
test('browser title stays channel-scoped display evidence and cannot overwrite unaligned playback metadata',async()=>{
 let now=1000;const relay=new SiriusXmBrowserRelay({file:null,clock:()=>now});
 const service=new SiriusXmMetadata({clock:()=>now,readPlaybackClock:()=>({time:null,reason:'No aligned stream timestamp'})});service.browserRelay=relay;
 service.getPublicChannelMetadata=async()=>({metadata:{channelNumber:53,channelName:"Diplo's Revolution",currentShow:'Scheduled show'},diagnostics:{}});
 relay.ingest({url,channelNumber:53,label:'@walkerandroyce - #RulesDontApply',observedAt:now});
 const raw={nowPlaying:{source:'SiriusXM',url:'sxm:9472',title:'Old title',artist:'Old artist'},queue:[{id:'exact'}]};
 const result=await service.overlay(raw);assert.equal(result.displayPlaybackState.nowPlaying.title,'Old title');assert.equal(raw.nowPlaying.title,'Old title');assert.equal(result.queue,raw.queue);assert.equal(result.siriusxmMetadata.currentShow,'Scheduled show');assert.equal(result.siriusxmMetadata.liveNowTitle,'@walkerandroyce - #RulesDontApply');
 assert.equal((await service.getChannelMetadata(52)).metadata.liveNowTitle,undefined);
 now+=90000;assert.equal((await service.overlay(raw)).displayPlaybackState.nowPlaying.title,'Old title');
 const other={nowPlaying:{source:'SoundCloud',title:'Unchanged'}};assert.equal((await service.overlay(other)).displayPlaybackState,other);
});
