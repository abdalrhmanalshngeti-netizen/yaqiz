// المرحلة الثانية للفوترة الإلكترونية — الخطوة 6: الإرسال الفعلي للهيئة
// (Clearance للفواتير الضريبية القياسية B2B، Reporting للفواتير المبسطة B2C)
//
// ⚠️ لم يُختبر بعد ضد سيرفرات الهيئة الحقيقية (لا يوجد حساب/شهادة إنتاج حقيقية
// بهذه البيئة) — نقاط النهاية وبنية الطلب مبنية على التوثيق العام لواجهة ZATCA
// REST API. الخطأ يُرجَع بوضوح ولا يُسقَط بصمت، لتسهيل التشخيص أول استخدام حقيقي.
//
// قرار معماري مقصود: الإرسال هنا **منفصل** عن معاملة إنشاء الفاتورة نفسها (غير
// متزامن معها) — إنشاء فاتورة بنقطة بيع يجب ألا يتعطل أو يتأخر بسبب استجابة
// خادم خارجي قد يكون بطيئًا أو غير متاح مؤقتًا. الفاتورة تُنشأ وتُوقَّع محليًا
// فورًا (الخطوات 2-5)، ثم يُستدعى هذا الملف كخطوة تالية (يدويًا الآن، ويصلح لاحقًا
// كمهمة تُشغَّل تلقائيًا عبر نفس محرك المزامنة الخلفية الموجود أصلًا بالمنصة).

const db = require('../config/db');
const { ZATCA_ENDPOINTS, getActiveCredential } = require('./zatcaOnboarding.service');

// مهلة زمنية إلزامية (راجع نفس التعليق بـzatcaOnboarding.service.js) — بوابة
// الهيئة المعلَّقة بلا هذا كانت تُبقي طلب الإرسال معلَّقًا للأبد
async function zatcaFetch(url, { certPem, secret, body }) {
  const basicAuth = Buffer.from(`${Buffer.from(certPem).toString('base64')}:${secret}`).toString('base64');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Version': 'V2',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`ZATCA API error ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('انتهت مهلة الاتصال ببوابة الهيئة (20 ثانية) بلا رد');
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * يرسل فاتورة موقَّعة فعليًا للهيئة — تصديق فوري (Clearance) للفواتير الضريبية
 * القياسية، أو إبلاغ (Reporting) للفواتير المبسطة، حسب invoice_type.
 * @param {object} client   اتصال قاعدة بيانات ضمن معاملة
 * @param {object} company  صف الشركة
 * @param {object} invoice  صف الفاتورة (يحتاج xml_content, zatca_uuid, invoice_no, invoice_type)
 * @param {object} credential { certificatePem, secret, environment } من getActiveCredential('production')
 */
async function submitInvoice(client, company, invoice, credential) {
  if (!invoice.xml_content) throw new Error('لا يوجد XML محفوظ لهذه الفاتورة — يجب توليده وتوقيعه أولًا');
  const isSimplified = (invoice.invoice_type || 'simplified') === 'simplified';
  const endpoint = isSimplified ? 'invoices/reporting/single' : 'invoices/clearance/single';
  const url = `${ZATCA_ENDPOINTS[credential.environment] || ZATCA_ENDPOINTS.sandbox}/${endpoint}`;

  const invoiceHashB64 = invoice.zatca_hash;
  const body = {
    invoiceHash: invoiceHashB64,
    uuid: invoice.zatca_uuid,
    invoice: Buffer.from(invoice.xml_content, 'utf8').toString('base64'),
  };

  // لا نرمي استثناءً عند رفض الهيئة الطلب (401/400 وغيرها) — هذا رد فعل تجاري
  // متوقع (بيانات اعتماد غير صالحة/فاتورة مرفوضة)، لا خطأ نظام. الاستدعاء يُرجع
  // نتيجة بحقل success تصف الحالة، ويُحدَّث صف الفاتورة دائمًا بنفس المعاملة
  // الأصلية بلا حاجة لالتفاف try/rollback من المستدعي يمحو أثر التحديث.
  try {
    const data = await zatcaFetch(url, { certPem: credential.certificatePem, secret: credential.secret, body });
    const status = isSimplified ? 'reported' : 'cleared';
    await client.query(
      `UPDATE invoices SET zatca_status = $1, zatca_response = $2, zatca_submitted_at = NOW() WHERE id = $3`,
      [status, JSON.stringify(data).slice(0, 8000), invoice.id]
    );
    return { success: true, status, data };
  } catch (err) {
    await client.query(
      `UPDATE invoices SET zatca_status = 'rejected', zatca_response = $1, zatca_submitted_at = NOW() WHERE id = $2`,
      [JSON.stringify({ error: err.message, data: err.data }).slice(0, 8000), invoice.id]
    );
    return { success: false, status: 'rejected', error: err.message, data: err.data };
  }
}

/**
 * نفس منطق submitInvoice أعلاه بالضبط، لكن لمستند إشعار دائن (جدول credit_notes
 * المنفصل) بدل فاتورة — إشعار الدائن نوع مستند قياسي بمنظور الهيئة (BT-3=381)
 * ويمر بنفس مساري التصديق/الإبلاغ حسب نوع الفاتورة المرجعية.
 * @param {object} client
 * @param {object} company
 * @param {object} note        صف من جدول credit_notes (يحتاج xml_content, zatca_uuid)
 * @param {boolean} isSimplified هل الفاتورة المرجعية مبسطة (تحدد Reporting أو Clearance)
 * @param {object} credential
 */
async function submitCreditNote(client, company, note, isSimplified, credential) {
  if (!note.xml_content) throw new Error('لا يوجد XML محفوظ لإشعار الدائن هذا — يجب توليده وتوقيعه أولًا');
  const endpoint = isSimplified ? 'invoices/reporting/single' : 'invoices/clearance/single';
  const url = `${ZATCA_ENDPOINTS[credential.environment] || ZATCA_ENDPOINTS.sandbox}/${endpoint}`;

  const body = {
    invoiceHash: note.zatca_hash,
    uuid: note.zatca_uuid,
    invoice: Buffer.from(note.xml_content, 'utf8').toString('base64'),
  };

  try {
    const data = await zatcaFetch(url, { certPem: credential.certificatePem, secret: credential.secret, body });
    const status = isSimplified ? 'reported' : 'cleared';
    await client.query(
      `UPDATE credit_notes SET zatca_status = $1, zatca_response = $2, zatca_submitted_at = NOW() WHERE id = $3`,
      [status, JSON.stringify(data).slice(0, 8000), note.id]
    );
    return { success: true, status, data };
  } catch (err) {
    await client.query(
      `UPDATE credit_notes SET zatca_status = 'rejected', zatca_response = $1, zatca_submitted_at = NOW() WHERE id = $2`,
      [JSON.stringify({ error: err.message, data: err.data }).slice(0, 8000), note.id]
    );
    return { success: false, status: 'rejected', error: err.message, data: err.data };
  }
}

// إرسال تلقائي "أفضل جهد" فور إنشاء فاتورة ضريبية قياسية (غير مبسّطة) — تُستدعى
// بلا انتظار (fire-and-forget) بعد الرد على العميل مباشرة، فلا تؤخر إنشاء
// الفاتورة نفسه ولا تُفشله لو رفضت الهيئة الطلب أو تعذّر الاتصال بها؛ أي فشل
// يبقى ظاهرًا فقط بحالة zatca_status ('rejected') ليعيد المالك الإرسال يدويًا
// لاحقًا. الفواتير المبسّطة تُستثنى عمدًا — لا تحتاج تصديقًا فوريًا أصلًا
// (تُبلَّغ للهيئة خلال 24 ساعة، لا قبل التسليم للعميل كالقياسية).
// لا تحجز اتصالًا مخصَّصًا من المسبح — db.query يفتح/يُنهي اتصالًا لكل استعلام
// منفرد فورًا، فلا يبقى أي اتصال محجوزًا طوال مدة انتظار رد الهيئة (submitInvoice
// نفسه لا يحتاج معاملة صريحة، يكتب حالة النتيجة دائمًا بعد انتهاء الاتصال الخارجي)
async function submitInvoiceBestEffort(invoiceId, companyId) {
  if (!invoiceId || !companyId) return;
  try {
    const { rows: [invoice] } = await db.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [invoiceId, companyId]
    );
    if (!invoice || (invoice.invoice_type || 'simplified') === 'simplified') return;
    if (!invoice.xml_content) return; // لم يُوقَّع أصلًا (بلا شهادة CSID سارية) — لا شيء نرسله

    let credential = await getActiveCredential(db, companyId, 'production');
    if (!credential) credential = await getActiveCredential(db, companyId, 'compliance');
    if (!credential) return; // لا تأهيل هيئة بعد — الحالة الشائعة اليوم لمعظم الشركات

    const { rows: [company] } = await db.query(`SELECT * FROM companies WHERE id = $1`, [companyId]);
    const result = await submitInvoice(db, company, invoice, credential);
    if (!result.success) {
      console.warn(`[ZATCA auto-submit] invoice ${invoice.invoice_no} rejected/failed:`, result.error);
    }
  } catch (err) {
    console.error(`[ZATCA auto-submit] unexpected error for invoice ${invoiceId}:`, err.message);
  }
}

// نفس مبدأ submitInvoiceBestEffort أعلاه بالضبط، لكن لإشعار دائن — isSimplified
// يُمرَّر من المستدعي لأنه محسوب مسبقًا هناك من نوع الفاتورة المرجعية
async function submitCreditNoteBestEffort(noteId, companyId, isSimplified) {
  if (!noteId || !companyId || isSimplified) return;
  try {
    const { rows: [note] } = await db.query(
      `SELECT * FROM credit_notes WHERE id = $1 AND company_id = $2`, [noteId, companyId]
    );
    if (!note || !note.xml_content) return;

    let credential = await getActiveCredential(db, companyId, 'production');
    if (!credential) credential = await getActiveCredential(db, companyId, 'compliance');
    if (!credential) return;

    const { rows: [company] } = await db.query(`SELECT * FROM companies WHERE id = $1`, [companyId]);
    const result = await submitCreditNote(db, company, note, isSimplified, credential);
    if (!result.success) {
      console.warn(`[ZATCA auto-submit] credit note ${note.note_no} rejected/failed:`, result.error);
    }
  } catch (err) {
    console.error(`[ZATCA auto-submit] unexpected error for credit note ${noteId}:`, err.message);
  }
}

module.exports = { submitInvoice, submitCreditNote, submitInvoiceBestEffort, submitCreditNoteBestEffort };
