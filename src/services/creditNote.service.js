// خدمة إنشاء إشعار دائن (Credit Note) فعلي — تُستدعى عند إلغاء فاتورة مبيعات
// كاملة أو عند تسجيل مرتجع مبيعات مرتبط بفاتورة، بدل تغيير حالة الفاتورة بصمت
// فقط. مستند مستقل بترقيمه التسلسلي الخاص (CN-xxxxxx)، مرجَّع للفاتورة الأصلية
// عبر BillingReference، ومار بنفس مسار توثيق الفاتورة العادية بالضبط: نفس
// سلسلة تجزئة ICV/PIH الموحّدة (zatcaHash.service)، نفس بناء XML
// (zatca.service: buildInvoiceXML مع docKind='credit_note')، نفس التوقيع
// الرقمي إن وُجدت شهادة CSID سارية، ونفس توليد رمز QR للمرحلة الثانية.
const crypto = require('crypto');
const { buildInvoiceXML } = require('./zatca.service');
const { nextChainInfo, computeInvoiceHash, commitChainHash } = require('./zatcaHash.service');
const { buildXadesSignature, embedSignature } = require('./zatcaSign.service');
const { generatePhase2QR } = require('./zatcaQR.service');
const zatcaOnboarding = require('./zatcaOnboarding.service');

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
  const subtotal    = items.reduce((s, it) => s + Number(it.line_total || 0), 0);
  const vat_amount  = items.reduce((s, it) => s + Number(it.vat_amount || 0), 0);
  const grand_total = subtotal + vat_amount;

  const { rows: [seq] } = await client.query(`SELECT NEXTVAL('credit_note_seq') AS n`);
  const note_no = `CN-${String(seq.n).padStart(6, '0')}`;

  const zatcaUuid = crypto.randomUUID();
  const { icv, previousInvoiceHash } = await nextChainInfo(client, company_id);
  const issueTimeStr = new Date().toTimeString().slice(0, 8);

  const noteReason = reason === 'cancel'
    ? `إشعار دائن — إلغاء الفاتورة ${referenceInvoice.invoice_no}`
    : `إشعار دائن — مرتجع على الفاتورة ${referenceInvoice.invoice_no}`;

  const { rows: [note] } = await client.query(`
    INSERT INTO credit_notes
      (company_id, note_no, reason, reference_invoice_id, reference_invoice_no, reference_return_id,
       customer_id, customer_name, customer_vat, date, subtotal, vat_amount, grand_total,
       payment_method, notes, zatca_uuid, icv, previous_invoice_hash, issue_time, branch_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING *
  `, [company_id, note_no, reason, referenceInvoice.id, referenceInvoice.invoice_no, reference_return_id || null,
      referenceInvoice.customer_id || null, referenceInvoice.customer_name || null, referenceInvoice.customer_vat || null,
      subtotal, vat_amount, grand_total, referenceInvoice.payment_method || null, noteReason,
      zatcaUuid, icv, previousInvoiceHash, issueTimeStr, referenceInvoice.branch_id || null, user_id]);

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
  try {
    const { rows: [companyRow] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [company_id]);
    let customerRow = null;
    if (referenceInvoice.customer_id) {
      customerRow = (await client.query(`SELECT * FROM customers WHERE id = $1`, [referenceInvoice.customer_id])).rows[0];
    }
    const xmlItems = items.map(it => ({ ...it, vat_rate: it.vat_rate ?? 15, vat_category_code: it.vat_category_code || 'S' }));
    // buildInvoiceXML يتوقع كائنًا بشكل "فاتورة" — نمرر صف الإشعار مع تسميته
    // كـinvoice_no ليظهر بعنصر cbc:ID، ونمرر رقم الفاتورة الأصلية بـlinked_invoice_no
    // ليُستخدم داخل BillingReference (راجع zatca.service.js)
    const noteForXml = { ...note, invoice_no: note.note_no, linked_invoice_no: referenceInvoice.invoice_no };
    const { xml, warnings } = buildInvoiceXML({
      company: companyRow, customer: customerRow, invoice: noteForXml, items: xmlItems,
      previousInvoiceHash, docKind: 'credit_note',
    });
    const noteHash = computeInvoiceHash(xml);

    let finalXml = xml;
    let qrBase64 = null;
    let credential = await zatcaOnboarding.getActiveCredential(client, company_id, 'production');
    if (!credential) credential = await zatcaOnboarding.getActiveCredential(client, company_id, 'compliance');
    if (credential) {
      try {
        const { ublExtensionsXml, signatureValue } = buildXadesSignature({
          invoiceHash: noteHash, certificatePem: credential.certificatePem, privateKeyPem: credential.privateKeyPem,
        });
        finalXml = embedSignature(xml, ublExtensionsXml);
        const cert = new crypto.X509Certificate(credential.certificatePem);
        qrBase64 = generatePhase2QR({
          company: companyRow, invoice: noteForXml, invoiceHashBase64: noteHash, signatureValueBase64: signatureValue,
          publicKeyDer: cert.publicKey.export({ type: 'spki', format: 'der' }),
        });
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
    }
  } catch (xmlErr) {
    console.error(`[ZATCA] credit note ${note_no} XML generation failed:`, xmlErr.message);
  }

  return note;
}

module.exports = { createCreditNote };
