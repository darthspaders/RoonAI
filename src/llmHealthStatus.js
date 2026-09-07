"use strict";

const { selectRuntimeModel } = require("./localModelRuntime");

function normalizeBaseUrl(baseUrl = "") {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function openAiCompatibleOrigin(baseUrl = "") {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

function modelStateMessage(label, model, state, modelFound = true) {
  if (!modelFound) return `${label} reachable, configured model not found`;
  if (state === "loaded") return "Local model ready";
  if (state === "loading") return `${label} model is loading`;
  if (state === "not-loaded") return `${label} reachable, configured model not loaded`;
  if (state) return `${label} model state: ${state}`;
  return `${label} reachable, model runtime state unavailable`;
}

function createLlmHealthStatus({ config, fetchJsonWithTimeout, openAiCompatibleProviders }) {
  function llmSnapshot() {
    const openAiCompatible = openAiCompatibleProviders.has(config.llmProvider);
    const model = openAiCompatible
      ? config.openAiCompatibleModel
      : (config.llmProvider === "openrouter" ? config.openRouterModel : config.ollamaModel);
    const label = openAiCompatible
      ? "LM STUDIO"
      : (config.llmProvider === "openrouter" ? "OPENROUTER" : "OLLAMA");
    const baseUrl = openAiCompatible
      ? config.openAiCompatibleBaseUrl
      : (config.llmProvider === "openrouter" ? "https://openrouter.ai/api/v1" : config.ollamaBaseUrl);
    return {
      provider: config.llmProvider,
      label,
      model,
      baseUrl
    };
  }

  async function lmStudioRuntimeModels(baseUrl, headers = {}) {
    const origin = openAiCompatibleOrigin(baseUrl);
    if (!origin) return null;
    try {
      const { response, body } = await fetchJsonWithTimeout(`${origin}/api/v0/models`, { headers }, 2500);
      if (!response.ok || !Array.isArray(body?.data)) return null;
      return body.data
        .map((model) => ({
          id: model.id || "",
          state: model.state || "",
          type: model.type || "",
          loadedContextLength: model.loaded_context_length || null,
          maxContextLength: model.max_context_length || null
        }))
        .filter((model) => model.id);
    } catch {
      return null;
    }
  }

  async function llmHealth() {
    const snapshot = llmSnapshot();
    const headers = {};
    if (config.openAiCompatibleApiKey) headers.authorization = `Bearer ${config.openAiCompatibleApiKey}`;
    if (config.openRouterApiKey) headers.authorization = `Bearer ${config.openRouterApiKey}`;

    try {
      if (openAiCompatibleProviders.has(config.llmProvider)) {
        const baseUrl = normalizeBaseUrl(config.openAiCompatibleBaseUrl);
        const { response, body } = await fetchJsonWithTimeout(`${baseUrl}/models`, { headers }, 2500);
        const models = Array.isArray(body?.data) ? body.data.map((model) => model.id).filter(Boolean) : [];
        const runtimeModels = await lmStudioRuntimeModels(baseUrl, headers);
        if (runtimeModels?.length) {
          const runtimeModel = selectRuntimeModel(runtimeModels, snapshot.model);
          const modelFound = !snapshot.model || Boolean(runtimeModel);
          const runtimeState = runtimeModel?.state || "";
          const loaded = Boolean(modelFound && runtimeState === "loaded");
          return {
            ...snapshot,
            configuredModel: snapshot.model,
            model: runtimeModel?.id || snapshot.model,
            online: response.ok && loaded,
            reachable: response.ok,
            loaded,
            models,
            runtimeModels,
            runtimeState,
            message: response.ok
              ? modelStateMessage(snapshot.label, snapshot.model, runtimeState, modelFound)
              : `${snapshot.label} returned HTTP ${response.status}`
          };
        }
        const loaded = !snapshot.model || models.includes(snapshot.model);
        return {
          ...snapshot,
          online: response.ok && loaded,
          reachable: response.ok,
          loaded,
          models,
          message: response.ok
            ? (loaded ? "Local model ready" : "LM Studio reachable, configured model not loaded")
            : `LM Studio returned HTTP ${response.status}`
        };
      }

      if (config.llmProvider === "openrouter") {
        return {
          ...snapshot,
          online: Boolean(config.openRouterApiKey),
          reachable: Boolean(config.openRouterApiKey),
          loaded: Boolean(config.openRouterApiKey),
          message: config.openRouterApiKey ? "OpenRouter key configured" : "OPENROUTER_API_KEY is missing"
        };
      }

      const baseUrl = normalizeBaseUrl(config.ollamaBaseUrl);
      const { response, body } = await fetchJsonWithTimeout(`${baseUrl}/api/tags`, {}, 2500);
      const models = Array.isArray(body?.models) ? body.models.map((model) => model.name).filter(Boolean) : [];
      const loaded = !snapshot.model || models.includes(snapshot.model);
      return {
        ...snapshot,
        online: response.ok && loaded,
        reachable: response.ok,
        loaded,
        models,
        message: response.ok
          ? (loaded ? "Ollama model ready" : "Ollama reachable, configured model not loaded")
          : `Ollama returned HTTP ${response.status}`
      };
    } catch (error) {
      return {
        ...snapshot,
        online: false,
        reachable: false,
        loaded: false,
        models: [],
        message: error?.name === "AbortError" ? "Local model check timed out" : (error.message || "Local model is offline")
      };
    }
  }

  return {
    llmHealth,
    llmSnapshot,
    lmStudioRuntimeModels
  };
}

module.exports = {
  createLlmHealthStatus,
  modelStateMessage,
  normalizeBaseUrl,
  openAiCompatibleOrigin
};
