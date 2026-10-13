"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite"),{createHash}=require("node:crypto");
const {analysisSpec}=require("../src/sonicAnalysisSpec");
const {encodeVector}=require("../src/sonicEmbeddingStore");
const {MODELS,readCompletedBatch,readModelMatrix,storedRankings,summarizeShortlist,protectedState,evaluateSonicEnsemble}=require("../src/sonicEnsembleEvaluation");
const {argumentsFor,markdown,main}=require("../scripts/sonic-evaluate-ensemble");
const hash=value=>createHash("sha256").update(String(value)).digest("hex");

function fixture(t,decisionFor=()=>"KEEP") {
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  db.exec(`CREATE TABLE sonic_blind_review_batch(batch_id TEXT,private_plan_json TEXT);
    CREATE TABLE sonic_review_session_item(session_id TEXT,item_index INTEGER,candidate_identity_key TEXT,status TEXT,review_json TEXT);
    CREATE TABLE sonic_analysis_pilot(manifest_json TEXT);
    CREATE TABLE sonic_analysis_link(identity_key TEXT,spec_key TEXT,artifact_key TEXT);
    CREATE TABLE sonic_analysis_artifact(artifact_key TEXT,spec_key TEXT,source_sha256 TEXT,result_json TEXT);
    CREATE TABLE track_sonic_profile(identity_key TEXT,model TEXT,model_version TEXT,embedding_base64 TEXT,dimensions INTEGER,source_sha256 TEXT);`);
  for(const table of ["taste_feedback","sonic_neighbor_feedback","sonic_anchor_profile","sonic_review_session","sonic_review_session_audit","sonic_coverage_work"]){
    db.exec(`CREATE TABLE ${table}(marker TEXT)`);db.prepare(`INSERT INTO ${table} VALUES(?)`).run(`preserve:${table}`);
  }
  const anchors=Array.from({length:6},(_,g)=>({lane:"progressive house",rating:"love",track:{identityKey:`tidal:a:${g}`,artist:`Anchor artist ${g}`,
    title:`Anchor ${g} (Original Mix)`,mixVersion:"Original Mix",tidalId:String(100+g),genre:"Progressive House",durationMs:240000,
    analysisLocal:{sha256:hash(`anchor:${g}`),file:`Z:\\private-anchor-${g}.flac`}}}));
  const candidates=anchors.flatMap((anchor,g)=>Array.from({length:4},(_,i)=>({lane:"progressive house",rating:i===3?"love":"skip",
    track:{identityKey:`tidal:c:${g}:${i}`,artist:`Candidate artist ${g}:${i}`,title:`Candidate ${g}:${i} (Original Mix)`,mixVersion:"Original Mix",
      tidalId:String(200+g*4+i),genre:"Progressive House",durationMs:240000,label:"Fixture Label",year:2025,
      analysisLocal:{sha256:hash(`candidate:${g}:${i}`),file:`Z:\\private-candidate-${g}-${i}.flac`}}})));
  const manifest={createdAt:"frozen-ensemble-fixture",items:[...anchors,...candidates]};
  for(const analyzer of MODELS){const spec=analysisSpec(analyzer);for(const item of manifest.items){
    const parts=item.track.identityKey.split(":"),g=Number(parts[2]),vector=Array(spec.dimensions).fill(0);
    if(parts[1]==="a")vector[g]=1;
    else {
      const i=Number(parts[3]),top=analyzer==="mert-fullsong"?[0,1,2]:[0,1,3],rank=top.indexOf(i),score=rank<0?.2:.95-rank*.05;
      vector[g]=score;vector[6+g*4+i]=Math.sqrt(1-score**2);
    }
    const artifactKey=`${analyzer}:${item.track.identityKey}`,source=item.track.analysisLocal.sha256;
    db.prepare("INSERT INTO sonic_analysis_artifact VALUES(?,?,?,?)").run(artifactKey,spec.key,source,
      JSON.stringify({specKey:spec.key,revision:spec.revision,sampleRate:spec.sampleRate,segments:[{start:15,end:45}]}));
    db.prepare("INSERT INTO sonic_analysis_link VALUES(?,?,?)").run(item.track.identityKey,spec.key,artifactKey);
    db.prepare("INSERT INTO track_sonic_profile VALUES(?,?,?,?,?,?)").run(item.track.identityKey,spec.repo,spec.key,encodeVector(vector),spec.dimensions,source);
  }}
  const matrices=new Map(MODELS.map(analyzer=>[analyzer,readModelMatrix(db,manifest,analyzer)])),clips={};
  const clipFor=track=>{const clipId=hash(`clip:${track.identityKey}`);clips[clipId]={sourceSha256:track.analysisLocal.sha256,start:15,end:45,sourceFile:track.analysisLocal.file};return clipId;};
  const groups=anchors.map((item,g)=>{
    const lists=storedRankings(manifest,matrices,item.track,3),union=new Map();
    for(const list of lists)for(const candidate of list.candidates){
      if(!union.has(candidate.track.identityKey))union.set(candidate.track.identityKey,{track:candidate.track,
        clipId:clipFor(manifest.items.find(item=>item.track.identityKey===candidate.track.identityKey).track),nominations:[]});
      union.get(candidate.track.identityKey).nominations.push({analyzer:list.analyzer,specKey:list.specKey,identityKey:candidate.track.identityKey,rank:candidate.rank,similarity:candidate.similarity});
    }
    return {sessionId:`fixture:${g}`,anchor:item.track,anchorClip:clipFor(item.track),lane:item.lane,candidates:[...union.values()]};
  });
  const plan={version:2,batchId:"blind:ensemble-fixture",models:MODELS,evaluationTopK:3,count:24,groups,clips,preparationRequest:{manifestCreatedAt:manifest.createdAt}};
  db.prepare("INSERT INTO sonic_blind_review_batch VALUES(?,?)").run(plan.batchId,JSON.stringify(plan));
  db.prepare("INSERT INTO sonic_analysis_pilot VALUES(?)").run(JSON.stringify(manifest));
  for(const group of groups)for(const [index,candidate]of group.candidates.entries()){
    const decision=decisionFor(candidate.track.identityKey,index);
    db.prepare("INSERT INTO sonic_review_session_item VALUES(?,?,?,?,?)").run(group.sessionId,index,candidate.track.identityKey,"REVIEWED",JSON.stringify({decision,reviewer:"human",listened:decision!=="UNSURE"}));
  }
  db.exec("PRAGMA query_only=ON");
  const change=fn=>{db.exec("PRAGMA query_only=OFF");try{fn();}finally{db.exec("PRAGMA query_only=ON");}};
  return {db,manifest,matrices,plan,change};
}

test("completed six-anchor replay recomputes exact frozen nominations and leaves all protected rows unchanged",t=>{
  const f=fixture(t),before=protectedState(f.db);
  const report=evaluateSonicEnsemble(f.db,{batchId:f.plan.batchId});
  assert.equal(report.source.anchorCount,6);assert.equal(report.source.retrievalTopK,3);assert.equal(report.source.recomputedFrozenNominationsMatch,true);
  for(const id of MODELS){const row=report.summary.find(row=>row.id===id);assert.equal(row.requested,18);assert.equal(row.returned,18);assert.equal(row.kept,18);}
  assert.deepEqual(protectedState(f.db),before);assert.equal(report.productionApplied,false);assert.equal(report.productionPromotionAllowed,false);
  assert.equal(report.isolation.protectedDatabaseUnchanged,true);assert.equal(report.isolation.reviewLabelsUsedForScoring,false);
  assert.equal(report.isolation.playbackStarted,false);assert.equal(report.isolation.inferenceStarted,false);
  assert.throws(()=>f.db.prepare("UPDATE taste_feedback SET marker='changed'").run(),/readonly|read.only/i);
  assert.doesNotMatch(JSON.stringify(report),/sourceFile|embedding_base64|private-anchor|private-candidate/);
  for(const item of f.manifest.items)assert.ok(!JSON.stringify(report).includes(item.track.analysisLocal.sha256),"audio hashes must stay private");
  const exported=markdown(report);assert.match(exported,/MERT-v2 shadow ensemble test/);assert.match(exported,/\| FullSong \| 18\/18 \|/);
  for(let g=0;g<6;g++)assert.ok(exported.includes(`Anchor artist ${g}`),"all six anchors must reach the readable export");
});

test("changing human decisions changes reported outcomes but cannot change retrieval or fused shortlists",t=>{
  const accepted=fixture(t),rejected=fixture(t,()=>"WRONG_LANE");
  const a=evaluateSonicEnsemble(accepted.db,{batchId:accepted.plan.batchId}),b=evaluateSonicEnsemble(rejected.db,{batchId:rejected.plan.batchId});
  const selections=report=>report.anchors.map(anchor=>Object.fromEntries(Object.entries(anchor.results).map(([id,result])=>[id,result.candidates.map(candidate=>candidate.track.identityKey)])));
  assert.deepEqual(selections(a),selections(b));
  assert.equal(a.summary.find(row=>row.id===MODELS[0]).kept,18);assert.equal(b.summary.find(row=>row.id===MODELS[0]).kept,0);
  assert.equal(b.summary.find(row=>row.id===MODELS[0]).wrongLane,18);
});

test("incomplete judgments, nonhuman decisions and missing frozen pilots withhold attribution",t=>{
  const f=fixture(t);
  for(const mutation of [
    ()=>f.db.prepare("UPDATE sonic_review_session_item SET status='PENDING' WHERE session_id='fixture:0' AND item_index=0").run(),
    ()=>f.db.prepare("UPDATE sonic_review_session_item SET status='REVIEWED',review_json=? WHERE session_id='fixture:0' AND item_index=0").run(JSON.stringify({decision:"KEEP",reviewer:"assistant",listened:true}))
  ]){f.change(mutation);assert.throws(()=>readCompletedBatch(f.db,f.plan.batchId));}
  f.change(()=>{f.db.prepare("UPDATE sonic_review_session_item SET review_json=? WHERE session_id='fixture:0' AND item_index=0").run(JSON.stringify({decision:"KEEP",reviewer:"human",listened:true}));
    f.db.prepare("INSERT INTO sonic_analysis_pilot VALUES(?)").run(JSON.stringify(f.manifest));});
  assert.throws(()=>readCompletedBatch(f.db,f.plan.batchId),/Frozen source pilot missing or ambiguous/);
});

test("a completed saved judgment cannot be reassigned to a different frozen candidate identity",t=>{
  const f=fixture(t);
  f.change(()=>f.db.prepare("UPDATE sonic_review_session_item SET candidate_identity_key=? WHERE session_id='fixture:0' AND item_index=0").run("tidal:unrelated-recording"));
  const before=protectedState(f.db);
  assert.throws(()=>readCompletedBatch(f.db,f.plan.batchId),/Saved review candidate identity differs/);
  assert.throws(()=>evaluateSonicEnsemble(f.db,{batchId:f.plan.batchId}),/Saved review candidate identity differs/);
  assert.deepEqual(protectedState(f.db),before);
});

test("changed profile audio evidence and changed embedding rankings cannot substitute unjudged candidates",t=>{
  const f=fixture(t),spec=analysisSpec(MODELS[0]);
  f.change(()=>f.db.prepare("UPDATE track_sonic_profile SET source_sha256=? WHERE identity_key='tidal:c:0:0' AND model_version=?").run(hash("changed-source"),spec.key));
  const matrix=readModelMatrix(f.db,f.manifest,MODELS[0]);
  assert.equal(matrix.missingCount,1);assert.ok(matrix.rejected.some(row=>row.identityKey==="tidal:c:0:0"));
  assert.throws(()=>evaluateSonicEnsemble(f.db,{batchId:f.plan.batchId}));
  const ranking=fixture(t),vector=Array(spec.dimensions).fill(0);vector[100]=1;
  ranking.change(()=>ranking.db.prepare("UPDATE track_sonic_profile SET embedding_base64=? WHERE identity_key='tidal:c:0:0' AND model_version=?").run(encodeVector(vector),spec.key));
  assert.throws(()=>evaluateSonicEnsemble(ranking.db,{batchId:ranking.plan.batchId}),/Recomputed top-k|Frozen similarity/);
});

test("retrieval ranks ignore global taste labels and preserve source/self recording exclusions",t=>{
  const f=fixture(t),anchor=f.manifest.items[0].track,first=storedRankings(f.manifest,f.matrices,anchor,3);
  const changed=structuredClone(f.manifest);for(const item of changed.items)item.rating=item.rating==="love"?"skip":"love";
  assert.deepEqual(storedRankings(changed,f.matrices,anchor,3),first);
  const related=structuredClone(f.manifest);related.items.find(item=>item.track.identityKey==="tidal:c:0:0").recordingGroup="anchor-recording";related.items[0].recordingGroup="anchor-recording";
  const filtered=storedRankings(related,f.matrices,anchor,3);
  assert.ok(filtered.every(list=>list.candidates.every(candidate=>candidate.track.identityKey!==anchor.identityKey&&candidate.track.identityKey!=="tidal:c:0:0")));
});

test("aliases cannot transfer a conflicting listening label onto a shortlisted identity",t=>{
  const labels=new Map([["canonical",{decision:"KEEP"}],["alias",{decision:"WRONG_LANE"}]]);
  assert.throws(()=>summarizeShortlist([{track:{identityKey:"canonical"},nominations:[{identityKey:"alias"}]}],labels,3),/conflict/i);
  assert.throws(()=>summarizeShortlist([{track:{identityKey:"unknown"},nominations:[]}],labels,3),/unjudged/);
  const f=fixture(t,(_key,index)=>index===1?"WRONG_LANE":"KEEP"),changed=structuredClone(f.plan),group=changed.groups[0];
  group.candidates[1].nominations[0].identityKey=group.candidates[0].track.identityKey;
  f.change(()=>f.db.prepare("UPDATE sonic_blind_review_batch SET private_plan_json=? WHERE batch_id=?").run(JSON.stringify(changed),f.plan.batchId));
  assert.throws(()=>readCompletedBatch(f.db,f.plan.batchId),/conflict/i);
});

test("uncertain and unfilled slots remain explicit and do not enter keep-rate denominators",()=>{
  const labels=new Map([["kept",{decision:"KEEP"}],["unsure",{decision:"UNSURE"}]]);
  const result=summarizeShortlist([{track:{identityKey:"kept"}},{track:{identityKey:"unsure"}}],labels,3);
  assert.equal(result.returned,2);assert.equal(result.unfilled,1);assert.equal(result.judged,1);assert.equal(result.unjudged,1);
  assert.equal(result.kept,1);assert.equal(result.keepRate,1);assert.equal(result.wrongLane,0);
});

test("evaluation CLI rejects malformed arguments and unsafe output paths before touching taste files",()=>{
  assert.deepEqual(argumentsFor(["--batch-id","blind:test","--output","data/new-report"]),{"--batch-id":"blind:test","--output":"data/new-report"});
  for(const args of [[],["--batch-id"],["--unknown","x"],["--batch-id","x","--batch-id","y"],["--batch-id","--output"]])assert.throws(()=>argumentsFor(args));
  for(const output of ["data","../outside-output",process.cwd()])assert.throws(()=>main(["--batch-id","blind:test","--output",output]),/fresh directory inside/);
});
