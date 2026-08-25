const router     = require('express').Router();
const auth       = require('../middleware/auth');
const can        = require('../middleware/permissions');
const planGuard  = require('../middleware/planGuard');
const requireBranch = require('../middleware/requireBranch');
const ctrl       = require('../controllers/employees.controller');

router.use(auth);

// Shifts — متاحة لكل الباقات (مو ميزة employees)، لازم تُعرَّف قبل planGuard
// كل موظف يقدر يجيب وردياته هو نفسه (يحتاجها عند الدخول ليعرف إن كانت له
// وردية مفتوحة أصلاً)؛ رؤية ورديات كل الموظفين تبقى محصورة بصلاحية settings.view
router.get ('/shifts/list',       ctrl.listShifts);
router.post('/shifts/open',       requireBranch, ctrl.openShift);
router.put ('/shifts/:id/close',  ctrl.closeShift);

router.use(planGuard('employees'));

// كانت هذي المسارات كلها مقيَّدة بـsettings.edit/settings.view — صلاحية عامة
// لإعدادات الشركة لا علاقة لها بالموظفين، رغم وجود employees.view/employees.manage
// المخصَّصتين لهذا الغرض تحديدًا أصلًا بقائمة الصلاحيات القابلة للمنح (تُستخدَمان
// فعليًا لإخفاء/إظهار أزرار "إضافة موظف" بالواجهة، ومقدَّمتان جاهزتين ضمن قالب
// "مدير الموارد البشرية" — كان هذا القالب معطَّلًا كليًا بلا أي طريقة لتفعيله)
router.get ('/',                  can('employees.view'),   ctrl.list);
router.post('/',                  can('employees.manage'), ctrl.create);
router.get ('/:id',               can('employees.view'),   ctrl.getOne);
router.put ('/:id',               can('employees.manage'), ctrl.update);
router.delete('/:id',             can('employees.manage'), ctrl.remove);

// Payroll
router.get ('/payroll/list',      can('reports.view'),     ctrl.listPayroll);
router.post('/payroll/generate',  can('employees.manage'), ctrl.generatePayroll);
router.put ('/payroll/:id/pay',   can('employees.manage'), ctrl.markPayrollPaid);

module.exports = router;
