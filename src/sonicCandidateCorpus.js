"use strict";

// Pure private corpus utilities: no catalogue calls, audio decoding, scheduling,
// database writes or queue actions. Callers must obtain verified provider data.
const { createHash } = require("node:crypto");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { matchBeatportVersionToTidal } = require("./beatportVersionMatch");

const MODELS = Object.freeze(["mert-fullsong", "mert-30s"]);
const MAX_CANDIDATES = 48, MAX_PER_ANCHOR = 8, MAX_INPUTS = 500;
const canonicalJson = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
const digest = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const deepFreeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const text = (value, label, maximum = 1024) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`Invalid corpus ${label}.`);
  return value.trim();
};
const integer = (value, fallback, maximum, label) => {
  value = value === undefined ? fallback : value;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Corpus ${label} must be an integer from 1 to ${maximum}.`);
  return value;
};
function optionalYear(value, label) {
  if (value === undefined || value === null || value === 0 || value === "" || value === "0") return undefined;
  if (typeof value === "string") {
    value=value.trim();
    if (/^\d{4}$/.test(value)) value=Number(value);
    else if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) && Number.isFinite(Date.parse(value))) {
      const date=value.slice(0,10), parsed=new Date(`${date}T00:00:00Z`);
      if (Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0,10)===date) value=Number(value.slice(0,4));
    }
  }
  if (!Number.isInteger(value) || value < 1000 || value > 9999) throw new Error(`Invalid corpus ${label} year.`);
  return value;
}
function canonicalTrack(input = {}) {
  const identityKey = text(input.identityKey, "exact TIDAL identity"), id = identityKey.match(/^tidal:([1-9]\d*)$/)?.[1];
  if (!id) throw new Error("A corpus recording requires an exact canonical TIDAL identity.");
  const ids = [input.tidalId,input.tidalTrackId,input.tidal?.id,input.tidal?.trackId,input.tidal?.track_id,input.id,input.trackId].filter(value=>value !== undefined && value !== "").map(String);
  if (!ids.length || ids.some(value=>value !== id)) throw new Error("Conflicting or missing explicit TIDAL provider identity.");
  for (const url of [input.tidalUrl,input.tidal?.tidalUrl].filter(Boolean)) {
    if (!/^https:\/\/(?:www\.)?(?:listen\.)?tidal\.com\/(?:browse\/)?track\/[1-9]\d*(?:[/?#]|$)/i.test(url) || url.match(/\/track\/(\d+)/)?.[1] !== id) throw new Error("Conflicting corpus TIDAL URL.");
  }
  const track = {identityKey,tidalId:id,artist:text(input.artist,"artist"),title:text(input.title,"title")};
  for (const key of ["mixVersion","album","isrc","genre","subgenre","label","key","camelot","releaseDate"]) {
    if (input[key] !== undefined && input[key] !== "") track[key] = text(input[key],key);
  }
  if (input.beatportTrackId !== undefined || input.beatportId !== undefined) {
    const id = String(input.beatportTrackId ?? input.beatportId);
    if (!/^[1-9]\d*$/.test(id) || input.beatportTrackId !== undefined && input.beatportId !== undefined && String(input.beatportTrackId) !== String(input.beatportId)) throw new Error("Conflicting exact Beatport mapping.");
    track.beatportTrackId=id;
  }
  for (const key of ["durationMs","bpm","year"]) {
    if (key === "year") {const year=optionalYear(input[key],"canonical");if (year !== undefined) track.year=year;continue;}
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") {
      if (!Number.isFinite(input[key]) || input[key] <= 0) throw new Error(`Invalid corpus ${key}.`);
      track[key] = input[key];
    }
  }
  return track;
}
function anchorTrack(input = {}) {
  if (/^tidal:/.test(input.identityKey || "")) return canonicalTrack(input);
  const identityKey=text(input.identityKey,"sampling anchor identity",4096);
  if (!/^(?:text|isrc|roon|file):.+$/.test(identityKey)) throw new Error("A frozen sampling anchor requires its existing typed exact identity.");
  const track={identityKey,artist:text(input.artist,"anchor artist"),title:text(input.title,"anchor title")};
  for (const key of ["mixVersion","album","isrc","genre","subgenre","label"]) if (input[key] !== undefined && input[key] !== "") track[key]=text(input[key],`anchor ${key}`);
  if (Number.isFinite(input.durationMs) && input.durationMs > 0) track.durationMs=input.durationMs;
  return track;
}
function descriptor(track) { return {identityKey:track.identityKey,artist:track.artist,title:track.title,mixVersion:track.mixVersion || "",isrc:track.isrc || "",durationMs:track.durationMs ?? null}; }
function sourceTrack(input = {}) {
  const result = {id:text(String(input.id || input.beatportTrackId || ""),"Beatport source identity"),artist:text(input.artist,"source artist"),title:text(input.title,"source title")};
  if (!/^[1-9]\d*$/.test(result.id) || [input.id,input.beatportTrackId,input.trackId].filter(value=>value !== undefined && value !== "").some(value=>String(value) !== result.id)) throw new Error("An exact nonconflicting Beatport source identity is required.");
  for (const key of ["mixName","mixVersion","album","isrc","label","releaseDate"]) if (input[key] !== undefined && input[key] !== "") result[key]=text(input[key],`source ${key}`);
  for (const key of ["durationMs","year"]) if (input[key] !== undefined && input[key] !== null) {
    if (key === "year") {const year=optionalYear(input[key],"source");if (year !== undefined) result.year=year;continue;}
    if (!Number.isFinite(input[key]) || input[key] <= 0) throw new Error(`Invalid source ${key}.`);
    result[key]=input[key];
  }
  return result;
}
function centeredSpans(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 7200) throw new Error("Invalid corpus source duration.");
  const width = Math.min(30,durationSeconds), start = Math.round((durationSeconds-width)/2*1e6)/1e6;
  return [[start,Math.round((start+width)*1e6)/1e6]];
}
function snapshotBody({track,sourceType,sourceSha256,byteLength,durationSeconds,spans,sourceTrack:providerTrack,localFileId,linkStatus,allowVersionProxy}) {
  track = canonicalTrack(track);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || !Number.isInteger(byteLength) || byteLength <= 0
    || byteLength > (sourceType === "beatport-preview" ? 20*1024*1024 : 256*1024*1024)) throw new Error("Invalid original audio snapshot hash or size.");
  const expected = centeredSpans(durationSeconds);
  if (!Array.isArray(spans) || spans.length !== 1 || !Array.isArray(spans[0]) || spans[0].length !== 2
    || spans[0].some((value,index)=>!Number.isFinite(value) || Math.abs(value-expected[0][index]) > .000001)) throw new Error("Both MERT models require the same centered original-source span.");
  const shared = {version:1,identityKey:track.identityKey,recordingDescriptor:descriptor(track),sourceType,sourceSha256,byteLength,durationSeconds,spans:expected,
    canonicalProvider:"tidal",canonicalTrackId:track.tidalId};
  if (sourceType === "beatport-preview") {
    if (allowVersionProxy !== false || localFileId !== undefined || linkStatus !== undefined) throw new Error("Catalogue previews require exact identity and allowVersionProxy:false.");
    const selected = sourceTrack(providerTrack), match = matchBeatportVersionToTidal(track,selected,{allowVersionProxy:false,requestedBeatportTrackId:track.beatportTrackId || ""});
    if (!match.matched || match.relation !== "exact") throw new Error("A fuzzy or alternate-version preview cannot enter the corpus.");
    return {...shared,sourceProvider:"beatport",sourceTrackId:selected.id,sourceTrack:selected,identityRelation:"exact",allowVersionProxy:false,partialPreview:true};
  }
  if (sourceType === "verified-local-file") {
    if (linkStatus !== "EXACT" || providerTrack !== undefined || allowVersionProxy !== undefined) throw new Error("Local corpus audio requires its distinct exact library link.");
    return {...shared,sourceProvider:"local-library",localFileId:text(String(localFileId || ""),"local file identity"),linkStatus:"EXACT",identityRelation:"exact",partialPreview:false};
  }
  throw new Error("Choose an explicit verified local or exact Beatport preview source.");
}
function freezeSonicSourceSnapshot(input = {}) {
  const bytes = input.audioBytes;
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error("Original audio bytes are required to freeze a source snapshot.");
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const body = snapshotBody({...input,sourceSha256,byteLength:bytes.byteLength,spans:input.spans === undefined ? centeredSpans(input.durationSeconds) : input.spans});
  return deepFreeze({...body,snapshotKey:`sonic-source-v1-${digest(body)}`});
}
function assertSonicSourceSnapshot(snapshot, {track,audioBytes} = {}) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("A frozen corpus source snapshot is required.");
  const canonical = canonicalTrack(track);
  const body = snapshotBody({...snapshot,track:canonical});
  if (snapshot.snapshotKey !== `sonic-source-v1-${digest(body)}` || canonicalJson(snapshot) !== canonicalJson({...body,snapshotKey:snapshot.snapshotKey})) throw new Error("The frozen source snapshot or exact recording changed.");
  if (audioBytes !== undefined && (!(audioBytes instanceof Uint8Array) || audioBytes.byteLength !== snapshot.byteLength
    || createHash("sha256").update(audioBytes).digest("hex") !== snapshot.sourceSha256)) throw new Error("Original audio bytes changed after corpus freezing.");
  return true;
}
function candidateRecord(input, anchors) {
  const track = canonicalTrack(input.track), verification = input.verification;
  if (!verification || verification.provider !== "tidal" || verification.verified !== true || verification.identityKey !== track.identityKey
    || canonicalJson(descriptor(canonicalTrack(verification.canonicalTrack))) !== canonicalJson(descriptor(track))) throw new Error("The corpus requires exact verified canonical TIDAL recording evidence.");
  assertSonicSourceSnapshot(input.source,{track});
  const origins = Array.isArray(input.provenance) ? input.provenance : [input.provenance];
  if (!origins.length || origins.length > 48) throw new Error("Bounded catalogue query provenance is required.");
  const provenance = origins.map(origin=>{
    if (!origin || origin.provider !== "tidal" || !anchors.has(origin.anchorIdentityKey)) throw new Error("Catalogue candidate provenance must identify a frozen anchor and provider.");
    return {anchorIdentityKey:origin.anchorIdentityKey,provider:"tidal",query:text(origin.query,"catalogue query"),source:text(origin.source,"catalogue source",80)};
  });
  return {track,verification:{provider:"tidal",verified:true,identityKey:track.identityKey,canonicalTrack:track},source:JSON.parse(canonicalJson(input.source)),
    recordingGroup:recordingGroup(track),provenance};
}
function freezeSonicCandidateCorpus({anchors,candidates,limit=48,maxPerAnchor=8,excludeIdentityKeys=[],excludeSourceSha256=[],excludeRecordingGroups=[],createdAt} = {}) {
  limit = integer(limit,48,MAX_CANDIDATES,"limit"); maxPerAnchor = integer(maxPerAnchor,8,MAX_PER_ANCHOR,"per-anchor cap");
  if (!Array.isArray(anchors) || !anchors.length || anchors.length > 8 || !Array.isArray(candidates) || candidates.length > MAX_INPUTS) throw new Error("A bounded corpus needs explicit anchors and candidate snapshots.");
  const frozenAnchors = anchors.map(anchorTrack).sort((a,b)=>a.identityKey.localeCompare(b.identityKey)), anchorKeys = new Set(frozenAnchors.map(track=>track.identityKey));
  if (anchorKeys.size !== frozenAnchors.length) throw new Error("Corpus anchors must be distinct exact identities.");
  for (const values of [excludeIdentityKeys,excludeSourceSha256,excludeRecordingGroups]) if (!Array.isArray(values) || values.length > 5000
    || values.some(key=>typeof key !== "string" || !key || key.length > 4096)) throw new Error("Invalid corpus identity or source exclusions.");
  if (excludeSourceSha256.some(hash=>!/^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid corpus source hash exclusions.");
  const excluded = new Set([...excludeIdentityKeys,...anchorKeys]);
  const excludedHashes = new Set(excludeSourceSha256), excludedGroups = new Set(excludeRecordingGroups);
  const anchorGroups = new Set(frozenAnchors.map(recordingGroup)), byIdentity = new Map(), duplicates = [], excludedCandidates = [];
  for (const input of candidates) {
    const item = candidateRecord(input,anchorKeys), previous = byIdentity.get(item.track.identityKey);
    if (previous) {
      if (canonicalJson(previous.track) !== canonicalJson(item.track) || previous.source.snapshotKey !== item.source.snapshotKey) throw new Error("Conflicting source or recording evidence for one exact corpus identity.");
      previous.provenance.push(...item.provenance);continue;
    }
    byIdentity.set(item.track.identityKey,item);
  }
  const unique = [], hashes = new Map(), groups = new Map();
  for (const item of [...byIdentity.values()].sort((a,b)=>a.track.identityKey.localeCompare(b.track.identityKey))) {
    item.provenance=[...new Map(item.provenance.map(origin=>[canonicalJson(origin),origin])).values()].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
    if (excluded.has(item.track.identityKey) || anchorGroups.has(item.recordingGroup) || excludedHashes.has(item.source.sourceSha256)
      || excludedGroups.has(item.recordingGroup)) {excludedCandidates.push({identityKey:item.track.identityKey,reason:"excluded-or-self-recording"});continue;}
    const sameSource = hashes.get(item.source.sourceSha256), sameGroup = groups.get(item.recordingGroup);
    if (sameSource && (sameSource.recordingGroup !== item.recordingGroup || canonicalJson(sameSource.source.spans) !== canonicalJson(item.source.spans))) throw new Error("The same original audio cannot impersonate another title, remix or excerpt.");
    const duplicate = sameSource || sameGroup;
    if (duplicate) {duplicates.push({identityKey:item.track.identityKey,duplicateOf:duplicate.track.identityKey,reason:sameSource?"exact-source":"versioned-recording-group"});continue;}
    unique.push(item);hashes.set(item.source.sourceSha256,item);groups.set(item.recordingGroup,item);
  }
  const slots=[], owner=new Map(), assignment=new Map();
  const assign=(slot,seen)=>{
    // Keep earlier assignments stable unless an augmenting path is necessary.
    for (const item of [...unique.filter(item=>!owner.has(item.track.identityKey)),...unique.filter(item=>owner.has(item.track.identityKey))]) {
      const key=item.track.identityKey;
      if (seen.has(key) || !item.provenance.some(origin=>origin.anchorIdentityKey===slot.anchorIdentityKey)) continue;
      seen.add(key);const previous=owner.get(key);
      if (!previous || assign(previous,seen)) {owner.set(key,slot);assignment.set(slot.id,item);return true;}
    }
    return false;
  };
  // Balanced slots with augmenting paths prevent shared query results from
  // consuming the only candidate available to a different anchor.
  for (let round=0;round<maxPerAnchor && assignment.size<limit;round++) for (const anchor of frozenAnchors) {
    if (assignment.size===limit) break;
    const slot={id:slots.length,anchorIdentityKey:anchor.identityKey};slots.push(slot);assign(slot,new Set());
  }
  const items=slots.filter(slot=>assignment.has(slot.id)).map(slot=>({...assignment.get(slot.id),samplingAnchorIdentityKey:slot.anchorIdentityKey}));
  const perAnchor=Object.fromEntries(frozenAnchors.map(anchor=>[anchor.identityKey,items.filter(item=>item.samplingAnchorIdentityKey===anchor.identityKey).length]));
  const frozenAt = createdAt === undefined ? null : text(createdAt,"timestamp",80);
  if (frozenAt !== null && !Number.isFinite(Date.parse(frozenAt))) throw new Error("Invalid corpus freeze timestamp.");
  const body={version:1,kind:"matched-source-catalogue-corpus",createdAt:frozenAt,anchors:frozenAnchors,items,limit,maxPerAnchor,
    excludedIdentityKeys:[...new Set(excludeIdentityKeys)].sort(),excludedSourceSha256:[...new Set(excludeSourceSha256)].sort(),excludedRecordingGroups:[...new Set(excludeRecordingGroups)].sort(),
    models:MODELS.map(analyzer=>({analyzer,specKey:analysisSpec(analyzer).key})),
    metadataPolicy:"soft-evidence-only",productionPromotionAllowed:false,queueable:false};
  return deepFreeze({...body,corpusKey:`sonic-corpus-v1-${digest(body)}`,diagnostics:{inputCandidates:candidates.length,distinctIdentities:byIdentity.size,
    selected:items.length,requested:limit,unfilled:limit-items.length,perAnchor,duplicates,excluded:excludedCandidates,productionApplied:false,mode:"shadow"}});
}
function verifySonicCandidateCorpusCoverage(corpus, lists) {
  if (!corpus || !Array.isArray(corpus.items)) throw new Error("A frozen candidate corpus is required.");
  const {corpusKey,diagnostics,...body}=corpus;
  if (corpusKey !== `sonic-corpus-v1-${digest(body)}` || corpus.version !== 1 || corpus.queueable !== false || corpus.productionPromotionAllowed !== false) throw new Error("The frozen candidate corpus changed.");
  if (corpus.kind !== "matched-source-catalogue-corpus" || corpus.metadataPolicy !== "soft-evidence-only" || !Array.isArray(corpus.anchors)
    || !corpus.anchors.length || corpus.anchors.length > 8 || corpus.items.length > integer(corpus.limit,48,MAX_CANDIDATES,"limit")
    || canonicalJson(corpus.models) !== canonicalJson(MODELS.map(analyzer=>({analyzer,specKey:analysisSpec(analyzer).key})))) throw new Error("Invalid frozen corpus boundaries or model spaces.");
  const cap=integer(corpus.maxPerAnchor,8,MAX_PER_ANCHOR,"per-anchor cap"), anchorKeys=new Set(corpus.anchors.map(anchor=>anchorTrack(anchor).identityKey));
  if (anchorKeys.size !== corpus.anchors.length || new Set(corpus.items.map(item=>item.track.identityKey)).size !== corpus.items.length
    || corpus.items.some(item=>!anchorKeys.has(item.samplingAnchorIdentityKey))
    || [...anchorKeys].some(key=>corpus.items.filter(item=>item.samplingAnchorIdentityKey===key).length>cap)) throw new Error("Invalid frozen corpus identity or sampling budgets.");
  if (!Array.isArray(lists) || lists.length !== MODELS.length || new Set(lists.map(list=>list.analyzer)).size !== MODELS.length
    || lists.some(list=>!MODELS.includes(list.analyzer))) throw new Error("Corpus coverage requires both distinct MERT-v2 model spaces.");
  const coverage = [], usable = new Map();
  for (const item of corpus.items) assertSonicSourceSnapshot(item.source,{track:item.track});
  for (const analyzer of MODELS) {
    const spec=analysisSpec(analyzer), list=lists.find(value=>value.analyzer===analyzer);
    if (list.specKey !== spec.key || !Array.isArray(list.records) || list.records.length > MAX_INPUTS
      || new Set(list.records.map(record=>record.identityKey)).size !== list.records.length) throw new Error("Invalid or duplicate corpus model/spec coverage records.");
    const records = new Map(list.records.map(record=>[record.identityKey,record])), accepted = new Set(), missing = [], rejected = [];
    for (const item of corpus.items) {
      const row=records.get(item.track.identityKey);
      if (!row) {missing.push(item.track.identityKey);continue;}
      if (row.sourceSha256 !== item.source.sourceSha256 || canonicalJson(row.spans) !== canonicalJson(item.source.spans)
        || row.dimensions !== spec.dimensions || row.revision !== spec.revision || row.sampleRate !== spec.sampleRate) {rejected.push({identityKey:item.track.identityKey,reason:"changed-source-span-or-model-provenance"});continue;}
      accepted.add(item.track.identityKey);
    }
    usable.set(analyzer,accepted);coverage.push({analyzer,specKey:spec.key,expected:corpus.items.length,available:accepted.size,missing,rejected});
  }
  const jointIdentityKeys=corpus.items.map(item=>item.track.identityKey).filter(key=>MODELS.every(model=>usable.get(model).has(key)));
  return deepFreeze({ready:corpus.items.length > 0 && jointIdentityKeys.length===corpus.items.length,corpusKey,poolCount:corpus.items.length,jointCount:jointIdentityKeys.length,
    jointIdentityKeys,jointCoverage:[...jointIdentityKeys],coverage,missingModelIsNegative:false,mode:"shadow",productionApplied:false,productionPromotionAllowed:false,queueable:false});
}
module.exports={freezeSonicSourceSnapshot,assertSonicSourceSnapshot,freezeSonicCandidateCorpus,verifySonicCandidateCorpusCoverage,MODELS,MAX_CANDIDATES,MAX_PER_ANCHOR};
