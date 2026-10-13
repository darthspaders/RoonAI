"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const O=require('./observation-sources.cjs'),{Pipeline,add}=require('./pipeline.cjs'),{atomic,read}=require('./library.cjs');
const listing=`var images = [{id: 'FS-Tau', title: 'Nebula', width: 4803, height: 4639, url: '/images/FS-Tau/'}];`;
const entry=()=>O.listing(listing,'webb','nebulae')[0];
const detail=(type='Observation')=>`<h1>Nebula</h1><p>Glowing gas and stars.</p><strong>Credit:</strong><div class="credit">ESA/Webb, NASA</div><h4>About the Image</h4><table aria-describedby="About the Image"><tr><th>Type:</th><td colspan="2">${type}</td></tr><tr><th>Size:</th><td>4803 x 4639 px</td></tr></table><table aria-describedby="About the Object"><a href="/images/archive/category/nebulae/">Nebulae</a></table><a href="https://cdn.esawebb.org/archives/images/publicationjpg/FS-Tau.jpg">Publication JPEG</a>`;
test('categorized galleries parse mixed-case IDs and require explicit Observation classification',()=>{
 const e=entry(),d=O.details(detail(),e);assert.equal(e.nasaId,'FS-Tau');assert.equal(d.observationType,'Observation');assert.equal(d.detailPending,false);assert.match(d.assetUrl,/publicationjpg/);assert.equal(d.credit,'ESA/Webb, NASA');
 for(const type of ['Photograph','Illustration',''])assert.throws(()=>O.details(detail(type),e),/non_observation_source/);
 assert.throws(()=>O.details(detail().replace('category/nebulae/','category/spacecraft/'),e),/non_observation_source/);
 assert.throws(()=>O.details(detail().replace('cdn.esawebb.org','example.org'),e),/unsupported_source/);
 assert.throws(()=>O.listingURL('images','people'),/Unapproved/);
 assert.throws(()=>O.listing('changed markup','webb','nebulae'),/markup changed/);
});
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'rh-observations-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));await fs.mkdir(path.join(home,'pipeline'));await atomic(path.join(home,'pipeline','config.json'),{discoveryPolicy:O.POLICY,activeImages:24});return new Pipeline({home:path.join(home,'pipeline'),library:path.join(home,'library'),idle:async()=>{}});}
test('strict policy retires mixed pending inventory, preserves reviewed images, and blocks broad discovery',async t=>{
 const p=await fixture(t);await p.locked(async()=>{
  for(const n of [1,2]){add(p.catalog,{id:'nasa-science-'+n,provider:'science',nasaId:String(n),title:'Nebula',assetUrl:'https://assets.science.nasa.gov/'+n+'.jpg'});}
  p.catalog.assets['nasa-science-2'].stage='verified';await p.revalidate();assert.equal(p.catalog.assets['nasa-science-1'].failureReason,'retired_mixed_archive_source');assert.equal(p.catalog.assets['nasa-science-2'].stage,'verified');
  p.fetch=()=>assert.fail('No broad archive requests');await assert.rejects(p.discoverPage({provider:'science',term:'Hubble'}),/disabled/);
 });
});
test('photo detail is rejected before any image download or worker call',async t=>{
 const p=await fixture(t);await p.locked(async()=>{add(p.catalog,entry());let requests=0;p.request=async url=>{requests++;assert.equal(url,entry().sourceUrl);return Buffer.from(detail('Photograph'));};p.worker=()=>assert.fail('No photo processing');const e=p.catalog.assets[entry().id];await p.process(e);assert.equal(requests,1);assert.equal(e.stage,'rejected');assert.equal(e.failureReason,'non_observation_source');assert.equal(e.downloadStatus,'pending');});
});
test('gallery paging uses all 50 rows and never evaluates archive JavaScript',async t=>{
 const p=await fixture(t);await p.locked(async()=>{p.request=async url=>{assert.match(url,/esawebb.org\/images\/archive\/category\/nebulae\/page\/2/);return Buffer.from(listing);};const result=await p.discoverPage({provider:'webb',term:'nebulae',page:2});assert.equal(result.pageSize,50);assert.equal(result.rows,1);assert.equal(p.catalog.assets[result.ids[0]].stage,'queued');});
});
test('strict trial resumes existing passes and discovers only observation feeds',async t=>{
 const p=await fixture(t),{Trial}=require('./trial.cjs'),trial=new Trial({home:p.home,pipeline:p,log:()=>{}});
 await p.locked(async()=>{add(p.catalog,{id:'nasa-science-1',provider:'science',nasaId:'1',title:'Nebula',assetUrl:'https://assets.science.nasa.gov/1.jpg'});p.catalog.assets['nasa-science-1'].stage='verified';await p.save();await atomic(trial.file,{version:1,target:2,status:'paused',baseline:[],ids:['nasa-science-1'],downloads:{},requests:[],totalRequests:0,cursor:0,pages:{},metadataSeen:0,metadataRejected:0});});
 const feeds=[];p.discoverPage=async q=>{feeds.push(q.provider);assert.ok(['hubble','webb'].includes(q.provider));const e=entry();add(p.catalog,e);return {rows:1,pageSize:50,ids:[e.id]};};
 p.process=async e=>{Object.assign(e,O.details(detail(),e),{stage:'verified'});await p.save();};
 const result=await trial.run({resume:true});assert.equal(result.status,'complete');assert.equal(result.passed,2);assert.equal(result.remaining,0);assert.ok(feeds.length>0);assert.equal((await read(trial.file)).cachedMetadataImported,undefined);
});
test('catalog replacement retries transient locks without losing the previous receipt',async t=>{
 const p=await fixture(t),file=path.join(p.home,'receipt.json');await atomic(file,{old:true});let attempts=0;const waits=[];
 await atomic(file,{new:true},{wait:async ms=>waits.push(ms),rename:async(a,b)=>{attempts++;assert.deepEqual(await read(file),{old:true});if(attempts<3)throw Object.assign(Error('locked'),{code:'EPERM'});await fs.rename(a,b);}});
 assert.equal(attempts,3);assert.deepEqual(waits,[100,200]);assert.deepEqual(await read(file),{new:true});
 attempts=0;await assert.rejects(atomic(file,{lost:true},{wait:async()=>{},rename:async()=>{attempts++;throw Object.assign(Error('locked'),{code:'EBUSY'});}}),/locked/);assert.equal(attempts,6);assert.deepEqual(await read(file),{new:true});
 attempts=0;await assert.rejects(atomic(file,{}, {rename:async()=>{attempts++;throw Object.assign(Error('disk'),{code:'ENOSPC'});}}),/disk/);assert.equal(attempts,1);
});
