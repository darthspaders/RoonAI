"use strict";
(() => {
  const select = document.getElementById("zoneSelect"), topbar = document.querySelector(".topbar");
  if (!select || !topbar) return;
  const row = document.createElement("div");
  row.id = "roonZoneBar";
  row.className = "roonZoneBar";
  const label = document.createElement("span");
  label.className = "roonZoneLabel";
  label.textContent = "Roon Zone";
  const group = document.createElement("div");
  group.className = "lyrionChoices";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Roon Zone");
  row.append(label, group);
  topbar.before(row);
  let drawn = "";
  function render() {
    const zones = [...select.options].filter((option) => option.value).map((option) => [option.value, option.textContent]);
    const key = JSON.stringify([zones, select.value]);
    if (key === drawn) return;
    drawn = key;
    const focused = group.contains(document.activeElement) ? document.activeElement.dataset.zoneId : null;
    group.replaceChildren(...zones.map(([id, name]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.dataset.zoneId = id;
      button.setAttribute("aria-pressed", String(id === select.value));
      button.onclick = () => {
        select.value = id;
        select.dispatchEvent(new Event("change"));
        render();
      };
      return button;
    }));
    if (focused) [...group.children].find((button) => button.dataset.zoneId === focused)?.focus();
    row.hidden = !zones.length;
  }
  select.addEventListener("change", render);
  new MutationObserver(render).observe(select, { childList: true, subtree: true });
  render();
})();
