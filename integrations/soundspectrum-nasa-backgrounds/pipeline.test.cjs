"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Pipeline,add,config,validReceipt,status}=require('./pipeline.cjs');
const {hash,atomic,read}=require('./library.cjs'),S=require('./pipeline-sources.cjs');
const entry=(n=1)=>({id:'nasa-science-'+n,provider:'science',nasaId:String(n),title:'Test nebula',target:'Test nebula',description:'NASA nebula image',mission:'JWST',credit:'NASA',sourceUrl:'https://science.nasa.gov/image/'+n,assetUrl:'https://assets.science.nasa.gov/'+n+'.jpg',suitabilityScore:80});
async function fixture(t,options={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'rh-nasa-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const home=path.join(root,'pipeline'),library=path.join(root,'library');await fs.mkdir(library);await fs.mkdir(home);await atomic(path.join(home,'config.json'),{discoveryPolicy:'legacy'});const p=new Pipeline({home,library,idle:async()=>{},...options});return p;}
test('identities deduplicate canonical source aliases across NASA providers',()=>{const c={assets:{}};assert.equal(add(c,entry()),true);assert.equal(add(c,{...entry(2),assetUrl:entry().assetUrl+'?w=6000#image'}),false);assert.equal(Object.keys(c.assets).length,1);assert.equal(add(c,{...entry(3),provider:'images',sourceUrl:entry().sourceUrl}),false);});
test('official sources, aspect suitability, nonphotographic exclusions',()=>{assert.throws(()=>S.official('https://science.nasa.gov.evil.test/a'));assert.throws(()=>S.official('http://science.nasa.gov/a'));assert.throws(()=>S.official('https://x@science.nasa.gov/a'));assert.equal(S.eligible({...entry(),sourceWidth:4000,sourceHeight:7000}),null);assert.ok(S.suitability({...entry(),sourceWidth:7680,sourceHeight:4320})>S.suitability({...entry(),sourceWidth:4320,sourceHeight:7680}));assert.equal(S.eligible({...entry(),title:'Nebula annotated chart'}),'non_photographic_or_annotated');assert.throws(()=>config({batchSize:500}));});
test('NASA legacy HTTP manifests are upgraded narrowly; overlays and insets excluded',()=>{assert.equal(S.manifestUrl('http://images-assets.nasa.gov/image/a~orig.jpg'),'https://images-assets.nasa.gov/image/a~orig.jpg');assert.throws(()=>S.manifestUrl('http://science.nasa.gov/a.jpg'));assert.equal(S.eligible({...entry(),description:'This field is overlaid with a map of dark matter.'}),'non_photographic_or_annotated');assert.equal(S.eligible({...entry(),description:'Location is shown by the white cross.'}),'non_photographic_or_annotated');});

test('NASA resize requests preserve 4K admission for landscape, portrait and panorama without upscaling',()=>{
 for(const [w,h] of [[11256,4877],[4877,11256],[18828,6397],[3840,2160],[2160,3840],[6000,4000]]){
  const u=new URL(S.acquisition({...entry(),assetUrl:'https://assets.science.nasa.gov/dynamicimage/a.png',sourceWidth:w,sourceHeight:h}));
  const downloadedWidth=Number(u.searchParams.get('w')),downloadedHeight=Math.round(h*downloadedWidth/w);
  assert.ok(downloadedWidth<=w);assert.ok(Math.min(downloadedWidth,downloadedHeight)>=2160);assert.ok(Math.max(downloadedWidth,downloadedHeight)>=3840);
 }
});

test('caption evidence excludes press graphics and source-bound visual review excludes missed text',()=>{
 for(const description of ['A galaxy labeled A in a pullout.', 'A horizontal collage of three images.', 'Objects circled in green.', 'The featured illustration imagines a planet.', 'A box is enlarged on the right half.'])assert.equal(S.eligible({...entry(),description}),'non_photographic_or_annotated');
 for(const title of ['Planet artist concept', "Planet artist's concept", 'Planet artist’s impression', "Planet artists' rendering"])assert.equal(S.eligible({...entry(),title}),'non_photographic_or_annotated');
 const reviewed=require('./review-exclusions.json').entries[0];assert.match(S.eligible({...entry(),...reviewed}),/^visual_review:/);
 assert.equal(S.eligible({...entry(),...reviewed,presentationSha256:'changed-source-needs-new-review'}),null);
});
test('checksum receipt rejects corruption',async t=>{const p=await fixture(t);await fs.writeFile(path.join(p.library,'a.jpg'),'original');await atomic(path.join(p.library,'prepared.json'),{files:{'a.jpg':hash('original')}});assert.ok(await validReceipt(p.library,'prepared.json'));await fs.writeFile(path.join(p.library,'a.jpg'),'changed');assert.equal(await validReceipt(p.library,'prepared.json'),null);});

test('press photographs cannot qualify through Webb or galaxy boilerplate',()=>{
 for(const title of ['James Webb Space Telescope Briefing','James Webb Space Telescope Town Hall','Ariane 5 Rollout with James Webb Space Telescope','John Grunsfeld Speaks at Hubble 25th Anniversary Image Unveiling',"NASA's Webb Telescope Clean Room Transporter",'NHFP Photo Montage-2026 Fellows'])
  assert.equal(S.eligible({...entry(),title,description:'Webb will study stars and galaxies.'}),'non_celestial_subject');
 assert.equal(S.eligible({...entry(),title:'Webb photograph',description:'The scientist, wearing Webb themed socks, waits. Webb studies galaxies.'}),'non_celestial_subject');
 for(const title of ['SN 1006: A Supernova Ribbon from Hubble','Portrait of NGC 1055','Galaxy Evolution Explorer Celebrates Five Years in Space'])assert.equal(S.eligible({...entry(),title}),null);
});

test('publication rechecks verified content and retains quarantined source files',async t=>{
 const p=await fixture(t,{install:async()=>({loaded:false})});await p.locked(async()=>{
  const good=entry(1),bad={...entry(2),title:'James Webb Space Telescope Briefing'};
  for(const item of [good,bad]){
   add(p.catalog,item);const e=p.catalog.assets[item.id],bytes=Buffer.from('image '+item.id);
   await fs.mkdir(p.folder(e));await fs.writeFile(path.join(p.folder(e),'background-4k.jpg'),bytes);
   await atomic(path.join(p.folder(e),'prepared.json'),{files:{'background-4k.jpg':hash(bytes)}});
   await atomic(path.join(p.folder(e),'masks.json'),{files:{'background-4k.jpg':hash(bytes)}});
   Object.assign(e,{stage:'verified',registrationStatus:'installed',presentationSha256:hash(bytes),maskStatus:'static',prepared:{fit:'contain'}});
  }
  await atomic(path.join(p.library,'library.json'),{version:1,entries:[good,bad].map(e=>({id:e.id,sha256:p.catalog.assets[e.id].presentationSha256}))});
  const result=await p.publishWhiteCap();assert.equal(result.installed,1);
  const rejected=p.catalog.assets[bad.id];assert.equal(rejected.stage,'rejected');assert.equal(rejected.registrationStatus,'excluded');assert.equal(rejected.contentReview.previousStage,'verified');
  assert.equal(await fs.readFile(path.join(p.folder(rejected),'background-4k.jpg'),'utf8'),'image '+bad.id);
  assert.deepEqual((await read(path.join(p.library,'library.json'))).entries.map(e=>e.id),[good.id]);
 });
});
test('rate limit persists and prevents repeat request',async t=>{let calls=0;const p=await fixture(t,{fetch:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'7200'}});}});await p.locked(async()=>{await assert.rejects(p.request(entry().assetUrl),/backoff/);await assert.rejects(p.request(entry().assetUrl),/backoff/);assert.equal(calls,1);});const fresh=await read(path.join(p.home,'catalog.json'));assert.ok(fresh.rateLimitedUntil>Date.now()+7100000);});
test('secret header only reaches api.nasa.gov and never follows to another host',async t=>{const previous=process.env.NASA_API_KEY;process.env.NASA_API_KEY='test-not-real';t.after(()=>{if(previous===undefined)delete process.env.NASA_API_KEY;else process.env.NASA_API_KEY=previous;});const seen=[];const p=await fixture(t,{fetch:async(u,o)=>{seen.push(o.headers);return seen.length===1?new Response('',{status:302,headers:{location:'https://science.nasa.gov/a'}}):new Response('{}');}});await p.locked(()=>p.request('https://api.nasa.gov/a'));assert.equal(seen[0]['X-Api-Key'],'test-not-real');assert.equal(seen[1]['X-Api-Key'],undefined);});
test('live visualizer prevents all network/processing work',async t=>{const p=await fixture(t,{idle:async()=>{throw Error('active visualizer');},fetch:async()=>assert.fail('network called')});await assert.rejects(p.run({manual:true}),/active visualizer/);});
test('dead process lock resumes, live process lock refuses',async t=>{const p=await fixture(t);await fs.mkdir(p.home,{recursive:true});await atomic(path.join(p.home,'pipeline.lock'),{pid:process.pid});await assert.rejects(p.locked(async()=>{}),/already running/);await atomic(path.join(p.home,'pipeline.lock'),{pid:2147483647});await p.locked(async()=>{assert.equal(p.catalog.version,1);});assert.ok((await fs.readdir(p.home)).some(n=>n.includes('interrupted')));});
test('full processing resumes after restart without reacquisition; duplicate bytes skipped',async t=>{
 let downloads=0,workers=0;const p=await fixture(t,{fetch:async()=>{downloads++;return new Response('source');},install:async()=>({loaded:false})});
 p.worker=async(action,e)=>{workers++;const f=p.folder(e);if(action==='prepare'){await fs.writeFile(path.join(f,'source.jpg'),'master');await fs.writeFile(path.join(f,'background-4k.jpg'),'presentation');const r={version:'test',files:{'source.jpg':hash('master'),'background-4k.jpg':hash('presentation')}};await atomic(path.join(f,'prepared.json'),r);return r;}const files={};for(const n of ['small','medium','large','cloud']){const name='reactive-'+n+'.png';await fs.writeFile(path.join(f,name),'layer');files[name]=hash('layer');}const r={version:'test',quality:{status:'static'},files};await atomic(path.join(f,'masks.json'),r);return r;};
 await p.locked(async()=>{add(p.catalog,entry());await p.process(p.catalog.assets[entry().id]);assert.equal(p.catalog.assets[entry().id].stage,'verified');await p.register();});
 const q=new Pipeline({home:p.home,library:p.library,idle:async()=>{},fetch:async()=>{downloads++;return new Response('source');}});
 await q.locked(async()=>{assert.equal(q.catalog.assets[entry().id].stage,'verified');assert.equal(add(q.catalog,entry()),false);await q.process(q.catalog.assets[entry().id]);add(q.catalog,entry(2));await q.process(q.catalog.assets[entry(2).id]);assert.equal(q.catalog.assets[entry(2).id].stage,'duplicate');});
 assert.equal(downloads,2);assert.equal(workers,2);const s=await status({home:p.home,library:p.library});assert.equal(s.prepared,1);assert.equal(s.duplicates,1);assert.ok(s.localBytes>0);
});
test('download checkpoint survives new process without network',async t=>{const p=await fixture(t,{fetch:async()=>assert.fail('redownload')});await p.locked(async()=>{add(p.catalog,entry());const e=p.catalog.assets[entry().id];await fs.mkdir(p.folder(e));await fs.writeFile(path.join(p.folder(e),'download.bin'),'checkpoint');await p.acquire(e);assert.equal(e.stage,'downloaded');assert.equal(e.originalContentHash,hash('checkpoint'));});});
test('repeated source failures become permanent and retain reason',async t=>{const p=await fixture(t,{fetch:async()=>new Response('',{status:404})});await p.locked(async()=>{add(p.catalog,entry());await p.process(p.catalog.assets[entry().id]);const e=p.catalog.assets[entry().id];assert.equal(e.stage,'failed');assert.equal(e.permanent,true);assert.match(e.failureReason,/HTTP 404/);});});

test('transient server failure preserves the queue stage for rate-limited retry',async t=>{const p=await fixture(t,{fetch:async()=>new Response('',{status:502})});await p.locked(async()=>{add(p.catalog,entry());const e=p.catalog.assets[entry().id];await assert.rejects(p.process(e),/NASA HTTP 502/);assert.equal(e.stage,'queued');assert.equal(e.attempts,0);});});

test('scale registration writes the catalog once and respects the native pool cap',async t=>{
 const p=await fixture(t,{install:async()=>({loaded:false})});await p.locked(async()=>{
  p.cfg.activeImages=24;
  for(let i=1;i<=30;i++){add(p.catalog,entry(i));const e=p.catalog.assets[entry(i).id],bytes=Buffer.from('image '+i);await fs.mkdir(p.folder(e));await fs.writeFile(path.join(p.folder(e),'background-4k.jpg'),bytes);await atomic(path.join(p.folder(e),'prepared.json'),{files:{'background-4k.jpg':hash(bytes)}});await atomic(path.join(p.folder(e),'masks.json'),{files:{'background-4k.jpg':hash(bytes)}});Object.assign(e,{stage:'verified',presentationSha256:hash(bytes),maskStatus:'static',prepared:{fit:'contain'},verifiedAt:new Date().toISOString()});}
  let saves=0;const save=p.save.bind(p);p.save=async()=>{saves++;await save();};
  const r=await p.register();assert.equal(r.installed,24);assert.equal(saves,1);assert.equal(Object.values(p.catalog.assets).filter(e=>e.registrationStatus==='eligible').length,6);
 });
});
