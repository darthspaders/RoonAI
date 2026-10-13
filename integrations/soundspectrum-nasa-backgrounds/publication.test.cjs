"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Pipeline,add,config}=require('./pipeline.cjs');
const {Trial}=require('./trial.cjs');
const {install,desired}=require('./install.cjs');
const {read,atomic,hash}=require('./library.cjs');

async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'rh-nasa-publication-'));
 t.after(async()=>{assert.equal(path.dirname(base),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('rh-nasa-publication-'));await fs.rm(base,{recursive:true,force:true});});
 const home=path.join(base,'pipeline'),library=path.join(base,'library'),directory=path.join(base,'native-package');await fs.mkdir(library);await fs.mkdir(home);await atomic(path.join(home,'config.json'),{discoveryPolicy:'legacy'});
 let installs=0;
 const options={home,library,idle:async()=>{},fetch:async()=>assert.fail('No acquisition during publication'),execute:async()=>assert.fail('No reprocessing during publication'),install:async o=>{installs++;return install({...o,directory});}};
 return {home,library,directory,options,p:new Pipeline(options),installs:()=>installs};
}
async function prepared(p,n,{reactive=false,stage='verified'}={}){
 const id='nasa-science-'+n;
 add(p.catalog,{id,provider:'science',nasaId:String(n),title:'Nebula '+n,target:'Repeated target',description:'A nebula',mission:'NASA',credit:'NASA',sourceUrl:'https://science.nasa.gov/image/'+n,assetUrl:'https://assets.science.nasa.gov/'+n+'.jpg',suitabilityScore:80});
 const e=p.catalog.assets[id],folder=p.folder(e),bytes=Buffer.from('4K photo '+n);await fs.mkdir(folder);
 await fs.writeFile(path.join(folder,'source.jpg'),bytes);await fs.writeFile(path.join(folder,'background-4k.jpg'),bytes);
 const receipt={version:'test',fit:'contain',sourceDimensions:[3840,2160],files:{'source.jpg':hash(bytes),'background-4k.jpg':hash(bytes)}};
 const masks={version:'test',quality:{status:reactive?'reactive':'static',reviewed:false},files:{}};
 for(const name of ['small','medium','large','cloud']){const file='reactive-'+name+'.png',layer=Buffer.from('emission '+n+' '+name);await fs.writeFile(path.join(folder,file),layer);masks.files[file]=hash(layer);}
 await atomic(path.join(folder,'prepared.json'),receipt);await atomic(path.join(folder,'masks.json'),masks);
 Object.assign(e,{stage,prepared:receipt,masks,maskStatus:masks.quality.status,presentationSha256:hash(bytes),registrationStatus:'eligible',verifiedAt:new Date().toISOString()});await p.save();return e;
}
async function snapshot(directory){const result={};for(const n of await fs.readdir(directory))result[n]=hash(await fs.readFile(path.join(directory,n)));return result;}

test('all mode installs more than 40 photos/reactive scenes, preserves unique native names, and excludes unfinished assets',async t=>{
 const f=await fixture(t);assert.equal(config({}).activeImages,'all');assert.throws(()=>config({activeImages:'everything'}));
 await f.p.locked(async()=>{
  for(let n=1;n<=65;n++)await prepared(f.p,n,{reactive:n%3!==0});
  await prepared(f.p,66,{stage:'masked'});await prepared(f.p,67,{stage:'failed'});
  const result=await f.p.publishWhiteCap();assert.equal(result.installed,65);assert.equal(result.reactive,44);assert.equal(result.static,21);assert.equal(result.loaded,false);
  const visible=await read(path.join(f.home,'status.json'));assert.equal(visible.registered,65);assert.equal(visible.reactive,44);assert.equal(visible.static,21);assert.equal(visible.pendingInstallation,0);
  const text=await fs.readFile(path.join(f.directory,'_package.py'),'utf8'),names=[...text.matchAll(/pkg.AddEntry\((u"[^"]*")/g)].map(m=>m[1]);
  assert.equal(names.length,65);assert.equal(new Set(names).size,65);assert.match(text,/nasa-science-65\.py/);assert.doesNotMatch(text,/nasa-science-66\.py/);
  assert.match(await fs.readFile(path.join(f.directory,'nasa-science-1.py'),'utf8'),/ReactiveSpaceBackground/);
  assert.doesNotMatch(await fs.readFile(path.join(f.directory,'nasa-science-3.py'),'utf8'),/ReactiveSpaceBackground/);
  const before=await snapshot(f.directory);await f.p.publishWhiteCap();assert.equal(f.installs(),1);assert.deepEqual(await snapshot(f.directory),before);
  const hashes=await desired({root:f.library,pipelineRoot:f.home,hashOnly:true});assert.deepEqual(hashes,before);assert.ok(Object.values(hashes).every(v=>typeof v==='string'));
 });
});

test('completion publishes immediately without waiting for target, while rechecking receipts',async t=>{
 const f=await fixture(t);await f.p.locked(async()=>{
  const first=await prepared(f.p,1,{stage:'masked',reactive:true});await f.p.process(first);assert.equal(first.registrationStatus,'installed');assert.equal(f.installs(),1);
  const prior=await snapshot(f.directory),second=await prepared(f.p,2,{stage:'masked'});
  await f.p.process(second);assert.equal(second.registrationStatus,'installed');assert.equal(f.installs(),2);
  assert.equal((await snapshot(f.directory))['nasa-science-1.py'],prior['nasa-science-1.py']);
  const third=await prepared(f.p,3);await fs.writeFile(path.join(f.p.folder(third),'source.jpg'),'corruption');
  const before=await snapshot(f.directory);await assert.rejects(f.p.publishWhiteCap(),/receipt validation failed/);assert.deepEqual(await snapshot(f.directory),before);assert.equal(third.registrationStatus,'eligible');
 });
});

test('visuals beginning after validation defer installation; fresh process publishes checkpoint without reprocessing',async t=>{
 const f=await fixture(t);await f.p.locked(async()=>{
  await prepared(f.p,1);await f.p.publishWhiteCap();const before=await snapshot(f.directory);
  const second=await prepared(f.p,2,{stage:'masked'});
  f.p.publishWallpapers=async()=>{f.p.idle=async()=>{throw Error('active visualizer');};};
  await assert.rejects(f.p.process(second),/active visualizer/);assert.equal(second.stage,'verified');assert.equal(second.registrationStatus,'eligible');assert.deepEqual(await snapshot(f.directory),before);
 });
 const fresh=new Pipeline(f.options);await fresh.locked(async()=>{await fresh.recoverRegistration();assert.equal((await fresh.publishWhiteCap()).installed,2);assert.equal(f.installs(),2);});
});

test('active-session guard during native staging leaves previous package intact and resume recovers metadata',async t=>{
 const f=await fixture(t);await f.p.locked(async()=>{
  await prepared(f.p,1);await f.p.publishWhiteCap();const before=await snapshot(f.directory);await prepared(f.p,2);
  f.p.install=async o=>{let checks=0;return install({...o,directory:f.directory,assertIdle:async()=>{if(++checks===3)throw Error('active visualizer');}});};
  await assert.rejects(f.p.publishWhiteCap(),/active visualizer/);assert.deepEqual(await snapshot(f.directory),before);assert.equal(await fs.stat(f.directory+'.stage').catch(()=>null),null);
 });
 const fresh=new Pipeline(f.options);await fresh.locked(async()=>{await fresh.recoverRegistration();assert.equal((await fresh.publishWhiteCap()).installed,2);});
});

test('trial publishes a passing image before the target and reports installed versus pending',async t=>{
 const f=await fixture(t),trial=new Trial({home:f.home,pipeline:f.p,log:()=>{}});
 f.p.discoverPage=async()=>{await prepared(f.p,1,{stage:'masked',reactive:true});await prepared(f.p,2,{stage:'masked'});return {rows:2,ids:['nasa-science-1','nasa-science-2']};};
 const process=f.p.process.bind(f.p);f.p.process=async e=>{if(e.id.endsWith('-2'))throw Error('simulated interruption');return process(e);};
 const result=await trial.run({target:2});assert.equal(result.status,'paused');assert.equal(result.passed,1);assert.equal(result.installed,1);assert.equal(result.pendingInstallation,0);assert.equal(result.registration.installed,1);assert.equal(f.installs(),1);
 const fresh=new Pipeline(f.options),resume=new Trial({home:f.home,pipeline:fresh,log:()=>{}});
 const done=await resume.run({resume:true});assert.equal(done.status,'complete');assert.equal(done.passed,2);assert.equal(done.installed,2);assert.equal(done.pendingInstallation,0);
 assert.equal((await read(path.join(f.home,'trial-status.json'))).installed,2);
});
