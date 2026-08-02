require('dotenv').config();
const bcrypt = require('bcrypt');
const db     = require('../../config/db');

async function seedSuperAdmin() {
  try {
    const username  = 'superadmin';
    const password  = 'SuperAdmin@2026!';
    const full_name = 'مدير يقظ';

    // تحقق من وجوده
    const { rows } = await db.query(`SELECT id FROM users WHERE username = $1 AND is_super_admin = true`, [username]);
    if (rows.length) {
      console.log('✅ Super admin already exists.');
      await db.pool.end(); return;
    }

    const hash = await bcrypt.hash(password, 12);

    // Super admin لا يحتاج company — نستخدم أول شركة موجودة كـ placeholder
    const { rows: companies } = await db.query(`SELECT id FROM companies LIMIT 1`);
    if (!companies.length) {
      console.error('❌ No company found. Run init seed first.');
      await db.pool.end(); return;
    }

    await db.query(`
      INSERT INTO users (company_id, username, password_hash, full_name, role, active, is_super_admin)
      VALUES ($1, $2, $3, $4, 'owner', true, true)
    `, [companies[0].id, username, hash, full_name]);

    console.log('✅ Super Admin created:');
    console.log(`   Username: ${username}`);
    console.log(`   Password: ${password}`);
    console.log(`   Panel:    http://localhost:3000/admin`);
  } catch(err) {
    console.error('❌ Error:', err.message);
  } finally {
    await db.pool.end();
  }
}

seedSuperAdmin();
