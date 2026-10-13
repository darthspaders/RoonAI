"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {SonicAnalyzedAudio,retainSource,digest}=require("../src/sonicAnalyzedAudio");
const {MODEL,MODEL_VERSION,DIMENSIONS}=require("../src/sonicCoverageIdentity");
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"sonic-source-test-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const audio=Buffer.from("original analyzed source");await retainSource(audio,directory);
 const embedding={identityKey:"tidal:1",model:MODEL,modelVersion:MODEL_VERSION,dimensions:DIMENSIONS,vector:Array(DIMENSIONS).fill(.1),sourceSha256:digest(audio),audioDurationMs:120000,track:{metadata:{identityRelation:"exact",audioDurationSeconds:120.123456}}};
 let args;
 const service=new SonicAnalyzedAudio({directory,store:{getEmbedding:()=>embedding},runner:async(command,input)=>{args=input;const dest=input.at(-1).replace(/^\/mnt\/([a-z])\//,(_,drive)=>drive.toUpperCase()+":/");await fs.writeFile(dest,Buffer.from("verified wav bytes"));}});
 return {service,embedding,directory,getArgs:()=>args};
}
test("preview uses retained exact hash, deterministic center and a checked receipt",async t=>{
 const f=await fixture(t),info=await f.service.describe("tidal:1");
 assert.equal(info.status,"ready");assert.equal(info.model,MODEL);assert.equal(info.durationSeconds,30);assert.equal(info.startSeconds,45.061728);
 assert.equal(info.sourceSha256,f.embedding.sourceSha256);assert.match(info.url,/clipId=[a-f0-9]{64}$/);
 const args=f.getArgs();assert.equal(args[args.indexOf("-ar")+1],"24000");assert.equal(args[args.indexOf("-ss")+1],"45.061728");
 assert.deepEqual(await f.service.describe("tidal:1"),info);
 let status,headers,body;await f.service.serve({method:"GET",headers:{range:"bytes=0-3"}},{writeHead:(s,h)=>{status=s;headers=h;},end:b=>{body=b;}},new URL(info.url,"http://localhost"));
 assert.equal(status,206);assert.equal(body.toString(),"veri");assert.match(headers["Content-Range"],/^bytes 0-3/);
});
test("different bytes are unavailable and never replaced with a convenient streaming preview",async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.directory,f.embedding.sourceSha256+".audio"),"different source");
 const info=await f.service.describe("tidal:1");assert.equal(info.status,"unavailable");assert.match(info.reason,/hash mismatch/);assert.equal(f.getArgs(),undefined);
});
test("missing provenance and incompatible models cannot produce misleading previews",async t=>{
 const f=await fixture(t);await fs.unlink(path.join(f.directory,f.embedding.sourceSha256+".audio"));
 let info=await f.service.describe("tidal:1");assert.equal(info.status,"unavailable");assert.match(info.reason,/no recoverable/);
 f.embedding.model="discogs-effnet";info=await f.service.describe("tidal:1");assert.equal(info.status,"unavailable");assert.match(info.reason,/No verified MERT/);
});
test("verified local provenance works, a proxy relation stays excluded",async t=>{
 const f=await fixture(t);f.embedding.track.metadata={provenance:{sourceType:"verified-local-file",localFileId:1}};
 assert.equal((await f.service.describe("tidal:1")).status,"ready");
 f.embedding.track.metadata={provenance:{identityRelation:"version-proxy"}};assert.equal((await f.service.describe("tidal:1")).status,"unavailable");
});
