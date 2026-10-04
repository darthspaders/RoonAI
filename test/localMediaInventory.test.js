"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { scanLocalMedia, readLocalMedia } = require("../src/localMediaInventory");
const { browseCatalog } = require("../src/databaseBrowserCatalog");

function fixture(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "rh-inventory-"));
  const db = new DatabaseSync(":memory:");
  t.after(() => { db.close(); fs.rmSync(rootPath, { recursive: true, force: true }); });
  let probes = 0;
  const probe = async file => {
    probes++;
    if (path.basename(file).startsWith("bad")) throw new Error("Unreadable audio");
    return { format: { tags: { artist: "deadmau5", album: "> album title goes here <", albumartist: "deadmau5", title: path.basename(file), genre: "Electronic" }, duration: 180 }, streams: [{ codec_type: "audio", sample_rate: 44100, bits_per_raw_sample: 16 }] };
  };
  return { db, rootPath, probe, probes: () => probes };
}

test("inventory preserves physical copies, resumes, retains missing files, and isolates local browsing", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.rootPath, "copy"));
  fs.writeFileSync(path.join(f.rootPath, "one.flac"), "same audio bytes");
  fs.writeFileSync(path.join(f.rootPath, "copy", "two.flac"), "same audio bytes");
  fs.writeFileSync(path.join(f.rootPath, "cover.jpg"), "not audio");
  assert.equal((await scanLocalMedia(f)).filesSeen, 2);
  let local = readLocalMedia(f.db, null);
  assert.equal(local.records.length, 2);
  assert.equal(new Set(local.records.map(r => r.fileHash)).size, 1);
  assert.notEqual(local.records[0].id, local.records[1].id);
  assert.equal(local.records[0].albumKey, local.records[1].albumKey);
  assert.equal((await scanLocalMedia(f)).filesReused, 2);
  assert.equal(f.probes(), 2);
  const snapshot = { records: [], localMedia: local, generatedAt: new Date().toISOString() };
  assert.equal(browseCatalog(snapshot, { view: "tracks" }).total, 0);
  const page = browseCatalog(snapshot, { media: "local", view: "tracks", q: "deadmau5", limit: 1, offset: 1 });
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.offset, 1);
  assert.equal(page.items[0].mediaType, "local");
  assert.equal(page.facets.genre[0].value, "Electronic");
  assert.equal(browseCatalog(snapshot, { media: "local", view: "albums" }).items[0].count, 2);
  assert.equal(browseCatalog(snapshot, { media: "local", view: "recordings" }).total, 2);
  fs.unlinkSync(path.join(f.rootPath, "one.flac"));
  await scanLocalMedia(f);
  local = readLocalMedia(f.db, null);
  assert.equal(local.records.length, 2);
  assert.equal(local.records.filter(r => r.availability === "missing").length, 1);
  assert.equal(browseCatalog({ ...snapshot, localMedia: local }, { media: "local", view: "tracks", availability: "available" }).total, 1);
  await assert.rejects(scanLocalMedia({ ...f, rootPath: path.join(f.rootPath, "offline") }));
  assert.equal(readLocalMedia(f.db, null).records.filter(r => r.availability === "available").length, 1);
});

test("unreadable and untagged files remain visible; changed files are reread", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.rootPath, "bad.mp3"), "bad");
  fs.writeFileSync(path.join(f.rootPath, "untagged.aif"), "audio");
  const probe = async file => path.basename(file).startsWith("bad") ? f.probe(file) : ({ streams: [{ codec_type: "audio" }] });
  const report = await scanLocalMedia({ ...f, probe });
  assert.equal(report.status, "partial"); assert.equal(report.filesFailed, 1);
  const records = readLocalMedia(f.db, null).records;
  assert.equal(records.length, 2);
  assert.equal(records.find(r => r.scanError).title, "bad.mp3");
  assert.equal(records.find(r => !r.scanError).title, "untagged.aif");
  fs.appendFileSync(path.join(f.rootPath, "untagged.aif"), "changed");
  const next = await scanLocalMedia({ ...f, probe });
  assert.equal(next.filesRead, 1); assert.equal(next.filesReused, 0);
});

test("file mutation during scanning cannot inherit a stale content hash", async t => {
  const f = fixture(t);
  const file = path.join(f.rootPath, "changing.flac");
  fs.writeFileSync(file, "before");
  const report = await scanLocalMedia({ ...f, hash: async () => { fs.appendFileSync(file, "after"); return "stale"; } });
  assert.equal(report.filesFailed, 1);
  assert.equal(readLocalMedia(f.db, null).records[0].fileHash, null);
});

test("Sonic coverage requires a valid vector for the exact local bytes, not a matching title", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.rootPath, "one.flac"), "audio bytes");
  await scanLocalMedia(f);
  const hash = readLocalMedia(f.db, null).records[0].fileHash;
  f.db.exec("CREATE TABLE track_sonic_profile(source_sha256 TEXT, embedding_base64 TEXT, model TEXT, model_version TEXT, dimensions INTEGER)");
  const vector = new Float32Array(1280).fill(0.1);
  const encoded = Buffer.from(vector.buffer).toString("base64");
  const insert = f.db.prepare("INSERT INTO track_sonic_profile VALUES(?,?,'discogs-effnet','1',1280)");
  insert.run("provider-preview-hash", encoded);
  assert.equal(readLocalMedia(f.db, f.db).records[0].sonicEmbedded, false);
  insert.run(hash, "invalid-vector");
  assert.equal(readLocalMedia(f.db, f.db).records[0].sonicEmbedded, false);
  insert.run(hash, encoded);
  assert.equal(readLocalMedia(f.db, f.db).records[0].sonicEmbedded, true);
  fs.appendFileSync(path.join(f.rootPath, "one.flac"), "changed");
  await scanLocalMedia(f);
  assert.equal(readLocalMedia(f.db, f.db).records[0].sonicEmbedded, false);
});

test("untraversed linked folders cause a partial scan without marking older files missing", async t => {
  const f = fixture(t);
  const file = path.join(f.rootPath, "old.flac"); fs.writeFileSync(file, "audio");
  await scanLocalMedia(f); fs.unlinkSync(file);
  fs.symlinkSync(f.rootPath, path.join(f.rootPath, "cycle"), process.platform === "win32" ? "junction" : "dir");
  const report = await scanLocalMedia(f);
  assert.equal(report.status, "partial");
  assert.equal(readLocalMedia(f.db, null).records[0].availability, "available");
});

test("metadata proposals stay separate from embedded tags and disappear when file bytes change", async t => {
  const f = fixture(t);
  const file = path.join(f.rootPath, 'one.flac'); fs.writeFileSync(file, 'audio');
  await scanLocalMedia(f);
  require('../src/localMediaMetadata').initializeMetadata(f.db);
  const stored = f.db.prepare('SELECT * FROM local_media_file').get();
  f.db.prepare('INSERT INTO local_media_metadata VALUES(?,?,?,?,?)').run(stored.id, stored.file_hash, JSON.stringify({ candidateCount: 1, changes: [{ tag: 'BPM', value: 128, decision: 'safe_fill' }] }), '{}', new Date().toISOString());
  const read = readLocalMedia(f.db, null).records[0];
  assert.equal(read.metadataProposals[0].value, 128); assert.equal(read.bpm, null);
  fs.appendFileSync(file, 'changed'); await scanLocalMedia(f);
  assert.equal(readLocalMedia(f.db, null).records[0].metadataProposals.length, 0);
});
