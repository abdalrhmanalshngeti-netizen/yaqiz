const db = require('../config/db');
const { todayLocalDateStr } = require('../utils/date.util');
const { nextDocNumber } = require('../services/docNumber.service');
const periodClose = require('../services/periodClose.service');
const logAudit = require('../middleware/logger');

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
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { company_id, sub: user_id } = req.user;
    const {
      type, party_type, party_name, amount, payment_method,
      description, reference, linked_invoice_id, linked_purchase_id, date,
      client_local_id
    } = req.body;
    // voucher_no لم يعد يُقبَل من المتصفح إطلاقًا — كان عدّادًا محليًا لكل
    // جهاز لا عدّادًا موحّدًا لكل شركة (بعكس كل مستند آخر بالمنصة). يُولَّد
    // الآن بالسيرفر حصريًا عبر nextDocNumber (عدّاد مستقل لكل شركة، آمن ضد
    // التداخل بين أجهزة/شركات).

    if (!type || !amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'بيانات السند غير مكتملة' });
    }
    if (!['receipt', 'payment'].includes(type)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'نوع السند غير صحيح' });
    }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة مثلاً) لا يجب أن تُنشئ
    // سندًا مكرَّرًا برقم جديد — نتعرّف على المحاولة السابقة عبر معرّف السند
    // المحلي بالمتصفح (client_local_id)، لا رقم السند (اللي صار سيرفريًا الآن)
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT * FROM vouchers WHERE company_id = $1 AND client_local_id = $2`,
        [company_id, client_local_id]
      );
      if (existing) {
        await client.query('COMMIT');
        return res.status(201).json({ success: true, data: existing });
      }
    }

    // تحقق من صحة الربط بفاتورة/فاتورة شراء — تجاهل الربط بصمت لو المعرّف
    // المحلي لم يُطابق فاتورة حقيقية بعد (لتفادي فشل الإدراج بسبب مفتاح أجنبي)
    let safeLinkedInvoiceId = null, safeLinkedPurchaseId = null;
    if (linked_invoice_id) {
      const { rows } = await client.query(`SELECT id FROM invoices WHERE id = $1 AND company_id = $2`, [linked_invoice_id, company_id]);
      if (rows[0]) safeLinkedInvoiceId = linked_invoice_id;
    }
    if (linked_purchase_id) {
      const { rows } = await client.query(`SELECT id FROM purchases WHERE id = $1 AND company_id = $2`, [linked_purchase_id, company_id]);
      if (rows[0]) safeLinkedPurchaseId = linked_purchase_id;
    }

    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, company_id, date || todayLocalDateStr(), req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    const seqN = await nextDocNumber(client, company_id, 'voucher');
    const voucher_no = `${type === 'receipt' ? 'RCP' : 'PAY'}-${String(seqN).padStart(6, '0')}`;

    const { rows: [voucher] } = await client.query(`
      INSERT INTO vouchers
        (company_id, voucher_no, type, party_type, party_name, amount,
         payment_method, description, reference, linked_invoice_id, linked_purchase_id,
         date, created_by, client_local_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [company_id, voucher_no, type, party_type || null, party_name || null, amount,
        payment_method || null, description || null, reference || null,
        safeLinkedInvoiceId, safeLinkedPurchaseId,
        date || todayLocalDateStr(), user_id, client_local_id || null]);

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: voucher });

    logAudit({
      companyId: company_id, userId: user_id, action: 'voucher_create',
      entityType: 'voucher', entityId: voucher.id, ip: req.ip,
      newValues: { voucher_no, type, amount, party_name },
      details: `سند ${type === 'receipt' ? 'قبض' : 'صرف'} جديد: ${voucher_no} — ${Number(amount).toFixed(2)} ر.س`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// حذف حقيقي (وليس إلغاء بحالة) — السندات ليست فواتير إلكترونية خاضعة لمتطلبات
// الهيئة بشأن عدم حذف الفواتير المُصدرة؛ هذا مستند محاسبي داخلي فقط، والحذف هنا
// يطابق تمامًا سلوك الواجهة المحلية (deleteReceipt) التي تعكس أثره ثم تحذفه.
exports.remove = async (req, res, next) => {
  try {
    const { rows: [voucher] } = await db.query(
      `DELETE FROM vouchers WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.user.company_id]
    );
    if (!voucher) return res.status(404).json({ success: false, message: 'السند غير موجود' });
    res.json({ success: true });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'voucher_delete',
      entityType: 'voucher', entityId: voucher.id, ip: req.ip,
      oldValues: { voucher_no: voucher.voucher_no, type: voucher.type, amount: voucher.amount },
      details: `حذف سند ${voucher.type === 'receipt' ? 'قبض' : 'صرف'}: ${voucher.voucher_no} — ${Number(voucher.amount).toFixed(2)} ر.س`
    });
  } catch (err) { next(err); }
};
