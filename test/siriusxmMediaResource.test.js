"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {readMediaResource}=require("../src/siriusxmMediaResource");
const url="https://aod-ftc-prod-device.streaming.siriusxm.com/test.aac";
test("a truncated segment is retried whole before any bytes are returned",async()=>{
  let calls=0;
  const resource=await readMediaResource(url,{fetchImpl:async()=>new Response(++calls===1?"bad":"complete",{headers:{"content-length":"8"}})});
  assert.equal(calls,2);assert.equal(resource.data.toString(),"complete");
});
test("finished downloads survive a player reading after the upstream deadline",async()=>{
  let signal;
  const resource=await readMediaResource(url,{timeoutMs:20,fetchImpl:async(u,o)=>{signal=o.signal;return new Response("complete");}});
  await new Promise(r=>setTimeout(r,40));
  assert.equal(signal.aborted,true);assert.equal(resource.data.toString(),"complete");
});
test("transient errors retry, permanent errors do not, resource size is bounded",async()=>{
  let calls=0;
  assert.equal((await readMediaResource(url,{fetchImpl:async()=>++calls===1?new Response(null,{status:503}):new Response("ok")})).data.toString(),"ok");
  calls=0;await assert.rejects(readMediaResource(url,{fetchImpl:async()=>{calls++;return new Response(null,{status:403});}}),/403/);assert.equal(calls,1);
  calls=0;await assert.rejects(readMediaResource(url,{maxBytes:2,fetchImpl:async()=>{calls++;return new Response("large");}}),/size/);assert.equal(calls,1);
});
test("a broken body retries without passing the partial segment to the decoder",async()=>{
  let calls=0;
  const resource=await readMediaResource(url,{fetchImpl:async()=>{
    if(++calls>1)return new Response("whole");
    let read=false;return new Response(new ReadableStream({pull(controller){if(read)controller.error(Error("lost connection"));else{read=true;controller.enqueue(new Uint8Array([1,2]));}}}));
  }});
  assert.equal(calls,2);assert.equal(resource.data.toString(),"whole");
});
