CREATE TABLE IF NOT EXISTS purchase_items (
  id           BIGSERIAL PRIMARY KEY,
  purchase_id  BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id   BIGINT,
  product_name TEXT    NOT NULL DEFAULT '',
  qty          NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort_order   INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_pid ON purchase_items(purchase_id);
