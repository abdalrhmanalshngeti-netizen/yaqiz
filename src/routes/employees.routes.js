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

router.get ('/',                  can('settings.view'),  ctrl.list);
router.post('/',                  can('settings.edit'),  ctrl.create);
router.get ('/:id',               can('settings.view'),  ctrl.getOne);
router.put ('/:id',               can('settings.edit'),  ctrl.update);
router.delete('/:id',             can('settings.edit'),  ctrl.remove);

// Payroll
router.get ('/payroll/list',      can('reports.view'),   ctrl.listPayroll);
router.post('/payroll/generate',  can('settings.edit'),  ctrl.generatePayroll);
router.put ('/payroll/:id/pay',   can('settings.edit'),  ctrl.markPayrollPaid);

module.exports = router;
