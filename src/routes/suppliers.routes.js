const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/suppliers.controller');

router.use(auth);

// كانت مقيَّدة بـpurchases.view/purchases.edit بدل suppliers.view/suppliers.manage
// المخصَّصتين لهذا الغرض تحديدًا — الواجهة أصلًا تستخدم has('suppliers.manage')
// لإظهار أزرار إضافة/تعديل/تعطيل مورد (بقالب "مدير مشتريات" اللي كان معطَّلًا
// كليًا لهذا السبب بالضبط)، لا purchases.edit الذي لم يكن قابلاً للمنح أصلًا
router.get ('/',              can('suppliers.view'),   ctrl.list);
router.post('/',              can('suppliers.manage'), ctrl.create);
router.get ('/:id',           can('suppliers.view'),   ctrl.getOne);
router.put ('/:id',           can('suppliers.manage'), ctrl.update);
router.delete('/:id',         can('suppliers.manage'), ctrl.remove);
router.get ('/:id/statement', can('suppliers.view'),   ctrl.statement);

module.exports = router;
