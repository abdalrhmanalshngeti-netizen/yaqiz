const db     = require('../config/db');
const stock  = require('../services/stock.service');
const branch = require('../services/branch.service');
const { createCreditNote } = require('../services/creditNote.service');

// ملاحظة: هذا الكنترولر يحفظ سجل المرتجع نفسه فقط. أثره على رصيد العميل/المورد
// (تقسيم الخزينة/الرصيد حسب حالة سداد الفاتورة المرتبطة) يُزامَن مسبقاً عبر
// مزامنة العميل/المورد العامة الموجودة أصلاً (أي تغيّر بحقل .balance محلياً يُرسَل
// كاملاً مع أي تحديث لبيانات العميل) — تكرار الخصم هنا يسبب احتسابه مرتين.
// (هذا لا يشمل الكمية الفعلية بالمخزون — أدناه نُعيدها فعليًا لمرتجعات المبيعات
// المرتبطة بصنف حقيقي، وإلا يبقى المخزون منقوصًا للأبد بعد أي مرتجع).

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
      payment_method, cogs_reversal
    } = req.body;

    if (!['sales', 'purchases'].includes(type) || !amount) {
      return res.status(400).json({ success: false, message: 'النوع والمبلغ مطلوبان' });
    }

    await client.query('BEGIN');

    let linkedInvoice = null;
    if (linked_invoice_id) {
      const { rows } = await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [linked_invoice_id, company_id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'الفاتورة المرتبطة غير موجودة' }); }
      linkedInvoice = rows[0];
    }
    let linkedPurchase = null;
    if (linked_purchase_id) {
      const { rows } = await client.query(`SELECT id, branch_id FROM purchases WHERE id = $1 AND company_id = $2`, [linked_purchase_id, company_id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'المشتريات المرتبطة غير موجودة' }); }
      linkedPurchase = rows[0];
    }

    const { rows: [seq] } = await client.query(`SELECT NEXTVAL('return_seq') AS n`);
    const return_no = `RET-${String(seq.n).padStart(6, '0')}`;

    const { rows: [ret] } = await client.query(`
      INSERT INTO returns
        (company_id, return_no, type, party_name, product_id, product_name, qty,
         base_amount, vat_amount, amount, reason, linked_invoice_id, linked_purchase_id,
         date, created_by, payment_method, cogs_reversal)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [company_id, return_no, type, party_name || '', product_id || null,
        product_name || '', qty || 0, base_amount || 0, vat_amount || 0, amount,
        reason || '', linked_invoice_id || null, linked_purchase_id || null,
        date || new Date().toISOString().slice(0, 10), req.user.sub,
        payment_method || null, cogs_reversal || 0]);

    // إرجاع الكمية فعليًا للمخزون — لنفس مستودع فرع الفاتورة الأصلية إن وُجدت
    // (نفس المستودع اللي خُصم منه وقت البيع)، وإلا مستودع فرع المستخدم الحالي
    if (type === 'sales' && product_id) {
      try {
        await client.query('SAVEPOINT sp_stock');
        const { warehouse_id } = linkedInvoice
          ? await branch.resolveWarehouseForBranch(client, company_id, linkedInvoice.branch_id, false)
          : await branch.resolveWarehouseForUser(client, company_id, req.user.sub, req.body.branch_id);
        await stock.add(client, {
          company_id, product_id, warehouse_id, qty: qty || 0,
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
      const { warehouse_id } = linkedPurchase
        ? await branch.resolveWarehouseForBranch(client, company_id, linkedPurchase.branch_id, false)
        : await branch.resolveWarehouseForUser(client, company_id, req.user.sub, req.body.branch_id);
      await stock.deduct(client, {
        company_id, product_id, warehouse_id, qty: qty || 0,
        reason: 'مرتجع مشتريات', source_type: 'return', source_id: ret.id,
        reference: return_no, user_id: req.user.sub
      });
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
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(`DELETE FROM returns WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
