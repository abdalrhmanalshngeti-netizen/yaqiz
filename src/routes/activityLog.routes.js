const router       = require('express').Router();
const auth         = require('../middleware/auth');
const can          = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl         = require('../controllers/activityLog.controller');

router.use(auth);
router.get('/', can('reports.view'), requireFeature('activity_log'), ctrl.list);

module.exports = router;
