const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/users.controller');
const { loginLimiter } = require('../middleware/rateLimiter');

router.use(auth);

// أي موظف مسجّل دخول يعلّم جولته التعليمية كمشاهَدة لحسابه الخاص فقط —
// قبل مسار /:id عشان توضيح النية، لا يتعارض معه لاختلاف عدد الأجزاء بالمسار
router.put ('/me/tours-seen', ctrl.updateToursSeen);

router.get ('/',       can('settings.view'),   ctrl.list);
router.post('/',       can('settings.edit'),   ctrl.create);
router.get ('/:id',    can('settings.view'),   ctrl.getOne);
router.put ('/:id',    can('settings.edit'),   ctrl.update);
router.delete('/:id',  can('settings.edit'),   ctrl.remove);
// أي موظف مسجّل دخول يقدر يغيّر كلمة مروره الخاصة — الكنترولر نفسه يتحقق
// من كلمة المرور الحالية للتغيير الذاتي، ويشترط صلاحية owner لتغيير كلمة مرور غيره.
// لا نشترط settings.edit هنا وإلا صار موظف عادي بلا هذي الصلاحية غير قادر
// على تغيير كلمة مروره الخاصة إطلاقاً. rate-limited لأنها تتحقق من كلمة مرور حالية.
router.put ('/:id/password', loginLimiter, ctrl.changePassword);

module.exports = router;
