"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { selectRuntimeModel, resolveLocalModel } = require("../src/localModelRuntime");
test("loaded LM Studio instance is selected over unloaded catalog entry without changing family", () => {
  const models = [{ id: "qwen/qwen3.6-35b-a3b", state: "not-loaded", type: "vlm" }, { id: "qwen/qwen3.6-35b-a3b:2", state: "loaded", type: "vlm" }, { id: "other:2", state: "loaded", type: "llm" }];
  assert.equal(selectRuntimeModel(models, models[0].id).id, models[1].id);
  assert.equal(selectRuntimeModel(models, "missing"), undefined);
  assert.equal(selectRuntimeModel(models, "qwen/qwen3.6-35b-a3b:3"), undefined);
  models[0].state = "loaded"; assert.equal(selectRuntimeModel(models, models[0].id).id, models[0].id);
});
test("completion target uses the loaded runtime ID and falls back for non-LM-Studio servers", async () => {
  const model = await resolveLocalModel({ openAiCompatibleBaseUrl: "http://localhost:19231/v1", openAiCompatibleModel: "qwen" }, async () => ({ ok: true, json: async () => ({ data: [{ id: "qwen", state: "not-loaded" }, { id: "qwen:2", state: "loaded" }] }) }));
  assert.equal(model, "qwen:2");
  assert.equal(await resolveLocalModel({ openAiCompatibleBaseUrl: "http://localhost:19232/v1", openAiCompatibleModel: "other" }, async () => { throw Error("unsupported"); }), "other");
});
