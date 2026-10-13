'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {assertIdle,noLinks,hash,read,atomic}=require('../library.cjs');
const {work}=require('../layer-pilot.cjs');
const {sceneFiles,pythonValue}=require('./package.cjs');
const PACKAGE='RabbitHole.NasaLayers.package';
function options(o={}){return {...o,directory:path.resolve(o.directory||path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','SoundSpectrum/WhiteCap/Packages',PACKAGE)),runtime:path.resolve(o.runtime||path.join(work,'rotation-installation')),assertIdle:o.assertIdle||assertIdle};}
async function desired(){
 const {files,targets}=await sceneFiles(PACKAGE,{expressive:true});
 const template=await fs.readFile(path.join(__dirname,'rotation.py'),'utf8');
 files['_package.py']=Buffer.from(template.replace('__TARGETS__',pythonValue(targets.map(x=>x.name))).replace('__ENTRIES__',pythonValue(targets.map(x=>[x.name,x.script]))).replace('__DIAGNOSTIC__',pythonValue(path.join(work,'rotation-installation','native-status.json').replaceAll('\\','/'))));
 return files;
}
function validRecord(r){return r?.version===1&&r.stage==='installed'&&r.package===PACKAGE&&[16,19,22,25].includes(Object.keys(r.files||{}).length)&&Object.entries(r.files).every(([n,v])=>/^(_package\.py|nasa-science-\d+(\.py|-(source\.jpg|background\.png|cloud-rgba\.png|stellar\.png|layer-background\.png|layer-cloud-rgba\.png|layer-stellar\.png)))$/.test(n)&&/^[a-f0-9]{64}$/.test(v.sha256)&&Number.isSafeInteger(v.bytes)&&v.bytes>0);}
async function readiness(o={}){
 const c=options(o);
 try{
  const file=path.join(c.directory,'..',PACKAGE+'.receipt.json');await noLinks(file);await noLinks(c.directory);
  const r=await read(file,null);if(!validRecord(r))return {ready:false};
  const members=await fs.readdir(c.directory);if(members.length!==Object.keys(r.files).length||members.some(n=>!Object.hasOwn(r.files,n)))return {ready:false};
  for(const [name,item] of Object.entries(r.files)){
   const file=path.join(c.directory,name);await noLinks(file);const stat=await fs.stat(file);
   if(!stat.isFile()||stat.size!==item.bytes||(o.verifyHashes&&hash(await fs.readFile(file))!==item.sha256))return {ready:false};
  }
  return {ready:true};
 }catch{return {ready:false};}
}
async function install(o={}){
 const c=options(o);await c.assertIdle();await noLinks(c.directory);await noLinks(c.runtime);
 const receipt=path.join(c.directory,'..',PACKAGE+'.receipt.json');await noLinks(receipt);
 const old=await read(receipt,null),present=await fs.stat(c.directory).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
 if(old||present){
  if(!old||!present||!(await readiness({...c,verifyHashes:true})).ready)throw Error('Unowned or edited NASA layer package preserved');
 }
 const files=await (c.desired||desired)();
 const record={version:1,stage:'installed',package:PACKAGE,installedAt:new Date().toISOString(),files:Object.fromEntries(Object.entries(files).map(([name,b])=>[name,{sha256:hash(b),bytes:b.length}]))};
 if(!validRecord(record))throw Error('Invalid NASA layer package');
 if(old&&Object.keys(files).length===Object.keys(old.files).length&&Object.keys(files).every(n=>record.files[n].sha256===old.files[n].sha256))return {installedFiles:Object.keys(files).length,updated:false,startupThemeChanged:false};
 await fs.mkdir(c.runtime,{recursive:true});
 const stage=c.directory+'.stage-'+crypto.randomUUID();await noLinks(stage);await fs.mkdir(stage);
 for(const [name,bytes] of Object.entries(files))await fs.writeFile(path.join(stage,name),bytes,{flag:'wx'});
 // Nothing is made visible until every source-bound asset is complete.
 await c.assertIdle();
 if(old){
  const backup=path.join(c.runtime,'backup-'+crypto.randomUUID());await fs.mkdir(backup);
  for(const n of Object.keys(old.files))await fs.copyFile(path.join(c.directory,n),path.join(backup,n),fs.constants.COPYFILE_EXCL);
  await atomic(path.join(backup,'receipt.json'),old);
  // Exact verified members only; never recursive-delete an installation path.
  for(const n of Object.keys(old.files))await fs.unlink(path.join(c.directory,n));await fs.rmdir(c.directory);
 }
 await fs.rename(stage,c.directory);await atomic(receipt,record);
 if(!(await readiness({...c,verifyHashes:true})).ready)throw Error('NASA layer installation verification failed');
 return {installedFiles:Object.keys(files).length,updated:true,startupThemeChanged:false};
}
module.exports={PACKAGE,desired,install,readiness};
if(require.main===module)(process.argv[2]==='install'?install():readiness({verifyHashes:true})).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
