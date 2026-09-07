"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FreshPool, FreshnessEvents, identityKeys, settings, searchFreshPool } = require("../src/standbyFreshness");
const { StandbyCandidateStore } = require("../src/standbyCandidateStore");
const { recordRefresh } = require("../src/standbyNovelty");
const config = settings({});
const track = (id, artist = `Artist ${id}`, title = `Track ${id}`) => ({ tidal: {id:String(id)}, artist, title, score:85, album:`Release ${id}` });
const offenders = [
  track(1,"Hobin Rude","My Golden Cage (Kasper Koman 6AM Reprise)"),
  track(2,"Avoure","Voile"), track(3,"Yotto","Odd One Out"),
  track(4,"Kasper Koman","The Blind Navigator"),
  track(5,"Stereo Underground, Sealine","Flashes (D-Nox & Beckers Remix)")
];
test("five manual refreshes exclude offenders and all recent pools before review, including restart and clear", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rh-fresh-"));
  try {
    const file=path.join(dir,"standby.json");
    let store=new StandbyCandidateStore({file,targetCount:25});
    store.replace(offenders,{recordHistory:true});
    const ever=new Set(offenders.flatMap(identityKeys));
    const counts=[];
    for(let run=0;run<5;run++) {
      const snapshot=store.read();
      const pool=new FreshPool({history:snapshot.standbyHistory,current:snapshot.candidates,config});
      const fresh=Array.from({length:25},(_,i)=>track(100+run*25+i));
      const result=await searchFreshPool({pool,passes:[{id:"initial"},{id:"replacement"}],
        search:async pass=>({tracks:[...offenders,...snapshot.candidates,...(pass.id==="initial"?fresh.slice(0,15):fresh)]}),
        review:async tracks=>{
          assert.equal(tracks.length,25);
          assert.ok(tracks.every(t=>identityKeys(t).every(k=>!ever.has(k))));
          return {tracks:tracks.slice().reverse(),review:{attempted:true,participated:true}};
        }
      });
      assert.equal(result.novelty.carriedOver,0);
      assert.equal(result.novelty.newTracksIntroduced,25);
      assert.equal(result.novelty.replacementSearchPasses,1);
      counts.push(result.tracks.length);
      result.tracks.flatMap(identityKeys).forEach(k=>ever.add(k));
      store.replace(result.tracks,{recordHistory:true});
      if(run===2) store.clear();
      store=new StandbyCandidateStore({file,targetCount:25});
      assert.equal(store.read().standbyHistory.length,run+2);
    }
    assert.equal(counts.reduce((a,b)=>a+b,0)/5,25);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test("ten-refresh cutoff does not expire by age; suggestion and activity windows expire independently",()=>{
  const now=Date.now(),old=new Date(now-40*86400000).toISOString();
  const history=Array.from({length:10},(_,i)=>({timestamp:old,tracks:i===0?[track(1)]:[]}));
  assert.equal(new FreshPool({history,config,now}).eligible(track(1)),false);
  assert.equal(new FreshPool({history:[...history,{timestamp:old,tracks:[]}],config,now}).eligible(track(1)),true);
  const recent=[{timestamp:new Date(now-29*86400000).toISOString(),tracks:[track(2)]},...Array.from({length:10},()=>({timestamp:old,tracks:[]}))];
  assert.equal(new FreshPool({history:recent,config,now}).eligible(track(2)),false);
  for(const [index,kind] of ["played","queued","rated","suggested","playlist"].entries()) {
    const t=track(index+50),event={...t,kind,at:now-29*86400000};
    assert.equal(new FreshPool({events:[event],config,now}).eligible(t),false);
    assert.equal(new FreshPool({events:[{...event,at:now-31*86400000}],config,now}).eligible(t),true);
  }
});
test("identity bridges missing IDs and separately supplied versions without merging distinct remixes",()=>{
  const t=track(10,"Sealine & Stereo Underground","Flashes (D-Nox & Beckers Remix)");
  const same={artist:"Stereo Underground, Sealine",title:"Flashes",version:"D-Nox & Beckers Remix"};
  const different={...same,version:"Original Mix"};
  const p=new FreshPool({current:[t],config});
  assert.equal(p.eligible(same),false);
  assert.equal(p.eligible(different),true);
  assert.equal(p.eligible({...different,tidal:{id:"10"}}),false);
  const p2=new FreshPool({config});
  p2.add([t,{...same,score:85},track(11,t.artist,t.title),{...different,score:85}]);
  assert.equal(p2.pool.length,2);
  assert.equal(p2.diagnostics.duplicateIdsExcluded,2);
});
test("inventory exhaustion returns a short pool; preferred one and hard two tracks per artist",async()=>{
  const p=new FreshPool({current:offenders,config});
  const fresh=Array.from({length:19},(_,i)=>track(100+i));
  const out=await searchFreshPool({pool:p,passes:[{id:"one"},{id:"two"}],search:async()=>({tracks:[...offenders,...fresh]}),review:async tracks=>({tracks,review:{}})});
  assert.equal(out.tracks.length,19);assert.equal(out.novelty.carriedOver,0);assert.match(out.novelty.shortfallReason,/exhausted/);
  const artists=new FreshPool({target:4,config});
  artists.add([track(1,"A"),track(2,"A"),track(3,"A"),track(4,"B")]);
  assert.equal(artists.select().length,2);assert.equal(artists.select(true).length,3);
});
test("time budget prevents more searches and never refills from rejected tracks",async()=>{
  let now=0,calls=0;
  const p=new FreshPool({current:offenders,config});
  const out=await searchFreshPool({pool:p,budgetMs:10,clock:()=>now,passes:[{id:"a"},{id:"b"}],search:async()=>{calls++;now=11;return {tracks:offenders};},review:async tracks=>({tracks,review:{}})});
  assert.equal(calls,1);assert.equal(out.tracks.length,0);assert.equal(out.novelty.carriedOver,0);assert.match(out.novelty.shortfallReason,/time/);
});
test("queue and playlist events persist and history retains last ten even after 30 days",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rh-events-"));
  try {
    const file=path.join(dir,"events.json");const events=new FreshnessEvents(file);
    events.record("queued",[track(1)]);events.record("playlist",[track(2)]);
    const pool=new FreshPool({events:new FreshnessEvents(file).entries,config});
    assert.equal(pool.eligible(track(1)),false);assert.equal(pool.eligible(track(2)),false);
    const h=recordRefresh([{timestamp:"2020-01-01",tracks:[track(1)]}],[],new Date().toISOString());
    assert.equal(h.length,2);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("actual discovery engine rejects recent identities before selecting its result pool",async()=>{
  const {discoverTracks}=require("../src/discoveryEngine");
  const raw=Array.from({length:20},(_,i)=>({...track(900+i),id:String(900+i),year:2026,releaseDate:"2026-04-17",durationMs:468000,label:"Lost & Found",releaseEvidence:{albumDate:"2026-04-17",albumYear:2026}}));
  const pool=new FreshPool({current:raw.slice(0,10),target:3,config});
  let first=true;
  const result=await discoverTracks({tidal:{isConfigured:()=>true,getArtistAlbums:async()=>[],searchTracks:async query=>{if(!first)return [];first=false;return raw.map(t=>({...t,query}));}},options:{request:"Find 3 underground progressive house tracks from 2026",genres:"progressive house",mood:"underground",years:"2026",count:"3",standbyPool:"true",standbyAcceptCandidate:t=>pool.observe(t),llmSearchPlan:{searchQueries:["progressive house 2026"]}}});
  assert.equal(result.tracks.length,3);
  assert.equal(pool.diagnostics.recentStandbyExcluded,10);
  assert.ok(result.tracks.every(t=>Number(t.tidal.id)>=910));
});

test("observed Roon queue additions emit identities once, including existing queue on connection",()=>{
  const {RoonClient}=require("../src/roonClient");
  const events=[];let callback;
  const fake={transport:{subscribe_queue:(zone,limit,cb)=>{callback=cb;}},queueSubscriptions:new Set(),queues:new Map(),queueSignatures:new Map(),scheduleZonesEmit:()=>{},emit:(event,track)=>events.push(track)};
  RoonClient.prototype.subscribeQueue.call(fake,"z");
  const item={queue_item_id:1,one_line:{line1:"Voile - Avoure"},two_line:{line1:"Voile",line2:"Avoure"}};
  callback("Subscribed",{items:[item]});
  callback("Changed",{items:[item]});
  callback("Changed",{items:[item,{queue_item_id:2,title:"New Track",artist:"New Artist"}]});
  assert.deepEqual(events,[{artist:"Avoure",title:"Voile"},{artist:"New Artist",title:"New Track"}]);
});

test("version-aware fallback identity survives pool persistence without TIDAL IDs",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rh-versions-"));
  try {
    const file=path.join(dir,"standby.json");
    const store=new StandbyCandidateStore({file,targetCount:2});
    const tracks=[{artist:"Artist",title:"Signal",version:"Extended Mix",album:"Release A",score:85},{artist:"Artist",title:"Signal",version:"Club Remix",album:"Release B",score:85}];
    store.replace(tracks,{recordHistory:true});
    const restarted=new StandbyCandidateStore({file,targetCount:2});
    assert.equal(restarted.list().length,2);
    restarted.clear();
    const pool=new FreshPool({history:restarted.read().standbyHistory,config});
    assert.ok(tracks.every(t=>!pool.eligible(t)));
    assert.equal(pool.eligible({...tracks[0],version:"Acoustic Version"}),true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
