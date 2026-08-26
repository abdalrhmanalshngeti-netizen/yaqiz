-- نفس مبدأ 053_client_local_id_dedup.sql — التسوية اليدوية للمخزون وتحويلات
-- المخزون بين الفروع كانتا بلا مفتاح منع تكرار، فإعادة إرسال طلب نجح فعليًا
-- بالسيرفر (استجابة ضاعت بالشبكة) يخصم/يضيف المخزون الحقيقي مرتين
ALTER TABLE stock_moves     ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS client_local_id INT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_moves_client_local_id     ON stock_moves(company_id, client_local_id)     WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_transfers_client_local_id ON stock_transfers(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
