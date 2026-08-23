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

// لا نستخدم client مخصَّص من db.pool.connect() ولا معاملة صريحة هنا عمدًا —
// requestComplianceCSID/requestProductionCSID لا يكتبان شيئًا بقاعدة البيانات
// إلا بعد نجاح الاتصال الخارجي بالهيئة، فلا حاجة لأي atomicity تمتد عبر ذلك
// الاتصال. db.query يفتح اتصالًا من المسبح وينهيه لكل استعلام منفرد فورًا —
// فلا يبقى أي اتصال محجوزًا طوال مدة انتظار رد الهيئة (كان يهدد باستنزاف
// كامل مسبح الاتصالات — 20 فقط — لو تعطّلت بوابة الهيئة لأي سبب)
exports.requestCompliance = async (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'هذه الميزة للمالك فقط' });
  }
  const { otp, environment } = req.body;
  if (!otp) return res.status(400).json({ success: false, message: 'رمز OTP مطلوب من بوابة فاتورة' });

  try {
    const { rows: [company] } = await db.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    const result = await onboarding.requestComplianceCSID(db, company, otp, environment || 'sandbox');
    res.json({ success: true, message: 'تم إصدار شهادة الامتثال بنجاح', data: result });
  } catch (err) {
    console.error('[ZATCA onboarding] compliance CSID failed:', err.message);
    res.status(502).json({ success: false, message: `فشل الاتصال بالهيئة: ${err.message}` });
  }
};

exports.requestProduction = async (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'هذه الميزة للمالك فقط' });
  }
  try {
    const { rows: [company] } = await db.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    const result = await onboarding.requestProductionCSID(db, company, req.body.environment || 'sandbox');
    res.json({ success: true, message: 'تم إصدار شهادة الإنتاج بنجاح', data: result });
  } catch (err) {
    console.error('[ZATCA onboarding] production CSID failed:', err.message);
    res.status(502).json({ success: false, message: `فشل الاتصال بالهيئة: ${err.message}` });
  }
};

// إرسال فعلي لفاتورة موجودة مسبقًا للهيئة (تصديق/إبلاغ) — منفصل عن إنشاء
// الفاتورة نفسها عمدًا (راجع التعليق أعلى zatcaSubmit.service.js).
// بلا client/معاملة صريحة عمدًا (نفس مبدأ requestCompliance/requestProduction
// أعلاه) — submitInvoice يكتب حالة النتيجة (نجاح أو رفض) دائمًا بنفسه بعد
// انتهاء الاتصال الخارجي، فلا حاجة لأي معاملة تمتد عبر الانتظار للهيئة
exports.submitInvoiceToZatca = async (req, res, next) => {
  try {
    const { rows: [invoice] } = await db.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.invoiceId, req.user.company_id]
    );
    if (!invoice) return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });

    const { rows: [company] } = await db.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    let credential = await onboarding.getActiveCredential(db, req.user.company_id, 'production');
    if (!credential) credential = await onboarding.getActiveCredential(db, req.user.company_id, 'compliance');
    if (!credential) {
      return res.status(400).json({ success: false, message: 'لا توجد شهادة CSID سارية لهذه الشركة — أكمل تأهيل الهيئة أولًا' });
    }

    const result = await submitInvoice(db, company, invoice, credential);

    if (result.success) {
      res.json({ success: true, message: result.status === 'cleared' ? 'تم تصديق الفاتورة من الهيئة' : 'تم إبلاغ الهيئة بالفاتورة', data: result });
    } else {
      console.error('[ZATCA submit] rejected by ZATCA:', result.error);
      res.status(502).json({ success: false, message: `فشل الإرسال للهيئة: ${result.error}` });
    }
  } catch (err) {
    console.error('[ZATCA submit] unexpected error:', err.message);
    res.status(500).json({ success: false, message: `خطأ غير متوقع: ${err.message}` });
  }
};

// إرسال فعلي لإشعار دائن موجود مسبقًا للهيئة — نفس مسار submitInvoiceToZatca
// أعلاه بالضبط، لكن لمستند من جدول credit_notes المنفصل
exports.submitCreditNoteToZatca = async (req, res, next) => {
  try {
    const { rows: [note] } = await db.query(
      `SELECT * FROM credit_notes WHERE id = $1 AND company_id = $2`,
      [req.params.noteId, req.user.company_id]
    );
    if (!note) return res.status(404).json({ success: false, message: 'إشعار الدائن غير موجود' });

    const { rows: [refInvoice] } = await db.query(
      `SELECT invoice_type FROM invoices WHERE id = $1`, [note.reference_invoice_id]
    );
    const isSimplified = (refInvoice?.invoice_type || 'simplified') === 'simplified';

    const { rows: [company] } = await db.query(`SELECT * FROM companies WHERE id = $1`, [req.user.company_id]);
    let credential = await onboarding.getActiveCredential(db, req.user.company_id, 'production');
    if (!credential) credential = await onboarding.getActiveCredential(db, req.user.company_id, 'compliance');
    if (!credential) {
      return res.status(400).json({ success: false, message: 'لا توجد شهادة CSID سارية لهذه الشركة — أكمل تأهيل الهيئة أولًا' });
    }

    const result = await submitCreditNote(db, company, note, isSimplified, credential);

    if (result.success) {
      res.json({ success: true, message: result.status === 'cleared' ? 'تم تصديق إشعار الدائن من الهيئة' : 'تم إبلاغ الهيئة بإشعار الدائن', data: result });
    } else {
      console.error('[ZATCA submit] credit note rejected by ZATCA:', result.error);
      res.status(502).json({ success: false, message: `فشل الإرسال للهيئة: ${result.error}` });
    }
  } catch (err) {
    console.error('[ZATCA submit] credit note unexpected error:', err.message);
    res.status(500).json({ success: false, message: `خطأ غير متوقع: ${err.message}` });
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
