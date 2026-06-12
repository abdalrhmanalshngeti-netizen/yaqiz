require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../config/db');

async function migrate() {
  const migrations = ['001_initial.sql', '002_saas.sql', '003_support_tickets.sql', '004_impersonation.sql', '005_indexes.sql', '006_payments.sql', '007_email.sql', '008_ai.sql', '009_ensure_core.sql'];
  for (const file of migrations) {
    const filePath = path.join(__dirname, 'migrations', file);
    if (!fs.existsSync(filePath)) continue;
    console.log(`Running ${file}...`);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await db.query(sql);
      console.log(`✅ ${file} completed.`);
    } catch (err) {
      // تجاهل أخطاء "already exists" — تشير لتشغيل سابق ناجح
      if (err.message.includes('already exists') || err.code === '42P07' || err.code === '42701') {
        console.log(`⚠️  ${file} skipped (already applied): ${err.message}`);
      } else {
        console.error(`❌ ${file} failed:`, err.message);
        // لا نوقف التطبيق — نكمل باقي الـ migrations
      }
    }
  }
  await db.pool.end();
}

migrate();
