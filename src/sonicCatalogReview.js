"use strict";

// Listening-only reference coverage. No embedding, retrieval, or taste lookup.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createHash,randomUUID,randomInt} = require("node:crypto");
const {assertSonicSourceSnapshot} = require("./sonicCandidateCorpus");
const {recordingGroup} = require("./sonicAnalysisPilot");
const KIND = "catalog-reference-coverage";
const PURPOSE = "Judge whether each catalog reference fits beside this anchor.";
const CACHE = path.resolve(__dirname,"../data/sonic-blind-audio");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function keys(value,allowed,label) {
  assert.ok(plain(value) && Object.keys(value).every(key=>allowed.includes(key)),`Invalid ${label} fields.`);
}
function text(value,label,max=1000) {
  assert.ok(typeof value === "string" && value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value),`Invalid ${label}.`);
  return value;
}
function musicalNames(track={}) {
  return Object.fromEntries(["artist","title","mixVersion","album"].filter(key=>track[key] !== undefined)
    .map(key=>[key,String(track[key] || "")]));
}
function storedTrack(input) {
  text(input?.identityKey,"exact recording identity",4096); text(input.artist,"artist"); text(input.title,"title");
  const allowed=["identityKey","artist","title","mixVersion","album","durationMs","tidalId","isrc","genre","subgenre","label","bpm","key","keyName","camelot","releaseDate","year","beatportTrackId"];
  return clone(Object.fromEntries(allowed.filter(key=>input[key] !== undefined).map(key=>[key,input[key]])));
}
function clipIdentity(clip) {
  return createHash("sha256").update(JSON.stringify([clip.sourceSha256,clip.start,clip.end,"pcm_s16le-mono-24000-v1"])).digest("hex");
}
function validateClip(clip) {
  keys(clip,["clipId","start","end","sourceSha256","sourceFile","localFileId","wavSha256","sourceType","sourceSnapshotKey"],"reference clip");
  assert.ok(sha(clip.sourceSha256) && sha(clip.clipId) && clip.clipId===clipIdentity(clip),"Invalid exact reference clip identity.");
  assert.ok(Number.isFinite(clip.start)&&Number.isFinite(clip.end)&&clip.start>=0&&clip.end>clip.start&&clip.end-clip.start<=30.000002,"Invalid reference excerpt span.");
  text(clip.sourceFile,"private source file",4096);
  assert.ok(clip.wavSha256===undefined || sha(clip.wavSha256),"Invalid prepared WAV hash.");
}
function selection(input,anchorKey) {
  keys(input,["kind","source","query","anchorIdentityKey"],"private reference selection");
  assert.ok(["same-artist","broad-psy"].includes(input.kind),"Choose an explicit reference sampling origin.");
  assert.equal(input.source,input.kind==="same-artist"?"artist-catalog-search":"frozen-catalog-sampling","Invalid catalog reference sampling source.");
  assert.equal(input.anchorIdentityKey,anchorKey,"Reference sampling anchor changed.");
  text(input.query,"reference sampling query");
  return clone(input);
}
function normalizedReference(input,anchorKey) {
  keys(input,["track","verification","source","sourceFile","selection"],"catalog reference");
  const track=storedTrack(input.track),verification=input.verification;
  keys(verification,["provider","verified","identityKey","canonicalTrack"],"canonical verification");
  assert.ok(verification.provider==="tidal"&&verification.verified===true&&verification.identityKey===track.identityKey,"Exact verified TIDAL evidence is required.");
  assertSonicSourceSnapshot(input.source,{track:input.track});
  assertSonicSourceSnapshot(input.source,{track:verification.canonicalTrack});
  assert.ok(input.source.sourceType==="beatport-preview"&&input.source.identityRelation==="exact"&&input.source.allowVersionProxy===false,"References require exact Beatport previews.");
  text(input.sourceFile,"private frozen preview file",4096);
  return {track,verification:clone(verification),source:clone(input.source),sourceFile:input.sourceFile,selection:selection(input.selection,anchorKey)};
}
function shuffled(items) {
  const result=[...items];
  for(let i=result.length-1;i>0;i--){const j=randomInt(i+1);[result[i],result[j]]=[result[j],result[i]];}
  return result;
}
function planIdentity(plan) {
  return digest({version:4,kind:KIND,batchId:plan.batchId,roundId:plan.roundId,createdAt:plan.createdAt,title:plan.title,method:plan.method,
    groups:plan.groups.map(group=>({sessionId:group.sessionId,anchor:group.anchor,anchorOrigin:group.anchorOrigin,purpose:group.purpose,
      anchorClip:{...plan.clips[group.anchorClip],wavSha256:undefined},
      references:group.candidates.map(candidate=>({track:candidate.track,reference:candidate.reference,
        clip:{...plan.clips[candidate.clipId],wavSha256:undefined}}))}))});
}
function buildCatalogReviewPlan({roundId,title="Catalog reference listening",groups}={}) {
  assert.ok(typeof roundId==="string"&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(roundId),"Choose a stable reference round ID.");
  text(title,"reference title",120);
  assert.ok(Array.isArray(groups)&&groups.length>=1&&groups.length<=4,"Reference review requires one to four anchors.");
  const clips={};
  const frozen=groups.map(group=>{
    keys(group,["anchor","references"],"reference group input");
    keys(group.anchor,["track","clip","origin"],"reference anchor input");
    const anchor=storedTrack(group.anchor.track),clip=clone(group.anchor.clip);
    validateClip(clip);
    assert.ok(clip.sourceType===undefined||clip.sourceType==="verified-local-file","The anchor must retain its frozen local source type.");
    assert.equal(clip.sourceSnapshotKey,undefined,"A local anchor cannot claim catalog preview evidence.");
    clip.sourceType="verified-local-file";
    clips[clip.clipId]=clip;
    keys(group.anchor.origin,["batchId","sessionId"],"prior anchor origin");
    text(group.anchor.origin.batchId,"prior batch identity");text(group.anchor.origin.sessionId,"prior session identity");
    assert.ok(Array.isArray(group.references)&&group.references.length>=2&&group.references.length<=6,"Each reference anchor requires two to six candidates.");
    const candidates=shuffled(group.references.map(input=>{
      const reference=normalizedReference(input,anchor.identityKey),[start,end]=reference.source.spans[0];
      const candidateClip={start,end,sourceSha256:reference.source.sourceSha256,sourceFile:reference.sourceFile,
        sourceType:"beatport-preview",sourceSnapshotKey:reference.source.snapshotKey};
      candidateClip.clipId=clipIdentity(candidateClip);
      clips[candidateClip.clipId] ||= candidateClip;
      return {track:reference.track,clipId:candidateClip.clipId,reference:{verification:reference.verification,source:reference.source,selection:reference.selection}};
    }));
    return {sessionId:`sonic-review:${randomUUID()}`,anchor,anchorOrigin:clone(group.anchor.origin),anchorClip:clip.clipId,purpose:PURPOSE,candidates};
  });
  const plan={version:4,kind:KIND,batchId:`blind:${randomUUID()}`,roundId,createdAt:new Date().toISOString(),title,
    models:[],count:frozen.reduce((n,group)=>n+group.candidates.length,0),anchorCount:frozen.length,groups:frozen,clips,
    method:"Deliberately selected exact catalog references; shuffled once within each revisited anchor; no embedding nominations or ranking comparison."};
  plan.planKey=planIdentity(plan);
  validateCatalogReviewPlan(plan);
  return plan;
}
function validatePreparedWave(file,clip) {
  const stat=fs.statSync(file);
  assert.ok(stat.isFile()&&stat.size>=44&&stat.size<=2*1024*1024,"A prepared bounded WAV file is required.");
  const bytes=fs.readFileSync(file);
  assert.equal(hash(bytes),clip.wavSha256,"Prepared reference WAV changed.");
  assert.ok(bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WAVE","Invalid prepared reference WAV.");
  let format=null,data=0;
  for(let offset=12;offset+8<=bytes.length;) {
    const id=bytes.toString("ascii",offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;
    assert.ok(start+size<=bytes.length,"Truncated prepared reference WAV.");
    if(id==="fmt "){assert.ok(size>=16);format=[bytes.readUInt16LE(start),bytes.readUInt16LE(start+2),bytes.readUInt32LE(start+4),bytes.readUInt16LE(start+14)];}
    if(id==="data")data+=size;
    offset=start+size+(size%2);
  }
  assert.deepEqual(format,[1,1,24000,16],"Reference audio requires mono24k signed16 PCM.");
  assert.ok(data>0&&data%2===0&&Math.abs(data/2-Math.round((clip.end-clip.start)*24000))<=1,"Prepared reference WAV differs from its exact excerpt.");
}
function validateCatalogReviewPlan(plan,{db,requirePrepared=false,cacheDirectory=CACHE}={}) {
  keys(plan,["version","kind","batchId","roundId","createdAt","title","models","count","anchorCount","groups","clips","method","planKey","preparationRequest","preparationRequestKey"],"reference plan");
  assert.equal(plan.version,4);assert.equal(plan.kind,KIND);assert.deepEqual(plan.models,[],"Reference coverage cannot contain model nominations.");
  text(plan.batchId,"reference batch identity");text(plan.title,"reference title",120);
  assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.roundId||""));
  assert.ok(Number.isFinite(Date.parse(plan.createdAt)),"Invalid reference creation timestamp.");
  assert.ok(Array.isArray(plan.groups)&&plan.groups.length>=1&&plan.groups.length<=4);
  assert.equal(plan.anchorCount,plan.groups.length);assert.ok(plain(plan.clips));
  const anchorKeys=new Set(),anchorHashes=new Set(),anchorGroups=new Set(),sessions=new Set(),used=new Set(),references=new Map(),sourceOwners=new Map();
  let count=0;
  for(const group of plan.groups) {
    keys(group,["sessionId","anchor","anchorOrigin","anchorClip","purpose","candidates"],"frozen reference group");
    const anchor=storedTrack(group.anchor),anchorClip=plan.clips[group.anchorClip];
    assert.deepEqual(anchor,group.anchor,"Unexpected private anchor fields.");
    validateClip(anchorClip);assert.equal(anchorClip.clipId,group.anchorClip);
    assert.equal(anchorClip.sourceType,"verified-local-file");assert.ok(anchorClip.localFileId!==undefined&&String(anchorClip.localFileId),"Existing exact local anchor provenance is required.");
    assert.equal(anchorClip.sourceSnapshotKey,undefined,"A local anchor cannot claim catalog preview evidence.");
    assert.ok(!anchorKeys.has(anchor.identityKey)&&!anchorHashes.has(anchorClip.sourceSha256)&&!anchorGroups.has(recordingGroup(anchor)),"Duplicate reference anchor recording.");
    anchorKeys.add(anchor.identityKey);anchorHashes.add(anchorClip.sourceSha256);anchorGroups.add(recordingGroup(anchor));used.add(group.anchorClip);
    text(group.sessionId,"reference session identity");assert.ok(!sessions.has(group.sessionId));sessions.add(group.sessionId);
    assert.equal(group.purpose,PURPOSE);keys(group.anchorOrigin,["batchId","sessionId"],"frozen anchor origin");
    text(group.anchorOrigin.batchId,"prior batch identity");text(group.anchorOrigin.sessionId,"prior session identity");
    if(db) {
      const row=db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id=?").get(group.anchorOrigin.batchId);
      const prior=row&&JSON.parse(row.private_plan_json),original=prior?.groups.find(g=>g.sessionId===group.anchorOrigin.sessionId);
      assert.ok(original&&prior.version!==4,"The original frozen anchor batch is unavailable.");
      assert.deepEqual(musicalNames(original.anchor),musicalNames(anchor));assert.equal(original.anchor.identityKey,anchor.identityKey);
      for(const field of ["tidalId","durationMs"]) assert.deepEqual(anchor[field]??"",original.anchor[field]??"","The frozen anchor recording descriptor changed.");
      const originalClip=prior.clips[original.anchorClip];
      for(const field of ["clipId","sourceSha256","sourceFile","localFileId","start","end","wavSha256"]) assert.deepEqual(anchorClip[field],originalClip[field],"The exact frozen local anchor clip changed.");
    }
    assert.ok(Array.isArray(group.candidates)&&group.candidates.length>=2&&group.candidates.length<=6);
    const identities=new Set(),hashes=new Set(),recordings=new Set();
    for(const candidate of group.candidates) {
      keys(candidate,["track","clipId","reference"],"frozen reference candidate");
      keys(candidate.reference,["verification","source","selection"],"frozen reference provenance");
      const clip=plan.clips[candidate.clipId];validateClip(clip);used.add(candidate.clipId);
      const reference=normalizedReference({...candidate.reference,track:candidate.track,sourceFile:clip.sourceFile},anchor.identityKey);
      assert.deepEqual(reference.track,candidate.track,"Unexpected private reference fields.");
      assert.equal(clip.clipId,candidate.clipId);assert.equal(clip.sourceType,"beatport-preview");
      assert.equal(clip.sourceSha256,reference.source.sourceSha256);assert.equal(clip.sourceSnapshotKey,reference.source.snapshotKey);
      assert.deepEqual([[clip.start,clip.end]],reference.source.spans);
      const key=reference.track.identityKey,recording=recordingGroup(reference.track),sha256=reference.source.sourceSha256;
      assert.ok(key!==anchor.identityKey&&sha256!==anchorClip.sourceSha256&&recording!==recordingGroup(anchor),"A reference cannot be its anchor recording.");
      assert.ok(!identities.has(key)&&!hashes.has(sha256)&&!recordings.has(recording),"Duplicate reference identity, source or recording version.");
      identities.add(key);hashes.add(sha256);recordings.add(recording);
      if(references.has(key)) assert.deepEqual(references.get(key),{track:reference.track,source:reference.source,sourceFile:clip.sourceFile},"A shared reference changed its source or version.");
      references.set(key,{track:reference.track,source:reference.source,sourceFile:clip.sourceFile});
      assert.ok(!sourceOwners.has(sha256)||sourceOwners.get(sha256)===key,"Distinct catalog versions cannot share original audio bytes.");sourceOwners.set(sha256,key);
      count++;
    }
  }
  for(const reference of references.values()) assert.ok(!anchorKeys.has(reference.track.identityKey)&&!anchorHashes.has(reference.source.sourceSha256)
    &&!anchorGroups.has(recordingGroup(reference.track)),"Catalog references cannot reuse any anchor recording.");
  assert.ok(count<=24);assert.equal(plan.count,count);assert.deepEqual(Object.keys(plan.clips).sort(),[...used].sort(),"Unexpected unused reference clips.");
  assert.equal(plan.planKey,planIdentity(plan),"Frozen reference plan identity changed.");
  if(db) {
    const hasFeedback=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sonic_neighbor_feedback'").get();
    for(const reference of references.values()) {
      assert.ok(!db.prepare("SELECT 1 FROM sonic_review_session_item WHERE candidate_identity_key=? AND review_json IS NOT NULL LIMIT 1").get(reference.track.identityKey),
        "Catalog references must be unjudged exact recordings.");
      if(hasFeedback) assert.ok(!db.prepare("SELECT 1 FROM sonic_neighbor_feedback WHERE candidate_identity_key=? LIMIT 1").get(reference.track.identityKey),
        "Catalog references must be unjudged exact recordings.");
    }
    for(const row of db.prepare("SELECT batch_id,private_plan_json FROM sonic_blind_review_batch").all()) {
      if(row.batch_id===plan.batchId) continue;
      const prior=JSON.parse(row.private_plan_json);
      for(const group of prior.groups) {
        const reviewed=db.prepare("SELECT item_index,review_json FROM sonic_review_session_item WHERE session_id=? AND review_json IS NOT NULL").all(group.sessionId);
        for(const item of reviewed) {
          const candidate=group.candidates[item.item_index];if(!candidate) continue;
          const priorHash=prior.clips[candidate.clipId]?.sourceSha256,priorGroup=recordingGroup(candidate.track);
          assert.ok(![...references.values()].some(reference=>reference.track.identityKey===candidate.track.identityKey||reference.source.sourceSha256===priorHash||recordingGroup(reference.track)===priorGroup),"Catalog references must be unjudged exact recordings.");
        }
      }
    }
  }
  if(requirePrepared) {
    assert.ok(db,"Publication requires prior frozen anchor evidence.");
    for(const reference of references.values()) {
      const stat=fs.statSync(reference.sourceFile);assert.ok(stat.isFile()&&stat.size===reference.source.byteLength&&stat.size<=20*1024*1024,"Frozen preview bytes are unavailable or changed.");
      assertSonicSourceSnapshot(reference.source,{track:reference.track,audioBytes:fs.readFileSync(reference.sourceFile)});
    }
    for(const clip of Object.values(plan.clips)) {assert.ok(sha(clip.wavSha256),"All reference WAVs must be prepared before publication.");validatePreparedWave(path.join(cacheDirectory,`${clip.clipId}.wav`),clip);}
  }
  return true;
}
function opaqueListeningIdentity(batchId,sessionId,role,index="") {return `blind-reference:${digest([batchId,sessionId,role,index])}`;}
module.exports={buildCatalogReviewPlan,validateCatalogReviewPlan,musicalNames,opaqueListeningIdentity,KIND,PURPOSE};
