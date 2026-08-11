const router       = require('express').Router();
const auth         = require('../middleware/auth');
const can          = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl         = require('../controllers/purchaseOrders.controller');

router.use(auth);
router.use(requireFeature('purchase_orders'));

router.get   ('/',        can('purchases.view'),   ctrl.list);
router.post  ('/',        can('purchases.create'), ctrl.create);
router.put   ('/:id',     can('purchases.create'), ctrl.updateStatus);
router.delete('/:id',     can('purchases.create'), ctrl.remove);

module.exports = router;
