"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync(require.resolve('../public/lyrion.js'),'utf8');
// Execute the actual UI controller functions with a small DOM and deferred
// status requests. No parallel copy of their artwork/response logic lives here.
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to));
const artworkCode=section('  function artworkImage(', '  let artistFavorites=');
const statusCode=section('  let statusRequest=', '  async function loadPlayer()');
const loadPlayerCode=section('  async function loadPlayer()', '  async function refreshPlayers()');
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function image(){return {dataset:{},hidden:true,complete:false,naturalWidth:0,removeAttribute(name){delete this[name];}};}
function artworkHarness(){
 let now=1000;
 const context={Date:{now:()=>now}};vm.runInNewContext(artworkCode,context);
 return {update:context.artworkImage,img:image(),advance:ms=>now+=ms};
}
const art='/api/lyrion/artwork?path=%2Fmusic%2Fcurrent%2Fcover.jpg';

function preparationHarness(){
 const calls=[],messages=[],attributes=new Map();
 const context={AbortController,setTimeout:()=>1,clearTimeout:()=>{},player:'one',busy:false,
  ui:{setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name)},
  message:value=>messages.push(value),fetch:(url,options)=>new Promise((resolve,reject)=>{
   calls.push({url,options,resolve});options.signal.addEventListener('abort',()=>reject(Error('Cancelled old station start')),{once:true});
  })};
 vm.runInNewContext(section('  let stationPreparation=', '  const playerQuery =')+'\nglobalThis.runAction=run;globalThis.stationAction=stationRequest;',context);
 return {context,calls,messages,attributes};
}
test('Pause can cancel station preparation without a late response replacing control status',async()=>{
 const h=preparationHarness(),control=deferred();let starts=0,unrelated=0;
 const start=h.context.runAction(async()=>{await h.context.stationAction('/api/siriusxm/ondemand/xtra/play',{id:'exact-channel'});starts++;})();
 assert.equal(h.messages.at(-1),'Preparing station audio…');assert.equal(h.context.busy,true);
 await h.context.runAction(async()=>unrelated++)({preventDefault(){},currentTarget:{dataset:{}}});assert.equal(unrelated,0);
 const pause=h.context.runAction(()=>control.promise)({preventDefault(){},currentTarget:{dataset:{lyrionControl:'pause'}}});
 await flush();assert.equal(h.calls[0].options.signal.aborted,true);assert.equal(starts,0);
 assert.equal(h.context.busy,true);assert.equal(h.messages.at(-1),'Working…');
 control.resolve();await pause;await start;
 assert.equal(h.context.busy,false);assert.equal(h.attributes.has('aria-busy'),false);assert.equal(h.messages.at(-1),'');
});
test('completed station preparation retains exact identity and clears its pending control gate',async()=>{
 const h=preparationHarness();let starts=0;
 const start=h.context.runAction(async()=>{await h.context.stationAction('/api/siriusxm/ondemand/artist/play',{id:'exact-station'});starts++;})();
 assert.deepEqual(JSON.parse(h.calls[0].options.body),{id:'exact-station',playerId:'one'});
 h.calls[0].resolve({ok:true,json:async()=>({station:{id:'exact-station'}})});await start;
 assert.equal(starts,1);assert.equal(h.context.busy,false);
 const ordinary=deferred(),work=h.context.runAction(()=>ordinary.promise)();let controls=0;
 await h.context.runAction(async()=>controls++)({preventDefault(){},currentTarget:{dataset:{lyrionControl:'pause'}}});assert.equal(controls,0);
 ordinary.resolve();await work;
});

test('a reused local artwork URL reloads for a new radio cut and stays stable on normal polls',()=>{
 const h=artworkHarness();h.update(h.img,art,'track-a');const first=h.img.src;
 h.img.complete=true;h.img.naturalWidth=100;h.img.onload();h.update(h.img,art,'track-a');
 assert.equal(h.img.src,first);assert.equal(h.img.hidden,false);
 h.update(h.img,art,'track-b');assert.notEqual(h.img.src,first);assert.match(h.img.src,/&rh-art=/);assert.equal(h.img.hidden,true);
 h.img.onload();const second=h.img.src;h.update(h.img,art,'track-b');assert.equal(h.img.src,second);
});

test('exact external artwork URLs and favorite icons are never modified',()=>{
 const h=artworkHarness(),url='https://cdn.example.test/exact-cover.jpg?signature=preserve';
 h.update(h.img,url,'track-a');assert.equal(h.img.src,url);
 h.update(h.img,url,'track-b');assert.equal(h.img.src,url);
 h.img.onerror();h.advance(30000);h.update(h.img,url,'track-b');assert.equal(h.img.src,url);
 const favorite=image();h.update(favorite,art);assert.equal(favorite.src,art);
});

test('late artwork callbacks cannot restore an old cut or cleared player artwork',()=>{
 const h=artworkHarness();h.update(h.img,art,'old');const oldLoad=h.img.onload,oldError=h.img.onerror;
 h.update(h.img,art,'new');const currentLoad=h.img.onload;
 oldLoad();assert.equal(h.img.hidden,true);oldError();assert.equal(h.img.dataset.retryAt,undefined);
 currentLoad();assert.equal(h.img.hidden,false);
 h.update(h.img,'');currentLoad();assert.equal(h.img.hidden,true);assert.equal(h.img.src,undefined);
});

test('failed artwork retries use the same track identity and do not run on every poll',()=>{
 const h=artworkHarness();h.update(h.img,art,'track-a');const first=h.img.src;h.img.onerror();
 h.advance(29000);h.update(h.img,art,'track-a');assert.equal(h.img.src,first);
 h.advance(1000);h.update(h.img,art,'track-a');assert.match(h.img.src,/&retry=31000$/);
 assert.equal(h.img.dataset.artworkIdentity,'track-a');
 h.img.onerror();h.update(h.img,art,'track-b');assert.doesNotMatch(h.img.src,/retry=/);
 assert.equal(h.img.dataset.retryAt,undefined);
});
test('failed track artwork shows the channel logo, retries later, and never loops on a broken logo',()=>{
 const h=artworkHarness(),logo='https://example.test/bpm.svg';
 h.update(h.img,art,'bpm-mix',logo);h.img.onerror();assert.equal(h.img.src,logo);
 h.img.complete=true;h.img.naturalWidth=100;h.img.onload();assert.equal(h.img.hidden,false);
 h.advance(29000);h.update(h.img,art,'bpm-mix',logo);assert.equal(h.img.src,logo);assert.equal(h.img.hidden,false);
 h.advance(1000);h.update(h.img,art,'bpm-mix',logo);assert.match(h.img.src,/&retry=/);
 h.img.onerror();assert.equal(h.img.src,logo);h.img.onerror();assert.equal(h.img.src,logo);assert.equal(h.img.hidden,true);
 const oldError=h.img.onerror;h.update(h.img,'https://example.test/chill.svg','chill-mix','https://example.test/chill.svg');oldError();
 assert.equal(h.img.src,'https://example.test/chill.svg');assert.equal(h.img.dataset.retryAt,undefined);
});

function statusHarness(){
 const nodes=new Map(),requests=[],events=[],favorites=deferred();
 const get=id=>{if(!nodes.has(id))nodes.set(id,{...image(),textContent:'',querySelector:()=>null,replaceChildren(...children){this.children=children;}});return nodes.get(id);};
 const context={Date,player:'one',epoch:1,queueOffset:0,history:[],sources:[],
  $:get,stage:{dispatchEvent:event=>events.push(event)},ui:{querySelectorAll:()=>[]},
  CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},
  document:{createElement:()=>({textContent:''}),createTextNode:value=>value},
  api:(route,body,query)=>{const call=deferred();requests.push({...call,route,query});return call.promise;},
  syncArtistFavorites(){},syncXtraFavorites(){},refreshXtraFavorites:async()=>{},refreshFavoriteMetadata:async()=>{},
  refreshArtistFavorites:()=>favorites.promise,renderFavorites(){},playerQuery:()=>'?playerId='+encodeURIComponent(context.player),
  setScrollingLabel:(id,value)=>get(id).textContent=value,
  time:seconds=>String(seconds),run:fn=>fn,home:async()=>{},showTime:value=>value};
 vm.runInNewContext(artworkCode+statusCode+loadPlayerCode,context);
 return {...context,context,get,requests,events,favorites};
}
function state(title,{url='sxm:channel',artwork=art,playerId='one',display=null}={}){
 const s={playerId,playerName:playerId,connected:true,state:'playing',position:10,duration:100,
  nowPlaying:{title,artist:'Artist',artwork,url,source:'SiriusXM'},queue:[],queueCount:1,queueIndex:0};
 if(display)s.displayPlaybackState={...s,nowPlaying:display};return s;
}

test('out-of-order status responses cannot put the previous title and artwork back',async()=>{
 const h=statusHarness(),old=h.context.refreshStatus(),current=h.context.refreshStatus();
 h.requests[1].resolve(state('New'));await current;const newArtwork=h.get('lyrionCover').src;
 h.requests[0].resolve(state('Old'));await old;
 assert.equal(h.get('lyrionTitle').textContent,'New');assert.equal(h.get('lyrionCover').src,newArtwork);
 assert.equal(h.events.filter(e=>e.type==='lyrion-track').length,1);
});

test('display title and both artwork layers advance together while raw playback keeps its exact URL',async()=>{
 const h=statusHarness();
 const display={title:'Aligned new cut',artist:'New artist',artwork:art,url:'sxm:channel',source:'SiriusXM'};
 const refresh=h.context.refreshStatus();h.requests[0].resolve(state('Buffered raw cut',{url:'sxm:exact-playback-id',display}));await refresh;
 assert.equal(h.get('lyrionTitle').textContent,display.title);assert.equal(h.get('lyrionArtist').textContent,display.artist);
 assert.equal(h.get('lyrionCover').src,h.get('lyrionBackdrop').src);
 assert.equal(h.events.find(e=>e.type==='lyrion-track').detail,display);
 assert.equal(h.events.find(e=>e.type==='lyrion-playback').detail.trackUrl,'sxm:exact-playback-id');
 const first=h.get('lyrionCover').src;const next=h.context.refreshStatus();h.requests[1].resolve(state('Next cut'));await next;
 assert.notEqual(h.get('lyrionCover').src,first);assert.equal(h.get('lyrionCover').src,h.get('lyrionBackdrop').src);
});

test('missing artwork on a new track clears both previous artwork layers',async()=>{
 const h=statusHarness();let refresh=h.context.refreshStatus();h.requests[0].resolve(state('First'));await refresh;
 h.get('lyrionCover').onload();h.get('lyrionBackdrop').onload();assert.equal(h.get('lyrionCover').hidden,false);
 refresh=h.context.refreshStatus();h.requests[1].resolve(state('No art',{artwork:''}));await refresh;
 for(const id of ['lyrionCover','lyrionBackdrop']){assert.equal(h.get(id).hidden,true);assert.equal(h.get(id).src,undefined);}
});
test('channel logo fallback applies to both artwork layers and clears when a different source has no artwork',async()=>{
 const h=statusHarness(),logo='https://example.test/bpm.svg';
 const display={title:'Sat Night Remix',artist:'@erinconstantine',url:'sxm:thebeat',source:'SiriusXM',artwork:logo,artworkFallback:logo};
 let refresh=h.context.refreshStatus();h.requests[0].resolve(state('Old cut',{display}));await refresh;
 for(const id of ['lyrionCover','lyrionBackdrop']){assert.equal(h.get(id).src,logo);assert.equal(h.get(id).dataset.artworkFallback,logo);}
 refresh=h.context.refreshStatus();h.requests[1].resolve(state('Song with art',{display:{...display,artwork:'exact-cover.jpg'}}));await refresh;
 for(const id of ['lyrionCover','lyrionBackdrop']){assert.equal(h.get(id).src,'exact-cover.jpg');h.get(id).onerror();assert.equal(h.get(id).src,logo);}
 refresh=h.context.refreshStatus();h.requests[2].resolve(state('No art',{display:{title:'No art',artist:'Artist',source:'SoundCloud',artwork:''}}));await refresh;
 for(const id of ['lyrionCover','lyrionBackdrop']){assert.equal(h.get(id).src,undefined);assert.equal(h.get(id).dataset.artworkFallback,'');}
});

test('changing players immediately rejects pending old-player polls, even while favorites are still loading',async()=>{
 const h=statusHarness();const refresh=h.context.refreshStatus();h.context.player='two';
 const switching=h.context.loadPlayer();assert.equal(h.context.epoch,2);
 h.requests[0].resolve(state('Old player'));await refresh;
 assert.notEqual(h.get('lyrionTitle').textContent,'Old player');assert.equal(h.get('lyrionCover').src,undefined);
 h.favorites.resolve();await flush();
 const sourceRequest=h.requests.find(r=>r.route==='sources');sourceRequest.resolve({sources:[]});
 await flush();
 const newStatus=h.requests.find(r=>r.route==='status'&&r.query.includes('two'));
 newStatus.resolve(state('New player',{playerId:'two'}));await switching;
 assert.equal(h.get('lyrionTitle').textContent,'New player');
});
