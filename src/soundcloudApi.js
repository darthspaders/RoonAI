"use strict";
const {SoundCloudClient}=require("./soundcloudClient");
function createSoundCloudApi({readJson,sendJson,items,client=new SoundCloudClient()}){
  return async(req,res,url)=>{
    const route=url.pathname.slice("/api/soundcloud/".length);
    const body=req.method==="POST"?await readJson(req):Object.fromEntries(url.searchParams);
    if(req.method==="GET" && route==="status")return sendJson(res,200,client.status());
    if(req.method==="POST" && route==="connect")return sendJson(res,200,client.begin());
    if(req.method==="GET" && route==="callback"){
      await client.callback(body.state,body.code);res.writeHead(303,{Location:"/soundcloud-setup.html?connected=1","Cache-Control":"no-store"});return res.end();
    }
    if(req.method==="GET" && route==="playlists")return sendJson(res,200,{playlists:await client.list()});
    if(req.method==="GET" && route==="search")return sendJson(res,200,{tracks:await client.search(body.q)});
    if(req.method==="GET" && route==="playlist"){
      const p=body.playlistId?{urn:body.playlistId}:await client.find(body.title || "Synapse Finds");
      return sendJson(res,200,p?await client.details(p.urn):{playlist:null,tracks:[]});
    }
    if(req.method==="POST" && route==="playlists/create")return sendJson(res,200,await client.create(body.title,body.sharing));
    if(req.method==="POST" && ["playlists/add","playlists/remove"].includes(route)){
      let tracks=body.tracks || [];
      if(!Array.isArray(tracks))throw Error("tracks must contain exact identifiers.");
      if(body.referenceIds){if(!Array.isArray(body.referenceIds))throw Error("referenceIds must be an array.");tracks=[...tracks,...body.referenceIds.map(id=>{const item=items.get(id);if(!item.soundcloudUrn)throw Error("Discovery is not an exact SoundCloud track.");return item.soundcloudUrn;})];}
      if(body.recentCount){
        if(route.endsWith("remove"))throw Error("Remove requires explicit exact tracks, not recent discoveries.");
        const count=Number(body.recentCount);if(!Number.isInteger(count)||count<1||count>100)throw Error("recentCount must be 1–100.");
        const recent=items.recent(count,"SoundCloud").filter(t=>t.soundcloudUrn);
        if(recent.length<count)throw Error(`Only ${recent.length} exact recent SoundCloud discoveries are saved. Request that count explicitly or supply exact tracks.`);
        tracks=[...tracks,...recent.map(t=>t.soundcloudUrn)];
      }
      return sendJson(res,200,await client.update({playlistId:body.playlistId,title:body.title,tracks,createIfMissing:body.createIfMissing===true,remove:route.endsWith("remove")}));
    }
    return sendJson(res,404,{error:"Unknown SoundCloud action"});
  };
}
module.exports={createSoundCloudApi};
