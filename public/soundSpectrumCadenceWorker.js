"use strict";
// Standalone diagnostic only; never imported by the streaming receiver.
let raf;
onmessage = ({ data }) => {
  if (data.type === "stop") { cancelAnimationFrame(raf); close(); return; }
  try {
    const { canvas, kind } = data;
    const gl = kind === "webgl" ? canvas.getContext("webgl2", { alpha:false, antialias:false }) : null;
    const ctx = kind !== "webgl" ? canvas.getContext("2d", { alpha:false, desynchronized:kind === "low-latency" }) : null;
    if ((!gl && !ctx) || typeof requestAnimationFrame !== "function") throw Error("Canvas or worker repaint clock unavailable");
    let start, first, last, count=0; const gaps=[];
    function tick(now) {
      start ??= now;
      const x=Math.round((now-start)*.25)%3700;
      if (gl) {
        gl.disable(gl.SCISSOR_TEST); gl.clearColor(.063,.051,.078,1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(x,900,140,360); gl.clearColor(.84,.71,.95,1); gl.clear(gl.COLOR_BUFFER_BIT);
      } else { ctx.fillStyle="#100d14";ctx.fillRect(0,0,3840,2160);ctx.fillStyle="#d6b5f2";ctx.fillRect(x,900,140,360); }
      if (now-start>=2000) { first ??= now;if(last!==undefined)gaps.push(now-last);last=now;count++; }
      if(now-start>=8000) {
        gaps.sort((a,b)=>a-b);
        postMessage({done:true,hz:(count-1)*1000/(last-first),gap95:gaps[Math.floor(gaps.length*.95)],samples:count,attributes:ctx?.getContextAttributes?.() || gl?.getContextAttributes?.()});
        return;
      }
      raf=requestAnimationFrame(tick);
    }
    raf=requestAnimationFrame(tick);
  } catch(error) { postMessage({error:error.message}); }
};
