'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {validate,VERSION,prepare}=require('./expressive.cjs');
const {atomic,hash}=require('./library.cjs'),{desired}=require('./install.cjs');
function receipt(digest){return {version:VERSION,sourceSha256:digest,grid:[25,15,Array(375).fill(0)],stars:[[.5,.5,.02,1]]};}
test('source-bound expressive maps reject changed sources, unsafe weights and excessive features',()=>{
 const r=receipt('a'.repeat(64));assert.equal(validate(r,r.sourceSha256),r);assert.throws(()=>validate(r,'b'.repeat(64)));
 r.grid[2][0]=1;assert.throws(()=>validate(r,r.sourceSha256));r.grid[2][0]=0;r.stars=Array(25).fill(r.stars[0]);assert.throws(()=>validate(r,r.sourceSha256));
});
test('expressive mode covers ordinary images, preserves originals, and requires every receipt',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rh-expressive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'expressive'));
 const image=Buffer.from('fixture photograph'),digest=hash(image),flare=Buffer.from('fixture flare');
 await fs.writeFile(path.join(root,digest+'.jpg'),image);await fs.writeFile(path.join(root,'expressive/flare.png'),flare);
 await atomic(path.join(root,'library.json'),{version:1,entries:[{id:'nasa-science-1',title:'Nebula',file:digest+'.jpg',sha256:digest,width:3840,height:2160}]});
 await atomic(path.join(root,'expressive/active.json'),{version:1,enabled:true,rendererVersion:VERSION,flareSha256:hash(flare)});
 await assert.rejects(desired({root}),/Invalid expressive/);
 await atomic(path.join(root,'expressive',digest+'.json'),receipt(digest));const files=await desired({root});
 assert.deepEqual(files['nasa-science-1.jpg'],image);assert.match(files['nasa-science-1.py'].toString(),/SetDrawClass\(ExpressiveSpaceBackground\)/);
 let worked=false;await prepare({library:root,guarded:()=>{worked=true;}},{presentationSha256:digest});assert.equal(worked,false);
 // Future additions cannot silently use the ordinary-photo renderer.
 await fs.unlink(path.join(root,'expressive',digest+'.json'));await fs.writeFile(path.join(root,'background-4k.jpg'),image);
 await prepare({library:root,folder:()=>root,guarded:async f=>f(new AbortController().signal),execute:async(command,args)=>{worked=true;assert.ok(args.includes(path.join(root,'background-4k.jpg')));await atomic(args.at(-1),receipt(digest));}},{presentationSha256:digest});
 assert.equal(worked,true);assert.equal(validate(JSON.parse(await fs.readFile(path.join(root,'expressive',digest+'.json'))),digest).version,VERSION);
});
