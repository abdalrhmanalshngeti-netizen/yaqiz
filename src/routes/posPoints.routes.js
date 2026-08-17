const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/posPoints.controller');

router.use(auth);

router.get ('/',      ctrl.list);
router.get ('/:id',   ctrl.getOne);
router.post('/',      ctrl.create);
router.put ('/:id',   ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
