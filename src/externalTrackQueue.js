"use strict";
const { parseTrackList, queueExactTracks } = require('./exactTrackVerification');
function queuePolicy(input = {}) {
  if (input.queuePolicy !== undefined && !['fast','strict'].includes(input.queuePolicy)) throw new Error('queuePolicy must be fast or strict.');
  if (input.verifyBeforeQueue !== undefined && typeof input.verifyBeforeQueue !== 'boolean') throw new Error('verifyBeforeQueue must be boolean.');
  if (input.queuePolicy && input.verifyBeforeQueue !== undefined && (input.queuePolicy === 'strict') !== input.verifyBeforeQueue) throw new Error('Conflicting queue policy parameters.');
  return input.queuePolicy || (input.verifyBeforeQueue === true ? 'strict' : 'fast');
}
class ExternalTrackQueue {
  constructor({ roon, verify, save, bridge, logger, diagnostics = false }) { Object.assign(this,{roon,verify,save,bridge,logger,diagnostics}); this.lastFailures=[]; this.tail=Promise.resolve(); }
  queue(input={}) {
    const work=this.tail.catch(()=>{}).then(()=>this.run(input)); this.tail=work.catch(()=>{}); return work;
  }
  async run(input) {
    const policy=queuePolicy(input);
    const mode=input.mode || 'append';
    if (!['append','next'].includes(mode)) throw new Error('mode must be append or next.');
    if (input.diagnostics !== undefined && typeof input.diagnostics !== 'boolean') throw new Error('diagnostics must be boolean.');
    const diagnostics=this.diagnostics || input.diagnostics === true;
    const logger=entry=>{ if (diagnostics && typeof this.logger === 'function') { try { this.logger(entry); } catch {} } };
    if (input.retryFailures && this.lastFailures.some(row=>row.queueOutcomeUncertain || row.queueAttemptedAt)) throw new Error('Previous queue action outcome is uncertain; inspect Roon before retrying supplied failures.');
    const tracks=input.retryFailures ? this.lastFailures.map(f=>({...f.track})) : parseTrackList(input.tracks);
    if (!tracks.length || tracks.length>500) throw new Error('Supply 1–500 tracks, or retry a saved failed batch.');
    if (input.retryFailures && input.tracks) throw new Error('Provide tracks or retryFailures, not both.');
    if (!input.zoneId) throw new Error('Select a Roon zone before queueing.');
    const queued=[],failed=[],warnings=[]; const size=policy==='fast'?50:40;
    let resolvedCount=0,tidalVerifiedCount=0;
    const chunks=[];
    for(let offset=0;offset<tracks.length;offset+=size) chunks.push(tracks.slice(offset,offset+size).map((track,index)=>({track,index:offset+index})));
    if (mode === 'next') chunks.reverse();
    logger({event:'supplied_queue_start',requestedMode:mode,effectiveMode:mode,queuePolicy:policy,requestedCount:tracks.length});
    for(const indexed of chunks) {
      const batch=indexed.map(entry=>entry.track);
      logger({event:'supplied_queue_batch',requestedMode:mode,effectiveMode:mode,queuePolicy:policy,offset:indexed[0].index,batchSize:batch.length});
      if(policy==='fast') {
        // Reuse the established bulk Roon implementation, including partial failure handling.
        const result=await this.roon.queueTracks(batch.map(track=>({...track,exactVerification:false})),input.zoneId,{mode,targetCount:batch.length,preferExtendedMixes:false,requireNextAction:mode==='next'});
        const execution=mode==='next'?indexed.slice().reverse():indexed;
        queued.push(...result.queued.map(r=>({...r,index:execution[r.index].index})));
        failed.push(...result.failed.map(r=>({...r,index:execution[r.index].index,track:execution[r.index].track})));
        resolvedCount+=result.queued.length+result.failed.filter(row=>row.resolved).length;
        if(result.warning) warnings.push(result.warning);
      } else {
        const verified=await this.verify({tracks:batch,zoneId:input.zoneId,checkRoon:false,max:40,diagnostics});
        const verifiedCount=verified.tracks.filter(row=>row.tidal?.verified).length;
        tidalVerifiedCount+=verifiedCount; resolvedCount+=verifiedCount;
        for(const row of verified.tracks.filter(r=>!r.usable || !r.tidal?.verified)) failed.push({index:indexed[row.index].index,track:batch[row.index],reason:row.error||row.status,status:row.status,reasons:row.reasons||[],identityOutcome:row.identityOutcome||row.status,identityDiagnostics:row.identityDiagnostics||null,versionExact:Boolean(row.versionExact),confidence:row.confidence||0});
        if(verified.tracks.some(r=>r.usable && r.tidal?.verified)) {
          const result=await queueExactTracks(verified,{
            zoneId:input.zoneId,
            mode,
            allowBridge:input.allowBridge !== false,
            bridgeSyncDelaysMs:input.bridgeSyncDelaysMs,
            bridgeLookupTimeoutMs:input.bridgeLookupTimeoutMs
          },this.roon,{save:this.save||(()=>{}),bridge:this.bridge,logger});
          queued.push(...result.queuedTracks.map(r=>({...r,index:indexed[r.index].index,track:batch[r.index]})));
          failed.push(...result.failedTracks.map(r=>({...r,index:indexed[r.index].index,track:batch[r.index],reason:r.error})));
          if(result.warning) warnings.push(result.warning);
        }
      }
    }
    queued.sort((a,b)=>a.index-b.index); failed.sort((a,b)=>a.index-b.index);
    this.lastFailures=failed;
    logger({event:'supplied_queue_complete',requestedMode:mode,effectiveMode:mode,queuePolicy:policy,resolvedCount,queuedCount:queued.length,failedCount:failed.length});
    return {mode,requestedMode:mode,effectiveMode:mode,queuePolicy:policy,verifyBeforeQueue:policy==='strict',requested:tracks.length,resolved:resolvedCount,resolvedCount,resolutionScope:policy==='strict'?'tidal-verified':'roon-queue-action',tidalVerifiedCount,tidalVerificationPerformed:policy==='strict',queued:queued.length,failed:failed.length,queuedCount:queued.length,failedCount:failed.length,queuedTracks:queued,failedTracks:failed,warnings:[...new Set(warnings)],warning:[...new Set(warnings)].join(' ')};
  }
}
module.exports={ExternalTrackQueue,queuePolicy};
