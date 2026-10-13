"use strict";
const fs=require('node:fs/promises'),path=require('node:path');
const {root,hash,assertIdle,noLinks,read,atomic}=require('./library.cjs');
const packageName='RabbitHole.SpaceImages.package';
function options(o={}){const runtime=path.resolve(o.root||root);return {...o,root:runtime,directory:path.resolve(o.directory||path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','SoundSpectrum/WhiteCap/Packages',packageName)),assertIdle:o.assertIdle||assertIdle};}
function literal(s){return 'u'+JSON.stringify(s).replace(/[^\x20-\x7e]/g,x=>'\\u'+x.charCodeAt(0).toString(16).padStart(4,'0'));}
async function desired(o={}){
 const c=options(o),library=await read(path.join(c.root,'library.json'),null);
 if(library?.version!==1||!Array.isArray(library.entries)||!library.entries.length||new Set(library.entries.map(e=>e.id)).size!==library.entries.length)throw Error('No valid prepared NASA library');
 const template=await fs.readFile(path.join(__dirname,'Photo.py'),'utf8'),files={},displayNames=new Set();let registrations=[];
 // Production planning/installation retains only hashes, never the entire 4K
 // collection in memory. Existing callers can still inspect small buffer maps.
 async function put(name,bytes){
  if(Object.hasOwn(files,name))throw Error('Duplicate package member');
  if(c.onFile)await c.onFile(name,bytes);
  files[name]=c.hashOnly||c.onFile?hash(bytes):bytes;
 }
 const prototype=await read(path.join(c.root,'reactive-prototype','prototype.json'),null);
 const reactive=prototype?.enabled===true;
 if(reactive&&(prototype.version!==1||prototype.imageId!=='nasa-science-904703'||!library.entries.some(e=>e.id===prototype.imageId&&e.sha256===prototype.sourceSha256)))throw Error('Reactive prototype source mismatch');
 const activeFile=path.join(c.root,'reactive-library','active.json');await noLinks(activeFile);
 const active=await read(activeFile,null),curated=new Map();
 const expressive=await read(path.join(c.root,'expressive/active.json'),null);
 if(expressive?.enabled){
  if(expressive.version!==1||![require('./expressive.cjs').VERSION,require('./expressive.cjs').RENDERER_VERSION].includes(expressive.rendererVersion))throw Error('Unknown expressive renderer');
  const sprite=path.join(c.root,'expressive/flare.png');await noLinks(sprite);const bytes=await fs.readFile(sprite);
  if(bytes.length>128*1024||hash(bytes)!==expressive.flareSha256)throw Error('Expressive flare checksum mismatch');
  await put('expressive-flare.png',bytes);
 }
 const motion=await read(path.join(c.root,'motion/active.json'),null),moving=new Map();
 let automaticFlarePath=null;
 if(motion?.enabled===true){
  if(motion.version!==1||!Array.isArray(motion.entries)||motion.entries.length>40)throw Error('Invalid motion library');
  for(const item of motion.entries){
   if(!/^nasa-(?:science-\d+|auto-[a-f0-9]{24})$/.test(item.imageId)||moving.has(item.imageId)||!Array.isArray(item.stars)||item.stars.length>12
    ||!item.stars.every(s=>Array.isArray(s)&&s.length===8&&s.every(Number.isFinite)&&s[0]>=0&&s[0]<=1&&s[1]>=0&&s[1]<=1&&s[2]>0&&s[2]<=.04&&Number.isInteger(s[3])&&s[3]>=0&&s[3]<=2&&s.slice(5).every(v=>v>=0&&v<=1))
    ||!/^[a-f0-9]{64}\.png$/.test(item.flareFile)||item.flareFile!==item.flareSha256+'.png')throw Error('Invalid source-bound flares');
   // A bounded pool may rotate an image out; retain its preparation for reuse.
   const source=library.entries.find(e=>e.id===item.imageId);if(!source)continue;
   if(source.sha256!==item.sourceSha256)throw Error('Motion source mismatch');
   const file=path.join(c.root,'motion',item.flareFile);await noLinks(file);const bytes=await fs.readFile(file);
   if(bytes.length>128*1024||hash(bytes)!==item.flareSha256)throw Error('Flare checksum mismatch');
   if(!Object.hasOwn(files,'stellar-flare.png'))await put('stellar-flare.png',bytes);moving.set(item.imageId,item);
   if(motion.automaticStars===true)automaticFlarePath=literal('/Packages/'+packageName+'/stellar-flare.png');
  }
 }
 const automatic=await read(path.join(c.root,'pipeline-active.json'),null),automated=new Map();
 if(automatic?.enabled===true){
  if(automatic.version!==1||!Array.isArray(automatic.entries)||automatic.entries.length>library.entries.length)throw Error('Invalid pipeline registration');
  for(const item of automatic.entries){
   if(!/^nasa-(?:science-\d+|auto-[a-f0-9]{24})$/.test(item.imageId)||item.folder!==item.imageId||automated.has(item.imageId)||!library.entries.some(e=>e.id===item.imageId&&e.sha256===item.sourceSha256))throw Error('Pipeline source mismatch');
   automated.set(item.imageId,item);
  }
 }
 if(active?.enabled===true){
  if(active.version!==1||!Array.isArray(active.entries)||active.entries.length>39)throw Error('Invalid reactive library');
  for(const item of active.entries){
   if(!/^nasa-science-\d+$/.test(item.imageId)||item.imageId==='nasa-science-904703'||curated.has(item.imageId)
      ||!/^nasa-science-\d+-[a-f0-9]{20}$/.test(item.folder)||!item.folder.startsWith(item.imageId+'-')
      ||item.reviewed!==true||!library.entries.some(e=>e.id===item.imageId&&e.sha256===item.sourceSha256))throw Error('Reactive library source/review mismatch');
   curated.set(item.imageId,item);
  }
 }
 for(const e of library.entries){
  if(!/^[a-f0-9]{64}\.jpg$/.test(e.file)||e.sha256!==e.file.slice(0,-4)||e.width!==3840||e.height!==2160||!/^nasa-(?:science-\d+|auto-[a-f0-9]{24})$/.test(e.id))throw Error('Invalid prepared image');
  await noLinks(path.join(c.root,e.file));const image=await fs.readFile(path.join(c.root,e.file));if(hash(image)!==e.sha256)throw Error('Prepared image hash mismatch');
  const script=e.id+'.py',imageName=e.id+'.jpg';
  await put(imageName,image);
  let body=template, lightPaths=[];
  const addition=curated.get(e.id)||automated.get(e.id),auto=automated.has(e.id);
  if((reactive&&e.id===prototype.imageId)||addition){
   for(const name of ['small','medium','large','cloud']){
    const sourceMember='reactive-'+name+'.png';
    const member=addition?e.id+'-reactive-'+name+'.png':sourceMember;
    const file=auto?path.join(c.pipelineRoot||path.resolve(c.root,'../pipeline'),'assets',addition.folder,sourceMember):addition?path.join(c.root,'reactive-library',addition.folder,sourceMember):path.join(c.root,'reactive-prototype',sourceMember);
    await noLinks(file);const bytes=await fs.readFile(file);
    if(bytes.length>12*1024*1024||hash(bytes)!==(addition||prototype).files?.[sourceMember])throw Error('Reactive layer hash mismatch');
    await put(member,bytes);lightPaths.push(literal('/Packages/'+packageName+'/'+member));
   }
   body='LIGHT_PATHS = ['+lightPaths.join(',')+']\n'+await fs.readFile(path.join(__dirname,'ReactivePhoto.py'),'utf8');
   let effect=moving.get(e.id);
   // Reuse only admitted pipeline stars. No runtime detection and no relaxed
   // astronomical classification; future qualified images follow this policy.
   if(!effect&&auto&&automaticFlarePath){
    const receiptFile=path.join(c.pipelineRoot||path.resolve(c.root,'../pipeline'),'assets',addition.folder,'masks.json');
    await noLinks(receiptFile);const receipt=await read(receiptFile,null);
    if(receipt?.sourceSha256!==e.sha256||receipt.quality?.status!=='reactive'||(receipt.stars!==undefined&&!Array.isArray(receipt.stars))
      ||Object.entries(addition.files).some(([n,h])=>receipt.files?.[n]!==h))throw Error('Automatic flare source mismatch');
    // Older accepted receipts can lack coordinates. Keep their emission only.
    const stars=(receipt.stars||[]).slice().sort((a,b)=>b.flux-a.flux).slice(0,12).map((s,i)=>{
     const channel=['small','medium','large'].indexOf(s.group);
     if(![s.x,s.y,s.diameter,s.flux].every(Number.isFinite)||s.x<0||s.x>=1920||s.y<0||s.y>=1080||s.diameter<=0||channel<0)throw Error('Invalid admitted star');
     return [s.x/1920,s.y/1080,Math.min(74,Math.max(18,s.diameter*5))/1920,channel,i*2.39996323,.94,.97,1];
    });
    if(stars.length)effect={stars};
   }
   const cloud=effect?.cloudMotion||null;
   let cloudPath='None';
   if(cloud){
    if(!Array.isArray(cloud)||cloud[0]!==33||cloud[1]!==19||!Array.isArray(cloud[2])||cloud[2].length!==33*19
      ||cloud[2].some((v,i)=>!Number.isFinite(v)||v<0||v>.92||((i<33||i>=33*18||i%33===0||i%33===32)&&v!==0)))throw Error('Invalid source-bound cloud motion');
    if(effect.cloudEmissionSha256!==(addition||prototype).files?.['reactive-cloud.png'])throw Error('Cloud emission source mismatch');
    if(!/^[a-f0-9]{64}\.png$/.test(effect.cloudFile)||effect.cloudFile!==effect.cloudSha256+'.png')throw Error('Invalid cloud file');
    const cloudFile=path.join(c.root,'motion',effect.cloudFile);await noLinks(cloudFile);const bytes=await fs.readFile(cloudFile);
    if(bytes.length>12*1024*1024||hash(bytes)!==effect.cloudSha256)throw Error('Cloud checksum mismatch');
    const member=e.id+'-cloud-flow.png';await put(member,bytes);cloudPath=literal('/Packages/'+packageName+'/'+member);
   }
   body='CLOUD_PATH = '+cloudPath+'\nCLOUD_MOTION = '+(cloud?JSON.stringify(cloud):'None')+'\n'+body;
   if(effect)body='LIVELY_STARS = True\nFLARE_PATH = '+literal('/Packages/'+packageName+'/stellar-flare.png')+'\nFLARE_STARS = '+JSON.stringify(effect.stars)+'\n'+body;
   // Native scene namespaces can retain globals from earlier entries. Every
   // reactive scene must declare its own motion state, including disabled.
   else body='LIVELY_STARS = False\nFLARE_PATH = None\nFLARE_STARS = []\n'+body;
  }
  if(expressive?.enabled){
   const file=path.join(c.root,'expressive',e.sha256+'.json');await noLinks(file);
   const receipt=require('./expressive.cjs').validate(await read(file,null),e.sha256);
   const config={imageId:e.id,grid:receipt.grid,stars:receipt.stars};
   // The vendor embeds a minimal Python 2 runtime, without json. These fields
   // are validated strings/numeric arrays, so emit Python literals directly.
   body='EXPRESSIVE_CONFIG = {"imageId": '+literal(config.imageId)+', "grid": '+JSON.stringify(config.grid)+', "stars": '+JSON.stringify(config.stars)+'}\nEXPRESSIVE_FLARE = '+literal('/Packages/'+packageName+'/expressive-flare.png')+'\n'+await fs.readFile(path.join(__dirname,'ExpressivePhoto.py'),'utf8');
  }
  if(expressive?.enabled){
   const layers=await require('./layer-remask/install.cjs').scene(c.root,e,packageName);
   if(layers){for(const [name,bytes] of Object.entries(layers.files))await put(name,bytes);body+=layers.code;}
  }
  await put(script,Buffer.from('IMAGE_PATH = '+literal('/Packages/'+packageName+'/'+imageName)+'\n'+body,'utf8'));
  const base=String(e.target||e.title||e.id).normalize('NFKD').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'').replace(/[^\x20-\x7e]/g,'').replace(/[\\/]/g,'-');
  // The native tour deduplicates by display name. Keep existing names and give
  // subsequent distinct images of the same target an exact source-ID suffix.
  let display=base;
  while(displayNames.has(display))display+=' ['+e.id+']';
  displayNames.add(display);
  registrations.push('    pkg.AddEntry('+literal('NASA - '+display)+'.encode(\'utf-8\'), '+literal(script)+'.encode(\'utf-8\'))');
 }
 await put('_package.py',Buffer.from('# -*- coding: utf-8 -*-\n# Ordinary Background entries, discovered by the existing artwork rotation.\ndef ExportPackage(inPathname):\n    pkg = VisPackage(inPathname)\n    pkg.DefaultEntryConfigType = \'Background\'\n'+registrations.join('\n')+'\n    return pkg\n'));
 return files;
}
async function install(o={}){
 const c=options(o);await c.assertIdle();await noLinks(c.directory);await noLinks(c.root);
 const files=await desired({...c,hashOnly:true}),recordPath=path.join(c.root,'installation.json'),prior=await read(recordPath,null);
 const members=await fs.readdir(c.directory).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
 if(members&&!prior)throw Error('Unowned NASA package preserved');
 if(prior&&(!prior.files||prior.directory!==c.directory))throw Error('Invalid NASA ownership record');
 for(const n of members||[]){
  if(!prior.files[n])throw Error('Unowned NASA package member preserved');
  const f=path.join(c.directory,n);await noLinks(f);const digest=hash(await fs.readFile(f));if(digest!==prior.files[n]&&files[n]!==digest)throw Error('Edited NASA package preserved');
 }
 // Keep a single previous owned generation for rollback; never touch factory files.
 const stage=c.directory+'.stage',backup=c.directory+'.previous';await noLinks(stage);await noLinks(backup);
 if(await fs.stat(stage).catch(()=>null))throw Error('Previous NASA staging directory needs inspection');
 await fs.mkdir(stage,{recursive:true});
 try{let checkedAt=0;
  const staged=await desired({...c,onFile:async(n,b)=>{
   if(Date.now()-checkedAt>2000){await c.assertIdle();checkedAt=Date.now();}
   if(hash(b)!==files[n])throw Error('NASA preparation changed during installation');
   await fs.writeFile(path.join(stage,n),b,{flag:'wx'});
  }});
  if(Object.keys(staged).length!==Object.keys(files).length)throw Error('NASA preparation changed during installation');
  await c.assertIdle();
  const oldBackup=await read(path.join(c.root,'backup.json'),null);
  if(await fs.stat(backup).catch(()=>null)){
   if(!oldBackup?.files)throw Error('Unowned backup preserved');
   const members=await fs.readdir(backup);
   for(const n of members){if(!oldBackup.files[n])throw Error('Unowned backup member preserved');const f=path.join(backup,n);await noLinks(f);if(hash(await fs.readFile(f))!==oldBackup.files[n])throw Error('Edited backup preserved');}
   for(const n of members)await fs.unlink(path.join(backup,n));await fs.rmdir(backup);
  }
  if(members){await atomic(path.join(c.root,'backup.json'),prior);await fs.rename(c.directory,backup);}
  try{await fs.rename(stage,c.directory);}catch(e){if(members)await fs.rename(backup,c.directory);throw e;}
  await atomic(recordPath,{version:1,directory:c.directory,files,installedAt:new Date().toISOString()});
 }catch(e){
  // Clean only the exact staged files this invocation created; preserve anything else.
  for(const [n,digest] of Object.entries(files)){const f=path.join(stage,n);const current=await fs.readFile(f).catch(()=>null);if(current&&hash(current)===digest)await fs.unlink(f);}
  await fs.rmdir(stage).catch(()=>{});throw e;
 }
 return {installedImages:Object.keys(files).filter(n=>/^nasa-(?:science-\d+|auto-[a-f0-9]{24})\.py$/.test(n)).length,packageName,loaded:false};
}
module.exports={desired,install,literal,options};
if(require.main===module)install().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
