const router       = require('express').Router();
const auth         = require('../middleware/auth');
const can          = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl         = require('../controllers/customers.controller');

router.use(auth);

// القراءة تبقى متاحة لكل الباقات (بيانات قديمة قد تكون موجودة من ترقية سابقة، ولوحة
// التحكم تحتاج أرصدة العملاء لحساب الذمم المدينة) — الإضافة/التعديل فقط مقيّدة بالباقة
router.get ('/',                    can('customers.view'),   ctrl.list);
router.post('/',                    can('customers.edit'), requireFeature('customers'), ctrl.create);
router.get ('/:id',                 can('customers.view'),   ctrl.getOne);
router.put ('/:id',                 can('customers.edit'), requireFeature('customers'), ctrl.update);
router.delete('/:id',               can('customers.edit'), requireFeature('customers'), ctrl.remove);
router.get ('/:id/statement',       can('customers.view'),   ctrl.statement);

module.exports = router;
