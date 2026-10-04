"use strict";
const crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const {SiriusXmOnDemand}=require("./siriusxmOnDemand");
const LOCAL=new Set(["127.0.0.1","::1","::ffff:127.0.0.1"]);
function safeMediaUrl(value){const u=new URL(value);if(u.protocol!=="https:"||u.username||u.password||u.port||!(u.hostname.endsWith(".streaming.siriusxm.com")||u.hostname==="api.edge-gateway.siriusxm.com"))throw Error("Unsupported SiriusXM media host.");return u;}
function rewriteManifest(text,base,reference){return text.split(/\r?\n/).map(line=>{
  if(line.startsWith("#"))return line.replace(/URI="([^"]+)"/g,(_,uri)=>'URI="'+reference(safeMediaUrl(new URL(uri,base).href).href,line.startsWith("#EXT-X-KEY"))+ '"');
  return line.trim()?reference(safeMediaUrl(new URL(line.trim(),base).href).href,false):line;
}).join("\n");}
function createSiriusXmOnDemandApi({lyrion,readJson,sendJson,catalog=new SiriusXmOnDemand()}){
  const resources=new Map(),streams=new Set();
  const base=process.env.SIRIUSXM_PLAYBACK_BASE_URL || "http://127.0.0.1:3777";
  const trackAudio=new (require("./siriusxmTrackAudio").SiriusXmTrackAudio)({onDiagnostic:details=>console.info("[SiriusXM track audio]",details)});
  function artistAudioOptions(key){
    const entry=catalog.saved.artistMedia?.[key];
    if(!entry)throw Error("Unknown SiriusXM track audio.");
    return {duration:entry.track?.duration,input:async()=>{
      const selected=entry.hls?await require("./siriusxmQuality").highestStream(entry.url,catalog):{url:entry.url,bitrate:null};
      if(entry.hls)console.info("[SiriusXM track audio] highest available rendition:",selected.bitrate?Math.round(selected.bitrate/1000)+" kbps":"single rendition");
      return reference(selected.url);
    }};
  }
  const prepareTrack=key=>catalog.saved.artistMedia?.[key]?.hls?trackAudio.get(key,artistAudioOptions(key)):Promise.resolve(null);
  const serveTrack=(req,res,key)=>trackAudio.serve(req,res,key,artistAudioOptions(key));
  const artists=new (require("./siriusxmArtistStations").SiriusXmArtistStations)({catalog,lyrion,base,decode,prepareTrack,serveTrack});
  lyrion.client.artistStations=artists;
  // Only opaque server-issued URLs reach the decoder; account tokens never enter argv or Lyrion.
  function reference(url,key=false){const u=safeMediaUrl(url);const id=crypto.randomUUID();resources.set(id,{url,key,at:Date.now()});if(resources.size>30000)for(const [k,v]of resources)if(Date.now()-v.at>43200000)resources.delete(k);const ext=u.pathname.match(/\.(m3u8|aac|mp3|m4a|ts)$/)?.[1]||"bin";return base+"/api/siriusxm/ondemand/resource/"+id+"/media."+ext;}
  function ticket(type,id){const item=catalog.get(type,id);if(!item.playable)throw Error("This episode is unavailable on your account.");const key=crypto.createHash('sha256').update(type+':'+id).digest('hex');catalog.saved.tickets||={};catalog.saved.tickets[key]={type,id};catalog.save();return {item,url:base+"/api/siriusxm/ondemand/audio/"+key+".flac"};}
  function identify(url){try{const m=new URL(url).pathname.match(/^\/api\/siriusxm\/ondemand\/audio\/([a-f0-9]{64})\.flac$/);const t=m&&catalog.saved.tickets?.[m[1]];return t?catalog.get(t.type,t.id):null;}catch{return null;}}
  lyrion.client.onDemandMetadata=url=>artists.identify(url)||identify(url);
  async function decode(mediaUrl,res){
      const selected=await require("./siriusxmQuality").highestStream(mediaUrl,catalog);
      console.info("[SiriusXM audio] highest available rendition:",selected.bitrate?Math.round(selected.bitrate/1000)+" kbps":"single rendition");
      const input=reference(selected.url);
      if(res.destroyed)return;
      if(streams.size>=3)throw Error("Too many episode audio connections. Stop another episode first.");
      const child=spawn(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-protocol_whitelist","http,https,tcp,tls,crypto","-allowed_extensions","ALL","-i",input,"-vn","-c:a","flac","-f","flac","pipe:1"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
      streams.add(child);let sent=false,clientClosed=false;
      let decoderError="";
      child.stderr.on("data",chunk=>{decoderError=(decoderError+chunk.toString().replace(/https?:\/\/[^\s'"\]]+/g,"[media URL]")).slice(-2000);});
      const cleanup=()=>{streams.delete(child);};
      child.on("error",()=>{cleanup();if(!res.headersSent)sendJson(res,502,{error:"Could not start the episode audio decoder. Check FFMPEG_PATH."});else res.destroy();});
      child.stdout.once("data",chunk=>{sent=true;res.writeHead(200,{"Content-Type":"audio/flac","Accept-Ranges":"none"});res.write(chunk);child.stdout.pipe(res);});
      child.on("close",code=>{cleanup();if(!clientClosed&&(code||decoderError))console.warn("[SiriusXM episode decoder]",{code,started:sent,error:decoderError});if(!sent&&!res.headersSent&&!res.destroyed)sendJson(res,502,{error:"SiriusXM episode audio could not be decoded."});else if(code)res.destroy();});
      res.on("close",()=>{clientClosed=!res.writableFinished;child.kill();cleanup();});
  }
  async function handle(req,res,url){
    const route=url.pathname.slice("/api/siriusxm/ondemand/".length);
    res.setHeader("Cache-Control","no-store");
    if(route.startsWith("artist/audio/"))return artists.audio(req,res,route.match(/^artist\/audio\/([a-f0-9]{64})\.(?:m4a|flac)$/)?.[1],sendJson);
    if(route.startsWith("resource/")||route.startsWith("audio/")){
      if(!LOCAL.has(req.socket.remoteAddress))return sendJson(res,403,{error:"Audio relay is local to the Rabbit Hole computer."});
      if(!["GET","HEAD"].includes(req.method))return sendJson(res,405,{error:"Unsupported method."});
      if(route.startsWith("resource/")){
        const entry=resources.get(route.slice(9).split("/")[0]);if(!entry||Date.now()-entry.at>43200000)return sendJson(res,404,{error:"Episode resource expired. Play the episode again."});
        const u=safeMediaUrl(entry.url),headers={};
        if(/^bytes=\d+-\d*$/.test(req.headers.range||""))headers.Range=req.headers.range;
        if(u.hostname==="api.edge-gateway.siriusxm.com")headers.Authorization="Bearer "+await catalog.token();
        const upstream=await require("./siriusxmMediaResource").readMediaResource(u,{fetchImpl:catalog.fetch.bind(catalog),headers,onRetry:details=>console.warn("[SiriusXM audio] retrying media resource",details)});
        if(res.destroyed)return;
        if(!entry.key&&!u.pathname.endsWith(".m3u8")){
          const h={"Content-Type":upstream.headers.get("content-type")||"application/octet-stream"};
          h["Content-Length"]=upstream.data.length;
          for(const k of ["content-range","accept-ranges"])if(upstream.headers.get(k))h[k]=upstream.headers.get(k);
          res.writeHead(upstream.status,h);
          res.end(upstream.data);return;
        }
        const data=upstream.data;
        if(data.length>8*1024*1024)throw Error("Unexpected episode resource size.");
        if(entry.key){const key=data.length===16?data:Buffer.from(JSON.parse(data.toString()).key,"base64");if(key.length!==16)throw Error("Invalid SiriusXM media key.");res.writeHead(200,{"Content-Type":"application/octet-stream"});return res.end(key);}
        if(data.subarray(0,7).toString()==="#EXTM3U"){res.writeHead(200,{"Content-Type":"application/vnd.apple.mpegurl"});return res.end(rewriteManifest(data.toString(),entry.url,reference));}
        res.writeHead(200,{"Content-Type":"application/octet-stream"});return res.end(data);
      }
      const key=route.match(/^audio\/([a-f0-9]{64})\.flac$/)?.[1],entity=catalog.saved.tickets?.[key];
      if(!entity)return sendJson(res,404,{error:"Unknown SiriusXM episode."});
      if(req.method==="HEAD"){res.writeHead(200,{"Content-Type":"audio/flac","Accept-Ranges":"none"});return res.end();}
      // Independent requests: a player's metadata probe must not kill active audio.
      const tuned=await catalog.tune(entity.type,entity.id),media=tuned.streams?.[0]?.urls?.find(u=>u.isPrimary)||tuned.streams?.[0]?.urls?.[0];
      if(!media?.url)throw Error("SiriusXM did not provide episode audio.");
      return decode(media.url,res);
      return;
    }
    if(req.headers.origin&&req.headers.origin!==url.origin)return sendJson(res,403,{error:"Use the Rabbit Hole page to search and play episodes."});
    if(req.method!=="POST")return sendJson(res,405,{error:"Use POST for on-demand actions."});
    const body=await readJson(req);
    if(route.startsWith("xtra/")){
      const type="channel-xtra",station=()=>{const s=artists.status(body.playerId);return s?.type===type?s:null;};
      if(route==="xtra/search")return sendJson(res,200,{items:await artists.search(body.query,type)});
      if(route==="xtra/browse")return sendJson(res,200,{items:await artists.browseXtra({refresh:body.refresh===true})});
      if(route==="xtra/favorites")return sendJson(res,200,{items:body.action?artists.favorite(body.action,body.id,type):artists.favorites(type)});
      if(route==="xtra/status")return sendJson(res,200,{station:station()});
      if(route==="xtra/play")return sendJson(res,200,{station:await artists.start(body.playerId,body.id,type,{shouldContinue:()=>!res.destroyed})});
      if(route==="xtra/stop")return lyrion.exclusive(()=>{if(station())artists.stop(body.playerId);return sendJson(res,200,{station:station()});});
    }
    if(route==="artist/search")return sendJson(res,200,{items:await artists.search(body.query)});
    if(route==="artist/favorites")return sendJson(res,200,{items:body.action?artists.favorite(body.action,body.id):artists.favorites()});
    if(route==="artist/library")return sendJson(res,200,{items:await artists.library()});
    if(route==="artist/status"){const station=artists.status(body.playerId);return sendJson(res,200,{station:station?.type==="channel-xtra"?null:station});}
    if(route==="artist/play")return sendJson(res,200,{station:await artists.start(body.playerId,body.id,"artist-station",{shouldContinue:()=>!res.destroyed})});
    if(route==="artist/stop")return lyrion.exclusive(()=>{const station=artists.status(body.playerId);return sendJson(res,200,{station:station?.type==="channel-xtra"?null:artists.stop(body.playerId)});});
    if(route==="channel-shows"){
      const result=await lyrion.siriusxm.getChannelMetadata(String(body.channel||""));
      if(!result.metadata?.channelEntityId)throw Error("Could not identify this SiriusXM channel. Try again shortly.");
      return sendJson(res,200,{channel:result.metadata.channelName,items:await catalog.channelShows(result.metadata.channelEntityId)});
    }
    if(route==="search")return sendJson(res,200,{items:await catalog.search(body.query)});
    if(route==="episodes")return sendJson(res,200,{items:await catalog.episodes(body.type,body.id)});
    if(route==="queue")return lyrion.exclusive(async()=>{
      if(!["play","add","next"].includes(body.action))throw Error("Choose play, add, or next.");
      await lyrion.client.requirePlayer(body.playerId);
      const entry=ticket(body.type,body.id);
      if(body.action==="play"){
        const tuned=await catalog.tune(body.type,body.id);const media=tuned.streams?.[0]?.urls?.find(u=>u.isPrimary)||tuned.streams?.[0]?.urls?.[0];
        if(!media?.url)throw Error("SiriusXM did not provide episode audio.");safeMediaUrl(media.url);
        await lyrion.handoff("lyrion");
      }
      artists.stop(body.playerId,"Queue changed; automatic additions stopped.");
      await lyrion.client.rpc(body.playerId,["playlist",{play:"play",add:"add",next:"insert"}[body.action],entry.url,entry.item.title]);
      return sendJson(res,200,{ok:true,item:entry.item});
    });
    return sendJson(res,404,{error:"Unknown on-demand action."});
  }
  return {handle,catalog,identify,artists};
}
module.exports={createSiriusXmOnDemandApi,safeMediaUrl,rewriteManifest};
