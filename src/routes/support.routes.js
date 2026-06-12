const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/support.controller');

router.post('/ticket', auth, ctrl.createTicket);

module.exports = router;
