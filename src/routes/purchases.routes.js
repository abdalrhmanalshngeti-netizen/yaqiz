const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const requireBranch = require('../middleware/requireBranch');
const ctrl   = require('../controllers/purchases.controller');

router.use(auth);

router.get ('/',             can('purchases.view'),   ctrl.list);
router.post('/',             can('purchases.create'), requireBranch, ctrl.create);
router.get ('/:id',          can('purchases.view'),   ctrl.getOne);
router.put ('/:id',          can('purchases.edit'),   ctrl.update);
router.post('/:id/payment',  can('purchases.edit'),   ctrl.addPayment);
router.post('/:id/payment-reversal', can('purchases.edit'), ctrl.reversePayment);
// تصحيح بقيد عكسي — أثره محاسبي كامل، فبصلاحية إدارة الحسابات (المالك دائمًا)
router.post('/:id/reverse', can('accounts.manage'), ctrl.reverse);

module.exports = router;
