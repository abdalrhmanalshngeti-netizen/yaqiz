const { PLAN_FEATURES } = require('../middleware/planGuard');

// نفس الأقسام اللي تُخفى/تُظهر بمعالج الأرصدة الافتتاحية بالواجهة حسب الباقة
// (راجع _obActiveSteps بـVVIP.html) — لو باقة جديدة تفتح أحدها ولم تكن متاحة
// بالباقة القديمة، فهذا يعني أن الشركة ربما عندها أرصدة سابقة بهذا الجانب
// (عملاء مدينون، التزامات مستحقة، رواتب موظفين) لم تُسجَّل وقت تعبئة المعالج
// أول مرة لأن الباقة القديمة كانت تُخفي خطوته بالكامل
const OB_RELEVANT_FEATURES = [
  { key: 'customers',   label: 'أرصدة العملاء' },
  { key: 'obligations', label: 'الالتزامات الدورية' },
  { key: 'employees',   label: 'بيانات الموظفين' },
];

// تُستدعى بعد أي تغيير فعلي لباقة شركة (ترقية ذاتية عبر الدفع، أو تغيير يدوي
// من لوحة إدارة المنصة) — إن فتحت الباقة الجديدة قسمًا من أقسام الأرصدة
// الافتتاحية لم يكن متاحًا بالباقة القديمة، وكانت الشركة قد أكملت المعالج
// من قبل أصلًا (وإلا فالمعالج نفسه سيعرض القسم تلقائيًا أول مرة يُفتح فيها)،
// نرسل إشعارًا حقيقيًا لمالك الحساب يدعوه لمراجعة الأرصدة الافتتاحية وتحديثها
async function notifyPlanUpgradeOpeningBalances(client, companyId, oldPlan, newPlan) {
  try {
    if (!oldPlan || !newPlan || oldPlan === newPlan) return;
    const before = PLAN_FEATURES[oldPlan] || [];
    const after  = PLAN_FEATURES[newPlan]  || [];
    const unlocked = OB_RELEVANT_FEATURES.filter(f => !before.includes(f.key) && after.includes(f.key));
    if (!unlocked.length) return;

    const { rows: [obSetting] } = await client.query(
      `SELECT value FROM settings WHERE company_id = $1 AND key = 'opening_balances_done'`,
      [companyId]
    );
    if (!obSetting || obSetting.value !== 'true') return;

    // بلا تكرار: طالما فيه إشعار سابق من نفس النوع لم يُقرأ بعد، لا داعي لإشعار
    // جديد حتى لو حصلت ترقية أخرى قبل أن يتفقد المالك الإشعار الأول
    const { rows: existing } = await client.query(
      `SELECT id FROM notifications WHERE company_id = $1 AND type = 'plan_upgrade_opening_balances' AND is_read = false LIMIT 1`,
      [companyId]
    );
    if (existing.length) return;

    const { rows: owners } = await client.query(
      `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND active = true`,
      [companyId]
    );
    if (!owners.length) return;

    const names = unlocked.map(f => f.label).join('، ');
    const message = `ترقية باقتك فتحت لك تسجيل: ${names}. إذا كانت عندك أرصدة سابقة بهذا الجانب من قبل الترقية، راجع "الأرصدة الافتتاحية" من الإعدادات وحدّثها حتى تبقى تقاريرك المالية دقيقة.`;
    for (const owner of owners) {
      await client.query(
        `INSERT INTO notifications (company_id, user_id, type, title, message, link)
         VALUES ($1,$2,'plan_upgrade_opening_balances','باقتك الجديدة تتيح أرصدة إضافية',$3,'/VVIP.html#settings')`,
        [companyId, owner.id, message]
      );
    }
  } catch (e) {
    console.error('[planUpgrade] failed to notify opening balances unlock:', e.message);
  }
}

module.exports = { notifyPlanUpgradeOpeningBalances };
