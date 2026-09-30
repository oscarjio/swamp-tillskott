// Mockat API för test utan inloggning (SWAMP_MOCK=1)
const { make, fmt } = require('./synth.js');
const gauges = [['YDOC_125717815','Nödinge',57.8858,12.0627],['YDOC_125717900','Bohus HR',57.8480,12.0273],['YDOC_125718263','Beijer PST',57.9565,12.1138],['YDOC_125718267','Torsbro PST',57.9799,12.1903],['YDOC_125718707','Skepplanda HR',57.9762,12.2137],['YDOC_125720946','Brandsbo HR',57.9201,12.0799],['YDOC_125723495','Valås HR',57.9387,12.1070],['YDOC_128906673','Alvhem PST',58.0048,12.1537],['YDOC_128911692','Surte Västra 2',57.8305,12.0125],['YDOC_128912530','Södra Nol',57.9091,12.0546],['YDOC_128912558','Rished',57.9210,12.0953]];
const syn = make(60, Date.now());
const P = s => { const m=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s); return new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime(); };
const level = { t: syn.level.map(r => P(r.date)), v: syn.level.map(r => +r.value) };
// simulera mätare på bänk (~700 mm) före installation + glapp
{ const cut = Date.now() - 12 * 86400000, gapEnd = cut + 3 * 86400000; const t = [], v = []; level.t.forEach((x, i) => { if (x < cut) { t.push(x); v.push(700 + (i % 7) * 0.3); } else if (x >= gapEnd) { t.push(x); v.push(level.v[i]); } }); level.t = t; level.v = v; }
const rain0 = { t: syn.rain.map(r => P(r.date)), v: syn.rain.map(() => 0.2) };
function rainFor(i){ if(!i) return rain0; const keep = 0.5 + ((i*37)%50)/100; const t=[],v=[]; rain0.t.forEach((x,k)=>{ if(((k*7919+i*104729)%1000)/1000 < keep) { t.push(x + i*600000); v.push(0.2);} }); return {t,v}; }
module.exports = {
  async get(p) {
    if (p === 'Companies/all') return [{ companyId: 7, name: 'Ale kommun' }];
    if (p.startsWith('Tag/company/')) return [{ deveui: 'D0000OBB', name: 'D0000OBB', attributes: [] }, { deveui: 'D0000OBN', name: 'D0000OBN', attributes: [] }, ...gauges.map(g => ({ deveui: g[0], name: g[1], latitude: g[2], longitude: g[3], attributes: [{ normalizedName: 'BATTERY', value: '3.60' }] }))];
    if (p.startsWith('companies/7/dashboards')) return [{ dashboardId: 652, name: 'Mätpunkt 1', type: 3 }, { dashboardId: 653, name: 'Mätpunkt 2', type: 3 }];
    if (p === 'Dashboards/652') return { templateDashboardItems: [{ tagId: 'D0000OBB' }, { tagId: 'YDOC_125717815' }] };
    if (p === 'Dashboards/653') return { templateDashboardItems: [{ tagId: 'D0000OBN' }, { tagId: 'YDOC_125717815' }] };
    if (p.startsWith('TagData/simple/latest/all/')) { const d = decodeURIComponent(p.split('/').pop()); return d.startsWith('D0') ? [{ key: 'Level_Monitoring-Level_200', label: 'Nivå (mm)', createdAt: fmt(Date.now()) }] : [{ key: 'RE', label: 'Regn (mm)', createdAt: fmt(Date.now()) }]; }
    throw new Error('mock saknar ' + p);
  },
  async series(dev, key, from, to) {
    const s = dev.startsWith('D0') ? (dev === 'D0000OBN' ? { t: level.t, v: level.v.map(x => x * 0.5) } : level) : rainFor(gauges.findIndex(g => g[0] === dev));
    const t = [], v = []; s.t.forEach((x, i) => { if (x >= from && x <= to) { t.push(x); v.push(s.v[i]); } }); return { t, v };
  },
};
