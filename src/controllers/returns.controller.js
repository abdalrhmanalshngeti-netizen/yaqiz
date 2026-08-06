const db = require('../config/db');

// ملاحظة: هذا الكنترولر يحفظ سجل المرتجع نفسه فقط. أثره على رصيد العميل/المورد
// (تقسيم الخزينة/الرصيد حسب حالة سداد الفاتورة المرتبطة) يُزامَن مسبقاً عبر
// مزامنة العميل/المورد العامة الموجودة أصلاً (أي تغيّر بحقل .balance محلياً يُرسَل
// كاملاً مع أي تحديث لبيانات العميل) — تكرار الخصم هنا يسبب احتسابه مرتين.

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

    if (linked_invoice_id) {
      const { rows } = await db.query(`SELECT id FROM invoices WHERE id = $1 AND company_id = $2`, [linked_invoice_id, company_id]);
      if (!rows[0]) return res.status(404).json({ success: false, message: 'الفاتورة المرتبطة غير موجودة' });
    }
    if (linked_purchase_id) {
      const { rows } = await db.query(`SELECT id FROM purchases WHERE id = $1 AND company_id = $2`, [linked_purchase_id, company_id]);
      if (!rows[0]) return res.status(404).json({ success: false, message: 'المشتريات المرتبطة غير موجودة' });
    }

    const { rows: [seq] } = await db.query(`SELECT NEXTVAL('return_seq') AS n`);
    const return_no = `RET-${String(seq.n).padStart(6, '0')}`;

    const { rows: [ret] } = await db.query(`
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

    res.status(201).json({ success: true, data: ret });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(`DELETE FROM returns WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
