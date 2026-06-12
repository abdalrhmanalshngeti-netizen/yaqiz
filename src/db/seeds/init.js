require('dotenv').config();
const bcrypt = require('bcrypt');
const db     = require('../../config/db');

async function seed() {
  console.log('Seeding initial data...');
  try {
    // شركة افتراضية
    const { rows: [company] } = await db.query(`
      INSERT INTO companies (name, name_en, vat_number, phone)
      VALUES ('شركة يقظ', 'Yaqiz Co.', '300000000000003', '0500000000')
      ON CONFLICT DO NOTHING
      RETURNING id
    `);

    const companyId = company?.id;
    if (!companyId) {
      console.log('Company already exists, skipping seed.');
      return;
    }

    // مستخدم Owner
    const hash = await bcrypt.hash('Admin@2026!', 12);
    await db.query(`
      INSERT INTO users (company_id, username, password_hash, full_name, role)
      VALUES ($1, 'admin', $2, 'مدير النظام', 'owner')
      ON CONFLICT DO NOTHING
    `, [companyId, hash]);

    // حساب خزينة افتراضي
    await db.query(`
      INSERT INTO treasury_accounts (company_id, name, type, is_default)
      VALUES ($1, 'الصندوق الرئيسي', 'cash', true)
    `, [companyId]);

    // إعدادات افتراضية
    const defaultSettings = [
      ['invoice_prefix', 'INV'],
      ['purchase_prefix', 'PUR'],
      ['quote_prefix', 'QUO'],
      ['vat_rate', '15'],
      ['currency', 'SAR'],
      ['language', 'ar'],
    ];
    for (const [key, value] of defaultSettings) {
      await db.query(`
        INSERT INTO settings (company_id, key, value) VALUES ($1,$2,$3)
        ON CONFLICT (key, company_id) DO NOTHING
      `, [companyId, key, value]);
    }

    console.log('✅ Seed completed.');
    console.log('   Company ID:', companyId);
    console.log('   Username: admin');
    console.log('   Password: Admin@2026!');
    console.log('   ⚠️  Change the password after first login!');

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

seed();
