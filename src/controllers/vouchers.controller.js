const { partySector } = require('../utils/costVisibility');
const db = require('../config/db');
const { todayLocalDateStr } = require('../utils/date.util');
const { nextDocNumber } = require('../services/docNumber.service');
const periodClose = require('../services/periodClose.service');
const customerAdvance = require('../services/customerAdvance.service');
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
    const sec = partySector(req.user);
    res.json({ success: true, data: sec === 'all' ? rows : rows.filter(v => v.type === (sec === 'customers' ? 'receipt' : 'payment')) });
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
      client_local_id, party_id, prior_applied, advance_amount
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

    // الطرف: المعرّف لو يخص الشركة، وإلا بالاسم (المعرّف المحلي ممكن ما تزامن بعد)
    const partyTable = type === 'receipt' ? 'customers' : 'suppliers';
    let safePartyId = null;
    if (party_id) {
      const { rows } = await client.query(`SELECT id FROM ${partyTable} WHERE id = $1 AND company_id = $2`, [party_id, company_id]);
      if (rows[0]) safePartyId = rows[0].id;
    }
    if (!safePartyId && party_name) {
      const { rows } = await client.query(`SELECT id FROM ${partyTable} WHERE company_id = $1 AND name = $2 ORDER BY is_active DESC NULLS LAST, id LIMIT 1`, [company_id, party_name]);
      if (rows[0]) safePartyId = rows[0].id;
    }
    const priorApplied = Math.max(0, Math.min(parseFloat(amount) || 0, parseFloat(prior_applied) || 0));
    // الزائد عن فواتير العميل ورصيده السابق = دفعة مقدمة (التزام 2160): رصيد دائن للعميل
    const advanceAmount = type === 'receipt' && safePartyId
      ? Math.max(0, Math.min((parseFloat(amount) || 0) - priorApplied, parseFloat(advance_amount) || 0)) : 0;

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
         date, created_by, client_local_id, party_id, prior_applied, advance_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [company_id, voucher_no, type, party_type || null, party_name || null, amount,
        payment_method || null, description || null, reference || null,
        safeLinkedInvoiceId, safeLinkedPurchaseId,
        date || todayLocalDateStr(), user_id, client_local_id || null, safePartyId, priorApplied, advanceAmount]);

    // الجزء المطبَّق على رصيد سابق (افتتاحي) للطرف — ينزّل رصيده مباشرة (ما له فاتورة
    // يمر عبرها مثل باقي التحصيل)
    if (priorApplied + advanceAmount > 0 && safePartyId) {
      await client.query(`UPDATE ${partyTable} SET balance = balance - $1 WHERE id = $2 AND company_id = $3`, [priorApplied + advanceAmount, safePartyId, company_id]);
    }

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
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // كان هذا الحذف بلا أي فحص إقفال فترة إطلاقًا — نفس فجوة returns.controller.js
    // exports.remove بالضبط: السند يُحذف بلا مانع حتى لو من فترة مُقفَلة محاسبيًا
    const { rows: [existing] } = await client.query(
      `SELECT * FROM vouchers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'السند غير موجود' });
    }
    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, req.user.company_id, existing.date, req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }
    // دفعة مقدمة سُوّيت فعلًا على فاتورة: حذف سندها يخلّي الفاتورة مسددة بفلوس ما وصلت
    const _adv = parseFloat(existing.advance_amount) || 0;
    if (_adv > 0 && existing.party_id && existing.type === 'receipt') {
      const avail = await customerAdvance.availableAdvance(client, req.user.company_id, existing.party_id);
      if (avail + 0.005 < _adv) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, code: 'ADVANCE_USED', message: 'الدفعة المقدمة في هذا السند خُصمت من فاتورة لاحقة — ألغِ الفاتورة أولًا ثم ألغِ السند' });
      }
    }
    const { rows: [voucher] } = await client.query(
      `DELETE FROM vouchers WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.user.company_id]
    );
    const _back = (parseFloat(voucher.prior_applied) || 0) + (parseFloat(voucher.advance_amount) || 0);
    if (_back > 0 && voucher.party_id) {
      const t = voucher.type === 'receipt' ? 'customers' : 'suppliers';
      await client.query(`UPDATE ${t} SET balance = balance + $1 WHERE id = $2 AND company_id = $3`, [_back, voucher.party_id, req.user.company_id]);
    }
    await client.query('COMMIT');
    res.json({ success: true });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'voucher_delete',
      entityType: 'voucher', entityId: voucher.id, ip: req.ip,
      oldValues: { voucher_no: voucher.voucher_no, type: voucher.type, amount: voucher.amount },
      details: `حذف سند ${voucher.type === 'receipt' ? 'قبض' : 'صرف'}: ${voucher.voucher_no} — ${Number(voucher.amount).toFixed(2)} ر.س`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
