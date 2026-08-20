const db     = require('../config/db');
const crypto = require('crypto');
const { buildInvoiceXML } = require('../services/zatca.service');
const { nextChainInfo, computeInvoiceHash, commitChainHash } = require('../services/zatcaHash.service');
const { buildXadesSignature, embedSignature } = require('../services/zatcaSign.service');
const { generatePhase2QR } = require('../services/zatcaQR.service');
const zatcaOnboarding = require('../services/zatcaOnboarding.service');

const STATUS_AR = { draft:'معلق', sent:'مرسل', accepted:'مقبول', rejected:'مرفوض' };
const STATUS_EN = { 'معلق':'draft','مرسل':'sent','مقبول':'accepted','مرفوض':'rejected' };

exports.list = async (req, res, next) => {
  try {
    const { status, customer_id, from, to, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    let where  = [`q.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (status)      { where.push(`q.status = $${idx++}`);      params.push(status); }
    if (customer_id) { where.push(`q.customer_id = $${idx++}`); params.push(customer_id); }
    if (from)        { where.push(`q.date >= $${idx++}`);        params.push(from); }
    if (to)          { where.push(`q.date <= $${idx++}`);        params.push(to); }

    const { rows } = await db.query(`
      SELECT q.*, c.name AS customer_name_db, COUNT(*) OVER() AS total_count
      FROM quotes q
      LEFT JOIN customers c ON c.id = q.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY q.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, [...params, limit, offset]);

    res.json({ success: true, data: rows, total: parseInt(rows[0]?.total_count || 0), page: parseInt(page) });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows: [quote] } = await db.query(
      `SELECT q.*, c.name AS customer_name_db
       FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
       WHERE q.id = $1 AND q.company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!quote) return res.status(404).json({ success: false, message: 'العرض غير موجود' });
    const { rows: items } = await db.query(
      `SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY sort_order`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...quote, items } });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { company_id, sub: user_id } = req.user;
    const { customer_id, customer_name, date, valid_until, notes, status, items = [] } = req.body;

    let subtotal = 0;
    const processedItems = items.map((item, idx) => {
      const line_total = parseFloat(item.qty) * parseFloat(item.unit_price || item.price || 0)
                         - parseFloat(item.discount || 0);
      subtotal += line_total;
      return { ...item, line_total, sort_order: idx };
    });
    const vat_amount   = subtotal * 0.15;
    const grand_total  = subtotal + vat_amount;

    const { rows: [seqRow] } = await client.query(`SELECT nextval('quote_seq') AS n`);
    const quote_no = `QUO-${String(seqRow.n).padStart(6, '0')}`;

    const { rows: [quote] } = await client.query(`
      INSERT INTO quotes
        (company_id, quote_no, customer_id, customer_name, date, valid_until,
         status, subtotal, vat_amount, grand_total, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [company_id,
        quote_no,
        customer_id || null,
        customer_name || '',
        date || new Date().toISOString().slice(0, 10),
        valid_until || null,
        STATUS_EN[status] || status || 'draft',
        subtotal, vat_amount, grand_total,
        notes || '',
        user_id]);

    for (const item of processedItems) {
      await client.query(`
        INSERT INTO quote_items (quote_id, product_id, product_name, qty, unit_price, discount, line_total, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [quote.id, item.product_id || null, item.name || item.product_name || '',
          parseFloat(item.qty), parseFloat(item.unit_price || item.price || 0),
          parseFloat(item.discount || 0), parseFloat(item.line_total),
          item.sort_order || 0]);
    }

    await client.query('COMMIT');
    const { rows: items_out } = await client.query(
      `SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY sort_order`, [quote.id]
    );
    res.status(201).json({ success: true, data: { ...quote, items: items_out } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.update = async (req, res, next) => {
  try {
    const { status, notes, valid_until } = req.body;
    const dbStatus = STATUS_EN[status] || status;

    const { rows: [quote] } = await db.query(`
      UPDATE quotes SET
        status      = COALESCE($1, status),
        notes       = COALESCE($2, notes),
        valid_until = COALESCE($3, valid_until)
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [dbStatus || null, notes || null, valid_until || null,
        req.params.id, req.user.company_id]);

    if (!quote) return res.status(404).json({ success: false, message: 'العرض غير موجود' });
    res.json({ success: true, data: quote });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(
      `DELETE FROM quotes WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.convert = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { company_id, sub: user_id } = req.user;

    const { rows: [quote] } = await client.query(
      `SELECT q.* FROM quotes q
       WHERE q.id = $1 AND q.company_id = $2
       FOR UPDATE`,
      [req.params.id, company_id]
    );
    if (!quote) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'العرض غير موجود' }); }
    if (['accepted','rejected'].includes(quote.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'لا يمكن تحويل هذا العرض' });
    }

    const { rows: items } = await client.query(
      `SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY sort_order`, [req.params.id]
    );
    if (!items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'العرض لا يحتوي على بنود' });
    }

    const { rows: [seqRow] } = await client.query(`SELECT nextval('invoice_seq') AS n`);
    const invoice_no = `INV-${String(seqRow.n).padStart(6, '0')}`;

    // فاتورة محوّلة من عرض سعر تبقى جزءًا من نفس سلسلة ICV/PIH الموحّدة —
    // بدون هذا كانت تُترك بلا UUID/ICV/تجزئة إطلاقًا فتنكسر تسلسل السلسلة
    // القانوني (BR-KSA-26) لأي شركة تستخدم عروض الأسعار
    const zatcaUuid = crypto.randomUUID();
    const { icv, previousInvoiceHash } = await nextChainInfo(client, company_id);
    const issueTimeStr = new Date().toTimeString().slice(0, 8);

    const { rows: [invoice] } = await client.query(`
      INSERT INTO invoices
        (company_id, invoice_no, invoice_type, customer_id, customer_name, date, status,
         subtotal, discount_amount, vat_amount, grand_total, paid_amount,
         payment_method, notes, zatca_status, created_by,
         zatca_uuid, icv, previous_invoice_hash, issue_time)
      VALUES ($1,$2,'simplified',$3,$4,NOW(),'issued',$5,0,$6,$7,0,'آجل',$8,'pending',$9,$10,$11,$12,$13)
      RETURNING *
    `, [company_id, invoice_no,
        quote.customer_id || null, quote.customer_name,
        quote.subtotal, quote.vat_amount, quote.grand_total,
        `محوّل من ${quote.quote_no}`, user_id,
        zatcaUuid, icv, previousInvoiceHash, issueTimeStr]);

    const processedItems = items.map(item => ({
      ...item,
      vat_amount: parseFloat(item.line_total) * 0.15,
    }));

    for (let i = 0; i < processedItems.length; i++) {
      const item = processedItems[i];
      await client.query(`
        INSERT INTO invoice_items
          (invoice_id, product_id, product_name, qty, unit_price, discount, line_total, vat_amount, sort_order)
        VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8)
      `, [invoice.id, item.product_id || null, item.product_name,
          item.qty, item.unit_price, item.line_total,
          item.vat_amount, i]);
    }

    // ── توليد XML الفاتورة (المرحلة الثانية) — بنفس منطق invoices.controller.js
    // create()، غير حاجب لعملية التحويل لو فشل (نفس تعامل الفاتورة العادية) ──
    try {
      const { rows: [companyRow] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [company_id]);
      let customerRow = null;
      if (quote.customer_id) {
        customerRow = (await client.query(`SELECT * FROM customers WHERE id = $1`, [quote.customer_id])).rows[0];
      }
      const xmlItems = processedItems.map(it => ({
        ...it, vat_rate: 15, vat_category_code: 'S',
      }));
      const { xml, warnings } = buildInvoiceXML({
        company: companyRow, customer: customerRow, invoice, items: xmlItems, previousInvoiceHash,
      });
      const invoiceHash = computeInvoiceHash(xml);

      let finalXml = xml;
      let qrBase64 = null;
      let credential = await zatcaOnboarding.getActiveCredential(client, company_id, 'production');
      if (!credential) credential = await zatcaOnboarding.getActiveCredential(client, company_id, 'compliance');
      if (credential) {
        try {
          const { ublExtensionsXml, signatureValue } = buildXadesSignature({
            invoiceHash, certificatePem: credential.certificatePem, privateKeyPem: credential.privateKeyPem,
          });
          finalXml = embedSignature(xml, ublExtensionsXml);
          const cert = new crypto.X509Certificate(credential.certificatePem);
          qrBase64 = generatePhase2QR({
            company: companyRow, invoice, invoiceHashBase64: invoiceHash, signatureValueBase64: signatureValue,
            publicKeyDer: cert.publicKey.export({ type: 'spki', format: 'der' }),
          });
        } catch (signErr) {
          console.error(`[ZATCA] signing/QR failed for converted invoice ${invoice_no}:`, signErr.message);
        }
      }

      await client.query(`UPDATE invoices SET xml_content = $1, zatca_hash = $2, zatca_qr_phase2 = $3 WHERE id = $4`,
        [finalXml, invoiceHash, qrBase64, invoice.id]);
      await commitChainHash(client, company_id, invoiceHash);
      invoice.xml_content = finalXml;
      invoice.zatca_hash = invoiceHash;
      invoice.zatca_qr_phase2 = qrBase64;
      if (warnings.length) {
        console.warn(`[ZATCA] converted invoice ${invoice_no} generated with incomplete seller data:`, warnings);
      }
    } catch (xmlErr) {
      console.error(`[ZATCA] XML generation failed for converted invoice ${invoice_no}:`, xmlErr.message);
    }

    await client.query(
      `UPDATE quotes SET status='accepted', converted_invoice_id=$1 WHERE id=$2`,
      [invoice.id, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, data: { ...invoice, items: processedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
