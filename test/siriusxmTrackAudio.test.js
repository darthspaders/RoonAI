"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const fs=require("node:fs/promises"), path=require("node:path"), os=require("node:os"), http=require("node:http");
const {EventEmitter}=require("node:events");
const {PassThrough}=require("node:stream");
const {spawnSync}=require("node:child_process");
const {SiriusXmTrackAudio,flacDuration,byteRange}=require("../src/siriusxmTrackAudio");
const executable=process.env.FFMPEG_PATH||"ffmpeg", key="a".repeat(64), other="b".repeat(64);
function header(seconds,rate=44100) {
  const result=Buffer.alloc(42);result.write("fLaC");result[4]=128;result.writeUIntBE(34,5,3);
  result.writeBigUInt64BE((BigInt(rate)<<44n)|(1n<<41n)|(23n<<36n)|BigInt(Math.round(seconds*rate)),18);return result;
}
async function directory(t) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sxm-audio-test-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir; }
async function server(t,handler) {
  const s=http.createServer(handler);await new Promise(resolve=>s.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();}));return "http://127.0.0.1:"+s.address().port;
}
test("only finalized FLAC durations are accepted; single byte ranges stay within the exact completed file",()=>{
  assert.equal(flacDuration(header(123)).duration,123);assert.equal(flacDuration(header(123)).sampleRate,44100);
  assert.throws(()=>flacDuration(header(0)),/finalize/);assert.throws(()=>flacDuration(Buffer.from("garbage")),/Invalid/);
  assert.deepEqual(byteRange("bytes=10-",100),{start:10,end:99});assert.deepEqual(byteRange("bytes=-7",100),{start:93,end:99});
  assert.deepEqual(byteRange("bytes=0-999",100),{start:0,end:99});for(const value of ["bytes=100-","bytes=50-10","bytes=-0","bytes=0-1,3-4","bytes=a-b"])assert.equal(byteRange(value,100),false);
});
test("zero-exit shortened output is retried before publication; repeated incomplete audio never becomes playable",async t=>{
  const dir=await directory(t),diagnostics=[];let calls=0;
  const cache=new SiriusXmTrackAudio({directory:dir,onDiagnostic:x=>diagnostics.push(x)});
  cache.decode=async(input,file)=>{calls++;await fs.writeFile(file,header(calls===1?10:123));};
  const entry=await cache.get(key,{input:"opaque",duration:123});assert.equal(calls,2);assert.equal(entry.duration,123);assert.equal(diagnostics[0].decodedSeconds,10);
  assert.equal(diagnostics[0].kind,"retry");assert.equal(diagnostics[1].kind,"ready");
  cache.decode=async(input,file)=>fs.writeFile(file,header(10));await assert.rejects(cache.get(other,{input:"opaque",duration:123}),/incomplete/);
  assert.equal((await fs.readdir(dir)).some(name=>name.startsWith(other)),false);
});
test("LMS probes and simultaneous reconnects share one decode, with stable complete bytes and ranges",async t=>{
  const dir=await directory(t),data=Buffer.concat([header(123),Buffer.alloc(2000,19)]);let calls=0;
  const cache=new SiriusXmTrackAudio({directory:dir});cache.decode=async(input,file)=>{calls++;await new Promise(r=>setTimeout(r,20));await fs.writeFile(file,data);};
  const url=await server(t,(req,res)=>cache.serve(req,res,key,{input:"opaque",duration:123}).catch(()=>{res.writeHead(502);res.end();}));
  const [probe,full,range]=await Promise.all([fetch(url,{method:"HEAD"}),fetch(url),fetch(url,{headers:{Range:"bytes=42-77"}})]);
  assert.equal(calls,1);assert.equal(probe.headers.get("content-length"),String(data.length));assert.equal(probe.headers.get("accept-ranges"),"bytes");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),data);assert.equal(range.status,206);assert.equal(range.headers.get("content-range"),`bytes 42-77/${data.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),data.subarray(42,78));
  const invalid=await fetch(url,{headers:{Range:"bytes=999999-"}});assert.equal(invalid.status,416);assert.equal(invalid.headers.get("content-range"),"bytes */"+data.length);
});
test("completed cache survives a service instance replacement and is bounded by completed size",async t=>{
  const dir=await directory(t),cache=new SiriusXmTrackAudio({directory:dir,maxBytes:60});let calls=0;
  cache.decode=async(input,file)=>{calls++;await fs.writeFile(file,header(123));};await cache.get(key,{input:"opaque",duration:123});
  const restored=new SiriusXmTrackAudio({directory:dir,maxBytes:60});restored.decode=cache.decode;
  assert.equal((await restored.get(key,{input:"opaque",duration:123})).duration,123);assert.equal(calls,1);
  await restored.get(other,{input:"opaque",duration:123});assert.equal(restored.entries.size,1);assert.equal((await fs.readdir(dir)).length,1);
});
test("waiting decoders retain their reserved slots under racing new arrivals",async t=>{
  const cache=new SiriusXmTrackAudio({directory:await directory(t),concurrency:2,maxFiles:20});let active=0,peak=0;
  cache.decode=async(input,file)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));await fs.writeFile(file,header(123));active--;};
  const requests=[];for(let n=1;n<=12;n++)requests.push(cache.get(n.toString(16).padStart(64,"0"),{input:"opaque",duration:123}));
  await Promise.all(requests);assert.equal(peak,2);assert.equal(cache.busy,0);assert.equal(cache.waiters.length,0);
});
test("busy cache never evicts a track being read or exceeds its completed disk bound",async t=>{
  const cache=new SiriusXmTrackAudio({directory:await directory(t),maxBytes:60});cache.decode=async(input,file)=>fs.writeFile(file,header(123));
  await cache.get(key,{input:"opaque",duration:123});cache.entries.get(key).readers++;
  await assert.rejects(cache.get(other,{input:"opaque",duration:123}),/cache limit/);
  assert.equal(cache.entries.size,1);assert.equal((await fs.readdir(cache.directory)).length,1);assert.equal((await cache.get(key,{input:"opaque",duration:123})).duration,123);
});
test("cache publication cannot evict a file between paused validation and reader acquisition",async t=>{
  const cache=new SiriusXmTrackAudio({directory:await directory(t),maxFiles:1}),data=Buffer.concat([header(123),Buffer.alloc(100,5)]);
  cache.decode=async(input,file)=>fs.writeFile(file,data);await cache.get(key,{input:"opaque",duration:123});
  const inspect=cache.inspect.bind(cache);let release,entered;const gate=new Promise(resolve=>release=resolve),paused=new Promise(resolve=>entered=resolve);let pauseOnce=true;
  cache.inspect=async(file,expected)=>{const actual=await inspect(file,expected);if(file.endsWith(key+".flac")&&pauseOnce){pauseOnce=false;entered();await gate;}return actual;};
  const origin=await server(t,(req,res)=>cache.serve(req,res,key,{input:"opaque",duration:123}).catch(()=>{res.writeHead(502);res.end();}));
  const reading=fetch(origin);await paused;assert.equal(cache.entries.get(key).readers,1);
  const publishing=cache.get(other,{input:"opaque",duration:123}).then(()=>null,error=>error);
  await new Promise(resolve=>setImmediate(resolve));assert.ok(cache.entries.has(key));release();
  const response=await reading;assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data);
  const error=await publishing;assert.ok(!error || /cache limit/.test(error.message));
});
test("an invalid cached duration cannot delete a file or cache entry with an active reader",async t=>{
  const cache=new SiriusXmTrackAudio({directory:await directory(t)});cache.decode=async(input,file)=>fs.writeFile(file,header(123));await cache.get(key,{input:"opaque",duration:123});
  const file=cache.entries.get(key).file;cache.entries.get(key).readers++;
  await assert.rejects(cache.get(key,{input:"opaque",duration:999}),/incomplete/);assert.ok(cache.entries.has(key));assert.equal((await fs.stat(file)).size,42);
});
test("decoder error diagnostics reject a zero exit, without retaining raw signed URLs",async t=>{
  const cache=new SiriusXmTrackAudio({directory:await directory(t),spawnImpl:()=>{
    const child=new EventEmitter();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stderr.write("Unable to open resource https://signed.invalid/audio?secret=private\n");child.emit("close",0);});return child;
  }});
  await assert.rejects(cache.decode("opaque","unused"),error=>/audio error/.test(error.message)&&!JSON.stringify(error).includes("private"));
});
test("actual FFmpeg HLS skipped segment reproduces zero-exit truncation; cache retries whole and serves finalized stereo FLAC",async t=>{
  if(spawnSync(executable,["-version"],{windowsHide:true}).error)return t.skip("FFmpeg unavailable.");
  const dir=await directory(t),media=path.join(dir,"source");await fs.mkdir(media);
  const generated=spawnSync(executable,["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:sample_rate=44100:duration=6","-ac","2","-c:a","aac","-b:a","256k","-f","hls","-hls_time","1","-hls_playlist_type","vod",path.join(media,"index.m3u8")],{windowsHide:true});assert.equal(generated.status,0,generated.stderr.toString());
  let generations=0;const requested=[];
  const origin=await server(t,async(req,res)=>{
    const name=path.basename(new URL(req.url,"http://localhost").pathname);requested.push({name,generation:generations});
    if(generations===1 && name==="index2.ts"){res.writeHead(404);res.end();return;}
    try{const data=await fs.readFile(path.join(media,name));res.writeHead(200,{"Content-Length":data.length});res.end(data);}catch{res.writeHead(404);res.end();}
  });
  const diagnostics=[],cache=new SiriusXmTrackAudio({directory:path.join(dir,"cache"),onDiagnostic:d=>diagnostics.push(d)});
  const entry=await cache.get(key,{input:()=>{generations++;return origin+"/index.m3u8";},duration:6});
  assert.equal(generations,2,JSON.stringify(requested));assert.equal(diagnostics[0].kind,"retry");assert.match(diagnostics[0].reason,/audio error|incomplete/);
  assert.ok(entry.duration>=6 && entry.duration<6.1);assert.equal(entry.sampleRate,44100);
  const data=await fs.readFile(entry.file),format=data.readBigUInt64BE(18);assert.equal(Number((format>>41n)&7n)+1,2);assert.equal(Number((format>>36n)&31n)+1,24);
  assert.ok(requested.some(r=>r.name==="index2.ts"&&r.generation===2));
  const probe=spawnSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",entry.file],{windowsHide:true});assert.equal(probe.status,0);assert.ok(Number(probe.stdout.toString())>=6);
});
