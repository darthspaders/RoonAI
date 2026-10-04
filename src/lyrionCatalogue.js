"use strict";
// Radio display enrichment only; never relax Roon or catalogue queue matching.
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const names=s=>String(s||'').split(/[,/;&+|]+|\s+(?:and|feat\.?|featuring)\s+/i).map(norm).filter(Boolean);
function identity(t){
 const artists=Array.isArray(t.artists)&&t.artists.length?t.artists.map(a=>norm(a.name||a)):names(t.artist);
 const versions=[];let title=String(t.title||'').replace(/[([]([^\])]+)[)\]]/g,(all,part)=>{
  if(/\b(remix|mix|edit|dub|version|rework|instrumental|live)\b/i.test(part)){versions.push(norm(part));return '';}
  return all;
 });
 if(t.version)versions.push(norm(t.version));
 // Only remove a title's credit suffix when every name is an actual credited artist.
 const credit=title.match(/\s+(?:with|feat\.?|featuring)\s+(.+)$/i);
 if(credit&&names(credit[1]).length&&names(credit[1]).every(n=>artists.includes(n)))title=title.slice(0,credit.index);
 return {title:norm(title),artists,version:[...new Set(versions)].sort().join('|')};
}
function matchesRadioTrack(wanted,result){
 const a=identity(wanted),b=identity(result);
 return !!a.title&&a.title===b.title&&a.version===b.version&&a.artists.some(n=>b.artists.includes(n));
}
class LyrionCatalogue {
 constructor({tidal,clock=Date.now,logger=console}={}){Object.assign(this,{tidal,clock,logger});this.cache=new Map();this.pending=new Map();this.observed=new Map();}
 key(t){return JSON.stringify([t?.title||'',t?.artist||'']);}
 async lookup(t){
  if(!t?.title||!t?.artist||!this.tidal?.isConfigured())return null;
  const key=this.key(t),cached=this.cache.get(key);
  if(cached&&this.clock()-cached.at<(cached.value?86400000:120000))return cached.value;
  if(this.pending.has(key))return this.pending.get(key);
  const task=this.search(t).then(value=>{this.cache.set(key,{at:this.clock(),value});if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value);return value;}).catch(e=>{this.logger.warn?.('[Lyrion catalogue] '+e.message);this.cache.set(key,{at:this.clock(),value:null});return null;}).finally(()=>this.pending.delete(key));
  this.pending.set(key,task);return task;
 }
 async search(t){
  const wanted=identity(t),primary=String(t.artist).split(/[,/;&+|]+/)[0].trim();
  // Search terms may omit generic version words; acceptance still compares the
  // full version above. TIDAL can bury exact hits when "remix" dominates a query.
  const remixer=wanted.version.replace(/\b(remix|mix|edit|dub|version|rework|instrumental|live)\b/g,' ').replace(/\|/g,' ').trim();
  const queries=[...new Set([`${primary} ${wanted.title} ${remixer}`.trim(),`${primary} ${t.title}`])];
  for(const query of queries){
   const rows=await this.tidal.searchTracks(query,{limit:12,detailLimit:0});
   const accepted=rows.filter(r=>matchesRadioTrack(t,r));
   const recordings=new Set(accepted.map(r=>r.isrc||r.id));
   if(recordings.size!==1)continue;
   const detail=await this.tidal.getTrack(accepted[0].id);
   if(!detail||!matchesRadioTrack(t,detail))continue;
   const title=detail.version&&!norm(detail.title).includes(norm(detail.version))?`${detail.title} (${detail.version})`:detail.title;
   return {id:String(detail.id),title,artist:detail.artist,isrc:detail.isrc||'',imageUrl:detail.imageUrl||'',tidalUrl:detail.tidalUrl||`https://tidal.com/browse/track/${detail.id}`,source:'tidal',matchMethod:'exact-title-version-and-credited-artists'};
  }
  return null;
 }
 enrich(state){
  const view=state.displayPlaybackState||state,t=view.nowPlaying;if(!t?.title||!t?.artist||!/^SiriusXM/i.test(t.source||''))return state;
  const player=state.playerId||'default',key=this.key(t),seen=this.observed.get(player);
  if(!seen||seen.key!==key){this.observed.set(player,{key,at:this.clock()});if(this.observed.size>100)this.observed.delete(this.observed.keys().next().value);}
  else if(view.state==='playing'&&this.clock()-seen.at>=5000)void this.lookup(t);
  const cached=this.cache.get(key);const match=cached&&this.clock()-cached.at<86400000?cached.value:null;
  if(!match)return state;
  return {...state,displayPlaybackState:{...view,nowPlaying:{...t,catalogue:{tidal:match},artwork:match.imageUrl||t.artwork}}};
 }
}
module.exports={LyrionCatalogue,matchesRadioTrack};
