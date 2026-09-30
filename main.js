const { app, BrowserWindow, ipcMain, safeStorage, shell, nativeTheme, Menu, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const API = 'https://api.swamp.se/api/';
const PORTAL = 'https://portal.swamp.se/#/landing';
const AUTH_FILE = () => path.join(app.getPath('userData'), 'auth.json');
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');

let win = null;
let auth = { token: null, expires: null, user: null, email: null, password: null };

/* ---------- lagring (krypterad med OS-nyckelring via safeStorage) ---------- */
const enc = s => (s == null ? null : safeStorage.isEncryptionAvailable() ? 'e:' + safeStorage.encryptString(s).toString('base64') : 'p:' + Buffer.from(s).toString('base64'));
const dec = s => { if (!s) return null; try { return s.startsWith('e:') ? safeStorage.decryptString(Buffer.from(s.slice(2), 'base64')) : Buffer.from(s.slice(2), 'base64').toString(); } catch { return null; } };

function loadAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf8'));
    auth = { token: dec(j.token), expires: j.expires, user: j.user, email: dec(j.email), password: dec(j.password) };
  } catch { /* första start */ }
}
function saveAuth() {
  fs.writeFileSync(AUTH_FILE(), JSON.stringify({ token: enc(auth.token), expires: auth.expires, user: auth.user, email: enc(auth.email), password: enc(auth.password) }));
}
function clearAuth() { auth = { token: null, expires: null, user: null, email: null, password: null }; try { fs.unlinkSync(AUTH_FILE()); } catch {} }

/* ---------- API ---------- */
async function authenticate(email, password) {
  const r = await fetch(API + 'Users/authenticate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(r.status === 400 || r.status === 401 ? 'Fel e-post eller lösenord' : 'Inloggning misslyckades (' + r.status + ')');
  const u = await r.json();
  if (!u.token) throw new Error('Inget token i svaret');
  auth.token = u.token; auth.expires = u.tokenExpires || null;
  auth.user = { name: u.fullName || [u.firstname, u.lastname].filter(Boolean).join(' ') || email, email: u.email || email };
  return auth.user;
}

const cache = new Map(); // enkel cache för att slippa dubbelhämtning
const inflight = new Map(); // samtidiga identiska anrop delar på ett svar
let reauth = null;
async function apiGet(p, opts = {}) {
  const hit = cache.get(p);
  if (hit && Date.now() - hit.at < (opts.ttl ?? 60000)) return hit.data;
  if (inflight.has(p)) return inflight.get(p);
  const pr = apiFetch(p).finally(() => inflight.delete(p));
  inflight.set(p, pr);
  return pr;
}
async function apiFetch(p) {
  const doFetch = () => fetch(API + p, { headers: { Authorization: 'Bearer ' + auth.token } });
  if (!auth.token) throw Object.assign(new Error('Inte inloggad'), { code: 401 });
  let r = await doFetch();
  if (r.status === 401 && auth.email && auth.password) { // token gått ut – logga in igen tyst (en gång, delat mellan anrop)
    try {
      reauth = reauth || authenticate(auth.email, auth.password).then(saveAuth).finally(() => setTimeout(() => (reauth = null), 5000));
      await reauth; r = await doFetch();
    } catch { auth.password = null; saveAuth(); }
  }
  if (r.status === 401) {
    const body = await r.text().catch(() => '');
    if (/permission/i.test(body)) throw Object.assign(new Error('Behörighet saknas: ' + p), { code: 403 });
    win?.webContents.send('auth:expired'); throw Object.assign(new Error('Sessionen har gått ut'), { code: 401 }); }
  if (!r.ok) throw new Error(`API ${r.status}: ${p}`);
  const data = await r.json();
  cache.set(p, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

/* ---------- Tidsserier: hämtas i 7-dygnsblock (parallellt, cachade) ---------- */
const pad = n => String(n).padStart(2, '0');
const fmtLocal = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const parseLocal = s => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : NaN; };
const BLOCK = 7 * 86400000;
async function getSeries(dev, key, from, to) {
  const jobs = [];
  for (let b = Math.floor(from / BLOCK) * BLOCK; b < to; b += BLOCK) {
    const bEnd = b + BLOCK;
    const complete = bEnd < Date.now() - 3600000;
    const a = complete ? b : b, z = complete ? bEnd - 1000 : Math.min(bEnd - 1000, Math.max(to, Date.now()));
    const p = `tagdata/timeseries/${encodeURIComponent(dev)}/${encodeURIComponent(key)}/${encodeURIComponent(fmtLocal(a))}/${encodeURIComponent(fmtLocal(z))}`;
    jobs.push(apiGet(p, { ttl: complete ? 6 * 3600000 : 60000 }));
  }
  const parts = await Promise.all(jobs);
  const t = [], v = [];
  let last = -Infinity;
  for (const rows of parts) for (const r of rows || []) {
    const tt = parseLocal(r.date), vv = parseFloat(r.value);
    if (!isFinite(tt) || !isFinite(vv) || tt < from || tt > to) continue;
    if (tt < last) { /* osorterat – sorteras nedan */ }
    last = tt; t.push(tt); v.push(vv);
  }
  const idx = t.map((_, i) => i).sort((i, j) => t[i] - t[j]);
  return { t: idx.map(i => t[i]), v: idx.map(i => v[i]) };
}

/* ---------- Inloggning via portalen (fungerar även med SSO) ---------- */
function portalLogin() {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({ width: 1100, height: 800, parent: win, modal: false, title: 'Logga in – Swamp portal', backgroundColor: '#1e1e1e', autoHideMenuBar: true, webPreferences: { partition: 'persist:portal' } });
    w.loadURL(PORTAL);
    let done = false;
    const probe = `(() => { try { const el=[...document.querySelectorAll('body *')].find(e=>e.__vue__&&e.__vue__.$store); const u=el&&el.__vue__.$store.state.users; return u&&u.token ? {token:u.token, expires:u.currentUser&&u.currentUser.tokenExpires, name:u.currentUser&&u.currentUser.fullName, email:u.currentUser&&u.currentUser.email} : null } catch(e){ return null } })()`;
    const timer = setInterval(async () => {
      if (w.isDestroyed()) return;
      try {
        const res = await w.webContents.executeJavaScript(probe, true);
        if (res && res.token && !done) {
          done = true; clearInterval(timer);
          auth.token = res.token; auth.expires = res.expires; auth.user = { name: res.name || res.email, email: res.email };
          auth.email = null; auth.password = null; saveAuth();
          w.close(); resolve(auth.user);
        }
      } catch { /* sidan laddar */ }
    }, 1000);
    w.on('closed', () => { clearInterval(timer); if (!done) reject(new Error('Inloggningsfönstret stängdes')); });
  });
}

function openPortal(url) {
  const w = new BrowserWindow({ width: 1300, height: 850, title: 'Swamp portal', backgroundColor: '#1e1e1e', autoHideMenuBar: true, webPreferences: { partition: 'persist:portal' } });
  w.loadURL(url || PORTAL);
}

/* ---------- fönster ---------- */
function createWindow() {
  let st = { width: 1480, height: 940 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) }; } catch {}
  // fönstret får inte hamna utanför skärmen (t.ex. om en extra skärm kopplats bort)
  if (st.x != null && !screen.getAllDisplays().some(d => { const a = d.workArea; return st.x < a.x + a.width - 100 && st.x + st.width > a.x + 100 && st.y >= a.y - 10 && st.y < a.y + a.height - 100; })) { delete st.x; delete st.y; }
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    ...st, minWidth: 980, minHeight: 640, show: false,
    title: 'Swamp Tillskott', backgroundColor: '#141416',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#141416', symbolColor: '#c3c2b7', height: 44 },
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  const persist = () => { if (!win || win.isDestroyed()) return; const b = win.getNormalBounds(); fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...b, maximized: win.isMaximized() })); };
  win.on('close', persist);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F12') win.webContents.toggleDevTools();
    if (i.key === 'F5' || (i.control && i.key.toLowerCase() === 'r')) { e.preventDefault(); win.webContents.send('app:refresh'); }
  });
}

/* ---------- IPC ---------- */
const MOCK = process.env.SWAMP_MOCK ? require('./test/mock.js') : null;
if (MOCK) { auth.token = 'mock'; auth.user = { name: 'Test', email: 'test@example.com' }; }
ipcMain.handle('auth:status', () => ({ loggedIn: !!auth.token, user: auth.user, remembered: !!auth.password }));
ipcMain.handle('auth:login', async (_e, { email, password, remember }) => {
  const user = await authenticate(email, password);
  if (remember) { auth.email = email; auth.password = password; } else { auth.email = null; auth.password = null; }
  saveAuth();
  return user;
});
ipcMain.handle('auth:portal', () => portalLogin());
ipcMain.handle('auth:logout', async () => { clearAuth(); cache.clear(); await session.fromPartition('persist:portal').clearStorageData().catch(() => {}); return true; });
ipcMain.handle('api:get', async (_e, p, opts) => {
  try { return { ok: true, data: MOCK ? await MOCK.get(p) : await apiGet(p, opts) }; }
  catch (err) { return { ok: false, error: err.message, code: err.code || 0 }; }
});
ipcMain.handle('api:series', async (_e, dev, key, from, to) => {
  try { return { ok: true, data: MOCK ? await MOCK.series(dev, key, from, to) : await getSeries(dev, key, from, to) }; }
  catch (err) { return { ok: false, error: err.message, code: err.code || 0 }; }
});
ipcMain.handle('api:clearCache', () => { cache.clear(); return true; });
ipcMain.handle('app:openPortal', (_e, url) => openPortal(url));
ipcMain.handle('app:version', () => app.getVersion());

app.setAppUserModelId('se.swamp.tillskott');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); if (!MOCK) loadAuth(); createWindow();
    if (process.env.SWAMP_E2E) require('./test/e2e.js')(win, app, process.env.SWAMP_E2E);
    if (process.env.SWAMP_SHOT) { // testläge: skärmdumpar av båda vyerna
      const out = process.env.SWAMP_SHOT;
      win.webContents.on('console-message', (_e, _l, m) => console.log('[renderer]', m));
      setTimeout(async () => {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 900, y: 560 });
        await new Promise(r => setTimeout(r, 500));
        fs.writeFileSync(out + '-analys.png', (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop=900`);
        await new Promise(r => setTimeout(r, 600));
        fs.writeFileSync(out + '-analys2.png', (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('[data-view=regn]').click()`);
        await new Promise(r => setTimeout(r, 3500));
        fs.writeFileSync(out + '-regn.png', (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('main').scrollTop=700`);
        await new Promise(r => setTimeout(r, 600));
        fs.writeFileSync(out + '-regn2.png', (await win.webContents.capturePage()).toPNG());
        app.exit(0);
      }, 5000);
    }
  });
  app.on('window-all-closed', () => app.quit());
}
