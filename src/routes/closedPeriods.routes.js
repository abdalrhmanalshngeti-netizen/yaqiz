const router       = require('express').Router();
const auth         = require('../middleware/auth');
const can          = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl         = require('../controllers/closedPeriods.controller');
const { loginLimiter } = require('../middleware/rateLimiter');

router.use(auth);

router.get   ('/',              can('accounts.close_period'), requireFeature('period_close'), ctrl.list);
router.post  ('/',              can('accounts.close_period'), requireFeature('period_close'), ctrl.create);
router.delete('/:id',           can('accounts.close_period'), requireFeature('period_close'), ctrl.remove);

// كلمة مرور التجاوز — منفصلة عن كلمة مرور دخول المالك
router.get ('/override-password/status', ctrl.overridePasswordStatus);
router.put ('/override-password',        loginLimiter, ctrl.setOverridePassword);
router.post('/verify-override',          loginLimiter, ctrl.verifyOverridePassword);

module.exports = router;
