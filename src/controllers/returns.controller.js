const db     = require('../config/db');
const stock  = require('../services/stock.service');
const branch = require('../services/branch.service');
const { createCreditNote } = require('../services/creditNote.service');
const { submitCreditNoteBestEffort } = require('../services/zatcaSubmit.service');
const { nextDocNumber } = require('../services/docNumber.service');
const { todayLocalDateStr } = require('../utils/date.util');
const periodClose = require('../services/periodClose.service');
const logAudit = require('../middleware/logger');

// ملاحظة: هذا الكنترولر يحفظ سجل المرتجع نفسه فقط. أثره على رصيد العميل/المورد
// (تقسيم الخزينة/الرصيد حسب حالة سداد الفاتورة المرتبطة) يُزامَن مسبقاً عبر
// مزامنة العميل/المورد العامة الموجودة أصلاً (أي تغيّر بحقل .balance محلياً يُرسَل
// كاملاً مع أي تحديث لبيانات العميل) — تكرار الخصم هنا يسبب احتسابه مرتين.
// (هذا لا يشمل الكمية الفعلية بالمخزون — أدناه نُعيدها فعليًا لمرتجعات المبيعات
// المرتبطة بصنف حقيقي، وإلا يبقى المخزون منقوصًا للأبد بعد أي مرتجع).

// يحسب ويطبّق تسوية المرتجع الآجلة: لا تتجاوز المتبقي الفعلي على المستند،
// والطلب من المتصفح يُقبل فقط ضمن هذا الحد (لا يُثق به لتجاوزه)
async function settleReturnCredit(client, { ret, linkedInvoice, linkedPurchase, amount, credit_portion }) {
  const amt = Math.round(parseFloat(amount) * 100) / 100;
  let outstanding = 0;
  if (linkedInvoice) {
    outstanding = parseFloat(linkedInvoice.grand_total) - parseFloat(linkedInvoice.paid_amount || 0) - parseFloat(linkedInvoice.credited_amount || 0);
  } else if (linkedPurchase) {
    outstanding = parseFloat(linkedPurchase.remaining || 0);
  }
  outstanding = Math.max(0, Math.round(outstanding * 100) / 100);
  const cap = Math.min(amt, outstanding);
  const asked = credit_portion != null && credit_portion !== '' ? parseFloat(credit_portion) : cap;
  const credit = Math.round(Math.max(0, Math.min(cap, isNaN(asked) ? cap : asked)) * 100) / 100;
  const cash = Math.round((amt - credit) * 100) / 100;
  await client.query(`UPDATE returns SET cash_portion = $1, credit_portion = $2 WHERE id = $3`, [cash, credit, ret.id]);
  if (credit > 0 && linkedInvoice) {
    await client.query(`
      UPDATE invoices SET credited_amount = credited_amount + $1,
        status = CASE WHEN paid_amount + credited_amount + $1 >= grand_total - 0.005 THEN 'paid' ELSE status END,
        updated_at = NOW()
      WHERE id = $2`, [credit, linkedInvoice.id]);
    if (linkedInvoice.customer_id) await client.query(`UPDATE customers SET balance = balance - $1 WHERE id = $2`, [credit, linkedInvoice.customer_id]);
  } else if (credit > 0 && linkedPurchase) {
    await client.query(`
      UPDATE purchases SET remaining = GREATEST(0, remaining - $1),
        status = CASE WHEN remaining - $1 <= 0.005 THEN 'paid' ELSE status END
      WHERE id = $2`, [credit, linkedPurchase.id]);
    if (linkedPurchase.supplier_id) await client.query(`UPDATE suppliers SET balance = balance - $1 WHERE id = $2`, [credit, linkedPurchase.supplier_id]);
  }
  return { cash, credit };
}

// حذف المرتجع كان يمسح السجل فقط: البضاعة المرتجعة تبقى بمخزون السيرفر (أو
// تبقى خارجه لمرتجع مشتريات)، والتسوية الآجلة تبقى مطبَّقة — فيرجع أول سحب
// بيانات بكميات وأرصدة غلط للواجهة. نعكسها هنا بنفس المعاملة
async function reverseReturnEffects(client, ret, user) {
  const qty = parseFloat(ret.qty) || 0;
  if (ret.product_id && qty > 0) {
    const { rows: [mv] } = await client.query(
      `SELECT warehouse_id FROM stock_moves WHERE company_id = $1 AND source_type = 'return' AND source_id = $2 ORDER BY id DESC LIMIT 1`,
      [ret.company_id, ret.id]
    );
    if (mv?.warehouse_id) {
      if (ret.type === 'sales') {
        await stock.deduct(client, {
          company_id: ret.company_id, product_id: ret.product_id, warehouse_id: mv.warehouse_id, qty,
          reason: 'حذف مرتجع مبيعات', source_type: 'return_delete', source_id: ret.id,
          reference: ret.return_no, user_id: user.sub,
          preferLot: { source_type: 'return', source_id: ret.id }
        });
      } else {
        const unitCost = qty ? (parseFloat(ret.cogs_reversal) || 0) / qty : undefined;
        await stock.add(client, {
          company_id: ret.company_id, product_id: ret.product_id, warehouse_id: mv.warehouse_id, qty,
          unit_cost: unitCost, reason: 'حذف مرتجع مشتريات', source_type: 'return_delete', source_id: ret.id,
          reference: ret.return_no, user_id: user.sub
        });
      }
    }
  }
  const credit = parseFloat(ret.credit_portion) || 0;
  if (credit > 0 && ret.linked_invoice_id) {
    const { rows: [inv] } = await client.query(
      `UPDATE invoices SET credited_amount = GREATEST(0, credited_amount - $1),
         status = CASE WHEN status = 'paid' AND paid_amount + GREATEST(0, credited_amount - $1) < grand_total - 0.005
                       THEN (CASE WHEN paid_amount > 0 THEN 'partial' ELSE 'issued' END) ELSE status END
       WHERE id = $2 AND company_id = $3 RETURNING customer_id`, [credit, ret.linked_invoice_id, ret.company_id]);
    if (inv?.customer_id) await client.query(`UPDATE customers SET balance = balance + $1 WHERE id = $2`, [credit, inv.customer_id]);
  } else if (credit > 0 && ret.linked_purchase_id) {
    const { rows: [pur] } = await client.query(
      `UPDATE purchases SET remaining = remaining + $1,
         status = CASE WHEN remaining + $1 >= total - 0.005 THEN 'unpaid' ELSE 'partial' END
       WHERE id = $2 AND company_id = $3 RETURNING supplier_id`, [credit, ret.linked_purchase_id, ret.company_id]);
    if (pur?.supplier_id) await client.query(`UPDATE suppliers SET balance = balance + $1 WHERE id = $2`, [credit, pur.supplier_id]);
  }
}

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM returns WHERE company_id = $1 ORDER BY date DESC, id DESC LIMIT 2000`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { company_id } = req.user;
    const {
      type, party_name, product_id, product_name, qty,
      base_amount, vat_amount, amount, reason,
      linked_invoice_id, linked_purchase_id, date,
      payment_method, cogs_reversal, client_local_id, credit_portion
    } = req.body;

    if (!['sales', 'purchases'].includes(type) || !amount) {
      return res.status(400).json({ success: false, message: 'النوع والمبلغ مطلوبان' });
    }

    await client.query('BEGIN');

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ مرتجعًا
    // مكرَّرًا (ويؤثر على المخزون مرتين) — نتعرّف على المحاولة السابقة عبر
    // المعرّف المحلي بالمتصفح
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT * FROM returns WHERE company_id = $1 AND client_local_id = $2`,
        [company_id, client_local_id]
      );
      if (existing) { await client.query('COMMIT'); return res.status(201).json({ success: true, data: existing }); }
    }

    let linkedInvoice = null;
    if (linked_invoice_id) {
      const { rows } = await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [linked_invoice_id, company_id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'الفاتورة المرتبطة غير موجودة' }); }
      linkedInvoice = rows[0];

      // منع تزوير مرتجع بمبلغ يتجاوز الفاتورة الأصلية (أو ما تبقى منها بعد
      // مرتجعات سابقة) — قبل هذا الإصلاح كان amount/qty يُقبَل من الـclient بلا
      // أي تحقق مقابل الفاتورة، وموظف بصلاحية returns.manage البسيطة يقدر
      // يُنشئ مرتجعًا بمبلغ ضخم فيتولّد له إشعار دائن حقيقي يُرسَل فعليًا
      // للهيئة (submitCreditNoteBestEffort)
      const { rows: [priorReturns] } = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM returns WHERE company_id = $1 AND linked_invoice_id = $2 AND type = 'sales'`,
        [company_id, linked_invoice_id]
      );
      const remainingReturnable = Math.round((parseFloat(linkedInvoice.grand_total) - parseFloat(priorReturns.total)) * 100) / 100;
      if (Math.round(parseFloat(amount) * 100) / 100 > remainingReturnable + 0.01) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `مبلغ المرتجع (${parseFloat(amount).toFixed(2)} ر.س) أكبر من المتبقي القابل للإرجاع بهذه الفاتورة (${remainingReturnable.toFixed(2)} ر.س)`
        });
      }
      if (product_id && qty) {
        const { rows: [origItem] } = await client.query(
          `SELECT COALESCE(SUM(qty),0) AS qty FROM invoice_items WHERE invoice_id = $1 AND product_id = $2`,
          [linked_invoice_id, product_id]
        );
        const { rows: [priorQty] } = await client.query(
          `SELECT COALESCE(SUM(qty),0) AS qty FROM returns WHERE company_id = $1 AND linked_invoice_id = $2 AND product_id = $3 AND type = 'sales'`,
          [company_id, linked_invoice_id, product_id]
        );
        const remainingQty = parseFloat(origItem.qty) - parseFloat(priorQty.qty);
        if (parseFloat(qty) > remainingQty + 0.001) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: `الكمية المرتجعة أكبر من الكمية المتبقية القابلة للإرجاع لهذا الصنف بالفاتورة (المتبقي: ${remainingQty})`
          });
        }
      }
    }
    let linkedPurchase = null;
    if (linked_purchase_id) {
      const { rows } = await client.query(`SELECT id, branch_id, total, remaining, supplier_id FROM purchases WHERE id = $1 AND company_id = $2`, [linked_purchase_id, company_id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'المشتريات المرتبطة غير موجودة' }); }
      linkedPurchase = rows[0];

      // نفس منطق التحقق أعلاه لمرتجعات المبيعات — دفاع بعمق حتى لو ما فيه
      // مخاطرة تصديق ZATCA هنا (مرتجعات المشتريات لا تُنشئ إشعار دائن)
      const { rows: [priorPReturns] } = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM returns WHERE company_id = $1 AND linked_purchase_id = $2 AND type = 'purchases'`,
        [company_id, linked_purchase_id]
      );
      const remainingPReturnable = Math.round((parseFloat(linkedPurchase.total) - parseFloat(priorPReturns.total)) * 100) / 100;
      if (Math.round(parseFloat(amount) * 100) / 100 > remainingPReturnable + 0.01) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `مبلغ مرتجع المشتريات (${parseFloat(amount).toFixed(2)} ر.س) أكبر من المتبقي القابل للإرجاع بهذه الفاتورة (${remainingPReturnable.toFixed(2)} ر.س)`
        });
      }
    }

    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, company_id, date || todayLocalDateStr(), req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    const retSeqN = await nextDocNumber(client, company_id, 'return');
    const return_no = `RET-${String(retSeqN).padStart(6, '0')}`;

    const { rows: [ret] } = await client.query(`
      INSERT INTO returns
        (company_id, return_no, type, party_name, product_id, product_name, qty,
         base_amount, vat_amount, amount, reason, linked_invoice_id, linked_purchase_id,
         date, created_by, payment_method, cogs_reversal, client_local_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [company_id, return_no, type, party_name || '', product_id || null,
        product_name || '', qty || 0, base_amount || 0, vat_amount || 0, amount,
        reason || '', linked_invoice_id || null, linked_purchase_id || null,
        date || todayLocalDateStr(), req.user.sub,
        payment_method || null, cogs_reversal || 0, client_local_id || null]);

    // الجزء الآجل من المرتجع يسوّي المتبقي على الفاتورة/فاتورة الشراء المرتبطة
    // (إشعار دائن)، والنقدي فقط هو ما يُرد فعليًا
    const settle = await settleReturnCredit(client, { ret, linkedInvoice, linkedPurchase, amount, credit_portion });
    ret.cash_portion = settle.cash; ret.credit_portion = settle.credit;

    // إرجاع الكمية فعليًا للمخزون — لنفس مستودع فرع الفاتورة الأصلية إن وُجدت
    // (نفس المستودع اللي خُصم منه وقت البيع)، وإلا مستودع فرع المستخدم الحالي
    if (type === 'sales' && product_id) {
      try {
        await client.query('SAVEPOINT sp_stock');
        const { warehouse_id } = linkedInvoice
          ? await branch.resolveWarehouseForBranch(client, company_id, linkedInvoice.branch_id, false)
          : await branch.resolveWarehouseForUser(client, company_id, req.user.sub, req.body.branch_id, req.user.role);
        // نُرجع البضاعة بنفس تكلفتها الأصلية وقت البيع (invoice_items.unit_cost)
        // لو مرتبطة بفاتورة حقيقية — لا بسعر الشراء الحالي (قد يكون تغيّر)
        let unitCost;
        if (linkedInvoice) {
          const { rows: [origItem] } = await client.query(
            `SELECT unit_cost FROM invoice_items WHERE invoice_id = $1 AND product_id = $2 LIMIT 1`,
            [linkedInvoice.id, product_id]
          );
          unitCost = origItem?.unit_cost ?? undefined;
        }
        await stock.add(client, {
          company_id, product_id, warehouse_id, qty: qty || 0, unit_cost: unitCost,
          reason: 'مرتجع مبيعات', source_type: 'return', source_id: ret.id,
          reference: return_no, user_id: req.user.sub
        });
      } catch (stockErr) {
        await client.query('ROLLBACK TO sp_stock');
        console.warn(`stock restore skipped [${return_no}] product ${product_id}:`, stockErr.message);
      }
    }

    // مرتجع مشتريات — يُخرِج الكمية فعليًا من نفس مستودع فرع فاتورة الشراء
    // الأصلية إن وُجدت (نفس المستودع اللي زيدت فيه وقت الشراء)، وإلا مستودع
    // فرع المستخدم الحالي. بعكس مرتجع المبيعات أعلاه (إضافة، لا تفشل أبدًا
    // بسبب كمية)، هذا خصم فعلي — لو تجاوزت الكمية المرتجعة الرصيد الفعلي
    // بالمستودع، نرفض العملية بالكامل بدل تسجيل مرتجع/قيد محاسبي لمخزون غير
    // موجود فعليًا (كان قبل هذا الإصلاح لا يُنفَّذ هذا الفرع إطلاقًا — أي مرتجع
    // مشتريات ما كان يُنقِص المخزون بالسيرفر أبدًا، ويعود الرقم القديم بصمت
    // بأول مزامنة دورية تالية رغم ظهور المرتجع "ناجحًا" بالواجهة)
    if (type === 'purchases' && product_id) {
      let warehouse_id;
      try {
        ({ warehouse_id } = linkedPurchase
          ? await branch.resolveWarehouseForBranch(client, company_id, linkedPurchase.branch_id, false)
          : await branch.resolveWarehouseForUser(client, company_id, req.user.sub, req.body.branch_id));
      } catch (branchErr) {
        await client.query('ROLLBACK');
        // نفس حالة المشتريات: المرتجعات محفوظة محليًا مسبقًا وتُزامَن لاحقًا
        // بخلفية منفصلة — راجع تعليق notifyBranchAuthFailure
        await branch.notifyBranchAuthFailure(company_id, req.user.sub, 'مرتجع مشتريات', branchErr.message).catch(() => {});
        return res.status(branchErr.status || 400).json({ success: false, message: branchErr.message });
      }
      // تكلفة العكس الحقيقية (FIFO) من stock.deduct نفسها — لا القيمة المُرسَلة
      // من الـclient بلا أي تحقق
      const { totalCost } = await stock.deduct(client, {
        company_id, product_id, warehouse_id, qty: qty || 0,
        reason: 'مرتجع مشتريات', source_type: 'return', source_id: ret.id,
        reference: return_no, user_id: req.user.sub,
        preferLot: linkedPurchase ? { source_type: 'purchase', source_id: linkedPurchase.id } : null
      });
      const realCogsReversal = Math.round(totalCost * 100) / 100;
      await client.query(`UPDATE returns SET cogs_reversal = $1 WHERE id = $2`, [realCogsReversal, ret.id]);
      ret.cogs_reversal = realCogsReversal;
    }

    // إشعار دائن فعلي — فقط لمرتجع مبيعات مرتبط فعليًا بفاتورة صدرت (بدون فاتورة
    // مرتبطة، ما فيه مستند رسمي نرجّع له، فلا نصطنع إشعارًا بلا مرجع حقيقي)
    let creditNote = null;
    if (type === 'sales' && linkedInvoice) {
      creditNote = await createCreditNote(client, {
        company_id, referenceInvoice: linkedInvoice, reason: 'return', reference_return_id: ret.id, user_id: req.user.sub,
        items: [{
          product_id: product_id || null, product_name: product_name || 'مرتجع',
          qty: qty || 1, unit_price: qty ? (parseFloat(base_amount || 0) / qty) : parseFloat(base_amount || 0),
          line_total: parseFloat(base_amount || 0), vat_amount: parseFloat(vat_amount || 0),
        }],
      });
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: ret, credit_note_no: creditNote?.note_no || null });

    logAudit({
      companyId: company_id, userId: req.user.sub, action: 'return_create',
      entityType: 'return', entityId: ret.id, ip: req.ip,
      newValues: { return_no: ret.return_no, type, amount, linked_invoice_id, linked_purchase_id },
      details: `مرتجع ${type === 'sales' ? 'مبيعات' : 'مشتريات'} جديد: ${ret.return_no} — ${Number(amount).toFixed(2)} ر.س`
        + (creditNote ? ` — إشعار دائن ${creditNote.note_no}` : '')
    });

    // تصديق فوري "أفضل جهد" لإشعار الدائن لدى الهيئة — فقط لو ما انصدّق فعليًا
    // أعلاه داخل createCreditNote (فاتورة قياسية + شهادة سارية = حجب متزامن)،
    // وإلا يُرسَل مرتين — نفس الحارس المطبَّق بـinvoices.controller.js exports.cancel
    if (creditNote && creditNote.zatca_status !== 'cleared' && creditNote.zatca_status !== 'reported') {
      submitCreditNoteBestEffort(creditNote.id, company_id, (linkedInvoice?.invoice_type || 'simplified') === 'simplified').catch(() => {});
    }
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === 'zatca_clearance_failed') {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message, zatca_error: err.zatca_error });
    }
    next(err);
  } finally {
    client.release();
  }
};

exports.remove = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // كان هذا الحذف بلا أي فحص إقفال فترة إطلاقًا — يحذف صف المرتجع بلا أي أثر
    // للتعديل الذي سبّبه (المخزون/الرصيد/إشعار الدائن تُعكَس محليًا بالمتصفح
    // فقط قبل استدعاء هذا المسار)، حتى لو المرتجع من فترة مُقفَلة محاسبيًا
    const { rows: [existing] } = await client.query(
      `SELECT date, return_no, type, amount FROM returns WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'المرتجع غير موجود' });
    }
    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, req.user.company_id, existing.date, req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }
    // إشعار دائن ضريبي صادر لهذا المرتجع — مستند رسمي لا يُحذف (كان يرجع 500
    // بقيد المفتاح الأجنبي، والواجهة تعيد المحاولة بلا نهاية)
    const { rows: [cn] } = await client.query(`SELECT id FROM credit_notes WHERE reference_return_id = $1 LIMIT 1`, [req.params.id]);
    if (cn) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'HAS_CREDIT_NOTE', message: 'هذا المرتجع صدر له إشعار دائن ضريبي ولا يمكن حذفه' });
    }
    const { rows: [ret] } = await client.query(
      `DELETE FROM returns WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.user.company_id]
    );
    await reverseReturnEffects(client, ret, req.user);
    await client.query('COMMIT');
    res.json({ success: true });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'return_delete',
      entityType: 'return', entityId: ret.id, ip: req.ip,
      oldValues: { return_no: ret.return_no, type: ret.type, amount: ret.amount },
      details: `حذف مرتجع ${ret.type === 'sales' ? 'مبيعات' : 'مشتريات'}: ${ret.return_no} — ${Number(ret.amount).toFixed(2)} ر.س`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
