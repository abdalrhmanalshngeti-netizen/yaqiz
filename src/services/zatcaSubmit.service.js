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

const { ZATCA_ENDPOINTS } = require('./zatcaOnboarding.service');

async function zatcaFetch(url, { certPem, secret, body }) {
  const basicAuth = Buffer.from(`${Buffer.from(certPem).toString('base64')}:${secret}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Version': 'V2',
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`ZATCA API error ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
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

module.exports = { submitInvoice };
