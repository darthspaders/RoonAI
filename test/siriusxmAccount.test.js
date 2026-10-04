const test=require('node:test'),assert=require('node:assert/strict');
const {SiriusXmAccount}=require('../src/siriusxmAccount');
test('device authorization protects secrets, respects polling, persists authenticated session and renews once',async()=>{
 let now=0,accepted=false,renewals=0;const calls=[];
 const c=new SiriusXmAccount({file:null,clock:()=>now,fetchImpl:async(url,options)=>{calls.push(url);let data={},status=200,cookies=[];
 if(url.endsWith('/devices'))data={grant:'device-secret'};
 if(url.endsWith('/anonymous'))data={accessToken:'anonymous-secret'};
 if(url.endsWith('/generate'))data={device_code:'private-code',user_code:'VISIBLE',verification_uri:'https://siriusxm.com/activatetv',expires_in:900,interval:5};
 if(url.endsWith('/sessions/create')){if(!accepted){status=401;data={code:'tokenServicesTeam.sessionService.authorization-pending'};}else{data={sessionType:'authenticated',accessToken:'subscriber-secret',accessTokenExpiresAt:new Date(now+120000).toISOString()};cookies=['refreshToken=refresh-secret; Secure; HttpOnly'];}}
 if(url.endsWith('/refresh')){renewals++;assert.match(options.headers.Cookie,/refreshToken=refresh-secret/);data={sessionType:'authenticated',accessToken:'renewed-secret',accessTokenExpiresAt:new Date(now+120000).toISOString()};}
 return {ok:status===200,status,headers:{getSetCookie:()=>cookies},text:async()=>JSON.stringify(data)};}});
 const begin=await c.begin();assert.equal(begin.userCode,'VISIBLE');assert.ok(!JSON.stringify(begin).includes('private-code'));
 assert.equal((await c.check()).pending,true);const count=calls.length;await c.check();assert.equal(calls.length,count);
 now+=5001;accepted=true;assert.equal((await c.check()).connected,true);assert.ok(!JSON.stringify(c.status()).includes('secret'));
 now+=70000;await Promise.all([c.token(),c.token()]);assert.equal(renewals,1);
 await assert.rejects(c.request('playback/play/v1/tune'),/Unsupported/);
});
test('expired authorization fails without touching playback',async()=>{const c=new SiriusXmAccount({file:null,clock:()=>100});c.pending={expires:0};await assert.rejects(c.check(),/expired/);assert.equal(c.pending,null);});

test('transient and rejected requests retain activation and back off',async()=>{
 let now=1000,status=500,code={code:'temporary'};
 const c=new SiriusXmAccount({file:null,clock:()=>now,fetchImpl:async()=>({ok:false,status,headers:{},text:async()=>JSON.stringify(code)})});
 const pending={expires:900000,interval:5,nextPoll:0,session:{accessToken:'secret'},deviceCode:'secret',cookies:{}};
 c.pending=pending;const result=await c.check();assert.equal(result.pending,true);assert.match(result.message,/30 seconds/);assert.equal(c.pending,pending);assert.equal(pending.nextPoll,31000);
 now=32000;status=401;code={error:{code:'tokenServicesTeam.sessionService.authorization-pending'}};
 assert.equal((await c.check()).pending,true);assert.equal(c.pending,pending);
 now=40000;code={code:'unauthorized'};assert.match((await c.check()).message,/retained/);assert.equal(c.pending,pending);
});

test('bare 401 renews once and exchanges the same device code with rotated cookies',async()=>{
 const calls=[];const c=new SiriusXmAccount({file:null,clock:()=>1000,fetchImpl:async(url,o)=>{
  calls.push({url,o});const n=calls.length;
  if(n===1)return {ok:false,status:401,headers:{getSetCookie:()=>['sxm-refresh-token=rotated; Secure']},text:async()=>''};
  assert.match(o.headers.Cookie,/sxm-refresh-token=rotated/);
  if(n===2){assert.ok(url.endsWith('/refresh'));return response({sessionType:'anonymous',accessToken:'renewed'});}
  assert.equal(o.headers.Authorization,'Bearer renewed');assert.deepEqual(JSON.parse(o.body),{deviceCode:'exact-private-code'});
  return response({sessionType:'authenticated',accessToken:'accepted'});
 }});
 c.pending={expires:900000,interval:5,nextPoll:0,session:{accessToken:'old'},deviceCode:'exact-private-code',cookies:{}};
 assert.equal((await c.check()).connected,true);assert.equal(calls.length,3);
});

function response(data){return {ok:true,status:200,headers:{getSetCookie:()=>[]},text:async()=>JSON.stringify(data)};}

test('invalid refresh token stops repeated checks and explains the blocked connection',async()=>{
 let calls=0;const c=new SiriusXmAccount({file:null,clock:()=>1000,fetchImpl:async()=>{calls++;return {ok:false,status:400,headers:{},text:async()=>JSON.stringify({code:'tokenServicesTeam.sessionService.invalid-refresh-token'})};}});
 c.pending={expires:900000,interval:5,nextPoll:0,session:{accessToken:'expired',accessTokenExpiresAt:new Date(0).toISOString()},deviceCode:'private',cookies:{}};
 assert.equal((await c.check()).blocked,true);assert.match(c.status().message,/Further checks are stopped/);
 await c.check();assert.equal(calls,1);assert.ok(!JSON.stringify(c.status()).includes('private'));
});

test('expired anonymous token is renewed before exchange and authenticated renewal needs no exchange',async()=>{
 let calls=0;const c=new SiriusXmAccount({file:null,clock:()=>100000,fetchImpl:async(url)=>{calls++;assert.ok(url.endsWith('/refresh'));return response({sessionType:'authenticated',accessToken:'accepted'});}});
 c.pending={expires:900000,interval:5,nextPoll:0,session:{accessToken:'expired',accessTokenExpiresAt:new Date(0).toISOString()},deviceCode:'private',cookies:{}};
 assert.equal((await c.check()).connected,true);assert.equal(calls,1);
});

test('failed recovery is bounded and pending cookies and backoff survive restart',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sxm-test-')),file=path.join(dir,'session.json');
 let calls=0;try{
 const c=new SiriusXmAccount({file,clock:()=>1000,fetchImpl:async()=>{calls++;return {ok:false,status:401,headers:{getSetCookie:()=>['sxm-refresh-token=rotated; Secure']},text:async()=>''};}});
 c.pending={expires:900000,interval:5,nextPoll:0,session:{accessToken:'old'},deviceCode:'private',cookies:{}};
 assert.equal((await c.check()).pending,true);assert.equal(calls,2);
 const restored=new SiriusXmAccount({file,clock:()=>2000});assert.equal(restored.pending.cookies['sxm-refresh-token'],'rotated');assert.equal(restored.pending.nextPoll,31000);assert.equal(restored.pending.checking,false);
 assert.ok(!JSON.stringify(restored.status()).includes('rotated'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
