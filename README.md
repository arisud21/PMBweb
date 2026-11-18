# Landing Page PMB + Klaim Voucher

Landing page penerimaan mahasiswa baru, formulir klaim voucher (kode voucher dikirim otomatis
ke email calon mahasiswa), formulir peminatan KIP-K, dan panel admin tunggal.

Dibangun dengan Node.js + Express, database SQLite (`data/pmb.sqlite`), email lewat SMTP.

## Struktur folder

```
views/          Index.html (landing), Admin.html (panel admin), Styles.html (CSS bersama)
server/         index.js (server & routing), service.js (logika), db.js (SQLite),
                mailer.js (email voucher), util.js, reset-admin.js
public/         file statis (logo, gambar, unggahan) -> diakses lewat /assets/<nama-file>
data/           dibuat otomatis: database SQLite, secret.key, outbox email (jangan di-commit)
```

---

## Menjalankan di localhost

Syarat: **Node.js 22.13 atau lebih baru** (cek dengan `node --version`).

```powershell
cd "D:\landing page pmb"
npm install
copy .env.example .env      # opsional, untuk SMTP / port / akun admin awal
npm start
```

Buka:
- Landing page: <http://localhost:3000/>
- Panel admin: <http://localhost:3000/admin>

Login admin awal: **admin / admin123** (atau sesuai `ADMIN_USERNAME`/`ADMIN_PASSWORD` di `.env`
saat database pertama kali dibuat). Segera ganti di menu **Akun Admin**.

Perintah lain:

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Mode pengembangan, server restart otomatis saat file `server/` berubah |
| `npm run reset-admin` | Reset login admin ke nilai `.env` / admin123 |
| `npm run reset-admin -- nama passwordbaru` | Reset ke username & password tertentu |
| `npm run test-email -- alamat@anda.com` | Kirim email uji |

### Email voucher

Email voucher diatur di **Admin > Pengaturan Email > Konfigurasi SMTP** (tanpa restart server).
Urutan sumber pengaturan: halaman admin (bila sakelarnya aktif) > file `.env` > mode uji.

- **Mode uji** (belum ada pengaturan): email tidak dikirim, hanya disimpan sebagai file `.html` di `data/outbox/`.
- **Pengirim pmb@poltektedc.ac.id (Google Workspace)**:
  1. Login ke akun Google **pmb@poltektedc.ac.id** > Akun Google > **Keamanan**, aktifkan **Verifikasi 2 Langkah**.
  2. Buka **Sandi aplikasi** (App Passwords), buat sandi baru, salin 16 karakternya.
     Jika menu ini tidak ada, admin Google Workspace kampus perlu mengizinkannya.
  3. Admin > Pengaturan Email > Konfigurasi SMTP: pilih **Google Workspace / Gmail**, username
     `pmb@poltektedc.ac.id`, tempel App Password, aktifkan sakelar, klik **Simpan & tes koneksi**.
  4. Klik **Kirim email uji**, lalu **Kirim ulang semua** untuk voucher yang tertahan (status Outbox/Gagal).
- Password SMTP disimpan **terenkripsi** (AES-256-GCM) di database; kuncinya di `data/secret.key`.
  Backup folder `data/` secara utuh. Jika `secret.key` hilang, cukup isi ulang password di halaman admin.

Alternatif (cadangan) lewat file `.env`, dipakai bila konfigurasi di halaman admin nonaktif:

  ```
  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=465
  SMTP_SECURE=true
  SMTP_USER=pmb@kampus.ac.id
  SMTP_PASS=<App Password 16 karakter>
  ```

  Restart server setelah mengubah `.env`.

### Diakses dari perangkat lain / dipasang di server

- Agar bisa dibuka dari HP di jaringan yang sama: set `HOST=0.0.0.0`, lalu buka `http://<IP-komputer>:3000`.
- Untuk server produksi: set `NODE_ENV=production`, jalankan dengan process manager (mis. `pm2 start npm --name pmb -- start`),
  dan pasang di belakang reverse proxy HTTPS (Nginx/Caddy) **di server yang sama**, pada subdomain sendiri
  (mis. `pmb.poltektedc.ac.id`, bukan sub-folder). Server mempercayai header `X-Forwarded-For` hanya dari
  proxy lokal (127.0.0.1), sehingga pembatasan klaim/login tetap per pengunjung.
- Backup cukup dengan menyalin folder `data/` (hentikan server dulu agar database konsisten).

### Logo

Logo bawaan: `public/logo.png`. Untuk logo lain, taruh file di `public/` lalu isi URL di **Identitas Kampus**
(mis. `/assets/logo-baru.png`).

---

## Fitur

**Alamat laman**:

| Laman | Alamat |
|---|---|
| Beranda | `/` |
| Klaim Voucher & KIP-K | `/?page=klaim` (tab KIP-K: `/?page=klaim&tab=kip`) |
| Halaman kustom (mis. Jalur Masuk) | `/?page=p&slug=jalur-masuk` |
| Profil program studi | `/?page=prodi&prodi=P01` |
| Panel admin | `/admin` atau `/?page=admin` |

**Beranda**: hero, daftar program studi, info voucher, pita statistik, alur klaim, tombol WhatsApp,
mode terang/gelap. Urutan dan tampil/sembunyi tiap bagian serta bagian tambahan (mis. Informasi PMB)
diatur di **Tata Letak Beranda**. Tombol kanan atas "Daftar PMB" menuju https://join.poltektedc.ac.id
(label & URL bisa diubah). Menu navigasi sepenuhnya diatur admin.

**Laman Klaim Voucher** (terpisah dari beranda), berisi dua tab:

- **Klaim Voucher**: nama, email, WhatsApp, asal sekolah, *program studi peminatan* (boleh lebih dari satu),
  dan *sumber informasi klaim voucher*. Semua wajib diisi. Pilihan sumber informasi diatur admin.
- **Peminatan KIP-K**: nama (sesuai KTP/KK), email, WhatsApp, asal sekolah, tahun lulus, *program studi
  peminatan* (boleh lebih dari satu), **status DTSEN** (Desil 1-6), kartu bantuan, catatan tambahan.
  Khusus Desil 5 dan 6 muncul pertanyaan **status PIP** (Sebagai Penerima PIP / Bukan Penerima PIP).
  Pilihan tahun lulus otomatis 3 tahun terakhir dari tahun akademik di Identitas Kampus
  (2027/2028 menghasilkan 2025, 2026, 2027). Tidak mengirim email; admin menghubungi pendaftar untuk verifikasi.

**Aturan klaim**: satu email satu voucher, kode unik acak (mis. `PMB-7K3D-9XQ2`), formulir otomatis
tertutup di luar periode klaim / saat kuota habis / saat voucher dinonaktifkan. Ada honeypot anti-bot
dan pembatasan jumlah klaim per IP.

**Panel admin (satu akun)**:
- Dasbor: filter periode (tahun/bulan), kartu ringkasan (klaim voucher, peminat KIP-K, kuota voucher, email terkirim),
  grafik tren, status email voucher, top program studi, sumber informasi, dan tombol
  **Rekap Prodi (Excel)** (sheet terpisah: Klaim Voucher & Peminatan KIP-K).
- Data Pendaftar: cari, filter prodi & status email, catatan admin, kirim ulang voucher, chat WhatsApp, hapus, ekspor Excel.
- Peminatan KIP-K: cari, filter prodi & desil DTSEN, detail, catatan admin, chat WhatsApp, hapus, ekspor Excel.
- Menu & Navigasi: judul hero beranda, label/URL tombol kanan atas, dan daftar menu (tambah, hapus, urutkan,
  tampil/sembunyi). Tujuan menu: bagian beranda (termasuk bagian tambahan), laman Klaim Voucher, tab KIP-K,
  halaman kustom, atau link URL. Setiap menu bisa punya hingga 10 **sub menu** (dropdown).
  Tujuan **Grup** = menu yang hanya membuka sub menu.
- Tata Letak Beranda: urutkan dan tampilkan/sembunyikan bagian bawaan, tambah hingga 10 bagian sendiri
  (label, judul, subjudul, teks, kartu, foto/carousel/YouTube). Bagian yang disembunyikan otomatis hilang dari menu.
- Halaman: buat halaman kustom seperti **Jalur Masuk** (judul, alamat, subjudul, teks pengantar, media, kartu berisi
  label, deskripsi, poin persyaratan, dan tombol). Isi awal Jalur Masuk adalah **contoh**, ganti dengan informasi resmi.
- Pengaturan Formulir: kelola pilihan sumber informasi klaim voucher, buka/tutup formulir KIP-K, teks informasi KIP-K.
- Program Studi: tambah/ubah/hapus, aktif/nonaktif, urutan, dan **profil** untuk laman "Lihat selengkapnya"
  (akreditasi, gelar lulusan, lama studi, foto, tentang, visi, misi, keunggulan, prospek karier).
- Pengaturan Voucher: aktif/nonaktif, nominal, awalan kode, periode klaim, masa berlaku
  (sampai tanggal tertentu / N hari sejak klaim), kuota, ketentuan, subjek email.
- Pengaturan Email, Identitas Kampus, dan Akun Admin (ganti username/password).

Keamanan: password admin di-hash (scrypt), sesi 6 jam, login dikunci 15 menit setelah 5 kali gagal.
