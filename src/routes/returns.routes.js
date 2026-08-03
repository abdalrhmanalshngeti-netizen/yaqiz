const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/returns.controller');

router.use(auth);

router.get   ('/',    can('returns.view'),   ctrl.list);
router.post  ('/',    can('returns.manage'), ctrl.create);
router.delete('/:id', can('returns.manage'), ctrl.remove);

module.exports = router;
