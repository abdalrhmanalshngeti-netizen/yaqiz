const router = require('express').Router();
const auth   = require('../middleware/auth');
const { registerLimiter } = require('../middleware/rateLimiter');
const ctrl   = require('../controllers/support.controller');

// نموذج عام بلا تسجيل دخول — كان يعتمد فقط على الحد العام (300 طلب/دقيقة)
// المصمَّم لاستخدام التطبيق الطبيعي، لا لصد إغراق نموذج عام لمهاجم واحد؛
// نفس فئة الحماية المستخدَمة أصلًا لتسجيل حساب جديد (5/ساعة لكل IP)
router.post('/public',              registerLimiter, ctrl.createPublicTicket);
router.post('/ticket',              auth, ctrl.createTicket);
router.get('/tickets',              auth, ctrl.listCompanyTickets);
router.put('/tickets/:id/status',   auth, ctrl.updateCompanyTicketStatus);

module.exports = router;
