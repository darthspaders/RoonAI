const test=require("node:test"),assert=require("node:assert/strict");
const {TidalVerifier}=require("../src/tidalVerifier");

test('complete track metadata still hydrates artwork from the exact album relationship',async()=>{
 const verifier=new TidalVerifier({});let calls=0;
 verifier.fetchTidalJson=async url=>{calls++;assert.match(url,/tracks\/410479727/);assert.match(url,/albums.coverArt/);return {data:{id:'410479727',type:'tracks',attributes:{title:'State of Progression'},relationships:{albums:{data:[{id:'410479726',type:'albums'}]}}},included:[{id:'410479726',type:'albums',attributes:{title:'State of Progression'},relationships:{coverArt:{data:[{id:'cover-id',type:'artworks'}]}}},{id:'cover-id',type:'artworks',attributes:{files:[{href:'https://resources.tidal.com/images/exact.jpg',meta:{width:1280,height:1280}}]}}]};};
 const track={title:'State of Progression',artist:'Ruben Karapetyan',album:'State of Progression',year:2025,releaseDate:'2025-01-31',durationMs:429000,releaseEvidence:{albumYear:2025},tidalUrl:'https://tidal.com/browse/track/410479727',imageUrl:''};
 assert.equal((await verifier.withDetailYear(track)).imageUrl,'https://resources.tidal.com/images/exact.jpg');assert.equal(calls,1);
 await verifier.withDetailYear({...track,imageUrl:'https://example.test/existing.jpg'});assert.equal(calls,1);
});
