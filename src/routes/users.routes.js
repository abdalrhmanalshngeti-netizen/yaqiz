const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/users.controller');

router.use(auth);

router.get ('/',       can('settings.view'),   ctrl.list);
router.post('/',       can('settings.edit'),   ctrl.create);
router.get ('/:id',    can('settings.view'),   ctrl.getOne);
router.put ('/:id',    can('settings.edit'),   ctrl.update);
router.delete('/:id',  can('settings.edit'),   ctrl.remove);
router.put ('/:id/password', can('settings.edit'), ctrl.changePassword);

module.exports = router;
