'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {reviewStandbyPool,reviewPayload}=require('../src/standbySynapseReview');
const {StandbyCandidateStore}=require('../src/standbyCandidateStore');
const tracks=[{id:'1',artist:'Alpha',title:'First',score:95,secret:'never-send',raw:{private:'raw'}},{id:'2',artist:'Beta',title:'Second',score:80}];
function router(complete){return {selectedTier:'sol',isSynapseTierUsable:()=>true,openAiProvider:{safeStatus:()=>({connected:true}),tierConfig:()=>({model:'test-model'}),completeJsonPrompt:complete}};}
test('only retained metadata and current taste signals go to Synapse; valid order survives persistence',async()=>{
 let captured;
 const result=await reviewStandbyPool(tracks,{router:router(async(prompt,options)=>{captured={prompt,options};return {text:'{"orderedIds":["1","0"]}',model:'actual-model'};}),profile:{artists:{Alpha:{score:2}},feedback:{x:{artist:'Alpha',title:'First',rating:'love',privateNote:'private'}},secret:'secret'}});
 assert.ok(!captured.prompt.includes('never-send'));assert.ok(!captured.prompt.includes('private'));assert.ok(!captured.prompt.includes('secret'));assert.ok(captured.prompt.includes('Alpha'));
 assert.equal(captured.options.requestType,'standby_final_review');assert.equal(captured.options.retryCount,0);
 assert.equal(result.review.participated,true);assert.equal(result.review.model,'actual-model');assert.deepEqual(result.tracks.map(t=>t.id),['2','1']);assert.equal(result.tracks[0].score,80);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-review-'));const store=new StandbyCandidateStore({file:path.join(dir,'pool.json'),targetCount:2});
 store.replace(result.tracks);store.markRefreshEnd({diagnostics:{synapseReview:result.review}});
 assert.deepEqual(store.summary().tracks.map(t=>t.id),['2','1']);assert.equal(store.summary().lastRun.diagnostics.synapseReview.model,'actual-model');
 fs.unlinkSync(store.file);fs.rmdirSync(dir);
});
test('disconnected and non-AUTO refreshes do not contact Synapse',async()=>{
 const r=router(()=>{throw Error('must not call');});r.openAiProvider.safeStatus=()=>({enabled:false});
 const disconnected=await reviewStandbyPool(tracks,{router:r});assert.equal(disconnected.review.attempted,false);
 const local=await reviewStandbyPool(tracks,{router:router(()=>{throw Error('must not call');}),mode:'local'});assert.equal(local.review.attempted,false);
});
test('malformed, missing, duplicate and invented IDs fall back without losing local pool',async()=>{
 for(const text of ['bad JSON','{"orderedIds":["0"]}','{"orderedIds":["0","0"]}','{"orderedIds":["0","99"]}']){
  const result=await reviewStandbyPool(tracks,{router:router(async()=>({text}))});assert.equal(result.review.participated,false);assert.equal(result.review.status,'failed');assert.deepEqual(result.tracks,tracks);
 }
 const timeout=await reviewStandbyPool(tracks,{router:router(async()=>{throw Error('Request timed out');})});assert.match(timeout.review.reason,/timed out/);assert.deepEqual(timeout.tracks,tracks);
});
test('local fallback clears previous refresh ranking',async()=>{
 const result=await reviewStandbyPool([{...tracks[0],standbySynapseRank:{runId:'old',rank:1}}],{});assert.equal(result.tracks[0].standbySynapseRank,undefined);
});

test('AUTO candidate planning always calls the local generator, even with Synapse available',async()=>{
 const {generateStandbySearchPlan}=require('../src/standbySynapseReview');let localCalls=0;
 const result=await generateStandbySearchPlan({mode:'auto',router:{generateSearchPlan:()=>{throw Error('must not ask Synapse for candidates');}},options:{request:'standby'},localGenerate:async()=>{localCalls++;return {plan:{searchQueries:['local']}};},timeoutMs:1000});
 assert.equal(localCalls,1);assert.deepEqual(result.plan.searchQueries,['local']);
});

test('unknown connection after restart still attempts the configured model and reports usage',async()=>{
 const r=router(async()=>({text:'{"orderedIds":["1","0"]}',model:'test-model',usage:{inputTokens:100,outputTokens:10}}));
 r.openAiProvider.safeStatus=()=>({enabled:true,configured:true,connected:false,state:'unknown',tiers:{sol:{available:true,budget:{limited:false}}}});
 const v=await reviewStandbyPool(tracks,{router:r});assert.equal(v.review.attempted,true);assert.equal(v.review.participated,true);assert.equal(v.review.routingMode,'AUTO');assert.equal(v.review.connectionPreviouslyConfirmed,false);assert.equal(v.review.tokenUsage.inputTokens,100);assert.equal(v.review.fallbackProvider,'');
});
test('configuration, budget and API failure reasons remain distinct',async()=>{
 for(const [status,failureType] of [[{enabled:false},'disabled'],[{configured:false},'missing_api_key'],[{tiers:{sol:{budget:{limited:true,limitedBy:['sol_daily']}}}},'budget_limit'],[{tiers:{sol:{available:false}}},'model_unavailable']]){
  const r=router(()=>{throw Error('must not call');});r.openAiProvider.safeStatus=()=>status;
  const v=await reviewStandbyPool(tracks,{router:r});assert.equal(v.review.failureType,failureType);assert.equal(v.review.attempted,false);assert.ok(v.review.skipReason);
 }
 const v=await reviewStandbyPool(tracks,{router:router(async()=>{throw Error('Request timed out after 25s');})});assert.equal(v.review.failureType,'timeout');assert.equal(v.review.attempted,true);assert.equal(v.review.fallbackProvider,'local');
});
