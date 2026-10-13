"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
function section(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, "production renderer section is present");
  return source.slice(start, end);
}
const escapeHtml = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function fixture() {
  const nodes = new Map(), playbackEvents = [], artworkCalls = [], forbidden = [], recoveries = [];
  function node(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    let html = "", text = "";
    const value = { htmlWrites: 0, textWrites: 0, childToken: null, hidden: false, disabled: false, value: "", title: "", dataset: {},
      classList: { toggle() {}, remove() {} }, style: { setProperty() {} },
      dispatchEvent: event => playbackEvents.push(event), querySelectorAll: () => [] };
    Object.defineProperties(value, {
      innerHTML: { get: () => html, set: next => {
        value.htmlWrites++; html = String(next).replace(/='([^']*)'/g, '="$1"'); text = html.replace(/<[^>]*>/g, ""); value.childToken = {};
      } },
      textContent: { get: () => text, set: next => { value.textWrites++; text = String(next); html = escapeHtml(text); value.childToken = {}; } }
    });
    nodes.set(selector, value); return value;
  }
  const state = { zones: [], selectedZoneId: "exact-zone", nowTrack: null, isSeeking: false, tidalPlaylistsLoaded: true };
  const context = { state, $: node, lastRabbitStatusAt: 0, rabbitRecoveryTimer: null, queueActionState: {},
    document: { querySelector: selector => selector === "#playerView .player" ? node(selector) : null },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    Date: { now: () => 123456 }, clearTimeout() {},
    activeZone: () => state.zones.find(zone => zone.zone_id === state.selectedZoneId) || state.zones[0],
    zonePlaybackPlaying: zone => zone.state === "playing", currentZoneNowPlaying: zone => zone?.now_playing,
    summarizeNowPlaying: zone => zone?.now_playing, nowPlayingTrack: zone => zone?.now_playing,
    zoneDisplayLabel: zone => zone.zone_id, escapeHtml,
    normalizeMatchText: value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    isLiveRadioZone: zone => zone?.liveRadio === true,
    formatQueueInfo: () => "", formatSeconds: value => String(value), liveQueueHtml: () => "",
    artworkMetadataMatchesRoon: () => false, trustedRadioArtworkUrl: () => "",
    setCoverImage: (cover, candidates) => artworkCalls.push([...candidates]),
    setRabbitHolePanelOpen() {}, updateJumpTopVisibility() {}, renderSystemHealth() {}, renderNowTidalPlaylistControl() {}, cleanRenderedArtifacts() {},
    scheduleRabbitRecoveryRefresh: delay => recoveries.push(delay),
    findNowPlayingMatch: zone => ({ index: zone?.now_playing ? 0 : -1, track: zone?.now_playing || null, source: context.matchSource || "memory" }),
    normalizeFeedbackValue: value => value || "", feedbackButtonsHtml: () => "<button>Rate</button>",
    compactScoreBadgeHtml: track => track.score ? `<span class='score'>${escapeHtml(track.score)}</span>` : "",
    feedbackBadgeLabel: value => value, feedbackForTrack: () => "",
    api: url => { forbidden.push(url); throw Error("Unexpected playback request"); },
    fetch: url => { forbidden.push(url); throw Error("Unexpected media or network request"); },
    loadTidalPlaylists: () => { forbidden.push("load-playlists"); throw Error("Unexpected playlist load"); },
    loadRabbitHole: () => { forbidden.push("load-rabbit-hole"); throw Error("Unexpected discovery request"); } };
  node("#rabbitHolePanel").hidden = true;
  vm.runInNewContext(
    section("function normalizeKeyText(", "function trackFeedbackKeys(") +
    section("function formatTrackDuration(", "function playbackQualityInfoFromTrack(") +
    section("function nowPlayingBadgeHtml(", "function selectedTidalPlaylist(") +
    section("function updateNowDiscoveryTools(", "function setFeedbackButtonsActive(") +
    section("function renderState(", "const liveStatus = window.createRabbitStatusLive(") +
    "\nfunction updateNowSourceQuality(track) { renderNowSourceQuality(null, track); }", context);
  return { context, state, node, nodes, playbackEvents, artworkCalls, forbidden, recoveries,
    render: payload => context.renderState(payload),
    quality: track => context.renderNowSourceQuality(null, track),
    discover: zone => context.updateNowDiscoveryTools(zone) };
}
function payload(overrides = {}) {
  return { connected: true, core: { name: "Exact Core" }, zones: [{ zone_id: "exact-zone", state: "playing", display_name: "HQPlayer",
    outputs: [{ display_name: "HQPlayer" }], is_seek_allowed: true,
    now_playing: { tidalUrl: "https://tidal.com/browse/track/123", title: "Track", artist: "Artist", album: "Album", image_key: "art-one",
      length: 240, durationMs: 240000, seek_position: 12, genre: "Progressive House", metadataEnrichment: { beatport: { id: "exact-123", label: "Label", bpm: 123 } } } }], ...overrides };
}

test("unchanged Roon status retains visible metadata, badge and static text nodes while seek and playback events continue", () => {
  const h = fixture(), first = payload(); h.render(first);
  const selectors = ["#connection", "#nowTitle", "#nowSubtitle", "#playState", "#seekLength"];
  const staticWrites = selectors.map(selector => h.node(selector).textWrites);
  const sourceNode = h.node("#nowSourceFormat"), badge = h.node("#nowDiscoveryBadge"), sourceToken = sourceNode.childToken, badgeToken = badge.childToken;
  const sourceWrites = sourceNode.htmlWrites, badgeWrites = badge.htmlWrites, seekWrites = h.node("#seekPosition").textWrites;
  for (const position of [14, 16, 18]) { first.zones[0].now_playing.seek_position = position; h.render(first); }
  assert.deepEqual(selectors.map(selector => h.node(selector).textWrites), staticWrites);
  assert.equal(sourceNode.htmlWrites, sourceWrites); assert.equal(badge.htmlWrites, badgeWrites);
  assert.equal(sourceNode.childToken, sourceToken); assert.equal(badge.childToken, badgeToken);
  assert.equal(h.node("#seekPosition").textWrites, seekWrites + 3); assert.equal(h.node("#seekPosition").textContent, "18");
  assert.equal(h.node("#seekSlider").value, "18"); assert.equal(h.playbackEvents.length, 4);
  assert.ok(h.playbackEvents.every(event => event.type === "roon-playback" && event.detail.zoneId === "exact-zone"));
  assert.equal(h.state.nowTrack, first.zones[0].now_playing); assert.deepEqual(h.forbidden, []);
});

test("metadata enrichment on the same exact track renders every complete HTML change immediately", () => {
  const h = fixture(), current = payload(), track = current.zones[0].now_playing; h.render(current);
  const metadata = h.node("#nowSourceFormat"), initialWrites = metadata.htmlWrites;
  const changes = [
    () => { track.metadataEnrichment.beatport.label = "New Label"; },
    () => { track.metadataEnrichment.beatport.bpm = 127; },
    () => { track.metadataEnrichment.beatport.id = "exact-456"; },
    () => { track.metadataEnrichment.beatport.subGenre = "Melodic House & Techno"; },
    () => { track.metadataEnrichment.beatport.releaseDate = "2026-10-07"; },
    () => { track.durationMs = 300000; }
  ];
  changes.forEach((change, index) => { change(); h.render(current); assert.equal(metadata.htmlWrites, initialWrites + index + 1); });
  assert.match(metadata.innerHTML, /New Label/); assert.match(metadata.innerHTML, /127 BPM/); assert.match(metadata.innerHTML, /#exact-456/);
  assert.match(metadata.innerHTML, /Melodic House &amp; Techno/); assert.match(metadata.innerHTML, /2026-10-07/); assert.match(metadata.innerHTML, /5:00/);
  assert.equal(track.tidalUrl, "https://tidal.com/browse/track/123"); assert.equal(h.state.nowTrack, track); assert.deepEqual(h.forbidden, []);
});

test("badge score, feedback and source changes update without replacing identical rendered badges", () => {
  const h = fixture(), current = payload(), track = current.zones[0].now_playing, badge = h.node("#nowDiscoveryBadge"); h.render(current);
  assert.match(badge.innerHTML, /Remembered track/);
  const initial = badge.htmlWrites; h.context.matchSource = "queue"; h.render(current);
  assert.equal(badge.htmlWrites, initial + 1); assert.match(badge.innerHTML, /Unscored now playing/);
  track.feedback = "Love"; h.render(current); assert.match(badge.innerHTML, /Love/);
  track.score = 91; h.render(current); assert.match(badge.innerHTML, /91/);
  const stable = badge.childToken, writes = badge.htmlWrites; h.render(current);
  assert.equal(badge.htmlWrites, writes); assert.equal(badge.childToken, stable);
  track.score = 97; h.render(current); assert.equal(badge.htmlWrites, writes + 1); assert.match(badge.innerHTML, /97/);
  assert.equal(h.state.nowTrack, track); assert.deepEqual(h.forbidden, []);
});

test("browser HTML normalization does not cause repeated writes and another writer's reset is repaired", () => {
  const h = fixture(), node = h.node("#arbitrary");
  h.context.setNowPlayingHtmlIfChanged(node, "<span class='value'>Content</span>");
  assert.equal(node.innerHTML, '<span class="value">Content</span>'); const original = node.childToken;
  h.context.setNowPlayingHtmlIfChanged(node, "<span class='value'>Content</span>");
  assert.equal(node.htmlWrites, 1); assert.equal(node.childToken, original);
  node.innerHTML = ""; h.context.setNowPlayingHtmlIfChanged(node, "<span class='value'>Content</span>");
  assert.equal(node.htmlWrites, 3); assert.match(node.innerHTML, /Content/);
  const repaired = node.childToken; h.context.setNowPlayingHtmlIfChanged(node, "<span class='value'>Content</span>");
  assert.equal(node.htmlWrites, 3); assert.equal(node.childToken, repaired);
  node.innerHTML = "<em>Other writer</em>"; h.context.setNowPlayingHtmlIfChanged(node, "<span class='value'>Content</span>");
  assert.equal(node.htmlWrites, 5); assert.match(node.innerHTML, /Content/);
});

test("source and badge clears remain idempotent and a later matching track restores them", () => {
  const h = fixture(), current = payload(); h.render(current);
  const metadata = h.node("#nowSourceFormat"), badge = h.node("#nowDiscoveryBadge");
  h.quality(null); h.discover(null); assert.equal(metadata.hidden, true); assert.equal(metadata.innerHTML, ""); assert.equal(badge.innerHTML, "");
  const metadataWrites = metadata.htmlWrites, badgeWrites = badge.htmlWrites;
  h.quality(null); h.discover(null); assert.equal(metadata.htmlWrites, metadataWrites); assert.equal(badge.htmlWrites, badgeWrites);
  h.render(current); assert.equal(metadata.hidden, false); assert.match(metadata.innerHTML, /Label/); assert.match(badge.innerHTML, /Remembered track/);
  assert.deepEqual(h.forbidden, []);
});

test("connection, track, artwork, playback state and duration changes remain immediate without changing media ownership", () => {
  const h = fixture(), current = payload(), zone = current.zones[0]; h.render(current);
  current.core.name = "Replacement Core"; zone.now_playing.title = "Next Track"; zone.now_playing.artist = "New Artist";
  zone.now_playing.album = "New Album"; zone.now_playing.image_key = "art-two"; zone.now_playing.length = 300; zone.state = "paused"; h.render(current);
  assert.equal(h.node("#connection").textContent, "Connected to Replacement Core"); assert.equal(h.node("#nowTitle").textContent, "Next Track");
  assert.equal(h.node("#nowSubtitle").textContent, "New Artist - New Album"); assert.equal(h.node("#playState").textContent, "paused");
  assert.equal(h.node("#seekLength").textContent, "300"); assert.match(h.artworkCalls.at(-1)[0], /art-two/);
  assert.equal(h.playbackEvents.at(-1).detail.state, "paused");
  current.connected = false; h.render(current); assert.equal(h.node("#connection").textContent, "Roon reconnecting…");
  assert.equal(h.playbackEvents.at(-1).detail.connected, false);
  zone.liveRadio = true; h.render(current); assert.equal(h.node("#seekLength").textContent, "Live radio"); assert.equal(h.node("#seekSlider").disabled, true);
  current.zones = []; h.render(current); assert.equal(h.node("#connection").textContent, "Enable this extension in Roon Settings > Extensions");
  assert.equal(h.node("#nowTitle").textContent, "No active zone"); assert.equal(h.node("#playState").textContent, "stopped");
  assert.deepEqual(h.forbidden, []);
});
