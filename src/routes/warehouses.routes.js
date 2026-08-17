const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/warehouses.controller');

router.use(auth);

router.get ('/',    ctrl.list);
router.get ('/:id', ctrl.getOne);
router.post('/',    ctrl.create);
router.put ('/:id', ctrl.update);

module.exports = router;
