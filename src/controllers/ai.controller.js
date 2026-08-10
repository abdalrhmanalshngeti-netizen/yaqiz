const db  = require('../config/db');
const ai  = require('../services/ai.service');

function cleanJSON(raw) {
  let s = raw.trim();
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : s;
}

// Monthly usage count for a given feature
async function getMonthlyUsage(company_id, feature) {
  const { rows: [row] } = await db.query(`
    SELECT COUNT(*) AS cnt FROM ai_usage
    WHERE company_id=$1 AND feature=$2
      AND created_at >= date_trunc('month', NOW())
  `, [company_id, feature]);
  return parseInt(row.cnt, 10);
}

async function getDailyUsage(company_id, feature) {
  const { rows: [row] } = await db.query(`
    SELECT COUNT(*) AS cnt FROM ai_usage
    WHERE company_id=$1 AND feature=$2
      AND created_at >= date_trunc('day', NOW())
  `, [company_id, feature]);
  return parseInt(row.cnt, 10);
}

async function logUsage(company_id, feature, tokens_in, tokens_out, user_id, question) {
  await db.query(`
    INSERT INTO ai_usage (company_id, feature, tokens_in, tokens_out, user_id, question)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [company_id, feature, tokens_in || 0, tokens_out || 0, user_id || null, question || null]);
}

// ── Plan limits ──────────────────────────────────────────────
const EXTRACT_LIMITS  = { basic: 30,  growth: 100, pro: 500 };
const ANALYZE_LIMITS  = { basic: 0,   growth: 10,  pro: 200 };
const ASSISTANT_DAILY = { basic: 0,   growth: 3,   pro: 9999 };
// assistant: pro only, no hard monthly limit (fair use)
// استخراج كشف حساب بنكي بالذكاء الاصطناعي — حد شهري منفصل عن تفريغ الفواتير
// العادي، وغير متاح على الباقة الأساسية إطلاقًا (تسوية البنك نفسها Growth/Pro فقط)
const BANK_STMT_EXTRACT_LIMITS = { basic: 0, growth: 3, pro: 4 };

async function getPlan(company_id) {
  const { rows: [co] } = await db.query(
    `SELECT plan, subscription_expires_at FROM companies WHERE id=$1`, [company_id]
  );
  if (!co) return 'basic';
  let plan = co.plan || 'basic';
  // normalize legacy names
  if (plan === 'free' || plan === 'starter' || plan === 'trial') plan = 'basic';
  // if paid plan subscription expired → downgrade to basic
  if (plan !== 'basic' && co.subscription_expires_at && new Date(co.subscription_expires_at) < new Date()) {
    plan = 'basic';
  }
  return plan;
}

// POST /api/ai/extract  (image_base64 أو pdf_base64)
exports.extract = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { image_base64, pdf_base64, mime_type = 'image/jpeg' } = req.body;
    if (!image_base64 && !pdf_base64) {
      return res.status(400).json({ success: false, message: 'image_base64 أو pdf_base64 مطلوب' });
    }

    const plan = await getPlan(company_id);
    const limit = EXTRACT_LIMITS[plan] ?? 0;

    if (limit === 0) {
      return res.status(403).json({
        success: false,
        code: 'PLAN_UPGRADE_REQUIRED',
        message: 'استخراج الفواتير بالذكاء الاصطناعي متاح من باقة النمو فأعلى.',
        current_plan: plan,
      });
    }

    const used  = await getMonthlyUsage(company_id, 'extract');
    if (used >= limit) {
      return res.status(403).json({
        success: false,
        code: 'AI_LIMIT_REACHED',
        message: `وصلت للحد الأقصى لتفريغ المستندات هذا الشهر (${limit} مرة). سيتجدد الحد أول الشهر القادم.`,
        used, limit,
      });
    }

    let result;
    if (pdf_base64) {
      const pdfBuffer = Buffer.from(pdf_base64, 'base64');
      result = await ai.extractFromPDF(pdfBuffer);
    } else {
      result = await ai.extractDocument(image_base64, mime_type);
    }
    await logUsage(company_id, 'extract', result.tokens_in, result.tokens_out, req.user.sub);

    let parsed = null;
    try { parsed = JSON.parse(cleanJSON(result.content)); } catch { /* fallback */ }

    if (!parsed) {
      return res.status(422).json({ success: false, message: 'تعذّرت قراءة الفاتورة — حاول مع صورة أوضح' });
    }

    res.json({
      success: true,
      data: parsed,
      usage: { used: used + 1, limit },
    });
  } catch (err) {
    // إرجاع رسالة الخطأ الحقيقية للمساعدة في التشخيص
    return res.status(500).json({ success: false, message: err.message || 'خطأ في الذكاء الاصطناعي' });
  }
};

// POST /api/ai/extract-bank-statement  (image_base64 أو pdf_base64)
exports.extractBankStatement = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { image_base64, pdf_base64, mime_type = 'image/jpeg' } = req.body;
    if (!image_base64 && !pdf_base64) {
      return res.status(400).json({ success: false, message: 'image_base64 أو pdf_base64 مطلوب' });
    }

    const plan  = await getPlan(company_id);
    const limit = BANK_STMT_EXTRACT_LIMITS[plan] ?? 0;

    if (limit === 0) {
      return res.status(403).json({
        success: false,
        code: 'PLAN_UPGRADE_REQUIRED',
        message: 'استخراج كشف الحساب البنكي بالذكاء الاصطناعي متاح من باقة النمو فأعلى.',
        current_plan: plan,
      });
    }

    const used = await getMonthlyUsage(company_id, 'extract_bank');
    if (used >= limit) {
      return res.status(403).json({
        success: false,
        code: 'AI_LIMIT_REACHED',
        message: `وصلت للحد الأقصى لاستخراج كشوفات الحساب البنكي هذا الشهر (${limit} ${limit===1?'مرة':'مرات'}). سيتجدد الحد أول الشهر القادم.`,
        used, limit,
      });
    }

    let result;
    if (pdf_base64) {
      const pdfBuffer = Buffer.from(pdf_base64, 'base64');
      result = await ai.extractBankStatementFromPDF(pdfBuffer);
    } else {
      result = await ai.extractBankStatementFromImages([image_base64]);
    }
    await logUsage(company_id, 'extract_bank', result.tokens_in, result.tokens_out, req.user.sub);

    let parsed = null;
    try { parsed = JSON.parse(cleanJSON(result.content)); } catch { /* fallback */ }

    if (!parsed || !Array.isArray(parsed.transactions)) {
      return res.status(422).json({ success: false, message: 'تعذّرت قراءة كشف الحساب — حاول برفع ملف أوضح' });
    }

    res.json({
      success: true,
      transactions: parsed.transactions,
      usage: { used: used + 1, limit },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'خطأ في الذكاء الاصطناعي' });
  }
};

// POST /api/ai/analyze
exports.analyze = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { summary } = req.body;
    if (!summary) return res.status(400).json({ success: false, message: 'summary مطلوب' });

    const plan  = await getPlan(company_id);
    const limit = ANALYZE_LIMITS[plan] ?? 0;

    if (limit === 0) {
      return res.status(403).json({
        success: false,
        code: 'PLAN_UPGRADE_REQUIRED',
        message: 'التحليل المالي الذكي متاح من باقة النمو فأعلى.',
        current_plan: plan,
      });
    }

    const used = await getMonthlyUsage(company_id, 'analyze');
    if (used >= limit) {
      return res.status(403).json({
        success: false,
        code: 'AI_LIMIT_REACHED',
        message: `وصلت للحد الأقصى للتحليل المالي هذا الشهر (${limit} مرة). يتجدد الحد أول الشهر القادم.`,
        used, limit,
      });
    }

    const result = await ai.analyzeFinancials(summary);
    await logUsage(company_id, 'analyze', result.tokens_in, result.tokens_out, req.user.sub);

    res.json({
      success: true,
      analysis: result.content,
      usage: { used: used + 1, limit },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'خطأ في التحليل الذكي' });
  }
};

// نطاق السياق المسموح لكل صلاحية — لا نثق بأي شيء يرسله المتصفح بخصوص ما
// يحق للمستخدم رؤيته؛ نُسقط أي حقل لا تغطيه صلاحياته الفعلية قبل ما يوصل
// للنموذج الذكي، حتى لو كان الطلب معدَّلًا مباشرة (تجاوزًا للواجهة).
// افتراضيًا "ممنوع" — أي حقل غير مُدرج صراحة هنا أو في SAFE_KEYS يُسقَط
// تلقائيًا، حتى لو نسينا نضيفه لاحقًا (fail closed، مو fail open).
const AI_CONTEXT_SAFE_KEYS = new Set([
  'today', 'yesterday', 'this_month', 'last_month',
  'company', 'vat_number', 'address', 'platform',
]);
const AI_CONTEXT_PERMISSION_MAP = {
  // ── الخزينة ──
  treasury: 'treasury.view', treasury_balance: 'treasury.view',
  // ── المبيعات/الفواتير ──
  invoice_count: 'sales.view', recent_invoices: 'sales.view', this_month_revenue: 'sales.view',
  today_invoices_count: 'sales.view', today_revenue: 'sales.view', today_invoices: 'sales.view',
  yesterday_invoices_count: 'sales.view', yesterday_revenue: 'sales.view', yesterday_invoices: 'sales.view',
  this_month_invoices_count: 'sales.view', last_month_revenue: 'sales.view', last_month_invoices: 'sales.view',
  invoices_total_count: 'sales.view', invoices_paid_count: 'sales.view', invoices_pending_count: 'sales.view',
  invoices_partial_count: 'sales.view', invoices_total_revenue: 'sales.view', invoices_total_collected: 'sales.view',
  invoices_total_remaining: 'sales.view', all_invoices: 'sales.view',
  this_month_net: ['sales.view', 'purchases.view'],
  // ── المشتريات ──
  this_month_expenses: 'purchases.view', today_expenses: 'purchases.view', yesterday_expenses: 'purchases.view',
  purchases_total_count: 'purchases.view', purchases_grand_total: 'purchases.view', recent_purchases: 'purchases.view',
  // ── العملاء ──
  customer_count: 'customers.view', top_customers: 'customers.view',
  customers_count: 'customers.view', customers_with_balance: 'customers.view',
  customers_total_balances: 'customers.view', customers: 'customers.view',
  // ── الموردون ──
  supplier_count: 'suppliers.view', top_suppliers: 'suppliers.view',
  suppliers_count: 'suppliers.view', suppliers_total_balance: 'suppliers.view', suppliers: 'suppliers.view',
  // ── المخزون ──
  product_count: 'inventory.view', products_count: 'inventory.view',
  low_stock_count: 'inventory.view', low_stock: 'inventory.view', products: 'inventory.view',
  // ── الموظفون والرواتب ──
  employees_count: 'employees.view', monthly_payroll: 'employees.view', employees: 'employees.view',
  // ── الالتزامات ──
  obligations_count: 'obligations.view', obligations_active_count: 'obligations.view',
  obligations_total_amount: 'obligations.view', obligations_monthly_equiv: 'obligations.view',
  obligations_due_soon: 'obligations.view', obligations: 'obligations.view',
  // ── عروض الأسعار ──
  quotes_count: 'quotes.view', quotes_pending: 'quotes.view', quotes_total: 'quotes.view',
};
function scopeAIContext(rawContext, user) {
  const ctx = rawContext && typeof rawContext === 'object' ? rawContext : {};
  if (user.role === 'owner') return ctx;
  const perms = user.perms || [];
  const scoped = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (AI_CONTEXT_SAFE_KEYS.has(key)) { scoped[key] = value; continue; }
    const needed = AI_CONTEXT_PERMISSION_MAP[key];
    if (!needed) continue; // حقل غير معروف → يُسقط دائمًا، ما نثق فيه افتراضيًا
    const neededArr = Array.isArray(needed) ? needed : [needed];
    if (neededArr.every(p => perms.includes(p))) scoped[key] = value;
  }
  return scoped;
}

// POST /api/ai/assistant
exports.assistant = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { question, history } = req.body;
    const context = scopeAIContext(req.body.context, req.user);
    if (!question) return res.status(400).json({ success: false, message: 'question مطلوب' });

    const plan  = await getPlan(company_id);
    const daily = ASSISTANT_DAILY[plan] ?? 0;

    if (daily === 0) {
      return res.status(403).json({
        success: false,
        code: 'PLAN_UPGRADE_REQUIRED',
        message: 'المساعد الذكي متاح من باقة النمو فأعلى.',
        current_plan: plan,
      });
    }

    const usedToday = await getDailyUsage(company_id, 'assistant');
    if (usedToday >= daily) {
      return res.status(403).json({
        success: false,
        code: 'AI_DAILY_LIMIT',
        message: `وصلت للحد اليومي (${daily} ${daily === 3 ? 'أسئلة' : 'سؤال'}). يتجدد الحد منتصف الليل.`,
        used: usedToday,
        limit: daily,
      });
    }

    // معلومات الباقة وحدود الاستخدام تُحسب من السيرفر مباشرة (مو من العميل)
    // عشان تكون موثوقة دائمًا، وهي آمنة تُعرض لأي موظف بغض النظر عن صلاحياته
    // لأنها معلومة على مستوى الشركة ككل وليست بيانات مالية لعميل/مورد معيّن
    const { rows: [coRow] } = await db.query(
      `SELECT subscription_expires_at FROM companies WHERE id=$1`, [company_id]
    );
    const [extractUsed, analyzeUsed] = await Promise.all([
      getMonthlyUsage(company_id, 'extract'),
      getMonthlyUsage(company_id, 'analyze'),
    ]);
    const daysLeft = coRow?.subscription_expires_at
      ? Math.ceil((new Date(coRow.subscription_expires_at) - new Date()) / 864e5)
      : null;
    context.platform = {
      plan,
      subscription_expires_at: coRow?.subscription_expires_at || null,
      days_until_subscription_expires: daysLeft,
      ai_usage: {
        extract:   { used: extractUsed, limit: EXTRACT_LIMITS[plan] ?? 0 },
        analyze:   { used: analyzeUsed, limit: ANALYZE_LIMITS[plan] ?? 0 },
        assistant: { used_today: usedToday, limit_daily: daily },
      },
    };

    const result = await ai.askAssistant(question, context || {}, Array.isArray(history) ? history : []);
    await logUsage(company_id, 'assistant', result.tokens_in, result.tokens_out, req.user.sub, question);

    res.json({
      success: true,
      answer: result.content,
      usage: { used: usedToday + 1, limit: daily },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'خطأ في المساعد الذكي' });
  }
};

// GET /api/ai/usage
exports.usage = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const plan = await getPlan(company_id);
    const [extractUsed, analyzeUsed, assistantDaily, bankStmtUsed] = await Promise.all([
      getMonthlyUsage(company_id, 'extract'),
      getMonthlyUsage(company_id, 'analyze'),
      getDailyUsage(company_id, 'assistant'),
      getMonthlyUsage(company_id, 'extract_bank'),
    ]);
    res.json({
      success: true,
      plan,
      usage: {
        extract:      { used: extractUsed,   limit: EXTRACT_LIMITS[plan]   ?? 0 },
        analyze:      { used: analyzeUsed,   limit: ANALYZE_LIMITS[plan]   ?? 0 },
        assistant:    { used: assistantDaily, limit: ASSISTANT_DAILY[plan] ?? 0, period: 'daily' },
        extract_bank: { used: bankStmtUsed,  limit: BANK_STMT_EXTRACT_LIMITS[plan] ?? 0 },
      },
    });
  } catch (err) { next(err); }
};
