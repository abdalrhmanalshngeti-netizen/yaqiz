const router = require('express').Router();
const auth = require('../middleware/auth');
const can  = require('../middleware/permissions');
const ctrl = require('../controllers/activityLog.controller');

router.use(auth);
router.get('/', can('reports.view'), ctrl.list);

module.exports = router;
