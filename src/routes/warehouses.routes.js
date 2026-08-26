const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/warehouses.controller');

router.use(auth);

// القراءة متاحة لأي مستخدم بالشركة (يحتاجها أي موظف لاختيار مستودعه بشاشات
// البيع/الشراء/نقل المخزون)؛ الكتابة owner-only — يُفرض داخل الكنترولر نفسه
// (نفس أسلوب branches.controller.js)
router.get ('/',    ctrl.list);
router.get ('/:id', ctrl.getOne);
router.post('/',    ctrl.create);
router.put ('/:id', ctrl.update);

module.exports = router;
