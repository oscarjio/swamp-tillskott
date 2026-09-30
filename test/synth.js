// Syntetisk data: dygnsvariation + regnrespons
const A=require('../src/analysis.js');
function make(days=40,endMs=Date.UTC(2026,8,30,15)){
  const start=endMs-days*A.DAY; const rain=[],level=[];
  let seed=1; const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const events=[]; for(let d=3;d<days;d+=4+Math.floor(rnd()*4)) events.push({t:start+d*A.DAY+rnd()*A.DAY, mm:2+rnd()*20, dur:2+rnd()*8});
  for(const e of events){ const tips=Math.round(e.mm/0.2); for(let k=0;k<tips;k++){ rain.push({date:fmt(e.t+rnd()*e.dur*A.HOUR),value:'0.2'}) } }
  rain.sort((a,b)=>a.date<b.date?-1:1);
  for(let t=start;t<endMs;t+=A.MIN){ const h=new Date(t).getHours()+new Date(t).getMinutes()/60;
    let base=145+12*Math.sin((h-8)/24*2*Math.PI)+5*Math.sin((h-19)/12*2*Math.PI);
    let resp=0; for(const e of events){ const dt=(t-e.t)/A.HOUR-2; if(dt>0) resp+=e.mm*1.3*Math.exp(-dt/10)*(1-Math.exp(-dt/1.5)); }
    let v=base+resp+(rnd()-0.5)*2; if(rnd()<0.0005) v=16;
    level.push({date:fmt(t),value:v.toFixed(3)}); }
  return {rain,level,start,end:endMs};
}
function fmt(t){const d=new Date(t),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`}
module.exports={make,fmt};
if(require.main===module){
  const {rain,level,start,end}=make();
  const L=A.despike(A.parseRows(level)); console.log('removed',L.removed);
  const R=A.parseRows(rain); const rh=A.binSum(R,start,end,A.HOUR); const l15=A.binMean(L,start,end,15*A.MIN);
  const prof=A.dryWeatherProfile(l15,rh); console.log(prof.method,prof.dryCount,prof.weekday.slice(0,8).map(x=>x.toFixed(1)).join(' '));
  const ev=A.detectEvents(rh,l15,prof); console.table(ev.map(e=>({s:new Date(e.start).toISOString().slice(0,13),mm:e.total,rise:e.rise,lag:e.lagH,perMm:e.perMm,exc:e.excess})));
  console.log(A.regression(ev.map(e=>e.total),ev.map(e=>e.rise)));
}
