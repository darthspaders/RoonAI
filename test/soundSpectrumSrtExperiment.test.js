"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { SoundSpectrumSrtExperiment, MAX_DURATION_MS, safeMetrics, safeVideoProfile, safeDiagnostics } = require("../src/soundSpectrumSrtExperiment");
const A = "native_srt_controller_123456", B = "browser_visual_viewer_123456";
function fixture(overrides = {}) {
  let now = 1000; const calls = [], lifecycle = [];
  const service = { clock: () => now, closed: false, generation: 3, state: "running", transport: "obs-webrtc", obsSession: {ready:true},
    visualizer: "whitecap", inputId: "feed:hqplayer-analysis", zoneId: "exact-zone", playerId: "", leases: new Map([[B, now + 12000]]),
    leaseVisibility: new Map(), viewerPerformance: new Map(), inventory: {srtExperiment:{available:true}},
    diagnostic: entry => lifecycle.push(entry),
    inspect: async () => service.inventory,
    session: async request => { calls.push(request); service.leases.set(request.viewerId, now + 12000); },
    releaseObsViewer: viewer => calls.push({releaseViewer:viewer}),
    release: reason => { calls.push({release:reason}); ++service.generation; service.state="idle"; },
    fail: async (generation, error) => { calls.push({fail:generation}); service.state="error"; ++service.generation; service.leases.clear(); },
    obsTransport: { srtConnection: async request => ({url:"srt://192.168.50.119:8890?mode=caller&latency=250&passphrase=private&streamid=private",generation:request.generation,requestedLatencyMs:250,
      videoProfile: {requestedBitrateMbps:60,configuredBitrateMbps:60,encoderMode:"shared-publisher",width:3840,height:2160,fps:60}}),
      releaseSrt: async request => { calls.push({releaseSrt:request}); }, snapshot: () => ({srtExperiment:{readers:1,observedAt:now,stats:[{msSendTsbPdDelay:250,msRTT:1,privateUrl:"SECRET"}]}}) }
  };
  Object.assign(service, overrides);
  const controller = new SoundSpectrumSrtExperiment(service);
  return {service, controller, calls, lifecycle, advance: ms => now += ms};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("SRT lifecycle logs only bounded sanitized transitions and preserves a pin beyond the hidden-browser deadline", async () => {
  const f = fixture(); f.service.leases.set(B, 91000); f.service.leaseVisibility.set(B, "hidden");
  const receipt = await f.controller.start({ viewerId: A, generation: 3 });
  assert.deepEqual(f.lifecycle.map(entry => [entry.event, entry.leasePresent]), [["srt-started", false], ["srt-ready", true]]);
  for (const entry of f.lifecycle) assert.deepEqual(Object.keys(entry).sort(), ["cleanupFailed", "elapsedMs", "event", "failureCode", "generation", "leasePresent", "originalExpiresAt", "reason", "targetMbps"]);
  for (let i = 0; i < 100; i++) f.controller.status(A);
  f.advance(90000); f.service.leases.delete(B); f.controller.sweep(); await flush();
  assert.equal(f.controller.status(A).state, "ready"); assert.equal(f.service.leases.get(A), receipt.expiresAt);
  assert.equal(f.lifecycle.length, 2); assert.equal(f.service.state, "running");
  await f.controller.stop({ viewerId: A, generation: 3 });
  assert.deepEqual(f.lifecycle.at(-1), { event: "srt-end", generation: 3, targetMbps: 60, originalExpiresAt: receipt.expiresAt,
    elapsedMs: 90000, leasePresent: false, reason: "user-stop", failureCode: null, cleanupFailed: false });
  assert.equal(f.lifecycle.length, 3); assert.doesNotMatch(JSON.stringify(f.lifecycle), /native_srt|browser_visual|srt:\/\/|private|passphrase|streamid|exact-zone/);
});

test("SRT end reasons distinguish expiry, generation change, lost lease and shutdown without renewed demand", async () => {
  for (const reason of ["expired", "generation-changed", "lease-lost", "shutdown"]) {
    const f = fixture(); const receipt = await f.controller.start({ viewerId: A, generation: 3 });
    if (reason === "expired") f.advance(MAX_DURATION_MS);
    if (reason === "generation-changed") f.service.generation++;
    if (reason === "lease-lost") f.service.leases.delete(A);
    if (reason === "shutdown") await f.controller.close();
    else { f.controller.sweep(); await flush(); }
    assert.equal(f.lifecycle.at(-1).event, "srt-end", reason); assert.equal(f.lifecycle.at(-1).reason, reason);
    assert.equal(f.lifecycle.at(-1).originalExpiresAt, receipt.expiresAt); assert.equal(f.lifecycle.at(-1).leasePresent, false);
    assert.equal(f.lifecycle.length, 3); assert.equal(f.controller.run, null);
  }
});

test("startup failures log a sanitized failed transition and cleanup, while rejected requests create no run log", async () => {
  const f = fixture(); f.service.inspect = async () => { throw Error("srt://PRIVATE?passphrase=PRIVATE"); };
  await assert.rejects(f.controller.start({ viewerId: A, generation: 3 }), /could not complete/);
  assert.deepEqual(f.lifecycle.map(entry => [entry.event, entry.reason]), [["srt-started", null], ["srt-error", "startup-failed"], ["srt-end", "startup-failed"]]);
  assert.equal(f.lifecycle.at(-1).leasePresent, false); assert.doesNotMatch(JSON.stringify(f.lifecycle), /PRIVATE|passphrase|viewerId|url|message/);
  const g = fixture(); await assert.rejects(g.controller.start({ viewerId: "bad", generation: 3 }));
  assert.equal(g.lifecycle.length, 0);
});

test("throwing or rejected diagnostic sinks cannot break Start, status or exact Stop cleanup", async () => {
  for (const diagnostic of [() => { throw Error("PRIVATE"); }, () => Promise.reject(Error("PRIVATE"))]) {
    const f = fixture({ diagnostic }); await f.controller.start({ viewerId: A, generation: 3 });
    assert.equal(f.controller.status(A).state, "ready"); await f.controller.stop({ viewerId: A, generation: 3 }); await flush();
    assert.equal(f.controller.run, null); assert.equal(f.service.leases.has(A), false); assert.equal(f.service.leases.has(B), true);
  }
});

test("HTTP controls require same origin, JSON and explicit actions; GET never creates native demand", async () => {
  const { createSoundSpectrumApi } = require("../src/soundSpectrum");
  const f = fixture(); f.service.srtExperiment = f.controller; f.service.snapshot = () => ({ state:f.service.state });
  const replies = [], headers = {};
  const api = createSoundSpectrumApi({service:f.service, readJson:async req=>req.body, sendJson:(_res,code,body)=>replies.push({code,body})});
  const res={setHeader:(key,value)=>headers[key]=value}, url=new URL(`http://localhost:3777/api/soundspectrum/srt?viewerId=${A}`);
  await api.handle({method:"GET",headers:{}},res,url);
  assert.equal(replies.at(-1).code,200); assert.equal(f.calls.length,0); assert.equal(headers["Cache-Control"],"no-store, private");
  for (const headers of [{origin:"http://evil.example","content-type":"application/json"},{"sec-fetch-site":"cross-site","content-type":"application/json"}]) {
    await api.handle({method:"POST",headers,body:{action:"start",viewerId:A,generation:3}},res,url); assert.equal(replies.at(-1).code,403);
  }
  await api.handle({method:"POST",headers:{},body:{action:"start",viewerId:A,generation:3}},res,url); assert.equal(replies.at(-1).code,415);
  await api.handle({method:"POST",headers:{"content-type":"application/json"},body:{action:"heartbeat",viewerId:A,generation:3}},res,url); assert.equal(replies.at(-1).code,400);
  assert.equal(f.calls.length,0);
  await api.handle({method:"POST",headers:{origin:url.origin,"content-type":"application/json"},body:{action:"start",viewerId:A,generation:3}},res,url);
  assert.equal(replies.at(-1).code,200); assert.match(replies.at(-1).body.connectionUrl,/^srt:/);
  await api.handle({method:"GET",headers:{}},res,url); assert.equal(replies.at(-1).body.connectionUrl,undefined);
  await api.handle({method:"POST",headers:{"content-type":"application/json"},body:{action:"stop",viewerId:B,generation:3}},res,url); assert.equal(replies.at(-1).code,403);
  await api.handle({method:"POST",headers:{"content-type":"application/json"},body:{action:"stop",viewerId:A,generation:3}},res,url); assert.equal(replies.at(-1).code,200);
});
test("inspection is passive and never returns private connection details", () => {
  const f=fixture(); assert.equal(f.controller.status(A).state,"idle"); assert.equal(f.calls.length,0);
  assert.equal(JSON.stringify(f.controller.status(A)).includes("SECRET"),false);
});
test("Start joins exact current publisher without native/audio/encoder startup and pins only its bounded lease", async () => {
  const f=fixture(); const value=await f.controller.start({viewerId:A,generation:3});
  assert.equal(value.state,"ready"); assert.match(value.connectionUrl,/^srt:/); assert.equal(value.expiresAt,1000+MAX_DURATION_MS);
  assert.equal(f.service.leases.get(B),13000); assert.equal(f.service.leases.get(A),601000);
  assert.deepEqual(f.calls[0],{action:"join",viewerId:A,generation:3,visualizer:"whitecap",inputId:"feed:hqplayer-analysis",playerId:"",zoneId:"exact-zone",transport:"obs-webrtc"});
  assert.equal(f.calls.filter(c=>c.action).length,1); assert.equal(f.controller.status(A).connectionUrl,undefined);
  assert.equal(JSON.stringify(f.controller.status(A)).includes("SECRET"),false); assert.equal(f.controller.status(A).metrics.stats[0].msSendTsbPdDelay,250);
});
test("existing browser identity cannot be repurposed into a native experiment", async () => {
  const f=fixture(); await assert.rejects(f.controller.start({viewerId:B,generation:3}),/separate/); assert.equal(f.calls.length,0);
});
test("stale generations, unavailable SRT, JPEG and idle publishers never start or join", async () => {
  for (const overrides of [{generation:4},{state:"idle"},{transport:"jpeg"},{inventory:{srtExperiment:{available:false}}},{obsSession:{ready:false}}]) {
    const f=fixture(overrides); await assert.rejects(f.controller.start({viewerId:A,generation:3}));
    assert.equal(f.calls.some(c=>c.action==="join"),false); assert.equal(f.service.leases.has(A),false);
  }
});
test("invalid capabilities and missing generations reject before touching demand", async () => {
  for(const request of [{viewerId:"x",generation:3},{viewerId:A},{viewerId:A,generation:"3"}]) {
    const f=fixture(); await assert.rejects(f.controller.start(request),/Invalid/); assert.equal(f.calls.length,0);
  }
});
test("only the exact controller and generation can Stop; another ordinary viewer survives", async () => {
  const f=fixture(); await f.controller.start({viewerId:A,generation:3});
  await assert.rejects(f.controller.stop({viewerId:B,generation:3}),/does not own/);
  await assert.rejects(f.controller.stop({viewerId:A,generation:4}),/generation/);
  const value=await f.controller.stop({viewerId:A,generation:3}); assert.equal(value.state,"stopped");
  assert.equal(f.service.leases.has(A),false); assert.equal(f.service.leases.has(B),true); assert.equal(f.service.state,"running");
  assert.equal(f.calls.filter(c=>c.releaseSrt).length,1);
});
test("expiry closes SRT and removes native demand even without browser heartbeats", async () => {
  const f=fixture(); await f.controller.start({viewerId:A,generation:3}); f.advance(MAX_DURATION_MS); f.controller.sweep(); await flush();
  assert.equal(f.controller.status(A).state,"expired"); assert.equal(f.calls.filter(c=>c.releaseSrt).length,1); assert.equal(f.service.leases.has(A),false);
});
test("ending the final native viewer cleans shared visuals", async () => {
  const f=fixture(); await f.controller.start({viewerId:A,generation:3}); f.service.leases.delete(B);
  await f.controller.stop({viewerId:A,generation:3}); assert.equal(f.service.state,"idle"); assert.equal(f.calls.filter(c=>c.release).length,1);
});
test("selection changes remove old native demand without stopping another generation", async () => {
  const f=fixture(); await f.controller.start({viewerId:A,generation:3}); f.service.generation=4; f.controller.sweep(); await flush();
  assert.equal(f.service.leases.has(A),false); assert.equal(f.service.leases.has(B),true); assert.equal(f.service.generation,4);
});
test("SRT teardown failure fails closed and reports error instead of falsely stopped", async () => {
  const f=fixture(); f.service.obsTransport.releaseSrt=async()=>{throw Error("PRIVATE");};
  await f.controller.start({viewerId:A,generation:3}); await assert.rejects(f.controller.stop({viewerId:A,generation:3}),/cleanup failed/);
  assert.equal(f.service.state,"error"); assert.equal(f.controller.status(A).state,"error"); assert.equal(f.calls.filter(c=>c.fail).length,1);
  assert.deepEqual(f.lifecycle.slice(-2).map(entry => [entry.event, entry.reason, entry.failureCode]),
    [["srt-error", "user-stop", "cleanup-failed"], ["srt-end", "user-stop", "cleanup-failed"]]);
  assert.doesNotMatch(JSON.stringify(f.lifecycle), /PRIVATE|viewerId|passphrase/);
});
test("Stop fences a delayed connection without resurrecting a native lease or revealing its URL", async () => {
  const f=fixture(); let finish; f.service.obsTransport.srtConnection=()=>new Promise(resolve=>finish=resolve);
  const starting=f.controller.start({viewerId:A,generation:3}); while(!finish) await flush();
  await f.controller.stop({viewerId:A,generation:3}); finish({url:"srt://192.168.50.119:8890?private",generation:3,requestedLatencyMs:250});
  await assert.rejects(starting,/ended|complete/); assert.equal(f.service.leases.has(A),false); assert.equal(f.controller.run,null);
});

test("Stop waits for a delayed join and removes its late lease without opening SRT", async () => {
  const f=fixture(); let finish, connected=0;
  f.service.session=request=>new Promise(resolve=>{finish=()=>{f.service.leases.set(request.viewerId,13000);resolve();};});
  f.service.obsTransport.srtConnection=async()=>{connected++;throw Error("Must not connect");};
  const starting=f.controller.start({viewerId:A,generation:3}); while(!finish) await flush();
  const stopping=f.controller.stop({viewerId:A,generation:3}); finish();
  await assert.rejects(starting,/ended|complete/); await stopping;
  assert.equal(connected,0); assert.equal(f.service.leases.has(A),false); assert.equal(f.service.leases.has(B),true);
});
test("a second experiment is refused without changing the first experiment deadline", async () => {
  const f=fixture(); const first=await f.controller.start({viewerId:A,generation:3}); f.advance(10000);
  await assert.rejects(f.controller.start({viewerId:"another_controller_123456789",generation:3}),/Stop/);
  assert.equal(f.controller.status(A).expiresAt,first.expiresAt);
});
test("cached counters exclude secrets and become unavailable when stale, missing or invalid", () => {
  const value={readers:1,observedAt:1000,stats:[{msRTT:0,bytesSent:42,packetsRetrans:-1,msSendTsbPdDelay:"250",secret:"PRIVATE"}]};
  const fresh=safeMetrics(value,2000); assert.equal(fresh.stats[0].msRTT,0); assert.equal(fresh.stats[0].bytesSent,42); assert.equal(fresh.stats[0].packetsRetrans,null);
  assert.equal(fresh.stats[0].msSendTsbPdDelay,null); assert.equal(JSON.stringify(fresh).includes("PRIVATE"),false);
  assert.equal(safeMetrics(value,6001).readers,null); assert.deepEqual(safeMetrics(value,6001).stats,[]); assert.equal(safeMetrics(null,1000).readers,null);
});

const independentProfile = { requestedBitrateMbps: 600, configuredBitrateMbps: 599.999488, encoderMode: "independent-srt",
  width: 3840, height: 2160, fps: 60, videoBitrateMbps: 590.5, videoBitrateObservedAt: 1000, videoBitrateWindowMs: 2000 };

test("independent failure diagnostics survive owned branch cleanup and remain private to its controller", async () => {
  const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60, 600];
  let cached = { state: "ready", videoProfile: independentProfile };
  f.service.obsTransport.srtConnection = async () => ({ url: "srt://192.168.50.119:8891", generation: 3, requestedLatencyMs: 250, videoProfile: independentProfile });
  f.service.obsTransport.snapshot = () => ({ srtExperiment: cached });
  f.service.obsTransport.releaseSrt = async request => { f.calls.push({ releaseSrt: request }); cached = { state: "disabled" }; };
  await f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps: 600 });
  f.advance(5000);
  const diagnostics = { failureCode: "child-exit", failureObservedAt: 6000, exitCode: 3221225725, signal: "SIGTERM" };
  cached = { state: "error", videoProfile: independentProfile, diagnostics: { ...diagnostics, url: "PRIVATE", passphrase: "PRIVATE", message: "PRIVATE" } };
  f.controller.sweep(); await flush();
  assert.equal(f.controller.run, null); assert.equal(f.controller.status(A).state, "error");
  assert.deepEqual(f.controller.status(A).diagnostics, diagnostics);
  assert.equal(f.controller.status(A).connectionUrl, undefined); assert.equal(JSON.stringify(f.controller.status(A)).includes("PRIVATE"), false);
  assert.equal(f.controller.status(B).state, "idle"); assert.equal(f.controller.status(B).diagnostics.failureCode, null);
  assert.equal(f.service.state, "running"); assert.equal(f.service.leases.has(B), true);
  assert.deepEqual(f.lifecycle.map(entry => entry.event), ["srt-started", "srt-ready", "srt-error", "srt-end"]);
  assert.deepEqual(f.lifecycle.slice(-2).map(entry => [entry.reason, entry.failureCode]), [["sender-failure", "child-exit"], ["sender-failure", "child-exit"]]);
  assert.doesNotMatch(JSON.stringify(f.lifecycle), /PRIVATE|viewerId|passphrase|url|message/);
});

test("cleanup diagnostics retain the original helper cause through an explicit Stop retry", async () => {
  for (const firstFailure of [null, "child-error", "send-buffer-full"]) {
    const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60, 600];
    let diagnostics = firstFailure ? { failureCode: firstFailure, failureObservedAt: 1000, exitCode: null, signal: null } : null, cleanupFailed = true;
    f.service.obsTransport.srtConnection = async () => ({ url: "srt://192.168.50.119:8891", generation: 3, requestedLatencyMs: 250, videoProfile: independentProfile });
    f.service.obsTransport.snapshot = () => ({ srtExperiment: { state: diagnostics ? "error" : "ready", videoProfile: independentProfile, diagnostics } });
    f.service.obsTransport.releaseSrt = async () => {
      if (cleanupFailed) { diagnostics = { failureCode: "cleanup-failed", failureObservedAt: 1000, exitCode: null, signal: null }; throw Error("PRIVATE cleanup failure"); }
      diagnostics = null;
    };
    await f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps: 600 });
    await assert.rejects(f.controller.stop({ viewerId: A, generation: 3 }), /cleanup failed/);
    assert.equal(f.controller.status(A).diagnostics.failureCode, firstFailure || "cleanup-failed");
    assert.equal(f.controller.status(B).diagnostics.failureCode, null);
    for (let retry = 0; retry < 20; retry++) await assert.rejects(f.controller.stop({ viewerId: A, generation: 3 }), /cleanup failed/);
    assert.equal(f.lifecycle.length, 3); assert.equal(f.lifecycle.at(-1).event, "srt-error");
    assert.equal(f.lifecycle.at(-1).leasePresent, true); assert.equal(f.lifecycle.at(-1).cleanupFailed, true);
    assert.equal(f.lifecycle.at(-1).failureCode, firstFailure || "cleanup-failed");
    cleanupFailed = false; await f.controller.stop({ viewerId: A, generation: 3 });
    assert.equal(f.controller.status(A).diagnostics.failureCode, firstFailure || "cleanup-failed");
    assert.equal(f.controller.run, null); assert.equal(f.service.leases.has(B), true);
    assert.equal(f.lifecycle.length, 4); assert.equal(f.lifecycle.at(-1).reason, "user-stop");
    assert.equal(f.lifecycle.at(-1).failureCode, firstFailure || "cleanup-failed");
    assert.equal(f.lifecycle.at(-1).leasePresent, false); assert.doesNotMatch(JSON.stringify(f.lifecycle), /PRIVATE|viewerId|passphrase/);
  }
});

test("previous generations, older trials and shared video cannot supply another run's diagnostics", async () => {
  for (const mismatch of ["old-trial", "old-generation", "shared-profile", "shared-run"]) {
    const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60, 600];
    const isShared = mismatch === "shared-run", profile = isShared ? { ...independentProfile, requestedBitrateMbps: 60, configuredBitrateMbps: 60, encoderMode: "shared-publisher" } : independentProfile;
    f.service.obsTransport.srtConnection = async () => ({ url: "srt://192.168.50.119:8891", generation: 3, requestedLatencyMs: 250, videoProfile: profile });
    await f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps: isShared ? 60 : 600 });
    f.advance(1000);
    f.service.obsTransport.snapshot = () => ({ srtExperiment: { state: "error", videoProfile: mismatch === "shared-profile" ? { ...profile, encoderMode: "shared-publisher" } : profile,
      diagnostics: { failureCode: "child-error", failureObservedAt: mismatch === "old-trial" ? 999 : 2000, exitCode: null, signal: null } } });
    if (mismatch === "old-generation") f.service.generation = 4;
    assert.equal(f.controller.status(A).diagnostics.failureCode, null, mismatch);
    await f.controller.stop({ viewerId: A, generation: 3 });
    assert.equal(f.controller.status(A).diagnostics.failureCode, null, mismatch);
  }
});

test("failure diagnostics accept only fixed codes, bounded timestamps, numeric exit values and safe signals", () => {
  const value = { failureCode: "child-exit", failureObservedAt: 1000, exitCode: 4294967295, signal: "SIGTERM", command: "PRIVATE", url: "PRIVATE", raw: "PRIVATE" };
  assert.deepEqual(safeDiagnostics(value, 2000), { failureCode: "child-exit", failureObservedAt: 1000, exitCode: 4294967295, signal: "SIGTERM" });
  assert.equal(JSON.stringify(safeDiagnostics(value, 2000)).includes("PRIVATE"), false);
  for (const patch of [{ failureCode: "SECRET" }, { failureObservedAt: 0 }, { failureObservedAt: -1 }, { failureObservedAt: 2001 },
    { failureObservedAt: "1000" }, { failureObservedAt: Infinity }, { failureObservedAt: 1.5 }]) {
    assert.deepEqual(safeDiagnostics({ ...value, ...patch }, 2000), { failureCode: null, failureObservedAt: null, exitCode: null, signal: null });
  }
  for (const exitCode of ["1", Infinity, NaN, 1.5, -2147483649, 4294967296]) assert.equal(safeDiagnostics({ ...value, exitCode }, 2000).exitCode, null);
  assert.equal(safeDiagnostics({ ...value, signal: "SIGTERM PRIVATE" }, 2000).signal, null);
  assert.deepEqual(safeDiagnostics({ ...value, failureCode: "monitor-error" }, 2000), { failureCode: "monitor-error", failureObservedAt: 1000, exitCode: null, signal: null });
  assert.equal(safeDiagnostics(value, NaN).failureCode, null);
});

test("send-buffer-full is an exact private-controller failure code with no raw transport or exit details", async () => {
  const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60, 600];
  let cached = { state: "ready", videoProfile: independentProfile };
  f.service.obsTransport.srtConnection = async () => ({ url: "srt://192.168.50.119:8891", generation: 3, requestedLatencyMs: 250, videoProfile: independentProfile });
  f.service.obsTransport.snapshot = () => ({ srtExperiment: cached });
  f.service.obsTransport.releaseSrt = async request => { f.calls.push({ releaseSrt: request }); cached = { state: "idle" }; };
  const started = await f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps: 600 });
  f.advance(1000);
  const diagnostic = { failureCode: "send-buffer-full", failureObservedAt: 2000, exitCode: 42, signal: "SIGTERM",
    message: "Dropping caller PRIVATE: Non-blocking call failure: no buffer available for sending", url: "srt://PRIVATE", passphrase: "PRIVATE" };
  cached = { state: "error", videoProfile: independentProfile, diagnostics: diagnostic };
  const pending = f.controller.status(A);
  assert.equal(pending.expiresAt, started.expiresAt); assert.equal(pending.state, "error");
  assert.deepEqual(pending.diagnostics, { failureCode: "send-buffer-full", failureObservedAt: 2000, exitCode: null, signal: null });
  f.controller.sweep(); await flush();
  const terminal = f.controller.status(A);
  assert.equal(terminal.state, "error"); assert.deepEqual(terminal.diagnostics, pending.diagnostics);
  assert.equal(f.controller.run, null); assert.equal(f.service.leases.has(A), false); assert.equal(f.service.leases.has(B), true);
  assert.equal(f.controller.status(B).diagnostics.failureCode, null); assert.equal(f.service.state, "running");
  assert.doesNotMatch(JSON.stringify(terminal), /PRIVATE|Dropping caller|passphrase|srt:\/\//);
  for (const code of ["send-buffer-full PRIVATE", "Send-buffer-full", "send-buffer-fullx", "no buffer available for sending"])
    assert.equal(safeDiagnostics({ ...diagnostic, failureCode: code }, 2000).failureCode, null);
});

test("independent encoder failure closes only its branch and stops reporting ready", async () => {
  const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60, 600];
  let state = "ready";
  f.service.obsTransport.srtConnection = async () => ({url:"srt://192.168.50.119:8891",generation:3,requestedLatencyMs:250,videoProfile:independentProfile});
  f.service.obsTransport.snapshot = () => ({srtExperiment:{state,videoProfile:independentProfile}});
  await f.controller.start({viewerId:A,generation:3,videoBitrateMbps:600}); state = "error";
  assert.equal(f.controller.status(A).state,"error"); f.controller.sweep(); await flush();
  assert.equal(f.controller.run,null); assert.equal(f.controller.status(A).state,"error");
  assert.equal(f.service.state,"running"); assert.equal(f.service.generation,3);
  assert.equal(f.service.leases.has(B),true); assert.equal(f.calls.some(c=>c.fail),false);
});

test("independent cleanup failure preserves its bounded controller for Stop retry without stopping WebRTC", async () => {
  const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60,600];
  f.service.obsTransport.srtConnection = async () => ({url:"srt://192.168.50.119:8891",generation:3,requestedLatencyMs:250,videoProfile:independentProfile});
  const first = await f.controller.start({viewerId:A,generation:3,videoBitrateMbps:600});
  f.service.obsTransport.releaseSrt = async () => {throw Error("private helper could not terminate");};
  await assert.rejects(f.controller.stop({viewerId:A,generation:3}),/Independent SRT cleanup failed/);
  const failed = f.controller.status(A); assert.equal(failed.state,"error"); assert.equal(failed.generation,3); assert.equal(failed.expiresAt,first.expiresAt);
  assert.equal(failed.connectionUrl,undefined); assert.equal(failed.videoProfile.encoderMode,"independent-srt");
  assert.equal(f.service.state,"running"); assert.equal(f.service.leases.has(B),true); assert.equal(f.calls.some(c=>c.fail),false);
  f.service.obsTransport.releaseSrt = async () => {};
  await f.controller.stop({viewerId:A,generation:3}); assert.equal(f.controller.run,null); assert.equal(f.controller.status(A).state,"stopped");
  assert.equal(f.service.leases.has(A),false); assert.equal(f.service.leases.has(B),true);
});

test("unsupported SRT bitrates reject before creating experiment or visual demand", async () => {
  for (const videoBitrateMbps of ["600", 0, 80, 600000, null, Infinity]) {
    const f = fixture(); await assert.rejects(f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps }), /Invalid/);
    assert.equal(f.controller.run, null); assert.equal(f.calls.length, 0); assert.equal(f.service.leases.size, 1);
  }
});

test("600 Mbps needs explicitly prepared independent support and never falls back to shared video", async () => {
  const f = fixture(); let starts = 0;
  f.service.obsTransport.srtConnection = async () => { starts++; throw Error("Must not fall back"); };
  await assert.rejects(f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps: 600 }), /unavailable/);
  assert.equal(starts, 0); assert.equal(f.calls.some(call => call.action === "join"), false);
  assert.equal(f.service.state, "running"); assert.equal(f.service.leases.has(B), true);
});

test("600 Mbps reaches only the independent video branch with the original internal expiry and safe profile", async () => {
  const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60, 600]; let request;
  f.service.obsTransport.srtConnection = async value => { request = value; return {
    url: "srt://192.168.50.119:8891?private-test", generation: 3, requestedLatencyMs: 250,
    videoProfile: { ...independentProfile, password: "PRIVATE", connectionUrl: "PRIVATE" }
  }; };
  const receipt = await f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps: 600, expiresAt: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(request, { viewerId: A, generation: 3, videoBitrateMbps: 600, expiresAt: 601000 });
  assert.equal(receipt.videoProfile.requestedBitrateMbps, 600); assert.equal(receipt.videoProfile.configuredBitrateMbps, 599.999488);
  assert.equal(receipt.videoProfile.encoderMode, "independent-srt"); assert.equal(receipt.videoProfile.videoBitrateMbps, 590.5);
  assert.equal(JSON.stringify(receipt.videoProfile).includes("PRIVATE"), false);
  assert.equal(f.service.state, "running"); assert.equal(f.service.leases.get(B), 13000);
  f.advance(6000); const status = f.controller.status(A); assert.equal(status.videoProfile.videoBitrateMbps, null);
  assert.equal(status.videoProfile.videoBitrateWindowMs, null); assert.equal(status.connectionUrl, undefined);
  await f.controller.stop({ viewerId: A, generation: 3 }); assert.equal(f.service.state, "running"); assert.equal(f.service.leases.has(B), true);
});

test("600 Mbps rejects shared or incorrectly configured encoder receipts and removes only its lease", async () => {
  for (const change of [{ encoderMode: "shared-publisher" }, { configuredBitrateMbps: 614.4 }, { configuredBitrateMbps: 60 }, { width: 1920 }, { fps: 30 }]) {
    const f = fixture(); f.service.inventory.srtExperiment.videoTargetsMbps = [60, 600];
    f.service.obsTransport.srtConnection = async () => ({ url: "srt://192.168.50.119:8891", generation: 3, requestedLatencyMs: 250, videoProfile: { ...independentProfile, ...change } });
    await assert.rejects(f.controller.start({ viewerId: A, generation: 3, videoBitrateMbps: 600 }), /could not complete/);
    assert.equal(f.service.leases.has(A), false); assert.equal(f.service.leases.has(B), true); assert.equal(f.service.state, "running");
    assert.equal(f.calls.filter(call => call.releaseSrt).length, 1);
  }
});

test("explicit 60 Mbps baseline rejects a stale higher-rate shared publisher without changing it", async () => {
  const f = fixture(); f.service.obsTransport.srtConnection = async () => ({url:"srt://192.168.50.119:8890",generation:3,requestedLatencyMs:250,
    videoProfile:{requestedBitrateMbps:60,configuredBitrateMbps:80,encoderMode:"shared-publisher",width:3840,height:2160,fps:60}});
  await assert.rejects(f.controller.start({viewerId:A,generation:3,videoBitrateMbps:60}),/could not complete/);
  assert.equal(f.service.state,"running"); assert.equal(f.service.leases.has(B),true); assert.equal(f.service.leases.has(A),false);
});

test("video profile measurements whitelist observed codec fields, real zeros and freshness", () => {
  const value = { ...independentProfile, videoBitrateMbps: 0, secret: "PRIVATE", observedCodec: {
    profile: "high", level: "6.1", observedAt: 1000, measurement: "gstreamer-h264parse-caps", privateUrl: "PRIVATE"
  } };
  const fresh = safeVideoProfile(value, 2000); assert.equal(fresh.videoBitrateMbps, 0); assert.equal(fresh.observedCodec.level, "6.1");
  assert.equal(JSON.stringify(fresh).includes("PRIVATE"), false);
  assert.equal(safeVideoProfile(value, 6001).videoBitrateMbps, null);
  assert.equal(safeVideoProfile({ ...value, videoBitrateObservedAt: 3000 }, 2000).videoBitrateMbps, null);
  assert.equal(safeVideoProfile({ ...value, observedCodec: { ...value.observedCodec, level: "PRIVATE" } }, 2000).observedCodec, null);
  assert.equal(safeVideoProfile({ ...value, requestedBitrateMbps: 80 }, 2000), null);
});
