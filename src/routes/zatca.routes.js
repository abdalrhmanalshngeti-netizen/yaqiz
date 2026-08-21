const router = require('express').Router();
const auth = require('../middleware/auth');
const can  = require('../middleware/permissions');
const ctrl = require('../controllers/zatcaOnboarding.controller');

router.get ('/onboarding/status',      auth, ctrl.status);
router.post('/onboarding/compliance',  auth, ctrl.requestCompliance);
router.post('/onboarding/production',  auth, ctrl.requestProduction);
// إرسال فعلي (شبه لا رجعة فيه) لفاتورة/إشعار دائن للهيئة — يتطلب نفس صلاحية
// التعديل على الفواتير، لا أي مستخدم مسجّل دخول بغضّ النظر عن دوره
router.post('/invoices/:invoiceId/submit', auth, can('sales.edit'), ctrl.submitInvoiceToZatca);
router.post('/credit-notes/:noteId/submit', auth, can('sales.edit'), ctrl.submitCreditNoteToZatca);
router.get ('/pending',                auth, ctrl.pendingDocuments);

module.exports = router;
