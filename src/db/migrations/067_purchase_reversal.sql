-- تصحيح فاتورة شراء/مصروف بقيد عكسي (لا حذف ولا تعديل): الأصل يبقى بحالة
-- 'reversed' مع سبب التصحيح ومن نفّذه، والقيد العكسي يُنشر بتاريخ التصحيح.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reversed_at     TIMESTAMPTZ;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reversed_by     INTEGER;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

-- فواتير الشراء النقدية كانت تُحفظ بمدفوع = 0 رغم إنها مسددة (المتبقي صفر) —
-- فتظهر بالجهاز بعد المزامنة كأنها غير مسددة، ويقدر المستخدم "يسددها" مرة ثانية.
-- المدفوع الصحيح = الإجمالي − المتبقي
UPDATE purchases SET paid_amount = total - COALESCE(remaining, 0)
WHERE status = 'paid' AND COALESCE(paid_amount, 0) = 0 AND total > COALESCE(remaining, 0);
