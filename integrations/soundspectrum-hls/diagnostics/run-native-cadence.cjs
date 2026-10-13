'use strict';
// Explicit bounded local trial. Never attach to or stop an existing user window.
const fs=require('node:fs/promises'), path=require('node:path'), crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const common=require(path.join(root,'data/soundspectrum-hls/cadence-20261010/run-benchmark.cjs'));
const {child}=require(path.join(root,'data/soundspectrum-hls/cadence-20261010/run-wgc-events.cjs'));
const {createSoundSpectrumNative}=require(path.join(root,'src/soundSpectrumNative'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(honorTimers=false){
 const token=crypto.randomUUID(), out=path.join(root,'data/native-render-cadence-20261012',token);
 await fs.mkdir(out,{recursive:true});
 const pkg=path.join(process.env['ProgramFiles(x86)'],'SoundSpectrum/WhiteCap/Packages/RabbitHole.CadenceDiagnostic.package');
 const source=await fs.readFile(path.join(__dirname,'native-cadence-package.py'));
 const pref=path.join(process.env.APPDATA,'SoundSpectrum/WhiteCap/Preferences (Standalone).txt');
 const globalPref=path.join(process.env.APPDATA,'SoundSpectrum/WhiteCap/Global Preferences.txt');
 const receipt={token,startedAt:new Date().toISOString(),phases:[],cleanup:{}};
 let native,probe,installed=false,original,before,cancelled=false;
 const cancel=()=>{cancelled=true;};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const deadline=Date.now()+85000;
 const guard=async()=>{
   if(cancelled||Date.now()>deadline)throw Error('Diagnostic cancelled or deadline exceeded');
   const status=await common.jsonStatus();
   if(status.state!=='idle'||status.clients!==0||status.generation!==before.generation)throw Error('Main visualizer session changed');
 };
 const wait=async ms=>{const end=Date.now()+ms;while(Date.now()<end){await guard();await sleep(500);}};
 try{
   before=await common.jsonStatus();if(before.state!=='idle'||before.clients)throw Error('Visuals must be idle');
   await common.noExistingOwnership();
   const inventory=await common.windowCommand('inspect',{OwnerProcessId:process.pid});
   if(inventory.processes?.length)throw Error('Existing native process: do not interfere');
   original=await fs.readFile(pref);await fs.writeFile(path.join(out,'standalone-before.private.txt'),original);
   await fs.copyFile(globalPref,path.join(out,'global-before.private.txt'));
   receipt.standaloneBefore=sha(original);
   await fs.mkdir(pkg);installed=true;await fs.writeFile(path.join(pkg,'_package.py'),source,{flag:'wx'});
   native=createSoundSpectrumNative({onDiagnostic:()=>{},spawnImpl:(exe,args,options)=>spawn(exe,args,
     {...options,env:{...options.env,RH_NATIVE_CADENCE_TOKEN:token,RH_NATIVE_CADENCE_OUTPUT:path.join(out,'render.jsonl')}})});
   await guard();
   await native.start({visualizer:'whitecap',inputId:'generator:fluid',width:3840,height:2160,
     windowMode:'borderless-fullscreen',uniqueCaptureTitle:true,targetFrameRate:120});
   const identity={...native.captureIdentity(),...await native.captureWindow()};receipt.identity=identity;
   await wait(3000);
   const loaded=(await fs.readFile(path.join(out,'render.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)[0];
   if(loaded.pid!==identity.pid||loaded.token!==token)throw Error('Render diagnostic identity mismatch');
   receipt.loaded=loaded;
   receipt.phases.push({name:'native-only-before',start:Date.now()});await wait(10000);receipt.phases.at(-1).end=Date.now();
   const dir=path.join(root,'data/soundspectrum-hls/cadence-20261010');
   const build=JSON.parse(await fs.readFile(path.join(dir,'wgc-native-cadence-probe-build.json'),'utf8'));
   if(sha(await fs.readFile(path.join(dir,'wgc-native-cadence-probe.exe')))!==build.exeSha256||
      sha(await fs.readFile(path.join(dir,'wgc-native-cadence-probe.cpp')))!==build.sourceSha256)throw Error('WGC diagnostic build mismatch');
   const config=JSON.parse((await fs.readFile(path.join(root,'data/soundspectrum-srt-high-bitrate/runtime.json'),'utf8')).replace(/^\uFEFF/,''));
   receipt.phases.push({name:'native-with-wgc',start:Date.now()});
   probe=child(path.join(dir,'wgc-native-cadence-probe.exe'),['--owned-whitecap',identity.windowHandle,
     String(identity.pid),identity.startTimeTicks,identity.executable,String(config.adapterIndex),'10000',
     String(process.pid),identity.windowTitle,identity.windowClass,'--one-ms'],process.env);
   while(!probe.closed){await guard();await sleep(500);}
   receipt.phases.at(-1).end=Date.now();receipt.wgc=probe.records;receipt.wgcExit=probe.exit;
   if(probe.invalid||probe.exit.code!==0)throw Error('WGC probe failed');
   receipt.phases.push({name:'native-only-after',start:Date.now()});await wait(8000);receipt.phases.at(-1).end=Date.now();
   if(honorTimers){
     const policy=require(path.join(root,'data/soundspectrum-hls/validation-20261010/native-cadence/native-timer-policy.cjs'));
     receipt.timerPolicy=await policy.honorTimerResolution(identity);
     receipt.phases.push({name:'native-honor-existing-timer-requests',start:Date.now()});
     await wait(10000);receipt.phases.at(-1).end=Date.now();
   }
   receipt.complete=true;
 }catch(e){receipt.error=e.message;}
 finally{
   if(probe){await probe.close();receipt.cleanup.probeClosed=probe.closed;}
   if(native){await native.stop();receipt.cleanup.nativeStopped=native.status().state==='stopped';}
   if(installed){
     if(sha(await fs.readFile(path.join(pkg,'_package.py')))!==sha(source))throw Error('Diagnostic package changed: preserve for inspection');
     await fs.unlink(path.join(pkg,'_package.py'));
     // Python may generate its own bytecode; delete only this known diagnostic file.
     await fs.unlink(path.join(pkg,'_package.pyc')).catch(e=>{if(e.code!=='ENOENT')throw e;});
     await fs.rmdir(pkg);receipt.cleanup.packageRemoved=true;
   }
   if(original)receipt.cleanup.standaloneExact=sha(await fs.readFile(pref))===sha(original);
   const after=await common.jsonStatus();receipt.cleanup.mainIdle=after.state==='idle'&&after.clients===0;
   receipt.cleanup.delayPreserved=JSON.stringify(common.safeStatus(after).delay)===JSON.stringify(common.safeStatus(before).delay);
   const data=await fs.readFile(path.join(out,'render.jsonl'),'utf8').catch(()=>'');
   receipt.samples=data.trim()?data.trim().split('\n').map(JSON.parse):[];
   for(const p of receipt.phases){
     const samples=receipt.samples.filter(s=>s.event==='render'&&s.utc*1000>p.start+1200&&s.utc*1000<p.end);
     p.samples=samples.length;p.fps=samples.reduce((a,s)=>a+s.frames,0)/samples.reduce((a,s)=>a+s.seconds,0);
     p.meanRenderCallbackMs=samples.reduce((a,s)=>a+s.meanRenderCallbackMs,0)/samples.length;
     p.gaps={};for(const s of samples)for(const [k,v] of Object.entries(s.gapHistogramMs))p.gaps[k]=(p.gaps[k]||0)+v;
   }
   receipt.finishedAt=new Date().toISOString();await fs.writeFile(path.join(out,'result.json'),JSON.stringify(receipt,null,2));
   process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
   console.log(JSON.stringify({out,complete:receipt.complete,error:receipt.error,loaded:receipt.loaded,phases:receipt.phases,
     wgc:receipt.wgc?.filter(x=>x.event==='phase-result'),cleanup:receipt.cleanup},null,2));
   if(!receipt.complete||!receipt.cleanup.standaloneExact||!receipt.cleanup.packageRemoved)process.exitCode=1;
 }
}
if(['--run','--run --honor-timers'].includes(process.argv.slice(2).join(' ')))run(process.argv.includes('--honor-timers')).catch(e=>{console.error(e.message);process.exitCode=1;});
else console.log('Prepared only. Explicit --run launches a bounded owned 4K native/WGC comparison when all visuals are idle.');
