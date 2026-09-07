"use strict";
const { parseTrackList, queueExactTracks } = require('./exactTrackVerification');
function queuePolicy(input = {}) {
  if (input.queuePolicy !== undefined && !['fast','strict'].includes(input.queuePolicy)) throw new Error('queuePolicy must be fast or strict.');
  if (input.verifyBeforeQueue !== undefined && typeof input.verifyBeforeQueue !== 'boolean') throw new Error('verifyBeforeQueue must be boolean.');
  if (input.queuePolicy && input.verifyBeforeQueue !== undefined && (input.queuePolicy === 'strict') !== input.verifyBeforeQueue) throw new Error('Conflicting queue policy parameters.');
  return input.queuePolicy || (input.verifyBeforeQueue === true ? 'strict' : 'fast');
}
class ExternalTrackQueue {
  constructor({ roon, verify, save, bridge }) { Object.assign(this,{roon,verify,save,bridge}); this.lastFailures=[]; this.tail=Promise.resolve(); }
  queue(input={}) {
    const work=this.tail.catch(()=>{}).then(()=>this.run(input)); this.tail=work.catch(()=>{}); return work;
  }
  async run(input) {
    const policy=queuePolicy(input);
    const tracks=input.retryFailures ? this.lastFailures.map(f=>({...f.track})) : parseTrackList(input.tracks);
    if (!tracks.length || tracks.length>500) throw new Error('Supply 1–500 tracks, or retry a saved failed batch.');
    if (input.retryFailures && input.tracks) throw new Error('Provide tracks or retryFailures, not both.');
    if (!input.zoneId) throw new Error('Select a Roon zone before queueing.');
    const queued=[],failed=[]; const size=policy==='fast'?50:40;
    for(let offset=0;offset<tracks.length;offset+=size) {
      const batch=tracks.slice(offset,offset+size);
      if(policy==='fast') {
        // Reuse the established bulk Roon implementation, including partial failure handling.
        const result=await this.roon.queueTracks(batch.map(track=>({...track,exactVerification:false})),input.zoneId,{mode:'append',targetCount:batch.length,preferExtendedMixes:false});
        queued.push(...result.queued.map(r=>({...r,index:offset+r.index})));
        failed.push(...result.failed.map(r=>({...r,index:offset+r.index,track:batch[r.index]})));
      } else {
        const verified=await this.verify({tracks:batch,zoneId:input.zoneId,checkRoon:false,max:40});
        for(const row of verified.tracks.filter(r=>!r.usable || !r.tidal?.verified)) failed.push({index:offset+row.index,track:batch[row.index],reason:row.error||row.status,status:row.status});
        if(verified.tracks.some(r=>r.usable && r.tidal?.verified)) {
          const result=await queueExactTracks(verified,{
            zoneId:input.zoneId,
            allowBridge:input.allowBridge !== false,
            bridgeSyncDelaysMs:input.bridgeSyncDelaysMs,
            bridgeLookupTimeoutMs:input.bridgeLookupTimeoutMs
          },this.roon,{save:this.save||(()=>{}),bridge:this.bridge});
          queued.push(...result.queuedTracks.map(r=>({...r,index:offset+r.index,track:batch[r.index]})));
          failed.push(...result.failedTracks.map(r=>({...r,index:offset+r.index,track:batch[r.index],reason:r.error})));
        }
      }
    }
    this.lastFailures=failed;
    return {queuePolicy:policy,verifyBeforeQueue:policy==='strict',requested:tracks.length,queued:queued.length,failed:failed.length,queuedCount:queued.length,failedCount:failed.length,queuedTracks:queued,failedTracks:failed};
  }
}
module.exports={ExternalTrackQueue,queuePolicy};
