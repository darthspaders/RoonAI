"use strict";

const { analysisSpec } = require("./sonicAnalysisSpec");

const MODELS = Object.freeze(["mert-fullsong", "mert-30s"]);
const METHODS = Object.freeze(["best-rank-agreement", "rrf"]);
const STATUSES = Object.freeze(["available", "missing-anchor", "missing-candidates"]);
const normalize = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const text = value => typeof value === "string" || typeof value === "number" ? String(value).replace(/\s+/g, " ").trim() : "";

function publicTrack(track) {
  if (!track || typeof track !== "object" || Array.isArray(track) || typeof track.identityKey !== "string" || !track.identityKey.trim() || track.identityKey.length > 512) throw new Error("An exact track identityKey is required for sonic rank fusion.");
  const result = {identityKey:track.identityKey};
  for (const key of ["artist", "title", "mixVersion", "album", "tidalId", "isrc", "genre"]) {
    const value = text(key === "mixVersion" ? track.mixVersion || track.mixName || track.version || track.remix : track[key]);
    if (value.length > 2000) throw new Error("Sonic rank fusion track metadata exceeds its bounded size.");
    if (value) result[key] = value;
  }
  if (Number.isFinite(track.durationMs) && track.durationMs >= 0) result.durationMs = track.durationMs;
  return result;
}

function evidenceFor(value, spec) {
  if (!value || typeof value !== "object" || typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sourceSha256)
    || !Array.isArray(value.spans) || !value.spans.length || value.spans.length > spec.maxWindows
    || value.spans.some(span => !Array.isArray(span) || span.length !== 2 || !span.every(Number.isFinite)
      || span[0] < 0 || span[1] <= span[0] || span[1]-span[0] > spec.windowSeconds+1)) throw new Error("Sonic rank fusion requires valid exact source and excerpt provenance.");
  const source = value.sourceSha256.toLowerCase(), spans = value.spans.map(span=>[...span]);
  return {source,spans,spanKey:JSON.stringify(spans),key:JSON.stringify([source,spans])};
}

function sameVersion(left, right) {
  // Audio aliases are evaluation deduplication only. Require complete matching
  // names and preserve the entire versioned title and explicit mix descriptor.
  const artist = normalize(left.artist), title = normalize(left.title);
  return Boolean(artist && title && artist === normalize(right.artist) && title === normalize(right.title)
    && normalize(left.mixVersion) === normalize(right.mixVersion));
}

function versionConflict(left, right) {
  const leftMix = normalize(left.mixVersion), rightMix = normalize(right.mixVersion);
  if (leftMix && rightMix && leftMix !== rightMix) return true;
  const namedVersion = /\b(?:remix|rework|edit|mix|version|remaster|instrumental|acoustic)\b/;
  return namedVersion.test(normalize(left.title)) && namedVersion.test(normalize(right.title))
    && normalize(left.title) !== normalize(right.title);
}

function fuseSonicRankings(options = {}) {
  const optionKeys = ["anchor", "lists", "count", "method", "agreementWeight", "rrfK"];
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key=>!optionKeys.includes(key))) throw new Error("Invalid sonic rank fusion options.");
  const {anchor,lists,count=3,method="best-rank-agreement",agreementWeight=.05,rrfK=60} = options;
  const anchorTrack = publicTrack(anchor);
  if (!Array.isArray(lists) || lists.length > MODELS.length) throw new Error("Sonic rank fusion accepts at most two model lists.");
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("Sonic rank fusion count must be an integer from 1 to 50.");
  if (!METHODS.includes(method)) throw new Error("Choose a supported sonic rank fusion method.");
  if (!Number.isFinite(agreementWeight) || agreementWeight < 0 || agreementWeight > .1) throw new Error("Sonic rank fusion agreementWeight must be from 0 to 0.1.");
  if (!Number.isInteger(rrfK) || rrfK < 1 || rrfK > 1000) throw new Error("Sonic rank fusion rrfK must be an integer from 1 to 1000.");

  const seenModels = new Set(), prepared = [], coverage = [], conflicts = new Map();
  let inputCandidateCount = 0, excludedSelfCount = 0;
  for (const list of lists) {
    if (!list || !MODELS.includes(list.analyzer) || seenModels.has(list.analyzer)) throw new Error("Sonic rank fusion requires distinct supported model lists.");
    seenModels.add(list.analyzer);
    const spec = analysisSpec(list.analyzer);
    if (list.specKey !== spec.key) throw new Error("Sonic rank fusion requires the exact analyzer specification key.");
    if (!STATUSES.includes(list.status) || !Array.isArray(list.candidates) || list.candidates.length > 100) throw new Error("Invalid or oversized sonic rank fusion model list.");
    if (list.status !== "available" && list.candidates.length) throw new Error("Missing sonic model coverage cannot contain candidate votes.");
    const anchorEvidence = list.anchorEvidence ? evidenceFor(list.anchorEvidence,spec) : null;
    if (list.status === "available" && (!anchorEvidence || !list.candidates.length)) throw new Error("An available sonic model requires anchor provenance and candidate coverage.");
    const rows = [];
    inputCandidateCount += list.candidates.length;
    for (const candidate of list.candidates) {
      if (!candidate || !Number.isInteger(candidate.rank) || candidate.rank < 1 || candidate.rank > 100
        || !Number.isFinite(candidate.similarity) || candidate.similarity < -1 || candidate.similarity > 1) throw new Error("Sonic rank fusion requires valid bounded ranks and similarities.");
      const track = publicTrack(candidate.track), evidence = evidenceFor(candidate.evidence,spec);
      if (track.identityKey === anchorTrack.identityKey || evidence.source === anchorEvidence.source) { excludedSelfCount++; continue; }
      rows.push({track,evidence,analyzer:list.analyzer,specKey:spec.key,rank:candidate.rank,similarity:candidate.similarity});
    }
    prepared.push({analyzer:list.analyzer,status:list.status,anchorEvidence,rows});
    coverage.push({analyzer:list.analyzer,specKey:spec.key,status:list.status,candidateCount:list.candidates.length});
  }
  for (const analyzer of MODELS) if (!seenModels.has(analyzer)) coverage.push({analyzer,specKey:analysisSpec(analyzer).key,status:"missing-anchor",candidateCount:0});
  coverage.sort((a,b)=>MODELS.indexOf(a.analyzer)-MODELS.indexOf(b.analyzer));
  const available = prepared.filter(list=>list.status === "available");
  const anchorEvidenceMatched = available.length === MODELS.length && available[0].anchorEvidence.key === available[1].anchorEvidence.key;
  if (method === "rrf" && available.length === MODELS.length && !anchorEvidenceMatched) throw new Error("Reciprocal-rank fusion requires matching anchor source and excerpt provenance.");
  if (available.length === MODELS.length && !anchorEvidenceMatched) conflicts.set(anchorTrack.identityKey,"anchor-source-or-span-conflict");

  const byIdentity = new Map();
  for (const row of prepared.flatMap(list=>list.rows)) {
    if (!byIdentity.has(row.track.identityKey)) byIdentity.set(row.track.identityKey,[]);
    byIdentity.get(row.track.identityKey).push(row);
  }
  for (const [identityKey,identityRows] of byIdentity) {
    if (new Set(identityRows.map(row=>row.evidence.source)).size > 1) conflicts.set(identityKey,"candidate-source-conflict");
    else if (new Set(identityRows.map(row=>row.evidence.spanKey)).size > 1) conflicts.set(identityKey,"candidate-span-conflict");
    else if (identityRows.some((row,index)=>identityRows.slice(index+1).some(other=>versionConflict(row.track,other.track)))) conflicts.set(identityKey,"candidate-version-conflict");
  }
  const rows = prepared.flatMap(list=>list.rows).filter(row=>!conflicts.has(row.track.identityKey))
    .sort((a,b)=>a.track.identityKey.localeCompare(b.track.identityKey) || a.analyzer.localeCompare(b.analyzer) || a.rank-b.rank || b.similarity-a.similarity || JSON.stringify(a.track).localeCompare(JSON.stringify(b.track)));
  const groups = [], identities = new Map();
  for (const row of rows) {
    let group = identities.get(row.track.identityKey);
    if (!group) group = groups.find(item=>item.evidence.key === row.evidence.key && sameVersion(item.track,row.track));
    if (!group) { group = {track:row.track,evidence:row.evidence,aliases:new Set(),nominations:new Map()}; groups.push(group); }
    group.aliases.add(row.track.identityKey); identities.set(row.track.identityKey,group);
    const prior = group.nominations.get(row.analyzer);
    if (!prior || row.rank < prior.rank || row.rank === prior.rank && row.similarity > prior.similarity) group.nominations.set(row.analyzer,{analyzer:row.analyzer,specKey:row.specKey,identityKey:row.track.identityKey,rank:row.rank,similarity:row.similarity});
  }
  const unionCandidates = groups.map(group=>{
    const nominations = [...group.nominations.values()].sort((a,b)=>MODELS.indexOf(a.analyzer)-MODELS.indexOf(b.analyzer));
    const agreement = anchorEvidenceMatched && nominations.length === MODELS.length;
    const baseRankScore = method === "rrf" ? nominations.reduce((sum,n)=>sum+1/(rrfK+n.rank),0) : Math.max(...nominations.map(n=>1/n.rank));
    const agreementBonus = method === "best-rank-agreement" && agreement ? agreementWeight : 0;
    return {track:{...group.track},nominations,baseRankScore,agreement,agreementBonus,ensembleScore:baseRankScore+agreementBonus,shadowOnly:true,queueable:false};
  }).sort((a,b)=>b.ensembleScore-a.ensembleScore || a.track.identityKey.localeCompare(b.track.identityKey));
  const candidates = unionCandidates.slice(0,count);
  const uniqueNominationCount = groups.reduce((sum,group)=>sum+group.nominations.size,0);
  const excludedConflictCount = prepared.reduce((sum,list)=>sum+list.rows.filter(row=>conflicts.has(row.track.identityKey)).length,0);
  const diagnostics = {mode:"shadow",productionApplied:false,method,requestedCount:count,returnedCount:candidates.length,unionCount:unionCandidates.length,
    inputCandidateCount,uniqueNominationCount,duplicateVoteCount:inputCandidateCount-excludedSelfCount-excludedConflictCount-uniqueNominationCount,
    excludedSelfCount,excludedConflictCount,aliasMergeCount:groups.reduce((sum,group)=>sum+group.aliases.size-1,0),anchorEvidenceMatched,agreementCount:unionCandidates.filter(candidate=>candidate.agreement).length,
    agreementWeight:method === "best-rank-agreement" ? agreementWeight : 0,rrfK:method === "rrf" ? rrfK : null,coverage,
    missingModels:coverage.filter(item=>item.status !== "available").map(item=>({analyzer:item.analyzer,status:item.status})),
    provenanceConflicts:[...conflicts].map(([identityKey,reason])=>({identityKey,reason})).sort((a,b)=>a.identityKey.localeCompare(b.identityKey)),
    reason:!available.length ? "no-available-models" : available.length === 1 ? "single-model-coverage" : !anchorEvidenceMatched ? "anchor-provenance-mismatch" : "matched-model-coverage"};
  return {candidates,unionCandidates,diagnostics,productionPromotionAllowed:false};
}

module.exports = {fuseSonicRankings};
