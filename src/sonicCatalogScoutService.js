"use strict";

// Observe-only integration. Reading a sealed pilot/cache never acquires audio,
// launches analysis, opens a database or changes discovery candidates.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { assertSonicSourceSnapshot } = require("./sonicCandidateCorpus");
const { SonicCatalogScoutCache } = require("./sonicCatalogScoutCache");
const { MODELS, SELECTORS, freezeSonicCatalogScoutPool, buildSonicCatalogScouts } = require("./sonicCatalogScouts");
const PROJECT_ROOT = path.resolve(__dirname, "..");
const REQUIRED_CODE = ["src/sonicCatalogScoutService.js", "src/sonicCatalogScouts.js", "src/sonicCatalogScoutCache.js",
  "src/sonicAnalysisSpec.js", "src/sonicCandidateCorpus.js", "src/sonicAnchorExperiment.js", "src/sonicEnsembleEvaluation.js",
  "src/sonicEnsemble.js", "src/sonicEmbeddingStore.js", "src/sonicAnalysisPilot.js", "src/beatportVersionMatch.js",
  "config/sonic-analyzers.json", "config/sonic-model-code-sha256.json"];
const MAX_JSON = 4 * 1024 * 1024, MAX_CODE = 8 * 1024 * 1024;
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const sha = value => createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const defaults = () => ({ version: 1, mode: "off", selector: "mert-30s", pilotDirectory: null, scoutCount: 6, finalCount: 3, agreementWeight: 0 });
function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid catalog scout service configuration.");
}
function realRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || !fs.lstatSync(value).isDirectory() || fs.lstatSync(value).isSymbolicLink())
    throw new Error("Catalog scout service requires an existing real private directory.");
  return fs.realpathSync(value);
}
function safePath(root, target, type = "file", allowMissing = false) {
  if (!inside(root, target) || fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw new Error("Catalog scout path escaped its private root.");
  const pieces = path.relative(root, target).split(path.sep); let current = root;
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === "ENOENT" && allowMissing) return target; throw error; }
    if (stat.isSymbolicLink() || !inside(root, fs.realpathSync(current))) throw new Error("Catalog scout paths cannot contain links.");
    const final = index === pieces.length - 1;
    if (final && type === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error("Catalog scout artifact has the wrong file type.");
  }
  return target;
}
function readBytes(root, file, maximum = MAX_JSON) {
  safePath(root, file); const stat = fs.lstatSync(file);
  if (stat.size <= 0 || stat.size > maximum) throw new Error("Catalog scout artifact exceeds its bounded size.");
  const bytes = fs.readFileSync(file);
  if (bytes.length !== stat.size) throw new Error("Catalog scout artifact changed during its read.");
  return bytes;
}
function readJson(root, file, maximum) { return JSON.parse(readBytes(root, file, maximum).toString("utf8")); }
function sameAnchor(input, stored) {
  if (!plain(input)) return false;
  const id = input.tidalId ?? input.tidalTrackId ?? input.id;
  const identity = input.identityKey || (id ? `tidal:${id}` : "");
  if (identity !== stored.identityKey || !input.artist || !input.title || input.artist !== stored.artist || input.title !== stored.title) return false;
  for (const id of [input.id, input.tidalTrackId, input.tidal?.id]) {
    if (id !== undefined && id !== null && String(id) !== String(stored.tidalId)) return false;
  }
  if (input.mixName !== undefined && input.mixName !== stored.mixVersion) return false;
  for (const field of ["tidalId", "mixVersion", "isrc", "durationMs"]) {
    if (input[field] !== undefined && input[field] !== "" && String(input[field]) !== String(stored[field] ?? "")) return false;
  }
  return true;
}
function sameCandidate(value, stored) {
  const input = value?.tidal || value;
  if (!sameAnchor(input, stored)) return false;
  // Observing a prepared recording requires its actual live descriptor. A
  // shared ID alone cannot supply missing version, duration or ISRC evidence.
  return String(input.mixVersion || input.mixName || "") === String(stored.mixVersion || "")
    && String(input.isrc || "") === String(stored.isrc || "")
    && (input.durationMs ?? null) === (stored.durationMs ?? null);
}
class SonicCatalogScoutService {
  constructor(options = {}) {
    keys(options, ["privateRoot", "projectRoot", "configFile"]);
    this.projectRoot = realRoot(options.projectRoot || PROJECT_ROOT);
    this.privateRoot = realRoot(options.privateRoot || path.join(PROJECT_ROOT, "data"));
    this.configFile = path.resolve(this.privateRoot, options.configFile || "sonic-catalog-scout-config.json");
    safePath(this.privateRoot, this.configFile, "file", true);
    this.settings = defaults(); this.configurationError = null;
    if (fs.existsSync(this.configFile)) {
      try { const saved = readJson(this.privateRoot, this.configFile, 65536); this.settings = this.validSettings(saved); }
      catch { this.configurationError = "invalid-private-configuration"; }
    }
  }
  validSettings(value) {
    keys(value, ["version", "mode", "selector", "pilotDirectory", "scoutCount", "finalCount", "agreementWeight"]);
    if (value.version !== 1 || !["off", "observe"].includes(value.mode) || !SELECTORS.includes(value.selector)
      || value.scoutCount !== 6 || value.finalCount !== 3 || value.agreementWeight !== 0
      || value.pilotDirectory !== null && (typeof value.pilotDirectory !== "string" || !value.pilotDirectory || value.pilotDirectory.length > 2048))
      throw new Error("Catalog scout service supports off/observe with six scouts, three results and zero agreement bonus.");
    if (value.pilotDirectory !== null) safePath(this.privateRoot, path.resolve(this.privateRoot, value.pilotDirectory), "directory", true);
    return clone(value);
  }
  configure(input = {}) {
    keys(input, ["mode", "selector", "pilotDirectory"]);
    const next = this.validSettings({ ...this.settings, ...input });
    if (next.pilotDirectory !== null) {
      const directory = path.resolve(this.privateRoot, next.pilotDirectory);
      safePath(this.privateRoot, directory, "directory"); this.readPrepared(directory);
      next.pilotDirectory = path.relative(this.privateRoot, directory);
    }
    safePath(this.privateRoot, this.configFile, "file", true);
    // The isolated control file is the only service write, and only an explicit
    // configure call reaches it. No cache or historical file is repaired here.
    const temporary = `${this.configFile}.${randomUUID()}.tmp`;
    safePath(this.privateRoot, temporary, "file", true);
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      safePath(this.privateRoot, this.configFile, "file", true); safePath(this.privateRoot, temporary);
      fs.renameSync(temporary, this.configFile);
    } finally { if (fs.existsSync(temporary)) { safePath(this.privateRoot, temporary); fs.unlinkSync(temporary); } }
    this.settings = next; this.configurationError = null;
    return this.status();
  }
  readPrepared(directory) {
    safePath(this.privateRoot, directory, "directory");
    const plan = readJson(this.privateRoot, path.join(directory, "plan.json"));
    if (plan.version !== 1 || plan.productionApplied !== false) throw new Error("Invalid catalog scout pilot seal.");
    assert.deepEqual(plan.models, MODELS.map(analysisSpec), "Prepared catalog scout model specifications changed.");
    const poolBytes = readBytes(this.privateRoot, path.join(directory, "pool.json")), requestBytes = readBytes(this.privateRoot, path.join(directory, "request.json"));
    assert.equal(plan.poolSha256, sha(poolBytes)); assert.equal(plan.requestSha256, sha(requestBytes));
    if (!Array.isArray(plan.code?.files) || plan.code.files.length > 100) throw new Error("Catalog scout pilot requires bounded code pins.");
    const pinned = new Set();
    for (const entry of plan.code.files) {
      if (!plain(entry) || typeof entry.path !== "string" || path.isAbsolute(entry.path) || pinned.has(entry.path)
        || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error("Invalid catalog scout code pin.");
      const file = path.resolve(this.projectRoot, entry.path);
      assert.equal(sha(readBytes(this.projectRoot, file, MAX_CODE)), entry.sha256, "Prepared catalog scout code changed."); pinned.add(entry.path);
    }
    if (REQUIRED_CODE.some(file => !pinned.has(file))) throw new Error("Catalog scout pilot must pin the service and source/spec validators.");
    const pool = JSON.parse(poolBytes), request = JSON.parse(requestBytes), recipe = request.recipe;
    if (!plain(recipe) || recipe.scoutCount !== 6 || recipe.finalCount !== 3 || recipe.agreementWeight !== 0
      || recipe.productionApplied !== false) throw new Error("Prepared catalog scout recipe changed.");
    assert.deepEqual(recipe.models, MODELS.map(analysisSpec));
    if (pool.version !== 1 || pool.kind !== "catalog-scout-pilot-pool" || !Array.isArray(pool.entries) || pool.entries.length > 100
      || !Array.isArray(pool.requests) || !pool.requests.length || pool.requests.length > 4) throw new Error("Invalid bounded prepared catalog scout pool.");
    const entries = new Map();
    for (const entry of pool.entries) {
      if (!plain(entry) || entries.has(entry.track?.identityKey) || entry.source?.sourceType !== "beatport-preview") throw new Error("Prepared catalog scout sources must be distinct exact previews.");
      freezeSonicCatalogScoutPool({ items: [entry] }); assertSonicSourceSnapshot(entry.source, { track: entry.track });
      if (typeof entry.sourceFile !== "string") throw new Error("Prepared catalog source location missing.");
      safePath(directory, path.resolve(directory, entry.sourceFile));
      entries.set(entry.track.identityKey, entry);
    }
    const requests = new Set();
    for (const row of pool.requests) {
      if (!plain(row) || typeof row.requestId !== "string" || requests.has(row.requestId) || !entries.has(row.anchorIdentityKey)
        || !Array.isArray(row.candidateIdentityKeys) || row.candidateIdentityKeys.length > 20
        || new Set(row.candidateIdentityKeys).size !== row.candidateIdentityKeys.length
        || row.candidateIdentityKeys.some(key => !entries.has(key) || key === row.anchorIdentityKey)) throw new Error("Prepared catalog request identities changed.");
      requests.add(row.requestId);
    }
    return { directory, entries, requests: pool.requests, cache: new SonicCatalogScoutCache({ directory: path.join(directory, "cache"), privateRoot: this.privateRoot, maxSources: 100 }) };
  }
  prepared() {
    if (!this.settings.pilotDirectory) return { value: null, reason: "no-prepared-pilot" };
    try { return { value: this.readPrepared(path.resolve(this.privateRoot, this.settings.pilotDirectory)), reason: null }; }
    catch { return { value: null, reason: "missing-or-stale-prepared-pilot" }; }
  }
  publicConfig() {
    return { mode: this.settings.mode, selector: this.settings.selector, scoutCount: 6, finalCount: 3, agreementWeight: 0,
      pilotConfigured: Boolean(this.settings.pilotDirectory), observeOnly: true, productionApplied: false, runtimeDatabaseWrites: 0 };
  }
  status() {
    const prepared = this.prepared(), value = prepared.value;
    const counts = Object.fromEntries(MODELS.map(id => [id, { warm: 0, cold: 0, unavailable: 0 }])); let jointWarm = 0;
    if (value) for (const entry of value.entries.values()) {
      const state = value.cache.status({ track: entry.track, source: entry.source });
      if (state.jointReady) jointWarm++;
      for (const model of state.models) counts[model.analyzer][model.status]++;
    }
    return { ...this.publicConfig(), configurationError: this.configurationError, preparedPoolCount: value?.entries.size || 0,
      preparedRequestCount: value?.requests.length || 0, jointWarmSourceCount: jointWarm, models: counts,
      cacheReady: Boolean(value && jointWarm === value.entries.size && value.entries.size),
      neutral: !value || jointWarm !== value.entries.size, fallback: !value || jointWarm !== value.entries.size,
      reason: this.configurationError || prepared.reason || (jointWarm === value.entries.size ? "prepared-cache-warm" : "prepared-cache-incomplete"),
      missingModelIsNegative: false, inferenceStarted: false, orderingChanged: false };
  }
  observeCandidates(candidates = [], { options = {} } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const diagnostics = { ...this.publicConfig(), candidateCount: list.length, invoked: true, orderingChanged: false,
      scoutsReturned: 0, neutral: true, fallback: true, missingModelIsNegative: false, inferenceStarted: false };
    if (this.settings.mode === "off") return { candidates: list, diagnostics: { ...diagnostics, reason: "mode-off" } };
    const prepared = this.prepared();
    if (!prepared.value) return { candidates: list, diagnostics: { ...diagnostics, reason: prepared.reason } };
    const value = prepared.value, matches = value.requests.filter(row => sameAnchor(options.anchorTrack, value.entries.get(row.anchorIdentityKey).track));
    if (matches.length !== 1) return { candidates: list, diagnostics: { ...diagnostics, reason: "anchor-not-exact-prepared-request" } };
    const row = matches[0], anchor = value.entries.get(row.anchorIdentityKey);
    if (!row.candidateIdentityKeys.length) return { candidates: list, diagnostics: { ...diagnostics, preparedCandidateCount: 0,
      partialCoverage: false, singleModelFallback: false, reason: "no-eligible-catalog-candidates" } };
    const items = row.candidateIdentityKeys.map(key => value.entries.get(key)).filter(entry => list.some(candidate => sameCandidate(candidate, entry.track)));
    if (!items.length) return { candidates: list, diagnostics: { ...diagnostics, preparedCandidateCount: 0, reason: "no-exact-live-prepared-candidates" } };
    try {
      const pool = freezeSonicCatalogScoutPool({ items });
      const matrices = new Map(MODELS.map(analyzer => [analyzer, { spec: analysisSpec(analyzer), records: new Map() }]));
      const warmth = Object.fromEntries(MODELS.map(id => [id, { warm: 0, cold: 0, unavailable: 0 }]));
      for (const entry of [anchor, ...pool.items]) for (const analyzer of MODELS) {
        const cached = value.cache.get({ track: entry.track, source: entry.source, analyzer }); warmth[analyzer][cached.status]++;
        if (cached.status === "warm") matrices.get(analyzer).records.set(entry.track.identityKey, cached.record);
      }
      const result = buildSonicCatalogScouts({ anchor, pool, matrices, selector: this.settings.selector, mode: "observe", scoutCount: 6, finalCount: 3, agreementWeight: 0 });
      return { candidates: list, diagnostics: { ...diagnostics, scoutsReturned: result.scouts.length,
        preparedCandidateCount: pool.items.length, cache: warmth, partialCoverage: result.diagnostics.partialCoverage,
        singleModelFallback: result.diagnostics.singleModelFallback, neutral: result.diagnostics.neutral,
        fallback: result.diagnostics.fallback, reason: result.diagnostics.reason, productionApplied: false } };
    } catch { return { candidates: list, diagnostics: { ...diagnostics, reason: "invalid-or-unavailable-prepared-evidence" } }; }
  }
}
module.exports = { SonicCatalogScoutService, REQUIRED_CODE };
