"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { Publisher, publishFinished, dimensions } = require('./publisher.cjs');
const { hash, atomic, read } = require('../soundspectrum-nasa-backgrounds/library.cjs');
const { Pipeline } = require('../soundspectrum-nasa-backgrounds/pipeline.cjs');
// A small JPEG header fixture; publication does not decode/reprocess imagery.
const jpeg = (width=3840,height=2160,seed=1) => Buffer.from([0xff,0xd8,0xff,0xe0,0,3,seed,0xff,0xc0,0,11,8,height>>8,height&255,width>>8,width&255,1,1,0x11,0,0xff,0xd9]);
async function fixture(t,extra={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rh-wallpaper-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={home:path.join(root,'state'),output:path.join(root,'pictures'),catalogHome:path.join(root,'nasa/pipeline'),...extra};
 const publisher=new Publisher(options),catalog={version:1,assets:{}};
 await fs.mkdir(options.catalogHome,{recursive:true});
 return {root,options,publisher,catalog,save:()=>atomic(path.join(options.catalogHome,'catalog.json'),catalog)};
}
async function add(f,number=1,options={}) {
 const id='nasa-science-'+number,folder=path.join(f.options.catalogHome,'assets',id),bytes=options.bytes||jpeg(3840,2160,number);
 await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(folder,'background-4k.jpg'),bytes);await fs.writeFile(path.join(folder,'source.jpg'),'separate master');await fs.writeFile(path.join(folder,'stars-small-mask.png'),'mask');
 const digest=hash(bytes);
 await atomic(path.join(folder,'prepared.json'),{files:{'background-4k.jpg':digest,'source.jpg':hash('separate master')}});
 await atomic(path.join(folder,'masks.json'),{sourceSha256:digest,files:{'stars-small-mask.png':hash('mask')}});
 const e={id,title:'Nebula '+number,stage:'verified',assetUrl:'https://assets.science.nasa.gov/'+number+'.jpg',presentationSha256:digest,...options.entry};
 f.catalog.assets[id]=e;await f.save();return {id,folder,bytes,digest,e};
}
test('only verified 4K presentations are published as independent identical files; masks and masters stay private',async t=>{
 const f=await fixture(t),a=await add(f);await add(f,2,{entry:{stage:'masked'}});await add(f,3,{entry:{title:'Nebula annotated chart'}});await add(f,4,{bytes:jpeg(1920,1080)});
 await f.publisher.enable();const result=await f.publisher.sync();assert.equal(result.published,1);assert.equal(result.errors.length,1);
 const [name]=await fs.readdir(f.options.output);assert.match(name,/^NASA-[a-f0-9]{64}\.jpg$/);
 const target=path.join(f.options.output,name),source=path.join(a.folder,'background-4k.jpg');assert.deepEqual(await fs.readFile(target),a.bytes);
 assert.notEqual((await fs.stat(source)).ino,(await fs.stat(target)).ino);assert.equal((await fs.stat(target)).nlink,1);
 await fs.writeFile(target,'independent edit');assert.deepEqual(await fs.readFile(source),a.bytes);
});
test('an interrupted copy is invisible to Windows and resumes idempotently without fetching or processing',async t=>{
 let fail=true;const f=await fixture(t,{beforeRename:async({temporary,destination})=>{assert.equal(path.dirname(destination),f.options.output);assert.equal((await fs.readdir(f.options.output)).length,0);assert.ok(!temporary.startsWith(f.options.output+path.sep));if(fail)throw Error('simulated crash');}});await add(f);await f.publisher.enable();
 const first=await f.publisher.sync();assert.equal(first.total,0);assert.equal((await fs.readdir(f.options.output)).length,0);
 fail=false;assert.equal((await f.publisher.sync()).published,1);assert.equal((await f.publisher.sync()).published,0);
});
test('future validation publishes once, identical bytes deduplicate and later rejection withdraws only the wallpaper copy',async t=>{
 const f=await fixture(t),a=await add(f);await f.publisher.enable();await f.publisher.sync();
 const b=await add(f,2,{bytes:a.bytes});assert.equal((await f.publisher.sync()).total,1);
 a.e.stage='rejected';b.e.stage='rejected';await f.save();const result=await f.publisher.sync();assert.equal(result.withdrawn,1);assert.equal(result.total,0);
 assert.deepEqual(await fs.readFile(path.join(a.folder,'background-4k.jpg')),a.bytes);assert.equal((await fs.readdir(path.join(f.options.home,'withdrawn'))).length,1);
 const c=await add(f,3);assert.equal((await f.publisher.sync({onlyIds:[c.id]})).published,1);
});
test('corrupt receipts never publish and wallpaper errors do not change the NASA catalog',async t=>{
 const f=await fixture(t),a=await add(f);await f.publisher.enable();await fs.writeFile(path.join(a.folder,'stars-small-mask.png'),'corruption');
 const before=await fs.readFile(path.join(f.options.catalogHome,'catalog.json'));assert.equal((await publishFinished(f.options)).published,0);assert.equal((await fs.readdir(f.options.output)).length,0);assert.deepEqual(await fs.readFile(path.join(f.options.catalogHome,'catalog.json')),before);
});
test('protected directories, hard links and unowned wallpaper folders are refused',async t=>{
 const f=await fixture(t);assert.throws(()=>new Publisher({...f.options,output:path.join(f.options.catalogHome,'assets/wallpapers')}),/overlaps/);assert.throws(()=>new Publisher({...f.options,output:f.root}),/overlaps/);
 await fs.mkdir(f.options.output);await fs.writeFile(path.join(f.options.output,'personal.jpg'),'keep');await assert.rejects(f.publisher.enable(),/unowned/);assert.equal(await fs.readFile(path.join(f.options.output,'personal.jpg'),'utf8'),'keep');
 const g=await fixture(t),a=await add(g);await g.publisher.enable();await fs.link(path.join(a.folder,'background-4k.jpg'),path.join(g.options.output,'NASA-'+a.digest+'.jpg'));await assert.rejects(g.publisher.sync(),/Linked/);
});
test('crash after rename recovers the exact catalog copy without overwriting it',async t=>{
 const f=await fixture(t),a=await add(f);await f.publisher.enable();const target=path.join(f.options.output,'NASA-'+a.digest+'.jpg');await fs.writeFile(target,a.bytes);const before=(await fs.stat(target)).mtimeMs;
 const result=await f.publisher.sync();assert.equal(result.published,0);assert.equal(result.total,1);assert.equal((await fs.stat(target)).mtimeMs,before);
});
test('pipeline integration publishes only after validation and keeps a broken output nonfatal',async t=>{
 const f=await fixture(t),a=await add(f);const p=new Pipeline({home:f.options.catalogHome,library:path.join(f.root,'nasa/library'),idle:async()=>{},fetch:()=>assert.fail('network'),install:()=>assert.fail('native installer')});
 // Isolate this wallpaper contract from optional native publication. All-mode
 // native completion/recovery is covered by the production publication tests.
 await atomic(path.join(p.home,'config.json'),{activeImages:24});
 const state=path.resolve(p.home,'../wallpaper'),publisher=new Publisher({...f.options,home:state});await publisher.enable();
 await p.locked(async()=>{await p.process(p.catalog.assets[a.id]);assert.equal(p.catalog.assets[a.id].stage,'verified');});assert.equal((await fs.readdir(f.options.output)).length,1);
 await fs.writeFile(path.join(f.options.output,'unowned.txt'),'preserve');
 await p.locked(async()=>{await p.process(p.catalog.assets[a.id]);assert.equal(p.catalog.assets[a.id].stage,'verified');});assert.match((await read(path.join(state,'status.json'))).error,/Unexpected member/);
});
test('JPEG dimensions reject truncation and preserve the encoded 4K aspect ratio',()=>{assert.deepEqual(dimensions(jpeg()),[3840,2160]);assert.throws(()=>dimensions(jpeg().subarray(0,10)),/Invalid|Truncated/);});

test('disable is reflected in status immediately and preserves copies while preventing future publication',async t=>{
 const f=await fixture(t);await add(f);await f.publisher.enable();await f.publisher.sync();
 await f.publisher.disable();await add(f,2);assert.equal((await f.publisher.status()).enabled,false);
 assert.equal((await f.publisher.sync()).enabled,false);assert.equal((await fs.readdir(f.options.output)).length,1);
 await f.publisher.enable();assert.equal((await f.publisher.sync()).total,2);
});
