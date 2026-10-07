"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { LyrionClient } = require("./lyrionClient");
const { LyrionFavorites } = require("./lyrionFavorites");
const { ambiguousLibraryUrl } = require("./lyrionItems");

function createLyrionApi({ roon, readJson, sendJson, catalogue=null, client = new LyrionClient({itemsFile:path.join(__dirname,"../data/lyrion-items.json")}), file = path.join(__dirname, "../data/lyrion-selection.json"), favoritesFile = path.join(__dirname, "../data/lyrion-favorites.json") }) {
  const favorites = new LyrionFavorites(favoritesFile);
  const favoriteImages = items => items.map(item => ({ ...item,
    artwork: client.artwork ? client.artwork({ artwork_url: item.artwork }) : item.artwork }));
  const siriusxm = new (require("./siriusxmMetadata").SiriusXmMetadata)({favorites:()=>favoriteImages(favorites.list())});
  let selectedPlayer = "";
  let activeFrontend = "roon";
  let playbackVersion = 0;
  let serial = Promise.resolve();
  const operation = new AsyncLocalStorage();
  try { selectedPlayer = JSON.parse(fs.readFileSync(file, "utf8")).playerId || ""; } catch {}
  const exclusive = fn => {
    if (operation.getStore()) return fn();
    const result = serial.then(() => operation.run(true, fn));
    serial = result.catch(() => {});
    return result;
  };
  async function handoff(target) {
    playbackVersion++;
    if (target === "lyrion") {
      // Only pause playing zones: never modify Roon pairing, queue, or configuration.
      for (const zone of roon.getState().zones || []) {
        if (zone.state === "playing") await roon.control(zone.zone_id, "pause");
      }
    } else {
      let players;
      try { players = await client.players(); } catch (error) {
        if (activeFrontend === "lyrion") throw new Error(`Cannot safely hand off from Lyrion: ${error.message}`);
        return; // An absent optional server must not disable existing Roon playback.
      }
      for (const player of players) if (player.playing && player.connected) await client.control(player.id, "pause");
    }
    activeFrontend = target;
  }
  async function presence() {
    const players = await client.players();
    const playing = players.find(p => p.id === selectedPlayer && p.playing && p.connected) || players.find(p => p.playing && p.connected);
    const roonPlaying = (roon.getState().zones || []).some(z => z.state === "playing");
    const chosen = playing && (!roonPlaying || activeFrontend === "lyrion") ? "lyrion" : roonPlaying ? "roon" : null;
    const state=chosen==='lyrion'?await displayStatus(playing.id,0,1):null;
    return { frontend: chosen, conflict: !!playing && roonPlaying,
      lyrion: state?(state.displayPlaybackState||state):null };
  }
  async function displayStatus(player,offset,limit){const state=await siriusxm.overlay(await client.status(player,offset,limit));return catalogue?catalogue.enrich(state):state;}
  async function handle(req, res, url) {
    const route = url.pathname.slice("/api/lyrion/".length);
    if (req.method === "GET" && route === "artwork") {
      const imagePath = url.searchParams.get("path") || "";
      const imageUrl = new URL(imagePath, client.baseUrl);
      if (imageUrl.origin !== client.baseUrl || !/^\/(imageproxy|music|plugins|html|contributor)\//.test(imageUrl.pathname)) return sendJson(res, 400, { error: "Invalid artwork path" });
      const headers = {};
      if (process.env.LYRION_USERNAME) headers.Authorization = `Basic ${Buffer.from(`${process.env.LYRION_USERNAME}:${process.env.LYRION_PASSWORD || ""}`).toString("base64")}`;
      const image = await fetch(imageUrl, { headers, signal: AbortSignal.timeout(10000) });
      const type = image.headers.get("content-type") || "";
      if (!image.ok || !type.startsWith("image/")) return sendJson(res, 404, { error: "Artwork unavailable" });
      const chunks = []; let size = 0;
      for await (const chunk of image.body) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new Error("Artwork too large"); chunks.push(chunk); }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
      return res.end(Buffer.concat(chunks));
    }
    const body = req.method === "POST" ? await readJson(req) : {};
    const player = body.playerId || url.searchParams.get("playerId") || selectedPlayer;
    const offset = Math.max(0, Math.min(1000000, Math.floor(Number(body.offset ?? url.searchParams.get("offset")) || 0)));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(body.limit ?? url.searchParams.get("limit")) || 50)));
    if (req.method === "GET" && route === "players") return sendJson(res, 200, { players: await client.players(), selectedPlayer });
    if(req.method==="GET" && route==="discoveries")return sendJson(res,200,{items:client.items.recent(Number(url.searchParams.get("count"))||10,url.searchParams.get("source")||"")});
    if (req.method === "GET" && route === "presence") return sendJson(res, 200, await presence());
    if (req.method === "GET" && route === "favorites") return sendJson(res, 200, { favorites: favoriteImages(favorites.list()) });
    if (req.method === "POST" && route === "favorites") {
      if (body.action === "remove") return sendJson(res, 200, { favorites: favoriteImages(favorites.remove(body.id)) });
      if (body.action !== "add") return sendJson(res, 400, { error: "Unsupported favorite action." });
      const entry = client.getAction(body.token, player);
      if (entry.action.kind !== "favorite") return sendJson(res, 400, { error: "Choose a channel's Favorite action." });
      return sendJson(res, 200, { favorites: favoriteImages(favorites.add(entry.action.channel)) });
    }
    if (req.method === "POST" && route === "favorites/play") {
      playbackVersion++;
      return exclusive(async () => {
        const channel = favorites.get(body.id);
        await client.requirePlayer(player);
        await handoff("lyrion");
        client.artistStations?.stop(player,"Channel selected; automatic additions stopped.");
        await client.rpc(player, ["playlist", "play", channel.url, channel.title]);
        return sendJson(res, 200, { ok: true });
      });
    }
    if (req.method === "POST" && route === "player") {
      playbackVersion++;
      await client.requirePlayer(player);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ playerId: player }));
      fs.renameSync(`${file}.tmp`, file);
      selectedPlayer = player;
      return sendJson(res, 200, { selectedPlayer });
    }
    if (!player) { const error = new Error("Choose a Lyrion player first."); error.statusCode = 400; throw error; }
    if (req.method === "GET" && ["status","now-playing","queue"].includes(route)) {
      const station=client.artistStations?.status(player)||null;
      return sendJson(res,200,{...await displayStatus(player,offset,limit),artistStation:station?.type==="channel-xtra"?null:station,xtraStation:station?.type==="channel-xtra"?station:null});
    }
    if(route==="native-favorites"){
      if(req.method==="GET")return sendJson(res,200,client.menu(await client.rpc(player,["favorites","items",offset,limit,"menu:1"]),player,"Lyrion favorites"));
      if(req.method!=="POST" || !["add","remove"].includes(body.action))throw Error("Choose add or remove favorite.");
      return exclusive(async()=>{
        const item=client.items.get(body.referenceId);
        if(item.libraryIdentity || ambiguousLibraryUrl(item.url))throw Error("Library collections cannot be saved by a title-query URL. Use the native library's favorite controls instead.");
        const exists=await client.rpc(player,["favorites","exists",item.url]);
        if(body.action==="add" && !Number(exists.exists))await client.rpc(player,["favorites","add",`url:${item.url}`,`title:${item.title}`,"type:audio"]);
        if(body.action==="remove" && Number(exists.exists))await client.rpc(player,["favorites","delete",`item_id:${exists.index}`]);
        return sendJson(res,200,{ok:true,changed:body.action==="add"?!Number(exists.exists):!!Number(exists.exists),referenceId:body.referenceId});
      });
    }
    if (req.method === "GET" && route === "sources") return sendJson(res, 200, { sources: await client.sources(player) });
    if (req.method === "POST" && route === "browse") return sendJson(res, 200, await client.browse(player, { ...body, offset, limit }));
    if (req.method === "POST" && route === "search") return sendJson(res, 200, await client.search(player, String(body.query || "").slice(0, 500), Array.isArray(body.sources) ? body.sources : []));
    if (req.method === "POST" && ["control", "queue"].includes(route)) {
      // Cancel an older station preparation on a newer transport intent, even
      // a pause on an already paused player. No Roon entry point is changed.
      playbackVersion++;
      return exclusive(async () => {
        await client.requirePlayer(player);
        const starts = route === "queue" ? body.action === "play" : ["play", "next", "previous"].includes(body.action);
        if (route === "queue" && !body.referenceId && !body.soundcloudTrack) {
          const entry = client.getAction(body.token, player);
          if (entry.action.kind !== body.action || !["play", "add", "next"].includes(body.action)) throw new Error("Invalid queue action.");
        }
        if(route==="queue" && (body.referenceId || body.soundcloudTrack))client.exactCommand(body,body.action,player);
        if (starts) await handoff("lyrion");
        if(route==="queue" && (body.referenceId || body.soundcloudTrack) && !["play","add","next"].includes(body.action))throw Error("Invalid queue action.");
        if(route==="queue" || body.action==="clear")client.artistStations?.stop(player,"Queue changed; automatic additions stopped.");
        if(route==="control" && ["next","previous"].includes(body.action))await client.artistStations?.skip(player,body.action);
        const result = route === "queue" ? (body.referenceId || body.soundcloudTrack ? await client.executeExact(player,body,body.action) : await client.execute(player, body.token, body.action)) : await client.control(player, body.action);
        return sendJson(res, 200, { ok: true, result });
      });
    }
    return sendJson(res, 404, { error: "Unknown Lyrion endpoint." });
  }
  function installPlaybackHandoffs() {
    // Decorate only playback entry points on this instance. The Roon implementation,
    // discovery/matching, pairing, queue identities and extension remain untouched.
    const starts = {
      control: (zoneId, action) => ["play", "next", "previous"].includes(action) ||
        action === "playpause" && !(roon.getState().zones || []).some(z => z.zone_id === zoneId && z.state === "playing"),
      playFromHere: () => true, playRadioStation: () => true, playSearchMatch: () => true,
      queueTracks: (tracks, zoneId, options) => options?.mode === "replace"
    };
    for (const [name, shouldStart] of Object.entries(starts)) {
      if (typeof roon[name] !== "function") continue;
      const original = roon[name].bind(roon);
      roon[name] = (...args) => shouldStart(...args) ? exclusive(async () => {
        await handoff("roon"); return original(...args);
      }) : original(...args);
    }
  }
  return { handle, handoff, exclusive, client, presence, siriusxm, installPlaybackHandoffs, playbackRevision:()=>playbackVersion };
}
module.exports = { createLyrionApi };
