"use strict";
// Manual candidate preparation only. Not called by NASA maintenance or installer.
const fs=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {root,assertIdle,noLinks,read,atomic,hash}=require('./library.cjs');
const run=promisify(execFile);
const work=path.resolve(root,'../preprocessing');
const python=path.join(work,'venv','Scripts','python.exe');
function validateIds(ids){
 if(!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>!/^nasa-science-\d+$/.test(id)))
  throw Error('Provide 1–8 distinct cached nasa-science-N image IDs');
 return ids;
}
function disposition(report,review){
 if(report.status!=='candidate')return 'keep-static';
 if(!review||review.cacheKey!==report.cacheKey||review.imageId!==report.imageId)return 'static-pending-review';
 return review.decision==='ready-for-native-test'?'ready-for-native-test':'keep-static';
}
async function markReviewed(id,key,decision,reason){
 validateIds([id]);
 if(!/^[a-f0-9]{64}$/.test(key)||!['ready-for-native-test','keep-static'].includes(decision)
    ||typeof reason!=='string'||reason.trim().length<12||reason.length>1000)throw Error('Review requires full key, decision and specific reason');
 const folder=path.resolve(root,'../mask-candidates',id+'-'+key.slice(0,20));
 await noLinks(folder);await noLinks(path.join(folder,'candidate.json'));
 const report=await read(path.join(folder,'candidate.json'),null);
 if(!report||report.cacheKey!==key||report.imageId!==id)throw Error('Review candidate identity mismatch');
 if(decision==='ready-for-native-test'&&report.status!=='candidate')throw Error('Static fallback cannot be approved for reactivity');
 for(const [name,sha] of Object.entries(report.files)){
  if(!/^[a-z0-9-]+\.(png|jpg)$/.test(name))throw Error('Invalid candidate member');
  const file=path.join(folder,name);await noLinks(file);
  if(hash(await fs.readFile(file))!==sha)throw Error('Candidate checksum mismatch');
 }
 const reviews=path.join(work,'reviews');await noLinks(reviews);await fs.mkdir(reviews,{recursive:true});
 const record={imageId:id,cacheKey:key,decision,reason:reason.trim(),reviewedAt:new Date().toISOString(),enabled:false};
 await atomic(path.join(reviews,key+'.json'),record);return record;
}
async function prepare(ids,options={}){
 validateIds(ids);
 const idle=options.idle||assertIdle,execute=options.execute||run;
 const directory=options.work||work,executable=options.python||python;
 await idle();await noLinks(directory);await noLinks(executable);
 await fs.access(executable);await fs.mkdir(directory,{recursive:true});
 const lockPath=path.join(directory,'prepare.lock');await noLinks(lockPath);
 const lock=await fs.open(lockPath,'wx').catch(e=>{if(e.code==='EEXIST')throw Error('Mask preprocessing already running or interrupted lock needs inspection');throw e;});
 try{
  const results=[];
  for(const id of ids){
   await idle();const controller=new AbortController();let checking=false,guardError;
   // Stop expensive offline work if a new visualizer session starts during it.
   const timer=setInterval(async()=>{
    if(checking)return;checking=true;
    try{await idle();}catch(e){guardError=e;controller.abort();}finally{checking=false;}
   },2000);
   try{
    const {stdout}=await execute(executable,['-B',options.worker||path.join(__dirname,'preprocessing','worker.py'),id,...(options.workerArgs||[])],{
     windowsHide:true,timeout:120000,maxBuffer:1024*1024,signal:controller.signal,
     env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2',MKL_NUM_THREADS:'2',PYTHONUTF8:'1'}
    });
    if(guardError)throw guardError;
    await idle();const report=JSON.parse(stdout);
    const review=await read(path.join(directory,'reviews',report.cacheKey+'.json'),null);
    report.disposition=disposition(report,review);results.push(report);
   }catch(e){throw guardError||e;}
   finally{clearInterval(timer);}
  }
  return results;
 }finally{await lock.close();await fs.unlink(lockPath);}
}
module.exports={prepare,validateIds,disposition,markReviewed};
if(require.main===module)(process.argv[2]==='review'
 ?markReviewed(...process.argv.slice(3)):prepare(process.argv.slice(2))).then(r=>console.log(JSON.stringify(r,null,2)))
 .catch(e=>{console.error(e.message);process.exitCode=1;});
