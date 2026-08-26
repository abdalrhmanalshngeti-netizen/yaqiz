const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const db     = require('../config/db');

const ACCESS_TTL  = '8h';
const REFRESH_TTL = '30d';

// هاش bcrypt ثابت (وهمي، لا يطابق أي كلمة مرور حقيقية) — يُستخدم فقط لإبقاء
// زمن استجابة تسجيل الدخول ثابتًا سواء وُجد اسم المستخدم أو لا (راجع exports.login)
const DUMMY_PASSWORD_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeOgOEufIWNZTeIQZOMuVYUD/qA6M0EHKC';

// sess = معرّف صف user_sessions — يُتحقق منه بكل طلب (middleware/auth.js) عشان
// إلغاء جلسة محددة من "أجهزتي" يسري فوراً، مو ينتظر انتهاء صلاحية التوكن (8 ساعات)
function signAccess(user, sessionId) {
  return jwt.sign(
    { sub: user.id, company_id: user.company_id, role: user.role, perms: user.permissions || [], sess: sessionId },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

function signRefresh(userId) {
  // jti عشوائي — بدونه توكنين لنفس المستخدم بنفس الثانية يطلعوا متطابقين حرفياً
  // (payload + iat بدقة ثانية) ويصطدمون بقيد UNIQUE على token_hash
  return jwt.sign(
    { sub: userId, jti: crypto.randomBytes(8).toString('hex') },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TTL }
  );
}

exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const ip = req.ip;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    // فحص محاولات الفشل الأخيرة (10 دقائق)
    const { rows: atRows } = await db.query(`
      SELECT COUNT(*)::int AS cnt FROM login_attempts
      WHERE username = $1 AND ip_address = $2
        AND success = false AND attempted_at > NOW() - INTERVAL '10 minutes'
    `, [username, ip]);

    if (atRows[0].cnt >= 5) {
      return res.status(429).json({
        success: false,
        message: 'تم تجاوز عدد المحاولات المسموح بها. حاول بعد 10 دقائق.'
      });
    }

    // جلب المستخدم
    const { rows } = await db.query(`
      SELECT u.*, c.name AS company_name, c.vat_number AS company_vat,
             c.cr_number AS company_cr, c.contact_phone AS company_phone,
             c.address AS company_address, c.city AS company_city,
             c.street_name AS company_street, c.building_number AS company_building,
             c.district AS company_district, c.postal_code AS company_postal_code,
             c.contact_email AS company_email,
             c.plan AS company_plan, c.subscription_expires_at, c.branch_limit_override,
             c.status AS company_status
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.username = $1 AND u.active = true
      LIMIT 1
    `, [username]);

    const user = rows[0];
    // bcrypt.compare يجب أن يُستدعى دائمًا بنفس التكلفة، سواء وُجد المستخدم أو
    // لا — قبل هذا، عدم وجود المستخدم كان يتخطى bcrypt.compare كليًا (short-
    // circuit)، فيرجع الرد أسرع بشكل قابل للقياس من حالة "مستخدم موجود لكن كلمة
    // مرور خاطئة" (تستدعي bcrypt.compare فعليًا، ~عشرات المللي ثانية إضافية).
    // فرق زمني كهذا يسمح بتخمين وجود اسم مستخدم حقيقي دون أي رسالة خطأ مختلفة
    const valid = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH) && !!user;

    // تسجيل المحاولة
    await db.query(
      `INSERT INTO login_attempts (username, ip_address, success) VALUES ($1,$2,$3)`,
      [username, ip, !!valid]
    );

    if (!valid) {
      return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    if (user.company_status === 'suspended' || user.company_status === 'cancelled') {
      return res.status(403).json({
        success: false,
        code: user.company_status === 'suspended' ? 'COMPANY_SUSPENDED' : 'COMPANY_CANCELLED',
        message: user.company_status === 'suspended'
          ? 'تم تعليق حساب شركتكم. يرجى التواصل مع الدعم الفني.'
          : 'تم إلغاء حساب شركتكم.'
      });
    }

    const refreshToken = signRefresh(user.id);

    // حفظ الجلسة أولاً عشان نضمّن معرّفها بالتوكن (للإبطال الفوري لجلسة محددة)
    const { rows: [session] } = await db.query(`
      INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES ($1,$2,$3,$4, NOW() + INTERVAL '30 days')
      RETURNING id
    `, [user.id, refreshToken, ip, req.headers['user-agent']]);

    const accessToken = signAccess(user, session.id);

    // تحديث آخر دخول
    await db.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);

    db.query(`
      INSERT INTO platform_log (event_type, company_id, user_id, description, ip_address)
      VALUES ('user_login', $1, $2, $3, $4)
    `, [user.company_id, user.id, `تسجيل دخول: ${user.username} (${user.role})`, ip]).catch(() => {});

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id:           user.id,
        username:     user.username,
        full_name:    user.full_name,
        role:         user.role,
        permissions:  user.permissions || [],
        pos_access:   user.pos_access,
        shift_enabled: user.shift_enabled,
        branch_id:    user.branch_id || null,
        all_branches: user.all_branches || false,
        company_id:              user.company_id,
        company_name:            user.company_name,
        company_vat:             user.company_vat,
        company_cr:              user.company_cr      || null,
        company_phone:           user.company_phone   || null,
        company_address:         user.company_address || null,
        company_city:            user.company_city    || null,
        company_email:           user.company_email   || null,
        plan:                    (['basic','growth','pro'].includes(user.company_plan) ? user.company_plan : 'basic'),
        subscription_expires_at: user.subscription_expires_at,
        branch_limit_override:   user.branch_limit_override ?? null,
        tours_seen:              user.tours_seen || {},
      }
    });

  } catch (err) { next(err); }
};

exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await db.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [refreshToken]);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── أجهزتي: قائمة الجلسات النشطة + إمكانية إنهاء أي جلسة فوراً ──
exports.listSessions = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, ip_address, user_agent, created_at, expires_at
      FROM user_sessions WHERE user_id = $1 AND expires_at > NOW()
      ORDER BY created_at DESC
    `, [req.user.sub]);
    res.json({ success: true, data: rows, current_session_id: req.user.sess || null });
  } catch (err) { next(err); }
};

exports.revokeSession = async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM user_sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.sub]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'الجلسة غير موجودة' });
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token مطلوب' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Refresh token غير صالح' });
    }

    const { rows } = await db.query(`
      SELECT u.*, s.id AS session_id, c.status AS company_status FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      JOIN companies c ON c.id = u.company_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = true
    `, [refreshToken]);

    if (!rows[0]) {
      return res.status(401).json({ success: false, message: 'جلسة منتهية، سجّل الدخول مجدداً' });
    }

    if (rows[0].company_status === 'suspended' || rows[0].company_status === 'cancelled') {
      return res.status(403).json({
        success: false,
        code: rows[0].company_status === 'suspended' ? 'COMPANY_SUSPENDED' : 'COMPANY_CANCELLED',
        message: rows[0].company_status === 'suspended'
          ? 'تم تعليق حساب شركتكم. يرجى التواصل مع الدعم الفني.'
          : 'تم إلغاء حساب شركتكم.'
      });
    }

    // تدوير توكن التجديد نفسه بكل استخدام — كان نفس الـrefreshToken يبقى صالحًا
    // لكامل الـ30 يومًا بلا أي تغيّر، فلو سُرق (تسريب سجلّات، XSS، جهاز مشترك)
    // يبقى المهاجم قادرًا على تجديد جلسته طوال المدة كاملة بلا أي وسيلة كشف أو
    // حد. الآن كل استدعاء لهذا المسار يُبطل التوكن القديم فورًا (تحديث
    // token_hash بنفس صف الجلسة) ويُصدر توكنًا جديدًا بدله — استخدام التوكن
    // القديم لاحقًا (من أي طرف: المستخدم الحقيقي أو المهاجم، أيهما تأخر) يفشل
    // بـ"جلسة منتهية" لعدم تطابقه مع الصف المحدَّث، فيصبح التسريب محدود الأثر
    // بدل صالح شهرًا كاملًا
    const newRefreshToken = signRefresh(rows[0].id);
    await db.query(
      `UPDATE user_sessions SET token_hash = $1, expires_at = NOW() + INTERVAL '30 days' WHERE id = $2`,
      [newRefreshToken, rows[0].session_id]
    );
    const newAccessToken = signAccess(rows[0], rows[0].session_id);
    res.json({ success: true, accessToken: newAccessToken, refreshToken: newRefreshToken });

  } catch (err) { next(err); }
};

// ── استبدال كود الدخول الإداري بتوكن ────────────────────
exports.redeemImpersonation = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'الكود مطلوب' });

    // ادّعاء الكود ذرّيًا بشرط used=FALSE بنفس عبارة الـUPDATE — يمنع تصادم
    // طلبين متزامنين (نقرة مزدوجة/إعادة إرسال) من الحصول على جلستي انتحال
    // صالحتين من كود واحد لمرة واحدة (كان يحصل بفحص SELECT منفصل قبل UPDATE)
    const { rows: claimed } = await db.query(`
      UPDATE impersonation_codes SET used = TRUE
      WHERE code = $1 AND used = FALSE AND expires_at > NOW()
      RETURNING code, company_name, created_by, user_id, company_id
    `, [code]);
    if (!claimed[0]) return res.status(404).json({ success: false, message: 'الكود غير صالح أو منتهي الصلاحية' });

    const { rows } = await db.query(`
      SELECT u.username, u.full_name, u.role, u.permissions, u.pos_access, u.shift_enabled, u.company_id,
             c.vat_number AS company_vat
      FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1 AND c.id = $2
    `, [claimed[0].user_id, claimed[0].company_id]);

    const rec = { ...claimed[0], ...rows[0] };
    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستخدم أو الشركة غير موجودة' });

    const token = jwt.sign(
      {
        sub: rec.user_id, company_id: rec.company_id,
        role: rec.role, perms: rec.permissions || [],
        impersonated: true, impersonated_by: rec.created_by
      },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      success: true, token,
      company_name: rec.company_name,
      user: {
        id: rec.user_id, username: rec.username, full_name: rec.full_name,
        role: rec.role, permissions: rec.permissions || [],
        pos_access: rec.pos_access, shift_enabled: rec.shift_enabled, company_id: rec.company_id,
        company_name: rec.company_name, company_vat: rec.company_vat,
      }
    });
  } catch (err) { next(err); }
};

// ── سجل جلسات الأدمن للمستخدم ────────────────────────────
exports.getAdminAccesses = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT description, created_at FROM platform_log
      WHERE company_id = $1 AND event_type IN ('impersonation','session_revoked')
      ORDER BY created_at DESC LIMIT 20
    `, [req.user.company_id]);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── إلغاء جميع جلسات الأدمن ──────────────────────────────
exports.revokeAdminSessions = async (req, res, next) => {
  try {
    await db.query(`UPDATE companies SET revoke_sessions_before = NOW() WHERE id = $1`, [req.user.company_id]);
    await db.query(`DELETE FROM impersonation_codes WHERE company_id = $1 AND used = FALSE`, [req.user.company_id]);
    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description)
      VALUES ('session_revoked', $1, $2)
    `, [req.user.company_id, `إلغاء جميع جلسات الأدمن بواسطة المستخدم`]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.me = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.username, u.full_name, u.role, u.permissions,
             u.pos_access, u.shift_enabled, u.last_login, u.tours_seen, u.branch_id, u.all_branches,
             c.name AS company_name, c.vat_number AS company_vat, c.logo_url,
             c.cr_number AS company_cr, c.contact_phone AS company_phone,
             c.address AS company_address, c.city AS company_city,
             c.street_name AS company_street, c.building_number AS company_building,
             c.district AS company_district, c.postal_code AS company_postal_code,
             c.contact_email AS company_email,
             c.plan AS plan, c.subscription_expires_at, c.branch_limit_override
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1
    `, [req.user.sub]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    const d = rows[0];
    d.plan = (['basic','growth','pro'].includes(d.plan) ? d.plan : 'basic');
    res.json({ success: true, data: d });
  } catch (err) { next(err); }
};

// ── تحديث بيانات الشركة ──────────────────────────────────
exports.updateCompany = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'هذه الميزة للمالك فقط' });
    }
    const { company_name, vat_number, cr_number, address, city, contact_phone, contact_email,
            street_name, building_number, district, postal_code, country_code } = req.body;

    // صيغة العنوان الوطني (رقم المبنى/الرمز البريدي) مطلوبة بمعيار سبل السعودي
    // ولازمة لتوليد QR فاتورة صحيح بالمرحلة الثانية — نتحقق منها هنا كخط دفاع
    // أخير حتى لو تجاوز طلب مباشر للـ API التحقق الموجود بالواجهة
    if (building_number !== undefined && building_number !== null && building_number !== '' && !/^\d{4}$/.test(String(building_number))) {
      return res.status(400).json({ success: false, message: 'رقم المبنى يجب أن يكون 4 أرقام بالضبط' });
    }
    if (postal_code !== undefined && postal_code !== null && postal_code !== '' && !/^\d{5}$/.test(String(postal_code))) {
      return res.status(400).json({ success: false, message: 'الرمز البريدي يجب أن يكون 5 أرقام بالضبط' });
    }

    await db.query(`
      UPDATE companies SET
        name            = COALESCE($1, name),
        vat_number      = COALESCE($2, vat_number),
        cr_number       = COALESCE($3, cr_number),
        address         = COALESCE($4, address),
        city            = COALESCE($5, city),
        contact_phone   = COALESCE($6, contact_phone),
        contact_email   = COALESCE($7, contact_email),
        street_name     = COALESCE($9, street_name),
        building_number = COALESCE($10, building_number),
        district        = COALESCE($11, district),
        postal_code     = COALESCE($12, postal_code),
        country_code    = COALESCE($13, country_code)
      WHERE id = $8
    `, [company_name||null, vat_number||null, cr_number||null,
        address||null, city||null, contact_phone||null, contact_email||null,
        req.user.company_id,
        street_name||null, building_number||null, district||null, postal_code||null, country_code||null]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
