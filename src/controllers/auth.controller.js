const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

const ACCESS_TTL  = '8h';
const REFRESH_TTL = '30d';

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, company_id: user.company_id, role: user.role, perms: user.permissions || [] },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

function signRefresh(userId) {
  return jwt.sign(
    { sub: userId },
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
             c.plan AS company_plan, c.subscription_expires_at
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.username = $1 AND u.active = true
      LIMIT 1
    `, [username]);

    const user  = rows[0];
    const valid = user && await bcrypt.compare(password, user.password_hash);

    // تسجيل المحاولة
    await db.query(
      `INSERT INTO login_attempts (username, ip_address, success) VALUES ($1,$2,$3)`,
      [username, ip, !!valid]
    );

    if (!valid) {
      return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user.id);

    // حفظ الجلسة
    await db.query(`
      INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES ($1,$2,$3,$4, NOW() + INTERVAL '30 days')
    `, [user.id, refreshToken, ip, req.headers['user-agent']]);

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
        company_id:   user.company_id,
        company_name:            user.company_name,
        company_vat:             user.company_vat,
        plan:                    user.company_plan || 'trial',
        subscription_expires_at: user.subscription_expires_at,
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
      SELECT u.* FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = true
    `, [refreshToken]);

    if (!rows[0]) {
      return res.status(401).json({ success: false, message: 'جلسة منتهية، سجّل الدخول مجدداً' });
    }

    const newAccessToken = signAccess(rows[0]);
    res.json({ success: true, accessToken: newAccessToken });

  } catch (err) { next(err); }
};

// ── استبدال كود الدخول الإداري بتوكن ────────────────────
exports.redeemImpersonation = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'الكود مطلوب' });

    const { rows } = await db.query(`
      SELECT ic.code, ic.company_name, ic.created_by, ic.user_id,
             u.username, u.full_name, u.role, u.permissions, u.pos_access, u.company_id,
             c.vat_number AS company_vat
      FROM impersonation_codes ic
      JOIN users u ON u.id = ic.user_id
      JOIN companies c ON c.id = ic.company_id
      WHERE ic.code = $1 AND ic.used = FALSE AND ic.expires_at > NOW()
    `, [code]);

    const rec = rows[0];
    if (!rec) return res.status(404).json({ success: false, message: 'الكود غير صالح أو منتهي الصلاحية' });

    await db.query(`UPDATE impersonation_codes SET used = TRUE WHERE code = $1`, [code]);

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
        pos_access: rec.pos_access, company_id: rec.company_id,
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
             u.pos_access, u.shift_enabled, u.last_login,
             c.name AS company_name, c.vat_number AS company_vat, c.logo_url,
             c.plan AS plan, c.subscription_expires_at
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1
    `, [req.user.sub]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};
