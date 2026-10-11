"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRoonSourceFormat } = require("../src/roonSourceFormat");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const zone = (name, line1 = "Eye in the Sky", extra = {}) => ({
  zone_id: `z-${name}`, display_name: name, state: "playing",
  now_playing: { length: 276, three_line: { line1, line2: "The Alan Parsons Project / Alan Parsons / Andrew Powell / Robert Howes", line3: "Eye in the Sky" }, ...extra }
});
const lmsRows = [
  { title: "Eye in the Sky", artist: "Andrew Powell", album: "Woolfson; Parsons: Eye in the Sky", duration: 280.997, bitrate: "2956kbps VBR", samplerate: "96000", samplesize: "24", type: "flc" },
  { title: "Eye In The Sky", artist: "The Alan Parsons Project", album: "Eye In the Sky", duration: 276.666, bitrate: "785kbps VBR", samplerate: "44100", samplesize: "16", type: "flc" },
  { title: "Eye in the Sky", artist: "The Alan Parsons Project", album: "Eye in the Sky", duration: 276.666, bitrate: "785kbps VBR", samplerate: "44100", samplesize: "16", type: "flc" }
];
const tidalAnswer = { catalogSource: "TIDAL", codec: "FLAC", quality: "HiRes Lossless", mediaTags: ["HIRES_LOSSLESS", "LOSSLESS"], track: { id: "70379770" } };

function harness({ zones = [zone("HQPd"), zone("Marantz AV10")], hqp = new Map([["HQPd", "192.168.60.76"]]), source = { rate: 44100, bits: 16, mime: "application/x-hqplayer-raw" }, rows = lmsRows, tidal = tidalAnswer } = {}) {
  const calls = { hqp: [], lms: [], tidal: [] };
  const byId = new Map(zones.map(z => [z.zone_id, z]));
  const resolve = createRoonSourceFormat({
    getZone: id => byId.get(id),
    hqplayerZones: hqp,
    control: { status: async host => { calls.hqp.push(host); return source ? { source } : null; } },
    lyrionTitles: async title => { calls.lms.push(title); if (rows instanceof Error) throw rows; return rows; },
    tidalQuality: async track => { calls.tidal.push(track); if (tidal instanceof Error) throw tidal; return tidal; }
  });
  return { resolve, calls };
}

test("an HQPlayer zone shows the rate and bit depth HQPlayer is receiving, without asking the library or TIDAL", async () => {
  const { resolve, calls } = harness();
  assert.deepEqual(await resolve("z-HQPd"), { format: "44.1 kHz / 16-bit", from: "hqplayer" });
  assert.deepEqual(calls.hqp, ["192.168.60.76"]);
  assert.equal(calls.lms.length + calls.tidal.length, 0);
});

test("an HQPlayer DSD input is shown in MHz at 1-bit and a file codec is named from its MIME type", async () => {
  assert.equal((await harness({ source: { rate: 2822400, bits: 1, mime: "audio/x-dsf" } }).resolve("z-HQPd")).format, "DSD · 2.8224 MHz / 1-bit");
});

test("another zone shows the library file that matches title, album, artist and length, worded like Lyrion's Format", async () => {
  const { resolve, calls } = harness();
  assert.deepEqual(await resolve("z-Marantz AV10"), { format: "FLAC · 44.1 kHz / 16-bit · 785 kbps VBR", from: "library" });
  assert.deepEqual(calls.lms, ["Eye in the Sky"]);
  assert.equal(calls.tidal.length, 0);
});

test("Roon's own titles and album names still match the file when brackets differ and the length agrees", async () => {
  const sorrow = zone("HQP-WIN11", "Sorrow [Live at the Circus Maximus]");
  sorrow.now_playing = { length: 655, three_line: { line1: "Sorrow [Live at the Circus Maximus]", line2: "David Gilmour", line3: "Live at the Circus Maximus" } };
  const trains = zone("Marantz AV10", "Trains");
  trains.now_playing = { length: 360, three_line: { line1: "Trains", line2: "Porcupine Tree", line3: "In Absentia" } };
  const rows = [
    { title: "Sorrow", artist: "David Gilmour", album: "Live From The Circus Maximus", duration: 655.196, bitrate: "", samplerate: "96000", samplesize: "16", type: "flc" },
    { title: "Trains  (CLOSURE/CONTINUATION.LIVE)", artist: "Steven Wilson", album: "CLOSURE / CONTINUATION. LIVE.", duration: 480.51, samplerate: "96000", samplesize: "24", type: "flc" },
    { title: "Trains  (Remastered)", artist: "Porcupine Tree", album: "In Absentia  (Remastered)", duration: 360.323, bitrate: "", samplerate: "44100", samplesize: "24", type: "flc" }
  ];
  const { resolve, calls } = harness({ zones: [sorrow, trains], rows });
  assert.deepEqual(await resolve("z-HQP-WIN11"), { format: "FLAC · 96 kHz / 16-bit", from: "library" });
  assert.deepEqual(await resolve("z-Marantz AV10"), { format: "FLAC · 44.1 kHz / 24-bit", from: "library" });
  assert.deepEqual(calls.lms, ["Sorrow", "Trains"]);
});

test("library copies by another artist or of another length are not matches", async () => {
  const rows = [{ ...lmsRows[2], artist: "Someone Else" }, { ...lmsRows[2], duration: 278.5 }];
  assert.deepEqual(await harness({ rows }).resolve("z-Marantz AV10"), { format: "FLAC · HiRes Lossless", from: "tidal" });
});

test("a copy on the same album wins over a same-length copy on a compilation", async () => {
  const rows = [lmsRows[2], { ...lmsRows[2], album: "The Best Of", samplerate: "96000", samplesize: "24" }];
  assert.equal((await harness({ rows }).resolve("z-Marantz AV10")).format, "FLAC · 44.1 kHz / 16-bit · 785 kbps VBR");
});

test("library copies that disagree on format are unknown, so TIDAL's catalogue answer is used and labelled as such", async () => {
  const rows = [lmsRows[2], { ...lmsRows[2], samplerate: "96000", samplesize: "24" }];
  assert.deepEqual(await harness({ rows }).resolve("z-Marantz AV10"), { format: "FLAC · HiRes Lossless", from: "tidal" });
});

test("TIDAL's Lossless tier is FLAC 44.1 kHz / 16-bit, and Atmos-only or unmatched answers show nothing", async () => {
  const format = async tidal => (await harness({ rows: [], tidal }).resolve("z-Marantz AV10")).format;
  assert.equal(await format({ ...tidalAnswer, mediaTags: ["LOSSLESS"] }), "FLAC · 44.1 kHz / 16-bit");
  assert.equal(await format({ ...tidalAnswer, mediaTags: ["DOLBY_ATMOS"], quality: "Dolby Atmos" }), null);
  assert.equal(await format({ ...tidalAnswer, track: null }), null);
});

test("a zone that is not playing a track, or is unknown, shows nothing", async () => {
  const idle = { ...zone("WiiM"), now_playing: null };
  const { resolve, calls } = harness({ zones: [idle] });
  assert.deepEqual(await resolve("z-WiiM"), { format: null, from: null });
  assert.deepEqual(await resolve("constructor"), { format: null, from: null });
  assert.equal(calls.lms.length + calls.tidal.length + calls.hqp.length, 0);
});

test("a resolved track is cached, but a failed library or TIDAL lookup is asked again", async () => {
  const ok = harness();
  await ok.resolve("z-Marantz AV10"); await ok.resolve("z-Marantz AV10");
  assert.equal(ok.calls.lms.length, 1);

  const lmsDown = harness({ rows: new Error("LMS down") });
  await lmsDown.resolve("z-Marantz AV10"); await lmsDown.resolve("z-Marantz AV10");
  assert.equal(lmsDown.calls.lms.length, 2);

  const tidalDown = harness({ rows: [], tidal: new Error("TIDAL down") });
  assert.deepEqual(await tidalDown.resolve("z-Marantz AV10"), { format: null, from: null });
  await tidalDown.resolve("z-Marantz AV10");
  assert.equal(tidalDown.calls.tidal.length, 2);
});

test("an HQPlayer zone whose HQPlayer has no input falls back to the library", async () => {
  assert.deepEqual(await harness({ source: null }).resolve("z-HQPd"), { format: "FLAC · 44.1 kHz / 16-bit · 785 kbps VBR", from: "library" });
});

test("the server serves the resolver by zone id with the HQPlayer zone map, LMS titles search and TIDAL lookup", () => {
  const server = read("src/server.js");
  assert.match(server, /pathname === "\/api\/roon\/source-format"\) \{\s*return sendJson\(res, 200, await roonSourceFormat\(url\.searchParams\.get\("zone_id"\)\)\);/);
  assert.match(server, /createRoonSourceFormat\(\{ getZone: \(id\) => roon\.zones\.get\(id\), hqplayerZones: roonHqplayerZones, control: roonHqplayerControl,\s*lyrionTitles: lyrionTitleSearch\(lyrionApi\.client\), tidalQuality: resolveCurrentTrackQuality \}\)/);
});

const app = read("public/app.js");
const fn = name => {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  return app.slice(start, app.indexOf("\n}\n", start) + 2);
};

test("Roon's Now Playing details show a Format row after Genre, with where the value came from", () => {
  const context = {
    escapeHtml: v => String(v), formatTrackDuration: () => "4:36", releaseYearForTrack: () => 1982, releaseDateForTrack: () => "", metadataLabelForTrack: () => "Arista",
    beatportGenreFieldsForTrack: () => ({}), normalizeMatchText: v => v, metadataGenreForTrack: () => "Rock", metadataTagBadgesForTrack: () => []
  };
  const start = app.indexOf("const NOW_FORMAT_NOTES");
  vm.runInNewContext(app.slice(start, app.indexOf("\n", start)) + "\n" + fn("nowSourceQualityHtml") + "\nthis.html = nowSourceQualityHtml;", context);
  const html = context.html(null, {}, { text: "FLAC · 44.1 kHz / 16-bit · 785 kbps VBR", from: "library" });
  const labels = [...html.matchAll(/sourceLabel">([^<]+)/g)].map(m => m[1]);
  assert.deepEqual(labels, ["Track length", "Released", "Label", "Genre", "Format"]);
  assert.match(html, /sourceValue">FLAC · 44\.1 kHz \/ 16-bit · 785 kbps VBR <span class="sourceNote">Library file<\/span>/);
  assert.doesNotMatch(context.html(null, {}, { text: "", from: "" }), /Format/);
});

test("the Format is fetched once per zone, track and play state, and a late answer for an old track is dropped", () => {
  const body = fn("updateNowFormat");
  assert.match(body, /\[zone\.zone_id, trackKey, zone\.state === "playing"\]\.join\("\|"\)/);
  assert.match(body, /if \(key === state\.nowFormat\.key\) return;/);
  assert.match(body, /\/api\/roon\/source-format\?zone_id=\$\{encodeURIComponent\(zone\.zone_id\)\}/);
  assert.match(body, /if \(state\.nowFormat\.key !== key \|\| !result\?\.format\) return;/);
  assert.match(app, /updateNowFormat\(zone, state\.nowTrack \|\| nowPlayingTrack\(zone\)\);\n  updateNowSourceQuality\(/);
});
