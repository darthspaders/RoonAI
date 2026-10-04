"use strict";
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn} = require("node:child_process");

function flacDuration(header) {
  if (header.length < 42 || header.subarray(0,4).toString() !== "fLaC" || (header[4] & 127) !== 0 || header.readUIntBE(5,3) !== 34) throw Error("Invalid completed SiriusXM FLAC.");
  const format = header.readBigUInt64BE(18);
  const rate = Number(format >> 44n), samples = Number(format & ((1n << 36n)-1n));
  if (!rate || !samples) throw Error("SiriusXM track decoder did not finalize its duration.");
  return {duration:samples/rate, samples, sampleRate:rate};
}
function validateDuration(actual, expected) {
  if (Number.isFinite(expected) && expected > 0 && actual.duration < expected - Math.max(2,expected*.01)) {
    const error = Error("SiriusXM track audio was incomplete.");
    error.details = {expectedSeconds:expected, decodedSeconds:Math.round(actual.duration*1000)/1000, samples:actual.samples};
    throw error;
  }
}
function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  let start, end;
  if (!match[1]) { const count=Number(match[2]); if (!Number.isSafeInteger(count) || count<=0) return false; start=Math.max(0,size-count); end=size-1; }
  else { start=Number(match[1]); end=match[2]?Math.min(Number(match[2]),size-1):size-1; }
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start>=0 && start<size && end>=start ? {start,end} : false;
}

// Artist/Xtra sources are individual finite tracks. Publish a completed file,
// not a new stream from position zero on each LMS probe/reconnect/seek.
class SiriusXmTrackAudio {
  constructor({directory=path.join(__dirname,"../data/siriusxm-audio-cache"), spawnImpl=spawn, maxTrackBytes=128*1024*1024, maxBytes=256*1024*1024, maxFiles=12, ttlMs=3600000, timeoutMs=120000, concurrency=2, attempts=2, onDiagnostic=()=>{}}={}) {
    Object.assign(this,{directory,spawnImpl,maxTrackBytes,maxBytes,maxFiles,ttlMs,timeoutMs,concurrency,attempts,onDiagnostic});
    this.entries=new Map(); this.pending=new Map(); this.busy=0; this.waiters=[]; this.initialized=null; this.publishing=Promise.resolve();
  }
  async initialize() {
    if (!this.initialized) this.initialized=(async()=>{
      await fsp.mkdir(this.directory,{recursive:true,mode:0o700});
      for (const name of await fsp.readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.flac$/.test(name) && !/^[a-f0-9]{64}\.\d+\.[a-f0-9-]+\.part$/.test(name)) continue;
        const file=path.join(this.directory,name), stat=await fsp.stat(file).catch(()=>null);
        if (!stat?.isFile()) continue;
        if (Date.now()-stat.mtimeMs>this.ttlMs || stat.size>this.maxTrackBytes || name.endsWith(".part")) { await fsp.unlink(file).catch(()=>{}); continue; }
        this.entries.set(name.slice(0,64),{file,size:stat.size,at:stat.mtimeMs,readers:0});
      }
      await this.prune();
    })();
    return this.initialized;
  }
  async prune(keep,{reserveBytes=0,reserveFiles=0}={}) {
    let total=reserveBytes+[...this.entries.values()].reduce((sum,e)=>sum+e.size,0), count=reserveFiles+this.entries.size;
    for (const [key,entry] of [...this.entries].sort((a,b)=>a[1].at-b[1].at)) {
      if (key===keep || entry.readers) continue;
      if (Date.now()-entry.at<=this.ttlMs && total<=this.maxBytes && count<=this.maxFiles) continue;
      try { await fsp.unlink(entry.file); this.entries.delete(key); total-=entry.size; count--; } catch {}
    }
  }
  async acquire() {
    if(this.busy<this.concurrency){this.busy++;return;}
    // A release transfers the already counted slot to this waiter. It cannot
    // be stolen by a newly arriving request before this promise resumes.
    await new Promise(resolve=>this.waiters.push(resolve));
  }
  release() { const next=this.waiters.shift(); if(next)next();else this.busy--; }
  withCacheLock(callback) {
    const operation=this.publishing.then(callback);
    this.publishing=operation.catch(()=>{});return operation;
  }
  async publish(key,part,file,size) {
    return this.withCacheLock(async()=>{
      await this.prune(undefined,{reserveBytes:size,reserveFiles:1});
      const total=[...this.entries.values()].reduce((sum,entry)=>sum+entry.size,0);
      if(total+size>this.maxBytes || this.entries.size+1>this.maxFiles)throw Error("SiriusXM audio cache limit is busy with active tracks.");
      await fsp.chmod(part,0o600); await fsp.rename(part,file);
      const entry={file,size,at:Date.now(),readers:0};this.entries.set(key,entry);return entry;
    });
  }
  async inspect(file, expected) {
    const handle=await fsp.open(file,"r");
    try { const header=Buffer.alloc(42); const read=await handle.read(header,0,header.length,0); const actual=flacDuration(header.subarray(0,read.bytesRead)); validateDuration(actual,expected); return actual; }
    finally { await handle.close(); }
  }
  async decode(input,file) {
    const args=["-hide_banner","-loglevel","warning","-nostdin","-y","-protocol_whitelist","http,https,tcp,tls,crypto","-allowed_extensions","ALL","-i",input,"-vn","-c:a","flac","-f","flac",file];
    return new Promise((resolve,reject)=>{
      let child, failure, settled=false;
      const stop=message=>{ failure ||= Error(message); try { child?.kill(); } catch {} };
      const finish=error=>{ if (settled) return; settled=true; clearTimeout(deadline); clearInterval(sizeCheck); error?reject(error):resolve(); };
      const deadline=setTimeout(()=>stop("SiriusXM track preparation timed out."),this.timeoutMs); deadline.unref?.();
      const sizeCheck=setInterval(()=>fsp.stat(file).then(stat=>{ if(stat.size>this.maxTrackBytes)stop("SiriusXM track exceeds the audio cache limit."); }).catch(()=>{}),250); sizeCheck.unref?.();
      try { child=this.spawnImpl(process.env.FFMPEG_PATH||"ffmpeg",args,{windowsHide:true,stdio:["ignore","ignore","pipe"]}); }
      catch { finish(Error("Could not start the SiriusXM track decoder.")); return; }
      // HLS can skip an unreadable segment and still exit zero. Reject that
      // decode before publishing it, even if its container looks valid.
      // Raw stderr can contain signed URLs and must never be logged or saved.
      let diagnosticTail="";
      child.stderr?.on("data",chunk=>{
        diagnosticTail=(diagnosticTail+chunk.toString()).slice(-4096);
        if(/Unable to open resource|Failed to open segment|HTTP error [45]\d\d|Error (?:when|while|during|opening)|Invalid data|Input\/output error|Connection (?:timed out|reset)|corrupt(?:ed)? (?:input|packet)/i.test(diagnosticTail))failure ||= Error("SiriusXM track decoder reported an audio error.");
      });
      child.once("error",()=>finish(Error("Could not start the SiriusXM track decoder.")));
      child.once("close",code=>finish(failure || (code ? Error("SiriusXM track decoder stopped before completion.") : null)));
    });
  }
  async get(key,{input,duration}={}) {
    if (!/^[a-f0-9]{64}$/.test(key||"")) throw Error("Invalid SiriusXM audio identity.");
    await this.initialize();
    const cached=await this.withCacheLock(async()=>{
      const entry=this.entries.get(key);
      if (!entry || (!entry.readers && Date.now()-entry.at>this.ttlMs))return null;
      try { const actual=await this.inspect(entry.file,duration); entry.at=Date.now();return {...entry,...actual}; }
      catch(error) {
        // Another consumer can still be playing this exact file. Invalidation
        // must not remove its entry/file while that read is in progress.
        if(entry.readers)throw error;
        await fsp.unlink(entry.file).catch(()=>{});this.entries.delete(key);return null;
      }
    });
    if(cached)return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size>=16) throw Error("Too many SiriusXM tracks are being prepared.");
    const promise=(async()=>{
      await this.acquire();
      const file=path.join(this.directory,key+".flac");
      try {
        for(let attempt=1;attempt<=this.attempts;attempt++) {
          const part=path.join(this.directory,key+"."+process.pid+"."+crypto.randomUUID()+".part");
          try {
            const source=typeof input==="function"?await input():input;
            await this.decode(source,part);
            const stat=await fsp.stat(part);
            if (stat.size>this.maxTrackBytes) throw Error("SiriusXM track exceeds the audio cache limit.");
            const actual=await this.inspect(part,duration);
            const entry=await this.publish(key,part,file,stat.size);
            this.onDiagnostic({kind:"ready",trackKey:key.slice(0,12),bytes:stat.size,...actual}); return {...entry,...actual};
          } catch(error) {
            await fsp.unlink(part).catch(()=>{});
            this.onDiagnostic({kind:"retry",trackKey:key.slice(0,12),attempt,reason:error.message,...error.details});
            if (attempt===this.attempts || /cache limit/.test(error.message)) throw error;
          }
        }
      } finally { this.release(); }
    })().finally(()=>this.pending.delete(key));
    this.pending.set(key,promise); return promise;
  }
  async open(key,options) {
    if(!/^[a-f0-9]{64}$/.test(key||""))throw Error("Invalid SiriusXM audio identity.");
    await this.initialize();
    for(let attempt=0;attempt<4;attempt++) {
      const acquired=await this.withCacheLock(async()=>{
        const entry=this.entries.get(key);
        if(!entry || (!entry.readers && Date.now()-entry.at>this.ttlMs))return null;
        // Pin before either await. Publication/pruning uses this same lock,
        // so it cannot evict the file between validation and opening it.
        entry.readers++;
        try {
          const actual=await this.inspect(entry.file,options.duration),handle=await fsp.open(entry.file,"r");entry.at=Date.now();
          let released=false;return {entry,actual,handle,release:()=>{if(!released){released=true;entry.readers--;}}};
        } catch(error) {
          entry.readers--;
          if(entry.readers)throw error;
          await fsp.unlink(entry.file).catch(()=>{});this.entries.delete(key);return null;
        }
      });
      if(acquired)return acquired;
      await this.get(key,options);
    }
    throw Error("SiriusXM audio cache limit is busy with active tracks.");
  }
  async serve(req,res,key,options) {
    const acquired=await this.open(key,options),entry=acquired.entry;
    const close=async()=>{try{await acquired.handle.close();}finally{acquired.release();}};
    if (res.destroyed) { await close();return; }
    const range=byteRange(req.headers.range,entry.size);
    const headers={"Content-Type":"audio/flac","Accept-Ranges":"bytes","Cache-Control":"private, no-store"};
    if (range===false) { await close();if(res.destroyed)return;res.writeHead(416,{...headers,"Content-Range":"bytes */"+entry.size}); res.end(); return; }
    if (range) { headers["Content-Range"]=`bytes ${range.start}-${range.end}/${entry.size}`; headers["Content-Length"]=range.end-range.start+1; }
    else headers["Content-Length"]=entry.size;
    if (req.method==="HEAD") { await close();if(res.destroyed)return;res.writeHead(range?206:200,headers); res.end(); return; }
    res.writeHead(range?206:200,headers);
    const stream=acquired.handle.createReadStream(range||{});
    stream.on("error",()=>res.destroy());
    stream.once("close",acquired.release);
    res.once("close",()=>stream.destroy()); stream.pipe(res);
  }
}
module.exports={SiriusXmTrackAudio,flacDuration,validateDuration,byteRange};
