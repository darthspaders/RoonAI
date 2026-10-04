"use strict";
const fs=require('node:fs'),path=require('node:path');
const {SiriusXmBrowserRelay}=require('../src/siriusxmBrowserRelay');
const relay=new SiriusXmBrowserRelay(),root=path.join(__dirname,'..'),dest=path.join(root,'data/siriusxm-browser-helper');
fs.mkdirSync(dest,{recursive:true});
for(const name of ['manifest.json','reader.js','content.js','background.js'])fs.copyFileSync(path.join(root,'integrations/siriusxm-browser-helper',name),path.join(dest,name));
fs.writeFileSync(path.join(dest,'pairing.json'),JSON.stringify({key:relay.key}),{mode:0o600});
console.log('Load this folder as an unpacked extension in Chrome or Edge on the Rabbit Hole PC:\n'+dest);
