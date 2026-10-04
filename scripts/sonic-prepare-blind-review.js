"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { SonicBlindReview, buildBlindPlan } = require("../src/sonicBlindReview");
const { wslPath } = require("../src/sonicAnalysisWorker");
const exec=promisify(execFile), root=path.resolve(__dirname,".."), cache=path.join(root,"data","sonic-blind-audio");
async function fileHash(file) {const h=createHash("sha256");for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest("hex");}
async function main() {
  const db=new DatabaseSync(path.join(root,"data","rabbit-hole-memory.sqlite"));db.exec("PRAGMA busy_timeout=5000");
  try {
    const service=new SonicBlindReview(db);
    const manifest=JSON.parse(db.prepare("SELECT manifest_json FROM sonic_analysis_pilot ORDER BY created_at DESC LIMIT 1").get().manifest_json);
    let plan=buildBlindPlan(db,manifest);
    const existing=db.prepare("SELECT batch_id FROM sonic_blind_review_batch WHERE plan_key=?").get(plan.planKey);
    if(existing) {console.log(JSON.stringify({reused:true,...summary(service.get(existing.batch_id).batch)}));return;}
    await fs.promises.mkdir(cache,{recursive:true});
    const planFile=path.join(root,"data",`sonic-blind-plan-${plan.planKey}.json`);
    if(fs.existsSync(planFile)) plan=JSON.parse(await fs.promises.readFile(planFile,"utf8"));
    const checkpoint=async()=>{await fs.promises.writeFile(`${planFile}.tmp`,JSON.stringify(plan,null,2));await fs.promises.rename(`${planFile}.tmp`,planFile);};
    await checkpoint();
    const clips=Object.values(plan.clips);let prepared=0;
    for(const clip of clips) {
      if(!/^[a-f0-9]{64}$/.test(clip.clipId))throw new Error("Invalid cached listening excerpt ID.");
      const out=path.join(cache,`${clip.clipId}.wav`), temp=path.join(cache,`${clip.clipId}.source`);
      if(clip.wavSha256 && fs.existsSync(out) && await fileHash(out)===clip.wavSha256) {prepared++;continue;}
      try {
        await fs.promises.copyFile(clip.sourceFile,temp);
        if(await fileHash(temp)!==clip.sourceSha256)throw new Error("Source changed since analysis; listening batch was not published.");
        const wslFfmpeg=process.platform==="win32"?process.env.SONIC_BLIND_WSL_FFMPEG:"";
        const audioPath=value=>wslFfmpeg?wslPath(value):value;
        const args=["-v","error","-nostdin","-i",audioPath(temp),"-ss",String(clip.start),"-t",String(clip.end-clip.start),
          "-ac","1","-ar","24000","-c:a","pcm_s16le","-map_metadata","-1","-y",audioPath(out)];
        await exec(wslFfmpeg?"wsl.exe":process.env.FFMPEG_PATH||"ffmpeg",wslFfmpeg?["--",wslFfmpeg,...args]:args,{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
        clip.wavSha256=await fileHash(out);await checkpoint();
        console.log(JSON.stringify({clipsPrepared:++prepared,clipsTotal:clips.length}));
      } finally {await fs.promises.rm(temp,{force:true});}
    }
    const result=service.create(plan);
    console.log(JSON.stringify(summary(result.batch)));
  } finally {db.close();}
}
function summary(batch) {return {batchId:batch.batchId,items:batch.count,completed:batch.completed,anchors:batch.groups.map(g=>({artist:g.anchor.artist,title:g.anchor.title,lane:g.lane})),
  url:`http://127.0.0.1:3777/?sonicBlindBatch=${encodeURIComponent(batch.batchId)}`};}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
