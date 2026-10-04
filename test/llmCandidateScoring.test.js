"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreCandidateBatch } = require("../src/llmClient");

const tracks = Array.from({ length: 9 }, (_, index) => ({
  id: String(index + 1), artist: `Artist ${index}`, title: `Track ${index}`, durationMs: 480000
}));

function score(id) {
  return { track_id: id, rejected: false, rejection_reason: "", rejection_basis: [], scores: {
    prompt_match: 80, taste_match: 70, freshness: 60,
    artist_label_match: 70, length_preference: 100, genre_confidence: 80
  }, final_score: 80, genre: "Progressive Trance", why: ["Duration fits."] };
}

function mockModel(t, respond) {
  const requests = [];
  t.mock.method(global, "fetch", async (url, init = {}) => {
    if (String(url).endsWith("/api/v0/models")) return new Response(JSON.stringify({ data: [] }));
    const body = JSON.parse(init.body);
    requests.push(body);
    return new Response(JSON.stringify(respond(body, requests.length)));
  });
  return requests;
}

const config = {
  llmProvider: "openai-compatible", openAiCompatibleBaseUrl: "http://localhost:19981/v1",
  openAiCompatibleModel: "qwen/qwen3.6-35b-a3b"
};

test("local Qwen candidate review fits bounded structured batches and scores every supplied id", async t => {
  const requests = mockModel(t, body => {
    const ids = body.response_format.json_schema.schema.properties.candidates.items.properties.track_id.enum;
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: ids.map(score) }) } }] };
  });
  const result = await scoreCandidateBatch(config, { tracks, options: { request: "Find 3 tracks", count: 3 } });
  assert.equal(requests.length, 2);
  assert.deepEqual(result.scores.map(item => item.trackId), tracks.map(track => track.id));
  assert.equal(result.rawCount, 9);
  for (const body of requests) {
    const schema = body.response_format.json_schema.schema.properties.candidates;
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.max_tokens, 3000);
    assert.ok(schema.maxItems <= 8);
    assert.equal(schema.minItems, schema.maxItems);
    assert.match(body.messages[1].content, /every supplied candidate/i);
  }
});

test("model request includes version-specific evidence and remixer taste outside the global top artists", async t => {
  const requests = mockModel(t, () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: [score("90471480")] }) } }] }));
  const artists = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, { name: `Favourite ${i}`, score: 100 - i }]));
  artists.remixer = { name: "Eelke Kleijn", score: 3 };
  await scoreCandidateBatch(config, { tracks: [{ id: "90471480", artist: "Pendulum", title: "9,000 Miles (Eelke Kleijn Remix)", album: "The Reworks", label: "Earstorm", durationMs: 501000,
    genre: "Progressive House", admissionDiagnostics: { durationConstraints: { passed: true, constraint: { minimumMs: 420000 } } },
    scoreBreakdown: { genreInference: { evidence: [{ source: "remixer", label: "Eelke Kleijn remixer scene", genre: "progressive house", corroborating: true }] } }
  }], options: { request: "Progressive house, driving, minimal vocals, at least 7 minutes" }, tasteProfile: { artists } });
  const prompt = requests[0].messages[1].content;
  const payload = JSON.parse(prompt.split("TIDAL candidates:\n")[1].split("\n\nReturn exactly this shape:")[0]);
  assert.equal(payload[0].label, "Earstorm");
  assert.deepEqual(payload[0].version_evidence.remix.taste, [{ name: "Eelke Kleijn", score: 3 }]);
  assert.deepEqual(payload[0].version_evidence.genres, ["Progressive House"]);
  assert.equal(payload[0].version_evidence.duration_constraint.minimumMs, 420000);
  assert.match(prompt, /Original-artist genre\/taste mismatch alone is NEVER grounds/);
  assert.match(prompt, /minimumMs is a minimum/);
  assert.match(prompt, /do not add another Sonic bonus\/penalty/);
  const schema = requests[0].response_format.json_schema.schema.properties.candidates.items;
  assert.ok(schema.required.includes("rejection_basis"));
  assert.ok(schema.properties.rejection_basis.items.enum.includes("original_artist_profile_mismatch"));
  assert.ok(schema.properties.rejection_basis.items.enum.includes("explicit_request_mismatch"));
});

test("structured rejection basis survives normalization, including unknown objections", async t => {
  mockModel(t, () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: [{ ...score("1"), rejected: true, rejection_basis: ["original_artist_profile_mismatch", "unknown_basis"] }] }) } }] }));
  const result = await scoreCandidateBatch(config, { tracks: tracks.slice(0, 1) });
  assert.deepEqual(result.scores[0].rejectionBasis, ["original_artist_profile_mismatch", "unknown_basis"]);
});

test("structured review rejects missing or duplicate scores instead of claiming full review", async t => {
  mockModel(t, () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: [score("1"), score("1")] }) } }] }));
  await assert.rejects(scoreCandidateBatch(config, { tracks: tracks.slice(0, 2) }), /every supplied candidate exactly once/i);
});

test("structured review rejects invented ids", async t => {
  mockModel(t, () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: [score("invented")] }) } }] }));
  await assert.rejects(scoreCandidateBatch(config, { tracks: tracks.slice(0, 1) }), /every supplied candidate exactly once/i);
});

test("truncated local model output reports context exhaustion without promoting reasoning to scores", async t => {
  mockModel(t, () => ({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: JSON.stringify({ candidates: [score("1")] }) } }], usage: { prompt_tokens: 5878, completion_tokens: 2314 } }));
  await assert.rejects(scoreCandidateBatch(config, { tracks: tracks.slice(0, 1) }), /token or context limit.*5878.*2314/i);
});

test("other model families keep their existing request format and reasoning behavior", async t => {
  const requests = mockModel(t, () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: tracks.map(track => score(track.id)) }) } }] }));
  const result = await scoreCandidateBatch({ ...config, openAiCompatibleModel: "other/model" }, { tracks });
  assert.equal(result.scores.length, 9);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].response_format, { type: "text" });
  assert.equal(requests[0].reasoning_effort, undefined);
});
