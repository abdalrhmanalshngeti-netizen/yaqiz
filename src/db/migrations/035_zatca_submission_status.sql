-- المرحلة الثانية للفوترة الإلكترونية — الخطوة 6: تتبّع حالة الإرسال الفعلي للهيئة
-- zatca_status الموجود مسبقًا (منذ 001_initial.sql) يُعاد استخدامه بالقيم:
-- pending | cleared (فواتير ضريبية قياسية) | reported (فواتير مبسطة) | rejected
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS zatca_response TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS zatca_submitted_at TIMESTAMPTZ;
