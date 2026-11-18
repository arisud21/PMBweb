'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const D = require('./db');
const mailer = require('./mailer');
const U = require('./util');
const { UserError } = U;

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const STATUS_LIST = ['Baru', 'Dihubungi', 'Mendaftar', 'Voucher Digunakan', 'Tidak Lanjut'];
const JENJANG_LIST = ['D3', 'D4', 'S1', 'S2', 'Profesi'];
const KIP_STATUS_LIST = ['Baru', 'Verifikasi', 'Diusulkan', 'Tidak Memenuhi Syarat'];
const KARTU_LIST = ['KIP', 'PKH', 'KKS', 'Panti Asuhan', 'Tidak Ada'];
const DTSEN_LIST = ['Desil 1', 'Desil 2', 'Desil 3', 'Desil 4', 'Desil 5', 'Desil 6'];
const DTSEN_PIP = ['Desil 5', 'Desil 6']; // desil yang wajib menjawab status PIP
const PIP_LIST = ['Sebagai Penerima PIP', 'Bukan Penerima PIP'];
// Tahun lulus = 3 tahun terakhir mengikuti tahun akademik, mis. 2027/2028 -> 2025, 2026, 2027
function tahunLulusList(tahunAkademik) {
  const m = String(tahunAkademik || '').match(/\b(19|20)\d{2}\b/);
  const y = m ? parseInt(m[0], 10) : parseInt(U.fmtDate().slice(0, 4), 10);
  return [y - 2, y - 1, y].map(String);
}
const lines = v => [...new Set(String(v || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean))];

const SETTING_DEFAULTS = {
  namaKampus: 'Politeknik TEDC Bandung',
  tagline: 'Penerimaan Mahasiswa Baru',
  tahunAkademik: '2027/2028',
  deskripsi: 'Daftar sekarang dan klaim voucher potongan biaya pendidikan. Kode voucher langsung dikirim ke email kamu.',
  kontakWa: '',
  kontakEmail: '',
  alamat: '',
  logoUrl: '',
  voucherAktif: 'true',
  voucherNominal: '500000',
  voucherPrefix: 'PMB',
  voucherKuota: '0',
  klaimMulai: '',
  klaimSelesai: '',
  masaBerlakuMode: 'tanggal',
  masaBerlakuTanggal: '',
  masaBerlakuHari: '30',
  voucherKeterangan: 'Voucher potongan biaya pendaftaran mahasiswa baru. Tunjukkan kode voucher ini kepada panitia PMB saat melakukan pendaftaran/daftar ulang.',
  emailSubjek: 'Voucher PMB {kampus} - {kode}',
  sumberInfo: 'Instagram\nTikTok\nEdufair\nKunjungan Tim PMB ke Sekolah',
  kipAktif: 'true',
  kipKeterangan: 'Setelah mengisi, admin akan menghubungi Anda kembali untuk verifikasi. Pendaftar yang memenuhi syarat akan menjadi prioritas dalam pengusulan KIP-K.',
  heroJudul: 'Seleksi Penerimaan Mahasiswa Baru',
  ctaLabel: 'Daftar PMB',
  ctaUrl: 'https://join.poltektedc.ac.id',
  menu: JSON.stringify([
    { id: 'm1', label: 'Beranda', type: 'section', value: 'beranda', aktif: true },
    { id: 'm2', label: 'Program Studi', type: 'section', value: 'prodi', aktif: true },
    { id: 'm3', label: 'Jalur Masuk', type: 'page', value: 'jalur-masuk', aktif: true },
    { id: 'm4', label: 'Klaim Voucher', type: 'klaim', value: '', aktif: true },
    { id: 'm5', label: 'Kontak', type: 'section', value: 'kontak', aktif: true }
  ]),
  layout: JSON.stringify(['beranda', 'prodi', 'voucher', 'statistik', 'alur'].map(id => ({ id, aktif: true }))),
  // Hero: lencana di kiri logo ({nominal} = nilai voucher, {prodi} = jumlah prodi aktif) dan tombol di kanan logo
  heroLencana: JSON.stringify([
    { teks: '{nominal}', ket: 'Nilai Voucher' },
    { teks: 'Prestasi Raport', ket: 'Jalur Seleksi' },
    { teks: 'Kartu UTBK', ket: 'Jalur Seleksi' }
  ]),
  heroTombol: JSON.stringify([
    { label: 'Klaim Voucher', url: '?page=klaim', gaya: 'utama' },
    { label: 'Peminatan KIP-K', url: '?page=klaim&tab=kip', gaya: 'sekunder' }
  ])
};
SETTING_DEFAULTS.heroPita = JSON.stringify({ aktif: true, prodi: true, teks: ['Voucher PMB', 'Beasiswa', 'Kampus Vokasi'] });
// Item hero bisa disembunyikan (aktif:false) tanpa dihapus agar dapat dipakai lagi.
// Batas "tampil" mengikuti ruang di hero; total tersimpan boleh lebih banyak.
const HERO_MAX_LENCANA = 4, HERO_MAX_TOMBOL = 3, HERO_MAX_SIMPAN = 8, HERO_MAX_PITA = 20, HERO_GAYA = ['utama', 'sekunder'];
const parseJsonArr = (v, def) => { try { const a = JSON.parse(v); if (Array.isArray(a)) return a; } catch (e) { /* abaikan */ } return JSON.parse(def); };
const withAktif = arr => arr.map(x => Object.assign({}, x, { aktif: x.aktif !== false }));
const heroLencana = s => withAktif(parseJsonArr(s.heroLencana, SETTING_DEFAULTS.heroLencana));
const heroTombol = s => withAktif(parseJsonArr(s.heroTombol, SETTING_DEFAULTS.heroTombol));
function heroPita(s) {
  let o = null;
  try { o = JSON.parse(s.heroPita); } catch (e) { o = null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = JSON.parse(SETTING_DEFAULTS.heroPita);
  return { aktif: o.aktif !== false, prodi: o.prodi !== false, teks: Array.isArray(o.teks) ? o.teks.filter(t => typeof t === 'string' && t) : [] };
}

/* ---------- Tata letak beranda ----------
   Bagian bawaan hanya bisa diurutkan & disembunyikan; bagian kustom dibuat admin (judul, teks, kartu, media). */
const LAYOUT_BUILTIN = ['beranda', 'prodi', 'voucher', 'statistik', 'alur'];
const MAX_CUSTOM_SECTIONS = 10;
function parseLayout(s) {
  let raw = [];
  try { raw = JSON.parse(s.layout || '[]'); } catch (e) { raw = []; }
  if (!Array.isArray(raw)) raw = [];
  const seen = new Set(), out = [];
  raw.forEach(x => {
    if (!x || typeof x.id !== 'string' || seen.has(x.id)) return;
    if (LAYOUT_BUILTIN.includes(x.id)) { seen.add(x.id); out.push({ id: x.id, aktif: x.aktif !== false }); }
    else if (x.tipe === 'kustom' && /^k[a-z]{2,19}$/.test(x.id)) { seen.add(x.id); out.push(x); }
  });
  LAYOUT_BUILTIN.forEach(id => { if (!seen.has(id)) out.push({ id, aktif: true }); });
  return out;
}
/** Id bagian yang bisa dituju menu: bawaan beranda + kustom + footer kontak. */
const layoutSections = layout => SECTIONS.concat(layout.filter(x => x.tipe === 'kustom').map(x => x.id));
/** Bagian beranda yang disembunyikan (untuk menyaring menu publik). */
const hiddenSections = layout => layout.filter(x => !x.aktif).map(x => x.id);
function cleanItems(raw, max, what) {
  raw = Array.isArray(raw) ? raw : [];
  if (raw.length > max) throw new UserError(`Maksimal ${max} kartu per ${what}.`);
  return raw.map((it, i) => {
    it = it || {};
    const x = {
      judul: U.clean(it.judul, 120), label: U.clean(it.label, 40), deskripsi: U.cleanText(it.deskripsi, 1000),
      poin: lines(it.poin).slice(0, 20).map(l => U.cleanText(l, 200)).join('\n'),
      tombolLabel: U.clean(it.tombolLabel, 40), tombolUrl: U.clean(it.tombolUrl, 300)
    };
    if (!x.judul) throw new UserError(`Kartu ke-${i + 1}: judul wajib diisi.`);
    if (x.tombolUrl && !isLink(x.tombolUrl)) throw new UserError(`Kartu "${x.judul}": URL tombol harus diawali https://`);
    if (x.tombolLabel && !x.tombolUrl) throw new UserError(`Kartu "${x.judul}": isi URL tombol.`);
    return x;
  });
}

const MENU_TYPES = ['section', 'klaim', 'kip', 'page', 'url', 'group'];
/** Ratakan menu + sub menu menjadi satu daftar (untuk pengecekan halaman yang dipakai). */
const flatMenu = menu => menu.reduce((a, m) => a.concat([m], Array.isArray(m.children) ? m.children : []), []);
/** Menu publik: hanya yang aktif, termasuk sub menu; grup tanpa sub menu aktif disembunyikan. */
const publicMenu = menu => menu.filter(m => m.aktif)
  .map(m => Object.assign({}, m, { children: (m.children || []).filter(c => c.aktif) }))
  .filter(m => m.type !== 'group' || m.children.length);
const SECTIONS = ['beranda', 'prodi', 'voucher', 'statistik', 'alur', 'kontak'];
const RESERVED_SLUGS = ['admin', 'klaim', 'api', 'assets', 'health'];
const isLink = u => /^https?:\/\/\S+$/i.test(u) || /^[?#]\S*$/.test(u);

/** Contoh isi halaman Jalur Masuk. Ganti dengan informasi resmi lewat panel admin. */
const JALUR_MASUK_SAMPLE = {
  slug: 'jalur-masuk',
  judul: 'Jalur Masuk',
  subjudul: 'Pilih jalur pendaftaran yang sesuai dengan kondisi dan prestasimu.',
  konten: 'Informasi di halaman ini adalah contoh. Silakan sesuaikan nama jalur, persyaratan, jadwal, dan biaya melalui menu Halaman di panel admin.',
  items: [
    { judul: 'Jalur Reguler', label: 'Umum', deskripsi: 'Seleksi berdasarkan berkas dan nilai rapor untuk lulusan SMA/SMK/MA sederajat.',
      poin: 'Lulusan SMA/SMK/MA sederajat\nScan rapor semester 1-5\nPas foto terbaru\nScan KTP/Kartu Keluarga', tombolLabel: 'Daftar Sekarang', tombolUrl: 'https://join.poltektedc.ac.id' },
    { judul: 'Jalur Prestasi', label: 'Prestasi', deskripsi: 'Untuk calon mahasiswa yang memiliki prestasi akademik maupun non-akademik.',
      poin: 'Sertifikat/piagam prestasi\nScan rapor semester 1-5\nSurat rekomendasi sekolah (jika ada)', tombolLabel: 'Daftar Sekarang', tombolUrl: 'https://join.poltektedc.ac.id' },
    { judul: 'Jalur Beasiswa KIP Kuliah', label: 'Beasiswa', deskripsi: 'Bantuan biaya pendidikan dari pemerintah bagi calon mahasiswa dari keluarga kurang mampu.',
      poin: 'Memiliki KIP/PKH/KKS atau terdaftar DTKS (diutamakan)\nLulusan maksimal 3 tahun terakhir\nMengisi formulir peminatan KIP-K', tombolLabel: 'Isi Peminatan KIP-K', tombolUrl: '?page=klaim&tab=kip' },
    { judul: 'Jalur Kelas Karyawan', label: 'Kuliah sambil kerja', deskripsi: 'Program perkuliahan untuk calon mahasiswa yang sudah bekerja.',
      poin: 'Surat keterangan bekerja\nIjazah dan transkrip terakhir\nScan KTP', tombolLabel: 'Daftar Sekarang', tombolUrl: 'https://join.poltektedc.ac.id' }
  ]
};

/* ============================================================
 *  INIT / SEED
 * ============================================================ */
function init() {
  const today = U.fmtDate();
  const defaults = Object.assign({}, SETTING_DEFAULTS, {
    klaimMulai: today,
    klaimSelesai: U.addDays(today, 30),
    masaBerlakuTanggal: U.addDays(today, 90)
  });
  const ins = D.db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  Object.entries(defaults).forEach(([k, v]) => ins.run(k, v));

  if (D.get('SELECT COUNT(*) AS n FROM prodi').n === 0) {
    const p = D.db.prepare('INSERT INTO prodi(id, nama, jenjang, deskripsi, aktif, urutan) VALUES (?, ?, ?, ?, 1, ?)');
    [
      ['P01', 'Teknik Mesin', 'D3', 'Perancangan, manufaktur, dan perawatan mesin industri.'],
      ['P02', 'Teknik Otomotif', 'D3', 'Teknologi kendaraan, diagnosis, dan servis otomotif modern.'],
      ['P03', 'Teknik Elektronika', 'D3', 'Sistem elektronika, kontrol, dan instrumentasi.'],
      ['P04', 'Teknik Informatika', 'D3', 'Pengembangan perangkat lunak, jaringan, dan basis data.'],
      ['P05', 'Komputerisasi Akuntansi', 'D3', 'Akuntansi berbasis sistem informasi dan teknologi.']
    ].forEach((r, i) => p.run(r[0], r[1], r[2], r[3], i + 1));
  }

  if (D.get('SELECT COUNT(*) AS n FROM halaman').n === 0) {
    const j = JALUR_MASUK_SAMPLE;
    D.run('INSERT INTO halaman(id, slug, judul, subjudul, konten, items, aktif, updated) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      'H01', j.slug, j.judul, j.subjudul, j.konten, JSON.stringify(j.items), U.fmtDateTime());
  }

  if (!D.get('SELECT id FROM admin WHERE id = 1')) {
    setAdminCredential(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PASSWORD || 'admin123');
    console.log('[setup] Akun admin dibuat. Segera ganti password lewat menu Akun Admin.');
  }
  D.run('DELETE FROM sessions WHERE expires < ?', Date.now());
}

function setAdminCredential(user, pass) {
  const { salt, hash } = U.hashPassword(pass);
  D.run(`INSERT INTO admin(id, username, salt, hash) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, salt = excluded.salt, hash = excluded.hash`, user, salt, hash);
  D.run('DELETE FROM sessions');
}

/* ============================================================
 *  MAPPERS
 * ============================================================ */
/** Field profil prodi: [nama, panjang maksimum, jenis] */
const PROFIL_FIELDS = [
  ['akreditasi', 60, 'short'], ['gelar', 60, 'short'], ['lamaStudi', 60, 'short'], ['fotoUrl', 300, 'url'],
  ['tentang', 5000, 'text'], ['visi', 1000, 'text'], ['misi', 3000, 'text'],
  ['keunggulan', 3000, 'text'], ['karier', 3000, 'text']
];
function parseProfil(v) {
  let o = {};
  try { o = JSON.parse(v || '{}') || {}; } catch (e) { o = {}; }
  const out = {};
  PROFIL_FIELDS.forEach(([k]) => { out[k] = typeof o[k] === 'string' ? o[k] : ''; });
  return out;
}
function cleanProfil(o) {
  o = o || {};
  const out = {};
  PROFIL_FIELDS.forEach(([k, max, kind]) => {
    const v = kind === 'text' ? U.cleanText(o[k], max) : U.clean(o[k], max);
    if (kind === 'url' && v && !/^(https?:\/\/\S+|\/\S*)$/i.test(v)) throw new UserError('URL foto harus diawali https:// atau /');
    out[k] = v;
  });
  return out;
}
const mapProdi = r => ({ id: r.id, nama: r.nama, jenjang: r.jenjang, deskripsi: r.deskripsi, aktif: r.aktif ? 'true' : 'false', urutan: String(r.urutan), profil: parseProfil(r.profil) });
const mapPendaftar = r => ({
  id: r.id, timestamp: r.timestamp, nama: r.nama, email: r.email, whatsapp: r.whatsapp,
  sekolah: r.sekolah, sumberInfo: r.sumber_info, prodiId: r.prodi_id, prodi: r.prodi,
  prodiList: r.prodi ? r.prodi.split('; ') : [], kode: r.kode,
  nominal: String(r.nominal), berlaku: r.berlaku, emailStatus: r.email_status, status: r.status, catatan: r.catatan
});
const mapKip = r => ({
  id: r.id, timestamp: r.timestamp, nama: r.nama, nisn: r.nisn, email: r.email, whatsapp: r.whatsapp,
  sekolah: r.sekolah, tahunLulus: r.tahun_lulus, prodiId: r.prodi_id, prodi: r.prodi,
  prodiList: r.prodi ? r.prodi.split('; ') : [], dtsen: r.dtsen || '', pip: r.pip || '',
  alamat: r.alamat, penghasilan: r.penghasilan, tanggungan: r.tanggungan ? String(r.tanggungan) : '',
  kartu: r.kartu, keterangan: r.keterangan, status: r.status, catatan: r.catatan
});
const parseJsonList = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const mapHalaman = r => ({
  id: r.id, slug: r.slug, judul: r.judul, subjudul: r.subjudul, konten: r.konten,
  items: parseJsonList(r.items), media: parseJsonList(r.media),
  aktif: r.aktif ? 'true' : 'false', updated: r.updated
});

/* ---------- Media halaman: foto tunggal, carousel foto, video YouTube ---------- */
const MEDIA_TYPES = ['foto', 'carousel', 'youtube'];
const MEDIA_POS = ['atas', 'bawah'];
const isImgUrl = u => /^(https?:\/\/\S+|\/\S*)$/i.test(u);
/** Ambil ID video (11 karakter) dari berbagai bentuk link YouTube, atau ID langsung. */
function youtubeId(v) {
  v = String(v || '').trim();
  if (/^[\w-]{11}$/.test(v)) return v;
  const m = v.match(/^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:\S*&)?v=|embed\/|shorts\/|live\/|v\/)|youtube-nocookie\.com\/embed\/|youtu\.be\/)([\w-]{11})(?:[?&#/]\S*)?$/i);
  return m ? m[1] : '';
}
function cleanMedia(raw) {
  raw = Array.isArray(raw) ? raw : [];
  if (raw.length > 10) throw new UserError('Maksimal 10 blok media per halaman.');
  return raw.map((m, i) => {
    m = m || {};
    const tipe = MEDIA_TYPES.includes(m.tipe) ? m.tipe : '';
    const nm = `Media ke-${i + 1}`;
    if (!tipe) throw new UserError(`${nm}: jenis media tidak valid.`);
    const x = { tipe, posisi: MEDIA_POS.includes(m.posisi) ? m.posisi : 'atas', keterangan: U.clean(m.keterangan, 200), gambar: [], youtube: '' };
    if (tipe === 'youtube') {
      x.youtube = youtubeId(m.youtube);
      if (!x.youtube) throw new UserError(`${nm}: link YouTube tidak dikenali. Contoh: https://www.youtube.com/watch?v=xxxxxxxxxxx`);
    } else {
      const list = (Array.isArray(m.gambar) ? m.gambar : lines(m.gambar)).map(u => U.clean(u, 300)).filter(Boolean);
      const bad = list.find(u => !isImgUrl(u));
      if (bad) throw new UserError(`${nm}: URL foto harus diawali https:// atau / (${bad.slice(0, 60)}).`);
      if (!list.length) throw new UserError(`${nm}: tambahkan minimal satu foto.`);
      if (tipe === 'foto' && list.length > 1) throw new UserError(`${nm}: foto tunggal hanya boleh satu gambar. Pilih jenis Carousel untuk beberapa foto.`);
      if (list.length > 15) throw new UserError(`${nm}: maksimal 15 foto per carousel.`);
      x.gambar = list;
    }
    return x;
  });
}
function parseMenu(s) {
  try { const m = JSON.parse(s.menu); if (Array.isArray(m)) return m; } catch (e) { /* abaikan */ }
  return JSON.parse(SETTING_DEFAULTS.menu);
}
const prodiLabel = p => (p.jenjang ? p.jenjang + ' ' : '') + p.nama;
function kipWindow(s) {
  return s.kipAktif === 'true'
    ? { open: true, reason: '' }
    : { open: false, reason: 'Pendataan peminatan KIP Kuliah sedang ditutup.' };
}

function getSettings() {
  const o = Object.assign({}, SETTING_DEFAULTS);
  D.all('SELECT key, value FROM settings').forEach(r => { o[r.key] = r.value; });
  return o;
}
const allProdi = () => D.all('SELECT * FROM prodi ORDER BY urutan, nama').map(mapProdi);
const activeProdi = () => D.all('SELECT * FROM prodi WHERE aktif = 1 ORDER BY urutan, nama').map(mapProdi);
const countPendaftar = () => D.get('SELECT COUNT(*) AS n FROM pendaftar').n;
const findPendaftar = id => { const r = D.get('SELECT * FROM pendaftar WHERE id = ?', String(id)); return r ? mapPendaftar(r) : null; };

/* ============================================================
 *  LOGIKA VOUCHER
 * ============================================================ */
function klaimWindow(s, total) {
  const today = U.fmtDate();
  const kuota = U.toInt(s.voucherKuota);
  let open = s.voucherAktif === 'true';
  let reason = '';
  if (!open) reason = 'Program voucher sedang tidak aktif.';
  else if (s.klaimMulai && today < s.klaimMulai) { open = false; reason = 'Klaim voucher dibuka mulai ' + U.fmtTanggal(s.klaimMulai) + '.'; }
  else if (s.klaimSelesai && today > s.klaimSelesai) { open = false; reason = 'Periode klaim voucher telah berakhir.'; }
  else if (kuota > 0 && total >= kuota) { open = false; reason = 'Kuota voucher sudah habis.'; }
  return { open, reason, kuota, sisaKuota: kuota > 0 ? Math.max(0, kuota - total) : null };
}

function berlakuHingga(s) {
  if (s.masaBerlakuMode === 'hari') return U.addDays(U.fmtDate(), U.toInt(s.masaBerlakuHari) || 30);
  return s.masaBerlakuTanggal || U.addDays(U.fmtDate(), 30);
}

function publicSettings(s) {
  const keys = ['namaKampus', 'tagline', 'tahunAkademik', 'deskripsi', 'kontakWa', 'kontakEmail', 'alamat', 'logoUrl',
    'voucherAktif', 'voucherNominal', 'klaimMulai', 'klaimSelesai', 'masaBerlakuMode', 'masaBerlakuTanggal',
    'masaBerlakuHari', 'voucherKeterangan', 'heroJudul', 'ctaLabel', 'ctaUrl'];
  const o = {};
  keys.forEach(k => { o[k] = s[k]; });
  o.heroLencana = heroLencana(s).filter(x => x.aktif);
  o.heroTombol = heroTombol(s).filter(x => x.aktif);
  o.heroPita = heroPita(s);
  return o;
}

/* ============================================================
 *  API PUBLIK
 * ============================================================ */
function getPublicData(slug, prodiId) {
  const s = getSettings();
  const prodi = activeProdi();
  const total = countPendaftar();
  let page = null;
  if (slug) {
    const r = D.get('SELECT * FROM halaman WHERE slug = ? AND aktif = 1', String(slug));
    page = r ? mapHalaman(r) : null;
  }
  const prodiDetail = prodiId ? (prodi.find(p => p.id === String(prodiId)) || null) : null;
  const layout = parseLayout(s), hidden = hiddenSections(layout);
  // menu yang menunjuk bagian beranda yang disembunyikan ikut disembunyikan
  const menu = publicMenu(parseMenu(s).map(m => Object.assign({}, m, {
    aktif: m.aktif && !(m.type === 'section' && hidden.includes(m.value)),
    children: (m.children || []).map(c => Object.assign({}, c, { aktif: c.aktif && !(c.type === 'section' && hidden.includes(c.value)) }))
  })));
  return {
    prodiDetail,
    menu,
    layout: layout.filter(x => x.aktif),
    page,
    settings: publicSettings(s),
    prodi: prodi.map(p => ({ id: p.id, nama: p.nama, jenjang: p.jenjang, deskripsi: p.deskripsi })),
    stats: { pendaftar: total, prodi: prodi.length },
    window: klaimWindow(s, total),
    sumberInfo: lines(s.sumberInfo),
    kip: {
      window: kipWindow(s),
      keterangan: s.kipKeterangan,
      tahunLulus: tahunLulusList(s.tahunAkademik),
      dtsen: DTSEN_LIST,
      dtsenPip: DTSEN_PIP,
      pip: PIP_LIST,
      kartu: KARTU_LIST
    },
    today: U.fmtDate()
  };
}

async function submitClaim(form) {
  form = form || {};
  if (form.website) return { ok: true, kode: '-', emailSent: false }; // honeypot anti-bot

  const data = {
    nama: U.clean(form.nama, 100),
    email: U.clean(form.email, 120).toLowerCase(),
    whatsapp: U.normWa(form.whatsapp),
    sekolah: U.clean(form.sekolah, 120),
    sumberInfo: U.clean(form.sumberInfo, 120)
  };
  const prodiIds = [...new Set((Array.isArray(form.prodiIds) ? form.prodiIds : []).map(x => U.clean(x, 40)).filter(Boolean))].slice(0, 20);
  if (data.nama.length < 3) throw new UserError('Nama lengkap wajib diisi.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) throw new UserError('Format email tidak valid.');
  if (data.whatsapp.length < 10 || data.whatsapp.length > 15) throw new UserError('Nomor WhatsApp tidak valid.');
  if (!data.sekolah) throw new UserError('Asal sekolah wajib diisi.');
  if (!prodiIds.length) throw new UserError('Pilih minimal satu program studi peminatan.');
  if (!data.sumberInfo) throw new UserError('Pilih dari mana kamu mendapat informasi klaim voucher.');

  const s = getSettings();
  if (!lines(s.sumberInfo).includes(data.sumberInfo)) throw new UserError('Pilihan sumber informasi tidak valid.');
  const rec = D.tx(() => {
    const win = klaimWindow(s, countPendaftar());
    if (!win.open) throw new UserError(win.reason);

    const aktif = activeProdi();
    const chosen = prodiIds.map(id => aktif.find(p => p.id === id));
    if (chosen.some(p => !p)) throw new UserError('Ada program studi yang tidak tersedia. Muat ulang halaman lalu pilih kembali.');
    if (D.get('SELECT 1 AS x FROM pendaftar WHERE email = ?', data.email)) {
      throw new UserError('Email ini sudah pernah mengklaim voucher. Periksa kotak masuk atau folder spam email kamu.');
    }
    let kode;
    do { kode = U.genCode(s.voucherPrefix); } while (D.get('SELECT 1 AS x FROM pendaftar WHERE kode = ?', kode));

    const r = Object.assign({}, data, {
      id: crypto.randomBytes(5).toString('hex').toUpperCase(),
      timestamp: U.fmtDateTime(),
      prodiId: chosen.map(p => p.id).join(','),
      prodi: chosen.map(prodiLabel).join('; '),
      kode,
      nominal: U.toInt(s.voucherNominal),
      berlaku: berlakuHingga(s),
      status: 'Baru'
    });
    D.run(`INSERT INTO pendaftar(id, timestamp, nama, email, whatsapp, sekolah, kota, sumber_info, prodi_id, prodi, kode, nominal, berlaku, email_status, status, catatan)
           VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'Mengirim', 'Baru', '')`,
      r.id, r.timestamp, r.nama, r.email, r.whatsapp, r.sekolah, r.sumberInfo, r.prodiId, r.prodi, r.kode, r.nominal, r.berlaku);
    return r;
  });

  const sent = await mailer.sendVoucher(rec, s);
  D.run('UPDATE pendaftar SET email_status = ? WHERE id = ?', sent.status, rec.id);

  return {
    ok: true, nama: rec.nama, email: rec.email, kode: rec.kode, nominal: String(rec.nominal),
    berlaku: rec.berlaku, prodi: rec.prodi, emailSent: sent.ok
  };
}

function submitKip(form) {
  form = form || {};
  if (form.website) return { ok: true }; // honeypot anti-bot
  const s = getSettings();
  const win = kipWindow(s);
  if (!win.open) throw new UserError(win.reason);

  const data = {
    nama: U.clean(form.nama, 100),
    email: U.clean(form.email, 120).toLowerCase(),
    whatsapp: U.normWa(form.whatsapp),
    sekolah: U.clean(form.sekolah, 120),
    tahunLulus: U.clean(form.tahunLulus, 4),
    dtsen: U.clean(form.dtsen, 20),
    pip: U.clean(form.pip, 40),
    keterangan: U.clean(form.keterangan, 1000)
  };
  const prodiIds = [...new Set((Array.isArray(form.prodiIds) ? form.prodiIds : []).map(x => U.clean(x, 40)).filter(Boolean))].slice(0, 20);
  let kartu = [...new Set((Array.isArray(form.kartu) ? form.kartu : []).map(x => U.clean(x, 40)))].filter(k => KARTU_LIST.includes(k));
  if (kartu.includes('Tidak Ada')) kartu = ['Tidak Ada'];

  if (data.nama.length < 3) throw new UserError('Nama lengkap wajib diisi.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) throw new UserError('Format email tidak valid.');
  if (data.whatsapp.length < 10 || data.whatsapp.length > 15) throw new UserError('Nomor WhatsApp tidak valid.');
  if (!data.sekolah) throw new UserError('Asal sekolah wajib diisi.');
  if (!tahunLulusList(s.tahunAkademik).includes(data.tahunLulus)) throw new UserError('Pilih tahun lulus.');
  if (!prodiIds.length) throw new UserError('Pilih minimal satu program studi peminatan.');
  if (!DTSEN_LIST.includes(data.dtsen)) throw new UserError('Pilih status DTSEN (desil).');
  if (DTSEN_PIP.includes(data.dtsen)) {
    if (!PIP_LIST.includes(data.pip)) throw new UserError('Pilih status penerima PIP.');
  } else data.pip = '';

  const aktif = activeProdi();
  const chosen = prodiIds.map(id => aktif.find(p => p.id === id));
  if (chosen.some(p => !p)) throw new UserError('Ada program studi yang tidak tersedia. Muat ulang halaman lalu pilih kembali.');
  const prodiId = chosen.map(p => p.id).join(','), prodi = chosen.map(prodiLabel).join('; ');

  return D.tx(() => {
    if (D.get('SELECT 1 AS x FROM kip WHERE email = ?', data.email)) {
      throw new UserError('Email ini sudah terdaftar sebagai peminat KIP Kuliah. Admin akan menghubungi kamu untuk verifikasi.');
    }
    const id = crypto.randomBytes(5).toString('hex').toUpperCase();
    D.run(`INSERT INTO kip(id, timestamp, nama, nisn, email, whatsapp, sekolah, tahun_lulus, prodi_id, prodi, alamat, penghasilan, tanggungan, kartu, keterangan, dtsen, pip, status, catatan)
           VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, '', '', 0, ?, ?, ?, ?, 'Baru', '')`,
      id, U.fmtDateTime(), data.nama, data.email, data.whatsapp, data.sekolah, data.tahunLulus,
      prodiId, prodi, kartu.join(', '), data.keterangan, data.dtsen, data.pip);
    return { ok: true, nama: data.nama, email: data.email, prodi, dtsen: data.dtsen, pip: data.pip };
  });
}

/* ============================================================
 *  AUTH
 * ============================================================ */
const loginFails = new Map(); // ip -> {count, until}

function adminLogin(username, password, ip) {
  const now = Date.now();
  const f = loginFails.get(ip) || { count: 0, until: 0 };
  if (f.until > now) throw new UserError('Terlalu banyak percobaan login. Coba lagi dalam 15 menit.', 429);

  const a = D.get('SELECT * FROM admin WHERE id = 1');
  const ok = a && String(username || '').trim() === a.username && U.verifyPassword(password, a.salt, a.hash);
  if (!ok) {
    f.count += 1;
    if (f.count >= 5) { f.until = now + 15 * 60 * 1000; f.count = 0; }
    loginFails.set(ip, f);
    throw new UserError('Username atau password salah.', 401);
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  D.run('INSERT INTO sessions(token, expires) VALUES (?, ?)', token, now + SESSION_TTL_MS);
  return { token, username: a.username };
}

function adminLogout(token) {
  if (token) D.run('DELETE FROM sessions WHERE token = ?', String(token));
  return true;
}

function requireAdmin(token) {
  const now = Date.now();
  const s = token && D.get('SELECT expires FROM sessions WHERE token = ?', String(token));
  if (!s || s.expires < now) throw new UserError('SESSION_EXPIRED', 401);
  D.run('UPDATE sessions SET expires = ? WHERE token = ?', now + SESSION_TTL_MS, String(token));
}

/* ============================================================
 *  API ADMIN
 * ============================================================ */
function adminGetData(token) {
  requireAdmin(token);
  const s = getSettings();
  const pendaftar = D.all('SELECT * FROM pendaftar ORDER BY timestamp DESC, rowid DESC').map(mapPendaftar);
  return {
    username: D.get('SELECT username FROM admin WHERE id = 1').username,
    settings: s,
    prodi: allProdi(),
    pendaftar,
    kip: D.all('SELECT * FROM kip ORDER BY timestamp DESC, rowid DESC').map(mapKip),
    halaman: D.all('SELECT * FROM halaman ORDER BY judul').map(mapHalaman),
    menu: parseMenu(s),
    layout: parseLayout(s),
    hero: { lencana: heroLencana(s), tombol: heroTombol(s), pita: heroPita(s) },
    sections: layoutSections(parseLayout(s)),
    statusList: STATUS_LIST,
    kipStatusList: KIP_STATUS_LIST,
    dtsenList: DTSEN_LIST,
    jenjangList: JENJANG_LIST,
    sumberList: lines(s.sumberInfo),
    window: klaimWindow(s, pendaftar.length),
    mailMode: mailer.mode(),
    today: U.fmtDate()
  };
}

function adminSaveSettings(token, obj) {
  requireAdmin(token);
  obj = obj || {};
  const out = {};
  Object.keys(obj).forEach(k => {
    if (!(k in SETTING_DEFAULTS) || ['menu', 'layout', 'heroLencana', 'heroTombol', 'heroPita'].includes(k)) return;
    out[k] = U.clean(obj[k], ['voucherKeterangan', 'deskripsi', 'kipKeterangan', 'sumberInfo'].includes(k) ? 1000 : 300);
  });
  if ('sumberInfo' in out) {
    const l = lines(out.sumberInfo).map(x => U.clean(x, 120)).filter(Boolean);
    if (!l.length) throw new UserError('Minimal harus ada satu pilihan sumber informasi.');
    out.sumberInfo = l.join('\n');
  }
  if ('kipAktif' in out) out.kipAktif = out.kipAktif === 'true' ? 'true' : 'false';

  ['klaimMulai', 'klaimSelesai', 'masaBerlakuTanggal'].forEach(k => {
    if (k in out && out[k] && !/^\d{4}-\d{2}-\d{2}$/.test(out[k])) throw new UserError('Format tanggal tidak valid: ' + k);
  });
  if ('voucherNominal' in out && !/^\d+$/.test(out.voucherNominal)) throw new UserError('Nominal voucher harus berupa angka.');
  if ('voucherKuota' in out) {
    if (!/^\d*$/.test(out.voucherKuota)) throw new UserError('Kuota harus berupa angka (0 = tanpa batas).');
    out.voucherKuota = out.voucherKuota || '0';
  }
  if ('masaBerlakuHari' in out && !/^\d+$/.test(out.masaBerlakuHari)) throw new UserError('Masa berlaku (hari) harus angka.');
  if ('masaBerlakuMode' in out && !['tanggal', 'hari'].includes(out.masaBerlakuMode)) out.masaBerlakuMode = 'tanggal';
  if ('voucherAktif' in out) out.voucherAktif = out.voucherAktif === 'true' ? 'true' : 'false';
  if ('voucherPrefix' in out) out.voucherPrefix = out.voucherPrefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'PMB';
  if ('kontakWa' in out) out.kontakWa = out.kontakWa ? U.normWa(out.kontakWa) : '';
  if ('logoUrl' in out && out.logoUrl && !/^(https?:\/\/|\/)/i.test(out.logoUrl)) throw new UserError('URL logo harus diawali http(s):// atau /');

  const merged = Object.assign(getSettings(), out);
  if (merged.klaimMulai && merged.klaimSelesai && merged.klaimMulai > merged.klaimSelesai) {
    throw new UserError('Tanggal mulai klaim tidak boleh setelah tanggal selesai.');
  }
  const up = D.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  D.tx(() => Object.entries(out).forEach(([k, v]) => up.run(k, String(v))));
  return getSettings();
}

function adminSaveProdi(token, p) {
  requireAdmin(token);
  p = p || {};
  const rec = {
    id: U.clean(p.id, 40),
    nama: U.clean(p.nama, 120),
    jenjang: U.clean(p.jenjang, 20),
    deskripsi: U.clean(p.deskripsi, 500),
    aktif: String(p.aktif) === 'false' ? 0 : 1,
    urutan: U.toInt(p.urutan),
    profil: JSON.stringify(cleanProfil(p.profil))
  };
  if (!rec.nama) throw new UserError('Nama program studi wajib diisi.');
  if (rec.id) {
    const r = D.run('UPDATE prodi SET nama = ?, jenjang = ?, deskripsi = ?, aktif = ?, urutan = ?, profil = ? WHERE id = ?',
      rec.nama, rec.jenjang, rec.deskripsi, rec.aktif, rec.urutan, rec.profil, rec.id);
    if (!r.changes) throw new UserError('Program studi tidak ditemukan.', 404);
  } else {
    rec.id = 'P' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(1).toString('hex').toUpperCase();
    if (!rec.urutan) rec.urutan = D.get('SELECT COUNT(*) AS n FROM prodi').n + 1;
    D.run('INSERT INTO prodi(id, nama, jenjang, deskripsi, aktif, urutan, profil) VALUES (?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.nama, rec.jenjang, rec.deskripsi, rec.aktif, rec.urutan, rec.profil);
  }
  return allProdi();
}

function adminDeleteProdi(token, id) {
  requireAdmin(token);
  const r = D.run('DELETE FROM prodi WHERE id = ?', String(id));
  if (!r.changes) throw new UserError('Program studi tidak ditemukan.', 404);
  return allProdi();
}

function adminUpdatePendaftar(token, id, patch) {
  requireAdmin(token);
  patch = patch || {};
  const cur = findPendaftar(id);
  if (!cur) throw new UserError('Data pendaftar tidak ditemukan.', 404);
  if ('status' in patch) {
    if (!STATUS_LIST.includes(patch.status)) throw new UserError('Status tidak valid.');
    cur.status = patch.status;
  }
  if ('catatan' in patch) cur.catatan = U.clean(patch.catatan, 1000);
  D.run('UPDATE pendaftar SET status = ?, catatan = ? WHERE id = ?', cur.status, cur.catatan, cur.id);
  return cur;
}

/** Simpan menu navigasi + tombol kanan atas + judul hero. */
function adminSaveMenu(token, o) {
  requireAdmin(token);
  o = o || {};
  const list = Array.isArray(o.menu) ? o.menu : [];
  if (list.length > 12) throw new UserError('Maksimal 12 menu.');
  const slugs = D.all('SELECT slug FROM halaman').map(r => r.slug);
  const sections = layoutSections(parseLayout(getSettings()));
  const item = (m, i, parent) => {
    const where = parent ? `Sub menu pada menu "${parent}"` : 'Menu';
    const it = {
      id: U.clean(m.id, 20) || 'm' + Date.now().toString(36) + (parent ? 's' : '') + i,
      label: U.clean(m.label, 40),
      type: MENU_TYPES.includes(m.type) && !(parent && m.type === 'group') ? m.type : '',
      value: U.clean(m.value, 300),
      aktif: m.aktif !== false && m.aktif !== 'false'
    };
    if (!it.label) throw new UserError(`${where} ke-${i + 1}: label wajib diisi.`);
    const nm = parent ? `Sub menu "${it.label}" pada menu "${parent}"` : `Menu "${it.label}"`;
    if (!it.type) throw new UserError(`${nm}: tujuan tidak valid${parent && m.type === 'group' ? ' (sub menu tidak bisa berupa Grup)' : ''}.`);
    if (it.type === 'section' && !sections.includes(it.value)) throw new UserError(`${nm}: pilih bagian beranda.`);
    if (it.type === 'page' && !slugs.includes(it.value)) throw new UserError(`${nm}: pilih halaman yang tersedia.`);
    if (it.type === 'url' && !isLink(it.value)) throw new UserError(`${nm}: URL harus diawali https://`);
    if (['klaim', 'kip', 'group'].includes(it.type)) it.value = '';
    return it;
  };
  const menu = list.map((m, i) => {
    const it = item(m, i, null);
    const kids = Array.isArray(m.children) ? m.children : [];
    if (kids.length > 10) throw new UserError(`Menu "${it.label}": maksimal 10 sub menu.`);
    it.children = kids.map((c, j) => item(c, j, it.label));
    if (it.type === 'group' && !it.children.length) throw new UserError(`Menu "${it.label}": tipe Grup harus punya minimal satu sub menu.`);
    return it;
  });
  const out = { menu: JSON.stringify(menu) };
  if ('ctaLabel' in o) { out.ctaLabel = U.clean(o.ctaLabel, 40); if (!out.ctaLabel) throw new UserError('Label tombol wajib diisi.'); }
  if ('ctaUrl' in o) { out.ctaUrl = U.clean(o.ctaUrl, 300); if (!isLink(out.ctaUrl)) throw new UserError('URL tombol harus diawali https://'); }
  if ('heroJudul' in o) { out.heroJudul = U.clean(o.heroJudul, 120); if (!out.heroJudul) throw new UserError('Judul hero wajib diisi.'); }
  const up = D.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  D.tx(() => Object.entries(out).forEach(([k, v]) => up.run(k, v)));
  return getSettings();
}

/** Simpan pengaturan hero beranda: judul, lencana (kiri logo), tombol (kanan logo), dan pita berjalan. */
function adminSaveHero(token, o) {
  requireAdmin(token);
  o = o || {};
  const judul = U.clean(o.heroJudul, 120);
  if (!judul) throw new UserError('Judul hero wajib diisi.');
  const aktifOf = x => !(x && (x.aktif === false || x.aktif === 'false'));

  const lencanaRaw = Array.isArray(o.lencana) ? o.lencana : [];
  if (lencanaRaw.length > HERO_MAX_SIMPAN) throw new UserError(`Maksimal ${HERO_MAX_SIMPAN} lencana tersimpan.`);
  const lencana = lencanaRaw.map((x, i) => {
    const it = { teks: U.clean(x && x.teks, 40), ket: U.clean(x && x.ket, 40), url: U.clean(x && x.url, 300), aktif: aktifOf(x) };
    if (!it.teks) throw new UserError(`Lencana ke-${i + 1}: teks utama wajib diisi.`);
    if (it.url && !isLink(it.url)) throw new UserError(`Lencana "${it.teks}": link harus diawali https:// atau ? (mis. ?page=p&slug=jalur-masuk).`);
    return it;
  });
  if (lencana.filter(x => x.aktif).length > HERO_MAX_LENCANA) throw new UserError(`Maksimal ${HERO_MAX_LENCANA} lencana yang ditampilkan. Sembunyikan sebagian.`);

  const tombolRaw = Array.isArray(o.tombol) ? o.tombol : [];
  if (tombolRaw.length > HERO_MAX_SIMPAN) throw new UserError(`Maksimal ${HERO_MAX_SIMPAN} tombol tersimpan.`);
  const tombol = tombolRaw.map((x, i) => {
    const it = { label: U.clean(x && x.label, 40), url: U.clean(x && x.url, 300), gaya: HERO_GAYA.includes(x && x.gaya) ? x.gaya : 'sekunder', aktif: aktifOf(x) };
    if (!it.label) throw new UserError(`Tombol ke-${i + 1}: label wajib diisi.`);
    if (!isLink(it.url)) throw new UserError(`Tombol "${it.label}": tujuan harus diawali https:// atau ? (mis. ?page=klaim).`);
    return it;
  });
  if (tombol.filter(x => x.aktif).length > HERO_MAX_TOMBOL) throw new UserError(`Maksimal ${HERO_MAX_TOMBOL} tombol yang ditampilkan. Sembunyikan sebagian.`);

  const p = o.pita || {};
  const teks = (Array.isArray(p.teks) ? p.teks : lines(p.teks)).map(t => U.clean(t, 60)).filter(Boolean);
  if (teks.length > HERO_MAX_PITA) throw new UserError(`Maksimal ${HERO_MAX_PITA} teks pita berjalan.`);
  const pita = { aktif: aktifOf(p), prodi: !(p.prodi === false || p.prodi === 'false'), teks };

  const out = { heroJudul: judul, heroLencana: JSON.stringify(lencana), heroTombol: JSON.stringify(tombol), heroPita: JSON.stringify(pita) };
  const up = D.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  D.tx(() => Object.entries(out).forEach(([k, v]) => up.run(k, v)));
  return getSettings();
}

/** Simpan tata letak beranda: urutan, tampil/sembunyi, dan isi bagian kustom. */
function adminSaveLayout(token, list) {
  requireAdmin(token);
  list = Array.isArray(list) ? list : [];
  const seen = new Set(), out = [];
  let custom = 0;
  list.forEach((x, i) => {
    x = x || {};
    const aktif = x.aktif !== false && x.aktif !== 'false';
    if (LAYOUT_BUILTIN.includes(x.id)) {
      if (seen.has(x.id)) return;
      seen.add(x.id); out.push({ id: x.id, aktif });
      return;
    }
    if (++custom > MAX_CUSTOM_SECTIONS) throw new UserError(`Maksimal ${MAX_CUSTOM_SECTIONS} bagian tambahan.`);
    let id = typeof x.id === 'string' && /^k[a-z]{2,19}$/.test(x.id) ? x.id : '';
    // id hanya huruf kecil agar bisa dipakai sebagai #anchor dan parameter ?s=
    while (!id || seen.has(id)) id = 'k' + Array.from(crypto.randomBytes(6), b => String.fromCharCode(97 + b % 26)).join('');
    const judul = U.clean(x.judul, 120);
    if (!judul) throw new UserError(`Bagian tambahan ke-${custom}: judul wajib diisi.`);
    const nm = `Bagian "${judul}"`;
    let items, media;
    try { items = cleanItems(x.items, 12, 'bagian'); media = cleanMedia(x.media); }
    catch (e) { if (e instanceof UserError) throw new UserError(`${nm}: ${e.message}`); throw e; }
    if (media.length > 5) throw new UserError(`${nm}: maksimal 5 blok media.`);
    seen.add(id);
    out.push({ id, tipe: 'kustom', aktif, label: U.clean(x.label, 40), judul, subjudul: U.clean(x.subjudul, 300), konten: U.cleanText(x.konten, 5000), items, media });
  });
  LAYOUT_BUILTIN.forEach(id => { if (!seen.has(id)) out.push({ id, aktif: true }); });

  // bagian kustom yang dihapus tidak boleh masih dipakai menu
  const s = getSettings(), before = parseLayout(s), ids = new Set(out.map(x => x.id));
  const removed = before.filter(x => x.tipe === 'kustom' && !ids.has(x.id));
  const used = flatMenu(parseMenu(s)).find(m => m.type === 'section' && removed.some(r => r.id === m.value));
  if (used) {
    const r = removed.find(x => x.id === used.value);
    throw new UserError(`Bagian "${r.judul}" masih dipakai menu "${used.label}". Ubah atau hapus menunya dulu di Menu & Navigasi.`);
  }
  D.run("INSERT INTO settings(key, value) VALUES ('layout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(out));
  return out;
}

function adminSaveHalaman(token, p) {
  requireAdmin(token);
  p = p || {};
  const rec = {
    id: U.clean(p.id, 20),
    slug: String(p.slug || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60),
    judul: U.clean(p.judul, 120),
    subjudul: U.clean(p.subjudul, 300),
    konten: U.cleanText(p.konten, 5000),
    aktif: String(p.aktif) === 'false' ? 0 : 1
  };
  if (!rec.judul) throw new UserError('Judul halaman wajib diisi.');
  if (rec.slug.length < 2) throw new UserError('Alamat (slug) halaman minimal 2 karakter, huruf kecil/angka/strip.');
  if (RESERVED_SLUGS.includes(rec.slug)) throw new UserError('Alamat halaman tersebut sudah dipakai sistem.');
  const items = cleanItems(p.items, 20, 'halaman');
  const media = JSON.stringify(cleanMedia(p.media));
  const dup = D.get('SELECT id FROM halaman WHERE slug = ?', rec.slug);
  if (dup && dup.id !== rec.id) throw new UserError('Alamat halaman sudah dipakai halaman lain.');

  const now = U.fmtDateTime();
  if (rec.id) {
    const old = D.get('SELECT slug FROM halaman WHERE id = ?', rec.id);
    if (!old) throw new UserError('Halaman tidak ditemukan.', 404);
    D.tx(() => {
      D.run('UPDATE halaman SET slug = ?, judul = ?, subjudul = ?, konten = ?, items = ?, media = ?, aktif = ?, updated = ? WHERE id = ?',
        rec.slug, rec.judul, rec.subjudul, rec.konten, JSON.stringify(items), media, rec.aktif, now, rec.id);
      if (old.slug !== rec.slug) { // ikutkan perubahan slug ke menu
        const s = getSettings();
        const menu = parseMenu(s);
        flatMenu(menu).forEach(m => { if (m.type === 'page' && m.value === old.slug) m.value = rec.slug; });
        D.run("UPDATE settings SET value = ? WHERE key = 'menu'", JSON.stringify(menu));
      }
    });
  } else {
    rec.id = 'H' + Date.now().toString(36).toUpperCase();
    D.run('INSERT INTO halaman(id, slug, judul, subjudul, konten, items, media, aktif, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rec.id, rec.slug, rec.judul, rec.subjudul, rec.konten, JSON.stringify(items), media, rec.aktif, now);
  }
  return D.all('SELECT * FROM halaman ORDER BY judul').map(mapHalaman);
}

function adminDeleteHalaman(token, id) {
  requireAdmin(token);
  const r = D.get('SELECT slug FROM halaman WHERE id = ?', String(id));
  if (!r) throw new UserError('Halaman tidak ditemukan.', 404);
  if (flatMenu(parseMenu(getSettings())).some(m => m.type === 'page' && m.value === r.slug)) {
    throw new UserError('Halaman ini masih dipakai di menu navigasi. Hapus atau ubah menunya terlebih dulu.');
  }
  D.run('DELETE FROM halaman WHERE id = ?', String(id));
  return D.all('SELECT * FROM halaman ORDER BY judul').map(mapHalaman);
}

function adminUpdateKip(token, id, patch) {
  requireAdmin(token);
  patch = patch || {};
  const r = D.get('SELECT * FROM kip WHERE id = ?', String(id));
  if (!r) throw new UserError('Data peminat KIP-K tidak ditemukan.', 404);
  const cur = mapKip(r);
  if ('status' in patch) {
    if (!KIP_STATUS_LIST.includes(patch.status)) throw new UserError('Status tidak valid.');
    cur.status = patch.status;
  }
  if ('catatan' in patch) cur.catatan = U.clean(patch.catatan, 1000);
  D.run('UPDATE kip SET status = ?, catatan = ? WHERE id = ?', cur.status, cur.catatan, cur.id);
  return cur;
}

function adminDeleteKip(token, id) {
  requireAdmin(token);
  const r = D.run('DELETE FROM kip WHERE id = ?', String(id));
  if (!r.changes) throw new UserError('Data peminat KIP-K tidak ditemukan.', 404);
  return true;
}

function adminDeletePendaftar(token, id) {
  requireAdmin(token);
  const r = D.run('DELETE FROM pendaftar WHERE id = ?', String(id));
  if (!r.changes) throw new UserError('Data pendaftar tidak ditemukan.', 404);
  return true;
}

async function adminResendVoucher(token, id) {
  requireAdmin(token);
  const rec = findPendaftar(id);
  if (!rec) throw new UserError('Data pendaftar tidak ditemukan.', 404);
  const sent = await mailer.sendVoucher(rec, getSettings());
  D.run('UPDATE pendaftar SET email_status = ? WHERE id = ?', sent.status, rec.id);
  if (!sent.ok) throw new UserError('Email gagal dikirim: ' + sent.error, 502);
  rec.emailStatus = sent.status;
  return rec;
}

/* ---------- Email ---------- */
function pendingEmailRows() {
  return D.all("SELECT * FROM pendaftar WHERE email_status <> 'Terkirim' ORDER BY timestamp").map(mapPendaftar);
}

async function adminEmailInfo(token, recheck) {
  requireAdmin(token);
  if (recheck) await mailer.verify();
  return Object.assign(mailer.info(), { pending: pendingEmailRows().length });
}

async function adminTestEmail(token, to) {
  requireAdmin(token);
  to = U.clean(to, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new UserError('Alamat email tujuan tidak valid.');
  try { await mailer.sendTest(to, getSettings()); }
  catch (e) { throw new UserError('Email uji gagal: ' + e.message, 502); }
  return { ok: true, mode: mailer.mode(), to };
}

/** Simpan konfigurasi SMTP dari halaman admin, lalu uji koneksi. */
async function adminSaveSmtp(token, c) {
  requireAdmin(token);
  c = c || {};
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const cfg = {
    enabled: c.enabled === true || c.enabled === 'true',
    host: String(c.host || '').trim().toLowerCase().slice(0, 120),
    port: parseInt(c.port, 10),
    secure: c.secure === true || c.secure === 'true',
    user: U.clean(c.user, 120),
    pass: typeof c.pass === 'string' ? c.pass.replace(/\s+/g, '').slice(0, 200) : '',
    clearPass: c.clearPass === true,
    from: U.clean(c.from, 120).toLowerCase(),
    fromName: U.clean(c.fromName, 80).replace(/["<>]/g, '')
  };
  if (cfg.enabled || cfg.host) {
    if (!/^[a-z0-9.-]{3,120}$/.test(cfg.host) || !cfg.host.includes('.')) throw new UserError('Host SMTP tidak valid (contoh: smtp.gmail.com).');
    if (!(cfg.port >= 1 && cfg.port <= 65535)) throw new UserError('Port SMTP harus angka 1-65535.');
    if (cfg.user && cfg.user.length < 3) throw new UserError('Username SMTP tidak valid.');
    if (!cfg.from) cfg.from = emailRe.test(cfg.user) ? cfg.user.toLowerCase() : '';
    if (!emailRe.test(cfg.from)) throw new UserError('Email pengirim wajib diisi dengan alamat email yang valid.');
  } else {
    cfg.port = cfg.port || 465;
  }
  mailer.saveConfig(cfg);
  if (mailer.mode() === 'smtp') await mailer.verify();
  return Object.assign(mailer.info(), { pending: pendingEmailRows().length });
}

/** Kirim ulang voucher ke pendaftar yang emailnya belum berstatus Terkirim (maks. 50 per klik). */
async function adminResendPending(token) {
  requireAdmin(token);
  if (mailer.mode() !== 'smtp') throw new UserError('SMTP belum diatur. Isi Konfigurasi SMTP di halaman Pengaturan Email terlebih dulu.');
  const s = getSettings();
  const rows = pendingEmailRows();
  const batch = rows.slice(0, 50);
  let sent = 0, failed = 0, lastError = '';
  for (const rec of batch) {
    const r = await mailer.sendVoucher(rec, s);
    D.run('UPDATE pendaftar SET email_status = ? WHERE id = ?', r.status, rec.id);
    if (r.ok) sent++; else { failed++; lastError = r.error; }
    if (failed >= 3 && sent === 0) break; // kemungkinan konfigurasi salah, hentikan
  }
  return { sent, failed, remaining: pendingEmailRows().length, lastError };
}

function adminChangeCredential(token, oldPassword, newUsername, newPassword) {
  requireAdmin(token);
  const a = D.get('SELECT * FROM admin WHERE id = 1');
  if (!U.verifyPassword(oldPassword, a.salt, a.hash)) throw new UserError('Password lama salah.');
  const user = U.clean(newUsername, 40) || a.username;
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(user)) throw new UserError('Username 3-40 karakter: huruf, angka, titik, _ atau -.');
  const pass = String(newPassword || '');
  if (pass && pass.length < 8) throw new UserError('Password baru minimal 8 karakter.');
  if (pass) {
    setAdminCredential(user, pass);
    // pertahankan sesi yang sedang dipakai
    D.run('INSERT INTO sessions(token, expires) VALUES (?, ?)', String(token), Date.now() + SESSION_TTL_MS);
  } else {
    D.run('UPDATE admin SET username = ? WHERE id = 1', user);
  }
  return { username: user };
}

/* ---------- Unggah foto (untuk media halaman, disimpan di public/uploads) ---------- */
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
function imageExt(b) {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'gif';
  return '';
}
function adminUploadImage(token, buf) {
  requireAdmin(token);
  if (!Buffer.isBuffer(buf) || !buf.length) throw new UserError('File foto kosong.');
  const ext = imageExt(buf);
  if (!ext) throw new UserError('Format foto harus JPG, PNG, WEBP, atau GIF.');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: '/assets/uploads/' + name };
}

module.exports = {
  init, setAdminCredential, adminUploadImage,
  getPublicData, submitClaim, submitKip,
  adminLogin, adminLogout, adminGetData, adminSaveSettings, adminSaveProdi, adminDeleteProdi,
  adminUpdatePendaftar, adminDeletePendaftar, adminResendVoucher, adminChangeCredential,
  adminUpdateKip, adminDeleteKip, adminSaveMenu, adminSaveLayout, adminSaveHero, adminSaveHalaman, adminDeleteHalaman,
  adminEmailInfo, adminTestEmail, adminResendPending, adminSaveSmtp
};
