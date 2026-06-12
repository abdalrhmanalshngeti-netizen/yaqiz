require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../config/db');

async function migrate() {
  const migrations = ['001_initial.sql', '002_saas.sql', '003_support_tickets.sql', '004_impersonation.sql', '005_indexes.sql', '006_payments.sql', '007_email.sql', '008_ai.sql'];
  for (const file of migrations) {
    const filePath = path.join(__dirname, 'migrations', file);
    if (!fs.existsSync(filePath)) continue;
    console.log(`Running ${file}...`);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await db.query(sql);
      console.log(`✅ ${file} completed.`);
    } catch (err) {
      console.error(`❌ ${file} failed:`, err.message);
      process.exit(1);
    }
  }
  await db.pool.end();
}

migrate();
