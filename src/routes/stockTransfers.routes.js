const router = require('express').Router();
const auth   = require('../middleware/auth');
const requireBranch = require('../middleware/requireBranch');
const ctrl   = require('../controllers/stockTransfers.controller');

router.use(auth);

router.get ('/',    ctrl.list);
router.get ('/:id', ctrl.getOne);
router.post('/',    requireBranch, ctrl.create);

module.exports = router;
