'use strict';
// Explicit test of ordinary vendor launch + installed watcher. No streaming/native.start.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile),root=path.resolve(__dirname,'../..');
const common=require(path.join(root,'data/soundspectrum-hls/cadence-20261010/run-benchmark.cjs'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const ps=async text=>(await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',text],{windowsHide:true,timeout:10000})).stdout.trim();
async function run(product,recovery){
 const token=crypto.randomUUID(),out=path.join(root,'data/soundspectrum-native-clock/installed-validation',token);
 const vendor=path.join(process.env['ProgramFiles(x86)'],'SoundSpectrum',product),exe=path.join(vendor,`${product} Standalone.x64.exe`),pkg=path.join(vendor,'Packages/RabbitHole.CadenceDiagnostic.package');
 const profile=path.join(process.env.APPDATA,'SoundSpectrum',product),receipt={token,product,recovery,startedAt:new Date().toISOString(),runs:[],cleanup:{}};
 let before,child,identity,installed=false,source,originals={},cancelled=false;const end=Date.now()+230000;
 const cancel=()=>{cancelled=true;};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 await fs.mkdir(out,{recursive:true});
 async function guard(){if(cancelled||Date.now()>end)throw Error('Cancelled/deadline');const s=await common.jsonStatus();if(s.state!=='idle'||s.clients||s.generation!==before.generation)throw Error('Viewer changed');}
 async function wait(ms){const until=Date.now()+ms;while(Date.now()<until){await guard();await sleep(500);}}
 async function finish(crash=false){
   if(!child)return;
   if(child.exitCode===null&&child.signalCode===null){if(crash||!identity?.startTimeTicks)child.kill();else await common.windowCommand('close',{ProcessId:child.pid,ExpectedExecutable:exe,StartTimeTicks:identity.startTimeTicks}).catch(e=>{receipt.closeWarning=e.message;});}
   for(let i=0;i<30&&child.exitCode===null&&child.signalCode===null;i++)await sleep(100);
   if(child.exitCode===null&&child.signalCode===null){child.kill();await sleep(500);}
   if(child.exitCode===null&&child.signalCode===null)throw Error('Owned process did not exit');child=null;
 }
 async function launch(label){
   const render=path.join(out,`${label}.jsonl`),r={label,renderFile:render,phases:[]};receipt.runs.push(r);identity=null;
   child=spawn(exe,[],{cwd:vendor,windowsHide:false,stdio:'ignore',env:{...process.env,RH_NATIVE_CADENCE_TOKEN:token,RH_NATIVE_CADENCE_OUTPUT:render}});
   let error;child.on('error',e=>{error=e;});await wait(7000);if(error)throw error;
   identity=await common.windowCommand('window',{ProcessId:child.pid,ExpectedExecutable:exe});r.identity=identity;
   if(!identity.window)throw Error('Ordinary launch has no window');
   r.logFile=path.join(receipt.installDirectory,'logs',`${product}-${child.pid}.jsonl`);r.renderFile=render;
   const log=await fs.readFile(r.logFile,'utf8');if(!log.includes('"clock-active"'))throw Error('Installed clock did not activate automatically');
   return r;
 }
 async function phase(r,name,ms){const p={name,start:Date.now()};r.phases.push(p);await wait(ms);p.end=Date.now();}
 try{
   before=await common.jsonStatus();if(before.state!=='idle'||before.clients)throw Error('Visuals must be idle');await common.noExistingOwnership();if((await common.windowCommand('inspect')).processes.length)throw Error('Existing visualizer');
   const task=JSON.parse(await ps("$t=Get-ScheduledTask -TaskName 'Rabbit Hole native visualizer clock' -ErrorAction Stop; @{state=[string]$t.State;exe=$t.Actions.Execute}|ConvertTo-Json -Compress"));
   if(task.state!=='Running')throw Error('Installed watcher not running');receipt.installDirectory=path.dirname(task.exe);receipt.build=JSON.parse(await fs.readFile(path.join(receipt.installDirectory,'build.json'),'utf8'));
   for(const name of ['Preferences (Standalone).txt','Global Preferences.txt']){originals[name]=await fs.readFile(path.join(profile,name));await fs.writeFile(path.join(out,`${name}.private`),originals[name]);}
   source=await fs.readFile(path.join(root,'integrations/soundspectrum-hls/diagnostics/native-cadence-package.py'));await fs.mkdir(pkg);installed=true;await fs.writeFile(path.join(pkg,'_package.py'),source,{flag:'wx'});
   const first=await launch('ordinary');await phase(first,'automatic-native',12000);
   if(recovery){
     // Only terminate the exact installed watcher's process, with failure status for Task Scheduler.
     const literal=task.exe.replace(/'/g,"''");
     receipt.watcherRecoveryTouched=true;
     receipt.watcherBefore=Number(await ps(`$p=@(Get-Process -Name native-clock-launcher -ErrorAction Stop | Where-Object {$_.Path -eq '${literal}'}); if($p.Count -ne 1){throw 'Watcher ownership ambiguous'}; Add-Type 'using System;using System.Runtime.InteropServices;public class RhClockCrash{[DllImport("kernel32.dll")]public static extern bool TerminateProcess(IntPtr h,uint code);}'; $id=$p[0].Id; if(-not [RhClockCrash]::TerminateProcess($p[0].Handle,1)){throw 'Crash simulation failed'}; $id`));
     const p={name:'watcher-crash-independent-clock',start:Date.now()};first.phases.push(p);
     for(let i=0;i<18;i++){await wait(4000);const id=Number(await ps(`$p=@(Get-Process -Name native-clock-launcher -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq '${literal}'}); if($p.Count -gt 1){throw 'Duplicate watcher'}; if($p.Count){$p[0].Id}else{0}`));if(id&&id!==receipt.watcherBefore){receipt.watcherAfter=id;break;}}
     p.end=Date.now();if(!receipt.watcherAfter)throw Error('Watcher automatic restart unconfirmed');
     await finish(true);first.crashExit=true;
     const second=await launch('after-native-crash');await phase(second,'automatic-after-crash',12000);await finish();
   }else await finish();
   receipt.complete=true;
 }catch(e){receipt.error=e.message;}
 finally{
   await finish().catch(e=>{receipt.cleanup.error=e.message;});
   const inventory=await common.windowCommand('inspect');receipt.cleanup.noNativeProcesses=!inventory.processes.length;
   if(receipt.cleanup.noNativeProcesses){receipt.cleanup.preferencesExact=true;for(const [name,bytes] of Object.entries(originals)){await fs.writeFile(path.join(profile,name),bytes);if(hash(await fs.readFile(path.join(profile,name)))!==hash(bytes))receipt.cleanup.preferencesExact=false;}}
   if(receipt.watcherRecoveryTouched){
     const literal=path.join(receipt.installDirectory,'native-clock-launcher.exe').replace(/'/g,"''");
     receipt.cleanup.watcherRunning=await ps(`$t=Get-ScheduledTask -TaskName 'Rabbit Hole native visualizer clock' -ErrorAction Stop; if($t.Actions.Execute -ne '${literal}'){throw 'Installed task changed'}; if($t.State -ne 'Running'){Start-ScheduledTask -TaskName $t.TaskName; Start-Sleep -Milliseconds 1200}; @(Get-Process -Name native-clock-launcher -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq '${literal}'}).Count`) === '1';
   }
   if(installed){if(hash(await fs.readFile(path.join(pkg,'_package.py')))!==hash(source))throw Error('Probe changed');await fs.unlink(path.join(pkg,'_package.py'));await fs.unlink(path.join(pkg,'_package.pyc')).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rmdir(pkg);receipt.cleanup.probeRemoved=true;}
   for(const r of receipt.runs){const samples=(await fs.readFile(r.renderFile,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse);r.log=(r.logFile?await fs.readFile(r.logFile,'utf8').catch(()=>''):'').trim().split('\n').filter(Boolean).map(JSON.parse);for(const p of r.phases){const s=samples.filter(x=>x.event==='render'&&x.utc*1000>p.start+1500&&x.utc*1000<p.end);p.samples=s.length;p.fps=s.reduce((a,x)=>a+x.frames,0)/s.reduce((a,x)=>a+x.seconds,0);}}
   const after=await common.jsonStatus();receipt.cleanup.mainUntouched=after.state==='idle'&&!after.clients&&after.generation===before.generation&&JSON.stringify(common.safeStatus(after).delay)===JSON.stringify(common.safeStatus(before).delay);
   receipt.pass=receipt.complete&&Object.values(receipt.cleanup).every(x=>x===true)&&receipt.runs.every(r=>r.phases.every(p=>p.samples>=3&&p.fps>=114&&p.fps<=126)&&r.log.filter(x=>x.event==='clock-active').length===1&&(r.crashExit||r.log.some(x=>x.event==='window-destroyed')));
   await fs.writeFile(path.join(out,'result.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({out,pass:receipt.pass,error:receipt.error,watcherBefore:receipt.watcherBefore,watcherAfter:receipt.watcherAfter,runs:receipt.runs.map(({label,identity,phases})=>({label,window:identity?.window,phases})),cleanup:receipt.cleanup},null,2));if(!receipt.pass)process.exitCode=1;
   process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
 }
}
if(process.argv[2]==='--run'&&['WhiteCap','Aeon','G-Force'].includes(process.argv[3])&&process.argv.slice(4).every(x=>x==='--recovery'))run(process.argv[3],process.argv.includes('--recovery')).catch(e=>{console.error(e);process.exitCode=1;});else console.log('Prepared only: --run WhiteCap|Aeon|G-Force [--recovery]');
