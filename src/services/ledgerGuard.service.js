const db = require('../config/db');

// الحارس المحاسبي اليومي: لكل شركة، يطابق الدفاتر (دفتر اليومية) مع السجلات
// الفرعية اللي يفترض تساويها، ويسجّل أي فرق بجدول ledger_guard_findings ليظهر
// بلوحة الإدارة قبل ما يلاحظه العميل. يقرأ فقط — ما يعدّل أي بيانات شركة.
// ملاحظة: القيود تُبنى بالمتصفح وتُزامَن، فجهاز ما زامن بعد قد يسبب فرقًا مؤقتًا
// يختفي بالتشغيل التالي؛ الفرق اللي يستمر أكثر من تشغيل هو المشكلة الحقيقية.
const TOL = 0.01;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function checkCompany(cid) {
  const q = async (sql, params = [cid]) => (await db.query(sql, params)).rows;
  const findings = [];
  const add = (check_key, subject, title, expected, actual) => {
    const diff = r2(actual - expected);
    if (Math.abs(diff) > TOL) findings.push({ check_key, subject: String(subject || ''), title, expected: r2(expected), actual: r2(actual), diff });
  };

  // 1) كل قيد متوازن
  const unbalanced = await q(`
    SELECT je.id, je.entry_no, LEFT(COALESCE(je.description,''), 80) AS d,
           SUM(CASE WHEN ji.side='debit' THEN ji.amount ELSE -ji.amount END)::float AS diff
    FROM journal_entries je JOIN journal_items ji ON ji.entry_id = je.id
    WHERE je.company_id = $1 GROUP BY je.id HAVING ABS(SUM(CASE WHEN ji.side='debit' THEN ji.amount ELSE -ji.amount END)) > 0.005
    LIMIT 50`);
  for (const u of unbalanced) findings.push({ check_key: 'unbalanced_entry', subject: u.entry_no || String(u.id), title: `قيد غير متوازن: ${u.entry_no || u.id} — ${u.d}`, expected: 0, actual: r2(u.diff), diff: r2(u.diff) });

  // أرصدة الحسابات (مدين − دائن) مجمّعة برقم الحساب
  const glRows = await q(`
    SELECT ji.account_code AS c, SUM(CASE WHEN ji.side='debit' THEN ji.amount ELSE -ji.amount END)::float AS b
    FROM journal_items ji JOIN journal_entries je ON je.id = ji.entry_id
    WHERE je.company_id = $1 GROUP BY ji.account_code`);
  const gl = Object.fromEntries(glRows.map(r => [r.c, Number(r.b)]));
  const g = c => gl[c] || 0;

  // 2) ميزان المراجعة
  add('trial_balance', '', 'ميزان المراجعة غير متوازن (مجموع المدين ≠ مجموع الدائن)', 0, Object.values(gl).reduce((s, v) => s + v, 0));

  // 3) النقدية بالدفاتر = أرصدة حسابات الخزينة
  const [tre] = await q(`SELECT COALESCE(SUM(balance),0)::float AS s FROM treasury_accounts WHERE company_id = $1`);
  add('cash_vs_treasury', '', 'حساب النقدية (1100) ≠ مجموع أرصدة الخزينة', g('1100'), tre.s);

  // 4) المخزون بالدفاتر = قيمة طبقات التكلفة الفعلية
  const [lots] = await q(`SELECT COALESCE(SUM(qty_remaining*unit_cost),0)::float AS v FROM stock_lots WHERE company_id = $1`);
  add('inventory_vs_lots', '', 'حساب المخزون (1300) ≠ قيمة المخزون الفعلية (طبقات FIFO)', g('1300'), lots.v);

  // 5) لكل منتج: الكمية = الطبقات = مخزون المستودعات، و6) لا كمية سالبة
  const prods = await q(`
    SELECT p.id, p.name, p.qty::float AS q,
      COALESCE((SELECT SUM(qty_remaining) FROM stock_lots l WHERE l.product_id = p.id),0)::float AS lq,
      COALESCE((SELECT SUM(qty) FROM product_stock s WHERE s.product_id = p.id),0)::float AS wq
    FROM products p WHERE p.company_id = $1`);
  for (const p of prods) {
    if (Math.abs(p.q - p.lq) > 0.0005) findings.push({ check_key: 'product_qty_vs_lots', subject: String(p.id), title: `«${p.name}»: الكمية ≠ طبقات التكلفة`, expected: r2(p.q), actual: r2(p.lq), diff: r2(p.lq - p.q) });
    if (Math.abs(p.q - p.wq) > 0.0005) findings.push({ check_key: 'product_qty_vs_warehouses', subject: String(p.id), title: `«${p.name}»: الكمية ≠ مجموع مخزون الفروع`, expected: r2(p.q), actual: r2(p.wq), diff: r2(p.wq - p.q) });
    if (p.q < -0.0005) findings.push({ check_key: 'negative_stock', subject: String(p.id), title: `«${p.name}»: كمية سالبة`, expected: 0, actual: r2(p.q), diff: r2(p.q) });
  }

  // 7) ذمم العملاء بالدفاتر = أرصدة العملاء، و8) = الفواتير المفتوحة
  const [cust] = await q(`SELECT COALESCE(SUM(balance),0)::float AS s FROM customers WHERE company_id = $1`);
  add('ar_vs_customers', '', 'ذمم العملاء (1200) ≠ مجموع أرصدة العملاء', g('1200'), cust.s);
  const [openInv] = await q(`
    SELECT COALESCE(SUM(grand_total - paid_amount - COALESCE(credited_amount,0)),0)::float AS s
    FROM invoices WHERE company_id = $1 AND status <> 'cancelled'`);
  // شركة لها أرصدة عملاء/موردين افتتاحية: ذممها ليست كلها فواتير بالنظام (والتحصيل
  // منها يُنقص الذمم بلا فاتورة) — المطابقة بالفواتير تتخطاها، وتبقى بالأرصدة أعلاه
  const [opening] = await q(`
    SELECT COALESCE(SUM(CASE WHEN ji.account_code='1200' THEN 1 ELSE 0 END),0)::int AS ar,
           COALESCE(SUM(CASE WHEN ji.account_code='2100' THEN 1 ELSE 0 END),0)::int AS ap
    FROM journal_items ji JOIN journal_entries je ON je.id = ji.entry_id
    WHERE je.company_id = $1 AND je.reference = 'OPENING'`);
  if (!opening.ar) add('ar_vs_invoices', '', 'ذمم العملاء (1200) ≠ المتبقي على الفواتير المفتوحة', g('1200'), openInv.s);

  // 9) ذمم الموردين بالدفاتر = أرصدة الموردين، و10) = فواتير الشراء المفتوحة
  const ap = -g('2100');
  const [sup] = await q(`SELECT COALESCE(SUM(balance),0)::float AS s FROM suppliers WHERE company_id = $1`);
  add('ap_vs_suppliers', '', 'ذمم الموردين (2100) ≠ مجموع أرصدة الموردين', ap, sup.s);
  const [openPur] = await q(`SELECT COALESCE(SUM(remaining),0)::float AS s FROM purchases WHERE company_id = $1 AND COALESCE(status,'') <> 'cancelled'`);
  if (!opening.ap) add('ap_vs_purchases', '', 'ذمم الموردين (2100) ≠ المتبقي على فواتير الشراء', ap, openPur.s);

  // 11) فواتير بيع بأصناف حقيقية بلا خصم مخزون (تكلفة صفر — ربح وهمي)
  const noCost = await q(`
    SELECT i.invoice_no FROM invoices i
    WHERE i.company_id = $1 AND i.status <> 'cancelled' AND COALESCE(i.cogs_total,0) = 0
      AND EXISTS (SELECT 1 FROM invoice_items it WHERE it.invoice_id = i.id AND it.product_id IS NOT NULL)
    LIMIT 50`);
  for (const r of noCost) findings.push({ check_key: 'invoice_without_cogs', subject: r.invoice_no, title: `فاتورة ${r.invoice_no} بيعت بلا خصم مخزون (تكلفة المبيعات صفر)`, expected: null, actual: null, diff: null });

  // 12) بضاعة بالطريق معلّقة أكثر من 7 أيام (اشتريت ولم تُدرج بالمخزون)
  const transit = g('1350');
  if (transit > TOL) {
    const [old] = await q(`
      SELECT COUNT(*)::int AS n FROM journal_items ji JOIN journal_entries je ON je.id = ji.entry_id
      WHERE je.company_id = $1 AND ji.account_code = '1350' AND ji.side = 'debit' AND je.date < CURRENT_DATE - 7`);
    if (old.n > 0) findings.push({ check_key: 'goods_in_transit', subject: '', title: `بضاعة بالطريق معلّقة أكثر من أسبوع (${r2(transit)} ر.س) — أصناف مشتراة لم تُدرج بالمخزون`, expected: 0, actual: r2(transit), diff: r2(transit) });
  }

  return findings;
}

async function saveFindings(cid, findings) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const keys = [];
    for (const f of findings) {
      keys.push(`${f.check_key}|${f.subject}`);
      await client.query(`
        INSERT INTO ledger_guard_findings (company_id, check_key, subject, title, expected, actual, diff)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (company_id, check_key, subject) DO UPDATE
          SET title = EXCLUDED.title, expected = EXCLUDED.expected, actual = EXCLUDED.actual,
              diff = EXCLUDED.diff, last_seen = NOW()`,
        [cid, f.check_key, f.subject, f.title, f.expected, f.actual, f.diff]);
    }
    // ما ظهر بهذا التشغيل = اتصلح
    await client.query(`
      DELETE FROM ledger_guard_findings
      WHERE company_id = $1 AND NOT ((check_key || '|' || subject) = ANY($2::text[]))`, [cid, keys]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// يشغّل الفحص على كل الشركات (أو شركة وحدة) ويسجّل التشغيل
async function runLedgerGuard({ companyId = null, trigger = 'schedule' } = {}) {
  const t0 = Date.now();
  const companies = companyId
    ? [{ id: companyId }]
    : (await db.query(`SELECT id FROM companies WHERE COALESCE(status,'active') <> 'anonymized' ORDER BY id`)).rows;
  let total = 0, failed = 0;
  for (const c of companies) {
    try {
      const f = await checkCompany(c.id);
      await saveFindings(c.id, f);
      total += f.length;
    } catch (e) {
      failed++;
      console.error(`[LedgerGuard] company ${c.id}:`, e.message);
    }
  }
  const duration = Date.now() - t0;
  await db.query(
    `INSERT INTO ledger_guard_runs (trigger, companies, findings, duration_ms, error) VALUES ($1,$2,$3,$4,$5)`,
    [trigger, companies.length, total, duration, failed ? `${failed} شركة تعذّر فحصها` : null]);
  return { companies: companies.length, findings: total, failed, duration_ms: duration };
}

module.exports = { runLedgerGuard, checkCompany };
