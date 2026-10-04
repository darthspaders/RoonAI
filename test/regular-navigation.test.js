const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("regular navigation groups Playback, Discover, and Memory views and keeps settings controls in System > Settings", () => {
  const primaryNav = html.match(/<nav class="viewTabs primaryNav"[\s\S]*?<\/nav>/)?.[0] || "";
  const topbar = html.match(/<section class="topbar">[\s\S]*?<\/section>/)?.[0] || "";
  const primaryGroups = [...primaryNav.matchAll(/data-nav-group="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(primaryGroups, ["playback", "discover", "tidalLibrary", "memory", "system"]);
  assert.doesNotMatch(topbar, /aiModeSelect|synapseModelInput|zoneSelect/);
  assert.doesNotMatch(html, /class="topChrome"/);
  assert.doesNotMatch(html, /class="brandBanner"/);
  assert.match(html, /id="settingsView" class="view settingsView"[\s\S]*?id="aiModeSelect"/);
  assert.match(html, /data-nav-item="settings" data-view="settings"/);
  assert.equal((html.match(/id="aiModeSelect"/g) || []).length, 1);
  assert.equal((html.match(/id="synapseModelInput"/g) || []).length, 1);
  assert.equal((html.match(/id="zoneSelect"/g) || []).length, 1);

  for (const group of primaryGroups) {
    assert.match(html, new RegExp(`id="secondary${group[0].toUpperCase()}${group.slice(1)}"`));
  }

  assert.match(html, /data-nav-item="queue" data-view="queue"/);
  assert.doesNotMatch(html, /data-nav-item="queue" data-view="queue" data-temporary-target/);
  const queueViewStart = html.indexOf('<section id="queueView" class="view queueView">');
  const queueElement = html.indexOf('id="liveQueue"');
  const discoverViewStart = html.indexOf('<section id="discoverView" class="view discoverView">');
  const playlistForm = html.indexOf('id="playlistForm"');
  const resultsPanel = html.indexOf('class="panel results"');
  const standbyViewStart = html.indexOf('<section id="standbyView" class="view standbyView">');
  const standbyPanel = html.indexOf('class="panel standbyPanel"');
  const playerViewStart = html.indexOf('<section id="playerView" class="view isActive">');
  assert.ok(queueViewStart >= 0 && queueElement > queueViewStart && queueElement < playerViewStart);
  assert.match(html, /data-nav-item="rabbit-hole" data-view="discover"/);
  assert.match(html, /data-nav-item="standby" data-view="standby"/);
  assert.match(html, /data-nav-group="tidalLibrary" aria-controls="secondaryTidalLibrary"/);
  assert.match(html, /data-nav-item="collections" data-view="tidalLibrary"/);
  assert.match(html, /id="tidalLibraryView" class="view tidalLibraryView"/);
  assert.match(html, /data-nav-item="library" data-view="musicMemory"/);
  assert.match(html, /data-nav-item="taste" data-view="history"/);
  assert.match(html, /data-nav-item="synapse-memory" data-view="memory"/);
  assert.ok(playerViewStart >= 0 && discoverViewStart > playerViewStart && playlistForm > discoverViewStart && resultsPanel > playlistForm && standbyViewStart > resultsPanel && standbyPanel > standbyViewStart);
  assert.match(html, /id="historyView" class="view memorySurface" data-memory-item="taste"/);
  assert.match(html, /id="musicMemoryView" class="view memorySurface" data-memory-item="library"/);
  assert.match(html, /<p class="eyebrow">Taste Profile<\/p>/);
  assert.match(html, /<p class="eyebrow">Library<\/p>/);
  assert.match(html, /data-nav-item="connections" data-view="connections"/);
  assert.match(html, /data-nav-item="ai" data-view="ai"/);
  assert.match(html, /data-nav-item="diagnostics" data-view="diagnostics"/);
  assert.doesNotMatch(html, /data-nav-item="(?:connections|ai|diagnostics)" data-temporary-target/);
  const connectionsViewStart = html.indexOf('<section id="connectionsView" class="view systemView connectionsView"');
  const aiViewStart = html.indexOf('<section id="aiView" class="view systemView aiView"');
  const diagnosticsViewStart = html.indexOf('<section id="diagnosticsView" class="view systemView diagnosticsView"');
  const settingsViewStart = html.indexOf('<section id="settingsView" class="view settingsView"');
  const systemHealth = html.indexOf('id="systemHealth"');
  const poolDiagnostics = html.indexOf('id="poolDiagnostics"');
  const intentDebug = html.indexOf('id="intentDebug"');
  const sourceReport = html.indexOf('id="sourceReport"');
  const rejectedDebug = html.indexOf('id="rejectedDebug"');
  assert.ok(connectionsViewStart >= 0 && aiViewStart > connectionsViewStart && diagnosticsViewStart > aiViewStart && settingsViewStart > diagnosticsViewStart);
  assert.ok(systemHealth > diagnosticsViewStart && systemHealth < settingsViewStart);
  assert.ok(poolDiagnostics > diagnosticsViewStart && poolDiagnostics < settingsViewStart && intentDebug > diagnosticsViewStart && intentDebug < settingsViewStart && sourceReport > diagnosticsViewStart && sourceReport < settingsViewStart && rejectedDebug > diagnosticsViewStart && rejectedDebug < settingsViewStart);
  assert.ok(resultsPanel > poolDiagnostics && resultsPanel > intentDebug && resultsPanel > sourceReport && resultsPanel > rejectedDebug);
  assert.match(app, /function setNavigationState\(/);
  assert.match(app, /setActiveView\(button\.dataset\.view, \{/);
  assert.match(app, /queue: \{ group: "playback", item: "queue" \}/);
  assert.match(app, /discover: \{ group: "discover", item: "rabbit-hole" \}/);
  assert.match(app, /tidalLibrary: \{ group: "tidalLibrary", item: "collections" \}/);
  assert.match(app, /sonicReview: \{ group: "discover", item: "sonic-review" \}/);
  assert.match(app, /standby: \{ group: "discover", item: "standby" \}/);
  assert.match(app, /connections: \{ group: "system", item: "connections" \}/);
  assert.match(app, /ai: \{ group: "system", item: "ai" \}/);
  assert.match(app, /diagnostics: \{ group: "system", item: "diagnostics" \}/);
  assert.match(app, /discover: "discover"/);
  assert.match(app, /system: "connections"/);
  const routedViews = JSON.parse(app.match(/\((\["history"[^\]]+\])\.includes\(view\)/)[1]);
  for (const view of ["history", "musicMemory", "database", "beatportCharts", "radio", "playlists", "tidal", "tidalLibrary", "sonicReview", "settings", "connections", "ai", "diagnostics", "queue", "discover", "standby"]) {
    assert.ok(routedViews.includes(view), `${view} must be reachable`);
  }
  assert.match(app, /#queueView/);
  assert.match(app, /#discoverView/);
  assert.match(app, /#standbyView/);
  assert.match(app, /#sonicReviewView/);
  assert.match(app, /#connectionsView/);
  assert.match(app, /#aiView/);
  assert.match(app, /#diagnosticsView/);
  assert.match(app, /setActiveView\("discover", \{ group: "discover", item: "rabbit-hole" \}\)/);
  assert.match(app, /settingsView/);
  assert.match(app, /querySelector\("\.appHeader"\)/);
  assert.match(html, /data-nav-item="sonic-review" data-view="sonicReview"/);
  assert.match(html, /id="sonicReviewView" class="view sonicReviewView"/);
  assert.match(html, /id="sonicReviewView"/);
  assert.match(app, /function sonicProfileEditorHtml\(/);
  assert.match(app, /function captureSonicReviewDraft\(/);
  assert.match(app, /function restoreSonicReviewDraft\(/);
  assert.match(app, /state\.sonicReview\.formDirty = true/);
  assert.doesNotMatch(app, /function sonicReviewStandbyTracks\(/);
  assert.doesNotMatch(app, /data-sonic-review-standby-index/);
  assert.match(app, /function sonicReviewGenreFields\(/);
  assert.match(app, /Available Genre\/Subgenre metadata is prefilled below/);
  assert.match(app, /metadataEnrichment: localTrack\.metadataEnrichment \|\| fallback\.metadataEnrichment \|\| null/);
  assert.match(app, /queuePolicy: "strict"/);
  assert.match(app, /strict TIDAL and Roon verification/);
});

test("Synapse Memory keeps its existing route and identifies its Memory destination", () => {
  const memoryHtml = fs.readFileSync(path.join(root, "public", "memory.html"), "utf8");
  assert.match(memoryHtml, /<main data-memory-item="synapse-memory">/);
  assert.match(memoryHtml, /<script src="\/memory\.js"><\/script>/);
});

test("Settings exposes the safe Sonic production mode selector", () => {
  const settings = html.match(/<section id="settingsView"[\s\S]*?<\/section>\s*<\/section>/)?.[0] || "";
  assert.match(settings, /id="sonicProductionModeSelect"/);
  assert.match(settings, /option value="off"/);
  assert.match(settings, /option value="observe"/);
  assert.match(settings, /option value="blend"/);
  assert.match(settings, /aria-describedby="sonicProductionHelp"/);
  assert.match(app, /\/api\/recommendation-v2\/production-mode/);
  assert.match(app, /Observe only · ordering preserved/);
  assert.match(app, /function updateSonicProductionMode\(/);
});
