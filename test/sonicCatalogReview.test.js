"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{createHash}=require("node:crypto");
const {DatabaseSync}=require("node:sqlite");
const {buildCatalogReviewPlan,validateCatalogReviewPlan,KIND,PURPOSE}=require("../src/sonicCatalogReview");
const {SonicBlindReview}=require("../src/sonicBlindReview");
const {SonicEmbeddingStore}=require("../src/sonicEmbeddingStore");
const {createSonicReviewSessionService}=require("../src/sonicReviewSessionService");
const {freezeSonicSourceSnapshot}=require("../src/sonicCandidateCorpus");
const clone=value=>JSON.parse(JSON.stringify(value)),hash=value=>createHash("sha256").update(value).digest("hex");
const clipId=clip=>hash(JSON.stringify([clip.sourceSha256,clip.start,clip.end,"pcm_s16le-mono-24000-v1"]));
const track=(id,extra={})=>({identityKey:`tidal:${id}`,tidalId:String(id),artist:`Artist ${id}`,title:`Track ${id}`,mixVersion:"Original Mix",album:"Album",durationMs:420000,isrc:`USAAA260${String(id).padStart(4,"0")}`,...extra});
function wav(seconds) {
  const samples=Math.round(seconds*24000),buffer=Buffer.alloc(44+samples*2);
  buffer.write("RIFF",0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write("WAVEfmt ",8);buffer.writeUInt32LE(16,16);
  buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(24000,24);buffer.writeUInt32LE(48000,28);
  buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write("data",36);buffer.writeUInt32LE(samples*2,40);
  return buffer;
}
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"sonic-catalog-review-"));
  const db=new DatabaseSync(":memory:");t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
  const embeddings=new SonicEmbeddingStore({enabled:false});Object.assign(embeddings,{enabled:true,db});embeddings.migrate();
  let profileWrites=0;
  const legacy=createSonicReviewSessionService({db,recommendationEngine:{saveSonicAnchorProfile(){profileWrites++;},analysisEvidenceFor(){throw Error("No analysis in reference review");}},logger:null});
  db.exec("CREATE TABLE taste_feedback(id INTEGER)");
  const service=new SonicBlindReview(db,{cacheDirectory:directory});
  const anchors=[1,2].map(id=>{
    const value=track(id);delete value.isrc;
    const clip={start:195,end:225,sourceSha256:hash(`local-original-${id}`),sourceFile:`Z:\\private\\anchor-${id}.flac`,localFileId:id};
    clip.clipId=clipId(clip);const bytes=wav(30);clip.wavSha256=hash(bytes);fs.writeFileSync(path.join(directory,`${clip.clipId}.wav`),bytes);
    return {track:value,clip,origin:{batchId:"blind:prior",sessionId:`prior:${id}`}};
  });
  const prior={version:2,batchId:"blind:prior",planKey:"prior-frozen",createdAt:"2026-10-01T00:00:00.000Z",title:"Earlier",
    groups:anchors.map(anchor=>({sessionId:anchor.origin.sessionId,anchor:anchor.track,anchorClip:anchor.clip.clipId,candidates:[]})),clips:Object.fromEntries(anchors.map(anchor=>[anchor.clip.clipId,anchor.clip]))};
  db.prepare("INSERT INTO sonic_blind_review_batch VALUES (?,?,?,?)").run(prior.batchId,prior.planKey,JSON.stringify(prior),prior.createdAt);
  function reference(id,anchor,extra={},kind="same-artist",durationSeconds=60) {
    const value=track(id,extra),bytes=Buffer.from(`frozen-exact-preview-${id}`),sourceFile=path.join(directory,`${id}.audio`);
    fs.writeFileSync(sourceFile,bytes);
    const source=freezeSonicSourceSnapshot({track:value,sourceType:"beatport-preview",audioBytes:bytes,durationSeconds,
      sourceTrack:{id:String(id+1000),artist:value.artist,title:value.title,mixName:value.mixVersion,isrc:value.isrc,durationMs:value.durationMs},allowVersionProxy:false});
    return {track:value,verification:{provider:"tidal",verified:true,identityKey:value.identityKey,canonicalTrack:clone(value)},source,sourceFile,
      selection:{kind,source:kind==="same-artist"?"artist-catalog-search":"frozen-catalog-sampling",query:"bounded exact catalog query",anchorIdentityKey:anchor.track.identityKey}};
  }
  const groups=anchors.map((anchor,i)=>({anchor,references:[reference(10+i*2,anchor),reference(11+i*2,anchor),reference(20,anchor,{},"broad-psy"),reference(21,anchor,{},"broad-psy")]}));
  const build=(input={})=>buildCatalogReviewPlan({roundId:"reference-test",title:"Reference listening",groups,...input});
  const prepare=plan=>{for(const clip of Object.values(plan.clips)){const bytes=wav(clip.end-clip.start);clip.wavSha256=hash(bytes);fs.writeFileSync(path.join(directory,`${clip.clipId}.wav`),bytes);}return plan;};
  return {db,directory,service,legacy,groups,build,prepare,reference,profileWrites:()=>profileWrites};
}
test("v4 freezes bounded shared references without inventing encoder nominations or mutating input",t=>{
  const f=fixture(t),before=clone(f.groups),p=f.build();
  assert.deepEqual(f.groups,before);assert.equal(p.version,4);assert.equal(p.kind,KIND);assert.deepEqual(p.models,[]);
  assert.equal(p.count,8);assert.equal(p.anchorCount,2);assert.equal(Object.keys(p.clips).length,8);
  assert.notEqual(p.planKey,f.build().planKey,"a distinct freeze has its own batch/session fingerprint");
  assert.equal(validateCatalogReviewPlan(p,{db:f.db}),true);
  assert.ok(p.groups.every(g=>g.purpose===PURPOSE&&g.candidates.length===4&&g.candidates.every(c=>c.nominations===undefined)));
  const changed=clone(f.groups);changed[0].references[0].selection.query="another declared catalog query";
  assert.notEqual(f.build({groups:changed}).planKey,p.planKey,"declared collection provenance is part of the frozen plan");
  for(const mutate of [q=>q.groups[0].candidates.reverse(),q=>q.groups[0].sessionId="sonic-review:changed",q=>q.batchId="blind:changed",q=>q.groups.reverse()]) {
    const changedPlan=clone(p);mutate(changedPlan);assert.throws(()=>validateCatalogReviewPlan(changedPlan),/plan identity changed/);
  }
});
test("named remix references remain separate exact recordings",t=>{
  const f=fixture(t),anchor=f.groups[0].anchor;
  const refs=[f.reference(30,anchor,{artist:"Artist",title:"Song",mixVersion:"Named One Remix"}),f.reference(31,anchor,{artist:"Artist",title:"Song",mixVersion:"Named Two Remix"})];
  const p=f.build({groups:[{anchor,references:refs}]});assert.equal(p.count,2);
  assert.deepEqual(p.groups[0].candidates.map(c=>c.track.mixVersion).sort(),["Named One Remix","Named Two Remix"]);
});
test("coverage requires bounded exact references and explicit collection provenance",t=>{
  const f=fixture(t);
  const bad=[()=>f.build({groups:[]}),()=>f.build({groups:Array(5).fill(f.groups[0])}),()=>f.build({groups:[{...f.groups[0],references:f.groups[0].references.slice(0,1)}]}),
    ()=>f.build({groups:[{...f.groups[0],references:Array(7).fill(f.groups[0].references[0])}]})];
  for(const make of bad)assert.throws(make);
  for(const mutate of [g=>g[0].references[0].verification.verified=false,g=>g[0].references[0].track.id=999,g=>g[0].references[0].source.allowVersionProxy=true,
    g=>g[0].references[0].track.mixVersion="Wrong Remix",g=>g[0].references[0].selection.anchorIdentityKey="other",g=>g[0].references[0].nominations=[{analyzer:"fake"}]]) {
    const groups=clone(f.groups);mutate(groups);assert.throws(()=>f.build({groups}));
  }
});
test("same identity, source or recording cannot duplicate or substitute an anchor",t=>{
  const f=fixture(t),first=f.groups[0],groups=clone(f.groups);
  groups[0].references[1]=clone(groups[0].references[0]);assert.throws(()=>f.build({groups}),/Duplicate reference/);
  const alias=f.reference(99,first.anchor,{artist:first.references[0].track.artist,title:first.references[0].track.title,mixVersion:first.references[0].track.mixVersion});
  assert.throws(()=>f.build({groups:[{...first,references:[first.references[0],alias]}]}),/Duplicate reference/);
  const self=f.reference(1,first.anchor,{...first.anchor.track,isrc:track(1).isrc});
  assert.throws(()=>f.build({groups:[{...first,references:[self,first.references[1]]}]}),/anchor recording/);
});
test("publication proves exact frozen anchor and source bytes and requires every prepared WAV atomically",t=>{
  const f=fixture(t),p=f.build();
  assert.throws(()=>f.service.create(p),/prepared/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);
  f.prepare(p);
  for(const mutate of [q=>q.groups[0].anchor.title="Relabeled",q=>q.groups[0].anchor.mixVersion="Wrong Remix",q=>q.groups[0].anchor.tidalId="999",
    q=>q.groups[0].anchorOrigin.sessionId="missing",q=>q.groups[0].candidates[0].nominations=[],q=>q.models.push("mert-fullsong")]) {
    const q=clone(p);mutate(q);assert.throws(()=>f.service.create(q));
  }
  const candidate=p.groups[0].candidates[0],file=p.clips[candidate.clipId].sourceFile,original=fs.readFileSync(file);fs.writeFileSync(file,Buffer.from("changed-original-bytes"));
  assert.throws(()=>f.service.create(p),/bytes|changed|unavailable/);fs.writeFileSync(file,original);
  const cacheFile=path.join(f.directory,`${candidate.clipId}.wav`),prepared=fs.readFileSync(cacheFile);prepared[100]^=1;fs.writeFileSync(cacheFile,prepared);
  assert.throws(()=>f.service.create(p),/WAV changed/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);
});
test("v4 public and legacy review paths omit source identities and excerpt offsets",t=>{
  const f=fixture(t),p=f.prepare(f.build()),result=f.service.create(p);
  assert.equal(result.batch.kind,KIND);assert.equal(result.batch.purpose,PURPOSE);assert.equal(result.batch.remaining,8);
  for(const g of result.batch.groups){assert.deepEqual(Object.keys(g.anchor).sort(),["album","artist","mixVersion","title"]);assert.equal(g.anchorAudio.start,0);assert.equal(g.anchorAudio.end,30);for(const item of g.items){assert.equal(item.audio.start,0);assert.equal(item.audio.end,30);assert.equal(item.candidate.identityKey,undefined);}}
  const outputs=[result,f.service.report(p.batchId),f.legacy.listReviewSessions(),...p.groups.flatMap(g=>[
    f.legacy.getReviewSession(g.sessionId,{includeDiagnostics:true,includeCurrent:true,includeAnchorContext:true}),f.legacy.getNextReviewItem(g.sessionId),f.legacy.getAssistantReviewContext(g.sessionId)])];
  for(const value of outputs)assert.doesNotMatch(JSON.stringify(value),/tidal:\d|tidalId":"\d|beatportId":"\d|sourceProvider|sourceFile|sourceSha256|wavSha256|isrc":"US|same-artist|broad-psy|selection|nominations/i);
  const rows=f.db.prepare("SELECT anchor_identity_key,anchor_json FROM sonic_review_session").all();assert.ok(rows.every(r=>r.anchor_identity_key.startsWith("blind-reference:")&&!r.anchor_json.includes("tidal")));
  assert.equal(f.profileWrites(),0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_neighbor_feedback").get().n,0);
});
test("v4 public durations remove source-coordinate rounding residue without changing the frozen span",t=>{
  const f=fixture(t),anchor=f.groups[0].anchor;
  const reference=f.reference(40,anchor,{},"same-artist",120.032653);
  const p=f.prepare(f.build({groups:[{anchor,references:[reference,f.groups[0].references[1]]}]}));
  const candidate=p.groups[0].candidates.find(c=>c.track.identityKey===reference.track.identityKey),clip=p.clips[candidate.clipId];
  assert.deepEqual([clip.start,clip.end],[45.016327,75.016327]);assert.notEqual(clip.end-clip.start,30);
  const result=f.service.create(p),index=p.groups[0].candidates.indexOf(candidate),audio=result.batch.groups[0].items[index].audio;
  assert.equal(audio.start,0);assert.equal(audio.end,30);
  const savedClip=f.service.plan(p.batchId).clips[candidate.clipId];assert.deepEqual([savedClip.start,savedClip.end],[45.016327,75.016327]);
});
test("v4 completion reports per-anchor judgments and tentative coverage, never model wins",async t=>{
  const f=fixture(t),p=f.prepare(f.build());f.service.create(p);
  assert.equal(f.service.report(p.batchId).ready,false);
  for(const [g,group]of p.groups.entries())for(const [index]of group.candidates.entries()) {
    const decision=g===0?["KEEP","WRONG_LANE","SKIP","UNSURE"][index]:"WRONG_LANE";
    f.service.save({batchId:p.batchId,sessionId:group.sessionId,index,decision,listened:decision!=="UNSURE"});
  }
  const report=f.service.report(p.batchId);assert.equal(report.ready,true);assert.equal(report.kind,KIND);assert.equal(report.decisions,8);assert.equal(report.models,undefined);
  assert.deepEqual(report.anchors[0].decisions,{KEEP:1,WRONG_LANE:1,SKIP:1,UNSURE:1});assert.equal(report.anchors[0].tentativeCoverage.acceptedReferenceFound,true);
  assert.equal(report.anchors[1].tentativeCoverage.acceptedReferenceFound,false);assert.equal(report.productionPromotionAllowed,false);
  assert.doesNotMatch(JSON.stringify(report),/mert-|effnet|"analyzer"|"rank"|"similarity"|tidal:\d|sourceSha256/i);
  const input={batchId:p.batchId,sessionId:p.groups[0].sessionId,index:0,decision:"KEEP",listened:true};
  const audits=()=>f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session_audit WHERE event_type='BLIND_LISTENING_SAVED'").get().n;
  f.service.save(input);assert.equal(audits(),8);assert.equal(f.service.create(p).batch.completed,8);
  await assert.rejects(f.legacy.saveReviewItem({...input,profile:{energy:3}}),/blind listening/);
  await assert.rejects(f.legacy.rateReviewItem({...input,rating:"love"}),/global ratings/);
  assert.equal(f.profileWrites(),0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM taste_feedback").get().n,0);
});
test("already judged references cannot be republished as fresh evidence",t=>{
  const f=fixture(t),p=f.prepare(f.build());f.service.create(p);
  f.service.save({batchId:p.batchId,sessionId:p.groups[0].sessionId,index:0,decision:"UNSURE",listened:false});
  const next=f.prepare(f.build({roundId:"another-reference-round"}));
  assert.throws(()=>f.service.create(next),/unjudged/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,2);
});
test("generic human feedback also excludes a reference and uncertainty never asserts absent coverage",t=>{
  const f=fixture(t),p=f.prepare(f.build()),reference=p.groups[0].candidates[0];
  f.db.prepare(`INSERT INTO sonic_neighbor_feedback (anchor_identity_key,candidate_identity_key,rating,source_event_id,source_label,model,model_version,created_at)
    VALUES (?,?,?,'prior-event','human','old-model','1','2026-10-01')`).run("other-anchor",reference.track.identityKey,"KEEP");
  assert.throws(()=>f.service.create(p),/unjudged/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n,0);
  f.db.exec("DELETE FROM sonic_neighbor_feedback");f.service.create(p);
  for(const group of p.groups)for(const [index]of group.candidates.entries())f.service.save({batchId:p.batchId,sessionId:group.sessionId,index,decision:"UNSURE",listened:false});
  assert.ok(f.service.report(p.batchId).anchors.every(anchor=>anchor.tentativeCoverage.acceptedReferenceFound===null));
  f.db.prepare("UPDATE sonic_review_session_item SET review_json=? WHERE session_id=? AND item_index=0").run(JSON.stringify({decision:"KEEP",listened:true,reviewer:"assistant"}),p.groups[0].sessionId);
  assert.equal(f.service.report(p.batchId).ready,false,"completed SQL status cannot substitute for genuine human listening evidence");
});
