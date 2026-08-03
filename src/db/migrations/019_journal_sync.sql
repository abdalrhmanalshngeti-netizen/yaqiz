-- The double-entry journal (db.journal in VVIP.html) existed only in the
-- browser's local storage with zero server sync — lost on cache clear,
-- invisible on other devices. journal_entries/journal_items tables already
-- existed in the original schema (001_initial.sql) but were never wired up
-- to any controller, and chart_of_accounts (required by journal_items'
-- account_id FK) was never seeded for any company. This seeds it to match
-- the frontend's local chart of accounts exactly, so journal entries can
-- finally be persisted.
INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group, parent_id)
SELECT c.id, a.code, a.name, a.name_en, a.type, a.is_group, NULL
FROM companies c
CROSS JOIN (VALUES
  ('1000','الأصول','Assets','أصول',true),
  ('1100','النقدية والبنوك','Cash & Banks','أصول',false),
  ('1200','الذمم المدينة','Accounts Receivable','أصول',false),
  ('1300','المخزون','Inventory','أصول',false),
  ('2000','الالتزامات','Liabilities','التزامات',true),
  ('2100','الذمم الدائنة','Accounts Payable','التزامات',false),
  ('2200','ضريبة القيمة المضافة','VAT Payable','التزامات',false),
  ('3000','حقوق الملكية','Equity','حقوق الملكية',true),
  ('4000','الإيرادات','Revenue','إيرادات',true),
  ('4100','إيرادات المبيعات','Sales Revenue','إيرادات',false),
  ('5000','المصروفات','Expenses','مصروفات',true),
  ('5100','تكلفة البضاعة المباعة','Cost of Goods Sold','مصروفات',false),
  ('5200','المصاريف التشغيلية','Operating Expenses','مصروفات',false)
) AS a(code, name, name_en, type, is_group)
WHERE NOT EXISTS (
  SELECT 1 FROM chart_of_accounts ca WHERE ca.company_id = c.id AND ca.code = a.code
);

-- ربط الحسابات الفرعية بمجموعاتها (parent_id) بعد إدراج الكل
UPDATE chart_of_accounts child SET parent_id = parent.id
FROM chart_of_accounts parent
WHERE child.company_id = parent.company_id
  AND parent.is_group = true
  AND child.parent_id IS NULL
  AND (
    (parent.code = '1000' AND child.code IN ('1100','1200','1300')) OR
    (parent.code = '2000' AND child.code IN ('2100','2200')) OR
    (parent.code = '4000' AND child.code IN ('4100')) OR
    (parent.code = '5000' AND child.code IN ('5100','5200'))
  );
