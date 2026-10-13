"use strict";

function createRetrospectiveScorer(config, scoreRetrospectiveCandidate) {
  return ({ input, model, signal }) => scoreRetrospectiveCandidate(config, {
    input, model: model.model, signal
  });
}

function createRetrospectiveModelHealth({ llmHealth, openAiCompatibleProviders }) {
  return async () => {
    const health = await llmHealth();
    // /v1/models alone can list an unloaded model. Require LM Studio's actual
    // loaded runtime state; never issue a request that would intentionally load
    // an unavailable model or fall back to a cloud provider.
    return {
      retrospectiveReady: Boolean(openAiCompatibleProviders.has(health.provider) &&
        health.reachable && health.loaded && health.runtimeState === "loaded" && health.model),
      provider: health.provider || "",
      model: health.model || ""
    };
  };
}

async function handleModelReviewBacklog(req, res, url, { backlog, readJson, sendJson }) {
  const base = "/api/model-review/backlog";
  const pathname = url.pathname;
  if (![base, `${base}/review`, `${base}/pause`].includes(pathname)) return false;
  if (pathname === base && req.method === "GET") {
    sendJson(res, 200, backlog.status());
    return true;
  }
  if (req.method === "POST" && pathname !== base) {
    await readJson(req);
    const result = pathname.endsWith("/pause") ? await backlog.pause() : await backlog.requestReview();
    sendJson(res, 200, result);
    return true;
  }
  sendJson(res, 405, { error: "Use GET for status or POST for Review backlog and Pause." });
  return true;
}

module.exports = { createRetrospectiveModelHealth, createRetrospectiveScorer, handleModelReviewBacklog };
