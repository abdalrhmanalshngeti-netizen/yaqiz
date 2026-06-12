const router = require('express').Router();
const ctrl   = require('../controllers/register.controller');
const { registerLimiter } = require('../middleware/rateLimiter');

// لا يحتاج authentication — مفتوح للعموم
router.post('/', registerLimiter, ctrl.register);

module.exports = router;
