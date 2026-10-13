"use strict";
window.createSoundSpectrumStage = function createSoundSpectrumStage(config = {}) {
  const { stage, lane, bar } = config;
  if (!stage || !lane || !bar) return null;
  const prefix = config.prefix || "lyrion", storagePrefix = config.storagePrefix || prefix;
  const elementId = suffix => prefix + suffix;
  const $ = id => document.getElementById(id.replace(/^lyrion/, prefix));
  const markup = html => html.replace(/((?:id|for|aria-controls|aria-describedby|aria-labelledby)=")lyrion/g, "$1" + prefix);
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
    '<div class="lyrionVisualFields"><label for="lyrionNativeVisualizer">Visualizer<select id="lyrionNativeVisualizer"><option value="aeon">Aeon</option><option value="g-force">G-Force</option><option value="whitecap">WhiteCap</option></select></label><label for="lyrionNativeInput">Audio input<select id="lyrionNativeInput"><option value="">Loading inputs…</option></select></label><label for="lyrionVisualTransport" class="lyrionVisualTransport">Video transport<select id="lyrionVisualTransport"><option value="jpeg">JPEG · current</option><option value="obs-webrtc" disabled>OBS / WebRTC · experimental</option><option value="hls" disabled>HLS · browser video</option><option value="webcodecs" disabled>WebCodecs · experimental</option></select></label><label id="lyrionVisualBufferField" for="lyrionVisualBuffer" hidden>Video buffer<select id="lyrionVisualBuffer" aria-describedby="lyrionVisualBufferHelp lyrionVisualBufferStatus"><option value="automatic">Automatic</option><option value="250">250 ms</option></select></label></div>',
    '<div id="lyrionWhitecapThemeField" class="lyrionVisualFields" hidden><label for="lyrionWhitecapTheme">WhiteCap theme<select id="lyrionWhitecapTheme" aria-describedby="lyrionWhitecapThemeHelp"><option value="current">Current custom theme</option><option value="nasa-layers" disabled>NASA layers · 3 backgrounds</option></select></label></div>',
    '<p id="lyrionWhitecapThemeHelp" class="muted" hidden>Choose a theme, then Start visuals. NASA layers rotates Cosmic Cliffs, Horsehead and the deep-field control. Your saved startup theme stays unchanged.</p>',
    '<p id="lyrionVisualBufferHelp" class="muted" hidden>250 ms requests a video buffer to cushion uneven delivery; actual delay can differ. Automatic uses the browser default. Applies to WebRTC video; playback and the global visual delay stay unchanged.</p>',
    '<p id="lyrionVisualBufferStatus" class="muted" role="status" aria-live="polite" hidden></p>',
    '<div id="lyrionHlsFields" class="lyrionVisualFields" hidden><label for="lyrionHlsBitrate">HLS bitrate · Mbps<input id="lyrionHlsBitrate" type="number" min="50" max="600" step="1" value="600" inputmode="numeric" aria-describedby="lyrionHlsHelp"></label><label for="lyrionHlsBuffer">HLS buffer · MB<select id="lyrionHlsBuffer" aria-describedby="lyrionHlsHelp lyrionHlsStatus"><option value="1">1 MB</option><option value="2">2 MB</option><option value="4">4 MB</option><option value="8">8 MB</option><option value="16">16 MB</option><option value="32">32 MB</option><option value="50">50 MB</option><option value="75">75 MB</option><option value="100">100 MB</option><option value="250">250 MB</option><option value="500">500 MB</option><option value="750">750 MB</option><option value="1000">1 GB (1,000 MB)</option></select></label></div>',
    '<p id="lyrionHlsHelp" class="muted" hidden>50–600 Mbps encoder target. Bitrate changes apply on the next Start visuals. Buffer is a video data target, up to 1 GB (1,000 MB). Playback waits for it to fill; your browser may limit the size. Your visual delay setting is preserved; HLS adds delivery time.</p>',
    '<p id="lyrionHlsStatus" class="muted" hidden></p>',
    '<p id="lyrionVisualHint" class="muted">Loading SoundSpectrum audio inputs…</p>',
    '<div class="lyrionVisualToolbar"><button id="lyrionVisualToggle" type="button" aria-describedby="lyrionVisualHint">Start visuals</button><button id="lyrionVisualRefresh" type="button">Refresh inputs</button><button id="lyrionVisualFreeze" type="button" aria-pressed="false" disabled>Pause visuals</button></div>',
    '<p id="lyrionVisualStatus" class="muted" role="status" aria-live="polite">Loading audio inputs…</p>'
  ].join("\n"));
  lane.prepend(panel);
  const backdrop = document.createElement("canvas"); backdrop.id = elementId("VisualBackdrop");
  backdrop.className = "lyrionVisualBackdrop"; backdrop.setAttribute("aria-hidden", "true"); backdrop.hidden = true;
  // Detached compatibility canvas: receivers do not paint a decorative copy.
  const video = $("lyrionVisualVideo"), renderer = $("lyrionNativeVisualizer"), input = $("lyrionNativeInput");
  const whitecapTheme = $("lyrionWhitecapTheme"), themeField = $("lyrionWhitecapThemeField"), themeHelp = $("lyrionWhitecapThemeHelp");
  let themePreference = "current";
  try { if (localStorage.getItem(storagePrefix + ".whitecapTheme") === "nasa-layers") themePreference = "nasa-layers"; } catch {}
  whitecapTheme.value = themePreference;
  const toggle = $("lyrionVisualToggle"), freeze = $("lyrionVisualFreeze");
  const surface = $("lyrionVisualSurface"), overlay = $("lyrionVisualOverlay"), expand = $("lyrionVisualExpand");
  const controlsExpand = document.createElement("button");
  controlsExpand.id = elementId("VisualControlsExpand"); controlsExpand.type = "button";
  controlsExpand.className = "soundSpectrumControlsExpand";
  controlsExpand.textContent = "Visuals + controls";
  controlsExpand.setAttribute("aria-label", "Fullscreen visuals with player controls");
  controlsExpand.setAttribute("aria-controls", elementId("VisualSurface"));
  controlsExpand.setAttribute("aria-pressed", "false"); controlsExpand.hidden = true;
  bar.append(controlsExpand);
  const pureExpand = document.createElement("button");
  pureExpand.id = elementId("VisualOnlyExpand"); pureExpand.type = "button";
  pureExpand.className = "soundSpectrumControlsExpand"; pureExpand.textContent = "Visuals only";
  pureExpand.setAttribute("aria-label", "Fullscreen visuals only"); pureExpand.hidden = true;
  bar.append(pureExpand);
  const transport = $("lyrionVisualTransport"), buffer = $("lyrionVisualBuffer");
  const bufferField = $("lyrionVisualBufferField"), bufferHelp = $("lyrionVisualBufferHelp"), bufferStatus = $("lyrionVisualBufferStatus");
  const bufferStorageKey = "soundSpectrum.webrtcVideoBuffer";
  let bufferPreference = "250", bufferStoredValue;
  try { bufferStoredValue = localStorage.getItem(bufferStorageKey); if (bufferStoredValue === "automatic") bufferPreference = "automatic"; } catch {}
  buffer.value = bufferPreference;
  const hlsFields = $("lyrionHlsFields"), hlsBitrate = $("lyrionHlsBitrate"), hlsBuffer = $("lyrionHlsBuffer");
  const hlsHelp = $("lyrionHlsHelp"), hlsStatus = $("lyrionHlsStatus");
  const wcFields = document.createElement("div"); wcFields.className = "lyrionVisualFields"; wcFields.hidden = true;
  wcFields.innerHTML = markup('<label for="lyrionWcFps">Frame rate<select id="lyrionWcFps" aria-describedby="lyrionWcHelp"><option value="60">60 fps</option><option value="120">120 fps · experimental</option></select></label><label for="lyrionWcBitrate">WebCodecs bitrate · Mbps<input id="lyrionWcBitrate" type="number" min="50" max="600" step="1" value="60" inputmode="numeric" aria-describedby="lyrionWcHelp"></label><label for="lyrionWcBuffer">Memory limit · MB<select id="lyrionWcBuffer" aria-describedby="lyrionWcHelp">' + [1,2,4,8,16,32,50,75,100,250,500,750,1000].map(n => '<option value="' + n + '">' + (n === 1000 ? '1 GB (1,000 MB)' : n + ' MB') + '</option>').join('') + '</select></label><label for="lyrionWcTime">Playback buffer<select id="lyrionWcTime" aria-describedby="lyrionWcHelp"><option value="500">0.5 seconds</option><option value="750">0.75 seconds</option><option value="1000">1 second</option><option value="1500">1.5 seconds</option><option value="2000">2 seconds</option></select></label>');
  const wcHelp = document.createElement("p"); wcHelp.id = elementId("WcHelp"); wcHelp.className = "muted"; wcHelp.hidden = true;
  wcHelp.textContent = "Playback waits for the selected time, not the MB limit. More buffer time adds delay. The memory limit covers queued compressed video; decoder and download memory are additional. Changes apply on Start. Your visual delay stays unchanged. 120 fps requires a 120 Hz or faster display and browser; measured rates below can be lower. Direct Windows capture → NVENC → WebCodecs.";
  const wcStatus = document.createElement("p"); wcStatus.className = "muted"; wcStatus.hidden = true;
  for (const control of [wcFields, wcHelp, wcStatus]) $("lyrionVisualHint").before(control);
  const wcFps = $("lyrionWcFps"), wcBitrate = $("lyrionWcBitrate"), wcBuffer = $("lyrionWcBuffer"), wcTime = $("lyrionWcTime");
  wcFps.value = "60"; wcBitrate.value = "60"; wcBuffer.value = "32"; wcTime.value = "750";
  try { const fps = Number(localStorage.getItem("soundSpectrum.webcodecsFps")); if ([60,120].includes(fps)) wcFps.value = String(fps);
    const rate = Number(localStorage.getItem("soundSpectrum.webcodecsBitrateMbps")), size = Number(localStorage.getItem("soundSpectrum.webcodecsBufferMB"));
    const time = Number(localStorage.getItem("soundSpectrum.webcodecsBufferMs")); if ([500,750,1000,1500,2000].includes(time)) wcTime.value = String(time);
    if (Number.isInteger(rate) && rate >= 50 && rate <= 600) wcBitrate.value = String(rate);
    if ([1,2,4,8,16,32,50,75,100,250,500,750,1000].includes(size)) wcBuffer.value = String(size);
  } catch {}
  const hlsBitrateKey = "soundSpectrum.hlsBitrateMbps", hlsBufferKey = "soundSpectrum.hlsBufferMB";
  let hlsBitratePreference = 600, hlsBufferPreference = 32, hlsBufferStoredValue;
  const validHlsBitrate = value => Number.isInteger(value) && value >= 50 && value <= 600;
  try {
    hlsBufferStoredValue = localStorage.getItem(hlsBufferKey);
    const savedBitrate = Number(localStorage.getItem(hlsBitrateKey)), savedBuffer = Number(hlsBufferStoredValue);
    if (validHlsBitrate(savedBitrate)) hlsBitratePreference = savedBitrate;
    if ([1, 2, 4, 8, 16, 32, 50, 75, 100, 250, 500, 750, 1000].includes(savedBuffer)) hlsBufferPreference = savedBuffer;
  } catch {}
  hlsBitrate.value = String(hlsBitratePreference); hlsBuffer.value = String(hlsBufferPreference);
  buffer.setAttribute("aria-describedby", elementId("VisualBufferHelp") + " " + elementId("VisualBufferStatus"));
  const settingsButton = document.createElement("button"); settingsButton.id = elementId("VisualSettings");
  settingsButton.type = "button"; settingsButton.className = "soundSpectrumSettingsButton"; settingsButton.textContent = "Visuals & audio";
  settingsButton.setAttribute("aria-haspopup", "dialog"); settingsButton.setAttribute("aria-controls", elementId("VisualSettingsDialog"));
  settingsButton.setAttribute("aria-expanded", "false");
  (config.settingsAnchor || bar).prepend(settingsButton);
  const settingsDialog = document.createElement("dialog"); settingsDialog.id = elementId("VisualSettingsDialog");
  settingsDialog.className = "soundSpectrumSettingsDialog"; settingsDialog.hidden = true;
  settingsDialog.setAttribute("aria-labelledby", elementId("VisualSettingsHeading"));
  settingsDialog.innerHTML = markup('<div class="soundSpectrumSettingsHeader"><h2 id="lyrionVisualSettingsHeading">Visuals & audio</h2><button id="lyrionVisualSettingsClose" type="button" aria-label="Close visuals and audio settings">Close</button></div><div id="lyrionVisualSettingsBody" class="soundSpectrumSettingsBody"><p id="lyrionVisualSettingsNotice" class="soundSpectrumSettingsNotice muted" hidden>Start visuals switches the center view to Visualizer.</p></div>');
  stage.append(settingsDialog);
  const settingsBody = $("lyrionVisualSettingsBody"), settingsClose = $("lyrionVisualSettingsClose");
  // Move the same controls once; their IDs, selections and handlers remain shared.
  for (const child of Array.from(panel.children)) if (child !== surface) settingsBody.append(child);
  const settingsReason = document.createElement("p"); settingsReason.id = elementId("VisualSettingsReason");
  settingsReason.className = "soundSpectrumSettingsReason muted"; settingsBody.append(settingsReason);
  hlsBitrate.setAttribute("aria-describedby", elementId("HlsHelp") + " " + settingsReason.id);
  window.rabbitRemoteClockStyle?.mount(settingsBody, prefix);
  // One global music-feed editor, independent of renderer/input/viewer changes.
  const visualDelay = window.createSoundSpectrumDelay?.({ container: settingsBody, prefix });
  const rtcVideo = document.createElement("video"); rtcVideo.id = elementId("VisualWebRTC"); rtcVideo.className = "lyrionVisualWebRTC";
  rtcVideo.hidden = true; rtcVideo.muted = true; rtcVideo.autoplay = true; rtcVideo.playsInline = true;
  rtcVideo.setAttribute("aria-label", "SoundSpectrum music visuals"); surface.prepend(rtcVideo);
  const names = { aeon: "Aeon", "g-force": "G-Force", whitecap: "WhiteCap" };
  const musicFeedId = config.musicFeedId || "feed:pre-hqplayer";
  let mode = "artwork", preferred = "aeon", paused = false, viewerId = "", revision = 0;
  let feedPlayer = "", startedTarget = "", leaseVisibility = "", heartbeatRetryCount = 0;
  let timer = null, controller = null, loading = false, available = true, inputsKnown = false, inputAvailable = false, captureAvailable = true, currentError = "", inventoryError = false, streamKey = "";
  let remote = { state: "idle", visualizers: [], inputs: [], noMicInputs: {}, musicInputs: [] }, audioInputs = [];
  let immersive = false, withControls = false, controlsTimer = null, scrollBefore = null, nativeFullscreenOwner = null;
  let nativeFullscreenWasStage = false;
  let settingsOpen = false, settingsRestoreFocus = true;
  // Scalar diagnostics mirror the existing canvas cadence stats. Never expose
  // viewer IDs, request bodies or audio locations in the player DOM.
  stage.dataset.lastHeartbeatAt = ""; stage.dataset.lastHeartbeatError = "";
  stage.dataset.lastHeartbeatDurationMs = ""; stage.dataset.lastHlsFrameAgeMs = "";
  stage.dataset.heartbeatRetryCount = "0"; stage.dataset.heartbeatRetrying = "false";
  stage.dataset.lastPollAt = ""; stage.dataset.nextPollAt = "";
  const visibility = () => String(document.visibilityState || (document.hidden ? "hidden" : "visible")).slice(0, 16);
  const leaseVisibilityValue = () => document.hidden ? "hidden" : "visible";
  const releaseReasons = new Set(["user-stop", "pause", "pagehide", "view-hidden", "source-change", "selection-change", "media-error", "hls-buffer-limit", "hls-buffer-timeout", "heartbeat-error", "start-cancelled", "start-error", "lease-ended", "remote-ended"]);
  const mediaOptions = { presentation: presentationMode,
    onReady: value => { stage.dataset.visualActive = String(value && visible()); if (!value) leaveImmersive(false); render(); if (value) showControls(); },
    onError: mediaFailed };
  const jpegMedia = window.createSoundSpectrumVideo?.({ image: video, canvas: $("lyrionVisualCanvas"), backdrop, backdropEnabled: false, ...mediaOptions });
  const rtcMedia = window.createSoundSpectrumWebRTC?.({ video: rtcVideo, backdrop, backdropEnabled: false, ...mediaOptions, onStats: () => renderBufferStatus() });
  const hlsMedia = window.createSoundSpectrumHLS?.({ video: rtcVideo, backdrop, backdropEnabled: false, ...mediaOptions, onStats: () => renderHlsStatus() });
  const wcMedia = window.createSoundSpectrumWebCodecs?.({ surface, backdrop, backdropEnabled: false, ...mediaOptions, onStats: () => renderWcStatus() });
  let media = jpegMedia;
  try { hlsMedia?.setBufferTarget?.(hlsBufferPreference); } catch {}
  try { rtcMedia?.setBufferTarget?.(bufferPreference === "automatic" ? null : 250); } catch {}
  const fidelity = window.createSoundSpectrumFidelity?.({ surface, getVideoStats: include => media?.stats?.(include),
    getRemote: () => remote, isVisible: () => visible(), isReady: () => media?.ready?.() === true, presentation: presentationMode });
  function renderWcStatus() {
    const selected = transport.value === "webcodecs";
    wcFields.hidden = wcHelp.hidden = wcStatus.hidden = !selected;
    wcFields.style.display = selected ? "" : "none";
    wcFps.disabled = wcBitrate.disabled = wcBuffer.disabled = wcTime.disabled = !selected || loading || !!viewerId;
    if (!selected) return;
    const unavailable = window.soundSpectrumWebCodecsSupport?.();
    const s = media === wcMedia ? wcMedia?.stats() : null;
    const rate = n => Number.isFinite(n) ? n.toFixed(1) : "waiting";
    const sampleFresh = Number.isFinite(remote.videoStats?.frameRatesObservedAt) && Date.now() - remote.videoStats.frameRatesObservedAt >= 0 && Date.now() - remote.videoStats.frameRatesObservedAt <= 6000;
    const captureRate = sampleFresh ? remote.videoStats.captureFps : null, encodedRate = sampleFresh ? remote.videoStats.encodedFps : null, repeatedRate = sampleFresh ? remote.videoStats.duplicateFps : null;
    const targetStatus = s?.wcTargetFps === 120 && s.wcBufferState === "playing" ? (!sampleFresh ? "120 fps verification waiting for fresh source measurements. " :
      [captureRate,encodedRate,s.wcStreamFps,s.decodeFps,s.displayedFps,s.wcPresentationHz].every(n => Number.isFinite(n) && n >= 114) && repeatedRate === 0 ? "Measured stages near 120 fps; physical display output remains unverified. " : "120 fps is not sustained across the measured stages. ") : "";
    const rates = s?.wcBufferState ? "Target " + (s.wcTargetFps || wcFps.value) + " fps · fresh capture " + rate(captureRate) + " · encoded " + rate(encodedRate) + " · repeated " + rate(repeatedRate) + " fps · stream PTS average " + rate(s.wcStreamFps) + " · decoded " + rate(s.decodeFps) + " · drawn " + rate(s.displayedFps) + " fps · repaint callbacks " + (s.wcTargetFps === 120 ? rate(s.wcPresentationHz) + " Hz" : "not measured in 60 fps mode") + ". Physical display scanout is not measured. " : "";
    wcStatus.textContent = unavailable || targetStatus + rates + (s?.wcBufferState ?
      "WebCodecs · " + s.wcBufferState + " · " + (s.wcBufferBytes / 1e6).toFixed(1) + " MB / " + s.wcRequestedMB + " MB limit · " + (s.wcTargetMs / 1000).toFixed(2) + " s target · " + (s.wcAheadSeconds ?? s.wcBufferSeconds).toFixed(2) + " s ahead · " + s.displayedFps.toFixed(1) + " drawn fps · " + s.replacedFrames + " late frames skipped · " + Math.round(s.wcLatenessMs || 0) + " ms late · " + (s.wcRetries || 0) + " retries · " + (s.wcRecoveries || 0) + " catch-ups · " + (s.codec || "checking codec") :
      "Chrome checks stream support on Start with hardware decoding preferred. Maximum decoder bitrate is not reported. HLS remains available.");
  }
  function renderBufferStatus() {
    // Roon and Lyrion stages share the browser preference without restarting either viewer.
    try {
      const saved = localStorage.getItem(bufferStorageKey);
      if (saved !== bufferStoredValue) {
        bufferStoredValue = saved;
        const preference = saved === "automatic" ? "automatic" : "250";
        if (preference !== bufferPreference) {
          bufferPreference = preference; buffer.value = preference;
          rtcMedia?.setBufferTarget?.(preference === "automatic" ? null : 250);
        }
      }
    } catch {}
    const applicable = transport.value === "obs-webrtc";
    bufferField.hidden = bufferHelp.hidden = bufferStatus.hidden = !applicable;
    // Existing grid-label styling overrides the browser's default [hidden] rule.
    bufferField.style.display = applicable ? "" : "none";
    transport.parentNode.style.gridColumn = applicable ? "auto" : "";
    buffer.disabled = !applicable;
    if (!applicable) { bufferStatus.textContent = "Video buffer is not used by JPEG."; return; }
    const preference = bufferPreference === "automatic" ? "Automatic" : "250 ms";
    let state;
    try { state = rtcMedia?.bufferState?.(); } catch {}
    let status = preference + " selected · waiting for WebRTC video.";
    if (!rtcMedia?.setBufferTarget || !rtcMedia?.bufferState || state?.state === "unsupported") status = "This browser does not support video buffer control · using its default.";
    else if (state?.state === "rejected") status = "Browser could not apply " + preference + " · its previous buffering may remain.";
    else if (state?.state === "applied" && state.requestedMs === (bufferPreference === "automatic" ? null : 250)) status = preference + (bufferPreference === "automatic" ? " applied · browser default restored." : " target requested · browser setting verified; actual delay can differ.");
    let rtc;
    if (media === rtcMedia) { try { rtc = media?.stats?.(false)?.rtc; } catch {} }
    const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const age = finite(rtc?.sampleAgeMs), interval = finite(rtc?.bufferIntervalSeconds);
    const ms = value => finite(value) === null ? "unknown" : value.toFixed(1) + " ms";
    const freshness = age === null ? "" : " · sample " + (age / 1000).toFixed(1) + " s old" + (age > 5000 ? " · stale" : "");
    if (age === null || interval === null || interval <= 0) status += " Interval measurements: waiting" + freshness + ".";
    else status += " Actual / target / minimum: " + ms(rtc?.jitterBufferMs) + " / " + ms(rtc?.jitterBufferTargetMs) + " / " + ms(rtc?.jitterBufferMinimumMs) +
      " · last " + interval.toFixed(1) + " s" + freshness + ".";
    bufferStatus.textContent = status;
  }
  function renderHlsStatus() {
    renderWcStatus();
    try {
      const saved = localStorage.getItem(hlsBufferKey);
      if (saved !== hlsBufferStoredValue) {
        hlsBufferStoredValue = saved;
        const value = Number(saved), next = [1, 2, 4, 8, 16, 32, 50, 75, 100, 250, 500, 750, 1000].includes(value) ? value : 32;
        if (next !== hlsBufferPreference) {
          hlsBufferPreference = next; hlsBuffer.value = String(next); hlsMedia?.setBufferTarget?.(next);
        }
      }
    } catch {}
    const applicable = transport.value === "hls";
    hlsFields.hidden = hlsHelp.hidden = hlsStatus.hidden = !applicable;
    hlsFields.style.display = applicable ? "" : "none";
    hlsBitrate.disabled = !applicable || loading || !!viewerId;
    hlsBuffer.disabled = !applicable;
    if (!applicable) return;
    const bitrate = viewerId && remote.transport === "hls" ? remote.videoStats?.configuredBitrateMbps : validHlsBitrate(Number(hlsBitrate.value)) ? Number(hlsBitrate.value) : hlsBitratePreference;
    let text = (hlsBufferPreference === 1000 ? "1 GB" : hlsBufferPreference + " MB") + " holds about " + (hlsBufferPreference * 8 / (bitrate || 600)).toFixed(2) + " s at " + (bitrate || 600) + " Mbps. ";
    let stats; try { if (media === hlsMedia) stats = hlsMedia?.stats?.(false); } catch {}
    const measured = stats?.hls;
    if (viewerId && remote.transport === "hls") {
      const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
      text += "HLS · " + (bitrate || 600) + " Mbps target";
      if (finite(measured?.bufferedSeconds)) text += " · " + measured.bufferedSeconds.toFixed(2) + " s buffered";
      if (measured?.playbackBufferState === "filling") text += " · filling playback buffer";
      text += finite(stats?.displayedFps) ? " · " + stats.displayedFps.toFixed(1) + " video fps" : " · video fps measuring";
      if (finite(measured?.dropPercent) && finite(measured?.playbackIntervalSeconds) && measured.playbackIntervalSeconds > 0)
        text += " · " + measured.dropPercent.toFixed(1) + "% video frames dropped over " + measured.playbackIntervalSeconds.toFixed(1) + " s";
      if (finite(measured?.framesDropped)) text += " · " + measured.framesDropped + " dropped since Start";
      text += ". Stop visuals to change bitrate.";
    } else text += "Ready for the next Start visuals.";
    hlsStatus.textContent = text;
  }
  function presentationMode() {
    if (immersive) return withControls ? "player-fullscreen" : "visualizer-fullscreen";
    const native = document.fullscreenElement || document.webkitFullscreenElement;
    return native === stage || native?.contains?.(stage) || stage.classList.contains("player--fullscreen") || stage.classList.contains("lyrionNow--fullscreen") ? "player-fullscreen" : "windowed";
  }
  function heartbeatVideoStats(snapshot) {
    // Optional measurements share the existing heartbeat; unavailable or
    // malformed media diagnostics must never interrupt viewer renewal.
    try {
      const value = snapshot || media?.stats?.(false);
      if (!value || typeof value !== "object" || Array.isArray(value) || !["websocket", "mjpeg", "obs-webrtc", "hls", "webcodecs"].includes(value.transport)) return undefined;
      const stats = { transport: value.transport, presentation: presentationMode() };
      const limits = { frames: 2147483647, receivedFrames: 2147483647, decodedFrames: 2147483647,
        replacedFrames: 2147483647, busyDroppedFrames: 2147483647, backgroundFrames: 2147483647,
        receiveFps: 240, decodeFps: 240, displayedFps: 240, backgroundFps: 240,
        meanDecodeMs: 60000, meanPaintMs: 60000, meanRafWaitMs: 60000, maxPaintGapMs: 60000, lastPaintGapMs: 60000, hlsBufferSeconds: 600, hlsRequestedMB: 1000, hlsReserveSeconds: 600, hlsMaxBufferSeconds: 600, hlsLoadedBytes: 1000000000000, hlsMediaTime: 864000, hlsReadyState: 4, hlsDroppedFrames: 2147483647, hlsDropPercent: 100 };
      for (const [key, limit] of Object.entries(limits)) {
        const number = value[key];
        if (typeof number === "number" && Number.isFinite(number) && number >= 0) stats[key] = Math.min(number, limit);
      }
      for (const [key, limit] of Object.entries({ wcBufferBytes: 1200000000, wcBufferSeconds: 600, wcRequestedMB: 1000, wcLoadedBytes: 1e12, wcDecodeQueue: 100, wcAheadSeconds: 600, wcTargetMs: 2000, wcLatenessMs: 60000, wcRetries: 1000000, wcRecoveries: 1000000, wcHttpStatus: 599, wcTargetFps: 120, wcPresentationHz: 360, wcStreamFps: 240 })) {
        if (Number.isFinite(value[key]) && value[key] >= 0) stats[key] = Math.min(value[key], limit);
      }
      if (["playlist", "init", "segment"].includes(value.wcRequestKind)) stats.wcRequestKind = value.wcRequestKind;
    if (["filling", "playing", "retrying", "recovering"].includes(value.wcBufferState)) stats.wcBufferState = value.wcBufferState;
      if (["filling", "playing", "idle"].includes(value.hlsBufferState)) stats.hlsBufferState = value.hlsBufferState;
      if (["quota", "starved", "load", "append", "other"].includes(value.hlsLastError)) stats.hlsLastError = value.hlsLastError;
      if (typeof value.hlsPaused === "boolean") stats.hlsPaused = value.hlsPaused;
      if (typeof value.hlsSeeking === "boolean") stats.hlsSeeking = value.hlsSeeking;
      if (["full", "windowed-touch"].includes(value.backdropProfile)) stats.backdropProfile = value.backdropProfile;
      try { if (typeof window.matchMedia === "function") stats.coarsePointer = window.matchMedia("(pointer: coarse)").matches === true; } catch {}
      return stats;
    } catch { return undefined; }
  }
  function freshHlsHeartbeat(generation, receiver) {
    stage.dataset.lastHlsFrameAgeMs = "";
    if (media !== receiver || media !== hlsMedia || !Number.isSafeInteger(generation) || remote.generation !== generation ||
      remote.state !== "running" || ![remote.transport, remote.videoTransport].includes("hls") || streamKey !== viewerId + ":hls:" + generation) return false;
    try {
      const stats = media?.stats?.(false), gap = stats?.lastPaintGapMs;
      const measured = typeof gap === "number" && Number.isFinite(gap) && gap >= 0;
      if (measured) stage.dataset.lastHlsFrameAgeMs = String(Math.min(60000, Math.round(gap)));
      return visible() && media?.ready?.() === true && stats?.transport === "hls" &&
        typeof stats.frames === "number" && Number.isFinite(stats.frames) && stats.frames > 0 && measured && gap <= 3000;
    } catch { return false; }
  }
  let transportChosen = false;
  try {
    mode = localStorage.getItem(storagePrefix + ".centerView") === "visualizer" ? "visualizer" : "artwork";
    const saved = localStorage.getItem(storagePrefix + ".soundSpectrum");
    if (Object.hasOwn(names, saved)) preferred = saved;
    const savedTransport = localStorage.getItem(storagePrefix + ".soundSpectrumTransport");
    transportChosen = ["jpeg", "obs-webrtc", "hls", "webcodecs"].includes(savedTransport);
    transport.value = ["obs-webrtc", "hls", "webcodecs"].includes(savedTransport) ? savedTransport : "jpeg";
  } catch {}
  if (!transport.value) transport.value = "jpeg";
  renderer.value = preferred;
  const fullscreen = presentationVisible;
  const viewPresent = () => fullscreen() && sourceVisible() && mode === "visualizer" && stage.getClientRects().length > 0;
  const visible = () => viewPresent() && !document.hidden;
  // A native visualizer can cover the browser without ending its viewer demand.
  // Hidden pages continue only a viewer that the user has already started.
  const canInspect = () => viewPresent() || (settingsOpen && canOpenSettings());
  const canPoll = () => canInspect() && (!!viewerId || !document.hidden);
  const canExpand = () => visible() && !!viewerId && remote.state === "running" && !loading && (!media || media.ready());
  const canOpenSettings = () => fullscreen() && sourceVisible() && (!immersive || withControls) && !document.hidden && stage.getClientRects().length > 0;
  const canStartFromSettings = () => mode === "artwork" && settingsOpen && canOpenSettings();
  function finishSettingsClose(restoreFocus = true) {
    if (!settingsOpen) return;
    settingsOpen = false; settingsDialog.hidden = true; settingsButton.setAttribute("aria-expanded", "false");
    visualDelay?.setVisible(false);
    stage.classList.remove("soundSpectrumStage--settingsOpen");
    if (!canPoll()) { revision++; cancelPoll(); }
    if (restoreFocus && canOpenSettings()) settingsButton.focus?.({ preventScroll: true });
  }
  function closeSettings(restoreFocus = true) {
    if (!settingsOpen) return;
    settingsRestoreFocus = restoreFocus;
    settingsDialog.close(); finishSettingsClose(restoreFocus);
  }
  function openSettings() {
    if (settingsOpen || !canOpenSettings()) return;
    settingsOpen = true; settingsRestoreFocus = true; settingsDialog.hidden = false;
    try { settingsDialog.showModal(); }
    catch { finishSettingsClose(false); return; }
    settingsButton.setAttribute("aria-expanded", "true"); stage.classList.add("soundSpectrumStage--settingsOpen");
    visualDelay?.setVisible(true);
    sync();
    settingsClose.focus?.({ preventScroll: true });
  }
  settingsButton.onclick = openSettings; settingsClose.onclick = () => closeSettings();
  settingsDialog.addEventListener("close", () => { if (!settingsDialog.open) finishSettingsClose(settingsRestoreFocus); });
  settingsDialog.addEventListener("cancel", event => { event.preventDefault(); event.stopPropagation(); closeSettings(); });
  settingsDialog.addEventListener("click", event => {
    if (event.target !== settingsDialog) return;
    const bounds = settingsDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeSettings();
  });
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
    const pure = immersive && !withControls;
    controlsExpand.textContent = withControls ? "Inset visuals" : "Visuals + controls";
    controlsExpand.setAttribute("aria-label", withControls ? "Return to inset visuals" : "Fullscreen visuals with player controls");
    controlsExpand.setAttribute("aria-pressed", String(withControls));
    pureExpand.hidden = !withControls;
    expand.setAttribute("aria-expanded", String(pure));
    expand.setAttribute("aria-label", pure ? "Return to player" : "Expand visualizer");
    expand.title = pure ? "Return to player" : "Expand visualizer";
    $("lyrionVisualExpandLabel").textContent = pure ? "Return to player" : "Fullscreen";
    $("lyrionVisualExpandIcon").innerHTML = '<path d="' + (pure ? 'M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3' : 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5') + '"/>';
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
    const wasControls = withControls;
    immersive = false; withControls = false;
    if (surface.parentNode !== panel) panel.prepend(surface);
    stage.classList.toggle("soundSpectrumStage--controlsFullscreen", false);
    stage.classList.toggle(config.immersiveClass || "lyrionNow--visualFullscreen", false); updateExpand();
    if (scrollBefore) { stage.scrollTop = scrollBefore.stage; lane.scrollTop = scrollBefore.lane; scrollBefore = null; }
    if (restoreFocus && canExpand()) { showControls(); (wasControls ? controlsExpand : expand).focus?.({ preventScroll: true }); }
    else if (surface.contains?.(document.activeElement) && visible()) settingsButton.focus?.({ preventScroll: true });
  }
  async function enterImmersive(showPlayer = false) {
    if (!canExpand()) return;
    closeSettings(false);
    if (!immersive) scrollBefore = { stage: stage.scrollTop, lane: lane.scrollTop };
    immersive = true; withControls = showPlayer;
    (withControls ? stage : panel).prepend(surface);
    stage.classList.toggle("soundSpectrumStage--controlsFullscreen", withControls);
    stage.classList.toggle(config.immersiveClass || "lyrionNow--visualFullscreen", !withControls); updateExpand(); showControls();
    (withControls ? controlsExpand : surface).focus?.({ preventScroll: true });
    if (config.resetImmersiveScroll) { stage.scrollTop = 0; lane.scrollTop = 0; }
    // Keep the existing player as the native fullscreen target so its normal
    // fullscreen lifecycle does not release this viewer or reopen the stream.
    const current = nativeFullscreenElement();
    nativeFullscreenWasStage = current === stage;
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
      if (!owner) {
        if (immersive && nativeFullscreenWasStage && nativeFullscreenElement() !== stage) leaveImmersive();
        nativeFullscreenWasStage = nativeFullscreenElement() === stage;
        return;
      }
      nativeFullscreenWasStage = nativeFullscreenElement() === stage;
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
  expand.onclick = event => { event?.stopPropagation?.(); if (immersive && !withControls) leaveImmersive(); else void enterImmersive(); };
  controlsExpand.onclick = event => { event?.stopPropagation?.(); if (withControls) leaveImmersive(); else void enterImmersive(true); };
  pureExpand.onclick = event => { event?.stopPropagation?.(); void enterImmersive(); };
  expand.addEventListener("blur", showControls);
  stage.addEventListener("keydown", event => {
    if (settingsOpen) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeSettings(); }
      return;
    }
    if (!immersive) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); leaveImmersive(); }
    else if (event.key === "Tab" && !withControls && !fidelity?.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); showControls(); expand.focus?.({ preventScroll: true }); }
  }, true);
  function clearVideo() { leaveImmersive(false); hideControls(); streamKey = ""; stage.dataset.heartbeatRetrying = "false"; media?.stop(); fidelity?.clear(); video.onerror = null; video.removeAttribute("src"); video.hidden = true; rtcVideo.hidden = true; backdrop.hidden = true; stage.dataset.visualActive = "false"; }
  function mediaFailed(reason, diagnostics) {
    if (!viewerId || !viewPresent()) return;
    currentError = typeof reason === "string" && reason.startsWith("webcodecs: ") ? reason.slice(11) : reason === "buffer-limit" ? "The browser could not hold the selected HLS buffer. Choose a smaller buffer, then Start visuals." :
      reason === "buffer-fill-timeout" ? "The HLS buffer did not fill in time. Choose a smaller buffer or bitrate, then Start visuals." :
      "The visual stream disconnected. Select Start visuals to reconnect.";
    // Background transport can suspend while the native window covers Chrome.
    // Keep its viewer demand, then reconnect media when the page is visible.
    if (document.hidden) { clearVideo(); render(); return; }
    stop({ reason: reason === "buffer-limit" ? "hls-buffer-limit" : reason === "buffer-fill-timeout" ? "hls-buffer-timeout" : "media-error", videoStats: heartbeatVideoStats(diagnostics) });
  }
  function cancelPoll() { clearTimeout(timer); timer = null; stage.dataset.nextPollAt = ""; controller?.abort(); controller = null; }
  function release(id, reason = "user-stop", videoStats) {
    if (!id) return;
    reason = releaseReasons.has(reason) ? reason : "user-stop";
    stage.dataset.lastStopAt = String(Date.now()); stage.dataset.lastStopReason = reason;
    stage.dataset.lastStopVisibility = leaseVisibilityValue();
    const body = JSON.stringify({ action: "stop", viewerId: id, reason, visibility: leaseVisibilityValue(), videoStats });
    try { if (navigator.sendBeacon?.("/api/soundspectrum/session", new Blob([body], { type: "application/json" }))) return; } catch {}
    void fetch("/api/soundspectrum/session", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
  function stop({ pause = false, reason = "user-stop", videoStats } = {}) {
    if (["view-hidden", "source-change", "pagehide"].includes(reason)) closeSettings(false);
    const previous = viewerId;
    viewerId = ""; feedPlayer = ""; startedTarget = ""; leaseVisibility = ""; revision++; loading = false; paused = pause;
    cancelPoll(); clearVideo(); release(previous, reason, videoStats); render();
    if (visible()) schedule(500);
  }
  function randomViewer() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }
  const optionLists = new WeakMap();
  function options(select, values, selected, fallback, preserveUnavailable = false) {
    const entries = values.map(value => ({ label: value.name === undefined ? "" : String(value.name),
      value: value.id === undefined ? "" : String(value.id), disabled: value.available === false,
      title: value.nativeName ? String(value.nativeName) : "" }));
    if (fallback) entries.unshift({ label: String(fallback), value: "", disabled: false, title: "" });
    // The heartbeat refreshes status, not the option DOM. Preserve an open
    // menu and its focus when all ordered labels, IDs, availability and titles
    // remain identical; changed metadata must still update immediately.
    const signature = JSON.stringify(entries);
    if (optionLists.get(select) !== signature) {
      select.replaceChildren(...entries.map(value => {
        const option = new Option(value.label, value.value); option.disabled = value.disabled;
        if (value.title) option.title = value.title;
        return option;
      }));
      optionLists.set(select, signature);
    }
    const next = entries.some(option => option.value === selected && (preserveUnavailable || !option.disabled)) ? selected : entries.find(option => !option.disabled)?.value || "";
    if (select.value !== next) select.value = next;
  }
  function selectedInput() { return audioInputs.find(value => value.id === input.value); }
  function selectedTheme() { return renderer.value === "whitecap" ? whitecapTheme.value || "current" : "current"; }
  function canUseTheme() { return selectedTheme() === "current" || remote.whitecapThemes?.some(theme => theme.id === selectedTheme() && theme.available === true); }
  function transportEntries() {
    const values = Array.isArray(remote.transports) ? remote.transports : [{ id: "jpeg", name: "JPEG · current", available: remote.captureAvailable !== false },
      { id: "obs-webrtc", name: "OBS / WebRTC · experimental", available: false, reason: "The optional OBS video publisher is not available on this server." }];
    const hlsSource = values.find(value => value.id === "hls");
    const experimental = hlsSource ? [{ ...hlsSource, id: "webcodecs", name: "WebCodecs · experimental",
      available: hlsSource.available !== false && !!wcMedia && !window.soundSpectrumWebCodecsSupport?.(),
      reason: window.soundSpectrumWebCodecsSupport?.() || hlsSource.reason }] : [];
    return [...values, ...experimental].filter(value => ["jpeg", "obs-webrtc", "hls", "webcodecs"].includes(value.id)).map(value => ({ ...value,
      available: value.available !== false && (value.id !== "obs-webrtc" || Object.hasOwn(names, renderer.value) && !!rtcMedia && typeof window.RTCPeerConnection === "function") && (value.id !== "hls" || !!hlsMedia && window.Hls?.isSupported?.() === true),
      nativeName: value.id === "hls" && (!hlsMedia || !window.Hls?.isSupported?.()) ? "HLS playback is unavailable in this browser. Refresh Rabbit Hole in Chrome." : value.id === "obs-webrtc" && !rtcMedia ? "Refresh Rabbit Hole to load the optional WebRTC receiver." : value.id === "obs-webrtc" && typeof window.RTCPeerConnection !== "function" ? "This browser does not support WebRTC receiving." : value.reason || value.name
    }));
  }
  function canUseTransport() { return remote.supported !== false && transportEntries().some(value => value.id === transport.value && value.available !== false); }
  function updateTransports(selected = transport.value) {
    const entries = transportEntries();
    if (!transportChosen && Array.isArray(remote.transports)) {
      selected = entries.some(value => value.id === "obs-webrtc" && value.available) ? "obs-webrtc" : "jpeg";
      transportChosen = true;
    }
    options(transport, entries, selected || "jpeg", undefined, true);
  }
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
    })), selected, audioInputs.length ? undefined : "No audio inputs available", true);
    inputAvailable = canUseInput();
    input.title = selectedInput()?.name || "";
  }
  function accept(data) {
    if (!data || !["idle", "starting", "running", "error"].includes(data.state)) throw Error("SoundSpectrum returned an unexpected status. Try again.");
    const incomingSource = data.inputSource || data.audioFeed?.source, incomingZone = data.zoneId || data.audioFeed?.zoneId;
    if (viewerId && ["starting", "running"].includes(data.state) && data.inputKind === "music-feed" && (data.inputId !== musicFeedId ||
      (config.feedSource && incomingSource && incomingSource !== config.feedSource) ||
      (config.targetParam === "zoneId" && incomingZone && incomingZone !== selectedPlayer()))) {
      currentError = "The shared visualizer switched to another playback source. Select Start visuals to reconnect.";
      stop({ reason: "source-change" }); return;
    }
    remote = data;
    if (viewerId && data.visualizer === "whitecap" && ["starting", "running"].includes(data.state)) themePreference = data.whitecapTheme === "nasa-layers" ? "nasa-layers" : "current";
    options(whitecapTheme, [{ id: "current", name: "Current custom theme", available: true },
      { id: "nasa-layers", name: "NASA layers · 3 backgrounds", available: data.whitecapThemes?.some(theme => theme.id === "nasa-layers" && theme.available === true) }], themePreference, undefined, true);
    if (Array.isArray(data.visualizers)) {
      const requested = ["running", "starting"].includes(data.state) ? data.visualizer : renderer.value || preferred;
      options(renderer, data.visualizers.filter(value => Object.hasOwn(names, value.id)).map(value => ({ ...value, name: names[value.id] })), requested);
      available = data.visualizers.some(value => Object.hasOwn(names, value.id) && value.available !== false);
    }
    if (Array.isArray(data.inputs) || data.noMicInputs || Array.isArray(data.musicInputs)) { inputsKnown = true; updateInputs(["running", "starting"].includes(data.state) ? data.inputId || "" : input.value); }
    updateTransports(viewerId && ["running", "starting"].includes(data.state) ? data.transport === "hls" && transport.value === "webcodecs" ? "webcodecs" : data.transport || "jpeg" : transport.value);
    if (viewerId && data.transport === "hls" && validHlsBitrate(data.videoStats?.configuredBitrateMbps)) hlsBitrate.value = String(data.videoStats.configuredBitrateMbps);
    captureAvailable = canUseTransport();
    if (data.state === "error") currentError = data.error || "SoundSpectrum could not start. Refresh inputs and try again.";
    else if (viewerId) currentError = "";
    if (viewerId && data.viewerActive === false) {
      const previous = viewerId; viewerId = ""; leaseVisibility = ""; release(previous, "lease-ended");
      if (!currentError) currentError = "The visualizer session ended. Select Start visuals to reconnect.";
    }
    if (viewerId && data.state === "running") {
      // The shared renderer changes for all viewers; preserve its live connection.
      const rtc = data.transport === "obs-webrtc" || data.videoTransport === "obs-webrtc";
      const hls = data.transport === "hls" || data.videoTransport === "hls";
      const nextKey = rtc || hls ? viewerId + ":" + (hls ? "hls" : "obs-webrtc") + ":" + data.generation : viewerId + ":jpeg";
      if (streamKey !== nextKey && !document.hidden) {
        streamKey = nextKey;
        const nextMedia = hls ? transport.value === "webcodecs" ? wcMedia : hlsMedia : rtc ? rtcMedia : jpegMedia;
        if (media !== nextMedia) { media?.stop(); media = nextMedia; }
        if ((rtc || hls) && !media) { mediaFailed(); return; }
        if (hls) media?.setBitrateTarget?.(data.videoStats?.configuredBitrateMbps || hlsBitratePreference);
        if (media) media.start(viewerId, data.videoTransport, data.generation, { bitrateMbps: data.videoStats?.configuredBitrateMbps, targetFps: data.videoStats?.targetFps || 60 });
        else {
          const streamViewer = viewerId;
          video.onerror = () => { if (viewerId === streamViewer) mediaFailed(); };
          video.src = "/api/soundspectrum/video?" + new URLSearchParams({ viewerId });
        }
      }
      if (!media) video.hidden = false;
    } else if (!viewerId || data.state !== "starting") clearVideo();
    if (viewerId && ["error", "idle"].includes(data.state)) {
      const previous = viewerId; viewerId = ""; leaseVisibility = ""; release(previous, "remote-ended");
      if (data.state === "idle") currentError = "The visualizer stopped on the PC. Select Start visuals to reconnect.";
    }
    render();
  }
  function render() {
    settingsButton.hidden = !canOpenSettings();
    $("lyrionVisualSettingsNotice").hidden = mode !== "artwork";
    if (settingsOpen && (!fullscreen() || !sourceVisible() || stage.getClientRects().length === 0)) closeSettings(false);
    panel.hidden = !(fullscreen() && sourceVisible() && mode === "visualizer"); stage.dataset.centerView = mode;
    choices.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.lyrionView === mode)));
    const running = !!viewerId && remote.state === "running" && !loading && (!media || media.ready());
    controlsExpand.hidden = !running || !viewPresent(); controlsExpand.disabled = !running || !visible();
    surface.tabIndex = running && visible() ? 0 : -1; expand.disabled = !running || !visible();
    if (!running || !viewPresent()) leaveImmersive(false);
    if (!running || !visible()) hideControls();
    inputAvailable = canUseInput();
    captureAvailable = canUseTransport();
    toggle.textContent = loading ? "Cancel start" : viewerId ? "Stop visuals" : "Start visuals";
    toggle.disabled = (!visible() && !canStartFromSettings()) || ((!available || !captureAvailable || !inputAvailable || !canUseTheme()) && !viewerId);
    themeField.hidden = themeHelp.hidden = renderer.value !== "whitecap";
    whitecapTheme.disabled = loading || !!viewerId;
    themeHelp.textContent = viewerId ? "Stop visuals to change the WhiteCap theme. Your saved startup theme stays unchanged." :
      !canUseTheme() ? "The NASA layer collection is unavailable. Refresh inputs, or choose Current custom theme." :
      "Choose a theme, then Start visuals. NASA layers rotates Cosmic Cliffs, Horsehead and the deep-field control. Your saved startup theme stays unchanged.";
    renderer.disabled = loading || !available; input.disabled = loading || !audioInputs.length;
    transport.disabled = loading; transport.title = transportEntries().find(value => value.id === transport.value)?.nativeName || "";
    $("lyrionVisualRefresh").disabled = loading || !canInspect();
    freeze.textContent = paused ? "Resume visuals" : "Pause visuals";
    freeze.disabled = !visible() || (!viewerId && !paused) || (paused && (!available || !captureAvailable || !inputAvailable || !canUseTheme()));
    freeze.setAttribute("aria-pressed", String(paused)); $("lyrionVisualEmpty").hidden = running;
    panel.setAttribute("aria-busy", String(loading || (!!viewerId && remote.state === "starting")));
    settingsBody.setAttribute("aria-busy", String(loading || (!!viewerId && remote.state === "starting") || (!inputsKnown && !!controller && !inventoryError)));
    const selected = selectedInput(), noMic = selected?.kind === "no-mic", musicFeed = selected?.kind === "music-feed";
    const activeNoMic = remote.inputKind === "no-mic" || (!remote.inputKind && noMic), activeMusicFeed = remote.inputKind === "music-feed" || (!remote.inputKind && musicFeed);
    input.title = selectedInput()?.name || "";
    if (!inputsKnown) options(input, [], "", currentError ? "Could not load inputs · Refresh inputs" : "Loading inputs…");
    $("lyrionVisualHint").textContent = !inputsKnown ? currentError ? "Audio inputs could not be loaded. Select Refresh inputs to try again." : "Loading SoundSpectrum audio inputs…" : noMic ? "SoundSpectrum’s built-in sound generator uses no microphone and does not listen to your music. Playback stays unchanged." : musicFeed ? copy.hint : "The microphone on the Rabbit Hole PC feeds the visuals. Playback stays unchanged.";
    let status = inputsKnown ? "Visuals stopped" : "Loading audio inputs…";
    let reason = !inputsKnown ? "Checking SoundSpectrum’s available audio inputs…" : noMic ? "Select Start visuals to run " + selected.name + ". No microphone is needed." : musicFeed ? copy.start : "Select a visualizer and Start visuals to use the PC microphone.";
    if (currentError) { status = currentError.includes("browser could not hold") ? "Browser buffer limit reached" : currentError.includes("buffer did not fill") ? "Playback buffer could not fill" : "SoundSpectrum unavailable"; reason = currentError; }
    else if (!inputsKnown) { /* Availability has not been checked yet. Keep the loading state. */ }
    else if (!available) { status = "SoundSpectrum unavailable"; reason = "No supported SoundSpectrum visualizer is available on the PC."; }
    else if (inputsKnown && !inputAvailable && !viewerId) { status = musicFeed ? "Music feed unavailable" : "Audio input unavailable"; reason = musicFeed ? selected.available === false ? selected.reason || "The experimental music feed is unavailable. Refresh inputs after enabling it on the PC." : copy.missingTarget : "No audio input is available. Refresh inputs, or connect a microphone on the Rabbit Hole PC."; }
    else if (!captureAvailable) { status = "Video transport unavailable"; reason = transport.title || remote.reason || "The SoundSpectrum video bridge is unavailable on the PC."; }
    else if (paused) { status = "Visuals paused"; reason = "Select Resume visuals to start SoundSpectrum again."; }
    else if (loading || (viewerId && remote.state === "starting")) { status = "Starting SoundSpectrum…"; reason = "Opening " + (names[renderer.value] || "SoundSpectrum") + (noMic ? " with " + selected.name + "…" : musicFeed ? " with the experimental music feed…" : " with the PC microphone…"); }
    else if (viewerId && media && (media === hlsMedia || media === wcMedia) && !media.ready()) {
      status = "Filling playback buffer…"; reason = "Video will start when the selected playback buffer is ready.";
    }
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
    settingsReason.textContent = reason; settingsReason.hidden = (panel.hidden && !settingsOpen) || $("lyrionVisualEmpty").hidden;
    toggle.setAttribute("aria-describedby", elementId("VisualHint") + (settingsReason.hidden ? "" : " " + settingsReason.id));
    renderBufferStatus();
    renderHlsStatus();
    fidelity?.render();
  }
  async function request(body, signal) {
    const response = await fetch("/api/soundspectrum/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (!response.ok) throw Object.assign(Error("SoundSpectrum could not be reached. Try again."), { statusCode: response.status });
      throw error;
    }
    if (!response.ok) throw Object.assign(Error(data.error || "SoundSpectrum could not be reached. Try again."), { statusCode: response.status });
    return data;
  }
  async function start({ fromSettings = false } = {}) {
    const artworkStart = fromSettings && canStartFromSettings();
    if ((!visible() && !artworkStart) || !available || !captureAvailable || !canUseInput() || !canUseTheme()) return;
    if (transport.value === "webcodecs") {
      const rate = Number(wcBitrate.value), size = Number(wcBuffer.value);
      if (![60,120].includes(Number(wcFps.value)) || !validHlsBitrate(rate) || ![1,2,4,8,16,32,50,75,100,250,500,750,1000].includes(size) || ![500,750,1000,1500,2000].includes(Number(wcTime.value))) {
        currentError = "Enter a whole-number WebCodecs bitrate from 50 to 600 Mbps and choose a buffer."; render(); return;
      }
    }
    if (transport.value === "hls" && !validHlsBitrate(Number(hlsBitrate.value))) {
      hlsBitrate.setAttribute("aria-invalid", "true"); currentError = "Enter a whole-number HLS bitrate from 50 to 600 Mbps."; render(); hlsBitrate.focus?.(); return;
    }
    if (transport.value === "hls") hlsBitratePreference = Number(hlsBitrate.value);
    // Only an explicit Start tap can promote Artwork. Keep the same dialog,
    // selections and viewer machinery; passive settings never choose a view.
    if (artworkStart) selectView("visualizer", { dismissSettings: false, save: true });
    const previous = viewerId; cancelPoll(); clearVideo(); release(previous, "selection-change");
    const id = randomViewer(), current = ++revision; viewerId = id; leaseVisibility = ""; paused = false; loading = true; currentError = ""; inventoryError = false; render();
    stage.dataset.lastStartAt = String(Date.now()); stage.dataset.lastHeartbeatAt = ""; stage.dataset.lastHeartbeatError = "";
    stage.dataset.lastHeartbeatDurationMs = ""; stage.dataset.lastHlsFrameAgeMs = "";
    heartbeatRetryCount = 0; stage.dataset.heartbeatRetryCount = "0"; stage.dataset.heartbeatRetrying = "false";
    const selection = renderer.value, inputId = input.value, playerId = selectedInput()?.kind === "music-feed" ? selectedPlayer() : "";
    feedPlayer = playerId; startedTarget = selectedPlayer();
    const pending = new AbortController(); controller = pending;
    const requestedVisibility = leaseVisibilityValue();
    const timeout = setTimeout(() => pending.abort(), 10000);
    try { localStorage.setItem(storagePrefix + ".soundSpectrum", selection); } catch {}
    preferred = selection;
    try {
      const selectedTransport = transport.value === "webcodecs" ? "hls" : transport.value || "jpeg";
      const selectedFps = transport.value === "webcodecs" ? Number(wcFps.value) : 60;
      const selectedBitrate = transport.value === "webcodecs" ? Number(wcBitrate.value) : hlsBitratePreference;
      if (transport.value === "webcodecs") { wcMedia?.setFrameRate?.(selectedFps); wcMedia?.setPlaybackBuffer?.(Number(wcTime.value)); wcMedia?.setBufferTarget(Number(wcBuffer.value)); wcMedia?.setBitrateTarget(selectedBitrate); }
      const join = ["obs-webrtc", "hls"].includes(selectedTransport) && (remote.whitecapTheme || "current") === selectedTheme() && (selectedTransport !== "hls" || remote.videoStats?.configuredBitrateMbps === selectedBitrate && (remote.videoStats?.targetFps || 60) === selectedFps) && remote.state === "running" && remote.transport === selectedTransport && remote.visualizer === selection && remote.inputId === inputId &&
        Number.isSafeInteger(remote.generation) && (!playerId || remote[config.targetParam || "playerId"] === playerId);
      const data = await request({ action: join ? "join" : "start", visualizer: selection, inputId, viewerId: id, transport: selectedTransport,
        ...(selectedTheme() !== "current" ? { whitecapTheme: selectedTheme() } : {}),
        ...(selectedTransport === "hls" ? { bitrateMbps: selectedBitrate, targetFps: selectedFps } : {}),
        ...(join ? { generation: remote.generation } : {}), ...(playerId ? { [config.targetParam || "playerId"]: playerId } : {}) }, pending.signal);
      if (current !== revision || viewerId !== id || !viewPresent()) { release(id, "start-cancelled"); return; }
      leaseVisibility = requestedVisibility;
      loading = false; accept(data); schedule(4000);
    } catch (error) {
      release(id, "start-error");
      if (current !== revision || viewerId !== id) return;
      viewerId = ""; loading = false; currentError = error.name === "AbortError" ? "SoundSpectrum timed out. Select Start visuals to reconnect." : error.message; render(); schedule(8000);
    } finally { clearTimeout(timeout); if (controller === pending) controller = null; if (current === revision) renewLeaseVisibility(); }
  }
  function renewLeaseVisibility() {
    if (!viewerId || loading || controller || !viewPresent() || leaseVisibility === leaseVisibilityValue()) return false;
    clearTimeout(timer); timer = null; stage.dataset.nextPollAt = "";
    void poll();
    return true;
  }
  function schedule(delay = 4000) {
    clearTimeout(timer); timer = null; stage.dataset.nextPollAt = "";
    if (canPoll() && !loading) { stage.dataset.nextPollAt = String(Date.now() + delay); timer = setTimeout(poll, delay); }
  }
  async function poll(refresh = false) {
    stage.dataset.lastPollAt = String(Date.now()); stage.dataset.nextPollAt = "";
    stage.dataset.lastPollVisibility = visibility(); stage.dataset.lastPollHidden = String(document.hidden);
    stage.dataset.lastPollSkipReason = !canInspect() ? "view-hidden" : !canPoll() ? "document-hidden" : loading ? "loading" : controller ? "in-flight" : "";
    if (!canPoll() || loading || controller) return;
    const current = revision, id = viewerId, heartbeat = !!id && !refresh, pending = new AbortController(); controller = pending;
    const generation = remote.generation, receiver = media, requestStartedAt = Date.now();
    let retryHeartbeat = false, heartbeatRequestComplete = false;
    render();
    const requestedVisibility = leaseVisibilityValue();
    const timeout = setTimeout(() => pending.abort(), 10000);
    try {
      let data;
      if (heartbeat) {
        data = await request({ action: "heartbeat", viewerId: id, visibility: requestedVisibility, videoStats: heartbeatVideoStats() }, pending.signal);
        heartbeatRequestComplete = true;
      }
      else {
        const query = new URLSearchParams(); if (refresh) query.set("refresh", "1"); if (id) query.set("viewerId", id);
        const response = await fetch("/api/soundspectrum/status" + (query.size ? "?" + query : ""), { signal: pending.signal, cache: "no-store" }); data = await response.json();
        if (!response.ok) throw Error(data.error || "SoundSpectrum could not be reached. Try again.");
      }
      if (current !== revision || id !== viewerId || controller !== pending || !canInspect()) return;
      if (heartbeat) {
        leaseVisibility = requestedVisibility; stage.dataset.lastHeartbeatAt = String(Date.now()); stage.dataset.lastHeartbeatError = "";
        stage.dataset.lastHeartbeatDurationMs = String(Math.min(600000, Math.max(0, Math.round(Date.now() - requestStartedAt))));
        stage.dataset.heartbeatRetrying = "false"; freshHlsHeartbeat(generation, receiver);
      }
      if (!heartbeat && inventoryError) { currentError = ""; inventoryError = false; }
      accept(data);
    } catch (error) {
      if (current !== revision || id !== viewerId || controller !== pending || !canInspect()) return;
      if (heartbeat) {
        const name = ["AbortError", "TypeError", "SyntaxError"].includes(error.name) ? error.name : "Error";
        stage.dataset.lastHeartbeatError = name + (Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599 ? ":" + error.statusCode : "");
        stage.dataset.lastHeartbeatDurationMs = String(Math.min(600000, Math.max(0, Math.round(Date.now() - requestStartedAt))));
        const freshHls = freshHlsHeartbeat(generation, receiver);
        // Media delivery can outlive a delayed control request. Retry that same
        // viewer only while actual foreground HLS frame progress proves it alive.
        if (!heartbeatRequestComplete && ["AbortError", "TypeError"].includes(error.name) && error.statusCode === undefined && freshHls) {
          retryHeartbeat = true; heartbeatRetryCount = Math.min(2147483647, heartbeatRetryCount + 1);
          stage.dataset.heartbeatRetryCount = String(heartbeatRetryCount); stage.dataset.heartbeatRetrying = "true";
          return;
        }
      }
      currentError = error.name === "AbortError" ? "SoundSpectrum timed out. Select Start visuals to reconnect." : error.message;
      if (!heartbeat) { inventoryError = true; if (error.name === "AbortError") currentError = "Audio input discovery timed out. Select Refresh inputs to try again."; }
      const previous = viewerId; viewerId = ""; leaseVisibility = ""; clearVideo(); release(previous, "heartbeat-error"); render();
    } finally {
      clearTimeout(timeout); const completedCurrent = controller === pending; if (completedCurrent) controller = null;
      if (completedCurrent && current === revision) { render(); if (canPoll() && !renewLeaseVisibility()) schedule(viewerId ? retryHeartbeat ? 1000 : 4000 : 8000); }
    }
  }
  function sync() {
    const wasHidden = stage.dataset.lastSyncHidden === "true";
    stage.dataset.lastSyncAt = String(Date.now()); stage.dataset.lastSyncVisibility = visibility();
    stage.dataset.lastSyncHidden = String(document.hidden); stage.dataset.lastSyncVisible = String(visible());
    if (!viewPresent() && (viewerId || loading)) stop({ reason: sourceVisible() ? "view-hidden" : "source-change" });
    if (!canPoll()) cancelPoll();
    render(); if (wasHidden && !document.hidden) showControls();
    if (!renewLeaseVisibility() && canPoll() && !timer && !controller && !loading) schedule(0);
  }
  function selectView(value, { dismissSettings = true, save = false } = {}) {
    if (!["artwork", "visualizer"].includes(value)) return;
    if (mode !== value && dismissSettings) closeSettings(false);
    mode = value;
    if (save) { try { localStorage.setItem(storagePrefix + ".centerView", mode); } catch {} }
    sync();
  }
  for (const button of choices.querySelectorAll("button")) button.onclick = () => selectView(button.dataset.lyrionView, { save: true });
  toggle.onclick = () => { if (viewerId || loading) { currentError = ""; stop(); } else void start({ fromSettings: true }); };
  freeze.onclick = () => { if (paused) void start(); else stop({ pause: true, reason: "pause" }); };
  $("lyrionVisualRefresh").onclick = () => { currentError = ""; inventoryError = false; revision++; cancelPoll(); void poll(true); };
  renderer.onchange = () => {
    preferred = renderer.value; try { localStorage.setItem(storagePrefix + ".soundSpectrum", preferred); } catch {}
    updateInputs(["microphone", "music-feed"].includes(selectedInput()?.kind) ? input.value : ""); updateTransports(); render();
    if (viewerId) { if (inputAvailable && captureAvailable && !document.hidden) void start(); else stop({ reason: "selection-change" }); }
  };
  whitecapTheme.onchange = () => {
    if (viewerId || loading) { whitecapTheme.value = themePreference; return; }
    themePreference = whitecapTheme.value === "nasa-layers" ? "nasa-layers" : "current";
    whitecapTheme.value = themePreference;
    try { localStorage.setItem(storagePrefix + ".whitecapTheme", themePreference); } catch {}
    currentError = ""; render();
  };
  input.onchange = () => {
    if (selectedInput()?.kind === "no-mic") { try { localStorage.setItem(storagePrefix + ".soundSpectrumInput." + renderer.value, input.value); } catch {} }
    render(); if (viewerId) { if (inputAvailable && !document.hidden) void start(); else stop({ reason: "selection-change" }); }
  };
  transport.onchange = () => {
    transportChosen = true;
    try { localStorage.setItem(storagePrefix + ".soundSpectrumTransport", transport.value); } catch {}
    if (viewerId || loading) stop({ reason: "selection-change" }); else render();
  };
  buffer.onchange = () => {
    bufferPreference = buffer.value === "automatic" ? "automatic" : "250"; buffer.value = bufferPreference;
    try { localStorage.setItem(bufferStorageKey, bufferPreference); bufferStoredValue = bufferPreference; } catch {}
    try { rtcMedia?.setBufferTarget?.(bufferPreference === "automatic" ? null : 250); } catch {}
    renderBufferStatus();
  };
  hlsBitrate.onchange = () => {
    const value = Number(hlsBitrate.value);
    hlsBitrate.setAttribute("aria-invalid", String(!validHlsBitrate(value)));
    if (!validHlsBitrate(value)) { currentError = "Enter a whole-number HLS bitrate from 50 to 600 Mbps."; render(); return; }
    hlsBitratePreference = value; currentError = "";
    try { localStorage.setItem(hlsBitrateKey, String(value)); } catch {}
    render();
  };
  hlsBuffer.onchange = () => {
    const value = Number(hlsBuffer.value);
    hlsBufferPreference = [1, 2, 4, 8, 16, 32, 50, 75, 100, 250, 500, 750, 1000].includes(value) ? value : 32;
    hlsBuffer.value = String(hlsBufferPreference);
    try { localStorage.setItem(hlsBufferKey, String(hlsBufferPreference)); hlsBufferStoredValue = String(hlsBufferPreference); } catch {}
    try { hlsMedia?.setBufferTarget?.(hlsBufferPreference); } catch {}
    renderHlsStatus();
  };
  wcFps.onchange = () => { if ([60,120].includes(Number(wcFps.value))) { try { localStorage.setItem("soundSpectrum.webcodecsFps", wcFps.value); } catch {} } };
  wcBitrate.onchange = wcBuffer.onchange = wcTime.onchange = () => {
    const rate = Number(wcBitrate.value), size = Number(wcBuffer.value);
    wcBitrate.setAttribute("aria-invalid", String(!validHlsBitrate(rate)));
    if (!validHlsBitrate(rate)) { currentError = "Enter a whole-number WebCodecs bitrate from 50 to 600 Mbps."; render(); return; }
    currentError = "";
    try { localStorage.setItem("soundSpectrum.webcodecsBitrateMbps", String(rate)); localStorage.setItem("soundSpectrum.webcodecsBufferMB", String(size)); localStorage.setItem("soundSpectrum.webcodecsBufferMs", wcTime.value); } catch {}
    renderWcStatus();
  };
  function playerChanged() {
    if ((viewerId || loading) && ((selectedInput()?.kind === "music-feed" && (!canUseInput() || (feedPlayer && feedPlayer !== selectedPlayer()))) ||
      (config.stopOnTargetChange && startedTarget !== selectedPlayer()))) stop({ reason: "source-change" });
    else render();
  }
  config.targetSelect?.addEventListener("change", playerChanged);
  for (const event of config.targetEvents || []) stage.addEventListener(event, playerChanged);
  new MutationObserver(sync).observe(stage, { attributes: true, attributeFilter: ["class"] });
  for (const entry of config.observe || []) {
    if (entry.target) new MutationObserver(sync).observe(entry.target, { attributes: true, attributeFilter: entry.attributes || ["hidden", "class"] });
  }
  document.addEventListener("visibilitychange", sync); window.addEventListener("pageshow", sync); window.addEventListener("online", sync);
  window.addEventListener("pagehide", () => { stop({ reason: "pagehide" }); cancelPoll(); }); sync();
  return { sync, stop, setView(value) { selectView(value); } };
};
