const db = require('../config/db');

const PLAN_FEATURES = {
  basic:   [],
  growth:  ['employees','payroll','shifts','loyalty','import','activity_log','cashflow','custom_period','stock_moves','admin_expenses','ai_extract','ai_analyze'],
  pro:     ['employees','payroll','shifts','loyalty','import','activity_log','cashflow','custom_period','stock_moves','admin_expenses','ai_extract','ai_analyze','journal','income_statement','balance_sheet','trial_balance','bank_recon','aging_report','purchase_orders','period_compare','ai_assistant'],
  expired: [],
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
