const test=require('node:test'),assert=require('node:assert/strict');
const {highestVariant,highestStream}=require('../src/siriusxmQuality');
const base='https://feed.streaming.siriusxm.com/master.m3u8';
test('selects highest actual audio quality regardless of manifest ordering',()=>{
 const text='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128100,AVERAGE-BANDWIDTH=128000\n128.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=64100\n64.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=256100,AVERAGE-BANDWIDTH=256000\n256.m3u8\n';
 assert.deepEqual(highestVariant(text,base),{url:'https://feed.streaming.siriusxm.com/256.m3u8',bitrate:256000,bandwidth:256100});
 assert.equal(highestVariant(text.replace(/#EXT-X-STREAM-INF:BANDWIDTH=256100[^]*$/,''),base).bitrate,128000);
 assert.equal(highestVariant('#EXTM3U\n#EXTINF:6\nseg.ts',base).url,base);
 assert.throws(()=>highestVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=999999\nhttp://localhost/file',base));
 assert.throws(()=>highestVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=999999,RESOLUTION=1280x720\nvideo.m3u8',base));
});
test('quality lookup fails explicitly instead of silently downgrading',async()=>{
 await assert.rejects(highestStream(base,{fetch:async()=>new Response('',{status:403})}),/403/);
 await assert.rejects(highestStream(base,{fetch:async()=>new Response('not a manifest')}),/manifest/);
});
