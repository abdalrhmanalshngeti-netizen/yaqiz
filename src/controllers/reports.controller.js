const db = require('../config/db');
const { todayLocalDateStr } = require('../utils/date.util');

exports.dashboard = async (req, res, next) => {
  try {
    const cid = req.user.company_id;
    const today = todayLocalDateStr();
    const monthStart = today.slice(0, 7) + '-01';

    const [sales, purchases, treasury, lowStock, overdueInv] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(grand_total),0) AS total_month,
          COALESCE(SUM(CASE WHEN status='paid' THEN grand_total END),0) AS collected,
          COALESCE(SUM(CASE WHEN status IN ('issued','partial') THEN grand_total - paid_amount END),0) AS receivable,
          COUNT(*) AS count
        FROM invoices WHERE company_id=$1 AND date >= $2 AND status != 'cancelled'
      `, [cid, monthStart]),

      db.query(`
        SELECT
          COALESCE(SUM(total),0) AS total_month,
          COALESCE(SUM(remaining),0) AS payable
        FROM purchases WHERE company_id=$1 AND date >= $2
      `, [cid, monthStart]),

      db.query(`
        SELECT COALESCE(SUM(balance),0) AS total_cash FROM treasury_accounts
        WHERE company_id=$1 AND is_active=true
      `, [cid]),

      db.query(`
        SELECT COUNT(*) AS count FROM products
        WHERE company_id=$1 AND qty <= min_qty AND min_qty > 0 AND is_active=true
      `, [cid]),

      db.query(`
        SELECT COUNT(*) AS count FROM invoices
        WHERE company_id=$1 AND due_date < $2 AND status IN ('issued','partial')
      `, [cid, today])
    ]);

    res.json({
      success: true,
      data: {
        sales:       sales.rows[0],
        purchases:   purchases.rows[0],
        cash:        treasury.rows[0].total_cash,
        low_stock:   parseInt(lowStock.rows[0].count),
        overdue:     parseInt(overdueInv.rows[0].count),
      }
    });
  } catch (err) { next(err); }
};

exports.vatReport = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const cid = req.user.company_id;

    const [salesVat, purchasesVat] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(taxable_amount),0) AS taxable_sales,
          COALESCE(SUM(vat_amount),0)     AS vat_collected,
          COUNT(*)                         AS invoice_count
        FROM invoices
        WHERE company_id=$1 AND status != 'cancelled'
          AND ($2::date IS NULL OR date >= $2)
          AND ($3::date IS NULL OR date <= $3)
      `, [cid, from || null, to || null]),

      db.query(`
        SELECT
          COALESCE(SUM(amount),0)     AS taxable_purchases,
          COALESCE(SUM(vat_amount),0) AS vat_deductible,
          COUNT(*)                     AS purchase_count
        FROM purchases
        WHERE company_id=$1 AND deductible=true
          AND ($2::date IS NULL OR date >= $2)
          AND ($3::date IS NULL OR date <= $3)
      `, [cid, from || null, to || null]),
    ]);

    const collected  = parseFloat(salesVat.rows[0].vat_collected);
    const deductible = parseFloat(purchasesVat.rows[0].vat_deductible);
    const net_vat    = collected - deductible;

    res.json({
      success: true,
      data: {
        sales:       salesVat.rows[0],
        purchases:   purchasesVat.rows[0],
        vat_collected:  collected,
        vat_deductible: deductible,
        net_vat_due:    net_vat,
        status: net_vat > 0 ? 'payable' : 'refundable'
      }
    });
  } catch (err) { next(err); }
};

exports.incomeStatement = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const cid = req.user.company_id;

    const [revenue, purchases, expenses] = await Promise.all([
      db.query(`
        SELECT COALESCE(SUM(taxable_amount),0) AS amount FROM invoices
        WHERE company_id=$1 AND status != 'cancelled'
          AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
      `, [cid, from || null, to || null]),

      db.query(`
        SELECT COALESCE(SUM(amount),0) AS amount FROM purchases
        WHERE company_id=$1 AND purchase_type='goods'
          AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
      `, [cid, from || null, to || null]),

      db.query(`
        SELECT category, COALESCE(SUM(amount),0) AS amount FROM purchases
        WHERE company_id=$1 AND purchase_type='opex'
          AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
        GROUP BY category ORDER BY amount DESC
      `, [cid, from || null, to || null]),
    ]);

    const rev   = parseFloat(revenue.rows[0].amount);
    const cogs  = parseFloat(purchases.rows[0].amount);
    const gross = rev - cogs;
    const opex  = expenses.rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    const net   = gross - opex;

    res.json({
      success: true,
      data: {
        revenue: rev,
        cogs,
        gross_profit: gross,
        gross_margin: rev > 0 ? ((gross / rev) * 100).toFixed(2) : 0,
        expenses:     expenses.rows,
        total_opex:   opex,
        net_income:   net
      }
    });
  } catch (err) { next(err); }
};

// تقرير فرع تحليلي فقط (ليس جزءًا من الدفاتر الرسمية) — إجمالي الربح لكل فرع =
// مبيعات الفرع − تكلفة البضاعة المباعة الفعلية المحسوبة وقت كل فاتورة
// (invoices.cogs_total، دقيقة FIFO حقيقية). هذا **يختلف عمدًا** عن قائمة الدخل
// الموحّدة أعلاه اللي تُقرِّب التكلفة بإجمالي مشتريات الفترة — لا تُوحَّد
// المنهجيتان لاحقًا، القيمتان تُجاوبان سؤالين مختلفين (تقرير تحليلي محلي لكل
// فرع، مقابل دفتر محاسبي رسمي موحّد للشركة كلها) وتغيير أحدهما ليطابق الآخر
// يُفسد دقة الطرف الآخر.
exports.branchPerformance = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const { rows } = await db.query(`
      SELECT b.id AS branch_id, b.name AS branch_name, b.is_main,
        COALESCE(SUM(i.taxable_amount),0) AS revenue,
        COALESCE(SUM(i.cogs_total),0) AS cogs,
        COUNT(i.id) AS invoices_count
      FROM branches b
      LEFT JOIN invoices i ON i.branch_id = b.id AND i.status != 'cancelled'
        AND ($2::date IS NULL OR i.date >= $2) AND ($3::date IS NULL OR i.date <= $3)
      WHERE b.company_id = $1 AND b.is_active = true
      GROUP BY b.id, b.name, b.is_main
      ORDER BY b.is_main DESC, b.name
    `, [req.user.company_id, from || null, to || null]);

    const data = rows.map(r => {
      const revenue = parseFloat(r.revenue), cogs = parseFloat(r.cogs);
      const gross = revenue - cogs;
      return {
        branch_id: r.branch_id, branch_name: r.branch_name, is_main: r.is_main,
        revenue, cogs, gross_profit: gross,
        gross_margin: revenue > 0 ? Number(((gross / revenue) * 100).toFixed(2)) : 0,
        invoices_count: parseInt(r.invoices_count),
      };
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

exports.balanceSheet = async (req, res, next) => {
  try {
    const cid = req.user.company_id;
    const [cash, receivables, inventory, payables] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(balance),0) AS amount FROM treasury_accounts WHERE company_id=$1 AND is_active=true`, [cid]),
      db.query(`SELECT COALESCE(SUM(balance),0) AS amount FROM customers WHERE company_id=$1 AND balance > 0`, [cid]),
      // تقييم FIFO حقيقي من طبقات التكلفة الفعلية المتبقية — بدل تقريب
      // "الكمية الحالية × آخر سعر شراء" اللي يتجاهل طبقات التكلفة الأقدم كليًا
      db.query(`SELECT COALESCE(SUM(sl.qty_remaining * sl.unit_cost),0) AS amount
                FROM stock_lots sl JOIN products p ON p.id = sl.product_id
                WHERE sl.company_id=$1 AND sl.qty_remaining > 0 AND p.is_active=true`, [cid]),
      db.query(`SELECT COALESCE(SUM(balance),0) AS amount FROM suppliers WHERE company_id=$1 AND balance > 0`, [cid]),
    ]);

    const totalAssets = parseFloat(cash.rows[0].amount) +
                        parseFloat(receivables.rows[0].amount) +
                        parseFloat(inventory.rows[0].amount);

    res.json({
      success: true,
      data: {
        assets: {
          cash:        parseFloat(cash.rows[0].amount),
          receivables: parseFloat(receivables.rows[0].amount),
          inventory:   parseFloat(inventory.rows[0].amount),
          total:       totalAssets
        },
        liabilities: {
          payables: parseFloat(payables.rows[0].amount),
          total:    parseFloat(payables.rows[0].amount)
        },
        equity: totalAssets - parseFloat(payables.rows[0].amount)
      }
    });
  } catch (err) { next(err); }
};

exports.customerAging = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.name,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) <= 0  THEN i.grand_total - i.paid_amount END),0) AS current_due,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) BETWEEN 1  AND 30  THEN i.grand_total - i.paid_amount END),0) AS days_1_30,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) BETWEEN 31 AND 60  THEN i.grand_total - i.paid_amount END),0) AS days_31_60,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) BETWEEN 61 AND 90  THEN i.grand_total - i.paid_amount END),0) AS days_61_90,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) > 90              THEN i.grand_total - i.paid_amount END),0) AS over_90,
        COALESCE(SUM(i.grand_total - i.paid_amount),0) AS total
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.company_id = $1 AND i.status IN ('issued','partial')
      GROUP BY c.name
      HAVING SUM(i.grand_total - i.paid_amount) > 0
      ORDER BY total DESC
    `, [req.user.company_id]);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.supplierAging = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        s.name,
        COALESCE(SUM(p.remaining),0) AS total_payable,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - p.date) <= 30  THEN p.remaining END),0) AS within_30,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - p.date) BETWEEN 31 AND 60 THEN p.remaining END),0) AS days_31_60,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - p.date) > 60 THEN p.remaining END),0) AS over_60
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.company_id = $1 AND p.status IN ('unpaid','partial')
      GROUP BY s.name
      HAVING SUM(p.remaining) > 0
      ORDER BY total_payable DESC
    `, [req.user.company_id]);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.lowStock = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, code, name, qty, min_qty, buy_price,
             (min_qty - qty) AS shortage
      FROM products
      WHERE company_id=$1 AND qty <= min_qty AND min_qty > 0 AND is_active=true
      ORDER BY (qty / NULLIF(min_qty,0)) ASC
    `, [req.user.company_id]);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};
