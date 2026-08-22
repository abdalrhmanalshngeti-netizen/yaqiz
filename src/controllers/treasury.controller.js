const db = require('../config/db');
const { nextDocNumber } = require('../services/docNumber.service');

// طرق الدفع التي تُقيَّد على الحساب البنكي بدل الصندوق النقدي
const BANK_METHODS = ['شبكة', 'تحويل', 'تحويل بنكي', 'شيك', 'card', 'transfer', 'bank', 'cheque', 'check'];

// يختار حساب الخزينة المناسب (كاش/بنك) حسب طريقة الدفع، مع رجوع آمن للحساب الافتراضي
async function resolveTreasuryAccount(client, companyId, paymentMethod) {
  const wantsBank = paymentMethod && BANK_METHODS.includes(String(paymentMethod).trim());
  if (wantsBank) {
    const { rows: [bankAcct] } = await client.query(
      `SELECT * FROM treasury_accounts WHERE company_id = $1 AND type = 'bank' AND is_active = true ORDER BY id LIMIT 1`,
      [companyId]
    );
    if (bankAcct) return bankAcct;
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
    const { name, type, bank_name, account_number, iban, balance, is_default } = req.body;
    if (!name) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'اسم الحساب مطلوب' }); }

    if (is_default) {
      await client.query(`UPDATE treasury_accounts SET is_default = false WHERE company_id = $1`, [req.user.company_id]);
    }

    const { rows } = await client.query(`
      INSERT INTO treasury_accounts
        (company_id, name, type, bank_name, account_number, iban, balance, is_default)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [req.user.company_id, name, type || 'cash', bank_name, account_number, iban, balance || 0, !!is_default]);

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
    const { name, bank_name, account_number, iban, is_default, is_active } = req.body;
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
        is_active      = COALESCE($6, is_active)
      WHERE id = $7 AND company_id = $8
      RETURNING *
    `, [name, bank_name, account_number, iban, is_default, is_active,
        req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.transfer = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { from_id, to_id, amount, description } = req.body;
    if (!from_id || !to_id || !amount || from_id === to_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'بيانات التحويل غير صحيحة' });
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

    const newFrom = parseFloat(from.balance) - parseFloat(amount);
    const newTo   = parseFloat(to.balance)   + parseFloat(amount);

    await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newFrom, from_id]);
    await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newTo,   to_id]);

    const desc = description || `تحويل من ${from.name} إلى ${to.name}`;
    await client.query(`
      INSERT INTO treasury_moves
        (company_id, account_id, type, amount, balance_before, balance_after,
         description, transfer_to_id, created_by)
      VALUES ($1,$2,'transfer',$3,$4,$5,$6,$7,$8)
    `, [req.user.company_id, from_id, amount, from.balance, newFrom, desc, to_id, req.user.sub]);

    await client.query('COMMIT');
    res.json({ success: true });
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
    const { type, amount, description, reference, payment_method, source_type } = req.body;
    if (!['in', 'out'].includes(type) || !amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'نوع الحركة والمبلغ مطلوبان' });
    }

    const acct = await resolveTreasuryAccount(client, req.user.company_id, payment_method);
    if (!acct) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'لا يوجد حساب خزينة افتراضي' }); }

    const newBal = type === 'in'
      ? parseFloat(acct.balance) + parseFloat(amount)
      : parseFloat(acct.balance) - parseFloat(amount);

    await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newBal, acct.id]);
    const { rows: [move] } = await client.query(`
      INSERT INTO treasury_moves (company_id, account_id, type, amount, balance_before, balance_after, description, reference, source_type, payment_method, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [req.user.company_id, acct.id, type, amount, acct.balance, newBal, description || '', reference || '', source_type || 'manual', payment_method || null, req.user.sub]);

    await client.query('COMMIT');
    res.json({ success: true, data: { ...move, balance: newBal } });
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
      SELECT tm.*, ta.name AS account_name, u.full_name AS created_by_name
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

// ── VOUCHERS ──────────────────────────────────────────────────

exports.listVouchers = async (req, res, next) => {
  try {
    const { type, from, to } = req.query;
    let where  = [`v.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (type) { where.push(`v.type = $${idx++}`); params.push(type); }
    if (from) { where.push(`v.date >= $${idx++}`); params.push(from); }
    if (to)   { where.push(`v.date <= $${idx++}`); params.push(to); }

    const { rows } = await db.query(`
      SELECT v.*, ta.name AS account_name
      FROM vouchers v
      LEFT JOIN treasury_accounts ta ON ta.id = v.account_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.created_at DESC
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getVoucher = async (req, res, next) => {
  try {
    const { rows: [v] } = await db.query(
      `SELECT v.*, ta.name AS account_name FROM vouchers v
       LEFT JOIN treasury_accounts ta ON ta.id = v.account_id
       WHERE v.id = $1 AND v.company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!v) return res.status(404).json({ success: false, message: 'السند غير موجود' });
    res.json({ success: true, data: v });
  } catch (err) { next(err); }
};

exports.createVoucher = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const {
      type, party_type, party_id, party_name,
      amount, account_id, payment_method,
      description, reference, date,
      linked_invoice_id, linked_purchase_id
    } = req.body;

    if (!type || !amount || !account_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'النوع والمبلغ والحساب مطلوبة' });
    }

    const vchSeqN = await nextDocNumber(client, req.user.company_id, 'voucher');
    const voucher_no = `${type === 'receipt' ? 'RCP' : 'PAY'}-${String(vchSeqN).padStart(6, '0')}`;

    // تحديث رصيد الخزينة
    const { rows: [acct] } = await client.query(
      `SELECT balance FROM treasury_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [account_id, req.user.company_id]
    );
    if (!acct) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'حساب الخزينة غير موجود' }); }

    const moveType = type === 'receipt' ? 'in' : 'out';
    const newBal   = type === 'receipt'
      ? parseFloat(acct.balance) + parseFloat(amount)
      : parseFloat(acct.balance) - parseFloat(amount);

    await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newBal, account_id]);
    await client.query(`
      INSERT INTO treasury_moves
        (company_id, account_id, type, amount, balance_before, balance_after,
         description, source_type, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'voucher',$8)
    `, [req.user.company_id, account_id, moveType, amount, acct.balance, newBal, description, req.user.sub]);

    // إنشاء السند
    const { rows: [voucher] } = await client.query(`
      INSERT INTO vouchers
        (company_id, voucher_no, type, party_type, party_id, party_name,
         amount, account_id, payment_method, description, reference, date,
         linked_invoice_id, linked_purchase_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [req.user.company_id, voucher_no, type, party_type, party_id, party_name,
        amount, account_id, payment_method, description, reference, date,
        linked_invoice_id, linked_purchase_id, req.user.sub]);

    // تحديث رصيد الطرف
    if (party_id && party_type === 'customer' && type === 'receipt') {
      await client.query(
        `UPDATE customers SET balance = balance - $1 WHERE id = $2 AND company_id = $3`,
        [amount, party_id, req.user.company_id]
      );
    } else if (party_id && party_type === 'supplier' && type === 'payment') {
      await client.query(
        `UPDATE suppliers SET balance = balance - $1 WHERE id = $2 AND company_id = $3`,
        [amount, party_id, req.user.company_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: voucher });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
