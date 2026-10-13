"use strict";
// This editor changes the shared music-analysis feed delay, before native
// rendering. It never buffers video or stores a browser-local delay.
window.createSoundSpectrumDelay = function createSoundSpectrumDelay({ container, prefix = "soundSpectrum" } = {}) {
  if (!container) return null;
  const id = suffix => prefix + "VisualDelay" + suffix;
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const editor = make("fieldset", "soundSpectrumDelay");
  editor.append(make("legend", "soundSpectrumDelayTitle", "Visual delay"));
  const hint = make("p", "soundSpectrumDelayHint muted", "Delays music-feed visuals in Aeon, G-Force and WhiteCap. Microphone and generator inputs keep their native timing.");
  hint.id = id("Hint"); editor.append(hint);
  const values = make("dl", "soundSpectrumDelayValues");
  const output = label => {
    const item = make("div"); item.append(make("dt", "", label));
    const value = make("output", "", "—"); value.id = id(label);
    value.setAttribute("aria-live", "off");
    const dd = make("dd"); dd.append(value); item.append(dd); values.append(item); return value;
  };
  const current = output("Current"), saved = output("Saved"); editor.append(values);
  const label = make("label", "soundSpectrumDelayLabel", "Preview delay (ms)");
  label.setAttribute("for", id("Input")); editor.append(label);
  const slider = make("input", "soundSpectrumDelayRange"); slider.id = id("Slider"); slider.type = "range";
  slider.min = "0"; slider.max = "5000"; slider.step = "1"; slider.value = "0";
  slider.setAttribute("aria-label", "Preview visual delay slider in milliseconds");
  slider.setAttribute("aria-describedby", id("Hint") + " " + id("Help") + " " + id("Status"));
  editor.append(slider);
  const stepper = make("div", "soundSpectrumDelayStepper");
  const minus = make("button", "", "−10"); minus.type = "button"; minus.id = id("Minus");
  minus.setAttribute("aria-label", "Decrease visual delay by 10 milliseconds");
  const input = make("input"); input.id = id("Input"); input.type = "number"; input.name = "visualDelayMs";
  input.min = "0"; input.max = "5000"; input.step = "1"; input.inputMode = "numeric"; input.autocomplete = "off";
  input.setAttribute("aria-describedby", id("Hint") + " " + id("Help") + " " + id("Status"));
  const plus = make("button", "", "+10"); plus.type = "button"; plus.id = id("Plus");
  plus.setAttribute("aria-label", "Increase visual delay by 10 milliseconds");
  stepper.append(minus); stepper.append(input); stepper.append(plus); editor.append(stepper);
  const help = make("p", "soundSpectrumDelayHelp muted", "0–5,000 ms. Preview applies live to music feeds. Save keeps it after a restart.");
  help.id = id("Help"); editor.append(help);
  const actions = make("div", "soundSpectrumDelayActions");
  const reset = make("button", "", "Reset to 0"); reset.type = "button"; reset.id = id("Reset");
  const save = make("button", "soundSpectrumDelaySave", "Save"); save.type = "button"; save.id = id("Save");
  const retry = make("button", "", "Refresh"); retry.type = "button"; retry.id = id("Refresh");
  retry.setAttribute("aria-label", "Refresh visual delay values");
  actions.append(reset); actions.append(save); actions.append(retry); editor.append(actions);
  const status = make("p", "soundSpectrumDelayStatus muted", "Open settings to load visual delay."); status.id = id("Status");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true");
  editor.append(status); container.append(editor);

  const PREVIEW_MS = 300, POLL_MS = 5000, TIMEOUT_MS = 10000;
  let state = null, visible = false, busy = false, reading = false, needsRefresh = false;
  let draftDirty = false, draftVersion = 0, preview = null, saveIntent = null, validation = "";
  let debounceTimer = null, pollTimer = null, refreshAfter = false;
  let epoch = 0, sequence = 0, latestRead = 0, acceptedSequence = 0;
  let message = status.textContent, error = false;
  const number = () => {
    const raw = String(input.value).trim();
    const value = raw === "" ? NaN : Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= (state?.maxMs || 5000) ? value : null;
  };
  const snapshot = data => {
    if (!data || typeof data.instanceId !== "string" || !data.instanceId || !Number.isSafeInteger(data.revision) || data.revision < 0) return null;
    if (![data.currentMs, data.savedMs].every(value => Number.isInteger(value) && value >= 0 && value <= 5000)) return null;
    return { currentMs: data.currentMs, savedMs: data.savedMs, revision: data.revision, instanceId: data.instanceId,
      maxMs: 5000, available: data.available !== false, settingsError: typeof data.settingsError === "string" ? data.settingsError.slice(0, 240) : "" };
  };
  function render() {
    current.textContent = state ? state.currentMs + " ms" : "—";
    saved.textContent = state?.settingsError ? "Unavailable" : state ? state.savedMs + " ms" : "—";
    const valid = number() !== null;
    const available = state?.available === true;
    input.disabled = !available;
    slider.disabled = !available;
    if (valid) slider.value = String(number());
    slider.setAttribute("aria-valuetext", slider.value + " milliseconds");
    minus.disabled = !available || (valid && number() === 0);
    plus.disabled = !available || (valid && number() === state.maxMs);
    reset.disabled = !available;
    save.disabled = !available || needsRefresh || !!saveIntent || (busy && editor.dataset.operation === "save");
    retry.hidden = !error && !needsRefresh; retry.disabled = busy || reading;
    input.setAttribute("aria-invalid", validation ? "true" : "false");
    editor.setAttribute("aria-busy", String(busy || (reading && !state)));
    editor.dataset.state = error || validation ? "error" : busy ? "pending" : !state ? "loading" : "ready";
    status.textContent = validation || message;
    status.classList.toggle("soundSpectrumDelayStatus--error", !!validation || error);
    save.textContent = busy && editor.dataset.operation === "save" ? "Saving…" : "Save";
  }
  function accept(data, requestSequence, preserveDraft = false) {
    const next = snapshot(data);
    if (!next || requestSequence < acceptedSequence || (state?.instanceId === next.instanceId && next.revision < state.revision)) return false;
    state = next; acceptedSequence = requestSequence;
    input.max = String(next.maxMs);
    if (!preserveDraft && !draftDirty && !preview && !saveIntent) input.value = String(next.currentMs);
    return true;
  }
  function idleMessage() {
    if (state?.available === false) { error = true; return "The shared music-feed delay is unavailable. Select Refresh to retry."; }
    if (state?.settingsError) { error = true; return state.settingsError; }
    return state && state.currentMs !== state.savedMs ? "Preview is active. Save to keep this value." : "Current delay is saved.";
  }
  function schedulePoll() {
    clearTimeout(pollTimer); pollTimer = null;
    if (visible) pollTimer = setTimeout(() => { pollTimer = null; refresh(false); }, POLL_MS);
  }
  async function request(options) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const response = await fetch("/api/soundspectrum/delay", { cache: "no-store", ...options, signal: abort.signal });
      const data = await response.json(); return { response, data };
    } finally { clearTimeout(timeout); }
  }
  async function refresh(explicit = true) {
    if (busy) { refreshAfter ||= explicit; schedulePoll(); return; }
    const requestSequence = ++sequence, read = ++latestRead, requestEpoch = epoch;
    reading = true;
    if (explicit || !state) { message = "Loading visual delay…"; error = false; }
    render();
    try {
      const { response, data } = await request();
      if (read !== latestRead || requestEpoch !== epoch) return;
      if (!response.ok || !accept(data, requestSequence)) throw new Error("read");
      needsRefresh = false;
      if (draftDirty && number() === state.currentMs && !preview && !saveIntent) draftDirty = false;
      if (explicit || !error) { error = false; message = idleMessage(); }
    } catch {
      if (read !== latestRead || requestEpoch !== epoch) return;
      error = true; message = state ? "Could not refresh delay. Current and saved show the last confirmed values." : "Could not load visual delay. Select Refresh to retry.";
    } finally {
      if (read === latestRead) reading = false;
      render(); schedulePoll();
    }
  }
  function validate(show = true) {
    const valid = number() !== null;
    validation = valid || !show ? "" : "Enter a whole number from 0 to 5,000 ms.";
    render(); return valid;
  }
  function edited() {
    draftVersion++; draftDirty = true; error = false; validation = "";
    clearTimeout(debounceTimer); preview = null;
    message = needsRefresh ? "Refresh to confirm the current values before trying again." : "Preview pending…";
    render();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!validate() || needsRefresh) return;
      preview = { value: number(), version: draftVersion }; pump();
    }, PREVIEW_MS);
  }
  function nudge(delta) {
    const base = number() ?? state?.currentMs ?? 0;
    input.value = String(Math.min(state?.maxMs || 5000, Math.max(0, base + delta))); edited();
  }
  function saveDraft() {
    if (!validate()) { input.focus(); return; }
    if (!state?.available || needsRefresh || saveIntent || (busy && editor.dataset.operation === "save")) return;
    clearTimeout(debounceTimer); debounceTimer = null; preview = null;
    draftDirty = true; saveIntent = { value: number(), version: draftVersion }; pump(); render();
  }
  async function pump() {
    if (busy || needsRefresh || !state) return;
    const operation = saveIntent ? { ...saveIntent, action: "save" } : preview ? { ...preview, action: "preview" } : null;
    if (!operation) return;
    if (operation.action === "save") saveIntent = null; else preview = null;
    busy = true; epoch++; const requestSequence = ++sequence;
    editor.dataset.operation = operation.action;
    error = false; message = operation.action === "save" ? "Saving visual delay…" : "Applying preview…"; render();
    try {
      const { response, data } = await request({ method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: operation.action, delayMs: operation.value, expectedRevision: state.revision, expectedInstanceId: state.instanceId }) });
      const confirmed = accept(data, requestSequence, true);
      if (!response.ok) {
        preview = null; saveIntent = null; clearTimeout(debounceTimer); debounceTimer = null;
        needsRefresh = !confirmed;
        error = true;
        message = response.status === 409 ? "Delay changed in another session. Current values are refreshed; review your preview and try again."
          : confirmed ? (operation.action === "save" ? "Could not save delay. Current preview and saved value are shown; select Save to retry." : "Could not apply preview. Current and saved values are shown; edit or select Save to retry.")
            : "Could not confirm delay. Refresh before trying again; values shown are the last confirmed.";
      } else if (!confirmed) {
        needsRefresh = true; error = true; preview = null; saveIntent = null;
        message = "Could not confirm delay. Refresh before trying again; values shown are the last confirmed.";
      } else {
        if (operation.version === draftVersion && number() === state.currentMs) draftDirty = false;
        message = idleMessage();
      }
    } catch {
      preview = null; saveIntent = null; clearTimeout(debounceTimer); debounceTimer = null;
      needsRefresh = true; error = true;
      message = "Could not confirm delay. Refresh before trying again; values shown are the last confirmed.";
    } finally {
      busy = false; editor.dataset.operation = ""; render(); pump();
      if (!busy && refreshAfter) { refreshAfter = false; refresh(); } else schedulePoll();
    }
  }
  input.addEventListener("input", edited);
  slider.addEventListener("input", () => { input.value = slider.value; edited(); });
  input.addEventListener("blur", () => { if (draftDirty) validate(); });
  input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); saveDraft(); } });
  minus.onclick = () => nudge(-10); plus.onclick = () => nudge(10);
  reset.onclick = () => { input.value = "0"; edited(); };
  save.onclick = saveDraft; retry.onclick = () => refresh(); render();
  return { refresh, setVisible(value) {
    const opening = !!value && !visible; visible = !!value;
    if (opening) refresh(); else if (!visible) { clearTimeout(pollTimer); pollTimer = null; }
  } };
};
