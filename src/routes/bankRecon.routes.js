const router         = require('express').Router();
const auth           = require('../middleware/auth');
const can            = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl           = require('../controllers/bankRecon.controller');

router.use(auth);
router.use(requireFeature('bank_recon'));

router.get('/', can('reports.view'),   ctrl.get);
// كانت الكتابة أيضًا مقيَّدة بـreports.view (صلاحية عرض فقط)، يحملها أدوار
// مقصودة كقراءة فقط مثل "مراجع حسابات"/"مشرف مخزون" — نفس فئة الباغ المُصلَحة
// سابقًا بحذف قيد اليومية؛ لا يوجد صلاحية bank_recon مخصَّصة، فأقرب صلاحية
// كتابة ذات صلة فعلية هي إدارة الخزينة
router.put('/', can('treasury.manage'), ctrl.update);

module.exports = router;
