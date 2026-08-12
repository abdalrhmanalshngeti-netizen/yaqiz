const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/zatcaOnboarding.controller');

router.get ('/onboarding/status',      auth, ctrl.status);
router.post('/onboarding/compliance',  auth, ctrl.requestCompliance);
router.post('/onboarding/production',  auth, ctrl.requestProduction);
router.post('/invoices/:invoiceId/submit', auth, ctrl.submitInvoiceToZatca);

module.exports = router;
