// End-to-end-test i mockläge: SWAMP_MOCK=1 SWAMP_E2E=<utkatalog> electron .
const fs = require('fs');
module.exports = (win, app, out) => run(win, app, out).catch(e => { fs.appendFileSync(out + '/progress.txt', 'KRASCH ' + e.stack + '\n'); app.exit(1); });
async function run(win, app, out) {
  const wc = win.webContents;
  const errors = [], log = [];
  wc.on('console-message', (e, level, msg) => { if (level >= 2 || /error/i.test(msg)) errors.push(msg); });
  wc.on('render-process-gone', (e, d) => errors.push('renderer gone ' + d.reason));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  const js = code => Promise.race([wc.executeJavaScript('{' + code + '\n}', true), sleep(20000).then(() => { throw new Error('TIMEOUT: ' + code.slice(0, 80)); })]);
  const shot = async n => fs.writeFileSync(`${out}/${n}.png`, (await wc.capturePage()).toPNG());
  const check = async (name, code) => { try { const r = await js(code); log.push(`${r ? 'OK  ' : 'FAIL'} ${name}${r && r !== true ? ' → ' + r : ''}`); } catch (e) { log.push('ERR  ' + name + ': ' + e.message); } fs.appendFileSync(out + '/progress.txt', ((Date.now() - t0) / 1000).toFixed(0) + 's ' + log[log.length - 1] + '\n'); };
  let downloads = [];
  wc.session.on('will-download', (e, item) => { const p = `${out}/${item.getFilename()}`; item.setSavePath(p); item.once('done', () => downloads.push(p)); });
  wc.on('did-finish-load', () => js(`window.onerror=(m,s,l)=>console.error('onerror',m,l); window.addEventListener('unhandledrejection',e=>console.error('unhandled',e.reason&&e.reason.stack||e.reason))`));
  await sleep(5000);
  await check('KPI renderade', `document.querySelectorAll('.kpi').length===7`);
  await check('huvuddiagram har 4 serier', `echarts.getInstanceByDom(document.getElementById('mainChart')).getOption().series.length===4`);
  await check('nivåmätare listade', `document.querySelectorAll('#levelSel option').length`);
  await check('händelsetabell', `document.querySelectorAll('#eventsTable tbody tr').length`);
  await shot('01-analys');
  // presets
  for (const d of [1, 3, 14, 30, 90]) {
    await js(`document.querySelector('#presets [data-d="${d}"]').click()`); await sleep(2500);
    await check(`preset ${d} d – huvuddiagram min/max`, `(()=>{const o=echarts.getInstanceByDom(document.getElementById('mainChart')).getOption();return Math.round((o.xAxis[0].max-o.xAxis[0].min)/864e5)===${d}})()`);
  }
  await shot('02-90d');
  await js(`document.querySelector('#presets [data-d="30"]').click()`); await sleep(2500);
  // regnsteg
  for (const v of ['600000', '1800000', '86400000', '3600000']) {
    await js(`const s=document.getElementById('rainStep');s.value='${v}';s.dispatchEvent(new Event('change'))`); await sleep(1500);
    await check(`regn per ${v / 60000} min`, `document.getElementById('mainTitle').textContent`);
  }
  // regnsumma får inte bero på upplösning
  const sums = [];
  for (const v of ['600000', '86400000', '3600000']) {
    await js(`const s=document.getElementById('rainStep');s.value='${v}';s.dispatchEvent(new Event('change'))`); await sleep(1500);
    sums.push(await js(`document.querySelector('.kpi .v').textContent`));
  }
  log.push((new Set(sums).size === 1 ? 'OK  ' : 'FAIL') + ' regnsumma lika oavsett upplösning: ' + sums.join(' | '));
  // spikfilter av/på + zoom behålls
  await js(`echarts.getInstanceByDom(document.getElementById('mainChart')).dispatchAction({type:'dataZoom',start:40,end:60})`); await sleep(300);
  await js(`const c=document.getElementById('despike');c.checked=false;c.dispatchEvent(new Event('change'))`); await sleep(2000);
  await check('zoom behålls när inställning ändras', `(()=>{const d=echarts.getInstanceByDom(document.getElementById('mainChart')).getOption().dataZoom[0];return d.start>30&&d.end<70})()`);
  await js(`const c=document.getElementById('despike');c.checked=true;c.dispatchEvent(new Event('change'))`); await sleep(2000);
  // inställningar
  for (const [id, v] of [['dryHours', '24'], ['gapHours', '3'], ['minMm', '0.2'], ['respHours', '48'], ['histDays', '10'], ['histDays', '60']]) {
    await js(`const e=document.getElementById('${id}');e.value='${v}';e.dispatchEvent(new Event('change'))`); await sleep(1800);
    await check(`inställning ${id}=${v}`, `document.querySelectorAll('.kpi').length===7`);
  }
  // klick på händelse (utanför period) → byter period och zoomar
  await js(`document.querySelector('#presets [data-d="3"]').click()`); await sleep(2500);
  await js(`(()=>{const c=echarts.getInstanceByDom(document.getElementById('scatterChart'));const s=c.getOption().series[0].data;const old=s.reduce((a,b)=>a.ev.start<b.ev.start?a:b);c.trigger&&0;window.__old=old.ev.start;})()`);
  await js(`(async()=>{const c=echarts.getInstanceByDom(document.getElementById('scatterChart'));const s=c.getOption().series[0].data;const old=s.reduce((a,b)=>a.ev.start<b.ev.start?a:b);c._$handlers.click[0].h({data:old});})()`); await sleep(3500);
  await check('klick på gammal händelse byter period', `(()=>{const o=echarts.getInstanceByDom(document.getElementById('mainChart')).getOption();return o.xAxis[0].min<window.__old})()`);
  await shot('03-event-zoom');
  // sortera händelsetabell
  await js(`document.querySelector('#presets [data-d="30"]').click()`); await sleep(2500);
  await js(`document.querySelector('#eventsTable th[data-k="total"]').click()`); await sleep(200);
  await check('sortering händelser', `(()=>{const v=[...document.querySelectorAll('#eventsTable tbody tr td:nth-child(3)')].map(t=>parseFloat(t.textContent.replace(',','.')));return v.every((x,i)=>!i||v[i-1]>=x)})()`);
  await js(`document.querySelector('#eventsTable tbody tr').click()`); await sleep(800);
  await check('radklick zoomar', `(()=>{const d=echarts.getInstanceByDom(document.getElementById('mainChart')).getOption().dataZoom[0];return d.end-d.start<60})()`);
  // CSV
  await js(`document.getElementById('exportEvents').click()`); await sleep(1500);
  // byt nivåmätare
  await js(`const s=document.getElementById('levelSel');s.value=s.options[1].value;s.dispatchEvent(new Event('change'))`); await sleep(2500);
  await check('byt nivåmätare', `document.getElementById('mainTitle').textContent.includes('Mätpunkt 2')`);
  // egna datum
  await js(`const f=document.getElementById('from'),t=document.getElementById('to');const n=Date.now();const iso=x=>{const d=new Date(x),p=v=>String(v).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())};f.value=iso(n-10*864e5);t.value=iso(n-5*864e5);t.dispatchEvent(new Event('change'))`); await sleep(2500);
  await check('eget datumintervall', `(()=>{const o=echarts.getInstanceByDom(document.getElementById('mainChart')).getOption();return Math.round((o.xAxis[0].max-o.xAxis[0].min)/864e5)===5 && !document.querySelector('#presets .active')})()`);
  await js(`const f=document.getElementById('from'),t=document.getElementById('to');const x=f.value;f.value=t.value;t.value=x;t.dispatchEvent(new Event('change'))`); await sleep(800);
  await check('fel ordning ger varning', `!document.getElementById('toast').hidden`);
  // regnmätarvy
  await js(`document.querySelector('#presets [data-d="7"]').click()`); await sleep(2000);
  await js(`document.querySelector('[data-view=regn]').click()`); await sleep(3500);
  await check('regnmätartabell 11 rader', `document.querySelectorAll('#gaugeTable tbody tr').length===11`);
  await check('kartmarkörer', `document.querySelectorAll('path.leaflet-interactive').length + ' st, etiketter ' + document.querySelectorAll('.gauge-label').length`);
  await check('kartan har storlek', `document.getElementById('map').clientHeight>300`);
  await check('dygnstabell', `document.querySelectorAll('#dailyTable tbody tr').length`);
  for (let i = 1; i <= 6; i++) { await js(`document.querySelectorAll('#gaugeTable tbody tr')[${i}].click()`); await sleep(700); }
  await check('max 6 valda + varning', `document.querySelectorAll('#gaugeTable tr.sel').length===6 && !document.getElementById('toast').hidden`);
  await check('regndiagram serier = 12', `echarts.getInstanceByDom(document.getElementById('rainChart')).getOption().series.length===12`);
  await shot('04-regn');
  // riktig musdragning i regndiagrammet (smalt fönster, ~40 min)
  const drag = async (id, x0, x1, yFrac) => {
    const r = await js(`(()=>{const b=document.getElementById('${id}').getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()`);
    const y = Math.round(r.y + r.h * yFrac), a = Math.round(r.x + r.w * x0), bx = Math.round(r.x + r.w * x1);
    wc.sendInputEvent({ type: 'mouseDown', x: a, y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 8; k++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a + (bx - a) * k / 8), y, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(30); }
    wc.sendInputEvent({ type: 'mouseUp', x: bx, y, button: 'left', clickCount: 1 }); await sleep(800);
  };
  await js(`document.querySelector('#rainChart').scrollIntoView({block:'center'})`); await sleep(500);
  await drag('rainChart', 0.52, 0.525, 0.3);
  await check('regndiagram zoomat efter dragning', `(()=>{const o=echarts.getInstanceByDom(document.getElementById('rainChart')).getOption();return o.dataZoom.some(d=>d.end-d.start<5)})()`);
  await shot('04b-regn-smal-zoom');
  await js(`echarts.getInstanceByDom(document.getElementById('rainChart')).dispatchAction({type:'dataZoom',start:0,end:100})`); await sleep(300);
  await drag('rainChart', 0.35, 0.6, 0.3); await shot('04c-regn-zoom');
  await js(`const s=document.getElementById('rainStep2');s.value='86400000';s.dispatchEvent(new Event('change'))`); await sleep(1000);
  await check('regn per dygn', `document.getElementById('rainChartTitle').textContent==='Regn per dygn'`);
  await js(`document.querySelector('#gaugeTable th[data-k="name"]').click()`); await sleep(300);
  await check('sortera namn', `document.querySelector('#gaugeTable tbody tr td').textContent.trim()`);
  // periodsumma i tabell = summa dygnstabell
  await check('periodsumma = dygnssumma (Nödinge)', `(()=>{const rows=[...document.querySelectorAll('#gaugeTable tbody tr')];const r=rows.find(x=>x.textContent.includes('Nödinge'));const p=r.children[5].textContent;const hs=[...document.querySelectorAll('#dailyTable thead th')].map(x=>x.textContent);const i=hs.indexOf('Nödinge');const f=document.querySelectorAll('#dailyTable tfoot td')[i].textContent;return p===f?p:('period '+p+' vs dygn '+f)})()`);
  for (const id of ['exportGauges', 'exportDaily']) { await js(`document.getElementById('${id}').click()`); await sleep(1500); }
  // avmarkera alla
  for (let k = 0; k < 8; k++) { await js(`const s=document.querySelector('#gaugeTable tr.sel');s&&s.click()`); await sleep(400); }
  await check('tomt regndiagram-meddelande', `echarts.getInstanceByDom(document.getElementById('rainChart')).getOption().title[0].text.length>0`);
  // tillbaka till analys – diagram ska ha rätt storlek
  await js(`document.querySelector('[data-view=analys]').click()`); await sleep(2500);
  await js(`document.querySelector('#mainChart').scrollIntoView({block:'center'})`); await sleep(500);
  await drag('mainChart', 0.5, 0.503, 0.5);
  await shot('05a-huvud-smal-zoom');
  await check('diagram har bredd efter vybyte', `echarts.getInstanceByDom(document.getElementById('mainChart')).getWidth()>800`);
  // fönsterstorlek
  win.setSize(1000, 700); await sleep(1000); await shot('05-litet-fonster');
  await check('ingen horisontell scroll', `document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1`);
  win.setSize(1600, 1000); await sleep(800);
  // utloggning
  await js(`document.getElementById('userBtn').click()`); await sleep(300);
  await shot('06-meny');
  log.push('Nedladdningar: ' + downloads.map(p => p.split('/').pop() + ' (' + fs.statSync(p).size + ' B)').join(', '));
  if (downloads[0]) log.push('CSV-exempel: ' + fs.readFileSync(downloads[0], 'utf8').split('\n').slice(0, 3).join(' ⏎ '));
  log.push('Konsolfel: ' + (errors.length ? '\n  ' + [...new Set(errors)].join('\n  ') : 'inga'));
  fs.writeFileSync(`${out}/result.txt`, log.join('\n'));
  app.exit(0);
}
