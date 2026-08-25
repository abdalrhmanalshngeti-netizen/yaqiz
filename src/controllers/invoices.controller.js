const db     = require('../config/db');
const stock  = require('../services/stock.service');
const branch = require('../services/branch.service');
const logAudit = require('../middleware/logger');
const crypto = require('crypto');
const { buildInvoiceXML, notifyIncompleteSellerData, resolveCustomerForXml } = require('../services/zatca.service');
const { nextChainInfo, computeInvoiceHash, commitChainHash } = require('../services/zatcaHash.service');
const { buildXadesSignature, embedSignature, embedQR } = require('../services/zatcaSign.service');
const { generatePhase2QR, extractCaSignature } = require('../services/zatcaQR.service');
const zatcaOnboarding = require('../services/zatcaOnboarding.service');
const { createCreditNote } = require('../services/creditNote.service');
const { nextDocNumber } = require('../services/docNumber.service');
const { submitInvoice, submitInvoiceBestEffort, submitCreditNoteBestEffort } = require('../services/zatcaSubmit.service');
const periodClose = require('../services/periodClose.service');
const { todayLocalDateStr } = require('../utils/date.util');

exports.list = async (req, res, next) => {
  try {
    const { status, customer_id, from, to, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where  = [`i.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (status)      { where.push(`i.status = $${idx++}`);           params.push(status); }
    if (customer_id) { where.push(`i.customer_id = $${idx++}`);      params.push(customer_id); }
    if (from)        { where.push(`i.date >= $${idx++}`);             params.push(from); }
    if (to)          { where.push(`i.date <= $${idx++}`);             params.push(to); }

    // بدون بنود الفاتورة هنا، كل عملية سحب دورية (loadAllFromAPI/كل 60 ثانية)
    // كانت تستبدل db.invoices محليًا بنسخة بلا items إطلاقًا — الفاتورة تفقد
    // أصنافها المعروضة خلال دقيقة من إنشائها على كل جهاز
    const { rows } = await db.query(`
      SELECT i.*, c.name AS customer_name,
             COALESCE(
               (SELECT json_agg(json_build_object(
                  'id', ii.id, 'product_id', ii.product_id, 'product_name', ii.product_name,
                  'product_code', ii.product_code, 'qty', ii.qty::float, 'unit_price', ii.unit_price::float,
                  'discount', ii.discount::float, 'line_total', ii.line_total::float,
                  'vat_amount', ii.vat_amount::float, 'unit_cost', ii.unit_cost::float
                ) ORDER BY ii.sort_order)
                FROM invoice_items ii WHERE ii.invoice_id = i.id),
               '[]'::json
             ) AS items,
             COUNT(*) OVER() AS total_count
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, [...params, limit, offset]);

    res.json({
      success: true,
      data:  rows,
      total: parseInt(rows[0]?.total_count || 0),
      page:  parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows: [invoice] } = await db.query(
      `SELECT i.*, c.name AS customer_name, c.vat_number AS customer_vat_db
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!invoice) return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });

    const { rows: items } = await db.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...invoice, items } });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { company_id, sub: user_id } = req.user;
    const {
      customer_id, customer_name, customer_vat, invoice_type,
      date, due_date, items = [], discount_type, discount_value,
      payment_method, notes, client_local_id
    } = req.body;
    // cogs_total لم يعد يُقبَل من الـclient إطلاقًا — كان تمريرًا مباشرًا بلا
    // أي تحقق، والسيرفر الآن مصدر الحقيقة الوحيد (عبر stock.deduct وطبقات
    // stock_lots)؛ يُحسَب فعليًا بعد خصم المخزون أدناه وتُحدَّث به الفاتورة

    if (!items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'يجب إضافة منتج واحد على الأقل' });
    }

    // الفاتورة الضريبية القياسية (غير المبسّطة) يجب تحديد هوية المشتري بها وفق
    // متطلبات الهيئة — لم يكن هناك أي فحص، فكان بالإمكان إنشاء فاتورة "tax"
    // بلا عميل محفوظ ولا اسم مُدخَل يدويًا، فيخرج XML بعميل "عميل نقدي" مجهول
    // على فاتورة يُفترض بها تعريف الطرف الآخر. الفاتورة المبسّطة (نقاط البيع)
    // تبقى بلا أي قيد كالمعتاد — هذا النوع بالتحديد مصمَّم أصلًا للعميل المجهول
    if ((invoice_type || 'simplified') !== 'simplified' && !customer_id && !String(customer_name || '').trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'الفاتورة الضريبية القياسية تتطلب تحديد بيانات المشتري (اختيار عميل محفوظ أو إدخال اسم العميل على الأقل)' });
    }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ فاتورة
    // مكرَّرة (وتخصم المخزون مرتين وتزيد سلسلة ICV مرتين) — نتعرّف على المحاولة
    // السابقة عبر المعرّف المحلي بالمتصفح
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT *, (SELECT COALESCE(json_agg(json_build_object(
            'id', ii.id, 'product_id', ii.product_id, 'product_name', ii.product_name,
            'qty', ii.qty::float, 'unit_price', ii.unit_price::float, 'line_total', ii.line_total::float,
            'vat_amount', ii.vat_amount::float
          )), '[]'::json) FROM invoice_items ii WHERE ii.invoice_id = invoices.id) AS items
         FROM invoices WHERE company_id = $1 AND client_local_id = $2`,
        [company_id, client_local_id]
      );
      if (existing) { await client.query('COMMIT'); return res.status(201).json({ success: true, data: existing }); }
    }

    if (customer_id) {
      const { rows: [custRow] } = await client.query(
        `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
        [customer_id, company_id]
      );
      if (!custRow) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'العميل غير موجود' });
      }
    }

    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, company_id, date || todayLocalDateStr(), req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    // فرع الفاتورة: مصرَّح صراحة بالطلب (نقطة بيع/فرع مُختار) وإلا فرع البائع
    // نفسه — بقراءة طازجة دائمًا، ليس من التوكن (المالك يقدر يغيّر فرع الموظف
    // بأي وقت والتوكن يبقى صالحًا ٨ ساعات)
    const { branch_id: resolvedBranchId, warehouse_id: resolvedWarehouseId } =
      await branch.resolveWarehouseForUser(client, company_id, user_id, req.body.branch_id, req.user.role);

    // ── التحقق من كفاية المخزون *بمستودع هذا الفرع تحديدًا* قبل إنشاء أي شيء —
    // نرفض الفاتورة كاملة بدل إنشائها وتجاهل خصم المخزون بصمت لو الكمية غير
    // كافية بهذا المستودع تحديدًا (كان يسبب تضاربًا بين الدفاتر والمخزون الفعلي).
    // القفل (FOR UPDATE) يمنع تضارب السباق مع عملية بيع أخرى متزامنة على نفس الصنف.
    // نجمع الكمية المطلوبة *لكل صنف* أولًا (بدل فحص كل سطر بمفرده) عشان لو نفس
    // الصنف تكرر بأكثر من سطر بنفس الفاتورة، يُقاس مجموع الكميين معًا مقابل
    // المتوفر فعليًا، لا كل سطر منفصل (كان يسمح ببيع أكثر من المخزون الفعلي).
    // كذلك نقفل الأصناف بترتيب ثابت (حسب product_id) لمنع احتمال deadlock بين
    // فاتورتين متزامنتين تحتويان نفس الصنفين بترتيب معكوس.
    const requiredByProduct = new Map();
    for (const item of items) {
      if (!item.product_id) continue;
      requiredByProduct.set(item.product_id, (requiredByProduct.get(item.product_id) || 0) + parseFloat(item.qty));
    }
    const stockShortages = [];
    for (const product_id of [...requiredByProduct.keys()].sort((a, b) => a - b)) {
      const { rows: [prod] } = await client.query(
        `SELECT p.name, COALESCE(ps.qty, 0) AS qty
         FROM products p
         LEFT JOIN product_stock ps ON ps.product_id = p.id AND ps.warehouse_id = $3
         WHERE p.id = $1 AND p.company_id = $2 FOR UPDATE OF p`,
        [product_id, company_id, resolvedWarehouseId]
      );
      if (!prod) continue;
      const requiredQty = requiredByProduct.get(product_id);
      if (parseFloat(prod.qty) < requiredQty) {
        stockShortages.push(`${prod.name} (المتوفر بهذا الفرع: ${prod.qty}، المطلوب: ${requiredQty})`);
      }
    }
    if (stockShortages.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: `الكمية غير كافية بالمخزون: ${stockShortages.join('، ')}`
      });
    }

    // ── حساب المبالغ ──────────────────────────
    let subtotal = 0;
    const processedItems = items.map(item => {
      const line_total = parseFloat(item.qty) * parseFloat(item.unit_price) - parseFloat(item.discount || 0);
      const vat_amount = line_total * (parseFloat(item.tax_rate ?? 15) / 100);
      subtotal += line_total;
      return { ...item, line_total, vat_amount };
    });

    const disc_val    = parseFloat(discount_value || 0);
    const disc_amt    = discount_type === 'percent' ? subtotal * disc_val / 100 : disc_val;
    const taxable     = subtotal - disc_amt;
    const rawItemVat  = processedItems.reduce((s, it) => s + it.vat_amount, 0);
    const vat_amount  = subtotal > 0 ? rawItemVat * (taxable / subtotal) : 0;
    const grand       = taxable + vat_amount;

    // ── رقم الفاتورة — عدّاد مستقل لكل شركة (لا تسلسل عام مشترك) ──────────
    const invSeqN = await nextDocNumber(client, company_id, 'invoice');
    const invoice_no = `INV-${String(invSeqN).padStart(6, '0')}`;

    // ── معرّفات المرحلة الثانية للفوترة الإلكترونية (ZATCA): UUID فريد،
    // عداد تسلسلي (ICV)، وتجزئة الفاتورة السابقة بالسلسلة — nextChainInfo تقفل
    // آخر صف بنفس المعاملة لمنع تضارب فاتورتين تُنشآن بنفس اللحظة
    const zatcaUuid = crypto.randomUUID();
    const { icv, previousInvoiceHash } = await nextChainInfo(client, company_id);
    const issueTimeStr = new Date().toTimeString().slice(0, 8);

    // ── إدراج الفاتورة ────────────────────────
    const { rows: [invoice] } = await client.query(`
      INSERT INTO invoices
        (company_id, invoice_no, invoice_type, customer_id, customer_name, customer_vat,
         date, due_date, subtotal, discount_type, discount_value, discount_amount,
         taxable_amount, vat_amount, grand_total, payment_method, notes,
         status, created_by, cogs_total,
         zatca_uuid, icv, previous_invoice_hash, issue_time, branch_id, client_local_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'issued',$18,$19,$20,$21,$22,$23,$24,$25)
      RETURNING *
    `, [company_id, invoice_no, invoice_type || 'simplified',
        customer_id, customer_name, customer_vat,
        date, due_date, subtotal, discount_type, disc_val, disc_amt,
        taxable, vat_amount, grand, payment_method, notes, user_id,
        0, // cogs_total الحقيقي يُحسَب أدناه بعد خصم المخزون فعليًا، ثم يُحدَّث
        zatcaUuid, icv, previousInvoiceHash, issueTimeStr, resolvedBranchId, client_local_id || null]);

    // ── إدراج البنود + خصم المخزون (FIFO حقيقي عبر stock.deduct) ──────────
    let cogsTotal = 0;
    for (let i = 0; i < processedItems.length; i++) {
      const item = processedItems[i];
      let itemUnitCost = null;

      if (item.product_id) {
        try {
          await client.query('SAVEPOINT sp_stock');
          const { totalCost, unitCostAvg } = await stock.deduct(client, {
            company_id, product_id: item.product_id, warehouse_id: resolvedWarehouseId, qty: item.qty,
            reason: 'بيع', source_type: 'invoice', source_id: invoice.id,
            reference: invoice_no, user_id
          });
          cogsTotal += totalCost;
          itemUnitCost = unitCostAvg;
        } catch (stockErr) {
          await client.query('ROLLBACK TO sp_stock');
          console.warn(`stock deduct skipped [${invoice_no}] product ${item.product_id}:`, stockErr.message);
        }
      }

      await client.query(`
        INSERT INTO invoice_items
          (invoice_id, product_id, product_name, product_code,
           qty, unit_price, discount, line_total, vat_amount, sort_order, unit_cost)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [invoice.id, item.product_id, item.product_name, item.product_code,
          item.qty, item.unit_price, item.discount || 0,
          item.line_total, item.vat_amount, i, itemUnitCost]);
    }
    cogsTotal = Math.round(cogsTotal * 100) / 100;
    await client.query(`UPDATE invoices SET cogs_total = $1 WHERE id = $2`, [cogsTotal, invoice.id]);
    invoice.cogs_total = cogsTotal;

    // ── توليد XML الفاتورة (المرحلة الثانية) وحساب تجزئتها لسلسلة KSA-13 ──────
    // لا نمنع إنشاء الفاتورة إن كانت بيانات البائع المُهيكلة ناقصة (شركات قديمة
    // لم تُكمل عنوانها بعد) — الفاتورة تبقى صالحة محاسبيًا، وتحذيرات الاكتمال
    // تُسجَّل فقط لتنبيه المالك قبل أي إرسال فعلي مستقبلي للهيئة (الخطوة 6)
    let companyRowForClearance = null;
    let credentialForClearance = null;
    try {
      const { rows: [companyRow] } = await client.query(`SELECT * FROM companies WHERE id = $1`, [company_id]);
      companyRowForClearance = companyRow;
      let customerRow = null;
      if (customer_id) {
        customerRow = (await client.query(`SELECT * FROM customers WHERE id = $1`, [customer_id])).rows[0];
      }
      customerRow = resolveCustomerForXml(customerRow, customer_name, customer_vat);
      const xmlItems = processedItems.map(it => ({
        ...it, vat_rate: it.tax_rate ?? 15, vat_category_code: it.vat_category_code || 'S',
      }));
      const { xml, warnings } = buildInvoiceXML({
        company: companyRow, customer: customerRow, invoice, items: xmlItems, previousInvoiceHash,
      });
      const invoiceHash = computeInvoiceHash(xml);

      // إن كانت الشركة أكملت تأهيل CSID (الخطوة 4) نوقّع الفاتورة رقميًا فورًا؛
      // غير ذلك تبقى الفاتورة بلا توقيع كما كانت — لا نمنع البيع لعدم اكتمال التأهيل
      let finalXml = xml;
      let qrBase64 = null;
      let credential = await zatcaOnboarding.getActiveCredential(client, company_id, 'production');
      if (!credential) credential = await zatcaOnboarding.getActiveCredential(client, company_id, 'compliance');
      credentialForClearance = credential;
      if (credential) {
        try {
          const { ublExtensionsXml, signatureValue } = buildXadesSignature({
            invoiceHash, certificatePem: credential.certificatePem, privateKeyPem: credential.privateKeyPem,
          });
          finalXml = embedSignature(xml, ublExtensionsXml);
          const cert = new (require('crypto')).X509Certificate(credential.certificatePem);
          qrBase64 = generatePhase2QR({
            company: companyRow, invoice, invoiceHashBase64: invoiceHash, signatureValueBase64: signatureValue,
            publicKeyDer: cert.publicKey.export({ type: 'spki', format: 'der' }),
            caSignatureDer: extractCaSignature(cert.raw),
          });
          finalXml = embedQR(finalXml, qrBase64);
        } catch (signErr) {
          console.error(`[ZATCA] signing/QR failed for invoice ${invoice_no}:`, signErr.message);
        }
      }

      await client.query(`UPDATE invoices SET xml_content = $1, zatca_hash = $2, zatca_qr_phase2 = $3 WHERE id = $4`,
        [finalXml, invoiceHash, qrBase64, invoice.id]);
      await commitChainHash(client, company_id, invoiceHash);
      invoice.xml_content = finalXml;
      invoice.zatca_hash = invoiceHash;
      invoice.zatca_qr_phase2 = qrBase64;
      if (warnings.length) {
        console.warn(`[ZATCA] invoice ${invoice_no} generated with incomplete seller data:`, warnings);
        await notifyIncompleteSellerData(client, company_id, warnings);
      }
    } catch (xmlErr) {
      // خطأ بتوليد XML لا يجب أن يمنع تسجيل عملية بيع حقيقية — يُسجَّل فقط
      console.error(`[ZATCA] XML generation failed for invoice ${invoice_no}:`, xmlErr.message);
    }

    // ── حجب فواتير B2B القياسية (غير المبسّطة) حتى تصديق فعلي من الهيئة ──────
    // قرار صريح: لا حفظ محلي جزئي بانتظار إرسال لاحق لفاتورة ضريبية قياسية —
    // إن كانت الشركة أهّلت شهادة CSID فعليًا (credential) ولم تُصدَّق الفاتورة
    // فورًا، تُلغى العملية كاملة بدل حفظها "معلَّقة" بصمت. الفواتير المبسّطة/POS
    // تبقى بمسار "أفضل جهد" غير حاجز بعد الرد (submitInvoiceBestEffort أسفل).
    // لو الشركة لم تُكمل تأهيل الهيئة أصلًا (!credential) لا حجب — الحالة
    // الشائعة اليوم لمعظم الشركات، والفاتورة تُحفَظ بلا توقيع/QR كسلوكها الحالي.
    if ((invoice.invoice_type || 'simplified') !== 'simplified' && credentialForClearance) {
      const clearResult = await submitInvoice(client, companyRowForClearance, invoice, credentialForClearance);
      if (!clearResult.success) {
        await client.query('ROLLBACK');
        return res.status(502).json({
          success: false,
          code: 'zatca_clearance_failed',
          message: 'تعذّر تصديق الفاتورة الضريبية القياسية لدى هيئة الزكاة والضريبة والجمارك — لم تُحفَظ الفاتورة. تحقق من الاتصال وأعد المحاولة.',
          zatca_error: clearResult.error || null,
        });
      }
      invoice.zatca_status = clearResult.status;
    }

    // ── تحديث رصيد العميل ────────────────────
    if (customer_id) {
      await client.query(
        `UPDATE customers SET balance = balance + $1 WHERE id = $2`,
        [grand, customer_id]
      );
    }

    // ── إذا مدفوع نقداً الآن → تحديث paid_amount و status ─────────────────
    if (payment_method && payment_method !== 'credit' && payment_method !== 'آجل' && grand > 0) {
      await client.query(`UPDATE invoices SET paid_amount = $1, status = 'paid' WHERE id = $2`, [grand, invoice.id]);
      if (customer_id) {
        await client.query(`UPDATE customers SET balance = balance - $1 WHERE id = $2`, [grand, customer_id]);
      }
    }

    await client.query(`
      INSERT INTO platform_log (event_type, company_id, user_id, description)
      VALUES ('invoice_created', $1, $2, $3)
    `, [company_id, user_id, `فاتورة جديدة: ${invoice_no} — ${Number(grand).toFixed(2)} ر.س`]);

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...invoice, items: processedItems } });

    logAudit({
      companyId: company_id, userId: user_id, action: 'invoice_create',
      entityType: 'invoice', entityId: invoice.id, ip: req.ip,
      newValues: { invoice_no, grand_total: grand, status: 'issued' },
      details: `إنشاء فاتورة ${invoice_no} — ${Number(grand).toFixed(2)} ر.س`
    });

    // تصديق فوري "أفضل جهد" للفواتير القياسية (غير المبسّطة) لدى الهيئة — فقط
    // لو ما انصدّقت فعليًا أعلاه أصلًا (بلا credential وقت الإنشاء)، وإلا
    // تُرسَل الفاتورة نفسها للهيئة مرتين (الحجب أعلاه ينتظر الرد فعليًا الآن)
    if (!((invoice.invoice_type || 'simplified') !== 'simplified' && credentialForClearance)) {
      submitInvoiceBestEffort(invoice.id, company_id).catch(() => {});
    }

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.update = async (req, res, next) => {
  try {
    const { notes, due_date } = req.body;
    const { rows: [inv] } = await db.query(
      `SELECT status FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!inv) return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });
    if (inv.status === 'cancelled') return res.status(400).json({ success: false, message: 'الفاتورة ملغاة ولا يمكن تعديلها' });

    const { rows: [updated] } = await db.query(`
      UPDATE invoices SET
        notes      = COALESCE($1, notes),
        due_date   = COALESCE($2, due_date),
        updated_at = NOW()
      WHERE id = $3 AND company_id = $4
      RETURNING *
    `, [notes, due_date, req.params.id, req.user.company_id]);

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

exports.addPayment = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { amount, payment_method, account_id, reference } = req.body;
    if (!amount || amount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'المبلغ غير صحيح' });
    }

    const { rows: [inv] } = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); }

    const remaining = parseFloat(inv.grand_total) - parseFloat(inv.paid_amount);
    const paying    = Math.min(parseFloat(amount), remaining);

    const newPaid   = parseFloat(inv.paid_amount) + paying;
    const newStatus = newPaid >= parseFloat(inv.grand_total) ? 'paid' : 'partial';

    await client.query(`
      UPDATE invoices SET paid_amount = $1, status = $2, updated_at = NOW()
      WHERE id = $3
    `, [newPaid, newStatus, inv.id]);

    // تحديث رصيد العميل
    if (inv.customer_id) {
      await client.query(`UPDATE customers SET balance = balance - $1 WHERE id = $2`, [paying, inv.customer_id]);
    }

    // تسجيل حركة خزينة
    if (account_id) {
      const { rows: [acct] } = await client.query(
        `SELECT balance, branch_id FROM treasury_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [account_id, req.user.company_id]
      );
      if (!acct) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'حساب الخزينة غير موجود' }); }
      // حساب مخصَّص لفرع آخر غير فرع هذي الفاتورة — رفض بدل تسجيل تحصيل على
      // صندوق فرع لا يخصها (حساب مشترك بلا فرع (branch_id فارغ، مثل البنكي) مسموح دائمًا)
      if (acct.branch_id && inv.branch_id && acct.branch_id !== inv.branch_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'حساب الخزينة المُحدَّد يخص فرعًا آخر غير فرع الفاتورة' });
      }
      const newBal = parseFloat(acct.balance) + paying;
      await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newBal, account_id]);
      await client.query(`
        INSERT INTO treasury_moves
          (company_id, account_id, type, amount, balance_before, balance_after,
           description, reference, source_type, source_id, created_by)
        VALUES ($1,$2,'in',$3,$4,$5,$6,$7,'invoice',$8,$9)
      `, [req.user.company_id, account_id, paying, acct.balance, newBal,
          `تحصيل فاتورة ${inv.invoice_no}`, reference || inv.invoice_no,
          inv.id, req.user.sub]);
    }

    await client.query('COMMIT');
    res.json({ success: true, paid: paying, remaining: remaining - paying, status: newStatus });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.cancel = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [inv] } = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); }
    if (inv.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'الفاتورة ملغاة بالفعل' }); }

    // كان الإلغاء بلا أي فحص إقفال فترة إطلاقًا (بعكس الإنشاء) — يعكس المخزون
    // ورصيد العميل وينشئ إشعار دائن حقيقي لفاتورة من سنة/شهر مُقفَل محاسبيًا
    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, req.user.company_id, inv.date, req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    await client.query(`UPDATE invoices SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [inv.id]);

    // إرجاع المخزون — لنفس مستودع فرع الفاتورة وقت البيع (وليس فرع المستخدم
    // الحالي الذي قد يكون تغيّر منذ ذلك الحين)
    const { warehouse_id: cancelWarehouseId } =
      await branch.resolveWarehouseForBranch(client, req.user.company_id, inv.branch_id, false);
    const { rows: items } = await client.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1`, [inv.id]
    );
    for (const item of items) {
      if (item.product_id) {
        // نُرجع المخزون بنفس تكلفته الأصلية وقت البيع (invoice_items.unit_cost)
        // لا بسعر الشراء الحالي — قد يكون تغيّر كليًا منذ ذلك الحين
        await stock.add(client, {
          company_id: req.user.company_id, product_id: item.product_id, warehouse_id: cancelWarehouseId, qty: item.qty,
          unit_cost: item.unit_cost,
          reason: 'مرتجع — إلغاء فاتورة', source_type: 'invoice_cancel', source_id: inv.id,
          reference: inv.invoice_no, user_id: req.user.sub
        });
      }
    }

    // إشعار دائن فعلي يوثّق الإلغاء (مستند مستقل مرجَّع للفاتورة، لا مجرد تغيير
    // حالة صامت) — إلزامي حسب لوائح الفوترة الإلكترونية لأي فاتورة صدرت فعليًا
    let creditNote = null;
    if (items.length) {
      creditNote = await createCreditNote(client, {
        company_id: req.user.company_id, referenceInvoice: inv, items, reason: 'cancel', user_id: req.user.sub,
      });
    }

    // عكس رصيد العميل
    if (inv.customer_id) {
      await client.query(
        `UPDATE customers SET balance = balance - $1 WHERE id = $2`,
        [parseFloat(inv.grand_total) - parseFloat(inv.paid_amount), inv.customer_id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, credit_note_no: creditNote?.note_no || null });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'invoice_cancel',
      entityType: 'invoice', entityId: inv.id, ip: req.ip,
      oldValues: { status: inv.status }, newValues: { status: 'cancelled' },
      details: `إلغاء فاتورة ${inv.invoice_no} — ${Number(inv.grand_total).toFixed(2)} ر.س`
        + (creditNote ? ` — إشعار دائن ${creditNote.note_no}` : '')
    });

    // تصديق فوري "أفضل جهد" لإشعار الدائن لدى الهيئة — كانت createCreditNote
    // تبني وتوقّع الإشعار محليًا فقط بلا أي إرسال فعلي إطلاقًا (submitCreditNoteBestEffort
    // موجودة أصلًا بـzatcaSubmit.service.js لكن لم يستدعها أي مكان بالكود)
    if (creditNote) {
      submitCreditNoteBestEffort(creditNote.id, req.user.company_id, (inv.invoice_type || 'simplified') === 'simplified').catch(() => {});
    }

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.remove = async (req, res, next) => {
  res.status(405).json({ success: false, message: 'لا يمكن حذف الفواتير — استخدم الإلغاء بدلاً من ذلك' });
};
