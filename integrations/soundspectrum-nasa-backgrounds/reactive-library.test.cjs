const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {promote,png}=require('./reactive-library.cjs');
const {desired,install}=require('./install.cjs');
const {hash,atomic}=require('./library.cjs');
const key='a'.repeat(64),id='nasa-science-123',names=['small','medium','large','cloud'];
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'rh-reactive-'));
 t.after(async()=>{assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(base).startsWith('rh-reactive-'));await fs.rm(base,{recursive:true,force:true});});
 const root=path.join(base,'library'),source=path.join(base,'curated-masks',id+'-'+key.slice(0,20));
 await fs.mkdir(root,{recursive:true});await fs.mkdir(source,{recursive:true});await fs.mkdir(path.join(base,'preprocessing'));
 const bytes=Buffer.from('source fixture'),sha=hash(bytes);await fs.writeFile(path.join(root,sha+'.jpg'),bytes);
 await atomic(path.join(root,'library.json'),{version:1,entries:[{id,target:'Example Nebula',file:sha+'.jpg',sha256:sha,width:3840,height:2160}]});
 const layer=Buffer.alloc(40);Buffer.from('89504e470d0a1a0a','hex').copy(layer);layer.writeUInt32BE(1920,16);layer.writeUInt32BE(1080,20);layer[24]=8;layer[25]=2;
 const files={};for(const n of names){const member='reactive-'+n+'.png';await fs.writeFile(path.join(source,member),layer);files[member]=hash(layer);}
 await atomic(path.join(source,'candidate.json'),{version:1,imageId:id,key,enabled:false,sourceSha256:sha,maxDelta8bit:4,files});
 const review={imageId:id,key,approved:true,reason:'Explicit offline layer and composite review'};
 await atomic(path.join(source,'review.json'),review);
 return {root,source,review,directory:path.join(base,'package'),assertIdle:async()=>{}};
}
test('multi-image promotion preserves source/registration and restores ordinary scene when disabled',async t=>{
 const f=await fixture(t),before=await desired(f);const r=await promote([id+':'+key],f);assert.equal(r.reactiveAdditions,1);
 const after=await desired(f);assert.deepEqual(before[id+'.jpg'],after[id+'.jpg']);assert.deepEqual(before['_package.py'],after['_package.py']);
 assert.match(after[id+'.py'].toString(),/ReactiveSpaceBackground/);assert.ok(after[id+'-reactive-cloud.png']);
 const file=path.join(f.root,'reactive-library/active.json'),active=JSON.parse(await fs.readFile(file));await atomic(file,{...active,enabled:false});assert.deepEqual(await desired(f),before);
});
test('promotion requires exact reviewed key and unmodified masks',async t=>{
 const f=await fixture(t);await atomic(path.join(f.source,'review.json'),{...f.review,key:'b'.repeat(64)});
 await assert.rejects(promote([id+':'+key],f),/review required/);
 await atomic(path.join(f.source,'review.json'),f.review);await fs.appendFile(path.join(f.source,'reactive-small.png'),'changed');
 await assert.rejects(promote([id+':'+key],f),/layer changed/);
});
test('failed installation restores prior active manifest and releases lock',async t=>{
 const f=await fixture(t);await assert.rejects(promote([id+':'+key],{...f,install:async()=>{throw Error('busy');}}),/busy/);
 const state=JSON.parse(await fs.readFile(path.join(f.root,'reactive-library/active.json')));assert.equal(state.enabled,false);
 assert.equal(await fs.stat(path.resolve(f.root,'../preprocessing/prepare.lock')).catch(()=>null),null);
});
test('invalid dimensions and unsafe/protected IDs rejected',async()=>{
 assert.throws(()=>png(Buffer.from('invalid')),/PNG/);
 await assert.rejects(promote(['nasa-science-904703:'+key]),/protected/);
 await assert.rejects(promote(['../elsewhere:'+key]),/keys/);
});
