"use strict";
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile), root=path.resolve(__dirname,'../../data/nasa-whitecap/library');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const hosts=new Set(['science.nasa.gov','assets.science.nasa.gov','images-api.nasa.gov','images-assets.nasa.gov']);
function official(url){const u=new URL(url);if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.username||u.password||u.port)throw Error('Only approved official NASA HTTPS sources are allowed');return u.href;}
async function request(url,max=2*1024*1024,fetcher=fetch){
 let u=official(url);
 for(let redirects=0;redirects<4;redirects++){
  const r=await fetcher(u,{redirect:'manual',signal:AbortSignal.timeout(60000),headers:{'User-Agent':'RabbitHole-NASA-LocalLibrary/1.0'}});
  if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();u=official(new URL(r.headers.get('location'),u).href);continue;}
  if(!r.ok){await r.body?.cancel();throw Error(`NASA HTTP ${r.status}; stop this run and retry on the next maintenance window`);}
  if(Number(r.headers.get('content-length'))>max){await r.body?.cancel();throw Error('NASA asset exceeds download limit');}
  const chunks=[];let length=0;
  for await(const chunk of r.body){length+=chunk.length;if(length>max)throw Error('NASA asset exceeds download limit');chunks.push(chunk);}
  return Buffer.concat(chunks);
 }
 throw Error('NASA redirect limit');
}
function assertStoppedStatus(s){
 if(!s||!['idle','error'].includes(s.state)||s.clients!==0||s.viewerActive||/could not close cleanly/i.test(s.error||''))throw Error('Rabbit Hole still has an active or unclean visualizer session.');
}
async function assertIdle(){
 const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-Process -Name 'WhiteCap Standalone','WhiteCap Standalone.x64' -ErrorAction SilentlyContinue).Count"],{windowsHide:true,timeout:5000});
 if(stdout.trim()!=='0')throw Error('Stop visuals first: image preparation/installation requires WhiteCap to be closed.');
 const r=await fetch('http://127.0.0.1:3777/api/soundspectrum/status',{signal:AbortSignal.timeout(4000)});
 if(!r.ok)throw Error('Cannot verify Rabbit Hole is idle');
 const s=await r.json();
 // A failed, fully stopped session retains its diagnostic until the next start.
 // Keep that evidence; it must not strand offline preparation after WhiteCap exits.
 assertStoppedStatus(s);
}
async function noLinks(file){for(let p=path.resolve(file);;p=path.dirname(p)){const s=await fs.lstat(p).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});if(s&&(s.isSymbolicLink()||s.isFile()&&s.nlink>1))throw Error('Linked library path preserved');if(path.dirname(p)===p)break;}}
async function atomic(file,value,{rename=fs.rename,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 await noLinks(file);const tmp=file+'.tmp-'+crypto.randomUUID();await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 for(let attempt=0;;attempt++)try{await rename(tmp,file);return;}catch(e){
  // Windows scanners/readers can briefly deny replacement. Never unlink the
  // destination: preserve the last valid checkpoint and failed temporary file.
  if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=5)throw e;
  await wait(100*2**attempt);await noLinks(file);
 }
}
async function read(file,fallback){return JSON.parse(await fs.readFile(file,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return JSON.stringify(fallback);}));}
function downloadUrl(entry){const u=new URL(official(entry.assetUrl));if(u.pathname.includes('/dynamicimage/')){u.search='';const width=Math.min(entry.sourceWidth,Math.max(4800,Math.ceil(2200*entry.sourceWidth/entry.sourceHeight)));if(!Number.isFinite(width)||width>12000)throw Error('Unsupported source dimensions');u.searchParams.set('w',String(width));u.searchParams.set('fit','clip');}return u.href;}
function validateEntry(e){if(!/^nasa-science-\d+$/.test(e.id)||!e.title||!e.credit||!['cover','contain'].includes(e.fit))throw Error('Incomplete NASA provenance');official(e.assetUrl);official(e.sourceUrl);official(e.apiUrl);}
function nearDuplicate(a,b){if(!a||!b)return false;let x=BigInt('0x'+a)^BigInt('0x'+b),n=0;while(x){x&=x-1n;n++;}return n<=8;}
async function prepare(entries,options={}){
 const dir=path.resolve(options.root||root), idle=options.assertIdle||assertIdle;
 await idle();await noLinks(dir);await fs.mkdir(dir,{recursive:true});
 const file=path.join(dir,'library.json'), previous=await read(file,{version:1,entries:[]});
 const config=await read(path.join(dir,'config.json'),{maxImages:24,maxBytes:256*1024*1024});
 if(!Number.isInteger(config.maxImages)||config.maxImages<20||config.maxImages>40||!Number.isSafeInteger(config.maxBytes)||config.maxBytes<64*1024*1024||config.maxBytes>512*1024*1024)throw Error('Invalid NASA library bounds');
 let merged=[...previous.entries];
 for(const e of entries){
  validateEntry(e);if(merged.some(x=>x.id===e.id||x.assetUrl===e.assetUrl||x.target===e.target))continue;
  await idle();const bytes=await request(downloadUrl(e),64*1024*1024,options.fetcher);const sourceHash=hash(bytes);
  if(merged.some(x=>x.sourceHash===sourceHash))continue;
  const input=path.join(dir,'work-'+crypto.randomUUID()),output=input+'.jpg';
  try{
   await fs.writeFile(input,bytes,{flag:'wx'});await idle();
   const python=options.python||process.env.RH_TEST_PYTHON||'python';
   const {stdout}=await run(python,['-B',path.join(__dirname,'prepare.py'),input,output,e.fit],{windowsHide:true,timeout:90000});
   const dimensions=JSON.parse(stdout),prepared=await fs.readFile(output);
   if(merged.some(x=>nearDuplicate(x.perceptualHash,dimensions.perceptualHash)))continue;
   const digest=hash(prepared),name=digest+'.jpg';await noLinks(path.join(dir,name));
   await fs.writeFile(path.join(dir,name),prepared,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   merged.push({...e,...dimensions,file:name,sha256:digest,bytes:prepared.length,sourceHash,downloadUrl:downloadUrl(e),preparedAt:new Date().toISOString()});
   // Keep a bounded, resumable set after each verified download. Installation
   // remains a separate operation, so a failed source never mutates WhiteCap.
   merged=bounded(merged,config);
   await atomic(file,{version:1,entries:merged});
   console.log('Prepared '+e.target);
  }finally{await fs.unlink(input).catch(()=>{});await fs.unlink(output).catch(()=>{});}
 }
 merged=bounded(merged,config);
 await atomic(file,{version:1,entries:merged});
 // Delete only our content-addressed files, after publishing a valid replacement.
 for(const n of await fs.readdir(dir)){if(/^[a-f0-9]{64}\.jpg$/.test(n)&&!merged.some(e=>e.file===n)){const f=path.join(dir,n);await noLinks(f);await fs.unlink(f);}}
 return {images:merged.length,bytes:merged.reduce((s,e)=>s+e.bytes,0)};
}
function bounded(entries,config){
 const pinned=entries.filter(x=>x.pinned),others=entries.filter(x=>!x.pinned).sort((a,b)=>b.preparedAt.localeCompare(a.preparedAt));
 if(pinned.length>config.maxImages)throw Error('Pinned collection exceeds image limit');
 const result=[...pinned,...others].slice(0,config.maxImages);
 while(result.reduce((s,e)=>s+e.bytes,0)>config.maxBytes){const i=result.findLastIndex(x=>!x.pinned);if(i<0)throw Error('Pinned collection exceeds cache limit');result.splice(i,1);}
 return result;
}
module.exports={root,hash,official,request,assertIdle,assertStoppedStatus,noLinks,atomic,read,downloadUrl,validateEntry,nearDuplicate,prepare};
if(require.main===module)prepare(require('./seed.json')).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
