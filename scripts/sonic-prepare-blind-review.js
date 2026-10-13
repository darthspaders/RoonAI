"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { SonicBlindReview, buildBlindPlan, ENSEMBLE_MODEL, blindEnsembleStrategy } = require("../src/sonicBlindReview");
const { recordingGroup } = require("../src/sonicAnalysisPilot");
const { wslPath } = require("../src/sonicAnalysisWorker");
const exec=promisify(execFile), root=path.resolve(__dirname,".."), cache=path.join(root,"data","sonic-blind-audio");
async function fileHash(file) {const h=createHash("sha256");for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest("hex");}
function argumentsFor(args) {
  const options={excludeBatchIds:[],dryRun:false}, seen=new Set();
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if(flag==="--help")return {help:true};
    if(flag==="--dry-run"){options.dryRun=true;continue;}
    if(flag==="--cache-only"){options.cacheOnly=true;continue;}
    if(!["--models","--top-k","--exclude-batch","--round-id","--title"].includes(flag))throw Error(`Unknown preparation option: ${flag}`);
    if(flag!=="--exclude-batch"&&seen.has(flag))throw Error(`Preparation option ${flag} may only be supplied once.`);
    seen.add(flag);
    const value=args[++i];
    if(!value||value.startsWith("--"))throw Error(`A value is required for ${flag}.`);
    if(flag==="--models")options.models=value.split(",");
    if(flag==="--top-k")options.topK=Number(value);
    if(flag==="--exclude-batch")options.excludeBatchIds.push(value);
    if(flag==="--round-id")options.roundId=value;
    if(flag==="--title")options.title=value;
  }
  if(options.roundId&&!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.roundId))throw Error("Use a short lowercase round ID with letters, numbers and hyphens.");
  if(options.topK!==undefined&&(!Number.isInteger(options.topK)||options.topK<1||options.topK>10))throw Error("Top-k must be an integer from 1 to 10.");
  if(options.models&&(!options.models.length||options.models.some(model=>!["effnet-control","mert-fullsong","mert-30s","mert-330m",ENSEMBLE_MODEL].includes(model))||new Set(options.models).size!==options.models.length))throw Error("Choose distinct supported blind listening models.");
  if(options.models?.includes(ENSEMBLE_MODEL)&&(options.models.length!==3||!options.models.includes("mert-fullsong")||!options.models.includes("mert-30s")||options.topK!==3))throw Error("The blind ensemble requires both v2 models and a fixed top-k of three.");
  const customized=options.models||options.topK!==undefined||options.title||options.excludeBatchIds.length;
  if(customized&&!options.roundId)throw Error("A round ID is required for a custom batch so preparation can resume without resampling.");
  if(options.roundId&&options.topK===undefined)throw Error("A custom round requires an explicit top-k for balanced candidate coverage.");
  return options;
}
function validateWave(file,clip) {
  const buffer=fs.readFileSync(file);
  if(buffer.length<44||buffer.length>2*1024*1024||buffer.toString("ascii",0,4)!=="RIFF"||buffer.toString("ascii",8,12)!=="WAVE")throw Error("Invalid listening WAV cache.");
  let format=null,dataBytes=0;
  for(let offset=12;offset+8<=buffer.length;) {
    const id=buffer.toString("ascii",offset,offset+4),size=buffer.readUInt32LE(offset+4),start=offset+8;
    if(start+size>buffer.length)throw Error("Truncated listening WAV cache.");
    if(id==="fmt "){
      if(size<16)throw Error("Invalid listening WAV format.");
      format={pcm:buffer.readUInt16LE(start),channels:buffer.readUInt16LE(start+2),rate:buffer.readUInt32LE(start+4),bits:buffer.readUInt16LE(start+14)};
    }
    if(id==="data")dataBytes+=size;
    offset=start+size+(size%2);
  }
  if(!format||format.pcm!==1||format.channels!==1||format.rate!==24000||format.bits!==16||!dataBytes||Math.abs(dataBytes/48000-(clip.end-clip.start))>.1)throw Error("Listening WAV does not match the prepared source span and format.");
}
async function main(args=process.argv.slice(2)) {
  const options=argumentsFor(args);
  if(options.help){console.log("Prepare the original batch: npm run sonic:prepare:blind\nNew balanced round: npm run sonic:prepare:blind -- --round-id NAME --models mert-fullsong,mert-30s --top-k 3 --exclude-batch BATCH_ID --title TITLE [--dry-run | --cache-only]\nBlind ensemble round: add mert-v2-ensemble to those two model IDs with top-k 3; the frozen strategy uses best rank plus 0.05 for exact-source agreement. Repeat --exclude-batch for each previous batch.\nDry-run freezes the private plan without publishing sessions or decoding clips. Cache-only prepares verified audio without publishing sessions.");return;}
  const db=new DatabaseSync(path.join(root,"data","rabbit-hole-memory.sqlite"));db.exec("PRAGMA busy_timeout=5000");
  let lockFile="",lockToken="";
  try {
    let planFile=options.roundId?path.join(root,"data",`sonic-blind-round-${options.roundId}.json`):"";
    const frozen=planFile&&fs.existsSync(planFile)?JSON.parse(await fs.promises.readFile(planFile,"utf8")):null;
    const manifestRow=frozen?.preparationRequest?.manifestCreatedAt
      ? db.prepare("SELECT manifest_json FROM sonic_analysis_pilot WHERE json_extract(manifest_json,'$.createdAt')=? ORDER BY created_at DESC LIMIT 1").get(frozen.preparationRequest.manifestCreatedAt)
      : db.prepare("SELECT manifest_json FROM sonic_analysis_pilot ORDER BY created_at DESC LIMIT 1").get();
    if(!manifestRow)throw Error("The frozen round's matched-source pilot is unavailable. No listening batch was changed.");
    const manifest=JSON.parse(manifestRow.manifest_json);
    const priorPlans=options.excludeBatchIds.map(id=>{
      const row=db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id=?").get(id);
      if(!row)throw Error("A requested previous listening batch does not exist.");
      return JSON.parse(row.private_plan_json);
    });
    const excludeIdentityKeys=[...new Set(priorPlans.flatMap(p=>p.groups.flatMap(g=>[g.anchor.identityKey,...g.candidates.map(c=>c.track.identityKey)])))].sort();
    const excludeSourceSha256=[...new Set(priorPlans.flatMap(p=>Object.values(p.clips).map(c=>c.sourceSha256)))].sort();
    const ensembleStrategy=options.models?.includes(ENSEMBLE_MODEL)?blindEnsembleStrategy():null;
    const excludeRecordingGroups=ensembleStrategy?[...new Set(priorPlans.flatMap(p=>p.groups.flatMap(g=>[recordingGroup(g.anchor),...g.candidates.map(c=>recordingGroup(c.track))])))].sort():[];
    const request={manifestCreatedAt:manifest.createdAt,roundId:options.roundId||"",models:options.models||null,topK:options.topK??null,title:options.title||null,excludeBatchIds:[...new Set(options.excludeBatchIds)].sort(),excludeIdentityKeys,excludeSourceSha256,
      ...(ensembleStrategy?{ensembleStrategy,excludeRecordingGroups}:{})};
    const requestKey=createHash("sha256").update(JSON.stringify(request)).digest("hex");
    await fs.promises.mkdir(cache,{recursive:true});
    lockFile=path.join(root,"data","sonic-blind-preparation.lock");lockToken=randomUUID();
    try{await fs.promises.writeFile(lockFile,JSON.stringify({pid:process.pid,token:lockToken,createdAt:new Date().toISOString()}),{flag:"wx"});}
    catch(error){lockFile="";throw Error(error.code==="EEXIST"?"Another listening preparation owns the cache lock. No batch was changed.":"Could not acquire the listening preparation cache lock.");}
    let plan;
    if(frozen) {
      plan=frozen;
      if(plan.preparationRequestKey!==requestKey)throw Error("This round ID already has a different frozen preparation request. Use its original options or a new round ID.");
    } else {
      plan=buildBlindPlan(db,manifest,{...(options.models?{models:options.models}:{}),...(options.topK!==undefined?{topK:options.topK,selectionMethod:"metadata-stratified-random"}:{}),...(options.title?{title:options.title}:{}),excludeIdentityKeys,excludeSourceSha256,
        ...(ensembleStrategy?{ensembleConfig:{method:ensembleStrategy.method,agreementWeight:ensembleStrategy.agreementWeight},excludeRecordingGroups}:{})});
      if(options.roundId){plan.preparationRequestKey=requestKey;plan.preparationRequest=request;}
    }
    planFile||=path.join(root,"data",`sonic-blind-plan-${plan.planKey}.json`);
    if(!options.roundId&&fs.existsSync(planFile))plan=JSON.parse(await fs.promises.readFile(planFile,"utf8"));
    const existing=db.prepare("SELECT batch_id FROM sonic_blind_review_batch WHERE plan_key=?").get(plan.planKey);
    if(existing){const service=new SonicBlindReview(db);console.log(JSON.stringify({reused:true,...summary(service.get(existing.batch_id).batch)}));return;}
    const checkpoint=async()=>{const temp=`${planFile}.${lockToken}.tmp`;await fs.promises.writeFile(temp,JSON.stringify(plan,null,2));await fs.promises.rename(temp,planFile);};
    await checkpoint();
    if(options.dryRun){console.log(JSON.stringify({prepared:false,frozen:true,batchId:plan.batchId,items:plan.count,anchors:plan.groups.map(g=>({artist:g.anchor.artist,title:g.anchor.title,lane:g.lane,items:g.candidates.length})),uniqueClips:Object.keys(plan.clips).length}));return;}
    const service=new SonicBlindReview(db);
    const knownClips=new Map(db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch").all().flatMap(row=>Object.entries(JSON.parse(row.private_plan_json).clips)));
    const clips=Object.values(plan.clips);let prepared=0;
    for(const clip of clips) {
      if(!/^[a-f0-9]{64}$/.test(clip.clipId))throw new Error("Invalid cached listening excerpt ID.");
      const out=path.join(cache,`${clip.clipId}.wav`), temp=path.join(cache,`${clip.clipId}.${lockToken}.source`);
      const known=knownClips.get(clip.clipId);
      if(!clip.wavSha256&&known?.sourceSha256===clip.sourceSha256&&known.start===clip.start&&known.end===clip.end)clip.wavSha256=known.wavSha256;
      if(clip.wavSha256&&fs.existsSync(out)&&await fileHash(out)===clip.wavSha256){validateWave(out,clip);prepared++;continue;}
      try {
        await fs.promises.copyFile(clip.sourceFile,temp);
        if(await fileHash(temp)!==clip.sourceSha256)throw new Error("Source changed since analysis; listening batch was not published.");
        const ffmpeg="/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffmpeg";
        const args=["-v","error","-nostdin","-i",wslPath(temp),"-ss",String(clip.start),"-t",String(clip.end-clip.start),
          "-ac","1","-ar","24000","-c:a","pcm_s16le","-map_metadata","-1","-y",wslPath(out)];
        await exec("wsl.exe",["-d","Ubuntu","--",ffmpeg,...args],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
        validateWave(out,clip);
        clip.wavSha256=await fileHash(out);await checkpoint();
        console.log(JSON.stringify({clipsPrepared:++prepared,clipsTotal:clips.length}));
      } finally {await fs.promises.rm(temp,{force:true});}
    }
    await checkpoint();
    if(options.cacheOnly){console.log(JSON.stringify({cached:true,published:false,batchId:plan.batchId,items:plan.count,clipsPrepared:prepared,clipsTotal:clips.length}));return;}
    const result=service.create(plan);
    console.log(JSON.stringify(summary(result.batch)));
  } finally {
    db.close();
    if(lockFile){try{const held=JSON.parse(await fs.promises.readFile(lockFile,"utf8"));if(held.token===lockToken)await fs.promises.unlink(lockFile);}catch(error){if(error.code!=="ENOENT")throw error;}}
  }
}
function summary(batch) {return {batchId:batch.batchId,items:batch.count,completed:batch.completed,anchors:batch.groups.map(g=>({artist:g.anchor.artist,title:g.anchor.title,lane:g.lane})),
  url:`http://127.0.0.1:3777/?sonicBlindBatch=${encodeURIComponent(batch.batchId)}`};}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={argumentsFor,validateWave,main};
