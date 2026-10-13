"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{createHash}=require("node:crypto");
const {analysisSpec}=require("../src/sonicAnalysisSpec");
const {recordingGroup}=require("../src/sonicAnalysisPilot");
const {publicTrack}=require("../src/sonicEnsembleEvaluation");
const {freezeSonicSourceSnapshot,freezeSonicCandidateCorpus}=require("../src/sonicCandidateCorpus");
const {buildCatalogReviewPlan}=require("../src/sonicCatalogReview");
const {createPrivateResultReceipt,evaluateAnchorExperiment}=require("../src/sonicAnchorExperiment");
const {REFERENCE_DIAGNOSTIC_RECIPE,buildReferenceDiagnosticCorpus,evaluateReferenceDiagnostic,referenceDiagnosticMarkdown}=require("../src/sonicReferenceDiagnostic");
const MODELS=["mert-fullsong","mert-30s"],ANCHORS=["tidal:91463750","tidal:355413959"],ADDITIONS=["tidal:62582289","tidal:62582288"];
const clone=value=>structuredClone(value),hash=value=>createHash("sha256").update(String(value)).digest("hex");
function vector(a,b,c=0) {const out=Array(1024).fill(0),norm=Math.hypot(a,b,c);out[0]=a/norm;out[1]=b/norm;out[2]=c/norm;return out;}
function fixture() {
  const original=Array.from({length:200},(_,i)=>{
    const id=i<2?ANCHORS[i]:`tidal:${1000+i}`,title=i===0?"Interlude":i===1?"Infinity":`Original ${i}`,
      artist=i===0?"Blazy, Aura Vortex":i===1?"S.P.L Project":`Artist ${i}`;
    const track={identityKey:id,tidalId:id.slice(6),artist,title,mixVersion:"",album:title,durationMs:420000,isrc:`USAAA${i}`,genre:i<2?"Psy-Trance":"Electronic",
      analysisLocal:{sha256:hash(`local-${i}`),localFileId:i+1,file:`Z:\\private-${i}.flac`}};
    return {track,recordingGroup:recordingGroup(track)};
  });
  const manifest={createdAt:"frozen-original-pilot",items:original},matrices=new Map(MODELS.map(analyzer=>[analyzer,{spec:analysisSpec(analyzer),records:new Map(original.map((item,i)=>[item.track.identityKey,
    {vector:i===0?vector(1,0):i===1?vector(0,1):vector(.7,.6,.3+i/600),evidence:{sourceSha256:item.track.analysisLocal.sha256,spans:[[15,45]]}}]))}]));
  const catalogAnchors=[original[0].track,original[1].track,...original.slice(2,6).map(item=>item.track)],all=new Map();
  function candidate(id,anchor,extra={}) {
    const track={identityKey:`tidal:${id}`,tidalId:String(id),artist:`Catalog artist ${id}`,title:`Catalog ${id}`,mixVersion:"Original Mix",album:`Catalog album ${id}`,
      durationMs:360000,isrc:`GBKQU${id}`,genre:anchor.genre,...extra};
    const source=freezeSonicSourceSnapshot({track,sourceType:"beatport-preview",audioBytes:Buffer.from(`exact-original-preview-${id}`),durationSeconds:60,
      sourceTrack:{id:String(id+100000),artist:track.artist,title:track.title,mixName:track.mixVersion,isrc:track.isrc,durationMs:track.durationMs},allowVersionProxy:false});
    const item={track,verification:{provider:"tidal",verified:true,identityKey:track.identityKey,canonicalTrack:clone(track)},source,
      provenance:{anchorIdentityKey:anchor.identityKey,provider:"tidal",query:"bounded catalog query",source:"frozen-catalog-sampling"}};
    all.set(track.identityKey,item);return item;
  }
  const candidates=catalogAnchors.flatMap((anchor,g)=>Array.from({length:4},(_,i)=>{
    const id=g===0&&i===0?392687743:g===0&&i===1?348255917:g===0&&i===2?439728233:500000000+g*10+i;
    const extra=id===392687743?{artist:"Art Of Trance",title:"Octopus",mixVersion:"3 Of Life & Domestic Remix"}:id===348255917?{title:"Sun Chaser"}:id===439728233?{title:"Australiens (Ryanosaurus Remix)",mixVersion:""}:{};
    return candidate(id,anchor,extra);
  }));
  const baseCorpus=freezeSonicCandidateCorpus({anchors:catalogAnchors,candidates,limit:24,maxPerAnchor:4});
  candidate(62582289,original[0].track,{artist:"Aura Vortex, Blazy",title:"Nuke",genre:undefined});
  candidate(62582288,original[0].track,{artist:"Aura Vortex",title:"Activation",genre:undefined});
  candidate(409182258,original[1].track,{artist:"S.P.L Project",title:"Human Intellect (Goa Trance DJ Mixed)",mixVersion:""});
  const anchorInput=track=>{const raw=publicTrack(track),clip={start:15,end:45,sourceSha256:track.analysisLocal.sha256,sourceFile:track.analysisLocal.file,localFileId:track.analysisLocal.localFileId,wavSha256:hash("prepared-WAV")};
    clip.clipId=hash(JSON.stringify([clip.sourceSha256,clip.start,clip.end,"pcm_s16le-mono-24000-v1"]));return {track:raw,clip,origin:{batchId:"blind:prior",sessionId:`prior:${track.identityKey}`}};};
  const reference=(key,anchor)=>{const item=all.get(key),same=ADDITIONS.includes(key)||key==="tidal:409182258";return {track:item.track,verification:item.verification,source:item.source,sourceFile:`private-${key}.audio`,
    selection:{kind:same?"same-artist":"broad-psy",source:same?"artist-catalog-search":"frozen-catalog-sampling",query:"frozen provider query",anchorIdentityKey:anchor.identityKey}};};
  const sets=[["tidal:392687743",...ADDITIONS,"tidal:348255917"],["tidal:392687743","tidal:409182258","tidal:439728233","tidal:348255917"]];
  const referencePlan=buildCatalogReviewPlan({roundId:"diagnostic-fixture",groups:original.slice(0,2).map((item,g)=>({anchor:anchorInput(item.track),references:sets[g].map(key=>reference(key,item.track))}))});
  const expandedCorpus=buildReferenceDiagnosticCorpus(baseCorpus,referencePlan),receipts=new Map(),privateResults=new Map();
  for(const item of expandedCorpus.items) for(const analyzer of MODELS) {
    const spec=analysisSpec(analyzer),key=item.track.identityKey,
      vec=key===ADDITIONS[0]?vector(.999,.02,.01):key===ADDITIONS[1]?vector(.998,.03,.01):key==="tidal:392687743"?vector(.9,.35,.25):vector(.4,.5,.6);
    const result={specKey:spec.key,revision:spec.revision,sampleRate:spec.sampleRate,vector:vec,audioDurationSeconds:60,analyzedSeconds:30,sourceCoverage:.5,segments:[{start:15,end:45,vector:[...vec]}]};
    receipts.set(`${key}|${analyzer}`,createPrivateResultReceipt(result,spec,item.source));privateResults.set(`${key}|${analyzer}`,result);
  }
  const development=original.slice(0,2).map(item=>({anchor:publicTrack(item.track),batchId:"blind:old",pairs:[{identityKey:original[9].track.identityKey,decision:"WRONG_LANE"}]}));
  const snapshot={manifest,matrices,development,heldOut:original.slice(10,16).map(item=>publicTrack(item.track)),exposure:{pairs:2,anchorCount:2}};
  const baselineReport=evaluateAnchorExperiment(snapshot,{corpus:baseCorpus,privateResults,fitOptions:REFERENCE_DIAGNOSTIC_RECIPE.fitOptions});
  baselineReport.fitRecipe={options:clone(REFERENCE_DIAGNOSTIC_RECIPE.fitOptions),declaredBeforeFirstReplay:true};
  const reviews=referencePlan.groups.flatMap(group=>group.candidates.map((item,index)=>({sessionId:group.sessionId,index,status:"REVIEWED",
    review:{reviewer:"human",listened:true,decision:item.track.identityKey==="tidal:392687743"||group.anchor.identityKey===ANCHORS[0]&&ADDITIONS.includes(item.track.identityKey)?"KEEP":"WRONG_LANE",note:"Actual human fixture judgment"}})));
  const input={baseCorpus,expandedCorpus,receipts,referencePlan,reviews,baselineReport};return {snapshot,input,all};
}
const rankedOnly=report=>report.anchors.map(group=>({anchor:group.anchor,models:group.models.map(model=>({analyzer:model.analyzer,
  variants:Object.fromEntries(Object.entries(model.variants).map(([key,value])=>[key,{...value,shortlistJudgments:undefined,
    shortlist:value.shortlist.map(({judgment,...row})=>row),references:value.references.map(({judgment,...row})=>row)}]))}))}));

test("exact expanded corpus appends only declared accepted sources and never invents missing genre",()=>{
  const f=fixture(),before=clone(f.input.baseCorpus),corpus=buildReferenceDiagnosticCorpus(f.input.baseCorpus,f.input.referencePlan);
  assert.equal(corpus.items.length,26);assert.deepEqual(corpus.items.slice(0,24),f.input.baseCorpus.items);assert.deepEqual(f.input.baseCorpus,before);
  assert.deepEqual(corpus.items.slice(24).map(item=>item.track.identityKey),ADDITIONS);assert.ok(corpus.items.slice(24).every(item=>item.track.genre===undefined));
  assert.equal(buildReferenceDiagnosticCorpus(f.input.baseCorpus,f.input.referencePlan).corpusKey,corpus.corpusKey);assert.ok(Object.isFrozen(corpus.items[25].source));
});
test("diagnostic preserves caps, records all eight exact pairs and distinguishes absence from unselected retrieval",()=>{
  const f=fixture(),before=clone(f),report=evaluateReferenceDiagnostic(f.snapshot,f.input);assert.deepEqual(f,before);
  assert.equal(report.referencePairs,8);assert.equal(report.coverage.modelReceipts,52);assert.equal(report.heldOutEvaluated,false);assert.equal(report.preservedHeldOutCount,6);
  for(const group of report.anchors)for(const model of group.models)for(const [name,variant]of Object.entries(model.variants)) {
    assert.equal(variant.poolCount,name==="baseline224"?224:226);assert.equal(variant.shortlist.length,3);assert.ok(variant.retrievedCount<=30);assert.equal(variant.references.length,4);
    for(const row of variant.references){if(row.poolMember){assert.ok(Number.isInteger(row.rawRank));assert.ok(Number.isFinite(row.rawSimilarity));assert.ok(Number.isFinite(row.rawTop20Margin));}
      else {assert.equal(row.rawRank,null);assert.equal(row.fitScore,null);assert.equal(row.fittedRank,null);assert.equal(row.selected,false);}}
  }
  const interlude=report.anchors.find(group=>group.anchor.identityKey===ANCHORS[0]),infinity=report.anchors.find(group=>group.anchor.identityKey===ANCHORS[1]);
  for(const model of interlude.models)for(const id of ADDITIONS) {
    const old=model.variants.baseline224.references.find(row=>row.track.identityKey===id),next=model.variants.expanded226.references.find(row=>row.track.identityKey===id);
    assert.equal(old.status,"not-in-pool");assert.equal(next.judgment.decision,"KEEP");assert.equal(next.selected,true);assert.equal(next.fit.metadata.style.available,false);
  }
  for(const model of infinity.models){const absent=model.variants.expanded226.references.find(row=>row.track.identityKey==="tidal:409182258");assert.equal(absent.status,"not-in-pool");assert.equal(absent.fit,null);}
  assert.equal(report.productionPromotionAllowed,false);assert.doesNotMatch(JSON.stringify(report),/sourceFile|analysisLocal|private-|vector|keepRateAmongJudged/);
});
test("changed human and prior labels cannot influence rank, retrieval, fit components or final selection",()=>{
  const f=fixture(),first=evaluateReferenceDiagnostic(f.snapshot,f.input),changed=clone(f);
  changed.input.reviews.forEach(item=>{item.review.decision=item.review.decision==="KEEP"?"WRONG_LANE":"KEEP";item.review.note="Changed label only";});
  changed.snapshot.development.forEach(group=>group.pairs.forEach(pair=>pair.decision="KEEP"));
  const second=evaluateReferenceDiagnostic(changed.snapshot,changed.input);assert.deepEqual(rankedOnly(first),rankedOnly(second));
  assert.notDeepEqual(first.anchors[0].models[0].variants.expanded226.shortlistJudgments,second.anchors[0].models[0].variants.expanded226.shortlistJudgments);
});
test("new Interlude accepts never become Infinity labels; displacement includes unknown outcomes",()=>{
  const f=fixture(),item=f.input.expandedCorpus.items.find(item=>item.track.identityKey===ADDITIONS[0]);
  for(const analyzer of MODELS) {const key=`${ADDITIONS[0]}|${analyzer}`,result=clone(f.input.receipts.get(key).result);result.vector=vector(0,1);result.segments[0].vector=[...result.vector];
    f.input.receipts.set(key,createPrivateResultReceipt(result,analysisSpec(analyzer),item.source));}
  const report=evaluateReferenceDiagnostic(f.snapshot,f.input);
  const infinity=report.anchors.find(group=>group.anchor.identityKey===ANCHORS[1]);
  for(const model of infinity.models) {const selected=model.variants.expanded226.shortlist.find(row=>row.track.identityKey===ADDITIONS[0]);
    assert.ok(selected,"the fixture makes Nuke enter Infinity's final3");assert.equal(selected.judgment.decision,"UNJUDGED");assert.ok(model.displacement.addedUnjudged>=1);}
  assert.equal(report.reviewLabelsUsedForRanking,false);assert.equal(report.globalTasteUsed,false);
});
test("represented accepted references outside bounded retrieval keep raw evidence and null fitted values",()=>{
  const f=fixture(),item=f.input.expandedCorpus.items.find(item=>item.track.identityKey===ADDITIONS[0]);
  for(const analyzer of MODELS) {const key=`${ADDITIONS[0]}|${analyzer}`,result=clone(f.input.receipts.get(key).result);result.vector=vector(0,0,1);result.segments[0].vector=[...result.vector];
    f.input.receipts.set(key,createPrivateResultReceipt(result,analysisSpec(analyzer),item.source));}
  const report=evaluateReferenceDiagnostic(f.snapshot,f.input),interlude=report.anchors.find(group=>group.anchor.identityKey===ANCHORS[0]);
  for(const model of interlude.models) {const row=model.variants.expanded226.references.find(row=>row.track.identityKey===ADDITIONS[0]);
    assert.equal(row.poolMember,true);assert.equal(row.status,"outside-bounded-retrieval");assert.ok(row.rawRank>20);assert.equal(row.rawSimilarity,0);
    assert.equal(row.fittedRank,null);assert.equal(row.fitScore,null);assert.equal(row.fit,null);assert.equal(row.selected,false);assert.equal(row.judgment.decision,"KEEP");}
});
test("missing model receipt, cross-source swaps, changed spans and coherently replaced results fail closed",()=>{
  for(const mutate of [
    f=>f.input.receipts.delete(`${ADDITIONS[0]}|${MODELS[0]}`),
    f=>{const key=`${ADDITIONS[0]}|${MODELS[0]}`,other=f.input.receipts.get(`${ADDITIONS[1]}|${MODELS[0]}`);f.input.receipts.set(key,other);},
    f=>{const receipt=f.input.receipts.get(`${ADDITIONS[0]}|${MODELS[0]}`);receipt.result.segments[0].start=14;receipt.resultSha256=hash(JSON.stringify(receipt.result));},
    f=>{const receipt=f.input.receipts.get(`${ADDITIONS[0]}|${MODELS[0]}`);receipt.result.vector[0]=.9;},
    f=>{const receipt=f.input.receipts.get(`${ADDITIONS[0]}|${MODELS[0]}`);receipt.revision="changed";},
    f=>{const receipt=f.input.receipts.get(`${ADDITIONS[0]}|${MODELS[0]}`);receipt.result.segments[0].start+=.000001;receipt.result.segments[0].end+=.000001;receipt.resultSha256=hash(JSON.stringify(receipt.result));}
  ]) {const f=clone(fixture());mutate(f);assert.throws(()=>evaluateReferenceDiagnostic(f.snapshot,f.input));}
});
test("model/source/descriptor drift or altered saved baseline cannot be accepted as the frozen comparison",()=>{
  for(const mutate of [
    f=>{f.snapshot.matrices.get(MODELS[0]).records.get(ANCHORS[0]).evidence.sourceSha256=hash("changed");},
    f=>{f.snapshot.matrices.get(MODELS[1]).spec={...analysisSpec(MODELS[1]),revision:"changed"};},
    f=>{f.snapshot.manifest.items[0].track.title="Relabeled anchor";},
    f=>{f.input.expandedCorpus.items[24].track.genre="Psy-Trance";},
    f=>{f.input.baselineReport.development[0].models[0].fitted.retrievedCandidates[0].rank=99;},
    f=>{f.input.baselineReport.fitRecipe.options.branchLimit=9;},
    f=>{f.snapshot.heldOut.pop();}
  ]) {const f=clone(fixture());mutate(f);assert.throws(()=>evaluateReferenceDiagnostic(f.snapshot,f.input));}
});
test("incomplete, fabricated or swapped human judgments cannot produce diagnostic outcomes",()=>{
  for(const mutate of [f=>f.input.reviews.pop(),f=>f.input.reviews[0].review.reviewer="assistant",f=>f.input.reviews[0].review.listened=false,
    f=>f.input.reviews[0].status="PENDING",f=>f.input.reviews[0].index=99,f=>f.input.reviews[0]=clone(f.input.reviews[1])]) {
    const f=clone(fixture());mutate(f);assert.throws(()=>evaluateReferenceDiagnostic(f.snapshot,f.input));
  }
});
test("Markdown reports recorded rows and explicit development limits without private paths",()=>{
  const f=fixture(),report=evaluateReferenceDiagnostic(f.snapshot,f.input),markdown=referenceDiagnosticMarkdown(report);
  assert.match(markdown,/Interlude/);assert.match(markdown,/Infinity/);assert.match(markdown,/not-in-pool/);assert.match(markdown,/baseline224/);assert.match(markdown,/expanded226/);
  assert.match(markdown,/UNJUDGED replacements/);assert.doesNotMatch(markdown,/private-|Z:\\|sourceFile/);
});
