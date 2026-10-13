'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {install,readiness,PACKAGE}=require('./install-rotation.cjs');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rh-nasa-theme-'));
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'rh-nasa-theme-'));await fs.rm(root,{recursive:true,force:true});});
 const directory=path.join(root,PACKAGE),runtime=path.join(root,'runtime');
 const files={'_package.py':Buffer.from('fixture rotation')};
 for(const id of ['1','2','3'])for(const suffix of ['.py','-source.jpg','-background.png','-cloud-rgba.png','-stellar.png'])files['nasa-science-'+id+suffix]=Buffer.from('fixture '+id+suffix);
 const theme=path.join(root,'existing-theme.txt');await fs.writeFile(theme,'unchanged theme');
 return {root,directory,runtime,theme,files,assertIdle:async()=>{},desired:async()=>files};
}
test('isolated installation is verified and idempotent without editing existing theme',async t=>{
 const f=await fixture(t);assert.equal((await readiness(f)).ready,false);
 assert.equal((await install(f)).installedFiles,16);assert.equal((await readiness({...f,verifyHashes:true})).ready,true);
 assert.equal((await install(f)).updated,false);assert.equal(await fs.readFile(f.theme,'utf8'),'unchanged theme');
 await fs.writeFile(path.join(f.directory,'_package.py'),'changed');
 assert.equal((await readiness({...f,verifyHashes:true})).ready,false);
 await assert.rejects(install(f),/edited/);
 assert.equal(await fs.readFile(path.join(f.directory,'_package.py'),'utf8'),'changed');
});
test('running visuals and unowned directories are preserved',async t=>{
 const f=await fixture(t);
 await assert.rejects(install({...f,assertIdle:async()=>{throw Error('visuals active');}}),/visuals active/);
 assert.equal(await fs.stat(f.directory).catch(()=>null),null);
 await fs.mkdir(f.directory);await fs.writeFile(path.join(f.directory,'keep.txt'),'user file');
 await assert.rejects(install(f),/Unowned/);
 assert.equal(await fs.readFile(path.join(f.directory,'keep.txt'),'utf8'),'user file');
});
