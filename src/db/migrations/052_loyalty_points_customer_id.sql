-- نقاط الولاء كانت مربوطة باسم العميل (نص حر) لا معرّفه — تغيير اسم عميل يُسقط
-- رصيد نقاطه (يصير غير قابل للوصول)، وعميلان بنفس الاسم يتشاركون نفس الرصيد.
ALTER TABLE loyalty_points ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

-- خير جهد: نربط السجلات الحالية بمعرّف العميل الحقيقي عبر مطابقة الاسم الحالي،
-- عشان ما تُفقَد النقاط الموجودة فعليًا وقت تفعيل العمود الجديد
UPDATE loyalty_points lp
SET customer_id = c.id
FROM customers c
WHERE c.company_id = lp.company_id AND c.name = lp.customer_name AND lp.customer_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_loyalty_points_customer_id ON loyalty_points(customer_id);

-- يمنع تكرار صف لنفس العميل الحقيقي (بالمعرّف) بمجرد ما يصير معروفًا — القيد
-- القديم UNIQUE(company_id, customer_name) يبقى كما هو لتوافق أي مسار لا يزال
-- يكتب بالاسم فقط (سجلات لن يُعرف معرّفها أبدًا، أو نداءات قديمة لم تُحدَّث)
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_points_company_customer_id
  ON loyalty_points(company_id, customer_id) WHERE customer_id IS NOT NULL;
