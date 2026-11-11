const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const requireBranch = require('../middleware/requireBranch');
const ctrl   = require('../controllers/purchases.controller');

router.use(auth);
// أي صلاحية من القائمة — سند قبض/صرف من المحاسب يحدّث مدفوع الفاتورة المربوطة ورصيد
// الطرف عبر هذا المسار؛ كان مقصورًا على صلاحية المبيعات/المشتريات فيرجع 403 بصمت،
// فيوصل القيد والخزينة وتبقى الفاتورة غير مسددة ورصيد المورد/العميل قديم
const canAny = (...ps) => (req, res, next) => {
  const perms = req.user.perms || [];
  if (req.user.role === 'owner' || ps.some(p => perms.includes(p))) return next();
  return res.status(403).json({ success: false, message: 'ليس لديك صلاحية لهذه العملية' });
};

router.get ('/',             can('purchases.view'),   ctrl.list);
// مصروف تشغيلي ناتج عن سداد التزام (المحاسب عنده إدارة الالتزامات بدون إنشاء مشتريات) —
// كان يرجع 403 فيوصل القيد والخزينة بدون سجل المصروف، فتنقص "مشتريات الشهر"
const canCreatePurchase = (req, res, next) => {
  const perms = req.user.perms || [];
  if (req.user.role === 'owner' || perms.includes('purchases.create')) return next();
  // المحاسب (إدارة الحسابات) يسجّل المصاريف العامة — بدون صلاحية مشتريات البضاعة
  if (req.body?.purchase_type === 'opex' && perms.includes('accounts.manage')) return next();
  if (req.body?.purchase_type === 'opex' && perms.includes('obligations.manage')
      && /^OBL-/.test(String(req.body?.supplier_ref || ''))) return next();
  return res.status(403).json({ success: false, message: 'ليس لديك صلاحية لهذه العملية' });
};
router.post('/',             canCreatePurchase, requireBranch, ctrl.create);
router.get ('/:id',          can('purchases.view'),   ctrl.getOne);
router.put ('/:id',          can('purchases.edit'),   ctrl.update);
router.post('/:id/payment',  canAny('purchases.edit', 'receipts.manage'),   ctrl.addPayment);
router.post('/:id/payment-reversal', canAny('purchases.edit', 'receipts.manage'), ctrl.reversePayment);
// تصحيح بقيد عكسي — أثره محاسبي كامل، فبصلاحية إدارة الحسابات (المالك دائمًا)
router.post('/:id/reverse', can('accounts.manage'), ctrl.reverse);

module.exports = router;
