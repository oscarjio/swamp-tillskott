/* global echarts, L, Analysis */
'use strict';
const A = Analysis;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const api = window.swamp;

/* ---------------- färger (validerad mörk palett) ---------------- */
const C = {
  rain: '#3987e5', level: '#d95926', base: '#b5b4aa', delta: '#199e70', weekend: '#9085e9',
  text: '#f2f1ec', text2: '#c3c2b7', muted: '#8d8c85', grid: '#26262b', axis: '#3a3a40', surface: '#1a1a1c',
};
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#008300', '#e66767'];

/* ---------------- tillstånd ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('st.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('st.' + k, JSON.stringify(v)); } catch { /* ignoreras */ } },
};
const S = {
  view: store.get('view', 'analys'),
  preset: store.get('preset', 7),
  from: null, to: null,
  company: null,
  levels: [], gauges: [], pairs: {},
  levelId: store.get('levelId', null),
  rainId: store.get('rainId', null),
  selGauges: store.get('selGauges', null),
  gaugeColor: {},
  events: [],
  sort: { events: { k: 'start', asc: false }, gauges: { k: 'period', asc: false } },
};
const charts = {};

/* ---------------- hjälp ---------------- */
const pad = n => String(n).padStart(2, '0');
const fmtDT = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtShort = t => { const d = new Date(t); return `${d.getDate()}/${d.getMonth() + 1} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const WD = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];
const toInput = t => { const d = new Date(t); return `${fmtDate(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const nf = (x, d = 1) => x == null || !isFinite(x) ? '–' : x.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = t => { if (!t) return '–'; const m = (Date.now() - t) / 60000; if (m < 60) return Math.round(m) + ' min sedan'; if (m < 1440) return Math.round(m / 60) + ' h sedan'; return Math.round(m / 1440) + ' d sedan'; };

const LOADING = { text: 'Hämtar data…', color: '#3987e5', textColor: '#c3c2b7', maskColor: 'rgba(20,20,22,0.72)', fontSize: 13, spinnerRadius: 12, lineWidth: 3 };
function chartsLoading(ids, on) { ids.forEach(id => { const c = chart(id); on ? c.showLoading('default', LOADING) : c.hideLoading(); }); }
let loadingN = 0;
function loading(on, text) {
  loadingN = Math.max(0, loadingN + (on ? 1 : -1));
  $('#loading').hidden = loadingN === 0;
  if (text) $('#loadingText').textContent = text;
  $('#refresh').classList.toggle('spin', loadingN > 0);
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 6000); }

async function get(path, opts) {
  const r = await api.get(path, opts);
  if (!r.ok) { if (r.code === 401) showLogin(); throw new Error(r.error); }
  return r.data;
}
async function series(dev, key, from, to) {
  const r = await api.series(dev, key, from, to);
  if (!r.ok) { if (r.code === 401) showLogin(); throw new Error(r.error); }
  return r.data;
}

/* ---------------- inloggning ---------------- */
function showLogin() { $('#login').hidden = false; $('#app').hidden = true; $('#rangeBar').style.visibility = 'hidden'; $('#tabs').style.visibility = 'hidden'; }
function hideLogin() { $('#login').hidden = true; $('#app').hidden = false; $('#rangeBar').style.visibility = ''; $('#tabs').style.visibility = ''; }
const cleanErr = e => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginErr').textContent = ''; $('#loginBtn').disabled = true; $('#loginBtn').textContent = 'Loggar in…';
  try { await api.login($('#email').value.trim(), $('#password').value, $('#remember').checked); $('#password').value = ''; await boot(); }
  catch (err) { $('#loginErr').textContent = cleanErr(err); }
  finally { $('#loginBtn').disabled = false; $('#loginBtn').textContent = 'Logga in'; }
});
$('#portalLoginBtn').addEventListener('click', async () => {
  $('#loginErr').textContent = '';
  try { await api.portalLogin(); await boot(); } catch (err) { $('#loginErr').textContent = cleanErr(err); }
});
$('#userBtn').addEventListener('click', e => { e.stopPropagation(); $('#userMenu').hidden = !$('#userMenu').hidden; });
document.addEventListener('click', () => ($('#userMenu').hidden = true));
$('#logout').addEventListener('click', async () => { await api.logout(); showLogin(); });
$('#openPortal').addEventListener('click', () => {
  const pair = S.pairs[S.levelId];
  api.openPortal(pair && pair.dashboardId ? `https://portal.swamp.se/#/dashboard/${pair.dashboardId}` : undefined);
});
api.onAuthExpired(() => { toast('Sessionen har gått ut – logga in igen.'); showLogin(); });
api.onRefresh(() => refresh(true));

/* ---------------- tidsintervall ---------------- */
function applyPreset(days) {
  S.preset = days; store.set('preset', days);
  S.to = Date.now(); S.from = S.to - days * A.DAY;
  $('#from').value = toInput(S.from); $('#to').value = toInput(S.to);
  $$('#presets button').forEach(b => b.classList.toggle('active', +b.dataset.d === days));
}
$$('#presets button').forEach(b => b.addEventListener('click', () => { applyPreset(+b.dataset.d); render(); }));
['#from', '#to'].forEach(id => $(id).addEventListener('change', () => {
  const f = new Date($('#from').value).getTime(), t = new Date($('#to').value).getTime();
  if (!(f < t)) return toast('Från måste vara före till');
  S.from = f; S.to = t; S.preset = null; store.set('preset', null);
  $$('#presets button').forEach(b => b.classList.remove('active'));
  render();
}));
$('#refresh').addEventListener('click', () => refresh(true));
async function refresh(clear) {
  if (clear) await api.clearCache();
  if (S.preset) applyPreset(S.preset);
  render();
}

/* ---------------- flikar ---------------- */
function setView(v) {
  S.view = v; store.set('view', v);
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#view-analys').hidden = v !== 'analys'; $('#view-regn').hidden = v !== 'regn'; $('main').scrollTop = 0;
  render();
}
$$('#tabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

/* ---------------- start: hitta mätare ---------------- */
async function boot() {
  hideLogin();
  loading(true, 'Hämtar mätare…');
  try {
    const st = await api.authStatus();
    $('#userName').textContent = st.user ? `${st.user.name || ''} · ${st.user.email || ''}` : '';
    const companies = await get('Companies/all', { ttl: 3600000 });
    S.company = companies[0];
    const [tags, dashboards] = await Promise.all([
      get(`Tag/company/${S.company.companyId}`, { ttl: 600000 }),
      get(`companies/${S.company.companyId}/dashboards`, { ttl: 600000 }).catch(() => []),
    ]);
    const latest = await Promise.all(tags.map(t => get(`TagData/simple/latest/all/${encodeURIComponent(t.deveui)}`, { ttl: 120000 }).catch(() => [])));
    S.levels = []; S.gauges = [];
    tags.forEach((t, i) => {
      const keys = latest[i] || [];
      const re = keys.find(k => k.key === 'RE');
      const lv = keys.find(k => /Level_Monitoring-Level/i.test(k.key)) || keys.find(k => /niv[åa]/i.test(k.label || '') && !/distance/i.test(k.key));
      const battery = (t.attributes || []).find(a => a.normalizedName === 'BATTERY');
      if (re) S.gauges.push({ id: t.deveui, name: t.name || t.deveui, lat: t.latitude, lon: t.longitude, key: 'RE', last: A.parseLocal(re.createdAt), battery: battery ? +battery.value : null });
      if (lv) S.levels.push({ id: t.deveui, name: t.name || t.deveui, key: lv.key, label: lv.label, last: A.parseLocal(lv.createdAt) });
    });
    S.gauges.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    // dashboards av typen "mätpunkt" ger namn + regnmätare-par
    const typed = dashboards.filter(d => d.type === 3);
    const details = await Promise.all(typed.map(d => get(`Dashboards/${d.dashboardId}`, { ttl: 600000 }).catch(() => null)));
    details.forEach((d, di) => {
      if (!d || !d.templateDashboardItems) return;
      const tagsIn = d.templateDashboardItems.map(i => i.tagId);
      const lv = S.levels.find(l => tagsIn.includes(l.id));
      const g = S.gauges.find(x => tagsIn.includes(x.id));
      if (lv && !S.pairs[lv.id]) { const nm = d.name || typed[di].name || lv.id; S.pairs[lv.id] = { dashboardId: typed[di].dashboardId, name: nm, rainId: g && g.id }; lv.display = `${nm} (${lv.id})`; }
    });
    S.levels.forEach(l => (l.display = l.display || l.name));
    S.levels.sort((a, b) => a.display.localeCompare(b.display, 'sv'));

    $('#levelSel').innerHTML = S.levels.map(l => `<option value="${esc(l.id)}">${esc(l.display)}</option>`).join('');
    $('#rainSel').innerHTML = S.gauges.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
    if (!S.levels.find(l => l.id === S.levelId)) S.levelId = S.levels[0] && S.levels[0].id;
    if (!S.gauges.find(g => g.id === S.rainId)) S.rainId = (S.pairs[S.levelId] && S.pairs[S.levelId].rainId) || (S.gauges[0] && S.gauges[0].id);
    $('#levelSel').value = S.levelId || ''; $('#rainSel').value = S.rainId || '';
    if (!Array.isArray(S.selGauges) || !S.selGauges.length) S.selGauges = [S.rainId].filter(Boolean);
    S.selGauges = S.selGauges.filter(id => S.gauges.find(g => g.id === id));
    S.selGauges.forEach(assignColor);
  } catch (err) { toast('Kunde inte hämta mätare: ' + err.message); }
  finally { loading(false); }
  if (S.preset) applyPreset(S.preset); else applyPreset(7);
  setView(S.view);
}

$('#levelSel').addEventListener('change', e => {
  S.levelId = e.target.value; store.set('levelId', S.levelId);
  const p = S.pairs[S.levelId];
  if (p && p.rainId) { S.rainId = p.rainId; $('#rainSel').value = S.rainId; store.set('rainId', S.rainId); }
  render();
});
$('#rainSel').addEventListener('change', e => { S.rainId = e.target.value; store.set('rainId', S.rainId); render(); });
['#rainStep', '#despike', '#dryHours', '#gapHours', '#minMm', '#respHours', '#histDays'].forEach(id => {
  const el = $(id), k = 'opt' + id;
  const saved = store.get(k, null);
  if (saved != null) { if (el.type === 'checkbox') el.checked = saved; else el.value = saved; }
  el.addEventListener('change', () => { store.set(k, el.type === 'checkbox' ? el.checked : el.value); render(); });
});
$('#rainStep2').value = store.get('opt#rainStep2', '3600000');
$('#rainStep2').addEventListener('change', e => { store.set('opt#rainStep2', e.target.value); renderRain(); });

let renderSeq = 0;
/** Klipp en serie till [a,b] så att delvisa intervall inte får med regn utanför perioden */
function clip(s, a, b) { const i = A.lowerBound(s.t, a), j = A.lowerBound(s.t, b + 1); return { t: s.t.slice(i, j), v: s.v.slice(i, j) }; }
/** Behåll zoomfönstret när samma period ritas om (t.ex. när en inställning ändras) */
function keepZoom(c, from, to) {
  const o = c.getOption && c.getOption();
  const dz = o && o.dataZoom && o.dataZoom[0];
  if (!dz || c._range !== from + '|' + to || dz.startValue == null) { c._range = from + '|' + to; return null; }
  if (dz.start <= 0.01 && dz.end >= 99.99) return null;
  return [dz.startValue, dz.endValue];
}
function render() { if (!S.from) return; if (S.view === 'analys') renderAnalys(); else renderRain(); }

/* ================================================================
   ECharts-gemensamt
   ================================================================ */
function chart(id) {
  if (charts[id]) { charts[id].resize(); return charts[id]; }
  const c = echarts.init(document.getElementById(id), null, { renderer: 'canvas' });
  charts[id] = c;
  c.getZr().on('dblclick', () => c.dispatchAction({ type: 'dataZoom', start: 0, end: 100 }));
  return c;
}
window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));
new ResizeObserver(() => Object.values(charts).forEach(c => c.resize())).observe(document.body);

function enableBrushZoom(c) {
  // gör "dra för att zooma" till standardläget
  setTimeout(() => c.dispatchAction({ type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: true }), 0);
}
const axisCommon = {
  axisLine: { lineStyle: { color: C.axis } },
  axisTick: { show: false },
  axisLabel: { color: C.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
};
const timeAxisLabel = {
  color: C.muted, fontSize: 11, hideOverlap: true,
  formatter: { year: '{yyyy}', month: '{d}/{M}', day: '{d}/{M}', hour: '{HH}:{mm}', minute: '{HH}:{mm}', second: '{HH}:{mm}:{ss}', millisecond: '{HH}:{mm}', none: '{d}/{M} {HH}:{mm}' },
};
const tooltipBase = {
  trigger: 'axis', backgroundColor: 'rgba(28,28,31,.96)', borderColor: '#3a3a40', textStyle: { color: C.text, fontSize: 12 },
  axisPointer: { type: 'line', lineStyle: { color: '#6a6a70' }, link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#3a3a40' } },
};
function toolboxZoom(xIdx) {
  return {
    right: 8, top: 0, itemSize: 14, iconStyle: { borderColor: C.muted }, emphasis: { iconStyle: { borderColor: C.text } },
    // filterMode 'none': linjer ritas även om inga mätpunkter råkar ligga inom det markerade fönstret
    feature: { dataZoom: { xAxisIndex: xIdx, yAxisIndex: false, filterMode: 'none', title: { zoom: 'Markera för att zooma', back: 'Tillbaka' } }, restore: { title: 'Återställ' } },
  };
}
function legendHtml(items) {
  return items.map(i => `<span><i class="${i.dashed ? 'dashed' : ''}" style="background:${i.color};color:${i.color}"></i>${esc(i.name)}</span>`).join('');
}

/* ================================================================
   VY 1: Regn & nivå
   ================================================================ */
async function renderAnalys() {
  const seq = ++renderSeq;
  const lvl = S.levels.find(l => l.id === S.levelId), g = S.gauges.find(x => x.id === S.rainId);
  if (!lvl || !g) { $('#kpis').innerHTML = '<div class="empty">Inga nivå- eller regnmätare hittades.</div>'; return; }
  const from = S.from, to = S.to;
  const histDays = +$('#histDays').value || 60;
  const hFrom = Math.min(from, to - histDays * A.DAY);
  const rainStep = +$('#rainStep').value;
  loading(true, 'Hämtar nivå och regn…');
  const AN = ['mainChart', 'scatterChart', 'profileChart'];
  chartsLoading(AN, true);
  let lvRaw, rnRaw;
  try {
    [lvRaw, rnRaw] = await Promise.all([series(lvl.id, lvl.key, hFrom, to), series(g.id, 'RE', hFrom - 3 * A.DAY, to)]);
  } catch (err) { loading(false); chartsLoading(AN, false); return toast('Kunde inte hämta data: ' + err.message); }
  loading(false);
  if (seq !== renderSeq) return;
  chartsLoading(AN, false);

  // ---- beräkningar ----
  const lv = $('#despike').checked ? A.despike(lvRaw) : lvRaw;
  const seg = A.segmentStart(lv);
  const hist0 = lv.t.length ? Math.max(hFrom, A.floorTo(Math.max(lv.t[0], seg || 0), A.HOUR)) : hFrom;
  S.segInfo = seg && seg > lv.t[0] + A.DAY ? seg : null;
  const rainH = A.binSum(rnRaw, hist0 - 3 * A.DAY, to, A.HOUR);
  const l15 = A.binMean(lv, hist0, to, 15 * A.MIN);
  const prof = A.dryWeatherProfile(l15, rainH, { dryHours: +$('#dryHours').value || 48 });
  const events = A.detectEvents(rainH, l15, prof, { gapHours: +$('#gapHours').value || 6, minMm: +$('#minMm').value || 1, responseHours: +$('#respHours').value || 24 });
  const vEvents = events.filter(e => e.end > from && e.start < to);
  S.events = vEvents;

  // vy-serier
  const inView = (t) => t >= from && t <= to;
  const rnView = clip(rnRaw, from, to);
  const rainV = A.binSum(rnView, from, to, rainStep);
  const rainPts = rainV.t.map((t, i) => [Math.min(t + rainStep / 2, to), rainV.v[i]]);
  const lvIdx0 = A.lowerBound(lv.t, from), lvIdx1 = A.lowerBound(lv.t, to + 1);
  const useRaw = to - from <= 21 * A.DAY;
  const lvPts = [];
  if (useRaw) { for (let i = lvIdx0; i < lvIdx1; i++) { lvPts.push([lv.t[i], +lv.v[i].toFixed(1)]); if (i + 1 < lvIdx1 && lv.t[i + 1] - lv.t[i] > 30 * A.MIN) lvPts.push([lv.t[i] + 60000, null]); } }
  else l15.t.forEach((t, i) => { if (inView(t)) lvPts.push([t + 7.5 * A.MIN, l15.v[i] == null ? null : +l15.v[i].toFixed(1)]); });
  const basePts = [], deltaPts = [];
  let exc = 0, baseSum = 0, maxD = -Infinity, maxDT = null, lvSum = 0, lvN = 0, lvMax = -Infinity;
  l15.t.forEach((t, i) => {
    if (!inView(t)) return;
    const b = A.baselineAt(t, prof), v = l15.v[i], tc = t + 7.5 * A.MIN;
    basePts.push([tc, b == null ? null : +b.toFixed(1)]);
    if (v == null || b == null) { deltaPts.push([tc, null]); return; }
    const d = v - b; deltaPts.push([tc, +d.toFixed(1)]);
    if (d > 0) exc += d * 0.25; baseSum += b * 0.25; lvSum += v; lvN++; lvMax = Math.max(lvMax, v);
    if (d > maxD) { maxD = d; maxDT = t; }
  });
  const rainTot = rnView.v.reduce((a, b) => a + b, 0);
  const rainHView = A.binSum(rnView, from, to, A.HOUR);
  const maxI = Math.max(0, ...rainHView.v);
  const withLevel = events.filter(e => e.hasLevel && e.rise != null);
  const reg = A.regression(withLevel.map(e => e.total), withLevel.map(e => e.rise));

  // ---- KPI ----
  const stepName = { 3600000: 'timme', 1800000: '30 min', 600000: '10 min', 86400000: 'dygn' }[rainStep];
  $('#kpis').innerHTML = [
    kpi('Regn i perioden', nf(rainTot, 1), 'mm', g.name, C.rain),
    kpi('Max regnintensitet', nf(maxI, 1), 'mm/h', maxI ? 'högsta timsumma' : 'inget regn', C.rain),
    kpi('Nivå medel / max', `${nf(lvN ? lvSum / lvN : null, 0)} / ${nf(lvN ? lvMax : null, 0)}`, 'mm', lvl.display, C.level),
    kpi('Max regnpåverkan', nf(isFinite(maxD) ? maxD : null, 1), 'mm', maxDT ? 'över torrväder, ' + fmtShort(maxDT) : '', C.delta),
    kpi('Tillskott över torrväder', nf(baseSum ? exc / baseSum * 100 : null, 1), '%', `${nf(exc, 0)} mm·h överskott`, C.delta),
    kpi('Nivåhöjning per mm regn', nf(reg ? reg.slope : null, 2), 'mm/mm', reg ? `R² ${nf(reg.r2, 2)} · ${reg.n} händelser (hela historiken)` : 'för få händelser', C.delta),
    kpi('Regnhändelser', String(vEvents.length), 'st', `≥ ${$('#minMm').value} mm i perioden`, C.rain),
  ].join('');

  // ---- huvuddiagram: tre paneler med gemensam tidsaxel ----
  $('#mainTitle').textContent = `${g.name} – regn per ${stepName}  ·  ${lvl.display} – nivå`;
  $('#mainLegend').innerHTML = legendHtml([
    { name: `Regn (mm/${stepName === 'timme' ? 'h' : stepName})`, color: C.rain },
    { name: 'Nivå (mm)', color: C.level },
    { name: 'Förväntad torrvädersnivå', color: C.base, dashed: true },
    { name: 'Regnpåverkan (nivå − torrväder)', color: C.delta },
  ]);
  const c = chart('mainChart');
  const zoomKeep = keepZoom(c, from, to);
  const grids = [{ top: 30, height: '17%' }, { top: '27%', height: '40%' }, { top: '73%', height: '14%' }].map(g0 => ({ left: 58, right: 24, ...g0 }));
  const x = i => ({ type: 'time', gridIndex: i, min: from, max: to, ...axisCommon, splitLine: { show: false }, axisLabel: i === 2 ? timeAxisLabel : { show: false }, axisPointer: { label: { show: i === 2, formatter: p => fmtDT(p.value) } } });
  const y = (i, name, extra) => ({ type: 'value', gridIndex: i, name, nameLocation: 'end', nameGap: 8, nameTextStyle: { color: C.muted, fontSize: 11, align: 'left' }, splitNumber: 3, ...axisCommon, ...extra });
  const markAreas = vEvents.map(e => [{ xAxis: e.start, itemStyle: { color: 'rgba(57,135,229,0.07)' } }, { xAxis: e.end }]);
  c.setOption({
    animation: false, backgroundColor: 'transparent', textStyle: { fontFamily: 'Segoe UI, system-ui, sans-serif' },
    grid: grids,
    xAxis: [x(0), x(1), x(2)],
    yAxis: [y(0, `Regn mm/${stepName === 'timme' ? 'h' : stepName}`, { min: 0, minInterval: 0.2 }), y(1, 'Nivå mm', { scale: true }), y(2, 'Påverkan mm', { scale: true })],
    toolbox: toolboxZoom([0, 1, 2]),
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2], zoomOnMouseWheel: 'ctrl', moveOnMouseMove: false, moveOnMouseWheel: false, preventDefaultMouseMove: false, filterMode: 'none', minValueSpan: 30 * A.MIN },
      { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 6, height: 22, borderColor: C.axis, backgroundColor: '#161618', fillerColor: 'rgba(57,135,229,0.15)', dataBackground: { lineStyle: { color: '#555' }, areaStyle: { color: '#333' } }, handleStyle: { color: '#555', borderColor: '#777' }, textStyle: { color: C.muted }, labelFormatter: v => fmtShort(v), filterMode: 'none', minValueSpan: 30 * A.MIN }],
    tooltip: { ...tooltipBase, formatter: ps => tooltipMain(ps, stepName, { prof, rainV, rainStep, l15 }) },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    series: [
      { name: 'Regn', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: rainPts, showSymbol: false, symbolSize: 6, lineStyle: { width: 1.8, color: C.rain }, itemStyle: { color: C.rain }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(57,135,229,0.45)' }, { offset: 1, color: 'rgba(57,135,229,0.03)' }]) }, markArea: { silent: true, data: markAreas } },
      { name: 'Nivå', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: lvPts, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.6, color: C.level }, itemStyle: { color: C.level }, connectNulls: false, markArea: { silent: true, data: markAreas } },
      { name: 'Torrväder', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: basePts, showSymbol: false, lineStyle: { width: 1.4, type: [5, 4], color: C.base }, itemStyle: { color: C.base } },
      { name: 'Påverkan', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: deltaPts, showSymbol: false, lineStyle: { width: 1.5, color: C.delta }, itemStyle: { color: C.delta }, areaStyle: { color: 'rgba(25,158,112,0.22)', origin: 0 }, markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: '#55555c', type: 'solid', width: 1 }, label: { show: false } }, markArea: { silent: true, data: markAreas } },
    ],
  }, true);
  enableBrushZoom(c);
  if (zoomKeep) c.dispatchAction({ type: 'dataZoom', startValue: zoomKeep[0], endValue: zoomKeep[1] });

  // ---- spridning: regnmängd vs nivåhöjning ----
  renderScatter(withLevel, reg, from, to);
  // ---- dygnsprofil ----
  renderProfile(prof, l15, from, to);
  // ---- händelsetabell ----
  renderEvents();
}

function kpi(k, v, unit, sub, color) {
  return `<div class="kpi"><div class="k"><i style="background:${color}"></i>${esc(k)}</div><div class="v">${v}<small>${esc(unit)}</small></div><div class="s">${esc(sub)}</div></div>`;
}

function tooltipMain(ps, stepName, ctx) {
  if (!ps.length) return '';
  const t = ps[0].axisValue;
  const row = (col, name, val, unit) => `<div style="display:flex;gap:14px;justify-content:space-between"><span><span style="display:inline-block;width:9px;height:3px;border-radius:2px;background:${col};margin-right:6px;vertical-align:3px"></span>${name}</span><b>${val}</b>${unit ? `<span style="color:${C.muted};margin-left:-10px">${unit}</span>` : ''}</div>`;
  const get = n => { const p = ps.find(x => x.seriesName === n); return p && p.value ? p.value[1] : null; };
  const ri = ctx.rainV.t.indexOf(A.floorTo(t, ctx.rainStep));
  const r = ri >= 0 ? ctx.rainV.v[ri] : get('Regn');
  let l = get('Nivå');
  if (l == null) { const k = ctx.l15.t.indexOf(A.floorTo(t, 15 * A.MIN)); if (k >= 0 && ctx.l15.v[k] != null) l = ctx.l15.v[k]; }
  const b = A.baselineAt(t, ctx.prof);
  const d = l != null && b != null ? l - b : get('Påverkan');
  let h = `<div style="color:${C.text2};margin-bottom:4px">${WD[new Date(t).getDay()]} ${fmtDT(t)}</div>`;
  if (r != null) h += row(C.rain, `Regn per ${stepName}`, nf(r, 1), 'mm');
  if (l != null) h += row(C.level, 'Nivå', nf(l, 1), 'mm');
  if (b != null) h += row(C.base, 'Torrväder', nf(b, 1), 'mm');
  if (d != null) h += row(C.delta, 'Påverkan', (d > 0 ? '+' : '') + nf(d, 1), 'mm');
  return h;
}

async function zoomToEvent(e) {
  const a = e.start - 6 * A.HOUR, b = Math.min(e.windowEnd, Date.now());
  if (a < S.from || b > S.to) { // händelsen ligger utanför vald period – byt period först
    S.from = a - A.DAY; S.to = Math.min(b + A.DAY, Date.now()); S.preset = null; store.set('preset', null);
    $('#from').value = toInput(S.from); $('#to').value = toInput(S.to);
    $$('#presets button').forEach(x => x.classList.remove('active'));
    await renderAnalys();
  }
  zoomTo(a, b);
}
function zoomTo(a, b) {
  const c = charts.mainChart; if (!c) return;
  c.dispatchAction({ type: 'dataZoom', startValue: Math.max(a, S.from), endValue: Math.min(b, S.to) });
  $('#mainChart').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#resetZoom').addEventListener('click', () => charts.mainChart && charts.mainChart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 }));

function renderScatter(evs, reg, from, to) {
  const c = chart('scatterChart');
  const pts = evs.map(e => ({ value: [e.total, e.rise], ev: e, itemStyle: { color: e.end > from && e.start < to ? C.delta : '#5c7d70', opacity: e.end > from && e.start < to ? 1 : 0.55 } }));
  const maxX = Math.max(5, ...evs.map(e => e.total)) * 1.08;
  $('#scatterExplain').innerHTML = reg
    ? `Varje punkt är en regnhändelse. Linjen visar att nivån i snitt stiger <b>${nf(reg.slope, 2)} mm per mm regn</b> (R² = ${nf(reg.r2, 2)}). Starkt samband och brant lutning = mycket regnberoende tillskottsvatten. Ljusa punkter ligger i vald period.`
    : 'Behöver minst tre regnhändelser med nivådata för att räkna ett samband. Punkterna visas ändå.';
  c.setOption({
    animation: false, grid: { left: 50, right: 20, top: 26, bottom: 36 },
    xAxis: { type: 'value', name: 'Regn per händelse (mm)', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: C.muted, fontSize: 11 }, min: 0, max: +maxX.toFixed(0), ...axisCommon },
    yAxis: { type: 'value', name: 'Nivåhöjning (mm)', nameTextStyle: { color: C.muted, fontSize: 11, align: 'left' }, ...axisCommon },
    tooltip: { trigger: 'item', backgroundColor: 'rgba(28,28,31,.96)', borderColor: '#3a3a40', textStyle: { color: C.text, fontSize: 12 },
      formatter: p => p.data.ev ? `<div style="color:${C.text2}">${fmtDT(p.data.ev.start)}</div>Regn <b>${nf(p.data.ev.total, 1)} mm</b> (max ${nf(p.data.ev.maxI, 1)} mm/h)<br>Nivåhöjning <b>${nf(p.data.ev.rise, 1)} mm</b><br>Tid till topp ${nf(p.data.ev.toPeakH, 1)} h<br><span style="color:${C.muted}">Klicka för att visa</span>` : p.seriesName },
    series: [
      { type: 'scatter', data: pts, symbolSize: 10, itemStyle: { borderColor: C.surface, borderWidth: 2 } },
      reg ? { type: 'line', name: 'Trend', data: [[0, reg.intercept], [maxX, reg.intercept + reg.slope * maxX]], showSymbol: false, silent: true, lineStyle: { color: C.text2, width: 1.5, type: [6, 4] } } : null,
    ].filter(Boolean),
  }, true);
  c.off('click');
  c.on('click', p => { if (p.data && p.data.ev) zoomToEvent(p.data.ev); });
}

function renderProfile(prof, l15, from, to) {
  const c = chart('profileChart');
  const labels = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);
  // faktisk medelnivå per kvart under vald period, för jämförelse
  const acc = Array.from({ length: 96 }, () => []);
  l15.t.forEach((t, i) => { if (t >= from && t <= to && l15.v[i] != null) acc[A.slotOf(t)].push(l15.v[i]); });
  const actual = acc.map(a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
  const r1 = a => a.map(v => v == null ? null : +v.toFixed(1));
  const segNote = S.segInfo ? ` <br><span class="badge">Data före ${fmtDT(S.segInfo)} används inte</span> nivån bytte läge där (glapp eller flyttad mätare).` : '';
  const days = Math.round((l15.t.length ? (l15.t[l15.t.length - 1] - l15.t[0]) : 0) / A.DAY);
  $('#profileExplain').innerHTML = (prof.method === 'torrväder'
    ? `Median av nivån per kvart under torra perioder (inget regn senaste ${prof.dryHours} h). Det är referensen som regnpåverkan räknas mot. Avståndet till den orange linjen = genomsnittligt tillskott i perioden.`
    : `För lite torrväder i historiken – referensen är därför 20:e percentilen av nivån per kvart. Profilen blir bättre när fler torra dygn har loggats (nu ${days} dygn data).`) + segNote;
  const series = [
    { name: 'Torrväder vardag', data: r1(prof.weekday), color: C.base, dashed: false },
    { name: 'Torrväder helg', data: r1(prof.weekend), color: C.weekend, dashed: true },
    { name: 'Medel vald period', data: actual, color: C.level },
  ];
  c.setOption({
    animation: false, grid: { left: 50, right: 20, top: 44, bottom: 30 },
    legend: { top: 0, right: 0, textStyle: { color: C.text2, fontSize: 12 }, itemWidth: 16, itemHeight: 3, icon: 'rect' },
    xAxis: { type: 'category', data: labels, ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.muted, fontSize: 11, interval: 11 } },
    yAxis: { type: 'value', scale: true, name: 'mm', nameTextStyle: { color: C.muted, fontSize: 11 }, ...axisCommon },
    tooltip: { ...tooltipBase, axisPointer: { type: 'line', lineStyle: { color: '#6a6a70' } }, valueFormatter: v => v == null ? '–' : nf(v, 1) + ' mm' },
    series: series.map(s => ({ type: 'line', name: s.name, data: s.data, showSymbol: false, smooth: 0.2, lineStyle: { width: s.name.startsWith('Medel') ? 2 : 1.6, color: s.color, type: s.dashed ? [5, 4] : 'solid' }, itemStyle: { color: s.color } })),
  }, true);
}

const EV_COLS = [
  { k: 'start', h: 'Start', f: e => `${WD[new Date(e.start).getDay()]} ${fmtDT(e.start)}` },
  { k: 'durationH', h: 'Längd (h)', f: e => nf(e.durationH, 0) },
  { k: 'total', h: 'Regn (mm)', f: e => nf(e.total, 1) },
  { k: 'maxI', h: 'Max (mm/h)', f: e => nf(e.maxI, 1) },
  { k: 'rise', h: 'Nivåhöjning (mm)', f: e => nf(e.rise, 1) },
  { k: 'peakDelta', h: 'Topp över torrväder (mm)', f: e => nf(e.peakDelta, 1) },
  { k: 'perMm', h: 'mm nivå / mm regn', f: e => nf(e.perMm, 2) },
  { k: 'toPeakH', h: 'Tid till topp (h)', f: e => nf(e.toPeakH, 1) },
  { k: 'lagH', h: 'Fördröjning från regnets tyngdpunkt (h)', f: e => nf(e.lagH, 1) },
  { k: 'excess', h: 'Överskott (mm·h)', f: e => nf(e.excess, 0) },
];
function renderEvents() {
  const s = S.sort.events;
  const evs = S.events.slice().sort((a, b) => ((a[s.k] ?? -Infinity) - (b[s.k] ?? -Infinity)) * (s.asc ? 1 : -1));
  const t = $('#eventsTable');
  if (!evs.length) { t.innerHTML = '<tr><td class="empty">Inga regnhändelser i vald period.</td></tr>'; return; }
  t.innerHTML = `<thead><tr>${EV_COLS.map(c => `<th data-k="${c.k}" class="${c.k === s.k ? 'sorted' + (s.asc ? ' asc' : '') : ''}">${c.h}</th>`).join('')}</tr></thead>
    <tbody>${evs.map((e, i) => `<tr data-i="${i}">${EV_COLS.map(c => `<td>${c.f(e)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  t.querySelectorAll('th').forEach(th => th.addEventListener('click', () => { const k = th.dataset.k; S.sort.events = { k, asc: s.k === k ? !s.asc : false }; renderEvents(); }));
  t.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
    t.querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel')); tr.classList.add('sel');
    zoomToEvent(evs[+tr.dataset.i]);
  }));
  S._evSorted = evs;
}
$('#exportEvents').addEventListener('click', () => {
  const evs = S._evSorted || [];
  downloadCsv('regnhandelser.csv', [EV_COLS.map(c => c.h), ...evs.map(e => [fmtDT(e.start), e.durationH, e.total, e.maxI, e.rise, e.peakDelta, e.perMm, e.toPeakH, e.lagH, e.excess])]);
});

/* ================================================================
   VY 2: Regnmätare
   ================================================================ */
function assignColor(id) {
  if (S.gaugeColor[id] != null) return;
  const used = new Set(Object.values(S.gaugeColor));
  const i = SERIES.findIndex((_, k) => !used.has(k));
  S.gaugeColor[id] = i < 0 ? 0 : i;
}
function toggleGauge(id) {
  if (S.selGauges.includes(id)) { S.selGauges = S.selGauges.filter(x => x !== id); delete S.gaugeColor[id]; }
  else { if (S.selGauges.length >= 6) return toast('Max 6 regnmätare samtidigt i diagrammet'); S.selGauges.push(id); assignColor(id); }
  store.set('selGauges', S.selGauges);
  renderRain(true);
}

let rainCache = null;
async function renderRain(soft) {
  const seq = ++renderSeq;
  const from = S.from, to = S.to, now = Date.now();
  const fFrom = Math.min(from, now - 30 * A.DAY), fTo = Math.max(to, now);
  const key = `${fFrom}|${fTo}`;
  if (!soft || !rainCache || rainCache.key !== key) {
    loading(true, 'Hämtar regnmätare…');
    chartsLoading(['rainChart'], true);
    try {
      const data = await Promise.all(S.gauges.map(g => series(g.id, 'RE', fFrom, fTo).catch(() => ({ t: [], v: [] }))));
      rainCache = { key, data };
    } catch (err) { loading(false); chartsLoading(['rainChart'], false); return toast(err.message); }
    loading(false);
    if (seq !== renderSeq) return;
    chartsLoading(['rainChart'], false);
  }
  const data = rainCache.data;
  const sumBetween = (s, a, b) => { let x = 0; for (let i = A.lowerBound(s.t, a); i < s.t.length && s.t[i] <= b; i++) x += s.v[i]; return x; };
  const rows = S.gauges.map((g, i) => {
    const s = data[i];
    const h = A.binSum(clip(s, from, to), from, to, A.HOUR);
    return {
      g, s,
      h1: sumBetween(s, now - A.HOUR, now), h24: sumBetween(s, now - A.DAY, now), d7: sumBetween(s, now - 7 * A.DAY, now), d30: sumBetween(s, now - 30 * A.DAY, now),
      period: sumBetween(s, from, to), maxI: Math.max(0, ...h.v), last: s.t.length ? s.t[s.t.length - 1] : g.last,
    };
  });
  S._gaugeRows = rows;
  renderGaugeTable(rows);
  renderMap(rows);
  renderRainChart(rows);
  renderDaily(rows);
}

const G_COLS = [
  { k: 'name', h: 'Regnmätare', f: r => `<span class="dot" style="background:${S.selGauges.includes(r.g.id) ? SERIES[S.gaugeColor[r.g.id]] : 'transparent'};border:1px solid ${S.selGauges.includes(r.g.id) ? 'transparent' : '#555'}"></span>${esc(r.g.name)}`, v: r => r.g.name },
  { k: 'h1', h: 'Senaste timmen', f: r => nf(r.h1, 1) },
  { k: 'h24', h: '24 h', f: r => nf(r.h24, 1) },
  { k: 'd7', h: '7 d', f: r => nf(r.d7, 1) },
  { k: 'd30', h: '30 d', f: r => nf(r.d30, 1) },
  { k: 'period', h: 'Vald period', f: r => `<b>${nf(r.period, 1)}</b>` },
  { k: 'maxI', h: 'Max mm/h', f: r => nf(r.maxI, 1) },
  { k: 'last', h: 'Senaste regn', f: r => `<span class="${r.last && Date.now() - r.last > 7 * A.DAY ? 'dim' : ''}">${ago(r.last)}</span>` },
  { k: 'battery', h: 'Batteri', f: r => r.g.battery ? nf(r.g.battery, 2) + ' V' : '–', v: r => r.g.battery },
];
function renderGaugeTable(rows) {
  const s = S.sort.gauges, col = G_COLS.find(c => c.k === s.k);
  const val = r => col.v ? col.v(r) : r[s.k];
  const sorted = rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string' ? x.localeCompare(y, 'sv') : (x ?? -1) - (y ?? -1)) * (s.asc ? 1 : -1); });
  const t = $('#gaugeTable');
  t.innerHTML = `<thead><tr>${G_COLS.map(c => `<th data-k="${c.k}" class="${c.k === s.k ? 'sorted' + (s.asc ? ' asc' : '') : ''}">${c.h}</th>`).join('')}</tr></thead>
    <tbody>${sorted.map(r => `<tr data-id="${esc(r.g.id)}" class="${S.selGauges.includes(r.g.id) ? 'sel' : ''}">${G_COLS.map(c => `<td>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  t.querySelectorAll('th').forEach(th => th.addEventListener('click', () => { const k = th.dataset.k; S.sort.gauges = { k, asc: s.k === k ? !s.asc : k === 'name' }; renderGaugeTable(rows); }));
  t.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => toggleGauge(tr.dataset.id)));
  $('#gaugeInfo').textContent = `Klicka för att visa i diagram · ${fmtDT(S.from)} – ${fmtDT(S.to)}`;
}
$('#exportGauges').addEventListener('click', () => {
  const rows = S._gaugeRows || [];
  downloadCsv('regnmatare.csv', [['Regnmätare', 'Senaste timmen', '24 h', '7 d', '30 d', `Period ${fmtDT(S.from)}–${fmtDT(S.to)}`, 'Max mm/h', 'Senaste regn', 'Lat', 'Lon'],
    ...rows.map(r => [r.g.name, r.h1, r.h24, r.d7, r.d30, r.period, r.maxI, r.last ? fmtDT(r.last) : '', r.g.lat, r.g.lon])]);
});

let map, mapLayer;
function renderMap(rows) {
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: true });
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
    L.tileLayer(esri + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap' }).addTo(map);
    L.tileLayer(esri + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
    map.on('zoomend', () => { if (!map._busy && S._gaugeRows) renderMap(S._gaugeRows); });
  }
  const pts = rows.filter(r => r.g.lat && r.g.lon);
  map._busy = true; // fitBounds kan trigga zoomend synkront – undvik dubbelritning
  if (!map._fitted && pts.length) { map.fitBounds(L.latLngBounds(pts.map(r => [r.g.lat, r.g.lon])).pad(0.15), { animate: false }); map._fitted = true; }
  map._busy = false;
  mapLayer.clearLayers();
  const max = Math.max(1, ...pts.map(r => r.period));
  // placera etiketter så de inte krockar (höger, vänster, upp, ned)
  const placed = [];
  const boxFor = (p, dir, rad, w) => {
    const h = 20;
    if (dir === 'right') return [p.x + rad + 6, p.y - h / 2, p.x + rad + 6 + w, p.y + h / 2];
    if (dir === 'left') return [p.x - rad - 6 - w, p.y - h / 2, p.x - rad - 6, p.y + h / 2];
    if (dir === 'top') return [p.x - w / 2, p.y - rad - 6 - h, p.x + w / 2, p.y - rad - 6];
    return [p.x - w / 2, p.y + rad + 6, p.x + w / 2, p.y + rad + 6 + h];
  };
  const hit = (a, c) => !(a[2] < c[0] || a[0] > c[2] || a[3] < c[1] || a[1] > c[3]);
  const dirs = {};
  {
    pts.slice().sort((a, b) => b.g.lat - a.g.lat).forEach(r => {
      const p = map.latLngToContainerPoint([r.g.lat, r.g.lon]), rad = 7 + 16 * Math.sqrt(r.period / max), w = 8 * (r.g.name.length + 9);
      let best = 'right';
      for (const d of ['right', 'left', 'top', 'bottom']) { const bx = boxFor(p, d, rad, w); if (!placed.some(q => hit(q, bx))) { best = d; break; } }
      placed.push(boxFor(p, best, rad, w)); dirs[r.g.id] = best;
    });
  }
  pts.forEach(r => {
    const sel = S.selGauges.includes(r.g.id);
    const k = Math.sqrt(r.period / max);
    const m = L.circleMarker([r.g.lat, r.g.lon], {
      radius: 7 + 16 * k, weight: sel ? 3 : 1.5, color: sel ? SERIES[S.gaugeColor[r.g.id]] : '#86b6ef',
      fillColor: '#3987e5', fillOpacity: 0.2 + 0.6 * k,
    }).addTo(mapLayer);
    const dir = dirs[r.g.id] || 'right', off = 7 + 16 * k + 4;
    m.bindTooltip(`${esc(r.g.name)} <b>${nf(r.period, 1)} mm</b>`, { permanent: true, direction: dir, offset: { right: [off, 0], left: [-off, 0], top: [0, -off], bottom: [0, off] }[dir], className: 'gauge-label' });
    m.on('click', () => toggleGauge(r.g.id));
  });
  setTimeout(() => map.invalidateSize(), 50);
}

function renderRainChart(rows) {
  const step = +$('#rainStep2').value, from = S.from, to = S.to;
  const sel = rows.filter(r => S.selGauges.includes(r.g.id));
  const unit = step >= A.DAY ? 'mm/dygn' : 'mm/h';
  $('#rainChartTitle').textContent = step >= A.DAY ? 'Regn per dygn' : 'Regn per timme';
  $('#rainLegend').innerHTML = legendHtml(sel.map(r => ({ name: r.g.name, color: SERIES[S.gaugeColor[r.g.id]] })));
  const c = chart('rainChart');
  const zoomKeep = keepZoom(c, from, to);
  if (!sel.length) { c.clear(); c.setOption({ title: { text: 'Välj regnmätare i tabellen eller kartan', left: 'center', top: 'middle', textStyle: { color: C.muted, fontSize: 13, fontWeight: 400 } } }, true); return; }
  const ser = [];
  sel.forEach(r => {
    const col = SERIES[S.gaugeColor[r.g.id]];
    const cs = clip(r.s, from, to);
    const b = A.binSum(cs, from, to, step);
    let cum = 0;
    ser.push({ name: r.g.name, type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, symbolSize: 6, data: b.t.map((t, i) => [Math.min(t + step / 2, to), b.v[i]]), lineStyle: { width: 1.7, color: col }, itemStyle: { color: col } });
    const hb = A.binSum(cs, from, to, A.HOUR);
    ser.push({ name: r.g.name + ' ', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, data: hb.t.map((t, i) => [t + A.HOUR, +(cum += hb.v[i]).toFixed(1)]), lineStyle: { width: 1.7, color: col }, itemStyle: { color: col } });
  });
  const x = i => ({ type: 'time', gridIndex: i, min: from, max: to, ...axisCommon, splitLine: { show: false }, axisLabel: i === 1 ? timeAxisLabel : { show: false }, axisPointer: { label: { show: i === 1, formatter: p => fmtDT(p.value) } } });
  const y = (i, name, extra) => ({ type: 'value', gridIndex: i, name, nameTextStyle: { color: C.muted, fontSize: 11, align: 'left' }, splitNumber: 3, min: 0, ...axisCommon, ...extra });
  c.setOption({
    animation: false, grid: [{ left: 50, right: 24, top: 30, height: '44%' }, { left: 50, right: 24, top: '62%', height: '26%' }],
    xAxis: [x(0), x(1)], yAxis: [y(0, `Regn ${unit}`), y(1, 'Ackumulerat mm')],
    toolbox: toolboxZoom([0, 1]),
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], zoomOnMouseWheel: 'ctrl', moveOnMouseMove: false, moveOnMouseWheel: false, preventDefaultMouseMove: false, filterMode: 'none', minValueSpan: 30 * A.MIN },
      { type: 'slider', xAxisIndex: [0, 1], bottom: 6, height: 22, borderColor: C.axis, backgroundColor: '#161618', fillerColor: 'rgba(57,135,229,0.15)', textStyle: { color: C.muted }, labelFormatter: v => fmtShort(v), filterMode: 'none', minValueSpan: 30 * A.MIN }],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: { ...tooltipBase, formatter: ps => {
      if (!ps.length) return '';
      const t = ps[0].axisValue;
      let h = `<div style="color:${C.text2};margin-bottom:4px">${WD[new Date(t).getDay()]} ${fmtDT(t)}</div><table style="border-collapse:collapse">`;
      const top = ps.filter(p => p.axisIndex === 0 || p.seriesIndex % 2 === 0);
      ps.filter(p => p.seriesIndex % 2 === 0).forEach(p => {
        const cumP = ps.find(q => q.seriesIndex === p.seriesIndex + 1);
        h += `<tr><td style="padding-right:12px"><span style="display:inline-block;width:9px;height:3px;border-radius:2px;background:${p.color};margin-right:6px;vertical-align:3px"></span>${esc(p.seriesName)}</td><td style="text-align:right"><b>${nf(p.value[1], 1)}</b> ${unit}</td>${cumP ? `<td style="text-align:right;padding-left:12px;color:${C.muted}">Σ ${nf(cumP.value[1], 1)} mm</td>` : ''}</tr>`;
      });
      if (!top.length) ps.forEach(p => { h += `<tr><td>${esc(p.seriesName)}</td><td><b>${nf(p.value[1], 1)}</b> mm</td></tr>`; });
      return h + '</table>';
    } },
    series: ser,
  }, true);
  enableBrushZoom(c);
  if (zoomKeep) c.dispatchAction({ type: 'dataZoom', startValue: zoomKeep[0], endValue: zoomKeep[1] });
}
$('#resetZoom2').addEventListener('click', () => charts.rainChart && charts.rainChart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 }));

function renderDaily(rows) {
  const from = S.from, to = S.to;
  const days = A.binSum({ t: [], v: [] }, from, to, A.DAY).t;
  const mat = rows.map(r => A.binSum(clip(r.s, from, to), from, to, A.DAY).v);
  const max = Math.max(1, ...mat.flat());
  const t = $('#dailyTable');
  const cell = v => { const a = v > 0 ? 0.12 + 0.7 * Math.sqrt(v / max) : 0; return `<td class="${v > 0 ? 'c' : 'dim'}" style="${v > 0 ? `background:rgba(57,135,229,${a.toFixed(2)})` : ''}">${v > 0 ? nf(v, 1) : '·'}</td>`; };
  const order = days.map((_, i) => i).reverse();
  t.innerHTML = `<thead><tr><th>Datum</th>${rows.map(r => `<th>${esc(r.g.name)}</th>`).join('')}<th>Medel</th></tr></thead>
    <tbody>${order.map(i => { const vals = mat.map(m => m[i]); const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1); return `<tr><td>${WD[new Date(days[i]).getDay()]} ${fmtDate(days[i])}</td>${vals.map(cell).join('')}<td>${nf(mean, 1)}</td></tr>`; }).join('')}</tbody>
    <tfoot><tr><td>Summa</td>${mat.map(m => `<td>${nf(m.reduce((a, b) => a + b, 0), 1)}</td>`).join('')}<td>${nf(mat.map(m => m.reduce((a, b) => a + b, 0)).reduce((a, b) => a + b, 0) / (mat.length || 1), 1)}</td></tr></tfoot>`;
  S._daily = { days, rows, mat };
}
$('#exportDaily').addEventListener('click', () => {
  const d = S._daily; if (!d) return;
  downloadCsv('dygnsnederbord.csv', [['Datum', ...d.rows.map(r => r.g.name)], ...d.days.map((day, i) => [fmtDate(day), ...d.mat.map(m => m[i])])]);
});

/* ---------------- CSV ---------------- */
function downloadCsv(name, rows) {
  const csv = '﻿' + rows.map(r => r.map(v => { const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- start ---------------- */
(async () => {
  if (api.platform === 'darwin') document.body.classList.add('mac');
  const st = await api.authStatus();
  if (st.loggedIn) boot(); else showLogin();
})();
