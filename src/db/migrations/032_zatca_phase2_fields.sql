-- المرحلة الثانية للفوترة الإلكترونية (ZATCA) — الخطوة 1: توسيع قاعدة البيانات
-- يضيف الحقول التي تتطلبها مواصفة XML (BR-KSA-09/10/37/63/66/67 للعنوان المُهيكل،
-- BT-151 لتصنيف الضريبة لكل سطر، KSA-1/13/16 لمعرّف الفاتورة وسلسلة التجزئة والعداد)

-- عنوان مُهيكل للشركة (البائع) بدل حقل address النصي الحر
ALTER TABLE companies ADD COLUMN IF NOT EXISTS street_name      VARCHAR(200);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS building_number  VARCHAR(4);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS district         VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS postal_code      VARCHAR(5);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country_code     VARCHAR(2) DEFAULT 'SA';

-- عنوان مُهيكل للعميل (المشتري) — إلزامي فقط للفاتورة الضريبية الكاملة، اختياري للمبسطة
ALTER TABLE customers ADD COLUMN IF NOT EXISTS street_name      VARCHAR(200);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS building_number  VARCHAR(4);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS district         VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code      VARCHAR(5);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS country_code     VARCHAR(2) DEFAULT 'SA';

-- عداد الفواتير التسلسلي (ICV، KSA-16) وسلسلة التجزئة (KSA-13) ووقت الإصدار (KSA-25)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS icv                      INT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS previous_invoice_hash    TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_transaction_code VARCHAR(7);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_time               TIME;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS xml_content              TEXT;

-- تصنيف فئة الضريبة لكل سطر فاتورة (BT-151): S = خاضع، Z = صفري، E = معفى، O = خارج نطاق الضريبة
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS vat_category_code VARCHAR(1) DEFAULT 'S';
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS vat_exemption_reason_code VARCHAR(20);

-- فهرس فريد يمنع تكرار رقم العداد التسلسلي لنفس الشركة (شرط KSA-16 أساسي لسلامة السلسلة)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_icv
  ON invoices(company_id, icv) WHERE icv IS NOT NULL;
