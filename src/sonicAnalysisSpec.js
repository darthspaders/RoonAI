"use strict";
const { createHash } = require("node:crypto");
const catalog = require("../config/sonic-analyzers.json");
const hash = value => createHash("sha256").update(value).digest("hex");
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const specs = catalog.analyzers.map(item => {
  const spec = { ...item, schemaVersion: catalog.schemaVersion, preprocessing: `ffmpeg-mono-${item.sampleRate}-v1` };
  return Object.freeze({ ...spec, key: `analysis-v1-${hash(stable(spec)).slice(0, 24)}` });
});
function analysisSpec(id) {
  const spec = specs.find(item => item.id === id || item.key === id);
  if (!spec) throw new Error(`Unknown Sonic analyzer: ${id}`);
  return spec;
}
module.exports = { analysisSpec, specs, hash };
