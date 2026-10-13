'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertStoppedStatus}=require('./library.cjs');
test('offline preparation accepts a stopped failed session without clearing its evidence',()=>{
 const s={state:'error',clients:0,viewerActive:false,error:'The configured Roon HQPlayer zone did not resume fresh music analysis.'};
 assert.doesNotThrow(()=>assertStoppedStatus(s));
 assert.match(s.error,/did not resume/);
 assert.doesNotThrow(()=>assertStoppedStatus({state:'idle',clients:0}));
});
test('active, unknown and unclean sessions still block preparation',()=>{
 for(const s of [null,{}, {state:'error'}, {state:'error',clients:1}, {state:'error',clients:0,viewerActive:true},
  {state:'starting',clients:0},{state:'running',clients:0},{state:'paused',clients:0},
  {state:'error',clients:0,error:'SoundSpectrum could not close cleanly: native shutdown failed'}])
  assert.throws(()=>assertStoppedStatus(s));
});
