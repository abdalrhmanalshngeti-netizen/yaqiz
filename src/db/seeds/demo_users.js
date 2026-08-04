require('dotenv').config();
const bcrypt = require('bcrypt');
const db     = require('../../config/db');

async function seedDemoUsers() {
  try {
    const hash = await bcrypt.hash('1234', 12);

    const { rows } = await db.query(
      `SELECT id FROM companies WHERE name LIKE '%يقظ%' LIMIT 1`
    );
    if (!rows.length) { console.error('❌ Company not found'); return; }
    const cid = rows[0].id;

    const users = [
      { username: 'owner',      full_name: 'مالك المنشأة', role: 'owner' },
      { username: 'accountant', full_name: 'المحاسب',       role: 'accountant' },
      { username: 'cashier',    full_name: 'أمين الصندوق',  role: 'cashier' },
    ];

    for (const u of users) {
      const r = await db.query(
        `INSERT INTO users (company_id, username, password_hash, full_name, role, active)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT (username, company_id) DO UPDATE SET password_hash=$3, active=true
         RETURNING username`,
        [cid, u.username, hash, u.full_name, u.role]
      );
      console.log(`✅ ${r.rows[0].username} (${u.role}) — password: 1234`);
    }
  } catch(e) {
    console.error('❌', e.message);
  } finally {
    await db.pool.end();
  }
}

seedDemoUsers();
