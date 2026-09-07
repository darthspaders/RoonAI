'use strict';
const {randomUUID}=require('node:crypto');
const DAY=86400000;
const norm=v=>String(v||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function trackId(t){return String(t.tidal?.id||t.tidalTrackId||t.id||`${norm(t.artist)}|${norm(t.title)}`);}
function recentHistory(history=[],now=Date.now()){return history.filter(h=>now-Date.parse(h.timestamp)<14*DAY).slice(-6);}
function repeatsAllowed(options={}){return options.allowRepeats===true||options.allowRepeats==='true'||/\b(?:similar|repeat)\s+results\b/i.test(String(options.request||''))&&!/\b(?:no|avoid|without|do not)\s+(?:similar|repeat)/i.test(String(options.request||''));}
function prepareNovelty(tracks,history,options={},now=Date.now()){
 const recent=recentHistory(history,now);const allow=repeatsAllowed(options);
 return tracks.map(t=>{
  const id=trackId(t);const appearances=[];let top=false;
  recent.slice().reverse().forEach((run,i)=>{const entry=run.tracks.find(r=>r.trackId===id);if(entry){appearances.push(i+1);if(i<3&&entry.rank===1)top=true;}});
  const distance=appearances[0]||0;const penalty=allow?0:distance?(distance===1?45:distance<=3?30:15)+Math.min(15,(appearances.length-1)*3):0;
  const copy={...t};delete copy.standbySynapseRank;delete copy.standbyFinalRank;
  return {...copy,standbyNovelty:{recentAppearances:appearances.length,lastSeenRefreshesAgo:distance,penalty,topSlotCooldown:!allow&&top,effectiveScore:(Number(t.score)||0)-penalty}};
 }).sort((a,b)=>b.standbyNovelty.effectiveScore-a.standbyNovelty.effectiveScore);
}
function finalizeNovelty(tracks,history,options={},now=Date.now()){
 const reviewedOrder=new Map(tracks.map((t,i)=>[trackId(t),i]));
 let ranked=prepareNovelty(tracks,history,options,now);
 // A model may refine taste/diversity within the shortlist, but cannot undo heavy cooldowns.
 const reviewed=tracks.some(t=>t.standbySynapseRank);
 ranked.sort((a,b)=>(b.standbyNovelty.effectiveScore+(reviewed?12*(1-reviewedOrder.get(trackId(b))/Math.max(1,tracks.length)):0))-(a.standbyNovelty.effectiveScore+(reviewed?12*(1-reviewedOrder.get(trackId(a))/Math.max(1,tracks.length)):0)));
 const blocked=ranked.filter(t=>t.standbyNovelty.topSlotCooldown);
 const alternatives=ranked.filter(t=>!t.standbyNovelty.topSlotCooldown);
 let topSlotCooldownApplied=[];let exception='';
 if(blocked.length&&alternatives.length>=2){
  if(ranked[0]?.standbyNovelty.topSlotCooldown){const first=alternatives[0];ranked=[first,...ranked.filter(t=>t!==first)];}
  topSlotCooldownApplied=blocked.map(t=>({trackId:trackId(t),version:t.version||t.tidal?.version||"",artist:t.artist,title:t.title}));
 }else if(blocked.length)exception='Fewer than two valid candidates outside the recent top-slot cooldown.';
 const runId=randomUUID();ranked=ranked.map((t,rank)=>({...t,standbyFinalRank:{runId,rank}}));
 const penalties=ranked.filter(t=>t.standbyNovelty.penalty).map(t=>({trackId:trackId(t),tidalTrackId:t.tidal?.id||t.tidalTrackId||t.tidalId||"",version:t.version||t.tidal?.version||"",artist:t.artist,title:t.title,...t.standbyNovelty}));
 return {tracks:ranked,diagnostics:{repeatedTracksSuppressed:penalties.length,noveltyPenalties:penalties,carriedOver:ranked.filter(t=>t.standbyNovelty.recentAppearances).map(t=>({trackId:trackId(t),artist:t.artist,title:t.title})),newTracksIntroduced:ranked.filter(t=>!t.standbyNovelty.recentAppearances).length,total:ranked.length,topSlotCooldownApplied,topSlotException:exception,repeatOverride:repeatsAllowed(options)}};
}
function recordRefresh(history,tracks,timestamp=new Date().toISOString()){
 const recent=recentHistory(history,Date.parse(timestamp));
 const entry={timestamp,tracks:tracks.map((t,i)=>({trackId:trackId(t),tidalTrackId:t.tidal?.id||t.tidalTrackId||t.tidalId||"",version:t.version||t.tidal?.version||"",artist:t.artist||'',title:t.title||'',rank:i+1,score:Number(t.score)||0,recentAppearances:1+recent.filter(h=>h.tracks.some(r=>r.trackId===trackId(t))).length}))};
 // Retain at least the last 100 refreshes regardless of age, plus the configured suggestion window.
 const retentionDays=Math.max(30,Number(process.env.STANDBY_SUGGESTED_COOLDOWN_DAYS)||30);
 const all=[...history,entry];return all.filter((h,i)=>i>=all.length-100||Date.parse(timestamp)-Date.parse(h.timestamp)<retentionDays*DAY);
}
module.exports={trackId,recentHistory,prepareNovelty,finalizeNovelty,recordRefresh,repeatsAllowed};
