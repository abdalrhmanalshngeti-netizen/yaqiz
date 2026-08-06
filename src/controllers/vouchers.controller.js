const db = require('../config/db');

// ملاحظة: هذا الكنترولر يحفظ سند القبض/الصرف نفسه فقط (للحفاظ عليه بين الأجهزة
// وعدم فقدانه) — لا يُعيد تطبيق أثره على الفاتورة/رصيد العميل، لأن ذلك يُزامَن
// مسبقاً عبر مسار مزامنة دفعات الفواتير/المشتريات المنفصل في الواجهة المحلية،
// فتكرار التطبيق هنا يسبب احتساب الدفعة مرتين.

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM vouchers WHERE company_id = $1 ORDER BY id DESC`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { company_id, sub: user_id } = req.user;
    const {
      voucher_no, type, party_type, party_name, amount, payment_method,
      description, reference, linked_invoice_id, linked_purchase_id, date
    } = req.body;

    if (!voucher_no || !type || !amount) {
      return res.status(400).json({ success: false, message: 'بيانات السند غير مكتملة' });
    }
    if (!['receipt', 'payment'].includes(type)) {
      return res.status(400).json({ success: false, message: 'نوع السند غير صحيح' });
    }

    // تحقق من صحة الربط بفاتورة/فاتورة شراء — تجاهل الربط بصمت لو المعرّف
    // المحلي لم يُطابق فاتورة حقيقية بعد (لتفادي فشل الإدراج بسبب مفتاح أجنبي)
    let safeLinkedInvoiceId = null, safeLinkedPurchaseId = null;
    if (linked_invoice_id) {
      const { rows } = await db.query(`SELECT id FROM invoices WHERE id = $1 AND company_id = $2`, [linked_invoice_id, company_id]);
      if (rows[0]) safeLinkedInvoiceId = linked_invoice_id;
    }
    if (linked_purchase_id) {
      const { rows } = await db.query(`SELECT id FROM purchases WHERE id = $1 AND company_id = $2`, [linked_purchase_id, company_id]);
      if (rows[0]) safeLinkedPurchaseId = linked_purchase_id;
    }

    const { rows: [voucher] } = await db.query(`
      INSERT INTO vouchers
        (company_id, voucher_no, type, party_type, party_name, amount,
         payment_method, description, reference, linked_invoice_id, linked_purchase_id,
         date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (voucher_no, company_id) DO UPDATE SET amount = EXCLUDED.amount
      RETURNING *
    `, [company_id, voucher_no, type, party_type || null, party_name || null, amount,
        payment_method || null, description || null, reference || null,
        safeLinkedInvoiceId, safeLinkedPurchaseId,
        date || new Date().toISOString().slice(0, 10), user_id]);

    res.status(201).json({ success: true, data: voucher });
  } catch (err) { next(err); }
};

// حذف حقيقي (وليس إلغاء بحالة) — السندات ليست فواتير إلكترونية خاضعة لمتطلبات
// الهيئة بشأن عدم حذف الفواتير المُصدرة؛ هذا مستند محاسبي داخلي فقط، والحذف هنا
// يطابق تمامًا سلوك الواجهة المحلية (deleteReceipt) التي تعكس أثره ثم تحذفه.
exports.remove = async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM vouchers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'السند غير موجود' });
    res.json({ success: true });
  } catch (err) { next(err); }
};
