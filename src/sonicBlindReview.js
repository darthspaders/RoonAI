"use strict";
const { randomUUID, randomInt, createHash } = require("node:crypto");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { compareAnalysis } = require("./sonicAnalysisEvaluation");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { fuseSonicRankings } = require("./sonicEnsemble");
const { readModelMatrix, storedRankings } = require("./sonicEnsembleEvaluation");
const { validateCatalogReviewPlan, musicalNames, opaqueListeningIdentity, KIND:CATALOG_REVIEW_KIND, PURPOSE:CATALOG_REVIEW_PURPOSE } = require("./sonicCatalogReview");
const { validateCatalogScoutReviewPlan, completedScoutReport, KIND:CATALOG_SCOUT_KIND, PURPOSE:CATALOG_SCOUT_PURPOSE } = require("./sonicCatalogScoutReview");

const BLIND_MODEL = "blind-listening";
const MODELS = ["effnet-control", "mert-fullsong", "mert-30s", "mert-330m"];
const ENSEMBLE_MODEL = "mert-v2-ensemble";
const ENSEMBLE_COMPONENTS = ["mert-fullsong", "mert-30s"];
const SELECTION_METHODS = ["metadata-stratified-preferred", "metadata-stratified-random"];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const shuffle = items => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};
function publicTrack(track = {}) {
  // Deliberate allowlist: no ranks, model output, global ratings or local paths.
  const out = {};
  for (const key of ["identityKey", "artist", "title", "mixVersion", "album", "durationMs", "tidalId"]) out[key] = track[key] ?? "";
  return out;
}
function blindEnsembleStrategy(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(key=>!["method","agreementWeight"].includes(key))) throw new Error("Invalid blind ensemble configuration.");
  const method = config.method === undefined ? "best-rank-agreement" : config.method, agreementWeight = config.agreementWeight === undefined ? .05 : config.agreementWeight;
  if (method !== "best-rank-agreement" || !Number.isFinite(agreementWeight) || agreementWeight < 0 || agreementWeight > .1) throw new Error("Choose a bounded best-rank blind ensemble configuration.");
  const strategy = {kind:"rank-fusion",version:1,method,agreementWeight,componentModels:[...ENSEMBLE_COMPONENTS],
    componentSpecs:ENSEMBLE_COMPONENTS.map(analyzer=>({analyzer,specKey:analysisSpec(analyzer).key})),retrievalTopK:3,finalCount:3};
  return {...strategy,strategyKey:`sonic-ensemble-v1-${digest(strategy).slice(0,24)}`};
}
function blindOptions(options = {}) {
  const keys = ["models", "topK", "excludeIdentityKeys", "excludeSourceSha256", "excludeRecordingGroups", "selectionMethod", "title", "ensembleConfig"];
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !keys.includes(key))) throw new Error("Invalid blind listening options.");
  const models = options.models === undefined ? [...MODELS] : options.models;
  if (!Array.isArray(models) || !models.length || models.length > MODELS.length + 1 || models.some(model => ![...MODELS,ENSEMBLE_MODEL].includes(model)) || new Set(models).size !== models.length) throw new Error("Choose distinct supported blind listening models.");
  const topK = options.topK === undefined ? null : options.topK;
  if ((topK !== null && (!Number.isInteger(topK) || topK < 1 || topK > 10)) || options.topK === null) throw new Error("Blind listening topK must be an integer from 1 to 10.");
  const hasEnsemble = models.includes(ENSEMBLE_MODEL);
  if (hasEnsemble && (topK !== 3 || models.length !== 3 || ENSEMBLE_COMPONENTS.some(model=>!models.includes(model)))) throw new Error("The blind ensemble requires both v2 models and a fixed topK of three.");
  if (!hasEnsemble && options.ensembleConfig !== undefined) throw new Error("A blind ensemble configuration requires the ensemble strategy.");
  const ensemble = hasEnsemble ? blindEnsembleStrategy(options.ensembleConfig) : null;
  const lists = {};
  for (const key of ["excludeIdentityKeys", "excludeSourceSha256", "excludeRecordingGroups"]) {
    const values = options[key] === undefined ? [] : options[key];
    if (!Array.isArray(values) || values.length > 5000 || values.some(value => typeof value !== "string" || !value || value.length > 4096)) throw new Error(`Invalid blind listening ${key}.`);
    lists[key] = [...new Set(values)];
  }
  const selectionMethod = options.selectionMethod === undefined ? topK === null ? SELECTION_METHODS[0] : SELECTION_METHODS[1] : options.selectionMethod;
  if (!SELECTION_METHODS.includes(selectionMethod)) throw new Error("Choose a supported blind anchor selection method.");
  const title = options.title === undefined ? hasEnsemble ? "Ensemble blind listening batch" : topK === null ? "First blind listening batch" : "Blind listening confirmation batch" : options.title;
  if (typeof title !== "string" || !title.trim() || title.length > 120) throw new Error("Choose a blind listening title of at most 120 characters.");
  return { models: [...models], topK, ...lists, selectionMethod, title: title.trim(), ensemble };
}
function selectAnchorsWithOptions(manifest, options) {
  if (!manifest || !Array.isArray(manifest.items)) throw new Error("A matched-source pilot manifest is required.");
  const eligible = manifest.items.filter(x => x.track?.analysisLocal?.sha256);
  const excludedKeys = new Set(options.excludeIdentityKeys), hashes = new Set(options.excludeSourceSha256), groups = new Set(options.excludeRecordingGroups);
  for (const item of eligible) if (excludedKeys.has(item.track.identityKey)) {
    hashes.add(item.track.analysisLocal.sha256); groups.add(item.recordingGroup || recordingGroup(item.track));
  }
  const positive = x => /^(love|like|good)$/i.test(x.rating || "");
  const remix = x => /remix|rework/i.test(`${x.track.title} ${x.track.mixVersion}`);
  const preferred = x => /progressive|trance|techno|melodic|deep house/.test(x.lane);
  const strata = [
    ["Progressive House", x => /progressive house/.test(x.lane)],
    ["Progressive / deep Trance", x => /trance/.test(x.lane) && !/psy/.test(x.lane)],
    ["Psytrance", x => /psy.*trance/.test(x.lane)],
    ["Techno", x => /techno/.test(x.lane) && !/melodic/.test(x.lane)],
    ["Named remix · house / techno", x => remix(x) && /house|techno/.test(x.lane)],
    ["Named remix · trance / adjacent", x => remix(x) && preferred(x)]
  ];
  const selected = [], identities = new Set(excludedKeys);
  const availableFor = matches => eligible.filter(x => !identities.has(x.track.identityKey) && !hashes.has(x.track.analysisLocal.sha256) && !groups.has(x.recordingGroup || recordingGroup(x.track))).filter(matches);
  if (options.selectionMethod === "metadata-stratified-random") {
    // Overlapping remix strata need a complete distinct assignment. Draw the
    // most constrained remaining stratum first and backtrack if a draw blocks
    // another stratum, retaining the public block order and exact lanes.
    const assign = remaining => {
      if (!remaining.length) return true;
      const choices = remaining.map(index => ({index,available:availableFor(strata[index][1])})).sort((a,b)=>a.available.length-b.available.length);
      const {index,available} = choices[0];
      if (!available.length) return false;
      for (const item of shuffle(available)) {
        const key = item.track.identityKey, hash = item.track.analysisLocal.sha256, group = item.recordingGroup || recordingGroup(item.track);
        selected[index] = {...item,purpose:strata[index][0]}; identities.add(key); hashes.add(hash); groups.add(group);
        if (assign(remaining.filter(i=>i!==index))) return true;
        identities.delete(key); hashes.delete(hash); groups.delete(group); selected[index] = undefined;
      }
      return false;
    };
    const missing = strata.find(([,matches])=>!availableFor(matches).length);
    if (missing) throw new Error(`The pilot needs an eligible anchor for ${missing[0]}; do not silently substitute another lane.`);
    if (!assign(strata.map((_,index)=>index))) throw new Error("The pilot needs six distinct eligible anchors across all requested metadata strata; do not silently substitute another lane.");
    return selected;
  }
  for (const [purpose, matches] of strata) {
    const available = availableFor(matches);
    const item = available.sort((a,b) => Number(positive(b)) - Number(positive(a)) || a.track.identityKey.localeCompare(b.track.identityKey))[0];
    if (!item) throw new Error(`The pilot needs an eligible anchor for ${purpose}; do not silently substitute another lane.`);
    selected.push({ ...item, purpose }); identities.add(item.track.identityKey); hashes.add(item.track.analysisLocal.sha256); groups.add(item.recordingGroup || recordingGroup(item.track));
  }
  return selected;
}
function selectAnchors(manifest, options = {}) {
  return selectAnchorsWithOptions(manifest, blindOptions(options));
}
function readBlindEnsembleMatrices(db, manifest) {
  if (!manifest || typeof manifest.createdAt !== "string" || !manifest.createdAt || !Array.isArray(manifest.items)
    || !manifest.items.length || manifest.items.length > 500
    || manifest.items.some(item=>typeof item.track?.identityKey !== "string" || !item.track.identityKey || !/^[a-f0-9]{64}$/.test(item.track.analysisLocal?.sha256))
    || new Set(manifest.items.map(item=>item.track.identityKey)).size !== manifest.items.length) throw new Error("The blind ensemble requires its exact frozen matched-source pool.");
  const matrices = new Map(ENSEMBLE_COMPONENTS.map(analyzer=>[analyzer,readModelMatrix(db,manifest,analyzer)]));
  // A partially valid pool changes nearest-neighbor ranks. Require every frozen
  // pool record in both distinct spaces, including profile/vector provenance.
  if ([...matrices.values()].some(matrix=>matrix.missingCount || matrix.rejected.length)) throw new Error("The complete frozen matched-source vector pool must match stored model evidence before preparing the blind ensemble.");
  for (const item of manifest.items) {
    const evidence = ENSEMBLE_COMPONENTS.map(analyzer=>matrices.get(analyzer).records.get(item.track.identityKey).evidence);
    if (evidence[0].sourceSha256 !== evidence[1].sourceSha256 || JSON.stringify(evidence[0].spans) !== JSON.stringify(evidence[1].spans)) throw new Error("The blind ensemble requires matched-source excerpts across both model spaces.");
  }
  return matrices;
}
function readFrozenBlindEnsemblePool(db, plan) {
  const pool = plan.sourcePool;
  if (!pool || typeof pool.manifestCreatedAt !== "string" || !pool.manifestCreatedAt || !Number.isInteger(pool.count) || pool.count < 1 || pool.count > 500
    || plan.preparationRequest && plan.preparationRequest.manifestCreatedAt !== pool.manifestCreatedAt) throw new Error("The blind ensemble must identify its exact frozen source pool.");
  const pilots = db.prepare("SELECT manifest_json FROM sonic_analysis_pilot WHERE json_extract(manifest_json,'$.createdAt')=?").all(pool.manifestCreatedAt);
  if (pilots.length !== 1) throw new Error("The frozen blind ensemble source pool is missing or ambiguous.");
  const manifest = JSON.parse(pilots[0].manifest_json);
  if (manifest.items?.length !== pool.count) throw new Error("The frozen blind ensemble source pool changed.");
  return {manifest,matrices:readBlindEnsembleMatrices(db,manifest)};
}
function buildBlindPlan(db, manifest, options = {}) {
  const settings = blindOptions(options), anchors = selectAnchorsWithOptions(manifest, settings);
  const actualModels = settings.models.filter(model=>model !== ENSEMBLE_MODEL);
  const matrices = settings.ensemble ? readBlindEnsembleMatrices(db,manifest) : null;
  const report = settings.ensemble ? null : compareAnalysis(db, manifest, { models: actualModels, anchorIdentityKeys: anchors.map(x => x.track.identityKey) });
  if (report && report.commonAudioCandidateCount !== manifest.items.length) throw new Error("Finish the matched-source pilot before preparing blind listening.");
  const trackByKey = new Map(manifest.items.map(x => [x.track.identityKey, x]));
  const clips = {};
  const clipFor = track => {
    const spec = analysisSpec(actualModels[0]);
    const row = db.prepare(`SELECT a.source_sha256,a.result_json FROM sonic_analysis_link l JOIN sonic_analysis_artifact a USING(artifact_key)
      WHERE l.identity_key=? AND l.spec_key=?`).get(track.identityKey, spec.key);
    const result = row && JSON.parse(row.result_json);
    const spans = result?.segments?.map(x => [x.start,x.end]);
    if (!row || row.source_sha256 !== track.analysisLocal.sha256 || spans?.length !== 1) throw new Error("Listening source does not match the stored analysis.");
    if (settings.ensemble && (result.specKey !== spec.key || result.revision !== spec.revision || result.sampleRate !== spec.sampleRate)) throw new Error("The blind ensemble source has mismatched analyzer provenance.");
    const [start,end] = spans[0];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 31) throw new Error("Invalid listening excerpt span.");
    const clipId = digest([row.source_sha256,start,end,"pcm_s16le-mono-24000-v1"]);
    clips[clipId] ||= { clipId, start, end, sourceSha256:row.source_sha256, sourceFile:track.analysisLocal.file, localFileId:track.analysisLocal.localFileId };
    return clipId;
  };
  const groups = anchors.map(anchor => {
    const ranks = report?.models.map(model => ({ model:model.analyzer, specKey:model.specKey,
      neighbors:model.anchors.find(x => x.anchor.identityKey === anchor.track.identityKey).neighbors }));
    const keys = [], seenHashes = new Set(), seenGroups = new Set(), nominations = new Map();
    if (settings.ensemble) {
      const lists = storedRankings(manifest,matrices,anchor.track,settings.topK).map(list=>({...list,
        candidates:list.candidates.map(candidate=>({...candidate,track:publicTrack(candidate.track)}))}));
      if (lists.some(list=>list.status !== "available" || list.candidates.length !== settings.topK)) throw new Error("Not enough matched-source neighbors for the blind ensemble.");
      const fused = fuseSonicRankings({anchor:publicTrack(anchor.track),lists,count:settings.topK,method:settings.ensemble.method,agreementWeight:settings.ensemble.agreementWeight});
      if (fused.candidates.length !== settings.topK || fused.diagnostics.excludedConflictCount || fused.diagnostics.excludedSelfCount
        || settings.ensemble.componentModels.some(model=>fused.unionCandidates.reduce((sum,candidate)=>sum+candidate.nominations.filter(n=>n.analyzer===model).length,0)!==settings.topK)) throw new Error("The blind ensemble requires a complete, source-consistent top-three union.");
      for (const candidate of fused.unionCandidates) { keys.push(candidate.track.identityKey); nominations.set(candidate.track.identityKey,candidate.nominations.map(n=>({...n}))); }
      for (const [rank,candidate] of fused.candidates.entries()) nominations.get(candidate.track.identityKey).push({analyzer:ENSEMBLE_MODEL,strategyKey:settings.ensemble.strategyKey,
        identityKey:candidate.track.identityKey,rank:rank+1,baseRankScore:candidate.baseRankScore,agreement:candidate.agreement,agreementBonus:candidate.agreementBonus,
        ensembleScore:candidate.ensembleScore,componentNominations:candidate.nominations.map(n=>({...n}))});
    } else if (settings.topK !== null) {
      const byIdentity = new Map(), byHash = new Map(), byGroup = new Map(), candidateClips = new Map();
      // Evaluate every fixed top-K nomination, hearing shared recordings once.
      // Never refill a duplicate with a lower rank or attribute a rank outside K.
      for (const model of ranks) {
        const top = model.neighbors.slice(0, settings.topK), modelHashes = new Set(), modelGroups = new Set();
        if (top.length !== settings.topK) throw new Error("Not enough matched-source neighbors for the requested blind listening topK.");
        for (const [rank, neighbor] of top.entries()) {
          const item = trackByKey.get(neighbor.identityKey), hash = item?.track.analysisLocal?.sha256;
          const group = item && (item.recordingGroup || recordingGroup(item.track));
          if (!item || modelHashes.has(hash) || modelGroups.has(group)) throw new Error("The fixed topK must contain distinct matched-source recordings for each model.");
          modelHashes.add(hash); modelGroups.add(group);
          const clipId = clipFor(item.track);
          const aliases = [byIdentity.get(neighbor.identityKey),byHash.get(hash),byGroup.get(group)].filter(Boolean);
          if (aliases.some(key => candidateClips.get(key) !== clipId)) throw new Error("Shared topK nominations must use the exact same source excerpt; alternate recordings cannot share a listening judgment.");
          const key = aliases[0] || neighbor.identityKey;
          if (!nominations.has(key)) { keys.push(key); nominations.set(key, []); candidateClips.set(key,clipId); }
          byIdentity.set(neighbor.identityKey,key); byHash.set(hash,key); byGroup.set(group,key);
          nominations.get(key).push({ analyzer:model.model, specKey:model.specKey, identityKey:neighbor.identityKey, rank:rank+1, similarity:neighbor.similarity });
        }
      }
    } else {
      // Historical round-robin: four heard pairs with all top-ten memberships.
      const order = shuffle(ranks);
      for (let rank = 0; rank < 10 && keys.length < 4; rank++) for (const model of order) {
        const key = model.neighbors[rank]?.identityKey, item = trackByKey.get(key);
        if (!item || keys.includes(key) || seenHashes.has(item.track.analysisLocal.sha256) || seenGroups.has(item.recordingGroup || recordingGroup(item.track))) continue;
        keys.push(key); seenHashes.add(item.track.analysisLocal.sha256); seenGroups.add(item.recordingGroup || recordingGroup(item.track));
        if (keys.length === 4) break;
      }
      if (keys.length !== 4) throw new Error("Not enough distinct matched-source neighbors for a complete listening block.");
    }
    return { sessionId:`sonic-review:${randomUUID()}`, anchor:publicTrack(anchor.track), anchorClip:clipFor(anchor.track),
      lane:anchor.track.genre, purpose:anchor.purpose,
      candidates:shuffle(keys).map(key => ({ track:publicTrack(trackByKey.get(key).track), clipId:clipFor(trackByKey.get(key).track),
        nominations:settings.topK !== null ? nominations.get(key) : ranks.flatMap(model => { const rank = model.neighbors.findIndex(x => x.identityKey === key);
          return rank < 0 ? [] : [{ analyzer:model.model, specKey:model.specKey, rank:rank+1, similarity:model.neighbors[rank].similarity }]; }) })) };
  });
  const version = settings.ensemble ? 3 : settings.topK === null ? 1 : 2;
  const planParts = [`blind-v${version}`,manifest.createdAt,actualModels.map(analysisSpec).map(x=>x.key),anchors.map(x=>x.track.identityKey)];
  if (settings.topK !== null) planParts.push(settings.topK,settings.selectionMethod);
  if (settings.ensemble) planParts.push(settings.models,settings.ensemble);
  return { version, batchId:`blind:${randomUUID()}`, planKey:digest(planParts),
    createdAt:new Date().toISOString(), title:settings.title, count:groups.reduce((sum,g)=>sum+g.candidates.length,0), anchorCount:groups.length, groups, clips,
    models:settings.models,evaluationTopK:settings.topK ?? 10,selectionMethod:settings.selectionMethod,
    ...(settings.ensemble ? {strategies:{[ENSEMBLE_MODEL]:settings.ensemble},sourcePool:{manifestCreatedAt:manifest.createdAt,count:manifest.items.length}} : {}),
    method:settings.topK === null ? "Six metadata-stratified anchors; four distinct round-robin top nominations each; shuffled within anchor; identical source excerpts."
      : settings.ensemble ? `Six fresh metadata-stratified anchors from the same frozen ${manifest.items.length}-track pool; each v2 model's fixed top three and the frozen best-rank ensemble's top three from their union; shared recordings heard once; shuffled within anchor; identical stored 30-second excerpts; no inference or production changes.`
      : `Six metadata-stratified ${settings.selectionMethod === "metadata-stratified-random" ? "randomly sampled" : "preferred"} anchors; every selected model's fixed top ${settings.topK} nominations; shared recordings heard once; shuffled within anchor; identical source excerpts.`,
    productionPromotionAllowed:false };
}

function validateBlindEnsemblePlan(plan, db) {
  const strategy = plan.strategies?.[ENSEMBLE_MODEL];
  if (!strategy) throw new Error("The blind ensemble requires a frozen virtual strategy.");
  const expected = blindEnsembleStrategy({method:strategy.method,agreementWeight:strategy.agreementWeight});
  if (Object.keys(strategy).length !== Object.keys(expected).length || Object.keys(expected).some(key=>JSON.stringify(strategy[key]) !== JSON.stringify(expected[key]))) throw new Error("The frozen blind ensemble strategy changed.");
  const {manifest,matrices} = readFrozenBlindEnsemblePool(db,plan), tracks = new Map(manifest.items.map(item=>[item.track.identityKey,item.track]));
  const assertDescriptor = track => {
    const original = tracks.get(track?.identityKey);
    if (!original || JSON.stringify(publicTrack(track)) !== JSON.stringify(publicTrack(original))) throw new Error("The frozen blind ensemble exact identity or version descriptor changed.");
  };
  for (const [clipId,clip] of Object.entries(plan.clips)) {
    if (!/^[a-f0-9]{64}$/.test(clip.sourceSha256) || !/^[a-f0-9]{64}$/.test(clip.wavSha256)
      || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start || clip.end-clip.start > 31
      || clip.clipId !== clipId || clipId !== digest([clip.sourceSha256,clip.start,clip.end,"pcm_s16le-mono-24000-v1"])) throw new Error("The blind ensemble requires exact prepared source clips.");
  }
  const assertSource = (evidence,clip) => {
    if (evidence.sourceSha256 !== clip.sourceSha256 || JSON.stringify(evidence.spans) !== JSON.stringify([[clip.start,clip.end]])) throw new Error("The frozen blind ensemble clip no longer matches exact stored model evidence.");
  };
  for (const group of plan.groups) {
    assertDescriptor(group.anchor);
    group.candidates.forEach(candidate=>assertDescriptor(candidate.track));
    const anchorClip = plan.clips[group.anchorClip];
    // Recompute the real top three before trusting the frozen virtual replay.
    // Validating only its supplied ranks would accept a coherently forged plan.
    const lists = storedRankings(manifest,matrices,group.anchor,expected.retrievalTopK).map(list=>{
      if (list.status !== "available" || list.candidates.length !== expected.retrievalTopK) throw new Error("The frozen blind ensemble requires complete stored top-three rankings.");
      assertSource(list.anchorEvidence,anchorClip);
      const candidates = list.candidates.map(row=>{
        const frozen = group.candidates.find(candidate=>candidate.nominations.some(n=>n.analyzer===list.analyzer && n.rank===row.rank
          && (n.identityKey || candidate.track.identityKey)===row.track.identityKey));
        const nomination = frozen?.nominations.find(n=>n.analyzer===list.analyzer && n.rank===row.rank);
        if (!nomination || nomination.specKey !== list.specKey || !Number.isFinite(nomination.similarity)
          || Math.abs(nomination.similarity-row.similarity) >= .00001) throw new Error("The frozen blind ensemble nominations no longer match the stored top-three identities, ranks or vectors.");
        assertSource(row.evidence,plan.clips[frozen.clipId]);
        // Earlier frozen plans stored cosine from the already normalized Float32
        // vectors. Keep those declared values after checking the fresh cosine.
        return {...row,track:publicTrack(row.track),similarity:nomination.similarity};
      });
      return {...list,candidates};
    });
    const fused = fuseSonicRankings({anchor:publicTrack(group.anchor),lists,count:expected.finalCount,method:expected.method,agreementWeight:expected.agreementWeight});
    if (fused.candidates.length !== expected.finalCount || fused.diagnostics.excludedSelfCount || fused.diagnostics.excludedConflictCount
      || fused.unionCandidates.length !== group.candidates.length
      || expected.componentModels.some(model=>fused.unionCandidates.reduce((sum,candidate)=>sum+candidate.nominations.filter(n=>n.analyzer===model).length,0)!==expected.retrievalTopK)) throw new Error("The blind ensemble requires a complete exact-source union.");
    for (const [rank,candidate] of fused.candidates.entries()) {
      const frozen = group.candidates.find(item=>item.track.identityKey === candidate.track.identityKey || candidate.nominations.some(n=>item.nominations.some(prior=>prior.analyzer===n.analyzer && prior.identityKey===n.identityKey)));
      const nomination = frozen?.nominations.find(n=>n.analyzer===ENSEMBLE_MODEL);
      if (!nomination || nomination.strategyKey !== expected.strategyKey || nomination.specKey !== undefined || nomination.similarity !== undefined
        || nomination.identityKey !== candidate.track.identityKey || nomination.rank !== rank+1 || nomination.baseRankScore !== candidate.baseRankScore
        || nomination.agreement !== candidate.agreement || nomination.agreementBonus !== candidate.agreementBonus || nomination.ensembleScore !== candidate.ensembleScore
        || JSON.stringify(nomination.componentNominations) !== JSON.stringify(candidate.nominations)) throw new Error("The frozen blind ensemble nominations changed.");
    }
  }
}

class SonicBlindReview {
  constructor(db, {cacheDirectory, artifactRoot} = {}) {
    this.db = db;
    this.catalogReviewCacheDirectory = cacheDirectory;
    this.catalogScoutArtifactRoot = artifactRoot;
    db.exec(`CREATE TABLE IF NOT EXISTS sonic_blind_review_batch (
      batch_id TEXT PRIMARY KEY, plan_key TEXT NOT NULL UNIQUE, private_plan_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }
  plan(id = "") {
    const row = id ? this.db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id=?").get(id)
      : this.db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch ORDER BY created_at DESC LIMIT 1").get();
    return row ? JSON.parse(row.private_plan_json) : null;
  }
  create(plan) {
    const catalogReference = plan.version === 4 || plan.kind === CATALOG_REVIEW_KIND;
    const catalogScout = plan.version === 5 || plan.kind === CATALOG_SCOUT_KIND;
    const catalogOpaque = catalogReference || catalogScout;
    const catalogKind = catalogScout ? CATALOG_SCOUT_KIND : CATALOG_REVIEW_KIND;
    if (catalogReference) validateCatalogReviewPlan(plan,{db:this.db,requirePrepared:true,cacheDirectory:this.catalogReviewCacheDirectory});
    if (catalogScout) validateCatalogScoutReviewPlan(plan,{db:this.db,requirePrepared:true,cacheDirectory:this.catalogReviewCacheDirectory,artifactRoot:this.catalogScoutArtifactRoot});
    const existing = this.db.prepare("SELECT batch_id FROM sonic_blind_review_batch WHERE plan_key=?").get(plan.planKey);
    if (existing) return this.get(existing.batch_id);
    if (!catalogOpaque) {
    if (plan.version !== undefined && ![1,2,3].includes(plan.version)) throw new Error("Unsupported blind listening plan version.");
    const fixedTopK = plan.version >= 2, models = plan.models || MODELS;
    if (fixedTopK && !Array.isArray(plan.models)) throw new Error("A fixed topK listening plan requires its evaluated models.");
    if (fixedTopK) blindOptions({models,topK:plan.evaluationTopK,selectionMethod:plan.selectionMethod,title:plan.title,
      ...(plan.version === 3 ? {ensembleConfig:{method:plan.strategies?.[ENSEMBLE_MODEL]?.method,agreementWeight:plan.strategies?.[ENSEMBLE_MODEL]?.agreementWeight}} : {})});
    else if (plan.models !== undefined) blindOptions({models:plan.models});
    if ((plan.version === 3) !== models.includes(ENSEMBLE_MODEL)) throw new Error("The virtual blind ensemble requires its own plan version.");
    const complete = Array.isArray(plan.groups) && plan.groups.length === 6 && plan.groups.every(group => {
      if (!Array.isArray(group.candidates)) return false;
      if (!fixedTopK) return group.candidates.length === 4;
      if (group.candidates.length < plan.evaluationTopK || group.candidates.length > models.length * plan.evaluationTopK) return false;
      if (group.candidates.some(candidate => !Array.isArray(candidate.nominations) || !candidate.nominations.length
        || candidate.nominations.some(n => !models.includes(n.analyzer) || !Number.isInteger(n.rank) || n.rank < 1 || n.rank > plan.evaluationTopK)
        || new Set(candidate.nominations.map(n => n.analyzer)).size !== candidate.nominations.length)) return false;
      return models.every(model => {
        const ranks = group.candidates.flatMap(candidate => candidate.nominations.filter(n => n.analyzer === model).map(n => n.rank));
        return ranks.length === plan.evaluationTopK && new Set(ranks).size === plan.evaluationTopK;
      });
    });
    const count = complete ? plan.groups.reduce((sum,group)=>sum+group.candidates.length,0) : 0;
    if (!complete || !plan.clips || Object.values(plan.clips).some(c => !c.wavSha256)
      || plan.count !== undefined && plan.count !== count
      || plan.groups.some(group => !plan.clips[group.anchorClip] || group.candidates.some(candidate => !plan.clips[candidate.clipId]))) throw new Error("Publish only a complete prepared listening batch.");
    if (plan.version === 3) validateBlindEnsemblePlan(plan,this.db);
    }
    const db = this.db, now = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (catalogReference) validateCatalogReviewPlan(plan,{db});
      if (catalogScout) validateCatalogScoutReviewPlan(plan,{db,requirePrepared:true,cacheDirectory:this.catalogReviewCacheDirectory,artifactRoot:this.catalogScoutArtifactRoot});
      for (const group of plan.groups) {
        db.prepare(`INSERT INTO sonic_review_session (session_id,anchor_identity_key,anchor_json,requested_count,candidate_count,status,
          review_policy,queue_policy,profile_policy,novelty_policy,model,model_version,diagnostics_json,created_at,updated_at)
          VALUES (?,?,?,?,?,'READY','HUMAN_CONFIRM_EACH','NEVER','LISTENING_ONLY','ALLOW_KNOWN',?,'1',?,?,?)`)
          .run(group.sessionId,catalogOpaque?opaqueListeningIdentity(plan.batchId,group.sessionId,"anchor"):group.anchor.identityKey,
            JSON.stringify(catalogOpaque?musicalNames(group.anchor):group.anchor),group.candidates.length,group.candidates.length,BLIND_MODEL,
            JSON.stringify({blind:true,batchId:plan.batchId,...(catalogOpaque?{kind:catalogKind}: {})}),now,now);
        for (const [i,candidate] of group.candidates.entries()) db.prepare(`INSERT INTO sonic_review_session_item
          (session_id,item_index,candidate_identity_key,candidate_json,relation_json,status,created_at,updated_at) VALUES (?,?,?,?,'{}','PENDING',?,?)`)
          .run(group.sessionId,i,catalogOpaque?opaqueListeningIdentity(plan.batchId,group.sessionId,"candidate",i):candidate.track.identityKey,
            JSON.stringify(catalogOpaque?musicalNames(candidate.track):candidate.track),now,now);
        db.prepare(`INSERT INTO sonic_review_session_audit (session_id,event_type,source,assistant,new_value,created_at)
          VALUES (?,'BLIND_BATCH_PREPARED','LOCAL','',?,?)`).run(group.sessionId,JSON.stringify({batchId:plan.batchId}),now);
      }
      db.prepare("INSERT INTO sonic_blind_review_batch VALUES (?,?,?,?)").run(plan.batchId,plan.planKey,JSON.stringify(plan),now);
      db.exec("COMMIT");
    } catch(error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    return this.get(plan.batchId);
  }
  get(id = "") {
    const plan = this.plan(id);
    if (!plan) return {ok:true,batch:null};
    const catalogReference = plan.version === 4 && plan.kind === CATALOG_REVIEW_KIND;
    const catalogScout = plan.version === 5 && plan.kind === CATALOG_SCOUT_KIND;
    const catalogOpaque = catalogReference || catalogScout;
    const catalogKind = catalogScout ? CATALOG_SCOUT_KIND : CATALOG_REVIEW_KIND;
    const catalogPurpose = catalogScout ? CATALOG_SCOUT_PURPOSE : CATALOG_REVIEW_PURPOSE;
    const descriptor = catalogOpaque ? musicalNames : publicTrack;
    let completed = 0, offset = 0;
    const groups = plan.groups.map((group,index) => {
      const items = this.db.prepare("SELECT item_index,status,decision,review_json FROM sonic_review_session_item WHERE session_id=? ORDER BY item_index").all(group.sessionId);
      completed += items.filter(x=>x.status !== "PENDING").length;
      const media = clipId => ({url:`/api/recommendation-v2/sonic-review/blind/audio?batchId=${encodeURIComponent(plan.batchId)}&clipId=${clipId}`,
        start:catalogOpaque?0:plan.clips[clipId].start,end:catalogOpaque?Math.round((plan.clips[clipId].end-plan.clips[clipId].start)*1e6)/1e6:plan.clips[clipId].end});
      const startNumber = offset; offset += group.candidates.length;
      return {number:index+1,sessionId:group.sessionId,anchor:descriptor(group.anchor),...(catalogOpaque?{purpose:catalogPurpose}:{lane:group.lane}),anchorAudio:media(group.anchorClip),
        items:items.map(item=>({index:item.item_index,number:startNumber+item.item_index+1,candidate:descriptor(group.candidates[item.item_index].track),
          audio:media(group.candidates[item.item_index].clipId),status:item.status,decision:item.decision,review:item.review_json ? JSON.parse(item.review_json) : null}))};
    });
    const count = offset;
    return {ok:true,batch:{batchId:plan.batchId,title:plan.title,count,anchorCount:groups.length,completed,remaining:count-completed,status:completed===count ? "COMPLETED" : "READY",groups,
      ...(catalogOpaque?{kind:catalogKind,purpose:catalogPurpose}:{}),blind:true,productionApplied:false,globalRatingsChanged:false}};
  }
  save({batchId,sessionId,index,decision,listened,note = ""} = {}) {
    const allowed = ["KEEP","SKIP","WRONG_LANE","UNSURE"];
    if (!allowed.includes(decision) || !Number.isInteger(index) || typeof note !== "string" || note.length > 2000) throw new Error("Choose a valid listening decision and a note of at most 2,000 characters.");
    if (decision !== "UNSURE" && listened !== true) throw new Error("Listen to both excerpts before judging, or choose Can't judge.");
    if (!batchId || !sessionId) throw new Error("A batch and review session are required.");
    const plan = this.plan(batchId), group = plan?.groups.find(g => g.sessionId===sessionId);
    if (!group?.candidates[index]) throw new Error("This listening item does not belong to the requested batch.");
    const review = {decision,note:note.trim(),listened:listened===true,reviewer:"human",evidence:"blind-listening",globalRatingChanged:false};
    const now = new Date().toISOString(), db=this.db;
    try {
      db.exec("BEGIN IMMEDIATE");
      const prior = db.prepare("SELECT review_json FROM sonic_review_session_item WHERE session_id=? AND item_index=?").get(sessionId,index);
      if (prior.review_json === JSON.stringify(review)) { db.exec("COMMIT"); return this.get(batchId); }
      db.prepare("UPDATE sonic_review_session_item SET status='REVIEWED',decision=?,review_json=?,error='',updated_at=? WHERE session_id=? AND item_index=?")
        .run(decision==='WRONG_LANE' ? 'REJECT' : decision==='UNSURE' ? 'REVIEW_MANUALLY' : decision,JSON.stringify(review),now,sessionId,index);
      const state = db.prepare("SELECT COUNT(*) AS completed FROM sonic_review_session_item WHERE session_id=? AND status<>'PENDING'").get(sessionId);
      const next = db.prepare("SELECT MIN(item_index) AS n FROM sonic_review_session_item WHERE session_id=? AND status='PENDING'").get(sessionId).n;
      db.prepare("UPDATE sonic_review_session SET completed_count=?,current_index=?,status=?,updated_at=?,completed_at=? WHERE session_id=?")
        .run(state.completed,next??group.candidates.length,state.completed===group.candidates.length?'COMPLETED':'RUNNING',now,state.completed===group.candidates.length?now:null,sessionId);
      db.prepare(`INSERT INTO sonic_review_session_audit (session_id,event_type,item_index,source,assistant,old_value,new_value,created_at)
        VALUES (?,'BLIND_LISTENING_SAVED',?,'HUMAN','',?,?,?)`).run(sessionId,index,prior.review_json,JSON.stringify(review),now);
      db.exec("COMMIT");
    } catch(error) { try {db.exec("ROLLBACK");} catch{} throw error; }
    return this.get(batchId);
  }
  report(id = "") {
    const snapshot=this.get(id).batch;
    if(!snapshot) return {ok:true,ready:false,reason:"No prepared batch."};
    if(snapshot.remaining) return {ok:true,ready:false,remaining:snapshot.remaining,productionPromotionAllowed:false};
    const plan=this.plan(snapshot.batchId);
    if (plan.version===5 && plan.kind===CATALOG_SCOUT_KIND) return completedScoutReport(plan,snapshot);
    if (plan.version===4 && plan.kind===CATALOG_REVIEW_KIND) {
      const unfinished=snapshot.groups.flatMap(group=>group.items).filter(item=>item.review?.reviewer!=="human"
        || !["KEEP","WRONG_LANE","SKIP","UNSURE"].includes(item.review.decision)
        || item.review.decision!=="UNSURE"&&item.review.listened!==true).length;
      if(unfinished) return {ok:true,ready:false,remaining:unfinished,kind:CATALOG_REVIEW_KIND,productionPromotionAllowed:false};
      const anchors=snapshot.groups.map(group=>{
        const decisions={KEEP:0,WRONG_LANE:0,SKIP:0,UNSURE:0};
        for(const item of group.items) if(item.review?.reviewer==="human" && (item.review.listened===true || item.review.decision==="UNSURE")
          && Object.hasOwn(decisions,item.review.decision)) decisions[item.review.decision]++;
        const humanDecisions=Object.values(decisions).reduce((sum,n)=>sum+n,0);
        const acceptedReferenceFound=decisions.KEEP>0?true:humanDecisions===group.items.length&&decisions.UNSURE===0?false:null;
        return {number:group.number,anchor:group.anchor,referenceCount:group.items.length,decisions,humanDecisions,
          tentativeCoverage:{acceptedReferenceFound,finding:acceptedReferenceFound===true?"At least one reference fit this anchor in the judged excerpts.":acceptedReferenceFound===false?
            "No reference in this small excerpt set was accepted for this anchor.":"The excerpt judgments leave reference coverage uncertain."}};
      });
      return {ok:true,ready:true,batchId:snapshot.batchId,kind:CATALOG_REVIEW_KIND,purpose:CATALOG_REVIEW_PURPOSE,anchorCount:anchors.length,decisions:snapshot.count,anchors,
        productionPromotionAllowed:false,productionApplied:false,globalRatingsChanged:false,
        notes:["This deliberately selected reference set tests candidate coverage for revisited anchors; it does not compare encoders or ranking strategies.",
          "Findings apply only to these exact versions and excerpts. Uncertainty and an unaccepted reference set do not establish that suitable catalog tracks are absent.",
          "Listening judgments remain separate from global ratings and production taste or queue behavior."]};
    }
    const models=(plan.models || MODELS).map(analyzer=>{
      const pairs=[];
      for(const [gi,group] of plan.groups.entries()) for(const [i,candidate] of group.candidates.entries()) {
        const nomination=candidate.nominations.find(n=>n.analyzer===analyzer);
        if(nomination) pairs.push({rank:nomination.rank,review:snapshot.groups[gi].items[i].review});
      }
      const judged=pairs.filter(p=>p.review?.listened===true&&p.review.decision!=="UNSURE");
      const kept=judged.filter(p=>p.review.decision==="KEEP").length;
      return {analyzer,sampledNominations:pairs.length,judged:judged.length,kept,wrongLane:judged.filter(p=>p.review.decision==="WRONG_LANE").length,
        skipped:judged.filter(p=>p.review.decision==="SKIP").length,unjudged:pairs.length-judged.length,
        sampledKeepRate:judged.length?kept/judged.length:null};
    });
    return {ok:true,ready:true,batchId:snapshot.batchId,models,anchorCount:snapshot.groups.length,decisions:snapshot.count,productionPromotionAllowed:false,
      ...(plan.version >= 2 ? {evaluationTopK:plan.evaluationTopK,expectedNominationsPerModel:snapshot.groups.length*plan.evaluationTopK} : {}),
      ...(plan.version === 3 ? {strategies:plan.strategies} : {}),
      notes:[plan.version >= 2 ? `Descriptive fixed top-${plan.evaluationTopK} results on a small metadata-stratified anchor sample; not a general quality or held-out claim.`
        : "Descriptive results for a small, deliberately sampled batch; not precision at ten or a held-out quality claim.",
        "Shared nominations use the same listening judgment for each nominating model. Can't judge is excluded from quality rates.",
        "These are partial-source listening judgments. Confirm promising results on different anchors and full recordings before production changes."]};
  }
}
module.exports = { SonicBlindReview, buildBlindPlan, selectAnchors, publicTrack, BLIND_MODEL, ENSEMBLE_MODEL, blindEnsembleStrategy };
