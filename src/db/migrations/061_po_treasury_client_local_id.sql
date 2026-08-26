-- نفس مبدأ 053/058_client_local_id_dedup.sql — أوامر الشراء وحسابات/حركات
-- الخزينة كانت بلا مفتاح منع تكرار، فإعادة إرسال طلب نجح فعليًا بالسيرفر
-- (استجابة ضاعت بالشبكة) يُنشئ سجلًا ماليًا مكرَّرًا فعليًا بلا أي طريقة لاكتشافه
ALTER TABLE purchase_orders   ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE treasury_accounts ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE treasury_moves    ADD COLUMN IF NOT EXISTS client_local_id INT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_client_local_id   ON purchase_orders(company_id, client_local_id)   WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_accounts_client_local_id ON treasury_accounts(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_moves_client_local_id    ON treasury_moves(company_id, client_local_id)    WHERE client_local_id IS NOT NULL;
