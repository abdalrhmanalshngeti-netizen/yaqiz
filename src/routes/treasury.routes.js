const router = require('express').Router();
const auth   = require('../middleware/auth');
const can    = require('../middleware/permissions');
const ctrl   = require('../controllers/treasury.controller');

router.use(auth);

// Accounts
router.get ('/accounts',          can('treasury.view'),   ctrl.listAccounts);
router.post('/accounts',          can('treasury.manage'), ctrl.createAccount);
router.put ('/accounts/:id',      can('treasury.manage'), ctrl.updateAccount);
router.post('/transfer',          can('treasury.manage'), ctrl.transfer);

// Moves
router.get ('/moves',             can('treasury.view'),   ctrl.listMoves);
router.post('/move',              can('treasury.manage'), ctrl.addMove);

// السندات فعليًا: /api/vouchers (vouchers.routes.js) فقط — ذاك المسار الوحيد
// الذي تستدعيه الواجهة (VVIP.html) فعلًا. كان يوجد هنا ثلاثة مسارات مطابقة
// بالاسم (/vouchers) لكن كنترولر مختلف كليًا (treasury.controller.js) لم
// يستدعِه أي كود حي إطلاقًا، وعلى عكس مسار vouchers.routes.js الحقيقي كان
// يحرّك رصيد الخزينة والعميل/المورد مباشرة بلا أي قيد يومية مقابل — أي
// استخدام مستقبلي له كان سيكسر تطابق الميزانية العمومية/قائمة الدخل بدفتر
// اليومية بصمت. أُزيل بالكامل بدل إصلاحه لعدم وجود أي مستهلك حقيقي له.

module.exports = router;
