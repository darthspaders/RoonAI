'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {scene}=require('./install.cjs'),{classify}=require('../layer-remask.cjs'),{hash,atomic}=require('../library.cjs');
test('cloud proposals exclude galaxy/deep-field/cluster subjects, include explicitly described gas',()=>{
 assert.equal(classify({title:'Rho Ophiuchi',description:'A cloud complex'}),true);
 assert.equal(classify({title:'Galaxies in a deep field',description:'Gas clouds in galaxies'}),false);
 assert.equal(classify({title:'A brilliant star cluster'}),false);
 assert.equal(classify({title:'NGC 253: Dusty Island Universe',description:'Contains dust and gas clouds'}),false);
 assert.equal(classify({title:'NGC 4449 (NIRCam)',description:'A dwarf galaxy with gas clouds and star-forming regions.'}),false);
 assert.equal(classify({title:'Countryside Mars and Milky Way',description:'Pink nebulae in a terrestrial panorama.'}),false);
});
test('unreviewed candidates cannot publish; approval binds source, mesh and every asset',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'rh-remask-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'library'),work=path.join(temp,'layer-remask-v2');await fs.mkdir(root);await fs.mkdir(work);
 const e={id:'nasa-science-1',sha256:'a'.repeat(64)},folder=path.join(work,e.id+'-'+e.sha256.slice(0,12));await fs.mkdir(folder);
 const r={version:2,recipe:'separated-cloud-interior-v2',sourceSha256:e.sha256,imageId:e.id,neutralMaxError:0,cloud:true,interiorOnly:true,enabled:false,grid:[33,19,Array(627).fill(0)],maxMotionPixels:[64,48],files:{}};
 for(const n of ['background.png','cloud-rgba.png','stellar.png']){const b=Buffer.from(n);await fs.writeFile(path.join(folder,n),b);r.files[n]=hash(b);}
 async function approve(){await atomic(path.join(folder,'candidate.json'),r);await atomic(path.join(work,'active.json'),{version:2,enabled:true,entries:[{imageId:e.id,sourceSha256:e.sha256,candidateSha256:hash(await fs.readFile(path.join(folder,'candidate.json')))}]});}
 await atomic(path.join(folder,'candidate.json'),r);assert.equal(await scene(root,e,'RabbitHole.Test.package'),null);
 await approve();const s=await scene(root,e,'RabbitHole.Test.package');assert.equal(Object.keys(s.files).length,3);assert.match(s.code,/LayeredSpaceBackground/);
 await assert.rejects(scene(root,{...e,sha256:'b'.repeat(64)},'RabbitHole.Test.package'),/source mismatch/);
 await atomic(path.join(folder,'candidate.json'),{...r,neutralMaxError:1});await assert.rejects(scene(root,e,'RabbitHole.Test.package'),/changed after approval/);
 r.grid[2][0]=.5;await approve();await assert.rejects(scene(root,e,'RabbitHole.Test.package'),/grid/);
 r.grid[2][0]=0;await approve();await fs.writeFile(path.join(folder,'stellar.png'),'changed');await assert.rejects(scene(root,e,'RabbitHole.Test.package'),/checksum/);
});
