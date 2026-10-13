"use strict";

// Pure private diagnostic. Callers supply frozen evidence; no filesystem,
// database, provider, scheduler, playback or production operations occur here.
const assert=require("node:assert/strict");
const {createHash}=require("node:crypto");
const {analysisSpec}=require("./sonicAnalysisSpec");
const {recordingGroup}=require("./sonicAnalysisPilot");
const {MODELS,publicTrack,storedRankings}=require("./sonicEnsembleEvaluation");
const {readPrivateResultReceipt,validateStoredResult}=require("./sonicAnchorExperiment");
const {assertSonicSourceSnapshot,verifySonicCandidateCorpusCoverage}=require("./sonicCandidateCorpus");
const {validateCatalogReviewPlan}=require("./sonicCatalogReview");
const {rankSonicAnchorFit}=require("./sonicAnchorFit");
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const freeze=value=>{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const ANCHORS=["tidal:91463750","tidal:355413959"],ADDITIONS=["tidal:62582289","tidal:62582288"];
const FIT_OPTIONS={rawTopK:20,branchLimit:10,finalCount:3};
const REFERENCE_DIAGNOSTIC_RECIPE=freeze({version:1,kind:"accepted-reference-rank-diagnostic",models:MODELS.map(id=>clone(analysisSpec(id))),
  anchorIdentityKeys:ANCHORS,addedIdentityKeys:ADDITIONS,sourcePools:{originalLocal:200,baselineCatalog:24,expandedCatalog:26,baseline:224,expanded:226},
  fitOptions:FIT_OPTIONS,anchorFitVersion:1,measuredAudioFeaturesUsed:false,labelsJoinedAfterRanking:true,heldOutEvaluated:false,
  productionApplied:false,productionPromotionAllowed:false});
function assertReferencePlan(plan) {
  validateCatalogReviewPlan(plan);
  assert.equal(plan.groups.length,2,"Use only the two completed reference anchors.");assert.equal(plan.count,8);
  assert.deepEqual(plan.groups.map(g=>g.anchor.identityKey).sort(),[...ANCHORS].sort());
  assert.ok(plan.groups.every(g=>g.candidates.length===4),"Require the original four reference pairs per anchor.");
}
function assertBaseCorpus(corpus) {
  assert.equal(corpus?.items?.length,24,"Preserve the original 24 catalog sources.");
  verifySonicCandidateCorpusCoverage(corpus,MODELS.map(analyzer=>({analyzer,specKey:analysisSpec(analyzer).key,records:[]})));
}
function buildReferenceDiagnosticCorpus(baseCorpus,referencePlan) {
  assertBaseCorpus(baseCorpus);assertReferencePlan(referencePlan);
  const group=referencePlan.groups.find(g=>g.anchor.identityKey===ANCHORS[0]);
  const additions=ADDITIONS.map(key=>{
    const candidate=group.candidates.find(c=>c.track.identityKey===key);assert.ok(candidate,"An exact declared added reference is missing.");
    const {track,reference}=candidate;
    assertSonicSourceSnapshot(reference.source,{track});assertSonicSourceSnapshot(reference.source,{track:reference.verification.canonicalTrack});
    assert.equal(track.mixVersion,"Original Mix","Keep the accepted exact original version.");
    assert.equal(reference.selection.kind,"same-artist");
    assert.ok(!baseCorpus.items.some(item=>item.track.identityKey===key||item.source.sourceSha256===reference.source.sourceSha256
      ||recordingGroup(item.track)===recordingGroup(track)||track.isrc&&item.track.isrc===track.isrc),"An added reference already exists in the baseline corpus.");
    return {track:clone(track),verification:clone(reference.verification),source:clone(reference.source),recordingGroup:recordingGroup(track),
      provenance:[{anchorIdentityKey:group.anchor.identityKey,provider:"tidal",query:reference.selection.query,source:reference.selection.source}],samplingAnchorIdentityKey:group.anchor.identityKey};
  });
  const body={version:1,kind:"accepted-reference-diagnostic-corpus",baseCorpusKey:baseCorpus.corpusKey,items:[...clone(baseCorpus.items),...additions]};
  return freeze({...body,corpusKey:`sonic-reference-corpus-v1-${digest(body)}`});
}
function descriptorMatch(expected,actual) {
  for(const key of ["identityKey","artist","title","mixVersion","album","durationMs","tidalId"]) assert.deepEqual(actual[key]??"",expected[key]??"","Reviewed exact recording descriptor changed.");
}
function assertOriginal(snapshot) {
  assert.equal(snapshot?.manifest?.items?.length,200,"Keep the original frozen 200-source pilot.");assert.ok(snapshot.matrices instanceof Map);
  assert.equal(new Set(snapshot.manifest.items.map(item=>item.track.identityKey)).size,200);
  assert.equal(snapshot.heldOut?.length,6,"Preserve the six reserved anchors.");
  assert.ok(snapshot.heldOut.every(track=>!ANCHORS.includes(track.identityKey)),"Reserved anchors cannot enter this diagnostic.");
  for(const analyzer of MODELS) {
    const spec=analysisSpec(analyzer),matrix=snapshot.matrices.get(analyzer);assert.deepEqual(matrix?.spec,spec,"Original model specification changed.");
    assert.equal(matrix.records.size,200,"Original model coverage changed.");
    for(const item of snapshot.manifest.items) {
      const record=matrix.records.get(item.track.identityKey),evidence=record?.evidence;
      assert.ok(record&&record.vector?.length===spec.dimensions&&Array.from(record.vector).every(Number.isFinite)
        &&Array.from(record.vector).some(value=>value!==0),"Invalid original model vector.");
      assert.equal(evidence?.sourceSha256,item.track.analysisLocal?.sha256,"Original model source changed.");
      assert.ok(/^[a-f0-9]{64}$/.test(evidence.sourceSha256)&&Array.isArray(evidence.spans)&&evidence.spans.length===1
        &&evidence.spans.every(span=>span.length===2&&span.every(Number.isFinite)&&span[0]>=0&&span[1]>span[0]&&span[1]-span[0]<=30.000002),"Original excerpt changed.");
    }
  }
  for(const item of snapshot.manifest.items) assert.deepEqual(snapshot.matrices.get(MODELS[0]).records.get(item.track.identityKey).evidence,
    snapshot.matrices.get(MODELS[1]).records.get(item.track.identityKey).evidence,"Original model source excerpts differ.");
}
function loadCatalogRecords(corpus,receipts) {
  assert.ok(receipts instanceof Map&&receipts.size===52,"Require exactly both-model receipts for all 26 catalog sources.");
  const records=new Map(MODELS.map(id=>[id,new Map()])),sources=new Set(),groups=new Set(),identities=new Set();
  for(const item of corpus.items) {
    assertSonicSourceSnapshot(item.source,{track:item.track});
    assertSonicSourceSnapshot(item.source,{track:item.verification?.canonicalTrack});
    assert.ok(item.verification?.provider==="tidal"&&item.verification.verified===true&&item.verification.identityKey===item.track.identityKey);
    assert.ok(!identities.has(item.track.identityKey)&&!sources.has(item.source.sourceSha256)&&!groups.has(recordingGroup(item.track)),"Duplicate expanded source or exact recording.");
    identities.add(item.track.identityKey);sources.add(item.source.sourceSha256);groups.add(recordingGroup(item.track));
    const actual=[];
    for(const analyzer of MODELS) {
      const spec=analysisSpec(analyzer),receipt=receipts.get(`${item.track.identityKey}|${analyzer}`);
      assert.ok(receipt,"Both models require every frozen catalog receipt.");
      const result=readPrivateResultReceipt(receipt,spec,item.source),record=validateStoredResult(result,spec,item.source);
      records.get(analyzer).set(item.track.identityKey,record);actual.push(record.evidence.actualSpans);
    }
    assert.deepEqual(actual[0],actual[1],"The two model receipts used different actual excerpts.");
  }
  return records;
}
function assertBaselineReplay(actual,saved) {
  assert.equal(saved?.analyzer,actual.analyzer);assert.equal(saved.specKey,actual.specKey);
  assert.deepEqual(actual.fitted.configuration,saved.fitted.configuration,"The original fit recipe changed.");
  for(const [a,b]of [[actual.baseline,saved.baseline],[actual.fitted.retrievedCandidates,saved.fitted.retrievedCandidates],[actual.fitted.shortlist,saved.fitted.shortlist]]) {
    assert.equal(a.length,b.length,"Frozen baseline retrieval changed.");
    for(let i=0;i<a.length;i++) {
      assert.deepEqual(a[i].track,b[i].track,"Frozen baseline descriptors or order changed.");assert.equal(a[i].rank,b[i].rank,"Frozen baseline raw rank changed.");
      assert.deepEqual(a[i].evidence,b[i].evidence,"Frozen baseline source evidence changed.");
      for(const key of ["similarity","fitAdjustment","fitScore"]) if(a[i][key]!==undefined) assert.ok(Number.isFinite(b[i][key])&&Math.abs(a[i][key]-b[i][key])<=1e-10,"Frozen baseline scores changed.");
      if(a[i].fit) {assert.deepEqual(a[i].fit,b[i].fit,"Frozen baseline fit components changed.");assert.deepEqual(a[i].retrieval,b[i].retrieval);}
    }
  }
}
function rankingSummary(list,fitted,group,poolCount,poolKeys) {
  assert.equal(fitted.diagnostics.measuredSignalPairsUsed,0,"Do not add measured features or label-derived signals to this fixed metadata recipe.");
  const cutoff=list.candidates[19],third=fitted.shortlist[2];assert.ok(cutoff&&third,"Require complete bounded raw and final-three shortlists.");
  const rows=fitted.retrievedCandidates,selected=new Set(fitted.shortlist.map(row=>row.track.identityKey));
  const compact=row=>({track:row.track,rawRank:row.rank,rawSimilarity:row.similarity,fitScore:row.fitScore,fitAdjustment:row.fitAdjustment,fit:row.fit,
    retrieval:row.retrieval,fittedRank:rows.findIndex(x=>x.track.identityKey===row.track.identityKey)+1});
  return {poolCount,rawCandidateCount:list.candidates.length,rawTopK:20,branchLimit:10,finalCount:3,retrievedCount:rows.length,
    rawTop20Cutoff:{identityKey:cutoff.track.identityKey,rawRank:cutoff.rank,rawSimilarity:cutoff.similarity},
    finalThreeCutoff:{identityKey:third.track.identityKey,fitScore:third.fitScore},shortlist:fitted.shortlist.map(compact),
    references:group.candidates.map(candidate=>{
      const key=candidate.track.identityKey,raw=list.candidates.find(row=>row.track.identityKey===key),row=rows.find(row=>row.track.identityKey===key),
        excluded=fitted.excluded.find(row=>row.track.identityKey===key);
      return {track:publicTrack(candidate.track),poolMember:poolKeys.has(key),status:!poolKeys.has(key)?"not-in-pool":row?"retrieved":excluded?"excluded":"outside-bounded-retrieval",
        rawRank:raw?.rank??null,rawSimilarity:raw?.similarity??null,rawTop20Margin:raw?raw.similarity-cutoff.similarity:null,
        retrieved:Boolean(row),retrieval:row?.retrieval??{rawTopK:false,metadataBranch:false,reasons:excluded?[excluded.reason]:[]},
        fittedRank:row?rows.indexOf(row)+1:null,fitScore:row?.fitScore??null,fitAdjustment:row?.fitAdjustment??null,fit:row?.fit??null,
        finalThreeMargin:row?row.fitScore-third.fitScore:null,selected:selected.has(key),
        evidence:raw?{sourceSha256:raw.evidence.sourceSha256,spans:clone(raw.evidence.spans)}:null};
    })};
}
function labelsAfterRanking(snapshot,referencePlan,reviews) {
  assert.ok(Array.isArray(reviews)&&reviews.length===8,"Require all eight completed human reference judgments.");
  const labels=new Map(ANCHORS.map(id=>[id,new Map()])),seen=new Set();
  for(const group of snapshot.development||[]) if(labels.has(group.anchor.identityKey)) for(const pair of group.pairs) {
    assert.ok(["KEEP","WRONG_LANE","SKIP","UNSURE"].includes(pair.decision));
    const map=labels.get(group.anchor.identityKey),prior=map.get(pair.identityKey);
    assert.ok(!prior||prior.decision===pair.decision,"Conflicting development labels.");map.set(pair.identityKey,{decision:pair.decision,labelSource:"prior-development"});
  }
  for(const saved of reviews) {
    const group=referencePlan.groups.find(g=>g.sessionId===saved.sessionId),candidate=group?.candidates[saved.index],key=`${saved.sessionId}|${saved.index}`;
    assert.ok(Number.isInteger(saved.index)&&candidate&&!seen.has(key),"A saved reference judgment changed its exact pair.");seen.add(key);
    assert.equal(saved.status,"REVIEWED");assert.equal(saved.review?.reviewer,"human");assert.equal(saved.review.listened,true);
    assert.ok(["KEEP","WRONG_LANE","SKIP","UNSURE"].includes(saved.review.decision));
    const map=labels.get(group.anchor.identityKey),prior=map.get(candidate.track.identityKey);
    assert.ok(!prior||prior.decision===saved.review.decision,"Conflicting exact reference judgments.");
    map.set(candidate.track.identityKey,{decision:saved.review.decision,labelSource:"completed-reference-review",note:String(saved.review.note||"")});
  }
  return labels;
}
function attachJudgments(variant,labels) {
  const annotate=row=>({...row,judgment:labels.get(row.track.identityKey)||{decision:"UNJUDGED",labelSource:null}});
  const shortlist=variant.shortlist.map(annotate),counts={KEEP:0,WRONG_LANE:0,SKIP:0,UNSURE:0,UNJUDGED:0};
  shortlist.forEach(row=>counts[row.judgment.decision]++);
  return {...variant,shortlist,shortlistJudgments:counts,references:variant.references.map(annotate)};
}
function evaluateReferenceDiagnostic(snapshot,input={}) {
  assert.ok(input&&typeof input==="object"&&Object.keys(input).every(key=>["baseCorpus","expandedCorpus","receipts","referencePlan","reviews","baselineReport"].includes(key)),"Invalid reference diagnostic inputs.");
  const {baseCorpus,expandedCorpus,receipts,referencePlan,baselineReport}=input;
  assertOriginal(snapshot);assertBaseCorpus(baseCorpus);assertReferencePlan(referencePlan);
  assert.deepEqual(expandedCorpus,buildReferenceDiagnosticCorpus(baseCorpus,referencePlan),"Expanded pool metadata, sources or declared membership changed.");
  assert.equal(baselineReport?.productionApplied,false);assert.equal(baselineReport.sourcePool.count,224);assert.equal(baselineReport.sourcePool.corpusKey,baseCorpus.corpusKey);
  assert.equal(baselineReport.sourcePool.manifestCreatedAt,snapshot.manifest.createdAt);assert.deepEqual(baselineReport.fitRecipe?.options,FIT_OPTIONS,"Use the sealed original fit recipe.");
  const catalogRecords=loadCatalogRecords(expandedCorpus,receipts),originalKeys=new Set(snapshot.manifest.items.map(item=>item.track.identityKey));
  for(const item of expandedCorpus.items) assert.ok(!originalKeys.has(item.track.identityKey)&&!snapshot.manifest.items.some(original=>original.track.analysisLocal.sha256===item.source.sourceSha256
    ||recordingGroup(original.track)===recordingGroup(item.track)||item.track.isrc&&original.track.isrc===item.track.isrc),"Catalog additions cannot duplicate an original recording.");
  const sourceByKey=new Map(expandedCorpus.items.map(item=>[item.track.identityKey,item.source]));
  const ranked=referencePlan.groups.map(group=>{
    const original=snapshot.manifest.items.find(item=>item.track.identityKey===group.anchor.identityKey);assert.ok(original);descriptorMatch(original.track,group.anchor);
    const anchor=publicTrack(original.track),clip=referencePlan.clips[group.anchorClip];
    for(const analyzer of MODELS) {const evidence=snapshot.matrices.get(analyzer).records.get(anchor.identityKey).evidence;
      assert.equal(evidence.sourceSha256,clip.sourceSha256);assert.deepEqual(evidence.spans,[[clip.start,clip.end]],"Reviewed anchor excerpt changed.");}
    for(const candidate of group.candidates) {const source=sourceByKey.get(candidate.track.identityKey);
      if(source) assert.deepEqual(source,candidate.reference.source,"A diagnostic source differs from the exact judged excerpt.");}
    return {anchor,models:MODELS.map(analyzer=>{
      const variants={};
      for(const [id,corpus]of [["baseline224",baseCorpus],["expanded226",expandedCorpus]]) {
        const manifest={...snapshot.manifest,items:[...snapshot.manifest.items,...corpus.items.map(item=>({track:publicTrack(item.track),recordingGroup:recordingGroup(item.track)}))]},
          matrices=new Map(MODELS.map(model=>[model,{spec:analysisSpec(model),records:new Map([...snapshot.matrices.get(model).records,...corpus.items.map(item=>[item.track.identityKey,catalogRecords.get(model).get(item.track.identityKey)])])}]));
        const list=storedRankings(manifest,matrices,anchor,manifest.items.length).find(list=>list.analyzer===analyzer);assert.equal(list.status,"available");
        for(const candidate of group.candidates) {const row=list.candidates.find(item=>item.track.identityKey===candidate.track.identityKey);
          if(row) {descriptorMatch(candidate.track,row.track);assert.equal(row.evidence.sourceSha256,candidate.reference.source.sourceSha256,"Ranked reference audio differs from its judged source.");
            assert.deepEqual(row.evidence.spans,candidate.reference.source.spans,"Ranked reference excerpt differs from its judged source.");}}
        const fitted=rankSonicAnchorFit({anchor,analyzer,specKey:list.specKey,anchorEvidence:list.anchorEvidence,candidates:list.candidates,options:FIT_OPTIONS});
        if(id==="baseline224") {const saved=baselineReport.development.find(row=>row.anchor.identityKey===anchor.identityKey)?.models.find(row=>row.analyzer===analyzer);
          assertBaselineReplay({analyzer,specKey:list.specKey,baseline:list.candidates.slice(0,3),fitted},saved);}
        variants[id]=rankingSummary(list,fitted,group,manifest.items.length,new Set(manifest.items.map(item=>item.track.identityKey)));
      }
      return {analyzer,specKey:analysisSpec(analyzer).key,variants};
    })};
  });
  // Human and older development labels become accessible only after every raw
  // ranking, retrieval decision, fit score and shortlist above is finalized.
  const labels=labelsAfterRanking(snapshot,referencePlan,input.reviews);
  const anchors=ranked.map(group=>({anchor:group.anchor,models:group.models.map(model=>{
    const map=labels.get(group.anchor.identityKey),variants=Object.fromEntries(Object.entries(model.variants).map(([key,value])=>[key,attachJudgments(value,map)]));
    const before=new Set(variants.baseline224.shortlist.map(row=>row.track.identityKey)),after=new Set(variants.expanded226.shortlist.map(row=>row.track.identityKey));
    const added=variants.expanded226.shortlist.filter(row=>!before.has(row.track.identityKey)),removed=variants.baseline224.shortlist.filter(row=>!after.has(row.track.identityKey));
    return {...model,variants,displacement:{added,removed,addedUnjudged:added.filter(row=>row.judgment.decision==="UNJUDGED").length,removedUnjudged:removed.filter(row=>row.judgment.decision==="UNJUDGED").length}};
  })}));
  return freeze({version:1,kind:REFERENCE_DIAGNOSTIC_RECIPE.kind,recipe:REFERENCE_DIAGNOSTIC_RECIPE,mode:"development-diagnostic",productionApplied:false,productionPromotionAllowed:false,
    reviewBatchId:referencePlan.batchId,referencePairs:8,coverage:{catalogSources:26,modelReceipts:52,bothModelCoverage:true,missingModelIsNegative:false},
    preservedHeldOutCount:6,heldOutEvaluated:false,reviewLabelsUsedForRanking:false,globalTasteUsed:false,anchors,
    limitations:["Only two already reviewed development anchors and a deliberately chosen reference set; no held-out quality or production claim.",
      "Final-three outcomes are partially judged. UNJUDGED replacements cannot be counted as successes or failures; no complete acceptance rate is reported.",
      "Absent sources have null ranks and scores. Outside bounded retrieval, fitted ranks and components remain unavailable; no forced extra selection occurs.",
      "Both pinned models retain centered thirty-second excerpts. Exact preview versus local-original source effects remain uncontrolled.",
      "New judgments are anchor-specific diagnostics, never genre truth, positive retrieval weights, tuning targets or global taste."]});
}
function referenceDiagnosticMarkdown(report) {
  const clean=value=>String(value??"—").replace(/[\r\n|]/g," "),lines=["# Accepted-reference rank diagnostic","",`Frozen224 versus expanded226; ${report.referencePairs} reference pairs, two development anchors. No production promotion or held-out claim.`,""];
  for(const group of report.anchors) for(const model of group.models) {
    lines.push(`## ${clean(group.anchor.title)} — ${model.analyzer}`,"","| Pool | Reference | Judgment | Raw rank | Retrieved | Fitted rank | Selected |","|---|---|---|---:|---|---:|---|");
    for(const [variant,rows]of Object.entries(model.variants)) for(const row of rows.references) lines.push(`| ${variant} | ${clean(row.track.title)} ${clean(row.track.mixVersion||"")} | ${row.judgment.decision} | ${clean(row.rawRank)} | ${row.status} | ${clean(row.fittedRank)} | ${row.selected?"yes":"no"} |`);
    lines.push("");
  }
  lines.push(...report.limitations.map(line=>`- ${line}`),"");return lines.join("\n");
}
module.exports={REFERENCE_DIAGNOSTIC_RECIPE,buildReferenceDiagnosticCorpus,evaluateReferenceDiagnostic,referenceDiagnosticMarkdown};
