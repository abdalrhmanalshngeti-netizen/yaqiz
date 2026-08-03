const router     = require('express').Router();
const auth       = require('../middleware/auth');
const can        = require('../middleware/permissions');
const planGuard  = require('../middleware/planGuard');
const ctrl       = require('../controllers/employees.controller');

router.use(auth);

// Shifts — متاحة لكل الباقات (مو ميزة employees)، لازم تُعرَّف قبل planGuard
router.get ('/shifts/list',       can('settings.view'),  ctrl.listShifts);
router.post('/shifts/open',       ctrl.openShift);
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
