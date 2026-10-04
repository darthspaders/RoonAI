"use strict";
const $=id=>document.getElementById(id);
async function call(action,post=false){const r=await fetch('/api/siriusxm/account/'+action,post?{method:'POST',headers:{'content-type':'application/json'},body:'{}'}:{});const d=await r.json();if(!r.ok)throw Error(d.error||'Connection failed');return d;}
function show(s){$('status').textContent=s.message||(s.connected?'SiriusXM connected. Ready to verify live metadata.':s.pending?'Waiting for authorization on SiriusXM.':'Not connected.');$('start').disabled=s.connected;if(s.connected)$('check').hidden=true;}
$('start').onclick=async()=>{try{$('start').disabled=true;const d=await call('start',true);$('code').textContent='Activation code: '+d.userCode;$('authorize').href=d.authorizationUrl;$('authorize').hidden=false;$('check').hidden=false;$('status').textContent='Authorize on SiriusXM, then return here and check the connection.';}catch(e){$('status').textContent=e.message;}finally{$('start').disabled=false;}};
$('check').onclick=async()=>{try{$('check').disabled=true;show(await call('check',true));}catch(e){$('status').textContent=e.message;}finally{$('check').disabled=false;}};
call('status').then(show).catch(e=>$('status').textContent=e.message);
