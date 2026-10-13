"use strict";
const fs=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {root,read,atomic,assertIdle,noLinks,hash}=require('./library.cjs');
const {install}=require('./install.cjs');
async function main(action){
 if(!['prepare','install','disable'].includes(action))throw Error('Use prepare, install or disable');
 await assertIdle();
 const directory=path.join(root,'reactive-prototype'),file=path.join(directory,'prototype.json');
 await noLinks(directory);
 if(action==='prepare'){
  const prior=await read(file,null);if(prior?.enabled)throw Error('Disable installed prototype before rebuilding masks');
  const library=await read(path.join(root,'library.json'),null),e=library?.entries?.find(e=>e.id==='nasa-science-904703');
  if(!e||! /^[a-f0-9]{64}\.jpg$/.test(e.file))throw Error('Installed Cosmic Cliffs image missing');
  const source=path.join(root,e.file);await noLinks(source);
  if(hash(await fs.readFile(source))!==e.sha256)throw Error('Source image hash mismatch');
  if(!process.env.RH_TEST_PYTHON)throw Error('Set RH_TEST_PYTHON to Python with Pillow and numpy');
  const r=await promisify(execFile)(process.env.RH_TEST_PYTHON,['-B',path.join(__dirname,'prepare_reactive.py'),source,directory],{windowsHide:true,timeout:120000});
  console.log(r.stdout.trim());return;
 }
 const prototype=await read(file,null);if(!prototype)throw Error('Prepare the prototype first');
 const original=prototype.enabled;prototype.enabled=action==='install';await atomic(file,prototype);
 try{console.log(JSON.stringify(await install()));}catch(e){prototype.enabled=original;await atomic(file,prototype);throw e;}
}
main(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1;});
