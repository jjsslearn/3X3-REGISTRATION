'use strict';
const express = require('express'), crypto = require('crypto'), path = require('path');
const { ADMIN_USER, ADMIN_PASS, SHEET_API_URL, SHEET_TOKEN } = process.env;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const FREE = parseInt(process.env.FREE_JERSEYS || '10', 10);
const OFFSET = parseInt(process.env.TZ_OFFSET_MIN || '330', 10); // minutes ahead of UTC (330 = India) for the edit deadline
const DEF_TITLE = '3x3 Basketball Competition';
const DEF_DESC = 'Three players, one basket, ten minutes of non-stop action. Read how the competition and the registration work below, then register your team.';
const SIZES = ['28', '30', '32', '34', '36', '38', '40', '42', '44', '46', '48'];

// ---- Sheet layout (one tab each). Registrations is append-only. ----
const HDR = {
  Categories: ['ID', 'Name', 'Born on or after', 'Born on or before'],
  Teams: ['ID', 'Team', 'Category ID', 'Secret key'],
  Settings: ['Key', 'Value'],
  Registrations: ['Reference', 'Submitted (UTC)', 'Category', 'Order in category', 'Free jersey', 'Team',
    ...[1, 2, 3, 4].flatMap(i => ['P' + i + ' name', 'P' + i + ' DOB', 'P' + i + ' chest', 'P' + i + ' size', 'P' + i + ' FIBA ID']),
    'Contact', 'Role', 'Phone', 'Email', 'Team ID', 'Category ID']
};

// ---- Storage: your Google Sheet (through Apps Script), or memory when not configured (local testing only) ----
function memoryStore() {
  const t = { Categories: [], Teams: [], Settings: [], Registrations: [] };
  return {
    async load() { return JSON.parse(JSON.stringify(t)); },
    async append(tab, row) { t[tab].push(row); },
    async replace(tab, rows) { t[tab] = rows.map(r => r.slice()); },
    async archive(name, rows) { t[name] = rows.map(r => r.slice()); }
  };
}
function appsScriptStore() { // talks to the small Google Apps Script attached to your Sheet (see apps-script/Code.gs)
  const call = async body => {
    const r = await fetch(SHEET_API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: SHEET_TOKEN, ...body }), redirect: 'follow' });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (e) { throw new Error('Unexpected reply from the sheet script. Check it is deployed as a Web app for "Anyone". ' + t.slice(0, 100)); }
    if (!j.ok) throw new Error(j.error || 'Sheet script error');
    return j;
  };
  return {
    async load() { return (await call({ action: 'load', headers: HDR })).data; },
    async append(tab, row) { await call({ action: 'append', tab, row }); },
    async replace(tab, rows) { await call({ action: 'replace', tab, rows }); },
    async archive(name, rows) { await call({ action: 'load', headers: { [name]: HDR.Registrations } }); await call({ action: 'replace', tab: name, rows }); }
  };
}
const useSheets = !!(SHEET_API_URL && SHEET_TOKEN);
const store = useSheets ? appsScriptStore() : memoryStore();

// ---- In-memory copy (loaded at start, written through to the sheet) ----
let cats = [], teams = [], regs = [], settings = {};
const catOf = id => cats.find(c => c.id === id);
const toRow = (r, order) => {
  const c = catOf(r.catId) || {};
  return [r.ref, r.at, c.name || '', String(order), order <= FREE ? 'Yes' : 'No', r.team,
    ...[0, 1, 2, 3].flatMap(i => { const p = r.players[i] || {}; return [p.name || '', p.dob || '', p.chest || '', p.size || '', p.fiba || '']; }),
    r.contact.name, r.contact.role, r.contact.phone, r.contact.email, r.teamId, r.catId];
};
const toReg = r => ({
  ref: r[0], at: r[1], team: r[5], teamId: r[30], catId: r[31],
  players: [0, 1, 2, 3].map(i => { const o = 6 + i * 5; return { name: r[o], dob: r[o + 1], chest: r[o + 2], size: r[o + 3], fiba: r[o + 4] }; }).filter(p => p.name),
  contact: { name: r[26], role: r[27], phone: r[28], email: r[29] }
});
async function hydrate() {
  const t = await store.load();
  cats = t.Categories.filter(r => r[0]).map(r => ({ id: r[0], name: r[1], from: r[2], to: r[3] }));
  teams = t.Teams.filter(r => r[0]).map(r => ({ id: r[0], name: r[1], cat: r[2], key: r[3] }));
  regs = t.Registrations.filter(r => r[0]).map(toReg);
  settings = {}; (t.Settings || []).forEach(r => { if (r[0]) settings[r[0]] = r[1]; });
}
const saveCats = () => store.replace('Categories', cats.map(c => [c.id, c.name, c.from, c.to]));
const saveTeams = () => store.replace('Teams', teams.map(t => [t.id, t.name, t.cat, t.key]));
const saveSettings = () => store.replace('Settings', [['title', settings.title || ''], ['desc', settings.desc || ''], ['deadline', settings.deadline || '']]);
const editOpen = () => !settings.deadline || Date.now() <= Date.parse(settings.deadline + 'T23:59:59Z') - OFFSET * 60000;
const rowsAll = () => { const cnt = {}; return regs.map(r => { cnt[r.catId] = (cnt[r.catId] || 0) + 1; return toRow(r, cnt[r.catId]); }); };
const regView = team => { const r = ranked().find(x => x.teamId === team.id); return r ? { ref: r.ref, at: r.at, team: r.team, cat: catOf(r.catId), players: r.players, contact: r.contact, pos: r.pos, free: r.free } : null; };
const cfgOut = () => ({ ok: true, cats, free: FREE, title: settings.title || DEF_TITLE, desc: settings.desc || DEF_DESC, deadline: settings.deadline || '', canEdit: editOpen(), teams: teams.map(t => ({ id: t.id, name: t.name, cat: t.cat, reg: regs.some(r => r.teamId === t.id) })) });
function ranked() { // regs are kept in registration order, so position = order of arrival within the category
  const cnt = {};
  const out = regs.map(r => { cnt[r.catId] = (cnt[r.catId] || 0) + 1; return { ...r, pos: cnt[r.catId], free: cnt[r.catId] <= FREE }; });
  const ix = r => { const i = cats.findIndex(c => c.id === r.catId); return i < 0 ? 999 : i; };
  return out.sort((a, b) => ix(a) - ix(b) || a.pos - b.pos);
}

// ---- Helpers ----
let chain = Promise.resolve();
const lock = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const genKey = () => { const b = crypto.randomBytes(10), k = [...b].map(x => ALPH[x % 32]).join(''); return k.slice(0, 5) + '-' + k.slice(5); };
const eq = (a, b) => { const h = s => crypto.createHash('sha256').update(String(s)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
const uid = p => p + crypto.randomBytes(4).toString('hex');
const hits = new Map();
setInterval(() => { const n = Date.now(); for (const [k, h] of hits) if (n > h.t) hits.delete(k); }, 600000).unref();
const limit = (name, max, ms) => (req, res, next) => {
  const k = name + req.ip, n = Date.now(); let h = hits.get(k);
  if (!h || n > h.t) { h = { n: 0, t: n + ms }; hits.set(k, h); }
  if (++h.n > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  next();
};
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]));
const isAdmin = req => { const c = cookies(req).adm; if (!c) return false; const [e, s] = c.split('.'); return +e > Date.now() && !!s && eq(s, sign(e)); };
const need = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Please sign in as organiser.' });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function validate(cat, P, C, taken) {
  const e = {}, s = (v, n) => String(v == null ? '' : v).trim().slice(0, n), today = new Date().toISOString().slice(0, 10);
  const pl = (Array.isArray(P) ? P : []).slice(0, 4).map(p => ({ name: s(p && p.name, 60), dob: s(p && p.dob, 10), chest: s(p && p.chest, 2), size: s(p && p.size, 2), fiba: s(p && p.fiba, 24) }));
  if (pl.length < 3) e.msg = 'Players 1 to 3 are mandatory.';
  pl.forEach((p, k) => {
    const i = k + 1;
    if (p.name.length < 2) e['n' + i] = 'Enter the player’s full name.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dob) || isNaN(new Date(p.dob))) e['d' + i] = 'Enter the date of birth.';
    else if (p.dob > today) e['d' + i] = 'Date of birth cannot be in the future.';
    else if (p.dob < cat.from || p.dob > cat.to) e['d' + i] = 'Not eligible for ' + cat.name + ' (born ' + cat.from + ' to ' + cat.to + ').';
    if (!/^\d{1,2}$/.test(p.chest)) e['c' + i] = 'Enter a number from 0 to 99.';
    if (!SIZES.includes(p.size)) e['s' + i] = 'Choose a sleeveless size.';
    if (p.fiba.length < 3) e['f' + i] = 'Enter the FIBA ID.';
    else if (taken.has(p.fiba.toLowerCase())) e['f' + i] = 'This FIBA ID is already registered for a team.';
    for (let j = 0; j < k; j++) {
      if (pl[j].chest === p.chest && !e['c' + i]) e['c' + i] = 'Same chest number as Player ' + (j + 1) + '.';
      if (p.fiba && pl[j].fiba.toLowerCase() === p.fiba.toLowerCase() && !e['f' + i]) e['f' + i] = 'Same FIBA ID as Player ' + (j + 1) + '.';
    }
  });
  const c = { name: s(C && C.name, 60), role: s(C && C.role, 10), phone: s(C && C.phone, 20), email: s(C && C.email, 80) };
  if (c.name.length < 2) e.cn = 'Enter the contact’s name.';
  if (!['Parent', 'Coach', 'Player'].includes(c.role)) e.role = 'Choose who the contact is.';
  if (!/^[+()\d\s-]{7,20}$/.test(c.phone)) e.cp = 'Enter a valid phone number.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) e.ce = 'Enter a valid email address.';
  return { e, pl, c };
}

// ---- App ----
const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
app.use(express.json({ limit: '100kb' }));
app.get('/healthz', (req, res) => res.send('ok'));

// Public
app.get('/api/config', (req, res) => res.json(cfgOut()));
app.post('/api/verify', limit('verify', 30, 600000), (req, res) => {
  const { teamId, key } = req.body || {}, t = teams.find(x => x.id === teamId);
  if (!t || !eq(norm(key), norm(t.key))) return res.status(403).json({ error: 'That secret key is not correct for this team.' });
  res.json({ ok: true, reg: regView(t), canEdit: editOpen(), deadline: settings.deadline || '' });
});
app.post('/api/register', limit('reg', 30, 600000), wrap((req, res) => lock(async () => {
  const { teamId, key, players, contact } = req.body || {}, team = teams.find(t => t.id === teamId);
  if (!team || !eq(norm(key), norm(team.key))) return res.status(403).json({ error: 'The secret key is not correct for this team.' });
  if (regs.some(r => r.teamId === team.id)) return res.status(409).json({ error: 'This team is already registered.' });
  const cat = catOf(team.cat);
  if (!cat) return res.status(409).json({ error: 'This team has no category. Please contact the organiser.' });
  const taken = new Set(regs.flatMap(r => r.players.map(p => p.fiba.toLowerCase())));
  const { e, pl, c } = validate(cat, players, contact, taken);
  if (Object.keys(e).length) return res.status(400).json({ error: e.msg || 'Please fix the fields marked in red.', errors: e });
  const rec = { ref: '3X3-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6), at: new Date().toISOString(), team: team.name, teamId: team.id, catId: cat.id, players: pl, contact: c };
  const pos = regs.filter(r => r.catId === cat.id).length + 1;
  try { await store.append('Registrations', toRow(rec, pos)); }
  catch (err) { console.error(err); return res.status(500).json({ error: 'Could not save your registration. Please try again.' }); }
  regs.push(rec);
  res.json({ ok: true, rec: { ref: rec.ref, at: rec.at, team: rec.team, cat, players: pl, contact: c }, pos, free: pos <= FREE });
})));

app.put('/api/register', limit('reg', 30, 600000), wrap((req, res) => lock(async () => {
  const { teamId, key, players, contact } = req.body || {}, team = teams.find(t => t.id === teamId);
  if (!team || !eq(norm(key), norm(team.key))) return res.status(403).json({ error: 'The secret key is not correct for this team.' });
  const reg = regs.find(r => r.teamId === team.id);
  if (!reg) return res.status(404).json({ error: 'This team has not registered yet.' });
  if (!editOpen()) return res.status(403).json({ error: 'Editing is closed. Please contact the organiser.' });
  const cat = catOf(reg.catId) || catOf(team.cat);
  if (!cat) return res.status(409).json({ error: 'This team has no category. Please contact the organiser.' });
  const taken = new Set(regs.filter(r => r.teamId !== team.id).flatMap(r => r.players.map(p => p.fiba.toLowerCase())));
  const { e, pl, c } = validate(cat, players, contact, taken);
  if (Object.keys(e).length) return res.status(400).json({ error: e.msg || 'Please fix the fields marked in red.', errors: e });
  const old = { players: reg.players, contact: reg.contact };
  reg.players = pl; reg.contact = c;
  try { await store.replace('Registrations', rowsAll()); }
  catch (err) { console.error(err); reg.players = old.players; reg.contact = old.contact; return res.status(500).json({ error: 'Could not save your changes. Please try again.' }); }
  const v = regView(team);
  res.json({ ok: true, rec: { ref: v.ref, at: v.at, team: v.team, cat: v.cat, players: v.players, contact: v.contact }, pos: v.pos, free: v.free });
})));

// Organiser
app.post('/api/admin/login', limit('login', 10, 900000), (req, res) => {
  if (!ADMIN_USER || !ADMIN_PASS) return res.status(503).json({ error: 'Organiser login is not configured on the server.' });
  const { username, password } = req.body || {}, a = eq(username || '', ADMIN_USER), b = eq(password || '', ADMIN_PASS);
  if (!(a && b)) return res.status(401).json({ error: 'Wrong username or password.' });
  const exp = Date.now() + 8 * 3600e3;
  res.setHeader('Set-Cookie', `adm=${exp}.${sign(String(exp))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.setHeader('Set-Cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/admin/data', need, (req, res) => res.json({
  ok: true, cats, free: FREE, settings: { title: settings.title || DEF_TITLE, desc: settings.desc || DEF_DESC, deadline: settings.deadline || '' },
  teams: teams.map(t => ({ id: t.id, name: t.name, cat: t.cat, key: t.key })),
  regs: ranked().map(r => ({ ref: r.ref, at: r.at, team: r.team, teamId: r.teamId, cat: catOf(r.catId) || { id: r.catId, name: 'Unknown category' }, players: r.players, contact: r.contact, pos: r.pos, free: r.free }))
}));
app.post('/api/admin/reload', need, wrap(async (req, res) => { await lock(hydrate); res.json({ ok: true }); }));
app.post('/api/admin/settings', need, wrap((req, res) => lock(async () => {
  const b = req.body || {}, title = String(b.title || '').trim().slice(0, 80), desc = String(b.desc || '').trim().slice(0, 600), deadline = String(b.deadline || '').trim();
  if (title.length < 2) return res.status(400).json({ error: 'Enter the tournament title.' });
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return res.status(400).json({ error: 'Choose a valid deadline date.' });
  const old = settings; settings = { title, desc, deadline };
  try { await saveSettings(); } catch (e) { console.error(e); settings = old; return res.status(500).json({ error: 'Could not save to Google Sheets.' }); }
  res.json({ ok: true });
})));
app.post('/api/admin/reset', need, wrap((req, res) => lock(async () => {
  const { scope, confirm } = req.body || {};
  if (!['registrations', 'teams', 'all'].includes(scope)) return res.status(400).json({ error: 'Choose what to delete.' });
  if (String(confirm || '').trim() !== 'RESET') return res.status(400).json({ error: 'Type RESET (capital letters) to confirm.' });
  const old = { regs, teams, cats, settings };
  let archived = null;
  try {
    if (regs.length) { // keep a copy of the registrations in their own sheet tab before deleting anything
      const d = new Date(Date.now() + OFFSET * 60000).toISOString();
      archived = 'Archive ' + d.slice(0, 10) + ' ' + d.slice(11, 16).replace(':', '-');
      await store.archive(archived, rowsAll());
    }
    regs = []; await store.replace('Registrations', []);
    if (scope !== 'registrations') { teams = []; await saveTeams(); }
    if (scope === 'all') { cats = []; settings = {}; await saveCats(); await saveSettings(); }
  } catch (e) {
    console.error(e); ({ regs, teams, cats, settings } = old);
    return res.status(500).json({ error: 'The reset stopped part-way. Press "Reload from Google Sheet" and check your sheet.' });
  }
  res.json({ ok: true, archived });
})));
app.post('/api/admin/category', need, wrap((req, res) => lock(async () => {
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 40), from = String(b.from || ''), to = String(b.to || '');
  if (name.length < 2) return res.status(400).json({ error: 'Enter a category name.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Choose both dates.' });
  if (from > to) return res.status(400).json({ error: 'The first date must not be after the second.' });
  if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'That category already exists.' });
  const old = cats; cats = [...cats, { id: uid('c'), name, from, to }];
  try { await saveCats(); } catch (e) { console.error(e); cats = old; return res.status(500).json({ error: 'Could not save to Google Sheets.' }); }
  res.json({ ok: true });
})));
app.delete('/api/admin/category/:id', need, wrap((req, res) => lock(async () => {
  if (teams.some(t => t.cat === req.params.id)) return res.status(409).json({ error: 'A team uses this category.' });
  const old = cats; cats = cats.filter(c => c.id !== req.params.id);
  try { await saveCats(); } catch (e) { console.error(e); cats = old; return res.status(500).json({ error: 'Could not save to Google Sheets.' }); }
  res.json({ ok: true });
})));
app.post('/api/admin/team', need, wrap((req, res) => lock(async () => {
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 60);
  if (name.length < 2) return res.status(400).json({ error: 'Enter the team name.' });
  if (!catOf(b.cat)) return res.status(400).json({ error: 'Choose a category (create one first).' });
  if (teams.some(t => t.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'That team already exists.' });
  const old = teams; teams = [...teams, { id: uid('t'), name, cat: b.cat, key: genKey() }];
  try { await saveTeams(); } catch (e) { console.error(e); teams = old; return res.status(500).json({ error: 'Could not save to Google Sheets.' }); }
  res.json({ ok: true });
})));
app.post('/api/admin/team/:id/key', need, wrap((req, res) => lock(async () => {
  if (!teams.some(t => t.id === req.params.id)) return res.status(404).json({ error: 'Team not found.' });
  const old = teams; teams = teams.map(t => t.id === req.params.id ? { ...t, key: genKey() } : t);
  try { await saveTeams(); } catch (e) { console.error(e); teams = old; return res.status(500).json({ error: 'Could not save to Google Sheets.' }); }
  res.json({ ok: true });
})));
app.delete('/api/admin/team/:id', need, wrap((req, res) => lock(async () => {
  if (regs.some(r => r.teamId === req.params.id)) return res.status(409).json({ error: 'This team has already registered, so it cannot be deleted.' });
  const old = teams; teams = teams.filter(t => t.id !== req.params.id);
  try { await saveTeams(); } catch (e) { console.error(e); teams = old; return res.status(500).json({ error: 'Could not save to Google Sheets.' }); }
  res.json({ ok: true });
})));
app.get('/api/admin/csv', need, (req, res) => {
  const q = v => { v = String(v == null ? '' : v); if (/^[=@]|^[+-][A-Za-z(]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  const H = ['Category', 'Order', 'Free jersey', 'Team', 'Reference', 'Submitted'];
  for (let i = 1; i <= 4; i++) H.push('P' + i + ' name', 'P' + i + ' DOB', 'P' + i + ' chest', 'P' + i + ' size', 'P' + i + ' FIBA ID');
  H.push('Contact', 'Role', 'Phone', 'Email');
  const rows = ranked().map(r => {
    const o = [(catOf(r.catId) || {}).name, r.pos, r.free ? 'Yes' : 'No', r.team, r.ref, r.at];
    for (let i = 0; i < 4; i++) { const p = r.players[i] || {}; o.push(p.name, p.dob, p.chest, p.size, p.fiba); }
    o.push(r.contact.name, r.contact.role, r.contact.phone, r.contact.email);
    return o.map(q).join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="3x3-registrations.csv"');
  res.send('\ufeff' + [H.map(q).join(','), ...rows].join('\n'));
});

const fs = require('fs');
const INDEX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f));
app.get(['/', '/index.html'], (req, res) => INDEX ? res.sendFile(INDEX) : res.status(500).send('index.html is missing. Put it in a folder named "public" next to server.js.'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' }); });

hydrate().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`3x3 registration on :${port} using ${useSheets ? 'Google Sheets' : 'MEMORY storage (data is lost on restart)'}`));
}).catch(e => { console.error('Could not load from Google Sheets:', e.message); process.exit(1); });
