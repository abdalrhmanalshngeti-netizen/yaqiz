// إصلاح طبقات التكلفة المكررة — migrate.js كان يعيد تشغيل 050_stock_lots.sql مع كل
// تشغيل للسيرفر، فكل منتج أُنشئ بعد الملف ينضاف له طبقة "رصيد افتتاحي" ثانية = كميته
// (الكمية الفعلية سليمة، طبقات FIFO متضخمة → تكلفة المبيعات وقيمة المخزون غلط).
//
// التوقيع: طبقة opening_backfill أُنشئت بعد أول طبقة حقيقية لنفس المنتج/المستودع،
// ومجموع الطبقات > الكمية الفعلية بالمستودع. نقص الطبقة المكررة بالزائد فقط.
//
//   node scripts/repair-duplicate-backfill-lots.js              ← عرض فقط (لا تعديل)
//   node scripts/repair-duplicate-backfill-lots.js --apply      ← تطبيق
//   ... --company 123                                            ← شركة وحدة
require('dotenv').config();
const db = require('../src/config/db');

const apply = process.argv.includes('--apply');
const ci = process.argv.indexOf('--company');
const companyId = ci > 0 ? parseInt(process.argv[ci + 1]) : null;

(async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT b.id AS lot_id, b.company_id, b.product_id, b.warehouse_id, b.qty_remaining::float AS lot_qty, b.unit_cost::float AS cost,
             p.name, COALESCE(ps.qty, 0)::float AS stock_qty,
             (SELECT SUM(qty_remaining) FROM stock_lots l WHERE l.product_id = b.product_id AND l.warehouse_id = b.warehouse_id)::float AS lots_qty
      FROM stock_lots b
      JOIN products p ON p.id = b.product_id
      LEFT JOIN product_stock ps ON ps.product_id = b.product_id AND ps.warehouse_id = b.warehouse_id
      WHERE b.source_type = 'opening_backfill' AND b.qty_remaining > 0
        AND ($1::int IS NULL OR b.company_id = $1)
        AND EXISTS (SELECT 1 FROM stock_lots o WHERE o.product_id = b.product_id AND o.warehouse_id = b.warehouse_id
                    AND o.source_type <> 'opening_backfill' AND o.created_at < b.created_at)
      ORDER BY b.company_id, b.product_id, b.created_at DESC`, [companyId]);
    let fixed = 0, value = 0;
    const left = new Map();
    for (const r of rows) {
      const key = r.product_id + ':' + r.warehouse_id;
      const excess = left.has(key) ? left.get(key) : Math.round((r.lots_qty - r.stock_qty) * 1000) / 1000;
      if (excess <= 0.0005) { left.set(key, 0); continue; }
      const cut = Math.min(excess, r.lot_qty);
      left.set(key, Math.round((excess - cut) * 1000) / 1000);
      console.log(`company ${r.company_id} | ${r.name} (wh ${r.warehouse_id}): lots ${r.lots_qty} vs stock ${r.stock_qty} → cut ${cut} @ ${r.cost} from lot ${r.lot_id}`);
      if (apply) await client.query(`UPDATE stock_lots SET qty_remaining = qty_remaining - $1 WHERE id = $2`, [cut, r.lot_id]);
      fixed++; value += cut * r.cost;
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${fixed} lot(s), inventory value overstated by ${value.toFixed(2)}`);
  } catch (e) {
    await client.query('ROLLBACK'); console.error('failed:', e.message); process.exitCode = 1;
  } finally { client.release(); await db.pool.end(); }
})();
