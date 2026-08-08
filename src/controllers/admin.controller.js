const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const db     = require('../config/db');
const { sendMail, resetPasswordTemplate } = require('../services/email.service');

const ADMIN_PERMISSIONS = ['tickets', 'customers', 'companies_manage', 'plans', 'cost_analysis', 'activity_log', 'dashboard', 'impersonate'];

// ينشئ جلسة كاملة (سطر admin_sessions + توكن نهائي) — يُستدعى من تسجيل الدخول
// المباشر (بدون 2FA) ومن تأكيد رمز 2FA على حد سواء
async function issueFullSession(admin, req) {
  await db.query(`UPDATE platform_admins SET last_login = NOW() WHERE id = $1`, [admin.id]);

  const { rows: [session] } = await db.query(`
    INSERT INTO admin_sessions (admin_id, ip_address, user_agent, expires_at)
    VALUES ($1, $2, $3, NOW() + INTERVAL '12 hours')
    RETURNING id
  `, [admin.id, req.ip, req.headers['user-agent']]);

  const token = jwt.sign(
    { sub: admin.id, is_super_admin: true, email: admin.email, name: admin.full_name, sess: session.id },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  return {
    success: true, token, email: admin.email, name: admin.full_name,
    role: admin.role, permissions: admin.permissions || [],
  };
}

// ── تسجيل دخول المدير العام ─────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
    }

    const { rows } = await db.query(
      `SELECT * FROM platform_admins WHERE email = $1 AND active = true`,
      [email.toLowerCase().trim()]
    );
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ success: false, message: 'بيانات غير صحيحة' });
    }

    // لو مفعّل عنده 2FA، ما نصدر توكن دخول كامل إلا بعد التحقق من الرمز —
    // بدلها نعطيه توكن مؤقت صالح 5 دقائق وغرضه الوحيد التحقق من رمز 2FA
    if (admin.totp_enabled) {
      const tempToken = jwt.sign(
        { sub: admin.id, purpose: '2fa_pending' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ success: true, requires_2fa: true, temp_token: tempToken });
    }

    const session = await issueFullSession(admin, req);
    res.json(session);
  } catch (err) { next(err); }
};

// ── تأكيد رمز 2FA أثناء تسجيل الدخول ──────────────────────
exports.verify2FALogin = async (req, res, next) => {
  try {
    const { temp_token, code } = req.body;
    if (!temp_token || !code) {
      return res.status(400).json({ success: false, message: 'الرمز المؤقت ورمز التحقق مطلوبان' });
    }

    let payload;
    try {
      payload = jwt.verify(temp_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة المؤقتة، سجّل الدخول مجدداً' });
    }
    if (payload.purpose !== '2fa_pending') {
      return res.status(401).json({ success: false, message: 'توكن غير صالح' });
    }

    const { rows: [admin] } = await db.query(
      `SELECT * FROM platform_admins WHERE id = $1 AND active = true`, [payload.sub]
    );
    if (!admin || !admin.totp_enabled) {
      return res.status(401).json({ success: false, message: 'الحساب غير موجود أو 2FA غير مفعّل' });
    }

    const validTotp = authenticator.verify({ token: code.trim(), secret: admin.totp_secret });
    if (validTotp) {
      const session = await issueFullSession(admin, req);
      return res.json(session);
    }

    // جرّب كرمز احتياطي (backup code) — يُستهلك مرة وحدة
    const normalizedCode = code.trim().toUpperCase();
    for (const hashedBackup of admin.totp_backup_codes) {
      if (await bcrypt.compare(normalizedCode, hashedBackup)) {
        await db.query(
          `UPDATE platform_admins SET totp_backup_codes = array_remove(totp_backup_codes, $1) WHERE id = $2`,
          [hashedBackup, admin.id]
        );
        const session = await issueFullSession(admin, req);
        return res.json(session);
      }
    }

    res.status(401).json({ success: false, message: 'رمز التحقق غير صحيح' });
  } catch (err) { next(err); }
};

// ── تفعيل 2FA: خطوة 1 — توليد سر جديد وQR (لسا مو مفعّل) ──
exports.setup2FA = async (req, res, next) => {
  try {
    const secret = authenticator.generateSecret();
    await db.query(`UPDATE platform_admins SET totp_pending_secret = $1 WHERE id = $2`, [secret, req.admin.sub]);

    const otpauth = authenticator.keyuri(req.admin.email, 'يقظ - لوحة الإدارة', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);

    res.json({ success: true, secret, qr_code: qrDataUrl });
  } catch (err) { next(err); }
};

// ── تفعيل 2FA: خطوة 2 — تأكيد أول رمز وتفعيله فعلياً ────
exports.confirm2FASetup = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'رمز التحقق مطلوب' });

    const { rows: [admin] } = await db.query(
      `SELECT totp_pending_secret FROM platform_admins WHERE id = $1`, [req.admin.sub]
    );
    if (!admin?.totp_pending_secret) {
      return res.status(400).json({ success: false, message: 'ابدأ إعداد 2FA أولاً' });
    }
    const valid = authenticator.verify({ token: code.trim(), secret: admin.totp_pending_secret });
    if (!valid) return res.status(400).json({ success: false, message: 'رمز التحقق غير صحيح' });

    // أكواد احتياطية — تُعرض مرة وحدة، تُخزَّن مشفّرة
    const backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
    const hashedBackupCodes = await Promise.all(backupCodes.map(c => bcrypt.hash(c, 10)));

    await db.query(`
      UPDATE platform_admins SET
        totp_secret = totp_pending_secret, totp_pending_secret = NULL,
        totp_enabled = true, totp_backup_codes = $1
      WHERE id = $2
    `, [hashedBackupCodes, req.admin.sub]);

    res.json({ success: true, backup_codes: backupCodes });
  } catch (err) { next(err); }
};

// ── تعطيل 2FA — يتطلب تأكيد كلمة المرور الحالية ──────────
exports.disable2FA = async (req, res, next) => {
  try {
    const { current_password } = req.body;
    const { rows: [admin] } = await db.query(`SELECT password_hash FROM platform_admins WHERE id = $1`, [req.admin.sub]);
    if (!current_password || !(await bcrypt.compare(current_password, admin.password_hash))) {
      return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    }
    await db.query(`
      UPDATE platform_admins SET totp_secret = NULL, totp_pending_secret = NULL,
        totp_enabled = false, totp_backup_codes = '{}' WHERE id = $1
    `, [req.admin.sub]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── تسجيل خروج — إنهاء الجلسة الحالية فوراً على السيرفر ──
exports.logout = async (req, res, next) => {
  try {
    if (req.admin?.sess) {
      await db.query(`DELETE FROM admin_sessions WHERE id = $1`, [req.admin.sess]);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── أجهزتي: قائمة الجلسات النشطة + إمكانية إنهاء أي جلسة فوراً ──
exports.listSessions = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, ip_address, user_agent, created_at, expires_at
      FROM admin_sessions WHERE admin_id = $1 AND expires_at > NOW()
      ORDER BY created_at DESC
    `, [req.admin.sub]);
    res.json({ success: true, data: rows, current_session_id: req.admin.sess || null });
  } catch (err) { next(err); }
};

exports.revokeSession = async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM admin_sessions WHERE id = $1 AND admin_id = $2`,
      [req.params.id, req.admin.sub]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'الجلسة غير موجودة' });
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── نسيت كلمة المرور (لوحة الإدارة) — استرجاع ذاتي بدل الحاجة لدخول مباشر لقاعدة البيانات ──
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'البريد الإلكتروني مطلوب' });

    const { rows: [admin] } = await db.query(
      `SELECT id, email, full_name FROM platform_admins WHERE email = $1 AND active = true LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    // نُرجع نجاح دائماً حتى لا نكشف وجود البريد من عدمه
    if (!admin) {
      return res.json({ success: true, message: 'إذا كان البريد مسجلاً، ستصلك رسالة خلال دقائق' });
    }

    await db.query(`DELETE FROM admin_password_reset_tokens WHERE admin_id = $1`, [admin.id]);

    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // ساعة واحدة

    await db.query(`
      INSERT INTO admin_password_reset_tokens (admin_id, token, expires_at)
      VALUES ($1,$2,$3)
    `, [admin.id, token, expiresAt]);

    const appUrl   = process.env.APP_URL || 'https://yaqiz.me';
    const resetUrl = `${appUrl}/reset-password?token=${token}&type=admin`;

    // فشل إرسال الإيميل ما يكسر الاستجابة ولا يسرّب تفاصيل SMTP للعميل
    sendMail({
      to:      admin.email,
      subject: 'إعادة تعيين كلمة مرور لوحة الإدارة — يقظ',
      html:    resetPasswordTemplate(admin.full_name, resetUrl),
    }).catch(e => console.error('[admin-forgot-password] Email send failed:', e.message));

    res.json({ success: true, message: 'إذا كان البريد مسجلاً، ستصلك رسالة خلال دقائق' });
  } catch (err) { next(err); }
};

exports.resetPasswordViaToken = async (req, res, next) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ success: false, message: 'الرمز وكلمة المرور الجديدة مطلوبان' });
    }
    if (new_password.length < 8 || !/[a-z]/.test(new_password) || !/[A-Z]/.test(new_password)) {
      return res.status(400).json({
        success: false,
        message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير وحرف صغير'
      });
    }

    const { rows: [rec] } = await db.query(`
      SELECT id, admin_id FROM admin_password_reset_tokens
      WHERE token = $1 AND expires_at > NOW() AND used = FALSE
    `, [token]);

    if (!rec) {
      return res.status(400).json({ success: false, message: 'الرابط منتهي الصلاحية أو مستخدم مسبقاً' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.query(
      `UPDATE platform_admins SET password_hash = $1, revoke_sessions_before = NOW() WHERE id = $2`,
      [hash, rec.admin_id]
    );
    await db.query(`UPDATE admin_password_reset_tokens SET used = TRUE WHERE id = $1`, [rec.id]);

    res.json({ success: true, message: 'تم تحديث كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن' });
  } catch (err) { next(err); }
};

// ── هوية الموظف الحالي (لأي موظف، بدون قيد صلاحية) ────────
exports.me = async (req, res, next) => {
  try {
    res.json({ success: true, data: { email: req.admin.email, name: req.admin.name, role: req.admin.role, permissions: req.admin.permissions, totp_enabled: req.admin.totp_enabled } });
  } catch (err) { next(err); }
};

// ── إحصائيات المنصة ──────────────────────────────────────
exports.stats = async (req, res, next) => {
  try {
    const [companies, users, invoices, newToday, byStatus, daily, suspended, recentLog, recentRegistrations] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active FROM companies`),
      db.query(`SELECT COUNT(*)::int AS total FROM users WHERE is_super_admin = false`),
      db.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(grand_total),0)::numeric AS revenue FROM invoices`),
      db.query(`SELECT COUNT(*)::int AS total FROM companies WHERE created_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT status, COUNT(*)::int AS count FROM companies GROUP BY status`),
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM companies
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day
      `),
      db.query(`
        SELECT c.id, c.name, c.status, c.created_at,
          COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin=false)::int AS user_count
        FROM companies c
        LEFT JOIN users u ON u.company_id = c.id
        WHERE c.status != 'active'
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT 10
      `),
      db.query(`
        SELECT pl.event_type, pl.description, pl.created_at, c.name AS company_name
        FROM platform_log pl
        LEFT JOIN companies c ON c.id = pl.company_id
        ORDER BY pl.created_at DESC LIMIT 10
      `),
      db.query(`
        SELECT c.id, c.name, c.contact_email, c.contact_phone, c.city, c.plan, c.created_at,
               u.full_name, u.username
        FROM companies c
        LEFT JOIN users u ON u.company_id = c.id AND u.role = 'owner'
        ORDER BY c.created_at DESC LIMIT 10
      `),
    ]);

    const statusMap = {};
    byStatus.rows.forEach(r => { statusMap[r.status] = r.count; });

    res.json({
      success: true,
      data: {
        companies:              { ...companies.rows[0], by_status: statusMap },
        users:                  users.rows[0],
        invoices:               invoices.rows[0],
        new_today:              newToday.rows[0].total,
        daily_reg:              daily.rows,
        issues:                 suspended.rows,
        recent_log:             recentLog.rows,
        recent_registrations:   recentRegistrations.rows,
      }
    });
  } catch (err) { next(err); }
};

// ── قائمة الشركات ─────────────────────────────────────────
exports.companies = async (req, res, next) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let where  = ['1=1'];
    let params = [];
    let idx    = 1;

    if (status) { where.push(`c.status = $${idx++}`); params.push(status); }
    if (search) {
      where.push(`(c.name ILIKE $${idx} OR c.vat_number ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.vat_number, c.status, c.plan,
        c.contact_email, c.contact_phone, c.city, c.created_at,
        c.subscription_expires_at,
        EXISTS(SELECT 1 FROM subscriptions s WHERE s.company_id = c.id) AS has_paid,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin = false)::int AS user_count,
        COUNT(DISTINCT i.id)::int  AS invoice_count,
        COALESCE(SUM(i.grand_total), 0)::numeric AS total_revenue,
        COUNT(*) OVER() AS total_count
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN invoices i ON i.company_id = c.id
      WHERE ${where.join(' AND ')}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, [...params, limit, offset]);

    res.json({
      success: true,
      data:  rows,
      total: parseInt(rows[0]?.total_count || 0),
      page:  parseInt(page)
    });
  } catch (err) { next(err); }
};

// ── تفاصيل شركة واحدة ─────────────────────────────────────
exports.companyDetails = async (req, res, next) => {
  try {
    const { rows: [company] } = await db.query(
      `SELECT c.*,
         COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin=false)::int AS user_count,
         COUNT(DISTINCT i.id)::int AS invoice_count,
         COALESCE(SUM(i.grand_total),0)::numeric AS total_revenue
       FROM companies c
       LEFT JOIN users u ON u.company_id = c.id
       LEFT JOIN invoices i ON i.company_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id]
    );
    if (!company) return res.status(404).json({ success: false, message: 'الشركة غير موجودة' });

    // استخدام الذكاء الاصطناعي لكل مستخدم بالشركة (تفريغ فواتير، تحليل، الشات
    // المساعد) — لمعرفة مين فعليًا يستخدم الميزات الذكية وبأي قدر
    const { rows: aiByUser } = await db.query(
      `SELECT user_id,
         COUNT(*) FILTER (WHERE feature='extract')::int   AS extract_count,
         COUNT(*) FILTER (WHERE feature='analyze')::int   AS analyze_count,
         COUNT(*) FILTER (WHERE feature='assistant')::int AS assistant_count
       FROM ai_usage WHERE company_id = $1 GROUP BY user_id`,
      [req.params.id]
    );
    const aiByUserMap = {};
    aiByUser.forEach(r => { aiByUserMap[r.user_id] = r; });

    const { rows: users } = await db.query(
      `SELECT id, username, full_name, role, active, last_login, created_at
       FROM users WHERE company_id = $1 AND is_super_admin = false ORDER BY created_at`,
      [req.params.id]
    );
    users.forEach(u => {
      const ai = aiByUserMap[u.id];
      u.ai_extract_count = ai?.extract_count || 0;
      u.ai_analyze_count = ai?.analyze_count || 0;
      u.ai_assistant_count = ai?.assistant_count || 0;
    });

    const { rows: [aiTotals] } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE feature='extract')::int   AS extract_count,
         COUNT(*) FILTER (WHERE feature='analyze')::int   AS analyze_count,
         COUNT(*) FILTER (WHERE feature='assistant')::int AS assistant_count
       FROM ai_usage WHERE company_id = $1`,
      [req.params.id]
    );

    const { rows: recentInvoices } = await db.query(
      `SELECT invoice_no, customer_name, grand_total, status, created_at
       FROM invoices WHERE company_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    res.json({ success: true, data: {
      ...company, users, recent_invoices: recentInvoices,
      ai_extract_count: aiTotals.extract_count,
      ai_analyze_count: aiTotals.analyze_count,
      ai_assistant_count: aiTotals.assistant_count,
    } });
  } catch (err) { next(err); }
};

// ── تغيير حالة الشركة (تعليق / تفعيل) ────────────────────
exports.setCompanyStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    await db.query(`UPDATE companies SET status = $1 WHERE id = $2`, [status, req.params.id]);

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description, admin_id)
      VALUES ('status_changed', $1, $2, $3)
    `, [req.params.id, `تغيير الحالة إلى: ${status} بواسطة ${req.admin.name || req.admin.email}`, req.admin.sub]);

    res.json({ success: true, message: `تم تغيير الحالة إلى ${status}` });
  } catch (err) { next(err); }
};

// ── تحليل التكلفة لكل الشركات ────────────────────────────
exports.costAnalysis = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.status, c.plan, c.created_at,
        c.contact_email, c.contact_phone, c.vat_number, c.city,
        c.subscription_expires_at,
        EXISTS(SELECT 1 FROM subscriptions s WHERE s.company_id = c.id) AS has_paid,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin = false)::int AS user_count,
        COUNT(DISTINCT i.id)::int AS invoice_count,
        COALESCE(SUM(i.grand_total), 0)::numeric AS total_revenue
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN invoices i ON i.company_id = c.id
      GROUP BY c.id
      ORDER BY COUNT(DISTINCT i.id) DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── سجل نشاط المنصة ──────────────────────────────────────
exports.platformLog = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT pl.*, c.name AS company_name
      FROM platform_log pl
      LEFT JOIN companies c ON c.id = pl.company_id
      ORDER BY pl.created_at DESC
      LIMIT 100
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── قائمة المستخدمين (الحسابات الرئيسية + التابعة) ────────
exports.listUsers = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id   AS company_id,
        c.name AS company_name,
        c.status AS company_status,
        u.id, u.username, u.full_name, u.role, u.active, u.last_login, u.created_at,
        (
          SELECT COUNT(*)::int FROM users u2
          WHERE u2.company_id = c.id
            AND u2.is_super_admin = false
            AND u2.role <> 'owner'
        ) AS sub_count
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.is_super_admin = false AND u.role = 'owner'
      ORDER BY u.created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── تصفح بصلاحيات مستخدم (Impersonation) ─────────────────
exports.impersonate = async (req, res, next) => {
  try {
    const reason = (req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: 'ملاحظة المعاينة مطلوبة قبل الدخول بحساب أي شركة' });
    }

    const { rows } = await db.query(`
      SELECT u.*, c.name AS company_name
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.company_id = $1 AND u.role = 'owner' AND u.active = true AND u.is_super_admin = false
      LIMIT 1
    `, [req.params.company_id]);

    const user = rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'لم يُعثر على حساب owner لهذه الشركة' });

    const crypto = require('crypto');
    const code = crypto.randomBytes(32).toString('hex');
    const actorName = req.admin.name || req.admin.email || 'المدير العام';

    // حذف الأكواد القديمة المنتهية أو المستخدمة لهذه الشركة
    await db.query(
      `DELETE FROM impersonation_codes WHERE company_id = $1 AND (expires_at < NOW() OR used = TRUE)`,
      [user.company_id]
    );

    await db.query(`
      INSERT INTO impersonation_codes (code, company_id, user_id, company_name, created_by, reason)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [code, user.company_id, user.id, user.company_name, actorName, reason]);

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description, admin_id)
      VALUES ('impersonation', $1, $2, $3)
    `, [user.company_id, `طلب دخول إداري: ${user.company_name} بواسطة ${actorName} — ملاحظة المعاينة: ${reason}`, req.admin.sub]);

    res.json({ success: true, code, company_name: user.company_name });
  } catch (err) { next(err); }
};

// ── إحصائيات الباقات ─────────────────────────────────────
exports.getPlans = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.plan, c.contact_email, c.subscription_expires_at,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin=false)::int AS user_count,
        COUNT(DISTINCT i.id)::int AS invoice_count
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN invoices i ON i.company_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    const plans = { basic: [], growth: [], pro: [] };
    rows.forEach(r => {
      const key = r.plan || 'basic';
      (plans[key] || (plans[key] = [])).push(r);
    });

    res.json({ success: true, data: { plans, companies: rows } });
  } catch (err) { next(err); }
};

// ── تغيير باقة شركة ──────────────────────────────────────
exports.setCompanyPlan = async (req, res, next) => {
  try {
    const { plan, expires_at } = req.body;
    const validPlans = ['basic', 'growth', 'pro'];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ success: false, message: 'باقة غير صالحة' });
    }

    if (expires_at) {
      const expDate = new Date(expires_at);
      if (isNaN(expDate.getTime())) {
        return res.status(400).json({ success: false, message: 'تاريخ انتهاء غير صالح' });
      }
      await db.query(
        `UPDATE companies SET plan = $1, subscription_expires_at = $2 WHERE id = $3`,
        [plan, expDate, req.params.id]
      );
    } else {
      const days = 30;
      await db.query(
        `UPDATE companies SET plan = $1, subscription_expires_at = NOW() + ($2 || ' days')::INTERVAL WHERE id = $3`,
        [plan, String(days), req.params.id]
      );
    }

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description, admin_id)
      VALUES ('plan_changed', $1, $2, $3)
    `, [req.params.id, `تغيير الباقة إلى: ${plan} بواسطة ${req.admin.email || req.admin.name}`, req.admin.sub]);

    res.json({ success: true, message: `تم تغيير الباقة إلى ${plan}` });
  } catch (err) { next(err); }
};

// ── عملاء جدد ومحتملون ────────────────────────────────────
exports.newClients = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.name, c.contact_email, c.contact_phone, c.city, c.plan,
             c.created_at, c.status,
             EXTRACT(DAY FROM NOW() - c.created_at)::int AS days_since,
             u.full_name, u.username
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id AND u.role = 'owner'
      WHERE c.created_at >= NOW() - INTERVAL '30 days'
        AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE email = u.username)
      ORDER BY c.created_at DESC
    `);
    const newClients       = rows.filter(r => r.days_since <  15);
    const potentialClients = rows.filter(r => r.days_since >= 15);
    res.json({ success: true, new: newClients, potential: potentialClients });
  } catch (err) { next(err); }
};

// ── تذاكر الدعم — قائمة ──────────────────────────────────
exports.listTickets = async (req, res, next) => {
  try {
    const { status, company_id } = req.query;
    const params = [];
    const conditions = [];
    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (company_id) {
      params.push(company_id);
      conditions.push(`t.company_id = $${params.length}`);
    }
    const where = conditions.length ? conditions.join(' AND ') : '1=1';
    const { rows } = await db.query(`
      SELECT t.*, a.full_name AS assigned_name
      FROM support_tickets t
      LEFT JOIN platform_admins a ON a.id = t.assigned_to
      WHERE ${where}
      ORDER BY t.created_at DESC
      LIMIT 200
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── تذكرة واحدة — تفاصيل + سجل الشركة + الردود ──────────
exports.getTicket = async (req, res, next) => {
  try {
    const { rows: [ticket] } = await db.query(`
      SELECT t.*, a.full_name AS assigned_name
      FROM support_tickets t
      LEFT JOIN platform_admins a ON a.id = t.assigned_to
      WHERE t.id = $1
    `, [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });

    const { rows: replies } = await db.query(
      `SELECT id, author_type, author_name, message, created_at
       FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at`,
      [req.params.id]
    );

    let history = [];
    if (ticket.company_id) {
      const { rows } = await db.query(`
        SELECT id, department, sub_dept, description, status, created_at, resolved_at
        FROM support_tickets WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50
      `, [ticket.company_id]);
      history = rows;
    }

    res.json({ success: true, data: ticket, replies, history });
  } catch (err) { next(err); }
};

// ── استلام التذكرة ────────────────────────────────────────
exports.claimTicket = async (req, res, next) => {
  try {
    const actor = req.admin.name || req.admin.email;
    const actionEntry = JSON.stringify([{
      status: null, label: `استلام بواسطة ${actor}`, actor, at: new Date().toISOString()
    }]);
    const { rows: [ticket] } = await db.query(`
      UPDATE support_tickets
      SET assigned_to = $1,
          status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
          actions = COALESCE(actions, '[]'::jsonb) || $2::jsonb
      WHERE id = $3
      RETURNING *
    `, [req.admin.sub, actionEntry, req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
    res.json({ success: true, data: ticket });
  } catch (err) { next(err); }
};

// ── رد الموظف على العميل ──────────────────────────────────
exports.replyTicket = async (req, res, next) => {
  try {
    const message = (req.body?.message || '').trim();
    if (!message) return res.status(400).json({ success: false, message: 'نص الرد مطلوب' });

    const { rows: [ticket] } = await db.query(
      `SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]
    );
    if (!ticket) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });

    const actor = req.admin.name || req.admin.email;
    const { rows: [reply] } = await db.query(`
      INSERT INTO ticket_replies (ticket_id, author_type, author_name, admin_id, message)
      VALUES ($1, 'admin', $2, $3, $4)
      RETURNING *
    `, [ticket.id, actor, req.admin.sub, message]);

    // لو التذكرة لسا مفتوحة، الرد يعني بدأنا نشتغل عليها
    if (ticket.status === 'open') {
      await db.query(`UPDATE support_tickets SET status = 'in_progress' WHERE id = $1`, [ticket.id]);
    }

    // إشعار العميل داخل التطبيق (لو التذكرة مرتبطة بشركة حقيقية، مو تذكرة ضيف)
    if (ticket.company_id) {
      await db.query(`
        INSERT INTO notifications (company_id, title, message, type)
        VALUES ($1, $2, $3, 'support_reply')
      `, [ticket.company_id, `رد على تذكرتك #${ticket.id}`, message]).catch(() => {});

      const { rows: [co] } = await db.query(`SELECT contact_email FROM companies WHERE id = $1`, [ticket.company_id]);
      if (co?.contact_email) {
        const { sendMail } = require('../services/email.service');
        sendMail({
          to: co.contact_email,
          subject: `رد على تذكرة الدعم #${ticket.id} — يقظ`,
          html: `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:20px;">
            <div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);">
              <div style="background:#0f172a;padding:20px 28px;color:#fff;font-weight:700;">رد على تذكرة الدعم #${ticket.id}</div>
              <div style="padding:24px 28px;color:#1e293b;line-height:1.8;white-space:pre-wrap;">${message}</div>
              <div style="padding:14px 28px;color:#94a3b8;font-size:.8rem;border-top:1px solid #f1f5f9;">يقظ — yaqiz.me</div>
            </div>
          </body></html>`
        }).catch(e => console.warn('[ticket-reply] Email failed:', e.message));
      }
    }

    res.status(201).json({ success: true, data: reply });
  } catch (err) { next(err); }
};

// ── تذاكر الدعم — تحديث الحالة ───────────────────────────
exports.updateTicketStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['open', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    const resolved_at = status === 'resolved' ? new Date() : null;
    const actionLabel = { open: 'إعادة فتح', in_progress: 'جارٍ المعالجة', resolved: 'محلولة' }[status];
    const actor = req.admin?.name || req.admin?.email || 'المدير';
    const actionEntry = JSON.stringify([{
      status, label: actionLabel, actor, at: new Date().toISOString()
    }]);

    const { rowCount } = await db.query(`
      UPDATE support_tickets
      SET status = $1, resolved_at = $2,
          actions = COALESCE(actions, '[]'::jsonb) || $3::jsonb
      WHERE id = $4
    `, [status, resolved_at, actionEntry, req.params.id]);

    if (!rowCount) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── إدارة موظفي لوحة الإدارة (خاص بالمالك فقط) ───────────

exports.listEmployees = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT a.id, a.email, a.full_name, a.role, a.permissions, a.active, a.last_login, a.created_at,
             a.manager_id, m.full_name AS manager_name
      FROM platform_admins a
      LEFT JOIN platform_admins m ON m.id = a.manager_id
      ORDER BY a.created_at
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// يتحقق إن manager_id (لو موجود) يشير لموظف حقيقي نشط، ومو نفس الشخص
async function resolveManagerId(managerId, selfId) {
  if (managerId == null || managerId === '') return null;
  const id = Number(managerId);
  if (!id || id === selfId) return null;
  const { rows: [m] } = await db.query(`SELECT id FROM platform_admins WHERE id = $1 AND active = true`, [id]);
  return m ? id : null;
}

exports.createEmployee = async (req, res, next) => {
  try {
    const { email, password, full_name, permissions = [], manager_id } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ success: false, message: 'البريد وكلمة المرور والاسم مطلوبة' });
    }
    const validPerms = permissions.filter(p => ADMIN_PERMISSIONS.includes(p));

    const hash = await bcrypt.hash(password, 12);
    const { rows: [emp] } = await db.query(`
      INSERT INTO platform_admins (email, password_hash, full_name, role, permissions, created_by, manager_id)
      VALUES ($1, $2, $3, 'staff', $4, $5, $6)
      RETURNING id, email, full_name, role, permissions, active, created_at, manager_id
    `, [email.toLowerCase().trim(), hash, full_name, validPerms, req.admin.sub, await resolveManagerId(manager_id, null)]);

    await db.query(`
      INSERT INTO platform_log (event_type, description, admin_id)
      VALUES ('admin_employee_added', $1, $2)
    `, [`إضافة موظف لوحة إدارة: ${full_name} (${email}) بواسطة ${req.admin.name || req.admin.email}`, req.admin.sub]);

    res.status(201).json({ success: true, data: emp });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم بالفعل' });
    next(err);
  }
};

exports.updateEmployee = async (req, res, next) => {
  try {
    const { rows: [target] } = await db.query(`SELECT role FROM platform_admins WHERE id = $1`, [req.params.id]);
    if (!target) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    if (target.role === 'owner') {
      return res.status(403).json({ success: false, message: 'لا يمكن تعديل حساب المالك' });
    }

    const { full_name, permissions, active, manager_id } = req.body;
    const validPerms = Array.isArray(permissions) ? permissions.filter(p => ADMIN_PERMISSIONS.includes(p)) : null;
    const managerIdResolved = manager_id !== undefined ? await resolveManagerId(manager_id, Number(req.params.id)) : undefined;

    const { rows: [emp] } = await db.query(`
      UPDATE platform_admins SET
        full_name  = COALESCE($1, full_name),
        permissions = COALESCE($2, permissions),
        active      = COALESCE($3, active),
        manager_id  = CASE WHEN $5 THEN $4 ELSE manager_id END,
        revoke_sessions_before = NOW()
      WHERE id = $6
      RETURNING id, email, full_name, role, permissions, active, created_at, manager_id
    `, [full_name || null, validPerms, typeof active === 'boolean' ? active : null,
        managerIdResolved ?? null, manager_id !== undefined, req.params.id]);

    await db.query(`
      INSERT INTO platform_log (event_type, description, admin_id)
      VALUES ('admin_employee_updated', $1, $2)
    `, [`تعديل صلاحيات/حالة الموظف #${req.params.id} بواسطة ${req.admin.name || req.admin.email}`, req.admin.sub]);

    res.json({ success: true, data: emp });
  } catch (err) { next(err); }
};

// ── إعادة تعيين كلمة مرور موظف (مالك فقط، بدون الحاجة لكلمة المرور القديمة) ──
exports.resetEmployeePassword = async (req, res, next) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'كلمة مرور جديدة مطلوبة (6 أحرف على الأقل)' });
    }
    const { rows: [target] } = await db.query(`SELECT role FROM platform_admins WHERE id = $1`, [req.params.id]);
    if (!target) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    if (target.role === 'owner') {
      return res.status(403).json({ success: false, message: 'لا يمكن تعديل حساب المالك من هنا — استخدم "حسابي"' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.query(
      `UPDATE platform_admins SET password_hash = $1, revoke_sessions_before = NOW() WHERE id = $2`,
      [hash, req.params.id]
    );
    await db.query(`
      INSERT INTO platform_log (event_type, description, admin_id)
      VALUES ('admin_password_reset', $1, $2)
    `, [`إعادة تعيين كلمة مرور الموظف #${req.params.id} بواسطة ${req.admin.name || req.admin.email}`, req.admin.sub]);

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── حساب الموظف نفسه: يعدّل اسمه/إيميله/كلمة مروره بنفسه ──
// تغيير الإيميل أو كلمة المرور يتطلب تأكيد كلمة المرور الحالية
exports.updateMyAccount = async (req, res, next) => {
  try {
    const { full_name, email, current_password, new_password } = req.body;
    const changingSensitive = !!(email || new_password);

    const { rows: [me] } = await db.query(`SELECT password_hash FROM platform_admins WHERE id = $1`, [req.admin.sub]);
    if (!me) return res.status(404).json({ success: false, message: 'الحساب غير موجود' });

    if (changingSensitive) {
      if (!current_password || !(await bcrypt.compare(current_password, me.password_hash))) {
        return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
      }
    }

    const newHash = new_password ? await bcrypt.hash(new_password, 12) : null;
    const { rows: [updated] } = await db.query(`
      UPDATE platform_admins SET
        full_name     = COALESCE($1, full_name),
        email         = COALESCE($2, email),
        password_hash = COALESCE($3, password_hash)
      WHERE id = $4
      RETURNING id, email, full_name, role, permissions
    `, [full_name || null, email ? email.toLowerCase().trim() : null, newHash, req.admin.sub]);

    res.json({ success: true, data: updated });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم بالفعل' });
    next(err);
  }
};

// ── فريقي: الموظفون اللي أنا مديرهم المباشر ──────────────
exports.listMyTeam = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, full_name, email, permissions, active, last_login, created_at
      FROM platform_admins WHERE manager_id = $1 ORDER BY full_name
    `, [req.admin.sub]);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── نشاط أحد أعضاء فريقي (أو أي موظف لو كنت المالك) ──────
exports.getTeamMemberActivity = async (req, res, next) => {
  try {
    const memberId = Number(req.params.id);
    const { rows: [member] } = await db.query(
      `SELECT id, full_name, email, manager_id FROM platform_admins WHERE id = $1`, [memberId]
    );
    if (!member) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    if (req.admin.role !== 'owner' && member.manager_id !== req.admin.sub) {
      return res.status(403).json({ success: false, message: 'ما تقدر تشوف نشاط هذا الموظف' });
    }

    const [logRes, ticketsRes, repliesRes] = await Promise.all([
      db.query(`
        SELECT event_type, description, created_at, company_id
        FROM platform_log WHERE admin_id = $1 ORDER BY created_at DESC LIMIT 100
      `, [memberId]),
      db.query(`
        SELECT id, company_name, status, department, sub_dept, created_at
        FROM support_tickets WHERE assigned_to = $1 ORDER BY created_at DESC LIMIT 50
      `, [memberId]),
      db.query(`
        SELECT ticket_id, message, created_at
        FROM ticket_replies WHERE admin_id = $1 ORDER BY created_at DESC LIMIT 50
      `, [memberId]),
    ]);

    res.json({
      success: true,
      data: { member: { id: member.id, full_name: member.full_name, email: member.email } },
      log: logRes.rows,
      tickets: ticketsRes.rows,
      replies: repliesRes.rows,
    });
  } catch (err) { next(err); }
};

// ── إشعارات لوحة الإدارة (لكل موظف منصة صلاحياته الخاصة) ──

exports.listNotifications = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM admin_notifications WHERE admin_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.admin.sub]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.unreadNotifCount = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM admin_notifications WHERE admin_id = $1 AND is_read = false`,
      [req.admin.sub]
    );
    res.json({ success: true, count: rows[0].count });
  } catch (err) { next(err); }
};

exports.markAllNotifRead = async (req, res, next) => {
  try {
    await db.query(
      `UPDATE admin_notifications SET is_read = true WHERE admin_id = $1 AND is_read = false`,
      [req.admin.sub]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};
