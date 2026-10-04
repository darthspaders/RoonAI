"use strict";
const fs=require("node:fs"),path=require("node:path");
const BASE="https://api.edge-gateway.siriusxm.com/";
class SiriusXmAccount {
 constructor({file=path.join(__dirname,"../data/siriusxm-account.json"),fetchImpl=fetch,clock=Date.now}={}){Object.assign(this,{file,fetch:fetchImpl,clock});this.saved={};this.pending=null;this.busy=null;this.refreshing=null;if(file&&fs.existsSync(file))this.saved=JSON.parse(fs.readFileSync(file,"utf8"));if(this.saved.pending?.expires>this.clock()){this.pending=this.saved.pending;this.pending.checking=false;}}
 save(){if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+".tmp",JSON.stringify({...this.saved,pending:this.pending}),{mode:0o600});fs.renameSync(this.file+".tmp",this.file);}}
 status(){return {connected:this.saved.session?.sessionType==="authenticated",expiresAt:this.saved.session?.accessTokenExpiresAt||null,pending:!!this.pending&&this.pending.expires>this.clock(),diagnostic:this.diagnostic||null,...(this.pending?.blocked?{blocked:true,message:this.pending.message}:{}),purpose:"Read live channel metadata only; Lyrion continues audio playback."};}
 async request(route,{token,body,cookies={}}={}){
  if(!new RegExp("^(device/v2/devices|session/v1/sessions/(anonymous|refresh)|session/v1/device-authorization/(user-codes/generate|sessions/create)|channel-guide/v1/channel/[a-f0-9-]+/peek)$").test(route))throw Error("Unsupported SiriusXM metadata operation.");
  let r;try{r=await this.fetch(BASE+route,{method:body===undefined?"GET":"POST",redirect:"error",signal:AbortSignal.timeout(12000),headers:{accept:"application/json",...(token?{Authorization:"Bearer "+token}:{}),...(body!==undefined?{"content-type":"application/json"}:{}),...(Object.keys(cookies).length?{Cookie:Object.entries(cookies).map(([k,v])=>k+"="+v).join("; ")}:{})},body:body===undefined?undefined:JSON.stringify(body)});}catch{throw Error("SiriusXM connection unavailable. Try again; playback is unchanged.");}
  const text=await r.text();let data={};try{data=JSON.parse(text);}catch{}
  // Preserve rotation even when the response is an error, as a browser does.
  for(const c of r.headers.getSetCookie?.()||[]){const pair=c.split(";")[0],i=pair.indexOf("=");if(i>0){const name=pair.slice(0,i);if(/;\s*max-age=0(?:;|$)/i.test(c)||!pair.slice(i+1))delete cookies[name];else cookies[name]=pair.slice(i+1);}}
  if(!r.ok){const e=Error("SiriusXM returned HTTP "+r.status);e.status=r.status;e.code=typeof data.code==="string"?data.code:typeof data.error==="string"?data.error:data.error?.code;this.diagnostic={route,status:r.status,code:typeof e.code==="string"&&/^[a-zA-Z0-9_.-]{1,160}$/.test(e.code)?e.code:null,at:new Date(this.clock()).toISOString()};console.warn("[SiriusXM connection]",JSON.stringify(this.diagnostic));throw e;}
  this.diagnostic=null;
  return data;
 }
 async begin(){if(this.busy)return this.busy;this.busy=this.start().finally(()=>this.busy=null);return this.busy;}
 async start(){
  if(this.status().connected)throw Error("SiriusXM is already connected.");
  if(this.pending&&this.pending.expires>this.clock())return this.pending.public;
  const cookies={};const device=await this.request("device/v2/devices",{body:{devicePlatform:"web-desktop",deviceAttributes:{browser:{app:"web-player",appVersion:"7.136.0",userAgent:"Rabbit Hole metadata connection"}},grantVersion:"v2",tenant:"sxm"},cookies});
  const session=await this.request("session/v1/sessions/anonymous",{token:device.grant,body:{},cookies});
  const code=await this.request("session/v1/device-authorization/user-codes/generate",{token:session.accessToken,body:{},cookies});
  const uri=new URL(code.verification_uri_complete||code.verification_uri);if(uri.protocol!=="https:"||!["siriusxm.com","www.siriusxm.com"].includes(uri.hostname))throw Error("Unexpected SiriusXM activation URL.");
  if(!code.device_code||!code.user_code)throw Error("SiriusXM did not return an activation code.");
  const expires=this.clock()+Math.min(Number(code.expires_in)||900,1800)*1000,interval=Math.max(5,Number(code.interval)||5);
  const display={userCode:code.user_code,authorizationUrl:uri.href,expiresAt:new Date(expires).toISOString(),interval};
  this.pending={session,cookies,deviceCode:code.device_code,expires,interval,nextPoll:0,public:display};this.save();return display;
 }
 async renew(session,cookies){
  const renewed=await this.request("session/v1/sessions/refresh",{token:session.refreshToken,body:{},cookies});
  if(!renewed.accessToken||!["anonymous","authenticated"].includes(renewed.sessionType))throw Error("SiriusXM session renewal was not accepted.");
  return renewed;
 }
 async check(){
  if(this.status().connected)return this.status();const p=this.pending;if(!p||p.expires<=this.clock()){this.pending=null;this.save();throw Error("Activation expired. Generate a new code.");}
  if(p.blocked)return this.status();
  if(p.checking||p.nextPoll>this.clock())return {...this.status(),message:p.message||"Waiting for authorization on SiriusXM."};p.nextPoll=this.clock()+p.interval*1000;p.checking=true;
  try{
   let renewed=false;
   if(Date.parse(p.session.accessTokenExpiresAt)<=this.clock()+30000){p.session=await this.renew(p.session,p.cookies);renewed=true;}
   const exchange=()=>this.request("session/v1/device-authorization/sessions/create",{token:p.session.accessToken,body:{deviceCode:p.deviceCode},cookies:p.cookies});
   let session;
   try{session=p.session.sessionType==="authenticated"?p.session:await exchange();}catch(e){
    // An unclassified 401 may be an expired access token, not a rejected code.
    if(e.status!==401||e.code||renewed)throw e;
    p.session=await this.renew(p.session,p.cookies);
    session=p.session.sessionType==="authenticated"?p.session:await exchange();
   }
   if(session.sessionType!=="authenticated"||!session.accessToken)throw Error("SiriusXM has not authorized this connection yet.");this.saved={session,cookies:p.cookies};this.pending=null;this.save();return this.status();
  }catch(e){if(["authorization_pending","slow_down","tokenServicesTeam.sessionService.authorization-pending"].includes(e.code)){if(e.code==="slow_down")p.interval+=5;p.message="Waiting for authorization on SiriusXM.";return {...this.status(),message:p.message};}
   if(e.code==="tokenServicesTeam.sessionService.invalid-refresh-token"){p.blocked=true;p.message="SiriusXM rejected this connection's refresh token after the session exchange failed. Further checks are stopped. Repeating activation has not resolved this issue.";return this.status();}
   if(e.status>=500 || e.status===429){p.nextPoll=this.clock()+30000;p.message="SiriusXM could not complete the session exchange. Activation is saved. Wait 30 seconds before checking again; another code is not needed while this one remains valid.";return {...this.status(),message:p.message,retryAfterSeconds:30};}
   if(e.status===401 || e.status===403){p.nextPoll=this.clock()+30000;p.message="SiriusXM rejected the session request. Activation is retained until expiry for diagnosis; reconnecting is not yet a verified fix.";return {...this.status(),message:p.message,retryAfterSeconds:30};}
   throw e;}finally{p.checking=false;this.save();}
 }
 async token(){
  if(!this.status().connected)throw Error("Connect SiriusXM at /siriusxm-setup.html.");
  if(Date.parse(this.saved.session.accessTokenExpiresAt)>this.clock()+60000)return this.saved.session.accessToken;
  if(!this.refreshing)this.refreshing=(async()=>{const session=await this.renew(this.saved.session,this.saved.cookies||{});if(session.sessionType!=="authenticated")throw Error("Reconnect SiriusXM: session renewal was not accepted.");this.saved.session=session;this.save();})().finally(()=>this.refreshing=null);
  await this.refreshing;return this.saved.session.accessToken;
 }
 async peek(id){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw Error("Exact SiriusXM channel entity ID required.");return this.request("channel-guide/v1/channel/"+id+"/peek",{token:await this.token()});}
}
module.exports={SiriusXmAccount};
