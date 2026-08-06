const bcrypt           = require('bcrypt');
const jwt              = require('jsonwebtoken');
const crypto           = require('crypto');
const db               = require('../config/db');
const { sendMail }     = require('../services/email.service');

const PLATFORM_OWNER_EMAIL = 'abdalrhmanalshngeti@gmail.com';

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
      username, password, full_name, phone, email,
      // الباقة المختارة
      plan: chosenPlan
    } = req.body;
    const plan = ['basic','growth','pro'].includes(chosenPlan) ? chosenPlan : 'basic';

    if (!contact_email && !contact_phone) {
      return res.status(400).json({
        success: false,
        message: 'يجب تعبئة البريد الإلكتروني أو رقم الجوال على الأقل'
      });
    }

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

    // 1. إنشاء الشركة — كل الباقات (أساسية/نمو/احترافية) تبدأ بتجربة 30 يوم
    const { rows: [company] } = await client.query(`
      INSERT INTO companies (name, vat_number, cr_number, address, city, contact_email, contact_phone, status, plan, subscription_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8::varchar, NOW() + INTERVAL '30 days')
      RETURNING *
    `, [company_name, vat_number||null, cr_number||null, address||null, city||null,
        contact_email||null, contact_phone||null, plan]);

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

    // 4. حساب الصندوق الرئيسي (كاش) + الحساب البنكي — لفصل تحصيلات الشبكة/التحويل عن النقد تلقائياً
    await client.query(`
      INSERT INTO treasury_accounts (company_id, name, type, balance, is_default)
      VALUES ($1,'الصندوق الرئيسي','cash',0,true)
    `, [company.id]);
    await client.query(`
      INSERT INTO treasury_accounts (company_id, name, type, balance, is_default)
      VALUES ($1,'الحساب البنكي','bank',0,false)
    `, [company.id]);

    // 4b. دليل الحسابات (لازم لربط قيود دفتر اليومية) — نفس القائمة المحلية بالواجهة
    const coaRows = [
      ['1000','الأصول','Assets','أصول',true,null],
      ['1100','النقدية والبنوك','Cash & Banks','أصول',false,'1000'],
      ['1200','الذمم المدينة','Accounts Receivable','أصول',false,'1000'],
      ['1300','المخزون','Inventory','أصول',false,'1000'],
      ['2000','الالتزامات','Liabilities','التزامات',true,null],
      ['2100','الذمم الدائنة','Accounts Payable','التزامات',false,'2000'],
      ['2200','ضريبة القيمة المضافة','VAT Payable','التزامات',false,'2000'],
      ['3000','حقوق الملكية','Equity','حقوق الملكية',true,null],
      ['4000','الإيرادات','Revenue','إيرادات',true,null],
      ['4100','إيرادات المبيعات','Sales Revenue','إيرادات',false,'4000'],
      ['5000','المصروفات','Expenses','مصروفات',true,null],
      ['5100','تكلفة البضاعة المباعة','Cost of Goods Sold','مصروفات',false,'5000'],
      ['5200','المصاريف التشغيلية','Operating Expenses','مصروفات',false,'5000'],
    ];
    const coaIdByCode = {};
    for (const [code, name, name_en, type, is_group] of coaRows) {
      const { rows: [row] } = await client.query(
        `INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [company.id, code, name, name_en, type, is_group]
      );
      coaIdByCode[code] = row.id;
    }
    for (const [code, , , , , parentCode] of coaRows) {
      if (parentCode) {
        await client.query(`UPDATE chart_of_accounts SET parent_id = $1 WHERE id = $2`,
          [coaIdByCode[parentCode], coaIdByCode[code]]);
      }
    }

    // 5. تسجيل الحدث في platform_log
    await client.query(`
      INSERT INTO platform_log (event_type, company_id, user_id, description, ip_address)
      VALUES ('company_registered',$1,$2,$3,$4)
    `, [company.id, user.id, `تسجيل شركة جديدة: ${company_name}`, req.ip]);

    // إصدار tokens داخل الـ transaction لضمان الاتساق
    // jti عشوائي بالـ refresh يمنع تصادم UNIQUE لو صار تسجيل مزدوج بنفس الثانية
    const refreshToken = jwt.sign(
      { sub: user.id, jti: crypto.randomBytes(8).toString('hex') },
      process.env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TTL }
    );

    // نسجّل الجلسة أولاً عشان نضمّن معرّفها بالتوكن (لدعم "أجهزتي" وإبطال جلسة محددة فوراً)
    const { rows: [session] } = await client.query(`
      INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES ($1,$2,$3,$4, NOW() + INTERVAL '30 days')
      RETURNING id
    `, [user.id, refreshToken, req.ip, req.headers['user-agent']]);

    const accessToken = jwt.sign(
      { sub: user.id, company_id: company.id, role: 'owner', perms: [], sess: session.id },
      process.env.JWT_SECRET, { expiresIn: ACCESS_TTL }
    );

    await client.query('COMMIT');

    // إشعار المالك بالعميل الجديد
    sendMail({
      to: PLATFORM_OWNER_EMAIL,
      subject: `🏢 عميل جديد — ${company_name}`,
      html: `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
        body{font-family:Arial,sans-serif;background:#f1f5f9;margin:0;padding:20px;}
        .wrap{max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);}
        .header{background:#1e40af;padding:20px 28px;color:#fff;font-size:1.1rem;font-weight:700;}
        .body{padding:24px 28px;}
        .row{padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:.92rem;display:flex;justify-content:space-between;}
        .label{color:#64748b;font-weight:600;}.val{color:#0f172a;font-weight:700;}
      </style></head><body>
      <div class="wrap">
        <div class="header">🏢 تسجيل منشأة جديدة في يقظ</div>
        <div class="body">
          <div class="row"><span class="label">اسم المنشأة</span><span class="val">${company_name}</span></div>
          <div class="row"><span class="label">اسم المالك</span><span class="val">${full_name} (@${username})</span></div>
          ${contact_email ? `<div class="row"><span class="label">البريد الإلكتروني</span><span class="val">${contact_email}</span></div>` : ''}
          ${contact_phone ? `<div class="row"><span class="label">رقم الجوال</span><span class="val">${contact_phone}</span></div>` : ''}
          ${city ? `<div class="row"><span class="label">المدينة</span><span class="val">${city}</span></div>` : ''}
          ${vat_number ? `<div class="row"><span class="label">الرقم الضريبي</span><span class="val">${vat_number}</span></div>` : ''}
          <div class="row"><span class="label">الباقة</span><span class="val">${{basic:'أساسي',growth:'نمو',pro:'احترافي'}[plan]||plan}</span></div>
          <div class="row"><span class="label">تاريخ التسجيل</span><span class="val">${new Date().toLocaleString('ar-SA')}</span></div>
        </div>
      </div></body></html>`
    }).catch(e => console.warn('[register] Owner notification failed:', e.message));

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
