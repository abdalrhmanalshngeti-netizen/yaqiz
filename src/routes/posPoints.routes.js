const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/posPoints.controller');

router.use(auth);

// القراءة متاحة لأي مستخدم بالشركة (يحتاجها أي موظف لاختيار نقطة البيع
// بشاشة الكاشير)؛ الكتابة owner-only — يُفرض داخل الكنترولر نفسه (نفس أسلوب
// branches.controller.js/warehouses.controller.js)
router.get ('/',      ctrl.list);
router.get ('/:id',   ctrl.getOne);
router.post('/',      ctrl.create);
router.put ('/:id',   ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
