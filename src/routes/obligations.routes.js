const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/obligations.controller');

router.use(auth);

router.get ('/',    can('obligations.view'),   ctrl.list);
router.post('/',    can('obligations.manage'),   ctrl.create);
router.put ('/:id', can('obligations.manage'),   ctrl.update);
router.delete('/:id', can('obligations.manage'), ctrl.remove);

module.exports = router;
