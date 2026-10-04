"use strict";
(() => {
 const stage=document.getElementById('lyrionNow');if(!stage)return;
 const rail=document.createElement('aside');rail.id='lyrionDiscoveryRail';rail.className='lyrionRail';rail.setAttribute('aria-label','Track details and playlists');
 rail.innerHTML=`<section><h3>Beatport metadata</h3><p id="lyrionBeatportStatus" class="muted" role="status">Play a track to find its details.</p><dl id="lyrionBeatportFields"></dl><a id="lyrionBeatportLink" target="_blank" rel="noopener noreferrer" hidden>View on Beatport</a><button id="lyrionBeatportRetry" type="button" hidden>Retry lookup</button></section>
 <section class="lyrionPlaylistSection"><h3>Add to playlist</h3><p class="muted lyrionPlaylistHint">Save this track to TIDAL.</p><div id="lyrionPlaylistTargets"></div><button id="lyrionAddPlaylist" type="button" disabled>Add to TIDAL</button><button id="lyrionRefreshPlaylists" type="button">Refresh playlists</button><form id="lyrionCreatePlaylist"><label for="lyrionPlaylistName">New TIDAL playlist</label><input id="lyrionPlaylistName" required maxlength="200" placeholder="Playlist name"><button type="submit">Create playlist</button></form><p id="lyrionPlaylistStatus" role="status" aria-live="polite"></p></section>`;
 stage.querySelector('.lyrionStageFooter').before(rail);
 const $=id=>document.getElementById(id);let track=null,key='',lookupKey='',version=0,playlists=[],loaded=false,loading=false,writing=false;
 let metadataTimer=null,metadataAttempts=0,metadataBusy=false;
 function cancelMetadata(){clearTimeout(metadataTimer);metadataTimer=null;version++;metadataBusy=false;}
 function scheduleMetadata(delay=5000){
  if(metadataTimer!==null||metadataBusy||lookupKey===key||!track?.title||!track?.artist||!stage.classList.contains('lyrionNow--fullscreen'))return;
  if(!metadataAttempts)$('lyrionBeatportStatus').textContent='Waiting for track information to settle…';
  metadataTimer=setTimeout(()=>{metadataTimer=null;void metadata();},delay);
 }
 function retryMetadata(message){
  $('lyrionBeatportRetry').hidden=false;
  if(metadataAttempts<4){lookupKey='';const delay=metadataAttempts===1?65000:120000;$('lyrionBeatportStatus').textContent=message+' Will check again automatically.';scheduleMetadata(delay);}
  else $('lyrionBeatportStatus').textContent=message;
 }
 let saved=[];try{saved=JSON.parse(localStorage.getItem('lyrion.playlistTargets')||'[]');}catch{}if(!Array.isArray(saved))saved=[];
 const targets=Array.from({length:3},(_,i)=>{
  const row=document.createElement('div');row.className='lyrionPlaylistTarget';const arm=document.createElement('input');arm.type='checkbox';arm.setAttribute('aria-label',`Use TIDAL playlist ${i+1}`);arm.checked=!!saved[i]?.armed;
  const select=document.createElement('select');select.setAttribute('aria-label',`TIDAL playlist ${i+1}`);select.append(new Option('Choose a playlist',''));
  row.append(arm,select);$('lyrionPlaylistTargets').append(row);
  arm.onchange=select.onchange=()=>{persist();buttons();};return {arm,select,id:saved[i]?.id||''};
 });
 function persist(){try{localStorage.setItem('lyrion.playlistTargets',JSON.stringify(targets.map(t=>({id:t.select.value,armed:t.arm.checked}))));}catch{}}
 function buttons(){ $('lyrionAddPlaylist').disabled=writing||!track?.title||!track?.artist||!targets.some(t=>t.arm.checked&&t.select.value);rail.querySelector('.lyrionPlaylistSection').querySelectorAll('select,input,#lyrionCreatePlaylist button').forEach(e=>e.disabled=writing);$('lyrionRefreshPlaylists').disabled=loading||writing;}
 async function request(url,body){const options=body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{};if(url==='/api/lyrion/track-metadata')options.signal=AbortSignal.timeout(25000);const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed.');return data;}
 async function loadPlaylists(force=false){
  if(loading||loaded&&!force)return;loading=true;buttons();$('lyrionPlaylistStatus').textContent='Loading TIDAL playlists…';
  try{const data=await request('/api/tidal/playlists'+(force?'?refresh=1':''));if(data.connected===false)throw Error(data.error||'Connect TIDAL profile access first.');playlists=data.playlists||[];
   for(const t of targets){const id=t.select.value||t.id;t.select.replaceChildren(new Option('Choose a playlist',''),...playlists.map(p=>new Option(p.title||p.name||'Untitled',String(p.id))));t.select.value=id;t.id='';}
   loaded=true;$('lyrionPlaylistStatus').textContent=playlists.length?'':'No TIDAL playlists yet. Create one below.';
  }catch(e){$('lyrionPlaylistStatus').textContent=e.message;}finally{loading=false;buttons();}
 }
 function inputTrack(t){
  const result={title:t.title,artist:t.artist};
  if(t.catalogue?.tidal?.id){result.tidal={...t.catalogue.tidal};return result;}
  // Lyrion row IDs belong to LMS, not TIDAL. Only preserve explicit TIDAL URLs.
  const url=String(t.url||'');const id=url.match(/^tidal:\/\/(?:track\/)?(\d+)(?:\.|[/?]|$)/i)?.[1]||url.match(/^https:\/\/(?:listen\.|www\.)?tidal\.com\/(?:browse\/)?track\/(\d+)(?:[/?]|$)/i)?.[1];
  if(id)result.tidal={id,tidalUrl:'https://tidal.com/browse/track/'+id};return result;
 }
 async function metadata(force=false){
  if(!stage.classList.contains('lyrionNow--fullscreen')||!track?.title||!track?.artist)return;
  if(metadataBusy||(!force&&lookupKey===key))return;clearTimeout(metadataTimer);metadataTimer=null;lookupKey=key;metadataBusy=true;metadataAttempts++;const currentVersion=++version,captured={...track};
  $('lyrionBeatportFields').replaceChildren();$('lyrionBeatportLink').hidden=true;$('lyrionBeatportRetry').hidden=true;$('lyrionBeatportStatus').textContent='Looking up this track…';
  try{const result=await request('/api/lyrion/track-metadata',{track:inputTrack(captured)});if(currentVersion!==version)return;
   metadataBusy=false;const m=result.metadata;if(!m){retryMetadata(result.reason||'No Beatport match available.');return;}
   const fields=[['Label',m.label],['Genre',[m.genre,m.subGenre].filter(Boolean).join(' · ')],['BPM',m.bpm],['Key',[m.keyName,m.camelot].filter(Boolean).join(' · ')],['Released',m.releaseDate],['Track length',m.durationMs?`${Math.floor(m.durationMs/60000)}:${String(Math.floor(m.durationMs/1000)%60).padStart(2,'0')}`:null],['Track ID',m.id],['Release ID',m.releaseId]];
   for(const [label,value] of fields){if(value===null||value===undefined||value==='')continue;const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;$('lyrionBeatportFields').append(dt,dd);}
   $('lyrionBeatportStatus').textContent='';const link=/^https:\/\/(?:www\.)?beatport\.com\//.test(m.url||'')?m.url:/^\d+$/.test(String(m.id||''))?'https://www.beatport.com/track/-/'+m.id:'';if(link){$('lyrionBeatportLink').href=link;$('lyrionBeatportLink').hidden=false;}
  }catch(e){if(currentVersion===version){metadataBusy=false;retryMetadata('Details unavailable. '+e.message);}}
 }
 stage.addEventListener('lyrion-track',event=>{
  track=event.detail;const next=JSON.stringify([track?.url,track?.title,track?.artist,track?.catalogue?.tidal?.id||'']);
  if(next!==key){cancelMetadata();key=next;lookupKey='';metadataAttempts=0;$('lyrionBeatportFields').replaceChildren();$('lyrionBeatportLink').hidden=true;$('lyrionBeatportRetry').hidden=true;$('lyrionBeatportStatus').textContent=track?.artist?'Enter fullscreen to view track details.':'Track title and artist are needed for a lookup.';}
  buttons();scheduleMetadata();
 });
 new MutationObserver(()=>{if(stage.classList.contains('lyrionNow--fullscreen')){void loadPlaylists();scheduleMetadata();}else{if(metadataBusy)lookupKey='';cancelMetadata();}}).observe(stage,{attributes:true,attributeFilter:['class']});
 $('lyrionBeatportRetry').onclick=()=>metadata(true);$('lyrionRefreshPlaylists').onclick=()=>loadPlaylists(true);
 $('lyrionAddPlaylist').onclick=async()=>{
  if(writing||!track?.artist)return;const captured=inputTrack({...track}),ids=[...new Set(targets.filter(t=>t.arm.checked).map(t=>t.select.value).filter(Boolean))],destinations=ids.map(id=>playlists.find(p=>String(p.id)===id)).filter(Boolean);if(!destinations.length)return;
  writing=true;buttons();const outcomes=[];
  try{for(const p of destinations){$('lyrionPlaylistStatus').textContent=`Adding ${captured.title} to ${p.title||p.name}…`;try{const r=await request('/api/tidal/playlist-track',{playlistId:p.id,playlistTitle:p.title||p.name,track:captured});outcomes.push(r.duplicate&&r.added===false?`Already in ${p.title||p.name}`:r.added===false?`Not added: ${r.error||r.reason||'Could not verify duplicates.'}`:`Added to ${p.title||p.name}`);}catch(e){outcomes.push(e.message);}}}
  finally{writing=false;buttons();$('lyrionPlaylistStatus').textContent=`${captured.title}: ${outcomes.join(' · ')}`;}
 };
 $('lyrionCreatePlaylist').onsubmit=async event=>{
  event.preventDefault();if(writing)return;const title=$('lyrionPlaylistName').value.trim();if(!title)return;writing=true;buttons();
  try{const r=await request('/api/tidal/playlist',{title});await loadPlaylists(true);const id=String(r.playlist.id);if(!playlists.some(p=>String(p.id)===id)){playlists.push({...r.playlist,title});for(const t of targets)t.select.append(new Option(title,id));}const target=targets.find(t=>!t.select.value)||targets[0];target.select.value=id;target.arm.checked=true;persist();$('lyrionPlaylistName').value='';$('lyrionPlaylistStatus').textContent=`Created ${title}. Select Add to TIDAL to save the track.`;}catch(e){$('lyrionPlaylistStatus').textContent=e.message;}finally{writing=false;buttons();}
 };
})();
