const db    = require('../config/db');
const stock = require('../services/stock.service');
const logAudit = require('../middleware/logger');

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

    const { rows } = await db.query(`
      SELECT i.*, c.name AS customer_name,
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
      payment_method, notes, cogs_total
    } = req.body;

    if (!items.length) {
      return res.status(400).json({ success: false, message: 'يجب إضافة منتج واحد على الأقل' });
    }

    if (customer_id) {
      const { rows: [custRow] } = await client.query(
        `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
        [customer_id, company_id]
      );
      if (!custRow) return res.status(404).json({ success: false, message: 'العميل غير موجود' });
    }

    // ── التحقق من كفاية المخزون قبل إنشاء أي شيء — نرفض الفاتورة كاملة بدل
    // إنشائها وتجاهل خصم المخزون بصمت لو الكمية غير كافية (كان يسبب تضاربًا
    // بين الدفاتر والمخزون الفعلي). القفل (FOR UPDATE) يمنع تضارب السباق مع
    // عملية بيع أخرى متزامنة على نفس الصنف.
    const stockShortages = [];
    for (const item of items) {
      if (!item.product_id) continue;
      const { rows: [prod] } = await client.query(
        `SELECT name, qty FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [item.product_id, company_id]
      );
      if (!prod) continue;
      if (parseFloat(prod.qty) < parseFloat(item.qty)) {
        stockShortages.push(`${prod.name} (المتوفر: ${prod.qty}، المطلوب: ${item.qty})`);
      }
    }
    if (stockShortages.length) {
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

    // ── رقم الفاتورة ──────────────────────────
    const { rows: [seq] } = await client.query(`SELECT NEXTVAL('invoice_seq') AS n`);
    const invoice_no = `INV-${String(seq.n).padStart(6, '0')}`;

    // ── إدراج الفاتورة ────────────────────────
    const { rows: [invoice] } = await client.query(`
      INSERT INTO invoices
        (company_id, invoice_no, invoice_type, customer_id, customer_name, customer_vat,
         date, due_date, subtotal, discount_type, discount_value, discount_amount,
         taxable_amount, vat_amount, grand_total, payment_method, notes,
         status, created_by, cogs_total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'issued',$18,$19)
      RETURNING *
    `, [company_id, invoice_no, invoice_type || 'simplified',
        customer_id, customer_name, customer_vat,
        date, due_date, subtotal, discount_type, disc_val, disc_amt,
        taxable, vat_amount, grand, payment_method, notes, user_id,
        parseFloat(cogs_total) || 0]);

    // ── إدراج البنود + خصم المخزون ────────────
    for (let i = 0; i < processedItems.length; i++) {
      const item = processedItems[i];
      await client.query(`
        INSERT INTO invoice_items
          (invoice_id, product_id, product_name, product_code,
           qty, unit_price, discount, line_total, vat_amount, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [invoice.id, item.product_id, item.product_name, item.product_code,
          item.qty, item.unit_price, item.discount || 0,
          item.line_total, item.vat_amount, i]);

      if (item.product_id) {
        try {
          await client.query('SAVEPOINT sp_stock');
          await stock.deduct(client, {
            company_id, product_id: item.product_id, qty: item.qty,
            reason: 'بيع', source_type: 'invoice', source_id: invoice.id,
            reference: invoice_no, user_id
          });
        } catch (stockErr) {
          await client.query('ROLLBACK TO sp_stock');
          console.warn(`stock deduct skipped [${invoice_no}] product ${item.product_id}:`, stockErr.message);
        }
      }
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
      return res.status(400).json({ success: false, message: 'المبلغ غير صحيح' });
    }

    const { rows: [inv] } = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    if (!inv) return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });

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
        `SELECT balance FROM treasury_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [account_id, req.user.company_id]
      );
      if (!acct) return res.status(404).json({ success: false, message: 'حساب الخزينة غير موجود' });
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
    if (!inv) return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' });
    if (inv.status === 'cancelled') return res.status(400).json({ success: false, message: 'الفاتورة ملغاة بالفعل' });

    await client.query(`UPDATE invoices SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [inv.id]);

    // إرجاع المخزون
    const { rows: items } = await client.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1`, [inv.id]
    );
    for (const item of items) {
      if (item.product_id) {
        await stock.add(client, {
          company_id: req.user.company_id, product_id: item.product_id, qty: item.qty,
          reason: 'مرتجع — إلغاء فاتورة', source_type: 'invoice_cancel', source_id: inv.id,
          reference: inv.invoice_no, user_id: req.user.sub
        });
      }
    }

    // عكس رصيد العميل
    if (inv.customer_id) {
      await client.query(
        `UPDATE customers SET balance = balance - $1 WHERE id = $2`,
        [parseFloat(inv.grand_total) - parseFloat(inv.paid_amount), inv.customer_id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'invoice_cancel',
      entityType: 'invoice', entityId: inv.id, ip: req.ip,
      oldValues: { status: inv.status }, newValues: { status: 'cancelled' },
      details: `إلغاء فاتورة ${inv.invoice_no} — ${Number(inv.grand_total).toFixed(2)} ر.س`
    });

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
