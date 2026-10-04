"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const { migrate, status } = require("../src/canonicalFoundation");
const { readCatalog } = require("../src/databaseBrowserCatalog");
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function inventory(db) {
  const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'canonical_%' ORDER BY name").all();
  const tables = {};
  for (const { name } of schema) {
    const hash = createHash("sha256");
    let count = 0;
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const keys = columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => quote(c.name));
    for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${keys.length ? keys.join(',') : 'rowid'}`).iterate()) { hash.update(JSON.stringify(row)); hash.update("\n"); count++; }
    tables[name] = { count, sha256: hash.digest("hex"), columns, foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() };
  }
  const catalog = readCatalog(db, null).records;
  return { at: new Date().toISOString(), schema, tables, schemaMeta: db.prepare("SELECT * FROM schema_meta").all(), userVersion: db.prepare("PRAGMA user_version").get(), foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all(), counts: {
    tracks: catalog.length, tidal: catalog.filter(r=>r.tidalId).length, beatport: catalog.filter(r=>r.beatportId).length, isrc: catalog.filter(r=>r.isrc).length,
    album: catalog.filter(r=>r.album).length, artwork: catalog.filter(r=>r.imageUrl).length, missingArtwork: catalog.filter(r=>!r.imageUrl).length,
    albumTitleGroups: new Set(catalog.filter(r=>r.album).map(r=>r.album.toLowerCase().trim())).size,
    albumCards: new Set(catalog.filter(r=>r.albumKey).map(r=>r.albumKey)).size
  } };
}
async function main() {
  const args = process.argv.slice(2);
  const dbFile = args.includes('--db') ? args[args.indexOf('--db')+1] : require('../src/config').musicMemory.dbFile;
  const out = path.resolve(args.includes('--out') ? args[args.indexOf('--out')+1] : `.codex-verify/canonical-phase1-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const save = (name, data) => fs.writeFileSync(path.join(out,name), JSON.stringify(data,null,2));
  const db = new DatabaseSync(dbFile, { readOnly: !args.includes('--apply') });
  db.exec('PRAGMA busy_timeout=10000');
  const backupFile = path.join(out,'before.sqlite');
  await backup(db,backupFile);
  const snapshot = new DatabaseSync(backupFile,{readOnly:true});
  const baseline = inventory(snapshot); snapshot.close();
  const fileHash = createHash('sha256');
  for await (const chunk of fs.createReadStream(backupFile)) fileHash.update(chunk);
  save('baseline.json',{...baseline, backupFile, backupSha256:fileHash.digest('hex')});
  if (args.includes('--apply')) {
    // Hold a writer reservation across both hashes and DDL, excluding concurrent app writes.
    const { before, after, changed } = migrate(db, { before:inventory, after(db,before) {
      const after=inventory(db);
      const changed=Object.keys(before.tables).filter(t=>before.tables[t].sha256!==after.tables[t].sha256);
      if(changed.length) throw new Error(`Legacy contents changed: ${changed.join(',')}`);
      return {before,after,changed};
    }});
    migrate(db);
    save('migration.json',{ before, after, changedLegacyTables:changed, status:status(db), note:'Hashes checked under the same writer reservation as DDL; any change aborts migration.' });
    console.log(JSON.stringify({out,counts:after.counts,changedLegacyTables:changed,status:status(db)}));
  } else console.log(JSON.stringify({out,counts:baseline.counts}));
  db.close();
}
if (require.main === module) main().catch(e=>{ console.error(e); process.exitCode=1; });
module.exports = { inventory };
