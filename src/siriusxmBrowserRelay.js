"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
class SiriusXmBrowserRelay {
 constructor({file=path.join(__dirname,'../data/siriusxm-browser-key'),clock=Date.now,ttl=90000}={}){
  this.clock=clock;this.ttl=ttl;this.channels=new Map();
  if(file&&fs.existsSync(file))this.key=fs.readFileSync(file,'utf8').trim();
  else{this.key=crypto.randomBytes(32).toString('hex');if(file){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,this.key,{mode:0o600});}}
 }
 authorized(value){const a=Buffer.from(String(value||'')),b=Buffer.from('Bearer '+this.key);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
 ingest(body){
  const u=new URL(body.url);if(u.origin!=='https://www.siriusxm.com'||!/^\/player\/channel-linear\/[^/]+\/[a-f0-9-]{36}$/.test(u.pathname))throw Error('A SiriusXM linear channel page is required.');
  const number=Number(body.channelNumber);if(!Number.isInteger(number)||number<1||number>9999)throw Error('Invalid channel number.');
  const label=String(body.label||'').trim(),show=String(body.show||'').trim();
  if(!label||label.length>600||show.length>300)throw Error('Missing or oversized visible metadata.');
  const observedAt=Number(body.observedAt);if(!Number.isFinite(observedAt)||Math.abs(this.clock()-observedAt)>this.ttl)throw Error('Stale browser reading.');
  this.channels.set(number,{label,show,url:u.origin+u.pathname,observedAt,receivedAt:this.clock()});
  if(this.channels.size>100)this.channels.delete(this.channels.keys().next().value);
  return {accepted:true,channelNumber:number};
 }
 get(number){const item=this.channels.get(Number(number));return item&&this.clock()-item.observedAt<this.ttl?{...item}:null;}
 status(){return {channels:[...this.channels.keys()].map(channelNumber=>({channelNumber,fresh:!!this.get(channelNumber),receivedAt:new Date(this.channels.get(channelNumber).receivedAt).toISOString()}))};}
}
module.exports={SiriusXmBrowserRelay};
