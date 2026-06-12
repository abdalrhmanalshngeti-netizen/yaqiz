const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/treasury.controller');

router.use(auth);

// Accounts
router.get ('/accounts',          can('treasury.view'),   ctrl.listAccounts);
router.post('/accounts',          can('treasury.edit'),   ctrl.createAccount);
router.put ('/accounts/:id',      can('treasury.edit'),   ctrl.updateAccount);
router.post('/transfer',          can('treasury.edit'),   ctrl.transfer);

// Moves
router.get ('/moves',             can('treasury.view'),   ctrl.listMoves);

// Vouchers
router.get ('/vouchers',          can('receipts.view'),   ctrl.listVouchers);
router.post('/vouchers',          can('receipts.edit'),   ctrl.createVoucher);
router.get ('/vouchers/:id',      can('receipts.view'),   ctrl.getVoucher);

module.exports = router;
