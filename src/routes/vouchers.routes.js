const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/vouchers.controller');

router.use(auth);

router.get   ('/',    can('receipts.view'),   ctrl.list);
router.post  ('/',    can('receipts.manage'), ctrl.create);
router.delete('/:id', can('receipts.manage'), ctrl.remove);

module.exports = router;
