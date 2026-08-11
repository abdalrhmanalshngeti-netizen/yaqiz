const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/journal.controller');

router.use(auth);

// لا تُقيَّد بالباقة ولا بصلاحية أقوى من reports.view: كل عملية بيع/شراء/سند/راتب
// تُنشئ قيدًا محاسبيًا محليًا يُزامَن هنا تلقائيًا بالخلفية لكل الباقات (حتى الأساسية
// بلا تبويب "دفتر اليومية" — القيود نفسها لازمة لحساب ميزان المراجعة وغيره) — هذا
// المسار نقطة مزامنة عامة وليس إجراء "إضافة قيد يدوي" حصري لتبويب معيّن
router.get   ('/',    can('reports.view'), ctrl.list);
router.post  ('/',    can('reports.view'), ctrl.create);
router.delete('/:id', can('reports.view'), ctrl.remove);

module.exports = router;
