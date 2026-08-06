const db     = require('../config/db');
const bcrypt = require('bcrypt');

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM closed_periods WHERE company_id = $1 ORDER BY period_key DESC`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { company_id, sub: user_id } = req.user;
    const { period_type, period_key, closed_by_name } = req.body;
    if (!['month', 'year'].includes(period_type) || !period_key) {
      return res.status(400).json({ success: false, message: 'بيانات الفترة غير صحيحة' });
    }
    const { rows: [row] } = await db.query(`
      INSERT INTO closed_periods (company_id, period_type, period_key, closed_by, closed_by_name)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (company_id, period_type, period_key) DO NOTHING
      RETURNING *
    `, [company_id, period_type, period_key, user_id, closed_by_name || '']);
    res.status(201).json({ success: true, data: row || null });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(`DELETE FROM closed_periods WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

// حالة كلمة مرور التجاوز — هل تم تعيينها لهذه الشركة أصلاً؟ (بدون كشف أي شيء عنها)
exports.overridePasswordStatus = async (req, res, next) => {
  try {
    const { rows: [co] } = await db.query(
      `SELECT (period_override_password_hash IS NOT NULL) AS is_set FROM companies WHERE id = $1`,
      [req.user.company_id]
    );
    res.json({ success: true, is_set: !!co?.is_set });
  } catch (err) { next(err); }
};

// تعيين/تغيير كلمة مرور التجاوز — مالك الحساب فقط، ويتطلب كلمة مرور دخوله
// الحقيقية كتأكيد (حتى لا يقدر أي شخص بجلسة مسروقة يغيّرها بدون معرفة كلمة
// مرور المالك الفعلية). هذه الكلمة منفصلة تمامًا عن كلمة مرور الدخول.
exports.setOverridePassword = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'هذا الإجراء لمالك الحساب فقط' });
    }
    const { current_login_password, new_override_password } = req.body;
    if (!current_login_password || !new_override_password) {
      return res.status(400).json({ success: false, message: 'كلمة مرور الدخول الحالية وكلمة مرور التجاوز الجديدة مطلوبتان' });
    }
    if (new_override_password.length < 6) {
      return res.status(400).json({ success: false, message: 'كلمة مرور التجاوز يجب أن تكون 6 أحرف على الأقل' });
    }
    const { rows: [owner] } = await db.query(
      `SELECT password_hash FROM users WHERE id = $1 AND company_id = $2`,
      [req.user.sub, req.user.company_id]
    );
    if (!owner || !(await bcrypt.compare(current_login_password, owner.password_hash))) {
      return res.status(401).json({ success: false, message: 'كلمة مرور الدخول الحالية غير صحيحة' });
    }
    const hash = await bcrypt.hash(new_override_password, 12);
    await db.query(`UPDATE companies SET period_override_password_hash = $1 WHERE id = $2`, [hash, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

// تحقق من كلمة مرور التجاوز (منفصلة عن كلمة مرور دخول المالك) — يُستخدم لتجاوز
// إقفال فترة محاسبية استثنائياً أو فتحها. لا يغيّر شيئاً، للتحقق فقط.
exports.verifyOverridePassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة' });
    const { rows: [co] } = await db.query(
      `SELECT period_override_password_hash FROM companies WHERE id = $1`,
      [req.user.company_id]
    );
    if (!co?.period_override_password_hash) {
      return res.status(400).json({ success: false, code: 'NOT_SET', message: 'لم يُعيَّن مالك الحساب كلمة مرور تجاوز بعد' });
    }
    if (!(await bcrypt.compare(password, co.period_override_password_hash))) {
      return res.status(401).json({ success: false, message: 'كلمة مرور التجاوز غير صحيحة' });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
};
