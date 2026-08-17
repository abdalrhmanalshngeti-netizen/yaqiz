-- مخزون لكل مستودع: products.qty يبقى إجماليًا مُشتقًا (توافق مع كل الاستعلامات/
-- التقارير الحالية)، هذا الجدول يصبح مصدر الحقيقة الفعلي للكمية لكل (منتج، مستودع)
CREATE TABLE IF NOT EXISTS product_stock (
  id           SERIAL PRIMARY KEY,
  company_id   INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  qty          DECIMAL(12,3) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_product_stock_company   ON product_stock(company_id);
CREATE INDEX IF NOT EXISTS idx_product_stock_warehouse ON product_stock(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_product_stock_product   ON product_stock(product_id);

ALTER TABLE stock_moves ADD COLUMN IF NOT EXISTS warehouse_id INT REFERENCES warehouses(id);
ALTER TABLE purchases   ADD COLUMN IF NOT EXISTS branch_id    INT REFERENCES branches(id);
ALTER TABLE invoices    ADD COLUMN IF NOT EXISTS branch_id    INT REFERENCES branches(id);

CREATE INDEX IF NOT EXISTS idx_stock_moves_warehouse ON stock_moves(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_purchases_branch       ON purchases(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoices_branch         ON invoices(branch_id);
