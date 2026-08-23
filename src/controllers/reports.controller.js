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

// كانت تحسب "تكلفة البضاعة المباعة" كإجمالي مشتريات بضاعة بالفترة، لا تكلفة
// ما بيع فعليًا (نفس البق المُصلَح بالجانب العميل سابقًا) — تُحسَب الآن من
// دفتر اليومية الحقيقي (المُزامَن فعليًا من كل الأجهزة)، بنفس منهجية الميزانية
// العمومية أدناه: إيراد = صافي حساب 4xxx، التكلفة = حساب 5100 تحديدًا (COGS
// حقيقي FIFO وقت البيع، لا وقت الشراء)، وبقية 5xxx مصاريف تشغيلية
exports.incomeStatement = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const cid = req.user.company_id;

    const { rows } = await db.query(`
      SELECT ji.account_code, ji.account_name,
        SUM(CASE WHEN ji.side='debit'  THEN ji.amount ELSE 0 END) AS debit,
        SUM(CASE WHEN ji.side='credit' THEN ji.amount ELSE 0 END) AS credit
      FROM journal_items ji
      JOIN journal_entries je ON je.id = ji.entry_id
      WHERE je.company_id = $1
        AND ($2::date IS NULL OR je.date >= $2) AND ($3::date IS NULL OR je.date <= $3)
      GROUP BY ji.account_code, ji.account_name
    `, [cid, from || null, to || null]);

    const bal = {};
    rows.forEach(r => { bal[r.account_code] = { name: r.account_name, debit: parseFloat(r.debit), credit: parseFloat(r.credit) }; });
    const get = code => bal[code] || { debit: 0, credit: 0 };
    const debitNormal  = code => get(code).debit  - get(code).credit;
    const creditNormal = code => get(code).credit - get(code).debit;
    const codesStarting = d => Object.keys(bal).filter(c => c.startsWith(d));

    const rev   = codesStarting('4').reduce((s, c) => s + creditNormal(c), 0);
    const cogs  = debitNormal('5100');
    const gross = rev - cogs;
    const expenseRows = codesStarting('5').filter(c => c !== '5100')
      .map(c => ({ category: bal[c].name, amount: debitNormal(c) }))
      .filter(r => Math.abs(r.amount) > 0.004)
      .sort((a, b) => b.amount - a.amount);
    const opex = expenseRows.reduce((s, r) => s + r.amount, 0);
    const net  = gross - opex;

    res.json({
      success: true,
      data: {
        revenue: rev,
        cogs,
        gross_profit: gross,
        gross_margin: rev > 0 ? ((gross / rev) * 100).toFixed(2) : 0,
        expenses:     expenseRows,
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

// كانت تتجاهل الأصول الثابتة، وضريبة القيمة المضافة المستردة، والالتزامات
// الدورية المستحقة بالكامل، وتحسب حقوق الملكية كرقم موازن (أصول-خصوم) لا
// كرأس مال + أرباح متراكمة حقيقية — نفس البقّات المُصلَحة بالجانب العميل
// سابقًا (renderBalanceSheet). تُبنى الآن من دفتر اليومية الحقيقي مباشرة،
// بنفس منهجية الجانب العميل بالضبط، فتطابقه رقميًا دائمًا
exports.balanceSheet = async (req, res, next) => {
  try {
    const cid = req.user.company_id;
    const { rows } = await db.query(`
      SELECT ji.account_code, ji.account_name,
        SUM(CASE WHEN ji.side='debit'  THEN ji.amount ELSE 0 END) AS debit,
        SUM(CASE WHEN ji.side='credit' THEN ji.amount ELSE 0 END) AS credit
      FROM journal_items ji
      JOIN journal_entries je ON je.id = ji.entry_id
      WHERE je.company_id = $1
      GROUP BY ji.account_code, ji.account_name
    `, [cid]);

    const bal = {};
    rows.forEach(r => { bal[r.account_code] = { name: r.account_name, debit: parseFloat(r.debit), credit: parseFloat(r.credit) }; });
    const get = code => bal[code] || { debit: 0, credit: 0 };
    const debitNormal  = code => get(code).debit  - get(code).credit;
    const creditNormal = code => get(code).credit - get(code).debit;
    const codesStarting = d => Object.keys(bal).filter(c => c.startsWith(d));

    const cash        = debitNormal('1100');
    const receivables = debitNormal('1200');
    const inventoryVal = debitNormal('1300');
    const fixedAssets  = debitNormal('1500');
    const outputVAT  = creditNormal('2200');
    const inputVAT   = debitNormal('2210');
    const vatNet      = outputVAT - inputVAT;
    const vatPayable   = Math.max(0, vatNet);
    const vatReceivable = Math.max(0, -vatNet);
    const knownAssetCodes = ['1100','1200','1300','1500'];
    const otherAssets = codesStarting('1').filter(c => !knownAssetCodes.includes(c)).reduce((s, c) => s + debitNormal(c), 0);
    const totalAssets = cash + receivables + inventoryVal + fixedAssets + vatReceivable + otherAssets;

    const accountsPayable = creditNormal('2100');
    const obligationsAccrued = creditNormal('2300');
    const knownLiabCodes = ['2100','2200','2210','2300'];
    const otherLiab = codesStarting('2').filter(c => !knownLiabCodes.includes(c)).reduce((s, c) => s + creditNormal(c), 0);
    const totalLiab = accountsPayable + vatPayable + obligationsAccrued + otherLiab;

    const netRevenue = codesStarting('4').reduce((s, c) => s + creditNormal(c), 0);
    const netCOGS    = debitNormal('5100');
    const netOPEX    = codesStarting('5').filter(c => c !== '5100').reduce((s, c) => s + debitNormal(c), 0);
    const netProfit  = (netRevenue - netCOGS) - netOPEX;

    const capital = creditNormal('3000');
    const otherEquity = codesStarting('3').filter(c => c !== '3000').reduce((s, c) => s + creditNormal(c), 0);
    const equity = capital + otherEquity + netProfit;

    res.json({
      success: true,
      data: {
        assets: {
          cash, receivables, inventory: inventoryVal, fixed_assets: fixedAssets,
          vat_receivable: vatReceivable, other: otherAssets, total: totalAssets
        },
        liabilities: {
          payables: accountsPayable, vat_payable: vatPayable, obligations: obligationsAccrued,
          other: otherLiab, total: totalLiab
        },
        equity
      }
    });
  } catch (err) { next(err); }
};

exports.customerAging = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id AS customer_id, c.name,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) <= 0  THEN i.grand_total - i.paid_amount END),0) AS current_due,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) BETWEEN 1  AND 30  THEN i.grand_total - i.paid_amount END),0) AS days_1_30,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) BETWEEN 31 AND 60  THEN i.grand_total - i.paid_amount END),0) AS days_31_60,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) BETWEEN 61 AND 90  THEN i.grand_total - i.paid_amount END),0) AS days_61_90,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - i.due_date) > 90              THEN i.grand_total - i.paid_amount END),0) AS over_90,
        COALESCE(SUM(i.grand_total - i.paid_amount),0) AS total
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.company_id = $1 AND i.status IN ('issued','partial')
      GROUP BY c.id, c.name
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
        s.id AS supplier_id, s.name,
        COALESCE(SUM(p.remaining),0) AS total_payable,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - p.date) <= 30  THEN p.remaining END),0) AS within_30,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - p.date) BETWEEN 31 AND 60 THEN p.remaining END),0) AS days_31_60,
        COALESCE(SUM(CASE WHEN (CURRENT_DATE - p.date) > 60 THEN p.remaining END),0) AS over_60
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.company_id = $1 AND p.status IN ('unpaid','partial')
      GROUP BY s.id, s.name
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
