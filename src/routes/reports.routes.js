const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/reports.controller');

router.use(auth);
router.use(can('reports.view'));

router.get('/dashboard',         ctrl.dashboard);
router.get('/vat',               ctrl.vatReport);
router.get('/income-statement',  ctrl.incomeStatement);
router.get('/balance-sheet',     ctrl.balanceSheet);
router.get('/aging/customers',   ctrl.customerAging);
router.get('/aging/suppliers',   ctrl.supplierAging);
router.get('/low-stock',         ctrl.lowStock);

module.exports = router;
