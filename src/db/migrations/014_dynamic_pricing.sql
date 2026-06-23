-- ============================================================
-- 014: Dynamic Pricing & Price History
-- ============================================================

-- أعمدة سياسة التسعير في جدول المنتجات
ALTER TABLE products ADD COLUMN IF NOT EXISTS profit_policy_type  VARCHAR(20)    DEFAULT 'none';
ALTER TABLE products ADD COLUMN IF NOT EXISTS profit_policy_value DECIMAL(10,4)  DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS auto_price_update   BOOLEAN        DEFAULT false;

-- ضريبة المدخلات لكل صف شراء (للمقاصة الضريبية)
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS input_tax_amount NUMERIC(12,2) DEFAULT 0;

-- سجل تغييرات أسعار المنتجات
CREATE TABLE IF NOT EXISTS product_price_history (
  id             BIGSERIAL PRIMARY KEY,
  company_id     INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id     INT          NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  old_buy_price  DECIMAL(12,2),
  new_buy_price  DECIMAL(12,2),
  old_sell_price DECIMAL(12,2),
  new_sell_price DECIMAL(12,2),
  policy_type    VARCHAR(20),
  policy_value   DECIMAL(10,4),
  purchase_id    INT          REFERENCES purchases(id),
  changed_by     INT          REFERENCES users(id),
  reason         VARCHAR(200) DEFAULT 'auto_pricing',
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product ON product_price_history(product_id);
CREATE INDEX IF NOT EXISTS idx_price_history_company ON product_price_history(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id, is_read);
