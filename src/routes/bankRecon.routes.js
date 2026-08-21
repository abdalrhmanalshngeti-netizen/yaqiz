const router         = require('express').Router();
const auth           = require('../middleware/auth');
const can            = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl           = require('../controllers/bankRecon.controller');

router.use(auth);
router.use(requireFeature('bank_recon'));

router.get('/', can('reports.view'), ctrl.get);
router.put('/', can('reports.view'), ctrl.update);

module.exports = router;
