const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/purchases.controller');

router.use(auth);

router.get ('/',             can('purchases.view'),   ctrl.list);
router.post('/',             can('purchases.create'), ctrl.create);
router.get ('/:id',          can('purchases.view'),   ctrl.getOne);
router.put ('/:id',          can('purchases.edit'),   ctrl.update);
router.post('/:id/payment',  can('purchases.edit'),   ctrl.addPayment);

module.exports = router;
