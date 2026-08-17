-- نقل بضاعة حقيقي بين مستودعين — لا تعديل ولا حذف بعد الإنشاء (يطابق عدم
-- وجود "تعديل فاتورة" بالنظام أصلًا). حركات stock_moves تُربط عبر
-- source_type='transfer', source_id=stock_transfers.id (بلا عمود جديد).
CREATE TABLE IF NOT EXISTS stock_transfers (
  id                SERIAL PRIMARY KEY,
  company_id        INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transfer_no       VARCHAR(50) NOT NULL,
  from_warehouse_id INT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id   INT NOT NULL REFERENCES warehouses(id),
  status            VARCHAR(20) DEFAULT 'completed',
  notes             TEXT,
  created_by        INT REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  CHECK (from_warehouse_id <> to_warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_company ON stock_transfers(company_id);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id            SERIAL PRIMARY KEY,
  transfer_id   INT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id    INT NOT NULL REFERENCES products(id),
  product_name  VARCHAR(200),
  qty           DECIMAL(12,3) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON stock_transfer_items(transfer_id);

CREATE SEQUENCE IF NOT EXISTS transfer_seq;
