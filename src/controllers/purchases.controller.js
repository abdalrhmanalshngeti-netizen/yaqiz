const db    = require('../config/db');
const stock = require('../services/stock.service');

exports.list = async (req, res, next) => {
  try {
    const { status, supplier_id, from, to, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where  = [`p.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (status)      { where.push(`p.status = $${idx++}`);       params.push(status); }
    if (supplier_id) { where.push(`p.supplier_id = $${idx++}`);  params.push(supplier_id); }
    if (from)        { where.push(`p.date >= $${idx++}`);         params.push(from); }
    if (to)          { where.push(`p.date <= $${idx++}`);         params.push(to); }

    const { rows } = await db.query(`
      SELECT p.*, s.name AS supplier_name_db, COUNT(*) OVER() AS total_count
      FROM purchases p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, [...params, limit, offset]);

    res.json({
      success: true,
      data: rows,
      total: parseInt(rows[0]?.total_count || 0),
      page: parseInt(page)
    });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows: [purchase] } = await db.query(
      `SELECT p.*, s.name AS supplier_name_db
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.id = $1 AND p.company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!purchase) return res.status(404).json({ success: false, message: 'المشتريات غير موجودة' });
    res.json({ success: true, data: purchase });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { company_id, sub: user_id } = req.user;
    const {
      supplier_id, supplier_name, supplier_ref,
      purchase_type, category, description,
      date, amount, vat_amount, payment_method,
      deductible, notes,
      items = []
    } = req.body;

    if (!amount && !items.length) {
      return res.status(400).json({ success: false, message: 'المبلغ أو البنود مطلوبة' });
    }

    const baseAmount = parseFloat(amount || 0);
    const vatAmount  = parseFloat(vat_amount || baseAmount * 0.15);
    const total      = baseAmount + vatAmount;

    const { rows: [seq] } = await client.query(`SELECT NEXTVAL('purchase_seq') AS n`);
    const purchase_no = `PUR-${String(seq.n).padStart(6, '0')}`;

    const { rows: [purchase] } = await client.query(`
      INSERT INTO purchases
        (company_id, purchase_no, supplier_id, supplier_name, supplier_ref,
         purchase_type, category, description, date, amount, vat_amount, total,
         remaining, payment_method, status, deductible, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,
              CASE WHEN $13 = 'cash' THEN 'paid' ELSE 'unpaid' END,$14,$15,$16)
      RETURNING *
    `, [company_id, purchase_no, supplier_id, supplier_name, supplier_ref,
        purchase_type || 'goods', category, description, date,
        baseAmount, vatAmount, total,
        payment_method, deductible !== false, notes, user_id]);

    // إضافة المخزون لو كانت مشتريات بضاعة مع بنود
    if (purchase_type !== 'opex' && items.length) {
      for (const item of items) {
        await stock.add(client, {
          company_id, product_id: item.product_id, qty: item.qty,
          unit_cost: item.unit_cost || item.unit_price,
          reason: 'شراء', source: supplier_name,
          source_type: 'purchase', source_id: purchase.id,
          reference: purchase_no, user_id
        });
        // تحديث سعر الشراء
        if (item.unit_cost) {
          await client.query(
            `UPDATE products SET buy_price = $1 WHERE id = $2`,
            [item.unit_cost, item.product_id]
          );
        }
      }
    }

    // تحديث رصيد المورد
    if (supplier_id && payment_method !== 'cash') {
      await client.query(
        `UPDATE suppliers SET balance = balance + $1 WHERE id = $2`,
        [total, supplier_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: purchase });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.update = async (req, res, next) => {
  try {
    const { notes, category, description } = req.body;
    const { rows: [updated] } = await db.query(`
      UPDATE purchases SET
        notes       = COALESCE($1, notes),
        category    = COALESCE($2, category),
        description = COALESCE($3, description)
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [notes, category, description, req.params.id, req.user.company_id]);

    if (!updated) return res.status(404).json({ success: false, message: 'المشتريات غير موجودة' });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

exports.addPayment = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { amount, account_id } = req.body;
    const { rows: [pur] } = await client.query(
      `SELECT * FROM purchases WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    if (!pur) return res.status(404).json({ success: false, message: 'المشتريات غير موجودة' });

    const paying    = Math.min(parseFloat(amount), parseFloat(pur.remaining));
    const newPaid   = parseFloat(pur.paid_amount) + paying;
    const newRem    = parseFloat(pur.total) - newPaid;
    const newStatus = newRem <= 0 ? 'paid' : 'partial';

    await client.query(`
      UPDATE purchases SET paid_amount=$1, remaining=$2, status=$3 WHERE id=$4
    `, [newPaid, newRem, newStatus, pur.id]);

    if (pur.supplier_id) {
      await client.query(`UPDATE suppliers SET balance = balance - $1 WHERE id = $2`, [paying, pur.supplier_id]);
    }

    if (account_id) {
      const { rows: [acct] } = await client.query(
        `SELECT balance FROM treasury_accounts WHERE id = $1 FOR UPDATE`, [account_id]
      );
      const newBal = parseFloat(acct.balance) - paying;
      await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newBal, account_id]);
      await client.query(`
        INSERT INTO treasury_moves
          (company_id, account_id, type, amount, balance_before, balance_after,
           description, source_type, source_id, created_by)
        VALUES ($1,$2,'out',$3,$4,$5,$6,'purchase',$7,$8)
      `, [req.user.company_id, account_id, paying, acct.balance, newBal,
          `سداد مشتريات ${pur.purchase_no}`, pur.id, req.user.sub]);
    }

    await client.query('COMMIT');
    res.json({ success: true, paid: paying, remaining: newRem, status: newStatus });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
