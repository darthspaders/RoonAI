"use strict";
(() => {
  const panel = document.getElementById("sonicCoveragePanel");
  const view = document.getElementById("settingsView");
  if (!panel || !view) return;
  const query = selector => panel.querySelector(selector);
  const form = query("#sonicCoverageLimits");
  let snapshot = null, busy = false, error = "", dirty = false, timer;
  const visible = () => view.classList.contains("isActive") && !document.hidden;
  const number = value => Number(value || 0).toLocaleString();

  function render() {
    const job = snapshot?.job;
    const paused = snapshot?.settings.paused;
    const unfinished = job && ["running", "paused"].includes(job.state);
    const status = error || (busy ? "Updating coverage…" : !snapshot ? "Loading coverage…"
      : snapshot.availability === "unavailable" ? "MERT-v2 FullSong provider unavailable"
      : snapshot.workerError ? `Blocked: ${snapshot.workerError}`
      : job?.state === "cancelled" ? "Backfill canceled · prepared embeddings kept; resume to continue"
      : paused ? `Paused${snapshot.activeCount ? ` · ${number(snapshot.activeCount)} active preparation(s) finishing` : ""}`
      : unfinished && !job.inventoryComplete ? "Finding known tracks…"
      : job?.state === "running" ? "Preparing audio fingerprints"
      : job?.state === "paused" ? "Backfill paused · discovery fill can continue"
      : job?.state === "failed" || job?.failed || snapshot.queueCounts.failed ? "Backfill has failures · retry available"
      : job?.state === "completed" && job.inventoryComplete && !job.remaining && !snapshot.queueDepth && !snapshot.activeCount && !snapshot.queueCounts.failed ? "Backfill complete"
      : snapshot.workStates?.retrying ? "Retrying MERT-v2 preparation after recoverable failures"
      : snapshot.queueDepth ? "Queued MERT-v2 preparation"
      : job?.state === "cancelled" ? "Backfill cancelled · completed fingerprints kept"
      : "Ready to prepare known tracks");
    query("#sonicCoverageStatus").textContent = job?.error && !error ? `${status} · ${job.error}` : status;
    panel.setAttribute("aria-busy", String(busy));
    for (const button of panel.querySelectorAll("button")) button.disabled = busy || (!snapshot && button.dataset.coverageAction !== "refresh");
    const disable = (action, condition) => { query(`[data-coverage-action="${action}"]`).disabled ||= Boolean(condition); };
    disable("start", unfinished); disable("pause", paused || !(unfinished || snapshot?.queueDepth || snapshot?.activeCount));
    disable("resume", !paused && !["paused", "cancelled", "failed"].includes(job?.state)); disable("cancel", !unfinished);
    disable("retry", !snapshot?.queueCounts.failed);
    const counts = query("#sonicCoverageCounts");
    counts.hidden = !job;
    if (job) counts.replaceChildren(...[["Total eligible",job.totalEligible],["Already embedded",job.alreadyEmbedded],["Prepared",job.preparedSuccessfully],["Failed",job.failed],["Remaining",job.remaining]].map(([label,value]) => {
      const entry = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd");
      term.textContent = label; detail.textContent = number(value); entry.append(term,detail); return entry;
    }));
    const progress = query("#sonicCoverageProgress");
    progress.hidden = !job;
    if (job) {
      progress.max = Math.max(1,job.totalEligible);
      if (job.inventoryComplete) progress.value = job.alreadyEmbedded + job.preparedSuccessfully;
      else progress.removeAttribute("value");
    }
    query("#sonicCoverageQueue").textContent = snapshot ? `MERT-v2 FullSong · ${number(snapshot.queueDepth)} queued or active · ${number(snapshot.activeCount)} active · ${number(snapshot.workStates?.retrying)} retrying · ${number(snapshot.queueCounts.failed)} failed · ${number(snapshot.queueCounts.cancelled)} canceled · Discovery fill ${snapshot.settings.lazyEnabled ? "on" : "off"}` : "";
    if (snapshot && !dirty && !form.contains(document.activeElement)) {
      for (const [name,value] of Object.entries({ batchSize:snapshot.settings.batchSize, concurrency:snapshot.settings.concurrency, intervalSeconds:snapshot.settings.minIntervalMs/1000, batchPauseSeconds:snapshot.settings.batchPauseMs/1000 })) form.elements[name].value = value;
      form.elements.lazyEnabled.checked = snapshot.settings.lazyEnabled;
    }
    const failures = query("#sonicCoverageFailures");
    failures.hidden = !(snapshot?.recentFailures?.length || snapshot?.retrying?.length);
    failures.querySelector("ul").replaceChildren(...[...(snapshot?.recentFailures || []), ...(snapshot?.retrying || [])].map(item => {
      const li = document.createElement("li"); li.textContent = `${item.identityKey}: ${item.error}${item.retryAt ? ` · retry after ${new Date(item.retryAt).toLocaleTimeString()}` : ""}`; return li;
    }));
  }

  function limits() {
    return { batchSize:Number(form.elements.batchSize.value), concurrency:Number(form.elements.concurrency.value), minIntervalMs:Number(form.elements.intervalSeconds.value)*1000, batchPauseMs:Number(form.elements.batchPauseSeconds.value)*1000, lazyEnabled:form.elements.lazyEnabled.checked };
  }

  async function request(action = "refresh", options = {}) {
    if (busy) return;
    busy = true; error = ""; render();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetch(`/api/recommendation-v2/coverage${action === "refresh" ? "" : `/${action}`}`, {
          method: action === "refresh" ? "GET" : "POST", signal:controller.signal,
          ...(action === "refresh" ? {} : { headers:{"content-type":"application/json"}, body:JSON.stringify(options) })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Coverage service is unavailable.");
        snapshot = result;
      } finally { clearTimeout(timeout); }
      if (["configure","start"].includes(action)) dirty = false;
    } catch (failure) { error = `Could not update coverage: ${failure.message}. Refresh to retry.`; }
    finally { busy = false; render(); schedule(); }
  }

  function schedule() { clearTimeout(timer); if (visible()) timer = setTimeout(() => request(), 5000); }
  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("submit", event => { event.preventDefault(); if (form.reportValidity()) request("configure",limits()); });
  panel.addEventListener("click", event => {
    const action = event.target.closest("[data-coverage-action]")?.dataset.coverageAction;
    if (!action) return;
    if (action === "start") { if (form.reportValidity()) request("start",limits()); }
    else if (action === "retry") request("resume",{retryFailed:true});
    else request(action, action === "pause" ? {scope:"all"} : action === "cancel" ? {scope:"bulk"} : {});
  });
  const shown = () => { if (visible()) request(); else clearTimeout(timer); };
  new MutationObserver(shown).observe(view,{attributes:true,attributeFilter:["class"]});
  document.addEventListener("visibilitychange",shown);
  shown();
})();
