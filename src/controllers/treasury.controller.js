const db = require('../config/db');
const branch = require('../services/branch.service');
const { nextDocNumber } = require('../services/docNumber.service');
const periodClose = require('../services/periodClose.service');
const { todayLocalDateStr } = require('../utils/date.util');
const logAudit = require('../middleware/logger');

// طرق الدفع التي تُقيَّد على الحساب البنكي بدل الصندوق النقدي
const BANK_METHODS = ['شبكة', 'تحويل', 'تحويل بنكي', 'شيك', 'card', 'transfer', 'bank', 'cheque', 'check'];

// يختار حساب الخزينة المناسب (كاش/بنك) حسب طريقة الدفع والفرع، مع رجوع آمن
// للحساب الافتراضي. البنكي يبقى مشتركًا على مستوى الشركة عمدًا (لا صندوق
// بنكي منفصل لكل فرع). النقدي يُوجَّه أولًا لصندوق الفرع نفسه — بغض النظر
// عن is_default (كل صناديق الفروع غير الأول تُنشأ بـis_default=false، فهذا
// العلم لم يعد يميّز "صندوق الفرع الصحيح" بعد تفعيل تعدد الفروع، فقط يميّز
// "الحساب الاحتياطي لشركة بفرع واحد أو فرع بلا صندوق خاص")
async function resolveTreasuryAccount(client, companyId, paymentMethod, branchId) {
  const wantsBank = paymentMethod && BANK_METHODS.includes(String(paymentMethod).trim());
  if (wantsBank) {
    const { rows: [bankAcct] } = await client.query(
      `SELECT * FROM treasury_accounts WHERE company_id = $1 AND type = 'bank' AND is_active = true ORDER BY id LIMIT 1`,
      [companyId]
    );
    if (bankAcct) return bankAcct;
  }
  if (branchId) {
    const { rows: [branchAcct] } = await client.query(
      `SELECT * FROM treasury_accounts WHERE company_id = $1 AND branch_id = $2 AND type = 'cash' AND is_active = true LIMIT 1`,
      [companyId, branchId]
    );
    if (branchAcct) return branchAcct;
  }
  const { rows: [defaultAcct] } = await client.query(
    `SELECT * FROM treasury_accounts WHERE company_id = $1 AND is_default = true LIMIT 1`,
    [companyId]
  );
  return defaultAcct;
}

// ── ACCOUNTS ──────────────────────────────────────────────────

exports.listAccounts = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM treasury_accounts WHERE company_id = $1 AND is_active = true ORDER BY is_default DESC, name`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.createAccount = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { name, type, bank_name, account_number, iban, balance, is_default, branch_id, client_local_id } = req.body;
    if (!name) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'اسم الحساب مطلوب' }); }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ حساب
    // خزينة مكرَّرًا — نتعرّف على المحاولة السابقة عبر المعرّف المحلي بالمتصفح
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT * FROM treasury_accounts WHERE company_id = $1 AND client_local_id = $2`,
        [req.user.company_id, client_local_id]
      );
      if (existing) { await client.query('COMMIT'); return res.status(201).json({ success: true, data: existing }); }
    }

    // ربط الحساب بفرع مُحدَّد — owner فقط (مثلاً حساب بنكي مخصَّص لفرع لاحقًا)
    let safeBranchId = null;
    if (branch_id) {
      if (req.user.role !== 'owner') { await client.query('ROLLBACK'); return res.status(403).json({ success: false, message: 'ربط حساب بفرع للمالك فقط' }); }
      const { rows: [b] } = await client.query(`SELECT id FROM branches WHERE id = $1 AND company_id = $2`, [branch_id, req.user.company_id]);
      if (!b) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'الفرع غير موجود' }); }
      safeBranchId = branch_id;
    }

    if (is_default) {
      await client.query(`UPDATE treasury_accounts SET is_default = false WHERE company_id = $1`, [req.user.company_id]);
    }

    const { rows } = await client.query(`
      INSERT INTO treasury_accounts
        (company_id, name, type, bank_name, account_number, iban, balance, is_default, branch_id, client_local_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [req.user.company_id, name, type || 'cash', bank_name, account_number, iban, balance || 0, !!is_default, safeBranchId, client_local_id || null]);

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.updateAccount = async (req, res, next) => {
  try {
    const { name, bank_name, account_number, iban, is_default, is_active, branch_id } = req.body;

    if (branch_id !== undefined && req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'ربط حساب بفرع للمالك فقط' });
    }
    if (branch_id) {
      const { rows: [b] } = await db.query(`SELECT id FROM branches WHERE id = $1 AND company_id = $2`, [branch_id, req.user.company_id]);
      if (!b) return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    }

    if (is_default) {
      await db.query(`UPDATE treasury_accounts SET is_default = false WHERE company_id = $1`, [req.user.company_id]);
    }
    const { rows } = await db.query(`
      UPDATE treasury_accounts SET
        name           = COALESCE($1, name),
        bank_name      = COALESCE($2, bank_name),
        account_number = COALESCE($3, account_number),
        iban           = COALESCE($4, iban),
        is_default     = COALESCE($5, is_default),
        is_active      = COALESCE($6, is_active),
        branch_id      = CASE WHEN $9 THEN $7 ELSE branch_id END
      WHERE id = $8 AND company_id = $10
      RETURNING *
    `, [name, bank_name, account_number, iban, is_default, is_active,
        branch_id === undefined ? null : branch_id, req.params.id,
        branch_id !== undefined, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.transfer = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { from_id, to_id, amount, description, client_local_id } = req.body;
    if (!from_id || !to_id || !amount || from_id === to_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'بيانات التحويل غير صحيحة' });
    }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن يُحوَّل
    // المبلغ مرتين — نتعرّف على المحاولة السابقة عبر المعرّف المحلي بالمتصفح.
    // التحويل يُنشئ صف حركة واحدًا فقط (بالحساب المصدر)، فيكفي فحصه وحده
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT id FROM treasury_moves WHERE company_id = $1 AND client_local_id = $2`,
        [req.user.company_id, client_local_id]
      );
      if (existing) { await client.query('COMMIT'); return res.json({ success: true }); }
    }

    const { rows: [from] } = await client.query(
      `SELECT * FROM treasury_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [from_id, req.user.company_id]
    );
    const { rows: [to] } = await client.query(
      `SELECT * FROM treasury_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [to_id, req.user.company_id]
    );

    if (!from || !to) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'حساب غير موجود' }); }
    if (parseFloat(from.balance) < parseFloat(amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'الرصيد غير كافي' });
    }

    // لا يوجد حقل تاريخ بهذا الطلب (يُسجَّل دومًا بـNOW())، فالفحص هنا ضد تاريخ
    // اليوم فقط — لكن كان هذا الكنترولر بالكامل بلا أي فحص إقفال فترات إطلاقًا
    // (بعكس الفواتير/المشتريات/السندات/المرتجعات/القيود/الرواتب)، فتحويل بين
    // حسابين يبقى ممكنًا حتى داخل شهر/سنة أُقفلت للتو بنفس اليوم
    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, req.user.company_id, todayLocalDateStr(), req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    const newFrom = parseFloat(from.balance) - parseFloat(amount);
    const newTo   = parseFloat(to.balance)   + parseFloat(amount);

    await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newFrom, from_id]);
    await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newTo,   to_id]);

    const desc = description || `تحويل من ${from.name} إلى ${to.name}`;
    await client.query(`
      INSERT INTO treasury_moves
        (company_id, account_id, type, amount, balance_before, balance_after,
         description, transfer_to_id, created_by, client_local_id)
      VALUES ($1,$2,'transfer',$3,$4,$5,$6,$7,$8,$9)
    `, [req.user.company_id, from_id, amount, from.balance, newFrom, desc, to_id, req.user.sub, client_local_id || null]);

    await client.query('COMMIT');
    res.json({ success: true });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'treasury_transfer',
      entityType: 'treasury_account', entityId: from_id, ip: req.ip,
      newValues: { from_id, to_id, amount },
      details: `تحويل ${Number(amount).toFixed(2)} ر.س من ${from.name} إلى ${to.name}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.addMove = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { type, amount, description, reference, payment_method, source_type, client_local_id } = req.body;
    if (!['in', 'out'].includes(type) || !amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'نوع الحركة والمبلغ مطلوبان' });
    }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ حركة
    // خزينة مكرَّرة — نتعرّف على المحاولة السابقة عبر المعرّف المحلي بالمتصفح
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT * FROM treasury_moves WHERE company_id = $1 AND client_local_id = $2`,
        [req.user.company_id, client_local_id]
      );
      if (existing) { await client.query('COMMIT'); return res.json({ success: true, data: existing }); }
    }

    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, req.user.company_id, todayLocalDateStr(), req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    const { branch_id: resolvedBranchId } =
      await branch.resolveWarehouseForUser(client, req.user.company_id, req.user.sub, req.body.branch_id, req.user.role);
    const acct = await resolveTreasuryAccount(client, req.user.company_id, payment_method, resolvedBranchId);
    if (!acct) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'لا يوجد حساب خزينة افتراضي' }); }

    const newBal = type === 'in'
      ? parseFloat(acct.balance) + parseFloat(amount)
      : parseFloat(acct.balance) - parseFloat(amount);

    await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newBal, acct.id]);
    const { rows: [move] } = await client.query(`
      INSERT INTO treasury_moves (company_id, account_id, type, amount, balance_before, balance_after, description, reference, source_type, payment_method, created_by, client_local_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [req.user.company_id, acct.id, type, amount, acct.balance, newBal, description || '', reference || '', source_type || 'manual', payment_method || null, req.user.sub, client_local_id || null]);

    await client.query('COMMIT');
    res.json({ success: true, data: { ...move, balance: newBal } });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'treasury_move',
      entityType: 'treasury_account', entityId: acct.id, ip: req.ip,
      newValues: { type, amount, description },
      details: `حركة خزينة يدوية (${type === 'in' ? 'إيداع' : 'سحب'}): ${Number(amount).toFixed(2)} ر.س — ${description || ''}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.listMoves = async (req, res, next) => {
  try {
    const { account_id, from, to, limit = 100 } = req.query;
    let where  = [`tm.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (account_id) { where.push(`tm.account_id = $${idx++}`); params.push(account_id); }
    if (from)       { where.push(`tm.created_at >= $${idx++}`); params.push(from); }
    if (to)         { where.push(`tm.created_at <= $${idx++}`); params.push(to); }

    const { rows } = await db.query(`
      SELECT tm.*, ta.name AS account_name, ta.branch_id AS account_branch_id, u.full_name AS created_by_name
      FROM treasury_moves tm
      LEFT JOIN treasury_accounts ta ON ta.id = tm.account_id
      LEFT JOIN users u ON u.id = tm.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY tm.created_at DESC
      LIMIT $${idx}
    `, [...params, limit]);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};
