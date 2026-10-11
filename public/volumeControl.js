"use strict";
(() => {
  // One volume row for both Now Playing rails. The caller owns the transport:
  // set(level) on slider release, step(delta) for the buttons.
  window.createVolumeControl = function (root, { set, step }) {
    const make = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node; };
    const label = make("span", "volumeLabel", "Volume");
    const down = make("button", "volumeStep", "−"), up = make("button", "volumeStep", "+");
    const slider = make("input", "volumeSlider"), readout = make("output", "volumeReadout");
    down.type = up.type = "button"; slider.type = "range";
    down.setAttribute("aria-label", "Volume down"); up.setAttribute("aria-label", "Volume up"); slider.setAttribute("aria-label", "Volume");
    root.replaceChildren(label, down, slider, up, readout);
    let current = null, held = false, sent = null, sentAt = 0;
    const text = (volume, value) => `${value}${volume.type === "db" ? " dB" : ""}${volume.is_muted ? " · Muted" : ""}`;
    slider.addEventListener("pointerdown", () => { held = true; });
    slider.addEventListener("input", () => { if (current) readout.textContent = text(current, slider.value); });
    slider.addEventListener("change", () => { held = false; sent = Number(slider.value); sentAt = Date.now(); set(sent); });
    down.addEventListener("click", () => step(-1));
    up.addEventListener("click", () => step(1));
    function update(volume) {
      current = volume || null;
      root.hidden = !current;
      if (!current) return;
      const level = current.value === undefined || current.value === null ? null : Number(current.value);
      slider.hidden = readout.hidden = level === null;
      if (level === null) return;
      slider.min = String(current.min ?? 0); slider.max = String(current.max ?? 100); slider.step = String(current.step ?? 1);
      if (held) return;
      if (sent !== null && level !== sent && Date.now() - sentAt < 3000) return;
      sent = null;
      slider.value = String(level);
      readout.textContent = text(current, level);
    }
    return { update };
  };
})();
