"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AutoModelRouter,
  LocalModelProvider,
  OpenAIModelProvider,
  OpenAiUsageLedger,
  normalizeMode,
  normalizeTier,
  stripModePrefix,
  openAiToolsFromRabbitHole
} = require("../src/modelProviders");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

function fakeTools(log = []) {
  return {
    get_rabbit_hole_status: {
      description: "Get status",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (input = {}) => {
        log.push({ name: "get_rabbit_hole_status", input });
        return {
          nowPlaying: {
            artist: "Bedrock",
            title: "Forge",
            album: "Forge"
          },
          zone: {
            name: "HQPlayer",
            state: "playing"
          }
        };
      }
    },
    rate_now_playing: {
      description: "Rate now playing",
      inputSchema: {
        type: "object",
        properties: { rating: { type: "string" } },
        required: ["rating"],
        additionalProperties: false
      },
      handler: async (input = {}) => {
        log.push({ name: "rate_now_playing", input });
        return {
          rating: input.rating,
          track: {
            artist: "Bedrock",
            title: "Forge"
          }
        };
      }
    },
    control_roon: {
      description: "Control Roon",
      inputSchema: {
        type: "object",
        properties: { control: { type: "string" } },
        required: ["control"],
        additionalProperties: false
      },
      handler: async (input = {}) => {
        log.push({ name: "control_roon", input });
        return {
          control: input.control,
          zone: { name: "HQPlayer" }
        };
      }
    },
    search_rabbit_hole: {
      description: "Search Rabbit Hole",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string" },
          count: { type: "integer" }
        },
        required: ["request"],
        additionalProperties: false
      },
      handler: async (input = {}) => {
        log.push({ name: "search_rabbit_hole", input });
        return {
          requestedCount: input.count || 12,
          tracks: [{ artist: "A", title: "B" }]
        };
      }
    }
  };
}

test("normalizes AI mode aliases", () => {
  assert.equal(normalizeMode("LOCAL"), "local");
  assert.equal(normalizeMode("openai"), "synapse");
  assert.equal(normalizeMode("luna"), "synapse");
  assert.equal(normalizeMode("AUTO"), "auto");
  assert.equal(normalizeMode("wat", "local"), "local");
  assert.equal(normalizeTier("TERRA"), "terra");
  assert.equal(normalizeTier("bogus", "sol"), "sol");
  assert.deepEqual(stripModePrefix("/sol debug Rabbit Hole"), {
    mode: "synapse",
    tier: "sol",
    message: "debug Rabbit Hole"
  });
});

test("converts Rabbit Hole tools to OpenAI function tools", () => {
  const tools = openAiToolsFromRabbitHole(fakeTools());
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "control_roon",
    "get_rabbit_hole_status",
    "rate_now_playing",
    "search_rabbit_hole"
  ]);
  assert.equal(tools[0].type, "function");
  assert.ok(tools.every((tool) => tool.parameters?.type === "object"));
});

test("local provider handles now-playing through Rabbit Hole tool", async () => {
  const calls = [];
  const provider = new LocalModelProvider({
    config: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" },
    tools: fakeTools(calls)
  });

  const result = await provider.respond("What's playing right now?", { localModel: "qwen" });
  assert.equal(result.provider, "local");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_rabbit_hole_status");
  assert.match(result.text, /Bedrock - Forge/);
});

test("AUTO keeps routine feedback local", async () => {
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local ok", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      respond: async () => {
        throw new Error("should not call synapse");
      }
    },
    logger: { log() {} }
  });

  const result = await router.respond({ message: "Love this track." });
  assert.equal(result.provider, "local");
  assert.equal(result.decision.reason, "routine playback or feedback command");
});

test("AUTO escalates complex analysis to Synapse", async () => {
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      canUseTier: () => true,
      respond: async (message, options = {}) => ({ text: "synapse ok", provider: "synapse", tier: options.tier, model: "gpt-5.6-terra", toolCalls: [] })
    },
    logger: { log() {} }
  });

  const result = await router.respond({ message: "Analyze my last 100 rated discovery tracks and explain the pattern." });
  assert.equal(result.provider, "synapse");
  assert.equal(result.tier, "terra");
  assert.match(result.decision.reason, /preference-history/);
});

test("AUTO sends normal discovery to Luna", async () => {
  const seen = [];
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      canUseTier: () => true,
      respond: async (message, options = {}) => {
        seen.push(options.tier);
        return { text: "luna ok", provider: "synapse", tier: options.tier, model: "gpt-5.6-luna", toolCalls: [] };
      }
    },
    logger: { log() {} }
  });

  const result = await router.respond({ message: "Find me 12 good tracks no matter what genre, avoid repeats, surprise me." });
  assert.equal(result.provider, "synapse");
  assert.equal(result.tier, "luna");
  assert.deepEqual(seen, ["luna"]);
});

test("AUTO reserves Sol for hard debugging and architecture requests", async () => {
  const seen = [];
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      canUseTier: () => true,
      respond: async (message, options = {}) => {
        seen.push(options.tier);
        return { text: "sol ok", provider: "synapse", tier: options.tier, model: "gpt-5.6-sol", toolCalls: [] };
      }
    },
    logger: { log() {} }
  });

  const result = await router.respond({ message: "Think really hard and debug Rabbit Hole's discovery architecture." });
  assert.equal(result.provider, "synapse");
  assert.equal(result.tier, "sol");
  assert.deepEqual(seen, ["sol"]);
});

test("AUTO falls back local when Synapse fails", async () => {
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local fallback", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      respond: async () => {
        throw new Error("rate limited");
      }
    },
    logger: { log() {} }
  });

  const result = await router.respond({ message: "Analyze my last 100 rated tracks." });
  assert.equal(result.provider, "local");
  assert.equal(result.fallback, true);
  assert.match(result.decision.reason, /fell back to local/);
});

test("AUTO escalates Luna to Terra on failed tool workflow", async () => {
  const seen = [];
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      canUseTier: () => true,
      respond: async (message, options = {}) => {
        seen.push(options.tier);
        if (options.tier === "luna") {
          return {
            text: "tool failed",
            provider: "synapse",
            tier: "luna",
            model: "gpt-5.6-luna",
            toolCalls: [{ name: "search_rabbit_hole", ok: false }]
          };
        }
        return {
          text: "terra recovered",
          provider: "synapse",
          tier: "terra",
          model: "gpt-5.6-terra",
          toolCalls: []
        };
      }
    },
    logger: { log() {} }
  });

  const result = await router.respond({ message: "Find and rank 12 progressive house candidates." });
  assert.equal(result.provider, "synapse");
  assert.equal(result.tier, "terra");
  assert.deepEqual(seen, ["luna", "terra"]);
  assert.deepEqual(result.decision.escalationPath, ["luna", "terra"]);
});

test("AUTO can generate discovery search plans with Synapse", async () => {
  const seen = [];
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      config: { model: "gpt-6-astra" },
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      canUseTier: () => true,
      completeJsonPrompt: async (prompt, options = {}) => {
        seen.push(options.tier);
        return {
          text: JSON.stringify({
            intent: "Analyze taste and find long progressive house.",
            intentRoute: "genre",
            promptStrictness: "genre-first",
            allowOutsideTaste: false,
            tasteInfluence: "strongly",
            targetGenres: ["progressive house"],
            vibeTerms: ["hypnotic"],
            searchQueries: ["progressive house extended 2026"],
            candidateArtists: [],
            candidateLabels: [],
            themeTerms: [],
            activityTerms: [],
            seedArtists: [],
            avoidTerms: []
          }),
          tier: options.tier,
          tierLabel: "Luna",
          model: "gpt-5.6-luna",
          usage: { inputTokens: 10, outputTokens: 5 },
          latencyMs: 4
        };
      }
    },
    logger: { log() {} }
  });

  const result = await router.generateSearchPlan({
    request: "Analyze my taste and find 20 long progressive house tracks.",
    count: 20
  }, async () => {
    throw new Error("should not use local planner");
  }, 1000);

  assert.equal(result.routing.provider, "synapse");
  assert.equal(result.routing.tier, "luna");
  assert.equal(result.requestedCount, 20);
  assert.deepEqual(result.plan.targetGenres, ["progressive house"]);
  assert.deepEqual(seen, ["luna"]);
});

test("Synapse discovery planning escalates when Luna returns unusable JSON", async () => {
  const seen = [];
  const router = new AutoModelRouter({
    config: { mode: "auto", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      canUseTier: () => true,
      completeJsonPrompt: async (prompt, options = {}) => {
        seen.push(options.tier);
        if (options.tier === "luna") {
          return {
            text: "{}",
            tier: "luna",
            tierLabel: "Luna",
            model: "gpt-5.6-luna",
            usage: { inputTokens: 2, outputTokens: 1 },
            latencyMs: 2
          };
        }
        return {
          text: JSON.stringify({
            intent: "Find better progressive house.",
            searchQueries: ["progressive house extended mix 2026"],
            candidateArtists: [],
            candidateLabels: [],
            targetGenres: ["progressive house"]
          }),
          tier: "terra",
          tierLabel: "Terra",
          model: "gpt-5.6-terra",
          usage: { inputTokens: 4, outputTokens: 2 },
          latencyMs: 3
        };
      }
    },
    logger: { log() {} }
  });

  const result = await router.generateSearchPlan({
    request: "Find and rank 12 progressive house candidates.",
    count: 12
  }, async () => {
    throw new Error("should not use local planner");
  }, 1000);

  assert.equal(result.routing.provider, "synapse");
  assert.equal(result.routing.tier, "terra");
  assert.deepEqual(seen, ["luna", "terra"]);
  assert.deepEqual(result.routing.escalationPath, ["luna", "terra"]);
});

test("Synapse discovery planning falls back to local planner", async () => {
  const router = new AutoModelRouter({
    config: { mode: "synapse", local: { llmProvider: "openai-compatible", openAiCompatibleModel: "qwen" } },
    tools: fakeTools(),
    localProvider: {
      respond: async () => ({ text: "local", provider: "local", toolCalls: [] })
    },
    openAiProvider: {
      config: { model: "gpt-6-astra" },
      safeStatus: () => ({ enabled: true, configured: true, state: "connected" }),
      checkHealth: async () => ({ state: "connected" }),
      completeJsonPrompt: async () => {
        throw new Error("OpenAI unavailable");
      }
    },
    logger: { log() {} }
  });

  const result = await router.generateSearchPlan({
    request: "Find 12 good tracks.",
    count: 12
  }, async () => ({
    prompt: "local prompt",
    requestedCount: 12,
    plan: {
      searchQueries: ["local query"],
      candidateArtists: [],
      candidateLabels: [],
      targetGenres: []
    }
  }), 1000);

  assert.equal(result.routing.provider, "local");
  assert.equal(result.routing.fallback, true);
  assert.match(result.routing.reason, /fell back to local planner/);
  assert.deepEqual(result.plan.searchQueries, ["local query"]);
});

test("OpenAI provider classifies invalid API key status", async () => {
  const provider = new OpenAIModelProvider({
    config: {
      enabled: true,
      apiKey: "test-key",
      baseUrl: "https://api.openai.test/v1",
      model: "gpt-6-astra",
      healthTimeoutMs: 1000
    },
    tools: fakeTools(),
    fetch: async () => jsonResponse(401, { error: { message: "invalid api key" } })
  });

  const status = await provider.checkHealth();
  assert.equal(status.state, "authentication_error");
  assert.equal(status.connected, false);
  assert.match(status.lastError, /invalid api key/);
});

test("OpenAI provider executes Rabbit Hole tool calls and returns final response", async () => {
  const toolCalls = [];
  const requests = [];
  const provider = new OpenAIModelProvider({
    config: {
      enabled: true,
      apiKey: "test-key",
      baseUrl: "https://api.openai.test/v1",
      model: "gpt-6-astra",
      timeoutMs: 1000
    },
    tools: fakeTools(toolCalls),
    logger: { log() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body || "{}") });
      if (requests.length === 1) {
        return jsonResponse(200, {
          id: "resp_1",
          output: [{
            type: "function_call",
            call_id: "call_1",
            name: "get_rabbit_hole_status",
            arguments: "{}"
          }],
          usage: { input_tokens: 20, output_tokens: 5 }
        });
      }
      return jsonResponse(200, {
        id: "resp_2",
        output_text: "Bedrock - Forge is playing.",
        output: [],
        usage: { input_tokens: 8, output_tokens: 7 }
      });
    }
  });

  const result = await provider.respond("What's playing?");
  assert.equal(result.provider, "synapse");
  assert.equal(result.text, "Bedrock - Forge is playing.");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "get_rabbit_hole_status");
  assert.equal(result.usage.inputTokens, 28);
  assert.equal(requests[1].body.input[0].type, "function_call_output");
  assert.equal(requests[1].body.previous_response_id, "resp_1");
});

test("OpenAI provider adds native prompt cache keys for official Responses requests", async () => {
  const requests = [];
  const logs = [];
  const provider = new OpenAIModelProvider({
    config: {
      enabled: true,
      apiKey: "test-key",
      model: "gpt-5.6-luna",
      timeoutMs: 1000
    },
    tools: fakeTools(),
    logger: { log(message) { logs.push(message); } },
    fetch: async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body || "{}") });
      return jsonResponse(200, {
        id: "resp_cache",
        output_text: "Plan ready.",
        output: [],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 10
        }
      });
    }
  });

  const result = await provider.completeJsonPrompt("Find progressive house.", {
    requestType: "search_plan",
    tier: "luna"
  });

  assert.equal(requests[0].body.prompt_cache_key, "rabbit-hole-discovery-v1-luna");
  assert.equal(result.usage.cachedInputTokens, 40);
  assert.equal(result.usage.uncachedInputTokens, 60);
  assert.equal(result.usage.cacheHitPercent, 40);
  assert.equal(result.usageLog.promptCacheKey, "rabbit-hole-discovery-v1-luna");
  assert.match(logs[0], /cacheKey=rabbit-hole-discovery-v1-luna/);
  assert.match(logs[0], /uncached=60/);
  assert.match(logs[0], /cacheHitPct=40/);
});

test("OpenAI provider does not add prompt cache keys to custom OpenAI-compatible endpoints", async () => {
  const requests = [];
  const provider = new OpenAIModelProvider({
    config: {
      enabled: true,
      apiKey: "test-key",
      baseUrl: "https://api.openai.test/v1",
      model: "gpt-5.6-luna",
      timeoutMs: 1000
    },
    tools: fakeTools(),
    logger: { log() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body || "{}") });
      return jsonResponse(200, {
        id: "resp_cache",
        output_text: "Ready.",
        output: [],
        usage: { input_tokens: 10, output_tokens: 2 }
      });
    }
  });

  await provider.completeJsonPrompt("Return JSON.", { requestType: "search_plan", tier: "luna" });
  assert.equal(requests[0].body.prompt_cache_key, undefined);
});

test("OpenAI usage ledger tracks costs by Synapse tier", () => {
  const ledger = new OpenAiUsageLedger({
    rates: {
      inputCostPerMillion: 1,
      cachedInputCostPerMillion: 0.1,
      outputCostPerMillion: 2
    },
    budgets: {
      tiers: {
        sol: { daily: 0.00001 }
      }
    }
  });

  ledger.record({
    provider: "synapse",
    tier: "luna",
    model: "gpt-5.6-luna",
    usage: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 500, totalTokens: 1500 },
    promptCacheKey: "rabbit-hole-discovery-v1-luna",
    toolCalls: 2
  });
  ledger.record({
    provider: "synapse",
    tier: "sol",
    model: "gpt-5.6-sol",
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    costUsd: 0.00002,
    toolCalls: 1
  });

  const totals = ledger.totals();
  assert.equal(totals.byTier.luna.session.calls, 1);
  assert.equal(totals.byTier.luna.session.toolCalls, 2);
  assert.equal(ledger.records[0].uncachedInputTokens, 900);
  assert.equal(ledger.records[0].promptCacheKey, "rabbit-hole-discovery-v1-luna");
  assert.equal(totals.byTier.sol.session.calls, 1);
  assert.equal(ledger.budgetState(0, "sol").limited, true);
  assert.equal(ledger.budgetState(0, "luna").limited, false);
});
