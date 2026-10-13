"use strict";

// Deliberately independent of every audio/video player and transport.
(() => {
  const FPS = 24, CELL = 5;
  const GLYPHS = "012345789アイウエオカキクケコサシスセソタチツテトナニヌネノ<>:+*=Z";
  function wrapText(ctx, text, width) {
    const lines = []; let line = "";
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  function shouldAnimate({ selected, visible, intersecting, reduced, suspended }) {
    return selected && visible && intersecting && !reduced && !suspended;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { wrapText, shouldAnimate, FPS };
  if (typeof document === "undefined") return;
  const canvas = document.getElementById("remoteMatrixClock");
  const preference = window.rabbitRemoteClockStyle;
  const clock = document.getElementById("remoteClock"), date = document.getElementById("remoteDate");
  const weather = document.getElementById("remoteWeatherSummary");
  if (!canvas || !clock || !date || !weather || !preference) return;
  const host = canvas.parentElement, ctx = canvas.getContext("2d");
  if (!ctx) return;
  const mask = document.createElement("canvas");
  const maskCtx = mask.getContext("2d");
  if (!maskCtx) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let selected = false, intersecting = true, suspended = false;
  let timer = 0, raf = 0, layoutRaf = 0, last = 0, regions = [], columns = [], width = 0, height = 0;
  let totalCost = 0, frames = 0, maxCost = 0, budgetStrikes = 0, staticOnly = false;
  let nextMutation = 0, mutationIndex = 0;
  const samples = new Float32Array(240); let sampleCount = 0;
  // A read-only snapshot for controlled comparisons; nothing is sent or stored.
  function stats() { return { selected,
    mode: !selected ? "seven" : staticOnly || reduced.matches ? "static" : running() ? "animated" : "paused",
    fpsCap: FPS, frames, averageDrawMs: frames ? totalCost / frames : 0, maxDrawMs: maxCost,
    recentP95DrawMs: (() => { const a = Array.from(samples.slice(0, Math.min(sampleCount, samples.length))).sort((a, b) => a-b); return a[Math.floor(a.length * .95)] || 0; })(),
    width: canvas.width, height: canvas.height, columns: columns.length
  }; }
  function publish() { canvas.dataset.matrixStats = JSON.stringify(stats()); }
  function running() {
    return !staticOnly && shouldAnimate({ selected, visible: !document.hidden, intersecting, reduced: reduced.matches, suspended });
  }
  function stop() { clearTimeout(timer); cancelAnimationFrame(raf); timer = raf = 0; last = 0; }
  function fail() {
    stop(); selected = false; canvas.hidden = true; host.classList.remove("rabbitRemoteMatrixMode");
  }
  function makeColumn(column) {
    const c = column.texture, x = c.getContext("2d");
    c.width = CELL; c.height = Math.ceil(Math.max(height * 1.6, 196) / CELL) * CELL;
    x.font = "bold 6px monospace"; x.textAlign = "center"; x.textBaseline = "top";
    x.shadowColor = "rgba(80,240,130,.45)"; x.shadowBlur = .7;
    const rows = c.height / CELL, trail = 8 + Math.floor(Math.random() * 22), head = Math.floor(Math.random() * rows);
    for (let row = 0; row < rows; row++) {
      const distance = (head - row + rows) % rows;
      const strength = distance < trail ? 1 - distance / trail : 0;
      // One continuous stream supplies both the bright lettering and dim surroundings.
      x.fillStyle = distance === 0 && Math.random() > .35 ? "#d1ffdf"
        : `rgb(${Math.round(65 + strength * 90)},${Math.round(200 + strength * 40 + Math.random() * 10)},${Math.round(85 + strength * 75)})`;
      x.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], CELL / 2, row * CELL);
    }
  }
  function schedule() {
    if (!running() || timer || raf) return;
    timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(tick); }, 1000 / FPS);
  }
  function paint(now) {
    const start = performance.now(), delta = last ? Math.min((now - last) / 1000, .1) : 0;
    last = now;
    ctx.clearRect(0, 0, width, height);
    ctx.save(); ctx.beginPath();
    for (const r of regions) ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    for (const col of columns) {
      col.offset = (col.offset + delta * col.speed) % col.texture.height;
      const y = Math.floor(col.offset);
      ctx.drawImage(col.texture, col.x, y);
      ctx.drawImage(col.texture, col.x, y - col.texture.height);
    }
    // Attenuate the rain outside the letters. The letters themselves consist
    // only of the same moving code at full brightness, never painted text.
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(mask, 0, 0, width, height);
    ctx.restore();
    if (now > nextMutation && columns.length && running()) {
      makeColumn(columns[mutationIndex++ % columns.length]); nextMutation = now + 180;
    }
    const cost = performance.now() - start;
    samples[sampleCount++ % samples.length] = cost;
    totalCost += cost; frames++; maxCost = Math.max(maxCost, cost);
    // Degrade only decoration if repeatedly expensive. This cannot certify video performance.
    budgetStrikes = cost > 4 ? budgetStrikes + 1 : Math.max(0, budgetStrikes - 1);
    if (budgetStrikes >= 8) staticOnly = true;
    if (frames % 96 === 0 || staticOnly) publish();
  }
  function tick(now) { raf = 0; if (!running()) return; try { paint(now); schedule(); } catch { fail(); } }
  function refreshActivity() {
    stop();
    publish();
    if (!selected || document.hidden || !intersecting || suspended) return;
    try { paint(performance.now()); schedule(); } catch { fail(); }
  }
  function rebuild() {
    layoutRaf = 0; if (!selected || document.hidden || suspended) return;
    try {
      const base = host.getBoundingClientRect();
      const rect = element => { const r = element.getBoundingClientRect(); return { x: r.left-base.left, y: r.top-base.top, width: r.width, height: r.height }; };
      const timeBox = rect(clock), dateBox = rect(date), weatherBox = rect(weather);
      width = Math.ceil(timeBox.width); height = Math.ceil(weatherBox.y + weatherBox.height);
      if (!width || !height) { stop(); return; }
      // Compact clock column only; cap DPR even on a 3x phone.
      const scale = Math.min(devicePixelRatio || 1, 1.25);
      for (const c of [canvas, mask]) { c.width = Math.ceil(width * scale); c.height = Math.ceil(height * scale); }
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      for (const c of [ctx, maskCtx]) c.setTransform(scale, 0, 0, scale, 0, 0);
      regions = [{ x: 0, y: 0, width, height }];
      function text(text, box, size, isTime, singleLine = isTime) {
        const font = px => `900 ${px}px Arial, sans-serif`;
        maskCtx.font = font(size);
        if (singleLine) size = Math.min(size, size * (box.width - 18) / maskCtx.measureText(text).width);
        else {
          const longestWord = Math.max(...text.split(/\s+/).map(word => maskCtx.measureText(word).width));
          size = Math.min(size, size * (box.width - 29) / longestWord);
        }
        if (isTime) size *= .95;
        maskCtx.font = font(size);
        maskCtx.textBaseline = "middle";
        maskCtx.fillStyle = maskCtx.strokeStyle = "white"; maskCtx.lineWidth = isTime ? 0 : .5;
        const lines = singleLine ? [text] : wrapText(maskCtx, text, box.width - 29);
        lines.forEach((line, i) => {
          const x = box.x + 9, y = box.y + box.height / 2 + (i - (lines.length - 1)/2) * size * 1.2;
          maskCtx.fillText(line, x, y);
          if (!isTime) maskCtx.strokeText(line, x, y);
        });
      }
      text(clock.getAttribute("datetime") || "00:00", timeBox, 76, true);
      text(date.textContent, dateBox, 26, false, true);
      text(weather.textContent.trim(), weatherBox, 22, false);
      // Invert the text mask into a cached 86% outside-only attenuation mask.
      // Interior alpha becomes zero, so the code flowing through it stays bright.
      maskCtx.globalCompositeOperation = "source-out";
      maskCtx.fillStyle = "rgba(255,255,255,.86)";
      maskCtx.fillRect(0, 0, width, height);
      maskCtx.globalCompositeOperation = "source-over";
      columns = Array.from({ length: Math.ceil(width / CELL) }, (_, i) => {
        const col = { x: i * CELL, speed: 9 + Math.random() * 19, offset: Math.random() * height, texture: document.createElement("canvas") };
        makeColumn(col); return col;
      });
      refreshActivity();
    } catch { fail(); }
  }
  function invalidate() { if (selected && !layoutRaf && !document.hidden && !suspended) layoutRaf = requestAnimationFrame(rebuild); }
  function setStyle(value) {
    selected = value === "matrix"; stop(); staticOnly = false; budgetStrikes = 0;
    host.classList.toggle("rabbitRemoteMatrixMode", selected); canvas.hidden = !selected;
    if (selected) invalidate();
    else { cancelAnimationFrame(layoutRaf); layoutRaf = 0; columns = []; }
    publish();
  }
  preference.subscribe(setStyle);
  const mutation = new MutationObserver(invalidate);
  for (const element of [clock, date, weather]) mutation.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["datetime"] });
  new ResizeObserver(invalidate).observe(host);
  const observer = new IntersectionObserver(entries => { intersecting = entries[0].isIntersecting; refreshActivity(); }, { threshold: 0 });
  observer.observe(clock);
  reduced.addEventListener("change", refreshActivity);
  document.addEventListener("visibilitychange", () => { if (document.hidden) { stop(); cancelAnimationFrame(layoutRaf); layoutRaf = 0; publish(); } else invalidate(); });
  window.addEventListener("pagehide", () => { suspended = true; stop(); cancelAnimationFrame(layoutRaf); layoutRaf = 0; publish(); });
  window.addEventListener("pageshow", () => { suspended = false; invalidate(); });
  setStyle(preference.get());
})();
