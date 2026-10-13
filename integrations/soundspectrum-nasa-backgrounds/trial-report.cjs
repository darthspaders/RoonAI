"use strict";
const fs=require('node:fs/promises'),path=require('node:path');
const {HOME,Pipeline,validReceipt}=require('./pipeline.cjs');
const {read,atomic,noLinks}=require('./library.cjs');
const {summary}=require('./trial.cjs');
async function report(home=HOME,{signal}={}){
 const job=await read(path.join(home,'trial-500.json'),null),catalog=await read(path.join(home,'catalog.json'),null);
 if(!job||!catalog)throw Error('No trial catalog');
 const rows=[],corrupt=[];
 for(const id of job.ids){signal?.throwIfAborted();const e=catalog.assets[id];if(!e)continue;
  if(e.stage==='verified')for(const receipt of ['prepared.json','masks.json'])if(!await validReceipt(path.join(home,'assets',id),receipt))corrupt.push({id,receipt});
  rows.push({id,title:e.title,source:e.sourceUrl,provider:e.provider,stage:e.stage,reason:e.failureReason||'',duplicateOf:e.duplicateOf||'',mode:e.maskStatus,
   dimensions:e.prepared?.sourceDimensions||null,stars:e.masks?.quality?.stars||0,bytes:e.localBytes||0});
 }
 const result={...summary(job,catalog),generatedAt:new Date().toISOString(),corruptReceipts:corrupt,rows};
 const directory=path.join(home,'reports');await noLinks(directory);await fs.mkdir(directory,{recursive:true});
 await atomic(path.join(directory,'qualification.json'),result);
 const cell=s=>String(s??'').replace(/\|/g,'/').replace(/[\r\n]+/g,' ');
 const text=['# NASA image qualification', '',`Status: ${result.status}. ${result.passed}/${result.target} new images passed; ${result.remaining} remaining.`,
  `Requests: ${result.totalRequests} total; ${result.requestsInLastHour}/900 in the current rolling hour.`,
  `Downloaded: ${result.downloaded}; duplicates: ${result.duplicates}; failures: ${result.failed}; rejected after admission: ${result.rejected}.`,
  `Receipt failures: ${corrupt.length}. Passing means technical quality and metadata screening, not a guarantee of artistic classification.`,
  '','| Image | Result | Dimensions | Visual response | Stars | Reason |','| --- | --- | --- | --- | --- | --- |',
  ...rows.map(e=>`| ${cell(e.title)} (${e.id}) | ${e.stage} | ${(e.dimensions||[]).join(' × ')} | ${cell(e.mode)} | ${e.stars} | ${cell(e.reason||e.duplicateOf)} |`)];
 await fs.writeFile(path.join(directory,'qualification.md'),text.join('\n')+'\n');return {passed:result.passed,target:result.target,corruptReceipts:corrupt.length,report:path.join(directory,'qualification.md')};
}
module.exports={report};
if(require.main===module)new Pipeline().guarded(signal=>report(HOME,{signal})).then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
