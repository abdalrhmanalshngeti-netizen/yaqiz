require('dotenv').config();
const bcrypt = require('bcrypt');
const db     = require('../../config/db');

async function run() {
  try {
    const hash = await bcrypt.hash('D8-Fss57/cc0', 12);
    await db.query(
      `UPDATE users SET username = $1, password_hash = $2 WHERE is_super_admin = true`,
      ['Amiine', hash]
    );
    console.log('✅ Super admin updated: Amiine');
  } catch(e) {
    console.error('❌', e.message);
  } finally {
    await db.pool.end();
  }
}
run();
