const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/quotes.controller');

router.use(auth);

router.get ('/',             can('quotes.view'),   ctrl.list);
router.post('/',             can('quotes.manage'), ctrl.create);
router.get ('/:id',          can('quotes.view'),   ctrl.getOne);
router.put ('/:id',          can('quotes.manage'), ctrl.update);
router.delete('/:id',        can('quotes.manage'), ctrl.remove);
router.post('/:id/convert',  can('quotes.manage'), ctrl.convert);

module.exports = router;
