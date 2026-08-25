const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/users.controller');
const { loginLimiter } = require('../middleware/rateLimiter');

router.use(auth);

// أي موظف مسجّل دخول يعلّم جولته التعليمية كمشاهَدة لحسابه الخاص فقط —
// قبل مسار /:id عشان توضيح النية، لا يتعارض معه لاختلاف عدد الأجزاء بالمسار
router.put ('/me/tours-seen', ctrl.updateToursSeen);

// كانت مقيَّدة بـsettings.edit/settings.view بدل users.view/users.manage
// المخصَّصتين لهذا الغرض تحديدًا — نفس الخلط الحاصل بـemployees.routes.js
// (راجع تعليقه)؛ الواجهة أصلًا تتحقق من has('users.manage') لإظهار أزرار
// إدارة المستخدمين، فكانت هذي الصلاحية عديمة الفائدة عمليًا لأي دور غير المالك
router.get ('/',       can('users.view'),      ctrl.list);
router.post('/',       can('users.manage'),    ctrl.create);
router.get ('/:id',    can('users.view'),      ctrl.getOne);
router.put ('/:id',    can('users.manage'),    ctrl.update);
router.delete('/:id',  can('users.manage'),    ctrl.remove);
// أي موظف مسجّل دخول يقدر يغيّر كلمة مروره الخاصة — الكنترولر نفسه يتحقق
// من كلمة المرور الحالية للتغيير الذاتي، ويشترط صلاحية owner لتغيير كلمة مرور غيره.
// لا نشترط settings.edit هنا وإلا صار موظف عادي بلا هذي الصلاحية غير قادر
// على تغيير كلمة مروره الخاصة إطلاقاً. rate-limited لأنها تتحقق من كلمة مرور حالية.
router.put ('/:id/password', loginLimiter, ctrl.changePassword);

module.exports = router;
