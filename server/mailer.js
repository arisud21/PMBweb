'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const D = require('./db');
const { esc, rupiah, fmtTanggal, fmtDateTime } = require('./util');

const OUTBOX = path.join(D.DATA_DIR, 'outbox');
const KEY_FILE = path.join(D.DATA_DIR, 'secret.key');
fs.mkdirSync(OUTBOX, { recursive: true });

/* ============================================================
 *  Enkripsi password SMTP (AES-256-GCM, kunci di data/secret.key)
 * ============================================================ */
function key() {
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(s) {
  const [v, iv, tag, ct] = String(s || '').split(':');
  if (v !== 'v1') throw new Error('format tidak dikenal');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/* ============================================================
 *  Sumber konfigurasi: halaman admin -> file .env -> outbox (uji)
 * ============================================================ */
function adminRow() {
  return D.get('SELECT * FROM mail_config WHERE id = 1') || null;
}
function envConfig() {
  if (!process.env.SMTP_HOST) return null;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return {
    source: 'env',
    host: process.env.SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    fromName: process.env.MAIL_FROM_NAME || ''
  };
}
let decryptError = '';
function activeConfig() {
  const r = adminRow();
  if (r && r.enabled && r.host) {
    let pass = '';
    decryptError = '';
    if (r.pass_enc) {
      try { pass = decrypt(r.pass_enc); }
      catch (e) { decryptError = 'Password SMTP tersimpan tidak bisa dibaca (file data/secret.key berubah/hilang). Isi ulang password di halaman admin.'; }
    }
    return { source: 'admin', host: r.host, port: r.port, secure: !!r.secure, user: r.username, pass, from: r.mail_from || r.username, fromName: r.from_name };
  }
  return envConfig();
}
function mode() { return activeConfig() ? 'smtp' : 'outbox'; }

const state = { ok: null, error: '', checkedAt: '', sig: '' };
let cache = { sig: '', transport: null };
function transportFor(cfg) {
  const sig = JSON.stringify([cfg.source, cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
  if (cache.sig !== sig) {
    if (cache.transport) try { cache.transport.close(); } catch (e) { /* abaikan */ }
    cache = {
      sig,
      transport: nodemailer.createTransport({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
      })
    };
  }
  if (state.sig !== sig) { state.ok = null; state.error = ''; state.checkedAt = ''; state.sig = sig; }
  return cache.transport;
}

/** Terjemahkan error SMTP umum menjadi petunjuk yang bisa ditindaklanjuti. */
function explain(e, cfg) {
  const msg = String((e && e.message) || e || '');
  const code = e && (e.responseCode || e.code);
  if (code === 535 || /535|Username and Password not accepted|Invalid login|BadCredentials|authentication failed/i.test(msg)) {
    return 'Login SMTP ditolak. Periksa username dan password. Untuk Google Workspace/Gmail wajib memakai App Password (bukan password biasa) dan Verifikasi 2 Langkah harus aktif.';
  }
  if (/534|Application-specific password required/i.test(msg)) return 'Google meminta App Password. Buat App Password untuk akun pengirim lalu isi sebagai password SMTP.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'Host SMTP tidak ditemukan (' + ((cfg && cfg.host) || '-') + '). Periksa nama host dan koneksi internet.';
  if (/wrong version number|ssl3_get_record|EPROTO/i.test(msg)) return 'Pengaturan keamanan tidak cocok dengan port. Gunakan SSL/TLS untuk port 465, STARTTLS untuk port 587.';
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|ECONNRESET|Greeting never received/i.test(msg)) return 'Tidak bisa terhubung ke server SMTP. Periksa port dan keamanan (465 = SSL/TLS, 587 = STARTTLS) atau firewall jaringan.';
  if (/553|550 5\.7|not allowed to send|sender address/i.test(msg)) return 'Alamat pengirim tidak diizinkan server. Samakan email pengirim dengan username SMTP atau daftarkan sebagai alias.';
  if (/Daily user sending limit|limit exceeded|421 4\.7/i.test(msg)) return 'Batas kirim harian akun pengirim tercapai. Coba lagi besok.';
  return msg.slice(0, 200);
}

async function verify() {
  const cfg = activeConfig();
  if (!cfg) { state.ok = null; state.error = ''; return state; }
  const t = transportFor(cfg);
  if (decryptError) { state.ok = false; state.error = decryptError; return state; }
  try {
    await t.verify();
    state.ok = true; state.error = '';
  } catch (e) {
    state.ok = false; state.error = explain(e, cfg);
  }
  state.checkedAt = new Date().toISOString();
  return state;
}

function info() {
  const cfg = activeConfig();
  if (cfg) transportFor(cfg); // sinkronkan status dengan konfigurasi terbaru
  const r = adminRow();
  const env = envConfig();
  return {
    mode: cfg ? 'smtp' : 'outbox',
    source: cfg ? cfg.source : 'none',
    host: cfg ? cfg.host : '',
    port: cfg ? cfg.port : null,
    secure: cfg ? cfg.secure : null,
    from: cfg ? cfg.from : '',
    fromName: cfg ? cfg.fromName : '',
    user: cfg ? cfg.user : '',
    passSet: cfg ? !!cfg.pass : false,
    ok: cfg ? state.ok : null,
    error: cfg ? (decryptError || state.error) : '',
    checkedAt: state.checkedAt,
    outbox: cfg ? '' : OUTBOX,
    envAvailable: !!env,
    envSummary: env ? { host: env.host, port: env.port, user: env.user, from: env.from } : null,
    admin: {
      enabled: !!(r && r.enabled),
      host: r ? r.host : '',
      port: r ? r.port : 465,
      secure: r ? !!r.secure : true,
      user: r ? r.username : '',
      passSet: !!(r && r.pass_enc),
      from: r ? r.mail_from : '',
      fromName: r ? r.from_name : '',
      updated: r ? r.updated : ''
    }
  };
}

/**
 * Simpan konfigurasi SMTP dari halaman admin.
 * pass: string baru; '' = pertahankan password lama. clearPass: true = hapus password.
 */
function saveConfig(c) {
  const r = adminRow();
  let passEnc = r ? r.pass_enc : '';
  if (c.clearPass) passEnc = '';
  else if (c.pass) passEnc = encrypt(c.pass);
  D.run(`INSERT INTO mail_config(id, enabled, host, port, secure, username, pass_enc, mail_from, from_name, updated)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, host = excluded.host, port = excluded.port,
           secure = excluded.secure, username = excluded.username, pass_enc = excluded.pass_enc,
           mail_from = excluded.mail_from, from_name = excluded.from_name, updated = excluded.updated`,
    c.enabled ? 1 : 0, c.host, c.port, c.secure ? 1 : 0, c.user, passEnc, c.from, c.fromName, fmtDateTime());
}

/* ============================================================
 *  Pengiriman
 * ============================================================ */
async function sendMail({ to, subject, html, text, fromName, replyTo }) {
  const cfg = activeConfig();
  if (cfg) {
    if (!cfg.from) throw new Error('Email pengirim belum diisi.');
    if (decryptError) throw new Error(decryptError);
    try {
      await transportFor(cfg).sendMail({
        from: { name: String(cfg.fromName || fromName || 'PMB').replace(/["<>\r\n]/g, ''), address: cfg.from },
        to, subject, html, text,
        replyTo: replyTo || undefined
      });
      state.ok = true; state.error = '';
    } catch (e) {
      const why = explain(e, cfg);
      state.ok = false; state.error = why;
      throw new Error(why);
    }
    return;
  }
  const file = path.join(OUTBOX, `${Date.now()}-${to.replace(/[^a-z0-9@._-]/gi, '_')}.html`);
  const head = `<!-- To: ${esc(to)}\n     Subject: ${esc(subject)} -->\n`;
  fs.writeFileSync(file, head + html, 'utf8');
  console.log(`[outbox] Email untuk ${to} disimpan: ${file}`);
}

function voucherEmail(rec, s) {
  const subject = String(s.emailSubjek || 'Voucher PMB {kampus} - {kode}')
    .replace(/\{kampus\}/g, s.namaKampus).replace(/\{kode\}/g, rec.kode).replace(/\{nama\}/g, rec.nama);
  const wa = s.kontakWa ? `<a href="https://wa.me/${esc(s.kontakWa)}" style="color:#1d4ed8">+${esc(s.kontakWa)}</a>` : '';
  const row = (k, v) => `<tr><td style="padding:8px 0;color:#6b7590;border-bottom:1px solid #eef2fb;width:40%">${k}</td><td style="padding:8px 0;border-bottom:1px solid #eef2fb;text-align:right">${v}</td></tr>`;
  const html = `
<div style="margin:0;padding:32px 12px;background:#eef2fb;font-family:Segoe UI,Arial,sans-serif;color:#0f1a3a">
 <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e1e7f3">
  <div style="padding:28px 32px;background:#0f1a3a;color:#ffffff">
   <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#f8c51c;font-weight:700">${esc(s.tagline)} ${esc(s.tahunAkademik)}</div>
   <div style="font-size:22px;font-weight:800;margin-top:6px">${esc(s.namaKampus)}</div>
  </div>
  <div style="height:6px;background:linear-gradient(90deg,#e0322b,#ffc107,#1fa3a8,#22a64a)"></div>
  <div style="padding:28px 32px">
   <p style="margin:0 0 14px;font-size:15px">Halo <b>${esc(rec.nama)}</b>,</p>
   <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#3b4565">Terima kasih sudah mengklaim voucher PMB. Berikut voucher kamu:</p>
   <div style="border:2px dashed #7c3aed;border-radius:16px;padding:22px;text-align:center;background:#f5f3ff">
    <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#6b7590;font-weight:700">Kode Voucher</div>
    <div style="font-size:30px;font-weight:800;letter-spacing:3px;margin:8px 0;color:#4338ca;font-family:Consolas,monospace">${esc(rec.kode)}</div>
    <div style="font-size:24px;font-weight:800;color:#0f1a3a">${rupiah(rec.nominal)}</div>
   </div>
   <table style="width:100%;margin-top:22px;font-size:14px;border-collapse:collapse">
    ${row('Program studi peminatan', String(rec.prodi).split('; ').map(esc).join('<br>'))}
    ${row('Berlaku hingga', '<b>' + esc(fmtTanggal(rec.berlaku)) + '</b>')}
    ${row('Email', esc(rec.email))}
   </table>
   <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#6b7590">${esc(s.voucherKeterangan)}</p>
   ${wa ? `<p style="margin:14px 0 0;font-size:13px;color:#6b7590">Butuh bantuan? Hubungi WhatsApp panitia PMB: ${wa}</p>` : ''}
  </div>
  <div style="padding:16px 32px;background:#f5f7fd;font-size:12px;color:#6b7590">${esc(s.namaKampus)}${s.alamat ? ' &middot; ' + esc(s.alamat) : ''}</div>
 </div>
</div>`;
  const text = `Halo ${rec.nama},\n\nKode voucher PMB kamu: ${rec.kode}\nNominal: ${rupiah(rec.nominal)}\n` +
    `Berlaku hingga: ${fmtTanggal(rec.berlaku)}\nProgram studi peminatan: ${rec.prodi}\n\n${s.voucherKeterangan}\n\n${s.namaKampus}`;
  return { subject, html, text };
}

/** Kirim voucher. Tidak pernah throw; mengembalikan {ok, status, error}. */
async function sendVoucher(rec, s) {
  try {
    const m = voucherEmail(rec, s);
    await sendMail({ to: rec.email, subject: m.subject, html: m.html, text: m.text, fromName: 'PMB ' + s.namaKampus, replyTo: s.kontakEmail });
    return { ok: true, status: mode() === 'smtp' ? 'Terkirim' : 'Outbox lokal' };
  } catch (e) {
    console.error('[mail] Gagal kirim ke', rec.email, '-', e.message);
    const full = String(e.message || e);
    return { ok: false, status: 'Gagal: ' + full.split('. ')[0].slice(0, 120), error: full.slice(0, 300) };
  }
}

/** Email uji untuk memastikan konfigurasi benar. Throw bila gagal. */
async function sendTest(to, s) {
  const cfg = activeConfig();
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;padding:24px;color:#0f1a3a">
    <h2 style="margin:0 0 10px">Email uji PMB berhasil</h2>
    <p style="margin:0 0 6px">Konfigurasi email untuk <b>${esc(s.namaKampus)}</b> sudah benar.</p>
    <p style="margin:0;color:#6b7590;font-size:13px">Pengirim: ${esc((cfg && cfg.from) || '-')} &middot; Server: ${esc((cfg && cfg.host) || 'outbox lokal')}</p></div>`;
  await sendMail({ to, subject: 'Email uji PMB ' + s.namaKampus, html, text: 'Email uji PMB berhasil. Konfigurasi email sudah benar.', fromName: 'PMB ' + s.namaKampus, replyTo: s.kontakEmail });
}

module.exports = { OUTBOX, mode, sendVoucher, sendTest, verify, info, saveConfig };
