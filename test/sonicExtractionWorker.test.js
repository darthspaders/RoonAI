"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const { SonicEmbeddingEngine, EssentiaDiscogsEffNetProvider } = require("../src/sonicEmbeddingEngine");

test("background extraction reuses FFmpeg/Essentia and keeps the main event loop responsive", async t => {
  if (spawnSync("ffmpeg", ["-version"], { windowsHide:true }).status !== 0) return t.skip("FFmpeg is not installed");
  const db = new DatabaseSync(":memory:");
  const store = new SonicEmbeddingStore({ enabled:false }); Object.assign(store,{enabled:true,db}); store.migrate();
  t.after(() => db.close());
  const worker = "process.stdin.resume();process.stdin.on('end',()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);process.stdout.write(JSON.stringify({vector:Array.from({length:1280},(_,i)=>i===0?1:0)}));});";
  const provider = new EssentiaDiscogsEffNetProvider({ command:process.execPath,args:["-e",worker],sampleRate:16000 });
  const engine = new SonicEmbeddingEngine({ store,provider });
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length-8,4); wav.write("WAVEfmt ",8); wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(16000,24); wav.writeUInt32LE(32000,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write("data",36); wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*12000),44+i*2);
  const track = {tidalId:"1",artist:"Test",title:"Worker"};
  let timerRan = false;
  const pending = engine.analyzeBufferAsync(wav,track,{sourceType:"beatport-preview"});
  await assert.rejects(engine.analyzeBufferAsync(wav, { ...track, tidalId: "2" }), {
    code: "SONIC_RESOURCE_BUSY", statusCode: 503
  }, "concurrent callers cannot launch another learned extraction");
  await new Promise(resolve => setTimeout(()=>{timerRan=true;resolve();},20));
  assert.equal(store.getEmbedding(track,{model:"discogs-effnet",modelVersion:"1"}),null,"timer ran before the slow extraction completed");
  const result = await pending;
  assert.equal(timerRan,true);
  assert.equal(result.model,"discogs-effnet"); assert.equal(result.dimensions,1280);
  assert.equal(store.getEmbedding(track,{model:"discogs-effnet",modelVersion:"1"}).vector.length,1280);
  assert.equal(engine.backgroundExtractionActive, false);
  const cached = await engine.analyzeBufferAsync(wav, track);
  assert.equal(cached.cached, true, "identical source audio reuses the existing fingerprint");
  assert.deepEqual(cached.track, result.track);
  assert.equal((await engine.analyzeBufferAsync(wav, { ...track, tidalId: "2" })).identityKey, "tidal:2", "a completed extraction releases the shared slot");
  await assert.rejects(engine.analyzeBufferAsync(Buffer.from("invalid audio"), { ...track, tidalId: "3" }), /FFmpeg/i);
  assert.equal(engine.backgroundExtractionActive, false, "failed decoding releases the shared slot");
});
