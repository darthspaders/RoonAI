"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Trial,continueRun,HOURLY_CAP}=require('./trial.cjs');
const {Pipeline,add}=require('./pipeline.cjs');
const {read,atomic,hash}=require('./library.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rh-nasa-trial-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));const home=path.join(dir,'pipeline'),library=path.join(dir,'library');await fs.mkdir(library);await fs.mkdir(home);await atomic(path.join(home,'config.json'),{activeImages:24,discoveryPolicy:'legacy'});const p=new Pipeline({home,library,idle:async()=>{},install:async()=>assert.fail('Premature native installation')});return {home,library,p,trial:new Trial({home,pipeline:p,log:()=>{}})};}
function entry(id){return {id:'nasa-science-'+id,provider:'science',nasaId:String(id),title:'Nebula '+id,target:'Nebula '+id,assetUrl:'https://assets.science.nasa.gov/'+id+'.jpg',suitabilityScore:80};}
test('only verified images count; failed and duplicate downloads do not satisfy target',async t=>{
 const {trial,p,home}=await fixture(t);let pages=0;
 p.discoverPage=async()=>{pages++;for(let i=1;i<=4;i++)add(p.catalog,entry(i));return {rows:4,ids:[1,2,3,4].map(i=>entry(i).id)};};
 p.process=async e=>{await p.onDownload(e,{bytes:10,sha256:'test'});e.stage=e.id.endsWith('-1')?'duplicate':e.id.endsWith('-2')?'failed':'verified';await p.save();};
 const s=await trial.run({target:2});assert.equal(s.passed,2);assert.equal(s.downloaded,4);assert.equal(s.duplicates,1);assert.equal(s.failed,1);assert.equal(s.status,'complete');assert.equal(pages,1);assert.equal(s.registration,null);
 assert.equal((await read(path.join(home,'status.json'))).configuration.batchSize,2);
});
test('interrupted run resumes completed work without counting existing library',async t=>{
 const {trial,p,home,library}=await fixture(t);await p.locked(async()=>{add(p.catalog,entry(99));p.catalog.assets[entry(99).id].stage='verified';await p.save();});
 p.discoverPage=async()=>{for(let i=1;i<=3;i++)add(p.catalog,entry(i));return {rows:4,ids:[99,1,2,3].map(i=>entry(i).id)};};
 let calls=0;p.process=async e=>{if(++calls===2)throw Error('simulated interruption');e.stage='verified';await p.save();};
 assert.equal((await trial.run({target:3})).passed,1);
 const fresh=new Pipeline({home,library,idle:async()=>{}});const seen=[];fresh.process=async e=>{seen.push(e.id);e.stage='verified';await fresh.save();};
 const resumed=await new Trial({home,pipeline:fresh,log:()=>{}}).run({resume:true});
 assert.equal(resumed.passed,3);assert.equal(resumed.status,'complete');assert.deepEqual(seen,[entry(2).id,entry(3).id]);
});
test('rolling quota survives process restart and blocks request before network',async t=>{
 const {trial,p,home}=await fixture(t);await p.locked(async()=>{
  trial.job={target:500,ids:[],downloads:{},requests:Array(HOURLY_CAP).fill(Date.now()),totalRequests:HOURLY_CAP};
  await trial.save();await assert.rejects(trial.beforeRequest(new AbortController().signal),/hourly request limit/);
  const fresh=new Trial({home,pipeline:p,log:()=>{}});fresh.job=await read(trial.file);await assert.rejects(fresh.beforeRequest(new AbortController().signal),/hourly request limit/);assert.equal(fresh.job.totalRequests,HOURLY_CAP);
 });
});
test('pause request blocks new fetch and active visualizer blocks start',async t=>{
 const {trial,p}=await fixture(t);await p.locked(async()=>{trial.job={target:500,ids:[],downloads:{},requests:[],totalRequests:0};await atomic(trial.stopFile,{pause:true});await assert.rejects(trial.beforeRequest(new AbortController().signal),/paused by user/);});
 p.idle=async()=>{throw Error('active visualizer');};await assert.rejects(trial.run(),/active visualizer/);
});
test('resume rechecks newly excluded panels before counting toward the target',async t=>{
 const {trial,p,home}=await fixture(t);p.discoverPage=async()=>{add(p.catalog,{...entry(1),title:'Nebula with Pullout'});add(p.catalog,entry(2));await p.save();return {rows:2,ids:[entry(1).id,entry(2).id]};};
 p.process=async()=>{throw Error('interrupted');};await trial.run({target:1});
 p.process=async e=>{e.stage='verified';await p.save();};const s=await trial.run({resume:true});
 assert.equal(s.status,'complete');assert.equal(s.passed,1);assert.equal(s.rejected,1);
 assert.equal((await read(path.join(home,'assets',entry(1).id,'metadata.json'))).stage,'rejected');
});
test('refused search feed gets a durable cooldown rather than repeated retries',async t=>{
 const {trial,p}=await fixture(t);await p.locked(async()=>{
  trial.job={target:500,ids:[],baseline:[],downloads:{},requests:[],totalRequests:0,cursor:0,pages:{}};
  let calls=0;p.discoverPage=async()=>{calls++;throw Error('NASA HTTP 403');};
  await trial.discover();await trial.discover();assert.equal(calls,1);
  assert.ok((await read(trial.file)).searchBackoff.science>Date.now());
 });
});

test('aspect correction retries only affected failures and preserves their download evidence',async t=>{
 const {trial,p}=await fixture(t);await p.locked(async()=>{
  for(const [id,w,h] of [[1,11256,4877],[2,1920,1080]]){add(p.catalog,{...entry(id),assetUrl:'https://assets.science.nasa.gov/dynamicimage/'+id+'.png',sourceWidth:w,sourceHeight:h});const e=p.catalog.assets[entry(id).id];Object.assign(e,{stage:'failed',failureReason:'insufficient_resolution',originalContentHash:'original'});await fs.mkdir(p.folder(e));await fs.writeFile(path.join(p.folder(e),'download.bin'),'undersized');}
  trial.job={target:500,ids:[entry(1).id,entry(2).id],downloads:{},requests:[],totalRequests:0};
  await trial.recoverAspectDownloads();await trial.recoverAspectDownloads();
  assert.equal(p.catalog.assets[entry(1).id].stage,'queued');assert.equal(p.catalog.assets[entry(2).id].stage,'failed');
  assert.equal(await fs.readFile(path.join(p.folder(p.catalog.assets[entry(1).id]),'download-before-aspect-fix.bin'),'utf8'),'undersized');
  assert.equal(p.catalog.assets[entry(1).id].acquisitionRepair.previousContentHash,'original');
 });
});

test('later quality exclusion reopens a completed target and requires a replacement',async t=>{
 const {trial,p}=await fixture(t);p.discoverPage=async()=>{for(let i=1;i<=2;i++)add(p.catalog,entry(i));return {rows:2,ids:[entry(1).id,entry(2).id]};};
 p.process=async e=>{e.stage='verified';await p.save();};assert.equal((await trial.run({target:1})).passed,1);
 await p.locked(async()=>{p.catalog.assets[entry(1).id].title='Nebula with Pullout';await p.save();});
 const result=await trial.run({resume:true});assert.equal(result.status,'complete');assert.equal(result.passed,1);assert.equal(result.rejected,1);assert.equal(p.catalog.assets[entry(2).id].stage,'verified');assert.ok(trial.job.previousCompletion);
});

test('one-off runner waits for visuals and resumes the saved job without remote work during the wait',async t=>{
 const {trial,p}=await fixture(t);await p.locked(async()=>{trial.job={version:1,status:'running',target:500,ids:[],downloads:{},requests:[],totalRequests:0};await trial.save();});
 let calls=0,time=Date.now(),waits=0;trial.run=async options=>{calls++;assert.equal(options.resume,true);if(calls===1)throw Error('Stop visuals first');return {status:'paused',reason:'test complete'};};
 const result=await continueRun(trial,{resume:true,clock:()=>time,sleep:async ms=>{waits++;assert.equal((await read(trial.file)).status,'waiting-visuals');assert.equal(calls,1);time+=ms;}});
 assert.equal(calls,2);assert.equal(waits,30);assert.equal(result.reason,'test complete');
});

test('explicit pause stops a visual wait promptly',async t=>{
 const {trial,p}=await fixture(t);await p.locked(async()=>{trial.job={version:1,status:'running',target:500,ids:[],downloads:{},requests:[],totalRequests:0};await trial.save();});
 trial.run=async()=>{throw Error('active visualizer');};let time=Date.now();
 const result=await continueRun(trial,{resume:true,clock:()=>time,sleep:async ms=>{time+=ms;await atomic(trial.stopFile,{pause:true});}});
 assert.equal(result.status,'paused');assert.equal(result.reason,'Trial paused by user');
});

for(const corrupt of [false,true])test('automatic finish '+(corrupt?'withholds installation for a corrupt image':'verifies the report before bounded registration'),async t=>{
 const {trial,p,home}=await fixture(t);let installed=0;
 p.install=async()=>{assert.equal((await read(path.join(home,'reports/qualification.json'))).corruptReceipts.length,0);installed++;};
 p.discoverPage=async()=>{add(p.catalog,entry(1));return {rows:1,ids:[entry(1).id]};};
 p.process=async e=>{const folder=p.folder(e),bytes=Buffer.from('prepared image');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'background-4k.jpg'),bytes);await fs.writeFile(path.join(folder,'source.jpg'),bytes);await fs.writeFile(path.join(folder,'reactive-small.png'),'mask');
  const prepared={version:'test',fit:'contain',sourceDimensions:[3840,2160],files:{'background-4k.jpg':hash(bytes),'source.jpg':hash(bytes)}};
  await atomic(path.join(folder,'prepared.json'),prepared);await atomic(path.join(folder,'masks.json'),{files:{'reactive-small.png':hash('mask')}});
  Object.assign(e,{stage:'verified',presentationSha256:hash(bytes),maskStatus:'static',prepared,verifiedAt:new Date().toISOString()});await p.save();if(corrupt)await fs.writeFile(path.join(folder,'background-4k.jpg'),'corruption');
 };
 if(corrupt){await assert.rejects(continueRun(trial,{target:1,finish:true}),/receipt validation failed/);assert.equal(installed,0);}
 else{const result=await continueRun(trial,{target:1,finish:true});assert.equal(result.passed,1);assert.equal(result.registration.installed,1);assert.equal(result.registration.loaded,false);assert.equal(installed,1);}
});
