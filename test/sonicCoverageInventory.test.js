"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createSonicCoverageInventory } = require("../src/sonicCoverageInventory");
const { coverageTrack } = require("../src/sonicCoverageIdentity");

test("inventory prioritizes ratings, reviewed anchors, histories, preferred lanes and remaining known catalog", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rabbit-coverage-inventory-"));
  const db=new DatabaseSync(":memory:");
  t.after(()=>{db.close();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);});
  const track=id=>({tidalId:String(id),artist:"Artist",title:`Track ${id}`});
  for(const [name,value] of Object.entries({
    "taste-profile.json":{feedback:{a:track(1)}},
    "discovery-history.json":{entries:[track(3)]},
    "standby-candidates.json":{standbyHistory:[{tracks:[{...track(4),tidalId:undefined,trackId:"4"}]}]},
    "listening-history.json":{plays:[track(5)]},
    "track-memory.json":{entries:[{...track(6),genre:"Progressive Trance"},track(7)]}
  }))fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
  db.exec("CREATE TABLE sonic_review_session(anchor_identity_key TEXT,anchor_json TEXT); CREATE TABLE sonic_review_session_item(candidate_identity_key TEXT,candidate_json TEXT,status TEXT);");
  db.prepare("INSERT INTO sonic_review_session VALUES(?,?)").run("tidal:2",JSON.stringify(track(2)));
  db.prepare("INSERT INTO sonic_review_session_item VALUES(?,?,'REVIEWED')").run("tidal:8",JSON.stringify(track(8)));
  db.prepare("INSERT INTO sonic_review_session_item VALUES(?,?,'PENDING')").run("tidal:9",JSON.stringify(track(9)));
  const inventory=createSonicCoverageInventory({db,dataDirectory:dir});
  const found=[];for await(const item of inventory())found.push({id:coverageTrack(item.track)?.tidalId,priority:item.priority});
  assert.deepEqual(found,[{id:"1",priority:1},{id:"2",priority:2},{id:"8",priority:2},{id:"3",priority:3},{id:"4",priority:3},{id:"5",priority:4},{id:"6",priority:5},{id:"7",priority:6}]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sonic_review_session_item WHERE status='REVIEWED'").get().n,1);
});
