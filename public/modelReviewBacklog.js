"use strict";
(() => {
  if (window.ModelReviewBacklogUi) return;
  const mounts = new WeakMap();
  const POLL_MS = 45000;
  const REQUEST_MS = 10000;
  let sequence = 0;
  const text = value => ["string", "number", "boolean"].includes(typeof value) ? String(value).slice(0, 3000) : "";
  const number = value => Math.max(0, Math.trunc(Number(value) || 0)).toLocaleString();

  function mount(root) {
    if (!root) return null;
    const previous = mounts.get(root);
    if (previous && root.contains(previous.element)) { previous.syncVisibility(); return previous; }
    previous?.destroy();
    const document = root.ownerDocument;
    const prefix = root.id || `modelReviewBacklog${++sequence}`;
    const create = (tag, value = "", className = "") => {
      const element = document.createElement(tag);
      if (value) element.textContent = value;
      if (className) element.className = className;
      return element;
    };
    const panel = create("div");
    const heading = create("h3", "Model review backlog");
    heading.id = `${prefix}-heading`;
    root.setAttribute("aria-labelledby", heading.id);
    const introduction = create("p", "Missed reviews catch up when your model is ready. Original ratings and decisions stay unchanged.", "muted");
    const status = create("p", "Open Taste to check the review backlog.");
    status.id = `${prefix}-status`;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    const counts = create("p", "", "muted");
    const controls = create("div", "", "resultActions");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Model review backlog controls");
    const buttons = {};
    for (const [action, label] of [["review", "Review backlog"], ["pause", "Pause"], ["refresh", "Refresh status"]]) {
      const button = create("button", label);
      button.type = "button";
      button.dataset.backlogAction = action;
      button.setAttribute("aria-describedby", status.id);
      button.style.minHeight = "44px";
      button.style.minWidth = "44px";
      controls.append(button);
      buttons[action] = button;
    }
    const scope = create("p", "Reviews completed afterward are excluded from historical accuracy.", "muted");
    const context = create("p", "", "muted");
    const results = create("div");
    results.setAttribute("role", "region");
    const resultsHeading = create("h4", "Reviewed afterward");
    resultsHeading.id = `${prefix}-results`;
    results.setAttribute("aria-labelledby", resultsHeading.id);
    const list = create("ol", "", "reportList");
    list.style.padding = "0";
    const empty = create("p", "No later model reviews yet. Completed catch-up reviews will appear here.", "muted");
    results.append(resultsHeading, list, empty);
    panel.append(heading, introduction, controls, status, counts, scope, context, results);
    root.append(panel);

    let snapshot = null, error = "", inFlight = null, timer = null, disposed = false;
    let awaitingApi = root.hasAttribute("data-await-backlog-api");
    let forcedVisible = true, pageVisible = true, wasVisible = false, resultsKey = "";
    const view = root.closest(".view");
    function visible() {
      if (disposed || !pageVisible || !forcedVisible || document.hidden || (root.hidden && !awaitingApi) || root.isConnected === false) return false;
      if (view && !view.classList.contains("isActive")) return false;
      for (let node = root; node; node = node.parentElement) if (node.hidden && (node !== root || !awaitingApi)) return false;
      const surface = awaitingApi ? view || root.parentElement : root;
      return !surface?.getClientRects || surface.getClientRects().length > 0;
    }
    function remaining() {
      const value = snapshot?.pendingCount;
      return value === undefined ? Number(snapshot?.counts?.pending || 0) + Number(snapshot?.counts?.waiting_model || 0) : Number(value || 0);
    }
    function statusText() {
      if (error) return error;
      if (inFlight?.kind === "review") return "Requesting backlog review.";
      if (inFlight?.kind === "pause") return "Pausing backlog review.";
      if (!snapshot) return inFlight ? "Checking review backlog." : "Review backlog status is unavailable. Refresh status to try again.";
      if (snapshot.state === "blocked") return `Review backlog needs attention.${snapshot.lastError ? ` ${text(snapshot.lastError)}` : " Refresh status or select Review backlog to try again."}`;
      if (snapshot.paused || snapshot.state === "paused") return "Paused. Select Review backlog to resume.";
      if (snapshot.running || snapshot.state === "running") return "Reviewing backlog. Original feedback stays unchanged.";
      if (snapshot.state === "foreground_busy") return "Waiting for the current model request to finish.";
      if (snapshot.state === "waiting_model" || (snapshot.modelReady === false && remaining() > 0)) return "Waiting for your model to be ready. It will not be loaded automatically.";
      if (["stopped", "cancelled"].includes(snapshot.state)) return "Backlog review stopped. Select Review backlog to continue.";
      if (remaining() > 0) return "Pending reviews catch up automatically when the model is ready.";
      if (Number(snapshot.failedCount ?? snapshot.counts?.failed ?? 0) > 0) return "Some reviews need another attempt. Select Review backlog to retry.";
      return "No reviews waiting.";
    }
    function reviewRow(item, index) {
      const row = create("li", "", "reportRow");
      const marker = create("span", String(index + 1), "rowIndex");
      marker.setAttribute("aria-hidden", "true");
      const body = create("div");
      const title = create("strong", [text(item.artist), text(item.title)].filter(Boolean).join(" — ") || "Saved feedback");
      title.style.whiteSpace = "normal";
      title.style.overflowWrap = "anywhere";
      title.style.overflow = "visible";
      body.append(title);
      const line = (value, className = "muted") => {
        const p = create("p", value, className);
        p.style.margin = "4px 0";
        p.style.whiteSpace = "normal";
        p.style.overflowWrap = "anywhere";
        body.append(p);
      };
      const original = [`Original rating: ${text(item.rating) || "Not recorded"}`];
      if (text(item.originalModelAction)) original.push(`Original model action: ${text(item.originalModelAction)}`);
      if (item.originalScore !== undefined && item.originalScore !== null) original.push(`Original score: ${text(item.originalScore)}`);
      if (item.originalModelScore !== undefined && item.originalModelScore !== null) original.push(`Original model score: ${text(item.originalModelScore)}`);
      line(original.join(" · "));
      const score = item.result?.scores?.[0];
      const assessment = score?.rejected === true ? "Rejected afterward" : "Assessed afterward";
      line(`${assessment}${score?.finalScore !== undefined && score?.finalScore !== null ? ` · Score: ${text(score.finalScore)}` : " · No score saved"}`);
      const model = [text(item.provider), text(item.model || item.result?.model)].filter(Boolean).join(" / ") || "Not recorded";
      const at = item.reviewedAt ? new Date(item.reviewedAt) : null;
      const time = at && Number.isFinite(at.getTime()) ? at.toLocaleString() : text(item.reviewedAt) || "Not recorded";
      line(`Reviewed afterward · Model: ${model} · Time: ${time}`);
      const quality = item.contextQuality || item.result?.contextQuality;
      line(quality === "metadata-only" ? "Metadata-only review: original request unavailable."
        : quality === "original-request" ? "Original request context available." : "Original request context not recorded.");
      const reason = text(score?.rejectionReason) || (Array.isArray(score?.why) ? score.why.map(text).filter(Boolean).join(" ") : "");
      if (reason) line(reason);
      row.append(marker, body);
      return row;
    }
    function render() {
      results.setAttribute("aria-busy", String(Boolean(inFlight)));
      status.textContent = statusText();
      const paused = snapshot?.paused || snapshot?.state === "paused";
      const running = snapshot?.running || snapshot?.state === "running";
      const failed = Number(snapshot?.failedCount ?? snapshot?.counts?.failed ?? 0);
      buttons.review.disabled = Boolean(awaitingApi || inFlight || (!snapshot && !error) || (snapshot && !paused && (running || (remaining() === 0 && failed === 0))));
      buttons.pause.disabled = Boolean(awaitingApi || inFlight || !snapshot || paused);
      buttons.refresh.disabled = Boolean(inFlight);
      counts.textContent = snapshot ? `${number(remaining())} pending · ${number(snapshot.completedCount ?? snapshot.counts?.completed)} reviewed afterward · ${number(failed)} failed` : "";
      const model = [text(snapshot?.model?.provider), text(snapshot?.model?.model)].filter(Boolean).join(" / ");
      context.textContent = [model ? `Selected model: ${model}.` : "", text(snapshot?.contextNote)].filter(Boolean).join(" ");
      context.hidden = !context.textContent;
      const items = Array.isArray(snapshot?.recentResults) ? snapshot.recentResults.slice(0, 10) : [];
      const key = JSON.stringify(items);
      if (key !== resultsKey) { list.replaceChildren(...items.map(reviewRow)); resultsKey = key; }
      empty.hidden = items.length > 0;
      list.hidden = !items.length;
    }
    function schedule() {
      clearTimeout(timer);
      timer = null;
      if (visible() && !inFlight) timer = setTimeout(() => request("refresh"), POLL_MS);
    }
    function request(kind) {
      if (disposed || !visible()) return Promise.resolve(null);
      if (awaitingApi && kind !== "refresh") return Promise.resolve(null);
      if (inFlight) return inFlight.promise;
      clearTimeout(timer);
      timer = null;
      error = "";
      const current = { kind, controller: new AbortController(), silent: false, cancel: null, promise: null };
      inFlight = current;
      render();
      current.promise = (async () => {
        let timeout;
        const deadline = new Promise((_, reject) => {
          current.cancel = () => { current.silent = true; current.controller.abort(); reject(new Error("Request cancelled.")); };
          timeout = setTimeout(() => { current.controller.abort(); reject(new Error("Request timed out. Refresh status before trying again.")); }, REQUEST_MS);
        });
        try {
          const payload = await Promise.race([deadline, (async () => {
            const response = await fetch(`/api/model-review/backlog${kind === "refresh" ? "" : `/${kind}`}`, {
              method: kind === "refresh" ? "GET" : "POST", cache: "no-store", signal: current.controller.signal,
              ...(kind === "refresh" ? {} : { headers: { "content-type": "application/json" }, body: "{}" })
            });
            const body = await response.json();
            if (!response.ok) throw new Error(text(body?.error) || "Backlog service is unavailable. Refresh status to try again.");
            const value = body?.status || body;
            if (!value || typeof value.state !== "string") throw new Error("Backlog status is unavailable. Refresh status to try again.");
            return value;
          })()]);
          if (!disposed && inFlight === current) {
            snapshot = payload;
            if (awaitingApi) { awaitingApi = false; root.hidden = false; root.removeAttribute("data-await-backlog-api"); }
          }
          return payload;
        } catch (failure) {
          if (!disposed && inFlight === current && !current.silent) error = window.navigator?.onLine === false
            ? "Offline. Reconnect and refresh status to try again."
            : `Could not ${kind === "pause" ? "pause reviews" : kind === "review" ? "request backlog review" : "check review backlog"}: ${text(failure.message) || "Service unavailable"}`;
          return null;
        } finally {
          clearTimeout(timeout);
          if (inFlight === current) { inFlight = null; if (!disposed) { render(); schedule(); } }
        }
      })();
      return current.promise;
    }
    function syncVisibility() {
      const shown = visible();
      if (!shown) {
        clearTimeout(timer);
        timer = null;
        if (inFlight?.kind === "refresh") { const pending = inFlight; inFlight = null; pending.cancel?.(); render(); }
      } else if (!wasVisible) request("refresh");
      wasVisible = shown;
    }
    const click = event => {
      const action = event.target.closest("[data-backlog-action]")?.dataset.backlogAction;
      if (!action || !buttons[action] || buttons[action].disabled || !root.contains(event.target)) return;
      request(action);
    };
    controls.addEventListener("click", click);
    document.addEventListener("visibilitychange", syncVisibility);
    const pageHide = () => { pageVisible = false; syncVisibility(); };
    const pageShow = () => { pageVisible = true; syncVisibility(); };
    const observer = typeof MutationObserver === "function" ? new MutationObserver(syncVisibility) : null;
    for (let node = root; observer && node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ["class", "hidden", "style"] });
    const controller = {
      element: panel, refresh: () => request("refresh"), syncVisibility,
      setVisible(value) { forcedVisible = value !== false; syncVisibility(); },
      destroy() {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        inFlight?.cancel?.();
        observer?.disconnect();
        controls.removeEventListener("click", click);
        document.removeEventListener("visibilitychange", syncVisibility);
        window.removeEventListener("pagehide", pageHide);
        window.removeEventListener("pageshow", pageShow);
        panel.remove();
        if (mounts.get(root) === controller) mounts.delete(root);
      }
    };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    mounts.set(root, controller);
    render();
    syncVisibility();
    return controller;
  }
  window.ModelReviewBacklogUi = { mount };
  const bootstrap = () => {
    const root = window.document?.getElementById?.("modelReviewBacklog");
    if (root) mount(root);
  };
  if (window.document?.readyState === "loading") window.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  else bootstrap();
  window.addEventListener("pageshow", bootstrap);
})();
