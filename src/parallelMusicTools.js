"use strict";
const definitions=require("./parallelMusicTools.json");
function validate(schema,value){
  if(schema.type==="object"){
    if(!value || typeof value!=="object" || Array.isArray(value))throw Error("Tool input must be an object.");
    for(const key of schema.required||[])if(value[key]===undefined)throw Error(`Missing ${key}`);
    for(const [key,item] of Object.entries(value)){if(!schema.properties[key])throw Error(`Unknown field: ${key}`);validate(schema.properties[key],item);}
  }else if(schema.type==="array"){
    if(!Array.isArray(value)||value.length>(schema.maxItems||100))throw Error("Invalid input array");for(const item of value)validate(schema.items,item);
  }else if(schema.type==="integer"){
    if(!Number.isInteger(value)||value<(schema.minimum??0)||value>(schema.maximum??1000000))throw Error("Invalid integer input");
  }else if(typeof value!==schema.type || (schema.minLength && value.length<schema.minLength) || (schema.enum && !schema.enum.includes(value)))throw Error("Invalid tool input");
}
function buildRequest(definition,input){
  validate(definition.inputSchema,input);
  const body={...input,...definition.defaults};let route=definition.path,method=definition.method;
  if(definition.name==="lyrion_browse" && !body.token && !body.source){route="/api/lyrion/sources";method="GET";}
  if(definition.name==="lyrion_playback")route=`/api/lyrion/${body.token || body.referenceId || body.soundcloudTrack?"queue":"control"}`;
  if(definition.name==="lyrion_playback" && body.action==="status"){route="/api/lyrion/status";method="GET";delete body.action;}
  if(method==="GET"){const query=new URLSearchParams(body).toString();return {route:route+(query?`?${query}`:""),options:{}};}
  return {route,options:{body}};
}
function createParallelMusicTools(request){return Object.fromEntries(definitions.map(d=>[d.name,{title:d.name.replaceAll("_"," "),description:d.description,inputSchema:d.inputSchema,annotations:d.annotations,handler:input=>{const {route,options}=buildRequest(d,input||{});return request(route,{...options,...(d.name==="lyrion_search"?{timeoutMs:180000}:/^\/api\/siriusxm\/ondemand\/(?:artist|xtra)\/play$/.test(route)?{timeoutMs:300000}:{})});}}]));}
module.exports={createParallelMusicTools,buildRequest};
