const router         = require('express').Router();
const auth           = require('../middleware/auth');
const can            = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl           = require('../controllers/loyalty.controller');

router.use(auth);
router.use(requireFeature('loyalty'));

router.get ('/',          can('customers.view'),   ctrl.get);
router.put ('/settings',  can('customers.edit'), ctrl.updateSettings);
router.post('/points',    can('customers.edit'), ctrl.addPoints);
router.post('/redeem',    can('customers.edit'), ctrl.redeem);

module.exports = router;
