"use strict";
window.createSoundSpectrumStage = function createSoundSpectrumStage(config = {}) {
  const { stage, lane, bar } = config;
  if (!stage || !lane || !bar) return null;
  const prefix = config.prefix || "lyrion", storagePrefix = config.storagePrefix || prefix;
  const elementId = suffix => prefix + suffix;
  const $ = id => document.getElementById(id.replace(/^lyrion/, prefix));
  const markup = html => html.replace(/((?:id|for|aria-controls)=")lyrion/g, "$1" + prefix);
  const presentationVisible = config.presentationVisible || (() => true);
  const sourceVisible = config.sourceVisible || (() => true);
  const selectedPlayer = config.selectedTarget || (() => "");
  const copy = {
    hint: "A separate copy of decoded PCM feeds the visuals for supported Lyrion playback. Experimental; timing may differ from what you hear.",
    start: "Select Start visuals to use the experimental music feed from your selected Lyrion player.",
    missingTarget: "Choose a Lyrion player before starting the music feed.",
    active: "The separate PCM copy is feeding SoundSpectrum.",
    waiting: "Waiting for supported Lyrion audio from your selected player.",
    label: "Music feed", ...config.feedCopy
  };
  stage.classList.add("soundSpectrumStage");
  const choices = document.createElement("div");
  choices.className = "lyrionCenterViews";
  choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "Center view");
  choices.innerHTML = markup('<button type="button" data-lyrion-view="artwork" aria-controls="lyrionCover">Artwork</button><button type="button" data-lyrion-view="visualizer" aria-controls="lyrionVisualPanel">Visualizer</button>');
  choices.querySelectorAll("button")[0]?.setAttribute("aria-controls", config.artworkId || elementId("Cover"));
  if (config.beforeChoices) config.beforeChoices.before(choices); else bar.prepend(choices);
  const panel = document.createElement("section"); panel.id = elementId("VisualPanel"); panel.className = "soundSpectrumPanel";
  panel.setAttribute("aria-label", "SoundSpectrum music visualizer");
  panel.innerHTML = markup([
    '<div id="lyrionVisualSurface" class="lyrionVisualSurface" role="group" aria-label="SoundSpectrum visualizer" tabindex="-1"><canvas id="lyrionVisualCanvas" role="img" aria-label="SoundSpectrum music visuals" hidden></canvas><img id="lyrionVisualVideo" alt="SoundSpectrum music visuals" hidden><div id="lyrionVisualEmpty"><p id="lyrionVisualReason">Select a visualizer and start visuals.</p></div><div id="lyrionVisualOverlay" class="lyrionVisualOverlay" hidden><button id="lyrionVisualExpand" type="button" aria-label="Expand visualizer" aria-controls="lyrionVisualSurface" aria-expanded="false" tabindex="-1"><svg id="lyrionVisualExpandIcon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/></svg><span id="lyrionVisualExpandLabel" class="lyrionVisualExpandLabel">Fullscreen</span></button></div></div>',
    '<div class="lyrionVisualFields"><label for="lyrionNativeVisualizer">Visualizer<select id="lyrionNativeVisualizer"><option value="aeon">Aeon</option><option value="g-force">G-Force</option><option value="whitecap">WhiteCap</option></select></label><label for="lyrionNativeInput">Audio input<select id="lyrionNativeInput"><option value="">Loading inputs…</option></select></label></div>',
    '<p id="lyrionVisualHint" class="muted">Loading SoundSpectrum audio inputs…</p>',
    '<div class="lyrionVisualToolbar"><button id="lyrionVisualToggle" type="button" aria-describedby="lyrionVisualHint">Start visuals</button><button id="lyrionVisualRefresh" type="button">Refresh inputs</button><button id="lyrionVisualFreeze" type="button" aria-pressed="false" disabled>Pause visuals</button></div>',
    '<p id="lyrionVisualStatus" class="muted" role="status" aria-live="polite">Loading audio inputs…</p>'
  ].join("\n"));
  lane.prepend(panel);
  const backdrop = document.createElement("canvas"); backdrop.id = elementId("VisualBackdrop");
  backdrop.className = "lyrionVisualBackdrop"; backdrop.setAttribute("aria-hidden", "true"); backdrop.hidden = true;
  stage.prepend(backdrop);
  const video = $("lyrionVisualVideo"), renderer = $("lyrionNativeVisualizer"), input = $("lyrionNativeInput");
  const toggle = $("lyrionVisualToggle"), freeze = $("lyrionVisualFreeze");
  const surface = $("lyrionVisualSurface"), overlay = $("lyrionVisualOverlay"), expand = $("lyrionVisualExpand");
  const names = { aeon: "Aeon", "g-force": "G-Force", whitecap: "WhiteCap" };
  const musicFeedId = config.musicFeedId || "feed:pre-hqplayer";
  let mode = "artwork", preferred = "aeon", paused = false, viewerId = "", revision = 0;
  let feedPlayer = "", startedTarget = "";
  let timer = null, controller = null, loading = false, available = true, inputsKnown = false, inputAvailable = false, captureAvailable = true, currentError = "", streamKey = "";
  let remote = { state: "idle", visualizers: [], inputs: [], noMicInputs: {}, musicInputs: [] }, audioInputs = [];
  let immersive = false, controlsTimer = null, scrollBefore = null, nativeFullscreenOwner = null;
  // Scalar diagnostics mirror the existing canvas cadence stats. Never expose
  // viewer IDs, request bodies or audio locations in the player DOM.
  stage.dataset.lastHeartbeatAt = ""; stage.dataset.lastHeartbeatError = "";
  stage.dataset.lastPollAt = ""; stage.dataset.nextPollAt = "";
  const visibility = () => String(document.visibilityState || (document.hidden ? "hidden" : "visible")).slice(0, 16);
  const media = window.createSoundSpectrumVideo?.({ image: video, canvas: $("lyrionVisualCanvas"), backdrop,
    onReady: value => { stage.dataset.visualActive = String(value && visible()); if (!value) leaveImmersive(false); render(); if (value) showControls(); },
    onError: () => { if (!viewerId || !visible()) return; currentError = "The visual stream disconnected. Select Start visuals to reconnect."; stop(); } });
  try {
    mode = localStorage.getItem(storagePrefix + ".centerView") === "visualizer" ? "visualizer" : "artwork";
    const saved = localStorage.getItem(storagePrefix + ".soundSpectrum");
    if (Object.hasOwn(names, saved)) preferred = saved;
  } catch {}
  renderer.value = preferred;
  const fullscreen = presentationVisible;
  const visible = () => fullscreen() && sourceVisible() && mode === "visualizer" && !document.hidden && stage.getClientRects().length > 0;
  const canExpand = () => visible() && !!viewerId && remote.state === "running" && !loading && (!media || media.ready());
  function hideControls() {
    clearTimeout(controlsTimer); controlsTimer = null;
    surface.dataset.controlsVisible = "false"; overlay.hidden = true; expand.tabIndex = -1;
  }
  function showControls() {
    if (!canExpand()) return;
    clearTimeout(controlsTimer); overlay.hidden = false; expand.tabIndex = 0; surface.dataset.controlsVisible = "true";
    controlsTimer = setTimeout(() => { controlsTimer = null; if (document.activeElement !== expand) hideControls(); }, 3000);
  }
  function updateExpand() {
    expand.setAttribute("aria-expanded", String(immersive));
    expand.setAttribute("aria-label", immersive ? "Return to player" : "Expand visualizer");
    expand.title = immersive ? "Return to player" : "Expand visualizer";
    $("lyrionVisualExpandLabel").textContent = immersive ? "Return to player" : "Fullscreen";
    $("lyrionVisualExpandIcon").innerHTML = '<path d="' + (immersive ? 'M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3' : 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5') + '"/>';
  }
  const nativeFullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function restoreNativeFullscreen() {
    const owner = nativeFullscreenOwner;
    if (!owner) return;
    owner.cancelled = true;
    if (nativeFullscreenElement() === stage) {
      nativeFullscreenOwner = null;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { if (exit) Promise.resolve(exit.call(document)).catch(() => {}); } catch {}
    } else if (!owner.pending) nativeFullscreenOwner = null;
  }
  function leaveImmersive(restoreFocus = true) {
    restoreNativeFullscreen();
    if (!immersive) return;
    immersive = false; stage.classList.toggle(config.immersiveClass || "lyrionNow--visualFullscreen", false); updateExpand();
    if (scrollBefore) { stage.scrollTop = scrollBefore.stage; lane.scrollTop = scrollBefore.lane; scrollBefore = null; }
    if (restoreFocus && canExpand()) { showControls(); expand.focus?.({ preventScroll: true }); }
    else if (surface.contains?.(document.activeElement) && visible()) toggle.focus?.({ preventScroll: true });
  }
  async function enterImmersive() {
    if (!canExpand()) return;
    scrollBefore = { stage: stage.scrollTop, lane: lane.scrollTop };
    immersive = true; stage.classList.toggle(config.immersiveClass || "lyrionNow--visualFullscreen", true); updateExpand(); showControls();
    surface.focus?.({ preventScroll: true });
    if (config.resetImmersiveScroll) { stage.scrollTop = 0; lane.scrollTop = 0; }
    // Keep the existing player as the native fullscreen target so its normal
    // fullscreen lifecycle does not release this viewer or reopen the stream.
    const current = nativeFullscreenElement();
    const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (current !== stage && request) {
      const owner = config.restoreNativeFullscreen ? { pending: true, entered: false, cancelled: false } : null;
      if (owner) nativeFullscreenOwner = owner;
      try { await request.call(stage); } catch { /* The full-window view remains available. */ }
      if (owner && nativeFullscreenOwner === owner) {
        owner.pending = false;
        if (owner.cancelled) restoreNativeFullscreen();
        else if (nativeFullscreenElement() !== stage) nativeFullscreenOwner = null;
      }
      if (immersive && config.resetImmersiveScroll) { stage.scrollTop = 0; lane.scrollTop = 0; }
    }
  }
  if (config.restoreNativeFullscreen) {
    const fullscreenChanged = () => {
      const owner = nativeFullscreenOwner;
      if (!owner) return;
      if (nativeFullscreenElement() === stage) {
        owner.entered = true;
        if (owner.cancelled) restoreNativeFullscreen();
      } else if (owner.entered) { nativeFullscreenOwner = null; leaveImmersive(); }
    };
    document.addEventListener("fullscreenchange", fullscreenChanged);
    document.addEventListener("webkitfullscreenchange", fullscreenChanged);
  }
  surface.onclick = event => {
    if (event?.target === expand || expand.contains?.(event?.target) || !canExpand()) return;
    surface.focus?.({ preventScroll: true }); showControls();
  };
  surface.addEventListener("pointermove", event => { if (event.pointerType === "mouse") showControls(); });
  surface.addEventListener("focusin", showControls);
  surface.addEventListener("keydown", event => {
    if (event.target === surface && ["Enter", " "].includes(event.key) && canExpand()) {
      event.preventDefault(); showControls(); expand.focus?.({ preventScroll: true });
    }
  });
  expand.onclick = event => { event?.stopPropagation?.(); if (immersive) leaveImmersive(); else void enterImmersive(); };
  expand.addEventListener("blur", showControls);
  stage.addEventListener("keydown", event => {
    if (!immersive) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); leaveImmersive(); }
    else if (event.key === "Tab") { event.preventDefault(); event.stopImmediatePropagation(); showControls(); expand.focus?.({ preventScroll: true }); }
  }, true);
  function clearVideo() { leaveImmersive(false); hideControls(); streamKey = ""; media?.stop(); video.onerror = null; video.removeAttribute("src"); video.hidden = true; backdrop.hidden = true; stage.dataset.visualActive = "false"; }
  function cancelPoll() { clearTimeout(timer); timer = null; stage.dataset.nextPollAt = ""; controller?.abort(); controller = null; }
  function release(id) {
    if (!id) return;
    const body = JSON.stringify({ action: "stop", viewerId: id });
    try { if (navigator.sendBeacon?.("/api/soundspectrum/session", new Blob([body], { type: "application/json" }))) return; } catch {}
    void fetch("/api/soundspectrum/session", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
  function stop({ pause = false } = {}) {
    const previous = viewerId;
    viewerId = ""; feedPlayer = ""; startedTarget = ""; revision++; loading = false; paused = pause;
    cancelPoll(); clearVideo(); release(previous); render();
    if (visible()) schedule(500);
  }
  function randomViewer() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }
  function options(select, values, selected, fallback, preserveUnavailable = false) {
    const entries = values.map(value => { const option = new Option(value.name, value.id); option.disabled = value.available === false; if (value.nativeName) option.title = value.nativeName; return option; });
    if (fallback) entries.unshift(new Option(fallback, ""));
    select.replaceChildren(...entries);
    select.value = entries.some(option => option.value === selected && (preserveUnavailable || !option.disabled)) ? selected : entries.find(option => !option.disabled)?.value || "";
  }
  function selectedInput() { return audioInputs.find(value => value.id === input.value); }
  function canUseInput() {
    const selected = selectedInput();
    return !!selected && selected.available !== false && (selected.kind !== "music-feed" || (!!selectedPlayer() && (!selected.zoneId || selected.zoneId === selectedPlayer()) && (!config.feedEligible || config.feedEligible(selected))));
  }
  function updateInputs(selected = input.value) {
    const builtIn = remote.noMicInputs?.[renderer.value] || [];
    const microphones = Array.isArray(remote.inputs) ? remote.inputs : [];
    audioInputs = [
      ...builtIn.filter(value => value.kind === "no-mic" && typeof value.id === "string" && typeof value.name === "string"),
      ...microphones.map(value => ({ ...value, kind: "microphone" })),
      ...(Array.isArray(remote.musicInputs) ? remote.musicInputs : []).filter(value => value.id === musicFeedId && value.kind === "music-feed" && (!config.feedSource || value.source === config.feedSource))
        .map(value => ({ ...value, name: value.label || value.name || "Music feed (experimental)", available: value.available === true }))
    ];
    if (!selected) {
      try { selected = localStorage.getItem(storagePrefix + ".soundSpectrumInput." + renderer.value) || ""; } catch {}
      if (!audioInputs.some(value => value.id === selected && value.kind === "no-mic")) selected = "";
    }
    options(input, audioInputs.map(value => ({ ...value, nativeName: value.kind === "music-feed" && value.reason ? value.name + ": " + value.reason : value.name,
      name: value.kind === "no-mic" ? "No mic · " + value.name.replace(/^Sound Generator \((.+)\)$/, "$1") : value.kind === "music-feed" ? value.name : value.name + " · PC microphone"
    })), selected, undefined, true);
    inputAvailable = canUseInput();
    input.title = selectedInput()?.name || "";
    if (!audioInputs.length) input.replaceChildren(new Option("No audio inputs available", ""));
  }
  function accept(data) {
    if (!data || !["idle", "starting", "running", "error"].includes(data.state)) throw Error("SoundSpectrum returned an unexpected status. Try again.");
    const incomingSource = data.inputSource || data.audioFeed?.source, incomingZone = data.zoneId || data.audioFeed?.zoneId;
    if (viewerId && ["starting", "running"].includes(data.state) && data.inputKind === "music-feed" && (data.inputId !== musicFeedId ||
      (config.feedSource && incomingSource && incomingSource !== config.feedSource) ||
      (config.targetParam === "zoneId" && incomingZone && incomingZone !== selectedPlayer()))) {
      currentError = "The shared visualizer switched to another playback source. Select Start visuals to reconnect.";
      stop(); return;
    }
    remote = data;
    if (Array.isArray(data.visualizers)) {
      const requested = ["running", "starting"].includes(data.state) ? data.visualizer : renderer.value || preferred;
      options(renderer, data.visualizers.filter(value => Object.hasOwn(names, value.id)).map(value => ({ ...value, name: names[value.id] })), requested);
      available = data.visualizers.some(value => Object.hasOwn(names, value.id) && value.available !== false);
    }
    if (Array.isArray(data.inputs) || data.noMicInputs || Array.isArray(data.musicInputs)) { inputsKnown = true; updateInputs(["running", "starting"].includes(data.state) ? data.inputId || "" : input.value); }
    captureAvailable = data.captureAvailable !== false && data.supported !== false;
    if (data.state === "error") currentError = data.error || "SoundSpectrum could not start. Refresh inputs and try again.";
    else if (viewerId) currentError = "";
    if (viewerId && data.viewerActive === false) {
      const previous = viewerId; viewerId = ""; release(previous);
      if (!currentError) currentError = "The visualizer session ended. Select Start visuals to reconnect.";
    }
    if (viewerId && data.state === "running") {
      // The shared renderer changes for all viewers; preserve its live connection.
      const nextKey = viewerId;
      if (streamKey !== nextKey) {
        streamKey = nextKey;
        if (media) media.start(viewerId, data.videoTransport);
        else {
          video.onerror = () => { if (viewerId !== nextKey || !visible()) return; currentError = "The visual stream disconnected. Select Start visuals to reconnect."; stop(); };
          video.src = "/api/soundspectrum/video?" + new URLSearchParams({ viewerId });
        }
      }
      if (!media) video.hidden = false;
    } else if (!viewerId || data.state !== "starting") clearVideo();
    if (viewerId && ["error", "idle"].includes(data.state)) {
      const previous = viewerId; viewerId = ""; release(previous);
      if (data.state === "idle") currentError = "The visualizer stopped on the PC. Select Start visuals to reconnect.";
    }
    render();
  }
  function render() {
    panel.hidden = !(fullscreen() && sourceVisible() && mode === "visualizer"); stage.dataset.centerView = mode;
    choices.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.lyrionView === mode)));
    const running = !!viewerId && remote.state === "running" && !loading && (!media || media.ready());
    surface.tabIndex = running && visible() ? 0 : -1; expand.disabled = !running || !visible();
    if (!running || !visible()) { leaveImmersive(false); hideControls(); }
    inputAvailable = canUseInput();
    toggle.textContent = loading ? "Cancel start" : viewerId ? "Stop visuals" : "Start visuals";
    toggle.disabled = !visible() || ((!available || !captureAvailable || !inputAvailable) && !viewerId);
    renderer.disabled = loading || !available; input.disabled = loading || !audioInputs.length;
    $("lyrionVisualRefresh").disabled = loading;
    freeze.textContent = paused ? "Resume visuals" : "Pause visuals";
    freeze.disabled = !visible() || (!viewerId && !paused) || (paused && (!available || !captureAvailable || !inputAvailable));
    freeze.setAttribute("aria-pressed", String(paused)); $("lyrionVisualEmpty").hidden = running;
    panel.setAttribute("aria-busy", String(loading || (!!viewerId && remote.state === "starting")));
    const selected = selectedInput(), noMic = selected?.kind === "no-mic", musicFeed = selected?.kind === "music-feed";
    const activeNoMic = remote.inputKind === "no-mic" || (!remote.inputKind && noMic), activeMusicFeed = remote.inputKind === "music-feed" || (!remote.inputKind && musicFeed);
    input.title = selectedInput()?.name || "";
    $("lyrionVisualHint").textContent = !inputsKnown ? "Loading SoundSpectrum audio inputs…" : noMic ? "SoundSpectrum’s built-in sound generator uses no microphone and does not listen to your music. Playback stays unchanged." : musicFeed ? copy.hint : "The microphone on the Rabbit Hole PC feeds the visuals. Playback stays unchanged.";
    let status = inputsKnown ? "Visuals stopped" : "Loading audio inputs…";
    let reason = !inputsKnown ? "Checking SoundSpectrum’s available audio inputs…" : noMic ? "Select Start visuals to run " + selected.name + ". No microphone is needed." : musicFeed ? copy.start : "Select a visualizer and Start visuals to use the PC microphone.";
    if (!available) { status = "SoundSpectrum unavailable"; reason = "No supported SoundSpectrum visualizer is available on the PC."; }
    else if (inputsKnown && !inputAvailable && !viewerId) { status = musicFeed ? "Music feed unavailable" : "Audio input unavailable"; reason = musicFeed ? selected.available === false ? selected.reason || "The experimental music feed is unavailable. Refresh inputs after enabling it on the PC." : copy.missingTarget : "No audio input is available. Refresh inputs, or connect a microphone on the Rabbit Hole PC."; }
    else if (!captureAvailable) { status = "SoundSpectrum unavailable"; reason = remote.reason || "The SoundSpectrum video bridge is unavailable on the PC."; }
    else if (paused) { status = "Visuals paused"; reason = "Select Resume visuals to start SoundSpectrum again."; }
    else if (currentError) { status = "SoundSpectrum unavailable"; reason = currentError; }
    else if (loading || (viewerId && remote.state === "starting")) { status = "Starting SoundSpectrum…"; reason = "Opening " + (names[renderer.value] || "SoundSpectrum") + (noMic ? " with " + selected.name + "…" : musicFeed ? " with the experimental music feed…" : " with the PC microphone…"); }
    else if (running) {
      if (activeMusicFeed) {
        const feed = remote.audioFeed || {}, feeding = ["receiving", "running"].includes(feed.state);
        const feedState = feed.state === "paused" ? "paused" : ["error", "unavailable", "disabled", "unsupported"].includes(feed.state) ? "unavailable" : "waiting";
        status = (names[remote.visualizer] || "SoundSpectrum") + (feeding ? " · " + copy.label + " active · Experimental" : " · " + copy.label + " " + feedState + " · Experimental");
        reason = feed.reason || (feeding ? copy.active : copy.waiting);
        if (!feeding) $("lyrionVisualEmpty").hidden = false;
      } else status = (names[remote.visualizer] || "SoundSpectrum") + (activeNoMic ? " · Sound generator · No microphone" : " · PC microphone active");
    }
    else if (remote.state === "running") { status = "SoundSpectrum is running on the PC"; reason = (names[remote.visualizer] || "SoundSpectrum") + " is running in another view. Select Start visuals to view it."; }
    $("lyrionVisualStatus").textContent = status; $("lyrionVisualReason").textContent = reason;
  }
  async function request(body, signal) {
    const response = await fetch("/api/soundspectrum/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await response.json();
    if (!response.ok) throw Object.assign(Error(data.error || "SoundSpectrum could not be reached. Try again."), { statusCode: response.status });
    return data;
  }
  async function start() {
    if (!visible() || !available || !captureAvailable || !canUseInput()) return;
    const previous = viewerId; cancelPoll(); clearVideo(); release(previous);
    const id = randomViewer(), current = ++revision; viewerId = id; paused = false; loading = true; currentError = ""; render();
    stage.dataset.lastStartAt = String(Date.now()); stage.dataset.lastHeartbeatAt = ""; stage.dataset.lastHeartbeatError = "";
    const selection = renderer.value, inputId = input.value, playerId = selectedInput()?.kind === "music-feed" ? selectedPlayer() : "";
    feedPlayer = playerId; startedTarget = selectedPlayer();
    const pending = new AbortController(); controller = pending;
    const timeout = setTimeout(() => pending.abort(), 10000);
    try { localStorage.setItem(storagePrefix + ".soundSpectrum", selection); } catch {}
    preferred = selection;
    try {
      const data = await request({ action: "start", visualizer: selection, inputId, viewerId: id, ...(playerId ? { [config.targetParam || "playerId"]: playerId } : {}) }, pending.signal);
      if (current !== revision || viewerId !== id || !visible()) { release(id); return; }
      loading = false; accept(data); schedule(4000);
    } catch (error) {
      release(id);
      if (current !== revision || viewerId !== id) return;
      viewerId = ""; loading = false; currentError = error.name === "AbortError" ? "SoundSpectrum timed out. Select Start visuals to reconnect." : error.message; render(); schedule(8000);
    } finally { clearTimeout(timeout); if (controller === pending) controller = null; }
  }
  function schedule(delay = 4000) {
    clearTimeout(timer); timer = null; stage.dataset.nextPollAt = "";
    if (visible() && !loading) { stage.dataset.nextPollAt = String(Date.now() + delay); timer = setTimeout(poll, delay); }
  }
  async function poll(refresh = false) {
    stage.dataset.lastPollAt = String(Date.now()); stage.dataset.nextPollAt = "";
    stage.dataset.lastPollVisibility = visibility(); stage.dataset.lastPollHidden = String(document.hidden);
    stage.dataset.lastPollSkipReason = !visible() ? "view-hidden" : loading ? "loading" : controller ? "in-flight" : "";
    if (!visible() || loading || controller) return;
    const current = revision, id = viewerId, heartbeat = !!id && !refresh, pending = new AbortController(); controller = pending;
    const timeout = setTimeout(() => pending.abort(), 10000);
    try {
      let data;
      if (heartbeat) data = await request({ action: "heartbeat", viewerId: id }, pending.signal);
      else {
        const query = new URLSearchParams(); if (refresh) query.set("refresh", "1"); if (id) query.set("viewerId", id);
        const response = await fetch("/api/soundspectrum/status" + (query.size ? "?" + query : ""), { signal: pending.signal, cache: "no-store" }); data = await response.json();
        if (!response.ok) throw Error(data.error || "SoundSpectrum could not be reached. Try again.");
      }
      if (current !== revision || id !== viewerId || !visible()) return;
      if (heartbeat) { stage.dataset.lastHeartbeatAt = String(Date.now()); stage.dataset.lastHeartbeatError = ""; }
      accept(data);
    } catch (error) {
      if (current !== revision || !visible()) return;
      if (heartbeat) stage.dataset.lastHeartbeatError = String(error.name || "Error").slice(0, 32) + (Number.isInteger(error.statusCode) ? ":" + error.statusCode : "");
      currentError = error.name === "AbortError" ? "SoundSpectrum timed out. Select Start visuals to reconnect." : error.message;
      const previous = viewerId; viewerId = ""; clearVideo(); release(previous); render();
    } finally {
      clearTimeout(timeout); if (controller === pending) controller = null;
      if (current === revision && visible()) schedule(viewerId ? 4000 : 8000);
    }
  }
  function sync() {
    stage.dataset.lastSyncAt = String(Date.now()); stage.dataset.lastSyncVisibility = visibility();
    stage.dataset.lastSyncHidden = String(document.hidden); stage.dataset.lastSyncVisible = String(visible());
    if (!visible() && (viewerId || loading)) stop();
    if (!visible()) cancelPoll();
    render(); if (visible() && !timer && !controller && !loading) schedule(0);
  }
  for (const button of choices.querySelectorAll("button")) button.onclick = () => {
    mode = button.dataset.lyrionView; try { localStorage.setItem(storagePrefix + ".centerView", mode); } catch {} sync();
  };
  toggle.onclick = () => { if (viewerId || loading) { currentError = ""; stop(); } else void start(); };
  freeze.onclick = () => { if (paused) void start(); else stop({ pause: true }); };
  $("lyrionVisualRefresh").onclick = () => { currentError = ""; revision++; cancelPoll(); void poll(true); };
  renderer.onchange = () => {
    preferred = renderer.value; try { localStorage.setItem(storagePrefix + ".soundSpectrum", preferred); } catch {}
    updateInputs(["microphone", "music-feed"].includes(selectedInput()?.kind) ? input.value : ""); render();
    if (viewerId) { if (inputAvailable) void start(); else stop(); }
  };
  input.onchange = () => {
    if (selectedInput()?.kind === "no-mic") { try { localStorage.setItem(storagePrefix + ".soundSpectrumInput." + renderer.value, input.value); } catch {} }
    render(); if (viewerId) { if (inputAvailable) void start(); else stop(); }
  };
  function playerChanged() {
    if ((viewerId || loading) && ((selectedInput()?.kind === "music-feed" && (!canUseInput() || (feedPlayer && feedPlayer !== selectedPlayer()))) ||
      (config.stopOnTargetChange && startedTarget !== selectedPlayer()))) stop();
    else render();
  }
  config.targetSelect?.addEventListener("change", playerChanged);
  for (const event of config.targetEvents || []) stage.addEventListener(event, playerChanged);
  new MutationObserver(sync).observe(stage, { attributes: true, attributeFilter: ["class"] });
  for (const entry of config.observe || []) {
    if (entry.target) new MutationObserver(sync).observe(entry.target, { attributes: true, attributeFilter: entry.attributes || ["hidden", "class"] });
  }
  document.addEventListener("visibilitychange", sync); window.addEventListener("pageshow", sync); window.addEventListener("online", sync);
  window.addEventListener("pagehide", () => { stop(); cancelPoll(); }); sync();
  return { sync, stop, setView(value) { if (["artwork", "visualizer"].includes(value)) { mode = value; sync(); } } };
};
