const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/creditNotes.controller');

router.use(auth);

// إشعارات الدائن تُنشأ تلقائيًا فقط (إلغاء فاتورة / مرتجع مرتبط) — لا إنشاء أو
// تعديل أو حذف يدوي هنا، فقط عرض المستندات الموثَّقة أصلًا
router.get('/',    can('sales.view'), ctrl.list);
router.get('/:id', can('sales.view'), ctrl.getOne);

module.exports = router;
