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

async function logUsage(company_id, feature, tokens_in, tokens_out) {
  await db.query(`
    INSERT INTO ai_usage (company_id, feature, tokens_in, tokens_out)
    VALUES ($1,$2,$3,$4)
  `, [company_id, feature, tokens_in || 0, tokens_out || 0]);
}

// ── Plan limits ──────────────────────────────────────────────
const EXTRACT_LIMITS  = { basic: 30,  growth: 100, pro: 500 };
const ANALYZE_LIMITS  = { basic: 0,   growth: 10,  pro: 200 };
const ASSISTANT_DAILY = { basic: 0,   growth: 3,   pro: 9999 };
// assistant: pro only, no hard monthly limit (fair use)

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
    await logUsage(company_id, 'extract', result.tokens_in, result.tokens_out);

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
    await logUsage(company_id, 'analyze', result.tokens_in, result.tokens_out);

    res.json({
      success: true,
      analysis: result.content,
      usage: { used: used + 1, limit },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'خطأ في التحليل الذكي' });
  }
};

// POST /api/ai/assistant
exports.assistant = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { question, context, history } = req.body;
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

    const result = await ai.askAssistant(question, context || {}, Array.isArray(history) ? history : []);
    await logUsage(company_id, 'assistant', result.tokens_in, result.tokens_out);

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
    const [extractUsed, analyzeUsed, assistantDaily] = await Promise.all([
      getMonthlyUsage(company_id, 'extract'),
      getMonthlyUsage(company_id, 'analyze'),
      getDailyUsage(company_id, 'assistant'),
    ]);
    res.json({
      success: true,
      plan,
      usage: {
        extract:   { used: extractUsed,   limit: EXTRACT_LIMITS[plan]   ?? 0 },
        analyze:   { used: analyzeUsed,   limit: ANALYZE_LIMITS[plan]   ?? 0 },
        assistant: { used: assistantDaily, limit: ASSISTANT_DAILY[plan] ?? 0, period: 'daily' },
      },
    });
  } catch (err) { next(err); }
};
