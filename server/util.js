'use strict';
const crypto = require('crypto');

const TZ = 'Asia/Jakarta';
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function parts(d) {
  const o = {};
  partsFmt.formatToParts(d || new Date()).forEach(p => { o[p.type] = p.value; });
  return o;
}

/** yyyy-MM-dd (zona Asia/Jakarta) */
function fmtDate(d) { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; }
/** yyyy-MM-dd HH:mm:ss (zona Asia/Jakarta) */
function fmtDateTime(d) { const p = parts(d); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; }
/** Tambah N hari ke tanggal ISO yyyy-MM-dd */
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function fmtTanggal(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${parseInt(m[3], 10)} ${BULAN[parseInt(m[2], 10) - 1]} ${m[1]}` : (iso || '-');
}
function toInt(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function rupiah(n) { return 'Rp' + String(toInt(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

/** Bersihkan input: buang karakter kontrol & awalan formula spreadsheet (=,+,-,@). */
function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .replace(/^[=+\-@]+/, '')
    .slice(0, max || 200);
}

/** Bersihkan teks panjang (konten halaman): buang karakter kontrol saja, tanda "-" di awal tetap. */
function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max || 5000);
}

/** Normalisasi nomor WA ke format 62xxxxxxxxxx */
function normWa(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return d.slice(0, 15);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(prefix) {
  const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  return `${prefix || 'PMB'}-${part()}-${part()}`;
}

function hashPassword(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pass, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(String(pass || ''), salt, 64).toString('hex'), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class UserError extends Error {
  constructor(message, status) { super(message); this.status = status || 400; this.expose = true; }
}

module.exports = { TZ, fmtDate, fmtDateTime, addDays, fmtTanggal, toInt, rupiah, clean, cleanText, normWa, esc, genCode, hashPassword, verifyPassword, UserError };
