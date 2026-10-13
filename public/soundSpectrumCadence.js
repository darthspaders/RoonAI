"use strict";
(() => {
  const $=id=>document.getElementById(id), phases=[['main','Main canvas'],['normal','Worker · normal canvas'],['low-latency','Worker · low-latency canvas'],['webgl','Worker · WebGL']];
  let running=false,cancelPhase=null,report;
  function summarize(times) {
    const gaps=times.slice(1).map((v,i)=>v-times[i]).sort((a,b)=>a-b);
    return {hz:times.length>1?(times.length-1)*1000/(times.at(-1)-times[0]):null,gap95:gaps[Math.floor(gaps.length*.95)]??null,samples:times.length};
  }
  function measure(kind) {
    return new Promise(resolve=>{
      const canvas=document.createElement('canvas');canvas.width=3840;canvas.height=2160;$('stage').replaceChildren(canvas);$('stage').hidden=false;
      let worker,raf,start,done=false;const times=[];
      const timeout=setTimeout(()=>finish({error:'Repaint clock timed out'}),12000);
      function finish(result) {if(done)return;done=true;clearTimeout(timeout);cancelAnimationFrame(raf);worker?.terminate();canvas.remove();$('stage').hidden=true;cancelPhase=null;resolve({...result,main:summarize(times)});}
      cancelPhase=reason=>finish({error:reason});
      try {
        const ctx=kind==='main'?canvas.getContext('2d',{alpha:false}):null;
        if(kind==='main'&&!ctx)throw Error('Canvas unavailable');
        if(kind!=='main') {
          const offscreen=canvas.transferControlToOffscreen();worker=new Worker('/soundSpectrumCadenceWorker.js?v=1');
          worker.onmessage=({data})=>finish(data.error?{error:data.error}:{worker:data});
          worker.onerror=()=>finish({error:'Worker failed'});worker.postMessage({canvas:offscreen,kind},[offscreen]);
        }
        function tick(now) {
          start??=now;
          if(now-start>=2000)times.push(now);
          if(ctx){ctx.fillStyle='#100d14';ctx.fillRect(0,0,3840,2160);ctx.fillStyle='#d6b5f2';ctx.fillRect(Math.round((now-start)*.25)%3700,900,140,360);}
          if(kind==='main'&&now-start>=8000){finish({});return;}
          raf=requestAnimationFrame(tick);
        }
        raf=requestAnimationFrame(tick);
      }catch(error){finish({error:error.message});}
    });
  }
  function stop(reason){if(!running)return;running=false;cancelPhase?.(reason);$('status').textContent=reason;}
  function updateReport(){$('report').value=JSON.stringify(report,null,2);$('copy').disabled=false;}
  $('run').onclick=async()=>{
    if(running||document.hidden)return;running=true;$('run').disabled=true;$('stop').disabled=false;$('copy').disabled=true;$('results').replaceChildren();
    report={version:1,startedAt:new Date().toISOString(),userAgent:navigator.userAgent,screen:{width:screen.width,height:screen.height,dpr:devicePixelRatio},standalone:matchMedia('(display-mode: standalone)').matches,results:[]};
    for(const [kind,label]of phases){
      if(!running)break;$('status').textContent=`Testing ${label.toLowerCase()}… Keep this tab visible.`;
      const result=await measure(kind);report.results.push({kind,...result});
      const row=document.createElement('tr');
      for(const text of [label,result.main.hz?.toFixed(1)??'—',result.worker?.hz?.toFixed(1)??(result.error?'Unavailable':'—'),result.error??((result.worker?.gap95??result.main.gap95)?.toFixed(2)+' ms')]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
      $('results').append(row);updateReport();
    }
    if(running){$('status').textContent='Test complete. Copy results or share a screenshot of the table.';
      const normal=report.results.find(x=>x.kind==='normal')?.worker?.hz,low=report.results.find(x=>x.kind==='low-latency')?.worker?.hz;
      $('meaning').textContent=normal>100&&low<75?'Normal worker canvas is faster than low-latency canvas here. This identifies a receiver setting to test with real video.':report.results.every(x=>!x.error&&(x.worker?.hz??x.main.hz)<75)?'All tested paths stayed below 75 Hz. The limit also occurs without video decoding or network delivery; device/browser presentation policy needs further isolation.':'Share the table to compare the paths. This simple drawing test does not establish real-video or physical display throughput.';
    }
    report.completed=running;report.finishedAt=new Date().toISOString();running=false;updateReport();$('run').disabled=false;$('stop').disabled=true;
  };
  $('stop').onclick=()=>stop('Test stopped. Partial results retained.');
  $('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('report').value);$('status').textContent='Results copied.';}catch{$('report').parentElement.open=true;$('report').focus();$('report').select();$('status').textContent='Select and copy the report below.';}};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('Test canceled because this tab was hidden. Run again with the tab visible.');});
  window.addEventListener('pagehide',()=>stop('Page closed.'));
})();
