const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/products.controller');

router.use(auth);

router.get ('/',             can('inventory.view'),   ctrl.list);
router.post('/',             can('inventory.edit'),   ctrl.create);
router.get ('/stock-moves/list', can('inventory.view'), ctrl.listAllMoves);
router.get ('/:id',          can('inventory.view'),   ctrl.getOne);
router.put ('/:id',          can('inventory.edit'),   ctrl.update);
router.delete('/:id',        can('inventory.edit'),   ctrl.remove);
router.get ('/:id/moves',          can('inventory.view'),   ctrl.stockMoves);
router.post('/:id/move',           can('inventory.edit'),   ctrl.manualMove);
router.put ('/:id/pricing-policy', can('pricing.manage'),   ctrl.setPricingPolicy);
router.get ('/:id/price-history',  can('inventory.view'),   ctrl.getPriceHistory);

module.exports = router;
