"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreRetrospectiveCandidate, scoreCandidateBatch, isLocalModelBusy, subscribeLocalModelActivity } = require("../src/llmClient");
const { memory } = require("../src/synapseMemory");
const runtime = require("../src/localModelRuntime");

const config = {
  llmProvider: "openai-compatible", openAiCompatibleBaseUrl: "http://localhost:19981/v1",
  openAiCompatibleModel: "configured-family", openAiCompatibleApiKey: "test-header-key"
};
const loadedModel = "already-loaded-instance:2";

function input(contextQuality = "original-request") {
  return {
    track: { id: "frozen-candidate-17", tidalId: "123456789", artist: "Catalog Artist",
      title: "Frozen Track (Named Remix)", album: "Frozen Release", label: "Catalog Label",
      mix: "Named Remix", genre: "Progressive House", releaseDate: "2025-03-04",
      year: 2025, durationMs: 480000, tidalUrl: "https://tidal.com/browse/track/123456789" },
    options: { request: "Find progressive house released in 2025, at least 7 minutes.", genres: ["Progressive House"], years: [2025], mood: "driving", language: "English" },
    contextQuality, snapshotAt: "2025-03-10T12:30:00.000Z"
  };
}

function candidate(contextQuality = "original-request") {
  return {
    track_id: "frozen-candidate-17", rejected: false, rejection_reason: "", rejection_basis: [],
    scores: { prompt_match: contextQuality === "metadata-only" ? 0 : 85, taste_match: 0,
      freshness: 80, artist_label_match: 60, length_preference: 100, genre_confidence: 75 },
    final_score: 81, genre: "Progressive House", why: ["The supplied duration is eight minutes."]
  };
}

function completion(value) {
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] };
}

function stubRetrospective(t, respond = () => completion({ candidates: [candidate()] })) {
  const requests = [];
  t.mock.method(memory, "context", () => { throw new Error("Current Synapse memory must not be accessed."); });
  t.mock.method(runtime, "resolveLocalModel", () => { throw new Error("Retrospective calls must not resolve, cache, or load a model."); });
  t.mock.method(global, "fetch", async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(await respond(requests.at(-1))), { status: 200 });
  });
  return requests;
}

test("retrospective assessment isolates frozen catalog/request data and uses the exact loaded model", async t => {
  const frozen = input();
  const marker = "FORBIDDEN_FEEDBACK_PROFILE_MARKER";
  const trap = () => { throw new Error("A forbidden current-data field was accessed."); };
  frozen.track.score = 99;
  frozen.track.reason = marker;
  frozen.track.why = [marker];
  frozen.track.query = marker;
  frozen.track.feedbackRating = marker;
  frozen.track.scoreBreakdown = { total: 99, tasteMatch: { percent: 99 }, marker };
  frozen.track.metadataEnrichment = { genre: marker, label: marker, derivedAfterRating: true };
  Object.defineProperty(frozen.track, "tasteProfile", { get: trap });
  frozen.options.tasteProfile = { marker };
  frozen.options.calibration = { marker };
  frozen.options.targetRating = marker;
  frozen.options.reviewReason = marker;
  Object.defineProperty(frozen.options, "currentMemory", { get: trap });
  frozen.profile = { marker };
  frozen.targetRating = marker;
  const before = JSON.stringify(frozen);
  const requests = stubRetrospective(t);

  const result = await scoreRetrospectiveCandidate({ ...config, completionOptions: { model: "wrong-model", memory: marker } }, { input: frozen, model: loadedModel });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://localhost:19981/v1/chat/completions");
  assert.equal(requests[0].body.model, loadedModel);
  assert.equal(requests[0].init.headers.authorization, "Bearer test-header-key");
  const serialized = JSON.stringify(requests[0].body);
  assert.ok(!serialized.includes(marker));
  assert.ok(!serialized.includes("test-header-key"));
  assert.ok(!serialized.includes("wrong-model"));
  const prompt = requests[0].body.messages[1].content;
  const supplied = JSON.parse(prompt.split("Frozen input:\n")[1]);
  assert.deepEqual(Object.keys(supplied.track).sort(), ["id", "artist", "title", "album", "label", "mix", "genre", "releaseDate", "year", "durationMs", "tidalId", "tidalUrl"].sort());
  assert.deepEqual(Object.keys(supplied.options), ["request", "genres", "years", "mood", "language"]);
  assert.equal(supplied.snapshotAt, frozen.snapshotAt);
  assert.equal(requests[0].body.reasoning_effort, "none");
  assert.equal(requests[0].body.max_tokens, 1000);
  assert.equal(requests[0].body.response_format.json_schema.strict, true);
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.properties.candidates.items.properties.track_id.enum, [frozen.track.id]);
  assert.equal(result.scores[0].trackId, frozen.track.id);
  assert.equal(result.scores[0].scores.tasteMatch, null);
  assert.equal(result.scores[0].scores.promptMatch, 85);
  assert.equal(result.assessmentType, "retrospective-catalog-request");
  assert.equal(result.model, loadedModel);
  assert.equal(result.snapshotAt, frozen.snapshotAt);
  assert.equal(isLocalModelBusy(), false);
  assert.equal(JSON.stringify(frozen), before);
});

test("metadata-only assessment does not use options or fabricate request/taste predictions", async t => {
  const frozen = input("metadata-only");
  frozen.options.request = "FORBIDDEN_UNAVAILABLE_REQUEST";
  Object.defineProperty(frozen.options, "genres", { get() { throw new Error("Unavailable original options must not be read."); } });
  const requests = stubRetrospective(t, () => completion({ candidates: [candidate("metadata-only")] }));
  const result = await scoreRetrospectiveCandidate(config, { input: frozen, model: loadedModel });
  const prompt = requests[0].body.messages[1].content;
  assert.match(prompt, /original request is unavailable/i);
  assert.match(prompt, /Do not infer the user's preference or original prediction/);
  assert.ok(!prompt.includes("FORBIDDEN_UNAVAILABLE_REQUEST"));
  assert.deepEqual(JSON.parse(prompt.split("Frozen input:\n")[1]).options, {});
  assert.equal(result.contextQuality, "metadata-only");
  assert.equal(result.scores[0].scores.promptMatch, null);
  assert.equal(result.scores[0].scores.tasteMatch, null);
});

test("retrospective input strips TIDAL URL query data and fragments", async t => {
  const frozen = input();
  frozen.track.tidalUrl += "?rating=FORBIDDEN_URL_CONTEXT#FORBIDDEN_URL_CONTEXT";
  const requests = stubRetrospective(t);
  await scoreRetrospectiveCandidate(config, { input: frozen, model: loadedModel });
  assert.ok(!JSON.stringify(requests[0].body).includes("FORBIDDEN_URL_CONTEXT"));
});

test("metadata-only assessment explicitly supports an unknown original timestamp without freshness inference", async t => {
  const frozen = { ...input("metadata-only"), snapshotAt: null };
  const item = candidate("metadata-only");
  item.scores.freshness = 0;
  const requests = stubRetrospective(t, () => completion({ candidates: [item] }));
  const result = await scoreRetrospectiveCandidate(config, { input: frozen, model: loadedModel });
  assert.equal(result.snapshotAt, null);
  assert.equal(result.scores[0].scores.freshness, null);
  assert.match(requests[0].body.messages[1].content, /original timestamp is unavailable/i);
  assert.match(requests[0].body.messages[1].content, /Do not infer historical freshness/);
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.properties.candidates.items.properties.scores.properties.freshness.enum, [0]);
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: { ...input(), snapshotAt: null }, model: loadedModel }), /snapshotAt/);
  item.scores.freshness = 80;
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: frozen, model: loadedModel }), /historical freshness/);
});

test("retrospective response rejects wrong, repeated, missing, and coerced track IDs", async t => {
  const invalid = [
    { candidates: [{ ...candidate(), track_id: "123456789" }] },
    { candidates: [candidate(), candidate()] },
    { candidates: [] },
    { candidates: [{ ...candidate(), track_id: 17 }] },
    { candidates: [{ ...candidate(), id: "frozen-candidate-17", track_id: undefined }] }
  ];
  for (const payload of invalid) {
    await t.test(JSON.stringify(payload).slice(0, 75), async subtest => {
      stubRetrospective(subtest, () => completion(payload));
      await assert.rejects(scoreRetrospectiveCandidate(config, { input: input(), model: loadedModel }), /exact supplied track ID|invalid or incomplete candidate/);
    });
  }
});

test("retrospective response rejects partial, extra, invalid numeric, and nonboolean fields", async t => {
  const mutations = [
    item => { delete item.scores.freshness; },
    item => { delete item.rejected; },
    item => { item.scores.prompt_match = "85"; },
    item => { item.scores.prompt_match = null; },
    item => { item.scores.prompt_match = -1; },
    item => { item.scores.prompt_match = 101; },
    item => { item.scores.prompt_match = 85.5; },
    item => { item.scores.prompt_match = Infinity; },
    item => { item.final_score = "81"; },
    item => { item.final_score = 101; },
    item => { item.rejected = "false"; },
    item => { item.scores.taste_match = 70; },
    item => { item.scores.predicted_rating = 100; },
    item => { item.rejection_basis = ["unknown_basis"]; },
    item => { item.why = [false]; },
    item => { item.why = ["one", "two", "three"]; },
    item => { item.predicted_rating = "LOVE"; },
    item => { item.rejected = true; }
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`invalid response ${index + 1}`, async subtest => {
      const item = candidate();
      mutate(item);
      stubRetrospective(subtest, () => completion({ candidates: [item] }));
      await assert.rejects(scoreRetrospectiveCandidate(config, { input: input(), model: loadedModel }));
    });
  }
});

test("metadata-only response rejects fabricated request scoring or explicit-request rejection", async t => {
  for (const mutation of [item => { item.scores.prompt_match = 50; }, item => {
    item.rejected = true; item.rejection_reason = "Request mismatch"; item.rejection_basis = ["explicit_request_mismatch"];
  }]) {
    await t.test("unavailable request evidence", async subtest => {
      const item = candidate("metadata-only");
      mutation(item);
      stubRetrospective(subtest, () => completion({ candidates: [item] }));
      await assert.rejects(scoreRetrospectiveCandidate(config, { input: input("metadata-only"), model: loadedModel }));
    });
  }
});

test("retrospective parsing accepts strict JSON only and rejects truncation", async t => {
  for (const response of [
    { choices: [{ finish_reason: "stop", message: { content: "```json\n" + JSON.stringify({ candidates: [candidate()] }) + "\n```" } }] },
    { choices: [{ finish_reason: "length", message: { content: JSON.stringify({ candidates: [candidate()] }) } }] },
    { choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: JSON.stringify({ candidates: [candidate()] }) } }] }
  ]) {
    await t.test("untrusted output", async subtest => {
      stubRetrospective(subtest, () => response);
      await assert.rejects(scoreRetrospectiveCandidate(config, { input: input(), model: loadedModel }));
    });
  }
});

test("retrospective assessment propagates cancellation to fetch and rejects before response completion", async t => {
  const controller = new AbortController();
  let requestSignal;
  t.mock.method(memory, "context", () => { throw new Error("Memory must not be accessed."); });
  t.mock.method(global, "fetch", (_url, init) => {
    requestSignal = init.signal;
    return new Promise(() => {});
  });
  const pending = scoreRetrospectiveCandidate(config, { input: input(), model: loadedModel, signal: controller.signal });
  controller.abort(new Error("Foreground model work has priority."));
  await assert.rejects(pending, error => error.name === "AbortError" && error.code === "ABORT_ERR");
  assert.equal(requestSignal.aborted, true);
  assert.equal(isLocalModelBusy(), false);
});

test("retrospective timeout bounds an unresponsive fetch without changing input", async t => {
  const frozen = input();
  const before = JSON.stringify(frozen);
  let requestSignal;
  t.mock.method(global, "fetch", (_url, init) => {
    requestSignal = init.signal;
    return new Promise(() => {});
  });
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: frozen, model: loadedModel, timeoutMs: 10 }),
    error => error.name === "TimeoutError" && error.code === "LLM_TIMEOUT");
  assert.equal(requestSignal.aborted, true);
  assert.equal(JSON.stringify(frozen), before);
});

test("already cancelled or invalid retrospective requests never call a model", async t => {
  let calls = 0;
  t.mock.method(global, "fetch", () => { calls += 1; throw new Error("No model call expected."); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: input(), model: loadedModel, signal: controller.signal }), error => error.name === "AbortError");
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: input(), model: "" }), /already-loaded model ID/);
  await assert.rejects(scoreRetrospectiveCandidate({ ...config, llmProvider: "openrouter" }, { input: input(), model: loadedModel }), /local OpenAI-compatible/);
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: { ...input(), snapshotAt: "" }, model: loadedModel }), /snapshotAt/);
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: { ...input(), contextQuality: "infer-current-taste" }, model: loadedModel }), /contextQuality/);
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: { ...input(), track: { artist: "A", title: "T" } }, model: loadedModel }), /supplied retrospective track ID/);
  assert.equal(calls, 0);
});

test("unavailable model errors surface without retry, model fallback, or input mutation", async t => {
  const frozen = input();
  const before = JSON.stringify(frozen);
  let calls = 0;
  t.mock.method(runtime, "resolveLocalModel", () => { throw new Error("No fallback allowed."); });
  t.mock.method(memory, "context", () => { throw new Error("No memory allowed."); });
  t.mock.method(global, "fetch", async (_url, init) => {
    calls += 1;
    assert.equal(JSON.parse(init.body).model, loadedModel);
    return new Response("Model is not loaded", { status: 503 });
  });
  await assert.rejects(scoreRetrospectiveCandidate(config, { input: frozen, model: loadedModel }), error => error.statusCode === 503);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(frozen), before);
  assert.equal(isLocalModelBusy(), false);
});

test("foreground local model activity preempts a retrospective request and cleans up after success", async t => {
  t.mock.method(memory, "context", () => "");
  t.mock.method(runtime, "resolveLocalModel", async () => "live-loaded-model");
  let finishLive;
  let retrospectiveSignal;
  t.mock.method(global, "fetch", (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === loadedModel) {
      retrospectiveSignal = init.signal;
      return new Promise(() => {});
    }
    return new Promise(resolve => { finishLive = () => resolve(new Response(JSON.stringify(completion({ candidates: [candidate()] })))); });
  });
  const controller = new AbortController();
  const events = [];
  const unsubscribe = subscribeLocalModelActivity(event => {
    events.push(event);
    if (event.phase === "start") controller.abort();
  });
  try {
    const background = scoreRetrospectiveCandidate(config, { input: input(), model: loadedModel, signal: controller.signal });
    const rejectedBackground = assert.rejects(background, error => error.name === "AbortError");
    const foreground = scoreCandidateBatch(config, { tracks: [input().track] });
    assert.equal(isLocalModelBusy(), true);
    await rejectedBackground;
    assert.equal(retrospectiveSignal.aborted, true);
    await Promise.resolve();
    finishLive();
    await foreground;
    assert.equal(isLocalModelBusy(), false);
    assert.deepEqual(events.map(event => [event.phase, event.activeCount, event.busy]), [["start", 1, true], ["end", 0, false]]);
  } finally {
    unsubscribe();
  }
});

test("foreground local activity clears on failure and throwing observers cannot break calls", async t => {
  t.mock.method(memory, "context", () => "");
  t.mock.method(runtime, "resolveLocalModel", async () => "live-loaded-model");
  t.mock.method(global, "fetch", async () => { throw new Error("Offline test failure"); });
  const events = [];
  const unsubscribe = subscribeLocalModelActivity(event => events.push(event.phase));
  const unsubscribeThrowing = subscribeLocalModelActivity(() => { throw new Error("Observer failure"); });
  try {
    await assert.rejects(scoreCandidateBatch(config, { tracks: [input().track] }), /Offline test failure/);
    assert.equal(isLocalModelBusy(), false);
    assert.deepEqual(events, ["start", "end"]);
    unsubscribe();
    await assert.rejects(scoreCandidateBatch(config, { tracks: [input().track] }), /Offline test failure/);
    assert.deepEqual(events, ["start", "end"]);
  } finally {
    unsubscribe();
    unsubscribeThrowing();
  }
});

test("cloud foreground calls do not claim local model activity", async t => {
  t.mock.method(memory, "context", () => "");
  t.mock.method(global, "fetch", async () => new Response(JSON.stringify(completion({ candidates: [candidate()] }))));
  const events = [];
  const unsubscribe = subscribeLocalModelActivity(event => events.push(event));
  try {
    await scoreCandidateBatch({ llmProvider: "openrouter", openRouterApiKey: "offline-test-key", openRouterModel: "cloud-test" }, { tracks: [input().track] });
    assert.equal(isLocalModelBusy(), false);
    assert.deepEqual(events, []);
  } finally {
    unsubscribe();
  }
});
