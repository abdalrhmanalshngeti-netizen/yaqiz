const router = require('express').Router();
const auth   = require('../middleware/auth');
const ctrl   = require('../controllers/branches.controller');

router.use(auth);

// القراءة متاحة لأي مستخدم بالشركة (يحتاجها أي موظف لمعرفة فرعه بقوائم POS/الشراء/الوردية)
router.get ('/exists', ctrl.checkExists);
router.get ('/',       ctrl.list);
router.get ('/:id',    ctrl.getOne);

// الكتابة owner-only — يُفرض داخل الكنترولر نفسه (نفس أسلوب settings.controller.js)
router.post('/',       ctrl.create);
router.put ('/:id',    ctrl.update);
router.delete('/:id',  ctrl.remove);

module.exports = router;
