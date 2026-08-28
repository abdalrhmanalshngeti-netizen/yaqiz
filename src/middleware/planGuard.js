const db = require('../config/db');

// ملاحظة: بعض المفاتيح هنا (trial_balance/bank_statement/extra_reports/ai_assistant)
// غير مُستخدَمة فعليًا بأي requireFeature() بمسار خلفي حاليًا (تلك التقارير
// تُحسَب بالكامل من بيانات مُزامَنة بالعميل بلا نقطة تحقق خلفية مخصصة، ai_assistant
// يُحكَم بسقف يومي بديل بدل حظر كامل) — أُبقيت متطابقة مع PLAN_FEATURES بالواجهة
// (VVIP.html) فقط لمنع "لغم" مستقبلي: لو أُضيف requireFeature() لأحدها لاحقًا
// بدون تحديث هذي القائمة، سيُحظَر خطأً عن باقة يُفترض أنها مخوَّلة له فعليًا
const PLAN_FEATURES = {
  basic:   ['ai_assistant'],
  growth:  ['employees','payroll','shifts','import','activity_log','cashflow','custom_period','stock_moves','admin_expenses','ai_extract','ai_analyze','customers','period_close','obligations','purchase_orders','journal','trial_balance','bank_statement','extra_reports','ai_assistant'],
  pro:     ['employees','payroll','shifts','loyalty','import','activity_log','cashflow','custom_period','stock_moves','admin_expenses','ai_extract','ai_analyze','journal','income_statement','balance_sheet','trial_balance','bank_recon','aging_report','purchase_orders','period_compare','ai_assistant','customers','obligations','pricing_policy','period_close','quotes','bank_statement','extra_reports'],
  expired: [],
};

const requireFeature = function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const { company_id } = req.user;
      const { rows: [co] } = await db.query(
        `SELECT plan, subscription_expires_at FROM companies WHERE id = $1`,
        [company_id]
      );
      if (!co) return res.status(403).json({ success: false, message: 'الشركة غير موجودة' });

      let plan = co.plan || 'basic';
      // normalize legacy plan names
      if (plan === 'trial' || plan === 'free' || plan === 'starter') plan = 'basic';
      // subscription/trial period ended on any plan → no plan features until renewed
      if (co.subscription_expires_at && new Date(co.subscription_expires_at) < new Date()) {
        plan = 'expired';
      }

      const allowed = PLAN_FEATURES[plan] || [];
      if (!allowed.includes(feature)) {
        return res.status(403).json({
          success: false,
          code: 'PLAN_UPGRADE_REQUIRED',
          message: 'هذه الميزة غير متاحة في باقتك الحالية. يرجى الترقية للوصول إليها.',
          current_plan: plan,
          required_feature: feature,
        });
      }
      next();
    } catch (err) { next(err); }
  };
};

module.exports = requireFeature;
// مُصدَّرة أيضًا كخاصية على نفس الدالة (بلا كسر أي `require(...)` قائم يستخدمها
// كدالة مباشرة) — تحتاجها planUpgrade.service.js لمعرفة أي ميزات جديدة تُفتح
// فعليًا عند ترقية باقة شركة، من نفس القائمة المُستخدَمة لفرض الصلاحيات، بدل
// نسخة ثانية منفصلة قابلة للتعارض معها مستقبلًا
module.exports.PLAN_FEATURES = PLAN_FEATURES;
