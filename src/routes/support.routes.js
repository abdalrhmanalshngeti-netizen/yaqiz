const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/support.controller');

router.post('/ticket',              auth, ctrl.createTicket);
router.get('/tickets',              auth, ctrl.listCompanyTickets);
router.put('/tickets/:id/status',   auth, ctrl.updateCompanyTicketStatus);

module.exports = router;
