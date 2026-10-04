"use strict";
let pairing;
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message?.type!=='sxm-visible-metadata'||!sender.tab||!sender.url?.startsWith('https://www.siriusxm.com/player/'))return;
 (async()=>{
  pairing ||= await (await fetch(chrome.runtime.getURL('pairing.json'))).json();
  const r=await fetch('http://127.0.0.1:3777/api/siriusxm/browser/metadata',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+pairing.key},body:JSON.stringify(message.data),signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('Rabbit Hole returned '+r.status);
  await chrome.action.setBadgeText({text:'ON'});await chrome.action.setBadgeBackgroundColor({color:'#615078'});
  await chrome.action.setTitle({title:'Metadata sent: CH '+message.data.channelNumber+' · '+message.data.label});reply({ok:true});
 })().catch(async()=>{await chrome.action.setBadgeText({text:'!'});await chrome.action.setTitle({title:'Metadata not sent. Check Rabbit Hole is running on this computer.'});reply({ok:false});});
 return true;
});
