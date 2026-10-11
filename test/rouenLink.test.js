"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { LyrionClient } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");

async function playbackLinks(config) {
  const sent = [];
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.rpc = async () => { throw new Error("Lyrion is not needed for playback links"); };
  const api = createLyrionApi({ roon: { getState: () => ({ zones: [] }) }, client, file: "does-not-exist", readJson: async () => ({}),
    sendJson: (res, status, body) => sent.push([status, body]), playbackLinks: config });
  await api.handle({ method: "GET" }, {}, new URL("http://rh.example/api/lyrion/playback-links"));
  return sent.at(-1);
}

test("the playback links name Rouen at its configured address, without needing a Lyrion player", async () => {
  assert.deepEqual(await playbackLinks({ rouenUrl: "http://192.168.60.18:3399" }), [200, { links: [{ id: "rouen", label: "Rouen", url: "http://192.168.60.18:3399/" }] }]);
});

test("an unset, malformed or non-web Rouen address adds no link", async () => {
  for (const rouenUrl of [undefined, "", "192.168.60.18:3399", "javascript:alert(1)", "ftp://192.168.60.18/"]) {
    assert.deepEqual(await playbackLinks({ rouenUrl }), [200, { links: [] }], String(rouenUrl));
  }
});

test("ROUEN_URL sets the Rouen address and the server hands it to the Lyrion API", () => {
  const before = process.env.ROUEN_URL;
  process.env.ROUEN_URL = "http://192.168.60.18:3399";
  delete require.cache[require.resolve("../src/config")];
  try {
    assert.equal(require("../src/config").playbackLinks.rouenUrl, "http://192.168.60.18:3399");
  } finally {
    if (before === undefined) delete process.env.ROUEN_URL; else process.env.ROUEN_URL = before;
    delete require.cache[require.resolve("../src/config")];
  }
  assert.match(fs.readFileSync(require.resolve("../src/server.js"), "utf8"), /createLyrionApi\(\{[^}]*playbackLinks: config\.playbackLinks/);
  assert.match(fs.readFileSync(require.resolve("../.env.example"), "utf8"), /\nROUEN_URL=\n/);
});

const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
function element(tag) {
  return { tagName: tag, children: [], hidden: false, textContent: "", replaceChildren(...n) { this.children = n; } };
}

test("Rouen opens in a new tab from the Playback System row, and the link hides when it is not set", () => {
  const list = element("span");
  const context = { $: id => ({ playbackSystemLinks: list })[id], document: { createElement: element } };
  vm.runInNewContext(source.slice(source.indexOf("  function renderPlaybackLinks("), source.indexOf("  async function loadPlaybackLinks(")), context);
  context.renderPlaybackLinks([{ id: "rouen", label: "Rouen", url: "http://192.168.60.18:3399/" }]);
  assert.equal(list.hidden, false);
  assert.deepEqual(list.children.map(a => [a.tagName, a.textContent, a.href, a.target, a.rel]), [["a", "Rouen ↗", "http://192.168.60.18:3399/", "_blank", "noopener noreferrer"]]);
  context.renderPlaybackLinks([]);
  assert.equal(list.hidden, true);
});

test("the Rouen link sits after the Roon and Lyrion choices, loads with the page and looks like the HQPlayer links", () => {
  assert.match(source, /<\/select><span id="playbackSystemLinks" class="lyrionChoices" hidden><\/span><span id="playbackSystemHint"/);
  assert.match(source, /fetch\("\/api\/lyrion\/playback-links",\{cache:"no-store"\}\)/);
  assert.match(source, /void loadPlaybackLinks\(\);/);
  const css = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
  assert.match(css, /\n:is\(\.hqplayerLinksBar,#playbackSystemLinks\) a \{display:inline-flex;/);
  assert.match(css, /\n:is\(\.hqplayerLinksBar,#playbackSystemLinks\) a:is\(:hover,:focus-visible\) \{/);
  assert.match(css, /\n#playbackSystemLinks\[hidden\] \{display:none;\}/);
});

test("Rouen sits right after Lyrion, and the hint stays at the far end of the row on wide screens", () => {
  const css = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
  assert.match(css, /\n\.playbackSystemBar \.lyrionChoices \{flex:0 1 auto;\}/);
  assert.match(css, /\n#playbackSystemHint \{margin-left:auto;\}/);
  assert.match(css, /@media\(max-width:600px\)\{#playbackSystemHint\{margin-left:0;\}\}/);
});
