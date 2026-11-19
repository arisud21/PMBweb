'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'pmb.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS prodi (
    id        TEXT PRIMARY KEY,
    nama      TEXT NOT NULL,
    jenjang   TEXT NOT NULL DEFAULT '',
    deskripsi TEXT NOT NULL DEFAULT '',
    aktif     INTEGER NOT NULL DEFAULT 1,
    urutan    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pendaftar (
    id           TEXT PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    nama         TEXT NOT NULL,
    email        TEXT NOT NULL UNIQUE,
    whatsapp     TEXT NOT NULL,
    sekolah      TEXT NOT NULL,
    kota         TEXT NOT NULL DEFAULT '',
    sumber_info  TEXT NOT NULL DEFAULT '',
    prodi_id     TEXT NOT NULL,
    prodi        TEXT NOT NULL,
    kode         TEXT NOT NULL UNIQUE,
    nominal      INTEGER NOT NULL,
    berlaku      TEXT NOT NULL,
    email_status TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'Baru',
    catatan      TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_pendaftar_ts ON pendaftar(timestamp);

  CREATE TABLE IF NOT EXISTS kip (
    id          TEXT PRIMARY KEY,
    timestamp   TEXT NOT NULL,
    nama        TEXT NOT NULL,
    nisn        TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL UNIQUE,
    whatsapp    TEXT NOT NULL,
    sekolah     TEXT NOT NULL,
    tahun_lulus TEXT NOT NULL,
    prodi_id    TEXT NOT NULL,
    prodi       TEXT NOT NULL,
    alamat      TEXT NOT NULL,
    penghasilan TEXT NOT NULL,
    tanggungan  INTEGER NOT NULL,
    kartu       TEXT NOT NULL DEFAULT '',
    keterangan  TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'Baru',
    catatan     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_kip_ts ON kip(timestamp);

  CREATE TABLE IF NOT EXISTS halaman (
    id        TEXT PRIMARY KEY,
    slug      TEXT NOT NULL UNIQUE,
    judul     TEXT NOT NULL,
    subjudul  TEXT NOT NULL DEFAULT '',
    konten    TEXT NOT NULL DEFAULT '',
    items     TEXT NOT NULL DEFAULT '[]',
    aktif     INTEGER NOT NULL DEFAULT 1,
    updated   TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS mail_config (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    enabled    INTEGER NOT NULL DEFAULT 0,
    host       TEXT NOT NULL DEFAULT '',
    port       INTEGER NOT NULL DEFAULT 465,
    secure     INTEGER NOT NULL DEFAULT 1,
    username   TEXT NOT NULL DEFAULT '',
    pass_enc   TEXT NOT NULL DEFAULT '',
    mail_from  TEXT NOT NULL DEFAULT '',
    from_name  TEXT NOT NULL DEFAULT '',
    updated    TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS admin (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    salt     TEXT NOT NULL,
    hash     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    expires INTEGER NOT NULL
  );
`);

// Migrasi untuk database lama
const pendaftarCols = db.prepare('PRAGMA table_info(pendaftar)').all().map(c => c.name);
const prodiCols = db.prepare('PRAGMA table_info(prodi)').all().map(c => c.name);
if (!prodiCols.includes('profil')) db.exec("ALTER TABLE prodi ADD COLUMN profil TEXT NOT NULL DEFAULT '{}'");
if (!pendaftarCols.includes('sumber_info')) db.exec("ALTER TABLE pendaftar ADD COLUMN sumber_info TEXT NOT NULL DEFAULT ''");
if (!pendaftarCols.includes('verifikasi_at')) db.exec("ALTER TABLE pendaftar ADD COLUMN verifikasi_at TEXT NOT NULL DEFAULT ''");
const kipCols = db.prepare('PRAGMA table_info(kip)').all().map(c => c.name);
if (!kipCols.includes('dtsen')) db.exec("ALTER TABLE kip ADD COLUMN dtsen TEXT NOT NULL DEFAULT ''");
if (!kipCols.includes('pip')) db.exec("ALTER TABLE kip ADD COLUMN pip TEXT NOT NULL DEFAULT ''");
const halamanCols = db.prepare('PRAGMA table_info(halaman)').all().map(c => c.name);
if (!halamanCols.includes('media')) db.exec("ALTER TABLE halaman ADD COLUMN media TEXT NOT NULL DEFAULT '[]'");

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DATA_DIR, all, get, run, tx };
