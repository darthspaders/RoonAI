"use strict";
const fs = require("node:fs");
const path = require("node:path");
const BASE = "https://api.edge-gateway.siriusxm.com/";
const TYPES = new Set(["show", "show-podcast", "episode-audio", "episode-podcast"]);

function credentials() {
  if (process.env.SIRIUSXM_USERNAME && process.env.SIRIUSXM_PASSWORD) return {handle:process.env.SIRIUSXM_USERNAME,password:process.env.SIRIUSXM_PASSWORD};
  const file = process.env.SIRIUSXM_LYRION_PREFS || "C:/ProgramData/Lyrion/prefs/plugin/siriusxm.prefs";
  let text; try { text = fs.readFileSync(file,"utf8"); } catch { throw Error("Configure your SiriusXM login in Lyrion first."); }
  function value(key) {
    const v = text.match(new RegExp("^"+key+": (.*)$","m"))?.[1].trim();
    if (!v || /^[|>]/.test(v)) throw Error("SiriusXM login configuration is missing or unsupported.");
    if (v.startsWith("'")) return v.slice(1,-1).replace(/''/g,"'");
    if (v.startsWith('"')) return JSON.parse(v);
    return v;
  }
  return {handle:value("username"),password:value("password")};
}
function entities(data) { return (data.container?.sets || []).flatMap(s=>s.items || []).filter(i=>TYPES.has(i.entity?.type)); }
function normalize(item) {
  const e=item.entity, image=e.images?.tile?.aspect_1x1?.preferred?.url || e.images?.tile?.aspect_1x1?.default?.url || e.images?.tile?.aspect_1x1?.preferredImage?.url;
  return {id:e.id,type:e.type,title:e.texts?.title?.default || "Untitled",description:e.texts?.description?.default || "",duration:(Number(item.decorations?.duration)||0)/1000,
    artwork:image && /^(?:aem|if|live)\/[\w/.-]+$/.test(image) ? "https://imgsrv-sxm-prod-device.streaming.siriusxm.com/"+Buffer.from(JSON.stringify({key:image,edits:[{format:{type:"jpeg"}},{resize:{width:600,height:600}}]})).toString("base64") : null,
    playable:e.type==="episode-audio" && !item.decorations?.unentitled,unentitled:!!item.decorations?.unentitled,
    unavailableReason:e.type==="episode-podcast"?"External podcast playback is not enabled here.":null};
}
class SiriusXmOnDemand {
  constructor({file=path.join(__dirname,"../data/siriusxm-on-demand.json"),fetchImpl=fetch,getCredentials=credentials}={}) {
    Object.assign(this,{file,fetch:fetchImpl,getCredentials});this.saved={items:{}};this.busy=null;this.retryAt=0;this.tunes=new Map();
    if(file)try{this.saved=JSON.parse(fs.readFileSync(file,"utf8"));}catch{}
  }
  save(){if(!this.file)return;fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+".tmp",JSON.stringify(this.saved),{mode:0o600});fs.renameSync(this.file+".tmp",this.file);}
  async request(route,{body,token}={}) {
    const r=await this.fetch(BASE+route,{method:body===undefined?"GET":"POST",redirect:"error",signal:AbortSignal.timeout(15000),headers:{accept:"application/json","content-type":"application/json","X-Sxm-Platform":"browser","X-Sxm-Tenant":"sxm",...(token?{Authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    for(const cookie of r.headers.getSetCookie?.()||[]){const m=cookie.match(/^sxm-refresh-token=([^;]+)/);if(m)this.saved.refreshToken=m[1];}
    if(!r.ok){const error=Error("SiriusXM on-demand returned HTTP "+r.status+".");error.statusCode=502;error.upstreamStatus=r.status;throw error;}
    return r.json();
  }
  async token(){
    if(this.saved.session?.accessToken && Date.parse(this.saved.session.accessTokenExpiresAt)>Date.now()+60000)return this.saved.session.accessToken;
    if(this.busy)return this.busy;
    if(Date.now()<this.retryAt)throw Error("SiriusXM sign-in failed. Wait a minute before trying again.");
    this.busy=(async()=>{
      let session;
      if(this.saved.refreshToken)try{session=await this.request("session/v1/sessions/refresh",{token:this.saved.refreshToken,body:{}});}catch(e){if(![401,403,400].includes(e.upstreamStatus))throw e;}
      if(session?.sessionType!=="authenticated"){
        const login=this.getCredentials();
        const device=await this.request("device/v2/devices",{body:{devicePlatform:"web-desktop",deviceAttributes:{browser:{app:"web-player",appVersion:"7.136.0",userAgent:"Rabbit Hole"}},grantVersion:"v2",tenant:"sxm"}});
        const anon=await this.request("session/v1/sessions/anonymous",{token:device.grant,body:{}});
        await this.request("identity/v1/identities/status?handle="+encodeURIComponent(login.handle),{token:anon.accessToken});
        const grant=await this.request("identity/v1/identities/authenticate/password",{token:anon.accessToken,body:login});
        session=await this.request("session/v1/sessions/authenticated",{token:grant.grant,body:true});
      }
      if(session?.sessionType!=="authenticated"||!session.accessToken)throw Error("SiriusXM has not authorized on-demand playback.");
      this.saved.session=session;this.save();return session.accessToken;
    })().catch(e=>{this.retryAt=Date.now()+60000;throw e;}).finally(()=>{this.busy=null;});
    return this.busy;
  }
  async api(route,body){return this.request(route,{body,token:await this.token()});}
  remember(items){const result=items.map(normalize);for(const item of result){const old=this.saved.items[item.type+":"+item.id];if(old?.showTitle)item.showTitle=old.showTitle;if(!item.artwork && old?.artwork?.startsWith("https://imgsrv-sxm-prod-device.streaming.siriusxm.com/"))item.artwork=old.artwork;this.saved.items[item.type+":"+item.id]=item;}this.save();return result;}
  get(type,id){if(!TYPES.has(type)||!/^[a-zA-Z0-9-]{1,120}$/.test(id||""))throw Error("Invalid SiriusXM entity.");const item=this.saved.items[type+":"+id];if(!item)throw Error("Search for this SiriusXM show or episode first.");return item;}
  async search(query){query=String(query||"").trim();if(!query||query.length>200)throw Error("Enter a show name (up to 200 characters).");return this.remember(entities(await this.api("search/v1/search",{searchString:query})));}
  async episodes(type,id){this.get(type,id);if(!["show","show-podcast"].includes(type))throw Error("Choose a show to browse episodes.");
    const data=await this.api("page/v1/page/"+type+"/"+id);
    const containers=data.page?.containers||[];
    const urls=containers.map(c=>c.url).filter(u=>typeof u==="string"&&/container\/aod(?:\?|$)/.test(u));
    const items=[];
    for(const url of urls){const u=new URL(url,BASE);if(u.origin!==new URL(BASE).origin||!u.pathname.startsWith("/relationship/v1/container/"))throw Error("Unsupported SiriusXM catalog URL.");items.push(...entities(await this.api(u.pathname.slice(1)+u.search)));}
    const result=this.remember(items);const show=this.get(type,id);for(const item of result){item.showTitle=show.title;item.artwork ||= show.artwork;}this.save();return result;
  }
  async channelShows(id){
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id||""))throw Error("Exact SiriusXM channel identity unavailable.");
    const page=await this.api("page/v1/page/channel-linear/"+id);
    const containers=(page.page?.containers||[]).filter(c=>typeof c.url==="string"&&/container\/shows-podcasts(?:\?|$)/.test(c.url));
    const items=[];
    for(const c of containers){const url=new URL(c.url,BASE);if(url.origin!==new URL(BASE).origin||!/^\/(recommender|relationship)\/v1\/container\/shows-podcasts$/.test(url.pathname)||url.searchParams.get("entityId")!==id)throw Error("Unexpected channel show-list identity.");
      items.push(...entities(await this.api(url.pathname.slice(1)+url.search)).filter(i=>["show","show-podcast"].includes(i.entity.type)));
    }
    return this.remember([...new Map(items.map(i=>[i.entity.type+":"+i.entity.id,i])).values()]);
  }
  async tune(type,id){const item=this.get(type,id);if(!item.playable)throw Error("This episode is not available for playback on your account.");const key=type+":"+id,previous=this.tunes.get(key);if(previous&&previous.until>Date.now())return previous.promise;
    const entry={until:Date.now()+60000,promise:this.api("playback/play/v1/tuneSource",{id,type,hlsVersion:"V3",manifestVariant:"FULL",mtcVersion:"V2"})};this.tunes.set(key,entry);
    try{const result=await entry.promise;const expires=Date.parse(result.streams?.[0]?.urls?.[0]?.validUntil);entry.until=Math.min(Date.now()+300000,Number.isFinite(expires)?expires-60000:Date.now()+60000);return result;}catch(e){this.tunes.delete(key);throw e;}
  }
}
module.exports={SiriusXmOnDemand,entities,normalize};
