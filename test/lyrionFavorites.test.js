"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {LyrionFavorites}=require("../src/lyrionFavorites");
const {LyrionClient}=require("../src/lyrionClient");
const {createLyrionApi}=require("../src/lyrionApi");
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lyrion-favorites-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,"favorites.json");}
test("channel favorites survive restarts, deduplicate, and remove without touching other channels",t=>{
 const file=fixture(t),store=new LyrionFavorites(file);assert.deepEqual(store.list(),[]);
 store.add({url:"sxm:9472",title:"Diplo's Revolution"});store.add({url:"sxm:9527",title:"A State of Armin"});store.add({url:"sxm:9472",title:"Diplo's Revolution"});
 const reopened=new LyrionFavorites(file);assert.equal(reopened.list().length,2);assert.equal(reopened.get("sxm:9472").title,"Diplo's Revolution");
 reopened.remove("sxm:9472");assert.deepEqual(reopened.list().map(x=>x.id),["sxm:9527"]);
 assert.throws(()=>reopened.add({url:"http://localhost:9999/9472.m3u8"}),/Choose a SiriusXM/);
 fs.writeFileSync(file,"broken");assert.throws(()=>reopened.list(),/preserved/);assert.equal(fs.readFileSync(file,"utf8"),"broken");
});
test("only permanent SiriusXM plugin preset URLs become favorite actions",()=>{
 const c=new LyrionClient();const menu=c.menu({item_loop:[{text:"Channel",presetParams:{favorites_url:"sxm:42",favorites_title:"Channel 42"}},{text:"Track",presetParams:{favorites_url:"soundcloud:42"}}]},"p","SiriusXM");
 assert.equal(menu.items[0].favoriteId,"sxm:42");assert.equal(c.getAction(menu.items[0].actions.favorite,"p").action.channel.title,"Channel 42");assert.equal(menu.items[1].actions.favorite,undefined);
});
test("saved favorites play through the handoff using stable channel URLs, without live playback",async t=>{
 const file=fixture(t);new LyrionFavorites(file).add({url:"sxm:42",title:"Channel 42"});const calls=[];
 const api=createLyrionApi({favoritesFile:file,file:path.join(path.dirname(file),"selection.json"),roon:{getState:()=>({zones:[{zone_id:"r",state:"playing"}]}),control:async()=>calls.push("pause Roon")},client:{requirePlayer:async()=>{},rpc:async(p,cmd)=>calls.push(cmd)},readJson:async()=>({playerId:"p",id:"sxm:42"}),sendJson:()=>{}});
 await api.handle({method:"POST"},{},new URL("http://localhost/api/lyrion/favorites/play"));assert.deepEqual(calls,["pause Roon",["playlist","play","sxm:42","Channel 42"]]);
});
