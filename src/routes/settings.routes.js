const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/settings.controller');

router.use(auth);

router.get('/', ctrl.getAll);
router.put('/', ctrl.upsert); // الكنترولر نفسه يشترط دور المالك

module.exports = router;
