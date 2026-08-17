-- ورديات ودرج نقدي لكل فرع
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS branch_id    INT REFERENCES branches(id);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS pos_point_id INT REFERENCES pos_points(id);
CREATE INDEX IF NOT EXISTS idx_shifts_branch ON shifts(branch_id);

-- NULL = حساب مشترك على مستوى الشركة (الافتراضي لحسابات البنك)؛ حسابات
-- النقدي تُنشأ تلقائيًا لكل فرع جديد (branches.controller.js) بنفس أسلوب
-- المستودع التلقائي بالمرحلة A
ALTER TABLE treasury_accounts ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id);
CREATE INDEX IF NOT EXISTS idx_treasury_accounts_branch ON treasury_accounts(branch_id);
