-- حسابان جديدان لتتبّع فائض سندات القبض/الصرف (بدل اختفائه بصمت من حساب
-- الذمم العام دون أي نسبة لأي عميل/مورد) — راجع تعليق الإصلاح بـVVIP.html
-- (postCustomerReceivable/postSupplierPayable بمنطق سندات القبض والصرف)
INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group, parent_id)
SELECT c.id, '2160', 'دفعات عملاء مقدمة', 'Customer Advances', 'التزامات', false,
       (SELECT id FROM chart_of_accounts WHERE company_id = c.id AND code = '2000')
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE company_id = c.id AND code = '2160');

INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group, parent_id)
SELECT c.id, '1250', 'دفعات مقدمة لموردين', 'Supplier Advances', 'أصول', false,
       (SELECT id FROM chart_of_accounts WHERE company_id = c.id AND code = '1000')
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE company_id = c.id AND code = '1250');
