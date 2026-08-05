const router      = require('express').Router();
const superAdmin  = require('../middleware/superAdmin');
const canAdmin    = require('../middleware/canAdmin');
const ctrl        = require('../controllers/admin.controller');
const { loginLimiter } = require('../middleware/rateLimiter');

// تسجيل دخول المدير العام — محمي بـ rate limit
router.post('/login', loginLimiter, ctrl.login);

// باقي الـ routes محمية بمصادقة موظف لوحة الإدارة
router.use(superAdmin);

// هوية الموظف الحالي — متاحة لأي موظف بغض النظر عن صلاحياته (لفحص الجلسة)
router.get('/me', ctrl.me);

// حساب الموظف نفسه — أي موظف يقدر يعدّل اسمه/إيميله/كلمة مروره بنفسه
router.put('/my-account', ctrl.updateMyAccount);

// فريقي — أي موظف مُعيَّن "مدير" على غيره يقدر يشوف تقرير نشاطهم
router.get('/my-team',              ctrl.listMyTeam);
router.get('/my-team/:id/activity', ctrl.getTeamMemberActivity);

// المالك الأصلي فقط — إدارة الموظفين نفسها لا تُوكَّل لأي موظف إطلاقاً
// (لو قدر موظف يدير صلاحيات غيره، يقدر يمنح نفسه أي صلاحية يبيها)
const ownerOnly = (req, res, next) => {
  if (req.admin?.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'هذه الصفحة للمالك فقط' });
  }
  next();
};
router.get('/employees',                     ownerOnly, ctrl.listEmployees);
router.post('/employees',                    ownerOnly, ctrl.createEmployee);
router.put('/employees/:id',                 ownerOnly, ctrl.updateEmployee);
router.put('/employees/:id/reset-password',  ownerOnly, ctrl.resetEmployeePassword);

// كل قسم بلوحة الإدارة صار صلاحية مستقلة يقدر المالك يوكّلها لأي موظف
router.get('/stats',                    canAdmin('dashboard'),     ctrl.stats);
router.get('/cost-analysis',            canAdmin('cost_analysis'), ctrl.costAnalysis);
router.get('/log',                      canAdmin('activity_log'),  ctrl.platformLog);
router.get('/plans',                    canAdmin('plans'),         ctrl.getPlans);
router.put('/companies/:id/status',     canAdmin('companies_manage'), ctrl.setCompanyStatus);
router.put('/companies/:id/plan',       canAdmin('companies_manage'), ctrl.setCompanyPlan);

// صلاحية "عرض بيانات العملاء والشركات"
router.get('/companies',                canAdmin('customers'), ctrl.companies);
router.get('/companies/:id',            canAdmin('customers'), ctrl.companyDetails);
router.get('/new-clients',              canAdmin('customers'), ctrl.newClients);
router.get('/users',                    canAdmin('customers'), ctrl.listUsers);

// صلاحية "تذاكر الدعم الفني"
router.get('/tickets',                  canAdmin('tickets'), ctrl.listTickets);
router.get('/tickets/:id',              canAdmin('tickets'), ctrl.getTicket);
router.put('/tickets/:id/status',       canAdmin('tickets'), ctrl.updateTicketStatus);
router.post('/tickets/:id/claim',       canAdmin('tickets'), ctrl.claimTicket);
router.post('/tickets/:id/reply',       canAdmin('tickets'), ctrl.replyTicket);

// صلاحية "الدخول بحساب الشركة"
router.post('/impersonate/:company_id', canAdmin('impersonate'), ctrl.impersonate);

// إشعارات لوحة الإدارة — كل موظف يشوف إشعاراته الخاصة فقط، بدون فحص صلاحية إضافي
router.get('/notifications',              ctrl.listNotifications);
router.get('/notifications/unread-count', ctrl.unreadNotifCount);
router.put('/notifications/read-all',     ctrl.markAllNotifRead);

module.exports = router;
