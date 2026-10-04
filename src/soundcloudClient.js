"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {soundcloudUrn}=require("./lyrionItems");
const API="https://api.soundcloud.com";
function playlistUrn(value){const m=String(value||"").match(/^(?:soundcloud:playlists:)?(\d+)$/);if(!m)throw Error("Supply an exact SoundCloud playlist URN or ID.");return `soundcloud:playlists:${m[1]}`;}
function compactPlaylist(p){return {urn:p.urn || playlistUrn(p.id),title:p.title,url:p.permalink_url,sharing:p.sharing,trackCount:p.track_count,userUrn:p.user?.urn || (p.user?.id?`soundcloud:users:${p.user.id}`:"")};}
function compactTrack(t){return {urn:t.urn || soundcloudUrn(t.id),title:t.title,artist:t.metadata_artist || t.user?.username || "",url:t.permalink_url,playableUrl:`soundcloud://${t.urn || soundcloudUrn(t.id)}`,duration:Number(t.duration||0)/1000};}
class SoundCloudClient {
  constructor({clientId=process.env.SOUNDCLOUD_CLIENT_ID||"",clientSecret=process.env.SOUNDCLOUD_CLIENT_SECRET||"",redirectUri=process.env.SOUNDCLOUD_REDIRECT_URI||"http://127.0.0.1:3777/api/soundcloud/callback",file=path.join(__dirname,"../data/soundcloud-auth.json"),fetchImpl=fetch,clock=Date.now}={}){
    Object.assign(this,{clientId,clientSecret,redirectUri,file,fetch:fetchImpl,clock});this.tokens={};this.states=new Map();this.serial=Promise.resolve();this.refreshing=null;
    if(file){try{this.tokens=JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){if(e.code!=="ENOENT")throw Error("Cannot read saved SoundCloud connection. File preserved.");}}
  }
  status(){return {configured:!!(this.clientId && this.clientSecret),connected:!!this.tokens.access_token,redirectUri:this.redirectUri,defaultPlaylist:"Synapse Finds",setupUrl:"/soundcloud-setup.html",account:this.tokens.account || null};}
  persist(tokens){this.tokens=tokens;if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(`${this.file}.tmp`,JSON.stringify(tokens),{mode:0o600});fs.renameSync(`${this.file}.tmp`,this.file);}}
  begin(){
    if(!this.status().configured)throw Error("Configure SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET locally, then restart Rabbit Hole. See /soundcloud-setup.html.");
    for(const [key,value] of this.states)if(value.expires<this.clock())this.states.delete(key);
    if(this.states.size>=10)throw Error("Too many pending SoundCloud connections. Try again in ten minutes.");
    const state=crypto.randomBytes(24).toString("base64url"),verifier=crypto.randomBytes(48).toString("base64url");
    this.states.set(state,{verifier,expires:this.clock()+600000});
    const url=new URL("https://secure.soundcloud.com/authorize");url.search=new URLSearchParams({client_id:this.clientId,redirect_uri:this.redirectUri,response_type:"code",state,code_challenge:crypto.createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
    return {authorizationUrl:url.href,expiresIn:600};
  }
  async fetchWithDnsRetry(url,options){
    for(let attempt=0;attempt<3;attempt++){
      try{return await this.fetch(url,options);}catch(error){
        // DNS failure happens before connecting; never retry uncertain token exchanges or writes.
        if(error.cause?.code!=="EAI_AGAIN" || attempt===2)throw error;
        await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
      }
    }
  }
  async tokenRequest(params){
    let response;
    try{response=await this.fetchWithDnsRetry("https://secure.soundcloud.com/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,...params}),signal:AbortSignal.timeout(20000),redirect:"error"});}catch(error){throw Error(`Cannot reach SoundCloud authorization (${error.cause?.code || "network error"}). Open /soundcloud-setup.html and connect again; the previous callback cannot be reused.`);}
    const result=await response.json();if(!response.ok || !result.access_token)throw Error(`SoundCloud authorization failed (${response.status}). Reconnect from SoundCloud setup.`);
    return {...result,expiresAt:this.clock()+(Number(result.expires_in)||3600)*1000};
  }
  async callback(state,code){
    const pending=this.states.get(state);this.states.delete(state);
    if(!pending || pending.expires<this.clock() || !code)throw Error("SoundCloud connection expired or invalid. Start again.");
    this.persist(await this.tokenRequest({grant_type:"authorization_code",code,code_verifier:pending.verifier,redirect_uri:this.redirectUri}));
    const me=await this.request("/me");this.persist({...this.tokens,account:{urn:me.urn||`soundcloud:users:${me.id}`,username:me.username}});
    return this.status();
  }
  async accessToken(){
    if(!this.tokens.access_token)throw Error("Connect SoundCloud first at /soundcloud-setup.html. Lyrion playback remains available.");
    if(this.tokens.expiresAt>this.clock()+60000)return this.tokens.access_token;
    if(!this.tokens.refresh_token)throw Error("Reconnect SoundCloud: refresh token unavailable.");
    if(!this.refreshing)this.refreshing=(async()=>{const next=await this.tokenRequest({grant_type:"refresh_token",refresh_token:this.tokens.refresh_token});this.persist({...next,account:this.tokens.account});})().finally(()=>{this.refreshing=null;});
    await this.refreshing;return this.tokens.access_token;
  }
  async request(route,{method="GET",body,redirects=0}={}){
    const url=new URL(route,API);
    if(url.origin!==API || url.username || url.password)throw Error("Invalid SoundCloud API page URL.");
    const token=await this.accessToken();
    let response;
    try{response=await this.fetchWithDnsRetry(url,{method,headers:{Authorization:`OAuth ${token}`,accept:"application/json",...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000),redirect:"manual"});}
    catch{throw Error(method==="GET"?"SoundCloud request unavailable.":"SoundCloud write outcome is uncertain. Read the playlist before retrying; no automatic write retry was made.");}
    if(method==="GET" && [301,302,303,307,308].includes(response.status)){
      if(redirects>=3 || !response.headers.get("location"))throw Error("Invalid SoundCloud redirect.");
      return this.request(new URL(response.headers.get("location"),url).href,{redirects:redirects+1});
    }
    if(!response.ok)throw Error(`SoundCloud returned ${response.status}${response.status===401?"; reconnect your account":""}. ${method!=="GET"?"Check the playlist before retrying.":""}`);
    if(response.status===204)return {};
    return response.json();
  }
  async all(route){
    const items=[],seen=new Set();let next=route;
    while(next){if(seen.has(next)||seen.size>=100)throw Error("SoundCloud pagination incomplete; refusing to use a partial playlist.");seen.add(next);
      const page=await this.request(next);items.push(...(Array.isArray(page)?page:page.collection||[]));next=Array.isArray(page)?null:page.next_href;
    }return items;
  }
  async list(){return (await this.all("/me/playlists?show_tracks=false&linked_partitioning=true&limit=200")).map(compactPlaylist);}
  async search(query){
    if(typeof query!=="string"||!query.trim()||query.length>300)throw Error("Enter a SoundCloud search of 1–300 characters.");
    const page=await this.request(`/tracks?q=${encodeURIComponent(query.trim())}&limit=12&linked_partitioning=true`);
    return (Array.isArray(page)?page:page.collection||[]).map(compactTrack).filter(t=>t.urn);
  }
  async find(title="Synapse Finds"){
    const matches=(await this.list()).filter(p=>p.title?.trim().toLowerCase()===title.trim().toLowerCase());
    if(matches.length>1)throw Error("Multiple SoundCloud playlists have that name. Choose an exact playlist URN.");return matches[0] || null;
  }
  exclusive(fn){const next=this.serial.then(fn);this.serial=next.catch(()=>{});return next;}
  async create(title="Synapse Finds",sharing="private"){
    if(typeof title!=="string" || !title.trim() || title.length>200 || !["private","public"].includes(sharing))throw Error("Invalid playlist title or sharing setting.");
    return this.exclusive(async()=>{const existing=await this.find(title);if(existing)return {playlist:existing,created:false};
      return {playlist:compactPlaylist(await this.request("/playlists",{method:"POST",body:{playlist:{title:title.trim(),sharing,tracks:[]}}})),created:true};});
  }
  async details(id){
    const urn=playlistUrn(id),raw=await this.request(`/playlists/${encodeURIComponent(urn)}?show_tracks=false`);
    const tracks=await this.all(`/playlists/${encodeURIComponent(urn)}/tracks?linked_partitioning=true&limit=200`);
    if(Number.isFinite(Number(raw.track_count)) && Number(raw.track_count)!==tracks.length)throw Error("SoundCloud returned an incomplete playlist. Refusing a replacement that could drop tracks.");
    const compact=tracks.map(compactTrack);if(compact.some(t=>!t.urn))throw Error("Playlist has an unavailable track identity; refusing to modify it.");
    return {playlist:compactPlaylist(raw),tracks:compact};
  }
  async resolve(value){
    const urn=soundcloudUrn(value);if(urn)return urn;
    let url;try{url=new URL(value);}catch{throw Error("Supply an exact SoundCloud track URN, numeric ID, playable URL, or permalink.");}
    if(!["soundcloud.com","www.soundcloud.com"].includes(url.hostname) || !["https:","http:"].includes(url.protocol) || url.username || url.password)throw Error("Only exact SoundCloud permalinks are supported; no artist/title matching.");
    const resource=await this.request(`/resolve?url=${encodeURIComponent(url.href)}`);
    const resolved=soundcloudUrn(resource.urn || resource.id);if(resource.kind!=="track" || !resolved)throw Error("That SoundCloud URL is not a track.");return resolved;
  }
  async update({playlistId,title="Synapse Finds",tracks,remove=false,createIfMissing=false}){
    if(!Array.isArray(tracks)||!tracks.length||tracks.length>100)throw Error("Supply 1–100 exact SoundCloud tracks.");
    if(typeof title!=="string" || !title.trim() || title.length>200)throw Error("Invalid playlist title.");
    const urns=[...new Set(await Promise.all(tracks.map(t=>this.resolve(t))))];
    return this.exclusive(async()=>{
      let p=playlistId?{urn:playlistUrn(playlistId)}:await this.find(title);
      let created=false;
      if(!p){
        if(!createIfMissing || remove)throw Error("Playlist not found. Use createIfMissing only when creation is requested.");
        p=compactPlaylist(await this.request("/playlists",{method:"POST",body:{playlist:{title,sharing:"private",tracks:urns.map(urn=>({urn}))}}}));
        return {playlist:p,created:true,changed:urns.length,duplicateCount:0};
      }
      const before=await this.details(p.urn);const me=await this.request("/me");
      if(before.playlist.userUrn!==(me.urn||`soundcloud:users:${me.id}`))throw Error("This playlist is not owned by the connected SoundCloud account.");
      const existing=before.tracks.map(t=>t.urn),set=new Set(urns);
      const next=remove?existing.filter(id=>!set.has(id)):[...existing,...urns.filter(id=>!existing.includes(id))];
      const changed=Math.abs(next.length-existing.length);
      if(!changed)return {...before,created,changed:0,duplicateCount:remove?0:urns.length};
      // Check again immediately before replacing the list; preserve concurrent external edits.
      const check=await this.details(p.urn);
      if(JSON.stringify(check.tracks.map(t=>t.urn))!==JSON.stringify(existing))throw Error("Playlist changed while preparing the edit. Read it again before retrying.");
      await this.request(`/playlists/${encodeURIComponent(p.urn)}`,{method:"PUT",body:{playlist:{tracks:next.map(urn=>({urn}))}}});
      const after=await this.details(p.urn);
      if(JSON.stringify(after.tracks.map(t=>t.urn))!==JSON.stringify(next))throw Error("Playlist changed during the update. Inspect its current contents before retrying.");
      return {...after,created,changed,duplicateCount:remove?0:urns.length-changed};
    });
  }
}
module.exports={SoundCloudClient,playlistUrn};
