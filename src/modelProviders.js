"use strict";
const voiceExecution = require("./voiceExecution");
const { exactIntent, parseTrackList } = require("./exactTrackVerification");

const fs = require("fs");
const path = require("path");
const {
  buildSearchPlanPrompt,
  extractJsonObject,
  normalizeSearchPlan,
  requestedCountFor
} = require("./llmClient");

const LOCAL_MODE = "local";
const SYNAPSE_MODE = "synapse";
const AUTO_MODE = "auto";
const OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai-compatible", "openai_compatible", "lmstudio", "llamacpp"]);
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const SYNAPSE_TIER_ORDER = ["luna", "terra", "sol"];
const DEFAULT_SYNAPSE_TIER = "luna";
const SYNAPSE_TIER_LABELS = {
  luna: "Luna",
  terra: "Terra",
  sol: "Sol"
};
const DEFAULT_SYNAPSE_TIER_MODELS = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol"
};
const DEFAULT_OPENAI_MODEL = DEFAULT_SYNAPSE_TIER_MODELS[DEFAULT_SYNAPSE_TIER];
const MAX_TOOL_OUTPUT_CHARS = 14_000;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMode(value, fallback = AUTO_MODE) {
  const key = cleanText(value).toLowerCase();
  if (["local", "lmstudio", "lm_studio", "qwen"].includes(key)) return LOCAL_MODE;
  if (["openai", "synapse", "cloud"].includes(key)) return SYNAPSE_MODE;
  if (SYNAPSE_TIER_ORDER.includes(key)) return SYNAPSE_MODE;
  if (key === AUTO_MODE) return AUTO_MODE;
  return fallback;
}

function normalizeTier(value, fallback = DEFAULT_SYNAPSE_TIER) {
  const key = cleanText(value).toLowerCase();
  if (SYNAPSE_TIER_ORDER.includes(key)) return key;
  return fallback;
}

function tierFromModel(model = "") {
  const text = cleanText(model).toLowerCase();
  if (!text) return "";
  return SYNAPSE_TIER_ORDER.find((tier) => text.includes(tier)) || "";
}

function tierLabel(tier = "") {
  const key = normalizeTier(tier, "");
  return SYNAPSE_TIER_LABELS[key] || "";
}

function normalizeSynapseTiers(tiers = {}, config = {}) {
  const defaultTier = normalizeTier(config.defaultTier || tierFromModel(config.model), DEFAULT_SYNAPSE_TIER);
  const globalRates = {
    inputCostPerMillion: config.inputCostPerMillion,
    cachedInputCostPerMillion: config.cachedInputCostPerMillion,
    outputCostPerMillion: config.outputCostPerMillion
  };
  return SYNAPSE_TIER_ORDER.reduce((result, tier) => {
    const raw = tiers[tier] || {};
    const model = cleanText(raw.model) ||
      (tier === defaultTier && cleanText(config.model) ? cleanText(config.model) : DEFAULT_SYNAPSE_TIER_MODELS[tier]);
    result[tier] = {
      key: tier,
      label: SYNAPSE_TIER_LABELS[tier],
      model,
      maxOutputTokens: envNumber(raw.maxOutputTokens, envNumber(config.maxOutputTokens, 0)),
      reasoningEffort: cleanText(raw.reasoningEffort || config.reasoningEffort || ""),
      reasoningMode: cleanText(raw.reasoningMode || config.reasoningMode || ""),
      rates: {
        inputCostPerMillion: envNumber(raw.inputCostPerMillion, envNumber(globalRates.inputCostPerMillion, 0)),
        cachedInputCostPerMillion: envNumber(raw.cachedInputCostPerMillion, envNumber(globalRates.cachedInputCostPerMillion, 0)),
        outputCostPerMillion: envNumber(raw.outputCostPerMillion, envNumber(globalRates.outputCostPerMillion, 0))
      },
      budgets: {
        maxPerRequest: envNumber(raw.maxCostPerRequest, envNumber(config.maxCostPerRequest, 0)),
        daily: envNumber(raw.dailyBudget, 0),
        monthly: envNumber(raw.monthlyBudget, 0)
      }
    };
    return result;
  }, {});
}

function envNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBaseUrl(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

function nowIso() {
  return new Date().toISOString();
}

function truncate(value, limit = MAX_TOOL_OUTPUT_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function stripModePrefix(message = "") {
  const text = String(message || "").trim();
  const match = text.match(/^\/(local|synapse|openai|auto|luna|terra|sol)\b\s*/i);
  if (!match) return { mode: "", tier: "", message: text };
  const token = cleanText(match[1]).toLowerCase();
  const tier = normalizeTier(token, "");
  return {
    mode: tier ? SYNAPSE_MODE : normalizeMode(token),
    tier,
    message: text.slice(match[0].length).trim()
  };
}

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function responseText(body = {}) {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text.trim();
  const chunks = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (item.type === "message") {
      for (const content of Array.isArray(item.content) ? item.content : []) {
        const text = content.text || content.output_text || "";
        if (text) chunks.push(text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function functionCalls(body = {}) {
  return (Array.isArray(body.output) ? body.output : [])
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: item.id || "",
      callId: item.call_id || item.id || "",
      name: item.name || "",
      arguments: item.arguments || "{}"
    }))
    .filter((item) => item.callId && item.name);
}

function usageFromResponse(body = {}) {
  const usage = body.usage || {};
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const cachedInputTokens = Number(usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0);
  const cacheWriteTokens = Number(usage.input_tokens_details?.cache_write_tokens || usage.prompt_tokens_details?.cache_write_tokens || 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cacheHitPercent = inputTokens > 0 ? Number(((cachedInputTokens / inputTokens) * 100).toFixed(1)) : 0;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0,
    uncachedInputTokens: Number.isFinite(uncachedInputTokens) ? uncachedInputTokens : 0,
    cacheHitPercent: Number.isFinite(cacheHitPercent) ? cacheHitPercent : 0,
    cacheWriteTokens: Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens) || 0
  };
}

function mergeUsage(left = {}, right = {}) {
  const inputTokens = Number(left.inputTokens || 0) + Number(right.inputTokens || 0);
  const cachedInputTokens = Number(left.cachedInputTokens || 0) + Number(right.cachedInputTokens || 0);
  const cacheWriteTokens = Number(left.cacheWriteTokens || 0) + Number(right.cacheWriteTokens || 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cacheHitPercent = inputTokens > 0 ? Number(((cachedInputTokens / inputTokens) * 100).toFixed(1)) : 0;
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    cacheHitPercent,
    cacheWriteTokens,
    outputTokens: Number(left.outputTokens || 0) + Number(right.outputTokens || 0),
    totalTokens: Number(left.totalTokens || 0) + Number(right.totalTokens || 0)
  };
}

function estimateCost(usage = {}, rates = {}) {
  const inputRate = Number(rates.inputCostPerMillion || 0);
  const outputRate = Number(rates.outputCostPerMillion || 0);
  if (!inputRate && !outputRate) return null;
  const input = Math.max(0, Number(usage.inputTokens || 0) - Number(usage.cachedInputTokens || 0));
  const cached = Math.max(0, Number(usage.cachedInputTokens || 0));
  const cachedRate = Number(rates.cachedInputCostPerMillion || inputRate || 0);
  const output = Math.max(0, Number(usage.outputTokens || 0));
  return Number((((input * inputRate) + (cached * cachedRate) + (output * outputRate)) / 1_000_000).toFixed(6));
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function emptyUsageTotals() {
  return {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0
  };
}

function addUsageRecord(total, record = {}) {
  total.calls += Number(record.calls || 1);
  total.costUsd = Number((total.costUsd + Number(record.costUsd || 0)).toFixed(6));
  total.inputTokens += Number(record.inputTokens || 0);
  total.cachedInputTokens += Number(record.cachedInputTokens || 0);
  total.outputTokens += Number(record.outputTokens || 0);
  total.totalTokens += Number(record.totalTokens || 0);
  total.toolCalls += Number(record.toolCalls || 0);
  return total;
}

class OpenAiUsageLedger {
  constructor(options = {}) {
    this.file = options.file || "";
    this.rates = options.rates || {};
    this.budgets = options.budgets || {};
    this.session = { ...emptyUsageTotals(), byTier: {} };
    this.records = [];
    this.persisted = this.read();
  }

  read() {
    if (!this.file) return { records: [] };
    try {
      if (!fs.existsSync(this.file)) return { records: [] };
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { records: Array.isArray(parsed.records) ? parsed.records : [] };
    } catch {
      return { records: [] };
    }
  }

  write() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const records = this.persisted.records.slice(-500);
      fs.writeFileSync(this.file, JSON.stringify({ records }, null, 2));
    } catch {
      // Usage logging is advisory; Rabbit Hole must remain usable if the file cannot be written.
    }
  }

  totals() {
    const today = dayKey();
    const month = monthKey();
    const records = this.persisted.records || [];
    const sumRecords = (filter) => records.filter(filter).reduce((total, record) => addUsageRecord(total, record), emptyUsageTotals());
    const todayTotals = sumRecords((record) => String(record.date || "").startsWith(today));
    const monthTotals = sumRecords((record) => String(record.date || "").startsWith(month));
    const byTier = {};
    for (const tier of SYNAPSE_TIER_ORDER) {
      byTier[tier] = {
        label: SYNAPSE_TIER_LABELS[tier],
        session: { ...emptyUsageTotals(), ...(this.session.byTier?.[tier] || {}) },
        today: sumRecords((record) => record.tier === tier && String(record.date || "").startsWith(today)),
        month: sumRecords((record) => record.tier === tier && String(record.date || "").startsWith(month))
      };
    }
    return {
      session: { ...this.session },
      today: todayTotals,
      month: monthTotals,
      todayCostUsd: todayTotals.costUsd,
      monthCostUsd: monthTotals.costUsd,
      byTier
    };
  }

  budgetState(extraCost = 0, tier = "") {
    const totals = this.totals();
    const selectedTier = normalizeTier(tier, "");
    const tierBudgets = selectedTier ? (this.budgets.tiers?.[selectedTier] || {}) : {};
    const tierTotals = selectedTier ? (totals.byTier?.[selectedTier] || {}) : {};
    const daily = Number(this.budgets.daily || 0);
    const monthly = Number(this.budgets.monthly || 0);
    const requestMax = Number(this.budgets.maxPerRequest || 0);
    const tierDaily = Number(tierBudgets.daily || 0);
    const tierMonthly = Number(tierBudgets.monthly || 0);
    const tierRequestMax = Number(tierBudgets.maxPerRequest || 0);
    const projectedDaily = totals.todayCostUsd + Number(extraCost || 0);
    const projectedMonthly = totals.monthCostUsd + Number(extraCost || 0);
    const projectedTierDaily = Number(tierTotals.today?.costUsd || 0) + Number(extraCost || 0);
    const projectedTierMonthly = Number(tierTotals.month?.costUsd || 0) + Number(extraCost || 0);
    const limitedBy = [];
    if (daily && projectedDaily >= daily) limitedBy.push("daily");
    if (monthly && projectedMonthly >= monthly) limitedBy.push("monthly");
    if (requestMax && Number(extraCost || 0) >= requestMax) limitedBy.push("request");
    if (tierDaily && projectedTierDaily >= tierDaily) limitedBy.push(`${selectedTier}_daily`);
    if (tierMonthly && projectedTierMonthly >= tierMonthly) limitedBy.push(`${selectedTier}_monthly`);
    if (tierRequestMax && Number(extraCost || 0) >= tierRequestMax) limitedBy.push(`${selectedTier}_request`);
    return {
      tier: selectedTier,
      dailyBudgetUsd: daily || null,
      monthlyBudgetUsd: monthly || null,
      maxCostPerRequestUsd: requestMax || null,
      tierDailyBudgetUsd: tierDaily || null,
      tierMonthlyBudgetUsd: tierMonthly || null,
      tierMaxCostPerRequestUsd: tierRequestMax || null,
      todayCostUsd: totals.todayCostUsd,
      monthCostUsd: totals.monthCostUsd,
      tierTodayCostUsd: selectedTier ? Number(tierTotals.today?.costUsd || 0) : null,
      tierMonthCostUsd: selectedTier ? Number(tierTotals.month?.costUsd || 0) : null,
      limited: limitedBy.length > 0,
      limitedBy
    };
  }

  record(entry = {}) {
    const usage = entry.usage || {};
    const costUsd = entry.costUsd ?? estimateCost(usage, this.rates);
    const tier = normalizeTier(entry.tier || tierFromModel(entry.model), "");
    const record = {
      date: nowIso(),
      provider: entry.provider || "openai",
      tier,
      model: entry.model || "",
      requestType: entry.requestType || "",
      inputTokens: Number(usage.inputTokens || 0),
      cachedInputTokens: Number(usage.cachedInputTokens || 0),
      uncachedInputTokens: Number(usage.uncachedInputTokens ?? Math.max(0, Number(usage.inputTokens || 0) - Number(usage.cachedInputTokens || 0))),
      cacheHitPercent: Number(usage.cacheHitPercent ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
      totalTokens: Number(usage.totalTokens || 0),
      costUsd,
      latencyMs: Number(entry.latencyMs || 0),
      toolCalls: Number(entry.toolCalls || 0),
      promptCacheKey: entry.promptCacheKey || ""
    };
    this.records.push(record);
    this.persisted.records.push(record);
    addUsageRecord(this.session, record);
    if (tier) {
      if (!this.session.byTier[tier]) this.session.byTier[tier] = emptyUsageTotals();
      addUsageRecord(this.session.byTier[tier], record);
    }
    this.write();
    return record;
  }
}

async function fetchJsonWithTimeout(fetchImpl, url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const body = text ? safeJsonParse(text, { raw: text }) : {};
    return { response, body, text };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function compactNowPlaying(status = {}) {
  const now = status.nowPlaying || {};
  const zone = status.zone || {};
  if (!now.title) return "No active Roon now-playing track is available.";
  return [
    `Now playing: ${now.artist || "Unknown artist"} - ${now.title}`,
    now.album ? `Album: ${now.album}` : "",
    zone.name ? `Zone: ${zone.name}` : "",
    zone.state ? `State: ${zone.state}` : "",
    now.genre ? `Genre: ${now.genre}` : "",
    now.releaseDate || now.year ? `Released: ${now.releaseDate || now.year}` : ""
  ].filter(Boolean).join("\n");
}

function compactToolList(tools = {}) {
  return Object.keys(tools).sort().join(", ");
}

function sortedToolEntries(tools = {}) {
  return Object.entries(tools).sort(([left], [right]) => left.localeCompare(right));
}

function openAiToolsFromRabbitHole(tools = {}) {
  return sortedToolEntries(tools).map(([name, tool]) => ({
    type: "function",
    name,
    description: tool.description || tool.title || name,
    parameters: tool.inputSchema || { type: "object", properties: {}, additionalProperties: false }
  }));
}

function isOfficialOpenAiBaseUrl(baseUrl = "") {
  try {
    const hostname = new URL(normalizeBaseUrl(baseUrl || DEFAULT_OPENAI_BASE_URL)).hostname.toLowerCase();
    return hostname === "api.openai.com" || hostname.endsWith(".openai.com");
  } catch {
    return false;
  }
}

function promptCacheWorkflow(requestType = "") {
  const text = cleanText(requestType).toLowerCase();
  if (text.includes("search_plan") || /\bdiscover|discovery|candidate|search|rank|music\b/.test(text)) return "discovery";
  if (text.includes("standby_final_review") || /\bverify|verification|review|resolve\b/.test(text)) return "verification";
  return "roon-reasoning";
}

function promptCacheKeyFor(requestType = "", tier = "") {
  const workflow = promptCacheWorkflow(requestType);
  const selectedTier = normalizeTier(tier, DEFAULT_SYNAPSE_TIER);
  return `rabbit-hole-${workflow}-v1-${selectedTier}`.slice(0, 64);
}

function cacheLogStats(usage = {}) {
  const inputTokens = Number(usage.inputTokens || 0);
  const cachedInputTokens = Number(usage.cachedInputTokens || 0);
  const uncachedInputTokens = Math.max(0, Number(usage.uncachedInputTokens ?? (inputTokens - cachedInputTokens)));
  const cacheHitPercent = inputTokens > 0
    ? Number((Number(usage.cacheHitPercent ?? ((cachedInputTokens / inputTokens) * 100))).toFixed(1))
    : 0;
  return { uncachedInputTokens, cacheHitPercent };
}

class CompactConversationState {
  constructor(limit = 8, memory = null) {
    this.memory = memory;
    this.limit = Math.max(2, Number(limit || 8));
    this.turns = [];
    this.summary = memory?.read().rollingSummary || "";
    this.turns = memory?.read().recentTurns.slice(-this.limit) || [];
  }

  add(role, content, meta = {}) {
    const text = cleanText(content);
    this.memory?.recordTurn(role, text);
    if (!text) return;
    this.turns.push({
      role,
      content: text.length > 900 ? `${text.slice(0, 900)}...` : text,
      provider: meta.provider || "",
      at: nowIso()
    });
    if (this.turns.length > this.limit) {
      const dropped = this.turns.splice(0, this.turns.length - this.limit);
      const compact = dropped.map((turn) => `${turn.role}: ${turn.content}`).join(" | ");
      this.summary = cleanText(`${this.summary} ${compact}`).slice(-1800);
    }
  }

  contextText() {
    const recent = this.turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
    return [
      this.summary ? `Older compact summary: ${this.summary}` : "",
      recent ? `Recent turns:\n${recent}` : ""
    ].filter(Boolean).join("\n\n");
  }
}

class LocalModelProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.memory = options.memory || null;
    this.tools = options.tools || {};
    this.fetch = options.fetch || global.fetch;
    this.timeoutMs = Math.max(5_000, Number(options.timeoutMs || 45_000));
  }

  get name() {
    return LOCAL_MODE;
  }

  async chatModel(message, context = "") {
    const config = this.config;
    context = [this.memory?.context(message), context].filter(Boolean).join("\n\n");
    const messages = [
      {
        role: "system",
        content: "You are the local Rabbit Hole music assistant. Keep answers compact. Use the supplied context only; do not claim to have controlled Roon or TIDAL unless a tool result was supplied."
      },
      ...(context ? [{ role: "user", content: `Rabbit Hole context:\n${context}` }] : []),
      { role: "user", content: message }
    ];

    if (OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider)) {
      const activeModel = await require("./localModelRuntime").resolveLocalModel(config, this.fetch);
      const baseUrl = normalizeBaseUrl(config.openAiCompatibleBaseUrl);
      const headers = { "content-type": "application/json" };
      if (config.openAiCompatibleApiKey) headers.authorization = `Bearer ${config.openAiCompatibleApiKey}`;
      const { response, body, text } = await fetchJsonWithTimeout(this.fetch, `${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: activeModel,
          messages,
          temperature: 0.35,
          top_p: 0.9
        })
      }, this.timeoutMs);
      if (!response.ok) throw new Error(`Local OpenAI-compatible chat failed: ${response.status} ${text}`);
      return cleanText(body.choices?.[0]?.message?.content) || "Local model returned an empty response.";
    }

    if (config.llmProvider === "openrouter") {
      if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not set.");
      const { response, body, text } = await fetchJsonWithTimeout(this.fetch, "https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.openRouterApiKey}`,
          "content-type": "application/json",
          "http-referer": "http://localhost",
          "x-title": "The Rabbit Hole"
        },
        body: JSON.stringify({
          model: config.openRouterModel,
          messages,
          temperature: 0.35
        })
      }, this.timeoutMs);
      if (!response.ok) throw new Error(`OpenRouter chat failed: ${response.status} ${text}`);
      return cleanText(body.choices?.[0]?.message?.content) || "OpenRouter returned an empty response.";
    }

    const baseUrl = normalizeBaseUrl(config.ollamaBaseUrl);
    const { response, body, text } = await fetchJsonWithTimeout(this.fetch, `${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages,
        stream: false,
        options: { temperature: 0.35, top_p: 0.9 }
      })
    }, this.timeoutMs);
    if (!response.ok) throw new Error(`Ollama chat failed: ${response.status} ${text}`);
    return cleanText(body.message?.content || body.response) || "Local model returned an empty response.";
  }

  parseRating(message = "") {
    const text = String(message || "").toLowerCase();
    if (/\b(never\s+again|reject\s+similar)\b/.test(text)) return "never";
    if (/\bwrong\s+genre\b/.test(text)) return "wrong_genre";
    if (/\b(love|loved)\b/.test(text)) return "love";
    if (/\bgood\b/.test(text)) return "good";
    if (/\bok(?:ay)?\b/.test(text)) return "ok";
    if (/\b(skip|reject|dislike)\b/.test(text)) return "skip";
    return "";
  }

  parseTransport(message = "") {
    const text = String(message || "").toLowerCase();
    if (/\b(next|skip\s+track)\b/.test(text)) return "next";
    if (/\b(prev|previous|back)\b/.test(text)) return "previous";
    if (/\bstop\b/.test(text)) return "stop";
    if (/\bpause\b/.test(text)) return "pause";
    if (/\b(play|resume)\b/.test(text)) return "play";
    return "";
  }

  parseCount(message = "", fallback = 12, max = 40) {
    const match = String(message || "").match(/\b(\d{1,2})\s*(?:track|song|candidate|pick)s?\b/i);
    const count = match ? Number(match[1]) : fallback;
    return Math.max(1, Math.min(max, Number.isFinite(count) ? count : fallback));
  }

  async executeTool(name, input = {}) {
    const tool = this.tools[name];
    if (!tool) throw new Error(`Rabbit Hole tool is not available: ${name}`);
    const startedAt = Date.now();
    const result = await tool.handler(input);
    return {
      name,
      input,
      result,
      latencyMs: Date.now() - startedAt
    };
  }

  summarizeToolResult(call = {}) {
    const result = call.result || {};
    if (call.name === "get_rabbit_hole_status") return compactNowPlaying(result);
    if (call.name === "rate_now_playing") {
      const track = result.track || {};
      return `Rated ${track.artist || "current track"} - ${track.title || "now playing"} as ${result.rating}.`;
    }
    if (call.name === "control_roon") return `Sent ${result.control || call.input?.control || "control"} to ${result.zone?.name || "Roon"}.`;
    if (call.name === "search_rabbit_hole") return `Rabbit Hole found ${Array.isArray(result.tracks) ? result.tracks.length : 0} verified tracks from ${result.requestedCount || call.input?.count || "the"} requested.`;
    if (call.name === "verify_tracks") return `Rabbit Hole verified ${result.usableCount || 0}/${result.checkedCount || result.requestedCount || 0} candidate tracks as usable.`;
    if (call.name === "queue_rabbit_hole_tracks" || call.name === "queue_standby_tracks") return `Queued ${result.queuedCount || 0} tracks in Roon.`;
    if (call.name === "refresh_standby_pool") return `Standby pool refreshed: ${result.count || 0}/${result.targetCount || 25} tracks.`;
    return truncate(result, 700);
  }

  async respond(message, options = {}) {
    const calls = [];
    const text = cleanText(message);
    const lower = text.toLowerCase();

    if (/\b(what'?s|what is|show|get|status).*\b(playing|roon|rabbit hole|status)\b/.test(lower) || /\bnow playing\b/.test(lower)) {
      calls.push(await this.executeTool("get_rabbit_hole_status"));
      return {
        text: this.summarizeToolResult(calls[0]),
        toolCalls: calls,
        provider: LOCAL_MODE,
        model: options.localModel || ""
      };
    }

    if (/\b(refresh|reload|rebuild)\b.*\bstandby\b/.test(lower)) {
      calls.push(await this.executeTool("refresh_standby_pool", { reason: "local-router", request: text }));
      return {
        text: this.summarizeToolResult(calls[0]),
        toolCalls: calls,
        provider: LOCAL_MODE,
        model: options.localModel || ""
      };
    }

    const transport = this.parseTransport(text);
    if (transport && !/\b(rate|rated|rating|feedback)\b/.test(lower)) {
      calls.push(await this.executeTool("control_roon", { control: transport }));
      return {
        text: this.summarizeToolResult(calls[0]),
        toolCalls: calls,
        provider: LOCAL_MODE,
        model: options.localModel || ""
      };
    }

    const rating = this.parseRating(text);
    if (rating && /\b(this|track|song|now playing|it)\b/.test(lower)) {
      calls.push(await this.executeTool("rate_now_playing", { rating, reason: text }));
      return {
        text: this.summarizeToolResult(calls[0]),
        toolCalls: calls,
        provider: LOCAL_MODE,
        model: options.localModel || ""
      };
    }

    if (/\b(find|discover|search|generate)\b/.test(lower) && /\b(track|song|music|candidate|playlist|progressive|house|trance|techno|genre)\b/.test(lower)) {
      const count = this.parseCount(text);
      calls.push(await this.executeTool("search_rabbit_hole", {
        request: text,
        count,
        requireRoonQueueable: /\b(roon|queue|hqplayer)\b/i.test(text),
        preferExtendedMixes: /\b(long|extended|7\+|8\+|over\s+\d+\s+min)\b/i.test(text)
      }));
      if (/\b(queue|add\s+next|load\s+into\s+roon)\b/i.test(text)) {
        calls.push(await this.executeTool("queue_rabbit_hole_tracks", {
          count: Math.min(count, this.parseCount(text, 10)),
          mode: /\b(next|add\s+next)\b/i.test(text) ? "next" : "append",
          preferExtendedMixes: /\b(long|extended|7\+|8\+|over\s+\d+\s+min)\b/i.test(text)
        }));
      }
      return {
        text: calls.map((call) => this.summarizeToolResult(call)).join(" "),
        toolCalls: calls,
        provider: LOCAL_MODE,
        model: options.localModel || ""
      };
    }

    const localText = await this.chatModel(text, options.context || "");
    return {
      text: localText,
      toolCalls: calls,
      provider: LOCAL_MODE,
      model: options.localModel || ""
    };
  }
}

class OpenAIModelProvider {
  constructor(options = {}) {
    this.memory = options.memory || null;
    this.config = options.config || {};
    this.tools = options.tools || {};
    this.fetch = options.fetch || global.fetch;
    this.ledger = options.ledger || new OpenAiUsageLedger();
    this.logger = options.logger || console;
    this.tiers = normalizeSynapseTiers(this.config.tiers || {}, this.config);
    this.defaultTier = normalizeTier(this.config.defaultTier || tierFromModel(this.config.model), DEFAULT_SYNAPSE_TIER);
    this.selectedTier = this.defaultTier;
    this.tierRuntimeStatus = SYNAPSE_TIER_ORDER.reduce((result, tier) => {
      result[tier] = {
        key: tier,
        label: SYNAPSE_TIER_LABELS[tier],
        state: this.config.enabled ? "configured" : "disabled",
        connected: false,
        lastSuccessAt: "",
        lastErrorAt: "",
        lastError: ""
      };
      return result;
    }, {});
    const selected = this.tierConfig(this.selectedTier);
    this.status = {
      provider: SYNAPSE_MODE,
      label: "SYNAPSE",
      enabled: Boolean(this.config.enabled),
      configured: Boolean(this.config.apiKey),
      connected: false,
      state: this.config.enabled ? "unknown" : "disabled",
      model: selected.model || DEFAULT_OPENAI_MODEL,
      selectedTier: selected.key,
      selectedTierLabel: selected.label,
      defaultTier: this.defaultTier,
      lastSuccessAt: "",
      lastErrorAt: "",
      lastError: "",
      latencyMs: 0
    };
  }

  get name() {
    return SYNAPSE_MODE;
  }

  endpoint(pathname) {
    return `${normalizeBaseUrl(this.config.baseUrl || DEFAULT_OPENAI_BASE_URL)}${pathname}`;
  }

  headers() {
    return {
      authorization: `Bearer ${this.config.apiKey || ""}`,
      "content-type": "application/json"
    };
  }

  promptCacheKey(requestType = "", tier = "") {
    if (!isOfficialOpenAiBaseUrl(this.config.baseUrl || DEFAULT_OPENAI_BASE_URL)) return "";
    return promptCacheKeyFor(requestType, tier || this.selectedTier || this.defaultTier);
  }

  applyPromptCache(body, options = {}, selected = {}) {
    const key = options.promptCacheKey || this.promptCacheKey(options.requestType || "chat", selected.key);
    if (key) body.prompt_cache_key = key;
    return key;
  }

  tierConfig(tier = "") {
    const key = normalizeTier(tier || this.selectedTier || this.defaultTier, this.defaultTier);
    return this.tiers[key] || this.tiers[this.defaultTier] || {
      key: DEFAULT_SYNAPSE_TIER,
      label: SYNAPSE_TIER_LABELS[DEFAULT_SYNAPSE_TIER],
      model: DEFAULT_OPENAI_MODEL,
      maxOutputTokens: 0,
      reasoningEffort: "",
      reasoningMode: "",
      rates: {},
      budgets: {}
    };
  }

  setTier(tier = "") {
    const selected = this.tierConfig(tier);
    this.selectedTier = selected.key;
    this.status = {
      ...this.status,
      model: selected.model,
      selectedTier: selected.key,
      selectedTierLabel: selected.label
    };
    return selected;
  }

  setModel(model = "", tier = "") {
    const clean = cleanText(model);
    if (!clean) return this.tierConfig(tier);
    const selected = this.tierConfig(tier || this.selectedTier);
    this.tiers[selected.key] = {
      ...selected,
      model: clean
    };
    this.config.model = clean;
    this.status = {
      ...this.status,
      model: clean,
      selectedTier: selected.key,
      selectedTierLabel: selected.label
    };
    return this.tiers[selected.key];
  }

  reasoningConfig(selected = {}) {
    const reasoning = {};
    if (selected.reasoningEffort) reasoning.effort = selected.reasoningEffort;
    if (selected.reasoningMode) reasoning.mode = selected.reasoningMode;
    return Object.keys(reasoning).length ? reasoning : null;
  }

  safeTierStatuses() {
    return SYNAPSE_TIER_ORDER.reduce((result, tier) => {
      const config = this.tierConfig(tier);
      const runtime = this.tierRuntimeStatus[tier] || {};
      const budget = this.ledger.budgetState(0, tier);
      result[tier] = {
        key: tier,
        label: config.label,
        model: config.model,
        configured: Boolean(config.model && this.config.apiKey),
        enabled: Boolean(this.config.enabled),
        available: Boolean(this.config.enabled && this.config.apiKey && config.model && !budget.limited),
        state: budget.limited ? "budget_limit_reached" : (runtime.state || (this.config.enabled ? "configured" : "disabled")),
        connected: Boolean(runtime.connected),
        lastSuccessAt: runtime.lastSuccessAt || "",
        lastErrorAt: runtime.lastErrorAt || "",
        lastError: runtime.lastError || "",
        usage: this.ledger.totals().byTier?.[tier] || null,
        budget
      };
      return result;
    }, {});
  }

  safeStatus() {
    return {
      ...this.status,
      selectedTier: this.selectedTier,
      selectedTierLabel: tierLabel(this.selectedTier),
      defaultTier: this.defaultTier,
      tiers: this.safeTierStatuses(),
      apiKeyConfigured: Boolean(this.config.apiKey),
      usage: {
        ...this.ledger.totals(),
        budget: this.ledger.budgetState(0, this.selectedTier)
      }
    };
  }

  applySuccess(extra = {}) {
    const tier = normalizeTier(extra.tier || extra.selectedTier || this.selectedTier, "");
    if (tier) {
      this.tierRuntimeStatus[tier] = {
        ...(this.tierRuntimeStatus[tier] || {}),
        key: tier,
        label: SYNAPSE_TIER_LABELS[tier],
        state: "connected",
        connected: true,
        lastSuccessAt: nowIso(),
        lastError: ""
      };
      this.selectedTier = tier;
    }
    this.status = {
      ...this.status,
      ...extra,
      enabled: Boolean(this.config.enabled),
      configured: Boolean(this.config.apiKey),
      connected: true,
      state: "connected",
      lastSuccessAt: nowIso(),
      lastError: "",
      selectedTier: tier || this.selectedTier,
      selectedTierLabel: tierLabel(tier || this.selectedTier)
    };
  }

  applyError(error, state = "api_error", extra = {}) {
    const tier = normalizeTier(extra.tier || extra.selectedTier || this.selectedTier, "");
    if (tier) {
      this.tierRuntimeStatus[tier] = {
        ...(this.tierRuntimeStatus[tier] || {}),
        key: tier,
        label: SYNAPSE_TIER_LABELS[tier],
        state,
        connected: false,
        lastErrorAt: nowIso(),
        lastError: error?.message || String(error || "OpenAI request failed")
      };
    }
    this.status = {
      ...this.status,
      ...extra,
      enabled: Boolean(this.config.enabled),
      configured: Boolean(this.config.apiKey),
      connected: false,
      state,
      lastErrorAt: nowIso(),
      lastError: error?.message || String(error || "OpenAI request failed"),
      selectedTier: tier || this.selectedTier,
      selectedTierLabel: tierLabel(tier || this.selectedTier)
    };
  }

  errorState(response, body = {}) {
    if (response.status === 401 || response.status === 403) return "authentication_error";
    if (response.status === 429) return "rate_limited";
    if (response.status >= 500) return "api_error";
    if (response.status === 404) return "api_error";
    return "api_error";
  }

  assertConfigured(tier = "") {
    const selected = this.tierConfig(tier);
    if (!this.config.enabled) {
      const error = new Error("OpenAI/Synapse is disabled.");
      this.applyError(error, "disabled", { tier: selected.key, model: selected.model });
      throw error;
    }
    if (!this.config.apiKey) {
      const error = new Error("OPENAI_API_KEY is not set.");
      this.applyError(error, "not_configured", { tier: selected.key, model: selected.model });
      throw error;
    }
    if (!selected.model) {
      const error = new Error(`OpenAI model is not set for ${selected.label}.`);
      this.applyError(error, "not_configured", { tier: selected.key, model: selected.model });
      throw error;
    }
    const budget = this.ledger.budgetState(0, selected.key);
    if (budget.limited) {
      const error = new Error(`OpenAI/Synapse budget limit reached for ${selected.label}.`);
      this.applyError(error, "budget_limit_reached", { tier: selected.key, model: selected.model });
      throw error;
    }
    return selected;
  }

  canUseTier(tier = "") {
    try {
      this.assertConfigured(tier);
      return true;
    } catch {
      return false;
    }
  }

  async checkHealth(options = {}) {
    this.status = { ...this.status, state: this.status.connected ? "connected" : "checking" };
    try {
      const selected = this.assertConfigured(options.tier || this.selectedTier);
      const startedAt = Date.now();
      const model = encodeURIComponent(selected.model || DEFAULT_OPENAI_MODEL);
      const { response, body, text } = await fetchJsonWithTimeout(this.fetch, this.endpoint(`/models/${model}`), {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.apiKey}` }
      }, Math.max(1_000, Number(options.timeoutMs || this.config.healthTimeoutMs || 6_000)));
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const error = new Error(body?.error?.message || body?.message || text || `OpenAI status returned HTTP ${response.status}`);
        this.applyError(error, this.errorState(response, body), { latencyMs, tier: selected.key, model: selected.model });
        return this.safeStatus();
      }
      this.applySuccess({
        latencyMs,
        tier: selected.key,
        model: body.id || selected.model || DEFAULT_OPENAI_MODEL
      });
      return this.safeStatus();
    } catch (error) {
      if (this.status.state === "disabled" || this.status.state === "not_configured" || this.status.state === "budget_limit_reached") {
        return this.safeStatus();
      }
      this.applyError(error, /timed out|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message || "") ? "disconnected" : "api_error");
      return this.safeStatus();
    }
  }

  async executeTool(call = {}) {
    const tool = this.tools[call.name];
    if (!tool) throw new Error(`Unknown Rabbit Hole tool: ${call.name}`);
    const input = safeJsonParse(call.arguments || "{}", {});
    const result = await tool.handler(input);
    return {
      type: "function_call_output",
      call_id: call.callId,
      output: truncate(result)
    };
  }

  requestBody(input, previousResponseId = "", options = {}) {
    const selected = this.tierConfig(options.tier);
    const body = {
      model: selected.model || DEFAULT_OPENAI_MODEL,
      input,
      tools: openAiToolsFromRabbitHole(this.tools),
      tool_choice: "auto"
    };
    if (previousResponseId) body.previous_response_id = previousResponseId;
    if (selected.maxOutputTokens) body.max_output_tokens = Number(selected.maxOutputTokens);
    const reasoning = this.reasoningConfig(selected);
    if (reasoning) body.reasoning = reasoning;
    if (!previousResponseId) {
      body.instructions = [
        "You are Synapse, the OpenAI reasoning model inside The Rabbit Hole.",
        `You are currently running as the ${selected.label} tier (${selected.model}).`,
        "Use Rabbit Hole tools for facts and actions. Do not claim Roon, TIDAL, standby, or feedback actions succeeded until a tool result confirms it.",
        "Keep answers concise and practical. Prefer current Rabbit Hole state over memory. Ask for clarification only when an action would be unsafe or impossible.",
        "For discovery quality, let Rabbit Hole search and verify the real catalog. Do not invent tracks.",
        "For a resolution-only request, use resolve_verified_tracks_for_roon. With queue authorization, call queue_verified_tracks directly even when saved tracks are TIDAL_VERIFIED_ROON_PENDING: it resolves pending identities and queues through the existing bulk Roon service. Never rerun TIDAL verification or discovery to retry Roon. Report timeout, not-found and version mismatch separately.",
        "For supplied lists with queue authorization, call roon_queue_tracks with structured track objects and matchPolicy flexible by default. Never send these through search_rabbit_hole or a natural-language list parser. Use roon_search_track for resolution diagnostics and roon_get_queue to inspect results. Use matchPolicy strict for exact versions/no substitutions. Do not pre-verify trusted lists. Use strict only for explicit verify-first, exact-version-only, availability or queueability requirements. Retry only failed requestedTrack objects through roon_queue_tracks; never resend successes. For QUEUE_FAILED with an uncertain acknowledgement, inspect roon_get_queue before retrying. For verification-only requests call verify_exact_tracks, never search_rabbit_hole. Preserve list line breaks and exact titles. Do not apply discovery, novelty or replacement tracks. Verification alone does not authorize queueing. A later queue request uses queue_verified_tracks for saved TIDAL identities, including pending Roon resolution. Roon lookup is required and allowed; another TIDAL lookup or discovery search is not.",
        `Available Rabbit Hole tools: ${compactToolList(this.tools)}.`
      ].join("\n");
    }
    this.applyPromptCache(body, options, selected);
    return body;
  }

  async postResponse(body, options = {}) {
    const query = options.memoryQuery || (typeof body.input === "string" ? body.input : JSON.stringify(body.input));
    const remembered = this.memory?.context(query, {cloud:true});
    body = {...body, instructions: ["You are Synapse, the OpenAI-based assistant inside Rabbit Hole.", body.instructions, remembered].filter(Boolean).join("\n\n")};
    const retries = Math.max(0, Math.min(5, Number(options.retryCount ?? this.config.retryCount ?? 0)));
    const retryDelayMs = Math.max(0, Number(this.config.retryDelayMs || 750));
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      last = await fetchJsonWithTimeout(this.fetch, this.endpoint("/responses"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body)
      }, Math.max(5_000, Number(options.timeoutMs || this.config.timeoutMs || 60_000)));

      if (last.response.ok || ![429, 500, 502, 503, 504].includes(last.response.status) || attempt >= retries) {
        return last;
      }
      await sleep(retryDelayMs * (attempt + 1));
    }
    return last;
  }

  async completeJsonPrompt(prompt, options = {}) {
    let selected;
    try { selected = this.assertConfigured(options.tier); } catch(error) { error.requestSent=false; throw error; }
    const startedAt = Date.now();
    const body = {
      model: selected.model || DEFAULT_OPENAI_MODEL,
      input: cleanText(prompt),
      instructions: "Return only valid JSON. Do not include Markdown, prose, or code fences."
    };
    if (selected.maxOutputTokens) body.max_output_tokens = Number(selected.maxOutputTokens);
    const reasoning = this.reasoningConfig(selected);
    if (reasoning) body.reasoning = reasoning;
    const promptCacheKey = this.applyPromptCache(body, options, selected);

    const { response, body: responseBody, text: rawText } = await this.postResponse(body, options);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const error = new Error(responseBody?.error?.message || responseBody?.message || rawText || `OpenAI request returned HTTP ${response.status}`);
      error.synapseFailureType = response.status === 429 ? "rate_limit" : [401,403].includes(response.status) ? "authentication" : response.status === 404 ? "model_unavailable" : "api_error";
      this.applyError(error, this.errorState(response, responseBody), { latencyMs, tier: selected.key, model: selected.model });
      throw error;
    }

    const usage = usageFromResponse(responseBody);
    const costUsd = estimateCost(usage, selected.rates || this.ledger.rates);
    const logEntry = this.ledger.record({
      provider: SYNAPSE_MODE,
      tier: selected.key,
      model: selected.model,
      requestType: options.requestType || "json",
      usage,
      costUsd,
      latencyMs,
      toolCalls: 0,
      promptCacheKey
    });
    const cacheStats = cacheLogStats(usage);
    this.logger.log(`[OpenAI Usage] tier=${selected.key} model=${selected.model} requestType=${options.requestType || "json"} cacheKey=${promptCacheKey || "n/a"} input=${usage.inputTokens || 0} cached=${usage.cachedInputTokens || 0} uncached=${cacheStats.uncachedInputTokens} cacheHitPct=${cacheStats.cacheHitPercent} output=${usage.outputTokens || 0} cost=${costUsd ?? "n/a"} latencyMs=${latencyMs} toolCalls=0`);
    this.applySuccess({ latencyMs, tier: selected.key, model: selected.model });
    return {
      text: responseText(responseBody),
      tier: selected.key,
      tierLabel: selected.label,
      model: selected.model,
      usage,
      costUsd,
      latencyMs,
      usageLog: logEntry
    };
  }

  async respond(message, options = {}) {
    const selected = this.assertConfigured(options.tier);
    const startedAt = Date.now();
    const input = [
      {
        role: "user",
        content: [
          options.context ? `Compact Rabbit Hole context:\n${options.context}` : "",
          cleanText(message)
        ].filter(Boolean).join("\n\n")
      }
    ];
    let previousResponseId = "";
    let nextInput = input;
    let usage = {};
    let text = "";
    const toolCalls = [];
    const maxToolRounds = Math.max(1, Math.min(10, Number(this.config.maxToolRounds || 6)));
    let promptCacheKey = "";

    for (let round = 0; round <= maxToolRounds; round += 1) {
      const body = this.requestBody(nextInput, previousResponseId, { tier: selected.key, requestType: options.requestType || "chat" });
      promptCacheKey = promptCacheKey || body.prompt_cache_key || "";
      const { response, body: responseBody, text: rawText } = await this.postResponse(body, {memoryQuery:message});

      if (!response.ok) {
        const error = new Error(responseBody?.error?.message || responseBody?.message || rawText || `OpenAI request returned HTTP ${response.status}`);
        this.applyError(error, this.errorState(response, responseBody), { latencyMs: Date.now() - startedAt, tier: selected.key, model: selected.model });
        throw error;
      }

      usage = mergeUsage(usage, usageFromResponse(responseBody));
      previousResponseId = responseBody.id || previousResponseId;
      text = responseText(responseBody) || text;
      const calls = functionCalls(responseBody);
      if (!calls.length) break;

      const outputs = [];
      for (const call of calls) {
        const toolStartedAt = Date.now();
        try {
          const output = await this.executeTool(call);
          outputs.push(output);
          toolCalls.push({
            name: call.name,
            ok: true,
            latencyMs: Date.now() - toolStartedAt
          });
        } catch (error) {
          outputs.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({ error: error.message || "Rabbit Hole tool failed." })
          });
          toolCalls.push({
            name: call.name,
            ok: false,
            error: error.message || "Rabbit Hole tool failed.",
            latencyMs: Date.now() - toolStartedAt
          });
        }
      }
      nextInput = outputs;
    }

    const latencyMs = Date.now() - startedAt;
    const costUsd = estimateCost(usage, selected.rates || this.ledger.rates);
    const logEntry = this.ledger.record({
      provider: SYNAPSE_MODE,
      tier: selected.key,
      model: selected.model,
      requestType: options.requestType || "chat",
      usage,
      costUsd,
      latencyMs,
      toolCalls: toolCalls.length,
      promptCacheKey
    });
    const cacheStats = cacheLogStats(usage);
    this.logger.log(`[OpenAI Usage] tier=${selected.key} model=${selected.model} requestType=${options.requestType || "chat"} cacheKey=${promptCacheKey || "n/a"} input=${usage.inputTokens || 0} cached=${usage.cachedInputTokens || 0} uncached=${cacheStats.uncachedInputTokens} cacheHitPct=${cacheStats.cacheHitPercent} output=${usage.outputTokens || 0} cost=${costUsd ?? "n/a"} latencyMs=${latencyMs} toolCalls=${toolCalls.length}`);
    this.applySuccess({ latencyMs, tier: selected.key, model: selected.model });
    return {
      text: text || "Synapse completed the request.",
      provider: SYNAPSE_MODE,
      tier: selected.key,
      tierLabel: selected.label,
      model: selected.model,
      usage,
      costUsd,
      latencyMs,
      toolCalls,
      usageLog: logEntry
    };
  }
}

class AutoModelRouter {
  constructor(options = {}) {
    this.memory = options.memory || null;
    this.config = options.config || {};
    this.tools = options.tools || {};
    this.localProvider = options.localProvider;
    this.openAiProvider = options.openAiProvider;
    this.conversation = options.conversation || new CompactConversationState(8, this.memory);
    this.mode = normalizeMode(this.config.mode || AUTO_MODE);
    this.selectedTier = normalizeTier(this.config.openai?.defaultTier || tierFromModel(this.config.openai?.model), DEFAULT_SYNAPSE_TIER);
    this.maxSynapseAttempts = Math.max(1, Math.min(SYNAPSE_TIER_ORDER.length, Number(this.config.openai?.maxEscalationAttempts || SYNAPSE_TIER_ORDER.length)));
    if (this.openAiProvider?.setTier) this.openAiProvider.setTier(this.selectedTier);
    this.lastDecision = {
      mode: this.mode,
      provider: LOCAL_MODE,
      reason: "initialized",
      fallback: false,
      tier: "",
      tierLabel: "",
      at: nowIso()
    };
    this.logger = options.logger || console;
  }

  localModelName() {
    if (OPENAI_COMPATIBLE_PROVIDERS.has(this.config.local?.llmProvider)) return this.config.local?.openAiCompatibleModel || "";
    if (this.config.local?.llmProvider === "openrouter") return this.config.local?.openRouterModel || "";
    return this.config.local?.ollamaModel || "";
  }

  setMode(mode) {
    const tier = normalizeTier(mode, "");
    if (tier) {
      this.mode = SYNAPSE_MODE;
      this.selectedTier = tier;
      if (this.openAiProvider?.setTier) this.openAiProvider.setTier(tier);
    } else {
      this.mode = normalizeMode(mode, this.mode);
    }
    this.lastDecision = {
      ...this.lastDecision,
      mode: this.mode,
      tier: this.mode === SYNAPSE_MODE ? this.selectedTier : this.lastDecision.tier,
      tierLabel: this.mode === SYNAPSE_MODE ? tierLabel(this.selectedTier) : this.lastDecision.tierLabel,
      at: nowIso()
    };
    return this.status();
  }

  setSynapseTier(tier = "") {
    const selected = normalizeTier(tier, this.selectedTier);
    this.selectedTier = selected;
    if (this.openAiProvider?.setTier) this.openAiProvider.setTier(selected);
    this.lastDecision = {
      ...this.lastDecision,
      tier: selected,
      tierLabel: tierLabel(selected),
      at: nowIso()
    };
    return this.status();
  }

  setOpenAiModel(model = "", tier = "") {
    const selected = normalizeTier(tier, this.selectedTier);
    const clean = cleanText(model);
    if (clean && this.openAiProvider?.setModel) {
      this.openAiProvider.setModel(clean, selected);
      this.selectedTier = selected;
    }
    return this.status();
  }

  async refreshSynapseStatus(options = {}) {
    if (!this.openAiProvider) return null;
    return this.openAiProvider.checkHealth(options);
  }

  status() {
    return {
      mode: this.mode,
      selectedTier: this.selectedTier,
      selectedTierLabel: tierLabel(this.selectedTier),
      activeProvider: this.lastDecision.provider || LOCAL_MODE,
      activeProviderLabel: this.lastDecision.provider === SYNAPSE_MODE ? "SYNAPSE" : "LOCAL",
      lastDecision: { ...this.lastDecision },
      local: {
        provider: LOCAL_MODE,
        label: "LOCAL",
        model: this.localModelName()
      },
      synapse: this.openAiProvider ? this.openAiProvider.safeStatus() : null,
      tools: {
        count: Object.keys(this.tools).length,
        names: Object.keys(this.tools).sort()
      }
    };
  }

  isSynapseUsable() {
    const status = this.openAiProvider?.safeStatus();
    return Boolean(status?.enabled && status?.configured && status?.state !== "budget_limit_reached");
  }

  isSynapseTierUsable(tier = "") {
    const status = this.openAiProvider?.safeStatus();
    const selected = normalizeTier(tier, this.selectedTier);
    const tierStatus = status?.tiers?.[selected];
    if (!status?.enabled || !status?.configured) return false;
    if (tierStatus && tierStatus.available === false) return false;
    if (status.state === "budget_limit_reached") return false;
    return this.openAiProvider?.canUseTier ? this.openAiProvider.canUseTier(selected) : true;
  }

  routeAuto(message = "") {
    const text = String(message || "").toLowerCase();
    if (/\b(what'?s playing|now playing|love this|good this|ok this|wrong genre|skip this|never again|pause|play|stop|next|previous|refresh standby)\b/.test(text)) {
      return { provider: LOCAL_MODE, tier: "", reason: "routine playback or feedback command" };
    }
    if (/\b(maximum|hardest|think really hard|architect(?:ure|ural)|algorithmic|debug|troubleshoot|major|reconstruct|autonomous|repeated failure|sol\b)\b/.test(text)) {
      return { provider: SYNAPSE_MODE, tier: "sol", reason: "hard reasoning, debugging, or architecture task" };
    }
    if (/\b(last\s+\d{2,}|100\s+rated|substantial|deep(?:er)? preference|preference analysis|predict|separates|characteristics|compare many|difficult|ambiguous|multi[-\s]?stage|multi[-\s]?step|based on that analysis|eliminate weak|strongest\s+\d+|large history|terra\b)\b/.test(text)) {
      return { provider: SYNAPSE_MODE, tier: "terra", reason: "large preference-history analysis or difficult multi-stage discovery" };
    }
    if (/\b(find|discover|search|generate|rank|ranking|candidate|candidates|validate|filter|summari[sz]e|extract|profile|best\s+\d+|over\s+\d+\s+minutes|avoid\s+repeats|surprise|queue\s+the\s+best|luna\b)\b/.test(text)) {
      return { provider: SYNAPSE_MODE, tier: "luna", reason: "music discovery, candidate validation, or moderate tool workflow" };
    }
    return { provider: LOCAL_MODE, tier: "", reason: "local-first default" };
  }

  shouldEscalate(message = "") {
    const route = this.routeAuto(message);
    return {
      escalate: route.provider === SYNAPSE_MODE,
      tier: route.tier || "",
      reason: route.reason
    };
  }

  chooseProvider(message = "", requestedMode = "", requestedTier = "") {
    const explicitTier = normalizeTier(requestedTier || requestedMode, "");
    const mode = explicitTier ? SYNAPSE_MODE : normalizeMode(requestedMode || this.mode);
    if (mode === LOCAL_MODE) return { mode, provider: LOCAL_MODE, tier: "", reason: "explicit local mode" };
    if (mode === SYNAPSE_MODE) {
      const tier = explicitTier || this.selectedTier || DEFAULT_SYNAPSE_TIER;
      return {
        mode,
        provider: SYNAPSE_MODE,
        tier,
        tierLabel: tierLabel(tier),
        reason: explicitTier ? `explicit ${tierLabel(tier)} tier` : "explicit Synapse mode"
      };
    }
    const route = this.routeAuto(message);
    return {
      mode,
      provider: route.provider,
      tier: route.tier || "",
      tierLabel: tierLabel(route.tier || ""),
      reason: route.reason
    };
  }

  synapseAttemptTiers(preferredTier = "") {
    const preferred = normalizeTier(preferredTier, DEFAULT_SYNAPSE_TIER);
    const start = Math.max(0, SYNAPSE_TIER_ORDER.indexOf(preferred));
    return SYNAPSE_TIER_ORDER.slice(start).slice(0, this.maxSynapseAttempts);
  }

  synapseResponseNeedsEscalation(response = {}) {
    return Array.isArray(response.toolCalls) && response.toolCalls.some((call) => call && call.ok === false);
  }

  escalationPathLabel(attempts = []) {
    return attempts.map((attempt) => tierLabel(attempt.tier) || attempt.tier).filter(Boolean).join(" -> ");
  }

  async generateSearchPlan(options = {}, localGenerateSearchPlan, timeoutMs = 45_000) {
    const request = cleanText(options.request || "Find tasteful music discoveries.");
    const requestedTier = normalizeTier(options.aiTier || options.tier || options.aiMode, "");
    const decision = this.chooseProvider(request, options.aiMode || "", requestedTier);
    const localPlan = async (fallbackError = "") => {
      const result = await localGenerateSearchPlan(options, timeoutMs);
      this.lastDecision = {
        mode: decision.mode,
        provider: LOCAL_MODE,
        requestedProvider: decision.provider,
        requestedTier: decision.tier || "",
        reason: fallbackError ? `${decision.reason}; Synapse unavailable, fell back to local planner` : decision.reason,
        fallback: Boolean(fallbackError),
        error: fallbackError,
        model: this.localModelName(),
        tier: "",
        tierLabel: "",
        escalationPath: [],
        toolCalls: 0,
        at: nowIso()
      };
      return {
        ...result,
        routing: { ...this.lastDecision }
      };
    };

    if (decision.provider !== SYNAPSE_MODE) {
      return localPlan("");
    }

    const attempted = [];
    try {
      if (!this.isSynapseTierUsable(decision.tier)) {
        await this.refreshSynapseStatus({ timeoutMs: this.config.openai?.healthTimeoutMs || 6_000 });
      }
      const requestedCount = Math.max(1, Math.min(requestedCountFor(options), 40));
      const prompt = buildSearchPlanPrompt({
        ...options,
        history: options.reference || options.history || "",
        count: requestedCount
      });
      let raw = null;
      let plan = null;
      let lastError = null;
      for (const tier of this.synapseAttemptTiers(decision.tier)) {
        attempted.push({ tier, ok: false });
        try {
          if (!this.isSynapseTierUsable(tier)) {
            throw new Error(`${tierLabel(tier)} is unavailable or budget-limited.`);
          }
          raw = await this.openAiProvider.completeJsonPrompt(prompt, { requestType: "search_plan", tier });
          plan = normalizeSearchPlan(extractJsonObject(raw.text));
          if (!plan.searchQueries.length && !plan.candidateArtists.length && !plan.candidateLabels.length && !plan.targetGenres.length) {
            throw new Error(`${tierLabel(tier)} did not return a usable search plan.`);
          }
          attempted[attempted.length - 1].ok = true;
          break;
        } catch (error) {
          lastError = error;
          attempted[attempted.length - 1].error = error.message || "Synapse search planning failed.";
          raw = null;
          plan = null;
        }
      }
      if (!plan || !raw) {
        throw lastError || new Error("Synapse search planning failed.");
      }
      this.lastDecision = {
        mode: decision.mode,
        provider: SYNAPSE_MODE,
        requestedProvider: SYNAPSE_MODE,
        requestedTier: decision.tier || "",
        reason: decision.reason,
        fallback: false,
        error: "",
        tier: raw.tier || this.selectedTier,
        tierLabel: raw.tierLabel || tierLabel(raw.tier || this.selectedTier),
        escalationPath: attempted.map((attempt) => attempt.tier),
        model: raw.model || this.openAiProvider.tierConfig?.(raw.tier || this.selectedTier)?.model || "",
        usage: raw.usage,
        costUsd: raw.costUsd ?? null,
        latencyMs: raw.latencyMs,
        toolCalls: 0,
        at: nowIso()
      };
      this.logger.log(`[AI Router] provider=${SYNAPSE_MODE} tier=${this.lastDecision.tier} mode=${decision.mode} reason="${decision.reason}" path="${this.escalationPathLabel(attempted)}"`);
      return {
        prompt,
        requestedCount,
        plan,
        routing: { ...this.lastDecision }
      };
    } catch (error) {
      return localPlan(error.message || "Synapse search planning failed.");
    }
  }

  async respond(input = {}) {
    voiceExecution.check();
    const stripped = stripModePrefix(input.message || "");
    const message = stripped.message;
    const memoryCommand = this.memory?.command(message);
    if (memoryCommand) { this.conversation = new CompactConversationState(8, this.memory); return {...memoryCommand, provider:LOCAL_MODE, toolCalls:[]}; }
    const supplied = parseTrackList(message);
    const wantsQueue = /(?:^|\n)\s*(?:please\s+)?(?:(?:verify|confirm|check)[^\n]*then\s+queue|send|queue|add|load)\b/i.test(message) && !/\b(?:tidal playlist|to tidal)\b/i.test(message) && !/\b(?:do not|don’t|don't|never)\s+(?:queue|send|add|load)\b/i.test(message);
    const wantsStrict = /\b(?:strict|verify|verification|exact versions only|confirm availability|check Roon queueability)\b/i.test(message);
    const retryFailures = /\bretry\b.*\bfail(?:ed|ures)\b/i.test(message);
    if (((supplied.length && wantsQueue) || retryFailures) && this.tools.queue_supplied_tracks) {
      const args = { ...(retryFailures ? {retryFailures:true} : {tracks:supplied}), queuePolicy:wantsStrict?"strict":"fast" };
      const result = await this.tools.queue_supplied_tracks.handler(args);
      const text = `Requested ${result.requested}; queued ${result.queued}; failed ${result.failed}. Policy: ${result.queuePolicy}.`;
      this.conversation.add("user",message); this.conversation.add("assistant",text);
      return {text,provider:LOCAL_MODE,model:"",toolCalls:[{name:"queue_supplied_tracks",input:args,result}]};
    }
    const exact = exactIntent({ message });
    if (exact && this.tools.verify_tracks) {
      const result = await this.tools.verify_tracks.handler({ tracks: exact.tracks, checkRoon: /\b(?:roon|queueab|queue)\w*/i.test(message) });
      const text = `TIDAL verified ${result.verifiedCount}/${result.checkedCount}. ${result.roonQueueableCount} Roon queueable. ${result.notFoundCount} not found; ${result.errorCount} API errors. Nothing queued.`;
      this.conversation.add("user", message);
      this.conversation.add("assistant", text);
      return { text, provider: LOCAL_MODE, model: "", toolCalls: [{ name: "verify_tracks", input: { tracks: exact.tracks }, result }] };
    }
    const verifiedAction = /^\s*(?:please\s+)?(?:queue|add)\b.*\bverified\s+tracks?\b/i.test(message) ? "queue_verified_tracks"
      : /^\s*(?:please\s+)?(?:send|save|create)\b.*\bverified\b.*\b(?:tidal|playlist)\b/i.test(message) ? "send_verified_tracks_to_tidal_playlist" : "";
    if (verifiedAction && this.tools[verifiedAction]) {
      const result = await this.tools[verifiedAction].handler({});
      const text = JSON.stringify(result);
      this.conversation.add("user", message);
      this.conversation.add("assistant", text);
      return { text, provider: LOCAL_MODE, model: "", toolCalls: [{ name: verifiedAction, input: {}, result }] };
    }
    const modeToken = stripped.mode || input.mode || "";
    const requestedTier = normalizeTier(stripped.tier || input.tier || input.aiTier || modeToken, "");
    const requestedMode = requestedTier ? SYNAPSE_MODE : normalizeMode(modeToken, this.mode);
    if (input.model) this.setOpenAiModel(input.model, requestedTier || this.selectedTier);
    const decision = this.chooseProvider(message, requestedMode, requestedTier);
    const context = this.conversation.contextText();
    let response;
    let fallback = false;
    let errorMessage = "";
    let attempted = [];

    this.conversation.add("user", message);

    if (decision.provider === SYNAPSE_MODE) {
      try {
        if (!this.isSynapseTierUsable(decision.tier)) {
          await this.refreshSynapseStatus({ timeoutMs: this.config.openai?.healthTimeoutMs || 6_000 });
        }
        let lastError = null;
        for (const tier of this.synapseAttemptTiers(decision.tier)) {
          voiceExecution.check();
          attempted.push({ tier, ok: false });
          try {
            if (!this.isSynapseTierUsable(tier)) {
              throw new Error(`${tierLabel(tier)} is unavailable or budget-limited.`);
            }
            response = await this.openAiProvider.respond(message, {
              context,
              requestType: decision.reason,
              tier
            });
            if (this.synapseResponseNeedsEscalation(response)) {
              throw new Error(`${tierLabel(tier)} returned a failed Rabbit Hole tool workflow.`);
            }
            attempted[attempted.length - 1].ok = true;
            break;
          } catch (error) {
            lastError = error;
            attempted[attempted.length - 1].error = error.message || "OpenAI/Synapse failed.";
            response = null;
          }
        }
        if (!response) throw lastError || new Error("OpenAI/Synapse failed.");
      } catch (error) {
        errorMessage = error.message || "OpenAI/Synapse failed.";
        voiceExecution.check();
        fallback = true;
        response = await this.localProvider.respond(message, {
          context,
          localModel: this.localModelName()
        });
      }
    } else {
      response = await this.localProvider.respond(message, {
        context,
        localModel: this.localModelName()
      });
    }

    voiceExecution.check();
    const provider = fallback ? LOCAL_MODE : (response.provider || decision.provider);
    this.lastDecision = {
      mode: decision.mode,
      provider,
      requestedProvider: decision.provider,
      requestedTier: decision.tier || "",
      reason: fallback ? `${decision.reason}; Synapse unavailable, fell back to local` : decision.reason,
      fallback,
      error: errorMessage,
      tier: fallback ? "" : (response.tier || decision.tier || ""),
      tierLabel: fallback ? "" : (response.tierLabel || tierLabel(response.tier || decision.tier || "")),
      escalationPath: attempted.map((attempt) => attempt.tier),
      model: response.model || "",
      usage: response.usage || null,
      costUsd: response.costUsd ?? null,
      latencyMs: response.latencyMs || null,
      toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
      at: nowIso()
    };
    this.conversation.add("assistant", response.text, { provider });
    this.logger.log(`[AI Router] provider=${provider} tier=${this.lastDecision.tier || ""} mode=${decision.mode} reason="${this.lastDecision.reason}" path="${this.escalationPathLabel(attempted)}"`);

    return {
      ...response,
      provider,
      mode: decision.mode,
      tier: this.lastDecision.tier,
      tierLabel: this.lastDecision.tierLabel,
      fallback,
      fallbackError: errorMessage,
      decision: { ...this.lastDecision },
      status: this.status()
    };
  }
}

function createModelRouter(options = {}) {
  const config = options.config || {};
  const aiConfig = config.ai || {};
  const openaiConfig = aiConfig.openai || {};
  const ledger = new OpenAiUsageLedger({
    file: openaiConfig.usageFile || "",
    rates: {
      inputCostPerMillion: openaiConfig.inputCostPerMillion,
      cachedInputCostPerMillion: openaiConfig.cachedInputCostPerMillion,
      outputCostPerMillion: openaiConfig.outputCostPerMillion
    },
    budgets: {
      maxPerRequest: openaiConfig.maxCostPerRequest,
      daily: openaiConfig.dailyBudget,
      monthly: openaiConfig.monthlyBudget,
      tiers: SYNAPSE_TIER_ORDER.reduce((result, tier) => {
        const tierConfig = openaiConfig.tiers?.[tier] || {};
        result[tier] = {
          maxPerRequest: tierConfig.maxCostPerRequest,
          daily: tierConfig.dailyBudget,
          monthly: tierConfig.monthlyBudget
        };
        return result;
      }, {})
    }
  });
  const localProvider = new LocalModelProvider({
    memory: options.memory,
    config,
    tools: options.tools || {},
    fetch: options.fetch,
    timeoutMs: aiConfig.localTimeoutMs || config.llmPlanningTimeoutMs || 45_000
  });
  const openAiProvider = new OpenAIModelProvider({
    memory: options.memory,
    config: openaiConfig,
    tools: options.tools || {},
    fetch: options.fetch,
    ledger,
    logger: options.logger || console
  });
  return new AutoModelRouter({
    memory: options.memory,
    config: {
      ...aiConfig,
      local: config
    },
    tools: options.tools || {},
    localProvider,
    openAiProvider,
    logger: options.logger || console
  });
}

module.exports = {
  AUTO_MODE,
  LOCAL_MODE,
  SYNAPSE_MODE,
  SYNAPSE_TIER_ORDER,
  AutoModelRouter,
  CompactConversationState,
  LocalModelProvider,
  OpenAIModelProvider,
  OpenAiUsageLedger,
  createModelRouter,
  normalizeMode,
  normalizeTier,
  stripModePrefix,
  openAiToolsFromRabbitHole,
  estimateCost
};
