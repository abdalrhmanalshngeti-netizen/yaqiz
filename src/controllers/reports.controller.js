const { canSeeCost } = require('../utils/costVisibility');
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
          COALESCE(SUM(CASE WHEN status IN ('issued','partial','unpaid') THEN grand_total - paid_amount - COALESCE(credited_amount,0) END),0) AS receivable,
          COUNT(*) AS count
        FROM invoices WHERE company_id=$1 AND date >= $2 AND status != 'cancelled'
      `, [cid, monthStart]),

      db.query(`
        SELECT
          COALESCE(SUM(total) FILTER (WHERE COALESCE(purchase_type,'goods') <> 'opex'),0) AS total_month,
          COALESCE(SUM(remaining),0) AS payable
        FROM purchases WHERE company_id=$1 AND date >= $2 AND COALESCE(status,'') NOT IN ('reversed','cancelled')
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

// كانت تحسب vat_collected/vat_deductible (الأرقام الفعلية المُستخدَمة للإقرار)
// من جداول invoices/purchases الخام مباشرة — يتجاهل أي أثر مرتجع أو إشعار
// دائن كليًا (لا تُوجَد بهذي الجداول أصلًا)، فيختلف دائمًا عن صافي حسابي
// الضريبة (2200 مخرجات/2210 مدخلات) بدفتر اليومية المعروض بالميزانية العمومية
// — تقريران لنفس البيانات بأرقام مختلفة، والمُستخدَم فعليًا لتقديم الإقرار هو
// الأقل دقة. الآن تُحسب الأرقام الفعلية من دفتر اليومية مباشرة (نفس منهجية
// exports.balanceSheet بالضبط)، فتشمل أي مرتجع/إشعار دائن تلقائيًا (يمر بنفس
// الحسابين أصلًا) وتطابق الميزانية العمومية دائمًا. الحقول الوصفية
// (taxable_sales, invoice_count...) تبقى من الجداول الخام كسياق فقط.
// الحساب الواحد يجي بأكثر من اسم بالقيود ("النقدية"، "النقدية والبنك"، "الصندوق"
// كلها 1100) — الاستعلام يرجّع سطر لكل (رقم، اسم)، فلازم نجمعها بالرقم. كان كل
// سطر يكتب فوق اللي قبله، فالنقدية بالميزانية طلعت قيمة آخر اسم فقط
function sumByAccountCode(rows) {
  const bal = {};
  for (const r of rows) {
    const b = bal[r.account_code] || (bal[r.account_code] = { name: r.account_name, debit: 0, credit: 0 });
    b.debit  += parseFloat(r.debit)  || 0;
    b.credit += parseFloat(r.credit) || 0;
  }
  return bal;
}

exports.vatReport = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const cid = req.user.company_id;

    const [salesVat, purchasesVat, journalVat] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(grand_total - COALESCE(vat_amount,0)),0) AS taxable_sales,
          COALESCE(SUM(vat_amount),0)     AS vat_collected,
          COUNT(*)                         AS invoice_count
        FROM invoices
        WHERE company_id=$1 AND status != 'cancelled'
          AND ($2::date IS NULL OR date >= $2)
          AND ($3::date IS NULL OR date <= $3)
      `, [cid, from || null, to || null]),

      db.query(`
        -- فاتورة معكوسة: تبقى بفترتها الأصلية، والعكس يُخصم بفترة تاريخ التصحيح
        -- (القيد العكسي بتاريخ اليوم — نفس ما يظهر بالدفاتر)
        SELECT
          COALESCE(SUM(sgn * amount),0)     AS taxable_purchases,
          COALESCE(SUM(sgn * vat_amount),0) AS vat_deductible,
          COUNT(*) FILTER (WHERE sgn = 1)   AS purchase_count
        FROM (
          SELECT 1 AS sgn, amount, vat_amount, date AS d FROM purchases
            WHERE company_id=$1 AND deductible=true
          UNION ALL
          SELECT -1, amount, vat_amount, reversed_at::date FROM purchases
            WHERE company_id=$1 AND deductible=true AND status='reversed' AND reversed_at IS NOT NULL
        ) x
        WHERE ($2::date IS NULL OR d >= $2)
          AND ($3::date IS NULL OR d <= $3)
      `, [cid, from || null, to || null]),

      db.query(`
        SELECT ji.account_code,
          SUM(CASE WHEN ji.side='debit'  THEN ji.amount ELSE 0 END) AS debit,
          SUM(CASE WHEN ji.side='credit' THEN ji.amount ELSE 0 END) AS credit
        FROM journal_items ji
        JOIN journal_entries je ON je.id = ji.entry_id
        WHERE je.company_id = $1 AND ji.account_code IN ('2200','2210')
          AND ($2::date IS NULL OR je.date >= $2)
          AND ($3::date IS NULL OR je.date <= $3)
        GROUP BY ji.account_code
      `, [cid, from || null, to || null]),
    ]);

    const jBal = {};
    journalVat.rows.forEach(r => { jBal[r.account_code] = { debit: parseFloat(r.debit), credit: parseFloat(r.credit) }; });
    const get = code => jBal[code] || { debit: 0, credit: 0 };
    const collected  = get('2200').credit - get('2200').debit;  // دائن-طبيعي (مخرجات)
    const deductible = get('2210').debit  - get('2210').credit; // مدين-طبيعي (مدخلات)
    const net_vat     = collected - deductible;

    res.json({
      success: true,
      data: {
        sales:       salesVat.rows[0],
        purchases:   purchasesVat.rows[0],
        vat_collected:  collected,
        vat_deductible: deductible,
        net_vat_due:    net_vat,
        status: net_vat > 0.005 ? 'payable' : net_vat < -0.005 ? 'credit_carried_forward' : 'nil'   // الرصيد الدائن يُرحَّل للفترات الجاية (لا استرداد)
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

    const bal = sumByAccountCode(rows);
    const get = code => bal[code] || { debit: 0, credit: 0 };
    const debitNormal  = code => get(code).debit  - get(code).credit;
    const creditNormal = code => get(code).credit - get(code).debit;
    const codesStarting = d => Object.keys(bal).filter(c => c.startsWith(d));

    const rev   = codesStarting('4').reduce((s, c) => s + creditNormal(c), 0);
    const cogs  = debitNormal('5100');
    const gross = rev - cogs;
    // تفصيل المصاريف بالاسم (فئة المصروف) — الإجمالي نفسه من مجاميع الحسابات
    const byName = {};
    rows.filter(r => String(r.account_code).startsWith('5') && r.account_code !== '5100').forEach(r => {
      const k = r.account_name || r.account_code;
      byName[k] = (byName[k] || 0) + parseFloat(r.debit) - parseFloat(r.credit);
    });
    const expenseRows = Object.entries(byName)
      .map(([category, amount]) => ({ category, amount }))
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
      -- الإيراد = الإجمالي − الضريبة (taxable_amount فاضي لبعض المسارات) ناقص مرتجعات
      -- المبيعات المربوطة بفواتير الفرع، والتكلفة ناقص تكلفة المرتجعات — يطابق الدفتر
      SELECT b.id AS branch_id, b.name AS branch_name, b.is_main,
        COALESCE(SUM(i.grand_total - COALESCE(i.vat_amount,0)),0)
          - COALESCE((SELECT SUM(r.base_amount) FROM returns r JOIN invoices ri ON ri.id = r.linked_invoice_id
                      WHERE r.company_id = $1 AND r.type = 'sales' AND ri.branch_id = b.id
                        AND ($2::date IS NULL OR r.date >= $2) AND ($3::date IS NULL OR r.date <= $3)),0) AS revenue,
        COALESCE(SUM(i.cogs_total),0)
          - COALESCE((SELECT SUM(r.cogs_reversal) FROM returns r JOIN invoices ri ON ri.id = r.linked_invoice_id
                      WHERE r.company_id = $1 AND r.type = 'sales' AND ri.branch_id = b.id
                        AND ($2::date IS NULL OR r.date >= $2) AND ($3::date IS NULL OR r.date <= $3)),0) AS cogs,
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

    const bal = sumByAccountCode(rows);
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

// ملخص "قسمي" — كل موظف يشوف أرقام قسمه فقط، محسوبة من سجلات السيرفر نفسها (مصدر
// واحد للمنشأة كلها): نفس الرقم يطلع للمالك ولمسؤول القسم بنفس اللحظة. الجهاز ما
// يحسب أي رصيد من بياناته المحلية (كانت ناقصة لمن ما عنده صلاحية الدفاتر)
exports.mySummary = async (req, res, next) => {
  try {
    const cid = req.user.company_id, uid = req.user.sub;
    const isOwner = req.user.role === 'owner';
    const perms = req.user.perms || [];
    const can = p => isOwner || perms.includes(p);
    const today = todayLocalDateStr();
    const monthStart = today.slice(0, 7) + '-01';
    // فلتر الفرع (اختياري) — للمبيعات والمشتريات والخزينة
    const bid = req.query.branch_id ? parseInt(req.query.branch_id) : null;
    const out = { at: new Date().toISOString(), today, sections: [] };
    const num = v => Math.round((parseFloat(v) || 0) * 100) / 100;

    if (can('sales.view') || can('pos.access')) {
      // من عنده نقطة بيع بس (كاشير) يشوف مبيعاته هو؛ مسؤول المبيعات يشوف الكل
      const mine = !can('sales.view');
      const p = [cid, today, monthStart, mine ? uid : null, bid];
      const [s] = (await db.query(`
        SELECT
          COALESCE(SUM(grand_total) FILTER (WHERE created_at::date = $2),0) AS today_total,
          COALESCE(SUM(grand_total - COALESCE(vat_amount,0)) FILTER (WHERE created_at::date = $2),0) AS today_net,
          COUNT(*) FILTER (WHERE created_at::date = $2) AS today_count,
          COALESCE(SUM(grand_total) FILTER (WHERE created_at::date >= $3),0) AS month_total,
          COALESCE(SUM(grand_total - COALESCE(vat_amount,0)) FILTER (WHERE created_at::date >= $3),0) AS month_net,
          COUNT(*) FILTER (WHERE created_at::date >= $3) AS month_count,
          COALESCE(SUM(grand_total - COALESCE(advance_applied,0)) FILTER (WHERE created_at::date = $2 AND payment_method IN ('نقدي','cash')),0) AS today_cash,
          COALESCE(SUM(grand_total - COALESCE(advance_applied,0)) FILTER (WHERE created_at::date = $2 AND payment_method IN ('شبكة','card')),0) AS today_card,
          COALESCE(SUM(grand_total) FILTER (WHERE created_at::date = $2 AND payment_method IN ('آجل','credit')),0) AS today_credit,
          COALESCE(SUM(grand_total - paid_amount - COALESCE(credited_amount,0)) FILTER (WHERE status IN ('issued','unpaid','partial') AND grand_total - paid_amount - COALESCE(credited_amount,0) > 0.005),0) AS open_credit
        FROM invoices
        WHERE company_id = $1 AND COALESCE(status,'') <> 'cancelled'
          AND ($4::int IS NULL OR created_by = $4) AND ($5::int IS NULL OR branch_id = $5)`, p)).rows;
      const [r] = (await db.query(`
        SELECT COALESCE(SUM(amount) FILTER (WHERE created_at::date = $2),0) AS today,
               COALESCE(SUM(amount) FILTER (WHERE created_at::date >= $3),0) AS month
        FROM returns WHERE company_id = $1 AND type = 'sales' AND ($4::int IS NULL OR created_by = $4)`, p.slice(0, 4))).rows;
      out.sections.push({ key: mine ? 'my_sales' : 'sales',
        today_total: num(s.today_total), today_net: num(s.today_net), today_count: +s.today_count,
        month_total: num(s.month_total), month_net: num(s.month_net), month_count: +s.month_count,
        today_cash: num(s.today_cash), today_card: num(s.today_card), today_credit: num(s.today_credit),
        returns_today: num(r.today), returns_month: num(r.month), open_credit: mine ? undefined : num(s.open_credit) });
      if (can('pos.access')) {
        const [sh] = (await db.query(`SELECT id, opening_cash, start_time, branch_id FROM shifts WHERE company_id = $1 AND user_id = $2 AND status = 'open' LIMIT 1`, [cid, uid])).rows;
        if (sh) {
          const [x] = (await db.query(`
            SELECT COALESCE(SUM(grand_total) FILTER (WHERE payment_method IN ('نقدي','cash')),0) AS cash,
                   COALESCE(SUM(grand_total) FILTER (WHERE payment_method IN ('شبكة','card')),0) AS card, COUNT(*) AS cnt
            FROM invoices WHERE company_id = $1 AND created_by = $2 AND created_at >= $3 AND COALESCE(status,'') <> 'cancelled'`, [cid, uid, sh.start_time])).rows;
          // نفس معادلة إغلاق الوردية بالسيرفر: مرتجعات النقدي تنطرح من الدرج، ومرتجعات الشبكة من الشبكة
          const [rr] = (await db.query(`SELECT COALESCE(SUM(COALESCE(cash_portion, amount)) FILTER (WHERE COALESCE(payment_method,'نقدي') IN ('نقدي','cash')),0) AS cash, COALESCE(SUM(COALESCE(cash_portion, amount)) FILTER (WHERE payment_method IN ('شبكة','card')),0) AS card FROM returns WHERE company_id = $1 AND created_by = $2 AND created_at >= $3 AND type = 'sales'`, [cid, uid, sh.start_time])).rows;
          out.sections.push({ key: 'shift', opening_cash: num(sh.opening_cash), start_time: sh.start_time,
            sales_cash: num(x.cash), sales_card: num(parseFloat(x.card) - parseFloat(rr.card)), invoices: +x.cnt, returns_cash: num(rr.cash), returns_card: num(rr.card),
            expected_cash: num(parseFloat(sh.opening_cash) + parseFloat(x.cash) - parseFloat(rr.cash)) });
        }
      }
    }
    if (can('customers.view')) {
      const [c] = (await db.query(`SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0),0) AS owed, COUNT(*) FILTER (WHERE balance > 0) AS n FROM customers WHERE company_id = $1`, [cid])).rows;
      const top = (await db.query(`SELECT name, balance FROM customers WHERE company_id = $1 AND balance > 0 ORDER BY balance DESC LIMIT 5`, [cid])).rows;
      const [od] = (await db.query(`SELECT COALESCE(SUM(grand_total - paid_amount - COALESCE(credited_amount,0)),0) AS v FROM invoices WHERE company_id = $1 AND status IN ('issued','unpaid','partial') AND grand_total - paid_amount - COALESCE(credited_amount,0) > 0.005 AND created_at < NOW() - INTERVAL '30 days'`, [cid])).rows;
      out.sections.push({ key: 'customers', receivables: num(c.owed), owing_count: +c.n, overdue_30: num(od.v), top: top.map(t => ({ name: t.name, balance: num(t.balance) })) });
    }
    if (can('purchases.view')) {
      const [pu] = (await db.query(`
        SELECT COALESCE(SUM(total) FILTER (WHERE created_at::date = $2 AND is_goods),0) AS today, COUNT(*) FILTER (WHERE created_at::date = $2 AND is_goods) AS today_n,
               COALESCE(SUM(total) FILTER (WHERE created_at::date >= $3 AND is_goods),0) AS month, COUNT(*) FILTER (WHERE created_at::date >= $3 AND is_goods) AS month_n,
               COALESCE(SUM(remaining),0) AS unpaid, COUNT(*) FILTER (WHERE remaining > 0) AS unpaid_n
        FROM (SELECT *, COALESCE(purchase_type,'goods') <> 'opex' AS is_goods FROM purchases) p
        WHERE company_id = $1 AND COALESCE(status,'') NOT IN ('reversed','cancelled') AND ($4::int IS NULL OR branch_id = $4)`, [cid, today, monthStart, bid])).rows;
      // اليوم/الشهر = مشتريات بضاعة فقط (المصاريف التشغيلية مستبعدة)؛ المستحق يشمل الكل
      const [sp] = (await db.query(`SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0),0) AS v FROM suppliers WHERE company_id = $1`, [cid])).rows;
      out.sections.push({ key: 'purchases', today_total: num(pu.today), today_count: +pu.today_n, month_total: num(pu.month), month_count: +pu.month_n,
        unpaid_total: num(pu.unpaid), unpaid_count: +pu.unpaid_n, payables: num(sp.v) });
    }
    if (can('inventory.view')) {
      const [iv] = (await db.query(`SELECT COALESCE(SUM(qty_remaining * unit_cost),0) AS v FROM stock_lots WHERE company_id = $1`, [cid])).rows;
      const low = (await db.query(`SELECT name, qty, min_qty FROM products WHERE company_id = $1 AND is_active AND min_qty > 0 AND qty <= min_qty ORDER BY qty LIMIT 10`, [cid])).rows;
      const [pc] = (await db.query(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE qty <= 0) AS out FROM products WHERE company_id = $1 AND is_active`, [cid])).rows;
      const byWh = (await db.query(`SELECT w.name, COALESCE(SUM(l.qty_remaining * l.unit_cost),0) AS v FROM warehouses w LEFT JOIN stock_lots l ON l.warehouse_id = w.id WHERE w.company_id = $1 GROUP BY w.id, w.name ORDER BY w.id`, [cid])).rows;
      // قيمة المخزون بالتكلفة لمن له صلاحية التكلفة فقط (الكاشير يشوف الأصناف والنواقص)
      const _cost = canSeeCost(req.user);
      out.sections.push({ key: 'inventory', stock_value: _cost ? num(iv.v) : null, products: +pc.n, out_of_stock: +pc.out,
        low_stock: low.map(l => ({ name: l.name, qty: num(l.qty), min_qty: num(l.min_qty) })), by_warehouse: _cost ? byWh.map(w => ({ name: w.name, value: num(w.v) })) : [] });
    }
    if (can('treasury.view')) {
      const acc = (await db.query(`SELECT name, type, balance FROM treasury_accounts WHERE company_id = $1 AND is_active AND ($2::int IS NULL OR branch_id = $2 OR branch_id IS NULL) ORDER BY id`, [cid, bid])).rows;
      out.sections.push({ key: 'treasury', total: num(acc.reduce((t, a) => t + parseFloat(a.balance), 0)), accounts: acc.map(a => ({ name: a.name, type: a.type, balance: num(a.balance) })) });
    }
    if (can('reports.view') || can('accounts.view')) {
      // الأرباح والضريبة من دفتر اليومية نفسه (نفس مصدر القوائم المالية)
      const g = Object.fromEntries((await db.query(`
        SELECT ji.account_code c, SUM(CASE WHEN ji.side='debit' THEN ji.amount ELSE -ji.amount END) b
        FROM journal_items ji JOIN journal_entries je ON je.id = ji.entry_id
        WHERE je.company_id = $1 AND je.date::date >= $2 AND COALESCE(je.source_type,'') NOT IN ('period_close','period_close_reversal')
        GROUP BY 1`, [cid, monthStart])).rows.map(r => [r.c, parseFloat(r.b)]));
      const sum = f => Object.entries(g).filter(([c]) => f(c)).reduce((t, [, v]) => t + v, 0);
      const revenue = -sum(c => c.startsWith('4'));
      const cogs = sum(c => c === '5100');
      const expenses = sum(c => c.startsWith('5') && c !== '5100');
      out.sections.push({ key: 'finance', month_revenue: num(revenue), month_cogs: num(cogs), month_gross: num(revenue - cogs),
        month_expenses: num(expenses), month_net: num(revenue - cogs - expenses), month_vat_net: num(-(g['2200'] || 0) - (g['2210'] || 0)) });
    }
    res.json({ success: true, data: out });
  } catch (err) { next(err); }
};
