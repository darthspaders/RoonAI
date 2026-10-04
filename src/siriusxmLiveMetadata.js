"use strict";
// Endpoint identified in MizterB/aiosxm; parse the public payload independently.
const ENDPOINT='https://lookaround-cache-prod.streaming.siriusxm.com/playbackservices/v1/live/lookAround';
const current=(items,now,maxAge)=>Array.isArray(items)?items.filter(x=>x&&typeof x.name==='string'&&Number.isFinite(Date.parse(x.validFrom))&&Date.parse(x.validFrom)<=now&&now-Date.parse(x.validFrom)<=maxAge).sort((a,b)=>Date.parse(b.validFrom)-Date.parse(a.validFrom))[0]:undefined;
function artwork(image){const key=image?.url;if(typeof key!=='string'||!/^\/?(?:live|aem|if)\/[\w/.-]+$/.test(key))return null;return 'https://imgsrv-sxm-prod-device.streaming.siriusxm.com/'+Buffer.from(JSON.stringify({key:key.replace(/^\//,''),edits:[{format:{type:'jpeg'}},{resize:{width:600,height:600}}]})).toString('base64');}
class SiriusXmLiveMetadata {
 constructor({fetchImpl=fetch,clock=Date.now,ttl=30000}={}){Object.assign(this,{fetch:fetchImpl,clock,ttl});this.cached=null;this.pending=null;this.history=new Map();}
 async feed(){
  if(this.cached&&this.clock()-this.cached.at<this.ttl)return {...this.cached,cache:'hit'};
  if(this.pending)return this.pending;
  this.pending=(async()=>{let data=null,error=null;try{const r=await this.fetch(ENDPOINT,{headers:{accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});if(!r.ok)throw Error('HTTP '+r.status);data=await r.json();if(!data.channels||Array.isArray(data.channels)||typeof data.channels!=='object'||data.delta===true)throw Error('Invalid or partial live feed');}catch(e){data=null;error=e.message;}
   this.cached={data,error,at:this.clock()};return {...this.cached,cache:'miss'};
  })().finally(()=>this.pending=null);return this.pending;
 }
 async get(id,playbackTime){
  const f=await this.feed(),entry=f.data?.channels[id],now=this.clock();
  // A mix can last hours; its source timestamp must still fall within this bound.
  if(entry){
   const previous=this.history.get(id)||{};const merged={};
   for(const key of ['cuts','shows'])merged[key]=[...new Map([...(previous[key]||[]),...(entry[key]||[])].filter(x=>Number.isFinite(Date.parse(x.validFrom))&&now-Date.parse(x.validFrom)<24*3600000).map(x=>[x.validFrom,x])).values()].sort((a,b)=>Date.parse(a.validFrom)-Date.parse(b.validFrom)).slice(-100);
   this.history.set(id,merged);if(this.history.size>500)this.history.delete(this.history.keys().next().value);
  }
  const selectionTime=Number.isFinite(playbackTime)?playbackTime:now;
  const timeline=Number.isFinite(playbackTime)?this.history.get(id):entry;
  const cut=!f.error&&entry?current(timeline?.cuts,selectionTime,6*3600000):undefined,show=!f.error&&entry?current(timeline?.shows,selectionTime,24*3600000):undefined;
  return {cut,show,artwork:artwork(cut?.image),diagnostics:{endpoint:ENDPOINT,channelEntityId:id,cache:f.cache,fetchedAt:new Date(f.at).toISOString(),trackStart:cut?.validFrom||null,showStart:show?.validFrom||null,fallbackReason:f.error||(!entry?'Channel absent from live feed':!cut?'No current timestamped cut':null)}};
 }
}
module.exports={SiriusXmLiveMetadata,current,ENDPOINT};
