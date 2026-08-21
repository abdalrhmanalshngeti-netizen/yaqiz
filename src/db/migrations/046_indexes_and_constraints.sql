-- سدّ فجوات فهرسة/قيود اكتُشفت بفحص شامل للمخطط: جداول محاسبية عالية الاستخدام
-- تفتقر لفهرس company_id (كل استعلام بالكود يفلتر عليه)، وpurchase_items.product_id
-- بلا مفتاح أجنبي أصلاً (الجدول الوحيد من نوعه بين كل جداول بنود الفواتير/العروض/
-- إشعارات الدائن). قيود CHECK دفاع إضافي فقط — التطبيق أصلاً يمنع القيم السالبة
-- عبر قفل الصفوف (FOR UPDATE) قبل أي عملية خصم.

CREATE INDEX IF NOT EXISTS idx_treasury_accounts_company ON treasury_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_treasury_moves_company    ON treasury_moves(company_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_company           ON vouchers(company_id);
CREATE INDEX IF NOT EXISTS idx_coa_company                ON chart_of_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company    ON journal_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_journal_items_entry         ON journal_items(entry_id);
CREATE INDEX IF NOT EXISTS idx_shifts_company              ON shifts(company_id);
CREATE INDEX IF NOT EXISTS idx_returns_company             ON returns(company_id);
CREATE INDEX IF NOT EXISTS idx_zatca_submissions_company   ON zatca_submissions(company_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_company        ON credit_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company       ON notifications(company_id);

DO $$ BEGIN
  ALTER TABLE purchase_items ADD CONSTRAINT purchase_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES products(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id);

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_qty_nonneg CHECK (qty >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE product_stock ADD CONSTRAINT product_stock_qty_nonneg CHECK (qty >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- ملاحظة: لا نضيف قيدًا مماثلًا على treasury_accounts.balance — الحساب البنكي
-- قد يمثّل سحبًا على المكشوف بسيناريو محاسبي حقيقي، بعكس الكمية الفعلية بالمخزون
-- التي لا يوجد لها أي تفسير منطقي بقيمة سالبة إطلاقًا
