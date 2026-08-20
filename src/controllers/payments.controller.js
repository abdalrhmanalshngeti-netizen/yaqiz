const https  = require('https');
const db     = require('../config/db');

const PLAN_PRICES = {
  basic:  { monthly: 199, annual: 2000 },
  growth: { monthly: 349, annual: 3700 },
  pro:    { monthly: 499, annual: 5500 },
};
const PLAN_LABELS = { basic: 'الأساسية', growth: 'النمو', pro: 'الاحترافية' };

function moyasarRequest(method, path, body, secretKey) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const auth = Buffer.from(`${secretKey}:`).toString('base64');
    const options = {
      hostname: 'api.moyasar.com',
      path,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

exports.createPayment = async (req, res, next) => {
  try {
    const { plan, cycle = 'monthly' } = req.body;
    const { company_id } = req.user;

    if (!PLAN_PRICES[plan]) {
      return res.status(400).json({ success: false, message: 'باقة غير صحيحة' });
    }

    const isAnnual  = cycle === 'annual';
    const amount    = isAnnual ? PLAN_PRICES[plan].annual : PLAN_PRICES[plan].monthly;
    const months    = isAnnual ? 12 : 1;
    const amountHalala = amount * 100;
    const callbackUrl = `${process.env.APP_URL || 'https://yaqiz.me'}/payment/callback`;

    const { rows: [company] } = await db.query(
      `SELECT name FROM companies WHERE id = $1`, [company_id]
    );

    const payload = {
      amount: amountHalala,
      currency: 'SAR',
      description: `اشتراك يقظ — باقة ${PLAN_LABELS[plan]} (${isAnnual ? 'سنوي' : 'شهري'})`,
      callback_url: callbackUrl,
      source: { type: 'creditcard' },
      metadata: { company_id: String(company_id), plan, months: String(months), cycle }
    };

    const moyasarRes = await moyasarRequest(
      'POST', '/v1/payments', payload,
      process.env.MOYASAR_SECRET_KEY
    );

    if (moyasarRes.status !== 201 || !moyasarRes.body.id) {
      console.error('[payment] Moyasar error:', moyasarRes.body);
      return res.status(502).json({ success: false, message: 'خطأ في بوابة الدفع، حاول لاحقاً' });
    }

    const mPayment = moyasarRes.body;

    await db.query(`
      INSERT INTO payments (company_id, moyasar_id, plan, amount, months, status, callback_url)
      VALUES ($1,$2,$3,$4,$5,'pending',$6)
      ON CONFLICT (moyasar_id) DO NOTHING
    `, [company_id, mPayment.id, plan, amount, months, callbackUrl]);

    const redirectUrl = mPayment.source?.transaction_url || mPayment.url;
    res.json({ success: true, payment_url: redirectUrl, payment_id: mPayment.id });

  } catch (err) { next(err); }
};

exports.verifyCallback = async (req, res) => {
  const { id } = req.query;
  const redirectBase = process.env.APP_URL || 'https://yaqiz.me';

  if (!id) return res.redirect(`${redirectBase}/subscribe?error=missing_id`);

  const client = await db.pool.connect();
  try {
    const moyasarRes = await moyasarRequest(
      'GET', `/v1/payments/${id}`, null,
      process.env.MOYASAR_SECRET_KEY
    );

    if (moyasarRes.status !== 200) {
      return res.redirect(`${redirectBase}/subscribe?error=verify_failed`);
    }

    const mPayment = moyasarRes.body;

    if (mPayment.status !== 'paid') {
      return res.redirect(`${redirectBase}/subscribe?error=not_paid&status=${mPayment.status}`);
    }

    await client.query('BEGIN');

    // مصدر الحقيقة هو صف payments المحلي (أنشأناه نحن وقت إنشاء الدفعة، بمبلغ
    // وباقة محسوبين بالسيرفر) — لا بيانات metadata الراجعة من Moyasar، لأنها
    // نظريًا قابلة للتلاعب لو استُخدم مسار دفع آخر بمفتاح publishable. FOR UPDATE
    // يمنع أيضًا معالجة نفس الدفعة مرتين بالتوازي (نداءين متزامنين لنفس id)
    const { rows: [payment] } = await client.query(
      `SELECT * FROM payments WHERE moyasar_id = $1 FOR UPDATE`, [id]
    );
    if (!payment) {
      await client.query('ROLLBACK');
      return res.redirect(`${redirectBase}/subscribe?error=unknown_payment`);
    }

    // المبلغ المدفوع فعليًا بالهيئة الخارجية يجب يطابق المبلغ المحسوب بالسيرفر
    // وقت إنشاء الدفعة تحديدًا — دفاع إضافي ضد أي دفعة أُنشئت أو عُدّلت خارج
    // مسار createPayment الطبيعي
    const expectedHalala = Math.round(Number(payment.amount) * 100);
    if (Math.abs(mPayment.amount - expectedHalala) > 1) {
      console.error(`[payment callback] amount mismatch: expected ${expectedHalala} halala, got ${mPayment.amount} for moyasar_id=${id}`);
      await client.query('ROLLBACK');
      return res.redirect(`${redirectBase}/subscribe?error=amount_mismatch`);
    }

    // idempotency فعلية: نتحقق من عدد الصفوف المتأثرة قبل ما نكمّل — لو الصف
    // مو 'pending' (اتعالج قبل كذا)، هذا استدعاء مكرر لنفس الرابط (تاريخ متصفح،
    // إعادة تحميل الصفحة) ولا يجوز يمدد الاشتراك من جديد
    const { rowCount } = await client.query(
      `UPDATE payments SET status='paid', paid_at=NOW() WHERE moyasar_id=$1 AND status='pending'`,
      [id]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.redirect(`${redirectBase}/VVIP.html?subscribed=1`);
    }

    const companyId = payment.company_id;
    const plan      = payment.plan;
    const isAnnual  = Number(payment.months) >= 12;

    // اشتراك سنوي = سنة تقويمية كاملة، مو 12×30 يوم تقريبية
    const expiresInterval = isAnnual ? '1 year' : '1 month';
    await client.query(`
      UPDATE companies
      SET plan=$1,
          subscription_expires_at = GREATEST(subscription_expires_at, NOW()) + INTERVAL '${expiresInterval}'
      WHERE id=$2
    `, [plan, companyId]);

    await client.query(`
      INSERT INTO subscriptions (company_id, plan, expires_at, amount, status)
      VALUES ($1,$2, NOW() + INTERVAL '${expiresInterval}', $3,'active')
    `, [companyId, plan, payment.amount]);

    await client.query(`
      INSERT INTO platform_log (event_type, company_id, description)
      VALUES ('payment_success',$1,$2)
    `, [companyId, `دفع ناجح — باقة ${plan} — ${payment.months} شهر — ${payment.amount} ر.س`]);

    await client.query('COMMIT');
    res.redirect(`${redirectBase}/VVIP.html?subscribed=1`);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[payment callback]', err.message);
    res.redirect(`${redirectBase}/subscribe?error=server_error`);
  } finally {
    client.release();
  }
};

exports.getStatus = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { rows: [co] } = await db.query(
      `SELECT plan, subscription_expires_at FROM companies WHERE id=$1`, [company_id]
    );
    const { rows: payments } = await db.query(
      `SELECT id, plan, amount, months, status, paid_at, created_at
       FROM payments WHERE company_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [company_id]
    );
    res.json({ success: true, data: { plan: co.plan, expires_at: co.subscription_expires_at, payments } });
  } catch (err) { next(err); }
};
