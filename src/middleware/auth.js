const jwt = require('jsonwebtoken');
const db  = require('../config/db');

// مسارات تبقى متاحة حتى بعد انتهاء الفترة المجانية (الدفع والدعم)
const SUBSCRIPTION_EXEMPT_PREFIXES = ['/api/payment', '/api/support'];

module.exports = async function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'يجب تسجيل الدخول' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // فحص إلغاء جلسات الأدمن
    if (payload.impersonated && payload.company_id) {
      const { rows } = await db.query(
        'SELECT revoke_sessions_before FROM companies WHERE id = $1',
        [payload.company_id]
      );
      const revokeBefore = rows[0]?.revoke_sessions_before;
      if (revokeBefore && payload.iat < new Date(revokeBefore).getTime() / 1000) {
        return res.status(401).json({
          success: false,
          code: 'IMP_REVOKED',
          message: 'تم إلغاء الجلسة الإدارية من قِبل المستخدم'
        });
      }
    }

    // منع أي عملية تعديل (غير القراءة) إذا انتهت الفترة المجانية/الاشتراك ولم يُجدَّد
    if (req.method !== 'GET' && payload.company_id) {
      const exempt = SUBSCRIPTION_EXEMPT_PREFIXES.some(p => req.originalUrl.startsWith(p));
      if (!exempt) {
        const { rows: [co] } = await db.query(
          'SELECT subscription_expires_at FROM companies WHERE id = $1',
          [payload.company_id]
        );
        if (co?.subscription_expires_at && new Date(co.subscription_expires_at) < new Date()) {
          return res.status(402).json({
            success: false,
            code: 'SUBSCRIPTION_EXPIRED',
            message: 'انتهت الفترة المجانية لشركتكم. يرجى التواصل مع مالك الحساب لتفعيل الاشتراك.'
          });
        }
      }
    }

    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        code: 'TOKEN_EXPIRED',
        message: 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً'
      });
    }
    res.status(401).json({ success: false, message: 'توكن غير صالح' });
  }
};
