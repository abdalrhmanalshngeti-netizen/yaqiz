-- نفس مبدأ client_local_id بالمستندات الأخرى (053_client_local_id_dedup.sql) —
-- بدونه، أي طلب إنشاء قيد يومية ناجح فعليًا بالسيرفر لكن ضاعت استجابته بالشبكة
-- (أو انقطع الاتصال قبل وصولها) يُعاد إرساله تلقائيًا بدورة المزامنة القادمة،
-- فيُنشئ قيدًا مكررًا فعليًا بلا أي طريقة لاكتشاف التكرار — يُضاعِف كل رقم بكل
-- تقرير مالي يعتمد على دفتر اليومية (ميزان المراجعة، الميزانية، قائمة الدخل).
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS client_local_id INT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_client_local_id
  ON journal_entries(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
