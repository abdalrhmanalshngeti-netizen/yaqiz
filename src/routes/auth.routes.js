const router = require('express').Router();
const { loginLimiter, registerLimiter } = require('../middleware/rateLimiter');
const auth     = require('../middleware/auth');
const ctrl     = require('../controllers/auth.controller');
const emailCtrl = require('../controllers/email.controller');

router.post('/login',                loginLimiter, ctrl.login);
router.post('/forgot-password',      registerLimiter, emailCtrl.forgotPassword);
router.post('/reset-password',       emailCtrl.resetPassword);
router.post('/logout',               ctrl.logout);
router.post('/refresh',              ctrl.refreshToken);
router.get ('/me',                   auth, ctrl.me);
router.post('/redeem-imp',           ctrl.redeemImpersonation);
router.get ('/admin-accesses',       auth, ctrl.getAdminAccesses);
router.post('/revoke-admin-sessions',auth, ctrl.revokeAdminSessions);

module.exports = router;
