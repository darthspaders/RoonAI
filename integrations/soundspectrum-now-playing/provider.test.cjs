'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { createNowPlayingProvider } = require('./provider.cjs');
const { LyrionClient } = require('../../src/lyrionClient.js');
const ZONE = '1601' + 'a'.repeat(28), OTHER = '1601' + 'b'.repeat(28), PLAYER = 'aa:bb:cc:dd:ee:ff';
const core = () => ({ core_id: 'core-one', moo: { transport: { host: '127.0.0.1', port: 9330 } } });
const now = overrides => ({ two_line: { line1: 'Track', line2: 'Artist' }, three_line: { line3: 'Album' }, length: 240, seek_position: 10, image_key: 'cover-one', item_key: 'item-one', ...overrides });
function fixture(t, overrides = {}) {
  let state = { connected: true, zones: [{ zone_id: OTHER, state: 'playing', now_playing: now({ two_line: { line1: 'Wrong track' } }) }, { zone_id: ZONE, state: 'playing', now_playing: now() }] }, paired = core();
  const requests = [];
  const provider = createNowPlayingProvider({ getRoonState: () => state, getRoonCore: () => paired,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(png(), { headers: { 'content-type': 'image/png' } }); }, ...overrides });
  t.after(() => provider.close());
  return { provider, requests, target: { source: 'roon-hqplayer', zoneId: ZONE }, state: value => { state = value; }, paired: value => { paired = value; }, zone: () => state.zones.find(zone => zone.zone_id === ZONE) };
}
function crc(data) {
  let n = 0xffffffff;
  for (const byte of data) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(name, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(name, 4); data.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4); return result;
}
function png(width = 1, height = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND')]);
}
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==', 'base64');
const wrapper = path => '/api/lyrion/artwork?path=' + encodeURIComponent(path);
function lyrion(t, artwork, extra = {}) {
  const requests = [], calls = [];
  let raw = { playerId: PLAYER, connected: true, state: 'playing', position: 10, duration: 100, queueIndex: 3, nowPlaying: { id: 'track-3', title: 'Track', artist: 'Artist', album: 'Album', duration: 100, artwork, url: 'https://private.invalid/signed-audio-secret' } };
  const client = { baseUrl: 'http://127.0.0.1:9000', status: async (...args) => { calls.push(args); return raw; } };
  const provider = createNowPlayingProvider({ lyrionClient: client, fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(png(), { headers: { 'content-type': 'image/png' } }); }, ...extra });
  t.after(() => provider.close());
  return { provider, client, target: { source: 'lyrion', playerId: PLAYER }, calls, requests, raw: value => { raw = value; }, current: () => raw };
}

test('cached exact Roon metadata is private, bounded, and stable across seek/pause/art changes', async t => {
  const f = fixture(t), first = await f.provider.readTrack(f.target);
  assert.equal(first.state, 'playing'); assert.equal(first.track.title, 'Track'); assert.match(first.track.key, /^[a-f0-9]{64}$/); assert.match(first.track.artToken, /^[a-f0-9]{48}$/);
  assert.equal(f.requests.length, 0); assert.deepEqual(Object.keys(first.track).sort(), ['album','artKind','artToken','artist','key','title']);
  f.zone().state = 'paused'; f.zone().now_playing.seek_position = 0; f.zone().now_playing.image_key = 'cover-two';
  const next = await f.provider.readTrack(f.target); assert.equal(next.state, 'paused'); assert.equal(next.track.key, first.track.key); assert.notEqual(next.track.artToken, first.track.artToken);
  f.zone().now_playing.two_line.line1 = 'Next Track'; assert.notEqual((await f.provider.readTrack(f.target)).track.key, first.track.key);
});
test('missing/stopped/disconnected targets do not fall back to a different playing Roon zone', async t => {
  const f = fixture(t);
  for (const target of [{ source:'roon-hqplayer',zoneId:'bad' }, { ...f.target,playerId:PLAYER }, { source:'guess',zoneId:ZONE }]) assert.deepEqual(await f.provider.readTrack(target), { state:'unavailable',track:null });
  f.state({ connected:true,zones:[{ zone_id:OTHER,state:'playing',now_playing:now() }] }); assert.equal((await f.provider.readTrack(f.target)).state, 'unavailable');
  f.state({ connected:false,zones:[{ zone_id:ZONE,state:'playing',now_playing:now() }] }); assert.equal((await f.provider.readTrack(f.target)).state, 'unavailable');
  for (const zone of [{zone_id:ZONE,state:'stopped',now_playing:now()}, {zone_id:ZONE,state:'playing',now_playing:null}]) { f.state({connected:true,zones:[zone]}); assert.deepEqual(await f.provider.readTrack(f.target), {state:'waiting',track:null}); }
});
test('text remains literal and sanitized without returning private queue or media fields', async t => {
  const f = fixture(t); f.zone().now_playing = now({ two_line:{ line1:' <script>\u0000Title\n'.repeat(100),line2:' Artist\t Name ' }, source_url:'secret',queue:{secret:true} });
  const result = await f.provider.readTrack(f.target); assert.equal(result.track.title.length,512); assert.equal(result.track.artist,'Artist Name'); assert.doesNotMatch(JSON.stringify(result), /secret|source_url|queue|\\u0000/); assert.ok(result.track.title.startsWith('<script>'));
});
test('Roon art uses only the current paired core and internal token, with redirect refusal', async t => {
  const f = fixture(t); f.zone().now_playing.image_key='opaque /?# key';
  const {track} = await f.provider.readTrack(f.target), image=await f.provider.readArt(track);
  assert.deepEqual({width:image.width,height:image.height,extension:image.extension},{width:1,height:1,extension:'png'});
  const request=f.requests[0]; assert.equal(new URL(request.url).origin,'http://127.0.0.1:9330'); assert.equal(new URL(request.url).pathname,'/api/image/opaque%20%2F%3F%23%20key'); assert.equal(request.options.redirect,'error'); assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(await f.provider.readArt({...track,key:'forged',url:'http://evil.invalid'}),null); assert.equal(await f.provider.readArt({...track,artToken:'forged'}),null);
  f.paired({...core(),core_id:'another-core'}); assert.equal(await f.provider.readArt(track),null); assert.equal(f.requests.length,1);
});
test('unsafe paired-core origins produce metadata without artwork', async t => {
  const f=fixture(t);
  for(const host of ['user@private','127.0.0.1/path','127.0.0.1\\evil','127.0.0.1?secret','127.0.0.1\n']) { f.paired({moo:{transport:{host,port:9330}}}); const {track}=await f.provider.readTrack(f.target); assert.equal(track.artKind,'none'); assert.equal(await f.provider.readArt(track),null); }
  assert.equal(f.requests.length,0);
});
test('Roon image fallback is limited to the paired core ports under one deadline', async t => {
  const calls=[];const f=fixture(t,{fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?new Response('',{status:404}):new Response(png(),{headers:{'content-type':'image/png'}});}});
  f.paired({...core(),registration:{http_port:9331}});const {track}=await f.provider.readTrack(f.target);assert.ok(await f.provider.readArt(track));
  assert.deepEqual(calls.map(call=>new URL(call.url).origin),['http://127.0.0.1:9330','http://127.0.0.1:9331']);assert.equal(calls[0].options.signal,calls[1].options.signal);assert.ok(calls.every(call=>call.options.redirect==='error'));
});
test('a paired-core identity or origin change during artwork download rejects the previous source image', async t => {
  for (const changed of [{...core(),core_id:'another-core'}, { ...core(),moo:{transport:{host:'127.0.0.1',port:9331}} }]) {
    let resolveFetch;
    const f=fixture(t,{fetchImpl:()=>new Promise(resolve=>{resolveFetch=resolve;})}),{track}=await f.provider.readTrack(f.target),pending=f.provider.readArt(track);
    while(!resolveFetch)await new Promise(resolve=>setImmediate(resolve));f.paired(changed);resolveFetch(new Response(png(),{headers:{'content-type':'image/png'}}));
    assert.equal(await pending,null);
  }
});
test('raster validation accepts PNG/JPEG headers and rejects bad magic, size, dimensions or content type', async t => {
  let data=png(),type='image/png',headers={};
  const f=fixture(t,{fetchImpl:async()=>new Response(data,{headers:{'content-type':type,...headers}})}),{track}=await f.provider.readTrack(f.target);
  assert.equal((await f.provider.readArt(track)).extension,'png'); data=JPEG; type='image/jpeg'; assert.equal((await f.provider.readArt(track)).extension,'jpg');
  const invalid=[ [Buffer.from('<svg></svg>'),'image/png'],[JPEG,'image/png'],[png(4097,1),'image/png'],[png(1,0),'image/png'],[png().subarray(0,-1),'image/png'],[JPEG.subarray(0,-2),'image/jpeg'],[png(),'image/svg+xml'],[Buffer.alloc(2*1024*1024+1),'image/png'] ];
  for([data,type] of invalid) assert.equal(await f.provider.readArt(track),null);
  data=png();type='image/png';headers={'content-length':String(2*1024*1024+1)};assert.equal(await f.provider.readArt(track),null);
});
test('redirect/error responses never turn into a second image fetch', async t => {
  let calls=0;const f=fixture(t,{fetchImpl:async(_,options)=>{calls++;assert.equal(options.redirect,'error');return new Response('',{status:302,headers:{location:'http://private.invalid','content-type':'image/png'}});}});
  assert.equal(await f.provider.readArt((await f.provider.readTrack(f.target)).track),null);assert.equal(calls,1);
});
test('art descriptors evict after sixteen entries and close revokes every token', async t => {
  const f=fixture(t),first=(await f.provider.readTrack(f.target)).track;
  for(let n=0;n<16;n++){f.zone().now_playing.image_key='cover-'+n;await f.provider.readTrack(f.target);}
  assert.equal(await f.provider.readArt(first),null);assert.equal(f.requests.length,0);
  const last=(await f.provider.readTrack(f.target)).track;f.provider.close();assert.equal(await f.provider.readArt(last),null);assert.deepEqual(await f.provider.readTrack(f.target),{state:'unavailable',track:null});
});
test('Lyrion reads only the exact player and raw status with cancellation, not enrichment', async t => {
  const f=lyrion(t,wrapper('/music/cover-one/cover.jpg')),first=await f.provider.readTrack(f.target);
  assert.equal(first.state,'playing');assert.equal(first.track.artKind,'album');assert.doesNotMatch(JSON.stringify(first),/private|signed|position|url/);
  assert.deepEqual(f.calls[0].slice(0,3),[PLAYER,0,1]);assert.equal(f.calls[0][3].timeoutMs,3000);assert.equal(f.calls[0][3].redirect,'error');assert.ok(f.calls[0][3].signal instanceof AbortSignal);
  f.current().position=0;f.current().state='paused';f.current().nowPlaying.artwork=wrapper('/music/cover-two/cover.jpg');
  assert.equal((await f.provider.readTrack(f.target)).track.key,first.track.key);
  f.current().queueIndex++;assert.notEqual((await f.provider.readTrack(f.target)).track.key,first.track.key);
  f.current().playerId='00:00:00:00:00:00';assert.equal((await f.provider.readTrack(f.target)).state,'unavailable');
});
test('LMS music and approved CDN proxy art is fetched solely from the configured LMS origin', async t => {
  const urls=['/music/cover-one/cover.jpg', '/imageproxy/'+encodeURIComponent('https://resources.tidal.com/images/01234567/89ab/cdef/0123/456789abcdef/320x320.jpg')+'/image.png', '/imageproxy/'+encodeURIComponent('http://pri.art.prod.streaming.siriusxm.com/images/chan/logo.png')+'/image.png', '/imageproxy/'+encodeURIComponent('https://i1.sndcdn.com/artworks-abcd-t500x500.jpg')+'/image.png'];
  for(const path of urls){const f=lyrion(t,wrapper(path)),{track}=await f.provider.readTrack(f.target);assert.ok(track.artToken);assert.ok(await f.provider.readArt(track));assert.equal(new URL(f.requests[0].url).origin,f.client.baseUrl);assert.equal(new URL(f.requests[0].url).pathname,path);f.client.baseUrl='http://127.0.0.1:9001';assert.equal(await f.provider.readArt(track),null);}
});
test('a configured LMS origin change during artwork download rejects the previous source image', async t => {
  let resolveFetch;
  const f=lyrion(t,wrapper('/music/cover-one/cover.jpg'),{fetchImpl:()=>new Promise(resolve=>{resolveFetch=resolve;})}),{track}=await f.provider.readTrack(f.target),pending=f.provider.readArt(track);
  while(!resolveFetch)await new Promise(resolve=>setImmediate(resolve));f.client.baseUrl='http://127.0.0.1:9001';resolveFetch(new Response(png(),{headers:{'content-type':'image/png'}}));
  assert.equal(await pending,null);
});
test('untrusted artwork URLs, path expansion, proxy nesting and remote endpoints cannot be fetched', async t => {
  const proxy=value=>wrapper('/imageproxy/'+encodeURIComponent(value)+'/image.png');
  const values=['http://private.invalid/art.jpg','//evil.invalid/music/id/cover.jpg',wrapper('/music/abc/../id/cover.jpg'),wrapper('/music/%2e%2e/id/cover.jpg'),wrapper('/music/id/cover.jpg?url=evil'),wrapper('/plugins/unknown/image.jpg'),proxy('http://127.0.0.1/private'),proxy('http://169.254.169.254/latest/meta-data'),proxy('https://resources.tidal.com.evil.invalid/images/cover.jpg'),proxy('https://user:pass@i1.sndcdn.com/artworks-abcd-large.jpg'),proxy('https://i1.sndcdn.com:8443/artworks-abcd-large.jpg'),proxy('https://i1.sndcdn.com/redirect?url=http://private'),proxy('https://i1.sndcdn.com/imageproxy/http%3A%2F%2Fprivate/image.png')];
  for(const value of values){const f=lyrion(t,value),{track}=await f.provider.readTrack(f.target);assert.equal(track.artKind,'none',value);assert.equal(await f.provider.readArt(track),null);assert.equal(f.requests.length,0);}
});
test('raw SiriusXM art is honestly classified as station branding', async t => {
  const f=lyrion(t,wrapper('/music/known/cover.jpg'));f.current().nowPlaying.source='SiriusXM';assert.equal((await f.provider.readTrack(f.target)).track.artKind,'channel');
});
test('transient status failures yield waiting, while explicit disconnect or wrong target remains unavailable', async t => {
  const roon=fixture(t,{getRoonState:()=>{throw Error('temporary cached read');}});assert.deepEqual(await roon.provider.readTrack(roon.target),{state:'waiting',track:null});
  const f=lyrion(t,'',{lyrionClient:{baseUrl:'http://127.0.0.1:9000',status:async()=>{throw Error('temporary LMS failure');}}});assert.deepEqual(await f.provider.readTrack(f.target),{state:'waiting',track:null});
  const invalid=lyrion(t,'');invalid.current().connected=false;assert.deepEqual(await invalid.provider.readTrack(invalid.target),{state:'unavailable',track:null});
  assert.deepEqual(await f.provider.readTrack({...f.target,playerId:'wrong'}),{state:'unavailable',track:null});
});
test('abort and close cancel in-flight art without publishing a late image', async t => {
  let observed,ready;const started=new Promise(resolve=>{ready=resolve;});
  const f=fixture(t,{fetchImpl:(_,options)=>new Promise((_,reject)=>{observed=options.signal;options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});ready();})});
  const {track}=await f.provider.readTrack(f.target),cancel=new AbortController(),work=f.provider.readArt(track,{signal:cancel.signal});await started;cancel.abort();await assert.rejects(work,{name:'AbortError'});assert.equal(observed.aborted,true);
  let resolveFetch;const g=fixture(t,{fetchImpl:()=>new Promise(resolve=>{resolveFetch=resolve;})}),next=(await g.provider.readTrack(g.target)).track,pending=g.provider.readArt(next);
  while(!resolveFetch)await new Promise(resolve=>setImmediate(resolve));g.provider.close();assert.equal(await pending,null);resolveFetch(new Response(png(),{headers:{'content-type':'image/png'}}));
});
test('a metadata deadline aborts the Lyrion request after three seconds', async t => {
  let observed;const f=lyrion(t,'',{lyrionClient:{baseUrl:'http://127.0.0.1:9000',status:(_,__,___,options)=>new Promise((_,reject)=>{observed=options.signal;observed.addEventListener('abort',()=>reject(observed.reason),{once:true});})}});
  const started=performance.now();assert.deepEqual(await f.provider.readTrack(f.target),{state:'waiting',track:null});assert.equal(observed.aborted,true);assert.ok(performance.now()-started<3500);
});
test('art fetch concurrency is bounded, and cancellation releases only completed work', async t => {
  const pending=[];const f=fixture(t,{fetchImpl:()=>new Promise(resolve=>pending.push(resolve))}),{track}=await f.provider.readTrack(f.target);
  const a=f.provider.readArt(track),b=f.provider.readArt(track);while(pending.length<2)await new Promise(resolve=>setImmediate(resolve));assert.equal(await f.provider.readArt(track),null);assert.equal(pending.length,2);
  for(const resolve of pending)resolve(new Response(png(),{headers:{'content-type':'image/png'}}));assert.ok(await a);assert.ok(await b);
});
test('Lyrion client preserves default requests and forwards real cancellation through both status reads', async () => {
  const requests=[];let count=0;
  const client=new LyrionClient({fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({result:++count===1?{mode:'play',player_connected:1,playlist_tracks:2,playlist_cur_index:3,playlist_loop:[]}:{playlist_loop:[{title:'Current','playlist index':3}]}}),{headers:{'content-type':'application/json'}});}});
  const cancel=new AbortController();const result=await client.status(PLAYER,0,1,{signal:cancel.signal,timeoutMs:50,redirect:'error'});assert.equal(result.nowPlaying.title,'Current');assert.equal(requests.length,2);assert.deepEqual(requests.map(({options})=>JSON.parse(options.body).params[1].slice(0,3)),[['status',0,1],['status','-',1]]);assert.ok(requests.every(({options})=>options.redirect==='error'));
  requests.length=0;await client.rpc('', ['serverstatus',0,999]);assert.equal(requests[0].options.redirect,undefined);
  cancel.abort();await assert.rejects(client.status(PLAYER,0,1,{signal:cancel.signal}),{name:'AbortError'});assert.equal(requests.length,1);
});
test('Lyrion request timeout and caller abort cancel the actual fetch signal', async () => {
  const signals=[];const client=new LyrionClient({fetchImpl:(_,options)=>new Promise((_,reject)=>{signals.push(options.signal);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});})});
  // A referenced turn lets the client's unref timer run in this isolated test.
  const alive=setTimeout(()=>{},100);try{await assert.rejects(client.rpc(PLAYER,['status',0,1],{timeoutMs:10}),{name:'TimeoutError'});}finally{clearTimeout(alive);}assert.equal(signals[0].aborted,true);
  const cancel=new AbortController(),work=client.status(PLAYER,0,1,{signal:cancel.signal});cancel.abort();await assert.rejects(work,{name:'AbortError'});assert.equal(signals[1].aborted,true);
});

const bridgeConfig = { enabled: true, cacheUrl: 'http://127.0.0.1:8787/api/art/cache' };
const bridgeCover = 'https://art.example.test/art/' + 'a'.repeat(40) + '.jpg?v=123';
function radioNow(f) {
  Object.assign(f.zone().now_playing, { length: 0,
    radio_lookup: { artist: 'Radio Artist', title: 'Song (Original Mix)' },
    radio_enrichment: { radioTrackKey: 'radio artist|song original mix', radioArtworkResolved: true, imageUrl: bridgeCover } });
}
test('radio bridge uses exact current song and fetches only the configured local cache object', async t => {
  const f=fixture(t,{artBridge:bridgeConfig}); radioNow(f);
  const first=(await f.provider.readTrack(f.target)).track;
  assert.equal(first.title,'Song (Original Mix)'); assert.equal(first.artKind,'album');
  assert.ok(await f.provider.readArt(first));
  assert.equal(f.requests[0].url,'http://127.0.0.1:8787/art/'+'a'.repeat(40)+'.jpg?v=123');
  assert.equal(f.requests[0].options.redirect,'error');
  assert.equal(f.requests[0].options.headers.Authorization,undefined);
  f.zone().now_playing.radio_lookup.title='Next Song';
  const next=(await f.provider.readTrack(f.target)).track;
  assert.notEqual(next.key,first.key); assert.equal(next.artKind,'channel');
  assert.equal(await f.provider.readArt(first),null); assert.equal(f.requests.length,1);
});
test('late radio album art replaces station art on the same song without changing its key', async t=>{
  const f=fixture(t,{artBridge:bridgeConfig}); radioNow(f);
  const radio=f.zone().now_playing.radio_enrichment; delete f.zone().now_playing.radio_enrichment;
  const station=(await f.provider.readTrack(f.target)).track; assert.equal(station.artKind,'channel');
  f.zone().now_playing.radio_enrichment=radio;
  const album=(await f.provider.readTrack(f.target)).track;
  assert.equal(album.key,station.key); assert.notEqual(album.artToken,station.artToken);
  assert.equal(album.artKind,'album');
});
test('matching display metadata wins; stale or different mix metadata never replaces radio art',async t=>{
  const f=fixture(t,{artBridge:bridgeConfig}); radioNow(f);
  const n=f.zone().now_playing;
  n.metadata_enrichment={status:'found',inputArtist:n.radio_lookup.artist,inputTitle:n.radio_lookup.title,imageUrl:bridgeCover.replace('a'.repeat(40),'b'.repeat(40))};
  await f.provider.readArt((await f.provider.readTrack(f.target)).track);
  assert.match(f.requests.at(-1).url,/b{40}/);
  n.metadata_enrichment.inputTitle='Song (Other Remix)';
  await f.provider.readArt((await f.provider.readTrack(f.target)).track);
  assert.match(f.requests.at(-1).url,/a{40}/);
  n.radio_enrichment.radioArtworkResolved=false;
  assert.equal((await f.provider.readTrack(f.target)).track.artKind,'channel');
  n.radio_lookup.catalogEnrichmentAllowed=false;
  n.metadata_enrichment.inputTitle=n.radio_lookup.title;
  assert.equal((await f.provider.readTrack(f.target)).track.artKind,'channel');
});
test('bridge URL parsing refuses arbitrary paths, source queries and malformed IDs',async t=>{
  const f=fixture(t,{artBridge:bridgeConfig});radioNow(f);
  for(const url of ['http://private.invalid/private','http://127.0.0.1:8787/api/art/cache?url=x',bridgeCover+'&url=x',bridgeCover+'#fragment',bridgeCover.replace('https://','https://user:pass@'),bridgeCover.replace('a'.repeat(40),'short')]) {
    f.zone().now_playing.radio_enrichment.imageUrl=url;
    assert.equal((await f.provider.readTrack(f.target)).track.artKind,'channel',url);
  }
  assert.equal(f.requests.length,0);
});
test('a radio track change during art download discards the previous song image',async t=>{
  let finish;
  const f=fixture(t,{artBridge:bridgeConfig,fetchImpl:()=>new Promise(resolve=>{finish=resolve;})});radioNow(f);
  const first=(await f.provider.readTrack(f.target)).track,pending=f.provider.readArt(first);
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  f.zone().now_playing.radio_lookup.title='Next Song';
  finish(new Response(png(),{headers:{'content-type':'image/png'}}));
  assert.equal(await pending,null);
});
test('bridge is opt-in and normal Roon albums retain native artwork',async t=>{
  const f=fixture(t);radioNow(f);
  assert.equal((await f.provider.readTrack(f.target)).track.title,'Track');
  const ordinary=fixture(t,{artBridge:bridgeConfig});
  ordinary.zone().now_playing.metadata_enrichment={status:'found',inputArtist:'Artist',inputTitle:'Track',imageUrl:bridgeCover};
  await ordinary.provider.readArt((await ordinary.provider.readTrack(ordinary.target)).track);
  assert.match(ordinary.requests[0].url,/9330\/api\/image/);
});
