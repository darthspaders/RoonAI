"use strict";

// Offline evidence report only. Never instantiate MusicMemoryStore here: its
// constructor migrates the database. No matching/linking service is invoked.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const {
  parseCanonicalCatalogIdentity, artistCreditSetKey, artistCreditValues,
  versionDescriptorFromTitle
} = require("../src/catalogIdentityNormalization");
const { artistNameCollisionRisk } = require("../src/artistIdentity");

const RULESET = "recording-identity-audit-2026-09-18-v1";
const CATEGORIES = {
  exact_duplicate: "Exact duplicate identity rows (metadata-supported)",
  different_release: "Same recording on different releases (metadata-supported)",
  version_mismatch: "Version / identity / enrichment mismatches — review required",
  distinct_recording: "Legitimate distinct recordings / title homonyms",
  needs_review: "Unresolved — insufficient or ambiguous evidence"
};
const text = value => String(value ?? "").trim();
const number = value => Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : null;
const parse = value => { try { return JSON.parse(value || "{}") || {}; } catch { return {}; } };
const uniq = values => [...new Set(values.filter(Boolean))];
const intersect = (a, b) => uniq(a.filter(value => b.includes(value)));
const validIsrc = value => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(text(value).replace(/[^a-z0-9]/gi, "").toUpperCase());
const cleanIsrc = value => validIsrc(value) ? text(value).replace(/[^a-z0-9]/gi, "").toUpperCase() : "";
const numericId = value => /^\d+$/.test(text(value)) ? text(value) : "";
const read = (db, table, query) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? db.prepare(query).all() : [];

function normalizeFact(fact) {
  const identity = parseCanonicalCatalogIdentity(fact);
  return {
    ...fact,
    durationMs: number(fact.durationMs),
    validIsrc: cleanIsrc(fact.isrc),
    normalizedArtists: artistCreditSetKey([...artistCreditValues(fact.artist), ...identity.featuredArtists]),
    baseTitle: identity.normalizedBaseTitle,
    albumFamily: identity.normalizedAlbumFamily,
    version: identity.version,
    titleVersion: versionDescriptorFromTitle(fact.title)
  };
}

// Different descriptors are not normalized away merely because both contain
// "mix". Remastering and missing version text are explicitly inconclusive.
function versionRelation(left, right) {
  if (!left?.explicit || !right?.explicit) return "unknown";
  if (left.normalized === right.normalized) return "same";
  if (left.kind === "remaster" || right.kind === "remaster") return "mastering-review";
  if (left.kind === "none" || right.kind === "none") return "unknown-descriptor";
  if (left.kind !== right.kind) return "different";
  if (["alternate", "live"].includes(left.kind)) return "different";
  const editMarkers = version => uniq(version.normalized.match(/\b(?:extended|radio|dub|instrumental|acapella|acoustic|mixed)\b/g) || []).sort().join("|");
  if (editMarkers(left) !== editMarkers(right)) return "different";
  return left.semantic === right.semantic ? "same" : "different";
}

function factConflicts(left, right, { linked = false } = {}) {
  const reasons = [];
  const sources = `${left.source} ↔ ${right.source}`;
  if (left.validIsrc && right.validIsrc && left.validIsrc !== right.validIsrc) reasons.push(`${sources}: different ISRCs (${left.validIsrc} / ${right.validIsrc})`);
  if (left.durationMs && right.durationMs && Math.abs(left.durationMs - right.durationMs) > 5000) reasons.push(`${sources}: duration difference ${Math.abs(left.durationMs - right.durationMs)} ms (>5 s)`);
  if (versionRelation(left.version, right.version) === "different") reasons.push(`${sources}: version conflict (${left.version.label} / ${right.version.label})`);
  if (left.baseTitle && right.baseTitle && left.baseTitle !== right.baseTitle) reasons.push(`${sources}: different normalized base titles`);
  // Extra featured credits are recorded for review, not automatically discarded.
  if (left.normalizedArtists && right.normalizedArtists && left.normalizedArtists !== right.normalizedArtists) reasons.push(`${sources}: different normalized artist credits`);
  if (linked && left.tidalId && right.tidalId && left.tidalId !== right.tidalId) reasons.push(`${sources}: different TIDAL IDs in an asserted identity link`);
  return reasons;
}

function makeRecord(row, beatport = null, providers = []) {
  const primary = normalizeFact({ source: "track_identity", artist: text(row.artist), title: text(row.title), mixVersion: text(row.mix_version), album: text(row.album), durationMs: row.duration_ms, isrc: text(row.isrc), tidalId: numericId(row.tidal_id), providerIds: parse(row.provider_ids) });
  const facts = [primary];
  if (beatport) {
    const raw = parse(beatport.raw_json);
    const artists = Array.isArray(raw.artists) ? raw.artists : [];
    facts.push(normalizeFact({ source: "beatport", providerTrackId: text(beatport.beatport_track_id), artist: artists.map(item => text(item.name)).filter(Boolean).join(", "), title: text(raw.name || raw.title), mixVersion: text(raw.mix_name || raw.mixName), album: text(beatport.release_title), releaseId: text(beatport.release_id), durationMs: beatport.duration_ms, isrc: text(beatport.isrc), artistIds: parse(beatport.artist_ids || "[]"), remixerIds: parse(beatport.remixer_ids || "[]"), genre: text(beatport.genre), bpm: beatport.bpm, confidence: beatport.confidence, fetchedAt: beatport.fetched_at }));
  }
  const secondaryProviders = [];
  for (const provider of providers) {
    const raw = parse(provider.raw_json);
    const fact = normalizeFact({ source: provider.provider, providerTrackId: text(provider.provider_track_id), tidalId: provider.provider === "tidal" ? numericId(provider.provider_track_id) : "", artist: text(typeof raw.artist === "string" ? raw.artist : ""), title: text(raw.title || raw.name), mixVersion: text(raw.mix_name || raw.mixName || raw.version), album: text(provider.release_title), releaseId: text(provider.release_id || raw.album?.id), durationMs: provider.duration_ms, isrc: text(provider.isrc), confidence: provider.confidence, fetchedAt: provider.fetched_at });
    if (provider.provider === "tidal") facts.push(fact);
    else if (provider.provider !== "beatport") secondaryProviders.push(fact);
  }
  const conflicts = [];
  for (const fact of facts) if (versionRelation(fact.version, fact.titleVersion) === "different") conflicts.push(`${fact.source}: explicit mix contradicts title version`);
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) conflicts.push(...factConflicts(facts[i], facts[j]));
  return { id: Number(row.id), identityKey: row.identity_key, primary, facts, secondaryProviders, conflicts: uniq(conflicts), alias: null, coverage: null, observations: [], latestRating: null };
}

function readSnapshot(dbFile, { extraRead = null } = {}) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const identities = db.prepare("SELECT * FROM track_identity ORDER BY id").all();
    const beatport = new Map(read(db, "beatport_enrichment", "SELECT * FROM beatport_enrichment").map(row => [row.track_identity_id, row]));
    const providers = new Map();
    for (const row of read(db, "provider_enrichment", "SELECT * FROM provider_enrichment ORDER BY fetched_at DESC, id DESC")) {
      if (!providers.has(row.track_identity_id)) providers.set(row.track_identity_id, new Map());
      const entries = providers.get(row.track_identity_id);
      if (!entries.has(row.provider)) entries.set(row.provider, row);
    }
    const records = identities.map(row => makeRecord(row, beatport.get(row.id), [...(providers.get(row.id)?.values() || [])]));
    const byId = new Map(records.map(record => [record.id, record]));
    const byKey = new Map(records.map(record => [record.identityKey, record]));
    const aliases = read(db, "track_identity_alias", "SELECT * FROM track_identity_alias");
    for (const alias of aliases) if (byId.has(alias.alias_identity_id)) byId.get(alias.alias_identity_id).alias = { canonicalId: alias.canonical_identity_id, relation: alias.relation, confidence: alias.confidence, source: alias.source };
    for (const work of read(db, "sonic_coverage_work", "SELECT identity_key, state, resolved_identity_key FROM sonic_coverage_work")) {
      if (byKey.has(work.identity_key)) byKey.get(work.identity_key).coverage = { state: work.state, resolvedKey: work.resolved_identity_key };
    }
    for (const row of read(db, "taste_feedback", "SELECT id, track_identity_id, rating, created_at FROM taste_feedback ORDER BY created_at DESC, id DESC")) {
      const record = byId.get(row.track_identity_id);
      if (record && !record.latestRating) record.latestRating = { id: row.id, rating: row.rating, at: row.created_at };
    }
    // Preserve selected provenance only; never export prompts, queue tokens,
    // file paths, preview credentials, audio or embedding vectors.
    for (const row of read(db, "track_observation", `SELECT track_identity_id, source, COUNT(*) AS observationRows, MAX(observed_at) AS latestAt FROM track_observation GROUP BY track_identity_id, source`)) {
      byId.get(row.track_identity_id)?.observations.push({ source: row.source, count: row.observationRows, latestAt: row.latestAt });
    }
    const sourceTrackIds = read(db, "track_observation", `SELECT DISTINCT track_identity_id, source, json_extract(raw_json, '$.trackId') AS rawTrackId FROM track_observation WHERE json_valid(raw_json) AND json_extract(raw_json, '$.trackId') IS NOT NULL`);
    for (const row of sourceTrackIds) {
      const record = byId.get(row.track_identity_id);
      if (record) (record.sourceTrackIdClaims ||= []).push({ source: row.source, rawTrackId: text(row.rawTrackId), note: "Unqualified trackId retained as provenance; not assumed to be TIDAL." });
    }
    for (const record of records) {
      const targets = uniq([record.alias?.canonicalId, byKey.get(record.coverage?.resolvedKey)?.id]).filter(id => id !== record.id);
      record.linkedRowIds = targets;
      for (const id of targets) {
        const target = byId.get(id);
        if (!target) continue;
        const targetFact = { ...target.primary, source: `persisted-link:${id}:${target.identityKey}` };
        for (const fact of record.facts) record.conflicts.push(...factConflicts(fact, targetFact, { linked: true }));
      }
      record.conflicts = uniq(record.conflicts);
    }
    // Related offline diagnostics can reuse this exact read-only transaction.
    // This hook is not used by the application or by any mutation workflow.
    const extra = extraRead ? extraRead(db) : undefined;
    return { generatedAt: new Date().toISOString(), dbFile: path.resolve(dbFile), readOnly: true, connectionChanges: db.prepare("SELECT total_changes() AS changes").get().changes, aliasCount: aliases.length, records, extra };
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

const identifiers = (record, field) => uniq(record.facts.map(fact => fact[field]));
const bpIds = record => record.facts.filter(fact => fact.source === "beatport").map(fact => fact.providerTrackId).filter(Boolean);
const versions = record => record.facts.map(fact => fact.version).filter(version => version.explicit);
const durations = record => record.facts.map(fact => fact.durationMs).filter(Boolean);

function differentReleases(a, b) {
  const evidence = [];
  for (const provider of ["tidal", "beatport"]) {
    const left = a.facts.find(fact => fact.source === provider);
    const right = b.facts.find(fact => fact.source === provider);
    if (left?.releaseId && right?.releaseId && left.releaseId !== right.releaseId) evidence.push(`${provider} release IDs ${left.releaseId} / ${right.releaseId}`);
    else if (left?.albumFamily && right?.albumFamily && left.albumFamily !== right.albumFamily) evidence.push(`${provider} release families differ (${left.album} / ${right.album})`);
  }
  if (a.primary.albumFamily && b.primary.albumFamily && a.primary.albumFamily !== b.primary.albumFamily) evidence.push(`identity album families differ (${a.primary.album} / ${b.primary.album})`);
  return evidence;
}

function classifyPair(a, b, candidateReasons = []) {
  const sameIsrc = intersect(identifiers(a, "validIsrc"), identifiers(b, "validIsrc"));
  const sameTidal = intersect(identifiers(a, "tidalId"), identifiers(b, "tidalId"));
  const sameBeatport = intersect(bpIds(a), bpIds(b));
  const linked = (a.linkedRowIds || []).includes(b.id) || (b.linkedRowIds || []).includes(a.id);
  const identityClaim = Boolean(sameIsrc.length || sameTidal.length || sameBeatport.length || linked);
  const artistsEqual = Boolean(a.primary.normalizedArtists && a.primary.normalizedArtists === b.primary.normalizedArtists);
  const titlesEqual = Boolean(a.primary.baseTitle && a.primary.baseTitle === b.primary.baseTitle);
  const artistsOverlap = intersect(a.primary.normalizedArtists.split("|"), b.primary.normalizedArtists.split("|")).length > 0;
  const relations = versions(a).flatMap(left => versions(b).map(right => versionRelation(left, right)));
  const versionDifference = relations.includes("different");
  const leftDurations = durations(a), rightDurations = durations(b);
  const durationSpreadMs = leftDurations.length && rightDurations.length ? Math.max(...leftDurations, ...rightDurations) - Math.min(...leftDurations, ...rightDurations) : null;
  const releaseDifferences = differentReleases(a, b);
  const evidence = [...sameIsrc.map(id => `shared ISRC ${id}`), ...sameTidal.map(id => `shared TIDAL ${id}`), ...sameBeatport.map(id => `shared Beatport ${id}`), ...(linked ? ["existing alias / coverage-resolution claim"] : []), ...(artistsEqual ? ["normalized artist credits agree"] : []), ...(titlesEqual ? ["normalized base title agrees"] : []), ...(durationSpreadMs === null ? ["duration missing on at least one row"] : [`all source durations span ${durationSpreadMs} ms`]), ...releaseDifferences];
  const finish = (category, reasons) => ({ a: a.id, b: b.id, category, candidateReasons, evidence, reasons, durationSpreadMs });
  if ([a, b].some(record => /(?:\bdi[.\s-]*fm\b|\bdigitally imported\b|\binternet radio\b)/i.test(record.primary.title))) return finish("needs_review", ["Station/broadcast title in track identity: raw radio metadata must be resolved before recording identity classification."]);
  const conflicts = [...a.conflicts.map(reason => `row ${a.id}: ${reason}`), ...b.conflicts.map(reason => `row ${b.id}: ${reason}`)];
  if (conflicts.length) return finish(conflicts.some(reason => !reason.includes("different normalized artist credits")) ? "version_mismatch" : "needs_review", conflicts);
  if (!artistsEqual && !artistsOverlap && a.primary.normalizedArtists && b.primary.normalizedArtists && !identityClaim) return finish("distinct_recording", ["Same-title homonyms with different full artist credits; no shared recording/provider identifiers. No inference that these are performances of the same composition."]);
  if (identityClaim && (!artistsEqual || !titlesEqual || versionDifference || durationSpreadMs > 5000)) return finish("version_mismatch", ["Shared identifier/link contradicts artist, title, mix/version or duration evidence; identifier equality must not override the conflict."]);
  if (versionDifference && artistsEqual && titlesEqual) return finish("distinct_recording", ["Explicit mix/edit/performance versions differ, with no shared identifier/link claiming equivalence."]);
  if (!artistsEqual || !titlesEqual) return finish("needs_review", ["Artist credits or normalized base titles do not agree completely."]);
  if (artistNameCollisionRisk(a.primary.artist, b.primary.artist)) return finish("needs_review", ["Potential artist spelling / diacritic / acronym collision."]);
  if (relations.includes("mastering-review") || relations.includes("unknown-descriptor")) return finish("needs_review", ["Different mastering or unrecognized version descriptors need explicit review."]);
  if (durationSpreadMs === null || durationSpreadMs > 2000) return finish("needs_review", ["Missing duration or duration spread exceeds the strict 2-second audit tolerance; 2–5 seconds still requires review."]);
  if ([a, b].some(record => !record.facts.some(fact => ["track_identity", "tidal"].includes(fact.source) && fact.durationMs))) return finish("needs_review", ["At least one row has duration only from Beatport enrichment; the same copied match must not corroborate itself."]);
  if (!sameIsrc.length && !sameTidal.length && !(linked && sameBeatport.length)) return finish("needs_review", ["Artist/title/duration similarity or a shared Beatport enrichment alone is insufficient recording identity evidence."]);
  const differentIsrcs = uniq([...identifiers(a, "validIsrc"), ...identifiers(b, "validIsrc")]);
  if (differentIsrcs.length > 1) return finish("needs_review", ["Different valid ISRCs require reconciliation even when other identifiers agree."]);
  if (releaseDifferences.length) return finish("different_release", ["Recording evidence agrees within 2 seconds; identified releases differ. This is a metadata-supported candidate, not an audio comparison."]);
  if (a.primary.tidalId && b.primary.tidalId && a.primary.tidalId !== b.primary.tidalId) return finish("needs_review", ["Same-recording evidence is strong, but distinct TIDAL catalog items have insufficient release evidence to classify as exact duplicates versus alternate releases."]);
  const albumEvidence = Boolean(a.primary.albumFamily && a.primary.albumFamily === b.primary.albumFamily) || a.facts.some(left => b.facts.some(right => left.source === right.source && left.releaseId && left.releaseId === right.releaseId));
  if (!sameTidal.length && !sameBeatport.length && !albumEvidence) return finish("needs_review", ["Recording evidence agrees but there is not enough release evidence to distinguish an exact duplicate from a release variant."]);
  return finish("exact_duplicate", ["Same recording/provider evidence and compatible release context; metadata-exact duplicate identity rows, not verified byte-identical audio."]);
}

function buildReport(snapshot) {
  const blocks = new Map();
  const add = (key, id) => { if (!blocks.has(key)) blocks.set(key, new Set()); blocks.get(key).add(id); };
  const records = snapshot.records;
  const byId = new Map(records.map(record => [record.id, record]));
  for (const record of records) {
    // Include title homonyms across artists so legitimate distinct recordings
    // are visible, rather than silently considering only positive duplicates.
    if (record.primary.baseTitle) add(`base-title:${record.primary.baseTitle}`, record.id);
    for (const id of identifiers(record, "validIsrc")) add(`isrc:${id}`, record.id);
    for (const id of identifiers(record, "tidalId")) add(`tidal:${id}`, record.id);
    for (const id of bpIds(record)) add(`beatport:${id}`, record.id);
    for (const id of record.linkedRowIds || []) if (byId.has(id)) { add(`link:${id}`, record.id); add(`link:${id}`, id); }
  }
  const candidates = new Map();
  for (const [key, block] of blocks) {
    const ids = [...block].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const pairKey = `${ids[i]}:${ids[j]}`;
      if (!candidates.has(pairKey)) candidates.set(pairKey, { a: ids[i], b: ids[j], reasons: [] });
      candidates.get(pairKey).reasons.push(key);
    }
  }
  const pairs = [...candidates.values()].map(pair => classifyPair(byId.get(pair.a), byId.get(pair.b), pair.reasons)).sort((a, b) => a.a - b.a || a.b - b.b);
  const counts = Object.fromEntries(Object.keys(CATEGORIES).map(category => [category, { pairs: pairs.filter(pair => pair.category === category).length, affectedRows: new Set(pairs.filter(pair => pair.category === category).flatMap(pair => [pair.a, pair.b])).size }]));
  const identityKinds = {};
  for (const record of records) { const kind = record.identityKey.split(":")[0]; identityKinds[kind] = (identityKinds[kind] || 0) + 1; }
  const sourceHashes = Object.fromEntries([__filename, require.resolve("../src/catalogIdentityNormalization"), require.resolve("../src/artistIdentity")].map(file => [path.basename(file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  return { ...snapshot, ruleset: RULESET, sourceHashes, counts, identityKinds, candidatePairs: pairs.length, rowsWithInternalConflicts: records.filter(record => record.conflicts.length).map(record => record.id), invalidIsrcRows: records.filter(record => record.facts.some(fact => fact.isrc && !fact.validIsrc)).map(record => record.id), pairs };
}

const cell = value => String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const durationText = values => uniq(values).map(value => `${(value / 1000).toFixed(3)} s`).join(" / ") || "unknown";
function recordSummary(record) {
  const bp = record.facts.find(fact => fact.source === "beatport");
  return `${record.id}: ${record.primary.artist} — ${record.primary.title}; mix=${uniq(versions(record).map(version => version.label)).join(" / ") || "unspecified"}; duration=${durationText(durations(record))}; ISRC=${identifiers(record, "validIsrc").join(" / ") || "missing"}; TIDAL=${identifiers(record, "tidalId").join(" / ") || "missing"}; BP=${bp?.providerTrackId || "missing"}; album=${record.primary.album || "missing"}; BP release=${bp?.releaseId || "missing"} (${bp?.album || "missing"})`;
}

function renderMarkdown(report) {
  const byId = new Map(report.records.map(record => [record.id, record]));
  const lines = ["# Rabbit Hole recording identity audit", "", `Snapshot: ${report.generatedAt}. Rules: ${report.ruleset}.`, "", `Read-only SQLite transaction; changes on audit connection: **${report.connectionChanges}**. ${report.records.length} identity rows; ${report.aliasCount} existing aliases; ${report.candidatePairs} candidate pairs. No merge, correction, schema change, provider call, playback action or Sonic operation was performed.`, "", "Pair counts are not a deletion count or a unique recording count. A row can occur in several categories. Positive pairs are not transitively merged into clusters. 'Exact' means metadata-supported identity duplication; audio was not compared.", "", "| Classification | Pairs | Affected rows |", "| --- | ---: | ---: |", ...Object.entries(report.counts).map(([category, count]) => `| ${CATEGORIES[category]} | ${count.pairs} | ${count.affectedRows} |`), "", `Identity keys: ${Object.entries(report.identityKinds).map(([kind, count]) => `${kind}=${count}`).join(", ")}. Rows with internal/link contradictions: ${report.rowsWithInternalConflicts.length}. Invalid-format ISRC rows: ${report.invalidIsrcRows.length}.`, "", "## Method and limits", "", "Candidates share a normalized base title, a valid ISRC, a TIDAL ID, a Beatport ID, or a stored alias/coverage-resolution link. Existing catalog normalization is reused; no fuzzy spelling/translation search is performed, so this is not an exhaustive audio-identity census. Candidate blocks are evidence retrieval only.", "", "All current track-identity, Beatport and latest TIDAL source facts are kept separately. Beatport mix_name is read from raw_json. MusicBrainz and Discogs are preserved as secondary context, not additional votes for a match. Aliases and coverage resolutions are claims to check, not independent proof. Raw standby trackId values are not automatically interpreted as TIDAL IDs.", "", "Matching requires artist/base-title agreement, corroborating identifiers, no contradictory versions/ISRCs, and all available full-track durations within 2 seconds. A 2–5 second spread remains unresolved; larger disagreement blocks a positive result. Preview duration and embedding similarity are never identity evidence. Missing versions are unknown, not proof of Original Mix. Remaster differences are reviewed separately. Stored confidence 0 may be a missing legacy value; it is not interpreted as a calibrated probability.", "", "Different explicit mixes/edits/performances without a contradictory shared ID are classified as distinct; claimed identity with conflicting facts is classified as a mismatch. Different artists sharing a title are reported as homonyms, without asserting a shared composition. Partial artist credits, unsupported version descriptors, missing durations or weak IDs stay unresolved. Artist name splitting can be ambiguous for band names; namespaced provider artist identities should be verified before any future linking.", "", "## Screenshot rows", ""];
  for (const id of [115, 4723, 8050, 116, 4724, 494771, 500780, 499400, 507695, 770, 3278, 3301, 5490]) {
    const record = byId.get(id);
    if (!record) continue;
    lines.push(`- ${recordSummary(record)}. Identity key: \`${record.identityKey}\`. Rating: ${record.latestRating?.rating || "unrated"}. Alias: ${record.alias?.canonicalId || "none"}. Coverage resolved key: ${record.coverage?.resolvedKey || "none"}.`);
    for (const conflict of record.conflicts) lines.push(`  - **Conflict:** ${conflict}`);
  }
  for (const [category, label] of Object.entries(CATEGORIES)) {
    lines.push("", `## ${label}`, "", "| Row A — source evidence | Row B — source evidence | Reasons / shared evidence |", "| --- | --- | --- |");
    for (const pair of report.pairs.filter(item => item.category === category)) lines.push(`| ${cell(recordSummary(byId.get(pair.a)))} | ${cell(recordSummary(byId.get(pair.b)))} | ${cell([...pair.evidence, ...pair.reasons].join("; "))} |`);
  }
  lines.push("", "## Row-level contradictions (including rows without a candidate pair)", "", "| Row | Source evidence | Contradictions |", "| --- | --- | --- |");
  for (const record of report.records.filter(item => item.conflicts.length)) lines.push(`| ${record.id} | ${cell(recordSummary(record))} | ${cell(record.conflicts.join("; "))} |`);
  lines.push("", "## Conservative exclusions", "", "A duration copied only from Beatport enrichment cannot independently validate that same match: every positive pair also needs a stored track-identity or TIDAL duration on each row. Partial artist credits, station/broadcast titles and unclear release distinctions between different TIDAL IDs stay unresolved. Pair mismatch counts include candidates touching a row with conflicting source facts; they are not a count of proven wrong mixes. Row conflict lists also contain credit differences that may be harmless omissions. Source-code SHA-256 hashes are included in the JSON for reproducibility.", "", "The adjacent JSON contains every source-attributed record, normalized comparison value, current alias/coverage claim, latest rating, limited observation provenance and every pair decision. No report output is consumed by the application.", "");
  return lines.join("\n");
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (["--db", "--out"].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith("--")) args[argv[i].slice(2)] = path.resolve(argv[++i]);
    else if (["--help", "-h"].includes(argv[i])) { console.log("node scripts/audit-recording-duplicates.js [--db path] --out NEW_DIRECTORY\nRead-only audit. Refuses to overwrite an existing output directory."); return; }
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!args.out) throw new Error("--out NEW_DIRECTORY is required");
  if (fs.existsSync(args.out)) throw new Error("Output directory already exists; choose a new directory to preserve audit evidence");
  const report = buildReport(readSnapshot(args.db || require("../src/config").musicMemory.dbFile));
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.mkdirSync(args.out);
  fs.writeFileSync(path.join(args.out, "duplicates.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  fs.writeFileSync(path.join(args.out, "duplicates.md"), renderMarkdown(report), { flag: "wx" });
  console.log(JSON.stringify({ generatedAt: report.generatedAt, identityRows: report.records.length, aliases: report.aliasCount, identityKinds: report.identityKinds, candidatePairs: report.candidatePairs, counts: report.counts, rowsWithInternalConflicts: report.rowsWithInternalConflicts.length, connectionChanges: report.connectionChanges, out: args.out }, null, 2));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { makeRecord, normalizeFact, versionRelation, classifyPair, readSnapshot, buildReport, renderMarkdown, validIsrc };
