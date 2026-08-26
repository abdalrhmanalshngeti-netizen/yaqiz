const router = require('express').Router();
const auth   = require('../middleware/auth');
const requireBranch = require('../middleware/requireBranch');
const ctrl   = require('../controllers/stockTransfers.controller');

router.use(auth);

// القراءة متاحة لأي مستخدم بالشركة (يحتاجها أي موظف بالفرع لمعرفة/متابعة نقل
// المخزون)؛ الكتابة owner-only — يُفرض داخل الكنترولر نفسه (نفس أسلوب
// branches.controller.js/warehouses.controller.js)
router.get ('/',    ctrl.list);
router.get ('/:id', ctrl.getOne);
router.post('/',    requireBranch, ctrl.create);

module.exports = router;
