"use strict";
// Explicit reviewed promotion; never called by discovery or background maintenance.
const fs=require('node:fs/promises'),path=require('node:path');
const {root,assertIdle,noLinks,read,atomic,hash}=require('./library.cjs');
const {install}=require('./install.cjs');
const names=['small','medium','large','cloud'];
function png(bytes){
 if(bytes.length<33||bytes.length>12*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'
    ||bytes.readUInt32BE(16)!==1920||bytes.readUInt32BE(20)!==1080||bytes[24]!==8||bytes[25]!==2)throw Error('Expected bounded 1080p RGB emission PNG');
}
async function promote(specs,o={}){
 const runtime=path.resolve(o.root||root),idle=o.assertIdle||assertIdle,installer=o.install||install;
 if(!specs.length||specs.length>39||specs.some(s=>!/^nasa-science-\d+:[a-f0-9]{64}$/.test(s)))throw Error('Provide reviewed image IDs and full candidate keys');
 const ids=specs.map(s=>s.split(':')[0]);if(new Set(ids).size!==ids.length||ids.includes('nasa-science-904703'))throw Error('Duplicate ID or protected Cosmic Cliffs');
 await idle();const destination=path.join(runtime,'reactive-library');await noLinks(destination);await fs.mkdir(destination,{recursive:true});
 const activePath=path.join(destination,'active.json');await noLinks(activePath);
 const prior=await read(activePath,null),library=await read(path.join(runtime,'library.json'),null);
 const entries=[];
 const lockPath=path.resolve(runtime,'../preprocessing/prepare.lock');await noLinks(lockPath);
 const lock=await fs.open(lockPath,'wx');
 try{
  for(const spec of specs){
   await idle();const [id,key]=spec.split(':'),folder=id+'-'+key.slice(0,20);
   const source=path.resolve(runtime,'../curated-masks',folder);await noLinks(source);await noLinks(path.join(source,'candidate.json'));
   const report=await read(path.join(source,'candidate.json'),null);
   if(report?.version!==1||report.imageId!==id||report.key!==key||report.enabled!==false||!library.entries.some(e=>e.id===id&&e.sha256===report.sourceSha256)
      ||!Number.isFinite(report.maxDelta8bit)||report.maxDelta8bit<0||report.maxDelta8bit>7.66)throw Error('Candidate identity or emission budget mismatch');
   const reviewFile=path.join(source,'review.json');await noLinks(reviewFile);const review=await read(reviewFile,null);
   if(review?.key!==key||review.imageId!==id||review.approved!==true||typeof review.reason!=='string'||review.reason.length<12)throw Error('Exact candidate visual review required');
   const target=path.join(destination,folder);await noLinks(target);await fs.mkdir(target,{recursive:true});
   const files={};for(const n of names){
    const member='reactive-'+n+'.png',file=path.join(source,member);await noLinks(file);const bytes=await fs.readFile(file);png(bytes);
    if(hash(bytes)!==report.files?.[member])throw Error('Candidate layer changed');
    const output=path.join(target,member);await noLinks(output);
    const old=await fs.readFile(output).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
    if(old&&hash(old)!==hash(bytes))throw Error('Existing promoted generation edited');
    if(!old)await fs.writeFile(output,bytes,{flag:'wx'});files[member]=hash(bytes);
   }
   entries.push({imageId:id,folder,sourceSha256:report.sourceSha256,key,files,reviewed:true,reviewReason:review.reason});
  }
  await idle();
  if(prior)await atomic(path.join(destination,'previous-active.json'),prior);
  await atomic(activePath,{version:1,enabled:true,entries,activatedAt:new Date().toISOString()});
  try{return {...await installer({...o,root:runtime}),reactiveAdditions:entries.length,enabled:true};}
  catch(e){await atomic(activePath,prior||{version:1,enabled:false,entries:[]});throw e;}
 }finally{await lock.close();await fs.unlink(lockPath);}
}
async function disable(){
 await assertIdle();const file=path.join(root,'reactive-library/active.json'),prior=await read(file,null);
 if(!prior)throw Error('No reactive library');await atomic(file,{...prior,enabled:false});
 try{return await install();}catch(e){await atomic(file,prior);throw e;}
}
module.exports={promote,png};
if(require.main===module)(process.argv[2]==='disable'?disable():promote(process.argv.slice(2)))
 .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
