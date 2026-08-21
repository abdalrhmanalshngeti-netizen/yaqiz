const router       = require('express').Router();
const auth         = require('../middleware/auth');
const can          = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl         = require('../controllers/quotes.controller');

router.use(auth);

router.get ('/',             can('quotes.view'),   ctrl.list);
router.post('/',             can('quotes.manage'), requireFeature('quotes'), ctrl.create);
router.get ('/:id',          can('quotes.view'),   ctrl.getOne);
router.put ('/:id',          can('quotes.manage'), requireFeature('quotes'), ctrl.update);
router.delete('/:id',        can('quotes.manage'), requireFeature('quotes'), ctrl.remove);
router.post('/:id/convert',  can('quotes.manage'), requireFeature('quotes'), ctrl.convert);

module.exports = router;
