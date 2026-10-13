// Exact-build, owned-process diagnostic. Restores the vendor clock on its UI thread.
'use strict';
if(Process.id!==EXPECTED_PID)throw Error('Owned PID mismatch');
const host=Process.getModuleByName('WhiteCap Standalone.x64.exe');
const helper=Module.load(CLOCK_DLL_PATH), user=Process.getModuleByName('user32.dll');
function fn(name,result,args){return new NativeFunction(helper.getExportByName(name),result,args);}
const start=fn('RhClockStart','int',['pointer','pointer','pointer']);
const stop=fn('RhClockStop','int',[]),ack=fn('RhClockAcknowledge','void',[]);
const requestStop=fn('RhClockRequestStop','void',[]);
const posted=fn('RhClockPosted','int',[]),skipped=fn('RhClockSkipped','int',[]),error=fn('RhClockError','int',[]);
const kill=new NativeFunction(user.getExportByName('KillTimer'),'int',['pointer','pointer']);
const restore=new NativeFunction(user.getExportByName('SetTimer'),'pointer',['pointer','pointer','uint','pointer']);
const callback=host.base.add(0x9860),origin=Date.now();
let phase='before',active=false,attempted=false,hwnd,id,callbacks=0,renders=0;
function snapshot(event){send({event,elapsedMs:Date.now()-origin,phase,callbacks,renders,posted:posted(),skipped:skipped(),error:error()});}
function finish(){
  requestStop();
  const timer=restore(hwnd,id,Math.max(0,id.add(0x50).readS32())+2,callback);
  active=false;phase='after';send({event:'clock-restored',timer:timer.toString(),elapsedMs:Date.now()-origin});
}
Interceptor.attach(callback,{onEnter(args){
  callbacks++;
  if(active){ack();if(Date.now()-origin>=TRIAL_END_MS)finish();}
  if(!attempted&&Date.now()-origin>=5000){
    attempted=true;hwnd=args[0];id=args[2];
    const killed=kill(hwnd,id);
    const started=killed?start(hwnd,id,callback):0;
    if(started){active=true;phase='trial';}
    else {restore(hwnd,id,Math.max(0,id.add(0x50).readS32())+2,callback);phase='failed';}
    send({event:'clock-started',killed,started,elapsedMs:Date.now()-origin});
  }
}});
Interceptor.attach(host.base.add(0x9f70),{onEnter(){renders++;},onLeave(){if(active&&Date.now()-origin>=TRIAL_END_MS)finish();}});
const interval=setInterval(()=>snapshot('counts'),1000);
setTimeout(()=>{
  clearInterval(interval);
  // A still-active clock is an explicit failure; the harness stops this owned process.
  if(active){stop();send({event:'restoration-failed',reason:'No UI callback restored the timer'});}
  send({event:'clock-worker-stopped',stopped:stop()});
  snapshot('trace-ended');Interceptor.detachAll();
},TRIAL_END_MS+5000);
send({event:'trace-ready',pid:Process.id,mode:'bounded-high-resolution-clock'});
