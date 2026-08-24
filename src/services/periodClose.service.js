const jwt = require('jsonwebtoken');

const OVERRIDE_TTL = '10m';

// يطابق _periodKey بالضبط بـVVIP.html — 'YYYY-MM' للشهر و'YYYY' للسنة
function periodKeys(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return { monthKey: null, yearKey: null };
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0');
  return { monthKey: `${y}-${m}`, yearKey: `${y}` };
}

// قابل لإعادة الاستخدام خلال مدته (لا استخدام واحد فقط) — إعادة محاولة حفظ
// فاشلة تعتمد على client_local_id الموجود أصلاً بكل نقاط الكتابة، وتوكن أحادي
// الاستخدام يكسرها. نطاقه على مستوى الشركة كلها لا فترة محددة — يطابق كون
// كلمة مرور التجاوز نفسها سرّ واحد للشركة كاملة أصلاً (migration 027)
function signPeriodOverrideToken(companyId) {
  return jwt.sign(
    { company_id: companyId, purpose: 'period_override' },
    process.env.PERIOD_OVERRIDE_JWT_SECRET,
    { expiresIn: OVERRIDE_TTL }
  );
}

function verifyPeriodOverrideToken(token, companyId) {
  if (!token) return false;
  try {
    const payload = jwt.verify(token, process.env.PERIOD_OVERRIDE_JWT_SECRET);
    return payload.purpose === 'period_override' && payload.company_id === companyId;
  } catch (e) {
    return false;
  }
}

// حارس مشترك يُستدعى داخل معاملة الكنترولر (نفس client، لا db.query منفصل)
// قبل أي INSERT/UPDATE بتاريخ مستند. يرجّع نتيجة بدل throw لأن المعالج العام
// للأخطاء بـapp.js يخفي err.message بالإنتاج برسالة عامة — الكنترولر يحتاج
// الرسالة العربية الحقيقية وcode فعلياً ليبنيهما برد 423 صريح
async function assertPeriodNotClosed(client, companyId, dateStr, overrideToken) {
  const { monthKey, yearKey } = periodKeys(dateStr);
  if (!monthKey) return { blocked: false }; // تاريخ غير صالح — ليس مسؤولية هذا الحارس

  const { rows: [row] } = await client.query(`
    SELECT c.period_override_password_hash IS NOT NULL AS enforced,
      EXISTS (
        SELECT 1 FROM closed_periods cp
        WHERE cp.company_id = c.id
          AND ((cp.period_type = 'month' AND cp.period_key = $2)
            OR (cp.period_type = 'year'  AND cp.period_key = $3))
      ) AS is_closed
    FROM companies c WHERE c.id = $1
  `, [companyId, monthKey, yearKey]);

  // كلمة تجاوز غير مضبوطة بعد → الإقفال غير مُنفَّذ إطلاقاً — يطابق نص الواجهة
  // الحالي بالضبط ("لن يُنفَّذ الإقفال حتى تضبط كلمة المرور")
  if (!row?.enforced || !row.is_closed) return { blocked: false };

  if (verifyPeriodOverrideToken(overrideToken, companyId)) return { blocked: false };

  return {
    blocked: true, status: 423, code: 'PERIOD_CLOSED',
    message: 'هذي الفترة مقفلة محاسبياً — التاريخ المُدخَل يقع ضمن فترة مُقفَلة'
  };
}

module.exports = { periodKeys, assertPeriodNotClosed, signPeriodOverrideToken, verifyPeriodOverrideToken };
