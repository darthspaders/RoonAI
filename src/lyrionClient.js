"use strict";
const crypto = require("node:crypto");
const {LyrionItems,soundcloudUrn}=require("./lyrionItems");

function sourceFor(url = "") {
  if (/^(file:|\/)/i.test(url)) return "Local";
  if (require('./siriusxmPlaybackClock').channelId(url)) return "SiriusXM";
  if (/tidal/i.test(url)) return "TIDAL";
  if (/soundcloud|squeezecloud/i.test(url)) return "SoundCloud";
  return "Radio / stream";
}
function resolveAction(item, base, name) {
  const alias = item[`${name}Action`] || name;
  if (alias !== name) return null; // A browse alias must never become a playback command.
  const actions = item.actions || {};
  const action = Object.hasOwn(actions, name) ? actions[name] : base?.actions?.[name];
  if (!action || !Array.isArray(action.cmd)) return null;
  const itemParams = action.itemsParams ? (item[action.itemsParams] || actions[action.itemsParams]) : {};
  if (action.itemsParams && !itemParams) return null;
  return { cmd: action.cmd, params: { ...action.params, ...itemParams } };
}
const LIBRARY_SOURCES = [
  { id: "local", title: "Local Library / NAS" },
  { id: "local-albums", title: "Local Library: Albums", mode: "albums" },
  { id: "local-artists", title: "Local Library: Artists", mode: "artists" }
];
const LIBRARY_IDS = new Set(LIBRARY_SOURCES.map(s => s.id));
class LyrionClient {
  constructor({ baseUrl = process.env.LYRION_URL || "http://127.0.0.1:9000", fetchImpl = fetch, itemsFile } = {}) {
    this.baseUrl = new URL(baseUrl).origin;
    this.fetch = fetchImpl;
    this.actions = new Map();
    this.items = new LyrionItems(itemsFile);
  }
  async rpc(player, command) {
    const headers = { "Content-Type": "application/json" };
    if (process.env.LYRION_USERNAME) headers.Authorization = `Basic ${Buffer.from(`${process.env.LYRION_USERNAME}:${process.env.LYRION_PASSWORD || ""}`).toString("base64")}`;
    const response = await this.fetch(`${this.baseUrl}/jsonrpc.js`, { method: "POST", headers,
      body: JSON.stringify({ id: crypto.randomUUID(), method: "slim.request", params: [player || "", command] }),
      signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Lyrion returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`Lyrion: ${body.error.message || JSON.stringify(body.error)}`);
    if (!body.result || body.result.error) throw new Error(`Lyrion: ${body.result?.error || "Empty response"}`);
    return body.result;
  }
  async players() {
    const result = await this.rpc("", ["serverstatus", 0, 999]);
    return (result.players_loop || []).map(p => ({ id: p.playerid, name: p.name, connected: !!Number(p.connected), playing: !!Number(p.isplaying), model: p.model }));
  }
  async requirePlayer(id) {
    if (!(await this.players()).some(p => p.id === id && p.connected)) throw new Error("Choose a connected Lyrion player first.");
  }
  artwork(track) {
    const value = track.artwork_url || (track.coverid ? `/music/${encodeURIComponent(track.coverid)}/cover.jpg` : Number(track.coverart) && track.id ? `/music/${encodeURIComponent(track.id)}/cover.jpg` : "");
    if (!value) return "";
    if (value.startsWith("/api/lyrion/artwork?")) return value;
    const url = new URL(value, this.baseUrl);
    if (!/^https?:$/.test(url.protocol)) return "";
    const imagePath = url.origin === this.baseUrl ? url.pathname + url.search : `/imageproxy/${encodeURIComponent(url.href)}/image.png`;
    return `/api/lyrion/artwork?path=${encodeURIComponent(imagePath)}`;
  }
  track(t) {
    const episode=this.onDemandMetadata?.(t.url);
    if(episode)return {id:episode.id,title:episode.title,artist:episode.artist||episode.showTitle||"",album:episode.album||"SiriusXM on demand",duration:episode.duration,artwork:this.artwork({artwork_url:episode.artwork}),source:episode.source||"SiriusXM on demand",index:Number(t["playlist index"]),url:t.url};
    return { id: String(t.id || ""), title: t.title || t.track || "Untitled", artist: t.artist || "", album: t.album || "",
      duration: Number(t.duration) || 0, artwork: this.artwork(t), source: /siriusxm/i.test(`${t.album} ${t.artwork_url}`) ? "SiriusXM" : sourceFor(t.url), soundcloudUrn:soundcloudUrn(t.url), index: Number(t["playlist index"]), url: t.url || "" };
  }
  async status(player, offset = 0, limit = 100) {
    const s = await this.rpc(player, ["status", offset, limit, "tags:aljJKNuxd"]);
    const index = Number(s.playlist_cur_index || 0);
    let current = (s.playlist_loop || []).find(t => Number(t["playlist index"]) === index);
    if (!current && Number(s.playlist_tracks)) {
      const result = await this.rpc(player, ["status", "-", 1, "tags:aljJKNuxd"]);
      current = result.playlist_loop?.[0];
    }
    if (s.remoteMeta) current = { ...current, ...s.remoteMeta };
    return { playerId: player, playerName: s.player_name, connected: !!Number(s.player_connected),
      state: s.mode === "play" ? "playing" : s.mode === "pause" ? "paused" : "stopped",
      position: Number(s.time) || 0, duration: Number(s.duration) || Number(current?.duration) || this.onDemandMetadata?.(current?.url)?.duration || 0,
      nowPlaying: current ? this.track(current) : null, queue: (s.playlist_loop || []).map(t => this.track(t)),
      queueCount: Number(s.playlist_tracks) || 0, queueIndex: index, offset };
  }
  remember(action, player, source) {
    while (this.actions.size >= 10000) this.actions.delete(this.actions.keys().next().value);
    const token = crypto.randomUUID();
    this.actions.set(token, { action, player, source, expires: Date.now() + 3600000 });
    return token;
  }
  getAction(token, player) {
    const entry = this.actions.get(token);
    if (!entry || entry.player !== player || entry.expires < Date.now()) throw new Error("This source result has expired. Browse or search again.");
    return entry;
  }
  menu(result, player, source) {
    return { count: Number(result.count) || 0, offset: Number(result.offset) || 0,
      message: result.window?.textarea || "", items: (result.item_loop || []).map(item => {
        const actions = {};
        const preset = item.presetParams || item.actions?.presetParams;
        const channel = /^sxm:[\w-]+$/.test(preset?.favorites_url || "") ? {
          url: preset.favorites_url, title: preset.favorites_title || item.text,
          artwork: this.artwork({ artwork_url: preset.icon || item["icon-id"] || item.icon })
        } : null;
        if (channel) actions.favorite = this.remember({ kind: "favorite", channel }, player, source);
        for (const [name, key] of [["go", "browse"], ["play", "play"], ["add", "add"], ["add-hold", "next"]]) {
          const action = resolveAction(item, result.base, name);
          if (action && (key !== "browse" || !action.cmd.includes("playlist"))) actions[key] = this.remember({ ...action, kind: key }, player, source);
        }
        const url=preset?.favorites_type==="audio" || actions.play ? preset?.favorites_url || item.url || "" : "";
        const urn=/soundcloud/i.test(source)?soundcloudUrn(url):"";
        const durationText=String(item.text||"").split("\n")[0].match(/\((?:(\d+):)?(\d+):(\d{2})\)$/);
        const duration=Number(item.duration)|| (durationText?Number(durationText[1]||0)*3600+Number(durationText[2])*60+Number(durationText[3]):0);
        return this.items.remember({ title: item.text || item.name || "Untitled", source, input: !!item.input, favoriteId: channel?.url || "", url, sourceId:urn || String(item.id || ""), soundcloudUrn:urn, duration,
          sourcePayload:{params:item.params || {},presetParams:preset || {}},
          artwork: this.artwork(/^[0-9a-f]{6,}$/i.test(String(item["icon-id"] || "")) ? { coverid: item["icon-id"] } : { artwork_url: item["icon-id"] || item.icon }), actions });
      }) };
  }
  async sources(player) {
    const apps = await this.rpc(player, ["apps", 0, 100, "menu:1"]);
    const radios = await this.rpc(player, ["radios", 0, 100, "menu:1"]);
    const items = [...(apps.item_loop || []), ...(radios.item_loop || [])];
    return [...LIBRARY_SOURCES.map(({ id, title }) => ({ id, title, actions: {} })), ...items.map(item => {
      const action = resolveAction(item, {}, "go");
      const id = action && (LIBRARY_IDS.has(action.cmd[0]) ? `app:${action.cmd[0]}` : action.cmd[0]);
      return action ? { id, title: item.text, actions: { browse: this.remember({ ...action, kind: "browse" }, player, item.text) }, input: !!item.input } : null;
    }).filter(Boolean)];
  }
  async browse(player, { token, query = "", offset = 0, limit = 50, source = "local" } = {}) {
    if (token) {
      const entry = this.getAction(token, player);
      if (entry.action.kind !== "browse") throw new Error("Use the queue endpoint for playback actions.");
      const command = this.command(entry.action, query, offset, limit);
      return this.menu(await this.rpc(player, command), player, entry.source);
    }
    const library = LIBRARY_SOURCES.find(s => s.id === source);
    if (!library) throw new Error("Select a source to browse.");
    if (library.mode) return this.menu(await this.rpc(player, ["browselibrary", "items", offset, limit, `mode:${library.mode}`, ...(query ? [`search:${query}`] : []), "menu:1"]), player, "Local");
    const result = await this.rpc(player, ["titles", offset, limit, "tags:aljJuxd", ...(query ? [`search:${query}`] : [])]);
    return { count: Number(result.count) || 0, offset, items: (result.titles_loop || []).map(t => this.items.remember({ ...this.track(t), source: "Local", actions:
      Object.fromEntries([["play", "load"], ["add", "add"], ["next", "insert"]].map(([kind, cmd]) => [kind,
        this.remember({ kind, cmd: ["playlistcontrol"], params: { cmd, track_id: t.id } }, player, "Local")])) })) };
  }
  command(action, query, offset, limit) {
    const params = Object.entries(action.params || {}).filter(([k]) => !["_index", "_quantity"].includes(k)).map(([k, v]) => {
      if (v === "__INPUT__" || v === "__TAGGEDINPUT__") {
        if (!query.trim()) throw new Error("Enter a search term for this source.");
        v = query;
      }
      return `${k}:${v}`;
    });
    return [...action.cmd, ...(action.kind === "browse" ? [offset, limit] : []), ...params];
  }
  async execute(player, token, kind) {
    const { action } = this.getAction(token, player);
    if (action.kind !== kind || !["play", "add", "next"].includes(kind)) throw new Error("Unsupported source action.");
    return this.rpc(player, this.command(action, "", 0, 50));
  }
  exactCommand({referenceId,soundcloudTrack},kind){
    const command={play:"play",add:"add",next:"insert"}[kind];
    if(!command)throw Error("Unsupported exact playback action");
    const item=referenceId?this.items.get(referenceId):null;
    const urn=soundcloudUrn(soundcloudTrack);
    const url=item?.url || (urn?`soundcloud://${urn}`:"");
    if(!url)throw Error("An exact referenceId or SoundCloud track URN is required.");
    return ["playlist",command,url];
  }
  async executeExact(player,input,kind){
    return this.rpc(player,this.exactCommand(input,kind));
  }
  async control(player, action) {
    const commands = { play: ["play"], pause: ["pause", 1], next: ["playlist", "index", "+1"], previous: ["playlist", "index", "-1"], clear: ["playlist", "clear"] };
    if (!commands[action]) throw new Error("Unsupported Lyrion control.");
    return this.rpc(player, commands[action]);
  }
  async search(player, query, requested = []) {
    if (!query?.trim()) throw new Error("Enter a search term.");
    const sources = (await this.sources(player)).filter(s => !requested.length || requested.includes(s.id));
    const results = [];
    for (const source of sources) {
      try {
        let result, request;
        if (LIBRARY_IDS.has(source.id)) { request = { source: source.id, query }; result = await this.browse(player, request); }
        else {
          const root = await this.browse(player, { token: source.actions.browse, query });
          const search = root.items.find(i => i.input && /search/i.test(i.title));
          if (!search) { results.push({ source: source.title, searchable: false, items: [] }); continue; }
          request = { token: search.actions.browse, query };
          result = await this.browse(player, request);
        }
        results.push({ source: source.title, searchable: true, ...result, request });
      } catch (error) { results.push({ source: source.title, error: error.message, items: [] }); }
    }
    return { provider: "lyrion", query, results };
  }
}
module.exports = { LyrionClient, resolveAction, sourceFor };
