const router       = require('express').Router();
const auth         = require('../middleware/auth');
const can          = require('../middleware/permissions');
const requireFeature = require('../middleware/planGuard');
const ctrl         = require('../controllers/reports.controller');

router.use(auth);
router.use(can('reports.view'));

router.get('/dashboard',         ctrl.dashboard);
router.get('/vat',               ctrl.vatReport);
router.get('/income-statement',  requireFeature('income_statement'), ctrl.incomeStatement);
router.get('/balance-sheet',     requireFeature('balance_sheet'),    ctrl.balanceSheet);
router.get('/aging/customers',   requireFeature('aging_report'),     ctrl.customerAging);
router.get('/aging/suppliers',   requireFeature('aging_report'),     ctrl.supplierAging);
router.get('/low-stock',         ctrl.lowStock);
router.get('/branch-performance', ctrl.branchPerformance);

module.exports = router;
