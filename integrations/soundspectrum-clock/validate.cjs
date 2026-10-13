'use strict';
// Explicit bounded owned-process validation; never attach a pre-existing user visualizer.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFile}=require('node:child_process');
const execute=require('node:util').promisify(execFile),root=path.resolve(__dirname,'../..');
const common=require(path.join(root,'data/soundspectrum-hls/cadence-20261010/run-benchmark.cjs'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function run(product){
 const token=crypto.randomUUID(),out=path.join(root,'data/soundspectrum-native-clock/validation',token);
 let build=path.join(root,'data/soundspectrum-native-clock/build');
 if(process.argv.includes('--installed')){const task=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-ScheduledTask -TaskName 'Rabbit Hole native visualizer clock' -ErrorAction Stop).Actions.Execute"],{windowsHide:true,timeout:10000});build=path.dirname(task.stdout.trim());}
 const receipt={token,product,startedAt:new Date().toISOString(),phases:[],cleanup:{}};
 receipt.build=JSON.parse(await fs.readFile(path.join(build,'build.json'),'utf8'));
 await fs.mkdir(out,{recursive:true});const pkg=path.join(process.env['ProgramFiles(x86)'],'SoundSpectrum',product,'Packages/RabbitHole.CadenceDiagnostic.package');
 const source=await fs.readFile(path.join(root,'integrations/soundspectrum-hls/diagnostics/native-cadence-package.py'));
 const pref=path.join(process.env.APPDATA,'SoundSpectrum',product,'Preferences (Standalone).txt');
 let native,original,installed=false,before,cancelled=false,pipeline;const deadline=Date.now()+160000;
 const cancel=()=>{cancelled=true;};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 async function guard(){if(cancelled||Date.now()>deadline)throw Error('Cancelled/deadline');const s=await common.jsonStatus();if(s.state!=='idle'||s.clients||s.generation!==before.generation)throw Error('Viewer changed');}
 async function wait(ms){const until=Date.now()+ms;while(Date.now()<until){await guard();if(pipeline)receipt.pipelineSamples.push({utcMs:Date.now(),...pipeline.snapshot()});await sleep(500);}}
 async function once(){await execute(path.join(build,'native-clock-launcher.exe'),['--once',product],{windowsHide:true,timeout:15000});}
 async function phase(name,ms){const p={name,start:Date.now()};receipt.phases.push(p);await wait(ms);p.end=Date.now();}
 try{
   before=await common.jsonStatus();if(before.state!=='idle'||before.clients)throw Error('Visuals must be idle');await common.noExistingOwnership();const inventory=await common.windowCommand('inspect',{OwnerProcessId:process.pid});if(inventory.processes?.length)throw Error('Existing native process');
   original=await fs.readFile(pref);await fs.writeFile(path.join(out,'standalone-before.private.txt'),original);await fs.copyFile(path.join(process.env.APPDATA,'SoundSpectrum',product,'Global Preferences.txt'),path.join(out,'global-before.private.txt'));
   await fs.mkdir(pkg);installed=true;await fs.writeFile(path.join(pkg,'_package.py'),source,{flag:'wx'});
   native=require(path.join(root,'src/soundSpectrumNative')).createSoundSpectrumNative({onDiagnostic:()=>{},spawnImpl:(exe,args,opts)=>spawn(exe,args,{...opts,env:{...opts.env,RH_NATIVE_CADENCE_TOKEN:token,RH_NATIVE_CADENCE_OUTPUT:path.join(out,'render.jsonl')}})});
   await native.start({visualizer:product.toLowerCase(),inputId:'generator:fluid',width:3840,height:2160,windowMode:'borderless-fullscreen',uniqueCaptureTitle:true,targetFrameRate:120});
   receipt.identity={...native.captureIdentity(),...await native.captureWindow()};await wait(6000);
   if(process.argv.includes('--reject-init')){
     const rejected=path.join(out,'rejected-adapter');await fs.mkdir(rejected);
     for(const name of ['native-clock-launcher.exe','native-clock.dll'])await fs.copyFile(path.join(build,name),path.join(rejected,name));
     await fs.writeFile(path.join(rejected,'adapter.sha256'),'0'.repeat(64));
     await execute(path.join(rejected,'native-clock-launcher.exe'),['--once',product],{windowsHide:true,timeout:15000});
     await phase('rejected-init-original',6000);
     if(!(await fs.readFile(path.join(rejected,'logs/launcher.jsonl'),'utf8')).includes('adapter-hash-fallback'))throw Error('Hash rejection not confirmed');
     receipt.rejectedInitializationPreservedOriginal=true;
   }
   await once();await wait(3000);
   const logFile=path.join(build,'logs',`${product}-${receipt.identity.pid}.jsonl`);
   const getLog=async()=>((await fs.readFile(logFile,'utf8')).trim().split('\n').map(JSON.parse));
   if(!(await getLog()).some(x=>x.event==='clock-active'))throw Error('Permanent adapter did not activate');
   await phase('native-clock',12000);await once();await phase('duplicate-bootstrap',6000);
   if(process.argv.includes('--pipeline')||process.argv.includes('--production')||process.argv.some(x=>x.startsWith('--probe='))){
     receipt.diagnostics=[];receipt.pipelineSamples=[];
     const probe=process.argv.find(x=>x.startsWith('--probe='))?.slice(8);
     const preset=process.argv.find(x=>/^--p[1-4]$/.test(x))?.slice(2);
     const provider=process.argv.includes('--production')?'integrations/soundspectrum-hls/index.cjs':probe?`data/soundspectrum-rea-20261012/downstream-${probe}/provider.cjs`:preset?`data/soundspectrum-rea-20261012/downstream-${preset}/provider.cjs`:process.argv.includes('--flush')?'data/soundspectrum-rea-20261012/downstream-flush/provider.cjs':'data/soundspectrum-rea-20261012/downstream/provider.cjs';
     const fps=process.argv.includes('--fps60')?60:120;
     receipt.probe=probe;receipt.provider=provider;receipt.pipelineFps=fps;receipt.providerBuild=JSON.parse(await fs.readFile(path.join(root,process.argv.includes('--production')?'data/soundspectrum-hls/native':path.dirname(provider),'build.json'),'utf8'));pipeline=require(path.join(root,provider)).createIntegration({appRoot:root,onDiagnostic:d=>receipt.diagnostics.push(d)});
     receipt.pipelineStart=await pipeline.start({nativeIdentity:receipt.identity,generation:1,observeWindow:async()=>({...native.captureIdentity(),...await native.captureWindow()}),isCurrent:()=>!cancelled,onFailure:()=>{cancelled=true;},profile:{width:3840,height:2160,fps,targetFps:fps,targetBitrateMbps:150}});
     await phase('with-pipeline',18000);await pipeline.stop();receipt.cleanup.pipelineStopped=pipeline.snapshot().state==='idle';pipeline=null;await phase('after-pipeline',6000);
   }
   // Maintenance fallback request, scoped to the exact HWND created above.
   let ps=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class RhClockValidation{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern uint RegisterWindowMessage(string name);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}'; $m=[RhClockValidation]::RegisterWindowMessage('RabbitHole.SoundSpectrum.NativeClock.Restore.v1'); if(-not [RhClockValidation]::PostMessage([IntPtr]${receipt.identity.windowHandle},$m,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Fallback request failed'}`;
   if(process.argv.includes('--stall'))ps=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class RhClockStall{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport("kernel32.dll")]public static extern IntPtr OpenThread(uint a,bool b,uint id);[DllImport("kernel32.dll")]public static extern uint SuspendThread(IntPtr h);[DllImport("kernel32.dll")]public static extern uint ResumeThread(IntPtr h);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}'; [uint32]$p=0; $t=[RhClockStall]::GetWindowThreadProcessId([IntPtr]${receipt.identity.windowHandle},[ref]$p); if($p -ne ${receipt.identity.pid}){throw 'Wrong owned PID'}; $h=[RhClockStall]::OpenThread(2,$false,$t); if($h -eq [IntPtr]::Zero){throw 'Thread unavailable'}; $s=$false; try{if([RhClockStall]::SuspendThread($h) -eq [uint32]::MaxValue){throw 'Suspend failed'}; $s=$true; Start-Sleep -Milliseconds 1500}finally{if($s){[void][RhClockStall]::ResumeThread($h)}; [void][RhClockStall]::CloseHandle($h)}`;
   await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:10000});await phase('fallback',8000);receipt.adapterLog=await getLog();
   if(!receipt.adapterLog.some(x=>x.event==='fallback-restored'))throw Error('Original timer restoration unconfirmed');
   receipt.complete=true;
 }catch(e){receipt.error=e.message;}
 finally{
   if(pipeline)await pipeline.stop();if(native){await native.stop();receipt.cleanup.nativeStopped=native.status().state==='stopped';}
   if(installed){if(hash(await fs.readFile(path.join(pkg,'_package.py')))!==hash(source))throw Error('Package changed');await fs.unlink(path.join(pkg,'_package.py'));await fs.unlink(path.join(pkg,'_package.pyc')).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rmdir(pkg);receipt.cleanup.packageRemoved=true;}
   if(original)receipt.cleanup.standaloneExact=hash(await fs.readFile(pref))===hash(original);
   const after=await common.jsonStatus();receipt.cleanup.mainIdle=after.state==='idle'&&!after.clients;receipt.cleanup.delayPreserved=JSON.stringify(common.safeStatus(after).delay)===JSON.stringify(common.safeStatus(before).delay);
   const data=await fs.readFile(path.join(out,'render.jsonl'),'utf8').catch(()=>'');receipt.samples=data.trim()?data.trim().split('\n').map(JSON.parse):[];
   for(const p of receipt.phases){const s=receipt.samples.filter(x=>x.event==='render'&&x.utc*1000>p.start+1500&&x.utc*1000<p.end);p.samples=s.length;p.fps=s.reduce((a,x)=>a+x.frames,0)/s.reduce((a,x)=>a+x.seconds,0);}
   receipt.pass=receipt.complete&&receipt.phases.every(p=>p.samples>=3&&p.fps>=(['fallback','rejected-init-original'].includes(p.name)?55:114)&&p.fps<=(['fallback','rejected-init-original'].includes(p.name)?70:126))&&Object.values(receipt.cleanup).every(x=>x===true);
   await fs.writeFile(path.join(out,'result.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({out,pass:receipt.pass,error:receipt.error,phases:receipt.phases,cleanup:receipt.cleanup},null,2));if(!receipt.pass)process.exitCode=1;
   process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
 }
}
if(process.argv[2]==='--run'&&['WhiteCap','Aeon','G-Force'].includes(process.argv[3])&&process.argv.slice(4).every(x=>['--pipeline','--production','--fps60','--flush','--p1','--p2','--p3','--p4','--stall','--reject-init','--installed','--probe=wgc-only','--probe=surface-only','--probe=copy-only','--probe=conversion-only'].includes(x))&&!(process.argv.includes('--installed')&&process.argv.includes('--reject-init')))run(process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});else console.log('Prepared only: --run WhiteCap|Aeon|G-Force [--pipeline|--production] [--fps60] [--flush|--p1|--p2|--p3|--p4] [--stall] [--reject-init|--installed] [--probe=wgc-only|surface-only|copy-only|conversion-only]');
