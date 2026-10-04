"use strict";
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// Match the live cut history window. A delayed stream is still usable when its
// channel-specific timestamp advances; file freshness alone cannot prove that.
const MAX_TIMESHIFT_MS=6*60*60*1000,STALE_MS=60000;
const observations=new Map();
function channelId(url){
 if(/^(?:sxm|siriusxm):[\w-]+$/i.test(url||''))return url.split(':')[1];
 try{const u=new URL(url);if(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&u.port==='9999')return u.pathname.match(/^\/([\w-]+)\.m3u8$/)?.[1]||null;}catch{}
 return null;
}
function playbackClock(id,{now=Date.now(),directory=path.join(os.tmpdir(),'siriusxm'),bufferMs=20000}={}){
 if(!/^[\w-]+$/.test(id||''))return {reason:'Unknown SiriusXM channel'};
 try{
  const file=path.resolve(directory,'pdt_'+id+'.txt'),stat=fs.statSync(file),segment=Date.parse(fs.readFileSync(file,'utf8').trim());
  if(now-stat.mtimeMs>STALE_MS||stat.mtimeMs>now+5000||!Number.isFinite(segment)||segment>now||now-segment>MAX_TIMESHIFT_MS)return {reason:'Stream timestamp unavailable or stale'};
  const previous=observations.get(file);
  if(previous&&now>=previous.observedAt&&segment<previous.segment){
   return {reason:'Stream timestamp regressed'};
  }
  if(!previous||segment>previous.segment||now<previous.observedAt){
   observations.delete(file);
   observations.set(file,{segment,observedAt:now});
   if(observations.size>200)observations.delete(observations.keys().next().value);
  }else if(now-previous.observedAt>=STALE_MS){
   return {reason:'Stream timestamp stopped advancing'};
  }
  // This is a delivery timestamp, not an HQPlayer audio clock. Match the
  // plugin's two-segment buffer estimate; never extrapolate a stalled stream.
  return {time:segment-bufferMs,segmentTime:segment,bufferMs,lagMs:now-segment+bufferMs,source:'segment-pdt-estimate'};
 }catch{return {reason:'Stream timestamp unavailable'};}
}
module.exports={channelId,playbackClock};
