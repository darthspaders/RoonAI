"use strict";

// Finish each small HLS resource before exposing it to the decoder. A slow
// player must not consume the upstream download deadline, and a broken segment
// must be retried before any partial bytes have reached FFmpeg.
async function readMediaResource(url, {fetchImpl=fetch, headers={}, timeoutMs=20000, maxBytes=8*1024*1024, attempts=3, onRetry=()=>{}}={}) {
  for(let attempt=1;attempt<=attempts;attempt++) {
    try {
      const response=await fetchImpl(url,{headers,redirect:"error",signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok) {
        await response.body?.cancel();
        const error=Error("SiriusXM media returned HTTP "+response.status);
        error.retryable=response.status===408 || response.status===429 || response.status>=500;
        throw error;
      }
      const reader=response.body.getReader(),chunks=[];let size=0;
      try {
        while(true) {
          const {value,done}=await reader.read();if(done)break;
          size+=value.length;
          if(size>maxBytes){const error=Error("Unexpected SiriusXM resource size.");error.retryable=false;throw error;}
          chunks.push(Buffer.from(value));
        }
      } catch(error) {await reader.cancel().catch(()=>{});throw error;}
      const length=response.headers.get("content-length");
      if(length!==null && !response.headers.get("content-encoding") && Number(length)!==size)throw Error("Incomplete SiriusXM media resource.");
      return {status:response.status,headers:response.headers,data:Buffer.concat(chunks,size)};
    } catch(error) {
      if(error.retryable===false || attempt===attempts)throw error;
      const code=error.cause?.code || error.code;
      onRetry({attempt,reason:error.name,...(typeof code==="string" && /^[A-Z0-9_]{1,40}$/.test(code)?{code}:{})});
      await new Promise(resolve=>setTimeout(resolve,attempt*250));
    }
  }
}
module.exports={readMediaResource};
