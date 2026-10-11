"use strict";
function hqplayerRows(h){
  if(!h||!h.rate)return [];
  const dsd=/dsd|sdm/i.test(h.mode||""),rows=[];
  const rate=h.rate>=1e6?`${+(h.rate/1e6).toFixed(4)} MHz`:`${+(h.rate/1000).toFixed(1)} kHz`;
  const multiple=h.rate%44100===0?h.rate/44100:h.rate%48000===0?h.rate/48000:0;
  const depth=h.bits?` / ${h.bits}-bit${dsd?" SDM":""}`:"";
  rows.push(["HQPlayer output",`${dsd?(multiple?`DSD${multiple}`:"DSD"):(h.mode||"PCM")} · ${rate}${depth}`]);
  if(h.filter)rows.push(["Filter",h.filter]);
  if(h.shaper)rows.push(["Shaper",h.shaper]);
  if(h.speed>0)rows.push(["Speed",`${+h.speed.toFixed(1)}x realtime`]);
  return rows;
}
function hqplayerSummary(h){
  return hqplayerRows(h).map(([,value])=>value).join(" · ");
}
