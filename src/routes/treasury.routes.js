const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/treasury.controller');

router.use(auth);

// Accounts
router.get ('/accounts',          can('treasury.view'),   ctrl.listAccounts);
router.post('/accounts',          can('treasury.manage'), ctrl.createAccount);
router.put ('/accounts/:id',      can('treasury.manage'), ctrl.updateAccount);
router.post('/transfer',          can('treasury.manage'), ctrl.transfer);

// Moves
router.get ('/moves',             can('treasury.view'),   ctrl.listMoves);
router.post('/move',              can('treasury.manage'), ctrl.addMove);

// Vouchers
router.get ('/vouchers',          can('receipts.view'),   ctrl.listVouchers);
router.post('/vouchers',          can('receipts.manage'), ctrl.createVoucher);
router.get ('/vouchers/:id',      can('receipts.view'),   ctrl.getVoucher);

module.exports = router;
