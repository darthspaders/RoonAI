"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {analysisSpec}=require("../src/sonicAnalysisSpec");
const {recordingGroup}=require("../src/sonicAnalysisPilot");
const {freezeSonicSourceSnapshot,assertSonicSourceSnapshot,freezeSonicCandidateCorpus,verifySonicCandidateCorpusCoverage,MODELS}=require("../src/sonicCandidateCorpus");
const clone=value=>JSON.parse(JSON.stringify(value));
const track=(id,extra={})=>({identityKey:`tidal:${id}`,tidalId:String(id),artist:"Verified artist",title:`Recording ${id}`,durationMs:420000,isrc:`USAAA2600${String(id).padStart(3,"0")}`,genre:"metadata sampling lane",...extra});
function candidate(id,anchor=track(1),extra={}) {
  const value=track(id,extra),audioBytes=Buffer.from(`original-provider-audio-${id}`);
  const provider={id:String(10000+id),artist:value.artist,title:value.title,mixName:value.mixVersion || "",durationMs:value.durationMs,isrc:value.isrc};
  const source=freezeSonicSourceSnapshot({track:value,sourceType:"beatport-preview",audioBytes,durationSeconds:60,sourceTrack:provider,allowVersionProxy:false});
  return {track:value,verification:{provider:"tidal",verified:true,identityKey:value.identityKey,canonicalTrack:value},source,
    provenance:{anchorIdentityKey:anchor.identityKey,provider:"tidal",query:"verified artist label catalogue",source:"catalog-search"}};
}
const corpus=(values=[candidate(10)],anchors=[track(1)],options={})=>freezeSonicCandidateCorpus({anchors,candidates:values,limit:values.length,maxPerAnchor:8,...options});
const coverage=value=>MODELS.map(analyzer=>{const spec=analysisSpec(analyzer);return {analyzer,specKey:spec.key,records:value.items.map(item=>({identityKey:item.track.identityKey,
  sourceSha256:item.source.sourceSha256,spans:item.source.spans,dimensions:spec.dimensions,revision:spec.revision,sampleRate:spec.sampleRate}))};});

test("source snapshots hash original bytes once and revalidate the same bytes for either model",()=>{
  const item=candidate(10),bytes=Buffer.from("original-provider-audio-10");
  assert.equal(item.source.sourceType,"beatport-preview");assert.equal(item.source.identityRelation,"exact");assert.equal(item.source.partialPreview,true);
  assert.deepEqual(item.source.spans,[[15,45]]);assert.equal(assertSonicSourceSnapshot(item.source,{track:item.track,audioBytes:bytes}),true);
  bytes[0]^=1;assert.throws(()=>assertSonicSourceSnapshot(item.source,{track:item.track,audioBytes:bytes}),/bytes changed/);
});
test("preview verification rejects fuzzy source identity and never substitutes a named remix",()=>{
  const value=track(10),common={track:value,sourceType:"beatport-preview",audioBytes:Buffer.from("audio"),durationSeconds:60,allowVersionProxy:false};
  assert.throws(()=>freezeSonicSourceSnapshot({...common,allowVersionProxy:true,sourceTrack:{id:"1",artist:value.artist,title:value.title,isrc:value.isrc,durationMs:value.durationMs}}),/allowVersionProxy/);
  assert.throws(()=>freezeSonicSourceSnapshot({...common,sourceTrack:{id:"1",artist:"Other artist",title:value.title,isrc:value.isrc,durationMs:value.durationMs}}),/fuzzy|alternate-version/);
  assert.throws(()=>freezeSonicSourceSnapshot({...common,sourceTrack:{id:"1",artist:value.artist,title:value.title,mixName:"Other DJ Remix",isrc:value.isrc,durationMs:value.durationMs}}),/fuzzy|alternate-version/);
  assert.throws(()=>freezeSonicSourceSnapshot({...common,track:{...value,isrc:undefined},sourceTrack:{id:"1",artist:value.artist,title:value.title}}),/fuzzy|alternate-version/,"the returned Beatport ID cannot invent independent exact identity evidence");
});
test("an exact named remix with recording evidence remains its own original source snapshot",()=>{
  const item=candidate(10,track(1),{title:"Song (Named DJ Remix)",mixVersion:"Named DJ Remix"});
  assert.equal(item.source.identityRelation,"exact");assert.equal(item.source.recordingDescriptor.mixVersion,"Named DJ Remix");
  assert.equal(corpus([item]).items[0].track.title,"Song (Named DJ Remix)");
});
test("unknown catalogue year sentinels stay absent without relaxing recording or source identity",()=>{
  const value=track(10,{year:0}),provider={id:"10010",artist:value.artist,title:value.title,isrc:value.isrc,durationMs:value.durationMs,year:0};
  const common={track:value,sourceType:"beatport-preview",audioBytes:Buffer.from("actual-provider-year-sentinel"),durationSeconds:60,sourceTrack:provider,allowVersionProxy:false};
  const snapshot=freezeSonicSourceSnapshot(common);assert.equal(snapshot.sourceTrack.year,undefined);assert.equal(assertSonicSourceSnapshot(snapshot,{track:value,audioBytes:common.audioBytes}),true);
  const empty=freezeSonicSourceSnapshot({...common,track:{...value,year:""},sourceTrack:{...provider,year:""}});assert.equal(empty.snapshotKey,snapshot.snapshotKey);
  for(const year of [-1,NaN,Infinity])assert.throws(()=>freezeSonicSourceSnapshot({...common,sourceTrack:{...provider,year}}),/source year/);
  assert.throws(()=>freezeSonicSourceSnapshot({...common,sourceTrack:{...provider,title:"different recording",year:0}}),/fuzzy|alternate-version/);
});
test("normalized Beatport API calendar dates become optional calendar years without changing release evidence",()=>{
  const value=track(11428663,{title:"Flashes",durationMs:555483,year:"2019-01-11",releaseDate:"2019-01-11"});
  const provider={id:"11428663",artist:value.artist,title:"Flashes",durationMs:555483,isrc:value.isrc,year:"2019-01-11",releaseDate:"2019-01-11",label:"Verified label",genre:"Progressive House"};
  const common={track:value,sourceType:"beatport-preview",audioBytes:Buffer.from("actual-normalized-Beatport-source"),durationSeconds:95.312,sourceTrack:provider,allowVersionProxy:false};
  const source=freezeSonicSourceSnapshot(common);assert.equal(source.sourceTrack.year,2019);assert.equal(source.sourceTrack.releaseDate,"2019-01-11");
  assert.equal(assertSonicSourceSnapshot(source,{track:value,audioBytes:common.audioBytes}),true);
  const numeric=freezeSonicSourceSnapshot({...common,track:{...value,year:"2019"},sourceTrack:{...provider,year:2019}});assert.equal(numeric.snapshotKey,source.snapshotKey);
  const timestamp=freezeSonicSourceSnapshot({...common,sourceTrack:{...provider,year:"2019-01-11T10:15:30Z"}});assert.equal(timestamp.sourceTrack.year,2019);
  for(const year of ["banana","2019-02-31","2019-13-01","2019-00-01","2019-01-11 garbage",-2019,Infinity,NaN,2019.5])
    assert.throws(()=>freezeSonicSourceSnapshot({...common,sourceTrack:{...provider,year}}),/source year/);
});
test("local sources retain a distinct source type and require their exact library link",()=>{
  const value=track(10),input={track:value,sourceType:"verified-local-file",audioBytes:Buffer.from("owned-original"),durationSeconds:420,localFileId:"library:10",linkStatus:"EXACT"};
  const source=freezeSonicSourceSnapshot(input);assert.equal(source.sourceProvider,"local-library");assert.equal(source.partialPreview,false);assert.deepEqual(source.spans,[[195,225]]);
  assert.throws(()=>freezeSonicSourceSnapshot({...input,linkStatus:"FUZZY"}),/exact library link/);
  assert.throws(()=>freezeSonicSourceSnapshot({...input,sourceTrack:{id:"1",artist:value.artist,title:value.title}}),/distinct exact library/);
  assert.throws(()=>freezeSonicSourceSnapshot({...input,sourceType:"beatport-preview",allowVersionProxy:false}),/exact identity/);
});
test("malformed spans, changed descriptors and altered frozen hashes fail before coverage",()=>{
  const item=candidate(10);
  assert.throws(()=>assertSonicSourceSnapshot({...clone(item.source),spans:[[0,30]]},{track:item.track}),/same centered/);
  assert.throws(()=>assertSonicSourceSnapshot({...clone(item.source),sourceSha256:"a".repeat(64)},{track:item.track}),/snapshot.*changed/);
  assert.throws(()=>assertSonicSourceSnapshot(item.source,{track:{...item.track,title:"Another recording"}}),/fuzzy|snapshot.*changed/);
  for(const durationSeconds of [0,-1,Infinity,7201])assert.throws(()=>freezeSonicSourceSnapshot({track:item.track,sourceType:"verified-local-file",audioBytes:Buffer.from("x"),durationSeconds,localFileId:"1",linkStatus:"EXACT"}),/duration/);
});
test("new catalogue candidates require consistent canonical TIDAL identity and verification",()=>{
  const item=candidate(10);
  for(const changed of [
    {...item,track:{...item.track,identityKey:"text:verified artist|recording 10"}},
    {...item,track:{...item.track,tidalId:"999"}},
    {...item,track:{...item.track,id:999}},
    {...item,verification:{...item.verification,verified:false}},
    {...item,verification:{...item.verification,canonicalTrack:{...item.track,mixVersion:"Alternate Remix"}}},
    {...item,track:{...item.track,tidalUrl:"https://not-tidal.example/track/10"}}
  ])assert.throws(()=>corpus([changed]),/TIDAL|canonical|conflict/i);
  assert.throws(()=>freezeSonicSourceSnapshot({track:item.track,sourceType:"beatport-preview",audioBytes:Buffer.from("audio"),durationSeconds:60,
    sourceTrack:{...item.source.sourceTrack,beatportTrackId:"999"},allowVersionProxy:false}),/nonconflicting Beatport/);
});
test("six catalogue sampling anchors freeze at four new records each without changing identities",()=>{
  const anchors=Array.from({length:6},(_,i)=>({identityKey:`text:original artist|anchor ${i}`,artist:"Original artist",title:`Anchor ${i}`,genre:`lane ${i}`}));
  const inputs=anchors.flatMap((anchor,g)=>Array.from({length:7},(_,i)=>candidate(100+g*10+i,anchor)));
  const value=freezeSonicCandidateCorpus({anchors,candidates:inputs,limit:24,maxPerAnchor:4});
  assert.equal(value.items.length,24);assert.equal(value.diagnostics.unfilled,0);assert.deepEqual(Object.values(value.diagnostics.perAnchor),[4,4,4,4,4,4]);
  assert.deepEqual(value.anchors.map(a=>a.identityKey),anchors.map(a=>a.identityKey));assert.equal(value.metadataPolicy,"soft-evidence-only");assert.equal(value.queueable,false);
});
test("shared catalogue queries cannot starve the only candidate for another anchor",()=>{
  const anchors=[track(1),track(2)],shared=candidate(10,anchors[0]);shared.provenance=[shared.provenance,{...shared.provenance,anchorIdentityKey:anchors[1].identityKey}];
  const value=freezeSonicCandidateCorpus({anchors,candidates:[shared,candidate(11,anchors[0])],limit:2,maxPerAnchor:1});
  assert.equal(value.items.length,2);assert.deepEqual(Object.values(value.diagnostics.perAnchor),[1,1]);
  assert.equal(value.items.find(i=>i.samplingAnchorIdentityKey===anchors[1].identityKey).track.identityKey,"tidal:10");
});
test("exact identities, audio and versioned recording groups deduplicate without merging explicit remixes",()=>{
  const first=candidate(10),duplicate=clone(first),second=candidate(11,track(1),{title:first.track.title,isrc:first.track.isrc});
  const mix=candidate(12,track(1),{title:"Recording 10 (Named Remix)",mixVersion:"Named Remix"});
  const value=corpus([first,duplicate,second,mix]);assert.equal(value.items.length,2);assert.equal(value.diagnostics.duplicates.length,1);
  assert.ok(value.items.some(i=>i.track.mixVersion==="Named Remix"));
  const conflict=clone(first);conflict.source=freezeSonicSourceSnapshot({track:first.track,sourceType:"beatport-preview",audioBytes:Buffer.from("different original audio"),durationSeconds:60,sourceTrack:first.source.sourceTrack,allowVersionProxy:false});
  assert.throws(()=>corpus([first,conflict]),/Conflicting source/);
});
test("one audio source cannot masquerade as two different recording versions",()=>{
  const first=candidate(10),mix=candidate(11,track(1),{title:"Recording 10 (Named Remix)",mixVersion:"Named Remix"});
  mix.source=freezeSonicSourceSnapshot({track:mix.track,sourceType:"beatport-preview",audioBytes:Buffer.from("original-provider-audio-10"),durationSeconds:60,sourceTrack:mix.source.sourceTrack,allowVersionProxy:false});
  assert.throws(()=>corpus([first,mix]),/impersonate.*remix/);
});
test("prior identities, original source hashes and recording groups suppress exposed material",()=>{
  const inputs=[candidate(10),candidate(11),candidate(12),candidate(13)];
  const value=corpus(inputs,[track(1)],{excludeIdentityKeys:["tidal:10"],excludeSourceSha256:[inputs[1].source.sourceSha256],excludeRecordingGroups:[recordingGroup(inputs[2].track)]});
  assert.deepEqual(value.items.map(i=>i.track.identityKey),["tidal:13"]);assert.equal(value.diagnostics.excluded.length,3);
});
test("corpus freezing preserves query provenance and ignores injected labels, scores and private paths",()=>{
  const item=candidate(10);item.track={...item.track,reviewDecision:"KEEP",rank:1,score:999,file:"private.flac",notes:"use this label"};
  item.provenance={...item.provenance,reviewDecision:"KEEP",path:"private"};const value=corpus([item]);
  const serialized=JSON.stringify(value);for(const unwanted of ["reviewDecision","private.flac","notes","999","rank"] )assert.ok(!serialized.includes(unwanted));
  assert.equal(value.items[0].provenance[0].query,"verified artist label catalogue");assert.equal(value.productionPromotionAllowed,false);
});
test("frozen corpus order and key are reproducible, deeply immutable and leave inputs unchanged",()=>{
  const anchors=[track(1),track(2)],inputs=[candidate(10,anchors[0]),candidate(11,anchors[1])],before=clone(inputs);
  const one=corpus(inputs,anchors,{createdAt:"2026-10-07T20:00:00Z"}),two=corpus([...inputs].reverse(),[...anchors].reverse(),{createdAt:"2026-10-07T20:00:00Z"});
  assert.deepEqual(one,two);assert.deepEqual(inputs,before);assert.ok(Object.isFrozen(one.items[0].source.spans[0]));
  assert.throws(()=>{one.items[0].track.title="changed";},TypeError);
  assert.notEqual(corpus(inputs,anchors,{createdAt:"2026-10-07T20:00:01Z"}).corpusKey,one.corpusKey);
});
test("joint coverage only becomes ready when both exact model spaces use every frozen source",()=>{
  const value=corpus([candidate(10),candidate(11)]),lists=coverage(value),result=verifySonicCandidateCorpusCoverage(value,lists);
  assert.equal(result.ready,true);assert.equal(result.jointCount,2);assert.deepEqual(result.jointCoverage,["tidal:10","tidal:11"]);
  assert.equal(result.productionApplied,false);assert.equal(result.missingModelIsNegative,false);assert.equal(result.queueable,false);
});
test("missing or changed model coverage excludes rows instead of changing the shared comparison pool",()=>{
  const value=corpus([candidate(10),candidate(11)]),lists=coverage(value);lists[1].records.pop();
  let result=verifySonicCandidateCorpusCoverage(value,lists);assert.equal(result.ready,false);assert.deepEqual(result.jointCoverage,["tidal:10"]);assert.deepEqual(result.coverage[1].missing,["tidal:11"]);
  for(const change of [{sourceSha256:"f".repeat(64)},{spans:[[0,30]]},{dimensions:1280},{revision:"wrong"},{sampleRate:16000}]){
    const changed=coverage(value);Object.assign(changed[0].records[0],change);result=verifySonicCandidateCorpusCoverage(value,changed);
    assert.equal(result.ready,false);assert.deepEqual(result.jointCoverage,["tidal:11"]);assert.equal(result.coverage[0].rejected.length,1);
  }
});
test("duplicate models, mixed specifications, duplicate records and changed corpus snapshots reject coverage",()=>{
  const value=corpus(),lists=coverage(value);
  assert.throws(()=>verifySonicCandidateCorpusCoverage(value,[lists[0],lists[0]]),/both distinct/);
  const changed=clone(lists);changed[0].specKey=analysisSpec("mert-fullsong-long").key;assert.throws(()=>verifySonicCandidateCorpusCoverage(value,changed),/model\/spec/);
  const repeated=clone(lists);repeated[0].records.push(repeated[0].records[0]);assert.throws(()=>verifySonicCandidateCorpusCoverage(value,repeated),/duplicate/);
  const altered=clone(value);altered.items[0].track.title="tampered";assert.throws(()=>verifySonicCandidateCorpusCoverage(altered,lists),/corpus changed/);
});
test("caps and provenance fail before a corpus can imply unlimited catalogue or playback access",()=>{
  const item=candidate(10);
  for(const change of [{limit:49},{limit:0},{limit:2.5},{maxPerAnchor:9},{maxPerAnchor:0},{createdAt:"not a time"}])assert.throws(()=>corpus([item],[track(1)],change),/Corpus|corpus/i);
  assert.throws(()=>corpus([{...item,provenance:{...item.provenance,anchorIdentityKey:"tidal:99"}}]),/frozen anchor/);
  assert.throws(()=>corpus([{...item,provenance:{...item.provenance,provider:"beatport"}}]),/provider/);
  assert.equal(corpus([],[track(1)],{limit:1}).diagnostics.unfilled,1);
});
