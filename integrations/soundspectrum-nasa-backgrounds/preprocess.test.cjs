'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {prepare,validateIds,disposition}=require('./preprocess.cjs');
test('quality review is source/config-specific and never enables a static fallback',()=>{
 const report={status:'candidate',imageId:'nasa-science-1',cacheKey:'a'};
 assert.equal(disposition(report,null),'static-pending-review');
 assert.equal(disposition(report,{imageId:report.imageId,cacheKey:'older',decision:'ready-for-native-test'}),'static-pending-review');
 assert.equal(disposition(report,{...report,decision:'keep-static'}),'keep-static');
 assert.equal(disposition(report,{...report,decision:'ready-for-native-test'}),'ready-for-native-test');
 assert.equal(disposition({...report,status:'static'},{...report,decision:'ready-for-native-test'}),'keep-static');
});
test('only bounded explicit local image identifiers are admitted',()=>{
 for(const ids of [[],['../../bad'],['nasa-science-1','nasa-science-1'],Array.from({length:9},(_,i)=>'nasa-science-'+i)])
  assert.throws(()=>validateIds(ids));
 assert.deepEqual(validateIds(['nasa-science-1']),['nasa-science-1']);
});
test('busy renderer blocks preparation before any worker executes',async()=>{
 let executed=false;
 await assert.rejects(prepare(['nasa-science-1'],{idle:async()=>{throw Error('active visuals')},execute:async()=>{executed=true}}),/active visuals/);
 assert.equal(executed,false);
});
test('exclusive lock, isolated interpreter, arguments and cleanup on failure',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rh-mask-test-'));
 const python=path.join(dir,'python.exe');await fs.writeFile(python,'test');
 const options={work:dir,python,idle:async()=>{},execute:async(exe,args,settings)=>{
  assert.equal(exe,python);assert.equal(args.at(-1),'nasa-science-1');
  assert.equal(settings.windowsHide,true);assert.equal(settings.timeout,120000);
  assert.equal(settings.env.OMP_NUM_THREADS,'2');throw Error('worker failure');
 }};
 try{
  await fs.writeFile(path.join(dir,'prepare.lock'),'');
  await assert.rejects(prepare(['nasa-science-1'],options),/already running/);
  await fs.unlink(path.join(dir,'prepare.lock'));
  await assert.rejects(prepare(['nasa-science-1'],options),/worker failure/);
  await assert.rejects(fs.access(path.join(dir,'prepare.lock')),{code:'ENOENT'});
 }finally{await fs.unlink(python);await fs.rmdir(dir);}
});
test('new visualizer activity aborts an in-flight worker',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rh-mask-test-'));
 const python=path.join(dir,'python.exe');await fs.writeFile(python,'test');let checks=0;
 try{
  await assert.rejects(prepare(['nasa-science-1'],{work:dir,python,
   idle:async()=>{if(++checks>2)throw Error('visualizer became active')},
   execute:async(exe,args,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))
  }),/visualizer became active/);
  await assert.rejects(fs.access(path.join(dir,'prepare.lock')),{code:'ENOENT'});
 }finally{await fs.unlink(python);await fs.rmdir(dir);}
});
