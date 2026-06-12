const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/invoices.controller');

router.use(auth);

router.get ('/',           can('sales.view'),    ctrl.list);
router.post('/',           can('sales.create'),  ctrl.create);
router.get ('/:id',        can('sales.view'),    ctrl.getOne);
router.put ('/:id',        can('sales.edit'),    ctrl.update);
router.delete('/:id',      can('sales.delete'),  ctrl.remove);
router.post('/:id/payment',can('sales.edit'),    ctrl.addPayment);
router.post('/:id/cancel', can('sales.delete'),  ctrl.cancel);

module.exports = router;
