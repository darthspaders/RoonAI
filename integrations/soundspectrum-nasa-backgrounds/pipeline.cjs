"use strict";
// Asset work only. Playback never imports this module or accesses NASA.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const legacy=require('./library.cjs'),sources=require('./pipeline-sources.cjs');
const {read,atomic,hash,noLinks}=legacy;
const observations=require('./observation-sources.cjs');
const HOME=path.resolve(legacy.root,'../pipeline'),ID=/^nasa-(?:science-\d+|auto-[a-f0-9]{24})$/;
const defaults={version:1,enabled:false,discoveryPolicy:observations.POLICY,batchSize:2,queriesPerRun:2,discoveryIntervalHours:24,activeImages:'all',maxStorageGB:20,maxAttempts:3};
const terms=['NIRCam','nebula','galaxy','star cluster','supernova remnant','cosmic dust','Hubble','Jupiter'];
const now=()=>new Date().toISOString();
async function loadKey(){
 if(process.env.NASA_API_KEY!==undefined)return;
 const env=await fs.readFile(path.resolve(__dirname,'../../.env'),'utf8').catch(()=> '');
 const line=env.split(/\r?\n/).find(x=>/^\s*NASA_API_KEY\s*=/.test(x));
 if(line)process.env.NASA_API_KEY=line.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,'');
}
function config(c){const v={...defaults,...c};if(!['legacy',observations.POLICY].includes(v.discoveryPolicy))throw Error('Invalid discovery policy');for(const [k,lo,hi] of [['batchSize',1,5],['queriesPerRun',1,4],['discoveryIntervalHours',24,720],['activeImages',19,40],['maxStorageGB',1,1000],['maxAttempts',1,5]]){if(k==='activeImages'&&v[k]==='all')continue;if(!Number.isInteger(v[k])||v[k]<lo||v[k]>hi)throw Error('Invalid pipeline setting '+k);}return v;}
async function bytesUnder(dir){let n=0;for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())n+=await bytesUnder(p);else if(e.isFile())n+=(await fs.stat(p)).size;}return n;}
async function validReceipt(folder,name){const r=await read(path.join(folder,name),null);if(!r?.files)return null;for(const [n,h] of Object.entries(r.files)){if(path.basename(n)!==n)throw Error('Invalid receipt member');await noLinks(path.join(folder,n));if(hash(await fs.readFile(path.join(folder,n)).catch(()=>Buffer.alloc(0)))!==h)return null;}return r;}
function aliases(e){return [...new Set([e.provider+':'+e.nasaId,...[e.sourceUrl,e.assetUrl,e.apiUrl].filter(Boolean).map(sources.canonical)])];}
function add(c,e){
 const keys=aliases(e),found=Object.values(c.assets).find(x=>x.id===e.id||x.aliases.some(k=>keys.includes(k)));
 if(found){found.aliases=[...new Set([...found.aliases,...keys])];return false;}
 if(!ID.test(e.id))throw Error('Invalid catalog ID');
 c.assets[e.id]={...e,aliases:keys,discoveredAt:now(),stage:e.rejection?'rejected':'queued',failureReason:e.rejection||null,
  attempts:0,downloadStatus:'pending',processingStatus:'pending',maskStatus:'pending',registrationStatus:'pending'};
 return true;
}
async function status(o={}){
 const home=o.home||HOME,c=await read(path.join(home,'catalog.json'),{assets:{}}),entries=Object.values(c.assets),cfg=config(await read(path.join(home,'config.json'),{}));
 const count=fn=>entries.filter(fn).length;
 const storage=await bytesUnder(home),library=await bytesUnder(o.library||legacy.root);
 const ownership=await read(path.join(o.library||legacy.root,'installation.json'),null);
 const installedBytes=ownership?.directory?await bytesUnder(ownership.directory):0;
 const installationBackupBytes=ownership?.directory?await bytesUnder(ownership.directory+'.previous'):0;
 const nasaDataBytes=await bytesUnder(path.dirname(home));
 const expressive=!!c.whitecapPublication?.expressiveScenes;
 return {enabled:cfg.enabled,configuration:cfg,discovered:entries.length,downloaded:count(e=>e.downloadStatus==='complete'),prepared:count(e=>e.processingStatus==='complete'),
  renderer:expressive?(c.whitecapPublication.rendererVersion||'expressive-1'):'conservative',separatedCloudScenes:c.whitecapPublication?.separatedCloudScenes||0,expressiveScenes:c.whitecapPublication?.expressiveScenes||0,
  conservativeMasks:{reactive:count(e=>e.stage==='verified'&&e.maskStatus==='reactive'),static:count(e=>e.stage==='verified'&&e.maskStatus==='static')},
  reactive:count(e=>e.stage==='verified'&&(expressive||e.maskStatus==='reactive')),static:expressive?0:count(e=>e.stage==='verified'&&e.maskStatus==='static'),maskGenerations:count(e=>!!e.masks),registered:count(e=>e.registrationStatus==='installed'),
  eligible:count(e=>e.stage==='verified'),failures:count(e=>e.stage==='failed'),rejected:count(e=>e.stage==='rejected'),duplicates:count(e=>e.stage==='duplicate'),
  queued:count(e=>['queued','downloaded','prepared','masked'].includes(e.stage)),localBytes:storage+library,averageAssetBytes:count(e=>e.localBytes)?Math.round(entries.reduce((s,e)=>s+(e.localBytes||0),0)/count(e=>e.localBytes)):0,
  pipelineBytes:storage,legacyLibraryBytes:library,installedBytes,installationBackupBytes,nasaDataBytes,totalLocalNasaBytes:nasaDataBytes+installedBytes+installationBackupBytes,
  whitecapPublication:c.whitecapPublication||null,pendingInstallation:count(e=>e.stage==='verified'&&e.registrationStatus!=='installed'),
  lastRun:c.lastRun||null,lastDiscovery:c.lastDiscovery||null,rateLimitedUntil:c.rateLimitedUntil||null,keyConfigured:!!process.env.NASA_API_KEY};
}
async function publicStatus(){return read(path.join(HOME,'status.json'),{enabled:false,status:'pipeline has not completed its first run'});}
async function publicCatalog(offset=0,limit=50){
 const c=await read(path.join(HOME,'catalog.json'),{assets:{}});const list=Object.values(c.assets);
 return {total:list.length,offset,entries:list.slice(offset,offset+limit).map(e=>({id:e.id,title:e.title,mission:e.mission,credit:e.credit,sourceUrl:e.sourceUrl,stage:e.stage,downloadStatus:e.downloadStatus,processingStatus:e.processingStatus,maskStatus:e.maskStatus,registrationStatus:e.registrationStatus,suitabilityScore:e.suitabilityScore,localBytes:e.localBytes,failureReason:e.failureReason,maskVersion:e.maskVersion,quality:e.masks?.quality}))};
}
class Pipeline{
 constructor(o={}){this.home=o.home||HOME;this.library=o.library||legacy.root;this.idle=o.idle||legacy.assertIdle;this.fetch=o.fetch||fetch;this.install=o.install||require('./install.cjs').install;this.execute=o.execute||exec;this.requests=0;
  this.requestBudget=o.requestBudget??30;this.beforeRequest=o.beforeRequest;this.onDownload=o.onDownload;
  if(!Number.isInteger(this.requestBudget)||this.requestBudget<1||this.requestBudget>5000)throw Error('Invalid request budget');
 }
 folder(e){if(!ID.test(e.id))throw Error('Invalid asset ID');return path.join(this.home,'assets',e.id);}
 async save(){await atomic(path.join(this.home,'catalog.json'),this.catalog);}
 rejection(e){
  if(this.cfg.discoveryPolicy===observations.POLICY&&!e.pinned&&e.stage!=='verified'&&
    (!['hubble','webb'].includes(e.provider)||e.sourcePolicy!==observations.POLICY))return 'retired_mixed_archive_source';
  // Gallery membership alone cannot establish the pictured subject. Detail checks
  // run before acquisition; verified observations must retain their provenance.
  if(e.sourcePolicy===observations.POLICY&&e.detailPending&&e.stage==='verified')return 'unverified_observation_source';
  if(e.sourcePolicy===observations.POLICY&&e.detailPending)return e.sourceWidth&&e.sourceHeight&&(Math.max(e.sourceWidth,e.sourceHeight)<3840||Math.min(e.sourceWidth,e.sourceHeight)<2160)?'insufficient_resolution':null;
  if(e.sourcePolicy===observations.POLICY&&e.observationType!=='Observation')return 'non_observation_source';
  return sources.eligible(e);
 }
 async revalidate(){
  let changed=0;
  for(const e of Object.values(this.catalog.assets)){
   if(!['verified','queued','downloaded','prepared','masked'].includes(e.stage))continue;
   const reason=this.rejection(e);if(!reason)continue;
   e.contentReview={previousStage:e.stage,reason,at:now(),presentationSha256:e.presentationSha256||null};
   e.stage='rejected';e.failureReason=reason;
   e.registrationStatus=e.registrationStatus==='installed'?'exclusion-pending':'excluded';
   changed++;
  }
  if(changed)await this.save();return changed;
 }
 async publishWallpapers(onlyIds){
  await this.revalidate();
  const home=this.home===HOME?path.resolve(this.home,'../../nasa-wallpaper'):path.resolve(this.home,'../wallpaper');
  try{
   const configuration=await read(path.join(home,'config.json'),null);if(!configuration?.enabled)return {enabled:false};
   return await require('../nasa-wallpaper/publisher.cjs').publishFinished({home,catalogHome:this.home,output:configuration.output,protectedDirectories:[this.library],catalog:this.catalog,onlyIds});
  }catch(e){return {wallpaperError:String(e.message).slice(0,240)};}
 }
 async publishWhiteCap(){
  await this.revalidate();
  if(this.cfg.activeImages!=='all')return {skipped:'bounded library uses explicit registration'};
  const ready=Object.values(this.catalog.assets).filter(e=>e.stage==='verified');
  const installed=await read(path.join(this.library,'library.json'),{entries:[]});
  // Reconcile a verified-but-unpublished checkpoint on every resume, even when
  // there are no downloads left or discovery itself is unavailable.
  const same=ready.length===installed.entries.length&&ready.every(e=>e.registrationStatus==='installed'&&installed.entries.some(x=>x.id===e.id&&x.sha256===e.presentationSha256));
  if(same)return {skipped:'all verified images already installed',installed:ready.length,loaded:false};
  return this.register();
 }
 async guarded(work){await this.idle();const controller=new AbortController();let busy=false,failed;
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{await this.idle();}catch(e){failed=e;controller.abort();}finally{busy=false;}},2000);
  try{const result=await work(controller.signal);if(failed)throw failed;await this.idle();return result;}finally{clearInterval(timer);}}
 async locked(work){
  await this.idle();await noLinks(this.home);await fs.mkdir(path.join(this.home,'assets'),{recursive:true});
  const lockPath=path.join(this.home,'pipeline.lock');await noLinks(lockPath);
  let lock;
  for(let i=0;i<2;i++)try{lock=await fs.open(lockPath,'wx');break;}catch(e){
   if(e.code!=='EEXIST')throw e;const prior=await read(lockPath,null);if(!prior?.pid)throw Error('Unrecognized pipeline lock');
   try{process.kill(prior.pid,0);throw Error('NASA pipeline already running');}catch(err){if(err.code!=='ESRCH')throw err;}
   // Exclusive owner is dead. Rename preserves crash evidence and avoids deleting an unknown file.
   await fs.rename(lockPath,lockPath+'.interrupted-'+crypto.randomUUID());
  }
  if(!lock)throw Error('Could not acquire pipeline lock');await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:now()}));
  try{this.cfg=config(await read(path.join(this.home,'config.json'),{}));this.catalog=await read(path.join(this.home,'catalog.json'),{version:1,assets:{},queries:{},cursor:0});if(this.catalog.version!==1)throw Error('Unsupported catalog version');return await work();}
  finally{await lock.close();await fs.unlink(lockPath);}
 }
 async request(url,max=4*1024*1024){
  if(this.catalog.rateLimitedUntil>Date.now())throw Error('NASA rate-limit backoff');
  return this.guarded(async signal=>{
   for(let redirect=0;redirect<4;redirect++){
    const u=sources.official(url);if(++this.requests>this.requestBudget)throw Error('Request budget reached');
    if(this.beforeRequest)await this.beforeRequest(signal);signal.throwIfAborted();
    const headers={'User-Agent':'RabbitHole-LocalNASA/2.0'};
    if(u.hostname==='api.nasa.gov'&&process.env.NASA_API_KEY)headers['X-Api-Key']=process.env.NASA_API_KEY;
    const r=await this.fetch(u.href,{redirect:'manual',headers,signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();url=new URL(r.headers.get('location'),u).href;continue;}
    if(r.status===429||r.status===503){await r.body?.cancel();const retry=r.headers.get('retry-after');const seconds=Number(retry);const delay=retry&&Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now();this.catalog.rateLimitedUntil=Date.now()+Math.max(3600000,Number.isFinite(delay)?delay:0);await this.save();throw Error('NASA rate-limit backoff');}
    if(!r.ok){await r.body?.cancel();throw Error('NASA HTTP '+r.status);}
    if(Number(r.headers.get('content-length'))>max){await r.body?.cancel();throw Error('source_exceeds_download_limit');}
    const chunks=[];let n=0;for await(const b of r.body){n+=b.length;if(n>max)throw Error('source_exceeds_download_limit');chunks.push(b);}return Buffer.concat(chunks);
   }throw Error('NASA redirect limit');
  });
 }
 async worker(action,e){
  const python=path.resolve(legacy.root,'../preprocessing/venv/Scripts/python.exe');
  return this.guarded(async signal=>{const {stdout}=await this.execute(python,['-B',path.join(__dirname,'preprocessing/pipeline.py'),action,this.folder(e),e.id],{windowsHide:true,timeout:150000,maxBuffer:1024*1024,signal,env:{...process.env,PYTHONUTF8:'1',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2',MKL_NUM_THREADS:'2'}});return JSON.parse(stdout);});
 }
 async metadata(e,persist=true){const folder=this.folder(e);await noLinks(folder);await fs.mkdir(folder,{recursive:true});e.localBytes=await bytesUnder(folder);await atomic(path.join(folder,'metadata.json'),e);if(persist)await this.save();}
 async migrate(){
  const old=await read(path.join(this.library,'library.json'),{entries:[]});let imported=0;
  for(const entry of old.entries){
   if(this.catalog.assets[entry.id])continue;
   await this.idle();const data=await fs.readFile(path.join(this.library,entry.file));if(hash(data)!==entry.sha256)throw Error('Existing source checksum changed');
   const e={...entry,provider:'science',nasaId:entry.id.replace('nasa-science-','')};add(this.catalog,e);const item=this.catalog.assets[e.id],folder=this.folder(item);await fs.mkdir(folder,{recursive:true});
   await fs.writeFile(path.join(folder,'source.jpg'),data);await fs.writeFile(path.join(folder,'background-4k.jpg'),data);
   const prepared={version:'legacy-import-1',sourceDimensions:entry.sourceDimensions,retainedDimensions:[3840,2160],fit:entry.fit,perceptualHash:entry.perceptualHash,files:{'source.jpg':entry.sha256,'background-4k.jpg':entry.sha256}};
   await atomic(path.join(folder,'prepared.json'),prepared);Object.assign(item,{stage:'prepared',pinned:true,downloadStatus:'complete',processingStatus:'complete',sourceRetention:'existing prepared 4K; earlier downloaded master was not retained',processingVersion:'legacy-import-1',presentationSha256:entry.sha256,prepared,localPaths:{source:'source.jpg',presentation:'background-4k.jpg'},suitabilityScore:sources.suitability(e),registrationStatus:'installed'});
   await this.metadata(item);imported++;
  }return {imported};
 }
 async discover(){
  if(this.catalog.lastDiscovery&&Date.now()-Date.parse(this.catalog.lastDiscovery)<this.cfg.discoveryIntervalHours*3600000)return {skipped:'discovery interval'};
  let added=0,known=0;this.catalog.queries||={};
  for(let i=0;i<this.cfg.queriesPerRun;i++){
   const strict=this.cfg.discoveryPolicy===observations.POLICY,index=(strict?this.catalog.observationCursor:this.catalog.cursor)||0;
   const [provider,term]=strict?observations.feeds[index%observations.feeds.length]:[index%2?'images':'science',terms[Math.floor(index/2)%terms.length]];const key=provider+':'+term,cursorKey=strict?'observationCursor':'cursor';
   const prior=this.catalog.queries[key]||{},page=prior.nextPage||1;
   if(prior.lastAt&&Date.now()-Date.parse(prior.lastAt)<24*3600000){this.catalog[cursorKey]=index+1;continue;}
   const result=await this.discoverPage({provider,term,page});added+=result.added;known+=result.known;
   this.catalog.queries[key]={lastAt:now(),nextPage:result.rows<(result.pageSize||20)?1:Math.min(100,page+1)};this.catalog[cursorKey]=index+1;await this.save();
  }
  this.catalog.lastDiscovery=now();await this.save();return {added,known,requests:this.requests};
 }
 async discoverPage({provider,term,page=1,pageSize=20}){
  if(['hubble','webb'].includes(provider)){
   const rows=observations.listing((await this.request(observations.listingURL(provider,term,page))).toString(),provider,term);let added=0,known=0;const ids=[];
   for(const e of rows){e.suitabilityScore=sources.suitability(e);e.rejection=this.rejection(e);if(add(this.catalog,e))added++;else known++;ids.push(e.id);}
   await this.save();return {added,known,rows:rows.length,ids,pageSize:50};
  }
  if(this.cfg.discoveryPolicy===observations.POLICY)throw Error('Mixed archive discovery disabled');
  if(!['science','images'].includes(provider)||!Number.isInteger(page)||page<1||page>100||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw Error('Invalid discovery page');
  const url=provider==='science'?'https://science.nasa.gov/wp-json/wp/v2/media?'+new URLSearchParams({search:term,per_page:String(pageSize),page:String(page),_fields:'id,title,source_url,media_details,credits,caption,alt_text,date,link'}):'https://images-api.nasa.gov/search?'+new URLSearchParams({q:term,media_type:'image',page:String(page),page_size:String(pageSize)});
  const body=JSON.parse(await this.request(url));const rows=provider==='science'?body:body.collection?.items;if(!Array.isArray(rows))throw Error('Invalid NASA discovery response');
  let added=0,known=0;const ids=[];
  for(const row of rows){const e=provider==='science'?sources.science(row):sources.images(row);if(!e)continue;if(add(this.catalog,e))added++;else known++;ids.push(e.id);}
  await this.save();return {added,known,rows:rows.length,ids};
 }
 async acquire(e){
  if(!e.assetUrl){const body=JSON.parse(await this.request(e.manifestUrl));const items=body.collection?.items||[];
   const urls=items.map(x=>{try{return sources.manifestUrl(x.href);}catch{return null;}}).filter(x=>x&&/\.(jpe?g|png)$/i.test(sources.official(x).pathname)&&!/~(thumb|small|medium)/i.test(x));
   urls.sort((a,b)=>(/~orig/i.test(b)?2:/~large/i.test(b)?1:0)-(/~orig/i.test(a)?2:/~large/i.test(a)?1:0));
   if(!urls.length)throw Error('unsupported_format');e.assetUrl=sources.canonical(urls[0]);e.aliases=[...new Set([...e.aliases,e.assetUrl])];await this.save();
  }
  const duplicate=Object.values(this.catalog.assets).find(x=>x.id!==e.id&&x.aliases.includes(sources.canonical(e.assetUrl))&&x.stage!=='duplicate'&&x.downloadStatus==='complete');
  if(duplicate){e.stage='duplicate';e.duplicateOf=duplicate.id;return;}
  const folder=this.folder(e);let bytes=await fs.readFile(path.join(folder,'download.bin')).catch(()=>null);
  if(!bytes){bytes=await this.request(sources.acquisition(e),64*1024*1024);await fs.writeFile(path.join(folder,'download.part'),bytes);await fs.rename(path.join(folder,'download.part'),path.join(folder,'download.bin'));}
  if(this.onDownload)await this.onDownload(e,{bytes:bytes.length,sha256:hash(bytes)});
  const digest=hash(bytes),same=Object.values(this.catalog.assets).find(x=>x.id!==e.id&&(x.sourceHash===digest||x.originalContentHash===digest));
  if(same){e.stage='duplicate';e.duplicateOf=same.id;await fs.unlink(path.join(folder,'download.bin'));return;}
  Object.assign(e,{originalContentHash:digest,downloadStatus:'complete',downloadedAt:now(),stage:'downloaded'});await this.metadata(e);
 }
 async process(e){
  const folder=this.folder(e);await noLinks(folder);await fs.mkdir(folder,{recursive:true});await atomic(path.join(folder,'input.json'),{title:e.title,description:e.description});
  try{
   if(e.sourcePolicy===observations.POLICY&&e.detailPending){
    try{Object.assign(e,observations.details((await this.request(e.sourceUrl)).toString(),e));}
    catch(error){if(!/non_observation_source|incomplete_observation_metadata|unsupported_source|asset host mismatch/.test(error.message))throw error;e.stage='rejected';e.failureReason=error.message;await this.metadata(e);return;}
    e.aliases=[...new Set([...e.aliases,...aliases(e)])];await this.metadata(e);
    await atomic(path.join(folder,'input.json'),{title:e.title,description:e.description});
   }
   if(!e.pinned){const reason=this.rejection(e);if(reason){e.stage='rejected';e.failureReason=reason;await this.metadata(e);return;}}
   if(e.stage==='queued')await this.acquire(e);
   if(e.stage==='duplicate'){await this.metadata(e);return;}
   if(e.stage==='downloaded'){
    const prepared=await validReceipt(folder,'prepared.json')||await this.worker('prepare',e);
    const same=Object.values(this.catalog.assets).find(x=>x.id!==e.id&&(x.presentationSha256===prepared.files['background-4k.jpg']||legacy.nearDuplicate(x.prepared?.perceptualHash,prepared.perceptualHash)));
    if(same){e.stage='duplicate';e.duplicateOf=same.id;await fs.unlink(path.join(folder,'download.bin')).catch(()=>{});await this.metadata(e);return;}
    Object.assign(e,{prepared,presentationSha256:prepared.files['background-4k.jpg'],processingVersion:prepared.version,sourceAspectRatio:prepared.sourceAspectRatio,
     sourceDimensions:prepared.sourceDimensions,localPaths:{source:'source.jpg',presentation:'background-4k.jpg'},processingStatus:'complete',stage:'prepared'});
    await this.metadata(e);await fs.unlink(path.join(folder,'download.bin')).catch(()=>{});
   }
   if(e.stage==='prepared'){
    const masks=await validReceipt(folder,'masks.json')||await this.worker('masks',e);
    Object.assign(e,{masks,maskVersion:masks.version,maskStatus:masks.quality.status,stage:'masked'});
    e.suitabilityDetails={resolution:e.prepared.sourceDimensions,aspect:e.prepared.sourceAspectRatio||e.sourceWidth/e.sourceHeight,detail:e.prepared.detailScore||null,contrast:e.prepared.contrast||null,confidentStars:masks.quality.stars||0,diffuseSupport:masks.quality.cloudMean||0};
    if(!e.pinned)e.suitabilityScore=Math.min(100,sources.suitability({...e,sourceWidth:e.prepared.sourceDimensions?.[0],sourceHeight:e.prepared.sourceDimensions?.[1]})+Math.min(5,(e.prepared.detailScore||0)*30)+Math.min(5,(masks.quality.stars||0)/5));
    await this.metadata(e);
   }
   if(e.stage==='masked'){
    if(!await validReceipt(folder,'prepared.json')||!await validReceipt(folder,'masks.json'))throw Error('quality_checksum_failed');
    // The imported reviewed rendering must reproduce byte-for-byte before admission.
    if(e.pinned){const active=await read(path.join(this.library,'reactive-library/active.json'),{}),entry=active.entries?.find(x=>x.imageId===e.id);
     const expected=entry||await read(path.join(this.library,'reactive-prototype/prototype.json'),{});
     for(const [n,h] of Object.entries(expected.files||{}))if(e.masks.files[n]!==h)throw Error('reviewed_emission_changed');
    }
    e.stage='verified';e.verifiedAt=now();e.failureReason=null;e.registrationStatus='eligible';await this.metadata(e);
   }
  }catch(error){
   if(/Stop visuals|active visualizer|abort|Cannot verify Rabbit Hole|rate-limit|Request budget|Trial |fetch failed|ECONN|ETIMEDOUT|NASA HTTP 50[024]/i.test(error.message))throw error;
   e.attempts=(e.attempts||0)+1;e.failureReason=String(error.message).split('\n').filter(x=>/Error:|ValueError:/.test(x)).pop()||String(error.message).slice(0,250);
   e.resumeStage=e.stage;e.stage='failed';e.nextRetryAt=Date.now()+Math.min(7*86400000,3600000*2**e.attempts);
   e.permanent=/insufficient_resolution|unsupported_format|reviewed_|quality_|source_exceeds|HTTP 40[034]/.test(e.failureReason)||e.attempts>=this.cfg.maxAttempts;await this.metadata(e);
  }
  if(e.stage==='verified'){await this.publishWallpapers([e.id]);await this.publishWhiteCap();}
 }
 async register(){
  await this.idle();await this.revalidate();const candidates=Object.values(this.catalog.assets).filter(e=>e.stage==='verified');
  await noLinks(this.library);await fs.mkdir(this.library,{recursive:true});
  const pinned=candidates.filter(e=>e.pinned),others=candidates.filter(e=>!e.pinned).sort((a,b)=>(a.lastSelectedAt||'').localeCompare(b.lastSelectedAt||'')||b.suitabilityScore-a.suitabilityScore);
  const all=this.cfg.activeImages==='all';
  if(!all&&pinned.length>this.cfg.activeImages)throw Error('Pinned collection exceeds pool limit');
  let selected=all?candidates:[...pinned,...others.slice(0,this.cfg.activeImages-pinned.length)];if(!selected.length)return {skipped:'no verified images'};
  const libFile=path.join(this.library,'library.json'),autoFile=path.join(this.library,'pipeline-active.json');
  const previous=await read(libFile,null),previousAuto=await read(autoFile,null),entries=[],automatic=[];
  // Retain earlier display-name precedence when another image has the same
  // target. New IDs append deterministically; installation never caps all-mode.
  if(all){const order=new Map((previous?.entries||[]).map((e,i)=>[e.id,i]));selected.sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity)||a.id.localeCompare(b.id));}
  // Never evict an original reviewed entry while its import/mask validation is incomplete.
  for(const e of previous?.entries||[])if(e.pinned&&!selected.some(x=>x.id===e.id))throw Error('Existing reviewed image not yet verified');
  for(const e of selected){
   // Universal artistic response is independent of the older conservative mask
   // classification. A newly admitted image must be prepared before publication.
   await require('./expressive.cjs').prepare(this,e);
   if(e.registrationStatus!=='installed'||!previous?.entries.some(x=>x.id===e.id&&x.sha256===e.presentationSha256)){
    const prepared=await validReceipt(this.folder(e),'prepared.json'),masks=await validReceipt(this.folder(e),'masks.json');
    if(!prepared||!masks||prepared.files['background-4k.jpg']!==e.presentationSha256||e.maskStatus==='reactive'&&JSON.stringify(masks.files)!==JSON.stringify(e.masks?.files))throw Error('Qualification receipt validation failed for '+e.id+'; installation withheld');
   }
   const folder=this.folder(e),file=e.presentationSha256+'.jpg',bytes=await fs.readFile(path.join(folder,'background-4k.jpg'));if(hash(bytes)!==e.presentationSha256)throw Error('Presentation checksum changed');
   await noLinks(path.join(this.library,file));
   const current=await fs.readFile(path.join(this.library,file)).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
   if(current&&hash(current)!==e.presentationSha256)throw Error('Existing presentation changed');
   if(!current){const temp=path.join(this.library,file+'.part-'+crypto.randomUUID());await fs.writeFile(temp,bytes,{flag:'wx'});await fs.rename(temp,path.join(this.library,file));}
   entries.push({id:e.id,title:e.title,target:e.target,mission:e.mission,credit:e.credit,description:e.description,sourceUrl:e.sourceUrl,assetUrl:e.assetUrl,apiUrl:e.apiUrl,releaseDate:e.releaseDate,pinned:!!e.pinned,file,sha256:e.presentationSha256,width:3840,height:2160,bytes:bytes.length,preparedAt:e.verifiedAt,fit:e.prepared.fit});
   if(!e.pinned&&e.maskStatus==='reactive')automatic.push({imageId:e.id,sourceSha256:e.presentationSha256,folder:e.id,files:Object.fromEntries(Object.entries(e.masks.files).filter(([n])=>n.startsWith('reactive-')))});
  }
  await atomic(path.join(this.home,'registration-pending.json'),{version:1,previous,previousAuto,selected:selected.map(e=>e.id)});
  try{
   await atomic(libFile,{version:1,entries});await atomic(autoFile,{version:1,enabled:true,entries:automatic});await this.idle();
   const desired=await require('./install.cjs').desired({root:this.library,pipelineRoot:this.home,hashOnly:true});const prior=await read(path.join(this.library,'installation.json'),{});
   const changed=Object.keys(desired).length!==Object.keys(prior.files||{}).length||Object.entries(desired).some(([n,digest])=>prior.files?.[n]!==digest);
   if(changed)await this.install({root:this.library,pipelineRoot:this.home,assertIdle:this.idle});
   for(const e of Object.values(this.catalog.assets))if(e.registrationStatus==='exclusion-pending')e.registrationStatus='excluded';
   for(const e of candidates){e.registrationStatus=selected.includes(e)?'installed':'eligible';if(selected.includes(e))e.lastSelectedAt=now();await this.metadata(e,false);}
   const expressive=await require('./expressive.cjs').enabled(this.library);
   const layers=await read(path.resolve(this.library,'../layer-remask-v2/active.json'),null);
   const separatedCloudScenes=layers?.enabled?layers.entries.filter(r=>selected.some(e=>e.id===r.imageId&&e.presentationSha256===r.sourceSha256)).length:0;
   const publication={separatedCloudScenes,rendererVersion:expressive?require('./expressive.cjs').RENDERER_VERSION:'conservative',at:now(),policy:all?'all-verified':'bounded',installed:selected.length,reactive:expressive?selected.length:selected.filter(e=>e.maskStatus==='reactive').length,static:expressive?0:selected.filter(e=>e.maskStatus==='static').length,conservativeMasks:{reactive:selected.filter(e=>e.maskStatus==='reactive').length,static:selected.filter(e=>e.maskStatus==='static').length},expressiveScenes:expressive?selected.length:0,changed,loaded:false};
   this.catalog.whitecapPublication=publication;await this.save();
   await fs.unlink(path.join(this.home,'registration-pending.json'));
   const current=await read(path.join(this.home,'status.json'),{});
   await atomic(path.join(this.home,'status.json'),{...current,configuration:this.cfg,registered:selected.length,pendingInstallation:candidates.length-selected.length,eligible:candidates.length,renderer:publication.rendererVersion||'conservative',separatedCloudScenes,expressiveScenes:publication.expressiveScenes,reactive:publication.reactive,static:publication.static,conservativeMasks:publication.conservativeMasks,whitecapPublication:publication});
   return publication;
  }catch(e){await atomic(libFile,previous);await atomic(autoFile,previousAuto);throw e;}
 }
 async recoverRegistration(){const p=await read(path.join(this.home,'registration-pending.json'),null);if(!p)return;await atomic(path.join(this.library,'library.json'),p.previous);await atomic(path.join(this.library,'pipeline-active.json'),p.previousAuto);await fs.unlink(path.join(this.home,'registration-pending.json'));}
 async run(o={}){await loadKey();return this.locked(async()=>{
  await this.recoverRegistration();if(!this.cfg.enabled&&!o.manual)return {skipped:'pipeline disabled'};
  if(await bytesUnder(path.resolve(this.home,'..'))>this.cfg.maxStorageGB*1024**3)return {skipped:'storage ceiling; inspect before increasing; no assets deleted'};
  const startedAt=now();let discovery;
  try{await this.migrate();await this.publishWallpapers();await this.publishWhiteCap();if(o.discovery!==false)discovery=await this.discover();
   for(const e of Object.values(this.catalog.assets))if(e.stage==='failed'&&!e.permanent&&e.nextRetryAt<=Date.now())e.stage=e.resumeStage;
   const queue=Object.values(this.catalog.assets).filter(e=>['queued','downloaded','prepared','masked'].includes(e.stage)).sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||b.suitabilityScore-a.suitabilityScore);
   const limit=o.migrateAll?queue.filter(e=>e.pinned).length:this.cfg.batchSize;
   for(const e of queue.slice(0,limit))await this.process(e);
   const registration=this.cfg.activeImages==='all'?await this.publishWhiteCap():await this.register();this.catalog.lastRun={startedAt,endedAt:now(),status:'complete',discovery,processed:Math.min(limit,queue.length),registration};await this.save();await atomic(path.join(this.home,'status.json'),await status({home:this.home,library:this.library}));return this.catalog.lastRun;
  }catch(e){this.catalog.lastRun={startedAt,endedAt:now(),status:'deferred',reason:String(e.message).slice(0,250)};await this.save();await atomic(path.join(this.home,'status.json'),await status({home:this.home,library:this.library}));throw e;}
 });}
}
async function main(){
 // Load the existing local .env parser without printing configuration or credentials.
 await loadKey();
 const command=process.argv[2]||'status',p=new Pipeline();
 if(command==='status')return status();
 if(command==='enable'||command==='disable')return p.locked(async()=>{p.cfg.enabled=command==='enable';await atomic(path.join(p.home,'config.json'),p.cfg);await atomic(path.join(p.home,'status.json'),await status());return {enabled:p.cfg.enabled};});
 if(command==='init')return p.run({manual:true,discovery:false,migrateAll:true});
 if(command==='publish-all')return p.locked(async()=>{
  await p.recoverRegistration();p.cfg.activeImages='all';await atomic(path.join(p.home,'config.json'),p.cfg);
  const result=await p.register(),snapshot=await status();
  const job=await read(path.join(p.home,'trial-500.json'),null);
  if(job){snapshot.trial=require('./trial.cjs').summary(job,p.catalog);await atomic(path.join(p.home,'trial-status.json'),snapshot.trial);}
  await atomic(path.join(p.home,'status.json'),snapshot);return result;
 });
 if(command==='run')return p.run({manual:process.argv.includes('--manual')});
 if(command==='discover')return p.locked(()=>p.discover());
 if(command==='retry')return p.locked(async()=>{const e=p.catalog.assets[process.argv[3]];if(!e||e.stage!=='failed')throw Error('Choose a failed catalog ID');e.stage=e.resumeStage||'queued';e.attempts=0;e.permanent=false;e.failureReason=null;await p.save();return {id:e.id,stage:e.stage};});
 if(command==='regenerate')return p.locked(async()=>{const e=p.catalog.assets[process.argv[3]];if(!e||e.stage!=='verified')throw Error('Choose a verified catalog ID');const folder=p.folder(e);await fs.rename(path.join(folder,'masks.json'),path.join(folder,'masks.previous-'+Date.now()+'.json'));e.stage='prepared';await p.save();await p.process(e);return {id:e.id,stage:e.stage,maskVersion:e.maskVersion};});
 throw Error('Commands: status, init, publish-all, discover, run [--manual], enable, disable, retry ID, regenerate ID');
}
module.exports={Pipeline,status,publicStatus,publicCatalog,config,add,aliases,validReceipt,bytesUnder,HOME,loadKey};
if(require.main===module)main().then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
