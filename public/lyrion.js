"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const ui = document.createElement("section");
  ui.id = "lyrionView"; ui.hidden = true; ui.setAttribute("aria-label", "Lyrion playback");
  ui.innerHTML = `
    <div class="panel lyrionToolbar"><label for="lyrionPlayer">Lyrion player</label><select id="lyrionPlayer"><option value="">Choose a player</option></select><button id="lyrionRefresh" type="button">Refresh players</button></div>
    <p id="lyrionMessage" role="status" aria-live="polite"></p>
    <section class="panel lyrionNow" id="lyrionNow" aria-label="Lyrion now playing">
      <img id="lyrionBackdrop" class="lyrionBackdrop" alt="" aria-hidden="true" hidden>
      <div class="lyrionStageBar"><span class="muted">Lyrion · Now playing</span><button id="lyrionFullscreen" type="button" aria-controls="lyrionNow" aria-pressed="false">Fullscreen</button></div>
      <div class="lyrionNowDetails lyrionRail"><h2 id="lyrionTitle">Choose your Lyrion player</h2><p id="lyrionArtist"></p><p id="lyrionAlbum" class="muted"></p><section id="lyrionSxm" class="lyrionSxm" aria-label="SiriusXM program information" hidden></section><section class="lyrionConnection"><h3>Playback</h3><p id="lyrionChain" class="muted">Lyrion</p></section></div>
      <div class="lyrionArtworkLane"><img id="lyrionCover" class="lyrionCover" alt="" hidden><p class="lyrionArtEmpty muted">Artwork will appear here</p><p id="lyrionStageQueue" class="muted"></p></div>
      <section id="lyrionStageFavorites" class="lyrionRail" aria-labelledby="lyrionStageFavoritesHeading"><h3 id="lyrionStageFavoritesHeading">Favorite channels</h3><div id="lyrionStageChannels" class="lyrionStageChannels"></div></section>
      <footer class="lyrionStageFooter"><div class="lyrionActions"><button data-lyrion-control="previous">Previous</button><button data-lyrion-control="play">Play</button><button data-lyrion-control="pause">Pause</button><button data-lyrion-control="next">Next</button></div><p id="lyrionStageMessage" role="status" aria-live="polite" hidden></p><progress id="lyrionProgress" max="1" value="0" aria-label="Playback progress"></progress><p id="lyrionTime" class="muted"></p></footer>
    </section>
    <section class="panel lyrionFavorites" aria-labelledby="lyrionFavoritesHeading">
      <div class="lyrionToolbar"><h2 id="lyrionFavoritesHeading">Favorite SiriusXM channels</h2><button id="lyrionFindChannels" type="button">Browse SiriusXM</button></div>
      <p class="muted">Save channels from SiriusXM browse or search. Your favorites stay saved in Rabbit Hole across devices and restarts.</p>
      <ul id="lyrionFavorites" class="lyrionFavoriteList"></ul>
    </section>
    <section class="panel" aria-labelledby="lyrionShowsHeading">
      <h2 id="lyrionShowsHeading">SiriusXM shows on demand</h2>
      <p class="muted">Find a show, browse its episodes, then play through your selected Lyrion player. Play now replaces its queue.</p>
      <form id="lyrionShowsSearch" class="lyrionToolbar"><label for="lyrionShowsQuery">Show name</label><input id="lyrionShowsQuery" type="search" value="Diplo" placeholder="Diplo, Rules Don’t Apply…" required maxlength="200"><button type="submit">Find shows</button><button id="lyrionShowsBack" type="button" hidden>Back to results</button></form>
      <p id="lyrionShowsStatus" class="muted" role="status" aria-live="polite">Search SiriusXM’s shows and available episodes.</p>
      <ul id="lyrionShowsResults" class="lyrionList"></ul>
    </section>
    <section class="panel" id="lyrionArtists" aria-labelledby="lyrionArtistsHeading">
      <h2 id="lyrionArtistsHeading">Artist stations</h2>
      <p class="muted">Personalized radio from SiriusXM, based on an artist. Play station replaces the queue and keeps adding songs while you listen.</p>
      <h3>Favorite artist stations</h3><p class="muted">Saved in Rabbit Hole across devices and restarts.</p><ul id="lyrionArtistFavorites" class="lyrionFavoriteList"></ul><p id="lyrionArtistFavoritesStatus" role="status" aria-live="polite"></p>
      <form id="lyrionArtistSearch" class="lyrionToolbar"><label for="lyrionArtistQuery">Artist</label><input id="lyrionArtistQuery" type="search" required maxlength="200" placeholder="Steve Aoki, Armin van Buuren, John Mayer…"><button type="submit">Find stations</button><button id="lyrionArtistLibrary" type="button">My stations</button></form>
      <div id="lyrionArtistShortcuts" class="lyrionChoices" role="group" aria-label="Artist search shortcuts"></div>
      <p id="lyrionArtistStatus" class="muted" role="status" aria-live="polite">Search an artist or browse stations saved in your SiriusXM library.</p>
      <div class="lyrionToolbar"><p id="lyrionArtistSession" role="status" aria-live="polite"></p><button id="lyrionArtistSaveCurrent" type="button" hidden>Favorite this station</button><button id="lyrionArtistStop" type="button" hidden>Stop adding songs</button></div>
      <ul id="lyrionArtistResults" class="lyrionFavoriteList"></ul>
    </section>
    <section class="panel" id="lyrionXtra" aria-labelledby="lyrionXtraHeading">
      <h2 id="lyrionXtraHeading">SiriusXM Xtra channels</h2>
      <p class="muted">Find music for a mood or activity. Play channel replaces your selected player’s queue and keeps adding songs while you listen.</p>
      <h3>Favorite Xtra channels</h3><p class="muted">Saved in Rabbit Hole across devices and restarts.</p>
      <ul id="lyrionXtraFavorites" class="lyrionFavoriteList"></ul><p id="lyrionXtraFavoritesStatus" role="status" aria-live="polite"></p>
      <form id="lyrionXtraSearch" class="lyrionToolbar"><label for="lyrionXtraQuery">Channel name or mood</label><input id="lyrionXtraQuery" type="search" required maxlength="200" placeholder="Zen, Chill Instrumental, Affirmations…"><button type="submit">Find channels</button><button id="lyrionXtraBrowse" type="button">Browse all Xtra channels</button></form>
      <div id="lyrionXtraShortcuts" class="lyrionChoices" role="group" aria-label="Xtra channel search shortcuts"></div>
      <p id="lyrionXtraStatus" class="muted" role="status" aria-live="polite">Search for an Xtra channel or browse the catalog.</p>
      <div class="lyrionToolbar"><p id="lyrionXtraSession" role="status" aria-live="polite"></p><button id="lyrionXtraSaveCurrent" type="button" hidden>Favorite this channel</button><button id="lyrionXtraStop" type="button" hidden>Stop adding songs</button></div>
      <ul id="lyrionXtraResults" class="lyrionFavoriteList"></ul>
    </section>
    <div class="lyrionColumns">
      <section class="panel"><h2>Sources & discovery</h2><p><a href="/soundcloud-setup.html">Connect SoundCloud playlists</a> · <a href="/siriusxm-setup.html">SiriusXM metadata</a></p><div class="lyrionToolbar"><label for="lyrionSource">Source</label><select id="lyrionSource"><option value="local">Local Library / NAS</option></select></div>
      <form id="lyrionSearch" class="lyrionToolbar"><label for="lyrionQuery">Search</label><input id="lyrionQuery" type="search" placeholder="Artist, track or channel"><button type="submit">Search source</button><button id="lyrionSearchAll" type="button">Search all sources</button></form>
      <div class="lyrionToolbar"><button id="lyrionBack" type="button" disabled>Back</button><button id="lyrionHome" type="button">Browse source</button><span id="lyrionBrowseTitle" class="muted"></span></div>
      <ul id="lyrionResults" class="lyrionList"></ul><button id="lyrionMore" type="button" hidden>Load more</button>
      </section>
      <section class="panel"><div class="lyrionToolbar"><h2>Queue</h2><button data-lyrion-control="clear">Clear queue</button></div><p id="lyrionQueueCount" class="muted"></p><ol id="lyrionQueue" class="lyrionList"></ol><button id="lyrionQueueMore" type="button" hidden>Next queue page</button></section>
    </div>`;
  document.querySelector(".shell").append(ui);
  const bar = document.createElement("div"); bar.className = "playbackSystemBar";
  bar.innerHTML = `<label for="playbackSystem">Playback system</label><select id="playbackSystem"><option value="roon">Roon</option><option value="lyrion">Lyrion</option></select><span id="playbackSystemHint" class="muted">Independent players and queues</span>`;
  document.querySelector(".appHeader").after(bar);
  let player = "", sources = [], favorites = [], browseRequest = {}, history = [], queueOffset = 0, epoch = 0, busy = false, polling = false;
  // Keep the existing controls and state; navigation only changes visibility.
  const tabDefinitions=[['now','Now playing', $('lyrionNow')],['channels','Channels',ui.querySelector('.lyrionFavorites')],['shows','Shows',$('lyrionShowsHeading').closest('section')],['artists','Artist stations',$('lyrionArtists')],['xtra','Xtra channels',$('lyrionXtra')],['sources','Sources',ui.querySelector('.lyrionColumns > section')],['queue','Queue',ui.querySelector('.lyrionColumns > section:last-child')]];
  const tabs=document.createElement('nav');tabs.className='lyrionTabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Lyrion sections');
  $('lyrionMessage').before(tabs);
  const compact=document.createElement('div');compact.className='lyrionCompact';compact.hidden=true;
  compact.innerHTML='<button type="button" id="lyrionReturnNow">Now playing</button><span id="lyrionCompactTitle"></span><button data-lyrion-control="play">Play</button><button data-lyrion-control="pause">Pause</button>';
  tabs.after(compact);
  let activeTab='now';
  function selectTab(id,focus=false){
    activeTab=tabDefinitions.some(t=>t[0]===id)?id:'now';
    for(const [key,,panel]of tabDefinitions){const selected=key===activeTab;panel.hidden=!selected;const b=$('lyrionTab-'+key);b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;if(selected&&focus)b.focus();}
    compact.hidden=activeTab==='now';
    try{localStorage.setItem('rabbitHole.lyrionTab',activeTab);}catch{}
  }
  for(const [id,label,panel]of tabDefinitions){
    const wrapper=document.createElement('section');wrapper.id='lyrionPanel-'+id;wrapper.setAttribute('role','tabpanel');wrapper.setAttribute('aria-labelledby','lyrionTab-'+id);wrapper.className='lyrionTabPanel';
    panel.before(wrapper);wrapper.append(panel);
    // The wrapper owns panel semantics; existing sections retain their layout.
    const b=document.createElement('button');b.type='button';b.id='lyrionTab-'+id;b.textContent=label;b.setAttribute('role','tab');b.setAttribute('aria-controls',wrapper.id);b.onclick=()=>selectTab(id);tabs.append(b);
    const def=tabDefinitions.find(t=>t[0]===id);def[2]=wrapper;
  }
  const columns=ui.querySelector('.lyrionColumns');for(const child of [...columns.children])columns.before(child);columns.remove();
  tabs.addEventListener('keydown',e=>{const keys=['ArrowLeft','ArrowRight','Home','End'];if(!keys.includes(e.key))return;e.preventDefault();const i=tabDefinitions.findIndex(t=>t[0]===activeTab);const next=e.key==='Home'?0:e.key==='End'?tabDefinitions.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabDefinitions.length)%tabDefinitions.length;selectTab(tabDefinitions[next][0],true);});
  $('lyrionReturnNow').onclick=()=>selectTab('now',true);
  try{selectTab(localStorage.getItem('rabbitHole.lyrionTab')||'now');}catch{selectTab('now');}
  function choices(selectId,label){
    const select=$(selectId),group=document.createElement('div');group.className='lyrionChoices';group.setAttribute('role','group');group.setAttribute('aria-label',label);select.after(group);select.hidden=true;
    const oldLabel=document.querySelector('label[for="'+selectId+'"]');if(oldLabel)oldLabel.hidden=true;
    const render=()=>{group.replaceChildren();for(const option of select.options){if(!option.value)continue;const b=document.createElement('button');b.type='button';b.textContent=option.textContent;b.setAttribute('aria-pressed',String(select.value===option.value));b.onclick=()=>{select.value=option.value;select.dispatchEvent(new Event('change'));render();};group.append(b);}};
    select.addEventListener('change',render);new MutationObserver(render).observe(select,{childList:true,subtree:true});render();return render;
  }
  const renderSystemChoices=choices('playbackSystem','Playback system');
  const renderPlayerChoices=choices('lyrionPlayer','Lyrion player');
  const renderSourceChoices=choices('lyrionSource','Music source');
  const channelMetadata=new Map();let favoriteMetadataAt=0;
  const showTime=value=>value?new Date(value).toLocaleTimeString([],{hour:"numeric",minute:"2-digit",timeZoneName:"short"}):"";
  function programSummary(m){return [m?.currentShow?"Now: "+m.currentShow:"",m?.nextShow?"Next: "+m.nextShow+" · "+showTime(m.nextShowStart):""].filter(Boolean).join("\n");}
  async function refreshFavoriteMetadata(){
    if(Date.now()-favoriteMetadataAt<45000)return;favoriteMetadataAt=Date.now();
    await Promise.allSettled(favorites.map(async f=>{const match=f.title.match(/\((\d+)\)$/);const channel=match?match[1]:f.url.replace(/^sxm:/,"");const r=await fetch("/api/siriusxm/metadata?channel="+encodeURIComponent(channel));if(!r.ok)return;const data=await r.json();channelMetadata.set(f.id,data.metadata);}));renderFavorites();
  }
  const message = text => { $("lyrionMessage").textContent = text; $("lyrionStageMessage").textContent = text; };
  const stage=$("lyrionNow"), fullButton=$("lyrionFullscreen");
  let stageExpanded=false, nativeStage=false, inertBefore=[];
  const fullscreenElement=()=>document.fullscreenElement || document.webkitFullscreenElement;
  function expandStage(value) {
    if(stageExpanded===value)return;
    stageExpanded=value;
    stage.classList.toggle("lyrionNow--fullscreen",value);
    document.body.classList.toggle("lyrionFullscreenOpen",value);
    fullButton.textContent=value?"Exit fullscreen":"Fullscreen";
    fullButton.setAttribute("aria-pressed",String(value));
    $("lyrionStageMessage").hidden=!value;

    $("lyrionMessage").hidden=value;
    if(value){
      stage.setAttribute("role","dialog");stage.setAttribute("aria-modal","true");
      // Keep the existing live player in place; isolate only its surrounding UI.
      for(let node=stage;node.parentElement && node!==document.body;node=node.parentElement){
        for(const sibling of node.parentElement.children){
          if(sibling!==node){inertBefore.push([sibling,sibling.inert]);sibling.inert=true;}
        }
      }
    }else{
      stage.removeAttribute("role");stage.removeAttribute("aria-modal");
      for(const [element,inert] of inertBefore)element.inert=inert;
      inertBefore=[];
    }
    fullButton.focus({preventScroll:true});
  }
  async function closeStage() {
    if(fullscreenElement()===stage){
      try { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
      catch { message("Use Escape or your browser's fullscreen control to exit."); return; }
    }
    nativeStage=false;expandStage(false);
  }
  fullButton.onclick=async()=>{
    if(stageExpanded){await closeStage();return;}
    expandStage(true);
    const request=stage.requestFullscreen || stage.webkitRequestFullscreen;
    if(request){try{await request.call(stage);nativeStage=fullscreenElement()===stage;}catch{/* Keep the accessible full-window fallback. */}}
  };
  const syncStage=()=>{
    if(fullscreenElement()===stage)nativeStage=true;
    else if(nativeStage){nativeStage=false;expandStage(false);}
  };
  document.addEventListener("fullscreenchange",syncStage);
  document.addEventListener("webkitfullscreenchange",syncStage);
  stage.addEventListener("keydown",event=>{
    if(!stageExpanded)return;
    if(event.key==="Escape"){event.preventDefault();closeStage();}
    if(event.key==="Tab"){
      const buttons=[...stage.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]")].filter(b=>b.getClientRects().length);
      const first=buttons[0],last=buttons[buttons.length-1];
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  // Measure only changed text/width: normal status polling must not restart scrolling.
  const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)");
  const scrollingLabels=["lyrionTitle","lyrionArtist"].map(id=>{
    const element=$(id), text=document.createElement("span");
    text.textContent=element.textContent;element.replaceChildren(text);element.classList.add("lyrionScrollingLabel");
    const label={element,text,animation:null,key:""};
    const pause=()=>label.animation?.pause();
    const resume=()=>{if(!element.matches(":hover, :focus-within"))label.animation?.play();};
    element.addEventListener("mouseenter",pause);element.addEventListener("mouseleave",resume);
    element.addEventListener("focusin",pause);element.addEventListener("focusout",resume);
    return label;
  });
  function measureLabels(){
    for(const label of scrollingLabels){
      const {element,text}=label, distance=Math.max(0,text.scrollWidth-element.clientWidth);
      const key=[text.textContent,element.clientWidth,distance,reducedMotion.matches].join("|");
      if(key===label.key)continue;label.key=key;label.animation?.cancel();label.animation=null;
      element.title=text.textContent;
      if(distance>1){element.tabIndex=0;}else{element.removeAttribute("tabindex");}
      if(distance<=1 || !element.clientWidth || reducedMotion.matches)continue;
      element.scrollLeft=0;
      const travel=distance/28, seconds=travel*2+4;
      label.animation=text.animate([
        {transform:"translateX(0)",offset:0},
        {transform:"translateX(0)",offset:2/seconds},
        {transform:"translateX(-"+distance+"px)",offset:(2+travel)/seconds},
        {transform:"translateX(-"+distance+"px)",offset:(4+travel)/seconds},
        {transform:"translateX(0)",offset:1}
      ],{duration:seconds*1000,iterations:Infinity,easing:"linear"});
      if(element.matches(":hover, :focus-within"))label.animation.pause();
    }
  }
  function setScrollingLabel(id,value){
    const label=scrollingLabels.find(item=>item.element.id===id);
    if(label.text.textContent!==value)label.text.textContent=value;
    measureLabels();
  }
  const labelResize=new ResizeObserver(measureLabels);
  scrollingLabels.forEach(label=>labelResize.observe(label.element));
  reducedMotion.addEventListener("change",measureLabels);
  document.fonts.ready.then(measureLabels);
  const api = async (route, body, query = "") => {
    const response = await fetch(`/api/lyrion/${route}${query}`, body ? { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({playerId:player,...body}) } : route==='status'?{signal:AbortSignal.timeout(15000),cache:'no-store'}:{});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Lyrion request failed"); return result;
  };
  let stationPreparation=null,actionGeneration=0;
  const run = fn => async event => {
    event?.preventDefault();
    if(busy){
      if(!stationPreparation||!event?.currentTarget?.dataset.lyrionControl)return;
      // Transport remains available while a finite station track downloads.
      // Cancel its pending start so a later response cannot resume playback.
      const pending=stationPreparation;stationPreparation=null;pending.controller.abort();
    }
    const generation=++actionGeneration;busy=true;ui.setAttribute('aria-busy','true');
    try{message('Working…');await fn(event);if(generation===actionGeneration)message('');}
    catch(error){if(generation===actionGeneration)message(error.message);}
    finally{if(generation===actionGeneration){busy=false;ui.removeAttribute('aria-busy');}}
  };
  async function stationRequest(url,body){
    const pending={controller:new AbortController()};stationPreparation=pending;message('Preparing station audio…');
    const deadline=setTimeout(()=>pending.controller.abort(),300000);
    try{
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,playerId:player}),signal:pending.controller.signal});
      const data=await response.json();if(!response.ok)throw Error(data.error||'SiriusXM request failed.');return data;
    }finally{clearTimeout(deadline);if(stationPreparation===pending)stationPreparation=null;}
  }
  const playerQuery = () => `?playerId=${encodeURIComponent(player)}`;
  const time = n => `${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,"0")}`;
  function button(label, fn) { const b=document.createElement("button"); b.type="button"; b.textContent=label; b.onclick=run(fn); return b; }
  let showResults=[],showResultsLabel="";
  async function showApi(action,body){if(action==='artist/play')return stationRequest('/api/siriusxm/ondemand/'+action,body);const r=await fetch("/api/siriusxm/ondemand/"+action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,playerId:player})});const data=await r.json();if(!r.ok)throw Error(r.status===404&&action==="channel-shows"?"Channel show lists are ready for the next Rabbit Hole restart. You can use Find shows to search by channel name now.":data.error||"SiriusXM request failed.");return data;}
  function renderShows(items){
    const list=$("lyrionShowsResults");list.replaceChildren();
    for(const item of items){
      const row=document.createElement("li"),text=document.createElement("div"),sub=document.createElement("small"),actions=document.createElement("div");text.className="lyrionText";actions.className="lyrionActions";
      text.textContent=item.title;sub.textContent=[item.type.startsWith("show")?"Show":"Episode",item.duration?Math.round(item.duration/60)+" min":"",(item.description||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim(),item.unentitled?"Not included in your subscription":item.unavailableReason].filter(Boolean).join(" · ");text.append(sub);row.append(text);
      if(item.type.startsWith("show"))actions.append(button("Episodes",async()=>{ $("lyrionShowsStatus").textContent="Loading episodes…";try{const data=await showApi("episodes",{id:item.id,type:item.type});renderShows(data.items);$("lyrionShowsBack").hidden=false;$("lyrionShowsStatus").textContent=item.title+" · "+data.items.length+" available episodes";}catch(e){$("lyrionShowsStatus").textContent=e.message;throw e;} }));
      if(item.playable)for(const [action,label]of [["play","Play now"],["next","Play next"],["add","Add to queue"]]){const b=button(label,async()=>{if(!player)throw Error("Choose a Lyrion player first.");await showApi("queue",{id:item.id,type:item.type,action});$("lyrionShowsStatus").textContent=(action==="play"?"Starting ":"Queued ")+item.title;await refreshStatus();});b.setAttribute("aria-label",label+": "+item.title);actions.append(b);}
      row.append(actions);list.append(row);
    }
    if(!items.length){const empty=document.createElement("li");empty.textContent="No available episodes or shows found. Try another show name.";list.append(empty);}
  }
  $("lyrionShowsSearch").onsubmit=run(async()=>{ showResultsLabel=""; $("lyrionShowsStatus").textContent="Searching SiriusXM…";try{const data=await showApi("search",{query:$("lyrionShowsQuery").value});showResults=data.items.sort((a,b)=>Number(b.type.startsWith("show"))-Number(a.type.startsWith("show")));renderShows(showResults);$("lyrionShowsBack").hidden=true;$("lyrionShowsStatus").textContent=showResults.length+" shows and episodes";}catch(e){$("lyrionShowsStatus").textContent=e.message;throw e;} });
  $("lyrionShowsBack").onclick=()=>{renderShows(showResults);$("lyrionShowsBack").hidden=true;$("lyrionShowsStatus").textContent=showResultsLabel||showResults.length+" shows and episodes";};
  async function channelShows(favorite){
    selectTab("shows",true);
    const name=favorite.title.replace(/\s*\(\d+\)\s*$/,"");
    $("lyrionShowsQuery").value=name;$("lyrionShowsBack").hidden=true;$("lyrionShowsResults").replaceChildren();
    showResults=[];showResultsLabel="";$("lyrionShowsStatus").textContent="Loading shows from "+name+"…";
    try{
      const channel=favorite.title.match(/\((\d+)\)/)?.[1]||favorite.url.replace(/^sxm:/,"");
      const data=await showApi("channel-shows",{channel});showResults=data.items;
      showResultsLabel=data.channel+" · "+showResults.length+" shows";renderShows(showResults);
      $("lyrionShowsStatus").textContent=showResults.length?showResultsLabel:"No on-demand shows listed for "+data.channel+".";
    }catch(e){$("lyrionShowsStatus").textContent=e.message;throw e;}
  }
  function artworkImage(img, url, identity="", fallback="") {
    const key=JSON.stringify([url||"",identity,fallback]);
    if(img.dataset.artworkKey===key && !(img.dataset.retryAt && Date.now()>=Number(img.dataset.retryAt))){img.hidden=!url || !img.complete || !img.naturalWidth;return;}
    const retry=img.dataset.artworkKey===key;
    img.dataset.artwork=url || "";img.dataset.artworkIdentity=identity;img.dataset.artworkFallback=fallback;img.dataset.artworkKey=key;delete img.dataset.retryAt;img.hidden=true;
    const generation=String(Number(img.dataset.artworkGeneration||0)+1);img.dataset.artworkGeneration=generation;
    const current=()=>img.dataset.artworkGeneration===generation;
    let usingFallback=false;
    img.onload=()=>{if(!current())return;img.hidden=false;if(!usingFallback)delete img.dataset.retryAt;};
    img.onerror=()=>{if(!current())return;img.hidden=true;img.dataset.retryAt=String(Date.now()+30000);if(!usingFallback&&fallback&&fallback!==url){usingFallback=true;img.src=fallback;}};
    if(url){
      let source=url;const localProxy=url.startsWith('/api/lyrion/artwork?');
      // LMS can reuse a mutable cover URL for consecutive radio cuts. Give our
      // local proxy a track-specific browser cache key; leave exact CDN URLs alone.
      if(identity && localProxy){
        let hash=2166136261;for(let i=0;i<identity.length;i++)hash=Math.imul(hash^identity.charCodeAt(i),16777619);
        source+='&rh-art='+(hash>>>0).toString(36);
      }
      if(retry&&!localProxy)img.removeAttribute('src');
      img.src=retry&&localProxy?`${source}&retry=${Date.now()}`:source;
    }else img.removeAttribute("src");
  }
  let artistFavorites=[], artistFavoritesAt=0, currentArtistStation=null;
  async function refreshArtistFavorites(force=false){
    if(!force && Date.now()-artistFavoritesAt<30000)return;
    artistFavoritesAt=Date.now();
    try{artistFavorites=(await showApi("artist/favorites",{})).items;renderArtistStations(artistFavorites,true);syncArtistFavorites();$("lyrionArtistFavoritesStatus").textContent="";}catch(e){$("lyrionArtistFavoritesStatus").textContent="Could not load favorites. "+e.message;artistFavoritesAt=0;}
  }
  function syncArtistFavorites(){
    ui.querySelectorAll("[data-artist-favorite]").forEach(b=>{const saved=artistFavorites.some(s=>s.id===b.dataset.artistFavorite);b.textContent=saved?"Saved":"Favorite";b.disabled=saved;});
    $("lyrionArtistSaveCurrent").hidden=!currentArtistStation || artistFavorites.some(s=>s.id===currentArtistStation.id);
  }
  async function saveArtistFavorite(action,id){
    artistFavorites=(await showApi("artist/favorites",{action,id})).items;renderArtistStations(artistFavorites,true);syncArtistFavorites();
    $("lyrionArtistFavoritesStatus").textContent=action==="add"?"Station saved to favorites.":"Station removed from favorites.";
  }
  function renderArtistStations(items,savedList=false){
    const list=$(savedList?"lyrionArtistFavorites":"lyrionArtistResults");list.replaceChildren();
    for(const item of items){
      const row=document.createElement('li'),label=document.createElement('span'),actions=document.createElement('div');actions.className='lyrionActions';
      label.textContent=item.title;
      const detail=document.createElement('small');detail.className='lyrionChannelProgram';detail.textContent=item.playable?'With '+(item.similarArtists?.join(', ')||'related artists'):'Not included in your subscription';label.append(detail);
      if(item.artwork){const img=document.createElement('img');img.alt='';artworkImage(img,item.artwork);row.append(img);}row.append(label);
      const play=button('Play station',async()=>{if(!player)throw Error('Choose a Lyrion player first.');await showApi('artist/play',{id:item.id});await refreshStatus();});play.disabled=!item.playable||!player;play.setAttribute('aria-label','Play station '+item.title);actions.append(play);
      const favorite=button(savedList?'Remove':'Favorite',()=>saveArtistFavorite(savedList?'remove':'add',item.id));favorite.setAttribute('aria-label',(savedList?'Remove favorite ':'Favorite ')+item.title);if(!savedList)favorite.dataset.artistFavorite=item.id;actions.append(favorite);
      row.append(actions);list.append(row);
    }
    if(!items.length){const empty=document.createElement('li');empty.textContent=savedList?'No favorite artist stations yet. Choose Favorite on a search result or the station you are playing.':'No artist stations found. Try another artist, or save a station in the SiriusXM app and choose My stations.';list.append(empty);}
  }
  async function findArtistStations(library=false){
    const query=$('lyrionArtistQuery').value.trim();if(!library&&!query)throw Error('Enter an artist name.');
    const version=epoch;$('lyrionArtistResults').replaceChildren();$('lyrionArtistStatus').textContent=library?'Loading your stations…':'Searching artist stations…';
    try{const data=await showApi(library?'artist/library':'artist/search',{query});if(version!==epoch)return;renderArtistStations(data.items);syncArtistFavorites();$('lyrionArtistStatus').textContent=data.items.length+' artist stations'+(library?' in your SiriusXM library':' found');}
    catch(e){$('lyrionArtistStatus').textContent=e.message;throw e;}
  }
  $('lyrionArtistSearch').onsubmit=run(()=>findArtistStations());
  $('lyrionArtistLibrary').onclick=run(()=>findArtistStations(true));
  $('lyrionArtistSaveCurrent').onclick=run(async()=>{if(currentArtistStation)await saveArtistFavorite('add',currentArtistStation.id);});
  $('lyrionArtistStop').onclick=run(async()=>{await showApi('artist/stop',{});await refreshStatus();});
  for(const name of ['Steve Aoki','Armin van Buuren','John Mayer','Bob Marley','Pearl Jam','The Beatles'])$('lyrionArtistShortcuts').append(button(name,async()=>{$('lyrionArtistQuery').value=name;await findArtistStations();}));
  let xtraFavorites=[],xtraFavoritesAt=0,currentXtraStation=null,xtraFavoritesRevision=0,xtraFavoritesRequest=0,xtraFavoriteSaving=false;
  async function xtraApi(action,body={}){
    if(action==='play')return stationRequest('/api/siriusxm/ondemand/xtra/play',body);
    const response=await fetch('/api/siriusxm/ondemand/xtra/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,playerId:player}),signal:AbortSignal.timeout(30000)});
    const data=await response.json();if(!response.ok)throw Error(data.error||'SiriusXM Xtra request failed.');return data;
  }
  async function refreshXtraFavorites(force=false){
    if(xtraFavoriteSaving||(!force&&Date.now()-xtraFavoritesAt<30000))return;
    xtraFavoritesAt=Date.now();const revision=xtraFavoritesRevision,request=++xtraFavoritesRequest;
    try{const items=(await xtraApi('favorites')).items;if(revision!==xtraFavoritesRevision||request!==xtraFavoritesRequest)return;xtraFavorites=items;renderXtraChannels(xtraFavorites,true);syncXtraFavorites();$('lyrionXtraFavoritesStatus').textContent='';}
    catch(e){if(revision!==xtraFavoritesRevision||request!==xtraFavoritesRequest)return;$('lyrionXtraFavoritesStatus').textContent='Could not load favorites. '+e.message;xtraFavoritesAt=0;}
  }
  function syncXtraFavorites(){
    ui.querySelectorAll('[data-xtra-favorite]').forEach(b=>{const saved=xtraFavorites.some(item=>item.id===b.dataset.xtraFavorite);b.textContent=saved?'Saved':'Favorite';b.disabled=saved;});
    $('lyrionXtraSaveCurrent').hidden=!currentXtraStation||xtraFavorites.some(item=>item.id===currentXtraStation.id);
  }
  async function saveXtraFavorite(action,id){
    xtraFavoritesRevision++;xtraFavoriteSaving=true;
    try{xtraFavorites=(await xtraApi('favorites',{action,id})).items;xtraFavoritesAt=Date.now();renderXtraChannels(xtraFavorites,true);syncXtraFavorites();
      $('lyrionXtraFavoritesStatus').textContent=action==='add'?'Xtra channel saved to favorites.':'Xtra channel removed from favorites.';
    }finally{xtraFavoriteSaving=false;}
  }
  function renderXtraChannels(items,savedList=false){
    const list=$(savedList?'lyrionXtraFavorites':'lyrionXtraResults');list.replaceChildren();
    for(const item of items){
      const row=document.createElement('li'),label=document.createElement('span'),actions=document.createElement('div');actions.className='lyrionActions';label.textContent=item.title;
      const detail=document.createElement('small');detail.className='lyrionChannelProgram';detail.textContent=item.playable===false?'Not included in your subscription':(item.description||'SiriusXM Xtra channel').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();label.append(detail);
      if(item.artwork){const img=document.createElement('img');img.alt='';artworkImage(img,item.artwork);row.append(img);}row.append(label);
      const play=button('Play channel',async()=>{if(!player)throw Error('Choose a Lyrion player first.');await xtraApi('play',{id:item.id});await refreshStatus();});play.disabled=item.playable===false||!player;play.setAttribute('aria-label','Play Xtra channel '+item.title);actions.append(play);
      const favorite=button(savedList?'Remove':'Favorite',()=>saveXtraFavorite(savedList?'remove':'add',item.id));favorite.setAttribute('aria-label',(savedList?'Remove favorite Xtra channel ':'Favorite Xtra channel ')+item.title);if(!savedList)favorite.dataset.xtraFavorite=item.id;actions.append(favorite);
      row.append(actions);list.append(row);
    }
    if(!items.length){const empty=document.createElement('li');empty.className='muted';empty.textContent=savedList?'No favorite Xtra channels yet. Choose Favorite on a channel below.':'No Xtra channels found. Try another name or browse all Xtra channels.';list.append(empty);}
  }
  async function findXtraChannels(browseAll=false){
    const query=$('lyrionXtraQuery').value.trim();if(!browseAll&&!query)throw Error('Enter a channel name or mood.');
    const version=epoch,list=$('lyrionXtraResults');list.replaceChildren();list.setAttribute('aria-busy','true');$('lyrionXtraStatus').textContent=browseAll?'Loading Xtra channels…':'Searching Xtra channels…';
    try{const data=await xtraApi(browseAll?'browse':'search',{query});if(version!==epoch)return;renderXtraChannels(data.items);syncXtraFavorites();$('lyrionXtraStatus').textContent=data.items.length+' Xtra channels'+(browseAll?' available':' found');}
    catch(e){$('lyrionXtraStatus').textContent=e.message;throw e;}
    finally{list.removeAttribute('aria-busy');}
  }
  $('lyrionXtraSearch').onsubmit=run(()=>findXtraChannels());
  $('lyrionXtraBrowse').onclick=run(()=>findXtraChannels(true));
  $('lyrionXtraSaveCurrent').onclick=run(async()=>{if(currentXtraStation)await saveXtraFavorite('add',currentXtraStation.id);});
  $('lyrionXtraStop').onclick=run(async()=>{await xtraApi('stop');await refreshStatus();});
  for(const name of ['Zen','Chill','Affirmations'])$('lyrionXtraShortcuts').append(button(name,async()=>{$('lyrionXtraQuery').value=name;await findXtraChannels();}));
  function renderFavorites() {
    $("lyrionFavorites").replaceChildren();
    $("lyrionStageChannels").replaceChildren();
    for (const favorite of favorites) {
      const channel=button(favorite.title,async()=>{await api("favorites/play",{id:favorite.id});await refreshStatus();});
      const channelLabel=document.createElement("span");channelLabel.textContent=favorite.title;channel.replaceChildren(channelLabel);
      if(favorite.artwork){const icon=document.createElement("img");icon.alt="";artworkImage(icon,favorite.artwork);channel.prepend(icon);}
      const summary=programSummary(channelMetadata.get(favorite.id));if(summary){const details=document.createElement("small");details.className="lyrionChannelProgram";details.textContent=summary;channel.append(details);}
      channel.disabled=!player;channel.setAttribute("aria-label",`Play favorite channel ${favorite.title}`);
      $("lyrionStageChannels").append(channel);
      const row=document.createElement("li");
      if(favorite.artwork){ const img=document.createElement("img");img.alt="";artworkImage(img,favorite.artwork);row.append(img); }
      const text=document.createElement("span");text.textContent=favorite.title;const summaryText=programSummary(channelMetadata.get(favorite.id));if(summaryText){const details=document.createElement("small");details.className="lyrionChannelProgram";details.textContent=summaryText;text.append(details);}row.append(text);
      const actions=document.createElement("div");actions.className="lyrionActions";
      const play=button("Play channel",async()=>{await api("favorites/play",{id:favorite.id});await refreshStatus();});
      play.disabled=!player;play.setAttribute("aria-label",`Play ${favorite.title}`);
      const remove=button("Remove",async()=>{ favorites=(await api("favorites",{action:"remove",id:favorite.id})).favorites;renderFavorites(); });
      remove.setAttribute("aria-label",`Remove ${favorite.title} from favorites`);
      const shows=button("Shows",()=>channelShows(favorite));shows.setAttribute("aria-label","Shows from "+favorite.title);
      actions.append(play,shows,remove);row.append(actions);$("lyrionFavorites").append(row);
    }
    if(!favorites.length){ const empty=document.createElement("li");empty.className="muted";empty.textContent="No favorite channels yet. Browse SiriusXM and choose Favorite beside a channel.";$("lyrionFavorites").append(empty); }
    if(!favorites.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="No saved channels yet. Choose Favorite beside a SiriusXM channel in Sources & discovery.";$("lyrionStageChannels").append(empty);}
    ui.querySelectorAll("[data-favorite-id]").forEach(b=>{const saved=favorites.some(f=>f.id===b.dataset.favoriteId);b.textContent=saved?"Saved":"Favorite";b.disabled=saved;});
  }
  function renderItems(items, append=false) {
    if (!append) $("lyrionResults").replaceChildren();
    for (const item of items) {
      const row=document.createElement("li"), text=document.createElement("div"); text.className="lyrionText"; text.textContent=item.title;
      const sub=document.createElement("small"); sub.textContent=[item.artist,item.source].filter(Boolean).join(" · "); text.append(sub); row.append(text);
      const actions=document.createElement("div"); actions.className="lyrionActions";
      if(item.actions?.favorite){
        const save=button("Favorite",async()=>{favorites=(await api("favorites",{action:"add",token:item.actions.favorite})).favorites;renderFavorites();});
        save.dataset.favoriteId=item.favoriteId;save.setAttribute("aria-label",`Favorite ${item.title}`);
        if(favorites.some(f=>f.id===item.favoriteId)){save.textContent="Saved";save.disabled=true;}
        actions.append(save);
      }
      if (item.actions?.browse) actions.append(button(item.input ? "Search" : "Browse", async()=>{
        history.push({...browseRequest}); await browse({token:item.actions.browse, query:$("lyrionQuery").value});
      }));
      for (const [action,label] of [["play","Play"],["next","Play next"],["add","Add"]]) if(item.actions?.[action]) actions.append(button(label,async()=>{
        await api("queue",{action,token:item.actions[action]}); await refreshStatus();
      }));
      row.append(actions); $("lyrionResults").append(row);
    }
    if (!$("lyrionResults").children.length) { const row=document.createElement("li"); row.textContent="No items returned. Try another search or source."; $("lyrionResults").append(row); }
  }
  async function browse(request, append=false) {
    const version=epoch; const result=await api("browse",request); if(version!==epoch)return;
    browseRequest=request; renderItems(result.items,append); $("lyrionMore").hidden=(request.offset||0)+result.items.length>=result.count;
    $("lyrionBack").disabled=!history.length; $("lyrionBrowseTitle").textContent=result.message || `${result.count} items`;
  }
  async function home() { history=[]; const source=sources.find(s=>s.id===$("lyrionSource").value); await browse(source?.id==="local"?{source:"local"}:{token:source?.actions.browse,query:$("lyrionQuery").value}); }
  async function search(all) {
    const version=epoch; const result=await api("search",{query:$("lyrionQuery").value,sources:all?[]:[$("lyrionSource").value]}); if(version!==epoch)return;
    renderItems(result.results.flatMap(r=>r.items)); $("lyrionMore").hidden=true;
    history=[]; $("lyrionBack").disabled=true;
    if(result.results.length===1&&result.results[0].request){browseRequest=result.results[0].request;$("lyrionMore").hidden=result.results[0].items.length>=result.results[0].count;}
    $("lyrionBrowseTitle").textContent=result.results.map(r=>`${r.source}: ${r.error||(r.searchable===false?"browse only":`${r.items.length} of ${r.count} results`)}`).join(" · ");
  }
  let statusRequest=0,lastAppliedStatus=0;
  async function refreshStatus() {
    if(!player)return; const version=epoch,requestedPlayer=player;
    const request=++statusRequest;
    const s=await api("status",null,`?playerId=${encodeURIComponent(requestedPlayer)}&offset=${queueOffset}`); if(version!==epoch||requestedPlayer!==player||request<lastAppliedStatus)return;lastAppliedStatus=request;
    ui.querySelectorAll("[data-lyrion-control]").forEach(b=>{b.disabled=!s.connected;});
    const station=s.artistStation?.type==='channel-xtra'?null:s.artistStation;currentArtistStation=station;syncArtistFavorites();void refreshArtistFavorites();
    $("lyrionArtistSession").textContent=station?station.title+" · "+(station.reason||(station.active?"Automatically adding songs":"Automatic additions stopped")):"";
    $("lyrionArtistStop").hidden=!station?.active;
    const xtraStation=s.xtraStation||(s.artistStation?.type==='channel-xtra'?s.artistStation:null);currentXtraStation=xtraStation;syncXtraFavorites();void refreshXtraFavorites();
    $('lyrionXtraSession').textContent=xtraStation?xtraStation.title+' · '+(xtraStation.reason||(xtraStation.active?'Automatically adding songs':'Automatic additions stopped')):'';
    $('lyrionXtraStop').hidden=!xtraStation?.active;
    const t=(s.displayPlaybackState||s).nowPlaying;
    stage.dispatchEvent(new CustomEvent('lyrion-track',{detail:t}));
    stage.dispatchEvent(new CustomEvent('lyrion-playback',{detail:{playerId:player,trackUrl:s.nowPlaying?.url||'',position:s.position,duration:s.duration,state:s.state}}));
    const metadata=s.siriusxmMetadata,program=$("lyrionSxm");const aboutOpen=program.querySelector("details")?.open;program.replaceChildren();program.hidden=!metadata;
    if(metadata){
      const channel=document.createElement("h3");channel.textContent=metadata.channelName+(metadata.channelNumber?" · CH "+metadata.channelNumber:"");program.append(channel);
      for(const [label,value] of [["Current show",metadata.currentShow],["Show",metadata.showStart&&metadata.showEnd?showTime(metadata.showStart)+" – "+showTime(metadata.showEnd):null],["Next",metadata.nextShow?metadata.nextShow+" · "+showTime(metadata.nextShowStart):null]]){if(!value)continue;const line=document.createElement("p");const strong=document.createElement("strong");strong.textContent=label+": ";line.append(strong,document.createTextNode(value));program.append(line);}
      if(metadata.currentShowDescription){const details=document.createElement("details"),summary=document.createElement("summary"),description=document.createElement("p");details.open=!!aboutOpen;summary.textContent="About this show";description.textContent=metadata.currentShowDescription;details.append(summary,description);program.append(details);}
    }
    void refreshFavoriteMetadata();
    setScrollingLabel("lyrionTitle",t?.title||"Nothing playing"); setScrollingLabel("lyrionArtist",t?.artist||""); $("lyrionAlbum").textContent=t?.album||"";
    $("lyrionCompactTitle").textContent=[t?.title,t?.artist].filter(Boolean).join(" — ");
    $("lyrionChain").textContent=`Lyrion → ${s.playerName} · ${s.connected?s.state:"player offline"}${t?.source?` · ${t.source}`:""}`;
    const artworkIdentity=JSON.stringify([requestedPlayer,t?.url||'',t?.title||'',t?.artist||'']);
    artworkImage($("lyrionCover"),t?.artwork || "",artworkIdentity,t?.artworkFallback||"");
    artworkImage($("lyrionBackdrop"),t?.artwork || "",artworkIdentity,t?.artworkFallback||"");
    $("lyrionStageQueue").textContent=s.queueCount+" items queued";
    ui.querySelectorAll("img[data-retry-at]").forEach(img=>artworkImage(img,img.dataset.artwork,img.dataset.artworkIdentity||'',img.dataset.artworkFallback||''));
    $("lyrionProgress").max=s.duration||1; $("lyrionProgress").value=s.duration?Math.min(s.position,s.duration):0;
    $("lyrionTime").textContent=s.duration?`${time(s.position)} / ${time(s.duration)}`:s.state==="playing"?"Live stream":"";
    $("lyrionQueueCount").textContent=`${s.queueCount} items${s.queueCount?` · showing ${queueOffset+1}–${queueOffset+s.queue.length}`:""}`;
    $("lyrionQueue").replaceChildren(...s.queue.map(t=>{const row=document.createElement("li");row.textContent=`${t.index===s.queueIndex?"Playing · ":""}${t.title}${t.artist?` — ${t.artist}`:""}`;return row;}));
    $("lyrionQueueMore").hidden=s.queueCount<=50;
    $("lyrionQueueMore").textContent=queueOffset+50>=s.queueCount?"Back to queue start":"Next queue page";
    $("lyrionQueueMore").onclick=run(async()=>{queueOffset=queueOffset+50>=s.queueCount?0:queueOffset+50;await refreshStatus();});
  }
  async function loadPlayer() {
    const version=++epoch,requestedPlayer=player;
    stage.dispatchEvent(new CustomEvent('lyrion-track',{detail:null}));
    // Invalidate the previous player before any asynchronous favorites/source
    // reads, so a late old-player response cannot restore its title or artwork.
    artworkImage($("lyrionCover"), "");artworkImage($("lyrionBackdrop"), "");
    renderFavorites();
    currentArtistStation=null;syncArtistFavorites();await refreshArtistFavorites(true);
    $("lyrionArtistSession").textContent="";$("lyrionArtistStop").hidden=true;
    currentXtraStation=null;syncXtraFavorites();await refreshXtraFavorites(true);
    $('lyrionXtraSession').textContent='';$('lyrionXtraStop').hidden=true;$('lyrionXtraResults').replaceChildren();$('lyrionXtraStatus').textContent='Search for an Xtra channel or browse the catalog.';
    if(version!==epoch||requestedPlayer!==player)return;
    $("lyrionArtistResults").replaceChildren();$("lyrionArtistStatus").textContent="Search an artist or choose a shortcut."; queueOffset=0; history=[]; $("lyrionResults").replaceChildren(); $("lyrionQueue").replaceChildren();
    ui.querySelectorAll("[data-lyrion-control]").forEach(b=>{b.disabled=!player;});
    if(!player){ $("lyrionSxm").hidden=true; setScrollingLabel("lyrionTitle","Choose your Lyrion player"); setScrollingLabel("lyrionArtist",""); $("lyrionAlbum").textContent=""; artworkImage($("lyrionCover"), ""); artworkImage($("lyrionBackdrop"), ""); $("lyrionStageQueue").textContent=""; $("lyrionChain").textContent="Lyrion"; $("lyrionProgress").value=0; $("lyrionTime").textContent=""; $("lyrionQueueCount").textContent=""; return; }
    const availableSources=await api("sources",null,playerQuery());if(version!==epoch||requestedPlayer!==player)return;sources=availableSources.sources;
    $("lyrionSource").replaceChildren(...sources.map(s=>new Option(s.title,s.id)));
    await refreshStatus(); await home();
  }
  async function refreshPlayers() {
    const result=await api("players"),preferred=player||result.selectedPlayer||""; player=result.players.some(p=>p.id===preferred)?preferred:"";
    $("lyrionPlayer").replaceChildren(new Option("Choose a player",""),...result.players.map(p=>new Option(`${p.name}${p.connected?"":" (offline)"}`,p.id)));
    $("lyrionPlayer").value=player;renderPlayerChoices(); favorites=(await api("favorites")).favorites;renderFavorites(); await loadPlayer();
    if(!result.players.length)message("No Lyrion players found. Connect a player in Lyrion, then refresh.");
    else if(preferred&&!player)message("Your previous Lyrion player is unavailable. Choose a player above to start playback.");
  }
  $("lyrionPlayer").onchange=run(async()=>{player=$("lyrionPlayer").value; if(player)await api("player",{});await loadPlayer();});
  $("lyrionRefresh").onclick=run(refreshPlayers); $("lyrionSource").onchange=run(home); $("lyrionHome").onclick=run(home);
  $("lyrionFindChannels").onclick=run(async()=>{
    const source=sources.find(s=>s.id==="siriusxm");if(!source)throw new Error("Choose a connected player with the SiriusXM plugin enabled in Lyrion.");
    $("lyrionSource").value=source.id;renderSourceChoices();selectTab("sources",true);await home();
  });
  $("lyrionSearch").onsubmit=run(()=>search(false)); $("lyrionSearchAll").onclick=run(()=>search(true));
  $("lyrionBack").onclick=run(()=>browse(history.pop()||{source:"local"}));
  $("lyrionMore").onclick=run(()=>browse({...browseRequest,offset:(browseRequest.offset||0)+50},true));
  ui.querySelectorAll("[data-lyrion-control]").forEach(b=>b.onclick=run(async()=>{if(b.dataset.lyrionControl==="clear"&&!confirm("Clear this Lyrion player's queue?"))return;await api("control",{action:b.dataset.lyrionControl});await refreshStatus();}));
  async function selectSystem() {
    const selected=$("playbackSystem").value; document.body.dataset.playbackSystem=selected; ui.hidden=selected!=="lyrion";
    try { localStorage.setItem("rabbitHole.playbackSystem",selected); } catch {}
    if(selected==="lyrion") { try {await refreshPlayers();}catch(e){message(`Cannot connect to Lyrion. ${e.message}. Check LYRION_URL and refresh players.`);} }
  }
  $("playbackSystem").onchange=selectSystem;
  try { $("playbackSystem").value=localStorage.getItem("rabbitHole.playbackSystem")==="lyrion"?"lyrion":"roon"; } catch {}
  renderSystemChoices();
  selectSystem();
  async function pollStatus(){if(!ui.hidden&&!polling&&!document.hidden){polling=true;try{await refreshStatus();}catch(e){message(e.message);}finally{polling=false;}}}
  setInterval(pollStatus,3000);
  document.addEventListener('visibilitychange',pollStatus);
  document.addEventListener('fullscreenchange',pollStatus);
  window.addEventListener('pageshow',pollStatus);
  window.addEventListener('online',pollStatus);
})();
