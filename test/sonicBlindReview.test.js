"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {SonicBlindReview,selectAnchors,buildBlindPlan}=require("../src/sonicBlindReview");
const {createSonicReviewSessionService}=require("../src/sonicReviewSessionService");
const {byteRange,serveBlindAudio}=require("../src/sonicBlindAudio");
const {analysisSpec}=require("../src/sonicAnalysisSpec");
const {SonicEmbeddingStore}=require("../src/sonicEmbeddingStore");
const {SonicAnalysisStore}=require("../src/sonicAnalysisStore");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const hash=i=>require("node:crypto").createHash("sha256").update(String(i)).digest("hex");
function fixture(t) {
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const embeddings=new SonicEmbeddingStore({enabled:false});Object.assign(embeddings,{enabled:true,db});embeddings.migrate();
  let profileWrites=0;
  const legacy=createSonicReviewSessionService({db,recommendationEngine:{saveSonicAnchorProfile(){profileWrites++;},analysisEvidenceFor(){throw Error("Blind context must not fetch model evidence");}},logger:null});
  db.exec("CREATE TABLE taste_feedback(id INTEGER)");
  return {db,embeddings,legacy,service:new SonicBlindReview(db),profileWrites:()=>profileWrites};
}
function plan() {
  const clips={};
  const clip=i=>{const id=hash(i);clips[id]={start:15,end:45,wavSha256:hash(`wav${i}`),sourceFile:"Z:\\private.flac",sourceSha256:hash(i)};return id;};
  return {batchId:"blind:test",planKey:"frozen-pilot",title:"Listening",createdAt:new Date().toISOString(),
    groups:Array.from({length:6},(_,g)=>({sessionId:`session:${g}`,anchor:{identityKey:`anchor:${g}`,artist:`Anchor ${g}`,title:"Anchor mix"},lane:"Progressive House",anchorClip:clip(`a${g}`),
      candidates:Array.from({length:4},(_,i)=>({track:{identityKey:`candidate:${g}:${i}`,title:`Candidate ${i}`,artist:"Artist"},clipId:clip(`${g}:${i}`),
        nominations:[{analyzer:["effnet-control","mert-fullsong","mert-30s","mert-330m"][i],rank:1,similarity:.98,specKey:"private-spec"}]}))})),clips};
}
test("prepared batch reuses durable Sonic Review sessions, hides attribution everywhere and writes no judgments",t=>{
  const f=fixture(t),p=plan(),result=f.service.create(p);
  assert.equal(result.batch.remaining,24);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,6);
  for(const output of [result,f.legacy.getReviewSession("session:0",{includeDiagnostics:true,includeCurrent:true,includeAnchorContext:true}),
    f.legacy.getAssistantReviewContext("session:0"),f.legacy.getNextReviewItem("session:0"),f.legacy.listReviewSessions(),f.service.report(p.batchId)]) {
    assert.doesNotMatch(JSON.stringify(output),/effnet|mert-|similarity|private-spec|sourceFile|nominations|sourceSha256|wavSha256/i);
  }
  assert.equal(f.profileWrites(),0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session_item WHERE decision IS NOT NULL").get().n,0);
});
test("human saves resume after restart, retries are idempotent, and revisions have an audit trail",t=>{
  const f=fixture(t),p=plan();f.service.create(p);
  const input={batchId:p.batchId,sessionId:"session:0",index:0,decision:"KEEP",listened:true,note:"Groove fits"};
  assert.equal(f.service.save(input).batch.completed,1);
  const audits=()=>f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session_audit WHERE event_type='BLIND_LISTENING_SAVED'").get().n;
  f.service.save(input);assert.equal(audits(),1);
  const resumed=new SonicBlindReview(f.db);assert.equal(resumed.get(p.batchId).batch.completed,1);
  assert.equal(resumed.create(p).batch.completed,1,"re-preparing cannot erase listening decisions");
  resumed.save({...input,decision:"SKIP"});assert.equal(audits(),2);assert.equal(resumed.get(p.batchId).batch.completed,1);
  assert.equal(f.profileWrites(),0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM taste_feedback").get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_neighbor_feedback").get().n,0);
});
test("invalid or unlistened judgments cannot mutate a batch; legacy writes cannot bypass isolation",async t=>{
  const f=fixture(t),p=plan();f.service.create(p);
  const input={batchId:p.batchId,sessionId:"session:0",index:0,decision:"KEEP",listened:true};
  for(const delta of [{listened:false},{index:4},{index:0.5},{batchId:"other"},{batchId:""},{sessionId:"other"},{decision:"LOVE"},{note:"x".repeat(2001)}])assert.throws(()=>f.service.save({...input,...delta}));
  await assert.rejects(f.legacy.saveReviewItem({...input,profile:{energy:5}}),/blind listening/);
  await assert.rejects(f.legacy.rateReviewItem({...input,rating:"love"}),/global ratings/);
  await assert.rejects(f.legacy.advanceReviewSession(input),/blind listening/);
  assert.equal(f.service.get(p.batchId).batch.completed,0);assert.equal(f.profileWrites(),0);
  f.service.save({...input,decision:"UNSURE",listened:false});assert.equal(f.service.get(p.batchId).batch.completed,1);
});
test("atomic preparation cannot leave half a listening batch",t=>{
  const f=fixture(t),p=plan();p.groups[2].candidates[1].track.identityKey=p.groups[2].candidates[0].track.identityKey;
  assert.throws(()=>f.service.create(p),/UNIQUE/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);
  assert.equal(f.service.get().batch,null);
});
test("results remain blind until complete and cannot count uncertainty as a negative or promote a model",t=>{
  const f=fixture(t),p=plan();f.service.create(p);assert.equal(f.service.report(p.batchId).ready,false);
  for(const group of p.groups)for(const [index] of group.candidates.entries()) f.service.save({batchId:p.batchId,sessionId:group.sessionId,index,decision:index===1?"UNSURE":"KEEP",listened:index!==1});
  const report=f.service.report(p.batchId);assert.equal(report.ready,true);assert.equal(report.productionPromotionAllowed,false);
  assert.equal(report.models[0].sampledKeepRate,1);assert.equal(report.models[1].sampledKeepRate,null);assert.equal(report.models[1].unjudged,6);
});
test("anchor sampling preserves named versions and refuses missing requested lanes",()=>{
  const items=["progressive house","trance raw deep hypnotic","psy trance","techno peak time driving","deep house","progressive house"].map((lane,i)=>({lane,rating:"love",
    track:{identityKey:`tidal:${i}`,artist:`Artist ${i}`,title:i>=4?`Track (Named ${i} Remix)`:`Track ${i}`,analysisLocal:{sha256:hash(i)}}}));
  const selected=selectAnchors({items});assert.equal(selected.length,6);assert.match(selected[4].track.title,/Named 4 Remix/);
  assert.throws(()=>selectAnchors({items:items.filter(x=>!x.lane.includes("psy"))}),/Psytrance/);
});
test("sampling uses all model spaces on matched audio, deduplicates nominations and excludes self recordings",t=>{
  const f=fixture(t),store=new SonicAnalysisStore({db:f.db,embeddingStore:f.embeddings});
  const manifest={createdAt:"frozen",items:["progressive house","trance raw deep hypnotic","psy trance","techno peak time driving","deep house","progressive house","electronic","house"].map((lane,i)=>({lane,rating:"love",
    track:{identityKey:`tidal:${i}`,artist:`Artist ${i}`,title:i>=4?`Track (Named ${i} Remix)`:`Track ${i}`,genre:lane,analysisLocal:{file:`track${i}.flac`,sha256:hash(i),localFileId:i+1}}}))};
  for(const model of ["effnet-control","mert-fullsong","mert-30s","mert-330m"]){const s=analysisSpec(model);for(const [i,item]of manifest.items.entries()){
    const vector=Array(s.dimensions).fill(0);vector[0]=1;vector[i+1]=.1;
    store.save(item.track,s,hash(i),{specKey:s.key,revision:s.revision,sampleRate:s.sampleRate,vector,segments:[{start:15,end:45}],audioDurationSeconds:60,analyzedSeconds:30,sourceCoverage:.5,timings:{}});
  }}
  const p=buildBlindPlan(f.db,manifest);assert.equal(p.groups.length,6);
  for(const g of p.groups){assert.equal(new Set(g.candidates.map(c=>c.track.identityKey)).size,4);assert.ok(g.candidates.every(c=>c.track.identityKey!==g.anchor.identityKey));assert.ok(g.candidates.every(c=>c.nominations.length===4));}
  f.db.prepare("DELETE FROM sonic_analysis_link WHERE identity_key='tidal:7' AND spec_key=?").run(analysisSpec("mert-fullsong").key);
  assert.throws(()=>buildBlindPlan(f.db,manifest),/matched-source/);
});
test("audio endpoint only serves prepared batch clips and supports seeking without accepting paths",async t=>{
  assert.equal(byteRange("bytes=0-1,4-8",20),null);assert.equal(byteRange("bytes=20-",20),null);assert.equal(byteRange("bytes=-0",20),null);
  assert.deepEqual(byteRange("bytes=-4",20),{start:16,end:19,partial:true});
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"sonic-blind-test-")),id=hash("clip"),buffer=Buffer.from("RIFF0123456789WAVE");
  fs.writeFileSync(path.join(folder,`${id}.wav`),buffer);
  const service={plan:batchId=>batchId==="test"?{clips:{[id]:{wavSha256:hash("wav")}}}:null};
  const server=http.createServer((req,res)=>serveBlindAudio(req,res,service,new URL(req.url,"http://localhost"),folder));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();server.close();fs.unlinkSync(path.join(folder,`${id}.wav`));fs.rmdirSync(folder);});
  const base=`http://127.0.0.1:${server.address().port}/?batchId=test&clipId=${id}`;
  const partial=await fetch(base,{headers:{range:"bytes=0-3"}});assert.equal(partial.status,206);assert.equal(await partial.text(),"RIFF");
  const head=await fetch(base,{method:"HEAD"});assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),String(buffer.length));
  assert.equal((await fetch(base.replace(id,"../../secret"))).status,404);
  assert.equal((await fetch(base.replace("batchId=test","batchId=unknown"))).status,404);
});
