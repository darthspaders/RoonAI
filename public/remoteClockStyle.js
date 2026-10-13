"use strict";

// Shared by the settings page and Ratings Remote on the same browser/origin.
(() => {
  const key = "rabbitRemoteClockStyle", listeners = new Set();
  let current = "seven";
  const normalize = value => value === "matrix" ? "matrix" : "seven";
  function read() { try { return normalize(localStorage.getItem(key)); } catch { return current; } }
  function notify(value) {
    if (value === current) return;
    current = value;
    for (const listener of listeners) listener(value);
  }
  current = read();
  const preference = {
    get: () => current,
    set(value) {
      const next = normalize(value); let saved = true;
      try { localStorage.setItem(key, next); } catch { saved = false; }
      notify(next);
      return saved;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    mount(container, prefix) {
      const fields = document.createElement("div"); fields.className = "lyrionVisualFields";
      const label = document.createElement("label"); label.textContent = "Remote clock style";
      const select = document.createElement("select"); select.id = `${prefix}RemoteClockStyle`; label.htmlFor = select.id;
      for (const [value, title] of [["matrix", "Matrix"], ["seven", "Standard · seven-segment"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = title; select.append(option);
      }
      const help = document.createElement("p"); help.id = `${prefix}RemoteClockStyleHelp`; help.className = "muted";
      const description = "Saved for this browser. Use the same Rabbit Hole address for settings and the remote.";
      help.textContent = description; select.setAttribute("aria-describedby", help.id);
      select.value = current;
      select.addEventListener("change", () => {
        help.textContent = preference.set(select.value) ? description : "Applied here, but this browser could not save the choice. Allow site storage to use it on the remote.";
      });
      preference.subscribe(value => { select.value = value; });
      label.append(select); fields.append(label); container.append(fields, help);
    }
  };
  window.rabbitRemoteClockStyle = preference;
  window.addEventListener("storage", event => { if (event.key === key || event.key === null) notify(read()); });
  window.addEventListener("pageshow", () => notify(read()));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) notify(read()); });
})();
