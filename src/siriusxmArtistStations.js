"use strict";
const crypto = require("node:crypto");
const BASE = "https://api.edge-gateway.siriusxm.com/";
const PREFIX = "/api/siriusxm/ondemand/artist/";
const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const XTRA = "channel-xtra";
const ARTIST = "artist-station";
const ALL_CHANNELS = "403ab6a5-d3c9-4c2a-a722-a94a6a5fd056";
const CATALOG_TTL = 3600000;
const items = data => (data.container?.sets || []).flatMap(set => set.items || []);
function artwork(images) {
  for (const variants of Object.values(images || {})) {
    const square = variants?.aspect_1x1;
    const key = (square?.preferred || square?.preferredImage || square?.default || square?.defaultImage || square)?.url;
    if (typeof key === "string" && /^[\w/-]+\.[\w]+$/.test(key)) return "https://imgsrv-sxm-prod-device.streaming.siriusxm.com/" + Buffer.from(JSON.stringify({key, edits:[{format:{type:"jpeg"}},{resize:{width:600,height:600}}]})).toString("base64");
  }
  return null;
}
function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.endsWith(".streaming.siriusxm.com")) throw Error("Unsupported artist station audio host.");
  return url;
}
class SiriusXmArtistStations {
  constructor({catalog, lyrion, base = "http://127.0.0.1:3777", pollMs = 10000, decode, prepareTrack, serveTrack}) {
    Object.assign(this, {catalog, lyrion, base, decode, prepareTrack, serveTrack});
    this.sessions = new Map();
    this.startRequests = new Map();
    catalog.saved.artistStations ||= {};
    catalog.saved.xtraChannels ||= {};
    catalog.saved.artistMedia ||= {};
    if (pollMs) { this.timer = setInterval(() => this.tick(), pollMs); this.timer.unref(); }
  }
  collection(type = ARTIST) {
    if (![ARTIST,XTRA].includes(type)) throw Error("Unsupported SiriusXM station type.");
    return this.catalog.saved[type===XTRA?"xtraChannels":"artistStations"];
  }
  remember(raw, type = ARTIST) {
    const collection = this.collection(type);
    const result = [];
    for (const item of raw) {
      const e = item.entity;
      if (e?.type !== type || typeof e.id !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(e.id)) continue;
      const station = {id:e.id, type, title:e.texts?.title?.default || (type===XTRA?"Xtra channel":"Artist station"), artwork:artwork(e.images),
        similarArtists:item.decorations?.similarArtists || [], playable:!item.decorations?.unentitled};
      if(type===XTRA){station.description=e.texts?.description?.default||"";station.channelNumber=Number(item.decorations?.channelNumber)||null;}
      collection[e.id] = station; result.push(station);
    }
    this.catalog.save(); return [...new Map(result.map(s => [s.id,s])).values()];
  }
  async search(query, type = ARTIST) {
    query = String(query || "").trim();
    if (!query || query.length > 200) throw Error(type===XTRA?"Enter an Xtra channel name (up to 200 characters).":"Enter an artist name (up to 200 characters).");
    const raw = items(await this.catalog.api("search/v1/search", {searchString:query}));
    // Search results supply exact station identities; no channel/title substitution.
    return this.remember(raw,type);
  }
  async browseXtra({refresh=false}={}) {
    const cached = this.catalog.saved.xtraCatalog;
    if(!refresh && cached?.at>Date.now()-CATALOG_TTL)return cached.ids.map(id=>this.collection(XTRA)[id]).filter(Boolean);
    if(this.browsingXtra)return this.browsingXtra;
    this.browsingXtra=(async()=>{
      // The official page supplies the catalog descriptor; follow only its exact SiriusXM relationship endpoint.
      const page=await this.catalog.api("page/v1/page/curated-grouping/"+ALL_CHANNELS);
      const descriptor=(page.page?.containers||[]).find(c=>typeof c.url==="string"&&/container\/all-channels(?:\?|$)/.test(c.url));
      if(!descriptor)throw Error("SiriusXM's Xtra channel catalog is unavailable. Search by name instead.");
      const url=new URL(descriptor.url,BASE);
      if(url.origin!==new URL(BASE).origin||url.pathname!=="/relationship/v1/container/all-channels"||url.searchParams.get("entityId")!==ALL_CHANNELS||url.searchParams.get("entityType")!=="curated-grouping"||!url.searchParams.get("containerId"))throw Error("Unexpected SiriusXM channel catalog identity.");
      const seen=new Set(),raw=[];
      for(let offset=0;offset<5000;){
        url.searchParams.set("offset",String(offset));url.searchParams.set("maxResponses","30");
        const entries=items(await this.catalog.api(url.pathname.slice(1)+url.search));
        if(!entries.length)break;
        let added=0;
        for(const item of entries){const key=item.entity?.type+":"+item.entity?.id;if(!item.entity?.id||seen.has(key))continue;seen.add(key);added++;if(item.entity.type===XTRA)raw.push(item);}
        if(!added)break;
        offset+=entries.length;
      }
      const result=this.remember(raw,XTRA);
      result.sort((a,b)=>a.title.localeCompare(b.title));
      this.catalog.saved.xtraCatalog={at:Date.now(),ids:result.map(i=>i.id)};this.catalog.save();return result;
    })().finally(()=>{this.browsingXtra=null;});
    return this.browsingXtra;
  }
  favorites(type = ARTIST) {
    const collection=this.collection(type);
    return (this.catalog.saved[type===XTRA?"xtraFavorites":"artistFavorites"] || []).map(id=>collection[id]).filter(Boolean);
  }
  favorite(action,id,type = ARTIST) {
    if(!["add","remove"].includes(action))throw Error("Choose add or remove favorite.");
    if(typeof id!=="string" || !Object.hasOwn(this.collection(type),id))throw Error(type===XTRA?"Search for this Xtra channel first.":"Search for this artist station first.");
    const field=type===XTRA?"xtraFavorites":"artistFavorites";
    const ids=new Set(this.catalog.saved[field] || []);
    if(action==="add")ids.add(id);else ids.delete(id);
    this.catalog.saved[field]=[...ids];this.catalog.save();return this.favorites(type);
  }
  async library() {
    const data = await this.catalog.api("ondemand/v1/library/all");
    const entries = Object.values(data.allDataMap || {}).filter(e => e.entityType === "artist-station");
    const result = [];
    for (const entry of entries.slice(0,200)) {
      if (!/^[a-zA-Z0-9-]{1,120}$/.test(entry.entityId)) continue;
      const d = await this.catalog.api("hydration/v2/hydration/item-core/artist-station/" + entry.entityId);
      const entity = d.entity?.artistStation || d.entity;
      result.push(...this.remember([{entity:{...entity, type:"artist-station"}}]));
    }
    return result;
  }
  status(player) {
    const s = this.sessions.get(player);
    return s ? {id:s.station.id,type:s.type,title:s.station.title,active:s.active,reason:s.reason || "",queued:s.urls.size} : null;
  }
  stop(player, reason = "Automatic additions stopped. Queued tracks remain available.") {
    this.startRequests.delete(player);
    const s = this.sessions.get(player); if (s) { s.active = false; s.reason = reason; }
    return this.status(player);
  }
  identify(url) {
    try { const key = new URL(url).pathname.match(/\/artist\/audio\/([a-f0-9]{64})\.(?:m4a|flac)$/)?.[1];
      const entry = this.catalog.saved.artistMedia[key]; return entry?.track || null;
    } catch { return null; }
  }
  async batch(s) {
    if (s.started && !s.cursor) return [];
    const type=s.type||ARTIST;
    const data = await this.catalog.api("playback/play/v1/tuneSource", {id:s.station.id,type,hlsVersion:"V3",manifestVariant:"FULL",mtcVersion:"V2",mediaFormat:"HLS",...(s.cursor?{sequenceToken:s.cursor}:{})});
    if (data.id !== s.station.id || data.type !== type) throw Error("SiriusXM returned a different station identity.");
    const tracks = [];
    for (const stream of data.streams || []) {
      const meta = stream.metadata?.[type===XTRA?"xtra":"artist"]?.items?.[0];
      const source = stream.urls?.find(u => u.isPrimary) || stream.urls?.[0];
      const id = stream.id || meta?.id;
      if (!id || !meta || !source?.url || s.seen.has(id)) continue;
      const hls=new URL(source.url).pathname.endsWith(".m3u8");
      if (source.encryptionKeyId && !hls) throw Error("This artist station audio format is not supported.");
      mediaUrl(source.url);
      const key = crypto.createHash("sha256").update(s.key + ":" + id).digest("hex");
      const track = {id,title:meta.name || "Untitled",artist:meta.artistName || "",album:meta.albumName || s.station.title,
        duration:(Number(meta.duration)||0)/1000,artwork:artwork(meta.images)||s.station.artwork,source:type===XTRA?"SiriusXM Xtra channel":"SiriusXM artist station",stationTitle:s.station.title};
      this.catalog.saved.artistMedia[key] = {track,url:source.url,hls,expires:Date.parse(source.validUntil)||Date.now()+3600000};
      tracks.push({id,url:this.base+PREFIX+"audio/"+key+(hls?".flac":".m4a"),track}); s.seen.add(id);
    }
    s.started = true; s.cursor = data.sequenceToken; s.limits = data.skipLimits;
    for (const [key,entry] of Object.entries(this.catalog.saved.artistMedia)) if (entry.expires < Date.now()-86400000) delete this.catalog.saved.artistMedia[key];
    this.catalog.save(); return tracks;
  }
  async start(player, id, type = ARTIST, {shouldContinue=()=>true}={}) {
    const request=Symbol("station-start"),revision=this.lyrion.playbackRevision?.();
    this.startRequests.set(player,request);
    try {
      await this.lyrion.client.requirePlayer(player);
      const initial=await this.lyrion.client.status(player,0,1);
      const station = this.collection(type)[id];
      if (!station?.playable) throw Error(type===XTRA?"Search for an available Xtra channel first.":"Search for an available artist station first.");
      const s = {key:crypto.randomUUID(),type,station,player,active:true,seen:new Set(),urls:new Set()};
      const batch = await this.batch(s);
      if (!batch.length) throw Error("SiriusXM did not return any playable tracks for this station.");
      // A failed/short upstream decode must not replace the current queue.
      if(this.prepareTrack)await this.prepareTrack(new URL(batch[0].url).pathname.match(/\/audio\/([a-f0-9]{64})\./)[1]);
      // Slow network/cache work stays outside the shared playback lock. Commit
      // only if this is still the latest request and playback ownership agrees.
      return await this.lyrion.exclusive(async()=>{
        const latest=await this.lyrion.client.status(player,0,1);
        if(!shouldContinue() || this.startRequests.get(player)!==request)throw Error("SiriusXM station request was cancelled before playback changed.");
        if(this.lyrion.playbackRevision?.()!==revision || !latest.connected || initial.state!==latest.state || initial.queueCount!==latest.queueCount || initial.queueIndex!==latest.queueIndex || initial.nowPlaying?.url!==latest.nowPlaying?.url)throw Error("Playback changed while the SiriusXM station was preparing. Choose Play station again.");
        // Preflight before replacing the user's queue. Starting a station is the only replacing action.
        await this.lyrion.handoff("lyrion");
        this.sessions.set(player,s);
        try {
          for (let i=0;i<batch.length;i++) {
            const t=batch[i]; await this.lyrion.client.rpc(player,["playlist",i===0?"play":"add",t.url,t.track.title]); s.urls.add(t.url);
          }
        } catch (e) { this.stop(player,"Queue update failed. Start the station again to retry safely."); throw e; }
        this.warm(batch.slice(1));
        return this.status(player);
      });
    } finally { if(this.startRequests.get(player)===request)this.startRequests.delete(player); }
  }
  async skip(player, direction) {
    const s=this.sessions.get(player); if (!s) return;
    const state=await this.lyrion.client.status(player,0,1);
    if (!s.urls.has(state.nowPlaying?.url)) return;
    const field=direction==="next"?"availableForwardSkips":"availableBackwardSkips";
    if (s.limits?.limited?.[field] === 0) throw Error("SiriusXM has no skips available in this direction right now.");
    const data=await this.catalog.api("playback/play/v1/skip",{id:s.station.id,type:s.type||ARTIST,sequenceToken:s.cursor,direction:direction==="next"?"forward":"backward"});
    if (data.skipLimits) s.limits=data.skipLimits;
    if (data.skipAllowed === false) throw Error("SiriusXM has no skips available right now.");
  }
  async tick() {
    if (this.ticking) return; this.ticking=true;
    try { for (const s of this.sessions.values()) {
      if (!s.active || Date.now() < (s.retryAt||0)) continue;
      await this.lyrion.exclusive(async () => {
        if (!s.active) return;
        try {
          const state=await this.lyrion.client.status(s.player,0,1);
          if (!state.connected) return;
          if (!state.queueCount || !s.urls.has(state.nowPlaying?.url) || state.queueCount!==s.urls.size) { this.stop(s.player,"Queue changed; automatic additions stopped."); return; }
          if (state.state!=="playing" || state.queueCount-state.queueIndex>3) return;
          if (s.seen.size>=1000) { this.stop(s.player,"Station session complete. Play the station again for more music."); return; }
          const batch=await this.batch(s);
          if (!batch.length) { this.stop(s.player,"SiriusXM returned no new tracks. Play the station again to continue."); return; }
          // External Lyrion clients do not share our lock. Recheck ownership after the network call.
          const latest=await this.lyrion.client.status(s.player,0,1);
          if (!s.active || latest.state!=="playing" || !s.urls.has(latest.nowPlaying?.url) || latest.queueCount!==s.urls.size) { this.stop(s.player,"Playback changed; automatic additions stopped."); return; }
          for (const t of batch) {
            try { await this.lyrion.client.rpc(s.player,["playlist","add",t.url,t.track.title]); }
            catch { this.stop(s.player,"Queue update was not confirmed. Automatic additions stopped to avoid duplicates."); return; }
            s.urls.add(t.url);
          }
          this.warm(batch);
          s.reason=""; s.failures=0;
        } catch (e) {
          s.retryAt=Date.now()+30000; s.failures=(s.failures||0)+1;
          s.reason="Could not fetch more songs. Retrying in 30 seconds.";
          console.warn("[SiriusXM artist station] refill failed:",e.message);
          if (s.failures>=3) this.stop(s.player,"Could not fetch more songs after three attempts. Play the station again to retry.");
        }
      });
    }} finally { this.ticking=false; }
  }
  warm(tracks) {
    if(!this.prepareTrack)return;
    // Begin before LMS requests the next track, without changing its transport.
    for(const track of tracks.slice(0,2)) {
      const key=new URL(track.url).pathname.match(/\/audio\/([a-f0-9]{64})\./)?.[1];
      if(key)this.prepareTrack(key).catch(error=>console.warn("[SiriusXM track audio] prefetch failed:",error.message));
    }
  }
  async audio(req,res,key,sendJson) {
    if (!LOCAL.has(req.socket.remoteAddress)) return sendJson(res,403,{error:"Artist station audio is local to the Rabbit Hole computer."});
    if (!["GET","HEAD"].includes(req.method)) return sendJson(res,405,{error:"Unsupported method."});
    const entry=this.catalog.saved.artistMedia[key];
    if (!entry || entry.expires<Date.now()) return sendJson(res,410,{error:"Station audio expired. Play the station again."});
    if(this.serveTrack && entry.hls)return this.serveTrack(req,res,key);
    if(entry.hls){
      if(req.method==="HEAD"){res.writeHead(200,{"Content-Type":"audio/flac","Accept-Ranges":"none"});return res.end();}
      if(!this.decode)throw Error("Artist station decoder unavailable.");
      return this.decode(entry.url,res,{key,kind:"artist"});
    }
    const headers={}; if (/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range||"")) headers.Range=req.headers.range;
    // Keep legacy queued M4A tracks in their original format. Complete this
    // finite resource before delivery: slow player reads cannot use up the
    // upstream deadline or receive an incomplete body as a finished song.
    const upstream=await require("./siriusxmMediaResource").readMediaResource(mediaUrl(entry.url),{fetchImpl:this.catalog.fetch.bind(this.catalog),headers,maxBytes:64*1024*1024,timeoutMs:60000});
    const responseHeaders={"Content-Type":"audio/mp4"};
    responseHeaders["Content-Length"]=upstream.data.length;
    for (const name of ["content-range","accept-ranges"]) if (upstream.headers.get(name)) responseHeaders[name]=upstream.headers.get(name);
    if(res.destroyed)return;
    res.writeHead(upstream.status,responseHeaders);
    if (req.method==="HEAD") return res.end();
    res.end(upstream.data);
  }
}
module.exports={SiriusXmArtistStations,artwork,mediaUrl};
