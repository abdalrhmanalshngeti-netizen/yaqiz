const db = require('../config/db');

const PLAN_FEATURES = {
  trial:  ['employees','payroll','purchase_orders','journal','balance_sheet','trial_balance','bank_recon','aging_report'],
  basic:  [],
  growth: ['employees','payroll','purchase_orders'],
  pro:    ['employees','payroll','purchase_orders','journal','balance_sheet','trial_balance','bank_recon','aging_report'],
};

module.exports = function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const { company_id } = req.user;
      const { rows: [co] } = await db.query(
        `SELECT plan, subscription_expires_at FROM companies WHERE id = $1`,
        [company_id]
      );
      if (!co) return res.status(403).json({ success: false, message: 'الشركة غير موجودة' });

      let plan = co.plan || 'trial';
      // لو انتهت الفترة التجريبية → أساسي
      if (plan === 'trial' && co.subscription_expires_at && new Date(co.subscription_expires_at) < new Date()) {
        plan = 'basic';
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
