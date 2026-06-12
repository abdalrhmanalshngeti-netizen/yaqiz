const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/suppliers.controller');

router.use(auth);

router.get ('/',              can('purchases.view'),   ctrl.list);
router.post('/',              can('purchases.edit'),   ctrl.create);
router.get ('/:id',           can('purchases.view'),   ctrl.getOne);
router.put ('/:id',           can('purchases.edit'),   ctrl.update);
router.delete('/:id',         can('purchases.edit'),   ctrl.remove);
router.get ('/:id/statement', can('purchases.view'),   ctrl.statement);

module.exports = router;
