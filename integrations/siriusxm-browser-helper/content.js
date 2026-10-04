"use strict";
let lastUrl=location.href,settleUntil=Date.now()+3000;
function send(){
 if(location.href!==lastUrl){lastUrl=location.href;settleUntil=Date.now()+3000;return;}
 if(Date.now()<settleUntil)return;
 const data=readSiriusXmPage(document,location.href);
 if(data)chrome.runtime.sendMessage({type:'sxm-visible-metadata',data}).catch(()=>{});
}
// Read only rendered channel text. Never click Play or access cookies/storage.
setInterval(send,15000);setTimeout(send,3500);
