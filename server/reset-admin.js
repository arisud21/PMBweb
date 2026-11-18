'use strict';
// Reset akun admin: npm run reset-admin [-- username password]
const svc = require('./service');
svc.init();
const user = process.argv[2] || process.env.ADMIN_USERNAME || 'admin';
const pass = process.argv[3] || process.env.ADMIN_PASSWORD || 'admin123';
svc.setAdminCredential(user, pass);
console.log(`Akun admin direset. Username: ${user}. Semua sesi login dihapus.`);
