"use strict";
const fs=require('node:fs/promises'),path=require('node:path');
const {Pipeline,validReceipt}=require('./pipeline.cjs');
const {read,atomic,hash,noLinks}=require('./library.cjs');
const {install}=require('./install.cjs');
async function prepare(o={}){
 const p=o.pipeline||new Pipeline();return p.locked(async()=>{
  const library=await read(path.join(p.library,'library.json'),{entries:[]});
  const prototype=await read(path.join(p.library,'reactive-prototype/prototype.json'),null);
  const active=await read(path.join(p.library,'reactive-library/active.json'),{});
  const directory=path.join(p.library,'motion');await noLinks(directory);await fs.mkdir(directory,{recursive:true});
  const entries=[];
  for(const e of library.entries){
   let receipt;
   if(prototype?.enabled&&prototype.imageId===e.id)receipt=prototype;
   else{const reviewed=active.enabled&&active.entries?.find(x=>x.imageId===e.id);
    if(reviewed)receipt=await read(path.resolve(p.library,'../curated-masks',reviewed.folder,'candidate.json'),null);
    else if(p.catalog.assets[e.id]?.stage==='verified')receipt=await validReceipt(p.folder(e),'masks.json');
   }
   if(!receipt?.stars||receipt.sourceSha256!==e.sha256)continue;
   const source=path.join(p.library,e.file);await noLinks(source);if(hash(await fs.readFile(source))!==e.sha256)throw Error('Motion source changed');
   const folder=path.join(directory,e.id);await noLinks(folder);await fs.mkdir(folder,{recursive:true});
   await atomic(path.join(folder,'input.json'),{source,sourceSha256:e.sha256,stars:receipt.stars});
   const python=path.resolve(p.library,'../preprocessing/venv/Scripts/python.exe');
   await p.guarded(signal=>p.execute(python,['-B',path.join(__dirname,'preprocessing/flares.py'),path.join(folder,'input.json'),folder],{signal,windowsHide:true,timeout:30000,env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}}));
   const flares=await read(path.join(folder,'flares.json'));const bytes=await fs.readFile(path.join(folder,'flare.png'));
   const file=hash(bytes)+'.png';await fs.writeFile(path.join(directory,file),bytes);
   entries.push({imageId:e.id,sourceSha256:e.sha256,stars:flares.stars,flareFile:file,flareSha256:hash(bytes)});
  }
  const manifest={version:1,enabled:false,preparedAt:new Date().toISOString(),entries};
  await atomic(path.join(directory,'prepared.json'),manifest);return {preparedImages:entries.length,animatedStars:entries.reduce((s,e)=>s+e.stars.length,0),enabled:false};
 });
}
async function activate(enabled,o={}){
 const p=o.pipeline||new Pipeline();return p.locked(async()=>{
  const file=path.join(p.library,'motion/active.json'),previous=await read(file,null);
  const manifest=enabled?await read(path.join(p.library,'motion/prepared.json'),null):previous;
  if(!manifest)throw Error('Prepare motion assets first');
  await atomic(file,{...manifest,enabled});
  try{return {...await (o.install||install)({root:p.library,pipelineRoot:p.home,assertIdle:p.idle}),motionEnabled:enabled};}
  catch(e){await atomic(file,previous);throw e;}
 });
}
async function prepareResponse(o={}){
 const p=o.pipeline||new Pipeline();return p.locked(async()=>{
  await p.idle();
  const directory=path.join(p.library,'motion');await noLinks(directory);
  const previous=await read(path.join(directory,'active.json'),null);
  if(previous?.version!==1||!previous.entries?.length)throw Error('Prepare the existing source-bound flare library first');
  const library=await read(path.join(p.library,'library.json'));
  const prototype=await read(path.join(p.library,'reactive-prototype/prototype.json'),null);
  const reviewed=await read(path.join(p.library,'reactive-library/active.json'),null);
  const entries=[];
  for(const item of previous.entries){
   const e=library.entries.find(x=>x.id===item.imageId);if(!e)continue;
   if(e.sha256!==item.sourceSha256)throw Error('Motion source changed');
   const selected=reviewed?.enabled&&reviewed.entries.find(x=>x.imageId===e.id);
   const receipt=selected||(prototype?.enabled&&prototype.imageId===e.id?prototype:null);
   if(!receipt)throw Error('Reviewed cloud source unavailable');
   const emission=selected?path.join(p.library,'reactive-library',selected.folder,'reactive-cloud.png'):path.join(p.library,'reactive-prototype/reactive-cloud.png');
   const source=path.join(p.library,e.file);await noLinks(source);await noLinks(emission);
   const folder=path.join(directory,e.id);await noLinks(folder);await fs.mkdir(folder,{recursive:true});
   await atomic(path.join(folder,'cloud-input.json'),{source,sourceSha256:e.sha256,emission,emissionSha256:receipt.files['reactive-cloud.png']});
   const python=path.resolve(p.library,'../preprocessing/venv/Scripts/python.exe');
   await p.guarded(signal=>p.execute(python,['-B',path.join(__dirname,'preprocessing/cloud_motion.py'),path.join(folder,'cloud-input.json'),path.join(folder,'cloud.json')],{signal,windowsHide:true,timeout:30000,env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}}));
   const cloud=await read(path.join(folder,'cloud.json'));
   const cloudBytes=await fs.readFile(path.join(folder,'cloud-flow.png'));
   if(hash(cloudBytes)!==cloud.fileSha256)throw Error('Prepared cloud changed');
   await fs.writeFile(path.join(directory,cloud.fileSha256+'.png'),cloudBytes);
   entries.push({...item,cloudMotion:cloud.activeVertices?cloud.grid:null,cloudEmissionSha256:cloud.emissionSha256,cloudFile:cloud.fileSha256+'.png',cloudSha256:cloud.fileSha256});
  }
  const manifest={...previous,enabled:false,automaticStars:true,responseVersion:2,preparedAt:new Date().toISOString(),entries};
  await atomic(path.join(directory,'prepared.json'),manifest);
  return {preparedImages:entries.length,cloudImages:entries.filter(x=>x.cloudMotion).length,automaticStars:true,enabled:false};
 });
}
module.exports={prepare,activate,prepareResponse};
if(require.main===module){const command=process.argv[2];(command==='prepare'?prepare():command==='prepare-response'?prepareResponse():command==='enable'?activate(true):command==='disable'?activate(false):Promise.reject(Error('Commands: prepare, prepare-response, enable, disable'))).then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});}
