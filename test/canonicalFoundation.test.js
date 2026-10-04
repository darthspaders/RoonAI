"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {migrate,status,decide,createEntity,snapshotSource}=require('../src/canonicalFoundation');
const {recordingEvidence,releaseEvidence}=require('../src/canonicalMatching');
function fixture(t){const db=new DatabaseSync(':memory:');migrate(db);t.after(()=>db.close());return db;}
test('additive migration is idempotent, preserves legacy bytes and rolls back on validation failure',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE track_identity(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO track_identity VALUES(1,'untouched')");
  assert.throws(()=>migrate(db,{after(){throw Error('validation failed');}}),/validation failed/);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'canonical_%'").get().n,0);
  migrate(db);const first=status(db);migrate(db);assert.deepEqual(status(db),first);assert.equal(first.behaviorEnabled,false);
  assert.deepEqual({...db.prepare('SELECT * FROM track_identity').get()},{id:1,title:'untouched'});
});
test('namespaced IDs, immutable snapshots and stale verification',t=>{
  const db=fixture(t),a=snapshotSource(db,{provider:'tidal',kind:'track',externalId:'123',raw:{title:'a'}}),b=snapshotSource(db,{provider:'beatport',kind:'track',externalId:'123',raw:{title:'b'}});
  assert.notEqual(a.sourceId,b.sourceId);
  const target=createEntity(db,'recording',{preferred_title:'a'});
  const link={sourceId:a.sourceId,targetId:target,state:'VERIFIED',sourceRevision:1,evidence:{snapshot:a.snapshotId},ruleset:'manual-v1',reviewer:'reviewer',reason:'reviewed'};
  decide(db,'recording',link);
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified').get().n,1);
  snapshotSource(db,{provider:'tidal',kind:'track',externalId:'123',raw:{title:'changed'}});
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified').get().n,0);
  assert.throws(()=>decide(db,'recording',link),/stale source/);
  assert.throws(()=>db.exec("UPDATE canonical_source_snapshot SET raw_json='{}'"),/immutable evidence/);
  assert.throws(()=>db.exec("UPDATE canonical_source_object SET provider='other'"),/immutable provider identity/);
  assert.throws(()=>db.exec("UPDATE canonical_recording SET id='changed'"),/immutable local ID/);
});
test('reused ISRCs are nonunique evidence and remain disputed',t=>{
  const db=fixture(t),source=snapshotSource(db,{provider:'tidal',kind:'track',externalId:'1',raw:{}});
  for(let i=0;i<2;i++){const id=createEntity(db,'recording',{preferred_title:'same'});db.prepare('INSERT INTO canonical_identifier_assertion(id,recording_id,source_id,snapshot_id,scheme,original_value,normalized_value,validity) VALUES(?,?,?,?,?,?,?,?)').run(String(i),id,source.sourceId,source.snapshotId,'ISRC','US-ABC-12-34567','USABC1234567','DISPUTED');}
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_identifier_assertion').get().n,2);
});
test('one recording has many editions, compilations and repeated release positions',t=>{
  const db=fixture(t),recording=createEntity(db,'recording',{state:'VERIFIED'});
  for(const [release_type,edition]of [['album','standard'],['album','reissue'],['compilation','volume 2']]){
    const release=createEntity(db,'release',{release_type,edition});
    for(const position of ['1','9'])createEntity(db,'membership',{release_id:release,recording_id:recording,position,provenance_json:'{}'});
  }
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_release_track').get().n,6);
});
test('link decisions revoke reversibly without erasing history or allowing two verified targets',t=>{
  const db=fixture(t),source=snapshotSource(db,{provider:'tidal',kind:'track',externalId:'1',raw:{}}),target=createEntity(db,'recording');
  const input={sourceId:source.sourceId,targetId:target,state:'VERIFIED',sourceRevision:1,evidence:{snapshot:source.snapshotId},ruleset:'manual-v1',reviewer:'reviewer',reason:'reviewed'};
  const id=decide(db,'recording',input);
  assert.throws(()=>decide(db,'recording',input),/already has/);
  const revoked=decide(db,'recording',{...input,state:'REVOKED',supersedesId:id,reason:'incorrect source'});
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link_verified').get().n,0);
  decide(db,'recording',{...input,supersedesId:revoked});
  assert.equal(db.prepare('SELECT count(*) n FROM canonical_recording_link').get().n,3);
  assert.throws(()=>db.exec('DELETE FROM canonical_recording_link'),/revocation/);
  assert.throws(()=>decide(db,'recording',{...input,supersedesId:id}),/UNIQUE|predecessor/);
});
test('provider payload rejects a snapshot from a different source object',t=>{
  const db=fixture(t),a=snapshotSource(db,{provider:'tidal',kind:'track',externalId:'1',raw:{}}),b=snapshotSource(db,{provider:'beatport',kind:'track',externalId:'1',raw:{}});
  assert.throws(()=>db.prepare('INSERT INTO canonical_provider_track(source_id,snapshot_id) VALUES(?,?)').run(a.sourceId,b.snapshotId),/mismatch/);
});
const base={artist:'Artist',title:'Song',mixVersion:'Original Mix',durationMs:300000,isrc:'USABC1234567'};
for(const [name,patch,conflict]of [['different artist',{artist:'Other'},'artist-credits'],['named remixer',{mixVersion:'Ada Remix'},'version-semantics'],['extended',{mixVersion:'Extended Mix'},'version-semantics'],['radio edit',{mixVersion:'Radio Edit'},'version-semantics'],['live',{mixVersion:'Live'},'version-semantics'],['instrumental',{mixVersion:'Instrumental'},'version-semantics'],['duration',{durationMs:306000},'duration'],['contradictory ISRC',{isrc:'USABC1234568'},'contradictory-isrc'],['featured artist',{title:'Song (feat. Guest)'},'artist-credits']])test(`matching rejects ${name} even with reused ISRC`,()=>{assert.ok(recordingEvidence(base,{...base,...patch}).conflicts.includes(conflict));});
test('blank version is unknown; duration review never becomes verified; artist bands remain intact',()=>{
  assert.ok(recordingEvidence(base,{...base,mixVersion:''}).unknown.includes('version'));
  assert.ok(recordingEvidence(base,{...base,durationMs:303000}).unknown.includes('duration-review'));
  assert.equal(recordingEvidence(base,base).state,'PROPOSED');
  assert.ok(recordingEvidence({...base,artist:'A & B'},{...base,artist:'A, B'}).conflicts.includes('artist-credits'));
  assert.ok(recordingEvidence({...base,mixVersion:'Ada Remix'},{...base,mixVersion:'Bob Remix'}).conflicts.includes('version-semantics'));
});
test('release title alone is insufficient; reissues/compilations remain distinct',()=>{
  const a={title:'Album',artist:'Artist',edition:'standard',releaseType:'album'};
  assert.ok(releaseEvidence(a,a).unknown.includes('complete-ordered-tracklist'));
  assert.equal(releaseEvidence(a,a).state,'PROPOSED');
  assert.ok(releaseEvidence(a,{...a,edition:'reissue'}).conflicts.includes('edition'));
  assert.ok(releaseEvidence(a,{...a,releaseType:'compilation'}).conflicts.includes('releaseType'));
  assert.equal(releaseEvidence({provider:'tidal',providerReleaseId:'1'},{provider:'beatport',providerReleaseId:'1'}).sameProviderObject,false);
});
