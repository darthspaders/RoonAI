'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {root,noLinks,hash,read}=require('../library.cjs');
const {literal}=require('../install.cjs');
const {work,plan}=require('../layer-pilot.cjs');
function pythonValue(value){
 if(value===null)return 'None';
 if(typeof value==='boolean')return value?'True':'False';
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Non-finite Python literal');return String(value);}
 if(typeof value==='string')return literal(value);
 if(Array.isArray(value))return '['+value.map(pythonValue).join(',')+']';
 return '{'+Object.entries(value).map(([k,v])=>literal(k)+':'+pythonValue(v)).join(',')+'}';
}
async function sceneFiles(packageName,options={}){
 if(!/^RabbitHole\.[A-Za-z]+\.package$/.test(packageName))throw Error('Invalid pilot package name');
 const files={},targets=[],body=await fs.readFile(path.join(__dirname,'LayeredPhoto.py'),'utf8');
 for(const cfg of plan.images){
  const folder=path.join(work,cfg.id+'-'+cfg.sha256.slice(0,12));await noLinks(folder);
  const report=await read(path.join(folder,'candidate.json'),null);
  if(!report||report.sourceSha256!==cfg.sha256||report.imageId!==cfg.id||report.enabled!==false||report.neutralMaxError!==0||report.cloud!==cfg.cloud)throw Error('Pilot source/reconstruction mismatch');
  if(report.grid?.[0]!==65||report.grid?.[1]!==37||report.grid[2]?.length!==65*37||report.grid[2].some(v=>!Number.isFinite(v)||v<0||v>1))throw Error('Invalid pilot mesh');
  if(!Array.isArray(report.maxMotionPixels)||report.maxMotionPixels.length!==2||report.maxMotionPixels.some((v,i)=>!Number.isFinite(v)||v<0||v>32||v!==cfg.maxMotionPixels[i]))throw Error('Pilot motion bounds differ from the reviewed plan');
  const paths=[];
  for(const name of ['source.jpg','background.png','cloud-rgba.png','stellar.png']){
   const file=name==='source.jpg'?path.join(root,cfg.sha256+'.jpg'):path.join(folder,name);await noLinks(file);
   const bytes=await fs.readFile(file),expected=name==='source.jpg'?cfg.sha256:report.files[name];
   if(hash(bytes)!==expected||bytes.length>40*1024*1024)throw Error('Pilot member checksum mismatch');
   const member=cfg.id+'-'+name;files[member]=bytes;paths.push('/Packages/'+packageName+'/'+member);
  }
  const settings={imageId:cfg.id,cloud:cfg.cloud,maxMotionPixels:report.maxMotionPixels,grid:report.grid};
  const script=cfg.id+'.py';
  files[script]=Buffer.from('PILOT_CONFIG = '+pythonValue(settings)+'\nPILOT_PATHS = '+pythonValue(paths)+'\n'+body);
  let expressive=false;
  // The selectable production three-image tour follows the user's universal
  // expressive policy. Scientific research/probe callers retain the old control.
  if(options.expressive&&await require('../expressive.cjs').enabled(root)){
   const file=path.join(root,'expressive',cfg.sha256+'.json');await noLinks(file);
   const receipt=require('../expressive.cjs').validate(await read(file,null),cfg.sha256);
   const active=await read(path.join(root,'expressive/active.json'));
   const flareFile=path.join(root,'expressive/flare.png');await noLinks(flareFile);const flare=await fs.readFile(flareFile);
   if(hash(flare)!==active.flareSha256)throw Error('Expressive tour flare checksum mismatch');
   // Keep the self-contained 16-member package contract. This installed copy
   // now holds the flare; original stellar residuals remain in research storage.
   files[cfg.id+'-stellar.png']=flare;
   files[script]=Buffer.from('IMAGE_PATH = '+pythonValue(paths[0])+'\nEXPRESSIVE_CONFIG = '+pythonValue({imageId:cfg.id,grid:receipt.grid,stars:receipt.stars})+'\nEXPRESSIVE_FLARE = '+pythonValue(paths[3])+'\n'+await fs.readFile(path.join(__dirname,'../ExpressivePhoto.py'),'utf8'));
   const layers=await require('../layer-remask/install.cjs').scene(root,{id:cfg.id,sha256:cfg.sha256},packageName);
   if(layers){Object.assign(files,layers.files);files[script]=Buffer.concat([files[script],Buffer.from(layers.code)]);}
   expressive=true;
  }
  targets.push({id:cfg.id,name:'Pilot NASA - '+(expressive?cfg.label.replace(' - control',''):cfg.label),cloud:expressive||cfg.cloud,script});
 }
 return {files,targets};
}
module.exports={pythonValue,sceneFiles};
