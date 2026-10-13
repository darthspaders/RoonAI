'use strict';
// Uses the existing native launcher/capture/session boundaries. Own package only.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
const {root,assertIdle,noLinks,hash,read,atomic}=require('../library.cjs');
const {literal}=require('../install.cjs');
const {work,plan}=require('../layer-pilot.cjs');
const {sceneFiles,pythonValue}=require('./package.cjs');
const {createSoundSpectrumNative}=require('../../../src/soundSpectrumNative');
const {JpegFrames}=require('../../../src/soundSpectrum');
const {buildCaptureCommand}=require('../../../scripts/soundspectrum-capture.cjs');
const repo=path.resolve(__dirname,'../../..'),packageName='RabbitHole.LayerPilot.package';
const directory=path.join(process.env['ProgramFiles(x86)'],'SoundSpectrum/WhiteCap/Packages',packageName);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function build(mode,log){
 const {files,targets:scenes}=await sceneFiles(packageName);
 const targets=[{id:'production-baseline',name:'NASA - Cosmic Cliffs in the Carina Nebula',cloud:true},...scenes];
 const probe=(await fs.readFile(path.join(__dirname,'native-probe.py'),'utf8')).replace('__PLAN__',pythonValue(targets)).replace('__LOG__',literal(log.replaceAll('\\','/'))).replace('__MODE__',literal(mode));
 files['_package.py']=Buffer.from(probe);
 return {files,targets};
}
async function snapshot(){
 const old=await read(path.join(work,'../response-20261011/protected-before.json'),{});
 const candidates=new Set(Object.keys(old).map(p=>path.resolve(repo,p)));
 const installed=await read(path.join(root,'installation.json'),null);
 for(const name of Object.keys(installed.files))candidates.add(path.join(installed.directory,name));
 for(const file of ['library.json','installation.json','motion/active.json','reactive-library/active.json','pipeline-active.json'])candidates.add(path.join(root,file));
 for(const cfg of plan.images)candidates.add(path.join(root,cfg.sha256+'.jpg'));
 const output={};for(const file of candidates){await noLinks(file);output[file]=hash(await fs.readFile(file));}return output;
}
async function run(mode,label){
 if(!['controlled','live'].includes(mode)||!/^[a-z0-9-]+$/.test(label))throw Error('Usage: native-probe.cjs controlled|live label');
 await assertIdle();await noLinks(directory);
 const out=path.join(work,'native-'+label);await fs.mkdir(out);
 const before=await snapshot();await atomic(path.join(out,'protected-before.json'),before);
 const base='http://127.0.0.1:3777/api/soundspectrum/';
 const saved=await (await fetch(base+'status')).json();await atomic(path.join(out,'session-before.json'),saved);
 const viewerId='layer-pilot-'+crypto.randomUUID();
 async function post(body){const r=await fetch(base+'session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,viewerId}),signal:AbortSignal.timeout(45000)});const j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j;}
 const log=path.join(out,'events.txt'),{files,targets}=await build(mode,log);
 const owned=Object.fromEntries(Object.entries(files).map(([n,b])=>[n,hash(b)]));
 await fs.writeFile(log,'',{flag:'wx'});await atomic(path.join(out,'members.json'),owned);
 // Fresh package only, atomically made visible after every member is complete.
 const stage=directory+'.stage';await noLinks(stage);await fs.mkdir(stage);
 for(const [name,bytes] of Object.entries(files))await fs.writeFile(path.join(stage,name),bytes,{flag:'wx'});
 await assertIdle();if(await fs.stat(directory).catch(()=>null))throw Error('Unowned pilot package preserved');
 await fs.rename(stage,directory);
 let native,capture,started=false,writes=[],captureError='',lastSave=0;
 const report={mode,targets,frames:0,captures:[],samples:[],complete:false};
 try{
  let window;
  if(mode==='controlled'){
   native=createSoundSpectrumNative({backupRoot:path.join(out,'native-backups')});
   const session=await native.start({visualizer:'whitecap',inputId:'generator:fluid',width:1280,height:720,uniqueCaptureTitle:true});
   report.pid=session.pid;window={windowHandle:session.windowHandle};started=true;
  }else{
   if(saved.visualizer!=='whitecap'||saved.inputId!=='feed:hqplayer-analysis')throw Error('Live probe requires the existing WhiteCap analysis selection');
   started=true;
   await post({action:'start',...Object.fromEntries(['visualizer','inputId','playerId','zoneId','transport','bitrateMbps'].map(k=>[k,saved[k]]))});
   for(let attempt=0;attempt<12;attempt++){
    const found=await promisify(execFile)('powershell.exe',['-NoProfile','-Command',"$p=@(Get-Process -Name 'WhiteCap Standalone.x64' -ErrorAction SilentlyContinue); if($p.Count -eq 1){$p[0].Id}"],{windowsHide:true});
    if(/^\d+$/.test(found.stdout.trim())){report.pid=Number(found.stdout.trim());break;}
    await post({action:'heartbeat',visibility:'visible'});await wait(1000);
   }
   if(!report.pid)throw Error('Owned native PID missing');
   await wait(1500);
   const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-File',path.join(repo,'scripts/soundspectrum-window.ps1'),'-Action','window','-ProcessId',String(report.pid),'-ExpectedExecutable','C:/Program Files (x86)/SoundSpectrum/WhiteCap/WhiteCap Standalone.x64.exe'],{windowsHide:true});
   window=JSON.parse(stdout).window;
  }
  const command=buildCaptureCommand({windowHandle:window.windowHandle,width:960,height:540,fps:10,quality:85});
  const parser=new JpegFrames(frame=>{report.frames++;const at=Date.now();if(at-lastSave>=90){lastSave=at;const name='frame-'+at+'.jpg';report.captures.push({at,name});writes.push(fs.writeFile(path.join(out,name),frame));}});
  capture=spawn(command.command,command.args,{env:command.env,windowsHide:true,stdio:['ignore','pipe','pipe']});capture.stdout.on('data',b=>parser.push(b));capture.stderr.on('data',b=>{if(captureError.length<2000)captureError+=b;});capture.on('error',e=>captureError=e.message);
  for(let i=0;i<28;i++){
   await wait(5000);
   let state='native';
   if(mode==='live'){const s=await post({action:'heartbeat',visibility:'visible'});state=s.state;
    const memory=await promisify(execFile)('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${report.pid} -ErrorAction Stop; @{workingSet=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;cpu=$p.CPU}|ConvertTo-Json -Compress`],{windowsHide:true});
    report.samples.push({at:Date.now(),state:s.state,error:s.error,video:s.videoStats,derived:s.audioFeed?.derivedSignal,memory:JSON.parse(memory.stdout)});
    if(s.state==='error')throw Error(s.error||'Live session failed');}
   const events=await fs.readFile(log,'utf8');
   console.log(JSON.stringify({seconds:(i+1)*5,state,frames:report.frames,rendered:(events.match(/'event': 'rendered'/g)||[]).length}));
   if(events.includes("'event': 'error'"))throw Error('Native scene raised an error; inspect events');
   if(i>=6&&!events.includes("'event': 'start'"))throw Error('Native engine did not start rendering');
   if(events.includes("'event': 'complete'")){report.complete=true;break;}
  }
  if(!report.complete||report.frames<200)throw Error('Native probe incomplete: '+captureError.slice(0,150));
 }finally{
  capture?.kill();await Promise.all(writes);
  if(started){if(native)await native.stop();else await post({action:'stop',reason:'user-stop'});}
  for(let i=0;i<15;i++){try{await assertIdle();break;}catch{await wait(1000);}}await assertIdle();
  const members=await fs.readdir(directory);
  if(members.length!==Object.keys(owned).length)throw Error('Pilot package has unknown members; preserved');
  for(const name of members){await noLinks(path.join(directory,name));if(hash(await fs.readFile(path.join(directory,name)))!==owned[name])throw Error('Pilot member edited; preserved');}
  for(const name of members)await fs.unlink(path.join(directory,name));await fs.rmdir(directory);
  report.protectedChanged=[];for(const [file,sha] of Object.entries(before))if(hash(await fs.readFile(file))!==sha)report.protectedChanged.push(file);
  // The server's stop response precedes asynchronous preference restoration.
  // Observe that restoration; never rewrite a user's preferences ourselves.
  report.initialProtectedChanged=[...report.protectedChanged];
  for(let attempt=0;attempt<10&&report.protectedChanged.length;attempt++){
   await wait(500);const remaining=[];
   for(const file of report.protectedChanged)if(hash(await fs.readFile(file))!==before[file])remaining.push(file);
   report.protectedChanged=remaining;
  }
  report.protectedCount=Object.keys(before).length;report.temporaryPackageRemoved=true;report.stopped=true;
  await atomic(path.join(out,'result.json'),report);
  console.log(JSON.stringify({complete:report.complete,frames:report.frames,protectedCount:report.protectedCount,protectedChanged:report.protectedChanged.length,stopped:true}));
  if(report.protectedChanged.length)throw Error('Protected files changed; inspect receipt');
 }
}
module.exports={build,run};
if(require.main===module)run(process.argv[2],process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1;});
