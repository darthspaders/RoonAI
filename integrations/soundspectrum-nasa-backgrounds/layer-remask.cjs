'use strict';
// Explicit, resumable remasking. Never publishes unreviewed segmentation.
const fs=require('node:fs/promises'),path=require('node:path');
const {root,read,atomic,hash,noLinks,assertIdle}=require('./library.cjs');
const pilot=require('./layer-pilot.cjs');
const work=path.resolve(root,'../layer-remask-v2');
const worker=path.join(__dirname,'layer-remask/prepare.py');
const python=path.join(pilot.work,'venv/Scripts/python.exe');
function classify(e){
 const text=[e.title,e.target].join(' ');
 const description=e.description||'';
 // A gas mention does not make a whole galaxy or terrestrial sky a cloud subject.
 const excluded=/galax|deep field|cluster|island universe|countryside|landscape|skyscape/i.test(text)||/\b(?:dwarf|spiral|elliptical|starburst) galaxy\b/i.test(description);
 return !excluded&&(/nebula|cloud|remnant|\bhh \d|star.forming/i.test(text)||/nebula|cloud complex|glowing gases|gas cloud|molecular cloud|star.forming region/i.test(description));
}
async function init(){
 await noLinks(work);await fs.mkdir(work,{recursive:true});
 const prior=await read(path.join(work,'plan.json'),null);if(prior)return prior;
 const library=await read(path.join(root,'library.json'));
 const images=library.entries.map(e=>{
  const old=pilot.plan.images.find(x=>x.id===e.id&&x.sha256===e.sha256);
  const cloud=old?old.cloud:classify(e);
  return {id:e.id,sha256:e.sha256,title:e.title,cloud,points:old?.points||[],labels:old?.labels||[],reviewedPoints:!!old,
   maxMotionPixels:cloud?[64,48]:[0,0],meshSize:[33,19],interiorOnly:true,rebuildSam:true};
 }).sort((a,b)=>Number(b.reviewedPoints)-Number(a.reviewedPoints));
 const plan={version:2,createdAt:new Date().toISOString(),images};await atomic(path.join(work,'plan.json'),plan);return plan;
}
async function runOwned(limit=Infinity){
 if(limit!==Infinity&&(!Number.isSafeInteger(limit)||limit<1))throw Error("Invalid remask limit");
 const plan=await init();await assertIdle();
 const lockFile=path.join(work,'run.lock');await noLinks(lockFile);
 // Reclaim a dead owner only, retaining its receipt for diagnosis.
 const old=await read(lockFile,null);if(old){let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('Remask owner already running');await fs.rename(lockFile,lockFile+'.dead-'+Date.now());}
 const lock=await fs.open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));
 const file=path.join(work,'status.json');const state=await read(file,{version:2,entries:{}});
 state.total=plan.images.length;state.pid=process.pid;state.status='running';state.startedAt=new Date().toISOString();state.reason=null;state.current=null;
 async function save(){state.updatedAt=new Date().toISOString();state.completed=Object.values(state.entries).filter(e=>['candidate','flares-only'].includes(e.status)).length;state.failed=Object.values(state.entries).filter(e=>e.status==='failed').length;state.remaining=state.total-state.completed-state.failed;await atomic(file,state);}
 await save();
 try{
  const pins=await read(path.join(__dirname,'layer-pilot/models.lock.json'));
  for(const [name,pin] of Object.entries(pins)){const f=path.join(pilot.work,name);await noLinks(f);if(hash(await fs.readFile(f))!==pin.sha256)throw Error('Remask model checksum mismatch: '+name);}
  let count=0;
  if(limit===Infinity){
   // Cheap source-bound flare remasks share one interpreter. Heavy cloud work
   // remains per-image, checkpointed and interruptible by the idle guard.
   state.stage='flare-remasking';await save();
   await pilot.guarded(python,['-B',worker,'flares']);
   state.stage='cloud-remasking';await save();
  }
  for(const cfg of plan.images){
   const folder=path.join(work,cfg.id+'-'+cfg.sha256.slice(0,12));await noLinks(folder);
   const receipt=await read(path.join(folder,'candidate.json'),null);
   if(receipt?.version===2&&receipt.sourceSha256===cfg.sha256&&['candidate','flares-only'].includes(receipt.status)){
    let valid=true;for(const [n,d]of Object.entries(receipt.files||{})){await noLinks(path.join(folder,n));if(hash(await fs.readFile(path.join(folder,n)))!==d)valid=false;}
    if(valid){state.entries[cfg.id]={status:receipt.status,sourceSha256:cfg.sha256};continue;}
   }
   if(count>=limit)continue;
   await assertIdle();
   const {bytesUnder,config}=require('./pipeline.cjs');
   const settings=config(await read(path.resolve(root,'../pipeline/config.json'),{}));
   if(await bytesUnder(path.dirname(root))+256*1024*1024>settings.maxStorageGB*1024**3)throw Error('Remask paused at the existing NASA storage ceiling; originals and candidates preserved');
   state.current=cfg.id;state.entries[cfg.id]={status:'running',sourceSha256:cfg.sha256};await save();
   try{
    if(cfg.cloud){
     // Reject bad semantic candidates before expensive star/depth processing.
     await pilot.guarded(python,['-B',worker,'segment',cfg.id]);
     const input=JSON.parse((await pilot.guarded(python,['-B',worker,'input',cfg.id])).stdout);
     const sourceFolder=path.join(pilot.work,cfg.id+'-'+cfg.sha256.slice(0,12));
     const prev=await read(path.join(sourceFolder,'nox.json'),null);
     const local=await read(path.join(folder,'nox.json'),null);
     const output=path.join(folder,'nox.tiff');
     const valid=local?.sourceSha256===cfg.sha256&&local.modelSha256===pins['nox/noxGeneratorColor.pb'].sha256&&local.sha256===hash(await fs.readFile(output).catch(()=>Buffer.alloc(0)));
     if(!valid){
      if(prev?.sourceSha256===cfg.sha256&&prev.modelSha256===pins['nox/noxGeneratorColor.pb'].sha256&&hash(await fs.readFile(path.join(sourceFolder,'nox.tiff')))==prev.sha256){
       await fs.copyFile(path.join(sourceFolder,'nox.tiff'),output);
       // Source-bound depth is reusable; SAM is deliberately rerun.
       for(const n of ['depth-da3.png','depth.json'])await fs.copyFile(path.join(sourceFolder,n),path.join(folder,n));
      }else{
       const result=await pilot.guarded(path.join(pilot.work,'nox/nox.exe'),['-f',input.input,'-o',output,'-r','-b','1','-s','256'],{cwd:path.join(pilot.work,'nox')});
       await fs.writeFile(path.join(folder,'nox.log'),result.stdout+'\n'+result.stderr);
      }
      await atomic(path.join(folder,'nox.json'),{sourceSha256:cfg.sha256,modelSha256:pins['nox/noxGeneratorColor.pb'].sha256,sha256:hash(await fs.readFile(output))});
     }
    }
    const result=await pilot.guarded(python,['-B',worker,'analyze',cfg.id]);await fs.writeFile(path.join(folder,'analysis.log'),result.stdout+'\n'+result.stderr);
    const r=await read(path.join(folder,'candidate.json'));state.entries[cfg.id]={status:r.status,sourceSha256:cfg.sha256,review:r.review};
   }catch(e){
    await assertIdle(); // A visual-start interruption pauses, never marks an image bad.
    state.entries[cfg.id]={status:'failed',sourceSha256:cfg.sha256,reason:String(e.message).slice(0,1600)};
   }
   count++;await save();console.log(JSON.stringify({current:cfg.id,...state.entries[cfg.id],completed:state.completed,remaining:state.remaining}));
  }
  state.current=null;state.status=state.remaining?'paused':state.failed?'complete-with-failures':'complete';await save();
 }catch(e){state.status='paused';state.reason=e.message;if(state.current&&state.entries[state.current]?.status==='running')state.entries[state.current]={...state.entries[state.current],status:'pending',reason:e.message};await save();throw e;}
 finally{try{state.pid=null;await save();}finally{await lock.close();await fs.unlink(lockFile);}}
 return {total:state.total,completed:state.completed,remaining:state.remaining,failed:state.failed,status:state.status};
}
async function run(limit=Infinity){const {Pipeline}=require("./pipeline.cjs");return new Pipeline().locked(()=>runOwned(limit));}
module.exports={work,init,run,classify};
if(require.main===module){const command=process.argv[2];const task=command==='init'?init().then(p=>({total:p.images.length,cloudCandidates:p.images.filter(e=>e.cloud).length})):command==='status'?read(path.join(work,'status.json'),{status:'not-started'}):command==='run'?run(process.argv[3]?Number(process.argv[3]):Infinity):Promise.reject(Error('Usage: layer-remask.cjs init|status|run [image limit]'));task.then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});}
