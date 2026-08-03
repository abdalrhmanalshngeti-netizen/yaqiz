const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/journal.controller');

router.use(auth);

router.get   ('/',    can('reports.view'), ctrl.list);
router.post  ('/',    can('reports.view'), ctrl.create);
router.delete('/:id', can('reports.view'), ctrl.remove);

module.exports = router;
