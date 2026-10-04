"use strict";
(() => {
  const root=document.getElementById("sonicReviewApp");
  if(!root)return;
  let active=false,batch=null,position=0,busy=false,error="",requestedId="";
  const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const rows=()=>batch?.groups.flatMap(group=>group.items.map(item=>({group,item})))||[];
  const current=()=>rows()[position];
  const pauseAudio=()=>root.querySelectorAll("audio").forEach(audio=>audio.pause());
  const draftKey=()=>{const row=current();return row?`rabbit-hole-blind:${batch.batchId}:${row.group.sessionId}:${row.item.index}`:"";};
  const readDraft=()=>{try{return JSON.parse(localStorage.getItem(draftKey()))||{};}catch{return {};}};
  const storeDraft=()=>{if(!current())return;try{localStorage.setItem(draftKey(),JSON.stringify({note:root.querySelector("#blindNote")?.value||"",listened:root.querySelector("#blindListened")?.checked||false}));}catch{}};
  const time=seconds=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,"0")}`;
  function audioPanel(track,audio,label,headingId) {
    return `<section class="panel sonicBlindTrack" aria-labelledby="${headingId}"><p class="muted">${label}</p>
      <h3 id="${headingId}" tabindex="-1">${esc(track.title)}</h3><p>${esc(track.artist)}</p>
      <p class="muted">${esc(track.album)}${track.mixVersion?` · ${esc(track.mixVersion)}`:""}</p>
      <audio controls preload="none" src="${esc(audio.url)}" aria-label="Play ${esc(label.toLowerCase())}: ${esc(track.title)}"></audio>
      <p class="sonicBlindSpan">Excerpt ${time(audio.start)}–${time(audio.end)} · ${(audio.end-audio.start).toFixed(0)} seconds</p>
      <p class="sonicBlindAudioError" role="status" hidden>Audio could not load. <button type="button" data-blind-action="retry-audio">Retry audio</button></p>
      ${/^\d+$/.test(String(track.tidalId))?`<a class="buttonLink" target="_blank" rel="noreferrer" href="https://tidal.com/browse/track/${esc(track.tidalId)}">Full track in TIDAL</a>`:""}</section>`;
  }
  function render(focus=false) {
    if(!active)return;
    const row=current(),draft=readDraft(),saved=row?.item.review;
    const note=draft.note??saved?.note??"",listened=draft.listened??saved?.listened??false;
    pauseAudio();
    root.innerHTML=`<div class="sonicBlind sonicReviewShell" aria-busy="${busy}">
      <header class="sonicReviewHeader"><div><h2>Blind listening</h2><p class="muted">Listen to the anchor, then judge whether the candidate belongs beside it.</p></div><button type="button" data-blind-action="close" ${busy?"disabled":""}>Back to Sonic Review</button></header>
      <div class="sonicBlindStatus" role="status">${esc(error|| (busy?"Loading saved listening progress…":!batch?"No listening batch is prepared yet.":`${batch.completed} of ${batch.count} decisions saved${batch.remaining===0?" · Batch complete":""}`))}</div>
      ${error?'<button type="button" data-blind-action="reload">Reload saved progress</button>':""}
      ${batch&&row?`<progress max="${batch.count}" value="${batch.completed}" aria-label="Saved listening decisions"></progress>
      <div class="sonicBlindToolbar"><label for="blindAnchor">Anchor</label><select id="blindAnchor" ${busy?"disabled":""}>${batch.groups.map((g,i)=>`<option value="${i*4}" ${g.sessionId===row.group.sessionId?"selected":""}>${i+1}. ${esc(g.anchor.artist)} · ${esc(g.anchor.title)}</option>`).join("")}</select><span>Candidate ${row.item.index+1} of 4</span></div>
      <p class="muted">Anchor lane: ${esc(row.group.lane)}. Consider groove, energy, mood and the specific mix. Model names and scores stay hidden.</p>
      <div class="sonicBlindPair">${audioPanel(row.group.anchor,row.group.anchorAudio,"Anchor","blindAnchorHeading")}${audioPanel(row.item.candidate,row.item.audio,"Candidate","blindCandidateHeading")}</div>
      <section class="panel sonicBlindDecision" aria-label="Listening decision">
        <label for="blindNote">Listening note <span class="muted">(optional)</span></label><textarea id="blindNote" maxlength="2000" rows="2" placeholder="What fits or differs in groove, energy, mood or version?" ${busy?"disabled":""}>${esc(note)}</textarea>
        <label class="sonicBlindConfirm"><input type="checkbox" id="blindListened" ${listened?"checked":""} ${busy?"disabled":""}> I listened to both excerpts</label>
        <p class="muted" id="blindDecisionHelp">Confirm listening to enable a judgment. Choose “Can’t judge” if the excerpts are insufficient.</p>
        <div class="sonicBlindActions" role="group" aria-label="How well does this candidate fit the anchor?">
          ${[["KEEP","Keep similar"],["SKIP","Skip"],["WRONG_LANE","Wrong lane"],["UNSURE","Can’t judge"]].map(([value,label])=>`<button type="button" data-blind-decision="${value}" aria-describedby="blindDecisionHelp" ${busy||(!listened&&value!=="UNSURE")?"disabled":""}>${label}</button>`).join("")}
        </div><p class="muted">${saved?`Saved: ${esc(({KEEP:"Keep similar",SKIP:"Skip",WRONG_LANE:"Wrong lane",UNSURE:"Can’t judge"})[saved.decision]||saved.decision)}. You can revise this decision.`:"No decision saved for this pair."} Global ratings and discovery ranking stay unchanged.</p>
      </section>
      <nav class="sonicBlindFooter" aria-label="Listening batch navigation"><button type="button" data-blind-action="previous" ${busy||position===0?"disabled":""}>Previous pair</button><span>Pair ${position+1} of ${batch.count}</span><button type="button" data-blind-action="next" ${busy||position===batch.count-1?"disabled":""}>Next pair</button></nav>
      ${batch.remaining===0?'<p role="status">Listening complete. Your judgments are saved for the model comparison; no model has been promoted.</p>':""}`:""}</div>`;
    root.querySelectorAll("audio").forEach(audio=>{
      audio.addEventListener("play",()=>root.querySelectorAll("audio").forEach(other=>{if(other!==audio)other.pause();}));
      audio.addEventListener("error",()=>{audio.closest("section").querySelector(".sonicBlindAudioError").hidden=false;});
    });
    if(focus)root.querySelector("#blindCandidateHeading")?.focus({preventScroll:true});
  }
  async function request(path,body) {
    const response=await fetch(`/api/recommendation-v2/sonic-review/blind${path}`,{cache:"no-store",signal:AbortSignal.timeout(15000),
      ...(body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok||data.ok===false)throw new Error(data.error||"Listening progress could not be saved.");return data;
  }
  async function load(id=requestedId) {
    if(busy)return;active=true;busy=true;error="";requestedId=id;render();
    try {batch=(await request(id?`?batchId=${encodeURIComponent(id)}`:"")).batch;position=Math.max(0,rows().findIndex(x=>x.item.status==="PENDING"));}
    catch(e){error=`Couldn’t load listening progress. ${e.message}`;}
    finally{busy=false;render();}
  }
  async function save(decision) {
    if(busy||!current())return;
    const row=current(),key=draftKey(),note=root.querySelector("#blindNote").value,listened=root.querySelector("#blindListened").checked;
    storeDraft();busy=true;error="";
    root.querySelectorAll("button,input,textarea,select").forEach(el=>el.disabled=true);
    root.querySelector(".sonicBlindStatus").textContent="Saving listening decision…";
    try {
      batch=(await request("/save",{batchId:batch.batchId,sessionId:row.group.sessionId,index:row.item.index,decision,note,listened})).batch;
      try{localStorage.removeItem(key);}catch{}
      const next=rows().findIndex((x,i)=>i>position&&x.item.status==="PENDING");
      const remaining=rows().findIndex(x=>x.item.status==="PENDING");
      if(next>=0)position=next;else if(remaining>=0)position=remaining;
    }catch(e){error=`Decision not confirmed saved. Your note is kept here; retry or reload saved progress. ${e.message}`;}
    finally{busy=false;render(true);}
  }
  root.addEventListener("click",event=>{
    if(event.target.closest("[data-sonic-blind-open]")){load();return;}
    const button=event.target.closest("[data-blind-action],[data-blind-decision]");if(!button||busy)return;
    if(button.dataset.blindDecision){save(button.dataset.blindDecision);return;}
    const action=button.dataset.blindAction;
    if(action==="retry-audio"){const panel=button.closest(".sonicBlindTrack");panel.querySelector(".sonicBlindAudioError").hidden=true;panel.querySelector("audio").load();return;}
    storeDraft();
    if(action==="close"){pauseAudio();active=false;renderSonicReview();root.querySelector("[data-sonic-blind-open]")?.focus();}
    else if(action==="reload")load();
    else {position=Math.max(0,Math.min(rows().length-1,position+(action==="next"?1:-1)));render(true);}
  });
  root.addEventListener("input",event=>{if(event.target.id==="blindNote"||event.target.id==="blindListened"){storeDraft();const checked=root.querySelector("#blindListened").checked;root.querySelectorAll("[data-blind-decision]").forEach(b=>b.disabled=busy||(!checked&&b.dataset.blindDecision!=="UNSURE"));}});
  root.addEventListener("change",event=>{if(event.target.id==="blindAnchor"){storeDraft();position=Number(event.target.value);render(true);}});
  window.addEventListener("pagehide",pauseAudio);
  window.SonicBlindReviewUi={get active(){return active;},pauseAudio,mount(){if(!active)return false;if(!root.querySelector(".sonicBlind"))render();return true;}};
  const id=new URLSearchParams(location.search).get("sonicBlindBatch");
  if(id){setActiveView("sonicReview");load(id);}
})();
