"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { SonicFullSongProvider } = require("../src/sonicFullSongProvider");
const { SonicEmbeddingEngine } = require("../src/sonicEmbeddingEngine");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const spec = analysisSpec("mert-fullsong");
const result = () => ({ specKey: spec.key, revision: spec.revision, sampleRate: 24000,
  audioDurationSeconds: 120, analyzedSeconds: 30, sourceCoverage: .25,
  vector: Array.from({ length: 1024 }, (_, i) => Number(i === 0)) });

test("FullSong asynchronously stores its pinned vector, reuses cache, and deletes its transient audio", async () => {
  let file, saved, calls = 0;
  const provider = new SonicFullSongProvider({ worker: { async run(path, supplied) {
    calls++; file = path;
    assert.deepEqual(supplied, spec);
    assert.equal((await fs.readFile(file)).toString(), "preview");
    await new Promise(resolve => setImmediate(resolve));
    return result();
  }, stop() {} } });
  const store = { getEmbedding: (identity, options) => saved?.model === options.model && saved?.modelVersion === options.modelVersion ? saved : null,
    upsertEmbedding: value => (saved = { ...value, dimensions: value.vector.length }) };
  const engine = new SonicEmbeddingEngine({ provider, store });
  const track = { tidalId: "123", artist: "Artist", title: "Track" };
  const first = await engine.analyzeBufferAsync(Buffer.from("preview"), track, { metadata: { identityRelation: "exact" } });
  assert.equal(first.model, spec.repo); assert.equal(first.modelVersion, spec.key);
  assert.equal(first.audioDurationMs, 120000); assert.equal(saved.metadata.analyzedSeconds, 30);
  assert.equal(saved.metadata.identityRelation, "exact");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.equal((await engine.analyzeBufferAsync(Buffer.from("preview"), track)).cached, true);
  assert.equal(calls, 1);
});

test("wrong FullSong revision and malformed vectors cannot be stored and failed audio is cleaned up", async () => {
  for (const bad of [{ revision: "wrong" }, { vector: [1, 0] }, { vector: Array(1024).fill(0) }, { analyzedSeconds: 120 }]) {
    let file;
    const provider = new SonicFullSongProvider({ worker: { async run(path) { file = path; return { ...result(), ...bad }; }, stop() {} } });
    await assert.rejects(provider.extractBufferAsync(Buffer.from("preview")), /pinned analysis specification/);
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  }
});

test("concurrent live FullSong requests fail busy and recover after completion", async () => {
  let release;
  const provider = new SonicFullSongProvider({ worker: { run: () => new Promise(resolve => { release = () => resolve(result()); }), stop() {} } });
  const store = { getEmbedding: () => null, upsertEmbedding: value => ({ ...value, dimensions: 1024 }) };
  const engine = new SonicEmbeddingEngine({ provider, store });
  const track = { tidalId: "123", artist: "Artist", title: "Track" };
  const first = engine.analyzeBufferAsync(Buffer.from("preview"), track);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(engine.analyzeBufferAsync(Buffer.from("preview"), track), { code: "SONIC_RESOURCE_BUSY" });
  release(); await first;
  assert.equal(engine.backgroundExtractionActive, false);
});
