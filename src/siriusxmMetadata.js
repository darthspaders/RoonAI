"use strict";
const ORIGIN="https://www.siriusxm.com";
const ENTITIES={'9472':'4ebc3011-0ebe-a9ad-c58b-9a306f60fc2b',thebeat:'6adef1b5-d812-9c10-7c6c-f05af4e27077',chill:'834383dd-9a7e-d59e-81a2-dd13e0377af2',big80s:'2ea07147-a720-ed0c-d4ce-d7bddd1640d3'};
const KNOWN=[{id:"9472",number:53,name:"Diplo's Revolution",slug:"diplos-revolution"},{id:"thebeat",number:52,name:"BPM",slug:"bpm"},{id:"chill",number:55,name:"SiriusXM Chill",slug:"siriusxm-chill"},{id:"big80s",number:8,name:"80s on 8",slug:"80s-on-8"}];
const norm=s=>String(s||"").normalize("NFKC").replace(/[’‘]/g,"'").trim().replace(/\s+/g," ").toLowerCase();
const artistIdentity=s=>String(s||'').split(/[,/]+/).map(norm).filter(Boolean).sort().join('|');
function channelPlaceholder(track,channel){
 const compact=s=>norm(s).replace(/[^a-z0-9]/g,'');const name=compact(channel);
 return !!name&&[track?.title,`${track?.artist||''} ${track?.title||''}`,`${track?.title||''} ${track?.artist||''}`].some(s=>compact(s)===name);
}
function epgTime(s){const m=String(s||"").match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}) (UTC|EDT|EST)$/);if(!m)return NaN;return Date.UTC(+m[3],+m[1]-1,+m[2],+m[4]+({UTC:0,EDT:4,EST:5}[m[6]]),+m[5]);}
const iso=n=>Number.isFinite(n)?new Date(n).toISOString():null;
function episode(e){const start=epgTime(e.sc?.sTimeStrUTC || e.sc?.sTimeStr),end=epgTime(e.sc?.eTimeStr);return {name:e.pr?.pName||"",description:e.pr?.longDesc||e.pr?.shortDesc||"",start:iso(start),end:iso(Number.isFinite(end)?end:start+Number(e.sc?.duration)),artwork:e.pr?.lrgLogo||e.pr?.logo||"",programId:e.pgid};}
function normalize(channel,guide,now){
 const episodes=[...(guide?.chEpgInfo?.nowplaying?.episode||[]),...(guide?.chEpgInfo?.dayChSchedules||[]).flatMap(d=>d.episode||[])].filter(e=>String(e.channelKey)===String(channel.channel_id)).map(episode).filter(e=>e.start&&e.end&&e.end>e.start);
 const schedule=[...new Map(episodes.map(e=>[e.programId+e.start,e])).values()].sort((a,b)=>a.start.localeCompare(b.start));
 let current=schedule.find(e=>Date.parse(e.start)<=now&&Date.parse(e.end)>now);
 const live=channel.episode||{},start=Number(live.starttime),end=start+Number(live.duration)*1000;
 if(!current&&start<=now&&end>now)current={name:live.longTitle,description:"",start:iso(start),end:iso(end),artwork:""};
 const next=schedule.find(e=>Date.parse(e.start)>now);
 const content=channel.content||{},trackStart=Number(content.starttime),hasTrack=!!content.title&&trackStart<=now&&now-trackStart<30*60000;
 return {channelNumber:Number(channel.siriuschannelnumber||channel.xmchannelnumber)||null,channelName:channel.displayname||"",channelId:channel.channel_id,channelSlug:String(channel.pageurl||channel.vanityURL||"").split("/").pop(),currentShow:current?.name||null,currentShowDescription:current?.description||null,currentTrack:hasTrack?content.title:null,currentArtist:hasTrack?(content.artists||[]).map(a=>a.name).filter(Boolean).join(", ")||null:null,showStart:current?.start||null,showEnd:current?.end||null,nextShow:next?.name||null,nextShowStart:next?.start||null,artwork:current?.artwork||channel.colorlogo||null,channelArtwork:channel.colorlogo||null,showArtwork:current?.artwork||null,trackArtwork:hasTrack?content.album?.art||null:null,schedule,source:"siriusxm"};
}
class SiriusXmMetadata {
 constructor({fetchImpl=fetch,clock=Date.now,logger=console,favorites=()=>[],ttl=45000,liveMetadata=null,readPlaybackClock=require('./siriusxmPlaybackClock').playbackClock}={}){Object.assign(this,{fetch:fetchImpl,clock,logger,favorites,ttl,liveMetadata,readPlaybackClock});this.cache=new Map();this.pending=new Map();this.playbackMetadata=new Map();}
 match(input){
  const q=typeof input==="object"?input:{channel:input};const value=String(q.channel||"");
  const catalog=[...KNOWN];for(const f of this.favorites()){const m=f.title?.match(/^(.*?)\s*\((\d+)\)$/);if(m&&/^sxm:[\w-]+$/.test(f.url)&&!catalog.some(c=>c.id===f.url.slice(4)))catalog.push({id:f.url.slice(4),number:+m[2],name:m[1]});}
  const number=Number(q.channelNumber||(/^\d+$/.test(value)&&catalog.some(c=>c.number===+value)?value:0));
  let found=number?catalog.find(c=>c.number===number):null;if(number&&!found)throw Error("Unknown channel number; save the channel as a Lyrion favorite first.");if(found)return {...found,method:"channel-number"};
  const id=String(q.channelId||require('./siriusxmPlaybackClock').channelId(q.url)||value);found=catalog.find(c=>c.id===id||c.slug===id);if(found)return {...found,method:"canonical-id"};
  const names=[q.channelName,q.album,q.artist,value].filter(Boolean);found=catalog.find(c=>names.some(name=>norm(c.name)===norm(name)));if(found)return {...found,method:"exact-name"};
  if(require('./siriusxmPlaybackClock').channelId(q.url))return {id:require('./siriusxmPlaybackClock').channelId(q.url),method:"canonical-id"};
  throw Error("No exact SiriusXM channel match.");
 }
 async json(url){for(let attempt=0;attempt<2;attempt++){try{const r=await this.fetch(url,{signal:AbortSignal.timeout(5000),headers:{accept:"application/json"},redirect:"error"});if(!r.ok)throw Error("HTTP "+r.status);return await r.json();}catch(e){if(attempt===0&&e.cause?.code==="EAI_AGAIN"){await new Promise(resolve=>setTimeout(resolve,250));continue;}throw Error(e.message+(e.cause?.code?" ("+e.cause.code+")":""));}}}
 async getChannelMetadata(input,{playbackTime}={}){
  const result=await this.getPublicChannelMetadata(input);let match;
  try{match=this.match(input);}catch{return result;}
  const entityId=result.metadata?.channelEntityId||ENTITIES[match.id];
  if(this.liveMetadata&&entityId){
   const live=await this.liveMetadata.get(entityId,playbackTime),m={...(result.metadata||{channelNumber:match.number,channelName:match.name,channelId:match.id,source:'siriusxm'})};
   if(live.cut){m.currentTrack=live.cut.name;m.currentArtist=live.cut.artistName||null;m.trackStart=live.cut.validFrom;m.isAd=!!live.cut.isAd;m.trackArtwork=live.artwork;m.liveMetadataSource='siriusxm-lookaround';}
   if(live.show){if(m.currentShow!==live.show.name){m.scheduledShow=m.currentShow;m.currentShowDescription=null;m.showStart=null;m.showEnd=null;m.showArtwork=null;m.artwork=m.channelArtwork||null;}m.currentShow=live.show.name;}
   return {metadata:live.cut||live.show||result.metadata?m:null,diagnostics:{...result.diagnostics,live:live.diagnostics}};
  }
  const live=this.browserRelay?.get(match.number);if(!live)return result;
  return {metadata:{...(result.metadata||{channelNumber:match.number,channelName:match.name,channelId:match.id,source:'siriusxm'}),liveNowTitle:live.label,liveNowShow:live.show,liveMetadataSource:'siriusxm-browser',liveObservedAt:new Date(live.observedAt).toISOString()},diagnostics:{...result.diagnostics,browser:{url:live.url,observedAt:new Date(live.observedAt).toISOString(),ageMs:this.clock()-live.observedAt}}};
 }
 async getPublicChannelMetadata(input){
  let match;try{match=this.match(input);}catch(e){const diagnostics={detectedChannel:typeof input==="object"?input.url||input.channelName||input.album||null:String(input),matchMethod:null,endpoints:[],cache:"miss",fetchedAt:new Date(this.clock()).toISOString(),populatedFields:[],fallbackReason:e.message};this.logger.warn?.("[SiriusXM metadata] "+JSON.stringify(diagnostics));return {metadata:null,diagnostics};}
  const cached=this.cache.get(match.id);if(cached&&this.clock()-cached.at<this.ttl)return {...cached.result,diagnostics:{...cached.result.diagnostics,matchMethod:match.method,cache:"hit"}};
  if(this.pending.has(match.id))return this.pending.get(match.id);
  const work=this.load(match).finally(()=>this.pending.delete(match.id));this.pending.set(match.id,work);return work;
 }
 async load(match){
  const liveUrl=ORIGIN+"/api/mountain/"+encodeURIComponent(match.id),scheduleUrl=ORIGIN+"/sxmepg/epg.sxmchepginfo.xmc?channelKeys="+encodeURIComponent(match.id)+"&distribution=XMDCOM&tzone=Eastern";
  const diagnostics={detectedChannel:match.id,matchMethod:match.method,endpoints:[liveUrl,scheduleUrl],cache:"miss",fetchedAt:new Date(this.clock()).toISOString(),populatedFields:[],fallbackReason:null};let metadata=null;
  const [live,guide]=await Promise.allSettled([this.json(liveUrl),this.json(scheduleUrl)]);
  try{if(live.status!=="fulfilled")throw live.reason;const c=live.value.channels?.[match.id];if(!c||String(c.channel_id)!==match.id)throw Error("Channel identity absent or mismatched.");if(match.number&&Number(c.siriuschannelnumber)!==match.number)throw Error("Channel number changed; refusing mismatched metadata.");
   metadata=normalize(c,guide.status==="fulfilled"?guide.value:null,this.clock());metadata.channelEntityId=c.uuid||null;diagnostics.populatedFields=Object.keys(metadata).filter(k=>metadata[k]&&(k!=="schedule"||metadata.schedule.length));
   if(guide.status!=="fulfilled")diagnostics.fallbackReason="Program guide unavailable: "+guide.reason.message;
   if(!metadata.currentTrack||!metadata.currentArtist)diagnostics.fallbackReason=[diagnostics.fallbackReason,"Public song metadata incomplete; retain Lyrion track and artist."].filter(Boolean).join(" ");
  }catch(e){diagnostics.fallbackReason=e.message;}
  const result={metadata,diagnostics};this.cache.set(match.id,{at:this.clock(),result});if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value);
  this.logger.info?.("[SiriusXM metadata] "+JSON.stringify(diagnostics));return result;
 }
 async overlay(rawPlaybackState){
  const player=rawPlaybackState.playerId||'default';
  if(rawPlaybackState.nowPlaying?.source!=="SiriusXM"){this.playbackMetadata.delete(player);return {...rawPlaybackState,displayPlaybackState:rawPlaybackState,siriusxmMetadata:null};}
  let id;try{id=this.match(rawPlaybackState.nowPlaying).id;}catch{}
  const timing=this.readPlaybackClock(id,{now:this.clock()});
  const result=await this.getChannelMetadata(rawPlaybackState.nowPlaying,{playbackTime:timing.time}),m=result.metadata;
  let previous=this.playbackMetadata.get(player);
  const channelName=m?.channelName||rawPlaybackState.nowPlaying.album;
  if(previous&&channelPlaceholder(previous.track,channelName)){this.playbackMetadata.delete(player);previous=null;}
  if(previous&&(previous.id!==id||this.clock()-previous.at>120000||rawPlaybackState.state==='stopped')){this.playbackMetadata.delete(player);previous=null;}
  const t={...rawPlaybackState.nowPlaying};
  const start=Date.parse(m?.trackStart);
  const placeholder=channelPlaceholder({title:m?.currentTrack,artist:m?.currentArtist},channelName);
  const eligible=!placeholder&&rawPlaybackState.state==='playing'&&Number.isFinite(timing.time)&&m?.liveMetadataSource==='siriusxm-lookaround'&&m.currentTrack&&start<=timing.time;
  let decision=timing.reason||'Retaining Lyrion metadata; no aligned cut';
  if(eligible&&(!previous||start>=previous.start)){
   const sameTrack=norm(t.title)===norm(m.currentTrack)&&artistIdentity(t.artist)===artistIdentity(m.currentArtist);
   // Raw LMS artwork can belong to a different buffered cut. Never attach it
   // to the overlay's title unless the complete title/artist pair agrees.
   t.artwork=m.trackArtwork||(sameTrack?t.artwork:'')||'';
   t.title=m.currentTrack;t.artist=m.currentArtist||'';
   this.playbackMetadata.set(player,{id,start,at:this.clock(),track:{title:t.title,artist:t.artist,artwork:t.artwork}});decision='Aligned with stream timestamp';
  }else if(!placeholder&&previous&&this.clock()-previous.at<=60000&&rawPlaybackState.state!=='stopped'){
   Object.assign(t,previous.track);decision=eligible?'Rejected older track timestamp':'Holding last aligned cut briefly';
  }
  if(placeholder){this.playbackMetadata.delete(player);decision='Rejected channel-name placeholder; using Lyrion song and artwork';}
  // Channel branding is a display fallback, never evidence for a track match.
  // Keep it separate from scheduled show art, which may be ahead of playback.
  let channelArtwork=m?.channelArtwork||'';
  if(!channelArtwork&&id){try{channelArtwork=this.favorites().find(f=>require('./siriusxmPlaybackClock').channelId(f.url)===id)?.artwork||'';}catch{}}
  t.artworkFallback=channelArtwork;
  if(!t.artwork)t.artwork=channelArtwork;
  if(this.playbackMetadata.size>100)this.playbackMetadata.delete(this.playbackMetadata.keys().next().value);
  result.diagnostics={...result.diagnostics,playback:{...timing,decision}};
  return {...rawPlaybackState,siriusxmMetadata:m,siriusxmDiagnostics:result.diagnostics,displayPlaybackState:{...rawPlaybackState,nowPlaying:t}};
 }
}
module.exports={SiriusXmMetadata,normalize,epgTime};
