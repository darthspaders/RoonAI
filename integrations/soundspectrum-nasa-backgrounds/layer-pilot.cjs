'use strict';
// Explicit three-image experiment. Never imported by maintenance or the production installer.
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {root,assertIdle,noLinks,hash,read,atomic}=require('./library.cjs');
const execute=promisify(execFile),work=path.resolve(root,'../layer-pilot');
const plan=require('./layer-pilot/plan.json');
async function guarded(command,args,options={}){
 await assertIdle();let busy=false,error,active=true;
 const controller=new AbortController();
 const started=Date.now();
 const job=execute(command,args,{windowsHide:true,maxBuffer:2*1024*1024,signal:controller.signal,
  env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'4',OPENBLAS_NUM_THREADS:'4',MKL_NUM_THREADS:'4',TF_NUM_INTRAOP_THREADS:'4',TF_NUM_INTEROP_THREADS:'2',CUDA_VISIBLE_DEVICES:'-1'},...options});
 const timer=setInterval(async()=>{
  if(busy||!active)return;busy=true;
  try{if(Date.now()-started>1800000)throw Error('Pilot worker deadline exceeded');await assertIdle();}
  catch(e){
   if(active){error=e;
    // The Windows venv launcher has a child interpreter. Stop this owned
    // process tree, not just its launcher, if visualization starts.
    if(job.child?.pid&&job.child.exitCode===null&&job.child.signalCode===null)
     await execute('taskkill.exe',['/PID',String(job.child.pid),'/T','/F'],{windowsHide:true,timeout:5000}).catch(()=>{});
    controller.abort();
   }
  }finally{busy=false;}
 },2500);
 try{return await job;}catch(e){throw error||e;}finally{active=false;clearInterval(timer);}
}
async function prepare(ids=plan.images.map(x=>x.id)){
 if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!plan.images.some(x=>x.id===id)))throw Error('Only the three approved pilot IDs are accepted');
 await assertIdle();await noLinks(work);await fs.mkdir(work,{recursive:true});
 const lockFile=path.join(work,'prepare.lock'),lock=await fs.open(lockFile,'wx');
 await lock.writeFile(JSON.stringify({pid:process.pid,started:new Date().toISOString()}));
 const python=path.join(work,'venv/Scripts/python.exe'),worker=path.join(__dirname,'layer-pilot/prepare.py');
 try{
  const pins=await read(path.join(__dirname,'layer-pilot/models.lock.json'),null);
  if(!pins)throw Error('Pinned model receipts missing');
  for(const [member,pin] of Object.entries(pins)){const f=path.join(work,member);await noLinks(f);if(hash(await fs.readFile(f))!==pin.sha256)throw Error('Model checksum mismatch: '+member);}
  for(const id of ids){
   const input=JSON.parse((await guarded(python,['-B',worker,'input',id])).stdout);
   const noxReceipt=await read(path.join(input.folder,'nox.json'),null);
   const output=path.join(input.folder,'nox.tiff');
   const cached=noxReceipt?.sourceSha256===input.sourceSha256 && noxReceipt.modelSha256===pins['nox/noxGeneratorColor.pb'].sha256 && noxReceipt?.sha256===hash(await fs.readFile(output).catch(()=>Buffer.alloc(0)));
   if(!cached){
    console.log('Separating stars: '+id);
    const r=await guarded(path.join(work,'nox/nox.exe'),['-f',input.input,'-o',output,'-r','-b','1','-s','256'],{cwd:path.join(work,'nox')});
    await fs.writeFile(path.join(input.folder,'nox.log'),r.stdout+'\n'+r.stderr);
    await atomic(path.join(input.folder,'nox.json'),{sourceSha256:input.sourceSha256,sha256:hash(await fs.readFile(output)),modelSha256:pins['nox/noxGeneratorColor.pb'].sha256});
   }
   console.log('Preparing masks / depth / layers: '+id);
   const r=await guarded(python,['-B',worker,'analyze',id]);
   await fs.writeFile(path.join(input.folder,'analysis.log'),r.stdout+'\n'+r.stderr);
   console.log(r.stdout.trim());
  }
 }finally{await lock.close();await fs.unlink(lockFile);}
}
module.exports={work,plan,guarded,prepare};
if(require.main===module){
 if(process.argv[2]!=='prepare')throw Error('Usage: node layer-pilot.cjs prepare [approved IDs]');
 prepare(process.argv.length>3?process.argv.slice(3):undefined).catch(e=>{console.error(e.message);process.exitCode=1;});
}
