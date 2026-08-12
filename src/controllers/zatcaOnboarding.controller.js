const db = require('../config/db');
const onboarding = require('../services/zatcaOnboarding.service');
const { submitInvoice } = require('../services/zatcaSubmit.service');

exports.status = async (req, res, next) => {
  try {
    const { rows: [co] } = await db.query(
      `SELECT zatca_onboarding_status FROM companies WHERE id = $1`, [req.user.company_id]
    );
    res.json({ success: true, data: { status: co?.zatca_onboarding_status || 'none' } });
  } catch (err) { next(err); }
};

exports.requestCompliance = async (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'هذه الميزة للمالك فقط' });
  }
  const { otp, environment } = req.body;
  if (!otp) return res.status(400).json({ success: false, message: 'رمز OTP مطلوب من بوابة فاتورة' });

  const client = await db.pool.connect();
  try {
    const { rows: [company] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    await client.query('BEGIN');
    const result = await onboarding.requestComplianceCSID(client, company, otp, environment || 'sandbox');
    await client.query('COMMIT');
    res.json({ success: true, message: 'تم إصدار شهادة الامتثال بنجاح', data: result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ZATCA onboarding] compliance CSID failed:', err.message);
    res.status(502).json({ success: false, message: `فشل الاتصال بالهيئة: ${err.message}` });
  } finally {
    client.release();
  }
};

exports.requestProduction = async (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'هذه الميزة للمالك فقط' });
  }
  const client = await db.pool.connect();
  try {
    const { rows: [company] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    await client.query('BEGIN');
    const result = await onboarding.requestProductionCSID(client, company, req.body.environment || 'sandbox');
    await client.query('COMMIT');
    res.json({ success: true, message: 'تم إصدار شهادة الإنتاج بنجاح', data: result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ZATCA onboarding] production CSID failed:', err.message);
    res.status(502).json({ success: false, message: `فشل الاتصال بالهيئة: ${err.message}` });
  } finally {
    client.release();
  }
};

// إرسال فعلي لفاتورة موجودة مسبقًا للهيئة (تصديق/إبلاغ) — منفصل عن إنشاء
// الفاتورة نفسها عمدًا (راجع التعليق أعلى zatcaSubmit.service.js)
exports.submitInvoiceToZatca = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { rows: [invoice] } = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.invoiceId, req.user.company_id]
    );
    if (!invoice) return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });

    const { rows: [company] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    let credential = await onboarding.getActiveCredential(client, req.user.company_id, 'production');
    if (!credential) credential = await onboarding.getActiveCredential(client, req.user.company_id, 'compliance');
    if (!credential) {
      return res.status(400).json({ success: false, message: 'لا توجد شهادة CSID سارية لهذه الشركة — أكمل تأهيل الهيئة أولًا' });
    }

    await client.query('BEGIN');
    const result = await submitInvoice(client, company, invoice, credential);
    await client.query('COMMIT'); // نلتزم دائمًا — حتى عند الرفض، تحديث حالة الفاتورة تشخيصي مهم ويجب أن يبقى محفوظًا

    if (result.success) {
      res.json({ success: true, message: result.status === 'cleared' ? 'تم تصديق الفاتورة من الهيئة' : 'تم إبلاغ الهيئة بالفاتورة', data: result });
    } else {
      console.error('[ZATCA submit] rejected by ZATCA:', result.error);
      res.status(502).json({ success: false, message: `فشل الإرسال للهيئة: ${result.error}` });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ZATCA submit] unexpected error:', err.message);
    res.status(500).json({ success: false, message: `خطأ غير متوقع: ${err.message}` });
  } finally {
    client.release();
  }
};
