const router = require('express').Router();
const auth   = require('../middleware/auth');
const { printInvoice } = require('../controllers/print.controller');

router.get('/invoice/:id', auth, printInvoice);

module.exports = router;
