'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const common=require(path.join(root,'data/soundspectrum-hls/cadence-20261010/run-benchmark.cjs'));
const {createSoundSpectrumNative}=require(path.join(root,'src/soundSpectrumNative'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
 const clockTrial=process.argv.includes('--clock-trial');
 const withWgc=process.argv.includes('--wgc');
 const withPipeline=process.argv.includes('--pipeline'),extended=withWgc||withPipeline;
 const token=crypto.randomUUID(),out=path.join(root,'data/soundspectrum-rea-20261012',token);
 await fs.mkdir(out,{recursive:true});
 const install=path.join(process.env['ProgramFiles(x86)'],'SoundSpectrum/WhiteCap');
 const pkg=path.join(install,'Packages/RabbitHole.CadenceDiagnostic.package');
 const source=await fs.readFile(path.join(__dirname,'native-cadence-package.py'));
 const pref=path.join(process.env.APPDATA,'SoundSpectrum/WhiteCap/Preferences (Standalone).txt');
 const receipt={token,startedAt:new Date().toISOString(),cleanup:{}};
 const clockDll=path.join(root,'data/soundspectrum-rea-20261012/native-clock-trial.dll');
 let native,instrument,probe,pipeline,installed=false,before,original,cancelled=false,closed;
 const cancel=()=>{cancelled=true;};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const deadline=Date.now()+110000;
 async function guard(){
   if(cancelled||Date.now()>deadline)throw Error('Cancelled or deadline');
   const s=await common.jsonStatus();if(s.state!=='idle'||s.clients||s.generation!==before.generation)throw Error('Main viewer changed');
 }
 async function wait(ms){const end=Date.now()+ms;while(Date.now()<end){await guard();await sleep(500);}}
 try{
   before=await common.jsonStatus();if(before.state!=='idle'||before.clients)throw Error('Visuals must be idle');
   await common.noExistingOwnership();
   const inventory=await common.windowCommand('inspect',{OwnerProcessId:process.pid});
   if(inventory.processes?.length)throw Error('Existing user native process');
   if(clockTrial){
     const build=JSON.parse(await fs.readFile(path.join(path.dirname(clockDll),'native-clock-build.json'),'utf8'));
     if(build.dllSha256!==sha(await fs.readFile(clockDll))||build.sourceSha256!==sha(await fs.readFile(path.join(__dirname,'native-clock-trial.cpp'))))throw Error('Clock trial build mismatch');
     receipt.clockBuild=build;
   }
   for(const [name,hash] of [['WhiteCap Standalone.x64.exe','932a406cbff66e270a06de77f806450aa25bbdf02fb9aaeb4a84995f50fb500d'],
     ['WhiteCap.x64.dll','bce889bec7c9b9698f51a8f3d7f4ad9ebe19325d649f8e9e1073b334007ce37f']]){
     if(sha(await fs.readFile(path.join(install,name)))!==hash)throw Error('Unrecognized native build');receipt[name]=hash;
   }
   original=await fs.readFile(pref);await fs.writeFile(path.join(out,'standalone-before.private.txt'),original);
   await fs.copyFile(path.join(process.env.APPDATA,'SoundSpectrum/WhiteCap/Global Preferences.txt'),path.join(out,'global-before.private.txt'));
   await fs.mkdir(pkg);installed=true;await fs.writeFile(path.join(pkg,'_package.py'),source,{flag:'wx'});
   native=createSoundSpectrumNative({onDiagnostic:()=>{},spawnImpl:(exe,args,options)=>spawn(exe,args,
     {...options,env:{...options.env,RH_NATIVE_CADENCE_TOKEN:token,RH_NATIVE_CADENCE_OUTPUT:path.join(out,'render.jsonl')}})});
   await native.start({visualizer:'whitecap',inputId:'generator:fluid',width:3840,height:2160,windowMode:'borderless-fullscreen',uniqueCaptureTitle:true,targetFrameRate:120});
   receipt.identity={...native.captureIdentity(),...await native.captureWindow()};
   await wait(7000);
   if(withPipeline){
     pipeline=require(path.join(root,'integrations/soundspectrum-hls/index.cjs')).createIntegration({appRoot:root});
     receipt.pipelineStart=await pipeline.start({nativeIdentity:receipt.identity,generation:1,
       observeWindow:async()=>({...native.captureIdentity(),...await native.captureWindow()}),isCurrent:()=>!cancelled,
       onFailure:()=>{cancelled=true;},profile:{width:3840,height:2160,fps:120,targetFps:120,targetBitrateMbps:150}});
     receipt.pipelineSamples=[];
   }
   const script=path.join(out,'trace.js');
   if(clockTrial)receipt.clockDllSha256=sha(await fs.readFile(clockDll));
   await fs.writeFile(script,'const EXPECTED_PID='+receipt.identity.pid+';\nconst CLOCK_DLL_PATH='+JSON.stringify(clockDll)+';\nconst TRIAL_END_MS='+(extended?25000:17000)+';\n'+await fs.readFile(path.join(__dirname,clockTrial?'rea-native-clock-trial.js':'rea-native-trace.js'),'utf8'));
   const manifest=JSON.parse(await fs.readFile(path.join(root,'data/soundspectrum-native/session-whitecap.json'),'utf8'));
   if(manifest.ownerPid!==process.pid||manifest.pid!==receipt.identity.pid||manifest.startTimeTicks!==receipt.identity.startTimeTicks)throw Error('Native ownership changed');
   receipt.traceStart=Date.now();
   instrument=spawn(process.execPath,[path.join(root,'data/soundspectrum-rea-20261012/rea/scripts/rea.mjs'),
     'instrument-with-frida','attach',String(receipt.identity.pid),'--script-file',script,'--duration-ms',extended?'31000':'23000','--format','json'],
     {cwd:out,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TURBO_TELEMETRY_DISABLED:'1'}});
   const stdout=[],stderr=[];let bytes=0;
   instrument.stdout.on('data',b=>{bytes+=b.length;if(bytes<2000000)stdout.push(b);else cancelled=true;});
   instrument.stderr.on('data',b=>{if(stderr.length<100)stderr.push(b);});
   instrument.on('error',e=>{receipt.instrumentError=e.message;});
   instrument.on('close',(code,signal)=>{closed=true;receipt.instrumentExit={code,signal};});
   while(!closed){
     await guard();
     if(pipeline)receipt.pipelineSamples.push({utcMs:Date.now(),...pipeline.snapshot()});
     if(withWgc&&!probe&&Date.now()-receipt.traceStart>=10000){
       const dir=path.join(root,'data/soundspectrum-hls/cadence-20261010');
       const build=JSON.parse(await fs.readFile(path.join(dir,'wgc-native-cadence-probe-build.json'),'utf8'));
       if(sha(await fs.readFile(path.join(dir,'wgc-native-cadence-probe.exe')))!==build.exeSha256||sha(await fs.readFile(path.join(dir,'wgc-native-cadence-probe.cpp')))!==build.sourceSha256)throw Error('WGC build mismatch');
       const config=JSON.parse((await fs.readFile(path.join(root,'data/soundspectrum-srt-high-bitrate/runtime.json'),'utf8')).replace(/^\uFEFF/,''));
       const identity=receipt.identity;
       probe=require(path.join(dir,'run-wgc-events.cjs')).child(path.join(dir,'wgc-native-cadence-probe.exe'),['--owned-whitecap',identity.windowHandle,String(identity.pid),identity.startTimeTicks,identity.executable,String(config.adapterIndex),'10000',String(process.pid),identity.windowTitle,identity.windowClass,'--one-ms'],process.env);
     }
     await sleep(500);
   }
   receipt.traceEnd=Date.now();await fs.writeFile(path.join(out,'rea-evidence.json'),Buffer.concat(stdout));
   await fs.writeFile(path.join(out,'rea-stderr.txt'),Buffer.concat(stderr));
   if(receipt.instrumentExit.code!==0)throw Error('REA instrumentation failed; inspect retained evidence');
   const evidence=JSON.parse(Buffer.concat(stdout).toString());
   const messages=evidence.evidence?.normalized_result?.messages||[];
   if(evidence.cleanup_error||evidence.evidence?.normalized_result?.cleanup_error||evidence.evidence?.normalized_result?.messages_truncated)throw Error('REA cleanup/evidence incomplete');
   if(messages.some(m=>m.type==='error'||m.payload?.event==='restoration-failed'))throw Error('REA script/trial failed; inspect retained evidence');
   if(clockTrial&&!messages.some(m=>m.payload?.event==='clock-restored'&&m.payload.timer!=='0x0'))throw Error('Native clock restoration unconfirmed');
   if(clockTrial&&!messages.some(m=>m.payload?.event==='clock-worker-stopped'&&m.payload.stopped===1))throw Error('Clock worker cleanup unconfirmed');
   if(probe){receipt.wgc=probe.records;receipt.wgcExit=probe.exit;if(!probe.closed||probe.invalid||probe.exit?.code!==0)throw Error('WGC comparison failed');}
   await wait(5000);receipt.complete=true;
 }catch(e){receipt.error=e.message;}
 finally{
   // Prefer REA's own bounded detach. Native stop is last-resort ownership cleanup.
   if(instrument&&!closed){instrument.kill();await sleep(2000);}
   if(pipeline){await pipeline.stop();receipt.cleanup.pipelineStopped=pipeline.snapshot().state==='idle';}
   if(probe){await probe.close();receipt.cleanup.probeClosed=probe.closed;}
   if(native){await native.stop();receipt.cleanup.nativeStopped=native.status().state==='stopped';}
   if(installed){
     if(sha(await fs.readFile(path.join(pkg,'_package.py')))!==sha(source))throw Error('Package changed; preserve for inspection');
     await fs.unlink(path.join(pkg,'_package.py'));await fs.unlink(path.join(pkg,'_package.pyc')).catch(e=>{if(e.code!=='ENOENT')throw e;});
     await fs.rmdir(pkg);receipt.cleanup.packageRemoved=true;
   }
   if(original)receipt.cleanup.standaloneExact=sha(await fs.readFile(pref))===sha(original);
   const after=await common.jsonStatus();receipt.cleanup.mainIdle=after.state==='idle'&&!after.clients;
   receipt.cleanup.delayPreserved=JSON.stringify(common.safeStatus(before).delay)===JSON.stringify(common.safeStatus(after).delay);
   receipt.finishedAt=new Date().toISOString();await fs.writeFile(path.join(out,'result.json'),JSON.stringify(receipt,null,2));
   process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
   console.log(JSON.stringify({out,complete:receipt.complete,error:receipt.error,cleanup:receipt.cleanup},null,2));
   if(!receipt.complete||!receipt.cleanup.standaloneExact)process.exitCode=1;
 }
}
if(['--run','--run --clock-trial','--run --clock-trial --wgc','--run --clock-trial --pipeline'].includes(process.argv.slice(2).join(' ')))run().catch(e=>{console.error(e.message);process.exitCode=1;});
else console.log('Prepared only. --run observes one exact owned 4K WhiteCap. Optional --clock-trial tests the bounded replacement; add --wgc or --pipeline for capture/encoder comparison. Requires local pinned tooling and build receipt.');
