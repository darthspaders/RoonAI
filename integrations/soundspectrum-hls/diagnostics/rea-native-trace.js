// Loaded by REA only after the harness verifies the exact binary and owned PID.
// EXPECTED_PID is prepended by the harness. This first pass observes only.
'use strict';
if (Process.id !== EXPECTED_PID) throw Error('Owned PID mismatch');
const host = Process.getModuleByName('WhiteCap Standalone.x64.exe');
const library = Process.getModuleByName('WhiteCap.x64.dll');
const origin = Date.now(), totals = {}, samples = new Set();
function location(p) {
  const m = Process.findModuleByAddress(p);
  return m ? m.name + '+' + p.sub(m.base) : p.toString();
}
function own(p) { return p.compare(host.base) >= 0 && p.compare(host.base.add(host.size)) < 0; }
function bump(key) { totals[key] = (totals[key] || 0) + 1; }
function once(key, value) { if (!samples.has(key) && samples.size < 40) { samples.add(key); send({event:key, ...value}); } }
function state(p) { return {delay:p.add(0x50).readS32(),slack:p.add(0x54).readS32(),
  interval:p.add(0x58).readS32(),threaded:p.add(0x6a).readU8()}; }
Interceptor.attach(Process.getModuleByName('user32.dll').getExportByName('SetTimer'), {
  onEnter(args) {
    if (!own(this.returnAddress)) return;
    bump('SetTimer:' + args[2].toUInt32());
    once('timer-request', {return:location(this.returnAddress), ms:args[2].toUInt32(),
      callback:location(args[3]), object:state(args[1])});
  }
});
Interceptor.attach(Process.getModuleByName('kernel32.dll').getExportByName('Sleep'), {
  onEnter(args) { this.active=own(this.returnAddress); if(this.active){this.ms=args[0].toUInt32();this.at=Date.now();bump('Sleep-request:'+this.ms);} },
  onLeave() { if(this.active)bump('Sleep-observed:'+Math.round(Date.now()-this.at)); }
});
Interceptor.attach(host.base.add(0x9860), {
  onEnter(args) { bump('timer-callback'); once('timer-stack',{stack:Thread.backtrace(this.context,Backtracer.ACCURATE).map(location)}); }
});
Interceptor.attach(host.base.add(0x9f70), {
  onEnter(args) { this.object=args[0];bump('host-render'); },
  onLeave() { const s=state(this.object);bump('host-delay:'+s.delay);once('host-render-state',s); }
});
const timer=setInterval(()=>send({event:'counts',elapsedMs:Date.now()-origin,totals:{...totals}}),1000);
setTimeout(()=>{clearInterval(timer);Interceptor.detachAll();send({event:'trace-ended',elapsedMs:Date.now()-origin,totals});},22000);
send({event:'trace-ready',pid:Process.id,host:host.name,library:library.name,mode:'observation'});
