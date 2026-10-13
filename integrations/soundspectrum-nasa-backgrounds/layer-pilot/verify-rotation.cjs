'use strict';
// Bounded QA of the installed selection. Observes scenes without selecting them.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {assertIdle,noLinks,hash,atomic}=require('../library.cjs');
const {work}=require('../layer-pilot.cjs');
const {pythonValue}=require('./package.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const base='http://127.0.0.1:3777/api/soundspectrum/';
const directory=path.join(process.env['ProgramFiles(x86)'],'SoundSpectrum/WhiteCap/Packages/RabbitHole.NasaRotationQA.package');
async function run({music=false}={}){
 await assertIdle();await noLinks(directory);
 const out=path.join(work,'rotation-profile/native-'+Date.now());await fs.mkdir(out);
 const events=path.join(out,'events.txt');await fs.writeFile(events,'',{flag:'wx'});
 const bytes=Buffer.from(`import os,time\nfrom SSEngine import EngineInstance\nLOG=${pythonValue(events.replaceAll('\\','/'))}\ndef ExportPackage(p):
    original=EngineInstance.RenderFrame
    state={'next':0,'error':False}
    def render(engine,at):
        result=original(engine,at)
        if time.time()<state['next']: return result
        state['next']=time.time()+1
        try:
            rotation=getattr(engine,'_rh_nasa_layers_rotation_v1',{})
            layers=[]
            for scene in engine.GetRunningConfigGroup('Background').mInstanceList:
                for layer in scene.mSceneLayers or []:
                    if hasattr(layer,'image_id'): layers.append('%s:%d:%.2f' % (layer.image_id,bool(layer.ready),layer.displacement))
            registered=sum(1 for entry in engine.GetConfigSetList('Background') if entry.ConfigName.startswith('Pilot NASA - '))
            line='%s|%s|%d|%d|%d|%s\\n' % (os.environ.get('RABBIT_HOLE_WHITECAP_THEME','current'),os.getpid(),rotation.get('index',-1),rotation.get('changes',0),registered,','.join(layers))
            with open(LOG,'ab') as stream: stream.write(line.encode('ascii'))
        except Exception:
            if not state['error']:
                with open(LOG,'ab') as stream: stream.write(b'ERROR\\n')
            state['error']=True
        return result
    EngineInstance.RenderFrame=render
    return VisPackage(p)
`);
 await fs.mkdir(directory);await fs.writeFile(path.join(directory,'_package.py'),bytes,{flag:'wx'});
 const saved=JSON.parse(await fs.readFile(path.join(work,'rotation-profile/session-before-reload.json'),'utf8'));
 const result={input:music?'existing-music-analysis':'generator:fluid',phases:[],temporaryPackageRemoved:false};let viewerId='';
 async function post(body){const r=await fetch(base+'session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,viewerId}),signal:AbortSignal.timeout(20000)});const j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j;}
 async function stop(){if(viewerId){await post({action:'stop',reason:'user-stop'});viewerId='';}for(let i=0;i<12;i++){try{await assertIdle();return;}catch{await wait(1000);}}throw Error('Visuals did not stop');}
 try{
  for(const theme of ['nasa-layers','current']){
   viewerId='nasa-theme-qa-'+crypto.randomUUID();
   const selected={action:'start',visualizer:'whitecap',whitecapTheme:theme,inputId:music?saved.inputId:'generator:fluid',...(music?{zoneId:saved.zoneId,playerId:saved.playerId}:{}),transport:saved.transport,bitrateMbps:saved.bitrateMbps||250};
   await post(selected);
   const phase={theme,samples:[]};result.phases.push(phase);
   for(let i=0;i<(theme==='nasa-layers'?18:5);i++){
    await wait(5000);const s=await post({action:'heartbeat',visibility:'visible'});
    phase.samples.push({state:s.state,theme:s.whitecapTheme,video:s.videoStats,derived:s.audioFeed?.derivedSignal});
    if(s.state==='error'||s.whitecapTheme!==theme)throw Error(s.error||'Incorrect live theme');
    const log=await fs.readFile(events,'utf8');
    console.log(JSON.stringify({theme,seconds:(i+1)*5,state:s.state,last:log.trim().split('\n').at(-1)}));
    if(log.includes('ERROR'))throw Error('Native observer failed');
    if(theme==='nasa-layers'&&/nasa-layers\|\d+\|0\|4\|3\|/.test(log))break;
   }
   const log=await fs.readFile(events,'utf8');
   if(theme==='nasa-layers'){
    if(!/nasa-layers\|\d+\|0\|4\|3\|/.test(log))throw Error('Three-image rotation did not wrap');
    for(const id of ['904703','1207184','904717'])if(!log.includes('nasa-science-'+id+':1:'))throw Error('Pilot image did not render: '+id);
   }else if(!/current\|\d+\|-1\|0\|0\|/.test(log))throw Error('Pilot leaked into the current theme');
   phase.complete=true;await stop();
  }
 }finally{
  await stop();
  if(hash(await fs.readFile(path.join(directory,'_package.py')))!==hash(bytes)||(await fs.readdir(directory)).length!==1)throw Error('Edited QA package preserved');
  await fs.unlink(path.join(directory,'_package.py'));await fs.rmdir(directory);result.temporaryPackageRemoved=true;
  await atomic(path.join(out,'result.json'),result);
 }
 return {complete:result.phases.length===2&&result.phases.every(p=>p.complete),temporaryPackageRemoved:true};
}
module.exports={run};
if(require.main===module)run({music:process.argv.includes('--music')}).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1;});
