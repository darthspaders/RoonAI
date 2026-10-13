"use strict";
// Explicit, one-off scale test. Uses the production pipeline and its idle guard;
// does not raise daily maintenance limits. Completed images publish through the
// same pipeline immediately when activeImages is 'all', independently of target.
const fs=require('node:fs/promises'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {Pipeline,HOME,status,bytesUnder,loadKey,add}=require('./pipeline.cjs');
const {read,atomic}=require('./library.cjs');
const sources=require('./pipeline-sources.cjs');
const observations=require('./observation-sources.cjs');
const TERMS=['nebula','Hubble','NIRCam','star cluster','galaxy','supernova remnant','Spitzer','Chandra','Webb','cosmic dust','Orion','Carina','Jupiter','Saturn'];
const HOUR=3600000,HOURLY_CAP=900,MIN_SPACING=1000;
const busyVisuals=message=>/Stop visuals|active visualizer/.test(message||'');
const terminal=e=>['verified','failed','rejected','duplicate'].includes(e.stage);
function summary(job,catalog={assets:{}}){
 const entries=job.ids.map(id=>catalog.assets[id]).filter(Boolean),n=stage=>entries.filter(e=>e.stage===stage).length;
 return {version:1,target:job.target,status:job.status,passed:n('verified'),remaining:Math.max(0,job.target-n('verified')),
  downloaded:Object.keys(job.downloads).length,downloadBytes:Object.values(job.downloads).reduce((s,d)=>s+d.bytes,0),
  duplicates:n('duplicate'),failed:n('failed'),rejected:n('rejected'),metadataSeen:job.metadataSeen,metadataRejected:job.metadataRejected,
  installed:entries.filter(e=>e.stage==='verified'&&e.registrationStatus==='installed').length,
  pendingInstallation:entries.filter(e=>e.stage==='verified'&&e.registrationStatus!=='installed').length,
  reactive:entries.filter(e=>e.stage==='verified'&&(catalog.whitecapPublication?.expressiveScenes||e.maskStatus==='reactive')).length,static:catalog.whitecapPublication?.expressiveScenes?0:entries.filter(e=>e.stage==='verified'&&e.maskStatus==='static').length,
  processed:entries.filter(terminal).length,totalRequests:job.totalRequests,requestsInLastHour:job.requests.filter(t=>t>Date.now()-HOUR).length,
  hourlyRequestCap:HOURLY_CAP,reason:job.reason||null,nextRequestAt:job.nextRequestAt||null,
  startedAt:job.startedAt,updatedAt:job.updatedAt,finishedAt:job.finishedAt||null,registration:catalog.whitecapPublication||job.registration||null};
}
class Trial {
 constructor(o={}){
  this.home=o.home||HOME;this.file=path.join(this.home,'trial-500.json');this.stopFile=path.join(this.home,'trial-pause.json');
  this.p=o.pipeline||new Pipeline({...o,requestBudget:5000});this.log=o.log||console.log;
  this.p.beforeRequest=signal=>this.beforeRequest(signal);
  this.p.onDownload=async(e,receipt)=>{this.job.downloads[e.id]||={...receipt,at:new Date().toISOString()};await this.save();};
 }
 async save(){
  this.job.updatedAt=new Date().toISOString();await atomic(this.file,this.job);
  const progress=summary(this.job,this.p.catalog);await atomic(path.join(this.home,'trial-status.json'),progress);
  const current=await read(path.join(this.home,'status.json'),{});
  // Browser/API reads precomputed status only; never scan/process during playback.
  await atomic(path.join(this.home,'status.json'),{...current,trial:progress});
 }
 async beforeRequest(signal){
  if(await read(this.stopFile,null))throw Error('Trial paused by user');
  let now=Date.now();this.job.requests=this.job.requests.filter(t=>t>now-HOUR);
  const spacing=(this.job.requests.at(-1)||0)+MIN_SPACING-now;
  if(this.job.requests.length>=HOURLY_CAP){this.job.nextRequestAt=this.job.requests[0]+HOUR+100;await this.save();throw Error('Trial hourly request limit; resume after nextRequestAt');}
  if(spacing>0)await delay(spacing,undefined,{signal});signal?.throwIfAborted();
  this.job.requests.push(Date.now());this.job.totalRequests++;this.job.nextRequestAt=null;await this.save();
 }
 async discover(){
  // Science exposes dimensions before downloading. Prioritize its high-resolution
  // masters over legacy Image Library records with unknown/small originals.
  const j=this.job,strict=this.p.cfg.discoveryPolicy===observations.POLICY,cursorKey=strict?'observationCursor':'cursor',cursor=j[cursorKey]||0;
  const [provider,term]=strict?observations.feeds[cursor%observations.feeds.length]:[cursor%5===4?'images':'science',TERMS[Math.floor(cursor/5)%TERMS.length]],key=provider+':'+term;
  j[cursorKey]=cursor;
  if(j.searchBackoff?.[provider]>Date.now()){j[cursorKey]++;return;}
  const page=j.pages[key]||1;if(page>100){j[cursorKey]++;return;}
  let result;
  try{result=await this.p.discoverPage({provider,term,page,pageSize:100});}
  catch(e){
   if(/NASA HTTP 403/.test(e.message)){
    // Respect a refused search endpoint. Do not retry it with alternate headers,
    // identities or URLs; cool that feed down and use already-public inventory.
    j.searchBackoff||={};j.searchBackoff[provider]=Date.now()+HOUR;j.lastSourceError={provider,term,status:403,at:new Date().toISOString()};j[cursorKey]++;await this.save();return;
   }
   if(/NASA HTTP 400/.test(e.message)&&page>1){j.pages[key]=101;j[cursorKey]++;await this.save();return;}throw e;
  }
  j.pages[key]=result.rows<(result.pageSize||100)?101:page+1;j[cursorKey]++;j.metadataSeen+=result.rows;
  for(const id of result.ids){const e=this.p.catalog.assets[id];if(!e||j.baseline.includes(id)||j.ids.includes(id))continue;
   if(e.stage==='rejected'){j.metadataRejected++;continue;}
   if(['queued','downloaded','prepared','masked'].includes(e.stage))j.ids.push(id);
  }
  await this.save();
 }
 async importCachedMetadata(){
  if(this.p.cfg.discoveryPolicy===observations.POLICY||this.job.cachedMetadataImported)return;
  // Reuse only the known NASA metadata receipts from the earlier collection
  // research, normalizing them through the same production source adapter.
  for(const name of ['nircam-all.json','candidates.json','extra.json']){
   const cached=await read(path.join(path.dirname(this.home),name),[]);
   if(!Array.isArray(cached))continue;
   for(const row of cached.slice(0,2000)){
    const candidate=sources.science(row);if(!candidate||candidate.rejection)continue;
    add(this.p.catalog,candidate);const e=this.p.catalog.assets[candidate.id];
    if(e&&!this.job.baseline.includes(e.id)&&!this.job.ids.includes(e.id)&&!terminal(e))this.job.ids.push(e.id);
   }
  }
  this.job.cachedMetadataImported=true;await this.p.save();await this.save();
 }
 async recoverAspectDownloads(){
  if(this.p.cfg.discoveryPolicy===observations.POLICY||this.job.aspectAcquisitionRepair===2)return;
  for(const id of this.job.ids){
   const e=this.p.catalog.assets[id],w=e?.sourceWidth,h=e?.sourceHeight;
   if(e?.stage!=='failed'||!/insufficient_resolution/.test(e.failureReason||'')||!w||!h||
      Math.min(w,h)<2160||Math.max(w,h)<3840||Math.min(w,h)*Math.min(1,4800/Math.max(w,h))>=2160||
      !String(e.assetUrl).startsWith('https://assets.science.nasa.gov/dynamicimage/'))continue;
   const folder=this.p.folder(e),file=path.join(folder,'download.bin');
   // Keep the undersized download and failure as evidence. No source is deleted;
   // corrected requests still pass every existing worker quality check.
   const evidence=e.acquisitionRepair?'download-before-aspect-margin-fix.bin':'download-before-aspect-fix.bin';
   await fs.rename(file,path.join(folder,evidence)).catch(error=>{if(error.code!=='ENOENT')throw error;});
   e.acquisitionRepair={at:new Date().toISOString(),previousFailure:e.failureReason,previousContentHash:e.originalContentHash,earlier:e.acquisitionRepair||null};
   Object.assign(e,{stage:'queued',downloadStatus:'pending',failureReason:null,permanent:false,attempts:0});
   delete e.originalContentHash;await this.p.metadata(e);
  }
  this.job.aspectAcquisitionRepair=2;await this.save();
 }
 async run({target=500,resume=false}={}){
  if(!Number.isInteger(target)||target<1||target>500)throw Error('Trial target must be 1–500 passing images');
  await loadKey();return this.p.locked(async()=>{
   await this.p.recoverRegistration();const existing=await read(this.file,null);
   if(existing&&!resume)throw Error('Existing trial preserved; use resume or status');
   if(!existing&&resume)throw Error('No trial to resume');
   this.job=existing||{version:1,target,status:'running',startedAt:new Date().toISOString(),baseline:Object.keys(this.p.catalog.assets),ids:[],downloads:{},requests:[],totalRequests:0,metadataSeen:0,metadataRejected:0,cursor:0,pages:{}};
   if(this.job.version!==1)throw Error('Unsupported trial');
   // Recover the refused-search checkpoint from the initial CLI version without
   // immediately repeating the request that caused that pause.
   if(this.job.reason==='NASA HTTP 403'){
    const provider=this.job.cursor%5===4?'images':'science';this.job.searchBackoff||={};
    this.job.searchBackoff[provider]=Date.parse(this.job.updatedAt)+HOUR;this.job.cursor++;
   }
   if(this.p.cfg.discoveryPolicy===observations.POLICY)await this.p.revalidate();
   for(const id of this.job.ids){const e=this.p.catalog.assets[id];if(!e||e.stage==='rejected')continue;const reason=this.p.rejection(e);if(reason){e.stage='rejected';e.failureReason=reason;await this.p.metadata(e);}}
   await this.p.publishWallpapers();await this.p.publishWhiteCap();
   if(this.job.status==='complete'&&summary(this.job,this.p.catalog).passed>=this.job.target)return summary(this.job,this.p.catalog);
   if(this.job.status==='complete'){this.job.previousCompletion=this.job.finishedAt;this.job.finishedAt=null;this.job.registration=null;}
   await this.recoverAspectDownloads();
   await this.importCachedMetadata();
   await fs.unlink(this.stopFile).catch(e=>{if(e.code!=='ENOENT')throw e;});
   this.job.status='running';this.job.reason=null;await this.save();
   try{
    while(summary(this.job,this.p.catalog).passed<this.job.target){
     await this.p.idle();if(await read(this.stopFile,null))throw Error('Trial paused by user');
     if(await bytesUnder(path.dirname(this.home))>this.p.cfg.maxStorageGB*1024**3)throw Error('Trial storage ceiling; inspect before resuming');
     if(this.p.catalog.rateLimitedUntil>Date.now())throw Error('NASA rate-limit backoff');
     const processed=summary(this.job,this.p.catalog).processed;
     if(this.job.scanAt===undefined||processed-this.job.scanAt>=10){
      for(let i=0;i<4;i++)await this.discover();this.job.scanAt=processed;await this.save();
     }
     const pending=this.job.ids.map(id=>this.p.catalog.assets[id]).filter(e=>e&&!terminal(e)).sort((a,b)=>b.suitabilityScore-a.suitabilityScore);
     if(!pending.length){
      const feeds=this.p.cfg.discoveryPolicy===observations.POLICY?observations.feeds:TERMS.flatMap(term=>['science','images'].map(provider=>[provider,term]));
      if(feeds.every(([provider,term])=>this.job.pages[provider+':'+term]>100))throw Error('Trial sources exhausted before target');
      const available=[...new Set(feeds.filter(([provider,term])=>!(this.job.pages[provider+':'+term]>100)).map(([provider])=>provider))];
      if(available.every(provider=>this.job.searchBackoff?.[provider]>Date.now())){this.job.nextRequestAt=Math.min(...available.map(provider=>this.job.searchBackoff[provider]));throw Error('Trial discovery backoff');}
      await this.discover();this.log(JSON.stringify(summary(this.job,this.p.catalog)));continue;
     }
     const e=pending[0];await this.p.process(e);await this.save();
     this.log(JSON.stringify({...summary(this.job,this.p.catalog),last:{id:e.id,title:e.title,stage:e.stage,reason:e.failureReason}}));
    }
    this.job.status='complete';this.job.finishedAt=new Date().toISOString();
   }catch(e){this.job.status='paused';this.job.reason=String(e.message).slice(0,300);}
   await this.save();await atomic(path.join(this.home,'status.json'),{...await status({home:this.home,library:this.p.library}),trial:summary(this.job,this.p.catalog)});
   return summary(this.job,this.p.catalog);
  });
 }
 async finish(){return this.p.locked(async()=>{
  this.job=await read(this.file,null);if(!this.job||this.job.status!=='complete'||summary(this.job,this.p.catalog).passed<this.job.target)throw Error('Complete the passing-image target first');
  await this.p.recoverRegistration();this.job.registration=await this.p.register();await this.save();
  await atomic(path.join(this.home,'status.json'),{...await status({home:this.home,library:this.p.library}),trial:summary(this.job,this.p.catalog)});return summary(this.job,this.p.catalog);
 });}
}
async function continueRun(trial,{resume=false,target=500,finish=false,sleep=delay,clock=Date.now}={}){
 let transients=0;
 for(;;){
  let result;
  try{result=await trial.run({resume,target});}
  catch(e){
   if(!busyVisuals(e.message))throw e;
   // locked() may refuse before opening the job when visuals were started
   // during a previous wait. Recover only this existing explicit trial.
   trial.job=await read(trial.file,null);if(!trial.job)throw e;
   trial.p.catalog=await read(path.join(trial.home,'catalog.json'),{assets:{}});
   trial.job.reason=e.message;result=summary(trial.job,trial.p.catalog);
  }
  resume=true;
  if(result.status==='complete'&&!busyVisuals(result.reason)){
   try{
    const report=await trial.p.guarded(signal=>require('./trial-report.cjs').report(trial.home,{signal}));
    if(report.corruptReceipts)throw Error('Qualification receipt validation failed; installation withheld');
    return {...(finish?await trial.finish():result),report:report.report};
   }catch(e){if(!busyVisuals(e.message))throw e;result={...result,reason:e.message};}
  }
  const busy=busyVisuals(result.reason);
  const quota=/hourly request limit|NASA rate-limit backoff|Trial discovery backoff/.test(result.reason||'');
  const transient=/fetch failed|ECONN|ETIMEDOUT|NASA HTTP 50[024]/.test(result.reason||'');
  if(!busy&&!quota&&(!transient||++transients>8))return result;
  const retryAt=busy?clock()+30000:quota?Math.max(clock()+1000,trial.job.nextRequestAt||trial.p.catalog.rateLimitedUntil||clock()+HOUR):clock()+Math.min(60000,5000*2**transients);
  trial.job.status=busy?'waiting-visuals':quota?'waiting-rate-limit':'waiting-network';trial.job.nextRequestAt=retryAt;await trial.save();
  trial.log(JSON.stringify(summary(trial.job,trial.p.catalog)));
  // Same explicit one-off process; no scheduled task. Waits do no image work
  // or remote requests and honor pause without requiring visuals to stop.
  while(clock()<retryAt){if(await read(trial.stopFile,null)){trial.job.status='paused';trial.job.reason='Trial paused by user';await trial.save();return summary(trial.job,trial.p.catalog);}await sleep(Math.min(1000,retryAt-clock()));}
 }
}
async function main(){
 const command=process.argv[2]||'status',trial=new Trial();
 if(command==='status')return read(path.join(HOME,'trial-status.json'),{status:'not started'});
 if(command==='pause'){await atomic(trial.stopFile,{requestedAt:new Date().toISOString()});return {pauseRequested:true};}
 if(command==='start'||command==='resume'){
  const numeric=process.argv.slice(3).find(x=>!x.startsWith('--'));
  return continueRun(trial,{resume:command==='resume',target:Number(numeric||500),finish:process.argv.includes('--finish')});
 }
 if(command==='finish')return trial.finish();
 throw Error('Commands: start [passing target, maximum 500], status, pause, resume, finish');
}
module.exports={Trial,summary,continueRun,HOURLY_CAP,MIN_SPACING};
if(require.main===module)main().then(s=>console.log(JSON.stringify(s,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
