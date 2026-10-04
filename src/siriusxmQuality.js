"use strict";
function safeUrl(value) {
  const u=new URL(value);
  if(u.protocol!=="https:"||u.username||u.password||u.port||!(u.hostname.endsWith(".streaming.siriusxm.com")||u.hostname==="api.edge-gateway.siriusxm.com"))throw Error("Unsupported SiriusXM media host.");
  return u;
}
function highestVariant(text,base) {
  const lines=text.split(/\r?\n/);const variants=[];
  for(let i=0;i<lines.length;i++){
    if(!lines[i].startsWith("#EXT-X-STREAM-INF:"))continue;
    const attributes=lines[i].slice(18);
    // AUDIO-only variants: do not accidentally select a video rendition.
    if(/(?:^|,)RESOLUTION=/.test(attributes))continue;
    const bandwidth=Number(attributes.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1]);
    const average=Number(attributes.match(/(?:^|,)AVERAGE-BANDWIDTH=(\d+)/)?.[1])||bandwidth;
    let j=i+1;while(j<lines.length&&!lines[j].trim())j++;
    if(bandwidth>0 && lines[j] && !lines[j].startsWith("#"))variants.push({url:safeUrl(new URL(lines[j].trim(),base).href).href,bitrate:average,bandwidth});
  }
  variants.sort((a,b)=>b.bitrate-a.bitrate||b.bandwidth-a.bandwidth);
  if(!variants.length && text.includes("#EXT-X-STREAM-INF:"))throw Error("No supported SiriusXM audio rendition.");
  return variants[0]||{url:safeUrl(base).href,bitrate:null};
}
async function highestStream(url,catalog) {
  const u=safeUrl(url);const headers={};
  if(u.hostname==="api.edge-gateway.siriusxm.com")headers.Authorization="Bearer "+await catalog.token();
  const response=await catalog.fetch(u,{headers,redirect:"error",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error("SiriusXM quality lookup returned HTTP "+response.status);
  const text=await response.text();
  if(text.length>2*1024*1024||!text.startsWith("#EXTM3U"))throw Error("Unexpected SiriusXM audio manifest.");
  return highestVariant(text,u.href);
}
module.exports={highestVariant,highestStream};
