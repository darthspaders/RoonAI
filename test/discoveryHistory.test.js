"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DiscoveryHistory } = require("../src/discoveryHistory");

function tempHistoryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-history-"));
  return path.join(dir, "history.json");
}

test("discovery history matches old URL entries by TIDAL id and artist/title aliases", () => {
  const file = tempHistoryFile();
  fs.writeFileSync(file, JSON.stringify({
    entries: [{
      key: "https://tidal.com/browse/track/12345",
      artist: "Guy J",
      title: "Nirvana",
      tidalUrl: "https://tidal.com/browse/track/12345",
      firstShownAt: 1000,
      lastShownAt: 1000,
      shownCount: 1
    }]
  }));

  const history = new DiscoveryHistory({ file });

  assert.ok(history.entryFor({ artist: "Guy J", title: "Nirvana" }));
  assert.ok(history.entryFor({ artist: "Guy J", title: "Nirvana", tidal: { id: "12345" } }));
  assert.ok(history.entryFor({ artist: "Guy J", title: "Nirvana", id: "12345" }));
});

test("discovery history merges future records for the same track identity", () => {
  const history = new DiscoveryHistory({ file: tempHistoryFile() });

  history.record([{
    artist: "Kamilo Sanclemente",
    title: "Smoke Machine",
    tidalUrl: "https://tidal.com/browse/track/998877"
  }], 1000);
  history.record([{
    artist: "Kamilo Sanclemente",
    title: "Smoke Machine",
    tidal: { id: "998877" }
  }], 2000);

  const entries = history.fallbackCandidates({ limit: 10 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].shownCount, 2);
  assert.ok(history.entryFor({ artist: "Kamilo Sanclemente", title: "Smoke Machine" }));
});

test("discovery history exposes label and source recency stats", () => {
  const history = new DiscoveryHistory({ file: tempHistoryFile() });

  history.record([{
    artist: "Branch Artist One",
    title: "First Branch",
    label: "Small Room",
    discoverySource: "Branch source search",
    discoveryLane: "branch",
    tidalUrl: "https://tidal.com/browse/track/101"
  }], 1000);
  history.record([{
    artist: "Branch Artist Two",
    title: "Second Branch",
    label: "Small Room",
    discoverySource: "Branch source search",
    discoveryLane: "branch",
    tidalUrl: "https://tidal.com/browse/track/102"
  }], 2000);

  const label = history.labelExposureFor({ label: "Small Room" }, 3000);
  const source = history.sourceExposureFor({
    discoverySource: "Branch source search",
    discoveryLane: "branch"
  }, 3000);

  assert.equal(label.trackCount, 2);
  assert.equal(label.shownCount, 2);
  assert.equal(label.recent, true);
  assert.equal(source.trackCount, 2);
  assert.equal(source.source, "Branch source search / branch");
  assert.equal(source.recent, true);
});
