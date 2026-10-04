"use strict";
function readSiriusXmPage(doc,href,now=Date.now()){
 const u=new URL(href);if(u.origin!=='https://www.siriusxm.com'||!/^\/player\/channel-linear\/[^/]+\/[a-f0-9-]{36}$/.test(u.pathname))return null;
 const text=qa=>doc.querySelector('[data-qa="'+qa+'"]')?.innerText?.trim()||'';
 const label=text('entity-header-on-now-title'),show=text('entity-header-on-now-show');
 const m=text('entity-header-subtitle').match(/\bCh\s+(\d+)\b/i);if(!m||!label)return null;
 return {url:u.origin+u.pathname,channelNumber:Number(m[1]),label,show,observedAt:now};
}
if(typeof module!=='undefined')module.exports={readSiriusXmPage};
