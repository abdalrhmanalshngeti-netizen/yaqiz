-- طبقات تكلفة FIFO حقيقية بالسيرفر — تحل محل الاعتماد على مصفوفة lots
-- المحلية بالمتصفح (كانت تُمحى بالكامل كل 60 ثانية مع كل مزامنة دورية،
-- فتتدهور كل عملية بيع تقريبًا لتحسب التكلفة بـ"آخر سعر شراء" فقط، لا FIFO
-- حقيقي) ولتحل محل products.buy_price كأساس وحيد لتكلفة البضاعة المباعة.
CREATE TABLE IF NOT EXISTS stock_lots (
  id            SERIAL PRIMARY KEY,
  company_id    INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id    INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id  INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  qty_remaining DECIMAL(12,3) NOT NULL,
  unit_cost     DECIMAL(12,2) NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type   VARCHAR(30),
  source_id     INT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_lots_fifo
  ON stock_lots(product_id, warehouse_id, received_at, id);

-- تمنع تكرار دفعة التعبئة الأولية لو أُعيد تشغيل هذا الملف (migrate.js يشغّل
-- كل ملفات الترحيل بكل إقلاع سيرفر) — بلا هذا القيد، كل إعادة تشغيل تضيف
-- دفعة وهمية جديدة فوق الدفعات الحقيقية المُنشأة فعليًا منذ ذلك الحين
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_lots_backfill_once
  ON stock_lots(product_id, warehouse_id) WHERE source_type = 'opening_backfill';

-- تكلفة كل بند فاتورة وقت البيع نفسه — تلزم لاسترجاع صحيح لاحقًا (إلغاء
-- فاتورة أو مرتجع مبيعات) بنفس التكلفة الأصلية، لا بسعر شراء حالي مختلف
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(12,2);

-- تعبئة أولية: دفعة واحدة لكل (منتج، مستودع) عنده كمية فعلية حاليًا، بنفس
-- الكمية وآخر سعر شراء معروف — لا تاريخ طبقات حقيقي متاح قبل هذا الإصلاح
-- (غير ممكن استرجاعه)، فهذه أفضل نقطة بداية نظيفة للأمام بلا إعادة حساب
-- لفواتير COGS تاريخية بأثر رجعي.
INSERT INTO stock_lots (company_id, product_id, warehouse_id, qty_remaining, unit_cost, source_type)
SELECT ps.company_id, ps.product_id, ps.warehouse_id, ps.qty, COALESCE(p.buy_price, 0), 'opening_backfill'
FROM product_stock ps
JOIN products p ON p.id = ps.product_id
WHERE ps.qty > 0
ON CONFLICT (product_id, warehouse_id) WHERE source_type = 'opening_backfill' DO NOTHING;
