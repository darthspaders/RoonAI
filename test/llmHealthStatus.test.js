"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLlmHealthStatus,
  modelStateMessage,
  normalizeBaseUrl,
  openAiCompatibleOrigin
} = require("../src/llmHealthStatus");

const providers = new Set(["openai-compatible", "lmstudio"]);

test("LLM health utility helpers preserve base URL and state message behavior", () => {
  assert.equal(normalizeBaseUrl("http://localhost:1234///"), "http://localhost:1234");
  assert.equal(openAiCompatibleOrigin("http://localhost:1234/v1"), "http://localhost:1234");
  assert.equal(openAiCompatibleOrigin("not a url"), "");
  assert.equal(modelStateMessage("LM STUDIO", "model-a", "loaded"), "Local model ready");
  assert.equal(modelStateMessage("LM STUDIO", "model-a", "", false), "LM STUDIO reachable, configured model not found");
});

test("LLM health reports OpenRouter as configured only when key exists", async () => {
  const status = createLlmHealthStatus({
    config: {
      llmProvider: "openrouter",
      openRouterModel: "openrouter/model",
      openRouterApiKey: ""
    },
    fetchJsonWithTimeout: async () => {
      throw new Error("fetch should not run for OpenRouter status");
    },
    openAiCompatibleProviders: providers
  });

  const snapshot = await status.llmHealth();

  assert.equal(snapshot.provider, "openrouter");
  assert.equal(snapshot.online, false);
  assert.equal(snapshot.message, "OPENROUTER_API_KEY is missing");
});

test("LLM health reports Ollama reachable with configured model missing", async () => {
  const status = createLlmHealthStatus({
    config: {
      llmProvider: "ollama",
      ollamaModel: "llama3",
      ollamaBaseUrl: "http://localhost:11434/"
    },
    fetchJsonWithTimeout: async (url) => {
      assert.equal(url, "http://localhost:11434/api/tags");
      return {
        response: { ok: true },
        body: { models: [{ name: "mistral" }] }
      };
    },
    openAiCompatibleProviders: providers
  });

  const snapshot = await status.llmHealth();

  assert.equal(snapshot.label, "OLLAMA");
  assert.equal(snapshot.reachable, true);
  assert.equal(snapshot.loaded, false);
  assert.equal(snapshot.message, "Ollama reachable, configured model not loaded");
});

test("LLM health uses LM Studio runtime model state when available", async () => {
  const calls = [];
  const status = createLlmHealthStatus({
    config: {
      llmProvider: "lmstudio",
      openAiCompatibleModel: "deepseek-r1",
      openAiCompatibleBaseUrl: "http://localhost:1234/v1",
      openAiCompatibleApiKey: "secret"
    },
    fetchJsonWithTimeout: async (url, options) => {
      calls.push({ url, authorization: options.headers?.authorization || "" });
      if (url.endsWith("/api/v0/models")) {
        return {
          response: { ok: true },
          body: {
            data: [{
              id: "deepseek-r1",
              state: "loaded",
              type: "llm",
              loaded_context_length: 8192,
              max_context_length: 32768
            }]
          }
        };
      }
      if (url.endsWith("/models")) {
        return {
          response: { ok: true },
          body: { data: [{ id: "deepseek-r1" }] }
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
    openAiCompatibleProviders: providers
  });

  const snapshot = await status.llmHealth();

  assert.deepEqual(calls.map((call) => call.url), [
    "http://localhost:1234/v1/models",
    "http://localhost:1234/api/v0/models"
  ]);
  assert.equal(calls[0].authorization, "Bearer secret");
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.runtimeState, "loaded");
  assert.equal(snapshot.message, "Local model ready");
});
