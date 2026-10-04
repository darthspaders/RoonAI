"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BeatportClient, normalizeBeatportTrack } = require("../src/beatportClient");

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const found = Object.entries(headers).find(([key]) => key.toLowerCase() === String(name).toLowerCase());
        return found ? found[1] : null;
      }
    },
    arrayBuffer: async () => body
  };
}

test("Beatport normalization exposes the transient sample metadata", () => {
  const track = normalizeBeatportTrack({
    id: 30374303,
    name: "Dream On",
    mix_name: "Extended Mix",
    sample_url: "https://geo-samples.beatport.com/preview.mp3",
    sample_start_ms: 180000,
    sample_end_ms: 300000
  });

  assert.equal(track.previewUrl, "https://geo-samples.beatport.com/preview.mp3");
  assert.equal(track.previewStartMs, 180000);
  assert.equal(track.previewEndMs, 300000);
  assert.equal(track.previewDurationMs, 120000);
});

test("Beatport preview fetch returns bytes without persisting an audio file", async () => {
  const audio = Buffer.from("temporary-preview-audio");
  let requestedUrl = "";
  const client = new BeatportClient({
    enabled: true,
    accessToken: "test-token",
    tokenFile: "",
    requestsPerSecond: 100,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response(200, audio, { "content-type": "audio/mpeg", "content-length": String(audio.length) });
    },
    logger: null
  });
  const result = await client.fetchPreviewBuffer({
    id: "30374303",
    title: "Dream On",
    mixName: "Extended Mix",
    previewUrl: "https://geo-samples.beatport.com/preview.mp3"
  });

  assert.equal(requestedUrl, "https://geo-samples.beatport.com/preview.mp3");
  assert.deepEqual(result.buffer, audio);
  assert.equal(result.bytes, audio.length);
  assert.equal(result.contentType, "audio/mpeg");
  result.buffer.fill(0);
  assert.equal(result.buffer.every((value) => value === 0), true);
});
