const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {promisify}=require('node:util'),{execFile}=require('node:child_process');
const {install,readiness,desired}=require('./install.cjs');
const {getOwnedTarget}=require('../soundspectrum-now-playing/index.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rh-whitecap-art-'));t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(dir).startsWith('rh-whitecap-art-'));await fs.rm(dir,{recursive:true,force:true});});return {runtime:path.join(dir,'runtime'),directory:path.join(dir,'package'),assertClosed:async()=>{}};}
test('only explicitly enabled WhiteCap owned music sessions may publish artwork',()=>{
 const s={state:'running',visualizer:'whitecap',inputKind:'music-feed',inputSource:'roon-hqplayer',zoneId:'exact-zone',generation:1,clock:()=>10,leases:new Map([['viewer',20]]),native:{status:()=>({owned:true,state:'running',visualizer:'whitecap',pid:123})}};
 assert.equal(getOwnedTarget(s,'instance'),null);assert.equal(getOwnedTarget(s,'instance','whitecap').nativePid,123);
 for(const change of [{inputKind:'no-mic'},{leases:new Map()},{closed:true},{zoneId:''},{native:{status:()=>({owned:false})}}])assert.equal(getOwnedTarget({...s,...change},'instance','whitecap'),null);
});
test('installation verifies exact package ownership and refuses edited/unowned files or a running WhiteCap',async t=>{
 const f=await fixture(t);assert.equal((await readiness(f)).ready,false);
 await assert.rejects(install({...f,assertClosed:async()=>{throw Error('running');}}),/running/);
 await install(f);assert.equal((await readiness(f)).ready,true);
 await fs.appendFile(path.join(f.directory,'_package.py'),'\n# changed');assert.equal((await readiness(f)).ready,false);await assert.rejects(install(f),/Edited/);
 const unowned=await fixture(t);await fs.mkdir(unowned.directory);await assert.rejects(install(unowned),/Unowned/);
});
test('native geometry, audio response, fresh-track handling and restoration run against stubs',async t=>{
 const f=await fixture(t);await fs.mkdir(f.runtime,{recursive:true});const files=await desired(f),filename=path.join(f.runtime,'rendered.py');await fs.writeFile(filename,files['_package.py']);
 const {stdout,stderr}=await promisify(execFile)(process.env.RH_TEST_PYTHON || 'python',['-B',path.join(__dirname,'test_native.py'),filename],{windowsHide:true,timeout:20000});assert.match(stdout+stderr,/OK/);
});
