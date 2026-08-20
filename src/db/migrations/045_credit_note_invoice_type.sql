-- بدون هذا العمود، buildInvoiceXML يفترض دائمًا invoice_type='simplified' لأي
-- إشعار دائن (القيمة الافتراضية عند غياب الحقل)، فيخرج transaction code/tax
-- category خاطئ لإشعارات دائن مرجَّعة لفواتير ضريبية قياسية (B2B) وليست مبسّطة.
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS invoice_type VARCHAR(20);
