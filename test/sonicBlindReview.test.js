"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {SonicBlindReview,selectAnchors,buildBlindPlan}=require("../src/sonicBlindReview");
const {createSonicReviewSessionService}=require("../src/sonicReviewSessionService");
const {byteRange,serveBlindAudio}=require("../src/sonicBlindAudio");
const {analysisSpec}=require("../src/sonicAnalysisSpec");
const {SonicEmbeddingStore}=require("../src/sonicEmbeddingStore");
const {SonicAnalysisStore}=require("../src/sonicAnalysisStore");
const {argumentsFor,validateWave}=require("../scripts/sonic-prepare-blind-review");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const vm=require("node:vm");
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

const V2_MODELS=["mert-fullsong","mert-30s"];
const V2_TOPS=[[0,1,2],[0,1,3],[0,3,4],[3,4,5],[0,3,4],[0,1,3]];
function v2Fixture(t) {
  const f=fixture(t),store=new SonicAnalysisStore({db:f.db,embeddingStore:f.embeddings});
  const lanes=["progressive house","trance raw deep hypnotic","psy trance","techno peak time driving","deep house","progressive house"];
  const anchors=lanes.map((lane,i)=>({lane,rating:"love",track:{identityKey:`v2:a:${i}`,artist:`Anchor ${i}`,
    title:i>=4?`Anchor (Named ${i} Remix)`:`Anchor ${i}`,genre:lane,
    analysisLocal:{file:`anchor-${i}.flac`,sha256:hash(`anchor-${i}`),localFileId:i+1}}}));
  const candidates=anchors.flatMap((anchor,g)=>Array.from({length:6},(_,i)=>({lane:"electronic",rating:null,
    track:{identityKey:`v2:c:${g}:${i}`,artist:`Candidate artist ${g}:${i}`,title:`Candidate ${g}:${i}`,genre:"electronic",
      analysisLocal:{file:`candidate-${g}-${i}.flac`,sha256:hash(`candidate-${g}-${i}`),localFileId:7+g*6+i}}})));
  const manifest={createdAt:"v2-frozen",items:[...anchors,...candidates]};
  for(const model of V2_MODELS){const s=analysisSpec(model);for(const item of manifest.items){
    const vector=Array(s.dimensions).fill(0),parts=item.track.identityKey.split(":"),g=Number(parts[2]);
    if(parts[1]==="a")vector[g]=1;
    else {
      const i=Number(parts[3]),top=model==="mert-fullsong"?[0,1,2]:V2_TOPS[g],rank=top.indexOf(i);
      const score=rank>=0?.96-rank*.04:.2-i*.01;
      vector[g]=score;vector[6+g*6+i]=Math.sqrt(1-score**2);
    }
    store.save(item.track,s,item.track.analysisLocal.sha256,{specKey:s.key,revision:s.revision,sampleRate:s.sampleRate,vector,
      segments:[{start:15,end:45}],audioDurationSeconds:60,analyzedSeconds:30,sourceCoverage:.5,timings:{}});
  }}
  return {...f,manifest};
}
function preparedV2Plan(f) {
  const p=buildBlindPlan(f.db,f.manifest,{models:V2_MODELS,topK:3,title:"Second blind listening batch"});
  for(const [clipId,clip]of Object.entries(p.clips))clip.wavSha256=hash(`wav:${clipId}`);
  return p;
}

test("v2 comparison uses each model's fixed top three, hears shared pairs once, and ignores absent control analysis",t=>{
  const f=v2Fixture(t),p=preparedV2Plan(f);
  assert.deepEqual(p.models,V2_MODELS);assert.equal(p.evaluationTopK,3);assert.equal(p.version,2);
  assert.equal(p.title,"Second blind listening batch");assert.equal(p.groups.length,6);assert.equal(p.count,27);
  const nominations=new Map(V2_MODELS.map(model=>[model,0]));
  for(const group of p.groups){
    const g=Number(group.anchor.identityKey.split(":")[2]),expected=new Set([0,1,2,...V2_TOPS[g]].map(i=>`v2:c:${g}:${i}`));
    assert.deepEqual(new Set(group.candidates.map(c=>c.track.identityKey)),expected);
    assert.equal(group.candidates.length,expected.size);
    for(const model of V2_MODELS){
      const modelNominations=group.candidates.flatMap(candidate=>candidate.nominations.filter(n=>n.analyzer===model));
      assert.deepEqual(modelNominations.map(n=>n.rank).sort((a,b)=>a-b),[1,2,3]);
      nominations.set(model,nominations.get(model)+modelNominations.length);
    }
    assert.ok(group.candidates.every(c=>c.nominations.length>=1&&c.nominations.length<=2));
    assert.ok(group.candidates.every(c=>c.nominations.every(n=>n.identityKey===c.track.identityKey)));
  }
  assert.deepEqual([...nominations.values()],[18,18]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_analysis_link WHERE spec_key=?").get(analysisSpec("effnet-control").key).n,0);
});

test("new anchor exclusions also reject alternate source identities and duplicate recordings",()=>{
  const old=["progressive house","trance raw deep hypnotic","psy trance","techno peak time driving","deep house","progressive house"].map((lane,i)=>({lane,rating:"love",
    recordingGroup:`old-recording:${i}`,track:{identityKey:`old:${i}`,artist:`Old artist ${i}`,title:i>=4?`Old (Named ${i} Remix)`:`Old ${i}`,
      analysisLocal:{sha256:hash(`old:${i}`)}}}));
  const fresh=old.map((item,i)=>({...item,recordingGroup:`fresh-recording:${i}`,track:{...item.track,identityKey:`fresh:${i}`,artist:`Fresh artist ${i}`,
    title:i>=4?`Fresh (Named ${i} Remix)`:`Fresh ${i}`,analysisLocal:{sha256:hash(`fresh:${i}`)}}}));
  const aliases=[{...old[0],recordingGroup:"different-source-recording",track:{...old[0].track,identityKey:"alias:same-source"}},
    {...old[0],track:{...old[0].track,identityKey:"alias:same-recording",analysisLocal:{sha256:hash("different-source")}}}];
  const manifest={items:[...old,...fresh,...aliases]},options={excludeIdentityKeys:old.map(item=>item.track.identityKey)};
  for(const selectionMethod of ["metadata-stratified-preferred","metadata-stratified-random"]){
    const chosen=selectAnchors(manifest,{...options,selectionMethod});
    assert.deepEqual(new Set(chosen.map(item=>item.track.identityKey)),new Set(fresh.map(item=>item.track.identityKey)));
  }
  assert.throws(()=>selectAnchors({items:old},options),/anchor|eligible|Progressive/i);
});

test("invalid models, duplicate models, top counts and anchor selection methods fail before preparation",t=>{
  const f=fixture(t),manifest={items:[]};
  for(const models of [[],["mert-30s","mert-30s"],["unknown"],["maest-mood"],"mert-30s"])
    assert.throws(()=>buildBlindPlan(f.db,manifest,{models}),/model|analyzer/i);
  for(const topK of [0,11,1.5,"3",null])assert.throws(()=>buildBlindPlan(f.db,manifest,{models:V2_MODELS,topK}),/top|count|integer/i);
  assert.throws(()=>buildBlindPlan(f.db,manifest,{models:V2_MODELS,topK:3,selectionMethod:"unranked"}),/selection/i);
});

test("variable-count batches save, resume and complete without changing the first batch or exposing private nominations",t=>{
  const f=v2Fixture(t),original=plan();f.service.create(original);
  f.service.save({batchId:original.batchId,sessionId:"session:0",index:0,decision:"KEEP",listened:true,note:"Original judgment"});
  const originalSnapshot=f.service.get(original.batchId),originalPrivate=JSON.stringify(f.service.plan(original.batchId));
  const p=preparedV2Plan(f),created=f.service.create(p);
  assert.equal(created.batch.count,27);assert.equal(created.batch.remaining,27);
  assert.deepEqual(created.batch.groups.flatMap(group=>group.items.map(item=>item.number)),Array.from({length:27},(_,i)=>i+1));
  assert.doesNotMatch(JSON.stringify([created,f.service.report(p.batchId),f.legacy.getReviewSession(p.groups[0].sessionId,{includeDiagnostics:true,includeCurrent:true,includeAnchorContext:true})]),
    /mert-|effnet|similarity|nominations|specKey|sourceFile|sourceSha256|wavSha256|evaluationTopK/);
  for(const group of p.groups){
    const row=f.db.prepare("SELECT requested_count,candidate_count FROM sonic_review_session WHERE session_id=?").get(group.sessionId);
    assert.equal(row.requested_count,group.candidates.length);assert.equal(row.candidate_count,group.candidates.length);
  }
  const longGroup=p.groups.find(group=>group.candidates.length===6),input={batchId:p.batchId,sessionId:longGroup.sessionId,index:5,decision:"KEEP",listened:true,note:"Last of six"};
  f.service.save(input);f.service.save(input);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session_audit WHERE session_id=? AND event_type='BLIND_LISTENING_SAVED'").get(longGroup.sessionId).n,1);
  const resumed=new SonicBlindReview(f.db);assert.equal(resumed.get(p.batchId).batch.completed,1);assert.equal(resumed.create(p).batch.completed,1);
  assert.throws(()=>resumed.save({...input,index:6}),/belong/);
  for(const group of p.groups)for(const [index]of group.candidates.entries())resumed.save({batchId:p.batchId,sessionId:group.sessionId,index,decision:"KEEP",listened:true});
  const completed=resumed.get(p.batchId).batch,report=resumed.report(p.batchId);
  assert.equal(completed.completed,27);assert.equal(completed.remaining,0);assert.equal(completed.status,"COMPLETED");
  assert.equal(report.anchorCount,6);assert.equal(report.decisions,27);assert.equal(report.productionPromotionAllowed,false);
  assert.deepEqual(report.models.map(model=>[model.analyzer,model.sampledNominations,model.judged,model.kept,model.sampledKeepRate]),
    V2_MODELS.map(model=>[model,18,18,18,1]));
  for(const group of p.groups){
    const row=f.db.prepare("SELECT status,completed_count,current_index FROM sonic_review_session WHERE session_id=?").get(group.sessionId);
    assert.equal(row.status,"COMPLETED");assert.equal(row.completed_count,group.candidates.length);assert.equal(row.current_index,group.candidates.length);
  }
  assert.deepEqual(resumed.get(original.batchId),originalSnapshot);assert.equal(JSON.stringify(resumed.plan(original.batchId)),originalPrivate);
  assert.equal(f.profileWrites(),0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM taste_feedback").get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_neighbor_feedback").get().n,0);
});

test("an incomplete variable-count plan is rejected atomically",t=>{
  const f=v2Fixture(t),p=preparedV2Plan(f),clip=Object.values(p.clips)[0];delete clip.wavSha256;
  assert.throws(()=>f.service.create(p),/complete prepared/i);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);
  assert.equal(f.service.get().batch,null);
});

test("alternate sources of the same recording cannot share one model-comparison listening judgment",t=>{
  const f=v2Fixture(t),full=f.manifest.items.find(item=>item.track.identityKey==="v2:c:3:0"),short=f.manifest.items.find(item=>item.track.identityKey==="v2:c:3:3");
  full.recordingGroup=short.recordingGroup="same-recording-different-sources";
  assert.notEqual(full.track.analysisLocal.sha256,short.track.analysisLocal.sha256);
  assert.throws(()=>buildBlindPlan(f.db,f.manifest,{models:V2_MODELS,topK:3}),/exact same source excerpt/i);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);
});

test("fixed-top-three publication rejects missing nominations, repeated ranks and inconsistent counts",t=>{
  const f=v2Fixture(t),baseline=preparedV2Plan(f);
  for(const corrupt of [
    p=>{p.count++;},
    p=>{p.groups[0].candidates[0].nominations.pop();},
    p=>{const nominations=p.groups[0].candidates.flatMap(c=>c.nominations.filter(n=>n.analyzer===V2_MODELS[0]));nominations[1].rank=nominations[0].rank;},
    p=>{p.groups[0].candidates=[];},
    p=>{delete p.clips[p.groups[0].anchorClip];}
  ]){
    const changed=structuredClone(baseline);corrupt(changed);
    assert.throws(()=>f.service.create(changed),/complete prepared/i);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);
  }
  assert.equal(f.service.get().batch,null);
});

async function blindUiHarness(groupSizes) {
  const listeners=new Map(),storage=new Map();
  const batch={batchId:"blind:ui",count:groupSizes.reduce((sum,n)=>sum+n,0),completed:0,remaining:groupSizes.reduce((sum,n)=>sum+n,0),
    groups:groupSizes.map((n,g)=>({sessionId:`ui:${g}`,lane:"Progressive House",anchor:{artist:`Anchor ${g}`,title:`Anchor title ${g}`},
      anchorAudio:{url:`/anchor/${g}`,start:15,end:45},items:Array.from({length:n},(_,i)=>({index:i,status:"PENDING",candidate:{artist:`Candidate artist ${g}:${i}`,title:`Candidate title ${g}:${i}`},
        audio:{url:`/candidate/${g}/${i}`,start:15,end:45}}))}))};
  const nodes={"#blindNote":{value:""},"#blindListened":{checked:false},".sonicBlindStatus":{textContent:""},"#blindCandidateHeading":{focus(){}}};
  const root={innerHTML:"",querySelectorAll(){return [];},querySelector(selector){return nodes[selector]||null;},addEventListener(type,listener){listeners.set(type,listener);}};
  const context={document:{getElementById(){return root;}},window:{addEventListener(){}},location:{search:"?sonicBlindBatch=blind%3Aui"},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetch:async()=>({ok:true,json:async()=>({ok:true,batch})}),AbortSignal,URLSearchParams,setActiveView(){},renderSonicReview(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../public/sonicBlindReview.js"),"utf8"),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {root,changeAnchor(value){listeners.get("change")({target:{id:"blindAnchor",value:String(value)}});},next(){
    const button={dataset:{blindAction:"next"}};listeners.get("click")({target:{closest:selector=>selector==="[data-sonic-blind-open]"?null:button}});
  }};
}

test("blind screen anchor navigation uses cumulative lengths and displays each block's actual candidate count",async()=>{
  const h=await blindUiHarness([3,4,5,6,3,6]);
  const offsets=[...h.root.innerHTML.matchAll(/<option value="(\d+)"/g)].map(match=>Number(match[1]));
  assert.deepEqual(offsets,[0,3,7,12,18,21]);assert.match(h.root.innerHTML,/Candidate 1 of 3/);
  h.changeAnchor(offsets[3]);assert.match(h.root.innerHTML,/Candidate title 3:0/);assert.match(h.root.innerHTML,/Candidate 1 of 6/);
  for(let i=0;i<6;i++)h.next();
  assert.match(h.root.innerHTML,/Candidate title 4:0/);assert.match(h.root.innerHTML,/Candidate 1 of 3/);assert.match(h.root.innerHTML,/Pair 19 of 27/);
  assert.doesNotMatch(h.root.innerHTML,/mert-|effnet|similarity|nominations/);
});

test("the original four-candidate blind screen retains its anchor offsets and labels",async()=>{
  const h=await blindUiHarness([4,4,4,4,4,4]);
  const offsets=[...h.root.innerHTML.matchAll(/<option value="(\d+)"/g)].map(match=>Number(match[1]));
  assert.deepEqual(offsets,[0,4,8,12,16,20]);h.changeAnchor(offsets[5]);
  assert.match(h.root.innerHTML,/Candidate title 5:0/);assert.match(h.root.innerHTML,/Candidate 1 of 4/);assert.match(h.root.innerHTML,/Pair 21 of 24/);
});

test("CLI custom rounds require a stable round ID and explicit valid top-k before any preparation",()=>{
  assert.deepEqual(argumentsFor([]),{excludeBatchIds:[],dryRun:false});
  assert.deepEqual(argumentsFor(["--round-id","v2-confirmation","--models","mert-fullsong,mert-30s","--top-k","3","--exclude-batch","blind:old","--title","Second listening","--dry-run"]),
    {excludeBatchIds:["blind:old"],dryRun:true,roundId:"v2-confirmation",models:V2_MODELS,topK:3,title:"Second listening"});
  for(const args of [["--models","mert-30s"],["--top-k","3"],["--exclude-batch","blind:old"],["--title","Second"]])
    assert.throws(()=>argumentsFor(args),/round ID/i);
  assert.throws(()=>argumentsFor(["--round-id","v2"]),/explicit top-k/i);
  for(const topK of ["0","11","2.5","nope"])assert.throws(()=>argumentsFor(["--round-id","v2","--top-k",topK]),/integer/i);
  for(const args of [["--top-k"],["--models","--dry-run"]])assert.throws(()=>argumentsFor(args),/value is required/i);
  assert.throws(()=>argumentsFor(["--unknown"]),/Unknown preparation option/);
  assert.throws(()=>argumentsFor(["--round-id","..\\unsafe","--top-k","3"]),/round ID/i);
});

function listeningWave(seconds=30) {
  const dataBytes=Math.round(seconds*48000),buffer=Buffer.alloc(44+dataBytes);
  buffer.write("RIFF",0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write("WAVEfmt ",8);buffer.writeUInt32LE(16,16);
  buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(24000,24);buffer.writeUInt32LE(48000,28);
  buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write("data",36);buffer.writeUInt32LE(dataBytes,40);
  return buffer;
}
test("prepared WAV cache must be complete mono 24-kHz 16-bit PCM with the exact listening duration",t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"sonic-blind-wav-test-")),file=path.join(folder,"clip.wav"),clip={start:15,end:45};
  t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(folder);});
  const validate=buffer=>{fs.writeFileSync(file,buffer);return ()=>validateWave(file,clip);};
  assert.doesNotThrow(validate(listeningWave()));
  for(const [offset,value,bytes]of [[20,3,2],[22,2,2],[24,48000,4],[34,24,2]]){
    const changed=listeningWave();changed[`writeUInt${bytes*8}LE`](value,offset);
    assert.throws(validate(changed),/span and format/i);
  }
  assert.throws(validate(listeningWave(29.8)),/span and format/i);
  assert.throws(validate(listeningWave().subarray(0,100)),/Truncated/i);
  const malformed=listeningWave();malformed.write("BAD!",0);assert.throws(validate(malformed),/Invalid listening WAV/i);
  assert.throws(validate(Buffer.alloc(20)),/Invalid listening WAV/i);
});

const ENSEMBLE_MODEL="mert-v2-ensemble",ENSEMBLE_MODELS=[...V2_MODELS,ENSEMBLE_MODEL];
function preparedEnsemblePlan(f,options={}) {
  f.db.exec("CREATE TABLE IF NOT EXISTS sonic_analysis_pilot(manifest_json TEXT)");
  if(!f.db.prepare("SELECT 1 FROM sonic_analysis_pilot WHERE json_extract(manifest_json,'$.createdAt')=?").get(f.manifest.createdAt))
    f.db.prepare("INSERT INTO sonic_analysis_pilot VALUES(?)").run(JSON.stringify(f.manifest));
  const p=buildBlindPlan(f.db,f.manifest,{models:ENSEMBLE_MODELS,topK:3,selectionMethod:"metadata-stratified-preferred",...options});
  for(const [clipId,clip]of Object.entries(p.clips))clip.wavSha256=hash(`wav:${clipId}`);
  return p;
}
function replayEnsembleGroup(p,group) {
  const {fuseSonicRankings}=require("../src/sonicEnsemble"),strategy=p.strategies[ENSEMBLE_MODEL];
  const evidence=clipId=>{const clip=p.clips[clipId];return {sourceSha256:clip.sourceSha256,spans:[[clip.start,clip.end]]};};
  const lists=V2_MODELS.map(analyzer=>({analyzer,specKey:analysisSpec(analyzer).key,status:"available",anchorEvidence:evidence(group.anchorClip),
    candidates:group.candidates.flatMap(candidate=>candidate.nominations.filter(n=>n.analyzer===analyzer).map(n=>({track:candidate.track,rank:n.rank,similarity:n.similarity,
      evidence:evidence(candidate.clipId)}))).sort((a,b)=>a.rank-b.rank)}));
  return fuseSonicRankings({anchor:group.anchor,lists,count:strategy.finalCount,method:strategy.method,agreementWeight:strategy.agreementWeight});
}

test("three-arm blind plan freezes equal top-three coverage and reuses the two-model audio union",t=>{
  const f=v2Fixture(t),analysisBefore=f.db.prepare("SELECT * FROM sonic_analysis_artifact ORDER BY artifact_key").all();
  const p=preparedEnsemblePlan(f),strategy=p.strategies[ENSEMBLE_MODEL];
  assert.equal(p.version,3);assert.deepEqual(p.models,ENSEMBLE_MODELS);assert.equal(p.count,27);assert.equal(p.groups.length,6);
  assert.equal(strategy.kind,"rank-fusion");assert.equal(strategy.method,"best-rank-agreement");assert.equal(strategy.agreementWeight,.05);
  assert.equal(strategy.retrievalTopK,3);assert.equal(strategy.finalCount,3);assert.deepEqual(strategy.componentModels,V2_MODELS);
  assert.deepEqual(strategy.componentSpecs,V2_MODELS.map(analyzer=>({analyzer,specKey:analysisSpec(analyzer).key})));
  const totals=new Map(ENSEMBLE_MODELS.map(analyzer=>[analyzer,0]));
  for(const group of p.groups){
    const g=Number(group.anchor.identityKey.split(":")[2]),expectedUnion=new Set([0,1,2,...V2_TOPS[g]].map(i=>`v2:c:${g}:${i}`));
    assert.deepEqual(new Set(group.candidates.map(c=>c.track.identityKey)),expectedUnion);
    for(const analyzer of ENSEMBLE_MODELS){const nominations=group.candidates.flatMap(c=>c.nominations.filter(n=>n.analyzer===analyzer));
      assert.deepEqual(nominations.map(n=>n.rank).sort((a,b)=>a-b),[1,2,3]);totals.set(analyzer,totals.get(analyzer)+nominations.length);}
    const virtual=group.candidates.flatMap(c=>c.nominations.filter(n=>n.analyzer===ENSEMBLE_MODEL).map(n=>({candidate:c,nomination:n}))).sort((a,b)=>a.nomination.rank-b.nomination.rank);
    const replay=replayEnsembleGroup(p,group).candidates;
    assert.deepEqual(virtual.map(row=>row.candidate.track.identityKey),replay.map(row=>row.track.identityKey));
    for(const [index,row]of virtual.entries()){
      assert.equal(row.nomination.strategyKey,strategy.strategyKey);assert.equal(row.nomination.identityKey,row.candidate.track.identityKey);
      assert.equal(row.nomination.baseRankScore,replay[index].baseRankScore);assert.equal(row.nomination.ensembleScore,replay[index].ensembleScore);
      assert.equal(row.nomination.agreementBonus,replay[index].agreementBonus);assert.deepEqual(row.nomination.componentNominations,replay[index].nominations);
      assert.equal(row.nomination.specKey,undefined);assert.equal(row.nomination.similarity,undefined,"fusion must not pretend to be an encoder cosine");
    }
  }
  assert.deepEqual([...totals.values()],[18,18,18]);
  assert.deepEqual(f.db.prepare("SELECT * FROM sonic_analysis_artifact ORDER BY artifact_key").all(),analysisBefore);
  assert.throws(()=>analysisSpec(ENSEMBLE_MODEL),/Unknown Sonic analyzer/);
});

test("ensemble strategy keys freeze configuration, while identical preparation safely resumes saved judgments",t=>{
  const f=v2Fixture(t),baseline=preparedEnsemblePlan(f),repeated=preparedEnsemblePlan(f),largerBonus=preparedEnsemblePlan(f,{ensembleConfig:{method:"best-rank-agreement",agreementWeight:.1}});
  assert.equal(repeated.planKey,baseline.planKey);assert.equal(repeated.strategies[ENSEMBLE_MODEL].strategyKey,baseline.strategies[ENSEMBLE_MODEL].strategyKey);
  assert.notEqual(largerBonus.planKey,baseline.planKey);assert.notEqual(largerBonus.strategies[ENSEMBLE_MODEL].strategyKey,baseline.strategies[ENSEMBLE_MODEL].strategyKey);
  assert.deepEqual(new Set(Object.keys(largerBonus.clips)),new Set(Object.keys(baseline.clips)));
  f.service.create(baseline);const group=baseline.groups[0],input={batchId:baseline.batchId,sessionId:group.sessionId,index:0,decision:"KEEP",listened:true,note:"Saved before reprepare"};
  f.service.save(input);const result=f.service.create(repeated);
  assert.equal(result.batch.batchId,baseline.batchId);assert.equal(result.batch.completed,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_blind_review_batch").get().n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,6);
  f.service.save(input);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session_audit WHERE event_type='BLIND_LISTENING_SAVED'").get().n,1);
});

test("ensemble attribution stays hidden until completion and existing first and second batches remain unchanged",t=>{
  const f=v2Fixture(t),first=plan(),second=preparedV2Plan(f);f.service.create(first);f.service.create(second);
  f.service.save({batchId:first.batchId,sessionId:first.groups[0].sessionId,index:0,decision:"KEEP",listened:true});
  const originals=[first,second].map(p=>({id:p.batchId,public:f.service.get(p.batchId),private:JSON.stringify(f.service.plan(p.batchId))}));
  const p=preparedEnsemblePlan(f),created=f.service.create(p);
  for(const output of [created,f.service.report(p.batchId),f.legacy.getReviewSession(p.groups[0].sessionId,{includeDiagnostics:true,includeCurrent:true,includeAnchorContext:true}),
    f.legacy.getAssistantReviewContext(p.groups[0].sessionId),f.legacy.listReviewSessions()])
    assert.doesNotMatch(JSON.stringify(output),/mert-|effnet|rank-fusion|strategyKey|agreementBonus|componentNominations|specKey|similarity|sourceFile|sourceSha256|wavSha256|nominations/);
  assert.equal(f.service.report(p.batchId).ready,false);assert.equal(created.batch.count,27);
  for(const group of p.groups)for(const [index]of group.candidates.entries())f.service.save({batchId:p.batchId,sessionId:group.sessionId,index,decision:"KEEP",listened:true});
  const report=f.service.report(p.batchId);assert.equal(report.ready,true);assert.equal(report.expectedNominationsPerModel,18);
  assert.deepEqual(report.models.map(model=>[model.analyzer,model.sampledNominations,model.judged,model.kept]),ENSEMBLE_MODELS.map(model=>[model,18,18,18]));
  assert.equal(report.productionPromotionAllowed,false);
  for(const original of originals){assert.deepEqual(f.service.get(original.id),original.public);assert.equal(JSON.stringify(f.service.plan(original.id)),original.private);}
  assert.equal(f.profileWrites(),0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM taste_feedback").get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_neighbor_feedback").get().n,0);
});

test("three-arm publication rejects altered strategy settings, virtual ranks and copied encoder evidence atomically",t=>{
  const f=v2Fixture(t),baseline=preparedEnsemblePlan(f);
  for(const corrupt of [
    p=>{p.strategies[ENSEMBLE_MODEL].agreementWeight=.1;},
    p=>{p.strategies[ENSEMBLE_MODEL].componentSpecs[0].specKey=analysisSpec("effnet-control").key;},
    p=>{const n=p.groups[0].candidates.flatMap(c=>c.nominations).find(n=>n.analyzer===ENSEMBLE_MODEL);n.strategyKey="changed-strategy";},
    p=>{const n=p.groups[0].candidates.flatMap(c=>c.nominations).find(n=>n.analyzer===ENSEMBLE_MODEL);n.ensembleScore+=.01;},
    p=>{const n=p.groups[0].candidates.flatMap(c=>c.nominations).find(n=>n.analyzer===ENSEMBLE_MODEL);n.componentNominations[0].rank=99;},
    p=>{const rows=p.groups[0].candidates.flatMap(c=>c.nominations).filter(n=>n.analyzer===ENSEMBLE_MODEL);rows[1].rank=rows[0].rank;},
    p=>{const n=p.groups[0].candidates.flatMap(c=>c.nominations).find(n=>n.analyzer===ENSEMBLE_MODEL);n.specKey=analysisSpec("mert-fullsong").key;n.similarity=.98;},
    p=>{const candidate=p.groups[0].candidates.find(c=>c.nominations.some(n=>n.analyzer===V2_MODELS[0]));candidate.nominations.push({...candidate.nominations.find(n=>n.analyzer===V2_MODELS[0])});}
  ]){
    const changed=structuredClone(baseline);corrupt(changed);assert.throws(()=>f.service.create(changed));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_blind_review_batch").get().n,0);
  }
});

test("virtual ensemble selection requires the exact two checkpoints and bounded frozen top-three settings",t=>{
  const f=fixture(t),manifest={items:[]};
  for(const models of [[ENSEMBLE_MODEL],["mert-fullsong",ENSEMBLE_MODEL],[...ENSEMBLE_MODELS,"effnet-control"]])
    assert.throws(()=>buildBlindPlan(f.db,manifest,{models,topK:3}));
  for(const options of [{topK:4},{topK:undefined},{ensembleConfig:{method:"rrf",agreementWeight:.05}},
    {ensembleConfig:{method:"best-rank-agreement",agreementWeight:.10001}},{ensembleConfig:{method:"best-rank-agreement",agreementWeight:-.01}}])
    assert.throws(()=>buildBlindPlan(f.db,manifest,{models:ENSEMBLE_MODELS,topK:3,...options}));
});

test("ensemble blind preparation preserves named candidate mixes as distinct exact-source listening pairs",t=>{
  const f=v2Fixture(t),north=f.manifest.items.find(item=>item.track.identityKey==="v2:c:3:0"),south=f.manifest.items.find(item=>item.track.identityKey==="v2:c:3:3");
  north.track.artist=south.track.artist="Versioned artist";north.track.title="Track (North Remix)";north.track.mixVersion="North Remix";
  south.track.title="Track (South Remix)";south.track.mixVersion="South Remix";
  const p=preparedEnsemblePlan(f),group=p.groups.find(group=>group.anchor.identityKey==="v2:a:3");
  const mixes=group.candidates.filter(candidate=>[north.track.identityKey,south.track.identityKey].includes(candidate.track.identityKey));
  assert.equal(mixes.length,2);assert.notEqual(mixes[0].clipId,mixes[1].clipId);
  assert.deepEqual(new Set(mixes.map(candidate=>candidate.track.mixVersion)),new Set(["North Remix","South Remix"]));
  f.service.create(p);const visible=f.service.get(p.batchId).batch.groups.find(group=>group.anchor.identityKey==="v2:a:3");
  assert.deepEqual(new Set(visible.items.filter(item=>item.candidate.artist==="Versioned artist").map(item=>item.candidate.title)),new Set(["Track (North Remix)","Track (South Remix)"]));
});

test("ensemble publication rejects changed source clips and model evidence before creating listening sessions",t=>{
  const f=v2Fixture(t),baseline=preparedEnsemblePlan(f);
  for(const corrupt of [
    p=>{p.clips[p.groups[0].anchorClip].start++;},
    p=>{p.clips[p.groups[0].candidates[0].clipId].sourceSha256=hash("changed-audio");},
    p=>{p.clips[p.groups[0].candidates[0].clipId].wavSha256="unverified";}
  ]){const changed=structuredClone(baseline);corrupt(changed);assert.throws(()=>f.service.create(changed),/source|prepared/i);}
  const spec=analysisSpec(V2_MODELS[1]),artifact=f.db.prepare(`SELECT a.artifact_key,a.result_json FROM sonic_analysis_link l JOIN sonic_analysis_artifact a USING(artifact_key)
    WHERE l.identity_key=? AND l.spec_key=?`).get(baseline.groups[0].anchor.identityKey,spec.key),result=JSON.parse(artifact.result_json);
  result.revision="changed-revision";f.db.prepare("UPDATE sonic_analysis_artifact SET result_json=? WHERE artifact_key=?").run(JSON.stringify(result),artifact.artifact_key);
  assert.throws(()=>f.service.create(baseline),/stored model evidence/i);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_blind_review_batch").get().n,0);
  assert.equal(f.profileWrites(),0);
});

test("ensemble CLI preparation keeps all three strategy identities behind an explicit resumable round",()=>{
  const models=ENSEMBLE_MODELS.join(","),options=argumentsFor(["--round-id","ensemble-confirmation","--models",models,"--top-k","3","--dry-run"]);
  assert.deepEqual(options.models,ENSEMBLE_MODELS);assert.equal(options.roundId,"ensemble-confirmation");assert.equal(options.topK,3);assert.equal(options.dryRun,true);
  assert.throws(()=>argumentsFor(["--models",models,"--top-k","3"]),/round ID/i);
  for(const badModels of [ENSEMBLE_MODEL,`${V2_MODELS[0]},${ENSEMBLE_MODEL}`,`${models},effnet-control`])
    assert.throws(()=>argumentsFor(["--round-id","ensemble-confirmation","--models",badModels,"--top-k","3"]),/both v2 models|fixed top-k/i);
  assert.throws(()=>argumentsFor(["--round-id","ensemble-confirmation","--models",models,"--top-k","4"]),/fixed top-k/i);
});

test("ensemble preparation and publication reject stale profile source hashes and dimensions for either checkpoint",t=>{
  for(const analyzer of V2_MODELS)for(const field of ["source_sha256","dimensions"]){
    const f=v2Fixture(t),frozen=preparedEnsemblePlan(f),spec=analysisSpec(analyzer),key=field==="dimensions"?"v2:a:0":"v2:c:0:0";
    const changed=field==="dimensions"?spec.dimensions-1:hash(`stale-profile:${analyzer}`);
    f.db.prepare(`UPDATE track_sonic_profile SET ${field}=? WHERE identity_key=? AND model_version=?`).run(changed,key,spec.key);
    assert.throws(()=>preparedEnsemblePlan(f),undefined,`${analyzer} preparation must reject stale ${field}`);
    assert.throws(()=>f.service.create(frozen),undefined,`${analyzer} publication must reject stale ${field}`);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_blind_review_batch").get().n,0);
    assert.equal(f.profileWrites(),0);
  }
});

test("internally consistent fusion cannot publish altered actual model ranks instead of the stored top three",t=>{
  const f=v2Fixture(t),p=preparedEnsemblePlan(f),group=p.groups[0],strategy=p.strategies[ENSEMBLE_MODEL];
  const actual=group.candidates.flatMap(candidate=>candidate.nominations.filter(n=>n.analyzer===V2_MODELS[0])).sort((a,b)=>a.rank-b.rank);
  [actual[0].rank,actual[1].rank]=[actual[1].rank,actual[0].rank];
  [actual[0].similarity,actual[1].similarity]=[actual[1].similarity,actual[0].similarity];
  const template=structuredClone(group.candidates.flatMap(candidate=>candidate.nominations).find(n=>n.analyzer===ENSEMBLE_MODEL));
  for(const candidate of group.candidates)candidate.nominations=candidate.nominations.filter(n=>n.analyzer!==ENSEMBLE_MODEL);
  const replay=replayEnsembleGroup(p,group).candidates;
  for(const [index,candidate]of replay.entries())group.candidates.find(row=>row.track.identityKey===candidate.track.identityKey).nominations.push({
    ...template,strategyKey:strategy.strategyKey,identityKey:candidate.track.identityKey,rank:index+1,baseRankScore:candidate.baseRankScore,
    agreement:candidate.agreement,agreementBonus:candidate.agreementBonus,ensembleScore:candidate.ensembleScore,
    componentNominations:structuredClone(candidate.nominations)});
  for(const analyzer of ENSEMBLE_MODELS)assert.deepEqual(group.candidates.flatMap(candidate=>candidate.nominations.filter(n=>n.analyzer===analyzer).map(n=>n.rank)).sort((a,b)=>a-b),[1,2,3]);
  const virtual=group.candidates.flatMap(candidate=>candidate.nominations.filter(n=>n.analyzer===ENSEMBLE_MODEL)).sort((a,b)=>a.rank-b.rank);
  assert.deepEqual(virtual.map(n=>[n.identityKey,n.ensembleScore]),replay.map(candidate=>[candidate.track.identityKey,candidate.ensembleScore]),"supplied fusion is consistent, so the stored ranking must be the rejection reason");
  assert.throws(()=>f.service.create(p));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_blind_review_batch").get().n,0);
});

test("an exact frozen source identity cannot be relabeled as a different title or named mix",t=>{
  const f=v2Fixture(t),baseline=preparedEnsemblePlan(f);
  for(const corrupt of [
    p=>{p.groups[0].candidates[0].track.title="Different recording (Other Remix)";},
    p=>{p.groups[0].anchor.mixVersion="Other Named Remix";}
  ]){
    const changed=structuredClone(baseline);corrupt(changed);
    assert.throws(()=>f.service.create(changed),/descriptor|identity|version|mix/i);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_blind_review_batch").get().n,0);
  }
});
