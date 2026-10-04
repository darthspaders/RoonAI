"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { AUDIO_EXTENSIONS, probeLocalAudio, trackFromFfprobe, hashFile } = require("./localLibraryMetadataEnrichment");
const extensions = new Set([...AUDIO_EXTENSIONS, ".aif", ".mp4", ".wma"]);
const parse = value => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
const hasTable = (db, name) => Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function initializeInventory(db) {
  // Paths identify physical copies. Hashes identify bytes, and are deliberately NOT unique.
  // Keep the earlier enrichment tables and all their evidence intact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_media_file (
      id INTEGER PRIMARY KEY, file_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
      root_path TEXT NOT NULL COLLATE NOCASE, file_size INTEGER, file_modified_at TEXT,
      file_hash TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
      availability TEXT NOT NULL, scan_error TEXT, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, scan_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_media_root ON local_media_file(root_path);
    CREATE TABLE IF NOT EXISTS local_media_scan (
      id TEXT PRIMARY KEY, root_path TEXT NOT NULL COLLATE NOCASE, status TEXT NOT NULL,
      files_seen INTEGER NOT NULL DEFAULT 0, files_read INTEGER NOT NULL DEFAULT 0,
      files_reused INTEGER NOT NULL DEFAULT 0, files_failed INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, error TEXT
    );
  `);
}

function cachedMetadata(row) {
  return trackFromFfprobe(row.file_path, {
    format: { tags: parse(row.raw_tags_json), duration: row.duration_ms / 1000, format_name: row.file_format },
    streams: [{ codec_type: "audio", sample_rate: row.sample_rate, bits_per_raw_sample: row.bit_depth, channels: row.channels }]
  });
}

async function scanLocalMedia({ db, rootPath, probe = probeLocalAudio, hash = hashFile, onProgress = () => {} }) {
  rootPath = path.resolve(rootPath);
  // An unavailable root must never mark a whole collection missing.
  if (!(await fs.promises.stat(rootPath)).isDirectory()) throw new Error("Library root is not a directory.");
  initializeInventory(db);
  const id = randomUUID(), startedAt = new Date().toISOString();
  const report = { id, rootPath, status: "running", filesSeen: 0, filesRead: 0, filesReused: 0, filesFailed: 0, errors: [] };
  db.prepare("UPDATE local_media_scan SET status='interrupted', error='Previous scan did not finish' WHERE root_path=? AND status='running'").run(rootPath);
  db.prepare("INSERT INTO local_media_scan(id,root_path,status,started_at,updated_at) VALUES(?,?,'running',?,?)").run(id, rootPath, startedAt, startedAt);
  const prior = db.prepare("SELECT * FROM local_media_file WHERE file_path=? COLLATE NOCASE");
  const legacy = hasTable(db, "local_library_file") ? db.prepare("SELECT * FROM local_library_file WHERE file_path=? COLLATE NOCASE") : null;
  const save = db.prepare(`INSERT INTO local_media_file(file_path,root_path,file_size,file_modified_at,file_hash,metadata_json,availability,scan_error,first_seen_at,last_seen_at,scan_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(file_path) DO UPDATE SET
    root_path=excluded.root_path,file_size=excluded.file_size,file_modified_at=excluded.file_modified_at,
    file_hash=excluded.file_hash,metadata_json=excluded.metadata_json,availability=excluded.availability,
    scan_error=excluded.scan_error,last_seen_at=excluded.last_seen_at,scan_id=excluded.scan_id`);
  function checkpoint() {
    db.prepare("UPDATE local_media_scan SET status=?,files_seen=?,files_read=?,files_reused=?,files_failed=?,updated_at=?,completed_at=?,error=? WHERE id=?")
      .run(report.status, report.filesSeen, report.filesRead, report.filesReused, report.filesFailed, new Date().toISOString(), report.status === "running" ? null : new Date().toISOString(), report.errors.length ? JSON.stringify(report.errors.slice(0, 30)) : null, id);
    onProgress({ ...report });
  }
  async function walk(directory) {
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { report.errors.push(`${directory}: ${error.message}`); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { report.errors.push(`Linked path not traversed: ${filePath}`); continue; }
      if (entry.isDirectory()) { await walk(filePath); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      report.filesSeen++;
      const old = prior.get(filePath);
      let stat, modified = null, metadata = {}, fileHash = "", errorText = null;
      try {
        stat = await fs.promises.stat(filePath);
        modified = stat.mtime.toISOString();
        const unchanged = row => row && row.file_size === stat.size && row.file_modified_at === modified;
        const cached = legacy?.get(filePath);
        if (unchanged(old) && !old.scan_error) {
          metadata = parse(old.metadata_json); fileHash = old.file_hash; report.filesReused++;
        } else if (unchanged(cached) && cached.status === "processed" && cached.raw_tags_json) {
          metadata = cachedMetadata(cached); fileHash = cached.file_hash; report.filesReused++;
        } else {
          metadata = trackFromFfprobe(filePath, await probe(filePath));
          fileHash = await hash(filePath);
          const after = await fs.promises.stat(filePath);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("File changed while being scanned; retry on next scan.");
          report.filesRead++;
        }
      } catch (error) {
        errorText = error.message; report.filesFailed++;
        // Retain previous descriptive tags for inspection, but never reuse stale audio evidence.
        metadata = old ? parse(old.metadata_json) : {}; fileHash = "";
      }
      save.run(filePath, rootPath, stat?.size ?? null, modified, fileHash || null, JSON.stringify(metadata), errorText ? "unreadable" : "available", errorText, startedAt, new Date().toISOString(), id);
      if (report.filesSeen % 100 === 0) checkpoint();
    }
  }
  try {
    await walk(rootPath);
    await fs.promises.stat(rootPath);
    // Missing is only asserted after an uninterrupted, fully traversed root.
    if (!report.errors.length) db.prepare("UPDATE local_media_file SET availability='missing' WHERE root_path=? AND scan_id<>?").run(rootPath, id);
    report.status = report.errors.length || report.filesFailed ? "partial" : "complete";
    checkpoint();
    return report;
  } catch (error) {
    report.status = "failed"; report.errors.push(error.message); checkpoint(); throw error;
  }
}

function readLocalMedia(db, sonicDb) {
  if (!hasTable(db, "local_media_file")) return { records: [], scans: [], sonicAvailable: false };
  const { decodeVector } = require("./sonicEmbeddingStore");
  const { MODEL, MODEL_VERSION, DIMENSIONS, validCoverageEmbedding } = require("./sonicCoverageIdentity");
  const sonicAvailable = hasTable(sonicDb, "track_sonic_profile");
  const hashes = new Set();
  if (sonicAvailable) for (const row of sonicDb.prepare("SELECT source_sha256,embedding_base64 FROM track_sonic_profile WHERE model=? AND model_version=? AND dimensions=? AND source_sha256 IS NOT NULL").iterate(MODEL, MODEL_VERSION, DIMENSIONS)) {
    if (validCoverageEmbedding({ model: MODEL, modelVersion: MODEL_VERSION, dimensions: DIMENSIONS, vector: decodeVector(row.embedding_base64) })) hashes.add(row.source_sha256);
  }
  const metadataResults = hasTable(db, 'local_media_metadata') ? new Map(db.prepare("SELECT local_media_id,file_hash,json_extract(result_json,'$.candidateCount') candidate_count,json_extract(result_json,'$.changes') changes_json,updated_at FROM local_media_metadata").all().map(row => [row.local_media_id, row])) : new Map();
  const records = db.prepare("SELECT * FROM local_media_file ORDER BY id").all().map(row => {
    const m = parse(row.metadata_json);
    const enriched = metadataResults.get(row.id);
    const currentMetadata = enriched && enriched.file_hash === row.file_hash ? enriched : null;
    const record = {
      id: `local:${row.id}`, identityKey: `local:${row.id}`, mediaType: "local", filePath: row.file_path,
      rootPath: row.root_path, fileHash: row.file_hash, fileSize: row.file_size,
      availability: row.availability, scanError: row.scan_error, lastScannedAt: row.last_seen_at,
      fileFormat: path.extname(row.file_path).slice(1).toUpperCase(), sampleRate: m.sampleRate, bitDepth: m.bitDepth,
      artist: m.artist || "", title: m.title || path.basename(row.file_path), album: m.album || "", albumArtist: m.albumArtist || "",
      // Embedded release tags group an album, without claiming canonical release identity.
      albumKey: m.album ? `local-album:${createHash('sha256').update(JSON.stringify([m.album.toLowerCase(), (m.albumArtist || path.dirname(row.file_path)).toLowerCase()])).digest('hex')}` : "",
      trackNumber: m.trackNumber, discNumber: m.discNumber, genres: [m.genre, m.subgenre].filter(Boolean),
      label: m.label || "", bpm: m.bpm || null, key: m.camelot || m.keyName || "", year: m.year || null,
      releaseDate: m.releaseDate || "", durationMs: m.durationMs || null, isrc: m.isrc || "", mixVersion: "",
      tidalId: "", beatportId: "", rating: "", tags: [], sonicTags: [], sonicAnchor: false, sonicReviewed: false,
      sonicEmbedded: sonicAvailable ? hashes.has(row.file_hash) : null,
      imageUrl: "", artworkSource: "", providers: ["embedded"], sources: ["local-library"],
      rawTags: m.rawTags || {}, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
      metadataGatheredAt: currentMetadata?.updated_at || null,
      metadataCandidates: currentMetadata?.candidate_count || 0,
      metadataProposals: currentMetadata ? parse(currentMetadata.changes_json || '[]') : []
    };
    record.searchText = [record.artist, record.title, record.album, record.albumArtist, record.label, ...record.genres, record.filePath, record.isrc].join(" ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return record;
  });
  const scans = db.prepare("SELECT * FROM local_media_scan ORDER BY started_at DESC, rowid DESC").all();
  return { records, sonicAvailable, scans: scans.filter((scan, i) => scans.findIndex(s => s.root_path.toLowerCase() === scan.root_path.toLowerCase()) === i) };
}

module.exports = { initializeInventory, scanLocalMedia, readLocalMedia, extensions };
