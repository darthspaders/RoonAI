"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {selectDisplayArtwork,recoverLegacyArtwork}=require('../src/artworkPolicy');
const {artwork,safeImage}=require('../src/databaseBrowserCatalog');
const cover=(patch={})=>({id:'a',url:'https://example.com/cover.jpg',verified:true,health:'OK',provider:'tidal',releaseId:'standard',...patch});
test('deterministic exact appearance, primary release, alternate release and verified track fallbacks',()=>{
  const options={releaseId:'standard',appearanceId:'position1',trackSourceId:'track1',primaryProvider:'tidal'};
  const all=[cover({id:'appearance',appearanceId:'position1'}),cover({id:'primary'}),cover({id:'alternate',provider:'beatport'}),cover({id:'track',releaseId:null,trackSourceId:'track1'})];
  for(const path of ['exact-appearance','primary-release','alternate-release','verified-track']){
    assert.equal(selectDisplayArtwork({...options,candidates:all}).path,path);
    assert.deepEqual(selectDisplayArtwork({...options,candidates:all}),selectDisplayArtwork({...options,candidates:[...all].reverse()}));all.shift();
  }
  assert.equal(selectDisplayArtwork({...options,candidates:all}).path,'placeholder');
});
test('dead, disputed, reissue and compilation artwork cannot stand in for an unresolved release',()=>{
  for(const candidate of [cover({health:'DEAD'}),cover({verified:false}),cover({releaseId:'reissue'}),cover({releaseId:'compilation'})])assert.equal(selectDisplayArtwork({releaseId:'standard',candidates:[candidate]}).path,'placeholder');
  assert.equal(selectDisplayArtwork({candidates:[cover()]}).path,'placeholder');
});
test('original snapshot URL takes precedence over failed bridge cache without crossing provider objects',()=>{
  const raw={imageUrl:'https://art.darthspader.com/art/a.jpg',sourceImageUrl:'https://resources.tidal.com/images/a/640x640.jpg'};
  assert.equal(artwork(raw,'tidal'),'https://resources.tidal.com/images/a/320x320.jpg');
  assert.equal(artwork({imageUrl:'https://example.com/current.jpg',sourceImageUrl:'https://example.com/old.jpg'},'tidal'),'https://example.com/current.jpg');
  assert.equal(artwork({album:{cover:'01234567-89ab-cdef-0123-456789abcdef'}},'tidal'),'https://resources.tidal.com/images/01234567/89ab/cdef/0123/456789abcdef/320x320.jpg');
});
test('legacy history recovery requires exact current provider/track/release and rejects archive edition conflict',()=>{
  const record={album:'Album',title:'Song'};
  const entry={id:1,provider:'musicbrainz',provider_track_id:'t',release_id:'r',release_title:'Album',confidence:99,fetched_at:'2026-01-01',raw:{imageUrl:'https://example.com/a.jpg'}};
  const latest={...entry,id:2,fetched_at:'2026-02-01',raw:{}};
  const recover=history=>recoverLegacyArtwork(record,history,artwork,safeImage);
  assert.equal(recover([entry,latest]).snapshotId,1);
  for(const patch of [{release_id:'other'},{provider_track_id:'other'},{release_title:'Album Deluxe'},{confidence:80}])assert.equal(recover([entry,{...latest,...patch}]),null);
  assert.equal(recover([{...entry,raw:{sourceImageUrl:'https://coverartarchive.org/release/wrong/cover.jpg'}}]),null);
});
test('Discogs primary release artwork uses exact stored release ID and track position',()=>{
  const entry={id:1,provider:'discogs',provider_track_id:'123:A1',release_id:'123',release_title:'Album',confidence:99,fetched_at:'2026-01-01',raw:{id:123,tracklist:[{position:'A1',title:'Song'}],images:[{type:'primary',uri:'https://i.discogs.com/cover.jpg'}]}};
  const recover=e=>recoverLegacyArtwork({album:'Album',title:'Song'},[e],artwork,safeImage);
  assert.equal(recover(entry).reason,'stored-provider-release-primary');
  assert.equal(recover({...entry,raw:{...entry.raw,id:456}}),null);
  assert.equal(recover({...entry,raw:{...entry.raw,images:[{type:'secondary',uri:'https://i.discogs.com/back.jpg'}]}}),null);
  assert.equal(recover({...entry,provider_track_id:'123:B1'}),null);
});
