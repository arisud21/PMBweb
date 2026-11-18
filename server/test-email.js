'use strict';
// Uji konfigurasi email: npm run test-email -- alamat@tujuan.com
const svc = require('./service');
const mailer = require('./mailer');

(async () => {
  const to = process.argv[2];
  if (!to) { console.log('Pemakaian: npm run test-email -- alamat@tujuan.com'); process.exit(1); }
  svc.init();
  const i = mailer.info();
  console.log(`Mode    : ${i.mode === 'smtp' ? 'SMTP (dari ' + (i.source === 'admin' ? 'halaman admin' : 'file .env') + ')' : 'uji (outbox lokal, email tidak dikirim)'}`);
  if (i.mode === 'smtp') {
    console.log(`Server  : ${i.host}:${i.port}`);
    console.log(`Login   : ${i.user || '-'} (password ${i.passSet ? 'terisi' : 'KOSONG'})`);
    console.log(`Pengirim: ${i.fromName ? i.fromName + ' ' : ''}<${i.from}>`);
    const st = await mailer.verify();
    if (!st.ok) { console.log('\nGAGAL terhubung: ' + st.error); process.exit(2); }
    console.log('Koneksi : OK');
  }
  const { getPublicData } = svc;
  const s = getPublicData('').settings;
  try {
    await mailer.sendTest(to, s);
    console.log(`\nBerhasil. ${i.mode === 'smtp' ? 'Email uji terkirim ke ' + to + '. Cek kotak masuk/spam.' : 'Email disimpan di ' + i.outbox}`);
  } catch (e) {
    console.log('\nGAGAL mengirim: ' + e.message);
    process.exit(3);
  }
})();
