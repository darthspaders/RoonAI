"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {desired}=require('./install.cjs');const {hash,atomic}=require('./library.cjs');
test('source-bound flare install preserves photograph, registration and emission bytes; disable restores legacy',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rh-nasa-motion-'));
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('rh-nasa-motion-'));await fs.rm(root,{force:true,recursive:true});});
 const id='nasa-science-904703',source=Buffer.from('source'),sha=hash(source),flare=Buffer.from('small glow'),flareSha=hash(flare);
 await fs.writeFile(path.join(root,sha+'.jpg'),source);await atomic(path.join(root,'library.json'),{version:1,entries:[{id,target:'Cosmic Cliffs',sha256:sha,file:sha+'.jpg',width:3840,height:2160}]});
 const proto=path.join(root,'reactive-prototype');await fs.mkdir(proto);const files={};
 for(const name of ['small','medium','large','cloud']){const n='reactive-'+name+'.png';await fs.writeFile(path.join(proto,n),'layer');files[n]=hash('layer');}
 await atomic(path.join(proto,'prototype.json'),{version:1,enabled:true,imageId:id,sourceSha256:sha,files});
 const before=await desired({root});await fs.mkdir(path.join(root,'motion'));await fs.writeFile(path.join(root,'motion',flareSha+'.png'),flare);
 assert.match(before[id+'.py'].toString(),/LIVELY_STARS = False\nFLARE_PATH = None\nFLARE_STARS = \[\]/);
 const manifest={version:1,enabled:true,entries:[{imageId:id,sourceSha256:sha,stars:[[.5,.5,.025,1,0,1,1,1]],flareFile:flareSha+'.png',flareSha256:flareSha}]};
 const file=path.join(root,'motion/active.json');await atomic(file,manifest);const after=await desired({root});
 assert.match(after[id+'.py'].toString(),/LIVELY_STARS = True/);assert.deepEqual(after[id+'.jpg'],before[id+'.jpg']);assert.deepEqual(after['_package.py'],before['_package.py']);
 assert.doesNotMatch(after[id+'.py'].toString(),/LIVELY_STARS = False/);
 assert.match(after[id+'.py'].toString(),/CLOUD_PATH = None\nCLOUD_MOTION = None/);
 for(const n of Object.keys(files))assert.deepEqual(after[n],before[n]);
 await atomic(file,{...manifest,enabled:false});assert.deepEqual(await desired({root}),before);
 manifest.entries[0].sourceSha256='wrong';await atomic(file,manifest);await assert.rejects(desired({root}),/source mismatch/);
 manifest.entries[0].sourceSha256=sha;manifest.entries[0].stars[0][2]=100;await atomic(file,manifest);await assert.rejects(desired({root}),/Invalid source-bound/);
});
test('future admitted automatic stars get flares; cloud light is source-bound and cannot leak to another scene',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rh-nasa-motion-'));
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('rh-nasa-motion-'));await fs.rm(root,{force:true,recursive:true});});
 const id='nasa-science-904703',auto='nasa-auto-'+'a'.repeat(24),sha=hash('photo'),flareSha=hash('flare'),cloudSha=hash('cloud');
 await fs.writeFile(path.join(root,sha+'.jpg'),'photo');
 await atomic(path.join(root,'library.json'),{version:1,entries:[id,auto].map(id=>({id,target:id,sha256:sha,file:sha+'.jpg',width:3840,height:2160}))});
 const proto=path.join(root,'reactive-prototype'),autoFolder=path.join(root,'assets',auto);await fs.mkdir(proto);await fs.mkdir(autoFolder,{recursive:true});
 const files={};for(const n of ['small','medium','large','cloud']){const name='reactive-'+n+'.png';files[name]=hash('layer');await fs.writeFile(path.join(proto,name),'layer');await fs.writeFile(path.join(autoFolder,name),'layer');}
 await atomic(path.join(proto,'prototype.json'),{version:1,enabled:true,imageId:id,sourceSha256:sha,files});
 await atomic(path.join(root,'pipeline-active.json'),{version:1,enabled:true,entries:[{imageId:auto,folder:auto,sourceSha256:sha,files}]});
 const receipt={sourceSha256:sha,quality:{status:'reactive'},stars:[{x:100,y:200,diameter:5,flux:20,group:'medium'}],files};
 await atomic(path.join(autoFolder,'masks.json'),receipt);
 await fs.mkdir(path.join(root,'motion'));await fs.writeFile(path.join(root,'motion',flareSha+'.png'),'flare');await fs.writeFile(path.join(root,'motion',cloudSha+'.png'),'cloud');
 const grid=[33,19,Array(33*19).fill(0)];grid[2][9*33+16]=.8;
 const item={imageId:id,sourceSha256:sha,stars:[[.5,.5,.025,1,0,1,1,1]],flareFile:flareSha+'.png',flareSha256:flareSha,cloudMotion:grid,cloudFile:cloudSha+'.png',cloudSha256:cloudSha,cloudEmissionSha256:files['reactive-cloud.png']};
 const manifest={version:1,enabled:true,automaticStars:true,entries:[item]};const file=path.join(root,'motion/active.json');await atomic(file,manifest);
 const result=await desired({root,pipelineRoot:root});
 assert.match(result[auto+'.py'].toString(),/LIVELY_STARS = True/);assert.match(result[auto+'.py'].toString(),/CLOUD_PATH = None\nCLOUD_MOTION = None/);
 assert.match(result[id+'.py'].toString(),/nasa-science-904703-cloud-flow.png/);assert.deepEqual(result[id+'.jpg'],Buffer.from('photo'));
 assert.deepEqual(result[id+'-cloud-flow.png'],Buffer.from('cloud'));
 item.cloudEmissionSha256=hash('other');await atomic(file,manifest);await assert.rejects(desired({root,pipelineRoot:root}),/Cloud emission source mismatch/);
 item.cloudEmissionSha256=files['reactive-cloud.png'];grid[2][0]=.5;await atomic(file,manifest);await assert.rejects(desired({root,pipelineRoot:root}),/Invalid source-bound cloud/);
 grid[2][0]=0;await atomic(file,manifest);receipt.sourceSha256=hash('other');await atomic(path.join(autoFolder,'masks.json'),receipt);await assert.rejects(desired({root,pipelineRoot:root}),/Automatic flare source mismatch/);
 receipt.sourceSha256=sha;delete receipt.stars;await atomic(path.join(autoFolder,'masks.json'),receipt);
 const legacy=await desired({root,pipelineRoot:root});assert.match(legacy[auto+'.py'].toString(),/LIVELY_STARS = False/);assert.match(legacy[auto+'.py'].toString(),/class ReactiveSpaceBackground/);
});
