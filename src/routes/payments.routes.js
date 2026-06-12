const router = require('express').Router();
const ctrl   = require('../controllers/payments.controller');
const auth   = require('../middleware/auth');

router.post('/create',   auth, ctrl.createPayment);
router.get('/status',    auth, ctrl.getStatus);

module.exports = router;
