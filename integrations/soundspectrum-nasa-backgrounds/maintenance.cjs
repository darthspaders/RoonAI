"use strict";
// Called by the optional post-validation daily task. At most one discovery run
// per week; no work at all until stability is recorded, and never during visuals.
const path=require('node:path'),fs=require('node:fs/promises');
const {root,read,atomic,request,assertIdle,prepare,official}=require('./library.cjs');
const {install}=require('./install.cjs');
const WEEK=7*24*60*60*1000;
const text=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
function candidate(m){
 const title=text(m.title?.rendered),url=m.source_url||'',w=m.media_details?.width,h=m.media_details?.height,credit=text(m.credits);
 const description=text(m.caption?.rendered||m.alt_text);
 if(!Number.isInteger(m.id)||!/^.+\((?:NIRCam|MIRI|NIRCam and MIRI)(?: Image| image)?\)$/.test(title)
  ||!/nebula|galax|cluster|NGC |IC |Messier|Serpens|Cassiopeia|Sagittarius|Rho Ophiuchi/i.test(title)
  ||/compass|annotat|compar|spectrum|spectra|chart|graph|inset|pull.?out|side.?by.?side|panel|illustrat|diagram|concept|light curve/i.test(title)
  ||/compass|annotat|insets?|pull.?out|side.?by.?side|panels?|collage|scale bar|labels?/i.test(description)
  ||!Number.isFinite(w)||!Number.isFinite(h)
  ||w<3840||h<2160||!credit.includes('NASA')||!/\/missions\/webb\//.test(url)||! /\.(?:jpe?g|png)$/i.test(new URL(official(url)).pathname))return null;
 return {id:'nasa-science-'+m.id,title,target:title.split(' (')[0],mission:'James Webb Space Telescope',credit,
  description,sourceUrl:official(m.link),apiUrl:'https://science.nasa.gov/wp-json/wp/v2/media/'+m.id,
  assetUrl:official(url),releaseDate:m.date,sourceWidth:w,sourceHeight:h,fit:'contain',pinned:false};
}
async function maintain(){
 const pipelineConfig=await read(path.resolve(root,'../pipeline/config.json'),null);
 if(pipelineConfig){
  if(!pipelineConfig.enabled)return {skipped:'NASA asset pipeline disabled'};
  // Existing daily task now performs a bounded, resumable idle-only asset batch.
  require('../../src/config.js');
  try{return await new (require('./pipeline.cjs').Pipeline)().run();}
  catch(e){if(/Stop visuals first|active visualizer session/.test(e.message))return {skipped:'visualizer active'};throw e;}
 }
 if(!(await read(path.join(root,'stability.json'),{})).verified)return {skipped:'initial live stability not yet verified'};
 const prior=await read(path.join(root,'maintenance.json'),{});
 if(Date.now()-(prior.attemptedAt||0)<WEEK)return {skipped:'weekly interval'};
 try{await assertIdle();}catch(e){
  if(/Stop visuals first|active visualizer session/.test(e.message))return {skipped:'visualizer active'};
  throw e;
 }
 await fs.mkdir(root,{recursive:true});
 const lock=await fs.open(path.join(root,'maintenance.lock'),'wx').catch(e=>{if(e.code==='EEXIST')return null;throw e;});
 if(!lock)return {skipped:'maintenance already running (or interrupted lock needs inspection)'};
 try{
  await atomic(path.join(root,'maintenance.json'),{attemptedAt:Date.now(),status:'checking'});
  const library=await read(path.join(root,'library.json'),{entries:[]});
  // One small metadata request, two photographs maximum. Never follow API links.
  const since=new Date(Date.now()-60*24*60*60*1000).toISOString().replace('.000Z','Z');
  const query=new URLSearchParams({search:'NIRCam',per_page:'40',after:since,_fields:'id,title,source_url,media_details,credits,caption,alt_text,date,link'});
  const data=JSON.parse(await request('https://science.nasa.gov/wp-json/wp/v2/media?'+query,4*1024*1024));
  if(!Array.isArray(data))throw Error('NASA response is not an image list');
  const candidates=data.map(m=>{try{return candidate(m);}catch{return null;}}).filter(Boolean)
   .filter(m=>!library.entries.some(e=>e.id===m.id||e.assetUrl===m.assetUrl||e.target===m.target)).slice(0,2);
  if(candidates.length)await prepare(candidates);
  // Also finish a previously prepared batch whose installation was interrupted.
  await assertIdle();await install();
  await atomic(path.join(root,'maintenance.json'),{attemptedAt:Date.now(),status:'complete',candidates:candidates.length});
  return {candidates:candidates.length};
 }catch(e){await atomic(path.join(root,'maintenance.json'),{attemptedAt:Date.now(),status:'deferred',reason:String(e.message).slice(0,240)});throw e;}
 finally{await lock.close();await fs.unlink(path.join(root,'maintenance.lock'));}
}
module.exports={candidate,maintain};
if(require.main===module)maintain().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
