const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const requireBranch = require('../middleware/requireBranch');
const ctrl   = require('../controllers/invoices.controller');

router.use(auth);
// أي صلاحية من القائمة — سند قبض/صرف من المحاسب يحدّث مدفوع الفاتورة المربوطة ورصيد
// الطرف عبر هذا المسار؛ كان مقصورًا على صلاحية المبيعات/المشتريات فيرجع 403 بصمت،
// فيوصل القيد والخزينة وتبقى الفاتورة غير مسددة ورصيد المورد/العميل قديم
const canAny = (...ps) => (req, res, next) => {
  const perms = req.user.perms || [];
  if (req.user.role === 'owner' || ps.some(p => perms.includes(p))) return next();
  return res.status(403).json({ success: false, message: 'ليس لديك صلاحية لهذه العملية' });
};

router.get ('/',           can('sales.view'),    ctrl.list);
router.post('/',           can('sales.create'),  requireBranch, ctrl.create);
router.get ('/:id',        can('sales.view'),    ctrl.getOne);
router.put ('/:id',        can('sales.edit'),    ctrl.update);
router.delete('/:id',      can('sales.delete'),  ctrl.remove);
router.post('/:id/payment',canAny('sales.edit', 'receipts.manage'),    ctrl.addPayment);
router.post('/:id/payment-reversal', canAny('sales.edit', 'receipts.manage'), ctrl.reversePayment);
router.post('/:id/cancel', can('sales.delete'),  ctrl.cancel);

module.exports = router;
