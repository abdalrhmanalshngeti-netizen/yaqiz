-- حساب "أرباح مرحّلة" (3100) لازم لقيد الإقفال المحاسبي الحقيقي لنهاية السنة
-- (يصفّر حسابات الإيرادات/المصروفات 4xxx/5xxx بنقل صافي الفرق له) — يُنشأ
-- تحت مجموعة 3000 (حقوق الملكية) الموجودة أصلاً لكل شركة. صيغة حقوق الملكية
-- بكل من VVIP.html وreports.controller.js تجمع أصلاً أي حساب تحت 3xxx غير
-- 3000 تلقائياً، فينضم لتقرير الميزانية بلا أي تعديل كود إضافي.
INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group, parent_id)
SELECT c.id, '3100', 'أرباح مرحّلة', 'Retained Earnings', 'حقوق الملكية', false,
  (SELECT id FROM chart_of_accounts WHERE company_id = c.id AND code = '3000')
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM chart_of_accounts ca WHERE ca.company_id = c.id AND ca.code = '3100'
);
