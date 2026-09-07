'use strict';
const {identity}=require('./directRoonQueue');

async function resolveKnown(requested,{knownTracks,tidal}) {
 requested={...requested,tidalTrackId:String(requested.tidalTrackId||requested.tidal?.id||requested.id||'')};
 let known=knownTracks().find(t=>identity(requested,{...t,tidalTrackId:String(t.tidalTrackId||t.id||'')},'strict').accepted);
 if(!known&&requested.tidalTrackId){
  const detail=await tidal.getTrack(requested.tidalTrackId);
  if(detail?.artist&&detail?.title&&identity(requested,{...detail,tidalTrackId:String(detail.id)},'strict').accepted)known=detail;
  else return {error:{success:false,failureType:'version_mismatch',reason:'The supplied TIDAL ID does not confirm the requested artist/title/version; bridge not modified.'}};
 }
 if(!known)return {error:{success:false,failureType:requested.tidalTrackId||requested.isrc?'roon_catalog_missing':'not_found',reason:'Direct and album lookup failed; no matching saved exact TIDAL identity is available for the bridge.'}};
 const id=String(known.tidalTrackId||known.id||'');
 if(!id)return {error:{success:false,failureType:'roon_catalog_missing',reason:'Exact identity has no TIDAL track ID for bridge insertion.'}};
 return {known:{...known,id,tidalTrackId:id}};
}

function decorateResult(requested,known,resolved,policy) {
 return {...resolved,identityEvidence:resolved.identityEvidence||identity(requested,resolved.match,'strict'),resolutionMethod:'exact_tidal_bridge',bridge:{playlistId:resolved.playlistId,tidalTrackId:known.id,reused:true,sync:resolved.sync||null},policy};
}

function createDirectBridge(deps) {
 const {bridge}=deps;
 return async (requested,zoneId,mode,policy,options={})=>{
  const prepared=await resolveKnown(requested,deps);
  if(prepared.error)return prepared.error;
  try{
   const resolved=await bridge.resolve({track:prepared.known,tidal:{verified:true},roon:{zoneId}}, {zoneId,mode,requireExisting:true,...options});
   return decorateResult(requested,prepared.known,resolved,policy);
  }catch(error){return {success:false,failureType:'bridge_resolution_failed',reason:error.message,resolutionMethod:'exact_tidal_bridge',bridge:{tidalTrackId:prepared.known.id,sync:error.bridgeSync||null,requiresManualRefresh:Boolean(error.bridgeSync?.requiresManualRefresh)}};}
 };
}

function createDirectBridgeBatch(deps) {
 const {bridge}=deps;
 return async (entries=[],zoneId,options={})=>{
  const prepared=[];
  const failures=[];
  for(const entry of entries){
   const item=await resolveKnown(entry.track,deps);
   if(item.error) failures.push({...entry,result:item.error});
   else prepared.push({...entry,known:item.known});
  }
  if(!prepared.length)return [...failures];
  if(!bridge.resolveBatch){
   const resolved=[];
   for(const entry of prepared) resolved.push({...entry,result:await bridge.resolve({track:entry.known,tidal:{verified:true},roon:{zoneId}}, {zoneId,mode:entry.mode||options.mode||'queue',requireExisting:true,...options})});
   return [...failures,...resolved.map(entry=>({...entry,result:decorateResult(entry.track,entry.known,entry.result,entry.policy)}))];
  }
  const batch=await bridge.resolveBatch(prepared.map(entry=>({track:entry.known,tidal:{verified:true},roon:{zoneId}})), {zoneId,mode:options.mode||'queue',requireExisting:true,...options});
  return [
   ...failures,
   ...prepared.map((entry,index)=>{
    const resolved=batch.results[index];
    return {...entry,result:resolved.success
     ? decorateResult(entry.track,entry.known,resolved,entry.policy)
     : {success:false,failureType:'bridge_resolution_failed',reason:resolved.reason,resolutionMethod:'exact_tidal_bridge',bridge:{playlistId:resolved.playlistId,tidalTrackId:entry.known.id,sync:resolved.sync||null,requiresManualRefresh:Boolean(resolved.sync?.requiresManualRefresh)}}};
   })
  ];
 };
}
module.exports={createDirectBridge,createDirectBridgeBatch};
