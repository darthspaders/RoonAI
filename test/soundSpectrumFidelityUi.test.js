"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../public/soundSpectrumFidelity.js"), "utf8");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(search = "?visualDiagnostics=1") {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = new Map(); this.hidden = false; this.open = false; this.textContent = ""; this.disabled = false; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(event, fn) { this.events.set(event, fn); }
    dispatch(event, extra = {}) { this.events.get(event)?.({ stopPropagation() {}, ...extra }); }
  }
  const remote = { state: "running", generation: 4, videoStats: { width: 800, height: 450, quality: 65 } };
  const fidelity = { active: true, generation: 4, format: "JPEG", transmittedResolution: { width: 800, height: 450 }, jpegPrecisionBits: 8, jpegSubsampling: "4:2:0", decodedResolution: { width: 800, height: 450 }, foregroundCanvasResolution: { width: 800, height: 450 }, backgroundCanvasResolution: { width: 320, height: 180 }, displayedCssResolution: { width: 1200, height: 900 }, displayedImageCssResolution: { width: 1200, height: 675 }, backgroundDisplayedCssResolution: { width: 1600, height: 1000 }, devicePixelRatio: 2, displayDevicePixels: { width: 2400, height: 1350 }, foregroundScale: { deviceX: 3, deviceY: 3 }, jpegPayloadMbps: 12.5, wireMbps: 12.51, averagingSeconds: 5, canvasColorSpace: "srgb", canvasColorType: "unorm8", decoderColorSpace: "Browser default conversion; not verified", foregroundPresentation: { opacity: "0.8", filter: "none", imageRendering: "auto", imageSmoothingQuality: "low" }, backgroundPresentation: { opacity: "0.26", filter: "blur(12px)" } };
  const server = { state: "running", generation: 4, native: { clientResolution: { width: 3840, height: 2160 }, observedAt: 1791357600000 }, capture: { configuredResolution: { width: 800, height: 450 }, inputResolution: null }, transmission: { resolution: { width: 800, height: 450 }, quality: 65, payloadBitrateMbps: 13 } };
  const requests = [], surface = new Element("surface"); let visible = true, statsReads = 0, fetchImpl = async () => ({ ok: true, json: async () => server });
  const context = { window: {}, location: { search }, URLSearchParams, AbortController, Date, document: { createElement: tag => new Element(tag) }, fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); } };
  vm.runInNewContext(source, context);
  const diagnostic = context.window.createSoundSpectrumFidelity({ surface, getVideoStats: () => { statsReads++; return { fidelity }; }, getRemote: () => remote, isVisible: () => visible, presentation: () => "windowed" });
  const panel = surface.children[0], list = panel?.children[1], button = panel?.children[2].children[0];
  const values = () => Object.fromEntries((list?.children || []).flatMap((value, index, all) => index % 2 ? [] : [[value.textContent, all[index + 1].textContent]]));
  const open = () => { diagnostic.render(); panel.open = true; panel.dispatch("toggle"); };
  return { diagnostic, remote, fidelity, server, surface, panel, button, requests, values, open, statsReads: () => statsReads, setVisible: value => { visible = value; }, setFetch: value => { fetchImpl = value; } };
}
test("temporary diagnostic is opt-in, and opening it requests only a passive native measurement", async () => {
  const off = harness(""); assert.equal(off.diagnostic, null); assert.equal(off.surface.children.length, 0); assert.equal(off.requests.length, 0);
  const h = harness(); h.diagnostic.render(); assert.equal(h.requests.length, 0);
  h.open(); await flush();
  assert.deepEqual(h.requests.map(x => x.url), ["/api/soundspectrum/fidelity"]);
  assert.equal(h.requests[0].options.method, undefined);
  assert.equal(h.requests[0].options.cache, "no-store");
  assert.equal(h.values()["Native window client"], "3840 × 2160 px");
  assert.equal(h.values()["Native internal render target"], "Unknown · not exposed by window capture");
});
test("diagnostic separates intrinsic, backing, CSS, object-fit and DPR dimensions, and exposes actual opacity", async () => {
  const h = harness(); h.open(); await flush(); const rows = h.values();
  assert.equal(rows["Canvas backing"], "800 × 450 px"); assert.equal(rows["Display element"], "1200 × 900 CSS px");
  assert.equal(rows["Displayed image"], "1200 × 675 CSS px · includes object-fit");
  assert.match(rows["Display pixel demand"], /^2400 × 1350/); assert.match(rows["Image enlargement"], /^3\.00× horizontal \/ 3\.00× vertical/);
  assert.match(rows["Foreground composition"], /^Opacity 0\.8 · filter none$/); assert.match(rows["Backdrop composition"], /^Opacity 0\.26 · filter blur\(12px\)$/);
  assert.match(rows["JPEG precision / chroma"], /^8 bits · 4:2:0/); assert.match(rows["JPEG payload bitrate"], /^12\.50 Mbps/);
  assert.match(rows["Application wire bitrate"], /excludes network framing/); assert.match(rows["Capture before scaling"], /^Unknown/);
  assert.equal(rows["Browser canvas color"], "srgb / unorm8");
});
test("unchanged diagnostics retain their nodes, and existing render calls update local dimensions without another request", async () => {
  const h = harness(); h.open(); await flush(); const old = [...h.panel.children[1].children];
  h.fidelity.displayedCssResolution = { width: 1920, height: 1080 }; h.diagnostic.render(); h.diagnostic.render();
  assert.equal(h.values()["Display element"], "1920 × 1080 CSS px"); assert.deepEqual(h.panel.children[1].children, old); assert.equal(h.requests.length, 1);
});
test("late native observations are ignored on source generation changes and pending queries abort on hide", async () => {
  const h = harness(); let resolve; h.setFetch(() => new Promise(yes => { resolve = yes; })); h.open(); await flush();
  const signal = h.requests[0].options.signal; h.remote.generation = 5; h.fidelity.generation = 5; h.diagnostic.render(); assert.equal(signal.aborted, true);
  resolve({ ok: true, json: async () => h.server }); await flush(); assert.equal(h.values()["Native window client"], "Unknown px");
  h.button.dispatch("click"); await flush(); assert.equal(h.requests.length, 2); h.setVisible(false); h.diagnostic.render();
  assert.equal(h.panel.hidden, true); assert.equal(h.requests[1].options.signal.aborted, true);
});
test("native query failure and missing browser measurements stay unknown without issuing audio, session or video requests", async () => {
  const h = harness(); h.setFetch(async () => ({ ok: false })); h.fidelity.canvasColorSpace = null; h.fidelity.jpegPrecisionBits = null; h.fidelity.jpegSubsampling = null;
  h.fidelity.jpegPayloadMbps = null; h.open(); await flush();
  assert.equal(h.values()["Native window client"], "Unknown px"); assert.match(h.values()["Browser canvas color"], /^Unknown/);
  assert.match(h.values()["JPEG precision / chroma"], /^Unknown bits · Unknown/); assert.match(h.values()["JPEG payload bitrate"], /^Unknown Mbps/);
  assert.equal(h.button.disabled, false); assert.deepEqual(h.requests.map(x => x.url), ["/api/soundspectrum/fidelity"]);
  h.fidelity.active = false; h.diagnostic.render(); assert.equal(h.panel.hidden, true);
});
test("collapsed diagnostics avoid geometry reads and mismatched recovery generations cannot show mixed native and browser values", async () => {
  const h = harness(); h.diagnostic.render(); h.diagnostic.render(); assert.equal(h.statsReads(), 0); assert.equal(h.requests.length, 0);
  h.open(); await flush(); assert.equal(h.values()["Native window client"], "3840 × 2160 px");
  h.fidelity.generation = 5; h.diagnostic.render(); assert.equal(h.panel.hidden, true);
  h.remote.generation = 5; h.diagnostic.render(); assert.equal(h.panel.hidden, false); assert.equal(h.values()["Native window client"], "Unknown px");
  assert.equal(h.requests.length, 1);
});

test("OBS diagnostics distinguish video from JPEG and do not imply measured color precision or a foreground canvas", async () => {
  const h = harness(); h.remote.transport = "obs-webrtc";
  Object.assign(h.fidelity, { format: "WebRTC", codec: "video/H264", codecParameters: "profile-level-id=42e01f", foregroundCanvasResolution: null,
    transmittedResolution: { width: 1920, height: 1080 }, wireMbps: 24, rtc: { meanDecodeMs: 2, meanJitterBufferMs: 5, framesDropped: 3, packetsLost: 0 } });
  Object.assign(h.server.capture, { inputResolution: { width: 2560, height: 1440 }, inputResolutionMeasurement: "obs-scene-item-source-size", inputObservedAt: 1000 });
  Object.assign(h.server.transmission, { configuredBitrateMbps: 25, configuredBitDepth: 8, configuredChromaSubsampling: "4:2:0", colorSpace: "Rec.709", range: "limited",
    outputSettingsResolution: { width: 1920, height: 1080 }, outputSettingsMeasurement: "obs-get-video-settings", payloadBitrateMbps: 25.2, bitrateScope: "publisher-stream-payload" });
  h.open(); await flush(); const rows = h.values();
  assert.equal(rows["Transmitted JPEG"], "Not used · WebRTC video"); assert.match(rows["Received video"], /^1920 × 1080 px · inbound RTP/);
  assert.equal(rows["Canvas backing"], "Foreground uses the decoded video directly"); assert.match(rows["Format / quality"], /video\/H264 · 25\.00 Mbps publisher target/);
  assert.match(rows["Application wire bitrate"], /^24\.00 Mbps · browser inbound RTP/); assert.match(rows["JPEG precision / chroma"], /unverified/);
  assert.match(rows["Browser canvas color"], /canvas conversion not used/); assert.match(rows["Native \/ captured framebuffer color"], /unknown/);
  assert.equal(rows["Capture conversion color"], "8 bits · 4:2:0 · Rec.709 limited range (configured) · actual negotiated color unverified");
  assert.equal(rows["Capture before scaling"], "2560 × 1440 px · OBS scene-item source size (cached observation)");
  assert.equal(rows["Capture after scaling"], "1920 × 1080 px · OBS GetVideoSettings; output settings, not measured wire dimensions");
  assert.equal(rows["Capture payload bitrate"], "25.20 Mbps · publisher stream payload, including Opus silence · server counter delta");
  assert.equal(rows["Video decode / jitter buffer"], "2.00 / 5.00 ms · cumulative averages"); assert.equal(rows["Video frames dropped / packets lost"], "3 / 0");
  h.remote.transport = "jpeg"; h.fidelity.format = "JPEG"; h.diagnostic.render();
  assert.equal(h.values()["Received video"], "Not used · JPEG route"); assert.equal(h.values()["Video codec parameters"], "Not used · JPEG route");
});

test("WebRTC diagnostics separate interval buffer measurements and their age from cumulative jitter averages", async () => {
  const h = harness(); h.remote.transport = "obs-webrtc"; h.fidelity.format = "WebRTC";
  h.fidelity.rtc = { bufferMode: "250ms", bufferTargetState: "applied", requestedBufferMs: 250,
    meanJitterBufferMs: 42, jitterBufferMs: 200, jitterBufferTargetMs: 250, jitterBufferMinimumMs: 0, bufferIntervalSeconds: 4, sampleAgeMs: 125 };
  h.open(); await flush();
  assert.equal(h.values()["Video buffer preference"], "250 ms · browser setting verified · actual delay can differ");
  assert.equal(h.values()["Video buffer actual / target / minimum"], "200.00 / 250.00 / 0.00 ms · last 4.00 s interval");
  assert.equal(h.values()["Video buffer sample age"], "0.13 s old");
  assert.match(h.values()["Video decode / jitter buffer"], /42\.00 ms · cumulative averages/);
  h.fidelity.rtc.sampleAgeMs = 5001; h.diagnostic.render();
  assert.match(h.values()["Video buffer actual / target / minimum"], /stale/); assert.match(h.values()["Video buffer sample age"], /stale/);
  assert.equal(h.requests.length, 1, "existing render performs no extra server query");
});

test("missing buffer interval data stays unknown and unsupported or rejected choices never imply success", async () => {
  const h = harness(); h.remote.transport = "obs-webrtc"; h.fidelity.format = "WebRTC";
  h.fidelity.rtc = { bufferMode: "automatic", bufferTargetState: "unsupported", sampleAgeMs: null, bufferIntervalSeconds: null };
  h.open(); await flush();
  assert.equal(h.values()["Video buffer preference"], "Automatic · unsupported · browser default");
  assert.equal(h.values()["Video buffer actual / target / minimum"], "Waiting for interval measurements");
  assert.equal(h.values()["Video buffer sample age"], "Unknown · waiting for measurements");
  h.fidelity.rtc.bufferTargetState = "rejected"; h.diagnostic.render();
  assert.equal(h.values()["Video buffer preference"], "Automatic · rejected · previous buffering may remain");
  h.fidelity.rtc.bufferTargetState = "idle"; h.diagnostic.render();
  assert.equal(h.values()["Video buffer preference"], "Automatic · waiting for receiver");
  assert.equal(h.requests.length, 1);
});

test("JPEG diagnostics mark WebRTC buffer information inapplicable even if cached RTC measurements exist", async () => {
  const h = harness(); h.fidelity.rtc = { bufferMode: "250ms", bufferTargetState: "applied", sampleAgeMs: 0,
    jitterBufferMs: 250, jitterBufferTargetMs: 250, jitterBufferMinimumMs: 10, bufferIntervalSeconds: 4 };
  h.open(); await flush();
  for (const label of ["Video buffer preference", "Video buffer actual / target / minimum", "Video buffer sample age"]) assert.equal(h.values()[label], "Not used · JPEG route");
  assert.equal(h.requests.length, 1);
});

test("HLS diagnostics expose byte targets and observed buffering without JPEG or RTP claims", async () => {
  const h = harness(); h.remote.transport = "hls"; h.remote.videoStats.configuredBitrateMbps = 600;
  Object.assign(h.fidelity, { format: "HLS", codec: "avc1.64003e", codecParameters: null, foregroundCanvasResolution: null,
    transmittedResolution: { width: 1920, height: 1080 }, wireMbps: 310, hls: { requestedBufferMB: 32, bufferedSeconds: 0.43, latencySeconds: 0.7, droppedFrames: 2,
      presentedFps: 59.9, callbackFps: 30, dropPercent: 0, playbackIntervalSeconds: 1.1, presentationSampleAgeMs: 500, playbackSampleAgeMs: 100 } });
  Object.assign(h.server.transmission, { configuredBitrateMbps: 600, payloadBitrateMbps: 312 });
  h.open(); await flush(); const rows = h.values();
  assert.equal(rows["Transmitted JPEG"], "Not used · HLS video"); assert.match(rows["Received video"], /1920 × 1080 px · HLS video-track metadata/);
  assert.equal(rows["Canvas backing"], "Foreground uses the decoded video directly");
  assert.match(rows["Format / quality"], /HLS · avc1\.64003e · 600\.00 Mbps publisher target/);
  assert.match(rows["Application wire bitrate"], /310\.00 Mbps · completed HLS segment\/part bytes/);
  assert.match(rows["Video buffer preference"], /32\.00 MB · video data target; segments and browser memory can exceed it/);
  assert.match(rows["Video buffer actual / target / minimum"], /0\.43 s buffered ahead · 0\.70 s behind live edge/);
  assert.equal(rows["Video frames dropped / packets lost"], "2 since Start / Not measured · HLS HTTP transport");
  assert.equal(rows["HLS video / callback fps"], "59.90 / 30.00 fps · compositor counter / JavaScript callbacks");
  assert.equal(rows["HLS frame drop interval"], "0.00% · last 1.10 s · video frames, not network packets");
  assert.equal(rows["HLS video / drop sample age"], "0.50 / 0.10 s old · rates unavailable after 3 s");
  assert.equal(rows["JPEG payload bitrate"], "Not used · HLS video");
  assert.match(rows["Video decode / jitter buffer"], /^Not measured/); assert.match(rows["Browser canvas color"], /canvas conversion not used/);
  assert.equal(h.requests.length, 1);
  h.remote.transport = "jpeg"; h.fidelity.format = "JPEG"; h.diagnostic.render();
  assert.equal(h.values()["Video buffer preference"], "Not used · JPEG route"); assert.equal(h.values()["Received video"], "Not used · JPEG route");
});

test("missing HLS measurements stay unknown without borrowing cached RTC measurements", async () => {
  const h = harness(); h.remote.transport = "hls"; h.fidelity.format = "HLS"; h.fidelity.wireMbps = null; h.fidelity.transmittedResolution = null;
  h.fidelity.rtc = { jitterBufferMs: 250, framesDropped: 4, packetsLost: 0 }; h.fidelity.hls = {};
  h.open(); await flush();
  assert.match(h.values()["Video buffer preference"], /^Unknown MB/);
  assert.match(h.values()["Video buffer actual / target / minimum"], /^Unknown s buffered ahead · Unknown s behind live edge/);
  assert.equal(h.values()["Video frames dropped / packets lost"], "Unknown since Start / Not measured · HLS HTTP transport");
  assert.match(h.values()["HLS video / callback fps"], /^Unknown \/ Unknown fps/);
  assert.match(h.values()["HLS frame drop interval"], /^Unknown% · last Unknown s/);
  assert.match(h.values()["Received video"], /^Unknown px/); assert.match(h.values()["Application wire bitrate"], /^Unknown Mbps/);
});
