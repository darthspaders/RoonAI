'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {read,atomic,noLinks,hash}=require('./library.cjs');
const VERSION='expressive-1';
const RENDERER_VERSION='stable-photo-flares-2';
function validate(receipt,digest){
 if(receipt?.version!==VERSION||receipt.sourceSha256!==digest||receipt.grid?.[0]!==25||receipt.grid?.[1]!==15||receipt.grid?.[2]?.length!==375||receipt.grid[2].some((v,i)=>!Number.isFinite(v)||v<0||v>1||((i<25||i>=350||i%25===0||i%25===24)&&v!==0))||!Array.isArray(receipt.stars)||receipt.stars.length>24||receipt.stars.some(s=>!Array.isArray(s)||s.length!==4||s.some(v=>!Number.isFinite(v))||s[0]<0||s[0]>1||s[1]<0||s[1]>1||s[2]<.005||s[2]>.04))throw Error('Invalid expressive source-bound receipt');
 return receipt;
}
async function enabled(library){return (await read(path.join(library,'expressive/active.json'),{})).enabled===true;}
async function prepare(p,e){
 if(!await enabled(p.library))return;
 const file=path.join(p.library,'expressive',e.presentationSha256+'.json');await noLinks(file);
 const prior=await read(file,null);if(prior){validate(prior,e.presentationSha256);return;}
 const source=path.join(p.folder(e),'background-4k.jpg');await noLinks(source);
 if(hash(await fs.readFile(source))!==e.presentationSha256)throw Error('Expressive source checksum changed');
 await p.guarded(signal=>p.execute(path.resolve(p.library,'../preprocessing/venv/Scripts/python.exe'),['-B',path.join(__dirname,'preprocessing/expressive.py'),source,file],{windowsHide:true,timeout:60000,maxBuffer:1024*1024,signal,env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}}));
 validate(await read(file,null),e.presentationSha256);
}
async function prepareAll(p){
 await p.guarded(signal=>p.execute(path.resolve(p.library,'../preprocessing/venv/Scripts/python.exe'),['-B',path.join(__dirname,'preprocessing/expressive.py'),'batch',p.library],{windowsHide:true,timeout:600000,maxBuffer:4*1024*1024,signal,env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}}));
 const library=await read(path.join(p.library,'library.json'));let stars=0;
 for(const e of library.entries){const r=validate(await read(path.join(p.library,'expressive',e.sha256+'.json')),e.sha256);stars+=r.stars.length;}
 const sprite=await fs.readFile(path.join(p.library,'expressive/flare.png'));
 return {version:1,enabled:true,rendererVersion:RENDERER_VERSION,prepared:library.entries.length,stellarAnchors:stars,flareSha256:hash(sprite),preparedAt:new Date().toISOString()};
}
async function activate(p){const receipt=await prepareAll(p);await atomic(path.join(p.library,'expressive/active.json'),receipt);return receipt;}
module.exports={VERSION,RENDERER_VERSION,validate,enabled,prepare,prepareAll,activate};
if(require.main===module){const {Pipeline}=require('./pipeline.cjs');const p=new Pipeline();p.locked(async()=>{const activeFile=path.join(p.library,'expressive/active.json'),previous=await read(activeFile,{enabled:false});const r=await prepareAll(p);await atomic(path.join(p.library,'expressive/previous-active.json'),previous);await atomic(activeFile,r);try{const installed=await p.register();return {...r,...installed};}catch(e){await atomic(activeFile,previous);throw e;}}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
