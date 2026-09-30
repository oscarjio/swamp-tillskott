// Webbshim för window.swamp – använder portalens token (window.__SWAMP_TOKEN)
(function () {
  const API = 'https://api.swamp.se/api/';
  const cache = new Map();
  const get = async (p) => {
    if (cache.has(p)) return cache.get(p);
    const pr = fetch(API + p, { headers: { Authorization: 'Bearer ' + window.__SWAMP_TOKEN } }).then(r => { if (!r.ok) throw new Error('API ' + r.status + ' ' + p); return r.json(); });
    cache.set(p, pr); pr.catch(() => cache.delete(p)); return pr;
  };
  const pad = n => String(n).padStart(2, '0');
  const fmt = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const BLOCK = 7 * 864e5;
  async function series(dev, key, from, to) {
    const jobs = [];
    for (let b = Math.floor(from / BLOCK) * BLOCK; b < to; b += BLOCK) {
      const complete = b + BLOCK < Date.now() - 36e5;
      const z = complete ? b + BLOCK - 1000 : Math.min(b + BLOCK - 1000, Math.floor(Math.max(to, Date.now()) / 6e4) * 6e4);
      jobs.push(get(`tagdata/timeseries/${encodeURIComponent(dev)}/${encodeURIComponent(key)}/${encodeURIComponent(fmt(b))}/${encodeURIComponent(fmt(z))}`));
    }
    const rows = (await Promise.all(jobs)).flat();
    const s = Analysis.parseRows(rows);
    const t = [], v = [];
    s.t.forEach((x, i) => { if (x >= from && x <= to) { t.push(x); v.push(s.v[i]); } });
    return { t, v };
  }
  const wrap = f => async (...a) => { try { return { ok: true, data: await f(...a) }; } catch (e) { return { ok: false, error: e.message }; } };
  window.swamp = {
    platform: 'web', authStatus: async () => ({ loggedIn: true, user: { name: 'webb', email: '' } }),
    login: async () => {}, portalLogin: async () => {}, logout: async () => {},
    get: wrap(p => get(p)), series: wrap(series), clearCache: async () => cache.clear(),
    openPortal: async () => {}, version: async () => 'web', onAuthExpired: () => {}, onRefresh: () => {},
  };
})();
