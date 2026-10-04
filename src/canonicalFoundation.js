"use strict";

// Explicit maintenance migration only. Never imported by playback/discovery/startup.
const { randomUUID, createHash } = require("node:crypto");
const VERSION = 1;
const STATE = "CHECK(state IN ('PROPOSED','VERIFIED','DISPUTED','REVOKED'))";
const stamp = "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)";
const definitions = {
  canonical_migration: "version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  canonical_artist: `id TEXT PRIMARY KEY, display_name TEXT NOT NULL, comparison_key TEXT, ${stamp}`,
  canonical_credit_set: "id TEXT PRIMARY KEY",
  canonical_artist_credit: "credit_set_id TEXT NOT NULL REFERENCES canonical_credit_set(id), position INTEGER NOT NULL, artist_id TEXT REFERENCES canonical_artist(id), raw_name TEXT NOT NULL, comparison_key TEXT, role TEXT NOT NULL, join_phrase TEXT, PRIMARY KEY(credit_set_id,position)",
  canonical_source_object: `id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('track','release','appearance','legacy','artist','other')), provider TEXT NOT NULL CHECK(provider=lower(trim(provider)) AND length(provider)>0), external_id TEXT NOT NULL CHECK(length(trim(external_id))>0), ${stamp}, UNIQUE(provider,kind,external_id)`,
  canonical_source_snapshot: "id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES canonical_source_object(id), source_revision INTEGER NOT NULL CHECK(source_revision>0), retrieved_at TEXT NOT NULL, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), legacy_table TEXT, legacy_row_key TEXT, content_hash TEXT, UNIQUE(source_id,source_revision)",
  canonical_release_family: `id TEXT PRIMARY KEY, preferred_title TEXT, credit_set_id TEXT REFERENCES canonical_credit_set(id), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), reviewer TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'PROPOSED' ${STATE}, ${stamp}`,
  canonical_recording: `id TEXT PRIMARY KEY, preferred_title TEXT, normalized_base_title TEXT, version_json TEXT CHECK(version_json IS NULL OR json_valid(version_json)), original_version_text TEXT, credit_set_id TEXT REFERENCES canonical_credit_set(id), performance_context TEXT, duration_ms INTEGER, duration_min_ms INTEGER, duration_max_ms INTEGER, state TEXT NOT NULL DEFAULT 'PROPOSED' ${STATE}, ${stamp}, CHECK(duration_min_ms IS NULL OR duration_max_ms IS NULL OR duration_min_ms<=duration_max_ms)`,
  canonical_release: `id TEXT PRIMARY KEY, preferred_title TEXT, normalized_title TEXT, release_type TEXT, credit_set_id TEXT REFERENCES canonical_credit_set(id), edition TEXT, edition_date TEXT, edition_year INTEGER, date_precision TEXT, original_release_date TEXT, label_refs_json TEXT CHECK(label_refs_json IS NULL OR json_valid(label_refs_json)), catalog_assertions_json TEXT CHECK(catalog_assertions_json IS NULL OR json_valid(catalog_assertions_json)), territory TEXT, format TEXT, mastering_context TEXT, family_id TEXT REFERENCES canonical_release_family(id), state TEXT NOT NULL DEFAULT 'PROPOSED' ${STATE}, ${stamp}`,
  canonical_provider_track: "source_id TEXT PRIMARY KEY REFERENCES canonical_source_object(id), original_artist TEXT, original_title TEXT, version_text TEXT, credit_set_id TEXT REFERENCES canonical_credit_set(id), duration_ms INTEGER, isrc_claims_json TEXT CHECK(isrc_claims_json IS NULL OR json_valid(isrc_claims_json)), playback_url TEXT, availability_json TEXT, territory TEXT, quality TEXT, snapshot_id TEXT NOT NULL REFERENCES canonical_source_snapshot(id)",
  canonical_provider_release: "source_id TEXT PRIMARY KEY REFERENCES canonical_source_object(id), original_title TEXT, release_type TEXT, original_artist TEXT, credit_set_id TEXT REFERENCES canonical_credit_set(id), release_date TEXT, original_release_date TEXT, label TEXT, catalog_number TEXT, upc TEXT, territory TEXT, format TEXT, track_count INTEGER, snapshot_id TEXT NOT NULL REFERENCES canonical_source_snapshot(id)",
  canonical_provider_appearance: "source_id TEXT PRIMARY KEY REFERENCES canonical_source_object(id), track_source_id TEXT NOT NULL REFERENCES canonical_provider_track(source_id), release_source_id TEXT NOT NULL REFERENCES canonical_provider_release(source_id), disc TEXT, side TEXT, sequence INTEGER, position TEXT, territory TEXT, snapshot_id TEXT NOT NULL REFERENCES canonical_source_snapshot(id), provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))",
  canonical_release_track: `id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES canonical_release(id), recording_id TEXT REFERENCES canonical_recording(id), disc TEXT, side TEXT, sequence INTEGER, position TEXT, displayed_title TEXT, credit_set_id TEXT REFERENCES canonical_credit_set(id), displayed_duration_ms INTEGER, provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)), ${stamp}`,
  canonical_identifier_assertion: "id TEXT PRIMARY KEY, recording_id TEXT REFERENCES canonical_recording(id), source_id TEXT NOT NULL REFERENCES canonical_source_object(id), snapshot_id TEXT NOT NULL REFERENCES canonical_source_snapshot(id), scheme TEXT NOT NULL, original_value TEXT NOT NULL, normalized_value TEXT, validity TEXT NOT NULL CHECK(validity IN ('VALID','INVALID','UNKNOWN','DISPUTED')), reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  canonical_metadata_assertion: "id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES canonical_source_object(id), snapshot_id TEXT NOT NULL REFERENCES canonical_source_snapshot(id), field TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)), language TEXT, confidence REAL, validation_state TEXT NOT NULL DEFAULT 'UNKNOWN', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  canonical_artwork_repair: "id TEXT PRIMARY KEY, legacy_track_id INTEGER NOT NULL REFERENCES track_identity(id), original_url TEXT NOT NULL, replacement_url TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES canonical_provider_track(source_id), snapshot_id TEXT NOT NULL REFERENCES canonical_source_snapshot(id), legacy_snapshot_id INTEGER NOT NULL REFERENCES provider_enrichment(id), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT, revocation_reason TEXT, UNIQUE(legacy_track_id,original_url,legacy_snapshot_id)",
  canonical_artwork_variant: "id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES canonical_source_object(id), snapshot_id TEXT NOT NULL REFERENCES canonical_source_snapshot(id), provider_release_source_id TEXT REFERENCES canonical_provider_release(source_id), release_link_id TEXT REFERENCES canonical_release_link(id), membership_link_id TEXT REFERENCES canonical_membership_link(id), role TEXT CHECK(role IN ('front','back','disc','other')), url TEXT, cached_asset TEXT, width INTEGER, height INTEGER, content_hash TEXT, attribution TEXT, retrieved_at TEXT NOT NULL, health TEXT NOT NULL DEFAULT 'UNCHECKED' CHECK(health IN ('UNCHECKED','OK','DEAD','INVALID','NETWORK_FAILURE')), checked_at TEXT, CHECK(url IS NOT NULL OR cached_asset IS NOT NULL)"
};
for (const [kind, target] of [["recording", "canonical_recording"], ["release", "canonical_release"], ["membership", "canonical_release_track"]]) {
  definitions[`canonical_${kind}_link`] = `id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES canonical_source_object(id), target_id TEXT NOT NULL REFERENCES ${target}(id), state TEXT NOT NULL ${STATE}, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), ruleset TEXT NOT NULL, reviewer TEXT NOT NULL, decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, source_revision INTEGER NOT NULL, reason TEXT NOT NULL, supersedes_id TEXT UNIQUE REFERENCES canonical_${kind}_link(id), FOREIGN KEY(source_id,source_revision) REFERENCES canonical_source_snapshot(source_id,source_revision)`;
}
const tables = Object.keys(definitions);
let SQL = Object.entries(definitions).map(([table, fields]) => `CREATE TABLE ${table} (${fields});`).join("\n");
SQL += "\nCREATE INDEX canonical_identifier_lookup ON canonical_identifier_assertion(scheme,normalized_value);";
SQL += "\nCREATE INDEX canonical_recording_lookup ON canonical_recording(normalized_base_title);";
for (const kind of ["recording", "release", "membership"]) {
  const table = `canonical_${kind}_link`;
  SQL += `
    CREATE VIEW ${table}_current AS SELECT l.* FROM ${table} l WHERE NOT EXISTS(SELECT 1 FROM ${table} n WHERE n.supersedes_id=l.id);
    CREATE VIEW ${table}_verified AS SELECT l.* FROM ${table}_current l JOIN canonical_source_object s ON s.id=l.source_id AND s.revision=l.source_revision WHERE l.state='VERIFIED';
    CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append a superseding decision'); END;
    CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append a revocation'); END;
    CREATE TRIGGER ${table}_validate BEFORE INSERT ON ${table} BEGIN
      SELECT CASE WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${table}_current WHERE id=NEW.supersedes_id AND source_id=NEW.source_id) THEN RAISE(ABORT,'invalid decision predecessor') END;
      SELECT CASE WHEN NEW.state='VERIFIED' AND NEW.source_revision<>(SELECT revision FROM canonical_source_object WHERE id=NEW.source_id) THEN RAISE(ABORT,'stale source revision') END;
      SELECT CASE WHEN NEW.state='VERIFIED' AND EXISTS(SELECT 1 FROM ${table}_current WHERE source_id=NEW.source_id AND state='VERIFIED' AND id IS NOT NEW.supersedes_id) THEN RAISE(ABORT,'source already has a verified target') END;
    END;`;
}
for (const [table,kind] of [["canonical_provider_track","track"],["canonical_provider_release","release"],["canonical_provider_appearance","appearance"]]) {
  for (const operation of ['INSERT','UPDATE']) SQL += `CREATE TRIGGER ${table}_validate_${operation} BEFORE ${operation} ON ${table} BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM canonical_source_object s JOIN canonical_source_snapshot p ON p.source_id=s.id WHERE s.id=NEW.source_id AND s.kind='${kind}' AND p.id=NEW.snapshot_id) THEN RAISE(ABORT,'source kind or snapshot mismatch') END;
  END;`;
}
SQL += `CREATE TRIGGER canonical_source_identity_immutable BEFORE UPDATE OF provider,kind,external_id ON canonical_source_object
  WHEN NEW.provider<>OLD.provider OR NEW.kind<>OLD.kind OR NEW.external_id<>OLD.external_id BEGIN SELECT RAISE(ABORT,'immutable provider identity'); END;`;
for (const table of ["canonical_recording", "canonical_release", "canonical_release_family", "canonical_artist", "canonical_source_object", "canonical_release_track"]) {
  SQL += `CREATE TRIGGER ${table}_immutable_id BEFORE UPDATE OF id ON ${table} WHEN NEW.id<>OLD.id BEGIN SELECT RAISE(ABORT,'immutable local ID'); END;`;
}
for (const table of ["canonical_source_snapshot", "canonical_identifier_assertion", "canonical_metadata_assertion"]) {
  for (const operation of ["UPDATE", "DELETE"]) SQL += `CREATE TRIGGER ${table}_no_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;`;
}
const checksum = createHash("sha256").update(SQL).digest("hex");
function migrate(db, { before, after } = {}) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
  try {
    const baseline = before?.(db);
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='canonical_migration'").get();
    if (exists) {
      const row = db.prepare("SELECT * FROM canonical_migration WHERE version=?").get(VERSION);
      if (!row || row.checksum !== checksum) throw new Error("Canonical migration checksum/version mismatch");
    } else {
      db.exec(SQL);
      db.prepare("INSERT INTO canonical_migration(version,checksum) VALUES (?,?)").run(VERSION, checksum);
    }
    const result = after?.(db, baseline);
    db.exec("COMMIT");
    return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
// Non-destructive rollback: disable consumers (already inactive) and keep evidence.
// Transaction failures rollback schema automatically; no DROP/down migration.
function status(db) {
  return { behaviorEnabled: false, migration: db.prepare("SELECT * FROM canonical_migration").all(), counts: Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n])) };
}
function decide(db, kind, decision) {
  if (!["recording", "release", "membership"].includes(kind)) throw new Error("Invalid link kind");
  const source = db.prepare('SELECT kind FROM canonical_source_object WHERE id=?').get(decision.sourceId);
  const sourceKinds = { recording: ['track', 'legacy'], release: ['release'], membership: ['appearance'] };
  if (!source || !sourceKinds[kind].includes(source.kind)) throw new Error('Invalid link source kind');
  if (!decision.reason?.trim() || !decision.reviewer?.trim() || !decision.ruleset?.trim() || !decision.evidence || !Object.keys(decision.evidence).length) throw new Error('A link decision requires attributed evidence and a reason');
  const id = randomUUID();
  db.prepare(`INSERT INTO canonical_${kind}_link(id,source_id,target_id,state,evidence_json,ruleset,reviewer,source_revision,reason,supersedes_id) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, decision.sourceId, decision.targetId, decision.state, JSON.stringify(decision.evidence), decision.ruleset, decision.reviewer, decision.sourceRevision, decision.reason, decision.supersedesId || null);
  return id;
}
function createEntity(db, kind, fields = {}) {
  const table = {recording:'canonical_recording',release:'canonical_release',family:'canonical_release_family',artist:'canonical_artist',membership:'canonical_release_track',creditSet:'canonical_credit_set'}[kind];
  if(!table) throw new Error('Invalid entity kind');
  const allowed = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
  if(Object.keys(fields).some(k=>!allowed.has(k)||k==='id')) throw new Error('Invalid entity fields');
  if(kind==='membership'&&fields.recording_id&&!db.prepare("SELECT 1 FROM canonical_recording WHERE id=? AND state='VERIFIED'").get(fields.recording_id)) throw new Error('Release membership requires a verified recording or an unresolved NULL');
  const id=randomUUID(),keys=['id',...Object.keys(fields)];
  db.prepare(`INSERT INTO ${table}(${keys.map(k=>'"'+k+'"').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(id,...Object.values(fields));
  return id;
}
function snapshotSource(db,{provider,kind,externalId,raw,retrievedAt=new Date().toISOString(),legacyTable=null,legacyRowKey=null}) {
  if(externalId==null||!String(externalId).trim()||!raw||typeof raw!=='object')throw new Error('Source identity and original metadata are required');
  db.exec('SAVEPOINT canonical_snapshot');
  try {
    provider=String(provider||'').trim().toLowerCase();
    const existing=db.prepare('SELECT * FROM canonical_source_object WHERE provider=? AND kind=? AND external_id=?').get(provider,kind,String(externalId));
    const sourceId=existing?.id||randomUUID(),revision=(existing?.revision||0)+1,snapshotId=randomUUID();
    if(existing)db.prepare('UPDATE canonical_source_object SET revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(revision,sourceId);
    else db.prepare('INSERT INTO canonical_source_object(id,kind,provider,external_id) VALUES (?,?,?,?)').run(sourceId,kind,provider,String(externalId));
    const json=JSON.stringify(raw);
    db.prepare('INSERT INTO canonical_source_snapshot(id,source_id,source_revision,retrieved_at,raw_json,legacy_table,legacy_row_key,content_hash) VALUES (?,?,?,?,?,?,?,?)').run(snapshotId,sourceId,revision,retrievedAt,json,legacyTable,legacyRowKey,createHash('sha256').update(json).digest('hex'));
    db.exec('RELEASE canonical_snapshot');
    return {sourceId,snapshotId,revision};
  }catch(error){db.exec('ROLLBACK TO canonical_snapshot; RELEASE canonical_snapshot');throw error;}
}
module.exports = { migrate, status, decide, createEntity, snapshotSource, tables, SQL, checksum, VERSION };
