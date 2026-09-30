/* Beräkningar för regn vs nivå (tillskottsvatten). Rena funktioner – testbara i Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;

  /** API-rader -> {t:[ms], v:[number]} sorterat */
  function parseRows(rows) {
    const out = [];
    for (const r of rows || []) {
      const v = parseFloat(r.value);
      if (!isFinite(v)) continue;
      const t = parseLocal(r.date || r.createdAt);
      if (!isFinite(t)) continue;
      out.push([t, v]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return { t: out.map(x => x[0]), v: out.map(x => x[1]) };
  }

  /** "2026-09-29 23:16:52" tolkas som lokal tid */
  function parseLocal(s) {
    if (typeof s !== 'string') return NaN;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return Date.parse(s);
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  }

  /** Början av lokalt intervall (hanterar sommartid för timme/dygn) */
  function floorTo(t, stepMs) {
    const d = new Date(t);
    if (stepMs >= DAY) { d.setHours(0, 0, 0, 0); return d.getTime(); }
    if (stepMs >= HOUR) { d.setMinutes(0, 0, 0); return d.getTime(); }
    const m = stepMs / MIN;
    d.setMinutes(Math.floor(d.getMinutes() / m) * m, 0, 0);
    return d.getTime();
  }
  function nextStep(t, stepMs) {
    if (stepMs >= DAY) { const d = new Date(t); d.setDate(d.getDate() + Math.round(stepMs / DAY)); return d.getTime(); }
    return t + stepMs;
  }

  /** Hampel-filter mot spikar (t.ex. nivå som hoppar till 16 mm) */
  function despike(s, win = 7, k = 4, minTol = 8) {
    const n = s.v.length, v = s.v.slice(), h = Math.floor(win / 2);
    let removed = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
      const w = s.v.slice(a, b).sort((x, y) => x - y);
      const med = w[w.length >> 1];
      const mad = w.map(x => Math.abs(x - med)).sort((x, y) => x - y)[w.length >> 1] * 1.4826;
      if (Math.abs(s.v[i] - med) > Math.max(k * mad, minTol)) { v[i] = med; removed++; }
    }
    return { t: s.t, v, removed };
  }

  /** Summera regn (tippningar) i fasta intervall, nollfyllt */
  function binSum(s, from, to, stepMs) {
    const t = [], v = [];
    const idx = new Map();
    for (let x = floorTo(from, stepMs); x < to; x = nextStep(x, stepMs)) { idx.set(x, t.length); t.push(x); v.push(0); }
    for (let i = 0; i < s.t.length; i++) {
      const k = idx.get(floorTo(s.t[i], stepMs));
      if (k !== undefined) v[k] += s.v[i];
    }
    return { t, v: v.map(x => Math.round(x * 100) / 100) };
  }

  /** Medelvärde i fasta intervall (null där data saknas) */
  function binMean(s, from, to, stepMs) {
    const t = [], sum = [], cnt = [];
    const idx = new Map();
    for (let x = floorTo(from, stepMs); x < to; x = nextStep(x, stepMs)) { idx.set(x, t.length); t.push(x); sum.push(0); cnt.push(0); }
    for (let i = 0; i < s.t.length; i++) {
      const k = idx.get(floorTo(s.t[i], stepMs));
      if (k !== undefined) { sum[k] += s.v[i]; cnt[k]++; }
    }
    return { t, v: sum.map((x, i) => cnt[i] ? x / cnt[i] : null) };
  }

  const SLOT = 15 * MIN, SLOTS = 96;
  const slotOf = t => { const d = new Date(t); return d.getHours() * 4 + Math.floor(d.getMinutes() / 15); };
  const isWeekend = t => { const g = new Date(t).getDay(); return g === 0 || g === 6; };
  const median = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const quantile = (a, q) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };

  /**
   * Torrvädersprofil: median av nivån per kvart på dygnet, bara från perioder
   * utan regn de senaste `dryHours` timmarna. Separat vardag/helg om data räcker.
   */
  function dryWeatherProfile(level15, rainHourly, opts = {}) {
    const dryHours = opts.dryHours ?? 48, dryMm = opts.dryMm ?? 0.4, minN = opts.minN ?? 3;
    // kumulativt regn för snabb fönstersumma
    const rt = rainHourly.t, cum = [0];
    for (let i = 0; i < rainHourly.v.length; i++) cum.push(cum[i] + rainHourly.v[i]);
    const rainBetween = (a, b) => { // summa för timmar som startar i [a,b)
      const i = lowerBound(rt, a), j = lowerBound(rt, b);
      return cum[j] - cum[i];
    };
    const buckets = { wd: [], we: [], all: [], any: [] };
    for (const k of Object.keys(buckets)) for (let s = 0; s < SLOTS; s++) buckets[k].push([]);
    let dryCount = 0;
    for (let i = 0; i < level15.t.length; i++) {
      const v = level15.v[i]; if (v == null) continue;
      const t = level15.t[i], s = slotOf(t);
      buckets.any[s].push(v);
      if (t - dryHours * HOUR < rt[0]) continue; // okänd regnhistorik
      if (rainBetween(t - dryHours * HOUR, t + HOUR) > dryMm) continue;
      dryCount++;
      buckets.all[s].push(v);
      (isWeekend(t) ? buckets.we : buckets.wd)[s].push(v);
    }
    let method = 'torrväder';
    const all = buckets.all.map((a, s) => a.length >= minN ? median(a) : null);
    const missing = all.filter(x => x == null).length;
    let base = all;
    if (missing > SLOTS * 0.25) { // för lite torrväder: använd 20:e percentilen av allt
      method = 'kvantil';
      base = buckets.any.map(a => quantile(a, 0.2));
    } else {
      base = all.map((x, s) => x ?? quantile(buckets.any[s], 0.2));
    }
    const mk = b => buckets[b].map((a, s) => a.length >= minN ? median(a) : base[s]);
    const wd = method === 'kvantil' ? base : smoothCircular(mk('wd'));
    const we = method === 'kvantil' ? base : smoothCircular(mk('we'));
    return { weekday: wd, weekend: we, all: smoothCircular(base), dryCount, method, dryHours };
  }

  function smoothCircular(a, r = 1) {
    const n = a.length;
    return a.map((_, i) => {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) { const x = a[(i + k + n) % n]; if (x != null) { s += x; c++; } }
      return c ? s / c : null;
    });
  }

  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

  function baselineAt(t, prof) { return (isWeekend(t) ? prof.weekend : prof.weekday)[slotOf(t)]; }

  /** Regnhändelser: timmar med regn, sammanslagna om uppehållet < gapHours */
  function detectEvents(rainHourly, level15, prof, opts = {}) {
    const gapH = opts.gapHours ?? 6, minMm = opts.minMm ?? 1, respH = opts.responseHours ?? 24;
    const ev = [];
    let cur = null;
    for (let i = 0; i < rainHourly.t.length; i++) {
      const v = rainHourly.v[i]; if (!(v > 0)) continue;
      const t = rainHourly.t[i];
      if (cur && t - cur.lastWet <= gapH * HOUR) {
        cur.lastWet = t; cur.total += v; cur.maxI = Math.max(cur.maxI, v); cur.wsum += v * (t + HOUR / 2);
      } else {
        if (cur) ev.push(cur);
        cur = { start: t, lastWet: t, total: v, maxI: v, wsum: v * (t + HOUR / 2) };
      }
    }
    if (cur) ev.push(cur);
    const out = [];
    for (let e = 0; e < ev.length; e++) {
      const x = ev[e];
      if (x.total < minMm) continue;
      const end = x.lastWet + HOUR;
      const centroid = x.wsum / x.total;
      // svarsfönster: från regnstart till end+respH (eller nästa händelse)
      const nextStart = ev[e + 1] ? ev[e + 1].start : Infinity;
      const wEnd = Math.min(end + respH * HOUR, nextStart);
      let peak = -Infinity, peakT = null, excess = 0, pre = [], n = 0;
      for (let i = lowerBound(level15.t, x.start - 3 * HOUR); i < level15.t.length && level15.t[i] < wEnd; i++) {
        const lv = level15.v[i]; if (lv == null) continue;
        const b = baselineAt(level15.t[i], prof); if (b == null) continue;
        const d = lv - b;
        if (level15.t[i] < x.start) { pre.push(d); continue; }
        n++;
        if (d > peak) { peak = d; peakT = level15.t[i]; }
        if (d > 0) excess += d * 0.25; // mm·h
      }
      const preD = pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : 0;
      out.push({
        start: x.start, end, durationH: (end - x.start) / HOUR, total: round(x.total, 1), maxI: round(x.maxI, 1),
        centroid,
        peakDelta: n ? round(peak, 1) : null,
        rise: n ? round(peak - Math.max(0, preD), 1) : null,
        peakT, toPeakH: peakT ? round((peakT - x.start) / HOUR, 1) : null, lagH: peakT ? round((peakT - centroid) / HOUR, 1) : null,
        excess: n ? round(excess, 0) : null,
        perMm: n ? round((peak - Math.max(0, preD)) / x.total, 2) : null,
        windowEnd: wEnd, hasLevel: n > 0,
      });
    }
    return out;
  }

  /**
   * Hitta början på nuvarande "mätperiod": bryt vid dataglapp > maxGapH eller vid
   * en bestående nivåförändring (t.ex. mätaren flyttad/omkalibrerad).
   */
  function segmentStart(s, opts = {}) {
    const maxGap = (opts.maxGapHours ?? 24) * HOUR;
    if (!s.t.length) return null;
    const days = []; // [dagstart, median, första t]
    let cur = null;
    for (let i = 0; i < s.t.length; i++) {
      const d = floorTo(s.t[i], DAY);
      if (!cur || cur.d !== d) { cur = { d, v: [], t0: s.t[i] }; days.push(cur); }
      cur.v.push(s.v[i]);
    }
    days.forEach(x => (x.m = median(x.v)));
    // glapp
    let start = s.t[0];
    for (let i = s.t.length - 1; i > 0; i--) if (s.t[i] - s.t[i - 1] > maxGap) { start = s.t[i]; break; }
    // bestående nivåskifte (två dagar i rad avviker från referensen)
    const idx0 = days.findIndex(x => x.d >= floorTo(start, DAY));
    const shifted = (m, ref) => Math.abs(m - ref) > Math.max(60, 0.5 * Math.abs(ref));
    for (let i = days.length - 2; i > idx0; i--) {
      const ref = median(days.slice(i + 1, i + 4).map(x => x.m));
      if (shifted(days[i].m, ref) && shifted(days[i - 1].m, ref)) { start = Math.max(start, days[i + 1].t0); break; }
    }
    return start;
  }

  function round(x, d) { const p = Math.pow(10, d); return Math.round(x * p) / p; }

  /** Linjär regression y = a + b x, samt lutning genom origo */
  function regression(xs, ys) {
    const n = xs.length; if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0, sxy0 = 0, sxx0 = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; sxy0 += xs[i] * ys[i]; sxx0 += xs[i] * xs[i]; }
    if (!sxx) return null;
    const b = sxy / sxx, a = my - b * mx;
    return { slope: b, intercept: a, r2: syy ? (sxy * sxy) / (sxx * syy) : 0, slope0: sxy0 / sxx0, n };
  }

  return { MIN, HOUR, DAY, parseRows, parseLocal, floorTo, despike, binSum, binMean, dryWeatherProfile, baselineAt, detectEvents, regression, segmentStart, slotOf, isWeekend, median, lowerBound, round };
});
