"use strict";
const fs = require("node:fs");
const path = require("node:path");
function byteRange(header, size) {
  if (!header) return {start:0,end:size-1,partial:false};
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size-1,Number(match[2])) : size-1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return {start,end,partial:true};
}
async function serveBlindAudio(req,res,service,url,cacheDir) {
  const batchId=url.searchParams.get("batchId"), clipId=url.searchParams.get("clipId");
  if (!batchId || !/^[a-f0-9]{64}$/.test(clipId||"") || !service.plan(batchId)?.clips[clipId]?.wavSha256) {
    res.writeHead(404); return res.end();
  }
  // Only locally prepared, allowlisted excerpt IDs. Never accept filesystem paths.
  const file=path.join(cacheDir,`${clipId}.wav`);
  let stat;
  try { stat=await fs.promises.stat(file); } catch {res.writeHead(503,{"Retry-After":"10"});return res.end("Listening excerpt unavailable.");}
  const range=byteRange(req.headers.range,stat.size);
  if (!range) {res.writeHead(416,{"Content-Range":`bytes */${stat.size}`});return res.end();}
  res.writeHead(range.partial?206:200,{"Content-Type":"audio/wav","Accept-Ranges":"bytes","Cache-Control":"private, max-age=3600",
    "Content-Length":range.end-range.start+1,"X-Content-Type-Options":"nosniff",
    ...(range.partial?{"Content-Range":`bytes ${range.start}-${range.end}/${stat.size}`}:{})});
  if(req.method==="HEAD") return res.end();
  const stream=fs.createReadStream(file,{start:range.start,end:range.end});
  stream.on("error",()=>res.destroy()); res.on("close",()=>stream.destroy());stream.pipe(res);
}
module.exports={byteRange,serveBlindAudio};
