const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCsv, buildM3u, safeM3uFileName, trackUrl } = require("../src/m3u");

test("M3U export preserves TIDAL track order and readable metadata", () => {
  const content = buildM3u({
    title: "My / Deep House",
    tracks: [
      { artist: "Artist One", title: "First", durationMs: 201000, tidal: { id: "123" } },
      { artist: "Artist Two", title: "Second", tidalUrl: "https://listen.tidal.com/track/456" },
      { artist: "Missing", title: "No identity" }
    ]
  });

  assert.match(content, /^#EXTM3U\r\n#PLAYLIST:My \/ Deep House\r\n/);
  assert.match(content, /#EXTINF:201,Artist One - First\r\nhttps:\/\/listen\.tidal\.com\/track\/123/);
  assert.match(content, /#EXTINF:-1,Artist Two - Second\r\nhttps:\/\/listen\.tidal\.com\/track\/456/);
  assert.doesNotMatch(content, /Missing/);
});

test("M3U helpers create safe filenames and recover a TIDAL URL from an id", () => {
  assert.equal(safeM3uFileName("My: Mix / 2026?"), "My- Mix - 2026.m3u");
  assert.equal(trackUrl({ tidal: { id: "987" } }), "https://listen.tidal.com/track/987");
});

test("CSV export gives ChatGPT a structured recommendation list", () => {
  const content = buildCsv({
    title: "Satisfaction",
    tracks: [
      { artist: "Benny Benassi", title: "Satisfaction", album: "Hypnotica", durationMs: 225000, tidal: { id: "321" } }
    ]
  });
  assert.match(content, /"playlist","Satisfaction"/);
  assert.match(content, /"track_number","artist","title","album","duration_seconds","tidal_url"/);
  assert.match(content, /"1","Benny Benassi","Satisfaction","Hypnotica","225","https:\/\/listen\.tidal\.com\/track\/321"/);
});
