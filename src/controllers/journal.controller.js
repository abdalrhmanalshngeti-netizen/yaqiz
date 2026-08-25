const db = require('../config/db');
const { nextDocNumber } = require('../services/docNumber.service');
const { todayLocalDateStr } = require('../utils/date.util');
const periodClose = require('../services/periodClose.service');
const logAudit = require('../middleware/logger');

// يحدد نوع الحساب الافتراضي لأي كود غير معروف بالاعتماد على الرقم الأول
// (1=أصول، 2=التزامات، 3=حقوق ملكية، 4=إيرادات، 5=مصروفات) — احتياطي فقط
// للحسابات التي لم تُزرع مسبقاً بدليل الحسابات (chart_of_accounts)
function inferAccountType(code) {
  const map = { '1': 'أصول', '2': 'التزامات', '3': 'حقوق الملكية', '4': 'إيرادات', '5': 'مصروفات' };
  return map[String(code || '')[0]] || 'أصول';
}

// يرجّع id الحساب بدليل الحسابات حسب الكود، وينشئه تلقائياً إذا ما كان موجوداً
async function resolveAccountId(client, companyId, code, name) {
  const safeCode = code || '0000';
  const { rows: [existing] } = await client.query(
    `SELECT id FROM chart_of_accounts WHERE company_id = $1 AND code = $2`,
    [companyId, safeCode]
  );
  if (existing) return existing.id;
  const { rows: [created] } = await client.query(
    `INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group)
     VALUES ($1,$2,$3,$3,$4,false) RETURNING id`,
    [companyId, safeCode, name || safeCode, inferAccountType(safeCode)]
  );
  return created.id;
}

exports.list = async (req, res, next) => {
  try {
    const { rows: entries } = await db.query(
      `SELECT id, entry_no, description, reference, date, created_at FROM journal_entries
       WHERE company_id = $1 ORDER BY date DESC, id DESC LIMIT 2000`,
      [req.user.company_id]
    );
    if (!entries.length) return res.json({ success: true, data: [] });

    const ids = entries.map(e => e.id);
    const { rows: lines } = await db.query(
      `SELECT entry_id, account_name, account_code, side, amount::float AS amount
       FROM journal_items WHERE entry_id = ANY($1) ORDER BY entry_id, id`,
      [ids]
    );
    const byEntry = {};
    lines.forEach(l => { (byEntry[l.entry_id] = byEntry[l.entry_id] || []).push(l); });

    const data = entries.map(e => ({
      id: e.id, description: e.description, ref: e.reference, date: e.date,
      entries: (byEntry[e.id] || []).map(l => ({ account: l.account_name, account_code: l.account_code, side: l.side, amount: l.amount }))
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { description, ref, date, entries = [], client_local_id } = req.body;
    if (!entries.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'يجب إضافة سطر واحد على الأقل' });
    }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ قيدًا
    // مكرَّرًا — نتعرّف على المحاولة السابقة عبر المعرّف المحلي بالمتصفح، بنفس
    // نمط بقية المستندات (راجع 053_client_local_id_dedup.sql)
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT id, description, reference, date FROM journal_entries WHERE company_id = $1 AND client_local_id = $2`,
        [req.user.company_id, client_local_id]
      );
      if (existing) {
        await client.query('COMMIT');
        return res.status(201).json({ success: true, data: { id: existing.id, description: existing.description, ref: existing.reference, date: existing.date, entries } });
      }
    }
    const debit  = entries.filter(e => e.side === 'debit').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const credit = entries.filter(e => e.side === 'credit').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    // سماحية بسيطة لفروق التقريب المتراكمة عبر عدة بنود (نسبة الضريبة، الخصومات...)
    // — نفس حد 0.01 المستخدَم بشاشة القيد اليدوي بالضبط (VVIP.html)، فكل مبلغ
    // بالمنصة مُقرَّب لأقرب هللة قبل دخوله القيد أصلًا، فأي فرق حقيقي أكبر من
    // هللة واحدة يعني قيدًا غير متوازن فعليًا، لا مجرد ضجيج تقريب عائم.
    // المقارنة بالهللات (أعداد صحيحة) لا بالريال (كسور عائمة) — لأن طرح رقمين
    // عشريين متقاربين بجافاسكريبت (مثلاً 100.01-100.00) قد ينتج ضجيجًا عائمًا
    // أكبر بقليل من 0.01 فعليًا رغم تطابقهما محاسبيًا، فيرفض قيدًا متوازنًا فعلًا
    const debitCents  = Math.round(debit * 100);
    const creditCents = Math.round(credit * 100);
    if (Math.abs(debitCents - creditCents) > 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'القيد غير متوازن — المدين لا يساوي الدائن' });
    }

    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, req.user.company_id, date || todayLocalDateStr(), req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    const jeSeqN = await nextDocNumber(client, req.user.company_id, 'entry');
    const entry_no = `JE-${String(jeSeqN).padStart(6, '0')}`;

    const { rows: [entry] } = await client.query(
      `INSERT INTO journal_entries (company_id, entry_no, description, reference, date, created_by, client_local_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.company_id, entry_no, description || '', ref || null,
       date || todayLocalDateStr(), req.user.sub, client_local_id || null]
    );

    for (const e of entries) {
      const accountId = await resolveAccountId(client, req.user.company_id, e.account_code, e.account);
      await client.query(
        `INSERT INTO journal_items (entry_id, account_id, account_code, account_name, side, amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [entry.id, accountId, e.account_code || '', e.account || '', e.side, parseFloat(e.amount) || 0]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { id: entry.id, description: entry.description, ref: entry.reference, date: entry.date, entries } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.remove = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // كان هذا الحذف بلا أي فحص إقفال فترة إطلاقًا (بعكس كل نقاط الكتابة
    // الأخرى) — يسمح بحذف قيد نهائي من سنة/شهر مُقفَل محاسبيًا
    const { rows: [entry] } = await client.query(
      `SELECT date, entry_no, description FROM journal_entries WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!entry) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'القيد غير موجود' });
    }
    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, req.user.company_id, entry.date, req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }
    await client.query(
      `DELETE FROM journal_entries WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    await client.query('COMMIT');
    res.json({ success: true });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'journal_delete',
      entityType: 'journal_entry', entityId: req.params.id, ip: req.ip,
      oldValues: { entry_no: entry.entry_no, date: entry.date, description: entry.description },
      details: `حذف قيد يومية: ${entry.entry_no} — ${entry.description || ''}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
