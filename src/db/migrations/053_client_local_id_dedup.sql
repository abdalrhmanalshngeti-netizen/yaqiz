-- نفس مبدأ client_local_id بالسندات (051_voucher_server_numbering.sql) —
-- بدونه، أي طلب إنشاء ناجح فعليًا بالسيرفر لكن ضاعت استجابته بالشبكة (أو
-- انقطع الاتصال قبل وصولها) يُعاد إرساله تلقائيًا بدورة المزامنة القادمة
-- (السجل المحلي لسه بلا معرّف سيرفري معروف)، فيُنشئ سجلًا مكررًا فعليًا بلا
-- أي طريقة لاكتشاف التكرار — لا الفواتير، لا المشتريات، لا العملاء/الموردين/
-- الموظفين/المنتجات/عروض الأسعار/المرتجعات عندها أي مفتاح منع تكرار حاليًا.
ALTER TABLE products  ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS client_local_id INT;
ALTER TABLE returns   ADD COLUMN IF NOT EXISTS client_local_id INT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_client_local_id  ON products(company_id, client_local_id)  WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_client_local_id ON customers(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_client_local_id ON suppliers(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_client_local_id ON employees(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_client_local_id ON purchases(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_client_local_id  ON invoices(company_id, client_local_id)  WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_client_local_id    ON quotes(company_id, client_local_id)    WHERE client_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_client_local_id   ON returns(company_id, client_local_id)   WHERE client_local_id IS NOT NULL;
