"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
function soundcloudUrn(value="") {
  const match=String(value).match(/^(?:soundcloud:\/\/)?(?:soundcloud:tracks:)?(\d+)$/);
  return match ? `soundcloud:tracks:${match[1]}` : "";
}
class LyrionItems {
  constructor(file){this.file=file;this.items=[];if(file){try{this.items=JSON.parse(fs.readFileSync(file,"utf8"));if(!Array.isArray(this.items))throw Error("Invalid item store");}catch(e){if(e.code!=="ENOENT")throw e;}}}
  save(){if(!this.file)return;fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(`${this.file}.tmp`,JSON.stringify(this.items));fs.renameSync(`${this.file}.tmp`,this.file);}
  remember(item){
    if(!item.url)return item;
    const found=this.items.find(i=>i.url===item.url && i.source===item.source);
    const saved={...item,referenceId:found?.referenceId || crypto.randomUUID(),discoveredAt:new Date().toISOString()};
    delete saved.actions;
    this.items=[saved,...this.items.filter(i=>i.referenceId!==saved.referenceId)].slice(0,2000);this.save();
    return {...item,referenceId:saved.referenceId};
  }
  get(id){const item=this.items.find(i=>i.referenceId===id);if(!item)throw Error("Exact discovery not found. Supply the original track URN/URL or browse again; do not rematch by title.");return item;}
  recent(count=10,source=""){return this.items.filter(i=>!source || i.source.toLowerCase()===source.toLowerCase()).slice(0,Math.max(1,Math.min(100,count)));}
}
module.exports={LyrionItems,soundcloudUrn};
