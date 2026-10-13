"use strict";
const WHITE_CAP_THEMES = Object.freeze([
  Object.freeze({ id: "current", name: "Current custom theme", available: true }),
  Object.freeze({ id: "nasa-layers", name: "NASA layers · 3 backgrounds" })
]);
function whitecapThemeSelection(value = "current", visualizer) {
  if (!WHITE_CAP_THEMES.some(theme => theme.id === value) || (value !== "current" && visualizer !== "whitecap")) {
    const error = new Error("Choose an available WhiteCap theme."); error.statusCode = 400; throw error;
  }
  return value;
}
async function whitecapThemes(options = {}) {
  const { ready } = await require("../integrations/soundspectrum-nasa-backgrounds/layer-pilot/install-rotation.cjs").readiness(options);
  return WHITE_CAP_THEMES.map(theme => ({ ...theme, available: theme.id === "current" || ready,
    ...(theme.id === "nasa-layers" && !ready ? { reason: "The NASA layer collection is unavailable on the PC." } : {}) }));
}
module.exports = { whitecapThemeSelection, whitecapThemes };
