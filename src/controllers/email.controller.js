const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db     = require('../config/db');
const { sendMail, resetPasswordTemplate } = require('../services/email.service');

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'البريد الإلكتروني مطلوب' });

    const { rows: [user] } = await db.query(
      `SELECT id, username, email FROM users WHERE email = $1 AND active = true LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    // نُرجع نجاح دائماً حتى لا نكشف وجود البريد من عدمه
    if (!user) {
      return res.json({ success: true, message: 'إذا كان البريد مسجلاً، ستصلك رسالة خلال دقائق' });
    }

    // حذف أي طلبات سابقة للمستخدم نفسه
    await db.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [user.id]);

    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // ساعة واحدة

    await db.query(`
      INSERT INTO password_reset_tokens (user_id, token, expires_at)
      VALUES ($1,$2,$3)
    `, [user.id, token, expiresAt]);

    const appUrl   = process.env.APP_URL || 'https://yaqiz.me';
    const resetUrl = `${appUrl}/reset-password?token=${token}`;

    await sendMail({
      to:      user.email,
      subject: 'إعادة تعيين كلمة المرور — يقظ',
      html:    resetPasswordTemplate(user.username, resetUrl),
    });

    res.json({ success: true, message: 'إذا كان البريد مسجلاً، ستصلك رسالة خلال دقائق' });
  } catch (err) { next(err); }
};

exports.resetPassword = async (req, res, next) => {
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
      SELECT id, user_id FROM password_reset_tokens
      WHERE token = $1 AND expires_at > NOW() AND used = FALSE
    `, [token]);

    if (!rec) {
      return res.status(400).json({ success: false, message: 'الرابط منتهي الصلاحية أو مستخدم مسبقاً' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, rec.user_id]);
    await db.query(`UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`, [rec.id]);
    await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [rec.user_id]);

    res.json({ success: true, message: 'تم تحديث كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن' });
  } catch (err) { next(err); }
};
