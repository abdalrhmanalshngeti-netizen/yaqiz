const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

const ACCESS_TTL  = '8h';
const REFRESH_TTL = '30d';

exports.register = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const {
      // بيانات الشركة
      company_name, vat_number, cr_number, address, city, contact_email, contact_phone,
      // بيانات المالك
      username, password, full_name, phone, email
    } = req.body;

    if (!company_name || !username || !password || !full_name) {
      return res.status(400).json({
        success: false,
        message: 'اسم الشركة واسم المستخدم وكلمة المرور والاسم الكامل مطلوبة'
      });
    }

    if (username.length < 6 || !/\d/.test(username)) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم يجب أن يكون 6 أحرف على الأقل ويحتوي على رقم واحد على الأقل' });
    }

    if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
      return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير وحرف صغير بالإنجليزية' });
    }

    // تحقق من تكرار اسم المستخدم
    const { rows: existing } = await client.query(
      `SELECT id FROM users WHERE username = $1`, [username]
    );
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'اسم المستخدم مستخدم مسبقاً' });
    }

    // 1. إنشاء الشركة
    const { rows: [company] } = await client.query(`
      INSERT INTO companies (name, vat_number, cr_number, address, city, contact_email, contact_phone, status, plan, subscription_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active','trial', NOW() + INTERVAL '14 days')
      RETURNING *
    `, [company_name, vat_number||null, cr_number||null, address||null, city||null,
        contact_email||null, contact_phone||null]);

    // 2. إنشاء مستخدم المالك
    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await client.query(`
      INSERT INTO users (company_id, username, password_hash, full_name, role, phone, email, active)
      VALUES ($1,$2,$3,$4,'owner',$5,$6,true)
      RETURNING id, username, full_name, role, company_id
    `, [company.id, username, hash, full_name, phone||null, email||null]);

    // 3. الإعدادات الافتراضية
    await client.query(`
      INSERT INTO settings (company_id, key, value) VALUES
        ($1,'vat_rate','15'),
        ($1,'currency','SAR'),
        ($1,'language','ar'),
        ($1,'invoice_prefix','INV'),
        ($1,'company_name',$2)
      ON CONFLICT (company_id, key) DO NOTHING
    `, [company.id, company_name]);

    // 4. حساب الصندوق الرئيسي
    await client.query(`
      INSERT INTO treasury_accounts (company_id, name, type, balance, is_default)
      VALUES ($1,'الصندوق الرئيسي','cash',0,true)
    `, [company.id]);

    // 5. تسجيل الحدث في platform_log
    await client.query(`
      INSERT INTO platform_log (event_type, company_id, user_id, description, ip_address)
      VALUES ('company_registered',$1,$2,$3,$4)
    `, [company.id, user.id, `تسجيل شركة جديدة: ${company_name}`, req.ip]);

    // إصدار tokens داخل الـ transaction لضمان الاتساق
    const accessToken = jwt.sign(
      { sub: user.id, company_id: company.id, role: 'owner', perms: [] },
      process.env.JWT_SECRET, { expiresIn: ACCESS_TTL }
    );
    const refreshToken = jwt.sign(
      { sub: user.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TTL }
    );

    await client.query(`
      INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES ($1,$2,$3,$4, NOW() + INTERVAL '30 days')
    `, [user.id, refreshToken, req.ip, req.headers['user-agent']]);

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'تم إنشاء الحساب بنجاح',
      accessToken,
      refreshToken,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: 'owner' },
      company: { id: company.id, name: company.name }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
