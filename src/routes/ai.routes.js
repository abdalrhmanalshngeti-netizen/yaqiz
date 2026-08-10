const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/ai.controller');

router.use(auth);
router.post('/extract',                ctrl.extract);
router.post('/extract-bank-statement', ctrl.extractBankStatement);
router.post('/analyze',                ctrl.analyze);
router.post('/assistant',              ctrl.assistant);
router.get('/usage',                   ctrl.usage);

module.exports = router;
