const router      = require('express').Router();
const superAdmin  = require('../middleware/superAdmin');
const ctrl        = require('../controllers/admin.controller');
const { loginLimiter } = require('../middleware/rateLimiter');

// تسجيل دخول المدير العام — محمي بـ rate limit
router.post('/login', loginLimiter, ctrl.login);

// باقي الـ routes محمية
router.use(superAdmin);

router.get('/stats',                    ctrl.stats);
router.get('/companies',                ctrl.companies);
router.get('/companies/:id',            ctrl.companyDetails);
router.put('/companies/:id/status',     ctrl.setCompanyStatus);
router.get('/cost-analysis',            ctrl.costAnalysis);
router.get('/log',                      ctrl.platformLog);
router.get('/new-clients',              ctrl.newClients);
router.get('/tickets',                  ctrl.listTickets);
router.get('/tickets/:id',              ctrl.getTicket);
router.put('/tickets/:id/status',       ctrl.updateTicketStatus);
router.get('/users',                    ctrl.listUsers);
router.post('/impersonate/:company_id', ctrl.impersonate);
router.get('/plans',                    ctrl.getPlans);
router.put('/companies/:id/plan',       ctrl.setCompanyPlan);

module.exports = router;
