"use strict";
const cache = new Map();
function selectRuntimeModel(models, configured = "") {
  const exact = models.find(m => m.id === configured);
  if (exact?.state === "loaded") return exact;
  const instances = models.filter(m => m.state === "loaded" && m.type !== "embeddings" &&
    (configured ? m.id.startsWith(configured + ":") && /^\d+$/.test(m.id.slice(configured.length + 1)) : true));
  // Deterministic only within the configured model family; never switch to an unrelated model.
  return instances.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))[0] || exact;
}
async function resolveLocalModel(config, fetchImpl = fetch) {
  const configured = config.openAiCompatibleModel || "";
  const url = config.openAiCompatibleBaseUrl || "";
  const key = url + "|" + configured;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.model;
  let model = configured;
  try {
    const origin = new URL(url).origin;
    const response = await fetchImpl(`${origin}/api/v0/models`, {
      headers: config.openAiCompatibleApiKey ? { authorization: `Bearer ${config.openAiCompatibleApiKey}` } : {},
      signal: AbortSignal.timeout(1500)
    });
    const data = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
    if (response.ok && Array.isArray(data.data)) model = selectRuntimeModel(data.data, configured)?.id || configured;
  } catch { /* Non-LM-Studio compatible servers retain their configured model. */ }
  cache.set(key, { model, until: Date.now() + 10000 });
  return model;
}
module.exports = { selectRuntimeModel, resolveLocalModel };
