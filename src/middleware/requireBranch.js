const db = require('../config/db');

// حماية من السيرفر ضد واجهة محلية قديمة/معدَّلة: يرفض العمليات المرتبطة
// بالمخزون/الفواتير/المشتريات/الورديات لأي شركة لم تُكمل بعد إعداد فرعها
// الأول (بوابة الفرع الإجبارية بالواجهة). مصدر الحقيقة هو وجود فرع نشط
// فعليًا، لا علم منفصل قابل للانحراف عن الواقع.
module.exports = async function requireBranch(req, res, next) {
  try {
    const { rows: [{ exists: hasBranch }] } = await db.query(
      `SELECT EXISTS(SELECT 1 FROM branches WHERE company_id = $1 AND is_active = true) AS exists`,
      [req.user.company_id]
    );
    if (!hasBranch) {
      return res.status(400).json({
        success: false,
        code: 'BRANCH_SETUP_REQUIRED',
        message: 'يجب إعداد فرع واحد على الأقل قبل إتمام هذه العملية',
      });
    }
    next();
  } catch (err) { next(err); }
};
