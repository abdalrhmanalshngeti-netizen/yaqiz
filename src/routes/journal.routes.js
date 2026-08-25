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
// الحذف مختلف عن الإنشاء أعلاه: لا يوجد أي مسار عمل تلقائي (بيع/شراء/سند/راتب)
// يحذف قيدًا كأثر جانبي عادي — الوحيد اللي يحذف قيدًا فعليًا هو تعديل الأرصدة
// الافتتاحية (يُعاد تعديله لصلاحية accounts.manage بنفس هذا الإصلاح، راجع
// VVIP.html showOpeningBalancesWizard)، فتشديد صلاحية الحذف هنا لا يكسر أي
// مزامنة عامة، بعكس POST أعلاه الذي يبقى نقطة مزامنة مشتركة لكل الموظفين
router.delete('/:id', can('accounts.manage'), ctrl.remove);

module.exports = router;
