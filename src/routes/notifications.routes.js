const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/notifications.controller');

router.use(auth);

router.get ('/',             ctrl.list);
router.get ('/unread-count', ctrl.unreadCount);
router.put ('/mark-all-read', ctrl.markAllRead);
router.put ('/:id/read',     ctrl.markOneRead);

module.exports = router;
