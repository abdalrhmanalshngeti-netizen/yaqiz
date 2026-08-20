-- إصلاح تعبئة migration 043: last_hash كان يُؤخذ من صف أعلى ICV بغضّ النظر عن
-- نجاح تجزئته، فلو فشل توليد XML لتلك الفاتورة تحديدًا (zatca_hash=NULL) صارت
-- السلسلة تُقرأ NULL وتبدأ الفاتورة التالية من FIRST_INVOICE_HASH خطأً بدل تجزئة
-- آخر فاتورة موثّقة فعليًا. هذا التصحيح يعيد ملء last_hash فقط (لا يغيّر last_icv
-- الذي يبقى صحيحًا كعداد تسلسلي) من آخر فاتورة لها تجزئة فعلية إن وُجدت.
UPDATE zatca_chain_state cs
SET last_hash = (
  SELECT i.zatca_hash FROM invoices i
  WHERE i.company_id = cs.company_id AND i.zatca_hash IS NOT NULL
  ORDER BY i.icv DESC LIMIT 1
)
WHERE cs.last_hash IS NULL
  AND EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.company_id = cs.company_id AND i.zatca_hash IS NOT NULL
  );
