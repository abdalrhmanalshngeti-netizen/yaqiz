const https  = require('https');
const db     = require('../config/db');

const PLAN_PRICES = { basic: 149, growth: 299, pro: 499 };
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
    const { plan, months = 1 } = req.body;
    const { company_id } = req.user;

    if (!PLAN_PRICES[plan]) {
      return res.status(400).json({ success: false, message: 'باقة غير صحيحة' });
    }

    const amount    = PLAN_PRICES[plan] * Math.max(1, Math.min(12, parseInt(months) || 1));
    const amountHalala = amount * 100;
    const callbackUrl = `${process.env.APP_URL || 'https://yaqiz.me'}/payment/callback`;

    const { rows: [company] } = await db.query(
      `SELECT name FROM companies WHERE id = $1`, [company_id]
    );

    const payload = {
      amount: amountHalala,
      currency: 'SAR',
      description: `اشتراك يقظ — باقة ${PLAN_LABELS[plan]} (${months} شهر)`,
      callback_url: callbackUrl,
      source: { type: 'creditcard' },
      metadata: { company_id: String(company_id), plan, months: String(months) }
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

    const meta = mPayment.metadata || {};
    const companyId = parseInt(meta.company_id);
    const plan      = meta.plan;
    const months    = parseInt(meta.months) || 1;

    if (!companyId || !PLAN_PRICES[plan]) {
      return res.redirect(`${redirectBase}/subscribe?error=invalid_meta`);
    }

    await db.query(`
      UPDATE payments SET status='paid', paid_at=NOW()
      WHERE moyasar_id=$1 AND status='pending'
    `, [id]);

    const expiresInterval = `${months * 30} days`;
    await db.query(`
      UPDATE companies
      SET plan=$1,
          subscription_expires_at = GREATEST(subscription_expires_at, NOW()) + INTERVAL '${expiresInterval}'
      WHERE id=$2
    `, [plan, companyId]);

    await db.query(`
      INSERT INTO subscriptions (company_id, plan, expires_at, amount, status)
      VALUES ($1,$2, NOW() + INTERVAL '${expiresInterval}', $3,'active')
    `, [companyId, plan, mPayment.amount / 100]);

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description)
      VALUES ('payment_success',$1,$2)
    `, [companyId, `دفع ناجح — باقة ${plan} — ${months} شهر — ${mPayment.amount / 100} ر.س`]);

    res.redirect(`${redirectBase}/VVIP.html?subscribed=1`);

  } catch (err) {
    console.error('[payment callback]', err.message);
    res.redirect(`${redirectBase}/subscribe?error=server_error`);
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
