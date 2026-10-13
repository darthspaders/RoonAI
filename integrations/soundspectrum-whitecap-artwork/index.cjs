"use strict";
const path = require("node:path");
function attach(options) {
  return require("../soundspectrum-now-playing/index.cjs").attachNowPlaying({ ...options,
    visualizer: "whitecap", runtimeRoot: path.join(__dirname, "../../data/soundspectrum-whitecap-artwork"),
    readiness: () => require("./install.cjs").readiness() });
}
module.exports = { attach };
