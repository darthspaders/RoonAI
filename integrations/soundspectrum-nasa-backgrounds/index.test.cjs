const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {official,request,nearDuplicate,hash,atomic}=require('./library.cjs');
const {install,desired}=require('./install.cjs');
const {candidate}=require('./maintenance.cjs');
test('NASA requests reject nonofficial redirects, credentials, oversized bodies and HTTP rate limits',async()=>{
 assert.throws(()=>official('https://example.com/x'));assert.throws(()=>official('http://science.nasa.gov/x'));assert.throws(()=>official('https://user@science.nasa.gov/x'));
 await assert.rejects(request('https://science.nasa.gov/x',20,async()=>new Response('',{status:302,headers:{location:'https://example.com/x'}})),/official/);
 await assert.rejects(request('https://science.nasa.gov/x',2,async()=>new Response('long')),/limit/);
 await assert.rejects(request('https://science.nasa.gov/x',2,async()=>new Response('',{status:429})),/429/);
 assert.equal((await request('https://science.nasa.gov/x',4,async()=>new Response('okay'))).toString(),'okay');
});
test('future imagery is restricted to credited, high-resolution, unannotated Webb astronomy',()=>{
 const m={id:123,title:{rendered:'NGC 123 (NIRCam Image)'},source_url:'https://assets.science.nasa.gov/dynamicimage/assets/science/missions/webb/science/a.jpg',link:'https://science.nasa.gov/image-detail/a/',media_details:{width:4000,height:3000},credits:'NASA, ESA, CSA',date:'2026-10-01'};
 assert.equal(candidate(m).id,'nasa-science-123');
 for(const patch of [{title:{rendered:'NGC 123 (NIRCam Compass Image)'}},{media_details:{width:1200,height:1000}},{credits:'unrelated'},{title:{rendered:'Telescope engineering image'}}])assert.equal(candidate({...m,...patch}),null);
 assert.equal(candidate({...m,caption:{rendered:'A collage with three insets and a scale bar.'}}),null);
 assert.equal(candidate({...m,media_details:{}}),null);
 assert.equal(nearDuplicate('0'.repeat(64),'0'.repeat(63)+'f'),true);assert.equal(nearDuplicate('0'.repeat(64),'f'.repeat(64)),false);
});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rh-nasa-'));t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(dir).startsWith('rh-nasa-'));await fs.rm(dir,{recursive:true,force:true});});const root=path.join(dir,'cache');await fs.mkdir(root);const b=Buffer.from('fixture image'),sha256=hash(b);await fs.writeFile(path.join(root,sha256+'.jpg'),b);await atomic(path.join(root,'library.json'),{version:1,entries:[{id:'nasa-science-123',target:'Nebula',file:sha256+'.jpg',sha256,width:3840,height:2160}]});return {root,directory:path.join(dir,'package'),assertIdle:async()=>{}};}
test('installer registers ordinary Background entries using native library and refuses unowned/edited files',async t=>{
 const f=await fixture(t),files=await desired(f);assert.match(files['_package.py'].toString(),/DefaultEntryConfigType = 'Background'/);assert.match(files['nasa-science-123.py'].toString(),/WhiteCap.Background.package\/Slideshow.lib.py/);assert.doesNotMatch(files['_package.py'].toString(),/inConfigFlags=2/);
 await assert.rejects(install({...f,assertIdle:async()=>{throw Error('active');}}),/active/);
 await install(f);await install(f);assert.ok(await fs.stat(f.directory+'.previous'));
 await fs.appendFile(path.join(f.directory,'_package.py'),'changed');await assert.rejects(install(f),/Edited/);
 const unowned=await fixture(t);await fs.mkdir(unowned.directory);await assert.rejects(install(unowned),/Unowned/);
});
test('installer refuses corrupted prepared files before touching installed package',async t=>{
 const f=await fixture(t);const list=JSON.parse(await fs.readFile(path.join(f.root,'library.json')));await fs.writeFile(path.join(f.root,list.entries[0].file),'changed');await assert.rejects(install(f),/hash mismatch/);assert.equal(await fs.stat(f.directory).catch(()=>null),null);
});
test('reactive prototype changes only Cosmic Cliffs and can revert to the original native package',async t=>{
 const f=await fixture(t),manifest=await readJson(path.join(f.root,'library.json'));
 manifest.entries.push({...manifest.entries[0],id:'nasa-science-904703',target:'Cosmic Cliffs'});
 await atomic(path.join(f.root,'library.json'),manifest);
 const baseline=await desired(f),dir=path.join(f.root,'reactive-prototype');await fs.mkdir(dir);
 const files={};for(const n of ['small','medium','large','cloud']){const name='reactive-'+n+'.png',b=Buffer.from('layer '+n);await fs.writeFile(path.join(dir,name),b);files[name]=hash(b);}
 const p={version:1,enabled:true,imageId:'nasa-science-904703',sourceSha256:manifest.entries[0].sha256,files};
 await atomic(path.join(dir,'prototype.json'),p);const enabled=await desired(f);
 assert.deepEqual(enabled['nasa-science-123.py'],baseline['nasa-science-123.py']);
 assert.deepEqual(enabled['_package.py'],baseline['_package.py']);
 assert.match(enabled['nasa-science-904703.py'].toString(),/ReactiveSpaceBackground/);
 assert.deepEqual(enabled['nasa-science-904703.jpg'],baseline['nasa-science-904703.jpg']);
 await fs.appendFile(path.join(dir,'reactive-small.png'),'bad');await assert.rejects(desired(f),/layer hash mismatch/);
 p.enabled=false;await atomic(path.join(dir,'prototype.json'),p);assert.deepEqual(await desired(f),baseline);
});
async function readJson(p){return JSON.parse(await fs.readFile(p,'utf8'));}
