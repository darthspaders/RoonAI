"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.join(__dirname, "..", "public");
const appScript = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
const remoteScript = fs.readFileSync(path.join(publicDir, "remote.js"), "utf8");

test("Rabbit Hole ratings remote is isolated from the main browser interface", () => {
  const html = fs.readFileSync(path.join(publicDir, "remote.html"), "utf8");
  const script = fs.readFileSync(path.join(publicDir, "remote.js"), "utf8");
  const styles = fs.readFileSync(path.join(publicDir, "remote.css"), "utf8");

  assert.match(html, /remote\.css/);
  assert.match(html, /remote\.js/);
  assert.match(html, /Rabbit Hole Ratings Remote/);
  assert.doesNotMatch(html, /Rattling Remote/);
  assert.doesNotMatch(html, /rabbitRemoteHeader/);
  assert.doesNotMatch(html, /styles\.css/);
  assert.doesNotMatch(html, /app\.js/);
  assert.doesNotMatch(html, /zoneSelect|<select/i);
  assert.match(html, /remoteBadge/);
  assert.match(html, /remoteArtwork/);
  assert.match(html, /remoteMetadata/);
  assert.match(html, /remoteRatingSheet/);

  assert.match(script, /\/api\/events/);
  assert.match(script, /\/api\/status/);
  assert.match(script, /\/api\/feedback/);
  assert.match(script, /\/api\/control/);
  assert.doesNotMatch(script, /zoneSelect/);
  assert.match(styles, /\.rabbitRemotePage/);
  assert.match(styles, /\.rabbitRemoteRatingSheet/);
});

test("live Roon artwork stays ahead of ambiguous catalog artwork", () => {
  assert.match(appScript, /const coverCandidates = now\?\.radio_lookup[\s\S]*roonCoverUrl,[\s\S]*metadataSourceCoverUrl/);
  assert.match(remoteScript, /const candidates = now\.radio_lookup[\s\S]*roonImageUrl,[\s\S]*metadata\.sourceImageUrl/);
  assert.match(appScript, /function artworkMetadataMatchesRoon[\s\S]*const toleranceMs = Math\.max\(30000, roonLengthMs \* 0\.12\)/);
  assert.match(remoteScript, /function artworkMetadataMatchesRoon[\s\S]*const toleranceMs = Math\.max\(30000, roonLengthMs \* 0\.12\)/);
});
