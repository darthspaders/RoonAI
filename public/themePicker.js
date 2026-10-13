"use strict";

(function () {
  const select = document.getElementById("themeSelect");
  if (!select) return;
  const saved = (/(?:^|;\s*)rh_theme=([a-z0-9-]+)/.exec(document.cookie) || [])[1];

  fetch("/api/themes")
    .then((response) => response.json())
    .then(({ themes, default: fallback }) => {
      for (const theme of themes) {
        const option = document.createElement("option");
        option.value = theme.id;
        option.textContent = theme.label;
        select.append(option);
      }
      select.value = themes.some((theme) => theme.id === saved) ? saved : fallback;
    })
    .catch(() => {
      select.disabled = true;
    });

  select.addEventListener("change", () => {
    document.cookie = `rh_theme=${select.value}; path=/; max-age=31536000; samesite=lax`;
    location.reload();
  });
})();
