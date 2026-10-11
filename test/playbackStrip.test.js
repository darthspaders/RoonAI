"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { parseRoonHqplayerZones, createRoonHqplayerRoute } = require("../src/roonHqplayer");
const { parseHqplayerStatus } = require("../src/hqplayerControl");

const DSD = '<?xml version="1.0" encoding="utf-8"?><Status active_bits="1" active_channels="2" active_filter="poly-sinc-gauss-xla" active_mode="SDM (DSD)" active_rate="22579200" active_shaper="ASDM7ECv3" process_speed="1.40585626139028941" state="2"/>';
const read = file => fs.readFileSync(require.resolve(`../${file}`), "utf8");

test("ROON_HQPLAYER_ZONES maps Roon zone names to HQPlayer hosts and skips anything that is not a plain host", () => {
  const zones = parseRoonHqplayerZones(" HQPd = 192.168.60.76 , Den=hqp.local,Study=[fd00::1],Bad=http://evil.example,Path=host/x,=10.0.0.1,NoHost=,Space=a b");
  assert.deepEqual([...zones], [["HQPd", "192.168.60.76"], ["Den", "hqp.local"], ["Study", "fd00::1"]]);
  assert.equal(parseRoonHqplayerZones("").size, 0);
  assert.equal(parseRoonHqplayerZones(undefined).size, 0);
});

test("the Roon HQPlayer route asks only the configured host of a mapped zone, and answers null for any other zone", async () => {
  const asked = [];
  const route = createRoonHqplayerRoute({ zones: parseRoonHqplayerZones("HQPd=192.168.60.76"), control: { status: async host => { asked.push(host); return parseHqplayerStatus(DSD); } } });
  assert.equal((await route("HQPd")).hqplayer.filter, "poly-sinc-gauss-xla");
  for (const zone of ["HQP-WIN11", "", null, "constructor", "__proto__", "hqpd"]) assert.deepEqual(await route(zone), { hqplayer: null }, String(zone));
  assert.deepEqual(asked, ["192.168.60.76"]);
});

test("the server serves the route from ROON_HQPLAYER_ZONES, and .env.example documents it", () => {
  const server = read("src/server.js");
  assert.match(server, /pathname === "\/api\/roon\/hqplayer"\) \{\s*return sendJson\(res, 200, await roonHqplayerStatus\(url\.searchParams\.get\("zone"\)\)\);/);
  assert.match(server, /const roonHqplayerZones = parseRoonHqplayerZones\(config\.roonHqplayer\.zones\);\nconst roonHqplayerControl = createHqplayerControl\(\);\nconst roonHqplayerStatus = createRoonHqplayerRoute\(\{ zones: roonHqplayerZones, control: roonHqplayerControl \}\);/);
  assert.match(read("src/config.js"), /roonHqplayer: \{\s*zones: process\.env\.ROON_HQPLAYER_ZONES \|\| ""/);
  assert.match(read(".env.example"), /\nROON_HQPLAYER_ZONES=\n/);
});

test("Roon and Lyrion share one HQPlayer summary line", () => {
  const context = {};
  vm.runInNewContext(read("public/hqplayerSummary.js"), context);
  assert.equal(context.hqplayerSummary(parseHqplayerStatus(DSD)), "DSD512 · 22.5792 MHz / 1-bit SDM · poly-sinc-gauss-xla · ASDM7ECv3 · 1.4x realtime");
  assert.equal(context.hqplayerSummary(null), "");
  assert.doesNotMatch(read("public/lyrion.js"), /function hqplayerRows\(/);
});

function roonHarness(reply) {
  const listeners = {}, fetched = [], timers = [];
  const el = () => ({ textContent: "", hidden: true });
  const nodes = { nowPlayback: el(), nowPlaybackChain: el(), nowPlaybackSignal: el() };
  const stage = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const context = {
    document: { hidden: false, querySelector: s => s === "#playerView .player" ? stage : null, getElementById: id => nodes[id] },
    fetch: async (url, options) => { fetched.push([url, options.cache]); return { ok: true, json: async () => ({ hqplayer: reply(url) }) }; },
    setInterval: (fn, ms) => timers.push([fn, ms]), encodeURIComponent
  };
  vm.runInNewContext(read("public/hqplayerSummary.js") + read("public/roonPlaybackStrip.js"), context);
  const emit = async detail => { listeners["roon-playback"]({ detail }); await new Promise(r => setImmediate(r)); };
  return { nodes, fetched, timers, emit, context };
}

test("the Roon strip names the zone and its state, and adds HQPlayer's output for a mapped zone", async () => {
  const h = roonHarness(url => url.includes("HQPd") ? parseHqplayerStatus(DSD) : null);
  await h.emit({ zoneName: "HQPd", state: "playing", connected: true });
  assert.deepEqual([h.nodes.nowPlayback.hidden, h.nodes.nowPlaybackChain.textContent], [false, "Roon → HQPd · playing"]);
  assert.deepEqual(h.fetched, [["/api/roon/hqplayer?zone=HQPd", "no-store"]]);
  assert.deepEqual([h.nodes.nowPlaybackSignal.textContent, h.nodes.nowPlaybackSignal.hidden], ["DSD512 · 22.5792 MHz / 1-bit SDM · poly-sinc-gauss-xla · ASDM7ECv3 · 1.4x realtime", false]);
  await h.emit({ zoneName: "Pat's Laptop", state: "paused", connected: true });
  assert.equal(h.fetched.at(-1)[0], "/api/roon/hqplayer?zone=Pat's%20Laptop");
  assert.deepEqual([h.nodes.nowPlaybackChain.textContent, h.nodes.nowPlaybackSignal.hidden], ["Roon → Pat's Laptop · paused", true]);
});

test("Roon state updates for the same zone do not refetch; starting playback does, and so does the 5 s timer while playing", async () => {
  const h = roonHarness(() => parseHqplayerStatus(DSD));
  await h.emit({ zoneName: "HQPd", state: "paused", connected: true });
  await h.emit({ zoneName: "HQPd", state: "paused", connected: true });
  assert.equal(h.fetched.length, 1);
  await h.emit({ zoneName: "HQPd", state: "playing", connected: true });
  await h.emit({ zoneName: "HQPd", state: "playing", connected: true });
  assert.equal(h.fetched.length, 2);
  assert.deepEqual(h.timers.map(([, ms]) => ms), [5000]);
  h.timers[0][0](); await new Promise(r => setImmediate(r));
  assert.equal(h.fetched.length, 3);
});

test("the Roon strip hides while Roon is disconnected or has no zone", async () => {
  const h = roonHarness(() => null);
  await h.emit({ zoneName: "HQPd", state: "playing", connected: false });
  assert.equal(h.nodes.nowPlayback.hidden, true);
  await h.emit({ zoneName: "", state: "stopped", connected: true });
  assert.deepEqual([h.nodes.nowPlayback.hidden, h.nodes.nowPlaybackSignal.hidden], [true, true]);
});

test("the Roon strip sits under the album art, the app reports the zone name, and the art shrinks to make room", () => {
  const html = read("public/index.html");
  assert.match(html, /<div class="cover" id="cover"><\/div>\s*<div id="nowPlayback" class="playbackStrip" hidden><p id="nowPlaybackChain"><\/p><p id="nowPlaybackSignal" class="playbackStripSignal" hidden><\/p><\/div>\s*<\/div>/);
  assert.ok(html.indexOf('src="/hqplayerSummary.js') < html.indexOf('src="/app.js') && html.indexOf('src="/app.js') < html.indexOf('src="/roonPlaybackStrip.js'), "script order");
  assert.match(read("public/app.js"), /const playback = \{ zoneId: state\.selectedZoneId, zoneName: zone\?\.display_name \|\| "",/);
  const css = read("public/styles.css");
  assert.match(css, /> \.artStack:has\(> #nowPlayback:not\(\[hidden\]\)\) \{\s*flex-direction: column;\s*gap: 8px;\s*\}/);
  const cover = "> .artStack > .cover:has(+ #nowPlayback:not([hidden])) {";
  const at = query => { const i = css.indexOf(query); return i < 0 ? "" : css.slice(i, css.indexOf("\n}\n", i)); };
  assert.ok(at("@container (min-height: 200px) {").includes(cover) && at("@container (min-height: 200px) {").includes("width: min(100cqw, calc(100cqh - 52px));"), "two lines under tall art");
  assert.ok(at("@container (min-height: 200px) and (max-width: 599.98px) {").includes("width: min(100cqw, calc(100cqh - 72px));"), "three lines under narrow art");
  assert.match(at("@container (max-height: 199.98px) {"), /#nowPlayback \{\s*display: none;\s*\}/);
});

test("on a phone the art row grows by the strip's room so the cover keeps its phone size", () => {
  const css = read("public/styles.css");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 699px) {"));
  assert.match(phone, /:has\(> \.artStack > #nowPlayback:not\(\[hidden\]\)\) \{\s*grid-template-rows: auto auto auto minmax\(280px, calc\(72vw \+ 72px\)\) auto auto auto;/);
  assert.match(phone, /> \.artStack > \.cover:has\(\+ #nowPlayback:not\(\[hidden\]\)\) \{\s*width: min\(100cqw, calc\(100cqh - 72px\)\);/);
});
