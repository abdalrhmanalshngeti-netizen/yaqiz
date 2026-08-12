-- المرحلة الثانية للفوترة الإلكترونية — الخطوة 7: تخزين رمز QR بصيغة المرحلة الثانية (base64)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS zatca_qr_phase2 TEXT;
