const {test}=require('node:test');const assert=require('node:assert/strict');
const {LyrionCatalogue,matchesRadioTrack}=require('../src/lyrionCatalogue');
const {createLyrionApi}=require('../src/lyrionApi');
const wanted={title:'RoTATe (David Guetta Remix)',artist:'Major Lazer/America Foster/Skillibeng/Beam',source:'SiriusXM'};
const result={id:'557887785',title:'RoTATe wiTh aMeRiCa FOsTeR, sKiLLiBeNg aNd bEAM',version:'David Guetta Remix',artist:'Major Lazer, Diplo, David Guetta, Skillibeng, BEAM, America Foster',isrc:'USZ4V2600489',imageUrl:'https://resources.tidal.com/correct.jpg'};
test('credited title suffix and alternate credits match but different remixes never do',()=>{
 assert.equal(matchesRadioTrack(wanted,result),true);
 for(const version of ['', 'Patrick Topping Remix','David Guetta Extended Remix'])assert.equal(matchesRadioTrack(wanted,{...result,version}),false);
 assert.equal(matchesRadioTrack(wanted,{...result,artist:'Someone Else'}),false);
 assert.equal(matchesRadioTrack(wanted,{...result,title:'RoTATe with Uncredited Person'}),false);
 assert.equal(matchesRadioTrack({title:'Dancing With Myself',artist:'Artist'},{title:'Dancing',artist:'Artist'}),false);
});
test('resolver coalesces search, verifies detail and shares exact identity/art without changing raw playback',async()=>{
 let now=0,searches=0;
 const c=new LyrionCatalogue({clock:()=>now,tidal:{isConfigured:()=>true,searchTracks:async()=>{searches++;return [result];},getTrack:async id=>{assert.equal(id,result.id);return result;}}});
 const state={playerId:'one',state:'playing',nowPlaying:{...wanted,artwork:'old.jpg',artworkFallback:'channel.svg'},queue:[1]};
 assert.equal(c.enrich(state),state);assert.equal(searches,0);
 await Promise.all([c.lookup(wanted),c.lookup(wanted)]);assert.equal(searches,1);
 const out=c.enrich(state);assert.equal(out.displayPlaybackState.nowPlaying.artwork,result.imageUrl);assert.equal(out.displayPlaybackState.nowPlaying.artworkFallback,'channel.svg');assert.equal(out.displayPlaybackState.nowPlaying.catalogue.tidal.id,result.id);assert.equal(state.nowPlaying.artwork,'old.jpg');assert.equal(out.displayPlaybackState.nowPlaying.title,wanted.title);
 assert.equal(c.enrich({...state,nowPlaying:{...wanted,title:'Another'}}).displayPlaybackState,undefined);
 now=6000;c.enrich({...state,nowPlaying:{...wanted,title:'Another'}});await c.lookup({...wanted,title:'Another'});assert.equal(searches>1,true);
});
test('conflicting recordings and changed detail identities are rejected',async()=>{
 const c=new LyrionCatalogue({tidal:{isConfigured:()=>true,searchTracks:async()=>[result,{...result,id:'other',isrc:'OTHER'}],getTrack:async()=>{throw Error('must not select ambiguous recording');}}});
 assert.equal(await c.lookup(wanted),null);
 const d=new LyrionCatalogue({tidal:{isConfigured:()=>true,searchTracks:async()=>[result],getTrack:async()=>({...result,version:'Other Remix'})}});
 assert.equal(await d.lookup(wanted),null);
});
test('presence and UI consume the same display enrichment, leaving raw state intact',async()=>{
 const raw={playerId:'p',state:'playing',nowPlaying:{...wanted,artwork:'raw.jpg'}};
 const api=createLyrionApi({file:__filename+'.none',favoritesFile:__filename+'.none',roon:{getState:()=>({zones:[]})},
  client:{players:async()=>[{id:'p',playing:true,connected:true}],status:async()=>raw},
  catalogue:{enrich:s=>({...s,displayPlaybackState:{...raw,nowPlaying:{...wanted,artwork:'verified.jpg'}}})},
  sendJson:(res,status,body)=>body,readJson:async()=>({})});
 api.siriusxm.overlay=async s=>({...s,displayPlaybackState:s});
 const presence=await api.presence();
 const ui=await api.handle({method:'GET'},{},new URL('http://localhost/api/lyrion/status?playerId=p'));
 assert.equal(presence.lyrion.nowPlaying.artwork,'verified.jpg');assert.deepEqual(presence.lyrion.nowPlaying,ui.displayPlaybackState.nowPlaying);assert.equal(raw.nowPlaying.artwork,'raw.jpg');
});
