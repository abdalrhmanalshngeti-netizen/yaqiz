// خدمة إنشاء إشعار دائن (Credit Note) فعلي — تُستدعى عند إلغاء فاتورة مبيعات
// كاملة أو عند تسجيل مرتجع مبيعات مرتبط بفاتورة، بدل تغيير حالة الفاتورة بصمت
// فقط. مستند مستقل بترقيمه التسلسلي الخاص (CN-xxxxxx)، مرجَّع للفاتورة الأصلية
// عبر BillingReference، ومار بنفس مسار توثيق الفاتورة العادية بالضبط: نفس
// سلسلة تجزئة ICV/PIH الموحّدة (zatcaHash.service)، نفس بناء XML
// (zatca.service: buildInvoiceXML مع docKind='credit_note')، نفس التوقيع
// الرقمي إن وُجدت شهادة CSID سارية، ونفس توليد رمز QR للمرحلة الثانية.
const crypto = require('crypto');
const { buildInvoiceXML, notifyIncompleteSellerData, resolveCustomerForXml, warnIfQrTotalsMismatch } = require('./zatca.service');
const { nextChainInfo, computeInvoiceHash, commitChainHash } = require('./zatcaHash.service');
const { buildXadesSignature, embedQR } = require('./zatcaSign.service');
const { generatePhase2QR, extractCaSignature } = require('./zatcaQR.service');
const zatcaOnboarding = require('./zatcaOnboarding.service');
const { submitCreditNote } = require('./zatcaSubmit.service');
const { nextDocNumber } = require('./docNumber.service');

/**
 * @param {object} client - عميل قاعدة بيانات ضمن معاملة قائمة (BEGIN سابق)
 * @param {object} opts
 * @param {number} opts.company_id
 * @param {object} opts.referenceInvoice - صف الفاتورة الأصلية كاملًا (من جدول invoices)
 * @param {object[]} opts.items - بنود الإشعار [{product_id, product_name, qty, unit_price, discount, line_total, vat_amount, vat_category_code}]
 * @param {'cancel'|'return'} opts.reason
 * @param {number|null} [opts.reference_return_id]
 * @param {number} opts.user_id
 * @returns {object} صف إشعار الدائن المُنشأ
 */
async function createCreditNote(client, { company_id, referenceInvoice, items, reason, reference_return_id, user_id }) {
  // عند الإلغاء الكامل، نُطابق قيم الفاتورة الأصلية حرفيًا (شاملةً أي خصم على
  // مستوى المستند) بدل إعادة حسابها من بنود invoice_items الخام — بنود الفاتورة
  // تحمل قيمها *قبل* توزيع أي خصم على مستوى المستند (invoices.controller.js
  // يطرح disc_amt ويوزّع الضريبة تناسبيًا بعد جمع بنود الأصل)، فإعادة الجمع من
  // الأصفار كانت تنتج إشعارًا بمبلغ أكبر من الفاتورة الأصلية لأي فاتورة فيها
  // خصم. المرتجع الجزئي يبقى محسوبًا من بنوده المُعطاة مباشرة (لا "إجمالي
  // فاتورة" واحد نطابقه لعملية جزئية أصلًا)
  let subtotal, discount_amount, vat_amount, grand_total;
  if (reason === 'cancel') {
    subtotal        = Number(referenceInvoice.subtotal || 0);
    discount_amount = Number(referenceInvoice.discount_amount || 0);
    vat_amount       = Number(referenceInvoice.vat_amount || 0);
    grand_total      = Number(referenceInvoice.grand_total || 0);
  } else {
    subtotal        = items.reduce((s, it) => s + Number(it.line_total || 0), 0);
    discount_amount = 0;
    vat_amount       = items.reduce((s, it) => s + Number(it.vat_amount || 0), 0);
    grand_total      = subtotal + vat_amount;
  }

  const cnSeqN = await nextDocNumber(client, company_id, 'credit_note');
  const note_no = `CN-${String(cnSeqN).padStart(6, '0')}`;

  const zatcaUuid = crypto.randomUUID();
  const { icv, previousInvoiceHash } = await nextChainInfo(client, company_id);
  const issueTimeStr = new Date().toTimeString().slice(0, 8);

  const noteReason = reason === 'cancel'
    ? `إشعار دائن — إلغاء الفاتورة ${referenceInvoice.invoice_no}`
    : `إشعار دائن — مرتجع على الفاتورة ${referenceInvoice.invoice_no}`;

  const { rows: [note] } = await client.query(`
    INSERT INTO credit_notes
      (company_id, note_no, reason, reference_invoice_id, reference_invoice_no, reference_return_id,
       customer_id, customer_name, customer_vat, date, subtotal, discount_amount, vat_amount, grand_total,
       payment_method, notes, zatca_uuid, icv, previous_invoice_hash, issue_time, branch_id, created_by, invoice_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    RETURNING *
  `, [company_id, note_no, reason, referenceInvoice.id, referenceInvoice.invoice_no, reference_return_id || null,
      referenceInvoice.customer_id || null, referenceInvoice.customer_name || null, referenceInvoice.customer_vat || null,
      subtotal, discount_amount, vat_amount, grand_total, referenceInvoice.payment_method || null, noteReason,
      zatcaUuid, icv, previousInvoiceHash, issueTimeStr, referenceInvoice.branch_id || null, user_id,
      referenceInvoice.invoice_type || 'simplified']);

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await client.query(`
      INSERT INTO credit_note_items
        (credit_note_id, product_id, product_name, qty, unit_price, discount, line_total, vat_amount, vat_category_code, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [note.id, it.product_id || null, it.product_name || '', it.qty, it.unit_price || 0,
        it.discount || 0, it.line_total, it.vat_amount || 0, it.vat_category_code || 'S', i]);
  }

  // بناء XML + توقيع + QR — نفس مسار الفاتورة العادية بالضبط، بلا تأثير على
  // إنشاء المستند نفسه لو فشل (يُسجَّل تحذير فقط، تمامًا كما مع الفواتير)
  let companyRow = null;
  let credential = null;
  try {
    ({ rows: [companyRow] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [company_id]));
    let customerRow = null;
    if (referenceInvoice.customer_id) {
      customerRow = (await client.query(`SELECT * FROM customers WHERE id = $1`, [referenceInvoice.customer_id])).rows[0];
    }
    customerRow = resolveCustomerForXml(customerRow, referenceInvoice.customer_name, referenceInvoice.customer_vat);
    const xmlItems = items.map(it => ({ ...it, vat_rate: it.vat_rate ?? 15, vat_category_code: it.vat_category_code || 'S' }));
    // buildInvoiceXML يتوقع كائنًا بشكل "فاتورة" — نمرر صف الإشعار مع تسميته
    // كـinvoice_no ليظهر بعنصر cbc:ID، ونمرر رقم الفاتورة الأصلية بـlinked_invoice_no
    // ليُستخدم داخل BillingReference (راجع zatca.service.js)
    const noteForXml = { ...note, invoice_no: note.note_no, linked_invoice_no: referenceInvoice.invoice_no };
    const { xml, warnings, totalTax, taxInclusive } = buildInvoiceXML({
      company: companyRow, customer: customerRow, invoice: noteForXml, items: xmlItems,
      previousInvoiceHash, docKind: 'credit_note',
    });
    warnIfQrTotalsMismatch('credit note', note_no, { totalTax, taxInclusive }, note.grand_total, note.vat_amount);
    const noteHash = computeInvoiceHash(xml);

    let finalXml = xml;
    let qrBase64 = null;
    // لا تراجع لشهادة compliance هنا — راجع نفس الملاحظة بـinvoices.controller.js
    credential = await zatcaOnboarding.getActiveCredential(client, company_id, 'production');
    if (credential) {
      try {
        const { signedXml, signatureValue } = buildXadesSignature({
          unsignedXml: xml, invoiceHash: noteHash, certificatePem: credential.certificatePem, privateKeyPem: credential.privateKeyPem,
        });
        finalXml = signedXml;
        const cert = new crypto.X509Certificate(credential.certificatePem);
        qrBase64 = generatePhase2QR({
          company: companyRow, invoice: noteForXml, invoiceHashBase64: noteHash, signatureValueBase64: signatureValue,
          publicKeyDer: cert.publicKey.export({ type: 'spki', format: 'der' }),
          caSignatureDer: extractCaSignature(cert.raw),
        });
        finalXml = embedQR(finalXml, qrBase64);
      } catch (signErr) {
        console.error(`[ZATCA] credit note ${note_no} signing/QR failed:`, signErr.message);
      }
    }

    await client.query(`UPDATE credit_notes SET xml_content = $1, zatca_hash = $2, zatca_qr_phase2 = $3 WHERE id = $4`,
      [finalXml, noteHash, qrBase64, note.id]);
    await commitChainHash(client, company_id, noteHash);
    note.xml_content = finalXml;
    note.zatca_hash = noteHash;
    note.zatca_qr_phase2 = qrBase64;
    if (warnings.length) {
      console.warn(`[ZATCA] credit note ${note_no} generated with incomplete seller data:`, warnings);
      await notifyIncompleteSellerData(client, company_id, warnings);
    }
  } catch (xmlErr) {
    console.error(`[ZATCA] credit note ${note_no} XML generation failed:`, xmlErr.message);
  }

  // حجب إشعارات الدائن لفواتير قياسية (غير مبسّطة) حتى تصديق فعلي من الهيئة —
  // نفس القرار المطبَّق أصلًا على الفاتورة القياسية نفسها بـinvoices.controller.js
  // exports.create (submitInvoice الحاجزة). قبل هذا الإصلاح، إشعار الدائن لفاتورة
  // قياسية كان يمر دائمًا بمسار "أفضل جهد" غير حاجز فقط (submitCreditNoteBestEffort
  // بعد الرد للعميل) — بعكس الفاتورة الأصلية التي يعكسها، فيمكن أن تُلغى/تُرجَع
  // فاتورة قياسية مصدَّقة فعليًا بمستند دائن لا يصل الهيئة أبدًا لو فشل الإرسال
  // اللاحق بصمت. لو لا توجد شهادة CSID سارية أصلًا (!credential) لا حجب —
  // نفس الاستثناء المطبَّق على الفاتورة الأصلية.
  const isSimplifiedNote = (note.invoice_type || 'simplified') === 'simplified';
  if (!isSimplifiedNote && credential) {
    const clearResult = await submitCreditNote(client, companyRow, note, false, credential);
    if (!clearResult.success) {
      throw Object.assign(
        new Error('تعذّر تصديق إشعار الدائن لدى هيئة الزكاة والضريبة والجمارك — لم تُحفَظ العملية. تحقق من الاتصال وأعد المحاولة.'),
        { status: 502, code: 'zatca_clearance_failed', zatca_error: clearResult.error || null }
      );
    }
    note.zatca_status = clearResult.status;
  }

  // حارس أمان: لو صار خطأ DB حقيقي (لا JS بحت) داخل try/catch أعلاه (استعلام
  // شهادة CSID، تحديث xml_content، ...)، تدخل المعاملة الحالية بحالة "معطوبة"
  // بصمت — وأي COMMIT لاحق عليها من المستدعي ينجح ظاهريًا لكنه فعليًا ينفّذ
  // ROLLBACK كاملًا (سلوك PostgreSQL موثّق: COMMIT على معاملة معطوبة = rollback
  // بلا خطأ). هذا الفحص الخفيف يكشف الحالة فورًا ويحوّلها لخطأ حقيقي يوقف
  // المعاملة عمدًا بدل نجاح صامت مضلِّل (الفاتورة تبقى "ملغاة" شكليًا بينما
  // فعليًا ما انحفظ شيء)
  try {
    await client.query('SELECT 1');
  } catch {
    throw new Error(`تعذّر إتمام توثيق إشعار الدائن ${note_no} بسبب خطأ داخلي بقاعدة البيانات — لم تُحفَظ أي عملية`);
  }

  return note;
}

module.exports = { createCreditNote };
