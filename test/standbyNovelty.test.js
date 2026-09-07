'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepareNovelty,finalizeNovelty,recordRefresh,trackId}=require('../src/standbyNovelty');
const {StandbyCandidateStore}=require('../src/standbyCandidateStore');
const {reviewPayload}=require('../src/standbySynapseReview');
const now=Date.now();
const golden={id:'golden',artist:'Artist',title:'My Golden Cage (Kasper Koman &AM Remix)',score:99};
const alternatives=Array.from({length:8},(_,i)=>({id:`new${i}`,artist:`Artist ${i}`,title:`Fresh ${i}`,score:85-i}));
const run=(tracks,age=0)=>({timestamp:new Date(now-age).toISOString(),tracks:tracks.map((t,i)=>({trackId:trackId(t),artist:t.artist,title:t.title,rank:i+1,score:t.score}))});
test('cooldown strength decays by refresh count and expires by time',()=>{
 const h=Array.from({length:6},()=>run([]));
 for(const [position,penalty] of [[5,45],[4,30],[3,30],[2,15],[0,15]]){const history=structuredClone(h);history[position]=run([golden]);assert.equal(prepareNovelty([golden],history,{},now)[0].standbyNovelty.penalty,penalty);}
 assert.equal(prepareNovelty([golden],[run([golden],15*86400000)],{},now)[0].standbyNovelty.penalty,0);
});
test('six refreshes cannot keep Golden Cage at number one, even when Synapse always prefers it',()=>{
 let history=[run([golden])];
 for(let i=0;i<6;i++){
  const ranked=[golden,...alternatives].map((t,rank)=>({...t,standbySynapseRank:{runId:'model',rank}}));
  const result=finalizeNovelty(ranked,history,{},now+i);
  if(i<3)assert.notEqual(result.tracks[0].id,'golden');
  history=recordRefresh(history,result.tracks,new Date(now+i).toISOString());
 }
 const firsts=history.slice(1).map(h=>h.tracks[0].trackId);assert.ok(new Set(firsts).size>=3);
});
test('few alternatives and explicit repeats are exceptions, never permanent rejection',()=>{
 const history=[run([golden])];const one=finalizeNovelty([golden],history,{},now);
 assert.equal(one.tracks.length,1);assert.match(one.diagnostics.topSlotException,/Fewer/);
 const override=finalizeNovelty([golden,...alternatives],history,{allowRepeats:true},now);
 assert.equal(override.tracks[0].id,'golden');assert.equal(override.diagnostics.repeatedTracksSuppressed,0);
 const returned=finalizeNovelty([golden,...alternatives],[...history,...Array.from({length:6},()=>run([]))],{},now);
 assert.equal(returned.tracks[0].id,'golden');
});
test('committed history and final rank survive restart without altering taste score',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-novelty-'));const file=path.join(dir,'standby.json');const store=new StandbyCandidateStore({file,targetCount:4});
 const h=[run([golden])];const final=finalizeNovelty([golden,...alternatives.slice(0,3)],h,{},now);
 const result=store.replace(final.tracks,{recordHistory:true,history:h});
 const restarted=new StandbyCandidateStore({file,targetCount:4});assert.equal(restarted.read().standbyHistory.length,2);
 assert.equal(restarted.summary().tracks[0].id,result.tracks[0].id);assert.notEqual(result.tracks[0].id,'golden');
 const appearance=restarted.read().standbyHistory[1].tracks.find(t=>t.trackId==='golden');assert.equal(appearance.score,99);assert.equal(appearance.recentAppearances,2);assert.ok(appearance.rank>1);
 fs.unlinkSync(file);fs.rmdirSync(dir);
});
test('Synapse payload contains bounded music history and novelty fields, excludes private database fields',()=>{
 const candidates=prepareNovelty([golden],[run([golden])],{},now);const payload=reviewPayload(candidates,{feedback:Object.fromEntries(Array.from({length:200},(_,i)=>[i,{artist:'A',title:'B',rating:'like',secret:'hidden'}]))},[run([golden])]);
 assert.equal(payload.tasteProfile.feedback.length,50);assert.equal(payload.recentStandbyHistory.length,1);assert.equal(payload.candidates[0].novelty.penalty,45);assert.ok(!JSON.stringify(payload).includes('hidden'));
});
