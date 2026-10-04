"use strict";
const { randomUUID, randomInt, createHash } = require("node:crypto");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { compareAnalysis } = require("./sonicAnalysisEvaluation");
const { analysisSpec } = require("./sonicAnalysisSpec");

const BLIND_MODEL = "blind-listening";
const MODELS = ["effnet-control", "mert-fullsong", "mert-30s", "mert-330m"];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const shuffle = items => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};
function publicTrack(track = {}) {
  // Deliberate allowlist: no ranks, model output, global ratings or local paths.
  const out = {};
  for (const key of ["identityKey", "artist", "title", "mixVersion", "album", "durationMs", "tidalId"]) out[key] = track[key] ?? "";
  return out;
}
function selectAnchors(manifest) {
  const eligible = manifest.items.filter(x => x.track.analysisLocal?.sha256);
  const positive = x => /^(love|like|good)$/i.test(x.rating || "");
  const remix = x => /remix|rework/i.test(`${x.track.title} ${x.track.mixVersion}`);
  const preferred = x => /progressive|trance|techno|melodic|deep house/.test(x.lane);
  const strata = [
    ["Progressive House", x => /progressive house/.test(x.lane)],
    ["Progressive / deep Trance", x => /trance/.test(x.lane) && !/psy/.test(x.lane)],
    ["Psytrance", x => /psy.*trance/.test(x.lane)],
    ["Techno", x => /techno/.test(x.lane) && !/melodic/.test(x.lane)],
    ["Named remix · house / techno", x => remix(x) && /house|techno/.test(x.lane)],
    ["Named remix · trance / adjacent", x => remix(x) && preferred(x)]
  ];
  const selected = [], hashes = new Set(), groups = new Set();
  for (const [purpose, matches] of strata) {
    const available = eligible.filter(x => !hashes.has(x.track.analysisLocal.sha256) && !groups.has(x.recordingGroup || recordingGroup(x.track)));
    const item = available.filter(matches).sort((a,b) => Number(positive(b)) - Number(positive(a)) || a.track.identityKey.localeCompare(b.track.identityKey))[0];
    if (!item) throw new Error(`The pilot needs an eligible anchor for ${purpose}; do not silently substitute another lane.`);
    selected.push({ ...item, purpose }); hashes.add(item.track.analysisLocal.sha256); groups.add(item.recordingGroup || recordingGroup(item.track));
  }
  return selected;
}
function buildBlindPlan(db, manifest) {
  const anchors = selectAnchors(manifest);
  const report = compareAnalysis(db, manifest, { models: MODELS, anchorIdentityKeys: anchors.map(x => x.track.identityKey) });
  if (report.commonAudioCandidateCount !== manifest.items.length) throw new Error("Finish the matched-source pilot before preparing blind listening.");
  const trackByKey = new Map(manifest.items.map(x => [x.track.identityKey, x]));
  const clips = {};
  const clipFor = track => {
    const spec = analysisSpec("effnet-control");
    const row = db.prepare(`SELECT a.source_sha256,a.result_json FROM sonic_analysis_link l JOIN sonic_analysis_artifact a USING(artifact_key)
      WHERE l.identity_key=? AND l.spec_key=?`).get(track.identityKey, spec.key);
    const result = row && JSON.parse(row.result_json);
    const spans = result?.segments?.map(x => [x.start,x.end]);
    if (!row || row.source_sha256 !== track.analysisLocal.sha256 || spans?.length !== 1) throw new Error("Listening source does not match the stored analysis.");
    const [start,end] = spans[0];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 31) throw new Error("Invalid listening excerpt span.");
    const clipId = digest([row.source_sha256,start,end,"pcm_s16le-mono-24000-v1"]);
    clips[clipId] ||= { clipId, start, end, sourceSha256:row.source_sha256, sourceFile:track.analysisLocal.file, localFileId:track.analysisLocal.localFileId };
    return clipId;
  };
  const groups = anchors.map(anchor => {
    const ranks = report.models.map(model => ({ model:model.analyzer, specKey:model.specKey,
      neighbors:model.anchors.find(x => x.anchor.identityKey === anchor.track.identityKey).neighbors }));
    // Round-robin top nominations; shared recommendations are heard once.
    // Retain all models' top-ten membership for the later descriptive report.
    const keys = [], seenHashes = new Set(), seenGroups = new Set();
    const order = shuffle(ranks);
    for (let rank = 0; rank < 10 && keys.length < 4; rank++) for (const model of order) {
      const key = model.neighbors[rank]?.identityKey, item = trackByKey.get(key);
      if (!item || keys.includes(key) || seenHashes.has(item.track.analysisLocal.sha256) || seenGroups.has(item.recordingGroup || recordingGroup(item.track))) continue;
      keys.push(key); seenHashes.add(item.track.analysisLocal.sha256); seenGroups.add(item.recordingGroup || recordingGroup(item.track));
      if (keys.length === 4) break;
    }
    if (keys.length !== 4) throw new Error("Not enough distinct matched-source neighbors for a complete listening block.");
    return { sessionId:`sonic-review:${randomUUID()}`, anchor:publicTrack(anchor.track), anchorClip:clipFor(anchor.track),
      lane:anchor.track.genre, purpose:anchor.purpose,
      candidates:shuffle(keys).map(key => ({ track:publicTrack(trackByKey.get(key).track), clipId:clipFor(trackByKey.get(key).track),
        nominations:ranks.flatMap(model => { const rank = model.neighbors.findIndex(x => x.identityKey === key);
          return rank < 0 ? [] : [{ analyzer:model.model, specKey:model.specKey, rank:rank+1, similarity:model.neighbors[rank].similarity }]; }) })) };
  });
  return { version:1, batchId:`blind:${randomUUID()}`, planKey:digest(["blind-v1",manifest.createdAt,MODELS.map(analysisSpec).map(x=>x.key),anchors.map(x=>x.track.identityKey)]),
    createdAt:new Date().toISOString(), title:"First blind listening batch", count:24, groups, clips,
    method:"Six metadata-stratified anchors; four distinct round-robin top nominations each; shuffled within anchor; identical source excerpts.",
    productionPromotionAllowed:false };
}

class SonicBlindReview {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS sonic_blind_review_batch (
      batch_id TEXT PRIMARY KEY, plan_key TEXT NOT NULL UNIQUE, private_plan_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }
  plan(id = "") {
    const row = id ? this.db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id=?").get(id)
      : this.db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch ORDER BY created_at DESC LIMIT 1").get();
    return row ? JSON.parse(row.private_plan_json) : null;
  }
  create(plan) {
    const existing = this.db.prepare("SELECT batch_id FROM sonic_blind_review_batch WHERE plan_key=?").get(plan.planKey);
    if (existing) return this.get(existing.batch_id);
    if (plan.groups.length !== 6 || plan.groups.some(g => g.candidates.length !== 4) || Object.values(plan.clips).some(c => !c.wavSha256)) throw new Error("Publish only a complete prepared listening batch.");
    const db = this.db, now = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const group of plan.groups) {
        db.prepare(`INSERT INTO sonic_review_session (session_id,anchor_identity_key,anchor_json,requested_count,candidate_count,status,
          review_policy,queue_policy,profile_policy,novelty_policy,model,model_version,diagnostics_json,created_at,updated_at)
          VALUES (?,?,?,4,4,'READY','HUMAN_CONFIRM_EACH','NEVER','LISTENING_ONLY','ALLOW_KNOWN',?,'1',?,?,?)`)
          .run(group.sessionId,group.anchor.identityKey,JSON.stringify(group.anchor),BLIND_MODEL,JSON.stringify({blind:true,batchId:plan.batchId}),now,now);
        for (const [i,candidate] of group.candidates.entries()) db.prepare(`INSERT INTO sonic_review_session_item
          (session_id,item_index,candidate_identity_key,candidate_json,relation_json,status,created_at,updated_at) VALUES (?,?,?,?,'{}','PENDING',?,?)`)
          .run(group.sessionId,i,candidate.track.identityKey,JSON.stringify(candidate.track),now,now);
        db.prepare(`INSERT INTO sonic_review_session_audit (session_id,event_type,source,assistant,new_value,created_at)
          VALUES (?,'BLIND_BATCH_PREPARED','LOCAL','',?,?)`).run(group.sessionId,JSON.stringify({batchId:plan.batchId}),now);
      }
      db.prepare("INSERT INTO sonic_blind_review_batch VALUES (?,?,?,?)").run(plan.batchId,plan.planKey,JSON.stringify(plan),now);
      db.exec("COMMIT");
    } catch(error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    return this.get(plan.batchId);
  }
  get(id = "") {
    const plan = this.plan(id);
    if (!plan) return {ok:true,batch:null};
    let completed = 0;
    const groups = plan.groups.map((group,index) => {
      const items = this.db.prepare("SELECT item_index,status,decision,review_json FROM sonic_review_session_item WHERE session_id=? ORDER BY item_index").all(group.sessionId);
      completed += items.filter(x=>x.status !== "PENDING").length;
      const media = clipId => ({url:`/api/recommendation-v2/sonic-review/blind/audio?batchId=${encodeURIComponent(plan.batchId)}&clipId=${clipId}`,
        start:plan.clips[clipId].start,end:plan.clips[clipId].end});
      return {number:index+1,sessionId:group.sessionId,anchor:publicTrack(group.anchor),lane:group.lane,anchorAudio:media(group.anchorClip),
        items:items.map(item=>({index:item.item_index,number:index*4+item.item_index+1,candidate:publicTrack(group.candidates[item.item_index].track),
          audio:media(group.candidates[item.item_index].clipId),status:item.status,decision:item.decision,review:item.review_json ? JSON.parse(item.review_json) : null}))};
    });
    return {ok:true,batch:{batchId:plan.batchId,title:plan.title,count:24,completed,remaining:24-completed,status:completed===24 ? "COMPLETED" : "READY",groups,
      blind:true,productionApplied:false,globalRatingsChanged:false}};
  }
  save({batchId,sessionId,index,decision,listened,note = ""} = {}) {
    const allowed = ["KEEP","SKIP","WRONG_LANE","UNSURE"];
    if (!allowed.includes(decision) || !Number.isInteger(index) || typeof note !== "string" || note.length > 2000) throw new Error("Choose a valid listening decision and a note of at most 2,000 characters.");
    if (decision !== "UNSURE" && listened !== true) throw new Error("Listen to both excerpts before judging, or choose Can't judge.");
    if (!batchId || !sessionId) throw new Error("A batch and review session are required.");
    const plan = this.plan(batchId), group = plan?.groups.find(g => g.sessionId===sessionId);
    if (!group?.candidates[index]) throw new Error("This listening item does not belong to the requested batch.");
    const review = {decision,note:note.trim(),listened:listened===true,reviewer:"human",evidence:"blind-listening",globalRatingChanged:false};
    const now = new Date().toISOString(), db=this.db;
    try {
      db.exec("BEGIN IMMEDIATE");
      const prior = db.prepare("SELECT review_json FROM sonic_review_session_item WHERE session_id=? AND item_index=?").get(sessionId,index);
      if (prior.review_json === JSON.stringify(review)) { db.exec("COMMIT"); return this.get(batchId); }
      db.prepare("UPDATE sonic_review_session_item SET status='REVIEWED',decision=?,review_json=?,error='',updated_at=? WHERE session_id=? AND item_index=?")
        .run(decision==='WRONG_LANE' ? 'REJECT' : decision==='UNSURE' ? 'REVIEW_MANUALLY' : decision,JSON.stringify(review),now,sessionId,index);
      const state = db.prepare("SELECT COUNT(*) AS completed FROM sonic_review_session_item WHERE session_id=? AND status<>'PENDING'").get(sessionId);
      const next = db.prepare("SELECT MIN(item_index) AS n FROM sonic_review_session_item WHERE session_id=? AND status='PENDING'").get(sessionId).n;
      db.prepare("UPDATE sonic_review_session SET completed_count=?,current_index=?,status=?,updated_at=?,completed_at=? WHERE session_id=?")
        .run(state.completed,next??4,state.completed===4?'COMPLETED':'RUNNING',now,state.completed===4?now:null,sessionId);
      db.prepare(`INSERT INTO sonic_review_session_audit (session_id,event_type,item_index,source,assistant,old_value,new_value,created_at)
        VALUES (?,'BLIND_LISTENING_SAVED',?,'HUMAN','',?,?,?)`).run(sessionId,index,prior.review_json,JSON.stringify(review),now);
      db.exec("COMMIT");
    } catch(error) { try {db.exec("ROLLBACK");} catch{} throw error; }
    return this.get(batchId);
  }
  report(id = "") {
    const snapshot=this.get(id).batch;
    if(!snapshot) return {ok:true,ready:false,reason:"No prepared batch."};
    if(snapshot.remaining) return {ok:true,ready:false,remaining:snapshot.remaining,productionPromotionAllowed:false};
    const plan=this.plan(snapshot.batchId);
    const models=MODELS.map(analyzer=>{
      const pairs=[];
      for(const [gi,group] of plan.groups.entries()) for(const [i,candidate] of group.candidates.entries()) {
        const nomination=candidate.nominations.find(n=>n.analyzer===analyzer);
        if(nomination) pairs.push({rank:nomination.rank,review:snapshot.groups[gi].items[i].review});
      }
      const judged=pairs.filter(p=>p.review?.listened===true&&p.review.decision!=="UNSURE");
      const kept=judged.filter(p=>p.review.decision==="KEEP").length;
      return {analyzer,sampledNominations:pairs.length,judged:judged.length,kept,wrongLane:judged.filter(p=>p.review.decision==="WRONG_LANE").length,
        skipped:judged.filter(p=>p.review.decision==="SKIP").length,unjudged:pairs.length-judged.length,
        sampledKeepRate:judged.length?kept/judged.length:null};
    });
    return {ok:true,ready:true,batchId:snapshot.batchId,models,anchorCount:6,decisions:24,productionPromotionAllowed:false,
      notes:["Descriptive results for a small, deliberately sampled batch; not precision at ten or a held-out quality claim.",
        "Shared nominations use the same listening judgment for each nominating model. Can't judge is excluded from quality rates.",
        "These are partial-source listening judgments. Confirm promising results on different anchors and full recordings before production changes."]};
  }
}
module.exports = { SonicBlindReview, buildBlindPlan, selectAnchors, publicTrack, BLIND_MODEL };
