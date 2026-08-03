const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/purchaseOrders.controller');

router.use(auth);

router.get   ('/',        can('purchases.view'),   ctrl.list);
router.post  ('/',        can('purchases.create'), ctrl.create);
router.put   ('/:id',     can('purchases.create'), ctrl.updateStatus);
router.delete('/:id',     can('purchases.create'), ctrl.remove);

module.exports = router;
