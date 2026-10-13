"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createHash}=require("node:crypto");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {analysisSpec}=require("../src/sonicAnalysisSpec");
const {fuseSonicRankings}=require("../src/sonicEnsemble");
const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const MODELS=["mert-fullsong","mert-30s"];
const ANCHOR={identityKey:"tidal:anchor",artist:"Anchor artist",title:"Anchor (Original Mix)",mixVersion:"Original Mix"};
const evidence=(source="anchor",spans=[[15,45]])=>({sourceSha256:hash(source),spans});
function candidate(key,rank,overrides={}) {
  return {track:{identityKey:key,artist:`Artist ${key}`,title:`Track ${key}`,mixVersion:"",...overrides.track},rank,
    similarity:overrides.similarity??.9,evidence:overrides.evidence??evidence(key)};
}
function list(analyzer,candidates=[],overrides={}) {
  return {analyzer,specKey:analysisSpec(analyzer).key,status:candidates.length?"available":"missing-candidates",anchorEvidence:evidence(),candidates,...overrides};
}
function input(full=[],short=[],overrides={}) {
  return {anchor:{...ANCHOR},lists:[list(MODELS[0],full),list(MODELS[1],short)],...overrides};
}
const scores=output=>output.candidates.map(c=>({key:c.track.identityKey,base:c.baseRankScore,bonus:c.agreementBonus,score:c.ensembleScore,agreement:c.agreement}));
function freeze(value) {
  if(value&&typeof value==="object"){Object.freeze(value);for(const item of Object.values(value))freeze(item);}
  return value;
}

test("rank fusion keeps a fixed three-slot shortlist from a six-pick union and remains shadow-only",()=>{
  const result=fuseSonicRankings(input([candidate("a",1),candidate("b",2),candidate("c",3)],[candidate("d",1),candidate("e",2),candidate("f",3)]));
  assert.equal(result.candidates.length,3);assert.equal(result.unionCandidates.length,6);
  assert.deepEqual(result.candidates.map(c=>c.track.identityKey),["a","d","b"]);
  assert.equal(result.diagnostics.mode,"shadow");assert.equal(result.diagnostics.productionApplied,false);
  assert.ok(result.unionCandidates.every(c=>c.shadowOnly===true&&c.queueable===false));
  assert.equal(fuseSonicRankings(input([candidate("a",1)],[candidate("b",1)],{count:1})).candidates.length,1);
});

test("agreement receives only the configured capped bonus and cannot displace stronger single-model picks",()=>{
  const result=fuseSonicRankings(input([candidate("a",1),candidate("shared",2)],[candidate("d",1),candidate("shared",2)],{agreementWeight:.1}));
  assert.deepEqual(result.candidates.map(c=>c.track.identityKey),["a","d","shared"]);
  const shared=result.candidates[2];assert.equal(shared.baseRankScore,.5);assert.equal(shared.agreementBonus,.1);assert.equal(shared.ensembleScore,.6);
  assert.equal(shared.nominations.length,2);assert.ok(shared.agreement);
  assert.ok(result.unionCandidates.every(c=>c.agreementBonus>=0&&c.agreementBonus<=.1));
  assert.throws(()=>fuseSonicRankings(input([],[],{agreementWeight:.100001})),/agreement|weight|bonus/i);
});

test("best-rank fusion preserves an asymmetric first choice rather than averaging its ranks",()=>{
  const result=fuseSonicRankings(input([candidate("shared",1)],[candidate("shared",10)]));
  assert.equal(result.candidates[0].baseRankScore,1);assert.equal(result.candidates[0].agreementBonus,.05);
  assert.equal(result.candidates[0].ensembleScore,1.05);
});

test("cosine magnitudes are provenance only and cannot change rank-fusion decisions or scores",()=>{
  const original=input([candidate("a",1,{similarity:-1}),candidate("b",2,{similarity:1})],[candidate("c",1,{similarity:-.99})]);
  const changed=structuredClone(original);
  for(const model of changed.lists)for(const row of model.candidates)row.similarity=-row.similarity;
  assert.deepEqual(scores(fuseSonicRankings(original)),scores(fuseSonicRankings(changed)));
  assert.deepEqual(scores(fuseSonicRankings(original)).map(c=>c.base),[1,1,.5]);
});

test("reciprocal-rank fusion sums rank evidence without adding another agreement bonus",()=>{
  const result=fuseSonicRankings(input([candidate("a",1),candidate("shared",2)],[candidate("d",1),candidate("shared",2)],{method:"rrf",agreementWeight:.1,rrfK:60}));
  assert.equal(result.candidates[0].track.identityKey,"shared");
  assert.equal(result.candidates[0].baseRankScore,2/62);assert.equal(result.candidates[0].ensembleScore,2/62);
  assert.ok(result.unionCandidates.every(c=>c.agreementBonus===0));
});

test("missing model coverage falls back to the available ranks without inventing disagreement or negatives",()=>{
  for(const status of ["missing-anchor","missing-candidates"]){
    const missing=list(MODELS[1],[],{status});delete missing.anchorEvidence;
    const result=fuseSonicRankings({anchor:ANCHOR,lists:[list(MODELS[0],[candidate("a",1),candidate("b",2),candidate("c",3)]),missing]});
    assert.deepEqual(result.candidates.map(c=>c.track.identityKey),["a","b","c"]);
    assert.deepEqual(result.candidates.map(c=>c.ensembleScore),[1,.5,1/3]);
    assert.ok(result.candidates.every(c=>c.agreement===false&&c.agreementBonus===0&&c.nominations.length===1));
    assert.ok(result.diagnostics.missingModels.some(model=>model.analyzer===MODELS[1]&&model.status===status));assert.equal(result.diagnostics.anchorEvidenceMatched,false);
  }
});

test("repeated votes from one model retain only its best rank and cannot inflate agreement",()=>{
  const result=fuseSonicRankings(input([candidate("a",4),candidate("a",1),candidate("b",2)],[candidate("a",3)]));
  const row=result.unionCandidates.find(c=>c.track.identityKey==="a");
  assert.equal(row.nominations.length,2);assert.equal(row.nominations.find(n=>n.analyzer===MODELS[0]).rank,1);
  assert.equal(row.baseRankScore,1);assert.equal(row.agreementBonus,.05);
  const single=fuseSonicRankings(input([candidate("a",1),candidate("a",1)],[]));
  assert.equal(single.candidates[0].nominations.length,1);assert.equal(single.candidates[0].agreement,false);assert.equal(single.candidates[0].agreementBonus,0);
});

test("a unanimous candidate with conflicting source hashes is excluded from both models",()=>{
  const result=fuseSonicRankings(input([candidate("conflict",1),candidate("a",2)],[candidate("conflict",1,{evidence:evidence("other-source")}),candidate("b",2)]));
  assert.deepEqual(result.candidates.map(c=>c.track.identityKey),["a","b"]);
  assert.ok(result.diagnostics.provenanceConflicts.some(c=>c.identityKey==="conflict"&&c.reason==="candidate-source-conflict"));
  assert.ok(result.candidates.every(c=>c.agreementBonus===0));
});

test("conflicting excerpt spans and conflicting duplicate rows fail closed before agreement scoring",()=>{
  const spanConflict=fuseSonicRankings(input([candidate("a",1)],[candidate("a",1,{evidence:evidence("a",[[16,46]])})]));
  assert.equal(spanConflict.candidates.length,0);
  assert.ok(spanConflict.diagnostics.provenanceConflicts.some(c=>c.identityKey==="a"&&c.reason==="candidate-span-conflict"));
  const duplicateConflict=fuseSonicRankings(input([candidate("a",1),candidate("a",2,{evidence:evidence("changed")})],[candidate("a",1)]));
  assert.equal(duplicateConflict.candidates.length,0);
  assert.ok(duplicateConflict.diagnostics.provenanceConflicts.some(c=>c.identityKey==="a"&&c.reason==="candidate-source-conflict"));
});

test("different anchor audio disables agreement while preserving explicitly diagnosed rank-only picks",()=>{
  const request=input([candidate("a",1)],[candidate("a",2)]);request.lists[1].anchorEvidence=evidence("different-anchor");
  const result=fuseSonicRankings(request);
  assert.equal(result.diagnostics.anchorEvidenceMatched,false);assert.equal(result.candidates[0].baseRankScore,1);
  assert.equal(result.candidates[0].agreement,false);assert.equal(result.candidates[0].agreementBonus,0);assert.equal(result.candidates[0].ensembleScore,1);
});

test("RRF rejects mismatched anchor sources or spans while a missing model retains one rank vote",()=>{
  for(const anchorEvidence of [evidence("different-anchor"),evidence("anchor",[[16,46]])]){
    const request=input([candidate("a",1)],[candidate("b",1)],{method:"rrf"});request.lists[1].anchorEvidence=anchorEvidence;
    assert.throws(()=>fuseSonicRankings(request),/anchor|provenance/i);
  }
  const result=fuseSonicRankings(input([candidate("a",1)],[],{method:"rrf"}));
  assert.equal(result.candidates[0].ensembleScore,1/61);assert.equal(result.candidates[0].agreementBonus,0);
});

test("verified aliases of the same exact excerpt merge once and preserve both nominated source identities",()=>{
  const track={artist:"Same Artist",title:"Same Track (Original Mix)",mixVersion:"Original Mix"},shared=evidence("same-audio");
  const result=fuseSonicRankings(input([candidate("tidal:1",1,{track,evidence:shared})],[candidate("local:2",2,{track,evidence:shared})]));
  assert.equal(result.unionCandidates.length,1);assert.equal(result.candidates[0].nominations.length,2);assert.equal(result.candidates[0].agreement,true);
  assert.deepEqual(new Set(result.candidates[0].nominations.map(n=>n.identityKey)),new Set(["tidal:1","local:2"]));
});

test("named remixes and explicit mix versions remain distinct even when source evidence looks shared",()=>{
  const shared=evidence("shared-audio"),artist="Versioned Artist";
  for(const tracks of [
    [{artist,title:"Song (North Remix)",mixVersion:"North Remix"},{artist,title:"Song (South Remix)",mixVersion:"South Remix"}],
    [{artist,title:"Song",mixVersion:"Original Mix"},{artist,title:"Song",mixVersion:"Extended Mix"}]
  ]){
    const result=fuseSonicRankings(input([candidate("edition:1",1,{track:tracks[0],evidence:shared})],[candidate("edition:2",1,{track:tracks[1],evidence:shared})]));
    assert.equal(result.unionCandidates.length,2);assert.ok(result.candidates.every(c=>c.agreement===false&&c.nominations.length===1));
  }
});

test("self identities and exact-source aliases cannot become recommendations, while other mixes survive",()=>{
  const result=fuseSonicRankings(input([candidate(ANCHOR.identityKey,1),candidate("self-alias",2,{evidence:evidence()})],
    [candidate("new-remix",1,{track:{artist:ANCHOR.artist,title:"Anchor (Another Remix)",mixVersion:"Another Remix"}})]));
  assert.deepEqual(result.candidates.map(c=>c.track.identityKey),["new-remix"]);assert.equal(result.diagnostics.excludedSelfCount,2);
});

test("invalid options and nonexact analyzer provenance are rejected instead of entering the ensemble",()=>{
  const baseline=input([candidate("a",1)],[candidate("b",1)]);
  for(const options of [{count:0},{count:51},{count:1.5},{count:"3"},{method:"cosine-mean"},{agreementWeight:-.01},{agreementWeight:NaN},{rrfK:0},{rrfK:1001},{rrfK:1.5}])
    assert.throws(()=>fuseSonicRankings({...baseline,...options}));
  for(const change of [
    x=>{x.lists[0].analyzer="effnet-control";},
    x=>{x.lists[0].specKey=analysisSpec(MODELS[1]).key;},
    x=>{x.lists[1].analyzer=x.lists[0].analyzer;x.lists[1].specKey=x.lists[0].specKey;},
    x=>{x.lists[0].status="failed";},
    x=>{x.lists[0].status="missing-candidates";},
    x=>{delete x.lists[0].anchorEvidence;},
    x=>{x.lists[0].candidates=[];},
    x=>{x.anchor.identityKey="";}
  ]){const request=structuredClone(baseline);change(request);assert.throws(()=>fuseSonicRankings(request));}
});

test("invalid ranks, cosine values and audio provenance cannot silently influence a shortlist",()=>{
  for(const rank of [0,101,1.5,"1",NaN])assert.throws(()=>fuseSonicRankings(input([candidate("a",rank)],[])));
  for(const similarity of [-1.01,1.01,Infinity,NaN])assert.throws(()=>fuseSonicRankings(input([candidate("a",1,{similarity})],[])));
  for(const badEvidence of [{sourceSha256:"bad",spans:[[15,45]]},{sourceSha256:hash("a"),spans:[]},
    evidence("a",[[45,15]]),evidence("a",[[-1,29]]),evidence("a",[[15,Infinity]])])
    assert.throws(()=>fuseSonicRankings(input([candidate("a",1,{evidence:badEvidence})],[])));
  const tooMany=Array.from({length:101},(_,i)=>candidate(`a:${i}`,i+1));
  assert.throws(()=>fuseSonicRankings(input(tooMany,[])));
});

test("fusion is reproducible under list and candidate permutations and does not mutate frozen inputs",()=>{
  const shared={artist:"Same Artist",title:"Same Track",mixVersion:""},request=input(
    [candidate("tidal:1",2,{track:shared,evidence:evidence("shared")}),candidate("a",1),candidate("tidal:1",3,{track:shared,evidence:evidence("shared")})],
    [candidate("b",1),candidate("local:2",2,{track:shared,evidence:evidence("shared")})]);
  const original=structuredClone(request),first=fuseSonicRankings(freeze(request));
  assert.deepEqual(request,original);
  const permuted=structuredClone(original);permuted.lists.reverse();for(const model of permuted.lists)model.candidates.reverse();
  const second=fuseSonicRankings(freeze(permuted));
  assert.deepEqual(first.candidates,second.candidates);assert.deepEqual(first.unionCandidates,second.unionCandidates);
});

test("candidate output excludes private source evidence and paths from both shortlist and union",()=>{
  const row=candidate("a",1,{track:{sourceFile:"Z:\\private.flac",analysisLocal:{file:"Z:\\private.flac",sha256:hash("a")},secret:"private"}});
  const result=fuseSonicRankings(input([row],[candidate("a",2)]));
  assert.doesNotMatch(JSON.stringify([result.candidates,result.unionCandidates]),/sourceSha256|spans|sourceFile|analysisLocal|private\.flac|secret/);
});

test("no model coverage produces an explicit empty shadow result without labeling any pair",()=>{
  const result=fuseSonicRankings({anchor:ANCHOR,lists:[]});
  assert.deepEqual(result.candidates,[]);assert.deepEqual(result.unionCandidates,[]);
  assert.equal(result.diagnostics.reason,"no-available-models");assert.equal(result.diagnostics.agreementCount,0);
  assert.deepEqual(result.diagnostics.missingModels.map(model=>model.analyzer),MODELS);
  assert.equal(result.productionPromotionAllowed,false);assert.equal(result.diagnostics.productionApplied,false);
});

test("loading and running the pure merger requires no database, filesystem, network, timer or process integration",()=>{
  const dependencies=[],context={module:{exports:{}},require(id){dependencies.push(id);assert.equal(id,"./sonicAnalysisSpec");return {analysisSpec};},
    fetch(){throw Error("Network work is forbidden in pure rank fusion");},setTimeout(){throw Error("Timers are forbidden in pure rank fusion");},
    setInterval(){throw Error("Timers are forbidden in pure rank fusion");},process:undefined};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../src/sonicEnsemble.js"),"utf8"),context);
  const result=context.module.exports.fuseSonicRankings(input([candidate("a",1)],[candidate("b",1)]));
  assert.equal(result.candidates.length,2);assert.deepEqual(dependencies,["./sonicAnalysisSpec"]);
  assert.equal(result.diagnostics.productionApplied,false);
});
