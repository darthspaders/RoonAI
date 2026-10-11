"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { LyrionClient } = require("../src/lyrionClient");
const { createLyrionApi } = require("../src/lyrionApi");

function lms({ players = [{ playerid: "p1", name: "HQPlayer (HQPlayerEmbedded)", connected: 1, model: "hqplayer", ip: "127.0.0.1:0" }], addresses = "192.168.60.76", down = false } = {}) {
  const client = new LyrionClient({ baseUrl: "http://lms.example:9000" });
  client.rpc = async (player, command) => {
    if (down) throw new Error("Lyrion returned HTTP 502");
    return command[0] === "serverstatus" ? { players_loop: players } : command[0] === "pref" ? { _p2: addresses } : {};
  };
  return client;
}
async function links(client, config = {}) {
  const sent = [];
  const api = createLyrionApi({ roon: { getState: () => ({ zones: [] }) }, client, file: "does-not-exist", readJson: async () => ({}),
    sendJson: (res, status, body) => sent.push([status, body]), hqplayerLinks: config });
  await api.handle({ method: "GET" }, {}, new URL("http://rh.example/api/lyrion/hqplayer-links"));
  return sent.at(-1);
}

test("HQPlayer's web interface is found from the bridge plugin's address, and HQPTuner comes from its setting", async () => {
  assert.deepEqual(await links(lms(), { tunerUrl: "http://192.168.60.77:8090" }), [200, { links: [
    { id: "hqplayer", label: "Web Interface", url: "http://192.168.60.76:8088/" },
    { id: "hqptuner", label: "HQPTuner", url: "http://192.168.60.77:8090/" }] }]);
});

test("an explicit HQPlayer web URL wins over discovery, and only http or https links are offered", async () => {
  assert.deepEqual((await links(lms(), { webUrl: "https://hqp.example/", tunerUrl: "javascript:alert(1)" }))[1].links,
    [{ id: "hqplayer", label: "Web Interface", url: "https://hqp.example/" }]);
});

test("without a bridge, a usable address or a reachable LMS, only configured links appear", async () => {
  assert.deepEqual((await links(lms({ players: [{ playerid: "p2", name: "Den", connected: 1, model: "squeezelite", ip: "192.168.60.50:1" }] })))[1].links, []);
  assert.deepEqual((await links(lms({ addresses: null })))[1].links, []);
  assert.deepEqual((await links(lms({ down: true }), { tunerUrl: "http://192.168.60.77:8090" }))[1].links, [{ id: "hqptuner", label: "HQPTuner", url: "http://192.168.60.77:8090/" }]);
});

test("the links endpoint answers without a selected Lyrion player, so Roon mode can show it too", async () => {
  const [status] = await links(lms());
  assert.equal(status, 200);
});

test("two bridges on different HQPlayers are ambiguous, so no web link is guessed", async () => {
  const players = ["192.168.60.80:1", "192.168.60.81:1"].map((ip, i) => ({ playerid: `p${i}`, name: `HQ${i}`, connected: 1, model: "hqplayer", ip }));
  assert.deepEqual((await links(lms({ players, addresses: "" })))[1].links, []);
});

test("the settings are read from HQPLAYER_WEB_URL and HQPTUNER_URL and documented", () => {
  const config = fs.readFileSync(require.resolve("../src/config.js"), "utf8");
  assert.match(config, /webUrl: process\.env\.HQPLAYER_WEB_URL \|\| ""/);
  assert.match(config, /tunerUrl: process\.env\.HQPTUNER_URL \|\| ""/);
  const example = fs.readFileSync(require.resolve("../.env.example"), "utf8");
  assert.match(example, /^HQPLAYER_WEB_URL=$/m);
  assert.match(example, /^HQPTUNER_URL=$/m);
  assert.match(fs.readFileSync(require.resolve("../src/server.js"), "utf8"), /createLyrionApi\(\{[^}]*hqplayerLinks: config\.hqplayer/);
});

const source = fs.readFileSync(require.resolve("../public/lyrion.js"), "utf8");
function element(tag) {
  return { tagName: tag, children: [], attributes: {}, hidden: false, textContent: "", className: "",
    append(...n) { this.children.push(...n); }, replaceChildren(...n) { this.children = n; },
    setAttribute(k, v) { this.attributes[k] = String(v); } };
}
test("the HQPlayer row under Playback System opens each link in a new tab and hides when there are none", () => {
  const root = element("div"), list = element("span");
  const context = { $: id => ({ hqplayerLinks: root, hqplayerLinkList: list })[id], document: { createElement: element } };
  vm.runInNewContext(source.slice(source.indexOf("  function renderHqplayerLinks("), source.indexOf("  async function loadHqplayerLinks(")), context);
  context.renderHqplayerLinks([{ id: "hqplayer", label: "Web Interface", url: "http://192.168.60.76:8088/" }, { id: "hqptuner", label: "HQPTuner", url: "http://192.168.60.77:8090/" }]);
  assert.equal(root.hidden, false);
  assert.deepEqual(list.children.map(a => [a.tagName, a.textContent, a.href, a.target, a.rel]), [
    ["a", "Web Interface ↗", "http://192.168.60.76:8088/", "_blank", "noopener noreferrer"],
    ["a", "HQPTuner ↗", "http://192.168.60.77:8090/", "_blank", "noopener noreferrer"]]);
  context.renderHqplayerLinks([]);
  assert.equal(root.hidden, true);
});

test("the HQPlayer row sits right under the Playback System bar and loads with the page", () => {
  assert.match(source, /bar\.after\(hqplayerRow\);/);
  assert.match(source, /<span class="hqplayerLinksLabel">HQPlayer<\/span><span id="hqplayerLinkList" class="lyrionChoices"><\/span>/);
  assert.match(source, /void loadHqplayerLinks\(\);/);
});

test("the HQPlayer links look like unselected pills and the Playback System, HQPlayer and Lyrion Player labels share one size", () => {
  const css = fs.readFileSync(require.resolve("../public/lyrion.css"), "utf8");
  const rule = selector => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"))?.[1] || "";
  assert.match(rule(".hqplayerLinksBar a"), /border:1px solid rgba\(217,179,255,\.14\);/);
  assert.doesNotMatch(rule(".hqplayerLinksBar a"), /var\(--line\)/);
  assert.match(rule('.playbackSystemBar label,.hqplayerLinksLabel,#lyrionView label[for="lyrionPlayer"]'), /font-size:16px;/);
  assert.doesNotMatch(rule(".hqplayerLinksLabel"), /font-size/);
});
