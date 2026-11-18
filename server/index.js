'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const svc = require('./service');
const mailer = require('./mailer');
const { DATA_DIR } = require('./db');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DEV = process.env.NODE_ENV !== 'production';

svc.init();

/* ---------- Render view (template views/*.html) ---------- */
const cache = {};
function template(name) {
  if (!DEV && cache[name]) return cache[name];
  const styles = fs.readFileSync(path.join(VIEWS, 'Styles.html'), 'utf8');
  const html = fs.readFileSync(path.join(VIEWS, name + '.html'), 'utf8')
    .split("<?!= include('Styles'); ?>").join(styles)
    .split('<base target="_top">').join('<script>window.__API_BASE__ = "";</script>');
  cache[name] = html;
  return html;
}
/** Nilai rute yang sudah disaring. */
function routeVars(q) {
  const pick = (v, re) => (typeof v === 'string' && re.test(v) ? v : '');
  const page = ['klaim', 'p', 'prodi'].includes(q.page) ? q.page : 'home';
  if (page === 'prodi' && !q.prodi && q.id) q = Object.assign({}, q, { prodi: q.id });
  return {
    appUrl: '/',
    page,
    slug: pick(q.slug, /^[a-z0-9-]{1,60}$/),
    tab: q.tab === 'kip' ? 'kip' : 'voucher',
    s: pick(q.s, /^[a-z]{1,20}$/),
    prodi: pick(q.prodi, /^[A-Za-z0-9]{1,40}$/)
  };
}
function render(name, vars) {
  vars = vars || { appUrl: '/' };
  return template(name).replace(/<\?= (\w+) \?>/g, (m, k) => (k in vars ? String(vars[k]) : ''));
}

/* ---------- Rate limit sederhana per IP ---------- */
const hits = new Map();
function rateLimit(ip, key, max, windowMs) {
  const k = key + '|' + ip, now = Date.now();
  const h = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (h.length >= max) { const e = new Error('Terlalu banyak permintaan. Coba lagi beberapa menit lagi.'); e.status = 429; e.expose = true; throw e; }
  h.push(now); hits.set(k, h);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

/* ---------- API: POST /api/<namaFungsi> dengan body { args: [...] } ---------- */
const API = {
  getPublicData: ([slug, prodiId]) => svc.getPublicData(typeof slug === 'string' ? slug.slice(0, 60) : '', typeof prodiId === 'string' ? prodiId.slice(0, 40) : ''),
  adminSaveMenu: ([t, o]) => svc.adminSaveMenu(t, o),
  adminSaveLayout: ([t, l]) => svc.adminSaveLayout(t, l),
  adminSaveHero: ([t, o]) => svc.adminSaveHero(t, o),
  adminEmailInfo: ([t, re]) => svc.adminEmailInfo(t, re === true),
  adminTestEmail: ([t, to], ip) => { rateLimit(ip, 'testmail', 10, 10 * 60e3); return svc.adminTestEmail(t, to); },
  adminResendPending: ([t]) => svc.adminResendPending(t),
  adminSaveSmtp: ([t, c], ip) => { rateLimit(ip, 'smtp', 20, 10 * 60e3); return svc.adminSaveSmtp(t, c); },
  adminSaveHalaman: ([t, p]) => svc.adminSaveHalaman(t, p),
  adminDeleteHalaman: ([t, id]) => svc.adminDeleteHalaman(t, id),
  submitClaim: ([form], ip) => { rateLimit(ip, 'claim', 10, 10 * 60e3); return svc.submitClaim(form); },
  submitKip: ([form], ip) => { rateLimit(ip, 'kip', 10, 10 * 60e3); return svc.submitKip(form); },
  adminUpdateKip: ([t, id, p]) => svc.adminUpdateKip(t, id, p),
  adminDeleteKip: ([t, id]) => svc.adminDeleteKip(t, id),
  adminLogin: ([u, p], ip) => { rateLimit(ip, 'login', 30, 15 * 60e3); return svc.adminLogin(u, p, ip); },
  adminLogout: ([t]) => svc.adminLogout(t),
  adminGetData: ([t]) => svc.adminGetData(t),
  adminSaveSettings: ([t, o]) => svc.adminSaveSettings(t, o),
  adminSaveProdi: ([t, p]) => svc.adminSaveProdi(t, p),
  adminDeleteProdi: ([t, id]) => svc.adminDeleteProdi(t, id),
  adminUpdatePendaftar: ([t, id, p]) => svc.adminUpdatePendaftar(t, id, p),
  adminDeletePendaftar: ([t, id]) => svc.adminDeletePendaftar(t, id),
  adminResendVoucher: ([t, id]) => svc.adminResendVoucher(t, id),
  adminChangeCredential: ([t, o, u, n]) => svc.adminChangeCredential(t, o, u, n)
};

const app = express();
app.disable('x-powered-by');
/* Di belakang reverse proxy (Nginx/Apache di server yang sama), req.ip diambil dari
   header X-Forwarded-For agar rate limit berlaku per pengunjung, bukan per proxy.
   Hanya proxy dari 127.0.0.1/::1 yang dipercaya; akses langsung dari luar tidak bisa memalsukan IP. */
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
app.use(express.json({ limit: '512kb' })); // cukup untuk tata letak beranda dengan banyak bagian kustom

app.get('/', (req, res) => res.type('html').send(req.query.page === 'admin' ? render('Admin') : render('Index', routeVars(req.query))));
app.get('/admin', (req, res) => res.type('html').send(render('Admin')));
app.get('/klaim', (req, res) => res.type('html').send(render('Index', routeVars(Object.assign({}, req.query, { page: 'klaim' })))));
app.get('/prodi/:id', (req, res) => res.type('html').send(render('Index', routeVars(Object.assign({}, req.query, { page: 'prodi', prodi: req.params.id })))));
app.get('/p/:slug', (req, res) => res.type('html').send(render('Index', routeVars(Object.assign({}, req.query, { page: 'p', slug: req.params.slug })))));
app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: DEV ? 0 : '7d' }));
app.get('/health', (req, res) => res.json({ ok: true }));

/* Unggah foto halaman: body = isi file mentah, token admin di header X-Admin-Token. */
app.post('/api/upload', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
  try {
    rateLimit(req.ip, 'upload', 60, 10 * 60e3);
    res.set('Cache-Control', 'no-store').json({ result: svc.adminUploadImage(req.get('X-Admin-Token'), req.body) });
  } catch (e) {
    if (e.expose) return res.status(e.status || 400).json({ error: e.message });
    console.error('[api:upload]', e);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

app.post('/api/:fn', async (req, res) => {
  const name = req.params.fn;
  if (!Object.prototype.hasOwnProperty.call(API, name)) return res.status(404).json({ error: 'Fungsi tidak dikenal.' });
  const args = req.body && Array.isArray(req.body.args) ? req.body.args : [];
  try {
    const result = await API[name](args, req.ip);
    res.set('Cache-Control', 'no-store').json({ result: result === undefined ? null : result });
  } catch (e) {
    if (e.expose) return res.status(e.status || 400).json({ error: e.message });
    console.error(`[api:${name}]`, e);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

app.use((req, res) => res.status(404).type('text').send('Halaman tidak ditemukan.'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: req.path === '/api/upload' ? 'Ukuran foto maksimal 5 MB.' : 'Data terlalu besar.' });
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: 'Permintaan tidak valid.' });
  console.error('[server]', err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log('');
  console.log('  PMB Landing Page berjalan');
  console.log(`  Landing page : ${url}/`);
  console.log(`  Panel admin  : ${url}/admin`);
  console.log(`  Database     : ${path.join(DATA_DIR, 'pmb.sqlite')}`);
  const mi = mailer.info();
  const src = mi.source === 'admin' ? 'halaman admin' : 'file .env';
  console.log(`  Email        : ${mi.mode === 'smtp' ? 'SMTP ' + mi.host + ':' + mi.port + ' sebagai ' + mi.from + ' (dari ' + src + ')' : 'MODE UJI - email TIDAK dikirim, hanya disimpan di ' + mailer.OUTBOX}`);
  console.log('');
  if (mi.mode === 'smtp') {
    mailer.verify().then(st => console.log(st.ok ? '  [email] Koneksi SMTP OK, email voucher siap dikirim.\n' : '  [email] SMTP BERMASALAH: ' + st.error + '\n'));
  } else {
    console.log(`  [email] Untuk mengirim email sungguhan, buka ${url}/admin > Pengaturan Email > Konfigurasi SMTP.\n`);
  }
});
