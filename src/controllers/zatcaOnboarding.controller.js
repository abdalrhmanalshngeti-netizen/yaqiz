const db = require('../config/db');
const onboarding = require('../services/zatcaOnboarding.service');
const { submitInvoice, submitCreditNote } = require('../services/zatcaSubmit.service');

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

// إرسال فعلي لإشعار دائن موجود مسبقًا للهيئة — نفس مسار submitInvoiceToZatca
// أعلاه بالضبط، لكن لمستند من جدول credit_notes المنفصل
exports.submitCreditNoteToZatca = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { rows: [note] } = await client.query(
      `SELECT * FROM credit_notes WHERE id = $1 AND company_id = $2`,
      [req.params.noteId, req.user.company_id]
    );
    if (!note) return res.status(404).json({ success: false, message: 'إشعار الدائن غير موجود' });

    const { rows: [refInvoice] } = await client.query(
      `SELECT invoice_type FROM invoices WHERE id = $1`, [note.reference_invoice_id]
    );
    const isSimplified = (refInvoice?.invoice_type || 'simplified') === 'simplified';

    const { rows: [company] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    let credential = await onboarding.getActiveCredential(client, req.user.company_id, 'production');
    if (!credential) credential = await onboarding.getActiveCredential(client, req.user.company_id, 'compliance');
    if (!credential) {
      return res.status(400).json({ success: false, message: 'لا توجد شهادة CSID سارية لهذه الشركة — أكمل تأهيل الهيئة أولًا' });
    }

    await client.query('BEGIN');
    const result = await submitCreditNote(client, company, note, isSimplified, credential);
    await client.query('COMMIT');

    if (result.success) {
      res.json({ success: true, message: result.status === 'cleared' ? 'تم تصديق إشعار الدائن من الهيئة' : 'تم إبلاغ الهيئة بإشعار الدائن', data: result });
    } else {
      console.error('[ZATCA submit] credit note rejected by ZATCA:', result.error);
      res.status(502).json({ success: false, message: `فشل الإرسال للهيئة: ${result.error}` });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ZATCA submit] credit note unexpected error:', err.message);
    res.status(500).json({ success: false, message: `خطأ غير متوقع: ${err.message}` });
  } finally {
    client.release();
  }
};

// قائمة أحدث المستندات (فواتير + إشعارات دائن) الموقّعة محليًا وغير المُرسلة
// للهيئة بعد — تغذّي واجهة "الإرسال اليدوي" بتبويب ربط الهيئة بالإعدادات
exports.pendingDocuments = async (req, res, next) => {
  try {
    const { rows: invoices } = await db.query(`
      SELECT id, invoice_no AS doc_no, 'invoice' AS doc_type, grand_total, date, zatca_status
      FROM invoices
      WHERE company_id = $1 AND xml_content IS NOT NULL AND (zatca_status IS NULL OR zatca_status = 'pending')
      ORDER BY icv DESC NULLS LAST LIMIT 50
    `, [req.user.company_id]);
    const { rows: notes } = await db.query(`
      SELECT id, note_no AS doc_no, 'credit_note' AS doc_type, grand_total, date, zatca_status
      FROM credit_notes
      WHERE company_id = $1 AND xml_content IS NOT NULL AND (zatca_status IS NULL OR zatca_status = 'pending')
      ORDER BY icv DESC NULLS LAST LIMIT 50
    `, [req.user.company_id]);
    const merged = [...invoices, ...notes].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);
    res.json({ success: true, data: merged });
  } catch (err) { next(err); }
};
