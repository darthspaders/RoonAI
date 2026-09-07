"use strict";

function createDiscoveryRequestPolicy({
  buildDiscoveryProfile,
  config,
  minimumScoreFor,
  normalizeMatchText,
  openAiCompatibleProviders,
  yearRangeUtil
} = {}) {
  function withNormalizedYearFilter(options = {}) {
    const parsed = yearRangeUtil.parseYearRange(options);
    if (!parsed) return options;
    return {
      ...options,
      years: parsed.label
    };
  }

  function shouldSkipModelForCatalogSearch(options = {}) {
    const parsed = yearRangeUtil.parseYearRange(options);
    if (!parsed) return false;
    const profile = buildDiscoveryProfile(options);
    if (profile.targetGenres?.length) return true;
    const text = normalizeMatchText(`${options.request || ""} ${options.genres || ""} ${options.mood || ""}`);
    return /\b(?:progressive|house|trance|melodic|deep|organic|techno|ambient|disco|synth|new wave|rock|jazz|metal|country|pop|funk|soul|r b|hip hop)\b/.test(text);
  }

  function isStrictRoonQueueMode(options = {}) {
    const explicitMode = normalizeMatchText([
      options.queueMode,
      options.verificationMode,
      options.searchMode,
      options.requireRoonQueueable
    ].filter(Boolean).join(" "));
    if (/\b(?:strict roon|roon strict|strict queue|queueable roon|roon queueable|roon-verified|strict-roon|roon-strict)\b/.test(explicitMode)) {
      return true;
    }
    return /^(1|true|yes)$/i.test(String(options.strictRoonQueueable || options.roonStrict || ""));
  }

  function booleanFlag(value) {
    return /^(1|true|yes)$/i.test(String(value || ""));
  }

  function isLocalOpenAiCompatibleLlm() {
    if (!openAiCompatibleProviders.has(config.llmProvider)) return false;
    return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(String(config.openAiCompatibleBaseUrl || ""));
  }

  function modelPlanningTimeoutBudget(defaultMs) {
    const configured = Number(config.llmPlanningTimeoutMs || 0);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(8_000, Math.min(180_000, configured));
    }
    return isLocalOpenAiCompatibleLlm()
      ? Math.max(defaultMs, 60_000)
      : defaultMs;
  }

  function strictSearchBudgets(options = {}, requestedCount = 8) {
    const yearRange = yearRangeUtil.parseYearRange(options);
    const minScore = minimumScoreFor(options);
    const strict = Boolean(yearRange || minScore);
    if (!strict) {
      return {
        roonFirstTimeoutMs: 10_000,
        modelTimeoutMs: modelPlanningTimeoutBudget(30_000),
        discoveryTimeoutMs: 12_000,
        roonQueueTimeoutMs: 10_000
      };
    }

    const catalogMode = shouldSkipModelForCatalogSearch(options);
    const strictRoonMode = isStrictRoonQueueMode(options);
    return {
      roonFirstTimeoutMs: Math.min(35_000, Math.max(16_000, requestedCount * 1_600)),
      modelTimeoutMs: modelPlanningTimeoutBudget(Math.min(45_000, Math.max(catalogMode ? 30_000 : 25_000, requestedCount * 1_500))),
      discoveryTimeoutMs: catalogMode
        ? (strictRoonMode
          ? Math.min(180_000, Math.max(90_000, requestedCount * 9_000))
          : Math.min(105_000, Math.max(55_000, requestedCount * 5_000)))
        : Math.min(120_000, Math.max(60_000, requestedCount * 5_000)),
      roonQueueTimeoutMs: Math.min(75_000, Math.max(24_000, requestedCount * 2_400))
    };
  }

  return {
    booleanFlag,
    isLocalOpenAiCompatibleLlm,
    isStrictRoonQueueMode,
    modelPlanningTimeoutBudget,
    shouldSkipModelForCatalogSearch,
    strictSearchBudgets,
    withNormalizedYearFilter
  };
}

module.exports = {
  createDiscoveryRequestPolicy
};
