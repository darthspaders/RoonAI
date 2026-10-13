'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {read,noLinks,hash}=require('../library.cjs');
async function scene(library,e,packageName){
 const work=path.resolve(library,'../layer-remask-v2');
 const activeFile=path.join(work,'active.json');await noLinks(activeFile);
 const active=await read(activeFile,null);if(!active?.enabled)return null;
 if(active.version!==2||!Array.isArray(active.entries))throw Error('Invalid remask activation');
 const item=active.entries.find(x=>x.imageId===e.id);if(!item)return null;
 if(item.sourceSha256!==e.sha256||!/^nasa-(?:science-\d+|auto-[a-f0-9]{24})$/.test(e.id)||!/^[a-f0-9]{64}$/.test(e.sha256))throw Error('Remask active source mismatch');
 const folder=path.join(work,e.id+'-'+e.sha256.slice(0,12));await noLinks(folder);
 const candidate=path.join(folder,'candidate.json');await noLinks(candidate);const bytes=await fs.readFile(candidate);
 if(hash(bytes)!==item.candidateSha256)throw Error('Remask candidate changed after approval');
 const r=JSON.parse(bytes);
 if(r.version!==2||r.recipe!=='separated-cloud-interior-v2'||r.sourceSha256!==e.sha256||r.imageId!==e.id||r.neutralMaxError!==0||r.cloud!==true||r.interiorOnly!==true||r.enabled!==false)throw Error('Invalid remask reconstruction');
 if(r.grid?.[0]!==33||r.grid?.[1]!==19||r.grid[2]?.length!==627||r.grid[2].some((v,i)=>!Number.isFinite(v)||v<0||v>1||((i<33||i>=594||i%33===0||i%33===32)&&v!==0)))throw Error('Invalid remask grid');
 if(r.maxMotionPixels?.length!==2||r.maxMotionPixels.some(v=>!Number.isFinite(v)||v<0||v>64))throw Error('Unsafe remask displacement');
 const files={},paths=[];
 for(const name of ['background.png','cloud-rgba.png','stellar.png']){
  const f=path.join(folder,name);await noLinks(f);const b=await fs.readFile(f);
  if(b.length>40*1024*1024||hash(b)!==r.files[name])throw Error('Remask asset checksum mismatch');
  const member=e.id+'-layer-'+name;files[member]=b;paths.push('/Packages/'+packageName+'/'+member);
 }
 const literal=require('../install.cjs').literal;
 const code='\nLAYER_CONFIG = '+JSON.stringify({grid:r.grid,maxMotionPixels:r.maxMotionPixels})+'\nLAYER_PATHS = ['+paths.map(literal).join(',')+']\n'+await fs.readFile(path.join(__dirname,'LayeredPhoto.py'),'utf8');
 return {files,code};
}
module.exports={scene};
